import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';

// Loaded inside each case, so a tree without this change fails these cases rather than the file.
const modules = async () => ({ ...await import('../src/model.js'), ...await import('../src/master-verification.js'), ...await import('../src/executor.js'),
  ...await import('../src/model/next-action.js'), ...await import('../src/model/action-account.js'), ...await import('../src/model/liveness.js'),
  ...await import('../src/model/actions.js'), ...await import('../src/model/actionless.js'), ...await import('../src/model/plain-status.js'), ...await import('../src/master/status.js'),
  ...await import('../src/master/dispatch.js'), ...await import('../src/coordination.js') });

// GY-1698: a post-deploy follow-up for a windowed criterion — an intervention rate below a threshold
// per N days, a hold for N consecutive days — can produce nothing before the window has run. GY-1689
// was filed at 03:36Z for GY-1685's 03:11Z merge and released at 06:39Z; the intervention report
// projected its reading no earlier than 2026-10-17T14:31Z, and two worker attempts, a review and two
// approver sessions were spent on it. The follow-up now carries the earliest instant its reading can
// exist (AC-1), and a released follow-up is not dispatched before it (AC-2).

const day = 86_400_000;
const mergeSha = 'f1984c1183521617660bdad738e72456315428ea', release = mergeSha;
const mergedAt = '2026-10-11T03:11:02Z', mergedMs = Date.parse(mergedAt);
const gy1685Id = 'b896515a-0def-4a4d-95f5-e7de00578d81';
const patternProof = 'manual:post-deploy/intervention-pattern-escalation-build';
// GY-1685 AC-1 as interventions/patterns.ts filed it, and GY-1682 AC-2's hand-written hold.
const rate = { id: 'AC-1', text: 'The cause of the recurring escalation interventions at the build stage is found and removed: the intervention report shows the escalation rate at the build stage below 3 per 7 days after the change ships, and the linked instances could not recur', proofs: [patternProof] };
const hold = { id: 'AC-2', text: 'Build-stage scope-widening interventions stay below the threshold of 3 in any rolling 7-day window for 14 consecutive days, with the counted causes recorded against the owning item', proofs: ['manual:post-deploy/intervention-pattern-within-threshold'] };
const regression = { id: 'AC-2', text: 'Each linked instance is reproduced against the base and shown not to recur against the candidate, by a test the change adds', proofs: ['manual:intervention-pattern-escalation-build'] };

/** GY-1685 as delivered: merged at 03:11Z, its deployment observed on the release that is its own merge. */
const delivered = (overrides: Partial<Work> = {}): Work => ({
  id: gy1685Id, key: 'GY-1685', title: 'Recurring escalation interventions at the build stage: 3 in 7 days', description: '', type: 'bug', priority: 1,
  dependencies: [], criteria: [rate, regression], policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: [],
  stage: 'done', revision: 40, policyRevision: 1, createdAt: '2026-10-11T02:07:11.287Z', updatedAt: mergedAt, stageEnteredAt: mergedAt, ready: true, epoch: 1, lease: null,
  workspaces: [{ host: 'vishrog', path: '/w', branch: 'graphyard/gy-1685-1', epoch: 1, owner: 'graphyard-codex-2' }], candidate: null, submission: { epoch: 1, pr: 1110 }, reworkRequested: false,
  scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [],
  delivery: { mergeSha, mergedAt, evidenceAsOf: mergedAt, authorizationRevision: 334 } as never, ...overrides,
} as Work);
const projection = { since: null, projected: '2026-10-17T14:31:37.000Z' };
const iso = (ms: number) => new Date(ms).toISOString();

