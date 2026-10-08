import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { daemonStateSchema, daemonSummary, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { mergeWriterIdle, mergeWriterKeptQueue, mergeWriterKeptRefusals, mergeWriterKeptReworks, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { baseMovedReason, type MergeRecordEvent } from '../src/merge-writer/executor.js';
import { trialFailurePrefix } from '../src/model/rework-ground.js';
import { systemInvariants } from '../src/model/invariants.js';
import type { MergeLedgerState } from '../src/model/merge-ledger.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';

/**
 * GY-1524: the control-plane merge executor over a simulated day of the real loop's cycles, in the
 * real step order. Items are submitted every few minutes; the base tip moves under some pushes
 * (one re-trial lands, one head exhausts its re-trials and is queued again); some trials fail
 * (refused, reworked, resubmitted on a new head); the coordinator's merge-record route is down for
 * stretches (a step fails before or after the push, and the next cycle reconciles or retries);
 * the executor is killed between a push and its record (reconciled, no second push); and the
 * rework decision route refuses a few requests before taking them. The writer must deliver every
 * item exactly once, push every merge commit exactly once, run one merge at a time, request each
 * owed rework exactly once, keep its state bounded, and hold every system invariant
 * docs/master-agent.md#system-invariants names.
 */
const minute = 60_000;
const start = Date.parse('2030-05-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy', retrials: 3 } } });
const githubDouble = new Proxy({}, { get: (_, name) => { throw new Error(`the merge writer step called GitHub (${String(name)})`); } });
const docs = fileURLToPath(new URL('../docs/master-agent.md', import.meta.url));

/** The day's script, by item ordinal. */
const items = 150, submitEveryMs = 9 * minute, cycleMs = 2 * minute, cycles = (24 * 60) / 2;
const sensitive = (n: number) => n % 10 === 0;
const failsTrial = (n: number) => n % 17 === 0;
const refusedDecisions = (n: number) => n % 34 === 0 ? 2 : 0;
const tipMovesOnce = (n: number) => n % 11 === 0 && !failsTrial(n);
const tipMovesAlways = (n: number) => n === 53;
const killedAfterPush = (n: number) => n === 23 || n === 77;
const lostTrialRecord = (n: number) => n === 41;
const routeDown = (cycle: number) => cycle % 97 < 2;

