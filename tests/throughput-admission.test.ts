import assert from 'node:assert/strict';
import test from 'node:test';
import { actionIdleMs, type ActionRow } from '../src/model/actions.js';
import type { Work } from '../src/model.js';
import { deliveryRecord, exclusionClass, populationRule, throughputClaim, throughputStall, throughputStallBound, verifyThroughput } from '../src/throughput.js';

// GY-1455: the measurement applies the admission rule the approvers settled (GY-1449 revision
// 48a9e55a, GY-1454 AC-1), built here from plain documents so every shape is visible at a glance.
const minute = 60_000;
const base = Date.parse('2026-10-07T12:00:00.000Z');
const at = (minutes: number) => new Date(base + minutes * minute).toISOString();
const now = base + 120 * minute;
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const controlPlaneKinds = ['escalate', 'request-rework', 'resync', 'request-review', 'dispatch', 'approve-scope', 'reclaim', 'merge'];

function row(kind: string, history: ActionRow['history']): ActionRow {
  return { id: `${kind}-${history.length}-${history[0]!.at}`, kind, work: 'w', key: 'GY-1', inputs: { kind }, gate: 'build', refusal: null, reason: '', binding: `${kind}:0`,
    requestedBy: 'graphyard', requestedAt: history[0]!.at, state: 'done', claim: null, attempts: 1, resolvedAt: history.at(-1)!.at, result: 'done', resolution: 'settled', history } as unknown as ActionRow;
}
const executed = (kind: string, from: number) => row(kind, [
  { at: at(from), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: '' },
  { at: at(from + 1), event: 'claimed', requester: 'graphyard', executor: 'executor-a', result: null, reason: 'attempt 1 claimed by executor-a on host-a' },
  { at: at(from + 2), event: 'completed', requester: 'graphyard', executor: 'executor-a', result: 'done', reason: '' },
]);
const superseded = (kind: string, from: number) => row(kind, [
  { at: at(from), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: '' },
  { at: at(from + 1), event: 'cancelled', requester: 'graphyard', executor: null, result: null, reason: 'now needs another action' },
]);
const session = (id: string, role: string | null) => ({ id, kind: 'coordination', role, principal: id, epoch: null, runtime: 'claude', host: 'host-m', workspace: null, tab: null, pane: null,
  agentName: null, head: null, attach: null, transcript: null, startedAt: at(5) });

function delivery(key: string, shape: { history?: ActionRow[]; sessions?: unknown[]; blocked?: number; requirements?: number; reworkRounds?: number } = {}): Work {
  return {
    id: key.toLowerCase(), key, title: `Delivery ${key}`, stage: 'done', policy: { checks: [], review: true }, implementers: ['worker-1'], workspaces: [], sessions: shape.sessions ?? [],
    submission: { pr: Number(key.split('-')[1]) }, candidate: null, updatedAt: at(40),
    delivery: { mergeSha: sha('a'), mergedAt: at(30) },
    pipeline: { attempts: [{ epoch: 1, owner: 'worker-1', claimedAt: at(0), endedAt: at(10), end: 'submitted' }], submittedAt: at(10), reworkRounds: shape.reworkRounds ?? 0,
      interventions: { blocked: shape.blocked ?? 0, requirements: shape.requirements ?? 0 }, backfill: null },
    actionQueue: { actions: [], history: shape.history ?? [executed('request-review', 11)] },
  } as unknown as Work;
}

/** One delivery of each shape AC-1 names, with whether it is admitted and the exclusion classes it carries. */
function shapes() {
  return {
    plain: delivery('GY-1'),
    supersededControlPlane: delivery('GY-2', { history: [executed('request-review', 11), ...controlPlaneKinds.map((kind, index) => superseded(kind, 12 + index))] }),
    approverSession: delivery('GY-3', { sessions: [session('approver:GY-3', 'approver')] }),
    masterSession: delivery('GY-4', { sessions: [session('master-1', 'master')] }),
    operatorSession: delivery('GY-5', { sessions: [session('operator-1', 'operator')] }),
    rolelessSession: delivery('GY-6', { sessions: [session('coordinator-1', null)] }),
    blocked: delivery('GY-7', { blocked: 1 }),
    requirements: delivery('GY-8', { requirements: 1 }),
    reworked: delivery('GY-9', { reworkRounds: 2 }),
    unexecuted: delivery('GY-10', { history: [superseded('dispatch', 11)] }),
  };
}

