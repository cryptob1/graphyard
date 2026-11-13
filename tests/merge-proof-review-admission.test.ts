import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import { evaluate } from '../src/model-boundary/gates.js';
import { mergeCandidateHold } from '../src/merge-writer/executor.js';

const H = 'a'.repeat(40), B = 'b'.repeat(40), at = '2031-01-01T00:00:00Z';
export function admissionFixture(): Work {
  const candidate = { sha: H, baseSha: B, pr: 1, branch: 'graphyard/gy-1-1', author: 'worker' };
  return { id: 'w1', key: 'GY-1', title: 'Admission', type: 'chore', description: '', dependencies: [], ready: true,
    epoch: 1, lease: null, stage: 'review', submission: { epoch: 1, pr: 1 }, policyRevision: 1,
    policy: { checks: ['test'], review: true }, criteria: [{ id: 'AC-1', text: 'Proved', proofs: ['e2e:fixture', 'manual:checked'] },
      { id: 'AC-2', text: 'After deployment', proofs: ['manual:post-deploy/audit'] }],
    workspaces: [{ host: 'test', path: '/fixture', branch: candidate.branch, epoch: 1, owner: 'worker' }],
    candidate, evidence: [], violations: [], reworkRequested: false,
    observation: { candidate, source: 'control-plane', at, files: ['package-lock.json'], checks: [], reviews: [],
      merged: false, mergeSha: null, baseTip: B, mergeBase: B, baseTipContained: true },
    gates: ['ready', 'build', 'review', 'test', 'acceptance'].map(name => ({ name, passed: true, reasons: [] })),
    mergeLedger: { key: 'GY-1', state: 'intent', head: H, baseTip: B, mergeSha: 'c'.repeat(40),
      trial: { head: H, mergeSha: 'c'.repeat(40), proofs: { 'e2e:fixture': { executed: 1, failed: 0 } } } },
  } as unknown as Work;
}
export function approve(work: Work) {
  work.observation!.reviews = [{ reviewer: 'independent', sha: H, baseSha: B, policyRevision: 1, state: 'APPROVED', id: 5, source: 'control-plane' }];
}
export function attest(work: Work) {
  work.evidence.push({ id: 'proof', proof: 'manual:checked', sha: H, baseSha: B, policyRevision: 1, producer: 'attester', trusted: true, result: 'pass', executed: 0, skipped: 0, at });
}

test('e2e:merge-proof-review-admission refuses missing manual proof despite passing E2E and cached gates', () => {
  const work = admissionFixture(); approve(work);
  assert.match(mergeCandidateHold(work) ?? '', /manual:checked/);
  assert.equal(evaluate(work, [work], new Date(at)).gates.find(g => g.name === 'acceptance')?.passed, false);
});
test('e2e:merge-proof-review-admission refuses missing review despite cached passed gate', () => {
  const work = admissionFixture(); attest(work);
  assert.ok(mergeCandidateHold(work));
});

test('e2e:merge-proof-review-admission binds proof and review to head, diff base and policy; post-deploy stays visible', () => {
  const work = admissionFixture(); approve(work); attest(work);
  assert.equal(mergeCandidateHold(work), null);
  assert.deepEqual(work.criteria[1].proofs, ['manual:post-deploy/audit']);
  for (const field of ['sha', 'baseSha', 'policyRevision'] as const) {
    for (const kind of ['proof', 'review']) {
      const changed = structuredClone(work);
      const record = kind === 'proof' ? changed.evidence[0] : changed.observation!.reviews[0];
      Object.assign(record, { [field]: field === 'policyRevision' ? 99 : 'd'.repeat(40) });
      assert.ok(mergeCandidateHold(changed), `${kind} with wrong ${field} is refused`);
    }
  }
});

import { randomUUID } from 'node:crypto';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import type { Services } from '../src/server/routes.js';
import { recordMergeEvent } from '../src/server/merge-record.js';
import { mergeOne, mergeRecordKinds, type MergePorts, type MergeRecordEvent } from '../src/merge-writer/executor.js';
import { foldMergeLedger } from '../src/model-boundary/merge-ledger.js';
import { decideCarry } from '../src/model/carry.js';
import { reconcileReviewConflict } from '../src/model/review-conflict.js';
import { auditAdmission, auditInstalls } from '../src/merge-admission-audit.js';

test('e2e:merge-proof-review-admission actual writer never pushes missing proofs or verdicts, and keeps passing trials bounded', async () => {
  for (const missing of ['proof', 'review', 'none']) {
    const work = admissionFixture();
    if (missing !== 'proof') attest(work);
    if (missing !== 'review') approve(work);
    const events: MergeRecordEvent[] = []; let pushes = 0;
    const ports: MergePorts = {
      baseBranch: 'main', now: () => Date.parse(at), fetch: async () => B,
      merge: async () => ({ mergeSha: 'c'.repeat(40), files: ['package-lock.json'] }),
      trial: async () => ({ build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: { 'e2e:fixture': { executed: 1, failed: 0 } } }),
      push: async () => { pushes++; return 'pushed'; }, holds: async () => pushes > 0,
      hold: async selected => mergeCandidateHold(work, selected),
      record: async (_work, event) => {
        events.push(event);
        work.mergeLedger = foldMergeLedger(events.map(({ kind, ...payload }) => ({ kind: mergeRecordKinds[kind], work: work.key, payload: kind === 'intent' ? { key: work.key, ...payload } : kind === 'refused' ? { ...payload, kind: 'merge' } : payload })))[work.key];
      },
    };
    const result = await mergeOne(ports, work);
    assert.equal(pushes, missing === 'none' ? 1 : 0);
    assert.equal(result.outcome, missing === 'none' ? 'merged' : 'requeued');
  }
});