interface Submission { n: number; head: string; submittedAt: number }
class World {
  /** main's first-parent chain, newest first. */
  main = [sha('base')];
  pushes: string[] = [];
  recorded = new Map<number, MergeRecordEvent[]>();
  reworked = new Map<number, { confirmedAt: number }>();
  decided: { n: number; binding: string }[] = [];
  refusedRequests = new Map<number, number>();
  submissions = new Map<number, Submission>();
  trials = 0; running = 0; widest = 0; killed = new Set<number>(); movedAlways = 0; cycle = 0; recordFailures = 0;
  constructor(readonly now: () => number) {}
  tip() { return this.main[0]!; }
  ordinal(head: string) { return [...this.submissions.values()].find(entry => entry.head === head)?.n ?? null; }
  submit(n: number, attempt: number, at: number) { this.submissions.set(n, { n, head: sha(`head${n}-${attempt}`), submittedAt: at }); }
  /** The items the snapshot shows at `now`: submitted ones, each with the ledger folded from what the writer recorded. */
  snapshot(): Work[] {
    const now = this.now();
    return [...this.submissions.values()].filter(entry => entry.submittedAt <= now).map(entry => {
      const n = entry.n, reworked = this.reworked.get(n);
      let ledger = null as MergeLedgerState | null;
      for (const event of this.recorded.get(n) ?? []) {
        if (event.kind === 'intent') ledger = { key: `GY-${n}`, state: 'intent', head: event.head, baseTip: event.baseTip, mergeSha: event.mergeSha, risk: event.risk, intentAt: event.at, pushedAt: null, observedTip: null, refusal: null, events: (ledger?.events ?? 0) + 1 };
        else if (event.kind === 'pushed' && ledger) ledger = { ...ledger, state: 'pushed', pushedAt: event.pushedAt, events: ledger.events + 1 };
        else if (event.kind === 'reconciled' && ledger) ledger = { ...ledger, state: 'reconciled', observedTip: event.observedTip, events: ledger.events + 1 };
        else if (event.kind === 'refused') ledger = { key: `GY-${n}`, head: event.head, baseTip: null, mergeSha: null, risk: null, intentAt: null, pushedAt: null, observedTip: null, events: 1, ...ledger, state: 'refused', refusal: { kind: 'merge', reason: event.reason } };
      }
      const delivered = ledger?.state === 'reconciled' && ledger.head === entry.head;
      const files = sensitive(n) ? ['src/store/schema.ts'] : ['src/app.ts'];
      const reviewed = !sensitive(n) || now >= entry.submittedAt + 20 * minute;
      return {
        id: `w${n}`, key: `GY-${n}`, description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
        policy: { checks: ['test'], review: true }, plannedFiles: [], revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(entry.submittedAt),
        ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: n }, candidate: { sha: entry.head, baseSha: sha('base'), pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' },
        reworkRequested: !!reworked && entry.head === sha(`head${n}-1`), scenarioRequirements: [], evidence: [], blocker: null, violations: [], mergeLedger: ledger,
        observation: { source: 'control-plane', candidate: { sha: entry.head, baseSha: sha('base'), pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' }, files, checks: [], reviews: [], merged: delivered, mergeSha: delivered ? ledger!.mergeSha : null, mergeable: true, protected: false, baseTip: this.tip(), baseTipContained: true, at: iso(now) },
        gates: ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: name === 'review' ? reviewed : name === 'build' || name === 'ready', reasons: [] })),
        ...(delivered ? { stage: 'done', delivery: { mergedAt: ledger!.pushedAt ?? iso(now), mergeSha: ledger!.mergeSha!, authorizationRevision: 1 } } : { stage: 'build' }),
      } as unknown as Work;
    });
  }
  ports(): MergeWriterReads {
    const world = this;
    return {
      baseBranch: 'main', retrials: 3, now: this.now, merger: async () => 'control-plane',
      fetch: async () => world.tip(),
      merge: async (head, baseTip) => ({ mergeSha: sha(`merge:${head}:${baseTip}`), files: ['src/app.ts'] }),
      trial: async (mergeSha, _files, item) => {
        world.trials += 1; world.running += 1; world.widest = Math.max(world.widest, world.running);
        await new Promise(resolve => setTimeout(resolve, 1));
        world.running -= 1;
        const n = Number(item.key.slice(3)), head = world.submissions.get(n)!.head, first = head === sha(`head${n}-1`);
        // A foreign commit lands on main during the trial: the leased push below is rejected.
        if ((tipMovesOnce(n) && world.trials % 2 === 1 && first) || (tipMovesAlways(n) && world.movedAlways < 4 && first)) { world.main.unshift(sha(`foreign:${world.trials}`)); if (tipMovesAlways(n)) world.movedAlways += 1; }
        const failed = failsTrial(n) && first;
        return { build: 'pass', tests: { passed: failed ? 0 : 1, failed: failed ? ['tests/item.test.ts'] : [], files: 1 }, durationMs: 1000, logTail: mergeSha, files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: failed ? 1 : 0 } } };
      },
      push: async (mergeSha, baseTip) => {
        world.running += 1; world.widest = Math.max(world.widest, world.running); world.running -= 1;
        if (baseTip !== world.tip()) return 'rejected';
        world.main.unshift(mergeSha); world.pushes.push(mergeSha);
        return 'pushed';
      },
      holds: async sha => world.main.includes(sha),
      record: async (item, event) => {
        const n = Number(item.key.slice(3));
        if (routeDown(world.cycle)) { world.recordFailures += 1; throw new Error('merge-record: route down (HTTP 503)'); }
        if (event.kind === 'pushed' && killedAfterPush(n) && !world.killed.has(n)) { world.killed.add(n); throw new Error('killed between the push and its record'); }
        // The intent landed, then the route dropped the trial record: the intent is left open with nothing pushed.
        if (event.kind === 'trial' && lostTrialRecord(n) && !world.killed.has(n)) { world.killed.add(n); throw new Error('killed between the trial and its record'); }
        world.recorded.set(n, [...(world.recorded.get(n) ?? []), event]);
      },
    };
  }
  decide: DaemonEffects['decide'] = async (work, action, _reason, input) => {
    const n = Number(work.key.slice(3));
    assert.equal(action, 'rework');
    const refused = this.refusedRequests.get(n) ?? 0;
    if (refused < refusedDecisions(n)) { this.refusedRequests.set(n, refused + 1); throw new Error('decide: route down (HTTP 503)'); }
    this.decided.push({ n, binding: (input as { binding: string }).binding });
    this.reworked.set(n, { confirmedAt: this.now() });
    return { id: randomUUID() };
  };
}

