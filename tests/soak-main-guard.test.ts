import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RerunPending, type GitHub } from '../src/github.js';
import { mainCancelledRerunLimit } from '../src/main-guard.js';
import { SimulatedGitHub, clock, hour, minute, protectionOnlyCheck } from './helpers/soak-world.js';
import { file } from './helpers/soak-plane.js';
import { soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * The main guard under GitHub delivery: merges that break main reverted, given up or landed
 * through the revert approver. One concern of the release-candidate soak (GY-404), split per
 * concern (GY-1363) so concurrent changes stop colliding in one file: the world is
 * tests/helpers/soak-world.ts, the control planes tests/helpers/soak-plane.ts, the day itself
 * tests/helpers/soak-simulation.ts, and every suite asserts the system invariants after every
 * cycle.
 */
soakControlPlanes('soak-main-guard', 406);

test('unit:soak-invariants-hold — under GitHub delivery the main guard across a day: a merge that breaks main is reverted once and its item reopened and delivered again, a revert that fails its own checks is given up with an attention line repeated while main is red and raised once as recovered, never again after the cursor prunes its row, no revert pull request is left open, and the guard reads a bounded amount per tick', { timeout: 600_000 }, async () => {
  // GY-1250: the guard runs in the job loop (`processJob`) every tick and the loop raises an
  // abandoned revert's attention line from the item's record every cycle, so both repeat per tick,
  // per item and per merge and belong in this world. GitHub merges what passes; items two and four
  // each pass CI alone and break main's `test` once merged. Item two's revert merges and it is
  // reopened; item four's revert fails its own `test`, so it is given up after one attempt.
  const before = process.env.GRAPHYARD_DELIVERY;
  process.env.GRAPHYARD_DELIVERY = 'github';
  let day: Awaited<ReturnType<typeof simulateDay>>;
  try {
    day = await simulateDay({
      hours: 6, mainGuard: { breaks: 2, abandons: 4, fixAfterMs: 30 * minute },
      plan: { items: 6, leftovers: 1, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, attested: 0, exhaustedReviewer: 0, unstable: 0, lowLane: 0, outOfQueue: { item: 6, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 6 } },
    });
  } finally { if (before === undefined) delete process.env.GRAPHYARD_DELIVERY; else process.env.GRAPHYARD_DELIVERY = before; }
  const { items, final, violations, failures, lost, github, escalations, guardDay } = day;
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item is delivered, the reopened one included');
  assert.deepEqual(violations, [], 'every system invariant holds across the reverts');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost');

  const [reverted, givenUp] = [items[1].key, items[3].key];
  const brokenBy = (key: string) => github.broken.find(entry => entry.key === key)!;
  assert.ok(brokenBy(reverted) && brokenBy(givenUp), `both breaking merges landed: ${github.broken.map(entry => entry.key).join(', ')}`);
  // Each merge is reverted at most once: one revert pull request per breaking merge, none for any other.
  const reverts = [...github.reverts.values()];
  assert.deepEqual(reverts.map(revert => revert.mergeSha).sort(), [brokenBy(reverted).mergeSha, brokenBy(givenUp).mergeSha].sort(), 'exactly the two breaking merges were reverted, once each');
  assert.deepEqual(reverts.filter(revert => revert.open).map(revert => revert.key), [], 'no revert pull request is left open');

  // The merged revert: the item is reopened, reworked on a new pull request, and delivered again.
  const reopened = final.find(item => item.key === reverted)!;
  assert.deepEqual(reopened.mainGuardReverts?.map(revert => revert.state), ['merged']);
  assert.match(reopened.mainGuardReverts![0].reason!, /test failed on that merge commit while its parent passed/);
  assert.equal(github.merges.filter(merge => merge.key === reverted).length, 2, 'the reopened item merged again on a fresh pull request');
  assert.notEqual(reopened.delivery?.mergeSha, brokenBy(reverted).mergeSha, 'its delivery is the new merge');
  assert.ok(reverts.find(revert => revert.key === reverted)!.merged, 'the App merged its revert');
  // GY-1291: branch protection refuses the App's merge of its own push without another's approval,
  // so the revert approver approved exactly the revert's head, once, after its diff was read once.
  const mergedRevert = [...github.reverts].find(([, revert]) => revert.key === reverted)!;
  assert.deepEqual(mergedRevert[1].approvals, [mergedRevert[1].head], 'the merged revert was approved at its head, once');
  assert.deepEqual(github.guardRequests.filter(request => request.kind === 'approve').map(request => `${request.pr}@${request.sha}`), [`${mergedRevert[0]}@${mergedRevert[1].head}`], 'only the verified revert is approved, once');
  assert.deepEqual(github.guardRequests.filter(request => request.kind === 'merge-diff' || request.kind === 'revert-diff').map(request => request.kind), ['merge-diff', 'revert-diff'], 'the diffs are read once, for the revert whose checks passed');

  // The given-up revert: closed after one attempt, its item left delivered, and one attention line.
  const kept = final.find(item => item.key === givenUp)!;
  assert.deepEqual(kept.mainGuardReverts?.map(revert => revert.state), ['abandoned']);
  assert.match(kept.mainGuardReverts![0].reason!, /own required checks failed: test/);
  assert.equal(kept.delivery?.mergeSha, brokenBy(givenUp).mergeSha, 'nothing withdrew the delivery whose revert was given up');
  assert.ok(reverts.find(revert => revert.key === givenUp)!.closed, 'its revert pull request was closed');
  assert.deepEqual(reverts.find(revert => revert.key === givenUp)!.approvals, [], 'the revert whose checks failed was never approved');
  // GY-1332: the line repeats every cycle while main's test is red, then is raised once as recovered and never again.
  const lines = escalations.filter(detail => detail.startsWith('Main guard:'));
  const red = lines.filter(detail => /Main is still red/.test(detail)), recovered = lines.filter(detail => /passed again; nothing is owed/.test(detail));
  assert.ok(red.length >= 2, `the line repeats while main is red: ${red.length}`);
  assert.equal(recovered.length, 1, `the line is raised once as recovered: ${lines.join(' | ')}`);
  assert.equal(lines.at(-1), recovered[0], 'nothing is raised after main passed again');
  assert.equal(lines.length, red.length + recovered.length);
  assert.match(lines[0], new RegExp(`${givenUp}'s merge ${brokenBy(givenUp).mergeSha.slice(0, 12)}.*\\(test\\).*revert PR #\\d+`));
  assert.ok(guardDay!.filled && guardDay!.linePruned, 'the cursor retired the line\'s row, and the line was not raised again');
  assert.ok(guardDay!.fixedAt !== null, 'main was fixed forward after the revert was given up');

  // The guard's reads: one history read a tick, and each commit's checks read only until they
  // conclude (a concluded verdict is kept), so a tick's reads never grow with the delivered items.
  const ticks = guardDay!.ticks;
  assert.ok(ticks.length >= 6 * 60 / 10, `the guard ran every tick of the day: ${ticks.length}`);
  assert.deepEqual(ticks.filter(tick => tick.requests.filter(request => request.kind === 'history').length !== 1).map(tick => `+${Math.round(tick.at / minute)} min`), [], 'every tick reads main\'s history exactly once');
  assert.equal(ticks.reduce((sum, tick) => sum + tick.requests.length, 0), github.guardRequests.length, 'the guard asks GitHub nothing outside its ticks');
  const reads = new Map<string, number>();
  for (const request of github.guardRequests) if (request.kind === 'checks') reads.set(request.sha!, (reads.get(request.sha!) ?? 0) + 1);
  const ciTicks = 5 + 2;
  assert.deepEqual([...reads].filter(([, count]) => count > ciTicks).map(([commit, count]) => `${commit.slice(0, 12)} ${count}`), [], `no commit's checks are read past the ticks its CI runs (${ciTicks})`);
  const busiest = Math.max(...ticks.map(tick => tick.requests.length));
  assert.ok(busiest <= 8, `a tick makes at most 8 GitHub requests: ${busiest}`);
  assert.deepEqual(ticks.at(-1)!.requests.map(request => request.kind), ['history'], 'once main is green and concluded a tick is one history read');
});

test('unit:soak.main-guard-revert-lands — under GitHub delivery with main\'s last-push-approval rule, a merge that breaks main is reverted by a pull request the revert approver App approves at its verified head and the App merges head-bound, so main is green again without an unrelated merge and the item is delivered again', { timeout: 600_000 }, async () => {
  // GY-1335: on 2026-10-05 five guard reverts were refused ("New changes require approval from someone
  // other than the last pusher") because no revert approver was configured, and main stayed red until
  // an unrelated merge. In this world GitHub refuses the App's merge of its own revert without another
  // App's approval at that head, so a revert lands only through the approver.
  const before = process.env.GRAPHYARD_DELIVERY;
  process.env.GRAPHYARD_DELIVERY = 'github';
  let day: Awaited<ReturnType<typeof simulateDay>>;
  try {
    day = await simulateDay({
      hours: 4, mainGuard: { breaks: 2, fixAfterMs: 99 * hour },
      plan: { items: 4, leftovers: 1, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, attested: 0, exhaustedReviewer: 0, unstable: 0, lowLane: 0, outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } },
    });
  } finally { if (before === undefined) delete process.env.GRAPHYARD_DELIVERY; else process.env.GRAPHYARD_DELIVERY = before; }
  const { items, final, violations, failures, lost, github, escalations } = day;
  assert.deepEqual(violations, [], 'every system invariant holds across the revert');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost');
  const key = items[1].key, broken = github.broken.find(entry => entry.key === key);
  assert.ok(broken, `the breaking merge landed: ${github.broken.map(entry => entry.key).join(', ')}`);
  const reverts = [...github.reverts];
  assert.deepEqual(reverts.map(([, revert]) => revert.mergeSha), [broken!.mergeSha], 'exactly the breaking merge was reverted, once');
  const [number, revert] = reverts[0];
  // Approved by the approver App at exactly the head the guard verified, then merged head-bound by the App.
  assert.deepEqual(revert.approvals, [revert.head], 'the revert was approved at its verified head, once');
  const kinds = github.guardRequests.filter(request => ['approve', 'merge', 'close'].includes(request.kind));
  assert.deepEqual(kinds.map(request => request.kind), ['approve', 'merge'], 'approved, then merged on the first attempt, never closed');
  assert.equal(kinds[0].pr, number); assert.equal(kinds[0].sha, revert.head);
  assert.ok(revert.merged && !revert.open && revert.closed === null, 'the App merged the revert under the last-push-approval rule');
  // Main is green from the revert's merge on: its test passes there, with no hand fix and no other merge needed.
  const runs = github.commitChecks(revert.merged!.sha, revert.merged!.at + 60 * minute).filter(run => run.name === 'test');
  assert.ok(runs.length && runs.every(run => run.result === 'success'), `main's test passes on the revert's merge: ${JSON.stringify(runs)}`);
  // The item is reopened by the merged revert and delivered again; nothing was abandoned, so no main-guard line was raised.
  const item = final.find(entry => entry.key === key)!;
  assert.deepEqual(item.mainGuardReverts?.map(entry => entry.state), ['merged']);
  assert.equal(item.stage, 'done'); assert.notEqual(item.delivery?.mergeSha, broken!.mergeSha, 'its delivery is the new merge');
  assert.deepEqual(escalations.filter(detail => detail.startsWith('Main guard:')), [], 'a landed revert raises no main-guard attention');
  // The rule this world enforces: the App's merge of a revert nobody else approved is refused.
  const unapproved = github.openRevert(items[0].key, final.find(entry => entry.key === items[0].key)!.delivery!.mergeSha);
  assert.throws(() => github.mergeRevertPull(unapproved.pr, unapproved.head), /require approval from someone other than the last pusher/);
});