test('unit:throughput-admission-rule — control-plane actions superseded before any executor ran them and approver sessions admit a delivery; master, operator or role-less sessions, blocked reports, requirements revisions, extra rework rounds and no executed action still exclude it, each with its reason; the GY-87 budgets are unchanged', () => {
  const records = Object.fromEntries(Object.entries(shapes()).map(([name, work]) => [name, deliveryRecord(work, now)]));
  const classes = (name: string) => records[name]!.exclusions.map(entry => exclusionClass(entry).reason);

  for (const name of ['plain', 'supersededControlPlane', 'approverSession']) {
    assert.equal(records[name]!.admitted, true, `${name} is admitted: ${records[name]!.exclusions.join('; ')}`);
    assert.deepEqual(records[name]!.exclusions, []);
  }
  assert.equal(records.supersededControlPlane!.actions.filter(action => action.supersededUnexecuted).length, controlPlaneKinds.length, 'every control-plane kind really was superseded unexecuted');

  const session = 'a coordination session other than an approver\'s was recorded on it';
  assert.deepEqual(classes('masterSession'), [session]);
  assert.match(records.masterSession!.exclusions[0]!, /^a master coordination session \(master-1 on host-m\) was recorded on it$/);
  assert.deepEqual(classes('operatorSession'), [session]);
  assert.match(records.operatorSession!.exclusions[0]!, /^an operator coordination session \(operator-1 on host-m\) was recorded on it$/);
  assert.deepEqual(classes('rolelessSession'), [session]);
  assert.match(records.rolelessSession!.exclusions[0]!, /\(coordinator-1 on host-m, no role recorded\)/);
  assert.deepEqual(classes('blocked'), ['a blocked report handed it to a master or operator to clear']);
  assert.deepEqual(classes('requirements'), ['a requirements revision was applied to it while it was under way']);
  assert.deepEqual(classes('reworked'), ['it took N rework rounds, so it is not one of the routine deliveries the claim is stated over']);
  assert.deepEqual(classes('unexecuted'), ['no executor completed an action on it, so it is no evidence about an executor-driven pipeline']);
  for (const name of ['masterSession', 'operatorSession', 'rolelessSession', 'blocked', 'requirements', 'reworked', 'unexecuted']) assert.equal(records[name]!.admitted, false, name);

  // The budgets are GY-87's own and this change leaves them exactly as stated.
  assert.equal(throughputClaim.submitToMergeP50Ms, 30 * minute);
  assert.equal(throughputClaim.idleActionableMs, actionIdleMs);
  assert.equal(actionIdleMs, 5 * minute);
  assert.equal(throughputClaim.minimumDeliveries, 10);
});

test('unit:throughput-rule-stated — populationRule names every exclusion class the measurement can emit, states that superseded control-plane actions and approver sessions do not exclude, and no superseded-action class is emitted as a coordinator fingerprint', () => {
  // Where each emittable class is named as an exclusion in the rule. A new class the measurement
  // emits without a line here fails below, so the rule cannot drift from the code again.
  const named: Record<string, string> = {
    'the item is not delivered': 'merged pull request of this repository (delivered',
    'its delivery records no merge commit': 'a merge commit',
    'no pull request number is recorded for it': 'a pull request number',
    'its key gy-N is not a work-item key of this repository': 'a work-item key',
    'no worker ever held it, so nothing implemented it': 'a worker that held it',
    'its timeline records no submission': 'a recorded submission',
    'it took N rework rounds, so it is not one of the routine deliveries the claim is stated over': 'at most one rework round',
    'no executor completed an action on it, so it is no evidence about an executor-driven pipeline': 'at least one action an executor claimed and completed',
    'a coordination session other than an approver\'s was recorded on it': 'excluded for a coordination session whose role is master, operator or anything but approver (or that records no role)',
    'a blocked report handed it to a master or operator to clear': 'a blocked report',
    'a requirements revision was applied to it while it was under way': 'a requirements revision applied while it was under way',
  };
  const unreal = { ...delivery('GY-11', { history: [] }), stage: 'build', delivery: null, submission: null, key: 'gy-11', implementers: [], pipeline: null } as unknown as Work;
  const missingCommit = { ...delivery('GY-12'), delivery: { mergeSha: 'pending', mergedAt: at(30) } } as unknown as Work;
  const emitted = new Map<string, boolean>();
  for (const work of [...Object.values(shapes()), unreal, missingCommit])
    for (const entry of deliveryRecord(work, now).exclusions) { const kind = exclusionClass(entry); emitted.set(kind.reason, kind.coordinator); }

  assert.deepEqual([...emitted.keys()].sort(), Object.keys(named).sort(), 'every class the measurement emits is listed, and every listed class is emitted');
  for (const [reason, phrase] of Object.entries(named)) assert.ok(populationRule.includes(phrase), `populationRule names "${reason}" as an exclusion (${phrase})`);
  assert.ok(![...emitted.keys()].some(reason => /superseded/.test(reason)), 'no superseded-action class is emitted');
  assert.deepEqual([...emitted].filter(([, coordinator]) => coordinator).map(([reason]) => reason).sort(), [
    'a blocked report handed it to a master or operator to clear',
    'a coordination session other than an approver\'s was recorded on it',
    'a requirements revision was applied to it while it was under way',
  ]);
  // The rule says what does not exclude, in the words of the approved revision.
  assert.match(populationRule, /a control-plane action \(escalate, request-rework, resync, request-review, dispatch, approve-scope, reclaim, merge\) superseded before any executor ran it and an approver session never exclude it/);
  // The admission rule is one sentence; the second says how the window is reported.
  assert.equal(populationRule.split(/(?<=\.) /).length, 2);

  // The needs-decision the loop raises over a window that cannot admit quotes the rule it applied.
  const masters = Array.from({ length: throughputStallBound }, (_, index) => delivery(`GY-${100 + index}`, { sessions: [session(`master-${index}`, 'master')] }));
  const report = verifyThroughput(masters, now, { deployed: { revision: sha('b'), version: '1', origin: 'https://example.invalid', observedAt: at(0), containsClaim: true, reason: null }, since: at(-60) });
  const stall = throughputStall(report)!;
  assert.equal(report.population.rule, populationRule);
  assert.ok(stall.text.includes(populationRule), 'the needs-decision quotes the rule');
});

// GY-1458: the loop re-measures the serving release at most every hour while its attention stands,
// a window the applied rule admits retires the needs-decision, and the attention never re-arms the
// decision the approvers already answered.
const revision = sha('d');
const deployed = { revision, version: '1', origin: 'https://example.invalid', observedAt: at(0), containsClaim: true, reason: null };
const claim = { id: 'claim', key: throughputClaim.item, title: 'The throughput claim', stage: 'done', policy: { checks: [], review: true }, delivery: { mergeSha: sha('c'), mergedAt: at(-120), deployment: { sha: revision, observedAt: at(-60) } } } as unknown as Work;
/** A window past the stall bound whose every delivery the pre-GY-1455 rule excluded and the applied rule admits. */
const admittedWindow = () => Array.from({ length: throughputStallBound }, (_, index) => index % 2
  ? delivery(`GY-${200 + index}`, { sessions: [session(`approver:GY-${200 + index}`, 'approver')] })
  : delivery(`GY-${200 + index}`, { history: [executed('request-review', 11), superseded('dispatch', 12), superseded('merge', 13)] }));
