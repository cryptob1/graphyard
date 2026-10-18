import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type Work } from '../src/model.js';
import { type HerdrAgent, automaticReviewerConcurrency, decisionInput, loadMasterConfig, profileConcurrency } from '../src/master.js';
import { checkInvariants, emptyInvariantRecord, invariantDefaults, systemInvariants } from '../src/model/invariants.js';
import { type ReviewRecord, heldNameAttention, launchReview, readReviewLedger, settledCloseAttempts } from '../src/reviewer.js';
import { type DispatchEffects, emptyDispatchCursor, runDispatchTick, selectReviewerProfile } from '../src/auto-dispatch.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { daemonEffects } from '../src/daemon/effects-production.js';
import { cappedEscalationKey, cappedFilingKey, cappedRefusalRequest, cappedRereviewKey, maxCappedFilingAttempts } from '../src/daemon/cycle-review-cap.js';
import { cappedReworkBinding } from '../src/daemon/decisions.js';
import { blockingFindings } from '../src/review-cap.js';
import { readReviewBinding } from '../src/review-post.js';
import { launchDirectory } from '../src/master/launch.js';
import { fleet, requested } from './helpers/review-fleet.js';
import { clock, hour, minute } from './helpers/soak-world.js';
import { api, file, principals, soakControlPlanes, store, url } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * Review and observation under the real loop: stale rework and merges, a flaky check whose run is
 * still running, automatic reviewer concurrency, and mechanical review findings. One concern of
 * the release-candidate soak (GY-404), split per concern (GY-1363) so concurrent changes stop
 * colliding in one file: the world is tests/helpers/soak-world.ts, the control planes
 * tests/helpers/soak-plane.ts, the day itself tests/helpers/soak-simulation.ts, and every suite
 * asserts the system invariants after every cycle.
 */
soakControlPlanes('soak-review', 405);

// Keep restart-induced stale observations in their own day, trimmed to six items so it adds
// little to the soak file's runtime: pausing the whole loop changes when heads are pushed, so the
// baseline day's CI-flake schedule stays intact.
test('unit:soak-invariants-hold — stale rework wakes the observation job once and proceeds once it lands, a stale merge needs no wake, and neither storms nor grows the cursor', { timeout: 300_000 }, async () => {
  const rework = new Set([2, 4]);
  const day = await simulateDay({ hours: 6, staleRework: true, staleMerge: 2,
    plan: { items: 4, leftovers: 0, slowRecompute: 0, workMs: 15 * minute, rework, deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } } });
  const { items, final, wakes, restartLog, staleMerges, state, violations, failures, lost } = day;
  assert.deepEqual(final.filter(item => item.stage !== 'done' || !item.delivery).map(item => `${item.key} ${item.stage}`), [], 'all four items are delivered after the restarts');
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  assert.equal(final.reduce((total, item) => total + (item.pipeline?.reworkRounds ?? 0), 0), rework.size, 'every rework round completes');
  // Each rework the restart left on a stale observation woke its item's observation job.
  const reworkKeys = [...rework].map(n => items[n - 1].key);
  assert.deepEqual(restartLog.filter(entry => entry.kind === 'rework').map(entry => entry.key), reworkKeys, `one stale rework per rework item: ${JSON.stringify(restartLog)}`);
  assert.equal(staleMerges.length, 2, 'two merges were left on a stale observation');
  // Every stale rework observation the restarts left woke its item's job exactly once after that
  // restart, and the item was still delivered: no wake storm, no growth of state.actions. A merge
  // left on an old observation needs no wake: no gate reads the observation's age since GY-1235, and
  // GitHub merges it on its own protection, so it is delivered with no wake at all.
  for (const [index, entry] of restartLog.entries()) {
    const until = restartLog.slice(index + 1).find(next => next.key === entry.key)?.at ?? Infinity;
    assert.equal(wakes.filter(wake => wake.key === entry.key && wake.at >= entry.at && wake.at < until).length, entry.kind === 'rework' ? 1 : 0, `${entry.key} (${entry.kind}): ${entry.kind === 'rework' ? 'one observation wake' : 'no wake'}: ${JSON.stringify(wakes)}`);
  }
  assert.equal(wakes.length, restartLog.filter(entry => entry.kind === 'rework').length, `no wake beyond the stale rework observations: ${JSON.stringify(wakes)}`);
  assert.ok(Object.keys(state.actions).filter(key => key.startsWith('wake:observation:')).length <= wakes.length, 'one wake entry per item woken');
});

test('unit:soak-invariants-hold — a flaky check whose workflow run is still running its other jobs waits for the run under the real loop: no rerun is POSTed while it runs, one is requested once it completes, the waiting cycles add no ledger entries, and the item keeps the rerun fast path with no refusal or rework round', { timeout: 300_000 }, async () => {
  // GY-1329: GitHub refuses (403) to rerun a workflow run that has not completed, and that refusal
  // used to resolve the owed rerun and cost the item a rework round. The run here stays unfinished
  // past checkRerunVisibilityMs, so the wait must also outlast the owed rerun's visibility bound.
  const flakyItem = 2, unfinishedMs = 20 * minute;
  const { items, final, github, violations, failures, lost, dayStart } = await simulateDay({ hours: 4, unfinishedRun: { item: flakyItem, ms: unfinishedMs },
    plan: { items: 4, leftovers: 0, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: flakyItem, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } } });
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  assert.deepEqual(final.filter(item => item.stage !== 'done' || !item.delivery).map(item => `${item.key} ${item.stage}`), [], 'every item is delivered');
  const key = items[flakyItem - 1].key, flaky = final.find(item => item.key === key)!;
  // The loop read the unfinished run on several cycles, past the visibility bound, and never POSTed meanwhile.
  const waits = github.runReads.filter(read => read.key === key && read.status !== 'completed');
  assert.ok(waits.length >= 3, `the run was read unfinished on several cycles: ${JSON.stringify(github.runReads)}`);
  const failedAt = Math.min(...waits.map(read => read.at)), lastWait = Math.max(...waits.map(read => read.at));
  assert.ok(lastWait - failedAt > 15 * minute, `the wait outlasted the owed rerun's visibility bound (${(lastWait - failedAt) / minute} min)`);
  assert.deepEqual(github.refusedReruns, [], 'no rerun was POSTed while its workflow run was unfinished');
  // One rerun was requested, after the run completed.
  const reruns = github.reruns.filter(rerun => rerun.key === key);
  assert.equal(reruns.length, 1, `one rerun: ${JSON.stringify(github.reruns)}`);
  assert.ok(reruns[0].at > lastWait, 'the rerun was requested only after the run completed');
  // The ledger: one waiting entry for the one status the run held, one request, nothing refused or expired.
  const ledger = (await store.pool.query(`SELECT kind FROM events WHERE work_id = $1 AND kind LIKE 'check.rerun.%' AND created_at >= $2 ORDER BY seq`, [flaky.id, new Date(dayStart).toISOString()])).rows.map(row => row.kind);
  const count = (kind: string) => ledger.filter(entry => entry === `check.rerun.${kind}`).length;
  assert.deepEqual([count('waiting'), count('requested'), count('refused'), count('expired')], [1, 1, 0, 0], `the waiting cycles added no ledger entries beyond the one wait: ${JSON.stringify(ledger)}`);
  assert.ok(!(flaky.checkReruns ?? []).some(entry => entry.state === 'refused' || entry.state === 'expired' || /permission/i.test(entry.detail ?? '')), `no refused or expired rerun: ${JSON.stringify(flaky.checkReruns)}`);
  assert.equal(flaky.pipeline?.reworkRounds ?? 0, 0, 'the flake cost no rework round');
  assert.ok(github.contains(github.merges.find(merge => merge.key === key)!.sha, reruns[0].sha), 'the head whose rerun passed is what landed');
});

