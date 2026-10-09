import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Work } from '../src/model.js';
import { type MasterConfig, approverSessionName } from '../src/master.js';
import { type DaemonEffects, emptyDaemonState, runCycle } from '../src/master-daemon.js';
import { maxDecisionRequests } from '../src/daemon/decisions.js';
import { plannedFilesMax } from '../src/model/scope.js';
import { Launcher } from '../src/daemon/cycle.js';
import { systemInvariants } from '../src/model/invariants.js';
import { blockerEscalateMs, blockerRecordMs } from '../src/daemon/cycle-blockers.js';
import { classifyBlocker, itemSpecificPlaneError, maxAutomaticClears } from '../src/model/blocker-class.js';
import { clock, hour, minute } from './helpers/soak-world.js';
import { approvedDecisionBoundMs } from '../src/model/approval.js';
import { PROOF, api, basePlan, blockerPlan, bulk18, coordinatorRoot, engine, extraFile, file, id, principals, scopePlan, soakConfig, soakControlPlanes, store } from './helpers/soak-plane.js';
import { assertLaunchesConfined, days, simulateDay } from './helpers/soak-simulation.js';

/**
 * Two-party decisions and their approvers: hand-launched and stranded approvals, capacity waits,
 * refused rework citations, scope requests, blockers, permission remedies and stale releases. One
 * concern of the release-candidate soak (GY-404), split per concern (GY-1363) so concurrent
 * changes stop colliding in one file: the world is tests/helpers/soak-world.ts, the control planes
 * tests/helpers/soak-plane.ts, the day itself tests/helpers/soak-simulation.ts, and every suite
 * asserts the system invariants after every cycle.
 */
soakControlPlanes('soak-decisions', 408);

test('unit:soak-invariants-hold — hand-launched approvers that vanish or stop without judging are relaunched within the bound, a refused relaunch is retried, and the spent watches keep every invariant holding', { timeout: 300_000 }, async () => {
  // GY-551: for every decision a master put to an approver by hand the loop now launches up to two
  // more sessions itself and keeps the spent watch past the bound, so both repeat per item here.
  const day = await simulateDay({ hours: 6, handApprovers: true });
  assertLaunchesConfined(day, coordinatorRoot!);
  const { final, violations, failures, state, herdr, hand, escalations, spent } = day;
  // Every item is delivered, so the day after starts from a clean board.
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'all fifteen items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds across the relaunches and the kept spent watches');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.equal(hand.size, 2);
  for (const [decision, { key, launches, refused }] of hand) {
    assert.equal(launches - refused, 2, `${key}: the loop relaunched the hand-launched approver twice, the hand launch being the first of three`);
    assert.ok(spent.has(decision), `${key}: past the bound the watch was kept, spent`);
    assert.ok(escalations.some(detail => detail.includes(decision) && /3 approver session\(s\)/.test(detail) && /session 1: .*session 2: .*session 3: /.test(detail)), `${key}: the unanswered decision was escalated with each session's end reason`);
    assert.equal(final.find(item => item.key === key)!.stage, 'done', `${key} was still delivered`);
    assert.ok(!Object.values(state.approvals).some(watch => watch.decision === decision), `${key}: the spent watch went with its delivered item`);
    assert.ok(![...herdr.agents.values()].some(agent => agent.name === approverSessionName(final.find(item => item.key === key)!, decision)), `${key}: no approver session for it is left open`);
  }
  assert.equal([...hand.values()].reduce((total, entry) => total + entry.refused, 0), 1, 'one relaunch was refused by a registry timeout, and retried');
});

test('unit:soak-invariants-hold — approvals a fault left with no outcome, on a head the item left and on one that holds, hand-watched and met by the loop\'s own request, each settle once, with at most one withdrawal, no approver session left open, and every invariant holding', { timeout: 300_000 }, async () => {
  // GY-1297: the settlement runs every cycle — the loop's request path and both watch kinds look at
  // every standing approval — so it must settle each stranded one exactly once and then stay quiet.
  // Five hours: with no merge queue to supersede it (GY-1235), the rerun-fails item's rework round
  // (GY-516) is a real round, and the day holds it and the last item's review.
  const day = await simulateDay({ hours: 5, stranded: true });
  const { final, violations, failures, herdr, stranded, withdrawals, state } = day;
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item is delivered');
  assert.deepEqual(violations, [], 'every system invariant holds');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.equal(stranded.size, 3, 'all three approvals were stranded');
  for (const [decision, { key, workId, kind, watched }] of stranded) {
    const settled = (await store.pool.query("SELECT kind, payload, created_at AS at FROM events WHERE work_id=$1 AND payload->>'id'=$2 AND kind = ANY($3::text[])", [workId, decision, ['decision.superseded', 'decision.applied', 'decision.failed', 'decision.stale', 'decision.withdrawn']])).rows;
    assert.equal(settled.length, 1, `${key}: decision ${decision} settled once (${settled.map(row => row.kind).join(', ')})`);
    const [approved] = (await store.pool.query("SELECT created_at AS at FROM events WHERE work_id=$1 AND payload->>'id'=$2 AND kind='decision.approved'", [workId, decision])).rows;
    // Only the loop's own request meets item 3's: it is settled when the item next needs a rework, not on a bound.
    if (watched) assert.ok(new Date(settled[0].at).getTime() - new Date(approved.at).getTime() <= approvedDecisionBoundMs, `${key}: settled within the decision bound`);
    // One bound to a head the item left can never apply; one whose situation holds is resumed and
    // applied, fails naming why, or settles stale on the revision its item moved past, as the resume day allows.
    if (kind === 'moved') assert.equal(settled[0].kind, 'decision.superseded', `${key}: superseded`);
    else assert.match(`${settled[0].kind} ${settled[0].payload.error ?? settled[0].payload.reason ?? ''}`, /^decision\.applied |^decision\.failed Approved by graphyard-approver at .+ but its application was never recorded; resuming it was refused: |^decision\.stale Task revision changed \(now \d+\)/, `${key}: applied, or failed or settled stale naming why`);
    assert.ok((withdrawals.get(decision) ?? 0) <= 1, `${key}: at most one withdrawal was sent for ${decision} (${withdrawals.get(decision)})`);
    if (watched) assert.equal(withdrawals.get(decision), 1, `${key}: the hand watch sent the one withdrawal that settled it`);
    assert.ok(![...herdr.agents.values()].some(agent => agent.name === approverSessionName(final.find(item => item.key === key)!, decision)), `${key}: no approver session for ${decision} is left open`);
    assert.ok(!Object.values(state.approvals).some(watch => watch.decision === decision), `${key}: no watch for ${decision} is left`);
  }
});

