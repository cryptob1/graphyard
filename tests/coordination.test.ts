import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, fileConflicts, proofPreview, resourceConflicts } from '../src/coordination.js';
import type { Work } from '../src/model.js';
const now = Date.parse('2026-01-01T00:10:00Z');
function work(id: string): Work {
  return { id, key: id, stage: 'ready', ready: true, plannedFiles: [], dependencies: [], lease: null, workspaces: [], submission: null, evidence: [], scenarioRequirements: [], criteria: [{ id: 'AC-1', text: 'Actual result', proofs: ['integration:result'] }], policyRevision: 2, candidate: { sha: 'a', baseSha: 'b' }, gates: [], violations: [] } as unknown as Work;
}
test('overlap includes actual diffs and directory scopes, excludes siblings and completed work', () => {
  const a = work('A'), b = work('B'); a.plannedFiles = ['src/api/', 'docs/*']; b.observation = { files: ['src/api/create.ts'] } as any;
  assert.deepEqual(fileConflicts(a, [a, b]), [{ key: 'B', paths: ['src/api/'] }]);
  b.observation!.files = ['src/apis/create.ts']; assert.deepEqual(fileConflicts(a, [a, b]), []);
  b.plannedFiles = ['docs/guide.md']; assert.equal(fileConflicts(a, [a, b]).length, 1);
  b.stage = 'done'; assert.deepEqual(fileConflicts(a, [a, b]), []);
});
test('proof preview refuses stale, untrusted, skipped and later failed evidence', () => {
  const w = work('A'); assert.equal(proofPreview(w)[0].status, 'unmeasured');
  const proof = { proof: 'integration:result', sha: 'a', baseSha: 'b', policyRevision: 2, trusted: true, result: 'pass', executed: 1, skipped: 0 } as const;
  w.evidence.push({ ...proof, trusted: false } as any); assert.equal(proofPreview(w)[0].status, 'unmeasured');
  w.evidence.push({ ...proof, policyRevision: 1 } as any); assert.equal(proofPreview(w)[0].status, 'unmeasured');
  w.evidence.push(proof as any); assert.equal(proofPreview(w)[0].status, 'passed');
  w.evidence.push({ ...proof, skipped: 1 } as any); assert.equal(proofPreview(w)[0].status, 'incomplete');
  w.evidence.push({ ...proof, result: 'fail' } as any); assert.equal(proofPreview(w)[0].status, 'failed');
});
test('diagnostics distinguish expired ownership, resource waits and a stalled integration', () => {
  const a = work('A'), b = work('B'); a.lastAssignment = { owner: 'old', epoch: 1 }; a.exclusiveResources = b.exclusiveResources = ['staging'];
  b.lease = { owner: 'other', epoch: 1, expiresAt: new Date(now + 60000).toISOString() };
  let result = diagnose(a, [a,b], now); assert.ok(result.some(d => d.kind === 'unowned-after-assignment')); assert.ok(result.some(d => d.kind === 'resource-busy'));
  a.submission = { epoch: 1, pr: 1 }; result = diagnose(a, [a,b], now, [{ work_id: 'A', available_at: new Date(now - 180000).toISOString(), locked_until: null, error: null }]);
  assert.ok(result.some(d => d.kind === 'unobserved')); assert.ok(result.some(d => d.kind === 'reconciliation-stalled'));
  a.stage = 'done'; assert.deepEqual(diagnose(a, [a,b], now), []);
});

test('completed work retains its resource reservation until its last lease expires', () => {
  const a = work('A'), b = work('B'); a.exclusiveResources = b.exclusiveResources = ['staging'];
  b.stage = 'done'; b.lease = { owner: 'last-worker', epoch: 1, expiresAt: new Date(now + 60000).toISOString() };
  assert.deepEqual(resourceConflicts(a, [a, b], now), [{ resource: 'staging', key: 'B' }]);
  assert.deepEqual(resourceConflicts(a, [a, b], now + 60000), []);
});

test('quarantined work retains every resource reservation after lease expiry', () => {
  const candidate = work('A'), quarantined = work('B');
  candidate.exclusiveResources = ['staging', 'database']; quarantined.exclusiveResources = ['staging', 'database'];
  quarantined.lease = { owner: 'old-worker', epoch: 3, expiresAt: new Date(now - 60000).toISOString() };
  quarantined.containmentQuarantine = { owner: 'old-worker', epoch: 3, at: new Date(now - 120000).toISOString(), settlementHash: 'a'.repeat(64) };
  assert.deepEqual(resourceConflicts(candidate, [candidate, quarantined], now), [
    { resource: 'staging', key: 'B' },
    { resource: 'database', key: 'B' },
  ]);
  candidate.exclusiveResources = ['unrelated'];
  assert.deepEqual(resourceConflicts(candidate, [candidate, quarantined], now), []);
});
