import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSchema, laneRequiresProof, type Work } from '../src/model.js';
import { evaluateLandability } from '../src/model/landability.js';
import { requiredProofs } from '../src/model/bootstrap.js';
import { postDeployChecks } from '../src/master-verification.js';
import { filingReason, followUpItem, followUpRequestId, type ReleaseCandidate, type UatRecord } from '../src/release-candidate.js';

// GY-1957 (same class as GY-188): a failed candidate's follow-up was born unmergeable. Its only
// criterion demanded a `manual:release-candidate-uat-pass` attestation before merge, yet that pass
// can only exist on a candidate cut after the fix merges — GY-1938 hung until a two-party
// requirements rewrite freed it. The follow-up now declares the later-candidate UAT pass a
// post-deploy verification (`manual:post-deploy/release-candidate-uat-pass`) beside a pre-merge
// criterion the head can show: the fix carries a test reproducing the failing suite. No gate is
// loosened — postDeployChecks owes the declared proof on the serving release after delivery,
// exactly as for any declared post-deploy verification (GY-1660).

const sha = 'a'.repeat(40), candidateId = 'rc-test-1', failingSuite = 'chart';
const cutAt = new Date(Date.now() - 7_200_000).toISOString();
const candidate: ReleaseCandidate = { id: candidateId, sha, cutAt, trigger: 'schedule', since: null, items: [] };
const uat: UatRecord = { id: candidateId, sha, result: 'failed', deployedSha: sha, at: new Date(Date.now() - 3_600_000).toISOString(), suites: [{ name: failingSuite, passed: false, detail: 'helm lint failed' }], followUp: null };
// The literal, not the source constant, so a tree without the change fails these cases as test cases
// (the filed payload is judged), not as an import error.
const declaredProof = 'manual:post-deploy/release-candidate-uat-pass';
const undeclaredProof = 'manual:release-candidate-uat-pass';

test('unit:release-follow-up-mergeable — a failed candidate files its follow-up mergeable: the later-candidate UAT pass declared post-deploy beside a pre-merge reproducing-test criterion, and create accepts the payload', () => {
  const item = followUpItem(candidate, uat);
  // The follow-up still names the failing suite and candidate wherever the plane shows it.
  assert.match(item.title, new RegExp(`Release candidate ${candidateId} failed UAT suite ${failingSuite} at ${sha.slice(0, 12)}`));
  assert.match(item.description, new RegExp(sha));
  assert.match(item.description, new RegExp(failingSuite));
  assert.equal(item.reason, filingReason);
  assert.deepEqual(item.criteria.map(criterion => [criterion.id, criterion.proofs]), [['AC-1', ['unit:failing-suite-reproduced']], ['AC-2', [declaredProof]]]);
  assert.match(item.criteria[0].text, new RegExp(`The fix carries a test that reproduces the failing ${failingSuite} suite of candidate ${candidateId} \\(${sha}\\)`));
  assert.match(item.criteria[1].text, new RegExp(`The ${failingSuite} suite that failed on candidate ${candidateId} \\(${sha}\\) passes against the UAT deployment of a later candidate`));
  // Create accepts the payload: no criterion refuses as a post-merge proof, an undeclared live
  // observation or an item of nothing but declared verifications (the engine's create schema is
  // this one extended with the optional operator-agent reason the filing identity demands).
  const { reason: _reason, ...created } = item;
  assert.equal(createSchema.safeParse(created).success, true, JSON.stringify(createSchema.safeParse(created)));
  // The proof rides the filing's idempotency identity: a retried filing replays the same item.
  assert.equal(followUpRequestId(candidateId), `release-candidate-follow-up:${candidateId}`);

  // The merge gate does not require the post-deploy proof before merge, in the lane an unknown
  // change rides — while the pre-merge criterion still gates, so nothing is loosened. The
  // undeclared shape the item was born with is refused: that was the bug.
  const reasons = (criteria: Work['criteria']) => {
    const work = delivered({ stage: 'acceptance', delivery: undefined, criteria });
    const verdict = evaluateLandability(work, [work], new Date());
    return verdict.verdict === 'refused' ? verdict.reasons.map(entry => entry.reason).join('\n') : '';
  };
  const declared = reasons(item.criteria);
  assert.ok(!declared.includes(declaredProof), declared);
  assert.match(declared, /AC-1: unit:failing-suite-reproduced needs trusted passing evidence/);
  assert.match(reasons([{ ...item.criteria[1], proofs: [undeclaredProof] }, item.criteria[0]]), new RegExp(`AC-2: ${undeclaredProof} needs trusted passing evidence`));
  assert.equal(laneRequiresProof('high', declaredProof), false);
  const work = delivered({ stage: 'acceptance', delivery: undefined, criteria: item.criteria });
  assert.deepEqual(requiredProofs(work, [work]).filter(proof => proof === declaredProof), []);
  assert.ok(requiredProofs(work, [work]).includes('unit:failing-suite-reproduced'));
});