test('unit:soak-invariants-hold — with production\'s resume, approvals a fault left with no outcome are applied or settled within a cycle of their session ending, never resumed once settled, never put to an approver again, and every invariant holds', { timeout: 300_000 }, async () => {
  // GY-1300: production's loop has the resume effect, so the apply step and the request path's
  // resume of an approved standing decision are what settle each stranded approval — not the
  // withdrawal the day above falls back to.
  const day = await simulateDay({ hours: 5, stranded: 'resume' });
  const { final, violations, failures, herdr, stranded, withdrawals, resumes, strandedLaunches, state } = day;
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item is delivered');
  assert.deepEqual(violations, [], 'every system invariant holds');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.equal(stranded.size, 3, 'all three approvals were stranded');
  for (const [decision, { key, workId, kind, watched }] of stranded) {
    const settled = (await store.pool.query("SELECT kind, payload, created_at AS at FROM events WHERE work_id=$1 AND payload->>'id'=$2 AND kind = ANY($3::text[])", [workId, decision, ['decision.superseded', 'decision.applied', 'decision.failed', 'decision.stale', 'decision.withdrawn']])).rows;
    assert.equal(settled.length, 1, `${key}: decision ${decision} settled once (${settled.map(row => row.kind).join(', ')})`);
    assert.notEqual(settled[0].kind, 'decision.withdrawn', `${key}: settled by the resume, not withdrawn`);
    assert.equal(withdrawals.get(decision) ?? 0, 0, `${key}: no withdrawal was sent for ${decision}`);
    if (kind === 'holds') assert.match(settled[0].kind, /^decision\.(applied|failed|stale)$/, `${key}: a decision whose situation holds is applied, or fails or settles stale`);
    if (watched) {
      // The session ends a minute after the loop first lists it; the apply step runs on the cycle after.
      const [approved] = (await store.pool.query("SELECT created_at AS at FROM events WHERE work_id=$1 AND payload->>'id'=$2 AND kind='decision.approved'", [workId, decision])).rows;
      assert.ok(new Date(settled[0].at).getTime() - new Date(approved.at).getTime() <= approvedDecisionBoundMs, `${key}: settled within the decision bound`);
      assert.ok((resumes.get(decision) ?? []).length >= 1, `${key}: the hand watch's apply step resumed ${decision}`);
    }
    // Bounded: every resume but the last found it still approved, and none is sent once it settled.
    const answers = resumes.get(decision) ?? [];
    assert.ok(answers.slice(0, -1).every(answer => answer === 'approved'), `${key}: no resume after ${decision} settled (${answers.join(', ')})`);
    assert.ok(answers.length <= 3, `${key}: resumes of ${decision} are bounded (${answers.length})`);
    assert.equal(strandedLaunches.get(decision) ?? 0, 0, `${key}: no approver was launched for the judged decision ${decision}`);
    assert.ok(![...herdr.agents.values()].some(agent => agent.name === approverSessionName(final.find(item => item.key === key)!, decision)), `${key}: no approver session for ${decision} is left open`);
    assert.ok(!Object.values(state.approvals).some(watch => watch.decision === decision && !watch.settledAt), `${key}: no open watch for ${decision} is left`);
  }
});

test('unit:soak-invariants-hold — approver launches refused for capacity wait uncounted and relaunch oldest-first within two cycles of capacity freeing, with no hand action and every invariant holding', { timeout: 360_000 }, async () => {
  // GY-849: between minute 50 and minute 130 no approver account is eligible, which spans the
  // rework rounds of items three and seven (requested about minutes 58 and 118), so both decisions
  // sit waiting when the window closes. The loop must relaunch them — uncounted against the launch
  // bound, one at a time on the launcher, the older request taking the freed capacity first, each
  // within a couple of cycles of the window closing — with no hand action, and both items delivered.
  const began = performance.now();
  const window = { from: 50 * minute, to: 130 * minute };
  const day = await simulateDay({ hours: 6, capacityWait: window });
  assertLaunchesConfined(day, coordinatorRoot!);
  const { items, final, violations, failures, escalations, capacityRefused, capacityLaunched, capacityWaiters } = day;
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}: ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'all fifteen items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds across the capacity waits and the ordered relaunches');
  assert.deepEqual(failures, [], 'no cycle failed');
  // Both rework decisions were refused inside the window and both still waited when it closed.
  assert.ok(capacityWaiters && capacityWaiters.length === 2, `both rework decisions waited at window close: ${JSON.stringify(capacityWaiters)}`);
  const waiters = [...(capacityWaiters ?? [])].sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt));
  assert.ok(waiters.every(entry => [...capacityRefused].some(refusal => refusal.decision === entry.decision && refusal.elapsed >= window.from && refusal.elapsed < window.to)),
    `each waiting decision was refused for capacity inside the window: ${JSON.stringify(capacityRefused.slice(0, 4))}…`);
  assert.ok(waiters.every(entry => entry.key === items[2].key || entry.key === items[6].key), `the waiters are the rework rounds of items three and seven: ${JSON.stringify(waiters)}`);
  // Once capacity freed, the oldest waiting decision launched first, then the next: one at a time,
  // each in its own cycle, so a newer decision never races an older one for the freed capacity.
  const recovered = capacityLaunched.filter(entry => waiters.some(waiter => waiter.decision === entry.decision)).sort((a, b) => a.elapsed - b.elapsed);
  assert.deepEqual(recovered.map(entry => entry.decision), waiters.map(entry => entry.decision),
    `capacity freed took the waiting decisions in age order: ${JSON.stringify({ launched: recovered, waited: waiters })}`);
  assert.ok(recovered.length >= 2 && recovered[0].elapsed < recovered[1].elapsed,
    `the relaunches went one at a time, never two in one cycle: ${JSON.stringify(recovered)}`);
  for (const entry of recovered)
    assert.ok(entry.elapsed >= window.to && entry.elapsed <= window.to + 2 * minute, `${entry.decision} launched within two cycles of capacity freeing (+${Math.round((entry.elapsed - window.to) / minute)} min)`);
  // Neither decision was left unanswered: neither escalated as unjudged, and both rework rounds ran.
  for (const waiter of waiters)
    assert.ok(!escalations.some(detail => detail.includes(waiter.decision) && /approver session\(s\)/.test(detail)), `${waiter.key}: the capacity wait never escalated as unjudged`);
  for (const n of [3, 7]) assert.equal(final.find(item => item.key === items[n - 1].key)!.pipeline?.reworkRounds ?? 0, 1, `item ${n}'s rework round ran after its capacity wait`);
  // The day runs beside the shard's other files, so its wall clock is the machine's: it takes about
  // 22 s alone, but CI measured it at 137 s and 154 s beside them, so its budget is sized like the
  // other days' (GY-630).
  const seconds = (performance.now() - began) / 1000;
  assert.ok(seconds < 200, `the capacity-wait day runs inside its budget (${seconds.toFixed(1)} s)`);
});

