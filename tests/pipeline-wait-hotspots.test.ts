import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { emptyDaemonState, runDaemon, type DaemonEffects } from '../src/master-daemon.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { LoopWake, loopWakeReasonLimit, loopWakeSubjects } from '../src/daemon/loop-wake.js';
import { gateMerge, type MergeGateClient } from '../src/github.js';
import type { GitHubMergeQueueState } from '../src/merge-queue.js';
import { masterConfigSchema, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/*
 * GY-1490. Measured from master status and the flow ledger over the 88 items merged in the 24 h to
 * 2026-10-07 23:40Z, the master loop slept its full 300 s interval after 175 of its 287 cycles —
 * every cycle that found nothing actionable — and the dispatcher ticking every 10 s beside it never
 * woke it. That sleep was the largest avoidable part of three budgeted waits: a scope request the
 * executor refused waited it out before the loop's grounded widening (GY-1462: asked 15:30:59,
 * widened 15:36:04), a standing verdict waited it out before its rework was requested (eleven
 * 5.0–5.7 min verdict→rework waits), and a worker slot that freed waited for the loop's next
 * dispatch. Now the tick wakes the loop for each new thing its next cycle acts on. Each test below
 * holds one part of that in isolation; the first holds the whole path end to end.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs = 0) => new Date(clock + offsetMs).toISOString();
const hour = 3_600_000;
const head = 'a'.repeat(40), base = 'b'.repeat(40);

async function setup() {
  const directory = await temporaryDirectory('pipeline-wait-hotspots');
  const workers: WorkerProfile[] = [];
  for (const name of ['alpha', 'beta']) {
    const file = join(directory, `${name}.token`);
    await writeFile(file, `${name}-token-`.padEnd(40, 'x'), { mode: 0o600 });
    workers.push({ name, principal: `${name}-principal`, agentName: `agent-${name}`, mode: 'launch', kind: 'claude', credentialFile: file, agentArgs: [], environment: {} } as unknown as WorkerProfile);
  }
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', herdrWorkspace: 'w1',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers });
  return { directory, master };
}

/** A released item no attempt holds: claimable the moment it is `ready`. */
function waiting(overrides: Partial<Work> = {}): Work {
  return {
    id: 'work-1490', key: 'GY-1490', title: 'Pipeline wait-time hotspots', description: '', type: 'bug', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/a.ts'], stage: 'build', revision: 3, policyRevision: 1,
    createdAt: iso(-hour), updatedAt: iso(), stageEnteredAt: iso(), ready: true, epoch: 0, lease: null, lastAssignment: null, sessions: [],
    workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }], violations: [],
    ...overrides,
  } as Work;
}
/** An attempt `owner` holds under a live lease. */
const leased = (key: string, owner: string, overrides: Partial<Work> = {}) => waiting({ id: `work-${key}`, key, epoch: 1, lease: { owner, epoch: 1, expiresAt: iso(hour) },
  lastAssignment: { owner, epoch: 1, claimedAt: iso(-60_000) }, ...overrides } as Partial<Work>);
/** A submitted head whose review approved it and whose required `test` check failed: its rework round is the loop's to request. */
function failedCheck(): Work {
  const candidate = { sha: head, baseSha: base, pr: 962, branch: 'graphyard/gy-1468-1', author: 'worker' };
  return waiting({ id: 'work-1468', key: 'GY-1468', stage: 'test', epoch: 1, candidate, submission: { epoch: 1, pr: 962 },
    observation: { candidate, checks: [{ appId: 15368, name: 'test', result: 'failure' }], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
      files: ['src/a.ts'], scopeFiles: [], at: iso(), prState: 'open', draft: false, baseTip: base, baseTree: base, baseTipContained: true, conversations: { required: true, unresolved: [] } } } as unknown as Partial<Work>);
}
const working = (name: string): HerdrAgent => ({ name, pane_id: `w1:${name}`, agent_status: 'working', agent: 'claude' });