test('unit:soak-invariants-hold — automatic reviews over hours of dispatch ticks, items and heads: the default reviewer concurrency is never exceeded, every settled reviewer\'s pane is closed within one cycle, a pane Herdr will not close is retried a bounded number of times and reported, no pending session\'s pane is closed, and every invariant holds', { timeout: 180_000 }, async () => {
  // GY-1072: the automatic profile runs automaticReviewerConcurrency sessions, and reconcileReviews
  // sweeps settled reviewers' panes on every dispatch tick. Sixteen items each go through two heads
  // (changes requested, then approved); one settled reviewer's close fails once, another's forever.
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude' }, 'claude-reviewer');
  const tickMs = 30_000, reviewMs = 2 * minute, reworkMs = minute;
  try {
    const config = await loadMasterConfig(host.root);
    const limit = profileConcurrency(selectReviewerProfile(config).profile!);
    assert.equal(limit, automaticReviewerConcurrency);
    const cursor = emptyDispatchCursor(config);
    const total = 16, closeOnceRefused = { n: 3, head: 1 }, closeNeverAccepted = { n: 7, head: 2 };
    // Each item's current head, when it next enters (a rework waits for its worker), and when it was delivered.
    const items = new Map<number, { work: Work | null; head: number; enterAt: number; deliveredAt: number | null }>();
    for (let n = 1; n <= total; n++) items.set(n, { work: null, head: 1, enterAt: clock.now() + (n <= 6 ? 0 : (n - 6) * 5 * minute), deliveredAt: null });
    const live = () => [...items.values()].filter(entry => entry.work && entry.deliveredAt === null).map(entry => entry.work!);
    // Each session posts its verdict two minutes in: changes requested on a first head, an approval on the second.
    const reviewIds = new Map<string, number>();
    const observe = (record: ReviewRecord) => Date.now() - Date.parse(record.requestedAt) < reviewMs ? null
      : { state: /e2/.test(record.sha) ? 'APPROVED' : 'CHANGES_REQUESTED', reviewer: 'graphyard-reviewer[bot]', reviewId: reviewIds.get(record.id) ?? reviewIds.set(record.id, 10_000 + reviewIds.size).get(record.id)!, submittedAt: new Date().toISOString() };
    const effects = host.effects(live, () => config, observe);
    const ledgerFile = join(host.root, '.graphyard/reviews.json');
    const heldSince = new Map<string, number>(), seenPending = new Set<string>(), refused: string[] = [], ledgers: string[] = [];
    let peak = 0, cycle = 0, neverPane: string | null = null, lingeringFrom: number | null = null;
    const record = emptyInvariantRecord();
    for (; cycle < 600; cycle++) {
      for (const [n, entry] of items) if (!entry.work && entry.deliveredAt === null && entry.enterAt <= clock.now()) entry.work = requested(n, entry.head);
      const closesBefore = host.closes.length;
      const tick = await runDispatchTick(config, cursor, effects, Date.now);
      refused.push(...tick.refused.map(entry => `${entry.work}: ${entry.reason}`));
      const ledger = (await readReviewLedger(host.root)).reviews;
      // Faults armed on the panes as their sessions start.
      for (const entry of ledger.filter(entry => entry.state === 'pending' && entry.pane && !seenPending.has(entry.id))) {
        seenPending.add(entry.id);
        const n = Number(entry.key.slice(3)) - 500, head = /e2/.test(entry.sha) ? 2 : 1;
        if (n === closeOnceRefused.n && head === closeOnceRefused.head) host.refuseClose.set(entry.pane!, 1);
        if (n === closeNeverAccepted.n && head === closeNeverAccepted.head) { host.refuseClose.set(entry.pane!, Infinity); neverPane = entry.pane; }
      }
      // No pending session's pane is ever closed.
      for (const pane of host.closes.slice(closesBefore)) assert.ok(!ledger.some(entry => entry.pane === pane && entry.state === 'pending'), `cycle ${cycle}: the pane ${pane} of a pending session was closed`);
      // The profile never runs more sessions than its limit, the held name included.
      const sessions = host.agents.filter(agent => agent.name?.startsWith('claude-reviewer')).length;
      assert.ok(sessions <= limit, `cycle ${cycle}: ${sessions} reviewer sessions over the limit of ${limit}`);
      peak = Math.max(peak, sessions);
      // Every settled reviewer still in its pane is closed by the next cycle, unless Herdr refuses that close every time.
      for (const entry of ledger.filter(entry => entry.state !== 'pending' && entry.pane)) {
        const visible = host.agents.some(agent => agent.pane_id === entry.pane && agent.name === entry.agentName);
        if (!visible) { heldSince.delete(entry.pane!); continue; }
        if (!heldSince.has(entry.pane!)) heldSince.set(entry.pane!, cycle);
        if (entry.pane !== neverPane) assert.ok(cycle - heldSince.get(entry.pane!)! <= 1, `cycle ${cycle}: settled reviewer ${entry.agentName} on ${entry.key} still holds pane ${entry.pane} since cycle ${heldSince.get(entry.pane!)}`);
      }
      // A verdict moves its item on: changes requested is reworked into the next head, an approval delivers it.
      for (const entry of items.values()) {
        if (entry.deliveredAt !== null || !entry.work || !ledger.some(review => review.requestId === entry.work!.autoDispatch!.review!.id && review.state === 'completed')) continue;
        if (entry.head === 1) Object.assign(entry, { work: null, head: 2, enterAt: clock.now() + reworkMs });
        else entry.deliveredAt = clock.now();
      }
      // The lingering-sessions invariant over the delivered items, their review sessions as the runtime lists them.
      const delivered = [...items].filter(([, entry]) => entry.deliveredAt !== null).map(([n, entry]) => ({ ...requested(n, 2), stage: 'done', delivery: { mergedAt: new Date(entry.deliveredAt!).toISOString() },
        sessions: ledger.filter(review => review.key === `GY-${500 + n}`).map(review => ({ id: review.id, kind: 'review', state: 'running', agentName: review.agentName, pane: review.pane })) }) as unknown as Work);
      const lingering = checkInvariants(record, { work: delivered, now: clock.now(), agents: host.agents }).find(check => check.invariant === 'lingering-sessions')!;
      const neverKey = `GY-${500 + closeNeverAccepted.n}`, neverDelivered = items.get(closeNeverAccepted.n)!.deliveredAt;
      if (!lingering.holds) {
        assert.deepEqual(lingering.subjects, [neverKey], `cycle ${cycle}: only the pane Herdr refuses to close lingers: ${lingering.reading}`);
        assert.ok(neverDelivered !== null && clock.now() - neverDelivered > invariantDefaults.sessionAfterSettleMinutes * minute);
        lingeringFrom ??= cycle;
      }
      if ([...items.values()].every(entry => entry.deliveredAt !== null)) {
        ledgers.push(await readFile(ledgerFile, 'utf8'));
        if (lingeringFrom !== null && ledgers.length > 10) break;
      }
      clock.advance(tickMs);
    }
    assert.ok(cycle < 600, 'the day settles');
    assert.deepEqual(refused, [], 'no launch was refused at the agent-name bound or otherwise');
    assert.ok(peak >= 3, `reviews ran in parallel (peak ${peak})`);
    const ledger = (await readReviewLedger(host.root)).reviews;
    assert.equal(ledger.filter(entry => entry.state === 'completed').length, 2 * total, 'every head of every item was reviewed once');
    // The pane Herdr refused once was released by the sweep; the one it never closes was tried a bounded number of times and is reported.
    assert.equal(host.closes.filter(pane => pane === neverPane).length, 1 + settledCloseAttempts, 'the settlement close and the bounded retries, nothing more');
    const held = heldNameAttention(ledger);
    assert.deepEqual(held.map(item => item.subject), [`GY-${500 + closeNeverAccepted.n}`]);
    assert.match(held[0].text, new RegExp(`in pane ${neverPane}`));
    assert.ok(lingeringFrom !== null, 'the lingering-sessions invariant names the held pane once it outlives its bound');
    // Once every request has settled, the ledger is not rewritten on later ticks.
    assert.ok(ledgers.length > 10, `the day ran on past its last delivery (${ledgers.length} quiet cycles)`);
    assert.equal(new Set(ledgers.slice(-10)).size, 1, 'no ledger churn from the refused close');
  } finally { await host.cleanup(); }
});

