import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { finishLocalCandidate, type LocalCandidate, type LocalReleasePorts, type LocalValidation } from '../src/daemon/promotion-local.js';
import { revertTarget, type CandidateItemDelta, type RevertOutcome, type RevertTarget } from '../src/release-revert.js';
import { defaultRepositoryPolicy, type RepositoryPolicy } from '../src/model/repository-policy.js';
import type { VerificationMap } from '../src/model/verification-maps.js';
import { candidateSettings } from '../src/master/merge-writer-settings.js';
import type { E2eCaseRecord, ReleaseCandidate, UatRecord } from '../src/release-candidate.js';

// GY-1848: a repository chooses what a failed release candidate does. `release.onFailure: 'hold'`
// names the failure and reverts nothing — no revert port runs (so no revert phase is recorded and
// nothing reopens; server/merge-record.ts reopens only through a recorded revert phase), no promote
// port runs, and the outcome is the classification: each failing required case with its step, the
// candidate, and the item a matching verification map would have targeted, or 'no map matched'.
// `release.revertUnmatched: false` holds a failure no verification map covers instead of the
// newest-item fallback; unset, revertTarget's newest-item fallback stays exactly as GY-1526 shipped it.

const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const map = (path: string, paths: string[]): VerificationMap => ({ path, paths, sections: { Tests: 't', Drive: 'd', Invariants: 'i', Gotchas: 'g' } });
const maps = [map('verification/server.md', ['src/server/**', 'src/engine.ts']), map('verification/store.md', ['src/store/**', 'src/store.ts']), map('verification/master.md', ['src/master/**', 'src/master.ts'])];
const contract = { outcomes: [{ id: 'sign-in', cases: ['sign-in'] }, { id: 'work-intake', cases: ['create-work-item', 'board'] }], cases: [{ id: 'sign-in', tags: ['browser'] }, { id: 'board', tags: ['api', 'board'] }, { id: 'create-work-item', tags: ['api', 'store'] }] };
const candidate: Pick<ReleaseCandidate, 'id' | 'sha' | 'items'> = { id: '20300501T120000Z', sha: sha('candidate'), items: [{ key: 'GY-3', mergeSha: sha('merge-3'), pr: 3 }, { key: 'GY-2', mergeSha: sha('merge-2'), pr: 2 }, { key: 'GY-1', mergeSha: sha('merge-1'), pr: 1 }] };
const cutCandidate: LocalCandidate = { id: candidate.id, sha: candidate.sha, cutAt: '2030-05-01T12:00:00.000Z', items: candidate.items };
const deltas: CandidateItemDelta[] = [{ key: 'GY-1', mergeSha: sha('merge-1'), files: ['src/server/routes/work.ts', 'tests/work.test.ts'] }, { key: 'GY-2', mergeSha: sha('merge-2'), files: ['src/store/schema.ts'] }, { key: 'GY-3', mergeSha: sha('merge-3'), files: ['web/app.tsx'] }];
const failedCase = (id: string, step = 'open the Work view') => ({ case: id, verdict: 'failed' as const, required: true, attempts: 2, failingStep: { index: 2, name: step, reason: 'no heading' } });
const uatWith = (cases: E2eCaseRecord[]): Pick<UatRecord, 'e2e'> =>
  ({ e2e: { runId: `rc-${candidate.id}`, sha: candidate.sha, blocking: cases.filter(entry => entry.verdict !== 'passed').map(entry => entry.case), cases } });
const failedValidation = (cases: E2eCaseRecord[]): LocalValidation => ({
  record: { result: 'failed', suites: [{ name: 'e2e', passed: false, detail: 'required case failed' }], followUp: null, deployedSha: candidate.sha, e2e: uatWith(cases).e2e! },
  followUp: null,
});
const revertedOutcome = (target: RevertTarget): RevertOutcome =>
  ({ outcome: 'reverted', revertSha: sha(`revert-${target.key}`), baseTip: sha('base-tip'), observedTip: sha('base-tip'), pushes: 1 });