function loopEffects(work: { current: Work[] }, agents: { current: HerdrAgent[] }, log: { dispatches: string[]; snapshots: number }): DaemonEffects {
  return {
    agents: () => agents.current,
    credentials: async profiles => Object.fromEntries(profiles.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => { log.snapshots++; return { work: work.current, now: new Date().toISOString() }; },
    closeSession: () => {}, requestProof: () => {}, requestSmoke: () => {}, recordDeployment: async () => {}, recordSession: async () => {},
    dispatch: async (_item, profile) => { log.dispatches.push(profile.name); },
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(), reason: 'not configured', deployed: [], pending: [] }),
    persist: async () => {},
  };
}
/** The dispatcher's effects, its tick feeding `wake` exactly as `master run` wires it. */
function tickEffects(master: MasterConfig, work: { current: Work[] }, agents: { current: HerdrAgent[] }, wake: LoopWake): DispatchEffects {
  return {
    snapshot: async () => ({ work: work.current, now: new Date().toISOString() }), agents: () => agents.current,
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    reconcileReviews: async () => ({ reviews: [] }), reconcileProducers: async () => ({ producers: [] }),
    launchReview: async () => { throw new Error('no review is under test'); }, launchProducer: async () => { throw new Error('no producer is under test'); },
    observeLoopSubjects: (items, herdr, at) => { wake.observe(loopWakeSubjects(items, master, at, herdr)); },
    persist: async () => {},
  };
}
const clean = (root: string) => ({ root, commit: 'c'.repeat(40), modified: [], untracked: [] });

/** Runs the loop on its real 300 s interval with the wake, until `body` has finished; answers the dispatches and snapshot reads it made. */
async function withLoop(master: MasterConfig, work: { current: Work[] }, agents: { current: HerdrAgent[] }, wake: LoopWake, body: (log: { dispatches: string[]; snapshots: number }) => Promise<void>) {
  const log = { dispatches: [] as string[], snapshots: 0 };
  const signal = 'SIGUSR2' as NodeJS.Signals;
  const running = runDaemon(master, emptyDaemonState(master), loopEffects(work, agents, log), { intervalMs: 300_000, identity: { pid: process.pid, host: 'machine-a' }, signals: [signal], log: () => {}, wake, checkout: () => clean(master.cliPath) });
  try { await body(log); } finally { process.emit(signal); await running; }
  return log;
}
async function until(condition: () => boolean, boundMs: number) {
  const started = Date.now();
  while (!condition()) { if (Date.now() - started > boundMs) return false; await sleep(10); }
  return true;
}

test('unit:pipeline-wait-hotspots — ready→claim: a ready item with free capacity is claimed within one dispatch tick of its release, not after the loop\'s 300 s idle sleep', async () => {
  const { master } = await setup();
  // A 200 ms floor stands in for the dispatch interval the real loop waits at least after a cycle.
  const work = { current: [waiting({ ready: false })] }, agents = { current: [] as HerdrAgent[] }, wake = new LoopWake(200);
  const tick = () => runDispatchTick(master, emptyDispatchCursor(master), tickEffects(master, work, agents, wake));
  const log = await withLoop(master, work, agents, wake, async log => {
    // The first cycle finds nothing to act on, so the loop sleeps its whole interval.
    assert.ok(await until(() => log.snapshots >= 1, 5_000), 'the first cycle ran');
    await tick();
    await sleep(200);
    assert.equal(log.snapshots, 1, 'nothing new: the tick leaves the loop asleep');
    // The item is released; the very next tick sees it claimable with a free profile and wakes the loop, which dispatches it.
    work.current = [waiting()];
    const released = Date.now();
    await tick();
    assert.ok(await until(() => log.dispatches.length > 0, 5_000), 'the woken cycle dispatched the released item');
    assert.ok(Date.now() - released < 5_000, `claimed ${Date.now() - released} ms after its release, inside one tick and a cycle`);
  });
  assert.deepEqual(log.dispatches, ['alpha']);
});

