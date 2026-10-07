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
