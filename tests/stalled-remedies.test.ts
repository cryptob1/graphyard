import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Work } from '../src/model.js';
import { actionId, type ActionRecord, type ActionRow } from '../src/model/actions.js';
import { actionStall, actionStallThreshold } from '../src/model/action-progress.js';
import type { NextAction } from '../src/model/action-kinds.js';
import { livenessCarry, livenessRetryLimit } from '../src/model/liveness.js';
import { stalledActionAttention } from '../src/cli/master-status.js';
import { credential401Remedy, stallRemedy } from '../src/stall-remedies.js';

/**
 * GY-949: a stalled row's unchanged reason binds to its sanctioned remedy, which the attention and
 * the escalation name. The loop no longer applies the installation-accept remedy itself (GY-1984):
 * the remedy record it wrote went with the executor fleet's action routes.
 *
 * One case per proof — unit:stall-remedy-binding, unit:stall-remedy-saturation-answer — and the
 * GY-948 instances replayed under manual:fault-class-stalled-gate. The reasons below are the ones the ledger recorded
 * on 29 September 2026 (`graphyard events GY-864 --kind action.failed`), word for word.
 */

const holdReason = (key: string) => `${key}: no observation newer than the claim was saved; its observation job is held: App graphyard-cryptob1-graphyard lacks Actions: write, which failed CI reruns needs to rerun failed workflow jobs on the unchanged candidate; accept the pending permission request at https://github.com/settings/installations/161493384; the claim woke it and leaves the row waiting for the observation`;
const fullProfile = (name: string) => `${name} (role worker is at its concurrency limit (8 of 8 live))`;
const saturationReason = (key: string) => `no worker profile can take ${key}: ${['claude-primary', 'claude-secondary', 'opencode-primary', 'opencode-secondary', 'claude-quinary', 'claude-senary', 'claude-tertiary', 'claude-quaternary', 'cursor-primary', 'cursor-secondary'].map(fullProfile).join('; ')}; bootstrap-existing (Existing sessions are observed only; Graphyard will not inject new work into an unsupervised process)`;
const generic = /Clear what that reason names/;
const shift = (at: string, ms: number) => new Date(Date.parse(at) + ms).toISOString();