test('e2e:merge-proof-review-admission transactional push refuses missing evidence even with passed cached gates', async () => {
  const store = await withDatabase('merge-proof-review-admission'); await store.init();
  try {
    const engine = new Engine(store, 120, 'fixture/admission');
    engine.gitRunner = async () => ({ status: 0, stdout: '', stderr: '' });
    for (const missing of ['proof', 'review', 'none']) {
      const work = admissionFixture(); work.id = randomUUID(); work.key = `GY-${missing === 'proof' ? 1 : missing === 'review' ? 2 : 3}`;
      Object.assign(work, { revision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, priority: 1 });
      if (missing !== 'proof') attest(work);
      if (missing !== 'review') approve(work);
      await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
      const record = (body: unknown) => recordMergeEvent({ engine } as Services, { id: 'writer', role: 'coordinator' }, work.id, body, randomUUID());
      await record({ kind: 'intent', head: H, baseTip: B, mergeSha: 'c'.repeat(40), risk: 'sensitive', at });
      await record({ kind: 'trial', head: H, baseTip: B, mergeSha: 'c'.repeat(40), outcome: 'verdict', build: 'pass', tests: { passed: 1, failed: [], files: 1 }, files: [], proofs: { 'e2e:fixture': { executed: 1, failed: 0 } }, durationMs: 1, attempts: [] });
      const push = () => record({ kind: 'pushed', mergeSha: 'c'.repeat(40), pushedAt: at });
      if (missing === 'none') await push();
      else {
        await assert.rejects(push, /merge admission refused/);
        const rows = await store.pool.query("SELECT seq FROM events WHERE work_id=$1 AND kind='merge.pushed'", [work.id]);
        assert.equal(rows.rowCount, 0, 'refusal rolls back the history mutation');
      }
    }
  } finally { await store.close(); }
});

test('e2e:merge-proof-review-admission carried approval records its original identity, head and policy', () => {
  const work = admissionFixture(); attest(work);
  const from = { sha: 'd'.repeat(40), baseSha: 'e'.repeat(40) }, to = { sha: H, baseSha: B };
  const carry = decideCarry({ from, to, policyRevision: 1, at,
    merge: { from: from.sha, parents: [from.sha, B], authoredByApp: true, author: 'plane', conflicts: false, baseChanges: [], diff: { reviewed: 'same', tip: 'same' } },
    predecessor: { key: null, validated: true }, reviewedFiles: ['package-lock.json'], proofs: [], app: 'plane',
    approval: { provider: 'github', reviewer: 'independent', sha: from.sha, reviewId: 12 } });
  work.baseRefresh = { head: H, carry } as Work['baseRefresh'];
  assert.equal(mergeCandidateHold(work), null);
  const audit = auditAdmission(work, at);
  assert.equal(audit.carry?.from.sha, from.sha);
  assert.equal(audit.carry?.policyRevision, 1);
  assert.equal(audit.approval?.reviewId, 12);
  work.baseRefresh!.carry!.policyRevision = 2;
  assert.ok(mergeCandidateHold(work));
});

test('e2e:merge-proof-review-admission audit distinguishes absent proof from empty display and reports hwd access gaps', async () => {
  const work = admissionFixture(); approve(work); attest(work);
  assert.equal(auditAdmission(work, at).classification, 'display-only');
  reconcileReviewConflict(work, new Date(at));
  assert.equal(work.reviewVerdicts!.verdicts[0].reviewer, 'independent', 'control-plane reviewer without bot suffix appears in the stored verdict list');
  assert.equal(auditAdmission(work, at).classification, 'satisfied');
  work.evidence = [];
  assert.equal(auditAdmission(work, at).classification, 'missing-admission-evidence');
  const audit = await auditInstalls([{ name: 'hwd-backend', url: 'http://inaccessible' },
    { name: 'history-gap', url: 'http://fixture', read: async path => path === 'work-snapshot' ? { work: [{ ...work, delivery: { mergeSha: 'c'.repeat(40) } }] } : path.startsWith('events?') ? { events: [], page: {} } : work }]);
  assert.deepEqual(audit.coverage[0].requiredItems, ['GY-3', 'GY-4']);
  assert.equal(audit.coverage[0].externalBlockers.length, 1);
  assert.equal(audit.coverage[1].audited, 0);
  assert.match(audit.coverage[1].externalBlockers[0], /admission snapshot unavailable/);
});
