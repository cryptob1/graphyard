import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

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

// GY-1727: on 2026-10-12 master verify-deployment filed GY-1721 (GY-1684 AC-1, a rate per 7 days) and
// GY-1724 (GY-1700 AC-2, a 24-hour window of live webhook deliveries) against the already serving
// release ba607f8a809e with no window, and both were dispatched at once. The 7-day reading cannot exist
// before GY-1684's merge plus 7 days; the 24-hour one before the release was first observed serving
// GY-1700 plus 24 hours — "24-hour" and "24h" named no window the filer recognised.
const serving = 'ba607f8a809ed20fea15387e1934425cacbfef9f';
const gy1684 = delivered({ id: '418cda0c-6c23-401a-b38a-836521a30534', key: 'GY-1684', criteria: [
  { id: 'AC-1', text: 'The cause of the recurring scope widening interventions at the build stage is found and removed: the intervention report shows the scope-widening rate at the build stage below 3 per 7 days after the change ships, and the linked instances could not recur', proofs: ['manual:post-deploy/intervention-pattern-scope-widening-build'] },
  { id: 'AC-2', text: 'Each linked instance is reproduced against the base and shown not to recur against the candidate, by a test the change adds', proofs: ['manual:intervention-pattern-scope-widening-build'] }],
  delivery: { mergeSha: '3ac8ada5fd51ec9c23b31318da2ee49e31b01b4c', mergedAt: '2026-10-11T07:43:36Z', evidenceAsOf: '2026-10-11T07:43:36Z', authorizationRevision: 1 } as never });
const gy1700 = delivered({ id: 'e03bc94f-82f4-481d-a443-4b4e6abe9eb6', key: 'GY-1700', criteria: [
  { id: 'AC-2', text: 'A 24-hour window of live GitHub activity on cryptob1/graphyard shows zero failed webhook deliveries (no 5xx, no connection failures) in the App\'s advanced delivery log at github.com/settings/apps/graphyard-cryptob1-graphyard/advanced.', proofs: ['manual:post-deploy/webhook-deliveries-clean-24h'] },
  { id: 'AC-3', text: 'The github-budget attention row in graphyard master status clears when a delivery arrives and does not re-fire during 24h of live repository activity while at least one pull request is open.', proofs: ['manual:post-deploy/github-budget-attention-row-clears'] }],
  delivery: { mergeSha: 'a14965e4ad9ad52069ce7dc0c5d5aabdbf4f8b43', mergedAt: '2026-10-11T15:08:24Z', evidenceAsOf: '2026-10-11T15:08:24Z', authorizationRevision: 1 } as never });
/** master verify-deployment of one delivered item against the serving release, observed at `at`: the follow-up inputs it files. */
const verifyServing = async (item: Work, at: string) => {
  const { verifyDeployment } = await modules();
  const now = Date.parse(at) + 2_000, filed: any[] = [];
  const verified = await verifyDeployment(item, {
    snapshot: async () => ({ work: [item], now: iso(now) }),
    observe: async () => ({ source: 'endpoint' as const, sha: serving, at, reason: null, deployed: [item.key], pending: [] }),
    release: () => ({ sha: 'f'.repeat(40), clean: true, repository: 'other/repo', reason: null }),
    emit: async () => assert.fail('nothing is emitted'), repository: 'owner/project', now: () => now,
    record: async () => {}, releaseWork: async () => {}, file: async (input: any) => { filed.push(input); return { key: `GY-${1720 + filed.length}` }; },
    patterns: async () => ({ since: null, projected: '2026-10-15T10:32:39.000Z' }),
  });
  assert.equal(verified.result, 'verified', verified.refusals.join('; '));
  return filed;
};

