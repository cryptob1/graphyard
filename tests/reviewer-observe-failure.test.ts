import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Observation, Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { bindReviewer, launchReview, reconcileReviews, saveReviewerProfile } from '../src/reviewer.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1752: each test is named for the proof it produces: integration:review-read-failure-contained.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), H2 = sha40('a2'), B = sha40('b1');
const clock = Date.now();
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const reviewer = 'graphyard-reviewer[bot]';

function observation(candidate: { sha: string; baseSha: string }, at: string): Observation {
  return { candidate: { ...candidate, pr: 84, branch: 'graphyard/gy-84-1', author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha40('7b'), baseTipContained: true };
}
/** One submitted, observed candidate whose only proof is manual: the review request stands alone. */
function work(overrides: Partial<Work> = {}, at = iso(0)): Work {
  const candidate = { sha: H, baseSha: B, pr: 84, branch: 'graphyard/gy-84-1', author: 'implementer' };
  return { id: 'work-84', key: 'GY-84', title: 'Dismissed approval', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Relaunch', proofs: ['manual:dismissed-review'] }],
    policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 3, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1,
    lease: null, workspaces: [{ host: 'h', path: '/w/gy-84', branch: 'graphyard/gy-84-1', epoch: 1, owner: 'implementer' }], candidate, submission: { epoch: 1, pr: 84 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: observation(candidate, at), blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [], ...overrides } as Work;
}

/** A Herdr and `gh` stub: tab and agent calls for a launch, pane closes, and the PR's review list. */
function stubs(reviews: () => unknown[]) {
  const calls: string[][] = [];
  const run = (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'api') return JSON.stringify(reviews());
    return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
  };
  return { calls, run, mint: async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() }) };
}

async function reviewerRoot() {
  const root = await temporaryDirectory('dismissed'), credentialDirectory = await temporaryDirectory('dismissed-credentials');
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentialDirectory, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' });
  return { root, credentialDirectory, config: await loadMasterConfig(root), cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}

test('integration:review-read-failure-contained — a GitHub read that fails (rate limit, timeout) leaves the pending session as it was instead of failing the pass, and the next pass settles it', async () => {
  const { root, config, cleanup } = await reviewerRoot();
  try {
    const { run, mint } = stubs(() => []);
    const at = new Date().toISOString();
    const item = work({}, at);
    reconcileAutoDispatch(item, [item], new Date());
    const request = item.autoDispatch!.review!;
    await launchReview(root, item, 'claude-reviewer', [], at, { run, mint, requestId: request.id });
    for (const message of ['gh: API rate limit exceeded for user ID 4241869. (HTTP 403)', 'The operation was aborted due to timeout']) {
      let reads = 0;
      const pass = await reconcileReviews(root, config, { run, work: [item], observe: () => { reads++; throw new Error(message); } });
      assert.equal(reads, 1, 'after one failed read the pass reads no more');
      assert.equal(pass.reviews[0].state, 'pending', 'a session whose verdict could not be read is not judged unanswered');
      assert.equal(pass.reviews[0].verdict, undefined);
    }
    const approval = { state: 'APPROVED', reviewer, reviewId: 12, submittedAt: iso(0) };
    const settled = (await reconcileReviews(root, config, { run, work: [item], observe: () => approval })).reviews[0];
    assert.equal(settled.state, 'completed');
    assert.equal(settled.verdict!.state, 'APPROVED');
  } finally { await cleanup(); }
});