test('unit:pipeline-wait-hotspots — ready→claim: a worker slot that frees while ready work waits wakes the loop at the floor after its cycle, instead of the next 30 s actionable cycle', async () => {
  const { master } = await setup();
  // Both profiles are busy on other attempts: the ready item waits for capacity.
  const busy = { current: [working('agent-alpha'), working('agent-beta')] };
  const work = { current: [waiting(), leased('GY-1', 'alpha-principal'), leased('GY-2', 'beta-principal')] };
  const subjects = (agents: HerdrAgent[], items = work.current) => loopWakeSubjects(items, master, clock, agents).map(subject => subject.key);
  assert.deepEqual(subjects(busy.current), ['dispatch:GY-1490:0'], 'claimable, but no slot is free');
  // GY-1's worker submitted: its lease ended and its pane is gone. alpha's slot is free.
  const freed = [waiting(), leased('GY-1', 'alpha-principal', { lease: null, submission: { epoch: 1, pr: 961 } } as Partial<Work>), leased('GY-2', 'beta-principal')];
  assert.deepEqual(subjects([working('agent-beta')], freed), ['dispatch:GY-1490:0', 'slot:alpha']);
  // A lease still live holds its profile even when its pane is between runtimes, and an unreadable Herdr frees nothing.
  assert.deepEqual(subjects([working('agent-beta')]), ['dispatch:GY-1490:0']);
  assert.deepEqual(subjects(null as unknown as HerdrAgent[], freed), ['dispatch:GY-1490:0']);

  const wake = new LoopWake(100);
  assert.deepEqual(wake.observe(loopWakeSubjects(work.current, master, clock, busy.current)), [], 'the first tick only records what stands');
  assert.deepEqual(wake.observe(loopWakeSubjects(work.current, master, clock, busy.current)).length, 0, 'an item that keeps waiting is no second wake');
  const started = Date.now(), sleeping = wake.sleep(30_000);
  assert.deepEqual(wake.observe(loopWakeSubjects(freed, master, clock, [working('agent-beta')])).map(subject => subject.key), ['slot:alpha']);
  assert.deepEqual(await sleeping, ['worker profile alpha is free while GY-1490 waits']);
  assert.ok(Date.now() - started >= 90 && Date.now() - started < 1_000, `the 30 s actionable wait ended at the floor, not before it: ${Date.now() - started} ms`);
});

test('unit:pipeline-wait-hotspots — ready→first push: a scope request the executor refused wakes the loop for its grounded widening once, not after the idle sleep', async () => {
  const { master } = await setup();
  const request = { epoch: 1, paths: ['tests/a.test.ts'], reason: 'AC-1 names the test', requestedBy: 'alpha-principal', at: iso(-2_000) };
  const asking = (decision: unknown) => [leased('GY-1462', 'alpha-principal', { scopeRequest: { ...request, decision } } as Partial<Work>)];
  const refused = { state: 'refused', reason: 'outside the criteria', at: iso(-1_000), decidedBy: 'executor', waitedMs: 1_000, paths: request.paths, requestedBy: request.requestedBy, requestedAt: request.at };
  const keys = (items: Work[]) => loopWakeSubjects(items, master, clock, []).map(subject => subject.key).filter(key => key.startsWith('scope:'));
  assert.deepEqual(keys(asking(null)), [`scope:GY-1462:1:${request.at}:open`]);
  assert.deepEqual(keys(asking(refused)), [`scope:GY-1462:1:${request.at}:refused`], 'refused within seconds by the executor, it still waits on the loop');
  assert.deepEqual(keys(asking({ ...refused, state: 'approved' })), [], 'an approved request waits on nobody');
  // A request on an ended attempt, or by an epoch the lease no longer holds, is nothing the loop can widen.
  assert.deepEqual(keys([leased('GY-1462', 'alpha-principal', { lease: { owner: 'alpha-principal', epoch: 1, expiresAt: iso(-1) }, scopeRequest: { ...request, decision: refused } } as Partial<Work>)]), []);
  assert.deepEqual(keys([leased('GY-1462', 'alpha-principal', { scopeRequest: { ...request, epoch: 0, decision: refused } } as Partial<Work>)]), []);

  const wake = new LoopWake(100);
  wake.observe(loopWakeSubjects([leased('GY-1462', 'alpha-principal')], master, clock, []));
  const started = Date.now(), sleeping = wake.sleep(300_000);
  wake.observe(loopWakeSubjects(asking(refused), master, clock, []));
  assert.deepEqual(await sleeping, ["GY-1462's scope request is refused and waits on its grounds"]);
  assert.ok(Date.now() - started < 1_000, 'the 300 s idle sleep ended at the wake');
  // The loop judged it and the refusal stands: later ticks hold the same subject and wake nothing.
  wake.observe(loopWakeSubjects(asking(refused), master, clock, []));
  assert.deepEqual(await wake.sleep(20), [], 'a standing subject is never a second wake');
});

