import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BaseRefresh } from '../src/merge-queue.js';
import { carriedApproval, carryRefusal, currentCarry, decideCarry, evidenceBindsCandidate, refreshedCarriedApproval, type CarryInput, type Evidence, type Observation, type TipMerge, type Work } from '../src/model.js';
import { assertReviewCandidate } from '../src/reviewer.js';
import { diagnose } from '../src/coordination.js';

// Each test is named for the proof it produces, so acceptance evidence maps to one executed
// case per required proof.
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), B = sha40('b1'), P = sha40('c1'), TIP = sha40('d1');
const at = '2026-09-19T08:00:00.000Z';
const authored = (overrides: Partial<TipMerge> = {}): TipMerge => ({ from: H, parents: [H, P], author: 'graphyard[bot]', authoredByApp: true, conflicts: false, baseChanges: ['src/other.ts', 'docs/other.md'], ...overrides });
const evidenceRecord = (proof: string, overrides: Partial<Evidence> = {}): Evidence => ({ id: `ev-${proof}`, proof, sha: H, baseSha: B, policyRevision: 1, producer: 'ci-runner', trusted: true, result: 'pass', executed: 3, skipped: 0, at, ...overrides });
function input(overrides: Partial<CarryInput> = {}): CarryInput {
  return { from: { sha: H, baseSha: B }, to: { sha: TIP, baseSha: P }, policyRevision: 1, at, merge: authored(), predecessor: { key: 'GY-1', validated: true },
    reviewedFiles: ['src/queue.ts', 'tests/queue.test.ts'], approval: { provider: 'github', reviewer: 'reviewer[bot]', sha: H, reviewId: 900 },
    proofs: [{ proof: 'unit:queue', evidence: evidenceRecord('unit:queue', { scopeFiles: ['src/queue.ts', 'tests/'] }) }, { proof: 'integration:docs', evidence: evidenceRecord('integration:docs', { id: 'ev-docs', scopeFiles: ['docs/'] }) }, { proof: 'manual:unscoped', evidence: evidenceRecord('manual:unscoped', { id: 'ev-manual' }) }, { proof: 'e2e:missing', evidence: undefined }],
    app: 'graphyard', ...overrides };
}
const states = (carry: ReturnType<typeof decideCarry>) => [carry.approval.carried, ...carry.evidence.map(entry => entry.carried)];
/** The base refresh that brought approved head H on B onto base P as Graphyard-authored TIP, with its carry decision. */
const refreshed = (carry: ReturnType<typeof decideCarry>): BaseRefresh => ({ from: { sha: H, baseSha: B }, base: P, baseTree: sha40('7e'), policyRevision: 1, at, head: TIP, conflict: null, merge: authored(), carry });

test('unit:queue-authored-tip-carry — approval and scope-disjoint evidence carry to a Graphyard-authored two-parent tip over the approved head and a validated predecessor', () => {
  const carry = decideCarry(input());
  assert.equal(carry.approval.carried, true);
  assert.deepEqual({ ...carry.approval, reason: undefined }, { carried: true, provider: 'github', reviewer: 'reviewer[bot]', sha: H, reviewId: 900, originalSha: H, reason: undefined });
  assert.match(carry.approval.reason, /GY-1 changed none of the 2 reviewed files/);
  assert.deepEqual(carry.evidence.map(entry => [entry.proof, entry.carried]), [['unit:queue', true], ['integration:docs', false], ['manual:unscoped', false], ['e2e:missing', false]]);
  assert.equal(carry.evidence[0].evidenceId, 'ev-unit:queue');
  assert.match(carry.evidence[1].reason, /changed docs\/other\.md inside the scope of evidence ev-docs; fresh evidence/);
  assert.match(carry.evidence[2].reason, /declares no scopeFiles, so its independence .* cannot be shown/);
  assert.match(carry.evidence[3].reason, /no trusted evidence was bound to the replaced head/);
  assert.deepEqual([carry.from, carry.to, carry.predecessor, carry.changedFiles], [{ sha: H, baseSha: B }, { sha: TIP, baseSha: P }, 'GY-1', ['src/other.ts', 'docs/other.md']]);
  // A predecessor that changed nothing relative to the bound base leaves the tested tree untouched.
  const untouched = decideCarry(input({ merge: authored({ baseChanges: [] }) }));
  assert.deepEqual(states(untouched), [true, true, true, true, false]);
  // The base branch itself is a validated predecessor.
  assert.equal(decideCarry(input({ predecessor: { key: null, validated: true } })).approval.carried, true);
});

