import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Store } from '../src/store.js';
import { runCycle } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { gateFiledItem } from '../src/daemon/cycle-batch-gate.js';
import { controlPlaneUpgradeItem, stepStallItem, trialHostFaultItem, trialImageFaultItem, trialNetworkFaultItem, trialSandboxFaultItem, upstreamFiler } from '../src/daemon/control-plane.js';
import { controlPlaneRecordPath, writeControlPlaneRecord } from '../src/deploy-watch.js';
import { masterConfigSchema } from '../src/master.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import type { Principal, Work } from '../src/model.js';

// GY-3365: a fault the loop files for itself passes the same filing validation as any item. A
// deploy that keeps failing at restart was refused (400: a bug item owes an end-to-end proof), so
// it reached the master only as a wake message. Every fault the loop files is now one faultItem,
// whose AC-2 binds the existing create-work-item case. Driven through the loop's own cycle and the
// production upstream filer against a control plane served on a temporary Postgres.

setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const credentials = [{ ...operator, token: `fault-${'x'.repeat(40)}` }];
const b = 'b'.repeat(40), c = 'c'.repeat(40);

let store: Store, http: ReturnType<typeof server>, url: string, credentialFile: string;
before(async () => {
  store = await withDatabase('loop-files-deploy-fault');
  await store.init();
  http = server(new Engine(store, 7200, 'cryptob1/graphyard'), credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  credentialFile = join(await temporaryDirectory('loop-files-deploy-fault-credential'), 'upstream.token');
  await writeFile(credentialFile, credentials[0]!.token, { mode: 0o600 });
});
after(async () => { http?.close(); await store?.close(); });

const work = async (): Promise<Work[]> => {
  const response = await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: `Bearer ${credentials[0]!.token}` } });
  assert.equal(response.status, 200);
  return (await response.json() as { work: Work[] }).work;
};

test('e2e:loop-files-deploy-fault — a deploy failing at restart is filed once as a bug with an e2e proof, and a second cycle files nothing more', async () => {
  const root = await temporaryDirectory('loop-files-deploy-fault');
  await writeControlPlaneRecord(controlPlaneRecordPath(root), { commit: b, verified: c, verifiedSeenAt: new Date().toISOString(), failedStep: 'restart', failedReason: 'restart failed: the server did not come back', failedAt: new Date().toISOString() });
  const upstream = { url, credentialFile };
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/game', baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'graphyard-master-game', workers: [], upstream });
  const effects: DaemonEffects = {
    snapshot: async () => ({ work: [], now: new Date().toISOString() }),
    agents: () => [], herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({}), closeSession: () => {},
    dispatch: async () => ({ pane: 'p1', epoch: 1 }),
    mergeWriter: { gate: { root, repository: 'owner/game' } } as unknown as MergeWriterReads,
    fileUpstream: upstreamFiler(upstream),
    persist: async () => {},
  };
  const state = emptyDaemonState(config), lines: string[] = [];
  const key = `control-plane-upgrade:${c}:restart`;

  await runCycle(config, state, effects, Date.now, undefined, line => lines.push(line));
  assert.equal(state.actions[key]?.state, 'done', `the create call is accepted: ${state.actions[key]?.detail}`);
  const filed = (await work()).filter(item => item.title === 'Control-plane upgrade stuck at restart');
  assert.equal(filed.length, 1, 'exactly one item for the failed deploy');
  assert.equal(filed[0]!.type, 'bug');
  assert.ok(filed[0]!.criteria.some(criterion => criterion.proofs.some(proof => proof.startsWith('e2e:'))), 'the item carries a criterion with an e2e proof');
  assert.match(state.actions[key]!.detail, new RegExp(`Filed ${filed[0]!.key} to the upstream install`));

  const before = (await work()).length;
  await runCycle(config, state, effects, Date.now, undefined, line => lines.push(line));
  assert.equal((await work()).length, before, 'a second cycle with the same failure files nothing more');
});

test('e2e:loop-files-deploy-fault — every fault kind the loop files is built by faultItem and accepted by the served API', async () => {
  const record = { commit: b, verified: c, failedStep: 'restart', failedReason: 'restart failed' };
  const kinds = {
    'control-plane-upgrade': controlPlaneUpgradeItem(record as Parameters<typeof controlPlaneUpgradeItem>[0]),
    'loop-step-stall': stepStallItem('dispatch', 'owner/game'),
    'trial-host-fault': trialHostFaultItem('registry.npmjs.org', 'owner/game'),
    'trial-image-fault': trialImageFaultItem('owner/game'),
    'trial-sandbox-fault': trialSandboxFaultItem('owner/game'),
    'trial-network-fault': trialNetworkFaultItem('owner/game', '31'),
    'flake': gateFiledItem({ key: 'flake:e2e:sign-in', title: 'Flaky check on main: e2e:sign-in', description: 'Flaky.' }, 'main', 'cryptob1/graphyard'),
    'known-red': gateFiledItem({ key: 'known-red:test:tests/board.test.ts', title: 'Known red on main: test:tests/board.test.ts', description: 'Red.' }, 'main', 'cryptob1/graphyard'),
  };
  const file = upstreamFiler({ url, credentialFile });
  for (const [kind, item] of Object.entries(kinds)) {
    assert.deepEqual(item.criteria.at(-1)!.proofs.at(-1), 'e2e:create-work-item', `${kind} is built by faultItem`);
    const created = await file(item, `${kind}:${randomUUID()}`).catch((error: Error) => error);
    assert.ok(!(created instanceof Error), `${kind} is accepted: ${created instanceof Error ? created.message : ''}`);
    assert.match(String(created.key), /^GY-\d+$/);
  }
});