test('unit:soak-merge-writer — a simulated day on the real loop: every submitted head is delivered exactly once with exactly one push of its merge commit, one merge in flight at a time, moved tips re-trialled within the bound then queued again, failed trials reworked exactly once through refused decision requests, crashes between push and record reconciled without a second push, record outages retried, state bounded, and every system invariant docs/master-agent.md names holding', { timeout: 300_000 }, async () => {
  let now = start;
  const world = new World(() => now);
  for (let n = 1; n <= items; n++) world.submit(n, 1, start + n * submitEveryMs);
  const reads = world.ports();
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: world.snapshot(), now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, decisions: async () => ({ decisions: [] }), persist: async () => {},
    github: githubDouble, merge: githubDouble, shadow: null, mergeWriter: reads, decide: world.decide } as unknown as DaemonEffects;
  const state = emptyDaemonState(config);
  const invariantNames = new Set<string>();
  let failedCycles = 0;
  for (let cycle = 0; cycle < cycles; cycle++) {
    now = start + cycle * cycleMs; world.cycle = cycle;
    // A reworked item comes back on a new head half an hour after its rework was confirmed.
    for (const [n, { confirmedAt }] of world.reworked) if (world.submissions.get(n)!.head === sha(`head${n}-1`) && now >= confirmedAt + 30 * minute) world.submit(n, 2, now);
    const result = await runCycle(config, state, effects, () => now);
    for (const action of result.actions) if (action.kind === 'merge' && action.state === 'failed' && /failed before it was recorded|timed out/.test(action.detail) && !/route down|killed between the/.test(action.detail)) { failedCycles += 1; console.error(action.detail); }
    await mergeWriterIdle(state);
    assert.ok(state.mergeWriter.queue.length <= mergeWriterKeptQueue && state.mergeWriter.refusals.length <= mergeWriterKeptRefusals && state.mergeWriter.reworks.length <= mergeWriterKeptReworks, `cycle ${cycle}: the state is bounded`);
    assert.ok(world.widest <= 1, `cycle ${cycle}: one merge in flight`);
    for (const check of state.invariants.report) { invariantNames.add(check.invariant); assert.ok(check.holds, `cycle ${cycle}: invariant ${check.invariant} is violated: ${check.line}`); }
  }
  assert.equal(failedCycles, 0, 'no merge failed for a cause the script did not inject');
  // Every item delivered exactly once, each on its own merge commit, each pushed exactly once, main's chain holding every one.
  const final = world.snapshot();
  assert.equal(final.length, items);
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => item.key), [], 'every item is delivered by the end of the day');
  const delivered = final.map(item => item.delivery!.mergeSha);
  assert.equal(new Set(delivered).size, items, 'each item has its own merge commit');
  assert.equal(new Set(world.pushes).size, world.pushes.length, 'no merge commit was pushed twice');
  assert.deepEqual([...delivered].sort(), [...world.pushes].sort(), 'what was pushed is exactly what was delivered: no delivery without a push, no push without a delivery');
  for (const mergeSha of delivered) assert.ok(world.main.includes(mergeSha), `${mergeSha.slice(0, 12)} is on main's first-parent chain`);
  assert.ok(world.trials > items, `re-trials happened: ${world.trials} trials for ${items} items`);
  // The scripted faults each left their trace and were recovered from.
  const reasons = (n: number) => (world.recorded.get(n) ?? []).filter(event => event.kind === 'refused').map(event => (event as { reason: string }).reason);
  assert.ok(reasons(53).includes(baseMovedReason(4)), `GY-53 exhausted its re-trials: ${reasons(53).join(' | ')}`);
  assert.equal(final.find(item => item.key === 'GY-53')!.stage, 'done', 'and was merged once the tip held still');
  const failing = Array.from({ length: items }, (_, index) => index + 1).filter(failsTrial);
  assert.deepEqual(world.decided.map(entry => entry.n).sort((a, b) => a - b), failing, 'each failed trial got exactly one rework request, the refused ones included');
  for (const n of failing) { assert.ok(reasons(n).some(reason => reason.startsWith(trialFailurePrefix)), `GY-${n} was refused for its trial`); assert.equal(world.refusedRequests.get(n) ?? 0, refusedDecisions(n), `GY-${n}'s request was refused ${refusedDecisions(n)} times first`); assert.equal(world.submissions.get(n)!.head, sha(`head${n}-2`), `GY-${n} came back on a new head`); }
  assert.ok(failing.some(n => refusedDecisions(n) > 0), 'some requests were refused before they were taken');
  assert.deepEqual(state.mergeWriter.reworks, [], 'no rework is still owed');
  for (const n of [23, 77]) {
    const kinds = (world.recorded.get(n) ?? []).map(event => event.kind);
    assert.deepEqual(kinds.filter(kind => kind === 'pushed' || kind === 'reconciled'), ['pushed', 'reconciled'], `GY-${n}: killed after its push, it was reconciled once: ${kinds.join(', ')}`);
    assert.equal(world.pushes.filter(mergeSha => mergeSha === final.find(item => item.key === `GY-${n}`)!.delivery!.mergeSha).length, 1, `GY-${n} was pushed once`);
  }
  assert.ok(world.recordFailures > 0, 'the record route was down for stretches');
  assert.ok(reasons(41).some(reason => /was never pushed/.test(reason)), `GY-41: the intent whose trial record was lost was reconciled as never pushed and queued again: ${reasons(41).join(' | ')}`);
  assert.equal(world.pushes.filter(mergeSha => mergeSha === final.find(item => item.key === 'GY-41')!.delivery!.mergeSha).length, 1);
  // Delivery kept pace: no head waited longer than two hours past its submission.
  for (const item of final) {
    const submittedAt = Date.parse(item.stageEnteredAt), mergedAt = Date.parse(item.delivery!.mergedAt);
    assert.ok(mergedAt - submittedAt <= 120 * minute, `${item.key} waited ${(mergedAt - submittedAt) / minute} minutes`);
  }
  // The state round-trips, the summary reports it, and every invariant the guide names was judged.
  assert.deepEqual(daemonStateSchema.parse(JSON.parse(JSON.stringify(state))).mergeWriter, state.mergeWriter);
  const summary = daemonSummary(state, now, config.run.intervalSeconds * 1000, config.hostId).mergeWriter;
  assert.deepEqual([summary.queue, summary.inFlight, summary.reworks], [[], null, []]);
  assert.ok(summary.refusals.length <= mergeWriterKeptRefusals && summary.refusals.length > 0);
  const guide = readFileSync(docs, 'utf8');
  const section = guide.slice(guide.indexOf('### System invariants'), guide.indexOf('## Research and diagnosis'));
  for (const invariant of systemInvariants) { assert.ok(section.includes(`\`${invariant}\``), `docs/master-agent.md#system-invariants names ${invariant}`); assert.ok(invariantNames.has(invariant), `${invariant} was judged over the day`); }
});
