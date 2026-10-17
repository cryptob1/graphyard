import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { daemonStateSchema, emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { mergeWriterIdle, mergeWriterKeptQueue, mergeWriterKeptRefusals, mergeWriterKeptReworks, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { MergeRecordEvent } from '../src/merge-writer/executor.js';
import * as mergerMode from '../src/merger-mode.js';
import type { MergeLedgerState } from '../src/model/merge-ledger.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';

/**
 * GY-1927: automatic merging off over three simulated days of the real loop's cycles, the
 * control-plane merge writer running in the real step order. Items are submitted every quarter
 * hour; automatic merging is switched off and on again each day; while it is off a third of the
 * held heads are released by an applied merge decision another identity approved, bound to their
 * exact head, base and policy revision, and some of those then move to a new head, which is held
 * again until a decision binds it too. Twice the hold is recorded while a trial runs, after the
 * writer selected the head from a snapshot that showed none, and the loop is restarted from its
 * persisted state every eight hours. No head may be pushed while the hold stands over it, every
 * item is delivered exactly once with one push, the plane refuses every intent it is sent under a
 * hold, the writer asks the plane for the hold at most twice per merge, the state stays bounded,
 * and the loop makes no GitHub call.
 */
const minute = 60_000, hour = 60 * minute;
const start = Date.parse('2030-06-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const base = sha('base');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy', retrials: 3 } } });
let githubCalls = 0;
const githubDouble = new Proxy({}, { get: (_, name) => { githubCalls += 1; throw new Error(`the merge writer step called GitHub (${String(name)})`); } });
// Read through the namespace, so the file loads (and fails) against a base without the export.
const { mergeHoldReason } = mergerMode as any;

const items = 260, submitEveryMs = 15 * minute, cycleMs = 3 * minute, cycles = (3 * 24 * hour) / cycleMs;
/** Automatic merging is off from 06:00 to 18:00 each day. */
const off = (at: number) => { const hourOfDay = new Date(at).getUTCHours(); return hourOfDay >= 6 && hourOfDay < 18; };
const released = (n: number) => n % 3 === 0;
const movesAfterRelease = (n: number) => n % 9 === 0;
/** The two items whose trial the hold lands under (both submitted just before 06:00 on a day). */
const holdDuringTrial = new Set([23, 119]);
const restartEvery = (8 * hour) / cycleMs;