/** Fake LocalReleasePorts (the soak-local-promotion pattern) recording every port call, with the reads the revert target is chosen from and the policy under test. */
function buildLocal(options: { release?: RepositoryPolicy['release']; items?: CandidateItemDelta[]; maps?: VerificationMap[] } = {}) {
  const calls: string[] = [];
  const targets: RevertTarget[] = [];
  const local: LocalReleasePorts = {
    settings: candidateSettings({ candidates: { everyMerges: 3, idleMinutes: 20 } }),
    history: async () => [],
    cut: async () => { calls.push('cut'); throw new Error('finishLocalCandidate cuts nothing'); },
    uat: async id => { calls.push(`uat:${id}`); throw new Error('finishLocalCandidate deploys no UAT'); },
    validate: async id => { calls.push(`validate:${id}`); throw new Error('finishLocalCandidate validates nothing'); },
    promote: async id => { calls.push(`promote:${id}`); return { promoted: true, sha: candidate.sha }; },
    verify: async verified => { calls.push(`verify:${verified.slice(0, 6)}`); return { served: verified, verified: true }; },
    revertInputs: async input => {
      calls.push(`revertInputs:${input.id}`);
      return { items: options.items ?? deltas, maps: options.maps ?? maps, contract };
    },
    revert: async target => { calls.push(`revert:${target.key}`); targets.push(target); return revertedOutcome(target); },
    ...(options.release ? { release: options.release } : {}),
  };
  return { calls, targets, local };
}

test('unit:release-failure-hold-reverts-nothing — under release.onFailure hold a candidate failing a required E2E case calls no revert port and reopens no item, calls no promote port, and its outcome names each failing case with its step, the candidate and the would-be target, or no map matched', async () => {
  // A map matches the failing case's outcome and covers GY-2's merge delta: the hold names it as the would-be target.
  const hold = { onFailure: 'hold' as const, revertUnmatched: true };
  const matched = buildLocal({ release: hold, maps: [map('verification/work-intake.md', ['src/store/**'])] });
  const outcome = await finishLocalCandidate(matched.local, cutCandidate, false, failedValidation([failedCase('board', 'read the board')]));
  assert.deepEqual(matched.calls, [`revertInputs:${candidate.id}`], 'the hold reads the revert inputs (read-only) and calls no other port: no revert, no promote, no verify');
  assert.deepEqual(matched.targets, [], 'no revert port call records no revert phase, so no item reopens');
  assert.equal(outcome.promoted, false, 'production never moves');
  assert.equal(outcome.revert, null);
  assert.match(outcome.detail, new RegExp(`^Held candidate ${candidate.id} \\(${candidate.sha.slice(0, 12)}\\): required E2E case board failed at step "read the board"; release\\.onFailure hold reverts nothing and reopens nothing; a matching verification map \\(verification/work-intake\\.md\\) would have targeted GY-2's merge ${sha('merge-2').slice(0, 12)}; production stays on the previous release; classification for an agent to act on$`));
  // No map matches: the classification says so instead of naming a target.
  const unmatched = buildLocal({ release: hold, maps: [] });
  const none = await finishLocalCandidate(unmatched.local, cutCandidate, false, failedValidation([failedCase('sign-in')]));
  assert.deepEqual(unmatched.calls, [`revertInputs:${candidate.id}`]);
  assert.equal(none.revert, null);
  assert.match(none.detail, /release\.onFailure hold reverts nothing and reopens nothing; no map matched; production stays on the previous release/);
  // Each failing required case is named with its step, not only the first.
  const both = buildLocal({ release: hold, maps: [] });
  const two = await finishLocalCandidate(both.local, cutCandidate, false, failedValidation([failedCase('board', 'read the board'), failedCase('create-work-item', 'create the item')]));
  assert.match(two.detail, /required E2E case board failed at step "read the board"; required E2E case create-work-item failed at step "create the item"/);
  // A port that names no policy keeps the default: today's revert, untouched.
  const fallback = buildLocal({ maps: [map('verification/work-intake.md', ['src/store/**'])] });
  const today = await finishLocalCandidate(fallback.local, cutCandidate, false, failedValidation([failedCase('board', 'read the board')]));
  assert.deepEqual(fallback.calls, [`revertInputs:${candidate.id}`, 'revert:GY-2'], 'the default policy reverts as GY-1526 shipped it');
  assert.deepEqual([today.revert!.target.key, today.revert!.target.map], ['GY-2', 'verification/work-intake.md']);
  assert.match(today.detail, /verification map verification\/work-intake\.md matches it and its globs cover GY-2's merge delta \(src\/store\/schema\.ts\), so GY-2's merge/);
  assert.equal(today.revert!.outcome.outcome, 'reverted');
});

