import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Work } from '../src/model.js';
import { actionId, type ActionRecord, type ActionRow } from '../src/model/actions.js';
import { actionRecordLimit, actionStall, actionStallThreshold } from '../src/model/action-progress.js';
import type { NextAction } from '../src/model/action-kinds.js';
import { livenessCarry, livenessRetryLimit } from '../src/model/liveness.js';
import { stalledActionAttention } from '../src/cli/master-status.js';
import { appPermissionsFirst, recordStallRemedy, stallRemedy, standingRemedy, type FlowResult, type RemedyFlow } from '../src/stall-remedies.js';
import { owedRemedies, remedyStep } from '../src/daemon/cycle-remedies.js';
import { Launcher, type Cycle } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { DaemonEffects } from '../src/daemon/effects.js';

/**
 * GY-949: the loop binds a stalled row's unchanged reason to its sanctioned remedy and applies it.
 *
 * One case per proof — unit:stall-remedy-binding, unit:stall-remedy-installation-accept,
 * unit:stall-remedy-recorded-once, unit:stall-remedy-saturation-answer — and the GY-948 instances
 * replayed under manual:fault-class-stalled-gate. The reasons below are the ones the ledger recorded
 * on 29 September 2026 (`graphyard events GY-864 --kind action.failed`), word for word.
 */

const holdReason = (key: string) => `${key}: no observation newer than the claim was saved; its observation job is held: App graphyard-cryptob1-graphyard lacks Actions: write, which failed CI reruns needs to rerun failed workflow jobs on the unchanged candidate; accept the pending permission request at https://github.com/settings/installations/161493384; the claim woke it and leaves the row waiting for the observation`;
const fullProfile = (name: string) => `${name} (role worker is at its concurrency limit (8 of 8 live))`;
const saturationReason = (key: string) => `no worker profile can take ${key}: ${['claude-primary', 'claude-secondary', 'opencode-primary', 'opencode-secondary', 'claude-quinary', 'claude-senary', 'claude-tertiary', 'claude-quaternary', 'cursor-primary', 'cursor-secondary'].map(fullProfile).join('; ')}; bootstrap-existing (Existing sessions are observed only; Graphyard will not inject new work into an unsupervised process)`;
const generic = /Clear what that reason names/;
/** When the run a completed row's last event ended began, as far as the row's retained history tells. */
const endedSince = (row: ActionRow) => actionStall({ ...row, history: row.history.slice(0, -1) })!.since;
const shift = (at: string, ms: number) => new Date(Date.parse(at) + ms).toISOString();

/** An open item whose `kind` row failed `failures` times for `reason`, the last at `at`. */
function stalledItem(key: string, kind: 'resync' | 'dispatch', reason: string, at: string, failures = actionStallThreshold) {
  const id = randomUUID(), binding = `${kind}:1`;
  const first = shift(at, -failures * 60_000);
  const history: ActionRecord[] = [{ at: shift(first, -60_000), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: `${key} needs ${kind}` }];
  for (let n = 0; n < failures; n++) {
    const failed = shift(first, (n + 1) * 60_000);
    history.push({ at: shift(failed, -10_000), event: 'claimed', requester: 'graphyard', executor: 'graphyard-master@vishrog/2', result: null, reason: `attempt ${n + 1}` },
      { at: failed, event: 'failed', requester: 'graphyard', executor: 'graphyard-master@vishrog/2', result: 'failed', reason });
  }
  const row: ActionRow = { id: actionId(kind, id, binding), kind, work: id, key, inputs: { kind } as ActionRow['inputs'], gate: 'build', refusal: null, reason: `${key} needs ${kind}`, binding,
    requestedBy: 'graphyard', requestedAt: history[0].at, state: 'pending', claim: null, attempts: failures, retryAt: shift(at, 60_000), resolvedAt: at, result: 'failed', resolution: reason, history };
  row.stall = actionStall(row)!;
  const work = { id, key, stage: 'build', ready: true, epoch: 1, title: key, lease: null, actionQueue: { actions: [row], history: [] }, updatedAt: at, stageEnteredAt: first } as unknown as Work;
  const action = { kind, work: id, key, gate: 'build', refusal: null, reason: row.reason, inputs: row.inputs, llmRole: null, binding } as unknown as NextAction;
  return { work, row, action };
}