/** An open item whose `kind` row failed `failures` times for `reason`, the last at `at`. */
function stalledItem(key: string, kind: 'resync' | 'dispatch' | 'request-review', reason: string, at: string, failures = actionStallThreshold) {
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

const endpoint4xx = (status = 404) => `Deployment endpoint answered ${status}`;
const claim401 = 'Command failed: /home/vish/code/graphyard/bin/graphyard.mjs claim GY-1994\n{"error":"A valid Graphyard bearer token is required"}';
const reviewerRefused = (key: string, status = 400) => `The control plane refused the reviewer launch of ${key} (${status}): Invalid input`;


// ---- AC-1 -----------------------------------------------------------------------------------------

test('unit:stall-remedy-binding — every stall reason the registry recognises binds to its sanctioned remedy or owning decision, the attention names it instead of the generic line, and an unrecognised reason keeps the generic line', () => {
  const hold = stallRemedy(holdReason('GY-864'));
  assert.equal(hold?.kind, 'installation-accept');
  assert.equal(hold?.owner, 'master', 'the permission hold is the master\'s browser flow to run');
  assert.match(hold!.remedy, /graphyard master browser installation-accept \(app-permissions first/);
  assert.match(hold!.remedy, /Actions: write/);
  const full = stallRemedy(saturationReason('GY-947'));
  assert.equal(full?.kind, 'capacity');
  assert.equal(full?.owner, 'master', 'a full role is a capacity decision, not something a retry or a flow clears');
  const suspended = stallRemedy('The control plane could not read App 1\'s installation: App graphyard-x\'s installation 91011 is suspended; restore it at https://github.com/settings/installations/91011');
  assert.equal(suspended?.kind, 'installation-suspended');
  assert.equal(suspended?.owner, 'human');
  const suspendedDirect = stallRemedy('App graphyard-x installation is suspended; restore it at https://github.com/settings/installations/91011');
  assert.equal(suspendedDirect?.kind, 'installation-suspended');
  const workerPushHold = stallRemedy('App graphyard-worker installation lacks Workflows: write (installed with read), worker-push-shortfall; they are minted without it until it is granted, so a worker push that needs it is refused. Run graphyard master browser app-permissions, then graphyard master browser installation-accept, or accept the pending permission request at https://github.com/settings/installations/91011');
  assert.equal(workerPushHold?.kind, 'installation-accept');
  assert.equal(stallRemedy('reviewer agent reviewer-a is busy in Herdr'), null, 'a reason no entry recognises binds to nothing');
  assert.equal(stallRemedy(endpoint4xx())?.kind, 'installation-setup');
  assert.equal(stallRemedy(claim401)?.kind, 'credential-401');
  assert.equal(stallRemedy(reviewerRefused('GY-1998'))?.kind, 'reviewer-identity');

  const at = '2026-09-29T05:41:27.620Z';
  const bound = stalledItem('GY-864', 'resync', holdReason('GY-864'), at);
  const unknown = stalledItem('GY-9', 'request-review', 'reviewer agent reviewer-a is busy in Herdr', at);
  const raised = stalledActionAttention({ work: [bound.work, unknown.work], now: at });
  const named = raised.find(entry => entry.subject === 'GY-864')!;
  assert.doesNotMatch(named.next, generic, 'a bound reason no longer gets the generic instruction');
  assert.match(named.next, /^Run graphyard master browser installation-accept — graphyard master browser app-permissions first/);
  assert.equal(named.role, 'master');
  assert.match(raised.find(entry => entry.subject === 'GY-9')!.next, generic, 'an unrecognised reason keeps the generic line');
});

// ---- AC-3 -----------------------------------------------------------------------------------------

test('unit:stall-remedy-saturation-answer — a row stalled on a full role names the capacity lever and the owning decision in its attention and its escalation, never a silent widened backoff', () => {
  const at = '2026-09-29T05:41:27.620Z';
  const { work, action } = stalledItem('GY-947', 'dispatch', saturationReason('GY-947'), at);
  const raised = stalledActionAttention({ work: [work], now: at })[0];
  assert.doesNotMatch(raised.next, generic);
  assert.match(raised.next, /Role worker is full \(8 of 8 live\)/);
  assert.match(raised.next, /capacity decision the master owns/);
  assert.match(raised.next, /graphyard master registry role set worker ACCOUNT\[,ACCOUNT…\] --concurrency N --reason REASON, N above 8/);
  assert.equal(raised.role, 'master');

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
 * Against this change each names its bound remedy; the permission holds name the browser flow and,
 * once the grant lets their rows complete, raise no stall; the saturations name the lever.
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
  test(`manual:fault-class-stalled-gate — GY-948 ${instance.subject}'s stalled ${instance.kind} does not recur as an unremedied stall`, () => {
    const reason = instance.kind === 'resync' ? holdReason(instance.subject) : saturationReason(instance.subject);
    const { work, row } = stalledItem(instance.subject, instance.kind, reason, instance.at, instance.failures);
    const raised = stalledActionAttention({ work: [work], now: instance.at });
    assert.equal(raised.length, 1, 'the row is stalled, as it was');
    assert.doesNotMatch(raised[0].next, generic, 'the instance: only the generic instruction, no remedy named');
    if (instance.kind === 'dispatch') { assert.match(raised[0].next, /capacity decision the master owns/); return; }
    assert.match(raised[0].next, /graphyard master browser installation-accept/, 'the attention names the sanctioned remedy');
    // The grant resumes the held observation job; the row's own recheck finds it and completes.
    row.history.push({ at: shift(instance.at, 120_000), event: 'completed', requester: 'graphyard', executor: 'x', result: 'done', reason: 'an observation newer than the claim was saved' });
    Object.assign(row, { state: 'done', result: 'done', resolvedAt: shift(instance.at, 120_000) });
    delete row.stall;
    assert.deepEqual(stalledActionAttention({ work: [work], now: shift(instance.at, 180_000) }), [], 'and the stall does not recur');
  });
}

// ---- GY-2014: permanent installation-level reasons ----------------------------------------------

test('unit:stall-remedy-deployment-endpoint-4xx — a row three failures deep on "Deployment endpoint answered 4xx" binds to the installation setup remedy', () => {
  for (const status of [400, 401, 403, 404]) {
    const bound = stallRemedy(endpoint4xx(status));
    assert.equal(bound?.kind, 'installation-setup', `status ${status}`);
    assert.equal(bound?.owner, 'master');
    assert.match(bound!.remedy, /deploymentUrl/);
    assert.match(bound!.next, /deploymentUrl/);
  }
  assert.equal(stallRemedy('Deployment endpoint answered 503'), null, '5xx stays unbound: another service\'s fault');
  assert.equal(stallRemedy('Deployment endpoint is unreachable: timeout'), null);
  const at = '2026-10-18T03:00:00.000Z';
  const { work } = stalledItem('GY-1963', 'resync', endpoint4xx(404), at);
  assert.ok(work.actionQueue!.actions[0].stall, 'three failures classify as a stall');
  assert.equal(stallRemedy(work.actionQueue!.actions[0].stall!.reason)?.kind, 'installation-setup');
});

test('unit:stall-remedy-claim-credential-401 — a dispatch row failing for the refused claim credential binds to the credential-401 remedy', () => {
  const bound = stallRemedy(claim401);
  assert.equal(bound?.kind, 'credential-401');
  assert.equal(bound?.owner, 'master');
  assert.equal(bound?.remedy, credential401Remedy);
  assert.match(bound!.next, /credential-401/);
  assert.doesNotMatch(bound!.next, generic);
});

test('unit:stall-remedy-reviewer-launch-refused — a request-review row failing for the refused reviewer launch binds to the reviewer-identity remedy the master owns', () => {
  const reason = reviewerRefused('GY-1998', 400);
  const bound = stallRemedy(reason);
  assert.equal(bound?.kind, 'reviewer-identity');
  assert.equal(bound?.owner, 'master');
  assert.match(bound!.remedy, /reviewer identity|reviewer setup/);
  assert.match(bound!.next, /GY-2008/);
  assert.equal(stallRemedy(reviewerRefused('GY-2009', 422))?.kind, 'reviewer-identity');
  assert.equal(stallRemedy('The control plane refused the reviewer launch of GY-1 (500): unavailable'), null, '5xx stays unbound');
  assert.equal(stallRemedy('reviewer agent reviewer-a is busy in Herdr'), null);
});