/** A window every delivery of which a master session drove: a stall under any rule. */
const masterWindow = () => Array.from({ length: throughputStallBound }, (_, index) => delivery(`GY-${300 + index}`, { sessions: [session(`master-${index}`, 'master')] }));
/** The measurement the loop recorded before the admitting fix merged: the same window judged under the earlier rule, a stall. */
const preFixRule = 'A delivery is counted when … and is excluded for any coordination session or any superseded control-plane action.';
function preFixMeasurement(measuredAt: number) {
  const report = verifyThroughput([claim, ...masterWindow()], measuredAt, { deployed });
  return { ...report, population: { ...report.population, rule: preFixRule } };
}

test('unit:throughput-remeasure-due — an unverified answer naming its re-measure time is asked in the cycle that finds it due, however far the failure backoff has grown; before it, and for a verified or failed answer, the backoff alone decides', async () => {
  const { throughputAskDue } = await import('../src/daemon/cycle-delivery.js');
  const { throughputRemeasureAt, throughputRemeasureDue, throughputRemeasureFrom, throughputRemeasureMs } = await import('../src/throughput.js');
  const measuredAt = at(0), dueAt = base + throughputRemeasureMs;
  assert.equal(throughputRemeasureMs, 60 * minute, 'the bound the loop promises');
  assert.equal(throughputRemeasureFrom(measuredAt), new Date(dueAt).toISOString());
  const answer = (state: 'waiting' | 'done' | 'failed', detail: string) => ({ kind: 'deployment' as const, work: null, principal: null, state, detail, attempts: 12, epoch: null, cycle: 100, at: measuredAt });
  const current = answer('waiting', `GY-87's throughput is already measured for ${revision.slice(0, 12)} (unverified, f.json); measured again from ${throughputRemeasureFrom(measuredAt)} as deliveries accumulate`);
  const recorded = answer('waiting', `Recorded GY-87's throughput measurement for ${revision.slice(0, 12)} in f.json, reading 20 deliveries whole: unverified: short; measured again from ${throughputRemeasureFrom(measuredAt)} as deliveries accumulate`);
  for (const waiting of [current, recorded]) {
    assert.equal(throughputRemeasureAt(waiting.detail), dueAt);
    // Twelve asks put the backoff at its 30-cycle cap: three cycles later it alone would not ask.
    assert.equal(throughputAskDue(waiting, 103, dueAt - minute), false, 'inside the hour the backoff decides');
    assert.equal(throughputAskDue(waiting, 103, dueAt), true, 'at the hour the re-measure is asked in that cycle');
    assert.equal(throughputAskDue(waiting, 103, dueAt + 20 * minute), true);
    assert.equal(throughputAskDue(waiting, 130, dueAt - minute), true, 'the backoff still asks on its own schedule');
  }
  assert.equal(throughputAskDue(answer('done', 'Re-measured …: verified: holds'), 200, dueAt + 10 * throughputRemeasureMs), false, 'a verified answer is final');
  assert.equal(throughputAskDue(answer('failed', `could not be recorded; measured again from ${throughputRemeasureFrom(measuredAt)}`), 103, dueAt), false, 'a failure waits on its backoff');
  assert.equal(throughputAskDue(answer('waiting', 'The control plane serves abc, not yet measured while the verified deployment is def'), 103, dueAt), false, 'a wait on the plane names no re-measure time');
  assert.equal(throughputAskDue(undefined, 0, base), true, 'a release never asked is asked now');
  assert.equal(throughputRemeasureDue({ verdict: 'unverified', measuredAt }, dueAt), true);
  assert.equal(throughputRemeasureDue({ verdict: 'unverified', measuredAt }, dueAt - 1), false);
});

test('unit:throughput-stall-null-after-admission — once the applied rule admits the window, throughputStall is null; the same window was a stall only under the earlier rule, and a report judged under a rule since revised raises no stall', async () => {
  const { throughputRuleSuperseded } = await import('../src/throughput.js');
  const applied = verifyThroughput([claim, ...admittedWindow()], now, { deployed });
  assert.equal(applied.population.rule, populationRule);
  assert.equal(applied.population.delivered, throughputStallBound);
  assert.equal(applied.population.admitted, throughputStallBound, applied.excluded.map(record => record.exclusions.join('; ')).join(' | '));
  assert.equal(applied.verdict, 'verified', applied.reason);
  assert.equal(throughputStall(applied), null, 'the applied rule admits deliveries: no stall');
  // A window the applied rule still cannot admit is a genuine, undecided stall.
  const masters = verifyThroughput([claim, ...masterWindow()], now, { deployed });
  assert.ok(throughputStall(masters), 'every delivery master-driven: still a stall');
  assert.equal(throughputRuleSuperseded(masters), false);
  // The same figures judged under the earlier rule: the question it asked is answered, so no stall.
  const stale = preFixMeasurement(now);
  assert.equal(throughputRuleSuperseded(stale), true);
  assert.equal(throughputStall(stale), null);
});