interface Submission { n: number; head: string; submittedAt: number; attempt: number }
interface Decision { action: 'merge'; state: 'applied'; input: { sha: string; baseSha: string; policyRevision: number }; requestedBy: string; approvedBy: string }
class World {
  main = [base];
  pushes: { mergeSha: string; head: string; n: number }[] = [];
  recorded = new Map<number, MergeRecordEvent[]>();
  submissions = new Map<number, Submission>();
  decisions = new Map<number, Decision[]>();
  autoMerge = true;
  /** Set while the next trial of one of `holdDuringTrial` should see the hold recorded under it. */
  pendingTrialHold = new Set(holdDuringTrial);
  trialHolds: number[] = [];
  pushedUnderHold: string[] = []; refusedIntents = 0; holdReads = 0; merges = 0; trials = 0;
  constructor(readonly now: () => number) {}
  tip() { return this.main[0]!; }
  submit(n: number, attempt: number, at: number) { this.submissions.set(n, { n, head: sha(`head${n}-${attempt}`), submittedAt: at, attempt }); }
  /** The hold the plane reads for item n now: the real rule over this world's setting and decisions. */
  hold(n: number) {
    const entry = this.submissions.get(n)!;
    const work = { key: `GY-${n}`, candidate: { sha: entry.head, baseSha: base, pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' }, policyRevision: 1 };
    return mergeHoldReason(work, { autoMerge: this.autoMerge }, this.decisions.get(n) ?? []) as string | null;
  }
  ledger(n: number) {
    let ledger = null as MergeLedgerState | null;
    for (const event of this.recorded.get(n) ?? []) {
      if (event.kind === 'intent') ledger = { key: `GY-${n}`, state: 'intent', head: event.head, baseTip: event.baseTip, mergeSha: event.mergeSha, risk: event.risk, intentAt: event.at, pushedAt: null, observedTip: null, refusal: null, events: (ledger?.events ?? 0) + 1 };
      else if (event.kind === 'pushed' && ledger) ledger = { ...ledger, state: 'pushed', pushedAt: event.pushedAt, events: ledger.events + 1 };
      else if (event.kind === 'reconciled' && ledger) ledger = { ...ledger, state: 'reconciled', observedTip: event.observedTip, events: ledger.events + 1 };
      else if (event.kind === 'refused') ledger = { key: `GY-${n}`, head: event.head, baseTip: null, mergeSha: null, risk: null, intentAt: null, pushedAt: null, observedTip: null, events: 1, ...ledger, state: 'refused', refusal: { kind: 'merge', reason: event.reason } };
    }
    return ledger;
  }
  /** The coordination view at `now`, each held candidate annotated with its hold as the route serves it. */
  snapshot(): Work[] {
    const now = this.now();
    return [...this.submissions.values()].filter(entry => entry.submittedAt <= now).map(entry => {
      const n = entry.n, ledger = this.ledger(n);
      const delivered = ledger?.state === 'reconciled' && ledger.head === entry.head;
      const candidate = { sha: entry.head, baseSha: base, pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' };
      const hold = delivered ? null : this.hold(n);
      return {
        id: `w${n}`, key: `GY-${n}`, description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
        policy: { checks: ['test'], review: true }, plannedFiles: [], revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(entry.submittedAt),
        ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: n }, candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [], mergeLedger: ledger,
        observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: delivered, mergeSha: delivered ? ledger!.mergeSha : null, mergeable: true, protected: false, baseTip: this.tip(), baseTipContained: true, at: iso(now) },
        gates: ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: true, reasons: [] })),
        ...(hold ? { mergeHold: hold } : {}),
        ...(delivered ? { stage: 'done', delivery: { mergedAt: ledger!.pushedAt ?? iso(now), mergeSha: ledger!.mergeSha!, authorizationRevision: 1 } } : { stage: 'build' }),
      } as unknown as Work;
    });
  }
  ports(): MergeWriterReads {
    const world = this, ordinal = (item: { key: string }) => Number(item.key.slice(3));
    return {
      baseBranch: 'main', retrials: 3, now: this.now, merger: async () => 'control-plane',
      fetch: async () => world.tip(),
      merge: async (head, baseTip) => ({ mergeSha: sha(`merge:${head}:${baseTip}`), files: ['src/app.ts'] }),
      trial: async (_mergeSha, _files, item) => {
        world.trials += 1;
        const n = ordinal(item);
        // The hold is recorded while this trial runs: the writer selected the head from a snapshot that showed none.
        if (world.pendingTrialHold.has(n)) { world.pendingTrialHold.delete(n); world.autoMerge = false; world.trialHolds.push(n); }
        await new Promise(resolve => setTimeout(resolve, 1));
        return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1000, logTail: '', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } };
      },
      hold: async item => { world.holdReads += 1; return world.hold(ordinal(item)); },
      push: async (mergeSha, baseTip) => {
        const n = [...world.submissions.values()].find(submission => sha(`merge:${submission.head}:${baseTip}`) === mergeSha)!.n;
        if (world.hold(n)) world.pushedUnderHold.push(`GY-${n}`);
        if (baseTip !== world.tip()) return 'rejected';
        world.main.unshift(mergeSha); world.pushes.push({ mergeSha, head: world.submissions.get(n)!.head, n });
        return 'pushed';
      },
      holds: async commit => world.main.includes(commit),
      // The plane's merge-record route: an intent under a standing hold is refused (409), as merge-record.ts refuses it.
      record: async (item, event) => {
        const n = ordinal(item);
        if (event.kind === 'intent' && world.hold(n)) { world.refusedIntents += 1; throw Object.assign(new Error(`Graphyard refused work/${item.id}/merge-record (409): ${world.hold(n)}`), { status: 409 }); }
        if (event.kind === 'intent') world.merges += 1;
        world.recorded.set(n, [...(world.recorded.get(n) ?? []), event]);
      },
    };
  }
}