test('unit:release-follow-up-still-verified — postDeployChecks owes the filed follow-up its declared UAT-pass proof on the serving release until a trusted pass is recorded after the merge', () => {
  const release = 'c'.repeat(40), mergeSha = 'd'.repeat(40);
  const criteria = followUpItem(candidate, uat).criteria;
  const checks = postDeployChecks(delivered({ criteria }), release);
  assert.equal(checks.length, 1, 'only the declared proof is a post-deploy check');
  const [owed] = checks;
  assert.deepEqual([owed.criterion, owed.proof, owed.result], ['AC-2', declaredProof, 'owed']);
  const followUp = owed.followUp!;
  assert.equal(followUp.title, `Post-deploy verification of GY-1957 AC-2 (release-candidate-uat-pass) on release ${release.slice(0, 12)}`);
  assert.deepEqual(followUp.input.dependencies, ['e4b2a3c8-1c0e-4d0a-9b4e-1f2a3b4c5d6e']);
  // The verification follow-up carries the filed criterion's outcome: it names the failing suite and candidate.
  assert.match(followUp.input.criteria[0].text, new RegExp(`The ${failingSuite} suite that failed on candidate ${candidateId} \\(${sha}\\) passes against the UAT deployment of a later candidate`));
  // A trusted pass is the observation only recorded after the merge, at the serving release, against its base.
  const pass = { id: 'e1', proof: declaredProof, sha: release, baseSha: mergeSha, policyRevision: 1, producer: 'release-producer', trusted: true, result: 'pass' as const, executed: 1, skipped: 0, at: new Date().toISOString() };
  const before = new Date(Date.parse(delivered({ criteria }).delivery!.mergedAt) - 60_000).toISOString();
  assert.equal(postDeployChecks(delivered({ criteria, evidence: [{ ...pass, at: before }] }), release)[0].result, 'owed', 'evidence recorded before the merge observes nothing');
  assert.equal(postDeployChecks(delivered({ criteria, evidence: [{ ...pass, baseSha: 'e'.repeat(40) }] }), release)[0].result, 'owed', 'evidence against another base observes nothing');
  assert.deepEqual(postDeployChecks(delivered({ criteria, evidence: [pass] }), release).map(check => [check.result, check.followUp]), [['observed', null]]);
  // A failing record at the serving release is no observation: the follow-up stays owed.
  assert.equal(postDeployChecks(delivered({ criteria, evidence: [{ ...pass, result: 'fail' as const }] }), release)[0].result, 'owed');
});

/** A delivered item carrying the follow-up's criteria (the fixture tests/post-deploy-criteria.test.ts files against). */
function delivered(overrides: Partial<Work> = {}): Work {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return { id: 'e4b2a3c8-1c0e-4d0a-9b4e-1f2a3b4c5d6e', key: 'GY-1957', title: `Release candidate ${candidateId} failed UAT`, description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'A test covers it', proofs: ['unit:covered'] }], policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'done', revision: 3, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [], candidate: null,
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], delivery: { mergedAt: at, mergeSha: 'd'.repeat(40), authorizationRevision: 2 }, ...overrides } as Work;
}