test('unit:throughput-attention-remedy-matches-record — the throughput attention never instructs master decide for a population rule already revised, approved and applied; it says none remains and names the re-measure, and only a stall under the applied rule carries the decision', async () => {
  const { throughputClaimVisibility, throughputRemeasureFrom } = await import('../src/throughput.js');
  const serving = { revision, version: '1' }, owner = { key: 'GY-1449' };
  for (const ownerItem of [null, owner]) {
    const stale = preFixMeasurement(now);
    const visible = throughputClaimVisibility({ report: stale, file: 'old.json' }, serving, throughputStallBound, null, ownerItem);
    assert.equal(visible.verdict, 'unverified'); assert.equal(visible.stall, null);
    const attention = visible.attention!;
    assert.doesNotMatch(`${attention.text} ${attention.next}`, /master decide|master approver|needs decision/, 'no refused remedy');
    assert.match(attention.text, /No population-rule decision remains: the newest measurement was judged under a population rule since revised, approved and applied/);
    assert.ok(attention.text.includes(`re-measures the serving release under the applied rule from ${throughputRemeasureFrom(stale.measuredAt)}`));
    assert.equal(attention.role, 'master'); assert.equal(attention.human, false);
  }
  // A stall under the applied rule is a genuinely undecided question: it keeps the typed decision.
  const genuine = verifyThroughput([claim, ...masterWindow()], now, { deployed });
  const decided = throughputClaimVisibility({ report: genuine, file: 'new.json' }, serving, throughputStallBound, null, owner);
  assert.ok(decided.stall);
  assert.match(decided.attention!.next, /graphyard master decide GY-1449 requirements/);
  assert.doesNotMatch(decided.attention!.text, /No population-rule decision remains/);
});

