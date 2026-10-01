import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, CHECK_NAME, mergeRequiredChecks } from '../src/github.js';
import { requiredChecksOf } from '../src/merge-queue.js';
import { LANDABLE_CHECK, landableCheckRun } from '../src/landable-check.js';
import { evaluateLandability } from '../src/model/landability.js';
import { GRAPHYARD_CHECKS, protectionPayload, protectionSatisfied } from '../src/install/github.js';
import { applyProtection, mergeQueueRuleset, protectionPlan } from '../src/protection.js';
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
  const reasons = verdict.verdict === 'refused' ? verdict.reasons : [];
  assert.ok(reasons.some(entry => entry.gate === 'build') && reasons.some(entry => entry.gate === 'acceptance'), 'the fixture refuses on both families');
  const failure = landableCheckRun(refused, [refused], now)!;
  assert.equal(failure.conclusion, 'failure');
  assert.equal(failure.head_sha, head);
  assert.equal(failure.output.title, `Refused: ${reasons.length} reason${reasons.length === 1 ? '' : 's'}`);
  // Every refusal reason is in the summary, word for word, under the gate that gives it.
  for (const entry of reasons) assert.ok(failure.output.summary.includes(`- ${entry.gate}: ${entry.reason}`), `summary names: ${entry.reason}`);
  assert.match(failure.output.summary, /unit:own-proof/);

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

  // A policy revision the evidence no longer binds refuses again, on the same run.
  const repoliced = item({ policyRevision: 2 });
  assert.equal(evaluateLandability(repoliced, [repoliced], now).verdict, 'refused');
  await github.publishLandable(repoliced, [repoliced]);
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

