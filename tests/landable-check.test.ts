import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, CHECK_NAME, mergeRequiredChecks } from '../src/github.js';
import { requiredChecksOf } from '../src/merge-queue.js';
import { LANDABLE_CHECK, landableCheckRun } from '../src/landable-check.js';
import { evaluateLandability } from '../src/model/landability.js';
import { GRAPHYARD_CHECKS, protectionPayload, protectionSatisfied } from '../src/install/github.js';
import type { Evidence, Observation, Work } from '../src/model.js';

// GY-887. The landability verdict (GY-878) reaches GitHub as one required check, graphyard/landable,
// on every candidate head: success when the verdict is landable, failure with its refusal reasons as
// the summary otherwise, and branch protection requires it beside CI.

const at = '2026-09-30T12:00:00.000Z';
const now = new Date(at);
const sha = (digit: string) => digit.repeat(40);
const head = sha('7'), base = sha('9'), main = sha('b');
const APP = 1234;

const proof = (overrides: Partial<Evidence> = {}): Evidence => ({
  id: `unit:own-proof@${(overrides.sha ?? head).slice(0, 4)}#${overrides.result ?? 'pass'}`, proof: 'unit:own-proof', sha: head, baseSha: base, policyRevision: 1,
  producer: 'independent-producer', trusted: true, result: 'pass', executed: 3, skipped: 0, at, ...overrides,
}) as Evidence;

/**
 * A submitted candidate with an in-scope change and its one criterion proven: landable unless `extra` says otherwise.
 * The change is under a high-risk path, so its risk lane (GY-883) requires every proof its criteria name.
 */
function item(extra: Partial<Work> = {}, candidateSha = head): Work {
  const candidate = { sha: candidateSha, baseSha: base, pr: 10, branch: 'graphyard/gy-1-1', author: 'worker' };
  const file = { path: 'src/store/own.ts', status: 'modified', sha: sha('d'), baseSha: sha('e'), additions: 3, deletions: 1, binary: false };
  const observation = {
    candidate, checks: [{ name: 'test', result: 'success', appId: 1 }], reviews: [{ reviewer: 'reviewer', sha: candidateSha, state: 'APPROVED', submittedAt: at }],
    merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/store/own.ts'], scopeFiles: [file], landing: { base: main, files: [file] },
    at, prState: 'open', draft: false, baseTip: main, baseTree: sha('e'), baseTipContained: true,
  } as unknown as Observation;
  return {
    id: 'gy-1', key: 'GY-1', title: 'GY-1', description: '', type: 'feature', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'proven', proofs: ['unit:own-proof'] }],
    policy: { checks: [], review: false }, plannedFiles: ['src/store/own.ts'], stage: 'merge', revision: 4, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, candidate,
    workspaces: [{ host: 'machine-a', path: '/tmp/GY-1', epoch: 1, owner: 'worker', branch: candidate.branch }],
    submission: { epoch: 1, pr: 10 }, reworkRequested: false, scenarioRequirements: [],
    evidence: [proof({ sha: candidateSha })], blocker: null, gates: [], violations: [],
    queue: null, queueSequence: 0, queueHistory: [], queueEjection: null, observation, ...extra,
  } as unknown as Work;
}

/** The control-plane adapter against a stubbed GitHub that keeps the check runs it is sent. */
function forge() {
  const runs: any[] = [];
  const writes: { method: string; path: string; body: any }[] = [];
  const pr = { head };
  const github = new GitHub({ repository: 'owner/repo', base: 'main', appId: APP, installationId: 1, privateKey: 'not-used-in-adapter-test' });
  github.request = async (path, method = 'GET', body) => {
    if (method === 'POST' && path === '/check-runs') { const run = { id: runs.length + 100, app: { id: APP }, ...(body as any) }; runs.push(run); writes.push({ method, path, body }); return run; }
    if (method === 'PATCH' && path.startsWith('/check-runs/')) { const run = runs.find(entry => entry.id === Number(path.slice(12)))!; Object.assign(run, body); writes.push({ method, path, body }); return run; }
    if (path === '/pulls/10') return { number: 10, head: { sha: pr.head, ref: 'graphyard/gy-1-1' }, base: { sha: base, ref: 'main' }, state: 'open', draft: false };
    if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: main } };
    if (/^\/commits\/[a-f0-9]{40}$/.test(path)) return { sha: path.slice(9), commit: { tree: { sha: sha('e') } } };
    const listed = path.match(/^\/commits\/([a-f0-9]{40})\/check-runs\?check_name=([^&]+)/);
    if (listed) return { total_count: 1, check_runs: runs.filter(run => run.head_sha === listed[1] && run.name === decodeURIComponent(listed[2])) };
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  return { github, runs, writes, pr };
}