test('integration:throughput-remeasure-cadence — a loop cycle that finds the serving release\'s newest measurement past the hour re-measures it in that cycle under the applied rule, so a window the earlier rule stalled is admitted, the stall is gone and the attention retires', async () => {
  const { writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { temporaryDirectory } = await import('./helpers/temp-dirs.js');
  const { emptyDaemonState, runCycle } = await import('../src/master-daemon.js');
  const { masterConfigSchema } = await import('../src/master.js');
  const { loopThroughputMeasurement, readThroughputMeasurement, recordThroughputMeasurement, throughputClaimVisibility, throughputRemeasureFrom, throughputRemeasureMs } = await import('../src/throughput.js');
  const root = await temporaryDirectory('throughput-cadence');
  try {
    const items = [claim, ...admittedWindow()];
    const takenAt = now - 30 * minute;
    const file = await recordThroughputMeasurement(root, preFixMeasurement(takenAt));
    const token = join(root, 'coordinator.token');
    await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: join(fileURLToPath(new URL('..', import.meta.url)), 'bin/graphyard.mjs'),
      repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], run: { deploymentReuseMinutes: 0 } });
    const state = emptyDaemonState(master);
    state.lock = { id: 'lock', pid: process.pid, host: master.hostId, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() };
    // The loop answered `current` many times since the pre-fix measurement: its backoff is at the 30-cycle cap.
    const key = `throughput:${revision}`;
    state.actions[key] = { kind: 'deployment', work: null, principal: null, state: 'waiting', attempts: 12, cycle: state.cycle, epoch: null, at: new Date(takenAt).toISOString(),
      detail: `${throughputClaim.item}'s throughput is already measured for ${revision.slice(0, 12)} (unverified, ${file}); measured again from ${throughputRemeasureFrom(new Date(takenAt).toISOString())} as deliveries accumulate` } as never;
    let clock = takenAt + throughputRemeasureMs - minute, measured = 0;
    const effects = {
      agents: () => [], credentials: async (profiles: { name: string }[]) => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
      snapshot: async () => ({ work: items, now: new Date(clock).toISOString() }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
      observeDeployment: async () => ({ source: 'endpoint', sha: revision, at: new Date(clock).toISOString(), reason: null, deployed: items.map(item => item.key), pending: [], requests: 0 }),
      recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
      measureThroughput: async (work: Work[], observedSha: string) => { measured++; return loopThroughputMeasurement(root, { work, observedSha, now: () => clock, origin: 'https://example.invalid',
        status: async () => ({ now: new Date(clock).toISOString(), release: { version: '1', revision } }), readItem: async (id: string) => items.find(item => item.id === id)!, contains: async () => true }); },
    } as never;

    // Inside the hour, with the backoff at its cap, the stale record stands and the attention says no decision remains.
    await runCycle(master, state, effects, () => clock);
    assert.equal(measured, 0, 'inside the hour nothing is measured');
    const before = throughputClaimVisibility(await readThroughputMeasurement(root), { revision, version: '1' }, items.length);
    assert.doesNotMatch(before.attention!.next, /master decide/);

    // The cycle that finds it past the hour re-measures in that same cycle, whatever the backoff says.
    clock = takenAt + throughputRemeasureMs + minute;
    await runCycle(master, state, effects, () => clock);
    assert.equal(measured, 1, 'the due re-measure runs in the cycle that finds it due');
    const fresh = (await readThroughputMeasurement(root))!;
    assert.equal(fresh.report.measuredAt, new Date(clock).toISOString(), 'a fresh measurement timestamp');
    assert.equal(fresh.report.population.rule, populationRule, 'judged under the applied rule');
    assert.equal(fresh.report.population.admitted, throughputStallBound, 'the window the earlier rule stalled is admitted');
    assert.equal(throughputStall(fresh.report), null);
    assert.equal(state.actions[key]!.state, 'done'); assert.match(state.actions[key]!.detail, /: verified:/);
    const after = throughputClaimVisibility(fresh, { revision, version: '1' }, items.length);
    assert.equal(after.stall, null);
    assert.equal(after.verdict, 'verified', after.reason);
    assert.equal(after.attention, null, 'the attention retires on its own, with no new requirements decision');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// GY-1587: the idle-actionable budget leaves out only a span no executor could have run, for a cause
// the row itself records — GY-468's request-rework 4ccba8e9, requested after the CI rerun was refused
// for a missing App permission and superseded 5585.6 min later — while a superseded row any executor
// could have run still counts in full.
const appRefusal = 'Required CI check test has not passed on the current candidate; rerun: refused: GitHub POST /repos/cryptob1/graphyard/actions/runs/36272630910/rerun-failed-jobs failed (403): the installed App lacks a permission this request needs; compare its installation at https://github.com/settings/installations/161493384 with graphyard github-setup --update-permissions';
/** A row requested at `from` and superseded `waited` ms later, never claimed; it carries `refusal` as GY-468's row does. */
function supersededAfter(kind: string, from: string, waited: number, refusal: string | null = null, claimed = false): ActionRow {
  const until = new Date(Date.parse(from) + waited).toISOString();
  const history: ActionRow['history'] = [{ at: from, event: 'requested', requester: 'graphyard', executor: null, result: null, reason: refusal ? `GY-468 needs a new head: ${refusal}` : '' }];
  if (claimed) history.push({ at: from, event: 'claimed', requester: 'graphyard', executor: 'executor-a', result: null, reason: 'attempt 1 claimed by executor-a on host-a' });
  history.push({ at: until, event: 'cancelled', requester: 'graphyard', executor: null, result: null, reason: 'GY-468 now needs dispatch instead' });
  return { ...row(kind, history), id: `${kind}-${from}-${refusal ? 'refused' : 'runnable'}${claimed ? '-claimed' : ''}`, inputs: { kind, ...(refusal ? { detail: refusal } : {}) }, refusal, state: 'pending', attempts: claimed ? 1 : 0, result: undefined } as unknown as ActionRow;
}
const gy468Span = Date.parse('2026-10-02T03:17:10.987Z') - Date.parse('2026-09-28T06:11:33.492Z');
const gy468Row = (refusal: string | null = appRefusal) => supersededAfter('request-rework', '2026-09-28T06:11:33.492Z', gy468Span, refusal);
/** A release that began serving before GY-468's row went idle, so its whole span lies inside the window (GY-1595 clips the rest). */
const servedSeptember = '2026-09-28T00:00:00.000Z';
const servingSinceSeptember = { ...claim, delivery: { ...claim.delivery, deployment: { sha: revision, observedAt: servedSeptember } } } as unknown as Work;
// GY-468's 5585.6 min span is longer than the trailing 72-hour window (GY-1596), so the measurements
// judging it whole are given the release's serving start, as `--since` gives it; the loop's own
// re-measure below keeps the default window.
/** Ten plain admitted deliveries and GY-468 carrying `extra` beside its executed review, in the window `release` opens. */
const idleWindow = (extra: ActionRow, release: Work = servingSinceSeptember) => [release, ...Array.from({ length: throughputClaim.minimumDeliveries - 1 }, (_, index) => delivery(`GY-${600 + index}`)),
  delivery('GY-468', { history: [executed('request-review', 11), extra] })];

test('unit:throughput-superseded-row-span — GY-468\'s superseded request-rework, which no executor could run for the App permission its own refusal records, is reported and left out of the idle-actionable budget; a runnable superseded row idle past 5 min, or one an executor claimed, still fails the claim in full; the budgets are unchanged', async () => {
  const { unrunnableCause, renderThroughput, loopThroughputMeasurement, readThroughputMeasurement, recordThroughputMeasurement, throughputRemeasureMs } = await import('../src/throughput.js');
  assert.deepEqual({ p50: throughputClaim.submitToMergeP50Ms, idle: throughputClaim.idleActionableMs, deliveries: throughputClaim.minimumDeliveries }, { p50: 30 * minute, idle: 5 * minute, deliveries: 10 }, 'the budgets are GY-87\'s own');
  assert.equal(Math.round(gy468Span / 6000) / 10, 5585.6, 'the recorded span');

  // GY-468's row: unclaimed, superseded, and its own refusal names the App permission it lacked.
  const refused = gy468Row();
  assert.equal(unrunnableCause(refused), appRefusal);
  const forgiven = verifyThroughput(idleWindow(refused), now, { deployed, since: servedSeptember });
  const gy468 = forgiven.deliveries.find(record => record.key === 'GY-468')!;
  assert.ok(gy468, 'GY-468 stays admitted: the superseded row is the loop machinery of record');
  assert.ok((gy468.idle?.ms ?? 0) <= throughputClaim.idleActionableMs, 'its span is not the delivery\'s idle figure');
  assert.deepEqual(gy468.unrunnableIdle, [{ ms: gy468Span, action: refused.id, kind: 'request-rework', since: '2026-09-28T06:11:33.492Z', cause: appRefusal }], 'the span is reported with the cause its row records');
  assert.equal(forgiven.population.admitted, throughputClaim.minimumDeliveries);
  assert.equal(forgiven.verdict, 'verified', forgiven.reason);
  assert.ok((forgiven.idle.maxMs ?? 0) <= throughputClaim.idleActionableMs);
  assert.match(renderThroughput(forgiven), /not counted: 5585\.6 min on request-rework no executor could run \(Required CI check/);

  // The same row with nothing on it saying why it could not run: anybody could have, nobody did.
  const runnable = gy468Row(null);
  assert.equal(unrunnableCause(runnable), null);
  const counted = verifyThroughput(idleWindow(runnable), now, { deployed, since: servedSeptember });
  assert.equal(counted.verdict, 'unverified');
  assert.equal(counted.idle.maxMs, gy468Span);
  assert.match(counted.reason, /GY-468 left its request-rework actionable and unclaimed for 5585\.6 min, 5580\.6 min past the 5 min bound/);
  // A short runnable superseded row just past the bound fails the claim too.
  const justPast = verifyThroughput(idleWindow(supersededAfter('request-review', at(12), 6 * minute)), now, { deployed, since: servedSeptember });
  assert.equal(justPast.verdict, 'unverified');
  assert.deepEqual(justPast.shortfall!.missed.map(entry => entry.metric), ['idle-actionable']);
  // A refusal on a row an executor claimed proves it was runnable: its wait is not forgiven, and
  // a refusal for anything but a permission (a timeout) is not a cause no executor could clear.
  assert.equal(unrunnableCause(supersededAfter('request-rework', at(12), 6 * minute, appRefusal, true)), null);
  assert.equal(unrunnableCause(supersededAfter('request-rework', at(12), 6 * minute, 'rerun: refused: GitHub POST … failed (502): bad gateway')), null);
  const timedOut = verifyThroughput(idleWindow(supersededAfter('request-rework', at(12), 6 * minute, 'the rerun timed out')), now, { deployed, since: servedSeptember });
  assert.equal(timedOut.verdict, 'unverified');
  // A 401/403 that does not itself establish a missing permission is one a later attempt clears:
  // a secondary rate limit, a rerun of a run still in progress, rejected credentials, or a 403 whose
  // preflight found nothing missing — GitHub's generic "Resource not accessible by integration"
  // included, which names no grant. Its row was runnable, and its wait fails the 5 min budget.
  for (const runnable403 of [
    'rerun: refused: GitHub POST /repos/cryptob1/graphyard/actions/runs/1/rerun-failed-jobs failed (403) "Resource not accessible by integration": the App permission preflight at 2026-09-28T06:00:00.000Z found no missing permission',
    'rerun: refused: GitHub POST /repos/cryptob1/graphyard/actions/runs/1/rerun-failed-jobs failed (403) "Resource not accessible by integration": GitHub gave no reason; no App permission preflight has run yet',
    'rerun: refused: GitHub POST /repos/cryptob1/graphyard/actions/runs/1/rerun-failed-jobs failed (403): secondary rate limit; retry later',
    'rerun: refused: GitHub POST /repos/cryptob1/graphyard/actions/runs/1/rerun-failed-jobs failed (403) "This workflow is already running": the App permission preflight at 2026-09-28T06:00:00.000Z found no missing permission',
    'rerun: refused: GitHub POST /repos/cryptob1/graphyard/actions/runs/1/rerun-failed-jobs failed (401): the App credentials were rejected; check GITHUB_APP_ID, GITHUB_INSTALLATION_ID and the private key',
  ]) {
    const rateLimited = supersededAfter('request-rework', at(12), 6 * minute, runnable403);
    assert.equal(unrunnableCause(rateLimited), null, runnable403);
    const missed = verifyThroughput(idleWindow(rateLimited), now, { deployed, since: servedSeptember });
    assert.equal(missed.verdict, 'unverified', runnable403);
    assert.deepEqual(missed.shortfall!.missed.map(entry => entry.metric), ['idle-actionable'], runnable403);
    assert.equal(missed.idle.maxMs, 6 * minute);
  }
  // The refusals that do establish the missing grant: the preflight's recorded shortfall.
  for (const missing of [
    'rerun: refused: GitHub POST /repos/cryptob1/graphyard/actions/runs/1/rerun-failed-jobs failed (403): App graphyard lacks Actions: write (installed with read), which CI reruns needs to rerun failed jobs; accept the pending permission request at https://github.com/settings/installations/1',
  ]) assert.equal(unrunnableCause(supersededAfter('request-rework', at(12), 6 * minute, missing)), missing);

  // The loop's next re-measure of the serving release — within one throughputRemeasureMs of the
  // pre-fix record — records the verdict under the fixed rule.
  const { rm } = await import('node:fs/promises');
  const { temporaryDirectory } = await import('./helpers/temp-dirs.js');
  const root = await temporaryDirectory('throughput-superseded-row-span');
  try {
    const takenAt = now - 30 * minute, items = idleWindow(refused);
    await recordThroughputMeasurement(root, verifyThroughput(idleWindow(runnable), takenAt, { deployed, since: servedSeptember }));
    const input = (clock: number) => ({ work: items, observedSha: revision, now: () => clock, origin: 'https://example.invalid',
      status: async () => ({ now: new Date(clock).toISOString(), release: { version: '1', revision } }), readItem: async (id: string) => items.find(item => item.id === id)!, contains: async () => true });
    assert.equal((await loopThroughputMeasurement(root, input(takenAt + throughputRemeasureMs - minute))).outcome, 'current');
    const again = await loopThroughputMeasurement(root, input(takenAt + throughputRemeasureMs));
    assert.equal(again.outcome, 'recorded');
    assert.equal(again.verdict, 'verified', again.detail);
    assert.equal((await readThroughputMeasurement(root))!.report.verdict, 'verified', 'the newest recorded verdict reflects the fixed rule');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// GY-1595: the window opens when the claim's release began serving, so a delivery merged inside it
// is charged only the idle time it waited inside the window — never what accrued before it opened.
test('unit:throughput-idle-window-clip — an action idle before the window start is charged only from the window start to its claim or settlement, one idle wholly before it charges nothing, one idle inside the window is charged whole, and the report names each clipped span with its original idleSince; the budgets are unchanged', async () => {
  const { actionIdleSpans, renderThroughput } = await import('../src/throughput.js');
  assert.deepEqual({ p50: throughputClaim.submitToMergeP50Ms, idle: throughputClaim.idleActionableMs, deliveries: throughputClaim.minimumDeliveries }, { p50: 30 * minute, idle: 5 * minute, deliveries: 10 }, 'the budgets are GY-87\'s own');
  const windowStart = at(-60); // the claim's deployment observation opens the window

  // GY-468's shape: a runnable request-rework idle from long before the window, superseded 3 min into it.
  const straddling = supersededAfter('request-rework', at(-60 - 5000), 5003 * minute);
  const clipped = verifyThroughput(idleWindow(straddling, claim), now, { deployed });
  assert.equal(clipped.window.since, windowStart);
  const gy468 = clipped.deliveries.find(record => record.key === 'GY-468')!;
  assert.equal(gy468.idle?.ms, 3 * minute, 'charged only from the window start to its settlement');
  assert.equal(gy468.idle?.since, at(-60 - 5000), 'the idle figure keeps its original idleSince');
  assert.deepEqual(gy468.clippedIdle, [{ action: straddling.id, kind: 'request-rework', since: at(-60 - 5000), chargedFrom: windowStart, ms: 3 * minute, unclippedMs: 5003 * minute }]);
  assert.equal(clipped.verdict, 'verified', clipped.reason);
  assert.match(renderThroughput(clipped), new RegExp(`clipped to the window: request-rework idle since ${at(-60 - 5000).replace(/\./g, '\\.')} charged 3 min from ${windowStart.replace(/\./g, '\\.')} of 5003 min`));

  // A claimed row idle before the window is charged from the window start to its claim.
  const claimedRow = row('request-review', [
    { at: at(-80), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: '' },
    { at: at(-58), event: 'claimed', requester: 'graphyard', executor: 'executor-a', result: null, reason: 'attempt 1 claimed by executor-a on host-a' },
    { at: at(-57), event: 'completed', requester: 'graphyard', executor: 'executor-a', result: 'done', reason: '' },
  ]);
  assert.deepEqual(actionIdleSpans(claimedRow, now, windowStart), [{ from: at(-80), ms: 2 * minute, clippedFrom: windowStart, unclippedMs: 22 * minute }]);
  assert.deepEqual(actionIdleSpans(claimedRow, now), [{ from: at(-80), ms: 22 * minute }], 'with no window the whole span is charged, unchanged');

  // An action idle wholly before the window start charges nothing, and is still named.
  const before = supersededAfter('request-rework', at(-60 - 5000), 4000 * minute);
  const none = verifyThroughput(idleWindow(before, claim), now, { deployed });
  const gy468Before = none.deliveries.find(record => record.key === 'GY-468')!;
  assert.notEqual(gy468Before.idle?.action, before.id, 'the pre-window row is not the delivery\'s idle figure');
  assert.ok((gy468Before.idle?.ms ?? 0) <= minute, 'only the executed review\'s 1 min wait is charged');
  assert.deepEqual(gy468Before.clippedIdle?.map(span => [span.since, span.ms, span.unclippedMs]), [[at(-60 - 5000), 0, 4000 * minute]]);
  assert.equal(none.verdict, 'verified', none.reason);

  // An action that went idle inside the window is charged its whole span, and past 5 min still fails the claim.
  const inside = supersededAfter('request-rework', at(-50), 6 * minute);
  const whole = verifyThroughput(idleWindow(inside, claim), now, { deployed });
  const gy468Inside = whole.excluded.concat(whole.deliveries).find(record => record.key === 'GY-468')!;
  assert.equal(gy468Inside.idle?.ms, 6 * minute);
  assert.equal(gy468Inside.clippedIdle, undefined, 'nothing clipped inside the window');
  assert.equal(whole.verdict, 'unverified');
  assert.deepEqual(whole.shortfall!.missed.map(entry => entry.metric), ['idle-actionable']);
  // A straddling span whose in-window part exceeds 5 min still fails the claim.
  const longInside = verifyThroughput(idleWindow(supersededAfter('request-rework', at(-70), 16 * minute), claim), now, { deployed });
  assert.equal(longInside.idle.maxMs, 6 * minute);
  assert.equal(longInside.verdict, 'unverified');
  assert.deepEqual(longInside.shortfall!.missed.map(entry => entry.metric), ['idle-actionable']);
});

test('unit:throughput-trailing-window — without an explicit --since the serving release is judged only over deliveries merged in the 72 hours before the measurement (or --until), never before GY-87 first served, named trailing-72h with why; --since still overrides it; the budgets are unchanged, an idle span past 5 min inside the window still fails the claim and fewer than 10 admitted deliveries leave it unverified', async () => {
  const { claimWindow, measureThroughput, throughputTrailingWindowMs } = await import('../src/throughput.js');
  const hour = 60 * minute;
  // GY-87 first served ten days before the measurement; the 72-hour window is much later.
  const measuredAt = base + 240 * hour;
  const servedAt = new Date(base).toISOString();
  const served = { ...claim, delivery: { mergeSha: sha('c'), mergedAt: new Date(base - hour).toISOString(), deployment: { sha: revision, observedAt: servedAt } } } as unknown as Work;
  const stamp = (ms: number) => new Date(ms).toISOString();
  /** One routine delivery merged `mergedAt`, submitted 20 min before, whose one executed action waited `idle` minutes. */
  const merged = (key: string, mergedAt: number, idle = 1) => {
    const from = mergedAt - 25 * minute;
    const work = delivery(key, { history: [row('request-review', [
      { at: stamp(from), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: '' },
      { at: stamp(from + idle * minute), event: 'claimed', requester: 'graphyard', executor: 'executor-a', result: null, reason: 'attempt 1 claimed by executor-a on host-a' },
      { at: stamp(from + idle * minute + minute), event: 'completed', requester: 'graphyard', executor: 'executor-a', result: 'done', reason: '' },
    ])] }) as any;
    work.delivery = { mergeSha: sha('a'), mergedAt: stamp(mergedAt) };
    work.pipeline = { ...work.pipeline, attempts: [{ epoch: 1, owner: 'worker-1', claimedAt: stamp(from - 30 * minute), endedAt: stamp(mergedAt - 20 * minute), end: 'submitted' }], submittedAt: stamp(mergedAt - 20 * minute) };
    work.updatedAt = stamp(mergedAt);
    return work as Work;
  };
  const trailingStart = measuredAt - throughputTrailingWindowMs;
  assert.equal(throughputTrailingWindowMs, 72 * hour);
  // Twelve clean deliveries inside the trailing 72 hours, and old misses the fixed window kept charging forever.
  const recent = Array.from({ length: 12 }, (_, index) => merged(`GY-${500 + index}`, trailingStart + (index + 1) * 5 * hour));
  const oldMisses = Array.from({ length: 5 }, (_, index) => merged(`GY-${400 + index}`, base + (index + 2) * hour, 149));
  const report = verifyThroughput([served, ...oldMisses, ...recent], measuredAt, { deployed });

  // AC-1: only the trailing 72 hours are judged, and the window says so and why.
  assert.equal(report.window.since, stamp(trailingStart));
  assert.equal(report.window.basis, 'trailing-72h');
  assert.match(report.window.reason, /72 hours before/);
  assert.match(report.window.reason, new RegExp(`${throughputClaim.item} first served \\(${servedAt}`));
  assert.deepEqual(report.deliveries.map(record => record.key), recent.map(item => item.key));
  assert.ok(!report.excluded.some(record => record.key.startsWith('GY-40')), 'deliveries merged before the trailing window are not listed at all');
  assert.equal(report.verdict, 'verified', report.reason);
  // The pre-GY-1596 window from GY-87's first serving fails on the old misses; --since still overrides the trailing window.
  const given = verifyThroughput([served, ...oldMisses, ...recent], measuredAt, { deployed, since: servedAt });
  assert.equal(given.window.basis, 'given');
  assert.equal(given.window.since, servedAt);
  assert.equal(given.population.delivered, 17);
  assert.equal(given.verdict, 'unverified');
  assert.deepEqual(given.shortfall!.missed.map(entry => entry.metric), ['idle-actionable']);
  // --until moves the trailing window's end with it.
  const until = stamp(base + 100 * hour);
  const bounded = verifyThroughput([served, ...oldMisses, ...recent], measuredAt, { deployed, until });
  assert.equal(bounded.window.basis, 'trailing-72h');
  assert.equal(bounded.window.since, stamp(base + 28 * hour));
  assert.equal(bounded.window.until, until);
  // Without --until the window ends at the measurement time: a merge stamped after it (clock skew,
  // a ledger read ahead of the clock) is neither read nor judged, in either measurement path.
  const future = [merged('GY-700', measuredAt + hour, 149), merged('GY-701', measuredAt + 2 * hour, 149)];
  const ahead = verifyThroughput([served, ...oldMisses, ...recent, ...future], measuredAt, { deployed });
  assert.deepEqual(ahead.deliveries.map(record => record.key), recent.map(item => item.key));
  assert.ok(![...ahead.deliveries, ...ahead.excluded].some(record => record.key.startsWith('GY-70')), 'a delivery merged after the measurement time is not judged');
  assert.equal(ahead.verdict, 'verified', ahead.reason);
  const everything = [served, ...oldMisses, ...recent, ...future];
  const measured = await measureThroughput(everything, async id => everything.find(item => item.id === id)!, measuredAt, { deployed });
  assert.ok(!measured.read.some(id => future.some(item => item.id === id)), 'a delivery merged after the measurement time is not read');
  assert.deepEqual(measured.report.deliveries.map(record => record.key), recent.map(item => item.key));
  assert.equal(measured.report.verdict, 'verified', measured.report.reason);
  // Never before GY-87 first served: a release fresher than 72 hours keeps its serving floor and basis.
  const fresh = verifyThroughput([served, ...oldMisses], base + 24 * hour, { deployed });
  assert.equal(fresh.window.since, servedAt);
  assert.equal(fresh.window.basis, 'deployment-observation');
  const early = merged('GY-399', base - 30 * minute);
  const floored = verifyThroughput([served, early, ...oldMisses], base + 24 * hour, { deployed });
  assert.ok(![...floored.deliveries, ...floored.excluded].some(record => record.key === 'GY-399'), 'a delivery merged before GY-87 first served is never judged');
  assert.deepEqual(claimWindow(served, null, base + 24 * hour), claimWindow(served, null, base + 1));
  assert.equal(claimWindow(undefined, null, measuredAt).basis, 'unknown', 'an undelivered claim still establishes no window');

  // AC-2: the budgets are unchanged.
  assert.equal(throughputClaim.submitToMergeP50Ms, 30 * minute);
  assert.equal(throughputClaim.idleActionableMs, 5 * minute);
  assert.equal(throughputClaim.minimumDeliveries, 10);
  // A delivery inside the trailing window idle past 5 min still fails the claim.
  const slow = verifyThroughput([served, ...recent.slice(1), merged('GY-600', trailingStart + hour, 6)], measuredAt, { deployed });
  assert.equal(slow.window.basis, 'trailing-72h');
  assert.equal(slow.verdict, 'unverified');
  assert.equal(slow.idle.key, 'GY-600');
  assert.deepEqual(slow.shortfall!.missed.map(entry => entry.metric), ['idle-actionable']);
  // Fewer than 10 admitted deliveries in the window leaves the claim unverified, never verified.
  const few = verifyThroughput([served, ...oldMisses, ...recent.slice(0, 9)], measuredAt, { deployed });
  assert.equal(few.population.admitted, 9);
  assert.equal(few.met, null);
  assert.equal(few.verdict, 'unverified');
  assert.deepEqual(few.shortfall!.missed.map(entry => entry.metric), ['population']);
});