test('unit:release-unmatched-failure-holds — with release.revertUnmatched false a failure no verification map covers holds instead of reverting the newest candidate item, and with it unset revertTarget\'s newest-item fallback is unchanged', async () => {
  const uat = uatWith([failedCase('sign-in')]);
  // AC-2's pinned baseline: with the key unset, revertTarget's newest-item fallback is byte-identical to GY-1526's.
  const fallback = revertTarget(candidate, uat, deltas, maps, contract)!;
  assert.deepEqual([fallback.key, fallback.mergeSha, fallback.map, fallback.case, fallback.step, fallback.candidate], ['GY-3', sha('merge-3'), null, 'sign-in', 'open the Work view', candidate.id]);
  assert.match(fallback.reason, /no verification map names the case, its outcome or its tags, so the newest candidate item GY-3's merge [0-9a-f]{12} is reverted$/);
  assert.deepEqual(revertTarget(candidate, uat, deltas, maps, contract, { unmatched: 'revert' }), fallback, 'an explicit revert option is the unset behaviour');
  assert.equal(revertTarget(candidate, uat, deltas, maps, contract, { unmatched: 'hold' }), null, 'the hold option withholds only the newest-item fallback');
  // A map-matched failure still reverts under revertUnmatched false: only the unmatched case holds.
  const falseUnmatched = { onFailure: 'revert' as const, revertUnmatched: false };
  const covered = buildLocal({ release: falseUnmatched, maps: [map('verification/work-intake.md', ['src/store/**'])] });
  const matchedRevert = await finishLocalCandidate(covered.local, cutCandidate, false, failedValidation([failedCase('board', 'read the board')]));
  assert.deepEqual(covered.calls, [`revertInputs:${candidate.id}`, 'revert:GY-2']);
  assert.equal(matchedRevert.revert!.outcome.outcome, 'reverted');
  // No map matches any item's delta: the failure holds instead of reverting the newest item.
  const unmatched = buildLocal({ release: falseUnmatched, maps: [] });
  const held = await finishLocalCandidate(unmatched.local, cutCandidate, false, failedValidation([failedCase('sign-in')]));
  assert.deepEqual(unmatched.calls, [`revertInputs:${candidate.id}`], 'no revert port call, so the newest item is not reverted and nothing reopens');
  assert.equal(held.revert, null);
  assert.equal(held.promoted, false);
  assert.match(held.detail, new RegExp(`^Held candidate ${candidate.id} \\(${candidate.sha.slice(0, 12)}\\): required E2E case sign-in failed at step "open the Work view"; no verification map matches any candidate item's merge delta and release\\.revertUnmatched is false, so the newest item is not reverted; production stays on the previous release; classification for an agent to act on$`));
  // A candidate that carries no delivered item keeps its own verdict under every policy: nothing to revert, nothing to hold.
  const empty = buildLocal({ release: falseUnmatched, maps: [] });
  const noItems = await finishLocalCandidate(empty.local, { ...cutCandidate, items: [] }, false, failedValidation([failedCase('sign-in')]));
  assert.deepEqual(empty.calls, [`revertInputs:${candidate.id}`]);
  assert.match(noItems.detail, /failed required E2E case sign-in but carries no delivered item to revert; production stays on the previous release$/);
  // The declared default is the behaviour a repository that declares nothing keeps.
  assert.deepEqual(defaultRepositoryPolicy.release, { onFailure: 'revert', revertUnmatched: true });
});