test('unit:pipeline-wait-hotspots — approval→merge: a standing verdict wakes the loop to request its rework round within one tick, once', async () => {
  const { master } = await setup();
  assert.deepEqual(loopWakeSubjects([failedCheck()], master, clock, []).map(subject => subject.key), [`decision:GY-1468:rework:${head}:ci:test`]);
  const wake = new LoopWake(100);
  const passing = failedCheck();
  passing.observation!.checks = [{ appId: 15368, name: 'test', result: 'pending' } as never];
  wake.observe(loopWakeSubjects([passing], master, clock, []));
  const started = Date.now(), sleeping = wake.sleep(300_000);
  wake.observe(loopWakeSubjects([failedCheck()], master, clock, []));
  assert.deepEqual(await sleeping, ['GY-1468 needs a rework decision']);
  assert.ok(Date.now() - started < 1_000);
  wake.observe(loopWakeSubjects([failedCheck()], master, clock, []));
  assert.deepEqual(await wake.sleep(20), []);
  // Once the round is requested the item waits on a worker — its dispatch and a free slot — not on a decision.
  assert.deepEqual(loopWakeSubjects([{ ...failedCheck(), reworkRequested: true }], master, clock, []).map(subject => subject.key), ['dispatch:GY-1468:1', 'slot:alpha', 'slot:beta']);
});

test('unit:pipeline-wait-hotspots — the dispatcher tick hands its snapshot and agents to the loop, and a wake that cannot be judged never fails the tick', async () => {
  const { master } = await setup();
  const work = { current: [waiting()] }, agents = { current: [working('agent-beta')] };
  const seen: { keys: string[]; agents: number; clock: number }[] = [];
  const effects = { ...tickEffects(master, work, agents, new LoopWake()), observeLoopSubjects: (items: Work[], herdr: HerdrAgent[] | null, at: number) => { seen.push({ keys: items.map(item => item.key), agents: herdr?.length ?? -1, clock: at }); } };
  const tick = await runDispatchTick(master, emptyDispatchCursor(master), effects);
  assert.deepEqual(seen.map(entry => [entry.keys, entry.agents]), [[['GY-1490'], 1]]);
  assert.equal(seen[0].clock, Date.parse(tick.at));
  const failing = await runDispatchTick(master, emptyDispatchCursor(master), { ...effects, observeLoopSubjects: () => { throw new Error('unreadable'); } });
  assert.deepEqual(failing.refused, []);
});

test('unit:pipeline-wait-hotspots — a wake ends only the sleep after a cycle that ran: a failed cycle\'s backoff is not cut short, and a wake during a cycle is kept for the next sleep', async () => {
  const { master } = await setup();
  // Kept: woken while no sleep runs, the next sleep returns at once with the reasons.
  const kept = new LoopWake(50);
  kept.wake(['GY-1 is claimable']);
  assert.deepEqual(await kept.sleep(300_000), ['GY-1 is claimable']);
  // A stop ends the sleep too, with no reasons.
  const stopping = new AbortController(), stopped = kept.sleep(300_000, stopping.signal);
  stopping.abort();
  assert.deepEqual(await stopped, []);

  // A loop whose every cycle fails is woken by nothing: its next attempt waits out its backoff.
  const wake = new LoopWake(0), signal = 'SIGUSR2' as NodeJS.Signals;
  let reads = 0;
  const effects = { ...loopEffects({ current: [] }, { current: [] }, { dispatches: [], snapshots: 0 }), snapshot: async () => { reads++; throw new Error('the plane is down'); } };
  const running = runDaemon(master, emptyDaemonState(master), effects, { intervalMs: 300_000, identity: { pid: process.pid, host: 'machine-a' }, signals: [signal], log: () => {}, wake, checkout: () => clean(master.cliPath) });
  try {
    assert.ok(await until(() => reads >= 1, 5_000));
    wake.wake(['GY-1 is claimable']);
    await sleep(300);
    assert.equal(reads, 1, 'the failed cycle backs off whatever the dispatcher sees');
  } finally { process.emit(signal); await running; }
});