// ---------------------------------------------------------------------------
// GY-1468: main runs cancelled in an infrastructure step. The shared world's main CI is extended
// here, for this day only: the first merge of each item numbered in `cancelledDay.cancels` gets a main run
// whose shards 1 and 2 are cancelled inside the apt step (the aggregate `test` failing on them) for
// that many attempts, and the adapter answers the guard's job reads and reruns of those runs.
// ---------------------------------------------------------------------------
const aptStep = 'Install bubblewrap (the confinement suite runs real namespaces)';
interface CancelledMain { key: string; mergeSha: string; runId: number; cancelledAttempts: number; attempts: { at: number; jobs: { name: string; id: number }[] }[] }
let cancelledDay: { cancels: Map<number, number>; runs: CancelledMain[]; jobReads: { at: number; checkRun: number }[]; reruns: { at: number; runId: number; attempt: number }[]; refused: number } | null = null;
let cancelledSerial = 50_000_000;
const world = SimulatedGitHub.prototype as unknown as { commitChecks(commit: string, now: number): { name: string; result: string; id: number }[]; adapter(): GitHub };
const plainChecks = world.commitChecks, plainAdapter = world.adapter;
/** The cancelled main run on `commit`, once the item's first merge landed it, or undefined. */
function cancelledMain(github: SimulatedGitHub, commit: string) {
  if (!cancelledDay) return undefined;
  const known = cancelledDay.runs.find(run => run.mergeSha === commit);
  if (known) return known;
  const merge = github.merges.find(entry => entry.sha === commit);
  const item = merge && [...cancelledDay.cancels.keys()].find(n => github.prs.get(merge.pr)?.files.includes(file(n)));
  if (!merge || item === undefined || github.merges.find(entry => entry.key === merge.key) !== merge) return undefined;
  const run: CancelledMain = { key: merge.key, mergeSha: commit, runId: 7_000_000 + cancelledDay.runs.length, cancelledAttempts: cancelledDay.cancels.get(item)!, attempts: [] };
  const all = [...Array.from({ length: 6 }, (_, index) => `test shard ${index + 1}`), 'test', 'typecheck', protectionOnlyCheck];
  run.attempts.push({ at: github.commits.get(commit)!.at, jobs: all.map(name => ({ name, id: ++cancelledSerial })) });
  cancelledDay.runs.push(run);
  return run;
}
const rerunJobs = new Set(['test shard 1', 'test shard 2', 'test']);
/** A rerun of only the cancelled shards and the aggregate concludes in two minutes; the whole first run takes CI's `ciMs`. */
const attemptMs = (github: SimulatedGitHub, index: number) => index === 0 ? github.options.ciMs : 2 * minute;
world.commitChecks = function (this: SimulatedGitHub, commit: string, now: number) {
  const run = cancelledMain(this, commit);
  if (!run) return plainChecks.call(this, commit, now);
  if (now - run.attempts[0].at < this.options.ciMs) return [];
  return run.attempts.flatMap((attempt, index) => attempt.jobs.map(job => {
    const cancelled = index + 1 <= run.cancelledAttempts && rerunJobs.has(job.name);
    const result = now - attempt.at < attemptMs(this, index) ? 'in_progress' : !cancelled ? 'success' : job.name === 'test' ? 'failure' : 'cancelled';
    return { name: job.name, result, id: job.id };
  }));
};
world.adapter = function (this: SimulatedGitHub) {
  const adapter = plainAdapter.call(this), github = this, rerun = adapter.rerunFailedJobs.bind(adapter);
  if (!cancelledDay) return adapter;
  const owner = (checkRun: number) => {
    for (const run of cancelledDay!.runs) for (const [index, attempt] of run.attempts.entries()) if (attempt.jobs.some(job => job.id === checkRun)) return { run, attempt: index + 1 };
    return undefined;
  };
  return Object.assign(adapter, {
    async jobRun(checkRun: number) {
      cancelledDay!.jobReads.push({ at: clock.now(), checkRun });
      const found = owner(checkRun);
      if (!found) throw new Error(`Check run ${checkRun} is not a GitHub Actions job; it cannot be rerun`);
      return { id: found.run.runId, attempt: found.attempt, step: aptStep };
    },
    async rerunFailedJobs(checkRun: number, options?: { runRead?: boolean; run?: { runId: number; attempt?: number } }) {
      const found = owner(checkRun);
      if (!found) return rerun(checkRun, options);
      const latest = found.run.attempts.at(-1)!;
      if (clock.now() - latest.at < attemptMs(github, found.run.attempts.length - 1)) { cancelledDay!.refused++; throw new RerunPending(found.run.runId, 'in_progress', found.run.attempts.length); }
      found.run.attempts.push({ at: clock.now(), jobs: [...rerunJobs].map(name => ({ name, id: ++cancelledSerial })) });
      cancelledDay!.reruns.push({ at: clock.now(), runId: found.run.runId, attempt: found.run.attempts.length });
      return { runId: found.run.runId, attempt: found.run.attempts.length };
    },
  }) as GitHub;
};

