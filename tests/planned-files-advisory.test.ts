import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { isHerdrCommand } from '../src/master/herdr.js';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { daemonStatePath, emptyDaemonState, type DaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import type { Principal, Work } from '../src/model.js';
import { coordinationViewHeader } from '../src/server/work-view.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';

setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-3539: with 12 workers allowed, file locks left 2 working. Planned and observed files are
// advisory; only an explicit exclusive resource that is a declared name or a file on the base holds.

const repository = 'owner/planned-files-advisory';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const loopId = 'graphyard-master-advisory-operator';
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const workers: Principal[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(name => ({ id: `worker-${name}`, role: 'worker', sessionKind: 'ai' }));
const credentials = [operator, coordinator, ...workers].map(principal => ({ ...principal, token: `advisory-${principal.id}-${'x'.repeat(32)}` }));
const token = (id: string) => credentials.find(credential => credential.id === id)!.token;
let agentToken: string;
let store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, cursorDirectory: string;

const call = async (bearer: string, method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${url}/api/${path}`, {
    method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (bearer: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const result = await call(bearer, method, path, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const file = (title: string, fields: { plannedFiles?: string[]; exclusiveResources?: string[] }) => ok(token(operator.id), 'POST', 'work', { why: 'w', simplest: 's',
  title, type: 'chore', priority: 1, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:planned-files-advisory', 'e2e:fixture'] }],
  policy: { checks: ['test'], review: true }, ...fields,
}) as Promise<Work>;
const update = (id: string, patch: Record<string, unknown>) => store.pool.query('UPDATE work_items SET document = document || $1::jsonb WHERE id = $2', [JSON.stringify(patch), id]);

const profile = (name: string, principal: string): WorkerProfile =>
  ({ name, principal, agentName: `agent-${name}`, mode: 'launch', kind: 'claude', credentialFile: `/srv/credentials/${name}.token`, agentArgs: [], approvals: 'auto', environment: {} } as WorkerProfile);
const snapshotRead = async () => (await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: `Bearer ${token(coordinator.id)}`, [coordinationViewHeader]: 'coordination' } })).json() as Promise<{ work: Work[]; now: string }>;
/** `graphyard master status` over this fixture's snapshot and the loop's state, as the CLI reads it. */
async function masterStatus(config: MasterConfig, state: DaemonState, panes: HerdrAgent[]) {
  await writeFile(daemonStatePath(config), JSON.stringify(state));
  const root = await temporaryDirectory('planned-files-advisory-status');
  execFileSync('git', ['init', '-q', root]);
  const run = async (command: string) => isHerdrCommand(command) ? JSON.stringify({ agents: panes }) : `${'b'.repeat(40)}\n`;
  return masterStatusReport(root, config, snapshotRead as () => Promise<any>, run);
}
const masterConfig = (): MasterConfig => masterConfigSchema.parse({
  version: 1, url, credentialFile: join(cursorDirectory, 'coordinator.token'), cliPath: '/outside/bin/graphyard.mjs',
  repository, baseBranch: 'main', githubAppId: 1234, hostId: 'loop-host', masterAgentName: 'graphyard-master-advisory', autoMerge: true, mergeMethod: 'merge',
  operatorAgent: { id: loopId, credentialFile: '/outside/operator-agent.token' },
  workers: workers.map((worker, index) => profile(`p${index}`, worker.id)),
});

before(async () => {
  cursorDirectory = await temporaryDirectory('planned-files-advisory-cursor');
  store = await withDatabase('planned-files-advisory');
  await store.init();
  engine = new Engine(store, 300, repository);
  // The base branch holds src/engine.ts and nothing under e2e/TIMINGS.md.
  engine.gitRunner = async args => ({ status: args[0] === 'cat-file' && args.at(-1) === `refs/remotes/origin/${engine.baseBranch}:src/engine.ts` ? 0 : 128, stdout: '', stderr: '' });
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  agentToken = `loop-agent-${randomUUID()}`;
  await ok(token(operator.id), 'POST', 'operator-agents', { id: loopId, displayName: 'Master loop', capabilities: [],
    scope: { repositories: [repository], workItems: ['*'] }, token: agentToken, reason: 'the loop applies its decisions under its own identity' });
});
after(async () => { http?.close(); await store?.close(); });

test('integration:planned-files-advisory — overlapping planned or observed files never hold dispatch; only an exclusive resource held by another item refuses, once in the loop log, and a path absent on the base never blocks', async () => {
  const first = await file('Refactor engine A', { plannedFiles: ['src/engine.ts'] });
  const second = await file('Refactor engine B', { plannedFiles: ['src/engine.ts', 'src/release.ts'] });
  const holder = await file('Uses staging', { exclusiveResources: ['staging', 'e2e/timings.md', 'src/engine.ts'] });
  const timings = await file('Writes timings', { exclusiveResources: ['e2e/timings.md'] });
  assert.deepEqual(second.plannedFiles, ['src/engine.ts', 'src/release.ts'], 'planned files are kept and shown');
  assert.deepEqual(holder.exclusiveResources, ['staging', 'src/engine.ts'], 'a path the base lacks is no resource');
  assert.deepEqual(timings.exclusiveResources, []);

  const herdr = { agents: [] as HerdrAgent[] };
  const config = masterConfig();
  const released: string[] = [], claims: string[] = [], log: string[] = [];
  const effects: DaemonEffects = {
    agents: () => herdr.agents,
    herdr: () => ({ agents: herdr.agents, available: true }),
    credentials: async () => Object.fromEntries(config.workers.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: snapshotRead,
    closeSession: () => {},
    release: async (item, reason) => {
      released.push(item.key);
      return ok(agentToken, 'POST', `work/${item.id}/ready`, { expectedRevision: item.revision, reason });
    },
    dispatch: async (item, chosen) => {
      const claimed = await ok(token(chosen.principal), 'POST', `work/${item.id}/claim`, {}) as Work;
      herdr.agents = [...herdr.agents, { name: chosen.agentName, pane_id: `pane-${item.key}`, agent: 'claude', agent_status: 'working' }];
      claims.push(item.key);
      return { pane: `pane-${item.key}`, epoch: claimed.epoch };
    },
    persist: async () => {},
  };
  const state: DaemonState = emptyDaemonState(config);
  const cycle = () => runCycle(config, state, effects, Date.now, undefined, line => log.push(line));

  await cycle();
  assert.deepEqual(new Set(released), new Set([first.key, second.key, holder.key, timings.key]), 'every item is released together');
  assert.deepEqual(new Set(claims), new Set([first.key, second.key, holder.key, timings.key]), 'items planning the same file are dispatched at once');
  const report = await masterStatus(config, state, herdr.agents);
  const owners = [first.key, second.key].map(key => report.items.find(item => item.key === key)?.owner);
  assert.ok(owners.every(Boolean) && owners[0] !== owners[1], `master status shows both items on src/engine.ts with a worker at once: ${JSON.stringify(owners)}`);

  // An item planning a file another item was observed to change is claimed beside it.
  await update(first.id, { lease: null, stage: 'review', submission: { epoch: 1, pr: 1 }, candidate: { sha: 'a'.repeat(40) }, observation: { files: ['src/engine.ts'], at: new Date().toISOString() } });
  const third = await file('Refactor engine C', { plannedFiles: ['src/engine.ts'] });
  await update(third.id, { ready: true });
  await ok(token(workers[6].id), 'POST', `work/${third.id}/claim`, {});

  // An explicit exclusive resource held by another item refuses the claim and the loop's dispatch.
  const waiting = await file('Also uses staging', { exclusiveResources: ['staging'] });
  await update(waiting.id, { ready: true });
  const refused = await call(token(workers[7].id), 'POST', `work/${waiting.id}/claim`, {});
  assert.equal(refused.status, 409);
  assert.match(JSON.stringify(refused.body), /Exclusive resources held: staging by GY-/);
  log.length = 0;
  await cycle();
  await cycle();
  assert.ok(!claims.includes(waiting.key), 'the item waits for the resource');
  const lines = log.filter(line => line.includes(waiting.key));
  assert.deepEqual(lines.map(line => line.replace(/cycle \d+: /, '')), [`[graphyard-master] ${waiting.key} waits: exclusive resource staging is held by ${holder.key}`], 'one log line names the item, the resource and the holder');
});
