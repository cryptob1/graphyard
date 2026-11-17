import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Observation, Principal, Work } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { dispatchEffects, type DispatchEffects } from '../src/dispatch/effects.js';
import { readDispatchCursor, writeDispatchCursor } from '../src/dispatch/cursor.js';
import { runDispatchTick, type DispatchTick } from '../src/dispatch/tick.js';
import { runCycle } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

/**
 * GY-3424 (e2e:dispatch-state-saves). A relaunch churn left one item with thousands of launch
 * failures and a running session its runtime no longer lists. The loop keyed that missing session
 * with a NUL separator, Postgres refused the jsonb, and every cycle's dispatch save answered 500, so
 * ready work waited. Two loop cycles here run the real dispatch tick against the served loop-state
 * API: both save, and the other item's ready review launches.
 */
const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'agent-a', role: 'worker', runtime: 'claude' };
const coordinator: Principal = { id: 'fixture-loop', role: 'coordinator' };
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const token = 'fixture-coordinator-token'.padEnd(40, 'x');

let store: Store, engine: Engine, config: MasterConfig, close: () => Promise<void>;
before(async () => {
  store = await withDatabase('dispatch_state_saves'); await store.init();
  engine = new Engine(store, 120, 'owner/project');
  engine.principals = [operator, worker, coordinator];
  const http = server(engine, [{ id: coordinator.id, role: 'coordinator', token }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  close = async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); };
  const credentialFile = join(await temporaryDirectory('dispatch-state-saves'), 'coordinator.token');
  await writeFile(credentialFile, token, { mode: 0o600 });
  config = masterConfigSchema.parse({
    version: 1, url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, credentialFile, cliPath: '/outside/graphyard.mjs',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 15368, hostId: 'host-1', masterAgentName: 'm', herdrWorkspace: 'wF',
    workers: [{ name: 'claude-worker', principal: worker.id, agentName: 'work-claude', mode: 'launch', kind: 'claude', credentialFile: '/outside/worker.token', approvals: 'auto' }],
    reviewer: { appId: 4242, installationId: 99, slug: 'graphyard-reviewer', credentialFile: '/outside/reviewer.json', boundAt: '2026-09-01T00:00:00.000Z' },
    reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude', kind: 'claude', approvals: 'auto', concurrency: 1 }],
    run: { reviewerProfile: 'claude-reviewer' },
  });
});
after(async () => { await close?.(); if (store) await store.close(); });

const reload = async (item: Work) => (await store.list()).find(entry => entry.id === item.id)!;
async function submitted(title: string) {
  let item = await engine.execute(operator, 'create', null, { type: 'chore', title, criteria: [{ id: 'AC-1', text: 'Read it', proofs: ['manual:by-hand', 'e2e:fixture'] }] }, randomUUID());
  item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
  item = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
  item = await engine.execute(worker, 'workspace', item.id, { epoch: item.epoch, host: 'machine-a', path: `/tmp/state-saves/${item.id}`, branch: `graphyard/${item.key.toLowerCase()}-${item.epoch}` }, randomUUID());
  return engine.execute(worker, 'submit', item.id, { epoch: item.epoch, pr: Number(item.key.slice(3)) }, randomUUID());
}
const observation = (item: Work): Observation => ({
  clockOffset: { min: 0, max: 0 },
  candidate: { sha: head, baseSha: base, pr: item.submission!.pr, branch: item.workspaces.at(-1)!.branch, author: 'implementer' },
  checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
  reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/loop.ts'], scopeFiles: [], at: new Date().toISOString(),
  prState: 'open', draft: false, baseTip: base, baseTree: '7e'.padEnd(40, 'f'), baseTipContained: true,
});

test('dispatch-state-saves: after thousands of launch failures on one item, the loop saves its dispatch state and launches another ready item next cycle', async () => {
  // The churned item: a running session its runtime no longer lists, and thousands of refused launches.
  const churned = await submitted('Churned item');
  await engine.execute(coordinator, 'session', churned.id, { id: 'coordination-1', kind: 'coordination', runtime: 'claude', host: 'host-1', agentName: 'watch-claude',
    pane: 'pane-77', subject: `${churned.key}: shepherding`, state: 'running' }, randomUUID());
  const seeded = await readDispatchCursor('/unused', config);
  const at = (i: number) => new Date(Date.parse('2026-11-16T08:00:00.000Z') + i * 1000).toISOString();
  seeded.failures = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`churn-${i}`, { kind: 'review' as const, work: churned.key, sha: head, attempts: 1, reason: 'Submitted workspace branch is missing', at: at(i), nextAt: at(i + 60) }]));
  await writeDispatchCursor(config, seeded);

  // The other item is ready for its review.
  const ready = await submitted('Ready item');
  await engine.observe(ready.id, (await reload(ready)).revision, observation(await reload(ready)));
  assert.equal((await reload(ready)).autoDispatch?.review?.state, 'requested', 'the control plane asked for a review of the ready item');

  const launched: string[] = [];
  const production = dispatchEffects('/outside', () => config, {
    // An hour on, so the churned session is past its launch grace and its absence is noted.
    snapshot: async () => ({ work: await store.list(), now: new Date(Date.now() + 3_600_000).toISOString() }),
    mutate: async (path: string, body: unknown) => { const [, id, command] = path.split('/'); return engine.execute(coordinator, command as any, id, body, randomUUID()); },
    run: () => { throw new Error('this test reaches no launcher of its own'); },
  });
  const effects: DispatchEffects = {
    ...production, inventory: undefined, agents: () => [] as any,
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    reconcileReviews: async () => ({ reviews: [] }), reconcileProducers: async () => ({ producers: [] }),
    launchReview: async work => { launched.push(work.key); return { pane: 'pane-review' }; },
    launchProducer: async () => ({ pane: 'pane-proof' }),
    persist: cursor => writeDispatchCursor(config, cursor),
  };
  const ticks: DispatchTick[] = [];
  const state = emptyDaemonState(config);
  const daemon: DaemonEffects = {
    agents: () => [], snapshot: effects.snapshot, credentials: async () => ({}), closeSession: async () => {}, dispatch: async () => {}, persist: async () => {},
    dispatchTick: async () => { const tick = await runDispatchTick(config, await readDispatchCursor('/unused', config), effects); ticks.push(tick); return tick; },
  };
  for (let cycle = 0; cycle < 2; cycle++) {
    await runCycle(config, state, daemon, Date.now, undefined, () => {});
    assert.equal(state.stepFailures.dispatch, undefined, `cycle ${cycle + 1}'s dispatch step saved its state: ${JSON.stringify(state.stepFailures.dispatch)}`);
  }
  assert.equal(ticks.length, 2, 'both cycles ran their dispatch tick to the end');
  assert.ok(launched.includes(ready.key), `the ready item's review launched; launched ${JSON.stringify(launched)}`);
  const stored = await readDispatchCursor('/unused', config);
  assert.ok(Object.keys(stored.sessionMisses).some(key => key.startsWith(churned.id)), `the churned item's missing session is kept for the next sweep to measure its grace: ${JSON.stringify(stored.sessionMisses)}`);
  assert.ok(Object.values(stored.failures).filter(failure => failure.work === churned.key).length <= 20, 'the churned item keeps only its latest launch failures');
});