test('unit:soak.main-guard-cancelled-runs — under GitHub delivery across a day, a merge whose main run is cancelled in the apt step and passes on rerun, and one that stays cancelled past the rerun bound, open no revert: reruns stop at the bound, the infrastructure fault is raised once, a later real failure is still reverted, the guard stops reading a reported run, and every invariant holds each cycle', { timeout: 600_000 }, async () => {
  // GY-1468: on 2026-10-07 main's run on GY-1465's merge failed `test` only because two shards were
  // cancelled at the job timeout inside the apt step, and the guard opened a revert of a good merge.
  // Item two's main run is cancelled once and passes on its rerun; item three's stays cancelled on
  // every attempt; item six breaks main for real afterwards.
  const before = process.env.GRAPHYARD_DELIVERY;
  process.env.GRAPHYARD_DELIVERY = 'github';
  cancelledDay = { cancels: new Map([[2, 1], [3, Infinity]]), runs: [], jobReads: [], reruns: [], refused: 0 };
  let day: Awaited<ReturnType<typeof simulateDay>>;
  try {
    day = await simulateDay({
      hours: 6, mainGuard: { breaks: 6, fixAfterMs: 99 * hour },
      plan: { items: 6, leftovers: 1, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, attested: 0, exhaustedReviewer: 0, unstable: 0, lowLane: 0, outOfQueue: { item: 6, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 6 } },
    });
  } finally {
    if (before === undefined) delete process.env.GRAPHYARD_DELIVERY; else process.env.GRAPHYARD_DELIVERY = before;
  }
  const scenario = cancelledDay; cancelledDay = null;
  const { items, final, violations, failures, lost, github, escalations } = day;
  assert.deepEqual(violations, [], 'every system invariant holds every cycle across the cancelled runs');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost');
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item is delivered, the reverted one included');

  const [passes, stays, breaks] = [items[1].key, items[2].key, items[5].key];
  const run = (key: string) => scenario.runs.find(entry => entry.key === key)!;
  assert.ok(run(passes) && run(stays), `both cancelled merges landed and were run on main: ${scenario.runs.map(entry => entry.key).join(', ')}`);
  // No revert for either cancelled merge: only the real failure is reverted.
  const reverts = [...github.reverts.values()];
  assert.deepEqual(reverts.filter(revert => revert.key === passes || revert.key === stays).map(revert => revert.key), [], 'a cancelled run never opens a revert');
  const brokenBy = github.broken.find(entry => entry.key === breaks);
  assert.ok(brokenBy, 'the breaking merge landed');
  assert.deepEqual(reverts.map(revert => revert.mergeSha), [brokenBy!.mergeSha], 'the later real failure is still reverted, once');
  assert.deepEqual(final.find(item => item.key === breaks)!.mainGuardReverts?.map(revert => revert.state), ['merged']);

  // Reruns: one for the run that passes on it, the bound for the one that stays cancelled, none after.
  const reruns = (key: string) => scenario.reruns.filter(entry => entry.runId === run(key).runId).length;
  assert.equal(reruns(passes), 1, 'the run that passes on its rerun is rerun once');
  assert.equal(reruns(stays), mainCancelledRerunLimit, 'reruns stop at the bound');
  assert.equal(run(stays).attempts.length, mainCancelledRerunLimit + 1);

  // The passing rerun records nothing; the run past the bound is one infrastructure fault naming the run, its merge kept.
  const passed = final.find(item => item.key === passes)!, stayed = final.find(item => item.key === stays)!;
  assert.equal(passed.mainGuardReverts, undefined, 'a rerun that passed leaves nothing on the item');
  assert.equal(stayed.delivery?.mergeSha, run(stays).mergeSha, 'the merge whose run stayed cancelled is still delivered');
  assert.deepEqual(stayed.mainGuardReverts?.map(entry => `${entry.state} ${entry.cause} ${entry.run?.id}#${entry.run?.attempt}`), [`abandoned cancelled ${run(stays).runId}#${mainCancelledRerunLimit + 1}`]);
  assert.match(stayed.mainGuardReverts![0].reason!, new RegExp(`infrastructure fault: CI run ${run(stays).runId} .*stopped in step "Install bubblewrap`));
  const faults = escalations.filter(detail => detail.startsWith('Main guard:') && /infrastructure fault/.test(detail));
  assert.equal(faults.length, 1, `the infrastructure fault is raised once, not every cycle: ${faults.join(' | ')}`);
  assert.match(faults[0], new RegExp(`${stays}'s merge ${run(stays).mergeSha.slice(0, 12)}.*rerun run ${run(stays).runId}`));
  assert.doesNotMatch(faults[0], /broke main/);

  // The guard's reads of the cancelled jobs are bounded: one per rerun and one to report, none once reported.
  const lastJobRun = run(stays).attempts.at(-1)!.jobs.map(job => job.id);
  const afterReport = scenario.jobReads.filter(read => lastJobRun.includes(read.checkRun));
  assert.ok(afterReport.length <= 1 + scenario.refused, `the reported run's job is read once: ${afterReport.length}`);
  assert.ok(scenario.jobReads.length <= reruns(passes) + reruns(stays) + 1 + scenario.refused, `job reads stay bounded: ${scenario.jobReads.length}`);
});