// GY-475's citation day. The regression day leaves items mid-flight on purpose; each day runs on a
// control plane of its own (GY-1360), so none of their rework reaches this day's loop.
test('unit:soak-invariants-hold — after a restart the first request for a refused rework decision already cites the refusal the binding names, and no request is refused', { timeout: 600_000 }, async () => {
  // GY-475: the approver refuses the rework decision items 3 and 7 call for; the loop settles the
  // watch, escalates the refusal and never re-requests it. A restart then loses the cursor while
  // both items still call for the same decision — same head, base and grounds binding. The ledger
  // keeps the refused inputs as jsonb, whose key order is not the loop's, so the fresh loop's
  // up-front scan matches them only in canonical form: each item's next request already cites its
  // refusal and is accepted on the first attempt, where a scan blind to the binding would send an
  // uncited request, take the 409 the server answers it with, and spend one of the three bounded
  // refusal answers per item.
  const day = await simulateDay({ hours: 6, refuseReworkOf: [3, 7] });
  assertLaunchesConfined(day, coordinatorRoot!);
  const { final, violations, observed, failures, lost, escalations, herdr, refused, decideCalls, restarted, state } = day;
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'all fifteen items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds across the refusals, the restart and the cited re-requests');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  assert.deepEqual([...observed].sort(), [...systemInvariants].sort(), 'every invariant was observed, not merely left unread');
  assert.ok(restarted, 'the day included the scenario restart');
  assert.equal(refused.length, 2, 'both scenario refusals were judged');
  assert.equal(final.reduce((total, item) => total + (item.pipeline?.reworkRounds ?? 0), 0), basePlan.rework.size + 1, 'the refusals added no rework rounds beyond the main day\'s own (review and the spent producer request; the failed rerun is superseded by the out-of-queue merge)');
  for (const { key, decision } of refused) {
    const item = final.find(entry => entry.key === key)!;
    const history = (await api(principals.operatorAgent, 'GET', `work/${encodeURIComponent(item.id)}/decisions`)).decisions as { id: string; action: string; state: string; input: any }[];
    const reworks = history.filter(entry => entry.action === 'rework');
    assert.equal(reworks.length, 2, `${key}: bounded requests — exactly the refused and the cited rework decisions`);
    assert.equal(reworks[0].id, decision, `${key}: the refused rework decision was the first`);
    assert.equal(reworks[0].state, 'refused');
    assert.equal(reworks[1].state, 'applied', `${key}: the cited re-request was applied and carried the round`);
    const calls = decideCalls.filter(call => call.key === key && call.action === 'rework');
    assert.equal(calls.length, 2, `${key}: each request was sent once — the re-request took no refused round-trip`);
    assert.ok(!calls[0].reason.includes(decision), `${key}: the refused request could cite nothing`);
    assert.ok(calls[1].reason.includes(decision), `${key}: the first request after the restart cites the refusal in its reason`);
    // The ledger kept the refused input as jsonb, whose key order is not the one the request
    // builds, so the fresh scan only matched it in canonical form — which this proves ran.
    assert.notEqual(JSON.stringify(reworks[0].input), JSON.stringify(calls[1].input), `${key}: jsonb kept the refused input in another key order than the request builds`);
    assert.deepEqual(calls[1].input, reworks[0].input, `${key}: the cited request carries the refused request's exact input`);
    assert.ok(escalations.some(detail => detail.includes(decision) && /does not request it again/.test(detail)), `${key}: the refusal was escalated, not re-requested, while it stood`);
    assert.ok(!Object.values(state.approvals).some(watch => watch.work === key), `${key}: no watch is left open on the item`);
  }
  assert.ok(![...herdr.agents.values()].some(agent => /approver/i.test(agent.name ?? '')), 'no approver session is left open at the end of the day');
});