test('unit:queue-authored-tip-carry — every refusal case requires fresh review and evidence, with the reason recorded', () => {
  const refused = (overrides: Partial<CarryInput>, pattern: RegExp) => {
    const carry = decideCarry(input(overrides));
    assert.deepEqual(states(carry), [false, false, false, false, false], pattern.source);
    assert.match(carry.approval.reason, pattern); for (const entry of carry.evidence) assert.match(entry.reason, pattern);
    assert.match(carryRefusal(input(overrides))!, pattern);
  };
  refused({ merge: null }, /was not produced by Graphyard's merge of the approved head/);
  refused({ merge: authored({ from: sha40('a9') }) }, /was not produced by Graphyard's merge of the approved head/);
  refused({ merge: authored({ parents: [H, P, sha40('e1')] }) }, /carries commits Graphyard did not produce/);
  refused({ merge: authored({ parents: [sha40('a9'), P] }) }, /rather than exactly the approved head/);
  refused({ merge: authored({ parents: [H] }) }, /carries commits Graphyard did not produce/);
  refused({ merge: authored({ authoredByApp: false, author: 'worker' }) }, /authored by worker, not by the graphyard App/);
  refused({ merge: authored({ conflicts: true }) }, /needed conflict resolution/);
  refused({ predecessor: { key: 'GY-1', validated: false } }, /predecessor GY-1 is not fully validated/);
  refused({ merge: authored({ baseChanges: null }) }, /could not be listed completely/);
  assert.equal(carryRefusal(input()), null);
  // Scope intersection is decided per binding: a touched reviewed file requires a fresh approval
  // while a disjoint proof still carries, and the other way round.
  const reviewed = decideCarry(input({ merge: authored({ baseChanges: ['src/queue.ts'] }) }));
  assert.equal(reviewed.approval.carried, false); assert.match(reviewed.approval.reason, /GY-1 changed reviewed files src\/queue\.ts; a fresh independent approval/);
  assert.deepEqual(reviewed.evidence.map(entry => entry.carried), [false, true, false, false], 'the proof scoped to the touched file is re-required; the docs proof carries');
  const unapproved = decideCarry(input({ approval: null }));
  assert.equal(unapproved.approval.carried, false); assert.match(unapproved.approval.reason, /no approval was bound to the replaced head/);
  assert.equal(unapproved.evidence[0].carried, true);
});

test('unit:queue-authored-tip-carry — a carried binding applies only to the exact refreshed head and policy it was decided for, and only for the policy\'s provider', () => {
  const carry = decideCarry(input());
  const work = { candidate: { sha: TIP, baseSha: P, pr: 2, branch: 'graphyard/gy-2-1', author: 'worker' }, policyRevision: 1, policy: { checks: ['test'], review: true }, baseRefresh: refreshed(carry) } as unknown as Work;
  assert.equal(currentCarry(work), carry);
  assert.equal(carriedApproval(work)?.reviewer, 'reviewer[bot]');
  assert.equal(evidenceBindsCandidate(work, evidenceRecord('unit:queue')), true, 'the carried record binds the tip');
  assert.equal(evidenceBindsCandidate(work, evidenceRecord('integration:docs', { id: 'ev-docs' })), false, 'a re-required record does not');
  assert.equal(evidenceBindsCandidate(work, evidenceRecord('unit:queue', { id: 'ev-later' })), false, 'only the exact record the decision named');
  assert.equal(evidenceBindsCandidate(work, evidenceRecord('unit:queue', { sha: TIP, baseSha: P })), true, 'an exact binding always applies');
  assert.equal(currentCarry({ ...work, policyRevision: 2 }), null, 'a policy revision invalidates the carry');
  assert.equal(currentCarry({ ...work, candidate: { ...work.candidate!, sha: sha40('e9') } }), null, 'another head is not the tip');
  assert.equal(carriedApproval({ ...work, policy: { ...work.policy, reviewProvider: 'codex' } }), null, 'a GitHub approval is not a Codex verdict');
  const agent = { ...work, policy: { checks: ['test'], review: true, reviewProvider: 'agent', reviewerProfiles: [{ name: 'claude', runtime: 'claude', reviewerApp: 'claude-app', timeoutSeconds: 1800 }] },
    baseRefresh: refreshed({ ...carry, approval: { ...carry.approval, provider: 'agent', reviewerApp: 'claude-app' } as typeof carry.approval }) } as unknown as Work;
  assert.equal(carriedApproval(agent)?.reviewerApp, 'claude-app');
  assert.equal(carriedApproval({ ...agent, policy: { ...agent.policy, reviewerProfiles: [{ name: 'cursor', runtime: 'cursor', reviewerApp: 'cursor-app', timeoutSeconds: 1800 }] } } as Work), null, 'an agent approval carries only for the profile still dispatched');
});

test('unit:queue-real-base-tip — the review launcher refuses a candidate behind the real base tip that does not merge cleanly, and diagnose reports it', () => {
  const candidate = { sha: H, baseSha: B, pr: 7, branch: 'graphyard/gy-7-1', author: 'worker' };
  // GY-191: behind and mergeable is reviewed as it stands; only a head GitHub reports conflicting is refused.
  const mergeable = { key: 'GY-7', policy: { checks: [], review: true }, submission: { epoch: 1, pr: 7 }, candidate, reworkRequested: false,
    observation: { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: [], scopeFiles: [], at, prState: 'open', draft: false, baseTip: sha40('b2'), baseTree: sha40('7b'), baseTipContained: false } } as unknown as Work;
  assert.equal(assertReviewCandidate(mergeable, at).sha, H, 'a mergeable head behind the base is reviewed');
  const observation = { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: false, conflicting: true, protected: true, files: [], scopeFiles: [], at, prState: 'open', draft: false, baseTip: sha40('b2'), baseTree: sha40('7b'), baseTipContained: false } as Observation;
  const work = { key: 'GY-7', policy: { checks: [], review: true }, submission: { epoch: 1, pr: 7 }, candidate, observation, reworkRequested: false, ready: true, dependencies: [], workspaces: [], criteria: [], evidence: [], gates: [], violations: [], plannedFiles: [], scenarioRequirements: [] } as unknown as Work;
  assert.throws(() => assertReviewCandidate(work, at), new RegExp(`GY-7 candidate ${H.slice(0, 12)} does not contain the base branch tip ${sha40('b2').slice(0, 12)}; .* Run graphyard sync GY-7`));
  const behind = diagnose(work, [work], Date.parse(at)).find(entry => entry.kind === 'base-behind')!;
  assert.match(behind.message, new RegExp(`does not contain the base branch tip ${sha40('b2').slice(0, 12)}`));
  // Bringing the head onto the moved tip is the control plane's work now, not a worker sync round.
  assert.match(behind.next, /the reconciliation job merges the base into this branch/);
  work.observation = { ...observation, baseTipContained: true };
  assert.equal(assertReviewCandidate(work, at).sha, H);
  assert.equal(diagnose(work, [work], Date.parse(at)).some(entry => entry.kind === 'base-behind'), false);
});

// ---- GY-831: a refreshed head whose carried approval is stale is re-reviewed or re-bound ----------

/** A base refresh of reviewed head H whose carried approval names review 800 of an earlier pull request's commit. */
const OLD = sha40('0d1');
function staleCarry(reviews: Observation['reviews'] = []) {
  const carry = decideCarry(input());
  carry.approval = { carried: true, provider: 'github', reviewer: 'graphyard-reviewer[bot]', sha: OLD, reviewId: 800, originalSha: OLD, reason: 'carried from the earlier pull request' };
  const candidate = { sha: TIP, baseSha: P, pr: 371, branch: 'graphyard/gy-470-2', author: 'worker' };
  return { key: 'GY-470', candidate, policyRevision: 1, policy: { checks: ['test'], review: true }, baseRefresh: refreshed(carry),
    observation: { candidate, reviews, checks: [], merged: false, mergeSha: null, protected: true, mergeable: true, files: [], scopeFiles: [], at, prState: 'open', draft: false } } as unknown as Work;
}

test('unit:carried-approval-rebinds — a carried binding from an earlier pull request is refreshed by the bound reviewer\'s newer approval of the head the tip was built from', () => {
  const work = staleCarry(), carried = carriedApproval(work)!;
  assert.equal(carried.originalSha, OLD);
  // The record refreshes the binding as soon as an observation shows the newer approval of H,
  // dismissed by GitHub on the tip push or not; a later change request refreshes nothing.
  const dismissed = staleCarry([{ id: 5327788286, reviewer: 'graphyard-reviewer[bot]', sha: H, state: 'DISMISSED', dismissal: { verdict: 'approved', mergeBase: true } } as Observation['reviews'][number]]);
  const refreshed = refreshedCarriedApproval(dismissed)!;
  assert.deepEqual([refreshed.carried, refreshed.reviewer, refreshed.reviewId, refreshed.originalSha, refreshed.sha], [true, 'graphyard-reviewer[bot]', 5327788286, H, H]);
  assert.match(refreshed.reason, new RegExp(`approval of ${H.slice(0, 12)} by graphyard-reviewer\\[bot\\] \\(review 5327788286\\), the head tip ${TIP.slice(0, 12)} was built from, replaces the carried approval of ${OLD.slice(0, 12)}`));
  // A dismissal that is not from mergeBase (manually dismissed) does not refresh the binding.
  assert.equal(refreshedCarriedApproval(staleCarry([{ id: 5327788286, reviewer: 'graphyard-reviewer[bot]', sha: H, state: 'DISMISSED', dismissal: { verdict: 'approved', mergeBase: false } } as Observation['reviews'][number]])), null, 'a deliberately dismissed approval does not re-bind');
  assert.equal(refreshedCarriedApproval(staleCarry([{ id: 5327788286, reviewer: 'graphyard-reviewer[bot]', sha: H, state: 'APPROVED' }, { id: 5327788290, reviewer: 'graphyard-reviewer[bot]', sha: H, state: 'CHANGES_REQUESTED' }])), null);
  assert.equal(refreshedCarriedApproval(staleCarry([{ id: 700, reviewer: 'graphyard-reviewer[bot]', sha: H, state: 'APPROVED' }])), null, 'an older approval is not newer than the binding');
  assert.equal(refreshedCarriedApproval(staleCarry([{ id: 5327788286, reviewer: 'someone-else', sha: H, state: 'APPROVED' }])), null, 'only the carried reviewer re-binds its own approval');
});