test('unit:soak-invariants-hold — review findings classified mechanical under the real loop: each approved head is planned once and held from merging until its one bot round, the fresh read settles every plan, and a rejected bot commit is recorded once as a misclassified finding, with every invariant holding', { timeout: 300_000 }, async () => {
  // GY-971: every approval of the day is read from the review ledger the dispatcher keeps. Two
  // items' first approvals raise a finding classified mechanical: the review gate holds each approved
  // head from merging, the loop asks for one bot round, and the round's commit on that head is read afresh. One
  // fresh read accepts it; the other rejects it as a misclassification, which is recorded once, and
  // that item is reworked and delivered like any change request. The plan, the hold, the rework
  // decision and the fresh-read judgement repeat per cycle, head and item, which is why they live here.
  const mechanical = { applied: 2, rejected: 5 };
  const { items, final, violations, failures, lost, github, actionKeys, mechanical: world } = await simulateDay({
    hours: 6, mechanical,
    plan: { items: 6, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, exhaustedReviewer: 0, outOfQueue: { item: 6, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 6 } },
  });
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}: ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'all six items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds across the mechanical-fix rounds');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost');
  // Every approval was classified, and every plan settled: applied by its fresh read, or none to make.
  const approvals = world.ledger.filter(record => record.verdict?.state === 'APPROVED' && !record.freshRead);
  assert.ok(approvals.length >= items.length, `every item's approval reached the ledger (${approvals.length})`);
  assert.deepEqual(world.ledger.filter(record => record.mechanicalFix?.state === 'planned').map(record => `${record.key} ${record.sha.slice(0, 12)}`), [], 'no plan is left standing');
  const plans = world.ledger.filter(record => record.mechanicalFix && record.mechanicalFix.state !== 'none');
  for (const n of [mechanical.applied, mechanical.rejected]) {
    const key = items[n - 1].key, id = items[n - 1].id;
    const own = plans.filter(record => record.key === key);
    assert.equal(own.length, 1, `${key}: one plan for its approved head: ${JSON.stringify(own.map(record => record.mechanicalFix))}`);
    const plan = own[0]!.mechanicalFix!;
    assert.equal(plan.state, 'applied', `${key}: the plan was settled by the fresh read of its bot commit: ${plan.reason ?? ''}`);
    assert.deepEqual(plan.paths, [file(n)]);
    const rounds = world.botRounds.filter(round => round.key === key);
    assert.deepEqual(rounds.map(round => round.approved), [plan.head], `${key}: exactly one bot round, on the approved head`);
    assert.equal(plan.commit, rounds[0]!.head, `${key}: the fresh read reviewed the bot commit`);
    assert.equal([...actionKeys].filter(entry => entry.startsWith(`decision:rework:${id}:`) && entry.includes(':mechanical:')).length, 1, `${key}: one mechanical-fix rework decision`);
    // No merge ahead of the round: the approved head is never what landed.
    const merged = github.merges.filter(entry => entry.key === key);
    assert.equal(merged.length, 1, `${key} merged once`);
    assert.notEqual(github.commits.get(merged[0]!.sha)!.parents[1], plan.head, `${key}: the approved head ${plan.head.slice(0, 12)} was not merged ahead of its bot round`);
    assert.ok(world.reviewHolds.has(`${key} ${plan.head}`), `${key}: the review gate held the approved head for the round: ${[...world.reviewHolds].join(', ')}`);
  }
  // The accepted bot commit is what landed for its item.
  const accepted = world.botRounds.find(round => round.key === items[mechanical.applied - 1].key)!;
  assert.ok(github.contains(github.merges.find(entry => entry.key === accepted.key)!.sha, accepted.head), 'the accepted bot commit landed');
  assert.equal(world.ledger.find(record => record.sha === accepted.head)?.freshRead?.judged?.outcome, 'accepted');
  // The rejected one is recorded once as a misclassified finding, and its item was reworked and delivered without it.
  const rejected = world.botRounds.find(round => round.key === items[mechanical.rejected - 1].key)!;
  assert.equal(world.ledger.find(record => record.sha === rejected.head)?.freshRead?.judged?.outcome, 'rejected');
  assert.deepEqual(world.misclassified.map(entry => [entry.signal.kind, entry.signal.work]), [['misclassified-finding', rejected.key]], 'one intervention per rejection');
  assert.ok(!github.contains(github.merges.find(entry => entry.key === rejected.key)!.sha, rejected.head), 'the rejected bot commit did not land');
  const report = await api(principals.coordinator, 'GET', `interventions?kind=misclassified-finding&work=${rejected.key}`);
  assert.equal(report.byKind?.find((entry: { kind: string }) => entry.kind === 'misclassified-finding')?.count, 1, `the control plane holds the one misclassification: ${JSON.stringify(report.byKind)}`);
});

