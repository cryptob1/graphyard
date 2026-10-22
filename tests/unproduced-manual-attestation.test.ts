import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, type Work } from '../src/model.js';
import { actionAccount, humanNeededActions } from '../src/model/next-action.js';
import { unproducedManualProofs } from '../src/model/unproduced-attestation.js';
import { stalledItems } from '../src/model/action-account.js';

// GY-521, 2026-09-26: GY-374 (manual:fault-class-configuration) and GY-393 sat in acceptance for over
// two hours with an approved review and passing CI. No producer session may run their proof, so only
// a two-party attestation satisfies it — and the loop logged a human step every cycle and requested nothing.

const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const proof = 'manual:fault-class-configuration';
const sha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
const refusal = `AC-1: ${proof} needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy`;

function item(head = sha, overrides: Partial<Work> = {}): Work {
  const candidate = { pr: 374, sha: head, baseSha };
  return {
    id: 'work-374', key: 'GY-374', title: 'Fault class: configuration', description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'The configuration fault class no longer recurs', proofs: [proof] }], producerProofs: [],
    policy: { checks: ['test'], review: true }, stage: 'acceptance', revision: 20, policyRevision: 2,
    createdAt: iso(-3 * 60 * 60_000), updatedAt: iso(0), stageEnteredAt: iso(-2 * 60 * 60_000), ready: true, epoch: 1, lease: null, workspaces: [],
    submission: { epoch: 1, pr: 374, sha: head }, candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [],
    observation: { at: iso(-30_000), candidate, prState: 'open', draft: false, mergeable: true, protected: true, checks: [], reviews: [] },
    gates: [
      { name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] },
      { name: 'test', passed: true, reasons: [] }, { name: 'acceptance', passed: false, reasons: [refusal] }, { name: 'merge', passed: true, reasons: [] },
    ],
    autoDispatch: { review: null, producers: [], history: [] }, ...overrides,
  } as unknown as Work;
}

test('unit:unproduced-manual-proof-owned-by-loop — an unproduced manual proof is never a human step: re-evaluated it gates nothing, and a stored request is still the loop\'s', () => {
  const work = item(), now = new Date(clock);
  assert.deepEqual(unproducedManualProofs(work, [work], now), [proof]);
  // GitHub delivery is the only mode (GY-1235): re-evaluated, the record carries no acceptance gate,
  // so the unproduced proof holds nothing and nobody — person or loop — is owed a step for it.
  const result = evaluate(work, [work], now);
  assert.equal(result.gates.some(gate => gate.name === 'acceptance'), false, 'no acceptance gate');
  const current = { ...work, stage: result.stage, gates: result.gates } as Work;
  assert.deepEqual(unproducedManualProofs(current, [current], now), [], 'nothing waits on the proof');
  const account = actionAccount(current, [current], now);
  assert.notEqual(account.action?.kind, 'attention', 'no escalation to a person');
  const stored = { ...current, nextAction: account.action } as Work;
  assert.deepEqual(humanNeededActions([stored], now), []);
  assert.deepEqual(stalledItems([stored], now, 0), []);
  // What stays a person's: a producer-runnable manual proof, a failed attestation, and anything else still refusing.
  assert.deepEqual(unproducedManualProofs(item(sha, { producerProofs: [proof] } as Partial<Work>), [], now), []);
  const failed = item(sha, { evidence: [{ proof, result: 'fail', executed: 1, skipped: 0, sha, baseSha, policyRevision: 2, trusted: true, producer: 'graphyard-approver', at: iso(-60_000) }] } as unknown as Partial<Work>);
  assert.deepEqual(unproducedManualProofs(failed, [failed], now), []);
  const mixed = item(sha, { gates: item().gates.map(gate => gate.name === 'acceptance' ? { ...gate, reasons: [refusal, 'AC-2: unit:other needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy'] } : gate) } as Partial<Work>);
  assert.deepEqual(unproducedManualProofs(mixed, [mixed], now), []);
  const unreviewed = item(sha, { gates: item().gates.map(gate => gate.name === 'review' ? { ...gate, passed: false, reasons: ['Independent approval of the current commit is required'] } : gate) } as Partial<Work>);
  assert.deepEqual(unproducedManualProofs(unreviewed, [unreviewed], now), []);
});