test('unit:landable-check-required — the reconciled branch protection requires graphyard/landable, bound to the Graphyard App, beside CI', async () => {
  const inputs = { repository: 'owner/repo', branch: 'main', requiredChecks: ['test', 'typecheck'], graphyardAppId: APP, reviewCount: 1 };
  assert.ok(GRAPHYARD_CHECKS.includes(LANDABLE_CHECK));

  // A fresh branch: the payload requires CI, the merge gate and the landability verdict.
  const fresh = protectionPayload(inputs, null);
  assert.deepEqual(fresh.required_status_checks.checks.find((check: any) => check.context === 'graphyard/landable'), { context: 'graphyard/landable', app_id: APP });
  assert.deepEqual(fresh.required_status_checks.checks.map((check: any) => check.context), ['test', 'typecheck', CHECK_NAME, LANDABLE_CHECK]);

  // A branch protected before GY-887 — CI and the merge gate only — is drift the installer repairs,
  // keeping what the repository already required.
  const before = { required_status_checks: { strict: false, checks: [{ context: 'test', app_id: null }, { context: 'typecheck', app_id: null }, { context: 'lint', app_id: 7 }, { context: CHECK_NAME, app_id: APP }] },
    enforce_admins: { enabled: true }, required_conversation_resolution: { enabled: false }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false },
    required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true } };
  assert.equal(protectionSatisfied(inputs, before), false, 'a branch that does not require graphyard/landable is not satisfied');
  const repaired = protectionPayload(inputs, before);
  assert.deepEqual(repaired.required_status_checks.checks, [...before.required_status_checks.checks, { context: LANDABLE_CHECK, app_id: APP }]);

  // An unbound graphyard/landable another producer could publish is rebound to the App.
  const unbound = { ...before, required_status_checks: { strict: false, checks: [...before.required_status_checks.checks, { context: LANDABLE_CHECK, app_id: null }] } };
  assert.equal(protectionSatisfied(inputs, unbound), false);
  assert.deepEqual(protectionPayload(inputs, unbound).required_status_checks.checks.find((check: any) => check.context === LANDABLE_CHECK), { context: LANDABLE_CHECK, app_id: APP });

  // `master protection` (src/protection.ts) reconciles an already-installed branch the same way: the
  // missing verdict is a change it applies, keeping every observed check, and verifies on re-read.
  const config = { repository: 'owner/repo', baseBranch: 'main', githubAppId: APP };
  const open = [{ key: 'GY-1', stage: 'build', policy: { checks: ['test'], review: true } } as unknown as Work];
  const queueRules = (checks: readonly string[]) => [{ type: 'merge_queue', parameters: {} }, { type: 'required_status_checks', parameters: { required_status_checks: checks.map(context => ({ context, integration_id: APP })) } }];
  assert.deepEqual(mergeQueueRuleset(config).rules.find(rule => rule.type === 'required_status_checks')?.parameters.required_status_checks,
    [{ context: CHECK_NAME, integration_id: APP }, { context: LANDABLE_CHECK, integration_id: APP }], 'the merge queue requires the verdict on every merge group');
  const stale = protectionPlan(before, config, open, queueRules([CHECK_NAME]));
  assert.equal(stale.consistent, false);
  assert.ok(stale.changes.includes(`required check ${LANDABLE_CHECK}: missing to required from App ${APP}`), stale.changes.join('; '));
  assert.ok(stale.changes.some(change => change.startsWith(`merge queue required check ${CHECK_NAME} and ${LANDABLE_CHECK}`)), stale.changes.join('; '));
  assert.equal(protectionPlan(unbound, config, open, queueRules(GRAPHYARD_CHECKS)).consistent, false, 'an unbound graphyard/landable does not satisfy master protection');

  let protection: any = structuredClone(before), rules: unknown = queueRules([CHECK_NAME]);
  const writes: { path: string; body: any }[] = [];
  const run = (_command: string, args: string[], input?: string) => {
    const path = args.find(arg => arg.startsWith('repos/'))!;
    if (args.includes('--method')) {
      const body = JSON.parse(input ?? '{}');
      writes.push({ path, body });
      if (path.endsWith('/protection/required_status_checks')) protection = { ...protection, required_status_checks: body };
      if (/\/rulesets(\/\d+)?$/.test(path)) rules = body.rules;
      return '{}';
    }
    if (path.endsWith('/protection')) return JSON.stringify(protection);
    if (path.includes('/rules/branches/')) return JSON.stringify(rules);
    if (path.includes('/rulesets')) return '[]';
    if (path === 'repos/owner/repo') return JSON.stringify({ owner: { type: 'Organization' }, allow_auto_merge: false });
    throw new Error(`Unexpected gh ${args.join(' ')}`);
  };
  const applied = await applyProtection(config, open, run);
  assert.equal(applied.consistent, true, [...applied.changes, ...applied.blockers].join('; '));
  const checksWrite = writes.find(write => write.path.endsWith('/protection/required_status_checks'))!;
  assert.deepEqual(checksWrite.body, { strict: false, checks: [...before.required_status_checks.checks, { context: LANDABLE_CHECK, app_id: APP }] }, 'master protection adds the App-bound verdict and keeps every observed check');
  assert.ok(protectionPlan(protection, config, open, rules).consistent, 'the reconciled protection requires graphyard/landable');
});

test('a refusal list longer than GitHub\'s summary bound keeps whole reasons and counts the ones it omits', () => {
  const work = item();
  const audit = evaluateLandability(work, [work], now);
  const reasons = Array.from({ length: 200 }, (_, index) => ({ gate: 'acceptance' as const, reason: `reason ${index} ${'x'.repeat(500)}` }));
  const run = landableCheckRun(work, [work], now, { ...audit, verdict: 'refused', reasons })!;
  assert.equal(run.conclusion, 'failure');
  assert.equal(run.output.title, 'Refused: 200 reasons');
  assert.ok(run.output.summary.length <= 65_535, `${run.output.summary.length}`);
  const kept = run.output.summary.split('\n').filter(line => /^- acceptance: reason \d+ x+$/.test(line)).length;
  assert.ok(kept > 0 && kept < 200);
  assert.match(run.output.summary, new RegExp(`- … ${200 - kept} more reasons omitted: GitHub bounds a check summary at 65535 characters\\n\\nCandidate ${head}`));
});