test('unit:landable-check-published — graphyard/landable concludes success on a landable head and failure with the refusal reasons as its summary on a refused one, recomputed when the inputs change', async () => {
  // Landable fixture: the check run says success and names the exact candidate it judged.
  const landable = item();
  assert.equal(evaluateLandability(landable, [landable], now).verdict, 'landable');
  const success = landableCheckRun(landable, [landable], now)!;
  assert.equal(success.name, LANDABLE_CHECK);
  assert.equal(success.name, 'graphyard/landable');
  assert.equal(success.head_sha, head);
  assert.equal(success.status, 'completed');
  assert.equal(success.conclusion, 'success');
  assert.equal(success.output.title, 'Landable');
  assert.match(success.output.summary, new RegExp(`Candidate ${head}; base ${base}; policy 1`));

  // Refused fixture: no trusted evidence for the criterion's proof, and the change leaves the planned files.
  const refused = item({ evidence: [], plannedFiles: ['src/store/other.ts'] });
  const verdict = evaluateLandability(refused, [refused], now);
  assert.equal(verdict.verdict, 'refused');
  const all = verdict.verdict === 'refused' ? verdict.reasons : [];
  assert.ok(all.some(entry => entry.gate === 'build') && all.some(entry => entry.gate === 'acceptance'), 'the fixture refuses on both families');
  const failure = landableCheckRun(refused, [refused], now)!;
  assert.equal(failure.conclusion, 'failure');
  assert.equal(failure.head_sha, head);
  // Only the build family is published (GY-1331): since GY-1235 proofs gate nothing, so an unproven
  // proof refuses no merge, and the required check would otherwise hold a head every gate passes.
  const reasons = all.filter(entry => entry.gate === 'build');
  assert.equal(failure.output.title, `Refused: ${reasons.length} reason${reasons.length === 1 ? '' : 's'}`);
  // Every build refusal reason is in the summary, word for word, under the gate that gives it.
  for (const entry of reasons) assert.ok(failure.output.summary.includes(`- ${entry.gate}: ${entry.reason}`), `summary names: ${entry.reason}`);
  assert.doesNotMatch(failure.output.summary, /acceptance:|unit:own-proof needs trusted passing evidence/);
  // A head refused only for its proofs is published landable: GitHub merges it on CI and review.
  const unproven = item({ evidence: [] });
  assert.ok(evaluateLandability(unproven, [unproven], now).verdict === 'refused', 'the verdict still names the unproven proof');
  assert.equal(landableCheckRun(unproven, [unproven], now)!.conclusion, 'success');

  // Once protection and the merge-queue ruleset require graphyard/landable (AC-2), the verdict still
  // concludes success: Graphyard's own checks never become CI inputs to the verdict they publish.
  const protectionChecks = [{ name: 'test', appId: 1 }, { name: CHECK_NAME, appId: APP }, { name: LANDABLE_CHECK, appId: APP }, { name: LANDABLE_CHECK, appId: null }];
  assert.deepEqual(mergeRequiredChecks(protectionChecks), [{ name: 'test', appId: 1 }]);
  const required = item({ observation: { ...landable.observation!, requiredChecks: [{ name: 'test', appId: 1 }, { name: LANDABLE_CHECK, appId: APP }] } } as Partial<Work>);
  assert.deepEqual(requiredChecksOf(required).map(check => check.name), ['test']);
  assert.equal(evaluateLandability(required, [required], now).verdict, 'landable');
  assert.equal(landableCheckRun(required, [required], now)!.conclusion, 'success');

  // No candidate head, no check run.
  assert.equal(landableCheckRun(item({ candidate: null } as Partial<Work>), [], now), null);

  // Published by the control-plane App: created on the head, left alone while the verdict stands,
  // updated in place when an input changes, and created afresh on a new head.
  const { github, runs, writes, pr } = forge();
  await github.publishLandable(refused, [refused]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'POST');
  assert.deepEqual({ name: runs[0].name, head: runs[0].head_sha, conclusion: runs[0].conclusion, summary: runs[0].output.summary }, { name: LANDABLE_CHECK, head, conclusion: 'failure', summary: failure.output.summary });

  await github.publishLandable(refused, [refused]);
  assert.equal(writes.length, 1, 'an unchanged verdict is not written again');

  // Trusted evidence arrives and the change is in scope: the same run turns to success.
  await github.publishLandable(landable, [landable]);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].method, 'PATCH');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].conclusion, 'success');

  // A change of input the build gate reads refuses again, on the same run: the planned files no longer cover the change.
  const replanned = item({ plannedFiles: ['src/store/other.ts'] });
  assert.equal(evaluateLandability(replanned, [replanned], now).verdict, 'refused');
  await github.publishLandable(replanned, [replanned]);
  assert.equal(writes.length, 3);
  assert.equal(runs[0].conclusion, 'failure');

  // A new head gets its own run.
  const next = item({}, sha('8'));
  pr.head = sha('8');
  await github.publishLandable(next, [next]);
  assert.equal(runs.length, 2);
  assert.deepEqual([runs[1].head_sha, runs[1].conclusion], [sha('8'), 'success']);

  // Success is never written on a head the pull request has moved past.
  pr.head = sha('6');
  await assert.rejects(github.publishLandable(landable, [landable]), /PR changed before the landability check was published/);
  assert.equal(runs.filter(run => run.head_sha === head).length, 1);

  // The merge group commit GitHub builds for an authorized head carries the verdict too.
  await github.publishGroupCheck(landable, sha('c'));
  assert.ok(runs.some(run => run.head_sha === sha('c') && run.name === LANDABLE_CHECK && run.conclusion === 'success'));
  // Graphyard's own verdict is never read back as a CI check.
  assert.notEqual(LANDABLE_CHECK, CHECK_NAME);
});

test('a refusal list longer than GitHub\'s summary bound keeps whole reasons and counts the ones it omits', () => {
  const work = item();
  const audit = evaluateLandability(work, [work], now);
  const reasons = Array.from({ length: 200 }, (_, index) => ({ gate: 'build' as const, reason: `reason ${index} ${'x'.repeat(500)}` }));
  const run = landableCheckRun(work, [work], now, { ...audit, verdict: 'refused', reasons })!;
  assert.equal(run.conclusion, 'failure');
  assert.equal(run.output.title, 'Refused: 200 reasons');
  assert.ok(run.output.summary.length <= 65_535, `${run.output.summary.length}`);
  const kept = run.output.summary.split('\n').filter(line => /^- build: reason \d+ x+$/.test(line)).length;
  assert.ok(kept > 0 && kept < 200);
  assert.match(run.output.summary, new RegExp(`- … ${200 - kept} more reasons omitted: GitHub bounds a check summary at 65535 characters\\n\\nCandidate ${head}`));
});