/** The loop's remedy step against `work`, with `flow` standing in for the master browser child and the record landing on the row as the control plane writes it. */
async function runRemedyStep(work: Work[], flow: (name: RemedyFlow) => Promise<FlowResult>, at: string) {
  const ran: RemedyFlow[] = [], records: { row: string; outcome: string }[] = [], refused: string[] = [];
  const launcher = new Launcher(Number.POSITIVE_INFINITY);
  const state = emptyDaemonState({ url: 'http://graphyard.test', repository: 'owner/project' } as never);
  const effects = {
    persist: async () => {},
    browserFlow: async (name: RemedyFlow) => { ran.push(name); return flow(name); },
    recordRemedy: async (row: string, attempt: Parameters<NonNullable<DaemonEffects['recordRemedy']>>[1]) => {
      const item = work.find(entry => entry.actionQueue!.actions.some(candidate => candidate.id === row))!;
      try { recordStallRemedy(item, row, attempt, 'graphyard-master', new Date(at)); records.push({ row, outcome: attempt.outcome }); }
      catch (error) { refused.push(String((error as Error).message)); throw error; }
    },
  } as unknown as DaemonEffects;
  const cycle = { effects, snapshot: { work, now: at }, state, now: () => Date.parse(at), launcher,
    launch: (_kind: string, _item: Work | null, key: string, holds: string[], body: (sink: unknown[]) => Promise<void>) => launcher.submit(key, holds, body as never) } as unknown as Cycle;
  await remedyStep(cycle);
  await launcher.idle();
  return { ran, records, refused, reported: launcher.drain() };
}

// ---- AC-1 -----------------------------------------------------------------------------------------

