import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCycle } from '../src/daemon/cycle.js';
import { upstreamFiler } from '../src/daemon/control-plane.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { controlPlaneRecordPath, writeControlPlaneRecord } from '../src/deploy-watch.js';
import { masterPrompt } from '../src/master/harness.js';
import { guideTopics } from '../src/guide.js';
import { masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3233: a fault in Graphyard itself — a stuck control-plane upgrade, a loop step past its
// timeout — on an install for another repository is never filed as work in that repository: it is
// filed once to the upstream install, or without one raised as one attention line, every cycle after.

const b = 'b'.repeat(40), c = 'c'.repeat(40);
const config = (upstream?: { url: string; credentialFile: string }) => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/game', baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'graphyard-master-game', workers: [], ...(upstream ? { upstream } : {}) });

/** A fixture install for owner/game with a stuck upgrade on record and a dispatch step that never returns. */
async function install(fileUpstream?: DaemonEffects['fileUpstream']) {
  const root = await temporaryDirectory('control-plane-fault-upstream');
  await writeControlPlaneRecord(controlPlaneRecordPath(root), { commit: b, verified: c, verifiedSeenAt: new Date().toISOString(), failedStep: 'health', failedReason: 'health failed: /healthz reports the server unhealthy', failedAt: new Date().toISOString() });
  const local: string[] = [], lines: string[] = [];
  const effects: DaemonEffects = {
    snapshot: async () => ({ work: [], now: new Date().toISOString() }),
    agents: () => [], herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({}),
    closeSession: () => {},
    dispatch: async () => ({ pane: 'p1', epoch: 1 }),
    dispatchTick: () => new Promise(() => {}),
    mergeWriter: { gate: { root, repository: 'owner/game' }, createWork: async (_input: unknown, key: string) => { local.push(key); return { key: 'GY-1' }; } } as unknown as MergeWriterReads,
    ...(fileUpstream ? { fileUpstream } : {}),
    persist: async () => {},
  };
  return { root, effects, local, lines };
}

/** Runs cycles, ticking mocked timers past the step timeout so the dispatch step stalls each one. */
async function cycles(count: number, cfg: ReturnType<typeof config>, effects: DaemonEffects, lines: string[]) {
  const state = emptyDaemonState(cfg);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    for (let index = 0; index < count; index++) {
      const done = runCycle(cfg, state, effects, Date.now, undefined, line => lines.push(line));
      for (let wait = 0; wait < 50; wait++) await new Promise(resolve => setImmediate(resolve));
      mock.timers.tick(10 * 60_000);
      await done;
    }
  } finally { mock.timers.reset(); }
  return state;
}

test('e2e:control-plane-fault-upstream — with upstream configured, a stuck upgrade and a stalled step are filed once to the upstream install, none into the managed repository', async t => {
  const filed: { key: string; title: string; auth: string }[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      filed.push({ key: String(request.headers['idempotency-key']), title: JSON.parse(body).title, auth: String(request.headers.authorization) });
      response.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ key: `GY-${filed.length + 100}` }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const credentialFile = join(await temporaryDirectory('control-plane-fault-credential'), 'upstream.token');
  await writeFile(credentialFile, 'u'.repeat(40), { mode: 0o600 });
  const upstream = { url: `http://127.0.0.1:${port}`, credentialFile };
  const { effects, local, lines } = await install(upstreamFiler(upstream));

  const state = await cycles(3, config(upstream), effects, lines);
  assert.deepEqual(local, [], 'nothing is filed into owner/game');
  assert.deepEqual(filed.map(entry => entry.key).sort(), [`control-plane-upgrade:${c}:health`, 'loop-step-stall:dispatch'], 'each fault is filed once to the upstream install, however many cycles see it');
  assert.ok(filed.every(entry => entry.auth === `Bearer ${'u'.repeat(40)}`), 'the filing carries the upstream credential');
  assert.match(filed.find(entry => entry.key === 'loop-step-stall:dispatch')!.title, /dispatch step stalls/);
  assert.match(state.actions['loop-step-stall:dispatch']!.detail, /Filed GY-\d+ to the upstream install/);
});

test('e2e:control-plane-fault-upstream — without upstream, each fault raises one attention line and nothing is filed, cycle after cycle', async () => {
  const { effects, local, lines } = await install();
  const state = await cycles(3, config(), effects, lines);
  assert.deepEqual(local, [], 'nothing is filed into owner/game');
  const attention = lines.filter(line => / attention failed: Graphyard fault/.test(line));
  assert.equal(attention.length, 2, 'one attention line per fault across three cycles');
  assert.equal(state.actions['loop-step-stall:dispatch']?.state, 'failed');
  assert.match(state.actions[`control-plane-upgrade:${c}:health`]!.detail, /keeps failing at health.*No upstream install is configured/);
});

test('e2e:control-plane-fault-upstream — the master prompt and guide master state the upstream rule', () => {
  assert.match(masterPrompt(config()), /A Graphyard fault .* belongs to Graphyard, not to owner\/game: the loop files it to the upstream install .*never file it as work in owner\/game or work around it by changing owner\/game/);
  assert.doesNotMatch(masterPrompt({ ...config(), repository: 'cryptob1/graphyard' }), /A Graphyard fault/, 'Graphyard\'s own install manages the repository its faults belong to');
  assert.match(guideTopics.master, /A Graphyard fault .* files it once to the upstream install .*never file it as work in the managed repository/);
});