test('unit:soak-decisions-scope-once — every invariant holds across direct wide scope requests: a rule-approved ask folds and answers once, a finding-grounded ask widens once, an unrepresentable ask is refused with nothing retrying it, and a partly grounded ask reaches its approver through transient refusals and a late history read with no scope fault', { timeout: 600_000 }, async () => {
  const day = await simulateDay({ hours: 4, scope: true });
  assertLaunchesConfined(day, coordinatorRoot!);
  const { items, final, violations, failures, state, escalations, transientRefused, lateReads, decideCalls } = day;
  assert.deepEqual(violations, [], 'every system invariant holds with the scope scenarios in the day');
  assert.deepEqual(failures, [], 'no cycle failed');

  // The rule-approved wide ask: folded into one directory entry, applied once, delivered on the
  // folded scope, and never decided again across the rest of the day.
  const wide = final.find(item => item.key === items[scopePlan.wideRule - 1].key)!;
  assert.equal(wide.scopeDecision?.state, 'approved', wide.scopeDecision?.reason);
  assert.deepEqual(wide.plannedFiles, [file(scopePlan.wideRule), scopePlan.wideRuleDir], 'the wide ask folded into one directory entry');
  assert.equal(wide.stage, 'done', 'the wide item was delivered on the folded scope');
  const wideActions = Object.keys(state.actions).filter(key => key.startsWith(`scope:${wide.id}:`));
  assert.equal(wideActions.length, 1, `one scope action stands for the wide item: ${wideActions.join(', ')}`);

  // The finding-grounded wide ask: the rule refuses it, the loop widens once by posting the folded
  // revision, and the item delivers on the folded scope.
  const found = final.find(item => item.key === items[scopePlan.wideFinding - 1].key)!;
  assert.equal(found.scopeDecision?.state, 'approved', 'the posted widening answered the request');
  assert.deepEqual(found.plannedFiles, [file(scopePlan.wideFinding), scopePlan.wideFindingDir], 'the finding-grounded ask folded the same way');
  assert.equal(found.stage, 'done', 'the finding item was delivered on the folded scope');
  const foundActions = Object.keys(state.actions).filter(key => key.startsWith(`scope:${found.id}:`));
  assert.equal(foundActions.length, 2, `the refusal and the widening are the only scope actions: ${foundActions.join(', ')}`);
  assert.equal((await api(principals.operatorAgent, 'GET', `work/${found.id}/decisions`)).decisions.filter((decision: any) => decision.action === 'requirements').length, 0, 'the loop widened on the finding directly, without routing a decision');

  // The unrepresentable ask: refused by the rule, decided once, never applied, never routed, and
  // never re-decided: the escalation stands and nothing retries it for the rest of the day. Its
  // worker waits on the refusal for hours, which the worker bound (GY-1460) does not count: ending
  // that attempt would only launch one that asks again (GY-1472).
  const blocked = final.find(item => item.key === items[scopePlan.unrepresentable - 1].key)!;
  assert.equal(blocked.stage, 'build', 'the item is held in build');
  assert.match(blocked.scopeDecision!.reason, new RegExp(`no fold represents the ask within the ${plannedFilesMax} entries plannedFiles holds \\(${plannedFilesMax + 1} after folding\\)`));
  assert.equal(blocked.scopeDecision?.state, 'refused', 'the refusal stands recorded on the item');
  assert.deepEqual(blocked.plannedFiles, bulk18, 'the oversized ask was never applied');
  const decided = Object.entries(state.actions).filter(([key]) => key.startsWith(`scope:${blocked.id}:`) && !key.includes(':finding:'));
  assert.equal(decided.length, 1, `one deciding action stands for the blocked item: ${decided.map(([key]) => key).join(', ')}`);
  assert.equal(decided[0][1].attempts, 1, 'the rule decided the ask once and never re-decided it');
  const judging = Object.entries(state.actions).find(([key]) => key.startsWith(`scope:${blocked.id}:`) && key.includes(':finding:'));
  assert.ok(judging && judging[1].state === 'done' && /no unresolved review finding/.test(judging[1].detail), `the finding rule judged the refusal and left it standing: ${judging?.[1].detail}`);
  assert.equal((await api(principals.operatorAgent, 'GET', `work/${blocked.id}/decisions`)).decisions.filter((decision: any) => decision.action === 'requirements').length, 0, 'an unrepresentable fold is never routed to a decision the schema would refuse');
  assert.equal(escalations.filter(detail => detail.includes(blocked.key) && /blocked on scope/.test(detail)).length, 1, 'exactly one escalation stands for the blocked item');

  // GY-1293. The partly grounded ask: the page is granted on the rule, the rest goes to the approver
  // against the widened revision, once, and is applied. The control plane refused the first widening
  // of it (stale revision) and of the finding item (5xx), and the first read of its decision history
  // missed the step's deadline: each was asked again on the next cycle, and none is a fault.
  assert.deepEqual(transientRefused.map(entry => [entry.n, entry.status]).sort(), [[scopePlan.wideFinding, 500], [scopePlan.partial, 409]], 'each transient refusal was served once');
  assert.equal(lateReads.length, 1, 'the partial item\'s history read once past the deadline');
  const partial = final.find(item => item.key === items[scopePlan.partial - 1].key)!;
  assert.equal(partial.stage, 'done', 'the partial item was delivered');
  assert.ok(partial.plannedFiles.includes(scopePlan.partialPage) && partial.plannedFiles.includes(scopePlan.partialFile), `both paths were granted: ${partial.plannedFiles.join(', ')}`);
  const partialRows = Object.entries(state.actions).filter(([key]) => key.startsWith(`scope:${partial.id}:`));
  assert.equal(partialRows.filter(([, action]) => /^Partly widened /.test(action.detail)).length, 2, `the partial widening is recorded for the revision it judged and the one it made, and made once: ${partialRows.map(([key, action]) => `${key} ${action.state} ${action.detail.slice(0, 80)}`).join(' | ')}`);
  assert.ok(partialRows.length <= 3, `the request's rows stay bounded (its decision and one judgement per revision): ${partialRows.map(([key]) => key).join(', ')}`);
  const asked = decideCalls.filter(call => call.key === partial.key && call.action === 'requirements');
  assert.equal(asked.length, 1, 'the rest was put to the approver exactly once');
  assert.ok((asked[0].input as { plannedFiles: string[] }).plannedFiles.includes(scopePlan.partialPage), 'against the widened plannedFiles');
  const requirements = (await api(principals.operatorAgent, 'GET', `work/${partial.id}/decisions`)).decisions.filter((decision: any) => decision.action === 'requirements');
  assert.deepEqual(requirements.map((decision: any) => decision.state), ['applied'], 'and its approval applied');
  const scoped = [items[scopePlan.wideFinding - 1].key, partial.key];
  const instances = state.faults.instances.filter(instance => scoped.includes(instance.subject) && (instance.faultClass === 'scope' || instance.faultClass === 'decision'));
  assert.deepEqual(instances.map(instance => [instance.subject, instance.kind]), [], 'no transient refusal or late read is counted as a scope or decision fault');
});