test('unit:soak-invariants-hold — change requests naming a blocking finding past the review-round cap under the real loop: each capped head gets one rework request and one approver, never the risk lane, never repeated across cycles; an approved round is reworked once and delivered, a refused one has its change request withdrawn once by the reviewer App, its owed rework cancelled and its head re-reviewed with the refusal, and is delivered, while a re-review requesting changes again escalates once and is never withdrawn twice, with every invariant holding', { timeout: 300_000 }, async () => {
  // GY-1389: past the cap the loop itself requests the capped round (neededDecision) for the
  // approver it launches, and the review-cap step stays quiet. GY-1575: once the approver refuses
  // the round as non-blocking, the step withdraws the change request as the reviewer App and the
  // head is reviewed again. All of it repeats per cycle, head and item: three items run past a cap
  // of 1 with a BLOCKING: change request on each head; the approver refuses the second and third
  // ones' capped rounds, and the third one's re-review requests changes again.
  const reviewCap = { cap: 1, items: [1, 3, 4], refused: [3, 4], again: [4] };
  const { items, final, violations, failures, lost, escalations, actionKeys, approverDecisions, github, state } = await simulateDay({
    hours: 6, reviewCap,
    plan: { items: 4, leftovers: 0, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, exhaustedReviewer: 0, outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } },
  });
  const [approved, refused, again] = [items[0], items[2], items[3]];
  assert.deepEqual(final.filter(item => item.key !== again.key && item.stage !== 'done').map(item => `${item.key} ${item.stage}: ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'every item but the one re-reviewed into a change request again is delivered');
  assert.deepEqual(violations, [], 'every system invariant holds across the capped rounds');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost');
  for (const work of [approved, refused, again]) {
    const decisions = (await api(principals.operatorAgent, 'GET', `work/${encodeURIComponent(work.id)}/decisions`)).decisions as { id: string; action: string; state: string; input?: { binding?: string }; approvedBy?: string | null; refusal?: { reason?: string } | null }[];
    const capped = decisions.filter(entry => entry.action === 'rework' && /:capped:/.test(entry.input?.binding ?? ''));
    assert.equal(capped.length, 1, `${work.key}: one capped rework request for its capped head: ${JSON.stringify(decisions.map(entry => [entry.action, entry.state, entry.input?.binding]))}`);
    assert.equal([...actionKeys].filter(key => key.startsWith(`decision:rework:${work.id}:`) && key.includes(':capped:')).length, 1, `${work.key}: the loop requested it once, across every cycle it stood`);
    assert.equal(approverDecisions.filter(decision => decision === capped[0].id).length, 1, `${work.key}: one approver session judged it, and none was launched again`);
    assert.equal(escalations.filter(detail => detail.includes(work.key) && /graphyard master decide \S+ rework REASON/.test(detail)).length, 0, `${work.key}: no escalation asks a master to request the round by hand`);
    const item = final.find(entry => entry.key === work.key)!, head = capped[0].input!.binding!.split(':')[0]!;
    const dismissed = github.dismissals.filter(entry => entry.key === work.key);
    if (work === approved) {
      assert.deepEqual([capped[0].state, capped[0].approvedBy], ['applied', 'graphyard-approver'], `${work.key}: the approver, not the risk lane, applied the capped round`);
      assert.equal(item.pipeline?.reworkRounds, reviewCap.cap + 1, `${work.key}: the round under the cap and the one capped round, nothing more`);
      assert.ok(item.delivery, `${work.key}: the head that answered the capped round was delivered`);
      assert.deepEqual(dismissed, [], `${work.key}: an approved round withdraws nothing`);
      continue;
    }
    assert.equal(capped[0].state, 'refused', `${work.key}: the approver refused the capped round`);
    assert.equal(item.pipeline?.reworkRounds, reviewCap.cap, `${work.key}: the refused round was not reworked`);
    // The withdrawal: once, as the reviewer App, of the head's change request, carrying the refusal and the FOLLOW-UP request.
    assert.equal(dismissed.length, 1, `${work.key}: its change request was withdrawn exactly once across every cycle: ${JSON.stringify(dismissed)}`);
    assert.equal(dismissed[0].sha, head, `${work.key}: the refused head's change request was the one withdrawn`);
    assert.ok(dismissed[0].message.includes(capped[0].refusal!.reason!) && /list these findings as FOLLOW-UP threads/.test(dismissed[0].message), `${work.key}: the withdrawal carries the refusal and the FOLLOW-UP request: ${dismissed[0].message}`);
    // One re-review request recorded for the head, and the owed request-rework never acted on: no worker reworked the refused round.
    assert.equal(state.actions[`review-cap:rereview:${work.id}:${head}`]?.state, 'done', `${work.key}: one re-review request recorded for its head`);
    const reworks = (item.actionQueue?.history ?? []).concat(item.actionQueue?.actions ?? []).filter(action => action.kind === 'request-rework' && (action.inputs as { sha?: string }).sha === head);
    const events = reworks.map(action => action.history.map(entry => entry.event));
    assert.ok(reworks.length && events.every(list => !list.includes('claimed')), `${work.key}: no request-rework owed for the refused head was ever acted on: ${JSON.stringify(events)}`);
    // The withdrawal cancels it and the approving re-review leaves nothing owed; a change request again on the same
    // binding (maybe before any observation saw the withdrawal) owes it still, and the escalation hands it to the master.
    assert.deepEqual(events.map(list => list.at(-1)), work === refused ? ['cancelled'] : ['requested'], `${work.key}: ${JSON.stringify(events)}`);
    if (work === refused) {
      assert.ok(item.delivery, `${work.key}: its re-review approved the head, which was delivered`);
      assert.equal(escalations.filter(detail => detail.includes(work.key) && /not withdrawn a second time/.test(detail)).length, 0, `${work.key}: nothing escalated a second withdrawal`);
    } else {
      assert.equal(item.stage, 'review', `${work.key}: its re-review requested changes again, so it waits in review`);
      const raised = state.actions[`escalation:review-cap:${work.id}:${head}`];
      assert.equal(raised?.state, 'done', `${work.key}: the repeated change request was escalated`);
      assert.match(raised!.detail, /requested changes again, so it is not withdrawn a second time/);
      assert.equal(raised!.attempts, 1, `${work.key}: escalated once, not on every cycle`);
    }
  }
});

test('unit:soak-invariants-hold — refused capped reworks whose record binds the capped change request under none of the step\'s readings, on two items\' capped heads under the real loop: each is escalated once by its decision id, never withdrawn on, and the loop\'s own capped round is still judged and delivered, with every invariant holding', { timeout: 300_000 }, async () => {
  // GY-1579: a prior release recorded each refusal for another reviewer slug and with no revision mark, so
  // refusedCappedRework cannot read it. The review-cap step runs over every open capped item on every cycle;
  // the escalation it adds must stay one per head, whatever the cycles, heads and items.
  const reviewCap = { cap: 1, items: [1, 2, 3], refused: [], unmatched: [2, 3] };
  const { items, final, violations, failures, lost, escalations, actionKeys, approverDecisions, github, state, unmatchedRefusals } = await simulateDay({
    hours: 6, reviewCap,
    plan: { items: 4, leftovers: 0, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, exhaustedReviewer: 0, outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } },
  });
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}: ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'every item is delivered');
  assert.deepEqual(violations, [], 'every system invariant holds across the capped rounds');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost');
  assert.deepEqual(github.dismissals, [], 'no change request is withdrawn on a refusal the step cannot bind, nor on an approved round');
  assert.deepEqual(unmatchedRefusals.map(entry => entry.key).sort(), [items[1].key, items[2].key].sort(), 'each unmatched item held its refusal on its capped head');
  for (const work of items.slice(0, 3)) {
    const decisions = (await api(principals.operatorAgent, 'GET', `work/${encodeURIComponent(work.id)}/decisions`)).decisions as { id: string; action: string; state: string; input?: { binding?: string } }[];
    const own = decisions.filter(entry => entry.action === 'rework' && (entry.input?.binding ?? '').endsWith(':capped:graphyard-reviewer[bot]'));
    assert.equal(own.length, 1, `${work.key}: the loop requested its own capped round once: ${JSON.stringify(decisions.map(entry => [entry.action, entry.state, entry.input?.binding]))}`);
    assert.equal(own[0].state, 'applied', `${work.key}: the approver judged it, and it was reworked`);
    assert.equal([...actionKeys].filter(key => key.startsWith(`decision:rework:${work.id}:`) && key.includes(':capped:')).length, 1, `${work.key}: requested once across every cycle`);
    assert.equal(approverDecisions.filter(decision => decision === own[0].id).length, 1, `${work.key}: one approver session judged it`);
    const stray = unmatchedRefusals.find(entry => entry.key === work.key);
    const raised = escalations.filter(detail => detail.includes(work.key) && /under none of its readings/.test(detail));
    if (!stray) { assert.deepEqual(raised, [], `${work.key}: nothing unmatched, nothing escalated`); continue; }
    const escalation = state.actions[`escalation:review-cap:${work.id}:${stray.sha}`];
    assert.equal(escalation?.state, 'done', `${work.key}: the unmatched refusal on its capped head was escalated`);
    assert.match(escalation!.detail, new RegExp(`refused capped rework decision ${stray.decision} on ${stray.sha.slice(0, 12)}`));
    assert.equal(escalation!.attempts, 1, `${work.key}: escalated once, not on every cycle`);
    assert.equal(raised.length, 1, `${work.key}: one escalation across the day: ${JSON.stringify(raised)}`);
  }
});