test('unit:post-deploy-follow-up-observation-window — a windowed follow-up records the earliest instant its reading can exist, from the report\'s projection or the merge plus the criterion\'s window, readable on the item and in master status', async () => {
  const { buildMasterStatus, createSchema, criterionHoldDays, criterionWindowDays, filePostDeployFollowUps, observationWindowFor, observationWindowHold, patternOfProof, patternReader, postDeployChecks, verifyDeployment } = await modules();
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
  // A consecutive-day hold is distinct from a rate window: only the hold adds days after a projected streak start.
  assert.equal(criterionHoldDays(rate.text), null);
  assert.equal(criterionHoldDays(hold.text), 14);
  assert.equal(criterionHoldDays(regression.text), null);

  // AC-1's rule. GY-1689 as filed: since null, the streak projected to 2026-10-17T14:31Z — earlier than the
  // merge plus the 7-day window the criterion names, so the reading can first exist at the merge bound.
  const merge7 = mergedMs + 7 * day;
  const filed = observationWindowFor(delivered(), rate, patternProof, projection)!;
  assert.equal(filed.notBefore, iso(merge7));
  assert.equal(filed.basis, 'criterion-window');
  assert.match(filed.detail, /GY-1685 merged at 2026-10-11T03:11:02.000Z and AC-1 names a 7-day window, so the reading can first exist at 2026-10-18T03:11:02.000Z \(the intervention report's projection for the escalation reading at the build stage, 2026-10-17T14:31:37.000Z, is earlier\)/);
  // A rate's projection past the merge bound is the instant: the report says the rate reading cannot exist before the streak begins.
  const later = observationWindowFor(delivered(), rate, patternProof, { since: null, projected: '2026-10-20T00:00:00.000Z' })!;
  assert.deepEqual([later.notBefore, later.basis], ['2026-10-20T00:00:00.000Z', 'intervention-report']);
  assert.match(later.detail, /not yet under its threshold \(since null\) and projects the streak to begin at 2026-10-20T00:00:00.000Z/);
  // A consecutive-day hold: `projected` is the streak's start, so the reading exists only hold-days later
  // (review of 3717dcd8cb0b): merge Oct 11, streak projected Oct 30 → Nov 13, not Oct 30.
  const holdProjected = '2026-10-30T00:00:00.000Z';
  const holdReady = iso(Date.parse(holdProjected) + 14 * day);
  const held = observationWindowFor(delivered({ criteria: [hold] }), hold, hold.proofs[0], { since: null, projected: holdProjected })!;
  assert.deepEqual([held.notBefore, held.basis], [holdReady, 'intervention-report']);
  assert.equal(held.notBefore, '2026-11-13T00:00:00.000Z');
  assert.match(held.detail, /projects the streak to begin at 2026-10-30T00:00:00.000Z, and AC-2 names a 14-consecutive-day hold, so the reading can first exist at 2026-11-13T00:00:00.000Z/);
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
  // The filing clock is the fixture's own instant (same as the readable-report case above), never the wall clock:
  // the observation bound depends only on merge and the criterion window, so wall time cannot change the assertion.
  const unreadable: any[] = [];
  await filePostDeployFollowUps(delivered(), release, [delivered()], async input => { unreadable.push(input); return { key: 'GY-1689' }; }, new Date('2026-10-11T03:36:11.661Z'), async () => { throw new Error('report timed out'); });
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
    record: async () => {}, releaseWork: async () => {}, file: async (input: any) => { filedByVerify.push(input); return { key: 'GY-1689' }; }, patterns,
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

  // GY-1727, reproducing GY-1721 and GY-1724: the already serving release files both follow-ups with their instants.
  const { criterionWindowHours } = await modules();
  assert.equal(criterionWindowHours(gy1700.criteria[0].text), 24);
  assert.equal(criterionWindowHours(gy1700.criteria[1].text), 24);
  assert.equal(criterionWindowHours(gy1684.criteria[0].text), null);
  assert.equal(criterionWindowHours('GY-1611 merged at 03:11Z; build 4567 hours of soak'), null, 'a number past three digits is no window');
  const [gy1721] = await verifyServing(gy1684, '2026-10-12T07:32:35.697Z');
  assert.deepEqual([gy1721.observationWindow.notBefore, gy1721.observationWindow.basis], ['2026-10-18T07:43:36.000Z', 'criterion-window'], 'merge plus the 7-day window: the report projects the streak earlier');
  assert.match(gy1721.description, /Observation window: the reading can first exist at 2026-10-18T07:43:36.000Z/);
  const [gy1724, gy1725] = await verifyServing(gy1700, '2026-10-12T07:33:40.939Z');
  assert.deepEqual([gy1724.observationWindow.notBefore, gy1724.observationWindow.basis], ['2026-10-13T07:33:40.939Z', 'criterion-window'], 'first observed serving plus 24 hours, not the merge plus 24 hours');
  assert.match(gy1724.observationWindow.detail, /GY-1700's serving release was first observed at 2026-10-12T07:33:40.939Z and AC-2 names a 24-hour live window, so the reading can first exist at 2026-10-13T07:33:40.939Z/);
  assert.equal(gy1725.observationWindow.notBefore, '2026-10-13T07:33:40.939Z', '"24h" is the same live window');
  assert.deepEqual(createSchema.parse((({ reason: _r, ...rest }) => rest)(gy1724)).observationWindow, gy1724.observationWindow);
  // Already recorded as serving: a later re-run keeps the first observation, never restarting the window.
  const recorded = { ...gy1700, delivery: { ...gy1700.delivery!, deployment: { sha: serving, mergeSha: gy1700.delivery!.mergeSha, source: 'endpoint', observedAt: '2026-10-12T07:33:40.939Z', at: '2026-10-12T07:33:47.795Z', observer: 'graphyard-master', covers: 'descendant' } } } as Work;
  assert.equal(postDeployChecks(recorded, serving, new Date('2026-10-12T09:00:00.000Z'), {}, new Date('2026-10-12T08:59:58.000Z'))[0].followUp!.input.observationWindow!.notBefore, '2026-10-13T07:33:40.939Z');
  // With no serving observation the merge anchors it; a day window past the hour window still decides.
  assert.equal(observationWindowFor(gy1700, gy1700.criteria[0], gy1700.criteria[0].proofs[0], undefined)!.notBefore, '2026-10-12T15:08:24.000Z');
  assert.equal(observationWindowFor(gy1700, { id: 'AC-9', text: 'per 7 days, in any 24-hour window' }, 'manual:post-deploy/x', undefined, Date.parse('2026-10-12T07:33:40.939Z'))!.notBefore, '2026-10-18T15:08:24.000Z');
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

  // Before the fix the follow-up carried no window, and the same item dispatched at once. A system-driven one
  // is now held by the loop's own observation (GY-1762); a hand-driven one still dispatches.
  const unwindowed = released(releasedAt, { observationWindow: undefined, systemDriven: false });
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
    assert.match(account.wait!.detail, new RegExp(`^GY-1689 waits for the loop's reading of .*, which can first exist at ${notBefore} \\(GY-1685 merged at .*\\); the loop records it, and no worker is dispatched$`));
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

  // Once the instant passes a hand-driven one is named a dispatch, and the queue requests it as Graphyard: no master session.
  const hand = released(releasedAt, { systemDriven: false }), handAll = [gy1685, hand];
  for (const at of [notBefore, '2026-10-18T09:00:00.000Z']) {
    const account = actionAccount(hand, handAll, new Date(at));
    assert.equal(account.action?.kind, 'dispatch', `dispatched at ${at}`);
    assert.deepEqual(account.action!.inputs, { kind: 'dispatch', target: 'implementation', epoch: 0, priority: 1, plannedFiles: [] });
    const queued = { ...hand, actionQueue: { actions: [], history: [] } } as Work;
    const transitions = reconcileActions(queued, [gy1685, queued], new Date(at));
    assert.deepEqual(transitions.map(entry => [entry.event, entry.action.kind, entry.action.requestedBy]), [['requested', 'dispatch', 'graphyard']]);
    assert.equal(dispatchable(hand, Date.parse(at)), true, `dispatchable at ${at}`);
    assert.doesNotThrow(() => assertDispatchable(hand, handAll, at));
    const later = buildMasterStatus({ work: all, now: at }, [], []).work.find(entry => entry.key === 'GY-1689')!;
    assert.equal(later.observationWindow!.waiting, false);
    assert.equal(plainStatus(hand, Date.parse(at)).sentence, 'Waiting for someone to pick this up');
  }
  // GY-1762: the system-driven one is never dispatched, even once its window has closed: the reading is owed
  // to the loop (an escalation), the item stays counted waiting, and only a recorded trusted reading ends that.
  for (const at of [notBefore, '2026-10-18T09:00:00.000Z']) {
    const account = actionAccount(item, all, new Date(at));
    assert.equal(account.action?.kind, 'escalate', `owed, not dispatched, at ${at}`);
    assert.equal(dispatchable(item, Date.parse(at)), false, `not dispatchable at ${at}`);
    assert.throws(() => assertDispatchable(item, all, at), /Dispatch waits for the loop's observation/);
    const later = buildMasterStatus({ work: all, now: at }, [], []);
    assert.deepEqual([later.counts.ready, later.counts.waiting], [0, 1]);
  }
  // A worker holding the item is the session the build gate waits for, window or none; the hold never offers it to a second worker.
  const leased = { ...item, epoch: 1, lease: { owner: 'graphyard-codex-1', epoch: 1, expiresAt: '2026-10-11T07:10:00.000Z' } } as Work;
  assert.deepEqual(actionAccount(leased, [gy1685, leased], new Date('2026-10-11T07:00:00.000Z')).wait?.kind, 'session');

  // GY-1727: GY-1724 as master verify-deployment now files it, released at once, is held until the 24-hour
  // live window has run and dispatched by the loop at the instant; master status names the wait and its timestamp.
  const [filed24] = await verifyServing(gy1700, '2026-10-12T07:33:40.939Z');
  const { reason: _why, ...input24 } = filed24;
  const gy1724 = (() => {
    const base = { ...gy1700, ...createSchema.parse(input24), id: 'c0ffee00-0000-4000-8000-000000001724', key: 'GY-1724', stage: 'ready', revision: 3, ready: true, delivery: undefined, submission: null, workspaces: [], lease: null, epoch: 0,
      createdAt: '2026-10-12T07:33:47.000Z', updatedAt: '2026-10-12T07:34:00.000Z', stageEnteredAt: '2026-10-12T07:34:00.000Z', gates: [] } as unknown as Work;
    const evaluated = evaluate(base, [gy1700, base], new Date('2026-10-12T07:36:00.000Z'), [15368]);
    return { ...base, stage: evaluated.stage, gates: evaluated.gates, violations: evaluated.violations, nextAction: null } as Work;
  })();
  const live = '2026-10-13T07:33:40.939Z', pair = [gy1700, gy1724];
  for (const at of ['2026-10-12T07:36:00.000Z', '2026-10-13T07:33:40.938Z']) {
    assert.equal(actionAccount(gy1724, pair, new Date(at)).action, null, `GY-1724 is not dispatched at ${at}`);
    assert.equal(actionAccount(gy1724, pair, new Date(at)).wait?.kind, 'window');
    assert.equal(dispatchable(gy1724, Date.parse(at)), false);
    assert.throws(() => assertDispatchable(gy1724, pair, at), new RegExp(`can first exist at ${live}`));
    const entry = buildMasterStatus({ work: pair, now: at }, [], []).work.find(row => row.key === 'GY-1724')!;
    assert.deepEqual([entry.observationWindow!.waiting, entry.observationWindow!.notBefore, entry.attention], [true, live, null]);
    assert.equal(plainStatus(gy1724, Date.parse(at)).sentence, `Waiting for its observation window — the reading it owes can first exist at ${live}`);
  }
  // GY-1762: past the instant the reading is owed to the loop; the item is escalated for it, never dispatched.
  for (const at of [live, '2026-10-13T08:00:00.000Z']) {
    assert.equal(actionAccount(gy1724, pair, new Date(at)).action?.kind, 'escalate', `GY-1724's reading is owed at ${at}`);
    const queued = { ...gy1724, actionQueue: { actions: [], history: [] } } as Work;
    assert.ok(reconcileActions(queued, [gy1700, queued], new Date(at)).every(entry => entry.action.kind !== 'dispatch'));
    assert.throws(() => assertDispatchable(gy1724, pair, at), /Dispatch waits for the loop's observation/);
  }
});

// GY-1732: on 2026-10-12 the coordinator checkout was at 98070f3538, which predates GY-1698's windows,
// while the serving release ba607f8a809e carried them; verify-deployment isolated that release only to
// emit its instructions and filed GY-1721..GY-1725 with the coordinator's own code — with no window, so
// each dispatched minutes after deploy. Each follow-up is now filed by the observed release's own filer,
// or deferred when that cannot run; and an hour-denominated window is read like a day-denominated one.
const managed = { repository: 'owner/project' as const };
/** The coordinator's own filer as 98070f3538 had it: no observation window on any follow-up. */
const staleFiler = async (input: any) => {
  const { localPostDeployChecks } = await modules();
  return (await localPostDeployChecks(input)).map(check => check.followUp ? { ...check, followUp: { ...check.followUp, input: (({ observationWindow: _w, ...rest }) => ({ ...rest, description: rest.description.replace(/\n\nObservation window: [^\n]*/, '') }))(check.followUp.input) } } : check);
};
const loopInstructions = (text => ({ guide: text, init: text }))('Keep cycling; deployment verification is a step of the cycle, against the exact deployed release. Stop only at a genuinely external blocker recorded in Graphyard. Ordinary review findings, rework, idle workers, and proof setup are not stopping conditions. Close finished agent sessions.');
/** master verify-deployment of `item` with the coordinator checkout at 98070f3538 and the release ba607f8a809e observed serving at `at`. */
const verifyBehind = async (item: Work, at: string, isolate: ((sha: string) => Promise<any>) | undefined, extra: { all?: Work[]; checkout?: string; checks?: (input: any) => Promise<any> } = {}) => {
  const { verifyDeployment } = await modules();
  const now = Date.parse(at) + 2_000, filed: { input: any; requestId: string }[] = [], recorded: unknown[] = [];
  const verified = await verifyDeployment(item, {
    snapshot: async () => ({ work: extra.all ?? [item], now: iso(now) }),
    observe: async () => ({ source: 'endpoint' as const, sha: serving, at, reason: null, deployed: [item.key], pending: [] }),
    release: () => ({ sha: '98070f3538'.padEnd(40, '0'), clean: true, repository: extra.checkout ?? managed.repository, reason: null }),
    emit: async () => assert.fail('the coordinator checkout behind the release emits nothing'), ...managed, now: () => now,
    checks: extra.checks ?? (async () => assert.fail('the coordinator checkout behind the release files nothing')),
    record: async (_work, data) => { recorded.push(data); }, releaseWork: async () => {}, file: async (input: any, requestId: string) => { filed.push({ input, requestId }); return { key: `GY-${1720 + filed.length}` }; },
    patterns: async () => ({ since: null, projected: '2026-10-15T10:32:39.000Z' }), isolate,
  });
  return { verified, filed, recorded };
};
/** The served release's isolated checkout, whose filer is the current code; `log` records the order of its uses. */
const releaseAt = (log: string[], checks: ((input: any) => Promise<any>) | null = async input => (await modules()).localPostDeployChecks(input)) => async (sha: string) => ({
  release: { sha, clean: true, ...managed, reason: null }, emit: async () => { log.push('emit'); return loopInstructions; },
  ...(checks ? { checks: async (input: any) => { log.push(`checks ${input.release.slice(0, 12)} ${input.servedAt}`); return checks(input); } } : {}),
  dispose: async () => { log.push('dispose'); },
});

test('unit:criterion-window-hours — an hour-denominated window is read like a day-denominated one: "over 24 hours" and "within 24 hours" give notBefore 24 hours after the merge, or after the release was first observed serving', async () => {
  const { criterionWindowDays, criterionWindowHours, observationWindowFor } = await modules();
  for (const text of ['zero failed deliveries over 24 hours', 'the row clears within 24 hours', 'a 24-hour window', 'during 24h of activity', 'over 24 hrs of activity', 'across 24hours'])
    assert.equal(criterionWindowHours(text), 24, text);
  assert.equal(criterionWindowHours('over 6 hours, then within 24 hours'), 24, 'the longest named window is the reading\'s');
  assert.equal(criterionWindowHours('per 7 days'), null);
  assert.equal(criterionWindowHours('the 3 hosts report healthy'), null);
  const merged = gy1700.delivery!.mergedAt, mergedMs24 = Date.parse(merged) + day;
  for (const text of ['Zero failed webhook deliveries over 24 hours', 'The attention row clears within 24 hours']) {
    const hours = observationWindowFor(gy1700, { id: 'AC-2', text }, 'manual:post-deploy/x', undefined)!;
    const days = observationWindowFor(gy1700, { id: 'AC-2', text: text.replace('24 hours', '1 day') }, 'manual:post-deploy/x', undefined)!;
    assert.equal(criterionWindowDays(text.replace('24 hours', '1 day')), 1);
    assert.deepEqual([hours.notBefore, hours.basis], [iso(mergedMs24), 'criterion-window'], `${text}: merge plus 24 hours`);
    assert.equal(hours.notBefore, days.notBefore, `${text}: the same instant as the one-day window`);
    const servedAt = Date.parse('2026-10-12T07:33:40.939Z');
    assert.equal(observationWindowFor(gy1700, { id: 'AC-2', text }, 'manual:post-deploy/x', undefined, servedAt)!.notBefore, iso(servedAt + day), `${text}: first observed serving plus 24 hours`);
  }
});

test('unit:post-deploy-filing-at-release-identity — with the coordinator checkout behind the observed release, every owed follow-up is filed by that release\'s own filer in its isolated checkout and carries its observation window', async () => {
  const { postDeployFollowUpId } = await modules();
  // The coordinator's own filer really is window-less: what filed GY-1721..GY-1725.
  const stale = await staleFiler({ work: gy1700, release: serving, now: '2026-10-12T07:33:42.939Z', projections: {}, servedAt: '2026-10-12T07:33:40.939Z' });
  assert.deepEqual(stale.map((check: any) => check.followUp.input.observationWindow), [undefined, undefined]);
  for (const [item, at, instants] of [[gy1700, '2026-10-12T07:33:40.939Z', ['2026-10-13T07:33:40.939Z', '2026-10-13T07:33:40.939Z']], [gy1684, '2026-10-12T07:32:35.697Z', ['2026-10-18T07:43:36.000Z']]] as const) {
    const log: string[] = [];
    const { verified, filed, recorded } = await verifyBehind(item, at, releaseAt(log));
    assert.equal(verified.result, 'verified', verified.refusals.join('; '));
    assert.deepEqual(verified.emittedFrom, { sha: serving, clean: true, isolated: true });
    assert.deepEqual(log, ['emit', `checks ${serving.slice(0, 12)} ${at}`, 'dispose'], 'the release\'s checkout emits, then files, and is disposed after filing');
    assert.deepEqual(filed.map(entry => entry.input.observationWindow?.notBefore), instants, `${item.key}: each follow-up carries the release's window`);
    for (const entry of filed) assert.match(entry.input.description, /\n\nObservation window: the reading can first exist at /);
    assert.deepEqual(filed.map(entry => entry.requestId), item.criteria.filter(criterion => criterion.proofs.some(proof => proof.startsWith('manual:post-deploy/'))).map(criterion => postDeployFollowUpId(item, criterion.id, criterion.proofs[0], serving)));
    assert.deepEqual(verified.postDeploy.map(check => [check.result, check.followUp, check.deferred]), filed.map((_entry, index) => ['owed', `GY-${1721 + index}`, undefined]));
    assert.equal(recorded.length, 1, 'the observation is recorded once its follow-ups are filed');
  }
  // A launcher checkout of another repository has no commit comparable to the release, and the release carries no
  // Graphyard filer (its commit is never in the launcher's store): the coordinator's code files, and nothing is isolated,
  // so a cross-repository deployment owing a follow-up is recorded rather than deferred on every retry.
  const at = '2026-10-12T07:33:40.939Z', other = { checkout: 'owner/graphyard' };
  const crossed = await verifyBehind(gy1700, at, async () => assert.fail('nothing is isolated for another repository'), { ...other, checks: (await modules()).localPostDeployChecks });
  assert.equal(crossed.verified.result, 'verified', crossed.verified.refusals.join('; '));
  assert.equal(crossed.verified.emittedFrom, null, 'a checkout of another repository emits nothing');
  assert.deepEqual(crossed.filed.map(entry => entry.input.observationWindow?.notBefore), ['2026-10-13T07:33:40.939Z', '2026-10-13T07:33:40.939Z']);
  assert.equal(crossed.recorded.length, 1);
  // With nothing owed to file, a checkout of another repository spends no isolated checkout and verifies as before.
  const quiet = delivered({ key: 'GY-1701', criteria: [{ id: 'AC-1', text: 'The change ships', proofs: ['unit:ships'] }] });
  const plain = await verifyBehind(quiet, at, async () => assert.fail('nothing owed, so nothing is isolated'), { ...other, checks: (await modules()).localPostDeployChecks });
  assert.deepEqual([plain.verified.result, plain.verified.postDeploy, plain.recorded.length], ['verified', [], 1]);
});

test('unit:post-deploy-filing-defers-when-release-unavailable — when the release\'s own filer cannot run, nothing is filed window-less: each check is owed with its unchanged request id and a deferral reason, nothing is recorded, and a later attempt files it with its window', async () => {
  const at = '2026-10-12T07:33:40.939Z', expected = ['manual:post-deploy/webhook-deliveries-clean-24h', 'manual:post-deploy/github-budget-attention-row-clears'];
  const { postDeployFollowUpId } = await modules();
  const ids = gy1700.criteria.map(criterion => postDeployFollowUpId(gy1700, criterion.id, criterion.proofs[0], serving));
  const missing = `Deployed release ${serving} is missing from the coordinator checkout; fetch it and verify again`;
  const cases: [string, (sha: string) => Promise<any>, RegExp][] = [
    ['the release commit is missing from the store', async () => ({ reason: missing }), new RegExp(`the observed release ba607f8a809e could not be checked out to file it at its own identity: Deployed release ${serving} is missing`)],
    ['isolation is refused', async sha => ({ reason: `Could not check out deployed release ${sha} in isolation: disk full` }), /could not be checked out to file it at its own identity: Could not check out deployed release .* in isolation: disk full/],
    ['the release predates the filer', releaseAt([], async () => { throw new Error('There is no master post-deploy-checks; use master guide for the subcommands'); }), /the observed release ba607f8a809e's own filer could not run: There is no master post-deploy-checks/],
    ['the checkout carries no filer', releaseAt([], null), /own filer could not run: the isolated release checkout carries no post-deploy filer/],
  ];
  for (const [label, isolate, reason] of cases) {
    const { verified, filed, recorded } = await verifyBehind(gy1700, at, isolate);
    assert.equal(verified.result, 'refused', label);
    assert.deepEqual([filed, recorded], [[], []], `${label}: nothing is filed and nothing is recorded`);
    assert.deepEqual(verified.postDeploy.map(check => [check.proof, check.result, check.followUp, check.requestId]), expected.map((proof, index) => [proof, 'owed', null, ids[index]]), `${label}: owed, unfiled, under the request id the release files it by`);
    for (const check of verified.postDeploy) assert.match(check.deferred!, reason, label);
    if (!/missing|refused/.test(label)) assert.deepEqual(verified.refusals, verified.postDeploy.map(check => `${check.criterion} (${check.proof}) owes its post-deploy follow-up ${check.requestId}, whose filing is deferred: ${check.deferred}`));
  }
  // The later attempt that can run the release's filer files each follow-up with its window, under the same request id.
  const { verified, filed, recorded } = await verifyBehind(gy1700, '2026-10-12T07:43:40.939Z', releaseAt([]));
  assert.equal(verified.result, 'verified', verified.refusals.join('; '));
  assert.deepEqual(filed.map(entry => [entry.requestId, entry.input.observationWindow.notBefore]), ids.map(id => [id, '2026-10-13T07:43:40.939Z']));
  assert.equal(recorded.length, 1);
  // One already filed under its request id is named, never deferred, even where the filer cannot run.
  const { verified: named } = await verifyBehind(gy1700, at, async () => ({ reason: missing }), { all: [gy1700, { ...gy1700, key: 'GY-1724', description: `Post-deploy follow-up: ${ids[0]}\n\n…` } as Work] });
  assert.deepEqual(named.postDeploy.map(check => [check.followUp, !!check.deferred]), [['GY-1724', false], [null, true]]);
  // A release filer that throws where this checkout's code sees nothing owed still records nothing: the release may owe what this code cannot recognise.
  const quiet = delivered({ key: 'GY-1701', criteria: [{ id: 'AC-1', text: 'The change ships', proofs: ['unit:ships'] }] });
  for (const isolate of [releaseAt([], async () => { throw new Error('spawn ENOMEM'); }), releaseAt([], null)]) {
    const thrown = await verifyBehind(quiet, at, isolate);
    assert.deepEqual([thrown.verified.result, thrown.filed, thrown.recorded], ['refused', [], []]);
    assert.match(thrown.verified.refusals.join('; '), /^GY-1701: whether the release ba607f8a809e owes post-deploy follow-ups is its own code's to decide, and the observed release ba607f8a809e's own filer could not run: .*; the deployment observation waits for it$/);
  }
});

test('unit:post-deploy-followup-window-or-deferral — with the coordinator checkout behind the serving release, every windowed post-deploy follow-up verify-deployment produces is either filed with an instant no earlier than its reading can exist, or deferred unfiled: never filed window-less', async () => {
  const outcomes: string[] = [];
  for (const [item, at] of [[gy1684, '2026-10-12T07:32:35.697Z'], [gy1700, '2026-10-12T07:33:40.939Z']] as const)
    for (const isolate of [releaseAt([]), async () => ({ reason: 'Deployed release missing' }), releaseAt([], async () => { throw new Error('no filer'); })]) {
      const { verified, filed } = await verifyBehind(item, at, isolate);
      for (const entry of filed) {
        const earliest = item.key === 'GY-1684' ? Date.parse(item.delivery!.mergedAt) + 7 * day : Date.parse(at) + day;
        assert.ok(entry.input.observationWindow && Date.parse(entry.input.observationWindow.notBefore) >= earliest, `${item.key}: ${entry.requestId} is filed with its window: ${JSON.stringify(entry.input.observationWindow)}`);
      }
      for (const check of verified.postDeploy) {
        assert.equal(check.result, 'owed');
        assert.ok(check.followUp ? filed.some(entry => entry.requestId.includes(`:${check.criterion}:${check.proof}:`)) : !!check.deferred && !!check.requestId, `${item.key} ${check.proof}: filed with its window or deferred`);
        outcomes.push(check.deferred ? 'deferred' : 'filed');
      }
    }
  assert.deepEqual(outcomes, ['filed', 'deferred', 'deferred', 'filed', 'filed', 'deferred', 'deferred', 'deferred', 'deferred']);
});

// The loop's executor files through the same seam: its verify-deployment handler, not only master verify-deployment.
/** The executor's verify-deployment of `item` against the release ba607f8a809e observed serving at `at`, through `postDeployFiler`. */
const executorVerify = async (item: Work, at: string, postDeployFiler: ((sha: string) => Promise<any>) | undefined, all: Work[] = [item], config: object = {}, sha = serving) => {
  const { controlPlaneHandlers } = await modules();
  const unusable = async (): Promise<never> => { throw new Error('not reached'); };
  const filed: { input: any; requestId: string }[] = [], recorded: unknown[] = [];
  const handlers = controlPlaneHandlers(() => config as never, {
    snapshot: async () => ({ work: all, now: iso(Date.parse(at) + 2_000) }),
    mutate: async (path: string, body: unknown) => { recorded.push([path, body]); return {}; },
    agents: () => [], workerCredentials: async () => ({}), producerCredentials: async () => ({}), dispatchWorker: unusable, launchReview: unusable, launchProducer: unusable,
    observeDeployment: async () => ({ source: 'endpoint' as const, sha, at, reason: null, deployed: [item.key], pending: [] }) as never,
    releaseWork: async () => {},
    fileWork: async (input: any, requestId: string) => { filed.push({ input, requestId }); return { key: `GY-${1720 + filed.length}` }; },
    now: () => Date.parse(at) + 2_000, ...(postDeployFiler ? { postDeployFiler } : {}),
  });
  const action = { id: 'row-1', work: item.id, key: item.key, kind: 'verify-deployment', inputs: { kind: 'verify-deployment', mergeSha: item.delivery!.mergeSha } } as never;
  const run = handlers['verify-deployment']!(action, { host: 'host-1', executor: 'executor-1' } as never) as unknown as Promise<string>;
  return { run, filed, recorded };
};
/** The served release's filer as `releasePostDeployFiler` hands it over: `log` records its uses and its disposal. */
const filerAt = (log: string[], checks: (input: any) => Promise<any> = async input => (await modules()).localPostDeployChecks(input)) => async (sha: string) => {
  log.push(`materialize ${sha.slice(0, 12)}`);
  return { filer: async (input: any) => { log.push(`checks ${input.servedAt}`); return checks(input); }, dispose: async () => { log.push('dispose'); } };
};

test('unit:post-deploy-filing-at-release-identity — the executor\'s verify-deployment files each owed follow-up with the observed release\'s filer, carrying its window, and the coordinator\'s own commit decides which filer that is', async () => {
  const at = '2026-10-12T07:33:40.939Z', log: string[] = [];
  const { run, filed, recorded } = await executorVerify(gy1700, at, filerAt(log));
  assert.match(await run, /AC-2 owes its post-deploy observation \(GY-1721\), AC-3 owes its post-deploy observation \(GY-1722\)/);
  assert.deepEqual(log, [`materialize ${serving.slice(0, 12)}`, `checks ${at}`, 'dispose']);
  assert.deepEqual(filed.map(entry => entry.input.observationWindow?.notBefore), ['2026-10-13T07:33:40.939Z', '2026-10-13T07:33:40.939Z']);
  for (const entry of filed) assert.match(entry.input.description, /\n\nObservation window: the reading can first exist at /);
  assert.deepEqual(recorded.map(([path]: any) => path), [`work/${gy1700.id}/deployment`], 'recorded once its follow-ups are filed');
  // The release's filer decides what is owed, even where this checkout's code sees nothing: a proof the
  // release recognises and this checkout does not is filed, and without that filer nothing is recorded.
  const quiet = delivered({ key: 'GY-1701', criteria: [{ id: 'AC-1', text: 'The change ships', proofs: ['unit:ships'] }] });
  const plainLog: string[] = [];
  const plain = await executorVerify(quiet, at, filerAt(plainLog));
  assert.match(await plain.run, /observed the release serving ba607f8a809e for GY-1701$/);
  assert.deepEqual(plainLog, [`materialize ${serving.slice(0, 12)}`, `checks ${at}`, 'dispose'], 'the release\'s filer is asked though this checkout sees nothing owed');
  const recognised = { criterion: 'AC-1', proof: 'unit:ships', result: 'owed', followUp: { title: 'Observe GY-1701 AC-1', requestId: `post-deploy:${quiet.id}:AC-1:unit:ships:${serving}`, input: { title: 'Observe GY-1701 AC-1', description: 'd', type: 'chore', priority: 2, dependencies: [], criteria: [], reason: 'r', observationWindow: { notBefore: '2026-10-13T07:33:40.939Z' } } } };
  const newer = await executorVerify(quiet, at, filerAt([], async () => [recognised]));
  assert.match(await newer.run, /AC-1 owes its post-deploy observation \(GY-1721\)/);
  assert.deepEqual([newer.filed.map(entry => entry.requestId), newer.recorded.length], [[recognised.followUp.requestId], 1], 'filed by the release\'s own recognition, then recorded');
  const unavailable = await executorVerify(quiet, at, async () => ({ reason: 'the observed release ba607f8a809e could not be checked out to file it at its own identity: Deployed release missing' }));
  assert.match(await unavailable.run.then(() => assert.fail('the action fails'), (failure: Error) => failure.message), /GY-1701: whether the release ba607f8a809e owes post-deploy follow-ups is its own code's to decide, and the observed release ba607f8a809e could not be checked out .*; the deployment observation waits for it$/);
  assert.deepEqual([unavailable.filed, unavailable.recorded], [[], []], 'nothing is recorded without the release\'s filer');

  // The default selection, over the executor's config: its checkout's own code only at the release's commit, or of
  // another repository; otherwise the release's isolated checkout, or the reason it cannot be had.
  const { releasePostDeployFiler, localPostDeployChecks } = await modules();
  const master = { cliPath: '/coordinator/bin/graphyard.mjs', repository: 'owner/project' } as never;
  const checkout = (sha: string, origin = 'git@github.com:owner/project.git') => (_command: string, args: string[]) => args.includes('rev-parse') ? `${sha}\n` : args.includes('get-url') ? `${origin}\n` : '';
  const isolated = { release: {}, emit: async () => ({}), checks: async () => [], dispose: async () => {} } as never;
  const refuse = async () => assert.fail('nothing is isolated');
  assert.equal(((await releasePostDeployFiler(master, serving, checkout(serving), refuse)) as any).filer, localPostDeployChecks, 'at the release\'s commit its own code is the release\'s');
  assert.equal(((await releasePostDeployFiler(master, serving, checkout('9'.repeat(40), 'git@github.com:owner/graphyard.git'), refuse)) as any).filer, localPostDeployChecks, 'another repository\'s release carries no Graphyard filer');
  const asked: string[] = [];
  const materialized = await releasePostDeployFiler(master, serving, checkout('98070f3538'.padEnd(40, '0')), async (_config, sha) => { asked.push(sha); return isolated; }) as any;
  assert.deepEqual([asked, materialized.filer === (isolated as any).checks], [[serving], true], 'behind the release, its isolated checkout files');
  assert.deepEqual(await releasePostDeployFiler(master, serving, checkout('98070f3538'.padEnd(40, '0')), async () => ({ reason: 'Deployed release missing' })), { reason: 'the observed release ba607f8a809e could not be checked out to file it at its own identity: Deployed release missing' });
});

test('unit:post-deploy-filing-defers-when-release-unavailable — the executor\'s verify-deployment files nothing window-less when the release\'s filer cannot be had or run: the action fails naming each deferred request id, nothing is recorded, and the retry files it with its window', async () => {
  const at = '2026-10-12T07:33:40.939Z', { postDeployFollowUpId } = await modules();
  const ids = gy1700.criteria.map(criterion => postDeployFollowUpId(gy1700, criterion.id, criterion.proofs[0], serving));
  for (const [label, filer, reason] of [
    ['the release commit is missing', async () => ({ reason: `the observed release ba607f8a809e could not be checked out to file it at its own identity: Deployed release ${serving} is missing from the coordinator checkout` }), /could not be checked out to file it at its own identity: Deployed release .* is missing/],
    ['the release predates the filer', filerAt([], async () => { throw new Error('There is no master post-deploy-checks'); }), /the observed release ba607f8a809e's own filer could not run: There is no master post-deploy-checks/],
  ] as const) {
    const { run, filed, recorded } = await executorVerify(gy1700, at, filer);
    const error = await run.then(() => assert.fail(`${label}: the action fails`), (failure: Error) => failure.message);
    for (const id of ids) assert.ok(error.includes(`owes its post-deploy follow-up ${id}, whose filing is deferred: `), `${label}: ${error}`);
    assert.match(error, reason);
    assert.match(error, /the deployment observation waits for it$/);
    assert.deepEqual([filed, recorded], [[], []], `${label}: nothing is filed and nothing is recorded`);
  }
  // A release filer that throws where this checkout's code sees nothing owed fails the action rather than recording the deployment.
  const quiet = delivered({ key: 'GY-1701', criteria: [{ id: 'AC-1', text: 'The change ships', proofs: ['unit:ships'] }] });
  const thrown = await executorVerify(quiet, at, filerAt([], async () => { throw new Error('spawn ENOMEM'); }));
  assert.match(await thrown.run.then(() => assert.fail('the action fails'), (failure: Error) => failure.message), /^GY-1701: whether the release ba607f8a809e owes post-deploy follow-ups is its own code's to decide, and the observed release ba607f8a809e's own filer could not run: spawn ENOMEM; the deployment observation waits for it$/);
  assert.deepEqual([thrown.filed, thrown.recorded], [[], []], 'nothing is recorded when the release\'s filer throws');
  // The retry that can run the release's filer files each follow-up with its window, under the same request id.
  const retried = await executorVerify(gy1700, '2026-10-12T07:43:40.939Z', filerAt([]));
  await retried.run;
  assert.deepEqual(retried.filed.map(entry => [entry.requestId, entry.input.observationWindow.notBefore]), ids.map(id => [id, '2026-10-13T07:43:40.939Z']));
  assert.equal(retried.recorded.length, 1);
});

// The integration halves: a real coordinator checkout and a real release, its CLI run in the isolated checkout verify-deployment materializes.
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const nodeModules = fileURLToPath(import.meta.resolve('tsx')).replace(/\/node_modules\/.*$/, '/node_modules');
/** A clone of this repository's HEAD with its dependencies linked: a coordinator checkout. */
async function cloneCheckout(directory: string, name: string) {
  const checkout = join(directory, name);
  execFileSync('git', ['clone', '-q', '--shared', '--no-hardlinks', repositoryRoot, checkout]);
  await symlink(nodeModules, join(checkout, 'node_modules'), 'dir');
  const git = (...args: string[]) => execFileSync('git', ['-C', checkout, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return { checkout, cliPath: join(checkout, 'bin/graphyard.mjs'), git, sha: git('rev-parse', 'HEAD') };
}
/** The fixed now of the real-effects cases, which stub Date at it: the observation, the snapshot and the parent's merge an hour before it. */
const liveNow = '2026-10-12T08:00:00.000Z';
/** verify-deployment through the real effects, the deployment observation and the control plane's writes stubbed. */
async function verifyReal(coordinator: { checkout: string; cliPath: string }, item: Work, served: string) {
  const { masterConfigSchema } = await import('../src/master.js');
  const { releaseChecks, verificationEffects, verifyDeployment } = await modules();
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/private/master.token', cliPath: coordinator.cliPath, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'coordinator-host', masterAgentName: 'graphyard-master-project', run: { deploymentUrl: 'https://graphyard.example/healthz', deploymentShaField: 'commit' } });
  const at = liveNow, filed: { input: any; requestId: string }[] = [], recorded: unknown[] = [];
  const effects = verificationEffects(master, { root: coordinator.checkout, snapshot: async () => ({ work: [item], now: liveNow }), mutate: async (_path, data) => { recorded.push(data); return data; },
    file: async (input: any, requestId: string) => { filed.push({ input, requestId }); return { key: `GY-${1720 + filed.length}` }; } });
  effects.releaseWork = async () => {};
  // The coordinator's own filer is its checkout's CLI: the stale code, were it ever asked.
  const own = releaseChecks(coordinator.cliPath);
  let ownAsked = 0;
  const verified = await verifyDeployment(item, { ...effects, observe: async () => ({ source: 'endpoint' as const, sha: served, at, reason: null, deployed: [item.key], pending: [] }), checks: async input => { ownAsked++; return own(input); } });
  return { verified, filed, recorded, ownAsked, own, at, master };
}
const liveCriterion = { id: 'AC-2', text: 'Zero failed webhook deliveries over 24 hours of live activity on the serving release', proofs: ['manual:post-deploy/webhook-deliveries-clean-24h'] };
const windowedParent = (served: string) => delivered({ id: 'e03bc94f-82f4-481d-a443-4b4e6abe9eb6', key: 'GY-1700', criteria: [liveCriterion],
  delivery: { mergeSha: served, mergedAt: iso(Date.parse(liveNow) - 3_600_000), evidenceAsOf: iso(Date.parse(liveNow) - 3_600_000), authorizationRevision: 1 } as never });

test('integration:stale-coordinator-files-windowed-followup — a coordinator checkout whose filer predates observation windows, at another commit than the served release, files the follow-up through the served release\'s own CLI in an isolated checkout, with its window', { timeout: 300_000 }, async () => {
  const directory = await temporaryDirectory('stale-coordinator');
  mock.timers.enable({ apis: ['Date'], now: Date.parse(liveNow) });
  try {
    const coordinator = await cloneCheckout(directory, 'coordinator'), served = coordinator.sha;
    // The coordinator moves to code that files no window, as 98070f3538's did; the served release is the commit it left.
    const source = join(coordinator.checkout, 'src/master-verification.ts'), code = await readFile(source, 'utf8');
    const windowed = 'const observationWindow = observationWindowFor(work, criterion, proof, projections[proof], served);';
    assert.ok(code.includes(windowed), 'the filer computes the window');
    await writeFile(source, code.replace(windowed, 'const observationWindow = undefined;'));
    coordinator.git('commit', '-q', '-am', 'a coordinator filer from before observation windows');
    const stale = coordinator.git('rev-parse', 'HEAD');
    const item = windowedParent(served);
    const { verified, filed, recorded, ownAsked, own, at, master } = await verifyReal(coordinator, item, served);
    assert.equal(verified.result, 'verified', verified.refusals.join('; '));
    assert.deepEqual([verified.checkout.sha, verified.emittedFrom], [stale, { sha: served, clean: true, isolated: true }]);
    assert.equal(ownAsked, 0, 'the coordinator\'s own filer is never asked');
    assert.equal(filed.length, 1);
    assert.deepEqual([filed[0].input.observationWindow.notBefore, filed[0].input.observationWindow.basis], [new Date(Date.parse(at) + day).toISOString(), 'criterion-window']);
    assert.match(filed[0].input.description, /\n\nObservation window: the reading can first exist at .* names a 24-hour live window/);
    assert.equal(recorded.length, 1);
    // The coordinator's own CLI would have filed it window-less: that is the filing that no longer happens.
    const [staleCheck] = await own({ work: item, release: served, now: at, projections: {}, servedAt: at });
    assert.equal(staleCheck.followUp!.input.observationWindow, undefined);
    assert.equal(staleCheck.followUp!.requestId, filed[0].requestId, 'the same follow-up, by its identity');
    // The loop's executor, over the same config and its default filer, files it through the served release's CLI too.
    const executor = await executorVerify(item, at, undefined, [item], master, served);
    await executor.run;
    assert.deepEqual(executor.filed.map(entry => [entry.requestId, entry.input.observationWindow?.notBefore]), [[filed[0].requestId, new Date(Date.parse(at) + day).toISOString()]]);
    assert.equal(executor.recorded.length, 1);
  } finally { mock.timers.reset(); await rm(directory, { recursive: true, force: true }); }
});

test('integration:deferred-post-deploy-filing-retries-windowed — a served release missing from the coordinator\'s store defers the follow-up (owed, unfiled, unrecorded, request id kept); once the commit is fetched the retry files it with its window', { timeout: 300_000 }, async () => {
  const directory = await temporaryDirectory('deferred-filing');
  mock.timers.enable({ apis: ['Date'], now: Date.parse(liveNow) });
  try {
    const coordinator = await cloneCheckout(directory, 'coordinator'), upstream = await cloneCheckout(directory, 'upstream');
    // Production serves a commit the coordinator has not fetched.
    upstream.git('commit', '-q', '--allow-empty', '-m', 'the served release');
    const served = upstream.git('rev-parse', 'HEAD'), item = windowedParent(served);
    const { postDeployFollowUpId } = await modules();
    const requestId = postDeployFollowUpId(item, 'AC-2', liveCriterion.proofs[0], served);
    const deferred = await verifyReal(coordinator, item, served);
    assert.equal(deferred.verified.result, 'refused');
    assert.deepEqual([deferred.filed, deferred.recorded, deferred.ownAsked], [[], [], 0], 'nothing is filed, recorded, or decided by the coordinator\'s code');
    assert.deepEqual(deferred.verified.postDeploy.map(check => [check.result, check.followUp, check.requestId]), [['owed', null, requestId]]);
    assert.match(deferred.verified.postDeploy[0].deferred!, new RegExp(`could not be checked out to file it at its own identity: Deployed release ${served} is missing from the coordinator checkout`));
    coordinator.git('fetch', '-q', upstream.checkout, 'HEAD');
    const retried = await verifyReal(coordinator, item, served);
    assert.equal(retried.verified.result, 'verified', retried.verified.refusals.join('; '));
    assert.deepEqual(retried.filed.map(entry => [entry.requestId, entry.input.observationWindow.notBefore]), [[requestId, new Date(Date.parse(retried.at) + day).toISOString()]]);
    assert.deepEqual([retried.ownAsked, retried.recorded.length], [0, 1]);
  } finally { mock.timers.reset(); await rm(directory, { recursive: true, force: true }); }
});