test('unit:soak-invariants-hold — blocked work unblocks itself: every routine blocker is re-checked each cycle and cleared only once its cause is gone, the scope and decision blockers reach their approver, a repeating blocker is left to the master, and no approver session or cursor row outlives its blocker', { timeout: 600_000 }, async () => {
  // GY-1008: the blocker step runs per item, every cycle, so it lives in this world. Seven of nine
  // items' first attempts record a blocker from the 2026-09-30 incidents; nothing outside the loop
  // touches them. Each must hold no lease from the moment it is recorded, clear without the master
  // only once its probe passes (never while it fails), and be delivered by its next attempt.
  // No wall-clock budget: about ten seconds alone, this day ran 214 s on the CI shard that also
  // holds the confinement soak, so a budget would measure the runner; the test timeout bounds it.
  const day = await simulateDay({
    hours: 4, blockers: true,
    plan: { items: blockerPlan.items, releaseEveryMs: 5 * minute, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 9, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 9 } },
  });
  const { items, final, violations, failures, state, herdr, blockerEvents, blockerProbes, githubStatusReads, credentialReads, blockerRecords, cycles, blockerDecisions, blockerActions, blockerKeysPeak, attempts } = day;
  const repeating = items[blockerPlan.repeating - 1].key, requestError = items[blockerPlan.requestError - 1].key;
  assert.deepEqual(final.filter(item => item.key !== repeating && item.key !== requestError && item.stage !== 'done').map(item => `${item.key} ${item.stage}: ${item.blocker ?? ''} ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'every item but the repeating and request-error ones is delivered');
  assert.deepEqual(violations, [], 'every system invariant holds across the blockers, their probes and their approvers');
  assert.deepEqual(failures, [], 'no cycle failed');

  // AC-2 in the loop: every recorded blocker ended its attempt — the item held no lease after it.
  assert.ok(blockerEvents.length >= 8, `each blocked item recorded its blocker: ${JSON.stringify(blockerEvents)}`);
  assert.deepEqual(blockerEvents.filter(entry => entry.lease !== null), [], 'a recorded blocker leaves no lease behind');

  const cleared = (key: string) => blockerActions.filter(action => action.work === key && action.state === 'done' && /^Cleared /.test(action.detail));
  for (const [n, blockerClass] of Object.entries(blockerPlan.classes).map(([n, cls]) => [Number(n), cls] as const)) {
    const key = items[n - 1].key;
    assert.equal(classifyBlocker(blockerPlan.text(n, 'graphyard/x', 'decision')).class, blockerClass, `item ${n}'s blocker text reads as ${blockerClass}`);
    if (key === repeating || key === requestError) continue;
    const clear = cleared(key);
    assert.equal(clear.length, 1, `${key}'s ${blockerClass} blocker was cleared by the loop exactly once: ${JSON.stringify(blockerActions.filter(action => action.work === key))}`);
    assert.match(clear[0].detail, new RegExp(`Cleared ${key}'s ${blockerClass} blocker`));
    assert.equal(attempts.get(key), 2, `${key} was delivered by the attempt after its blocker cleared`);
    const recorded = blockerEvents.find(entry => entry.key === key)!;
    // AC-3: an environmental cause is probed every cycle while it stands, and clears only once it passes.
    const clearsAt = blockerPlan.clearsAt[blockerClass];
    if (clearsAt !== undefined) {
      const ran = blockerProbes.filter(probe => probe.key === key);
      assert.ok(ran.filter(probe => !probe.passed).length >= Math.floor((clearsAt - recorded.elapsed) / minute) - 2, `${key}'s ${blockerClass} probe ran every cycle its cause stood (${ran.length} runs)`);
      assert.ok(clear[0].elapsed >= clearsAt, `${key} was cleared only once its probe passed (+${clear[0].elapsed / minute} min, cause gone at +${clearsAt / minute} min)`);
      assert.ok(clear[0].elapsed <= Math.max(clearsAt, recorded.elapsed) + 2 * minute, `${key} was cleared within two cycles of its cause going (+${clear[0].elapsed / minute} min)`);
    }
  }
  // GY-1567: causes in the worker's session or at GitHub, not in the item. The refused delivery push
  // cleared within two cycles of being recorded (the attempt had ended).
  {
    const key = items[10].key, recorded = blockerEvents.find(entry => entry.key === key)!;
    assert.ok(cleared(key)[0].elapsed <= recorded.elapsed + 2 * minute, `${key}'s runtime-denial blocker cleared within two cycles (+${cleared(key)[0].elapsed / minute} min, recorded +${recorded.elapsed / minute} min)`);
  }
  // Review of GY-1567: the first usage-limit report spent every worker account until the reset
  // minute. Both items on it stood together while every account was held, each failing probe naming
  // the held accounts, and cleared within two cycles of the reset. Their probe reads the account
  // health dispatch reads, once per cycle, so the two of them added no read in any cycle.
  const spent = [items[8].key, items[9].key], reset = blockerPlan.accountResetAt;
  const stood = spent.map(key => ({ key, recorded: blockerEvents.find(entry => entry.key === key)!.elapsed, clear: cleared(key)[0].elapsed }));
  for (const { key, recorded, clear } of stood) {
    const records = blockerRecords.filter(entry => entry.key === key && entry.class === 'runtime-exhaustion');
    assert.ok(clear >= reset && clear <= reset + 2 * minute, `${key} was cleared within two cycles of the accounts' reset (+${clear / minute} min, reset +${reset / minute} min)`);
    assert.ok(records.filter(entry => entry.result === 'fail').length >= Math.floor((reset - recorded) / blockerRecordMs), `${key}'s probe was written failing while the accounts were held: ${JSON.stringify(records)}`);
    assert.deepEqual(records.filter(entry => entry.result === 'fail' && !/account-one is held[^]*account-two is held[^]*account-three is held/.test(entry.detail)), [], `${key}'s failing probe named every held account`);
    assert.deepEqual(records.filter(entry => entry.result === 'pass').map(entry => entry.elapsed), [clear], `${key}'s probe passed only once an account was eligible`);
  }
  const together = Math.min(...stood.map(entry => entry.clear)) - Math.max(...stood.map(entry => entry.recorded));
  assert.ok(together >= 30 * minute, `both spent-account items stood on the held accounts together (${together / minute} min)`);
  const heldReads = credentialReads.filter(at => at >= Math.max(...stood.map(entry => entry.recorded)) && at < reset);
  assert.equal(new Set(heldReads).size, heldReads.length, 'no cycle read the account health twice while both items stood on it');
  assert.ok(heldReads.length >= Math.floor(together / minute) - 1, `the account health was read every cycle they stood (${heldReads.length})`);
  assert.ok(credentialReads.length <= cycles + 1, `the account health was read once per cycle across the day (${credentialReads.length} reads, ${cycles} cycles)`);
  const outage = [items[11].key, items[12].key], outageProbes = blockerProbes.filter(probe => outage.includes(probe.key) && probe.class === 'github-outage');
  const bothFailing = [...new Set(outageProbes.filter(probe => !probe.passed).map(probe => probe.elapsed))].filter(at => outage.every(key => outageProbes.some(probe => probe.key === key && probe.elapsed === at && !probe.passed)));
  assert.ok(bothFailing.length >= 30, `both github-outage items stood on the incident together for many cycles (${bothFailing.length})`);
  assert.equal(new Set(githubStatusReads).size, githubStatusReads.length, `no cycle read githubstatus.com twice: ${githubStatusReads.map(at => at / minute).join(', ')}`);
  assert.ok(githubStatusReads.every((at, index) => index === 0 || at - githubStatusReads[index - 1] >= minute), 'githubstatus.com was read at most once a minute');
  assert.ok(githubStatusReads.filter(at => bothFailing.includes(at)).length <= bothFailing.length && githubStatusReads.length < outageProbes.length / 1.5,
    `the status page was read once for both items, not once per item (${githubStatusReads.length} reads for ${outageProbes.length} probes)`);
  // The outside-scope failure cleared on a later base tip than the one it was met on.
  const outside = items[3].key;
  assert.ok(blockerProbes.some(probe => probe.key === outside && probe.class === 'outside-scope-test-failure'), 'the outside-scope blocker read the base tip');
  // AC-4: the scope blocker became an additive widening the approver judged; the decision blocker's approver was launched by the loop.
  const scoped = final.find(item => item.key === items[4].key)!, decided = final.find(item => item.key === items[5].key)!;
  assert.ok(scoped.plannedFiles.includes(extraFile(5)) && scoped.plannedFiles.includes(file(5)), `the planned-file-scope blocker widened plannedFiles additively: ${scoped.plannedFiles.join(', ')}`);
  assert.ok(!scoped.plannedFiles.some(path => /github\.com/.test(path)), 'the URL the blocker cites never became a planned path');
  assert.ok(decided.plannedFiles.includes(extraFile(6)), 'the needs-decision blocker\'s decision was judged and applied');
  const decision = blockerDecisions.get(decided.key)!;
  assert.ok(day.decideCalls.some(call => call.key === scoped.key && call.action === 'requirements'), 'the loop requested the scope widening itself');
  assert.ok(blockerActions.some(action => action.work === decided.key && new RegExp(`blocked on decision ${decision} .*launched approver`).test(action.detail)), `the loop launched the waiting decision's approver: ${JSON.stringify(blockerActions.filter(action => action.work === decided.key))}`);

  // GY-1055: a 500 on the item's own request is the master's to recheck: handed over once, never
  // probed on health nor cleared; the plane-wide errors beside it cleared on health above.
  assert.deepEqual([3, 7, 8].map(n => itemSpecificPlaneError(blockerPlan.text(n, 'graphyard/x', null))), [false, false, true], 'only the request-level 500 reads as the item\'s own server error');
  assert.deepEqual(cleared(requestError), [], `${requestError}'s request-level server error was never cleared on health`);
  assert.deepEqual(blockerProbes.filter(probe => probe.key === requestError), [], `${requestError}'s blocker was never probed`);
  assert.equal(blockerActions.filter(action => action.work === requestError && /server error its own request met, .*needs the master to recheck that operation/.test(action.detail)).length, 1, `${requestError} was handed to the master once: ${JSON.stringify(blockerActions.filter(action => action.work === requestError))}`);
  assert.equal(attempts.get(requestError), 1, `${requestError} was not dispatched again`);
  // GY-1055: the credential cause stood past blockerEscalateMs: reported to the master once, after
  // that long, while the loop kept probing it and cleared it when it went. No shorter cause was.
  const credential = items[0].key, firstFailed = blockerProbes.find(probe => probe.key === credential && !probe.passed)!;
  const escalations = blockerActions.filter(action => /its probe has failed since .* so it is reported to the master/.test(action.detail));
  assert.deepEqual(escalations.map(action => action.work), [credential], `only the long-standing credential blocker was reported to the master, once: ${JSON.stringify(escalations)}`);
  assert.ok(escalations[0].elapsed >= firstFailed.elapsed + blockerEscalateMs && escalations[0].elapsed <= firstFailed.elapsed + blockerEscalateMs + 2 * minute && escalations[0].elapsed < blockerPlan.clearsAt['github-credential']!,
    `${credential} was reported within two cycles of its probe having failed for blockerEscalateMs, before its cause went (+${escalations[0].elapsed / minute} min, first failed at +${firstFailed.elapsed / minute} min)`);

  // The repeating blocker: cleared maxAutomaticClears times in a row, then left to the master.
  assert.equal(cleared(repeating).length, maxAutomaticClears, `${repeating} was cleared ${maxAutomaticClears} times and no more`);
  assert.ok(blockerActions.some(action => action.work === repeating && new RegExp(`again after the loop cleared its blocker ${maxAutomaticClears} times in a row`).test(action.detail)), `${repeating} was left to the master once spent`);
  assert.equal(attempts.get(repeating), maxAutomaticClears + 1, `${repeating} was dispatched once per clear, and not again`);

  // Nothing outlives its blocker: no approver session lingers, no watch is kept, and the cursor's
  // blocker rows went with their items.
  // (The recurring-fault items the day's stalled blockers file have approvers of their own, which the
  // invariants already judge; these are the blocked items' own.)
  const approvers = [...herdr.agents.values()].filter(agent => items.some(item => new RegExp(`^graphyard-approver-${item.key.toLowerCase()}-[0-9a-f]+$`).test(agent.name ?? '')));
  assert.deepEqual(approvers.map(agent => agent.name), [], 'no approver session of a blocked item is left open');
  assert.ok(!Object.values(state.approvals).some(watch => watch.decision === decision), 'the launched approver\'s watch went with its judged decision');
  assert.deepEqual(Object.keys(state.actions).filter(key => key.startsWith('blocker:')), [], 'no blocker row outlives its item');
  // Per blocked item: its blocker row and its episode's rows (the failing probe's start and its
  // report to the master, the base tip, the decisions awaited, the approver launched).
  assert.ok(blockerKeysPeak <= 3 * 13, `the blocker rows stayed bounded by the blocked items (peak ${blockerKeysPeak})`);
});