test('unit:soak-invariants-hold — refused capped reworks read as requested before the revision mark under the real loop: a legacy refusal dated under the item\'s revision withdraws its change request once and the item is delivered, its re-review requesting changes again escalates once, and an undated one is read from its binding alike (GY-1579 AC-1): withdrawn once and delivered, never left silent, with every invariant holding', { timeout: 300_000 }, async () => {
  // GY-1577, the GY-1573 round-8 shape repeated per item and cycle: the loop asked for each capped round, the approver refused
  // it, and the history the loop reads holds the refusal without GY-1575's revision mark. The first item's refusal is dated after
  // its (only) policy revision, so it binds; the second's likewise, and its re-review requests changes again; the third's carries
  // no time at all, and nothing dates it before the revision, so its binding answers the round as the others' do (GY-1579 AC-1).
  // A refusal the item's record dates before the revision still escalates rather than return silently (unit:capped-refusal-never-silent).
  const reviewCap = { cap: 1, items: [1, 2, 3], refused: [1, 2, 3], again: [2], legacy: [1, 2], undated: [3] };
  const { items, final, violations, failures, lost, escalations, github, state } = await simulateDay({
    hours: 6, reviewCap,
    plan: { items: 4, leftovers: 0, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, exhaustedReviewer: 0, outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } },
  });
  const [legacy, again, undated] = items;
  assert.deepEqual(violations, [], 'every system invariant holds across the legacy refusals');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost');
  assert.deepEqual(final.filter(item => item.key !== again.key && item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'the legacy items, the undated one included, and the uncapped one are delivered');
  assert.deepEqual(escalations.filter(detail => /does not bind this change request/.test(detail)), [], 'no legacy refusal, dated or undated, is escalated as binding nothing');
  for (const work of [legacy, again, undated]) {
    const decisions = (await api(principals.operatorAgent, 'GET', `work/${encodeURIComponent(work.id)}/decisions`)).decisions as { id: string; action: string; state: string; input?: { binding?: string } }[];
    const capped = decisions.filter(entry => entry.action === 'rework' && /:capped:/.test(entry.input?.binding ?? ''));
    assert.deepEqual(capped.map(entry => entry.state), ['refused'], `${work.key}: one capped rework, refused, requested once across every cycle`);
    const head = capped[0].input!.binding!.split(':')[0]!, item = final.find(entry => entry.key === work.key)!;
    const dismissed = github.dismissals.filter(entry => entry.key === work.key), raised = state.actions[`escalation:review-cap:${work.id}:${head}`];
    assert.equal(item.pipeline?.reworkRounds, reviewCap.cap, `${work.key}: the refused round was not reworked`);
    assert.equal(dismissed.length, 1, `${work.key}: the legacy refusal withdrew its change request exactly once: ${JSON.stringify(dismissed)}`);
    assert.equal(dismissed[0].sha, head);
    assert.match(dismissed[0].message, new RegExp(`\\(decision ${capped[0].id}\\)`), `${work.key}: the withdrawal names the unmarked refusal`);
    assert.equal(state.actions[`review-cap:rereview:${work.id}:${head}`]?.state, 'done', `${work.key}: one re-review requested for its head`);
    if (work !== again) {
      assert.ok(item.delivery, `${work.key}: its re-review approved the head, which was delivered`);
      assert.equal(raised, undefined, `${work.key}: nothing escalated`);
    } else {
      assert.equal(item.stage, 'review', `${work.key}: its re-review requested changes again, so it waits in review`);
      assert.match(raised!.detail, /requested changes again, so it is not withdrawn a second time/);
      assert.equal(raised!.attempts, 1, `${work.key}: escalated once, not on every cycle`);
    }
  }
});

