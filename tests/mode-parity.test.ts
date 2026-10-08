import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { regressionRefusals } from '../src/regression-guard.js';
import { evaluateLandability } from '../src/model/landability.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { reworkGround } from '../src/model/rework-ground.js';
import { foldMergeLedger, mergeTrialKind } from '../src/model/merge-ledger.js';
import { reworkWaitsForApprover } from '../src/server/lane-rework.js';
import type { Observation, Work } from '../src/model/work.js';

// GY-1528: mode parity. One fixture item runs through submit (the plannedFiles check the engine's
// submit applies), evaluate (the landability verdict), dispatch (the auto-dispatch reconciliation)
// and rework-ground (the ground and whether an approver is needed). Under the github merger its
// outputs equal the snapshot recorded on this head, so the old gates stay exactly as they were
// until their code is deleted; under the control-plane merger each switched behaviour is named.

const at = Date.parse('2030-06-01T00:00:00Z');
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const head = sha('parity-head'), base = sha('parity-base');

function fixture(source: 'control-plane' | null): Work {
  const candidate = { sha: head, baseSha: base, pr: 7, branch: 'graphyard/gy-1-1', author: 'worker' };
  const scoped = (path: string) => ({ path, status: 'modified' as const, sha: sha(path), baseSha: sha(`base:${path}`), additions: 1, deletions: 1, binary: false });
  const observation = { ...(source ? { source } : {}), candidate, checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [], merged: false, mergeSha: null,
    mergeable: true, protected: true, files: ['src/app.ts', 'src/other.ts'], at: new Date(at).toISOString(), baseTip: base, scopeFiles: ['src/app.ts', 'src/other.ts'].map(scoped) } as unknown as Observation;
  const ledger = foldMergeLedger([
    { kind: 'merge.intent', payload: { key: 'GY-1', head, baseTip: base, mergeSha: sha('parity-merge'), risk: 'normal', at: new Date(at).toISOString() } },
    { kind: mergeTrialKind, payload: { head, baseTip: base, mergeSha: sha('parity-merge'), proofs: { 'unit:item-works': { executed: 3, failed: 0 }, 'integration:item-holds': { executed: 1, failed: 0 } } } },
  ])['GY-1'];
  return {
    id: 'parity', key: 'GY-1', title: 'parity fixture', type: 'feature', description: '', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works', 'integration:item-holds', 'manual:item-looks', 'e2e:item-ships'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/app.ts'], stage: 'build', revision: 3, policyRevision: 1, ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'h', path: '/w', branch: 'graphyard/gy-1-1', epoch: 1, owner: 'worker' }], submission: { epoch: 1, pr: 7 }, candidate, reworkRequested: false,
    scenarioRequirements: [], blocker: null, gates: [], violations: [], createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(), stageEnteredAt: new Date(at).toISOString(),
    evidence: [{ id: 'e1', proof: 'unit:item-works', result: 'fail', trusted: true, executed: 3, skipped: 0, failed: 1, producer: 'producer-a', sha: head, baseSha: base, policyRevision: 1, at: new Date(at).toISOString() }],
    autoDispatch: { review: null, history: [], producers: [{ id: 'p1', kind: 'producer', group: 'unit', proofs: ['integration:item-holds'], sha: head, baseSha: base, policyRevision: 1, requestedAt: new Date(at).toISOString(), state: 'requested', reason: 'prove it' }] },
    observation, mergeLedger: ledger,
  } as unknown as Work;
}

/** The fixture through the four steps, as plain data. */
function run(source: 'control-plane' | null) {
  const work = fixture(source), now = new Date(at);
  const submit = regressionRefusals(work, work.observation!, [work]);
  const verdict = evaluateLandability(work, [work], now);
  const evaluate = verdict.verdict === 'refused' ? verdict.reasons : [];
  const dispatched = structuredClone(work);
  const dispatch = reconcileAutoDispatch(dispatched, [dispatched], now).map(entry => ({ event: entry.event, kind: entry.request.kind, resolution: entry.request.resolution ?? null }));
  return { submit, evaluate, dispatch, producers: dispatched.autoDispatch!.producers.length, ground: reworkGround(work, [], now), approver: reworkWaitsForApprover(work) };
}

/** The github-mode outputs, recorded on this head (GY-1528). */
const recorded = {
  submit: [
    'Candidate changes 1 file outside its planned files that must match the base branch byte-for-byte; run graphyard sync GY-1, restore each file from origin/<base>, and push again',
    `Out-of-scope regression: src/other.ts: differs from the base branch tip (+1 −1) (no delivered work item claims this path)`,
  ],
  evaluate: [
    { gate: 'build', reason: 'Candidate changes 1 file outside its planned files that must match the base branch byte-for-byte; run graphyard sync GY-1, restore each file from origin/<base>, and push again' },
    { gate: 'build', reason: 'Out-of-scope regression: src/other.ts: differs from the base branch tip (+1 −1) (no delivered work item claims this path)' },
    { gate: 'build', reason: `AC-1: unit:item-works failed on ${head.slice(0, 12)} (trusted evidence from producer-a); the head returns to its worker before review` },
    { gate: 'acceptance', reason: 'AC-1: unit:item-works needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy' },
    { gate: 'acceptance', reason: 'AC-1: integration:item-holds needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy' },
    { gate: 'acceptance', reason: 'AC-1: e2e:item-ships needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy' },
  ],
  dispatch: [
    { event: 'dispatch.requested', kind: 'review', resolution: null },
    { event: 'dispatch.satisfied', kind: 'producer', resolution: 'trusted evidence failed for unit:item-works (producer-a); the next head is requested afresh' },
  ],
  producers: 0,
  ground: `a trusted proof failed on candidate ${head.slice(0, 12)} (unit:item-works)`,
  approver: false,
};

test('unit:mode-parity-github-snapshot — under the github merger the fixture\'s submit, evaluate, dispatch and rework-ground outputs equal the snapshot recorded on this head; under the control-plane merger each switched behaviour is named', () => {
  assert.deepEqual(run(null), recorded);
  const switched = run('control-plane');
  const named: Record<string, boolean> = {
    'plannedFiles and scope refusals: the submit refuses nothing': switched.submit.length === 0 && !switched.evaluate.some(entry => /planned files/.test(entry.reason)),
    'producer evidence: the stray producer failure refuses no build': !switched.evaluate.some(entry => /trusted evidence from/.test(entry.reason)),
    'acceptance from the merge ledger trial: unit and integration proofs pass on its counts': !switched.evaluate.some(entry => /unit:|integration:/.test(entry.reason)),
    'manual attestations only for sensitive risk, e2e deferred': !switched.evaluate.some(entry => /manual:|e2e:/.test(entry.reason)),
    'producer sessions: the standing request is withdrawn and none is opened': switched.producers === 0 && switched.dispatch.filter(entry => entry.kind === 'producer').every(entry => entry.event === 'dispatch.cancelled'),
    'normal-risk rework approver: none is needed': switched.approver === false,
  };
  for (const [behaviour, holds] of Object.entries(named)) assert.ok(holds, `control-plane switches off ${behaviour}: ${JSON.stringify(switched)}`);
  assert.equal(switched.ground, recorded.ground, 'the rework ground reads the record the same in both modes');
});