test('unit:soak-invariants-hold — rows stalled on the App permission hold across hours of real loop cycles are remedied once per unchanged run: one browser flow and one record per run, a refused remedy escalated once and never retried, rows held together sharing one flow', { timeout: 300_000 }, async () => {
  // GY-949: step 6b runs a browser flow for a stalled row and records it on the row. Its guarantee —
  // once per unchanged run, never retried in a loop — rests on the record landing through the real
  // route, the loop's own guard covering the cycles between a launch and its record, and the
  // launcher's key; so it is driven here through the real engine, route and launcher, cycle after
  // cycle. A stand-in executor fails each held item's dispatch row with the hold's own words while
  // the hold stands. The first held item's remedy is refused (a pending sudo confirmation); two
  // items held together two hours later share one flow, which grants the permission and lets their
  // rows complete. Each flow outlives several cycles, as a real one waiting on sudo does.
  const moveClock = async (ms: number) => { clock.advance(ms); await store.pool.query('UPDATE simulated_clock SET offset_ms=$1', [clock.offsetMs]); };
  await moveClock(0);
  const dayStart = clock.now();
  const hold = (key: string) => `${key}: no observation newer than the claim was saved; its observation job is held: App graphyard-owner-project lacks Actions: write, which failed CI reruns needs to rerun failed workflow jobs on the unchanged candidate; accept the pending permission request at https://github.com/settings/installations/2; the claim woke it and leaves the row waiting for the observation`;
  const sudo = 'Confirm access was not approved within 300s; approve the GitHub Mobile prompt (code 42) and rerun master browser installation-accept';
  const create = async (n: number) => {
    const work = await engine.execute(principals.operator, 'create', null, { title: `Held item ${n}`, plannedFiles: [`src/held-${days}-${n}.ts`], criteria: [{ id: 'AC-1', text: `Held item ${n} behaves`, proofs: [PROOF] }] }, id());
    return engine.execute(principals.operator, 'ready', work.id, {}, id());
  };
  const items: Work[] = [await create(1)];
  const own = () => new Set(items.map(item => item.id));
  let granted = false, cycles = 0;
  const flows: { flow: string; cycle: number }[] = [], records: { row: string; outcome: string; cycle: number }[] = [], refusedRecords: string[] = [];
  const config = { ...soakConfig, workers: [] } as MasterConfig;
  const state = emptyDaemonState(config);
  const loop = new Launcher();
  const effects: DaemonEffects = {
    closeSession: () => {}, dispatch: async () => ({}), requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(clock.now()).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => ({}), requestSmoke: () => {},
    agents: () => [], credentials: async () => ({}), persist: async () => {},
    snapshot: async () => { const read = await store.coordinationSnapshot(); return { work: read.work.filter(item => own().has(item.id)), now: read.now, jobs: read.jobs }; },
    // The master browser flow, faked: it settles three cycles after it starts. The first answers a
    // pending sudo confirmation; every later one grants the permission, which ends the hold.
    browserFlow: async flow => {
      const started = cycles;
      flows.push({ flow, cycle: started });
      while (cycles < started + 3) await new Promise(resolve => setTimeout(resolve, 5));
      if (flows.length === 1) return { outcome: 'refused', verified: false, reason: sudo };
      granted = true;
      return { outcome: 'applied', verified: true, reason: 'Installation 2 now grants actions: read to write' };
    },
    recordRemedy: async (row, attempt) => {
      try { const result = await api(principals.coordinator, 'POST', `actions/${row}/remedy`, attempt); records.push({ row, outcome: attempt.outcome, cycle: cycles }); return result; }
      catch (error) { refusedRecords.push(error instanceof Error ? error.message : String(error)); throw error; }
    },
  };
  const escalations = new Map<string, Set<string>>(), failures: string[] = [];
  /** The executor's attempt at every claimable dispatch row of a held item: refused while the hold stands. */
  const execute = async () => {
    for (const item of items) {
      const claimed = await engine.claimNextAction(principals.coordinator, { executor: 'soak-executor', host: 'soak-host', kinds: ['dispatch'], work: item.id }, id()) as { action: { id: string } | null };
      if (!claimed.action) continue;
      await engine.settleClaimedAction(principals.coordinator, claimed.action.id, { executor: 'soak-executor', ...(granted ? { result: 'done', reason: 'the held job resumed' } : { result: 'failed', reason: hold(item.key) }) }, id());
    }
  };
  for (; clock.now() - dayStart < 6 * hour; cycles++) {
    if (items.length === 1 && clock.now() - dayStart >= 2 * hour) items.push(await create(2), await create(3));
    await execute();
    try { await runCycle(config, state, effects, clock.now, loop); }
    catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
    for (const item of (await store.list()).filter(entry => own().has(entry.id))) {
      if (process.env.SOAK_TRACE) console.error(`c${cycles} ${item.key} next=${item.nextAction?.kind}:${item.nextAction?.binding?.slice(0, 60)} rows=${(item.actionQueue?.actions ?? []).map(row => `${row.kind}/${row.state}/${row.attempts}/${row.remedy?.outcome ?? '-'}/${row.stall ? 'S' : ''}`).join(',')}`);
      for (const row of (item.actionQueue?.actions ?? []).filter(row => row.kind === 'escalate' && row.binding.startsWith('stalled:')))
        escalations.set(item.key, (escalations.get(item.key) ?? new Set()).add(row.binding));
    }
    await moveClock(minute);
  }
  await loop.idle();
  const final = (await store.list()).filter(item => own().has(item.id));
  const [first, second, third] = items.map(item => final.find(entry => entry.id === item.id)!);
  // A row the escalation superseded is retired to the queue's history, its record with it.
  const remedied = (work: Work) => [...work.actionQueue?.actions ?? [], ...work.actionQueue?.history ?? []].flatMap(row => row.remedy ? [row.remedy] : []);

  assert.deepEqual(failures, [], 'no cycle failed');
  assert.ok(cycles >= 300, `the loop ran the day: ${cycles} cycles`);
  // One flow per run: the refused run's, and the one the two rows held together share.
  assert.deepEqual(flows.map(entry => entry.flow), ['installation-accept', 'installation-accept'], `a flow per run, never one per cycle: ${JSON.stringify(flows)}`);
  assert.ok(flows[1].cycle - flows[0].cycle >= 100, 'the refused run was never retried while it stood');
  // One record per run and row, each through the route, and the route was never asked for a second.
  assert.deepEqual(records.map(entry => entry.outcome).sort(), ['applied', 'applied', 'refused']);
  assert.deepEqual(refusedRecords, [], 'the loop never tried to record a remedy twice for one run');
  assert.deepEqual([remedied(first).length, remedied(second).length, remedied(third).length], [1, 1, 1]);
  assert.equal(remedied(first)[0].outcome, 'refused');
  assert.match(remedied(first)[0].detail, /Confirm access was not approved/);
  // The refusal was escalated once with the refusal and the remedy named; the granted rows were not escalated.
  assert.deepEqual([...escalations.get(first.key) ?? []].length, 1, `one escalation for the refused run: ${[...escalations.get(first.key) ?? []].join(', ')}`);
  assert.match([...escalations.get(first.key)!][0], /^stalled:[0-9a-f]+:remedy:/);
  assert.equal(escalations.get(second.key), undefined);
  assert.equal(escalations.get(third.key), undefined);
  // The grant let the held rows complete: nothing of theirs is stalled any more.
  for (const work of [second, third]) assert.ok(!(work.actionQueue?.actions ?? []).some(row => row.kind === 'dispatch' && row.stall), `${work.key}'s row is no longer stalled`);
  // The loop's own report: one config action per flow, the refused one failed and the shared one done.
  const reported = Object.entries(state.actions).filter(([key]) => key === 'remedy:installation-accept').map(([, action]) => action);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].attempts, 2);
  for (const item of final) await api(principals.operator, 'POST', `work/${item.key}/close`, { kind: 'obsolete', reason: 'soak: the permission-hold scenario ends here' });
});