test('unit:soak-invariants-hold — refused answers to refused capped heads\' escalations under the real loop: a master answer the approver refuses has the re-review\'s change request withdrawn once more and the head re-reviewed, and is delivered; a change request after that second withdrawal escalates, is answered and refused again, and is never withdrawn a third time; withdrawals, re-reviews and escalations stay bounded across cycles, items and heads, with every invariant holding', { timeout: 300_000 }, async () => {
  // GY-1580, the GY-1573 rounds 9-10 shape repeated per item and cycle: the approver refuses each capped round, the loop withdraws
  // its change request, and the re-review of the other two requests changes again. The first item's re-review approves; the master answers
  // the second and third items' escalations with the rework they name, the approver refuses each answer, and the third item's head
  // requests changes after its second withdrawal too, which the master answers once more.
  const reviewCap = { cap: 1, items: [1, 2, 3], refused: [1, 2, 3], again: [2, 3], answered: [2, 3], third: [3] };
  const { items, final, violations, failures, lost, escalations, github, state, capAnswers } = await simulateDay({
    hours: 8, reviewCap,
    plan: { items: 4, leftovers: 0, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, exhaustedReviewer: 0, outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } },
  });
  const [plain, answered, third] = items;
  assert.deepEqual(violations, [], 'every system invariant holds across the refused answers');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost');
  assert.deepEqual(final.filter(item => item.key !== third.key && item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item but the one whose head requested changes after its second withdrawal is delivered');
  for (const work of [plain, answered, third]) {
    const decisions = (await api(principals.operatorAgent, 'GET', `work/${encodeURIComponent(work.id)}/decisions`)).decisions as { id: string; action: string; state: string; input?: { binding?: string } }[];
    const capped = decisions.filter(entry => entry.action === 'rework' && /:capped:/.test(entry.input?.binding ?? ''));
    assert.deepEqual(capped.map(entry => entry.state), ['refused'], `${work.key}: one capped rework, refused, requested once across every cycle`);
    const head = capped[0].input!.binding!.split(':')[0]!, item = final.find(entry => entry.key === work.key)!;
    const dismissed = github.dismissals.filter(entry => entry.key === work.key), raised = state.actions[`escalation:review-cap:${work.id}:${head}`];
    const answers = capAnswers.filter(entry => entry.key === work.key);
    assert.ok(dismissed.every(entry => entry.sha === head), `${work.key}: only the capped head's change requests were withdrawn`);
    assert.equal(escalations.filter(detail => detail.includes(work.key) && /review-round cap/i.test(detail)).length <= answers.length + 1, true, `${work.key}: escalated once per change request the loop would not withdraw, never per cycle: ${JSON.stringify(escalations.filter(detail => detail.includes(work.key)))}`);
    if (work === plain) {
      assert.deepEqual([dismissed.length, answers.length], [1, 0], `${work.key}: withdrawn once and never answered`);
      assert.ok(item.delivery, `${work.key}: its re-review approved the head, which was delivered`);
      assert.equal(raised, undefined, `${work.key}: nothing escalated`);
      continue;
    }
    assert.ok(answers[0] && answers[0].precedent.join() === capped[0].id, `${work.key}: the master's first answer cites the capped refusal: ${JSON.stringify(answers)}`);
    assert.equal(dismissed.length, 2, `${work.key}: withdrawn twice across every cycle, never a third time: ${JSON.stringify(dismissed)}`);
    assert.ok(dismissed[1].message.includes(answers[0].decision) && dismissed[1].message.includes(capped[0].id), `${work.key}: the second withdrawal carries both refusals: ${dismissed[1].message}`);
    assert.equal(state.actions[`review-cap:rereview:${work.id}:${head}:answered`]?.state, 'done', `${work.key}: one second re-review requested for its head`);
    if (work === answered) {
      assert.ok(item.delivery, `${work.key}: its second re-review approved the head, which was delivered`);
      assert.equal(answers.length, 1, `${work.key}: answered once`);
      continue;
    }
    assert.equal(item.stage, 'review', `${work.key}: its change request after the second withdrawal stands, so it waits in review`);
    assert.equal(answers.length, 2, `${work.key}: the master answered both escalations, once each`);
    assert.ok(answers[1].precedent.includes(answers[0].decision), `${work.key}: the second answer cites the first: ${JSON.stringify(answers)}`);
    assert.match(raised!.detail, /not withdrawn a third time/);
    assert.ok(raised!.detail.includes(answers[1].decision), `${work.key}: the standing escalation names the newest refused answer: ${raised!.detail}`);
    assert.ok(raised!.attempts <= 3, `${work.key}: re-recorded only when its refusals changed, not every cycle (${raised!.attempts})`);
  }
});

test('unit:soak-invariants-hold — a capped rework asked again on a head whose change request was withdrawn once and refused too, under the real loop with no master answer: its change request is withdrawn exactly once more and the head re-reviewed with both refusals, once per refusal across cycles, and is delivered; a change request after that second withdrawal escalates once and is never withdrawn a third time, with no relaunch row while the step holds the head and every invariant holding', { timeout: 300_000 }, async () => {
  // GY-1810, the GY-1802 / GY-1773 shape per item and cycle: the approver refuses the loop's capped round, the step withdraws the
  // change request, the re-review requests changes again, the capped rework is asked again on the same binding and refused too.
  // Nothing needs a master answer: a low or medium lane applies one at once, so none can be refused there.
  const reviewCap = { cap: 1, items: [1, 2], refused: [1, 2], again: [1, 2], third: [1], asked: [1, 2] };
  const { items, final, violations, failures, lost, escalations, github, state, askedAgain, capAnswers } = await simulateDay({
    hours: 8, reviewCap,
    plan: { items: 4, leftovers: 0, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, exhaustedReviewer: 0, outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } },
  });
  const [escalated, delivered] = items;
  assert.deepEqual(violations, [], 'every system invariant holds across the repeated refusals');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost');
  assert.deepEqual(capAnswers, [], 'no master answer was asked for or given');
  assert.deepEqual(askedAgain.map(entry => entry.key).sort(), [delivered.key, escalated.key].sort(), 'each head had its capped rework asked again once');
  assert.deepEqual(final.filter(item => item.key !== escalated.key && item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item but the one whose head requested changes after its second withdrawal is delivered');
  for (const work of [delivered, escalated]) {
    const decisions = (await api(principals.operatorAgent, 'GET', `work/${encodeURIComponent(work.id)}/decisions`)).decisions as { id: string; action: string; state: string; input?: { binding?: string } }[];
    const refused = decisions.filter(entry => entry.action === 'rework' && entry.state === 'refused' && /:capped:/.test(entry.input?.binding ?? ''));
    assert.equal(refused.length, 2, `${work.key}: the capped rework refused twice on one binding: ${JSON.stringify(decisions.map(entry => [entry.action, entry.state, entry.input?.binding]))}`);
    const head = refused[0].input!.binding!.split(':')[0]!, item = final.find(entry => entry.key === work.key)!;
    const dismissed = github.dismissals.filter(entry => entry.key === work.key);
    assert.equal(dismissed.length, 2, `${work.key}: withdrawn once per refusal, never repeated across cycles: ${JSON.stringify(dismissed)}`);
    assert.ok(dismissed.every(entry => entry.sha === head), `${work.key}: only the capped head's change requests were withdrawn`);
    assert.ok(refused.every(decision => dismissed[1].message.includes(decision.id)), `${work.key}: the second withdrawal carries both refusals: ${dismissed[1].message}`);
    assert.equal(state.actions[`review-cap:rereview:${work.id}:${head}:answered`]?.state, 'done', `${work.key}: one second re-review requested for its head`);
    assert.ok(!escalations.some(detail => detail.includes(work.key) && /the loop relaunches the review on its own/.test(detail)), `${work.key}: no relaunch row while the step holds the head`);
    if (work === delivered) {
      assert.ok(item.delivery, `${work.key}: its second re-review approved the head, which was delivered`);
      continue;
    }
    assert.equal(item.stage, 'review', `${work.key}: its change request after the second withdrawal stands, so it waits in review`);
    const raised = state.actions[`escalation:review-cap:${work.id}:${head}`];
    assert.match(raised!.detail, /not withdrawn a third time/);
    assert.ok(refused.every(decision => raised!.detail.includes(decision.id)), `${work.key}: the escalation names both refusals: ${raised!.detail}`);
    assert.ok(raised!.attempts <= 2, `${work.key}: re-recorded only when its refusals changed, not every cycle (${raised!.attempts})`);
  }
});

test('unit:soak-invariants-hold — refused capped reworks of control-plane heads under the real loop across simulated days: each change request is withdrawn once in the control plane\'s own review record with no GitHub request, stranded withdrawals that failed against GitHub earlier are picked up on the next cycle, each head is re-reviewed on the same head by a launched reviewer listing the findings as FOLLOW-UP, a head whose re-reviews keep requesting changes is asked again, withdrawn once more and escalated, never withdrawn a third time, withdrawals, wakes and sessions stay bounded, settled sessions are cleaned up, and every invariant holds', { timeout: 300_000 }, async () => {
  // GY-2078: under the control-plane merger a head has no pull request, so withdrawing through GitHub's
  // review dismissal failed five times and stranded the item. Six control-plane items enter over two days,
  // each past its review-round cap with the reviewer's BLOCKING: change request on its head and an approver's
  // refusal of the capped rework the loop asked for; two carry the exhausted GitHub withdrawal the earlier release left
  // once that refusal landed (GY-2010, GY-1998), and the sixth's re-reviews keep requesting changes. Every cycle is the real loop (runCycle) and
  // the real dispatcher tick (runDispatchTick) over the soak's control plane, whose routes withdraw, register
  // the reviewer launch and take its verdict; every GitHub read or write throws.
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude' }, 'claude-reviewer');
  try {
    const config = await loadMasterConfig(host.root);
    const reviewerBot = `${config.reviewer!.slug}[bot]`, cycleMs = 10 * minute, cycles = (2 * 24 * hour) / cycleMs, verdictAfterMs = 20 * minute;
    const total = 6, stranded = new Set([2, 5]), again = 6;
    const dayStart = clock.now(), enterAt = (n: number) => dayStart + [1, 1, 12, 14, 26, 30][n - 1]! * hour;
    const head = (n: number) => `c${n}`.padEnd(40, 'd'), base = 'b'.repeat(40), reviewId = (n: number) => 9000 + n;
    const finding = (n: number) => `src/server/routes/work.ts:${10 + n} — GY-${700 + n}'s handler size exceeds its budget`;
    const ghCalls: string[] = [], wakes: string[] = [], decided: string[] = [], approvals: string[] = [];
    const githubDouble = new Proxy({}, { get: (_, name) => { ghCalls.push(String(name)); throw new Error(`the loop called GitHub (${String(name)})`); } });
    const syncClock = () => store.pool.query('UPDATE simulated_clock SET offset_ms=$1', [clock.offsetMs]);
    const items = new Map<number, Work>();
    const enter = async (n: number) => {
      const now = new Date(clock.now()).toISOString(), sha = head(n), body = `AC-1 is judged on ${sha.slice(0, 12)}.\nBLOCKING: ${finding(n)}`;
      const candidate = { sha, baseSha: base, pr: 700 + n, branch: `graphyard/gy-${700 + n}-1`, author: 'implementer' };
      const work = { id: randomUUID(), key: `GY-${700 + n}`, title: `Item ${n}`, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
        policy: { checks: ['test'], review: true }, plannedFiles: ['src/server/routes/work.ts'], stage: 'review', revision: 3, policyRevision: 1, createdAt: now, updatedAt: now, stageEnteredAt: now, ready: true, epoch: 1, lease: null,
        workspaces: [{ host: 'h', path: `/w/${n}`, branch: candidate.branch, epoch: 1, owner: 'implementer' }], candidate, submission: { epoch: 1, pr: candidate.pr }, reworkRequested: false,
        scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: ['implementer'], systemDriven: true,
        observation: { source: 'control-plane', at: now, candidate, checks: [], merged: false, mergeSha: null, mergeable: true, protected: false, baseTip: base, baseTipContained: true, files: ['src/server/routes/work.ts'],
          scopeFiles: [{ path: 'src/server/routes/work.ts', status: 'modified', sha: 'e'.repeat(40), additions: 1, deletions: 0, binary: false }],
          reviews: [{ reviewer: reviewerBot, sha, state: 'CHANGES_REQUESTED', id: reviewId(n), submittedAt: now, body, blocking: blockingFindings(body), source: 'control-plane' }], reviewIds: [reviewId(n)] },
        pipeline: { attempts: [], submittedAt: now, reworkRounds: 4, interventions: { blocked: 0, requirements: 0 } } } as unknown as Work;
      await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
      items.set(n, work);
    };
    const snapshot = async () => ({ work: (await store.list()).filter(item => [...items.values()].some(entry => entry.id === item.id)), now: new Date(clock.now()).toISOString() });
    // The withdraw effect is the production wiring: a control-plane verdict goes to the review-withdraw route, nothing to gh or GitHub.
    const production = daemonEffects(host.root, config, {
      snapshot, mutate: (path: string, data: unknown, key?: string) => api(principals.coordinator, 'POST', path, data, key),
      run: (async (command: string, args: string[]) => { ghCalls.push([command, ...args].join(' ')); throw new Error('no child process in this soak'); }) as never,
      fetcher: (async (input: unknown) => { ghCalls.push(String(input)); throw new Error('no network in this soak'); }) as never,
    } as never);
    const state = emptyDaemonState(config);
    const effects = { agents: () => [...host.agents], herdr: () => ({ agents: [...host.agents], available: true }), credentials: async () => ({}), snapshot,
      closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
      observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(clock.now()).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
      recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {}, github: githubDouble, merge: githubDouble, shadow: null,
      decisions: async (work: Work) => api(principals.operatorAgent, 'GET', `work/${encodeURIComponent(work.id)}/decisions`),
      // The loop requests each capped round through the plane's decide route, and the independent approver it launches refuses it as non-blocking.
      decide: (work: Work, action: string, reason: string, input: Record<string, unknown> = {}) => { decided.push(`${work.key} ${action} ${String(input.binding)}`); return api(principals.operatorAgent, 'POST', `work/${work.id}/decide`, { action, input: decisionInput(action, work, input), reason }); },
      approver: async (work: Work, decision: string) => {
        approvals.push(`${work.key} ${decision}`);
        await api(principals.approver, 'POST', `work/${work.id}/approve`, { action: 'refuse', decision, reason: `Refused: ${work.key}'s finding is real but not blocking; file it as a follow-up` });
        // What the release before GY-2078 left on the stranded items once their refusal landed: five withdrawals GitHub refused for want of a pull request, and their escalation.
        const n = Number(work.key.slice(3)) - 700, sha = work.candidate!.sha, now = new Date(clock.now()).toISOString();
        if (stranded.has(n) && !state.actions[cappedFilingKey(work, { sha, reviewId: reviewId(n) })]) {
          const spent = `${work.key} is in review round 5, past its cap of 3, and ${reviewerBot} requested changes naming a blocking finding`;
          state.actions[cappedEscalationKey(work, sha)] = { kind: 'escalation', work: work.key, principal: null, epoch: null, at: now, state: 'done', detail: `${spent}; withdrawing it failed 5 times (GitHub refused to dismiss review ${reviewId(n)} (404))`, attempts: 1, cycle: state.cycle };
          state.actions[cappedFilingKey(work, { sha, reviewId: reviewId(n) })] = { kind: 'review', work: work.key, principal: null, epoch: null, at: now, state: 'failed', detail: `${spent}, but withdrawing it failed: GitHub refused to dismiss review ${reviewId(n)} (404)`, attempts: maxCappedFilingAttempts, cycle: state.cycle };
        }
        return { agentName: `approver-${decision.slice(0, 8)}`, pane: null };
      },
      withdrawReview: production.withdrawReview, wakeObservation: async (work: Work) => { wakes.push(work.key); } } as unknown as DaemonEffects;
    // The dispatcher's launch is the real reviewer launch over the fleet's Herdr, registered with the plane's review-launch route,
    // and reading the refusal its prompt carries from the plane's decision history as readCappedRefusal does.
    const prompts = new Map<string, string>();
    const dispatch = { ...host.effects(() => [], () => config), snapshot: async () => ({ work: (await snapshot()).work.filter(item => item.stage !== 'done'), now: new Date(clock.now()).toISOString() }),
      launchReview: (work: Work, request: { id: string }, profile: { name: string }, herdr: HerdrAgent[], observedAt: string) => launchReview(host.root, work, profile.name, herdr, observedAt, { run: host.run, mint: host.mint, requestId: request.id,
        registerLaunch: (item, launch) => api(principals.coordinator, 'POST', `work/${item.id}/review-launch`, launch, `review-launch:${launch.tokenHash}`),
        cappedRefusal: async (item, sha) => {
          const history = (await api(principals.operatorAgent, 'GET', `work/${encodeURIComponent(item.id)}/decisions`)).decisions;
          const request = cappedRefusalRequest(item, sha, config, history, (await snapshot()).work);
          return request ? { request } : null;
        } }) } as DispatchEffects;
    const cursor = emptyDispatchCursor(config), answered = new Set<string>(), refusedLaunches: string[] = [], invariants = new Set<string>();
    let peakSessions = 0;
    for (let cycle = 0; cycle < cycles; cycle++) {
      for (let n = 1; n <= total; n++) if (!items.has(n) && clock.now() >= enterAt(n)) await enter(n);
      // The plane's observation job reads each open candidate every few seconds (GY-1675): the observation is as fresh as the cycle.
      await store.pool.query("UPDATE work_items SET document=jsonb_set(document, '{observation,at}', to_jsonb($2::text)) WHERE id = ANY($1)", [[...items.values()].map(work => work.id), new Date(clock.now()).toISOString()]);
      await runCycle(config, state, effects, () => clock.now());
      for (const check of state.invariants.report) { invariants.add(check.invariant); assert.ok(check.holds, `cycle ${cycle}: invariant ${check.invariant} is violated: ${check.line}`); }
      const tick = await runDispatchTick(config, cursor, dispatch, () => clock.now());
      refusedLaunches.push(...tick.refused.map(entry => `${entry.work}: ${entry.reason}`));
      // Each launched reviewer posts its one verdict as its launch token: an approval listing the refused finding as FOLLOW-UP, except the sixth item's change request.
      for (const record of (await readReviewLedger(host.root)).reviews) {
        if (record.state !== 'pending' || !record.pane) continue;
        if (!prompts.has(record.id)) prompts.set(record.id, await readFile(join(launchDirectory(record.checkout!), `${record.agentName}.request`), 'utf8'));
        if (answered.has(record.id) || clock.now() - Date.parse(record.requestedAt) < verdictAfterMs) continue;
        const { verdictToken } = await readReviewBinding(join(dirname(config.reviewer!.credentialFile), 'sessions', record.id));
        const n = Number(record.key.slice(3)) - 700, changes = n === again;
        const body = changes ? `AC-1 is judged on ${record.sha.slice(0, 12)}.\nBLOCKING: ${finding(n)}` : `AC-1: MET.\nFOLLOW-UP: ${finding(n)}`;
        const response = await fetch(`${url}/api/work/${encodeURIComponent(items.get(n)!.id)}/review-verdict`, { method: 'POST', headers: { Authorization: `Bearer ${verdictToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
          body: JSON.stringify({ event: changes ? 'REQUEST_CHANGES' : 'APPROVE', body, sha: record.sha, token: verdictToken }) });
        assert.equal(response.status, 200, `${record.key}: the verdict is taken: ${await response.text()}`);
        answered.add(record.id);
      }
      peakSessions = Math.max(peakSessions, host.agents.length);
      clock.advance(cycleMs); await syncClock();
    }
    assert.equal(items.size, total, 'every item entered');
    assert.deepEqual(ghCalls, [], 'nothing read or wrote GitHub, nor ran gh, all days');
    assert.deepEqual(refusedLaunches, [], 'no reviewer launch was refused');
    const final = (await snapshot()).work, ledger = (await readReviewLedger(host.root)).reviews;
    for (const [n, work] of items) {
      const item = final.find(entry => entry.id === work.id)!, sha = head(n), repeated = n === again;
      // The loop asked for the capped round itself, once per change request it judged, and one approver refused each.
      const asked = decided.filter(entry => entry.startsWith(`${work.key} `));
      assert.deepEqual(asked, Array(repeated ? 3 : 1).fill(`${work.key} rework ${cappedReworkBinding(sha, reviewerBot)}`), `${work.key}: the capped rounds the loop requested`);
      assert.equal(approvals.filter(entry => entry.startsWith(`${work.key} `)).length, asked.length, `${work.key}: one approver per capped round, none launched again`);
      // Withdrawn in the control plane's own record, once per refusal the step may withdraw on, never a third time.
      const withdrawn = (await store.pool.query('SELECT payload FROM events WHERE work_id=$1 AND kind=$2 ORDER BY seq', [work.id, 'review.withdrawn'])).rows.map(row => row.payload);
      assert.equal(withdrawn.length, repeated ? 2 : 1, `${work.key}: withdrawn ${repeated ? 'twice' : 'once'} across every cycle: ${JSON.stringify(withdrawn)}`);
      assert.equal(withdrawn[0].reviewId, reviewId(n), `${work.key}: the capped change request was the first withdrawn`);
      for (const entry of withdrawn) {
        assert.equal(entry.sha, sha, `${work.key}: only the capped head's change requests were withdrawn`);
        assert.match(entry.reason, /list(?:ing)? these findings as FOLLOW-UP threads/, `${work.key}: the withdrawal carries the re-review request`);
        assert.equal(item.observation!.reviews.find(review => review.id === entry.reviewId)!.state, 'DISMISSED');
      }
      assert.equal(wakes.filter(key => key === work.key).length, withdrawn.length, `${work.key}: its observation was woken once per withdrawal`);
      const filing = state.actions[cappedFilingKey(work, { sha, reviewId: reviewId(n) })]!;
      assert.equal(filing.state, 'done', `${work.key}: ${filing.detail}`);
      if (stranded.has(n)) assert.equal(filing.attempts, maxCappedFilingAttempts + 1, `${work.key}: the stranded withdrawal was retried once, on the first cycle that saw it, with no hand action`);
      assert.equal(state.actions[cappedRereviewKey(work, sha)]?.state, 'done', `${work.key}: one re-review requested for its head`);
      // A reviewer launched on the same head after each withdrawal, its request carrying the refusal and the findings as FOLLOW-UP; each settled and left no pane.
      const sessions = ledger.filter(record => record.key === work.key);
      assert.deepEqual(sessions.map(record => [record.sha, record.state]), Array(withdrawn.length).fill([sha, 'completed']), `${work.key}: one re-review session per withdrawal on the same head, each completed`);
      for (const session of sessions) {
        const prompt = prompts.get(session.id)!;
        assert.match(prompt, /An independent approver refused the capped rework this head's last change request asked for/);
        assert.ok(prompt.includes(`Re-review head ${sha} and `) && /list(?:ing)? these findings as FOLLOW-UP threads/.test(prompt), `${work.key}: the re-review lists the findings as FOLLOW-UP: ${prompt.slice(0, 400)}`);
        assert.ok(!host.agents.some(agent => agent.pane_id === session.pane), `${work.key}: the settled reviewer's pane was closed`);
      }
      const review = item.gates.find(gate => gate.name === 'review')!;
      if (repeated) {
        assert.ok(review.reasons.includes('Outstanding change requests must be resolved through a new review'), `${work.key}: the change request after its second withdrawal stands`);
        const raised = state.actions[cappedEscalationKey(work, sha)]!;
        assert.match(raised.detail, /not withdrawn a third time/);
        assert.ok(raised.attempts <= 2, `${work.key}: re-recorded only when its refusals changed, not every cycle (${raised.attempts})`);
      } else assert.ok(!review.reasons.some(reason => /Outstanding change requests|Independent approval/.test(reason)), `${work.key}: the re-review's approval passes review: ${review.reasons.join('; ')}`);
    }
    assert.equal(ledger.length, total + 1, 'one reviewer session per withdrawal, never relaunched');
    assert.ok(peakSessions <= total, `sessions stayed bounded (peak ${peakSessions})`);
    assert.deepEqual(host.agents, [], 'no reviewer session is left running');
    for (const invariant of systemInvariants) assert.ok(invariants.has(invariant), `${invariant} was judged over the days`);
  } finally { await host.cleanup(); }
});