test('unit:soak-merge-hold — three simulated days of the real loop with automatic merging switched off and on: no head is pushed while the hold stands over it, only exact-candidate merge decisions release one, a new head is held again, a hold recorded mid-trial lands nothing, restarts keep it, every item is delivered exactly once, and the writer stays bounded with no GitHub call', { timeout: 300_000 }, async () => {
  let now = start;
  const world = new World(() => now);
  for (let n = 1; n <= items; n++) world.submit(n, 1, start + n * submitEveryMs);
  const effects = (): DaemonEffects => ({ agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: world.snapshot(), now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, decisions: async () => ({ decisions: [] }), persist: async () => {},
    github: githubDouble, merge: githubDouble, shadow: null, mergeWriter: world.ports(), decide: async () => { throw new Error('no rework is owed in this soak'); } } as unknown as DaemonEffects);
  let state: DaemonState = emptyDaemonState(config), loopEffects = effects(), restarts = 0;
  const heldPassedThrough = new Set<string>();
  for (let cycle = 0; cycle < cycles; cycle++) {
    now = start + cycle * cycleMs;
    // The day's switch, recorded by the operator (a hold the trial recorded early stands until the switch turns it back on).
    world.autoMerge = !off(now) && !(world.trialHolds.length && off(now + hour));
    // While the hold stands, a third of the held heads get an applied decision another identity approved, half an hour after submission.
    for (const entry of world.submissions.values()) {
      if (entry.submittedAt > now || !released(entry.n) || world.ledger(entry.n)?.state === 'reconciled') continue;
      if (!world.autoMerge && world.hold(entry.n)) heldPassedThrough.add(`${entry.n}:${entry.head}`);
      if (!world.autoMerge && world.hold(entry.n) && now >= entry.submittedAt + 30 * minute) world.decisions.set(entry.n, [...world.decisions.get(entry.n) ?? [], { action: 'merge', state: 'applied', input: { sha: entry.head, baseSha: base, policyRevision: 1 }, requestedBy: 'graphyard-master', approvedBy: 'graphyard-approver' }]);
    }
    // A released head that moves before it merges is held again: the worker pushes a new head an hour after its first decision.
    for (const entry of world.submissions.values()) {
      if (!movesAfterRelease(entry.n) || entry.attempt !== 1 || !world.decisions.get(entry.n)?.length || world.ledger(entry.n)?.state === 'reconciled') continue;
      if (now >= entry.submittedAt + 90 * minute) world.submit(entry.n, 2, now);
    }
    // The loop restarts from its persisted state every eight hours, with fresh effects.
    if (cycle && cycle % restartEvery === 0) {
      await mergeWriterIdle(state);
      state = daemonStateSchema.parse(JSON.parse(JSON.stringify(state)));
      loopEffects = effects(); restarts += 1;
    }
    await runCycle(config, state, loopEffects, () => now);
    await mergeWriterIdle(state);
    assert.ok(state.mergeWriter.queue.length <= mergeWriterKeptQueue && state.mergeWriter.refusals.length <= mergeWriterKeptRefusals && state.mergeWriter.reworks.length <= mergeWriterKeptReworks, `cycle ${cycle}: the state is bounded`);
    assert.deepEqual(world.pushedUnderHold, [], `cycle ${cycle}: nothing is pushed while the hold stands over it`);
  }
  // The last day's switch turns automatic merging back on at 18:00, so everything still held is delivered by the end.
  const final = world.snapshot();
  assert.equal(final.length, items);
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => item.key), [], 'every item is delivered by the end');
  assert.equal(new Set(world.pushes.map(push => push.mergeSha)).size, world.pushes.length, 'no merge commit was pushed twice');
  assert.equal(new Set(world.pushes.map(push => push.n)).size, items, 'each item was pushed exactly once');
  for (const item of final) assert.equal(world.pushes.find(push => push.n === Number(item.key.slice(3)))!.head, item.candidate!.sha, `${item.key} was delivered on its current head`);
  // What the hold did over the days.
  assert.ok(heldPassedThrough.size > 20, `heads were held: ${heldPassedThrough.size}`);
  const releasedPushes = world.pushes.filter(push => world.decisions.get(push.n)?.some(decision => decision.input.sha === push.head));
  assert.ok(releasedPushes.length > 10, `exact-candidate decisions released heads while the hold stood: ${releasedPushes.length}`);
  for (const n of [...world.decisions.keys()].filter(movesAfterRelease)) {
    const moved = world.submissions.get(n)!;
    if (moved.attempt !== 2) continue;
    assert.ok(!world.pushes.some(push => push.n === n && push.head === sha(`head${n}-1`)), `GY-${n}'s first head, moved after its decision, was never pushed`);
  }
  assert.deepEqual(world.trialHolds.sort((a, b) => a - b), [...holdDuringTrial].sort((a, b) => a - b), 'the hold landed under both scripted trials');
  for (const n of holdDuringTrial) {
    const refusals = (world.recorded.get(n) ?? []).filter(event => event.kind === 'refused').map(event => (event as { reason: string }).reason);
    assert.equal(refusals.filter(reason => /automatic merging is off/.test(reason)).length, 1, `GY-${n}: the push under the new hold was refused and recorded once: ${refusals.join(' | ')}`);
  }
  assert.equal(world.refusedIntents, 0, 'the writer asked for the hold before every intent, so the plane refused none');
  assert.ok(world.holdReads <= 2 * (world.merges + cycles), `the hold is read at most twice per merge: ${world.holdReads} reads for ${world.merges} merges`);
  assert.equal(restarts, Math.floor((cycles - 1) / restartEvery));
  assert.equal(githubCalls, 0, 'the loop made no GitHub call');
  assert.deepEqual(daemonStateSchema.parse(JSON.parse(JSON.stringify(state))).mergeWriter, state.mergeWriter);
});