test('unit:stall-remedy-binding — every stall reason the registry recognises binds to its sanctioned remedy or owning decision, the attention names it instead of the generic line, and an unrecognised reason keeps the generic line', () => {
  const hold = stallRemedy(holdReason('GY-864'));
  assert.equal(hold?.kind, 'installation-accept');
  assert.equal(hold?.applies, 'loop', 'the permission hold is a remedy the loop applies itself');
  assert.match(hold!.remedy, /graphyard master browser installation-accept \(app-permissions first/);
  assert.match(hold!.remedy, /Actions: write/);
  const full = stallRemedy(saturationReason('GY-947'));
  assert.equal(full?.kind, 'capacity');
  assert.equal(full?.applies, 'decision', 'a full role is a capacity decision, not something a retry or a flow clears');
  const suspended = stallRemedy('The control plane could not read App 1\'s installation: App graphyard-x\'s installation 91011 is suspended; restore it at https://github.com/settings/installations/91011');
  assert.equal(suspended?.kind, 'installation-suspended');
  assert.equal(suspended?.owner, 'human');
  const suspendedDirect = stallRemedy('App graphyard-x installation is suspended; restore it at https://github.com/settings/installations/91011');
  assert.equal(suspendedDirect?.kind, 'installation-suspended');
  const workerPushHold = stallRemedy('App graphyard-worker installation lacks Workflows: write (installed with read), worker-push-shortfall; they are minted without it until it is granted, so a worker push that needs it is refused. Run graphyard master browser app-permissions, then graphyard master browser installation-accept, or accept the pending permission request at https://github.com/settings/installations/91011');
  assert.equal(workerPushHold?.kind, 'installation-accept');
  assert.equal(stallRemedy('reviewer agent reviewer-a is busy in Herdr'), null, 'a reason no entry recognises binds to nothing');

  const at = '2026-09-29T05:41:27.620Z';
  const bound = stalledItem('GY-864', 'resync', holdReason('GY-864'), at);
  const unknown = stalledItem('GY-9', 'request-review' as 'dispatch', 'reviewer agent reviewer-a is busy in Herdr', at);
  const raised = stalledActionAttention({ work: [bound.work, unknown.work], now: at });
  const named = raised.find(entry => entry.subject === 'GY-864')!;
  assert.doesNotMatch(named.next, generic, 'a bound reason no longer gets the generic instruction');
  assert.match(named.next, /the loop applies the sanctioned remedy itself — graphyard master browser installation-accept/);
  assert.equal(named.role, 'master');
  assert.match(raised.find(entry => entry.subject === 'GY-9')!.next, generic, 'an unrecognised reason keeps the generic line');
});

// ---- AC-2 -----------------------------------------------------------------------------------------

test('unit:stall-remedy-installation-accept — a row stalled on the permission hold is remedied by the loop: installation-accept, app-permissions first when the App does not yet request it, verified, and the outcome recorded on the row', async () => {
  const at = '2026-09-29T05:41:27.620Z';
  const { work, row } = stalledItem('GY-864', 'resync', holdReason('GY-864'), at);
  let accepts = 0;
  const { ran, records, reported } = await runRemedyStep([work], async name => {
    if (name === 'app-permissions') return { outcome: 'applied', verified: true, reason: 'App now requests 1 raised permission(s); run master browser installation-accept so the installation grants them' };
    return ++accepts === 1 ? { outcome: 'refused', verified: false, reason: `The App itself does not yet request actions: none to write; ${appPermissionsFirst}` }
      : { outcome: 'applied', verified: true, reason: 'Installation 161493384 now grants actions: read to write' };
  }, at);
  assert.deepEqual(ran, ['installation-accept', 'app-permissions', 'installation-accept'], 'app-permissions runs only when installation-accept says the App does not yet request it');
  assert.deepEqual(records, [{ row: row.id, outcome: 'applied' }]);
  const recorded = standingRemedy(work, row.id, row.stall!.reason)!;
  assert.deepEqual(recorded.flows, ['installation-accept', 'app-permissions', 'installation-accept']);
  assert.match(recorded.detail, /verified through the API: Installation 161493384 now grants/);
  assert.equal(reported.length, 1, 'the loop reports the remedy it applied');
  assert.equal(reported[0].state, 'done');
  assert.equal(reported[0].work, 'GY-864', 'a single-item remedy attributes the action to that item');
  assert.match(reported[0].detail, /installation-accept remedy .* for the stalled GY-864's resync: applied/);
  const raised = stalledActionAttention({ work: [work], now: at }).find(entry => entry.subject === 'GY-864')!;
  assert.match(raised.next, /the loop applied the installation-accept remedy \(installation-accept, then app-permissions, then installation-accept\)/, 'the attention names what the remedy did');
});

test('unit:stall-remedy-installation-accept — a refused remedy (a pending sudo confirmation) is recorded, escalated once with the refusal and the remedy named, and never applied again', async () => {
  const at = '2026-09-29T05:41:27.620Z';
  const { work, row, action } = stalledItem('GY-515', 'resync', holdReason('GY-515'), at);
  const sudo = 'Confirm access was not approved within 300s; approve the GitHub Mobile prompt (code 42) and rerun master browser installation-accept';
  const first = await runRemedyStep([work], async () => ({ outcome: 'refused', verified: false, reason: sudo }), at);
  assert.deepEqual(first.ran, ['installation-accept']);
  assert.deepEqual(first.records, [{ row: row.id, outcome: 'refused' }]);
  assert.equal(first.reported[0].state, 'failed');

  const escalated = livenessCarry(work, { gate: 'build', refusal: null, action, wait: null, defect: null }, [work], new Date(at)).action!;
  assert.equal(escalated.kind, 'escalate', `escalated at once, not after ${livenessRetryLimit} failures`);
  assert.equal(escalated.inputs.kind === 'escalate' && escalated.inputs.trigger, 'stalled-action');
  assert.match(escalated.reason, /installation-accept remedy \(installation-accept\) was refused at .*Confirm access was not approved/);
  assert.match(escalated.reason, /escalated once with the refusal and the remedy named/);
  assert.ok(escalated.inputs.kind === 'escalate' && escalated.inputs.detail.includes('Remedy: graphyard master browser installation-accept'));

  // Answered, the run is not escalated again; and the loop never applies the remedy a second time.
  work.actionQueue!.history.push({ ...row, id: actionId('escalate', work.id, escalated.binding), kind: 'escalate', state: 'done', result: 'done', resolvedAt: shift(at, 60_000), history: [] });
  assert.equal(livenessCarry(work, { gate: 'build', refusal: null, action, wait: null, defect: null }, [work], new Date(shift(at, 120_000))).action, action, 'once: an answered refusal escalation is not raised again for the run');
  const again = await runRemedyStep([work], async () => { throw new Error('applied twice'); }, shift(at, 120_000));
  assert.deepEqual(again.ran, [], 'the refused remedy is not retried in a loop');
  assert.match(stalledActionAttention({ work: [work], now: at })[0].next, /was refused at .* The loop does not apply it again for this unchanged run/);

  // After the row completes and later reopens with a fresh stall on the same reason, a new run starts and the remedy is applied again.
  row.history.push({ at: shift(at, 180_000), event: 'completed', requester: 'graphyard', executor: 'x', result: 'done', reason: 'cleared' });
  for (let n = 0; n < actionStallThreshold; n++) {
    row.history.push({ at: shift(at, (190 + n) * 60_000), event: 'failed', requester: 'graphyard', executor: 'x', result: 'failed', reason: holdReason('GY-515') });
  }
  assert.equal(standingRemedy(work, row.id, row.stall!.reason), null, 'fresh run has no standing remedy');
  const fresh = await runRemedyStep([work], async () => ({ outcome: 'refused', verified: false, reason: sudo }), shift(at, 300 * 60_000));
  assert.deepEqual(fresh.ran, ['installation-accept'], 'fresh run applies the remedy again');
});

test('unit:stall-remedy-installation-accept — a flow that cannot run (no browser profile) is a refusal carrying its message, not a crash', async () => {
  const at = '2026-09-29T05:41:27.620Z';
  const { work, row } = stalledItem('GY-864', 'resync', holdReason('GY-864'), at);
  const result = await runRemedyStep([work], async () => { throw new Error('No browser profile is configured; rerun master init --browser-profile PROFILE'); }, at);
  assert.deepEqual(result.records, [{ row: row.id, outcome: 'refused' }]);
  assert.match(standingRemedy(work, row.id, row.stall!.reason)!.detail, /No browser profile is configured/);
});

test('unit:stall-remedy-recorded-once — the remedy is applied and recorded once per unchanged run, across cycles and across rows held by the same condition; a second record is refused', async () => {
  const at = '2026-09-29T05:41:27.620Z';
  const a = stalledItem('GY-864', 'resync', holdReason('GY-864'), at), b = stalledItem('GY-515', 'resync', holdReason('GY-515'), at);
  const work = [a.work, b.work];
  assert.equal(owedRemedies(work).length, 2);
  const applied = async () => ({ outcome: 'applied' as const, verified: true, reason: 'Installation 161493384 now grants actions: read to write' });
  const first = await runRemedyStep(work, applied, at);
  assert.deepEqual(first.ran, ['installation-accept'], 'one installation to accept: the flow runs once for both rows');
  assert.deepEqual(first.records.map(entry => entry.row).sort(), [a.row.id, b.row.id].sort(), 'and its outcome is recorded on each');
  assert.equal(first.reported[0].work, null, 'a remedy shared by several items attributes the action to none alone');
  assert.deepEqual(owedRemedies(work), []);

  // The rows go on failing for the same reason while the held jobs resume: still one run, no second application.
  for (const { row } of [a, b]) {
    const failedAt = shift(at, 5 * 60_000);
    row.history.push({ at: shift(failedAt, -10_000), event: 'claimed', requester: 'graphyard', executor: 'x', result: null, reason: 'again' }, { at: failedAt, event: 'failed', requester: 'graphyard', executor: 'x', result: 'failed', reason: row.stall!.reason });
  }
  for (let cycle = 0; cycle < 3; cycle++) assert.deepEqual((await runRemedyStep(work, applied, shift(at, (cycle + 6) * 60_000))).ran, [], `cycle ${cycle + 2} applies nothing`);
  assert.throws(() => recordStallRemedy(a.work, a.row.id, { remedy: 'installation-accept', reason: a.row.stall!.reason, outcome: 'applied', detail: 'again', flows: ['installation-accept'] }, 'graphyard-master', new Date(shift(at, 10 * 60_000))),
    /already recorded for this unchanged run/);
  assert.throws(() => recordStallRemedy(a.work, a.row.id, { remedy: 'installation-accept', reason: 'some other reason', outcome: 'applied', detail: 'x', flows: ['installation-accept'] }, 'graphyard-master', new Date(at)),
    /no longer stalled on the reason/);

  // A run that ended — the row completed — and a fresh one on the same hold is owed the remedy again.
  a.row.history.push({ at: shift(at, 20 * 60_000), event: 'completed', requester: 'graphyard', executor: 'x', result: 'done', reason: 'observed' });
  for (let n = 0; n < actionStallThreshold; n++) a.row.history.push({ at: shift(at, (21 + n) * 60_000), event: 'failed', requester: 'graphyard', executor: 'x', result: 'failed', reason: a.row.stall!.reason });
  assert.equal(standingRemedy(a.work, a.row.id, a.row.stall!.reason), null);
  assert.deepEqual(owedRemedies(work).map(entry => entry.work.key), ['GY-864']);

  // GY-1586: the remedy cleared the hold and the held job completed the row before the record landed.
  // The record still lands on the run the completion ended, once; a row that completed out of
  // another reason's run, or after any later event, is refused.
  const c = stalledItem('GY-1586', 'dispatch', holdReason('GY-1586'), at), reason = c.row.stall!.reason;
  c.row.history.push({ at: shift(at, 30_000), event: 'claimed', requester: 'graphyard', executor: 'x', result: null, reason: 'resumed' }, { at: shift(at, 60_000), event: 'completed', requester: 'graphyard', executor: 'x', result: 'done', reason: 'the held job resumed' });
  Object.assign(c.row, { state: 'done', result: 'done' });
  assert.equal(actionStall(c.row), null);
  const late = { remedy: 'installation-accept' as const, reason, outcome: 'applied' as const, detail: 'granted', flows: ['installation-accept' as const] };
  assert.equal(recordStallRemedy(c.work, c.row.id, late, 'graphyard-master', new Date(shift(at, 90_000))).remedy?.outcome, 'applied', 'a record landing after the row completed out of its run is kept');
  assert.throws(() => recordStallRemedy(c.work, c.row.id, late, 'graphyard-master', new Date(shift(at, 120_000))), /already recorded for this unchanged run/);
  assert.throws(() => recordStallRemedy(c.work, c.row.id, { ...late, reason: 'some other reason' }, 'graphyard-master', new Date(at)), /no longer stalled on the reason/);
  assert.deepEqual(owedRemedies([c.work]), [], 'a completed row is owed nothing');
  const d = stalledItem('GY-1587', 'dispatch', holdReason('GY-1587'), at);
  d.row.history.push({ at: shift(at, 60_000), event: 'completed', requester: 'graphyard', executor: 'x', result: 'done', reason: 'done' }, { at: shift(at, 70_000), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: 'again' });
  assert.throws(() => recordStallRemedy(d.work, d.row.id, { ...late, reason: d.row.stall!.reason }, 'graphyard-master', new Date(shift(at, 90_000))), /no longer stalled on the reason/, 'only a completion that is the row\'s last event ended the run the record names');

  // A record made early in a run outlives the run's first failures once same-reason retries trim them
  // from the row's history: the completion that ends the run takes no second record, and the first stands.
  const e = stalledItem('GY-1588', 'dispatch', holdReason('GY-1588'), at), held = e.row.stall!.reason;
  const refusal = { ...late, reason: held, outcome: 'refused' as const, detail: 'a sudo confirmation is pending' };
  recordStallRemedy(e.work, e.row.id, refusal, 'graphyard-master', new Date(shift(at, 10_000)));
  for (let n = 1; n <= actionRecordLimit; n++) {
    const failedAt = shift(at, n * 60_000);
    e.row.history.push({ at: shift(failedAt, -10_000), event: 'claimed', requester: 'graphyard', executor: 'x', result: null, reason: 'again' }, { at: failedAt, event: 'failed', requester: 'graphyard', executor: 'x', result: 'failed', reason: held });
  }
  e.row.history.push({ at: shift(at, (actionRecordLimit + 1) * 60_000), event: 'completed', requester: 'graphyard', executor: 'x', result: 'done', reason: 'the held job resumed' });
  e.row.history = e.row.history.slice(-actionRecordLimit);
  Object.assign(e.row, { state: 'done', result: 'done' });
  assert.ok(Date.parse(endedSince(e.row)) > Date.parse(e.row.remedy!.at), 'the retained history no longer reaches back to the record');
  assert.throws(() => recordStallRemedy(e.work, e.row.id, { ...late, reason: held }, 'graphyard-master', new Date(shift(at, (actionRecordLimit + 2) * 60_000))), /already recorded for this unchanged run/);
  assert.equal(e.row.remedy?.outcome, 'refused', 'the run\'s recorded refusal is kept');

  // Settlement wakes the item's reconciliation, which can retire the completed row to the queue's
  // history before the record lands: the record lands on that retired copy, once.
  const f = stalledItem('GY-1589', 'dispatch', holdReason('GY-1589'), at), retiredFor = f.row.stall!.reason;
  f.row.history.push({ at: shift(at, 60_000), event: 'completed', requester: 'graphyard', executor: 'x', result: 'done', reason: 'the held job resumed' });
  Object.assign(f.row, { state: 'done', result: 'done', resolution: 'GY-1589 no longer needs this action' });
  f.work.actionQueue = { actions: [], history: [f.row] };
  assert.equal(recordStallRemedy(f.work, f.row.id, { ...late, reason: retiredFor }, 'graphyard-master', new Date(shift(at, 90_000))), f.row);
  assert.equal(f.row.remedy?.outcome, 'applied');
  assert.throws(() => recordStallRemedy(f.work, f.row.id, { ...late, reason: retiredFor }, 'graphyard-master', new Date(shift(at, 120_000))), /already recorded for this unchanged run/);
});

// ---- AC-3 -----------------------------------------------------------------------------------------

test('unit:stall-remedy-saturation-answer — a row stalled on a full role names the capacity lever and the owning decision in its attention and its escalation, never a silent widened backoff', async () => {
  const at = '2026-09-29T05:41:27.620Z';
  const { work, action } = stalledItem('GY-947', 'dispatch', saturationReason('GY-947'), at);
  const raised = stalledActionAttention({ work: [work], now: at })[0];
  assert.doesNotMatch(raised.next, generic);
  assert.match(raised.next, /Role worker is full \(8 of 8 live\)/);
  assert.match(raised.next, /capacity decision the master owns/);
  assert.match(raised.next, /graphyard master registry role set worker ACCOUNT\[,ACCOUNT…\] --concurrency N --reason REASON, N above 8/);
  assert.equal(raised.role, 'master');
  assert.deepEqual(owedRemedies([work]), [], 'nothing the loop runs clears it: no browser flow is applied');
  assert.deepEqual((await runRemedyStep([work], async () => { throw new Error('ran'); }, at)).ran, []);

  const escalating = stalledItem('GY-947', 'dispatch', saturationReason('GY-947'), at, livenessRetryLimit);
  const escalated = livenessCarry(escalating.work, { gate: 'build', refusal: null, action: escalating.action, wait: null, defect: null }, [escalating.work], new Date(at)).action!;
  assert.equal(escalated.kind, 'escalate', 'the stall resolves to the owning decision');
  assert.match(escalated.reason, /Remedy: a capacity decision: raise role worker's concurrency in the agent registry/);
  assert.ok(escalated.inputs.kind === 'escalate' && /Remedy: a capacity decision/.test(escalated.inputs.detail), 'the escalation names the lever');
});

// ---- AC-4 -----------------------------------------------------------------------------------------

/**
 * The five instances GY-948 lists, each at the instant the loop recorded it. Against the base each
 * attention named only "Clear what that reason names" and no remedy was ever applied — the instance.
 * Against this change each names its bound remedy; the permission holds are remedied by the loop
 * once and, once the grant lets their rows complete, raise no stall; the saturations name the lever.
 */
const instances = [
  { subject: 'GY-864', at: '2026-09-29T05:39:55.925Z', kind: 'resync' as const, failures: 4 },
  { subject: 'GY-515', at: '2026-09-29T05:41:27.620Z', kind: 'resync' as const, failures: 3 },
  { subject: 'GY-947', at: '2026-09-29T05:41:27.620Z', kind: 'dispatch' as const, failures: 3 },
  { subject: 'GY-73', at: '2026-09-29T05:41:27.620Z', kind: 'dispatch' as const, failures: 3 },
  { subject: 'GY-806', at: '2026-09-29T05:41:27.620Z', kind: 'dispatch' as const, failures: 3 },
];

test('manual:fault-class-stalled-gate — GY-948 lists five stalled-gate instances, and each is replayed below', () => {
  assert.deepEqual(instances.map(instance => instance.subject), ['GY-864', 'GY-515', 'GY-947', 'GY-73', 'GY-806']);
});

for (const instance of instances) {
  test(`manual:fault-class-stalled-gate — GY-948 ${instance.subject}'s stalled ${instance.kind} does not recur as an unremedied stall`, async () => {
    const reason = instance.kind === 'resync' ? holdReason(instance.subject) : saturationReason(instance.subject);
    const { work, row } = stalledItem(instance.subject, instance.kind, reason, instance.at, instance.failures);
    const raised = stalledActionAttention({ work: [work], now: instance.at });
    assert.equal(raised.length, 1, 'the row is stalled, as it was');
    assert.doesNotMatch(raised[0].next, generic, 'the instance: only the generic instruction, no remedy named');
    if (instance.kind === 'dispatch') { assert.match(raised[0].next, /capacity decision the master owns/); return; }
    const { ran } = await runRemedyStep([work], async () => ({ outcome: 'applied', verified: true, reason: 'Installation 161493384 now grants actions: read to write' }), instance.at);
    assert.deepEqual(ran, ['installation-accept'], 'the loop applied the sanctioned remedy itself');
    // The grant resumes the held observation job; the row's own recheck finds it and completes.
    row.history.push({ at: shift(instance.at, 120_000), event: 'completed', requester: 'graphyard', executor: 'x', result: 'done', reason: 'an observation newer than the claim was saved' });
    Object.assign(row, { state: 'done', result: 'done', resolvedAt: shift(instance.at, 120_000) });
    delete row.stall;
    assert.deepEqual(stalledActionAttention({ work: [work], now: shift(instance.at, 180_000) }), [], 'and the stall does not recur');
  });
}