test('unit:post-deploy-follow-up-observation-window — a windowed follow-up records the earliest instant its reading can exist, from the report\'s projection or the merge plus the criterion\'s window, readable on the item and in master status', async () => {
  const { buildMasterStatus, createSchema, criterionWindowDays, filePostDeployFollowUps, observationWindowFor, observationWindowHold, patternOfProof, patternReader, postDeployChecks, verifyDeployment } = await modules();
  // The declared proof names the report's pattern; the kinds carry hyphens of their own.
  assert.deepEqual(patternOfProof(patternProof), { kind: 'escalation', stage: 'build' });
  assert.deepEqual(patternOfProof('manual:post-deploy/intervention-pattern-scope-widening-build'), { kind: 'scope-widening', stage: 'build' });
  assert.deepEqual(patternOfProof('manual:post-deploy/intervention-pattern-human-only-decision-none'), { kind: 'human-only-decision', stage: 'none' });
  assert.equal(patternOfProof(hold.proofs[0]), null, 'a hand-named proof is no pattern row');
  assert.equal(patternOfProof('manual:post-deploy/harness-drift-cleared'), null);
  // The criterion's window: a per-7-days rate, a 14-consecutive-days hold over 7-day windows, none.
  assert.equal(criterionWindowDays(rate.text), 7);
  assert.equal(criterionWindowDays(hold.text), 14);
  assert.equal(criterionWindowDays(regression.text), null);
  assert.equal(criterionWindowDays("'master status' on the live install reports harnessDrift null after a loop cycle"), null);

  // AC-1's rule. GY-1689 as filed: since null, the streak projected to 2026-10-17T14:31Z — earlier than the
  // merge plus the 7-day window the criterion names, so the reading can first exist at the merge bound.
  const merge7 = mergedMs + 7 * day;
  const filed = observationWindowFor(delivered(), rate, patternProof, projection)!;
  assert.equal(filed.notBefore, iso(merge7));
  assert.equal(filed.basis, 'criterion-window');
  assert.match(filed.detail, /GY-1685 merged at 2026-10-11T03:11:02.000Z and AC-1 names a 7-day window, so the reading can first exist at 2026-10-18T03:11:02.000Z \(the intervention report's projection for the escalation reading at the build stage, 2026-10-17T14:31:37.000Z, is earlier\)/);
  // A projection past the merge bound is the instant: the report says the reading cannot exist before it.
  const later = observationWindowFor(delivered(), rate, patternProof, { since: null, projected: '2026-10-20T00:00:00.000Z' })!;
  assert.deepEqual([later.notBefore, later.basis], ['2026-10-20T00:00:00.000Z', 'intervention-report']);
  assert.match(later.detail, /not yet under its threshold \(since null\) and projects the streak to begin at 2026-10-20T00:00:00.000Z/);
  // A streak already begun: since plus the criterion's window, when that is the later bound.
  const since = observationWindowFor(delivered(), rate, patternProof, { since: '2026-10-12T00:00:00.000Z', projected: null })!;
  assert.deepEqual([since.notBefore, since.basis], ['2026-10-19T00:00:00.000Z', 'intervention-report']);
  assert.match(since.detail, /under its threshold since 2026-10-12T00:00:00.000Z, and AC-1 names a 7-day window, so the reading can first exist at 2026-10-19T00:00:00.000Z; GY-1685 merged at/);
  const early = observationWindowFor(delivered(), rate, patternProof, { since: '2026-10-05T00:00:00.000Z', projected: null })!;
  assert.deepEqual([early.notBefore, early.basis], [iso(merge7), 'criterion-window'], 'a streak begun before the merge still waits for the post-ship window');
  // No report reading: the merge plus the window. A 14-consecutive-days hold is at least the merge plus 14 days.
  const unread = observationWindowFor(delivered(), rate, patternProof, null)!;
  assert.deepEqual([unread.notBefore, unread.basis], [iso(merge7), 'criterion-window']);
  assert.match(unread.detail, /holds no reading for the escalation reading at the build stage/);
  const fourteen = observationWindowFor(delivered({ criteria: [hold] }), hold, hold.proofs[0], undefined)!;
  assert.deepEqual([fourteen.notBefore, fourteen.basis], [iso(mergedMs + 14 * day), 'criterion-window']);
  // A reading no window bounds carries none: an ordinary follow-up.
  assert.equal(observationWindowFor(delivered(), { id: 'AC-3', text: "'master status' on the live install reports harnessDrift null" }, 'manual:post-deploy/harness-drift-cleared', undefined), undefined);

  // The filing: the report is read once per pattern proof, the follow-up carries the window and says so.
  const reads: unknown[] = [];
  const patterns = async (pattern: unknown) => { reads.push(pattern); return projection; };
  const inputs: any[] = [];
  const file = async (input: any) => { inputs.push(input); return { key: 'GY-1689' }; };
  const checks = await filePostDeployFollowUps(delivered(), release, [delivered()], file, new Date('2026-10-11T03:36:11.661Z'), patterns);
  assert.deepEqual(checks.map(check => [check.criterion, check.result, check.followUp]), [['AC-1', 'owed', 'GY-1689']]);
  assert.deepEqual(reads, [{ kind: 'escalation', stage: 'build' }]);
  assert.deepEqual(inputs[0].observationWindow, filed);
  assert.match(inputs[0].description, /\n\nObservation window: the reading can first exist at 2026-10-18T03:11:02.000Z — GY-1685 merged at .*\. The item is not dispatched before then\.\n\nGY-1685 AC-1:/);
  // The server's create input is the schema with the operator agent's reason beside it: the window is on the item.
  const { reason: _reason, ...created } = inputs[0];
  const parsed = createSchema.parse(created);
  assert.deepEqual(parsed.observationWindow, filed);
  assert.equal(createSchema.safeParse({ ...created, observationWindow: { notBefore: 'soon', basis: 'criterion-window', detail: '' } }).success, false, 'the instant is an ISO instant');
  // A report that cannot be read, or none, still files the follow-up — on the merge bound.
  const unreadable: any[] = [];
  await filePostDeployFollowUps(delivered(), release, [delivered()], async input => { unreadable.push(input); return { key: 'GY-1689' }; }, new Date(), async () => { throw new Error('report timed out'); });
  assert.deepEqual([unreadable[0].observationWindow.notBefore, unreadable[0].observationWindow.basis], [iso(merge7), 'criterion-window']);
  const withoutReader = postDeployChecks(delivered(), release)[0].followUp!.input;
  assert.deepEqual([withoutReader.observationWindow!.notBefore, withoutReader.observationWindow!.basis], [iso(merge7), 'criterion-window']);
  assert.equal(postDeployChecks(delivered({ criteria: [{ id: 'AC-3', text: "'master status' on the live install reports harnessDrift null", proofs: ['manual:post-deploy/harness-drift-cleared'] }] }), release)[0].followUp!.input.observationWindow, undefined);
  // The reader over GET /api/interventions: the pattern's row, or null when the report holds none.
  const report = { patterns: [{ kind: 'escalation', stage: 'build', underThreshold: { ...projection, days: 0, holdDays: 14, peak: 3, reach: '2026-10-10T14:31:37.000Z', established: '2026-10-17T14:31:37.000Z' } }] };
  const paths: string[] = [];
  const read = patternReader(async path => { paths.push(path); return report; });
  assert.deepEqual(await read({ kind: 'escalation', stage: 'build' }), projection);
  assert.equal(await read({ kind: 'rework', stage: 'build' }), null);
  assert.deepEqual(paths, ['interventions', 'interventions']);

  // Through master verify-deployment's effects: the filed input carries the window.
  const now = Date.parse('2026-10-11T03:36:02.908Z'), work = [delivered()], filedByVerify: any[] = [];
  const verified = await verifyDeployment(work[0], {
    snapshot: async () => ({ work, now: iso(now) }),
    observe: async () => ({ source: 'endpoint' as const, sha: release, at: iso(now), reason: null, deployed: ['GY-1685'], pending: [] }),
    release: () => ({ sha: 'f'.repeat(40), clean: true, repository: 'other/repo', reason: null }),
    emit: async () => assert.fail('nothing is emitted'), repository: 'owner/project', now: () => now,
    record: async () => {}, file: async (input: any) => { filedByVerify.push(input); return { key: 'GY-1689' }; }, patterns,
  });
  assert.equal(verified.result, 'verified', verified.refusals.join('; '));
  assert.deepEqual(filedByVerify[0].observationWindow, filed);

  // Readable on the item and in master status: the row names the instant and whether it still holds.
  const followUp = { ...delivered(), ...parsed, id: 'c0ffee00-0000-4000-8000-000000001689', key: 'GY-1689', stage: 'ready', ready: true, delivery: undefined, submission: null, workspaces: [], gates: [], createdAt: '2026-10-11T03:36:11.661Z', stageEnteredAt: '2026-10-11T06:39:00.000Z' } as unknown as Work;
  const status = buildMasterStatus({ work: [delivered(), followUp], now: '2026-10-11T06:40:00.000Z' }, [], []);
  const row = status.work.find(entry => entry.key === 'GY-1689')!;
  assert.deepEqual(row.observationWindow, { ...filed, waiting: true });
  assert.deepEqual(observationWindowHold(followUp, new Date('2026-10-11T06:40:00.000Z')), filed);
  assert.equal(observationWindowHold(followUp, new Date(filed.notBefore)), null, 'at the instant the window no longer holds');
  assert.equal(buildMasterStatus({ work: [delivered(), followUp], now: filed.notBefore }, [], []).work.find(entry => entry.key === 'GY-1689')!.observationWindow!.waiting, false);
});

test('unit:observation-window-holds-dispatch — a released follow-up is not dispatched before its recorded instant and is dispatched by the loop once it passes; before the fix GY-1689 was dispatched at once', async () => {
  const { actionAccount, actionlessCards, actionlessItems, assertDispatchable, buildMasterStatus, createSchema, dispatchable, evaluate, livenessFallback, nextAction, plainStatus, postDeployChecks, reconcileActions, stalledCards, stalledItems } = await modules();
  const gy1685 = delivered();
  const notBefore = iso(mergedMs + 7 * day);
  // GY-1689 as the loop files it now: GY-1685's follow-up, carrying the window, released at 06:39Z.
  const { reason: _reason, ...input } = postDeployChecks(gy1685, release, new Date('2026-10-11T03:36:11.661Z'), { [patternProof]: projection })[0].followUp!.input;
  const released = (at: string, overrides: Partial<Work> = {}): Work => {
    const item = { ...gy1685, ...createSchema.parse(input), id: 'c0ffee00-0000-4000-8000-000000001689', key: 'GY-1689', stage: 'ready', revision: 3, ready: true, delivery: undefined, submission: null, workspaces: [], lease: null, epoch: 0,
      createdAt: '2026-10-11T03:36:11.661Z', updatedAt: at, stageEnteredAt: '2026-10-11T06:39:00.000Z', gates: [], ...overrides } as unknown as Work;
    const evaluated = evaluate(item, [gy1685, item], new Date(at), [15368]);
    // `nextAction: null` is the control plane having computed an action and found none, as its evaluation writes it.
    return { ...item, stage: evaluated.stage, gates: evaluated.gates, violations: evaluated.violations, nextAction: null };
  };
  const releasedAt = '2026-10-11T06:39:55.000Z';
  const item = released(releasedAt), all = [gy1685, item];
  assert.equal(item.gates.find(gate => !gate.passed)?.name, 'build', 'released, its dependency delivered, the build gate is what refuses');
  assert.equal(item.observationWindow!.notBefore, notBefore);

  // Before the fix the follow-up carried no window, and the same item dispatched at once.
  const unwindowed = released(releasedAt, { observationWindow: undefined });
  const before = actionAccount(unwindowed, [gy1685, unwindowed], new Date(releasedAt));
  assert.equal(before.action?.kind, 'dispatch');
  assert.match(before.action!.reason, /^GY-1689 is ready and unassigned: Worker has not submitted implementation for this attempt/);
  assert.equal(dispatchable(unwindowed, Date.parse(releasedAt)), true);
  assert.doesNotThrow(() => assertDispatchable(unwindowed, [gy1685, unwindowed], releasedAt));

  // With the window: no dispatch action, a named wait on the instant, and the loop's queue requests nothing.
  // The durable loop's claimable set (assertDispatchable) and master status's schedule (dispatchable)
  // refuse the same way — nextAction alone never stopped GY-1689's launch.
  for (const at of [releasedAt, '2026-10-17T14:31:37.000Z', '2026-10-18T03:11:01.999Z']) {
    const account = actionAccount(item, all, new Date(at));
    assert.equal(account.action, null, `no action at ${at}`);
    assert.deepEqual([account.gate, account.refusal, account.wait?.kind, account.wait?.on], ['build', 'Worker has not submitted implementation for this attempt', 'window', null]);
    assert.match(account.wait!.detail, new RegExp(`^GY-1689 waits for its observation window: the reading it owes can first exist at ${notBefore} \\(GY-1685 merged at .*\\); the loop dispatches it then$`));
    assert.equal(nextAction(item, all, new Date(at)), null);
    const queued = { ...item, actionQueue: { actions: [], history: [] } } as Work;
    assert.deepEqual(reconcileActions(queued, [gy1685, queued], new Date(at)), [], 'the dispatch step is asked for nothing');
    assert.deepEqual(queued.actionQueue!.actions, []);
    assert.equal(dispatchable(item, Date.parse(at)), false, `dispatchable holds at ${at}`);
    assert.throws(() => assertDispatchable(item, all, at), /Dispatch waits for its observation window: the reading it owes can first exist at/);
    // Not a stale wait, not stalled, not a stalled card: the wait is due at the instant.
    assert.equal(livenessFallback(item, all, new Date(at)), null);
    assert.deepEqual(stalledItems(all, new Date(at)), []);
    const listed = actionlessItems(all, new Date(at)).find(entry => entry.key === 'GY-1689')!;
    assert.deepEqual([listed.outcome, listed.waitingOn], ['waiting-on', null]);
    assert.match(listed.detail, new RegExp(`can first exist at ${notBefore}`));
    assert.deepEqual(stalledCards(all, Date.parse(at)), []);
    assert.equal(actionlessCards(all, Date.parse(at)).find(card => card.item.key === 'GY-1689')!.movedBy, `its observation window, which closes at ${notBefore}`);
  }
  // Master status: the row names the instant and raises no gate attention row, hours past the one-hour dwell bound.
  const status = buildMasterStatus({ work: all, now: '2026-10-14T06:39:55.000Z' }, [], []);
  const row = status.work.find(entry => entry.key === 'GY-1689')!;
  assert.deepEqual([row.attention, row.attentionOwner, row.observationWindow!.waiting, row.observationWindow!.notBefore], [null, null, true, notBefore]);
  assert.deepEqual(status.attentionItems.filter(entry => entry.subject === 'GY-1689'), []);
  assert.equal(plainStatus(item, Date.parse('2026-10-14T06:39:55.000Z')).sentence, `Waiting for its observation window — the reading it owes can first exist at ${notBefore}`);
  // The pre-fix item at the same dwell is the stalled-gate row the item describes.
  const stale = buildMasterStatus({ work: [gy1685, unwindowed], now: '2026-10-14T06:39:55.000Z' }, [], []).work.find(entry => entry.key === 'GY-1689')!;
  assert.equal(stale.attention, 'Worker has not submitted implementation for this attempt');

  // Once the instant passes the same computation names the dispatch, and the queue requests it as Graphyard: no master session.
  for (const at of [notBefore, '2026-10-18T09:00:00.000Z']) {
    const account = actionAccount(item, all, new Date(at));
    assert.equal(account.action?.kind, 'dispatch', `dispatched at ${at}`);
    assert.deepEqual(account.action!.inputs, { kind: 'dispatch', target: 'implementation', epoch: 0, priority: 1, plannedFiles: [] });
    const queued = { ...item, actionQueue: { actions: [], history: [] } } as Work;
    const transitions = reconcileActions(queued, [gy1685, queued], new Date(at));
    assert.deepEqual(transitions.map(entry => [entry.event, entry.action.kind, entry.action.requestedBy]), [['requested', 'dispatch', 'graphyard']]);
    assert.equal(dispatchable(item, Date.parse(at)), true, `dispatchable at ${at}`);
    assert.doesNotThrow(() => assertDispatchable(item, all, at));
    const later = buildMasterStatus({ work: all, now: at }, [], []).work.find(entry => entry.key === 'GY-1689')!;
    assert.equal(later.observationWindow!.waiting, false);
    assert.equal(plainStatus(item, Date.parse(at)).sentence, 'Waiting for someone to pick this up');
  }
  // A worker holding the item is the session the build gate waits for, window or none; the hold never offers it to a second worker.
  const leased = { ...item, epoch: 1, lease: { owner: 'graphyard-codex-1', epoch: 1, expiresAt: '2026-10-11T07:10:00.000Z' } } as Work;
  assert.deepEqual(actionAccount(leased, [gy1685, leased], new Date('2026-10-11T07:00:00.000Z')).wait?.kind, 'session');
});
