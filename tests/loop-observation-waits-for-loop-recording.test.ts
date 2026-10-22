import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dispatchable } from '../src/coordination.js';
import { actionAccount, nextAction } from '../src/model/next-action.js';
import { reconcileActions } from '../src/model/actions.js';
import { livenessFallback } from '../src/model/liveness.js';
import { closeSchema, closureRefRefusal } from '../src/model/closure.js';
import * as model from '../src/model.js';
import type { Work } from '../src/model.js';

// GY-1779: a loop-owned observation item whose reading is due waits on the loop's own recording — kind
// window, on the loop — and never produces an escalate action with trigger operator-proof; an unsubmitted
// pre-GY-1762 worker candidate left in build (GY-1725, #1172) waits the same way; and only the loop's
// recorded reading, bound to the release it was taken on, ends the wait.
const loopObservation = (work: Work, at: Date, all: Work[] = []) => (model as unknown as { loopObservation: (work: Work, at: Date, all: Work[]) => { due: boolean; waitingFor: string } | null }).loopObservation(work, at, all);
const hour = 3_600_000, now = Date.parse('2026-10-13T12:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const filed = sha('a'), serving = sha('b'), mergeSha = sha('c');
const proof = 'manual:post-deploy/github-budget-attention-row-clears', own = 'manual:github-budget-attention-row-clears-on-serving-release';
const parent = { id: '11111111-1111-4111-8111-111111111111', key: 'GY-1700', stage: 'done', policy: { checks: [], review: true }, delivery: { mergeSha, mergedAt: iso(now - 50 * hour), deployment: { sha: filed, mergeSha, source: 'endpoint', observedAt: iso(now - 40 * hour), covers: 'descendant', at: iso(now - 40 * hour), observer: 'graphyard-master' } }, criteria: [{ id: 'AC-3', text: 'The github-budget row clears for 24h', proofs: [proof] }] } as unknown as Work;
const item = (n: number, extra: Partial<Work> = {}): Work => ({
  id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, key: `GY-${n}`, title: `Observation ${n}`, description: `Post-deploy follow-up: post-deploy:${parent.id}:AC-3:${proof}:${filed}\n\nowed`, type: 'chore', priority: 1, stage: 'ready', ready: true, epoch: 0, revision: 5, policyRevision: 1,
  createdAt: iso(now - 40 * hour), updatedAt: iso(now - 30 * hour), stageEnteredAt: iso(now - 30 * hour), lease: null, lastAssignment: null, systemDriven: true,
  workspaces: [], sessions: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], 
  criteria: [{ id: 'AC-1', text: 'The row clears and does not re-fire during 24h', proofs: [own] }], policy: { checks: ['test', 'typecheck'], review: true }, dependencies: [],
  observationWindow: { notBefore: iso(now - hour), basis: 'criterion-window', detail: 'the 24-hour live window ran' },
  gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }],
  ...extra,
}) as unknown as Work;
const reading = (extra: object = {}) => ({ id: 'r1', proof: own, trusted: true, result: 'pass', policyRevision: 1, sha: serving, baseSha: mergeSha, executed: 1, skipped: 0, at: iso(now - 600_000), producer: 'graphyard-master', reading: { detail: 'no github-budget row in 24h' }, ...extra });

