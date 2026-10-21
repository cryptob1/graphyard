import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyCandidateRevert, candidateRevertReason, failingRequiredCases, revertCandidateItem, revertRecordKey, revertTarget, type CandidateItemDelta, type RevertPorts, type RevertRecordEvent } from '../src/release-revert.js';
import type { E2eCaseRecord, ReleaseCandidate, UatRecord } from '../src/release-candidate.js';
import type { VerificationMap } from '../src/model/verification-maps.js';
import type { Work } from '../src/model.js';

// GY-1526: a candidate that fails a required E2E case on UAT reverts the merge of the candidate
// item the failure implicates — chosen through the release contract and the verification maps —
// through the merge writer's own steps, records the revert on the item and reopens it for rework.

const start = Date.parse('2030-05-01T12:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const map = (path: string, paths: string[]): VerificationMap => ({ path, paths, sections: { Tests: 't', Drive: 'd', Invariants: 'i', Gotchas: 'g' } });
const maps = [map('verification/server.md', ['src/server/**', 'src/engine.ts']), map('verification/store.md', ['src/store/**', 'src/store.ts']), map('verification/master.md', ['src/master/**', 'src/master.ts'])];
const contract = { outcomes: [{ id: 'sign-in', cases: ['sign-in'] }, { id: 'work-intake', cases: ['create-work-item', 'board'] }], cases: [{ id: 'sign-in', tags: ['browser'] }, { id: 'board', tags: ['api', 'board'] }, { id: 'create-work-item', tags: ['api', 'store'] }] };
const candidate: Pick<ReleaseCandidate, 'id' | 'sha' | 'items'> = { id: '20300501T120000Z', sha: sha('candidate'), items: [{ key: 'GY-3', mergeSha: sha('merge-3'), pr: 3 }, { key: 'GY-2', mergeSha: sha('merge-2'), pr: 2 }, { key: 'GY-1', mergeSha: sha('merge-1'), pr: 1 }] };
const deltas: CandidateItemDelta[] = [{ key: 'GY-1', mergeSha: sha('merge-1'), files: ['src/server/routes/work.ts', 'tests/work.test.ts'] }, { key: 'GY-2', mergeSha: sha('merge-2'), files: ['src/store/schema.ts'] }, { key: 'GY-3', mergeSha: sha('merge-3'), files: ['web/app.tsx'] }];
const uatWith = (cases: E2eCaseRecord[], blocking = cases.filter(entry => entry.verdict !== 'passed').map(entry => entry.case)): Pick<UatRecord, 'e2e'> =>
  ({ e2e: { runId: 'rc-20300501T120000Z', sha: candidate.sha, blocking, cases } });
const failedCase = (id: string, step = 'open the Work view') => ({ case: id, verdict: 'failed' as const, required: true, attempts: 2, failingStep: { index: 2, name: step, reason: 'no heading' } });

test('unit:release-revert-area-match — revertTarget takes the failing required cases, their outcomes and tags, selects the maps whose file name or Paths name them, and returns the newest candidate item whose merge delta a selected map\'s globs cover, naming the case, step and map', () => {
  // The `board` case fails: its outcome is work-intake, its tags api and board; the store map matches by the `store` tag of create-work-item? No — only the failing case's own tags count.
  const uat = uatWith([failedCase('board', 'read the board'), { case: 'sign-in', verdict: 'passed', required: true, attempts: 1, failingStep: null }]);
  assert.deepEqual(failingRequiredCases(uat), [{ case: 'board', step: 'read the board', verdict: 'failed' }]);
  // No map is named board, api or work-intake: the newest candidate item is the fallback (tested below). A Paths segment naming the tag selects the map.
  const byPath = revertTarget(candidate, uat, deltas, [...maps, map('verification/intake.md', ['src/board/**', 'src/store/schema.ts'])], contract)!;
  assert.deepEqual([byPath.key, byPath.mergeSha, byPath.map, byPath.case, byPath.step, byPath.candidate], ['GY-2', sha('merge-2'), 'verification/intake.md', 'board', 'read the board', candidate.id]);
  assert.match(byPath.reason, /^Release candidate 20300501T120000Z \([0-9a-f]{12}\) failed required E2E case board at step "read the board" \(outcome work-intake\); verification map verification\/intake\.md matches it and its globs cover GY-2's merge delta \(src\/store\/schema\.ts\), so GY-2's merge [0-9a-f]{12} is reverted$/);
  // A map named for the tag (verification/api.md) covering an older item still loses to a newer covered item, but wins over an uncovered newest item.
  const byStem = revertTarget(candidate, uat, deltas, [...maps, map('verification/api.md', ['src/server/**'])], contract)!;
  assert.deepEqual([byStem.key, byStem.map], ['GY-1', 'verification/api.md'], 'GY-3 (web/) and GY-2 (store) are not covered by the api map; GY-1 is');
  // The outcome id names the map too, and the case id does.
  assert.equal(revertTarget(candidate, uat, deltas, [map('verification/work-intake.md', ['src/store/**'])], contract)!.key, 'GY-2');
  assert.equal(revertTarget(candidate, uat, deltas, [map('verification/board.md', ['src/server/**'])], contract)!.key, 'GY-1');
  // The newest covered item wins when two are covered: GY-2 is newer than GY-1.
  const both = revertTarget(candidate, uat, deltas, [map('verification/api.md', ['src/server/**', 'src/store/**'])], contract)!;
  assert.deepEqual([both.key, both.map], ['GY-2', 'verification/api.md']);
  // Only outright failures select: a flaky required case stays on the holds and evidence-decision path, and an optional failure is nothing.
  assert.equal(revertTarget(candidate, uatWith([{ ...failedCase('board'), verdict: 'flaky' }]), deltas, maps, contract), null, 'a flaky case reverts nothing');
  assert.equal(revertTarget(candidate, uatWith([{ ...failedCase('board'), required: false }], []), deltas, maps, contract), null, 'an optional failure reverts nothing');
  assert.equal(revertTarget(candidate, { e2e: null }, deltas, maps, contract), null, 'no release run, nothing to attribute');
  assert.equal(revertTarget({ ...candidate, items: [] }, uat, deltas, maps, contract), null, 'a candidate without items has nothing to revert');
  // The first failing case names the target; a second failing case's areas still select maps.
  const two = revertTarget(candidate, uatWith([failedCase('sign-in', 'sign in'), failedCase('create-work-item', 'create')]), deltas, maps, contract)!;
  assert.deepEqual([two.key, two.map, two.case, two.step], ['GY-2', 'verification/store.md', 'sign-in', 'sign in'], 'the store map is selected by create-work-item\'s store tag and covers GY-2');
});

test('unit:release-revert-newest-fallback — with no selected map, or none whose globs cover a candidate item\'s merge delta, revertTarget returns the newest candidate item and says why', () => {
  const uat = uatWith([failedCase('sign-in')]);
  // sign-in's tag is browser and its outcome sign-in: no map in the set is named for them or paths them.
  const none = revertTarget(candidate, uat, deltas, maps, contract)!;
  assert.deepEqual([none.key, none.mergeSha, none.map, none.case, none.step], ['GY-3', sha('merge-3'), null, 'sign-in', 'open the Work view']);
  assert.match(none.reason, /\(outcome sign-in\); no verification map names the case, its outcome or its tags, so the newest candidate item GY-3's merge [0-9a-f]{12} is reverted$/);
  // A selected map that covers no candidate item's delta still falls back, naming the map.
  const uncovered = revertTarget(candidate, uat, deltas, [map('verification/browser.md', ['web/vendor/**'])], contract)!;
  assert.deepEqual([uncovered.key, uncovered.map], ['GY-3', null]);
  assert.match(uncovered.reason, /the matching verification map verification\/browser\.md covers no candidate item's merge delta, so the newest candidate item GY-3's merge/);
  // An item without a delta is never covered, and the newest item is the candidate's first.
  assert.equal(revertTarget(candidate, uat, [], [map('verification/browser.md', ['**'])], contract)!.key, 'GY-3');
  assert.equal(revertTarget(candidate, uat, [], [], { outcomes: [] })!.key, 'GY-3', 'no contract at all still reverts the newest item');
});

test('unit:release-revert-newest-fallback — revertCandidateItem refuses a conflicting revert, a failed trial or a merge main no longer holds without pushing, re-trials a push the tip moved under at most retrials times, and applyCandidateRevert reopens only the item still holding the delivery', async () => {
  const target = { mergeSha: sha('merge-9'), candidate: '20300501T120000Z', case: 'sign-in', step: 'open the Work view' };
  const item = { id: 'w9', key: 'GY-9' };
  function ports(options: { holds?: boolean; conflict?: string[]; build?: 'pass' | 'fail'; failedTests?: string[]; pushes?: ('pushed' | 'rejected')[]; tips?: string[] } = {}) {
    const calls: string[] = [], events: RevertRecordEvent[] = [];
    let fetches = 0, pushed = 0;
    const port: RevertPorts = {
      baseBranch: 'main', retrials: 2, now: () => start,
      fetch: async () => { calls.push('fetch'); const tips = options.tips ?? [sha('tip')]; return tips[Math.min(fetches++, tips.length - 1)]!; },
      holds: async () => { calls.push('holds'); return options.holds ?? true; },
      revert: async (mergeSha, baseTip) => { calls.push(`revert:${baseTip.slice(0, 6)}`); return options.conflict ? { conflict: options.conflict } : { revertSha: sha(`revert:${mergeSha}:${baseTip}`), files: ['src/a.ts'] }; },
      trial: async revertSha => { calls.push(`trial:${revertSha.slice(0, 6)}`); return { build: options.build ?? 'pass', tests: { passed: 1, failed: options.failedTests ?? [], files: 1 }, durationMs: 5 }; },
      push: async () => { calls.push('push'); const pushes = options.pushes ?? ['pushed']; return pushes[Math.min(pushed++, pushes.length - 1)]!; },
      record: async (_work, event) => { calls.push(`record:${event.phase}`); events.push(event); },
    };
    return { port, calls, events };
  }
  const clean = ports();
  const landed = await revertCandidateItem(clean.port, item, target);
  const revertSha = sha(`revert:${target.mergeSha}:${sha('tip')}`);
  assert.deepEqual(landed, { outcome: 'reverted', revertSha, baseTip: sha('tip'), observedTip: sha('tip'), pushes: 1 });
  assert.deepEqual(clean.calls, ['fetch', 'holds', `revert:${sha('tip').slice(0, 6)}`, 'record:intent', `trial:${revertSha.slice(0, 6)}`, 'record:trial', 'push', 'record:pushed', 'fetch', 'record:reconciled']);
  assert.ok(clean.calls.indexOf('record:intent') < clean.calls.indexOf('push'), 'the intent is on the ledger before the push');
  assert.deepEqual(clean.events[0], { kind: 'revert', phase: 'intent', mergeSha: target.mergeSha, revertSha, baseTip: sha('tip'), candidate: target.candidate, case: 'sign-in', step: 'open the Work view', at: iso(start) });
  assert.deepEqual(clean.events[3], { kind: 'revert', phase: 'reconciled', mergeSha: target.mergeSha, revertSha, observedTip: sha('tip'), candidate: target.candidate, case: 'sign-in', step: 'open the Work view', at: iso(start) });
  assert.equal(revertRecordKey(item, clean.events[0]), `revert-record:w9:intent:${target.mergeSha}:${revertSha}:${sha('tip')}`);
  const refusals: [string, Parameters<typeof ports>[0], RegExp][] = [
    ['conflict', { conflict: ['src/a.ts'] }, /revert refused: the revert conflicts in src\/a\.ts/],
    ['failed build', { build: 'fail' }, /revert refused: the trial of [0-9a-f]{12} failed build step npm run build/],
    ['failed tests', { failedTests: ['tests/a.test.ts'] }, /revert refused: the trial of [0-9a-f]{12} failed tests tests\/a\.test\.ts/],
    ['unheld merge', { holds: false }, /revert refused: main no longer holds [0-9a-f]{12} in its first-parent history/],
  ];
  for (const [name, options, expected] of refusals) {
    const refused = ports(options);
    const outcome = await revertCandidateItem(refused.port, item, target);
    assert.equal(outcome.outcome, 'refused', name); assert.match((outcome as { reason: string }).reason, expected, name);
    assert.ok(!refused.calls.includes('push'), `${name}: nothing is pushed`);
    assert.equal(refused.events.at(-1)?.phase, 'refused', `${name}: the refusal is recorded`);
  }
  // A push the tip moved under rebuilds on the new tip; past the bound the revert is left queued.
  const moved = ports({ pushes: ['rejected', 'pushed'], tips: [sha('tip'), sha('tip2')] });
  const second = await revertCandidateItem(moved.port, item, target);
  assert.deepEqual([second.outcome, (second as { pushes: number }).pushes, (second as { baseTip: string }).baseTip], ['reverted', 2, sha('tip2')]);
  const stuck = ports({ pushes: ['rejected'] });
  const queued = await revertCandidateItem(stuck.port, item, target);
  assert.deepEqual([queued.outcome, (queued as { pushes: number }).pushes], ['requeued', 3]);
  assert.match((queued as { reason: string }).reason, /base moved 3 times/);
  // The item's record: replace by merge, reopen only while the delivery stands.
  const work = { key: 'GY-9', stage: 'done', revision: 3, delivery: { mergedAt: iso(start), mergeSha: target.mergeSha, authorizationRevision: 1 }, submission: { epoch: 1, pr: 9 }, candidate: { sha: sha('h') }, lease: null, pipeline: { attempts: [], reworkRounds: 0 } } as unknown as Work;
  const revert = { mergeSha: target.mergeSha, revertSha, candidate: target.candidate, case: 'sign-in', step: 'open the Work view', at: iso(start) };
  assert.deepEqual(applyCandidateRevert(work, revert, new Date(start)), { reopened: true });
  assert.deepEqual([work.stage, work.delivery, work.submission, work.candidate, work.candidateReverts], ['ready', undefined, null, null, [revert]]);
  assert.deepEqual(applyCandidateRevert(work, { ...revert, revertSha: sha('again') }, new Date(start)), { reopened: false }, 'reopened once');
  assert.deepEqual(work.candidateReverts!.map(entry => entry.revertSha), [sha('again')], 'the entry for the same merge is replaced');
  assert.match(candidateRevertReason(work, revert), /^GY-9's merge [0-9a-f]{12} was reverted \([0-9a-f]{12}\): release candidate 20300501T120000Z failed required E2E case sign-in at step "open the Work view" on UAT\./);
});