test('unit:soak-invariants-hold — releases requested outside any diagnosis that go stale in backlog are asked again by the loop once per stale decision against the current revision, each put to an approver that judges and is closed, a release that keeps racing escalates exactly once at the bound, no owed-decision fault is counted while the loop is still asking, a large slow backlog is read side by side and kept, and every invariant holds', { timeout: 600_000 }, async () => {
  // GY-1315. GY-1313 and GY-1314 sat in backlog behind stale releases nobody but the diagnosis step
  // would ask for again, and each owed line counted as a decision fault. Item 4's hand-requested
  // release races once; item 5's races every time it is judged. Sixty backlog items never released
  // sit beside them, each history read taking 60 ms of real time, as the stale-release step reads
  // every unreleased backlog item's history.
  const backlog = 60, readMs = 60;
  const day = await simulateDay({
    hours: 3, staleRelease: { item: 4, racing: 5, backlog, readMs },
    plan: { items: 5, releaseEveryMs: 5 * minute, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 5, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 5 } },
  });
  const { items, final, violations, failures, lost, decideCalls, approverWorks, approverPanes, herdrClosed, state, staleReleaseDay } = day;
  const [once, racing] = [items[3], items[4]];
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'all five items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  assert.deepEqual(staleReleaseDay.hand.map(entry => entry.key), [once.key, racing.key], 'both hand releases were requested');
  for (const entry of [...staleReleaseDay.hand, ...staleReleaseDay.races]) assert.match(entry.outcome, /Task revision changed/, `${entry.key}'s release ${entry.decision} went stale on the race`);
  const releases = async (work: Work) => (await api(principals.operatorAgent, 'GET', `work/${encodeURIComponent(work.id)}/decisions`)).decisions
    .filter((entry: { action: string }) => entry.action === 'release') as { id: string; state: string; requestedAt: string; input: { expectedRevision?: number } }[];

  // The hand release that raced once: the loop asked again once, bound to the revision the item had
  // moved to, put it to one approver, and it applied.
  const onceReleases = await releases(once);
  assert.deepEqual(onceReleases.map(entry => entry.state), ['stale', 'applied'], `${once.key}'s release went stale once and its one re-request applied: ${JSON.stringify(onceReleases)}`);
  assert.ok(onceReleases[1].input.expectedRevision! > onceReleases[0].input.expectedRevision!, 'the re-request binds the revision the item moved to');
  assert.equal(decideCalls.filter(call => call.key === once.key && call.action === 'release').length, 1, 'one re-request per stale release');
  assert.deepEqual(approverWorks.filter(key => key === once.key), [once.key], 'the re-request had exactly one approver');

  // The release that keeps racing: asked again until maxDecisionRequests releases settled without
  // applying, each once and against the current revision, then escalated exactly once and asked no more.
  const racingReleases = await releases(racing);
  const unapplied = racingReleases.filter(entry => entry.state === 'stale');
  assert.equal(unapplied.length, maxDecisionRequests, `${racing.key}'s releases went stale up to the bound: ${JSON.stringify(racingReleases.map(entry => entry.state))}`);
  assert.equal(racingReleases.filter(entry => entry.state !== 'stale').length, 0, 'nothing more was requested once the bound was spent');
  assert.equal(staleReleaseDay.races.length, maxDecisionRequests - 1, 'every re-request was judged by its approver');
  assert.equal(decideCalls.filter(call => call.key === racing.key && call.action === 'release').length, maxDecisionRequests - 1, 'one re-request per stale release, up to the bound');
  for (const [index, entry] of racingReleases.entries()) if (index) assert.ok(entry.input.expectedRevision! > racingReleases[index - 1].input.expectedRevision!, 'each re-request binds the item\'s current revision');
  const escalated = Object.entries(state.actions).filter(([key, action]) => key.startsWith('release:stale:') && action.kind === 'escalation' && action.work === racing.key);
  assert.equal(escalated.length, 1, `the spent release escalated exactly once: ${JSON.stringify(escalated)}`);
  assert.equal(day.escalations.filter(detail => detail.startsWith(`${racing.key} still waits in backlog for its release`)).length, 1, 'and that escalation was performed once across the day');
  assert.deepEqual(staleReleaseDay.handReleased.map(entry => entry.key), [racing.key], 'the operator released it by the route the escalation named');

  // Every approver the loop launched for a re-request judged and was closed.
  assert.ok(approverWorks.filter(key => key === racing.key).length >= maxDecisionRequests - 1, `each of ${racing.key}'s re-requests had its approver: ${JSON.stringify(approverWorks)}`);
  assert.deepEqual(approverPanes.filter(pane => !herdrClosed.includes(pane)), [], `every approver session the day launched was closed: ${JSON.stringify(herdrClosed)}`);

  // No owed-decision fault while the loop was still asking: none for the once-raced item, and none
  // for the racing one before its last request went stale and spent the bound (past it the loop asks
  // no more, so the owed release is a fault, as it should be).
  const spentAt = staleReleaseDay.races.at(-1)!.at;
  const owed = state.faults.instances.filter(instance => instance.kind === 'owed-decision' && (instance.subject === once.key || instance.subject === racing.key));
  assert.deepEqual(owed.filter(instance => instance.subject === once.key || Date.parse(instance.at) < spentAt), [], `no owed-decision fault while the loop was asking again: ${JSON.stringify(owed)}`);
  assert.deepEqual(state.faults.instances.filter(instance => instance.faultClass === 'decision' && instance.subject === once.key), [], `no decision fault of any kind for ${once.key}`);

  // The large backlog: every cold read pass ran side by side and was kept, so the decisions step
  // never waited out the backlog's reads one after another, nor read a kept history again.
  const cold = staleReleaseDay.steps.filter(step => step.backlogReads > 0);
  assert.ok(cold.length >= 1, 'the backlog was read');
  for (const step of staleReleaseDay.steps) assert.ok(step.ms < backlog * readMs / 2, `the decisions step at +${Math.round(step.elapsed / minute)} min took ${step.ms} ms reading ${step.backlogReads} backlog histories (${backlog * readMs} ms one after another)`);
  assert.ok(staleReleaseDay.steps.filter(step => step.backlogReads === 0).length > cold.length * 5, `a kept backlog history is not read again each cycle: ${cold.length} of ${staleReleaseDay.steps.length} cycles read the backlog`);
});