test('unit:pipeline-wait-hotspots — the wake is bounded: woken cycles stand one floor apart, a subject absent for one tick (Herdr unreadable once) never wakes the loop again, and the log keeps the newest reasons', async () => {
  // The floor: a wake that stands when the sleep begins still waits the floor out, and the default floor is one 10 s dispatch tick.
  assert.equal(new LoopWake().floorMs, 10_000);
  let floor = 250;
  const spaced = new LoopWake(() => floor);
  spaced.wake(['GY-1 is claimable']);
  const started = Date.now();
  assert.deepEqual(await spaced.sleep(300_000), ['GY-1 is claimable']);
  assert.ok(Date.now() - started >= 240 && Date.now() - started < 2_000, `the woken sleep lasted the floor: ${Date.now() - started} ms`);
  floor = 10_000;
  spaced.wake(['GY-2 is claimable']);
  assert.equal(spaced.due(5_000, 300_000), false, 'woken inside the floor (read live from the configured dispatch interval): not yet due');
  assert.equal(spaced.due(10_000, 300_000), true, 'woken past the floor: due');
  assert.equal(spaced.due(10_000, 8_000), true, 'a wait shorter than the floor ends at the wait');
  assert.deepEqual(spaced.take(), ['GY-2 is claimable']);
  assert.equal(spaced.due(10_000, 300_000), false, 'nothing woke it: it sleeps its wait');

  // Hysteresis: a slot subject that drops out for one tick and comes back is no second wake; one gone for two ticks is.
  const wake = new LoopWake(0), claimable = { key: 'dispatch:GY-1:0', reason: 'GY-1 is claimable' }, slot = { key: 'slot:alpha', reason: 'alpha is free' };
  wake.observe([claimable, slot]);
  assert.deepEqual(wake.observe([claimable]), [], 'Herdr unreadable for one tick: the slot drops out');
  assert.deepEqual(wake.observe([claimable, slot]), [], 'and back the next tick: no wake');
  wake.observe([claimable]); wake.observe([claimable]);
  assert.deepEqual(wake.observe([claimable, slot]).map(subject => subject.key), ['slot:alpha'], 'gone two ticks, it is a new subject');
  assert.deepEqual(wake.take(), ['alpha is free']);
  // A flapping subject that is absent every other tick across a simulated hour wakes the loop never.
  for (let tick = 0; tick < 360; tick++) assert.deepEqual(wake.observe(tick % 2 ? [claimable] : [claimable, slot]), []);

  // The log line keeps the newest reasons when a wake carries more than its limit.
  const many = new LoopWake(0);
  many.wake(Array.from({ length: loopWakeReasonLimit + 5 }, (_, index) => `reason ${index}`));
  const reasons = many.take();
  assert.equal(reasons.length, loopWakeReasonLimit);
  assert.equal(reasons.at(-1), `reason ${loopWakeReasonLimit + 4}`);
  assert.equal(reasons[0], 'reason 5');
});

test('unit:pipeline-wait-hotspots — approval→merge: a candidate whose gates all pass is enqueued for merge by the same observation that publishes its verdict, with no loop cycle between', async () => {
  const candidate = { sha: head, baseSha: base, pr: 963, branch: 'graphyard/gy-1489-1', author: 'worker' };
  const passing = waiting({ id: 'work-1489', key: 'GY-1489', stage: 'merge', epoch: 1, policyRevision: 2, candidate, submission: { epoch: 1, pr: 963 },
    gates: [{ name: 'merge', passed: true, reasons: [] }], mergeAuthorization: { sha: head, baseSha: base, policyRevision: 2, at: iso() } } as unknown as Partial<Work>);
  const calls: string[] = [];
  const github = {
    publish: async () => { calls.push('publish'); },
    mergeQueueState: async () => { calls.push('read'); return { mode: 'none', head, queue: false, mergeStateStatus: 'BLOCKED', position: null, entryState: null, groupHead: null, pullRequestId: 'PR_963', requestedAt: null } as unknown as GitHubMergeQueueState; },
    enqueuePullRequest: async (_state: GitHubMergeQueueState, sha: string) => { calls.push(`enqueue ${sha.slice(0, 4)}`); },
    dequeuePullRequest: async () => { calls.push('dequeue'); },
    publishGroupCheck: async () => { calls.push('group'); },
  } as unknown as MergeGateClient;
  // The request is the passing gate itself (GY-1235): the observation that first finds the candidate authorized records it.
  const request = { sha: head, baseSha: base, policyRevision: 2, requestedBy: 'graphyard', at: iso() };
  const gated = await gateMerge(github, passing, request);
  assert.equal(gated.action.kind, 'enqueue', gated.action.reason);
  assert.deepEqual(calls, ['publish', 'read', 'enqueue aaaa'], 'verdict published, then enqueued bound to that head, in one observation');
  // A gate that does not pass withdraws the authorization: nothing is enqueued.
  calls.length = 0;
  assert.equal((await gateMerge(github, { ...passing, gates: [{ name: 'test', passed: false, reasons: ['test is pending'] }] } as Work, request)).action.kind, 'hold');
  assert.ok(!calls.some(call => call.startsWith('enqueue')));
});
