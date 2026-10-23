import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { masterConfigSchema, type WorkerProfile } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { Launcher, defaultLaunchConcurrency } from '../src/daemon/cycle.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// Time-bomb allowance (GY-1694): the 2030-01-01 snapshot `now` is the cycle's own logic clock (runCycle adopts snapshot.now); Date.now() only times the cycle and the launcher waves, which nothing compares with 2030.

// GY-616: a burst of session launches ran inside the master cycle, one Herdr pane and session
// registration after another, and every merge, decision and close after them waited for the burst.
const cli = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const hour = 3_600_000;
// The ten launches are hotfixes: GY-2097's in-flight cap (4) exempts a 'Hotfix:' title, so this
// test still measures the launcher's own concurrency rather than the pipeline's cap.

function work(key: string): Work {
  return {
    id: `id-${key}`, key, title: `Hotfix: ${key}`, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x'] }],
    policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1, createdAt: iso(-4 * hour), updatedAt: iso(0), stageEnteredAt: iso(-4 * hour),
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [],
  } as Work;
}
const profile = (name: string, credentialFile: string): WorkerProfile => ({ name, principal: `${name}-principal`, agentName: `agent-${name}`, mode: 'launch', kind: 'codex', credentialFile, agentArgs: [], approvals: 'auto', environment: {} });

test('unit:launches-off-cycle — the cycle hands 10 five-second launches to the launcher and completes in under 10 s; the launcher runs 3 at a time and all 10 finish, reported to the next cycle', async () => {
  const directory = await temporaryDirectory('launches-off-cycle');
  const token = join(directory, 'coordinator.token'); await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const credential = join(directory, 'worker.token'); await writeFile(credential, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const keys = Array.from({ length: 10 }, (_, index) => `GY-${index + 1}`);
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: cli, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: keys.map((_, index) => profile(`worker-${index + 1}`, credential)) });
  assert.equal(master.run.launchConcurrency, undefined, 'master.json sets no concurrency, so the default applies');
  let running = 0, peak = 0;
  const finished: string[] = [];
  const effects: DaemonEffects = {
    agents: () => [], credentials: async items => Object.fromEntries(items.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: keys.map(work), now: iso(0) }),
    closeSession: () => {},
    // Each launch — a pane and a registered session — takes five seconds.
    dispatch: async item => { running += 1; peak = Math.max(peak, running); await delay(5_000); running -= 1; finished.push(item.key); },
    persist: async () => {},
  };
  const state = emptyDaemonState(master), launcher = new Launcher();
  assert.equal(launcher.concurrency, defaultLaunchConcurrency); assert.equal(defaultLaunchConcurrency, 3);

  const started = Date.now();
  const first = await runCycle(master, state, effects, Date.now, launcher);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10_000, `the cycle completed in ${elapsed}ms without waiting on its launches`);
  assert.equal(finished.length, 0, 'no five-second launch had finished when the cycle ended: it recorded the requests and moved on');
  assert.equal(launcher.pending, 10, 'all 10 launch requests are with the launcher');
  assert.ok(!first.actions.some(action => action.kind === 'dispatch' && action.state === 'done'), 'nothing is reported done before it is');
  // Each launch in flight holds its profile, and the next cycle neither repeats a launch nor
  // reconciles its `started` entry as interrupted.
  const second = await runCycle(master, state, effects, Date.now, launcher);
  assert.ok(!second.actions.some(action => /Resumed/.test(action.detail)), 'a launch in flight is not reconciled as interrupted');
  assert.equal(launcher.pending, 10, 'a launch already in flight is not requested twice');

  await launcher.idle();
  assert.equal(finished.length, 10, 'all 10 launches finished');
  assert.deepEqual([...finished].sort(), [...keys].sort());
  assert.equal(peak, 3, 'the launcher ran at most 3 launches at once');
  assert.ok(Date.now() - started >= 15_000, 'ten 5 s launches, three at a time, take four waves');

  // The next cycle reports what every launch did.
  const third = await runCycle(master, state, effects, Date.now, launcher);
  const reported = third.actions.filter(action => action.kind === 'dispatch' && action.state === 'done').map(action => action.work).sort();
  assert.deepEqual(reported, [...keys].sort(), 'each launch result is reported to the next cycle');
  assert.equal(launcher.drain().length, 0);

  // A concurrency set in master.json is the launcher's.
  const tuned = masterConfigSchema.parse({ ...master, run: { ...master.run, launchConcurrency: 5 } });
  assert.equal(tuned.run.launchConcurrency, 5);
  await runCycle(tuned, emptyDaemonState(tuned), { ...effects, dispatch: async () => {} }, Date.now, launcher);
  assert.equal(launcher.concurrency, 5);
  await launcher.idle();
  assert.throws(() => masterConfigSchema.parse({ ...master, run: { ...master.run, launchConcurrency: 0 } }));
});

test('unit:launches-off-cycle — the launcher queues past its concurrency, runs each key once, and a launch that throws settles without holding up the rest', async () => {
  const launcher = new Launcher(2);
  const gates: (() => void)[] = [];
  const order: string[] = [];
  for (const key of ['a', 'b', 'c']) assert.equal(launcher.submit(key, [`profile-${key}`], async sink => {
    order.push(key); await new Promise<void>(resolve => gates.push(resolve));
    sink.push({ kind: 'dispatch', work: key, principal: null, state: 'done', detail: `launched ${key}`, attempts: 1, epoch: null, cycle: 0, at: iso(0) });
  }), true);
  assert.equal(launcher.submit('a', [], async () => {}), false, 'a key in flight is not launched twice');
  await delay(10);
  assert.deepEqual(order, ['a', 'b'], 'two run, the third queues');
  assert.deepEqual([...launcher.held()].sort(), ['profile-a', 'profile-b', 'profile-c'], 'a queued launch already holds its profile');
  gates.shift()!();
  await delay(10);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.deepEqual(launcher.drain().map(action => action.detail), ['launched a']);
  launcher.submit('d', [], async () => { throw new Error('pane refused'); });
  for (const open of gates.splice(0)) open();
  await delay(10); gates.splice(0).forEach(open => open());
  await launcher.idle();
  assert.equal(launcher.pending, 0);
  assert.deepEqual(launcher.drain().map(action => action.detail).sort(), ['launched b', 'launched c']);
});