test('unit:loop-observation-waits-for-loop-recording — a due reading is a window wait on the loop, never an operator-proof escalation, for a ready item and for one left in build with an unsubmitted worker candidate', () => {
  const due = item(1724), windowed = item(1728, { observationWindow: { notBefore: iso(now + 6 * hour), basis: 'criterion-window', detail: 'later' } });
  const inBuild = item(1725, { stage: 'build', epoch: 3, candidate: { pr: 1172, sha: sha('d'), baseSha: sha('e'), author: 'graphyard-cryptob1-graphyard[bot]', branch: 'graphyard/gy-1725-3', createdAt: iso(now - 5 * hour) } } as Partial<Work>);
  const all = [parent, due, windowed, inBuild];
  for (const work of [due, inBuild]) {
    assert.equal(loopObservation(work, new Date(now), all)?.due, true);
    const account = actionAccount(work, all, new Date(now));
    assert.equal(account.action, null, `${work.key} names no action`);
    assert.deepEqual([account.wait?.kind, account.wait?.on], ['window', 'loop'], `${work.key} waits on the loop`);
    assert.match(account.wait!.detail, /the loop records it in its deployment-verification step, and no worker is dispatched/);
    assert.equal(nextAction(work, all, new Date(now)), null);
    assert.equal(dispatchable(work, now), false);
    const queued = { ...work, actionQueue: { actions: [], history: [] } } as Work;
    assert.ok(reconcileActions(queued, [parent, queued], new Date(now)).every(entry => entry.action.kind !== 'attention' && entry.action.kind !== 'dispatch'), `${work.key} queues no escalation and no dispatch`);
    // The liveness fallback owns the wait to the loop: it is due a bound ahead of every evaluation, never a stale wait.
    assert.equal(livenessFallback(work, all, new Date(now)), null);
    assert.equal(livenessFallback(work, all, new Date(now + 48 * hour)), null);
  }
  // Before its instant the wait is the same wait, on the loop, naming when the reading can first exist.
  const early = actionAccount(windowed, all, new Date(now));
  assert.deepEqual([early.action, early.wait?.kind, early.wait?.on], [null, 'window', 'loop']);
  assert.match(early.wait!.detail, new RegExp(`can first exist at ${iso(now + 6 * hour)}`));
  // The recorded pass ends the reading's wait; the still-open item waits on the loop's close in the same step — by the loop's own pass or one recorded by hand — never an operator-proof escalation.
  const read = item(1726, { evidence: [reading()] as never });
  assert.equal(loopObservation(read, new Date(now), all), null);
  const closing = actionAccount(read, [parent, read], new Date(now));
  assert.deepEqual([closing.action, closing.wait?.kind, closing.wait?.on], [null, 'window', 'loop']);
  assert.match(closing.wait!.detail, /GY-1726's reading of manual:github-budget-attention-row-clears-on-serving-release passed on release bbbbbbbbbbbb and the item is still open; the loop closes it as delivered-observation in its deployment-verification step, and no worker is dispatched/);
  assert.equal(nextAction(read, [parent, read], new Date(now)), null);
  assert.equal(dispatchable(read, now), false);
  const queuedRead = { ...read, actionQueue: { actions: [], history: [] } } as Work;
  assert.ok(reconcileActions(queuedRead, [parent, queuedRead], new Date(now + 48 * hour)).every(entry => entry.action.kind !== 'attention' && entry.action.kind !== 'dispatch'), 'a recorded pass queues no escalation and no dispatch, however long it stays open');
  assert.equal(livenessFallback(read, [parent, read], new Date(now + 48 * hour)), null);
});

test('unit:loop-observation-waits-for-loop-recording — only the loop\'s recorded reading ends the wait: bound to the filed release, or marked as the loop\'s on the later release the control plane serves; a worker\'s attestation on its own candidate does not', async () => {
  // Imported at call time so the base tree, which lacks the refusal, fails this case rather than the file.
  const { deliveredObservationRefusal } = await import('../src/model/loop-observation.js') as unknown as { deliveredObservationRefusal: (work: Work, all: Work[], ref: string, now: Date) => string | null };
  const all = [parent];
  const wait = (evidence: object[]) => loopObservation(item(1725, { evidence } as never), new Date(now), all);
  assert.equal(wait([reading()]), null, 'the loop\'s reading on the serving release');
  assert.equal(wait([reading({ sha: filed, reading: undefined })]), null, 'a reading on the filed release');
  assert.ok(wait([reading({ reading: undefined })]), 'an unmarked record on another release is not the loop\'s reading');
  assert.ok(wait([reading({ sha: sha('d'), baseSha: sha('e'), reading: undefined, attestation: { decision: 'x', approvedBy: 'approver', requestedBy: 'operator' } })]), 'GY-1725\'s attestation on candidate 5708562d, bound to its own base, never ended the wait');
  assert.ok(wait([reading({ baseSha: sha('e') })]), 'a reading off the parent\'s merge');
  assert.ok(wait([reading({ result: 'fail' })]), 'a failed reading');
  assert.ok(wait([reading(), reading({ id: 'r2', result: 'fail', at: iso(now - 60_000) })]), 'a later failed reading withdraws the pass');
  assert.equal(wait([reading({ result: 'fail' }), reading({ id: 'r2', at: iso(now - 60_000) })]), null, 'a later pass ends the wait a failed reading left standing');
  // The closure a passing reading ends in names the release it was read on.
  assert.deepEqual(closeSchema.parse({ kind: 'delivered-observation', reason: 'read', ref: serving }).kind, 'delivered-observation');
  assert.throws(() => closeSchema.parse({ kind: 'delivered-observation', reason: 'read', ref: null }), /names the release its reading was taken on/);
  assert.equal(closureRefRefusal(item(1725), [item(1725)], 'delivered-observation', serving), null);
  assert.match(closureRefRefusal(item(1725), [item(1725)], 'delivered-observation', 'GY-1700') ?? '', /names the release commit its reading was taken on/);
  // The kind is no client-controlled lifecycle transition: only a loop-owned item with a recorded passing reading closes, and only on the release it was read on.
  const at = new Date(now), closable = (evidence: object[], ref = serving) => deliveredObservationRefusal(item(1725, { evidence } as never), all, ref, at);
  assert.equal(closable([reading()]), null);
  assert.match(closable([]) ?? '', /GY-1725 carries no passing reading of manual:github-budget-attention-row-clears-on-serving-release as the loop reads one/);
  assert.match(closable([reading({ result: 'fail' })]) ?? '', /carries no passing reading/);
  assert.match(closable([reading(), reading({ id: 'r2', result: 'fail', at: iso(now - 60_000) })]) ?? '', /carries no passing reading/);
  assert.match(closable([reading()], filed) ?? '', /passing reading was taken on release bbbbbbbbbbbb, not aaaaaaaaaaaa/);
  const code = item(1727, { criteria: [{ id: 'AC-1', text: 'Code', proofs: ['unit:code'] }], evidence: [reading({ proof: 'unit:code' })] } as never);
  assert.match(deliveredObservationRefusal(code, all, serving, at) ?? '', /GY-1727 is not a loop-owned observation item/);
});

