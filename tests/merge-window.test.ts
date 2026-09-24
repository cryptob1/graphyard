import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { definiteProviderRefusal, mergeWindowFloorMs, mergeWork } from '../src/master.js';
import type { Work } from '../src/model.js';

// GY-159, 2026-09-24: GitHub refused the provider call while the published check lagged (HTTP
// 405), and a later attempt acquired its execution on an 18 s old observation, committed, and ran
// out of window before the provider call. Each was held as an unknown outcome until it lapsed.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const config = { version: 1 as const, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge' as const, workers: [], reviewers: [], producers: [], run: { intervalSeconds: 20, deploymentShaField: 'commit', dispatchIntervalSeconds: 10, producerTimeoutMinutes: 120 } };
const validProtection = { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: 'Graphyard / merge', app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
const sha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
const observed = (ageMs: number) => ({ at: new Date(Date.now() - ageMs).toISOString(), candidate: { sha, baseSha, pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' } }) as any;
function work(overrides: Partial<Work> = {}) {
  const candidate = { sha, baseSha, pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' };
  const queue = { sequence: 1, enqueuedAt: '2030-01-01T00:30:00Z', policyRevision: 2,
    speculation: { ref: 'refs/graphyard/queue/gy-42', tip: sha, base: baseSha, baseTree: 'e'.repeat(40), predecessors: [], policyRevision: 2, publishedAt: '2030-01-01T00:31:00Z' } };
  return { id: 'work-id', key: 'GY-42', queue, title: 'Merge window', description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:master'] }], policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'merge', revision: 9, policyRevision: 2, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 42 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: observed(0), blocker: null, gates: [{ name: 'merge', passed: true, reasons: [] }], violations: [], mergeAuthorization: { sha, baseSha, policyRevision: 2, at: new Date().toISOString() }, ...overrides } as Work;
}
const execution = { id: '44444444-4444-4444-8444-444444444444', owner: 'master', sha, baseSha, policyRevision: 2, authorizationRevision: 9, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString() };
const verify = async () => ({ executionId: execution.id, sha, verifiedAt: new Date(Date.now() - 2000).toISOString(), providerDelayMs: 0, clockOffset: { min: 0, max: 0 } });
/** The record before acquire, after acquire, and after merge-commit, as the broker re-reads it. */
function broker(item: () => Work) {
  let held: Work['mergeExecution'] = null;
  return {
    snapshot: async () => ({ work: [{ ...item(), ...(held ? { mergeExecution: held } : {}) }], now: new Date().toISOString() }),
    acquire: async () => { held = execution; return { execution }; },
    commit: async () => { const committingAt = new Date(Date.now() - 2000).toISOString(); held = { ...execution, committingAt }; return { executionId: execution.id, sha, committingAt }; },
  };
}
function github(options: { check?: unknown; put?: () => string } = {}) {
  const calls: string[][] = [];
  const run = (_command: string, args: string[]) => {
    calls.push(args);
    if (args[1] === 'view') return JSON.stringify({ headRefOid: sha, baseRefName: 'main', state: 'OPEN', isDraft: false });
    if (args[1]?.includes('/git/ref/heads/')) return JSON.stringify({ ref: 'refs/heads/main', object: { type: 'commit', sha: baseSha } });
    if (args[1]?.includes('/check-runs')) return JSON.stringify(options.check ?? { check_runs: [{ name: 'Graphyard / merge', status: 'completed', conclusion: 'success', started_at: new Date().toISOString() }] });
    if (args.includes('--include')) return `Date: ${new Date().toUTCString()}\n\n{}`;
    if (args[1] === '--method') return options.put ? options.put() : JSON.stringify({ merged: true, sha: 'c'.repeat(40) });
    return JSON.stringify(validProtection);
  };
  return { calls, run };
}

test('unit:merge-window-sizing — a GitHub 4xx from the merge call is a refusal that releases the committed execution', async () => {
  assert.match(definiteProviderRefusal(new Error('Command failed: gh api --method PUT x\ngh: Required status check "Graphyard / merge" is failing. (HTTP 405)\n'))!, /^Required status check "Graphyard \/ merge" is failing\. \(HTTP 405\)$/);
  assert.equal(definiteProviderRefusal(new Error('provider response lost')), null);
  assert.equal(definiteProviderRefusal(new Error('gh: Server Error (HTTP 502)')), null, 'a 5xx leaves the outcome unknown');
  const item = work(); const store = broker(() => item); let cancelled = '';
  const gh = github({ put: () => { throw new Error('Command failed: gh api\ngh: Required status check "Graphyard / merge" is failing. (HTTP 405)'); } });
  await assert.rejects(mergeWork(config, item, store.snapshot, store.acquire, async (_work, authority) => { cancelled = authority.id; }, verify, gh.run, execution.owner, store.commit), /GitHub refused the merge of GY-42: .*HTTP 405/);
  assert.equal(cancelled, execution.id);
});

test('unit:merge-window-sizing — a lagging Graphyard / merge check is refused before commit, and the execution is released', async () => {
  const item = work(); const store = broker(() => item); let cancelled = ''; let committed = false;
  const gh = github({ check: { check_runs: [{ name: 'Graphyard / merge', status: 'completed', conclusion: 'failure', started_at: new Date().toISOString() }] } });
  await assert.rejects(mergeWork(config, item, store.snapshot, store.acquire, async (_work, authority) => { cancelled = authority.id; }, verify, gh.run, execution.owner, async () => { committed = true; return store.commit(); }),
    /does not yet show Graphyard \/ merge as passed .*completed\/failure/);
  assert.equal(committed, false); assert.equal(cancelled, execution.id);
  assert.equal(gh.calls.some(args => args[1] === '--method'), false);
});

test('unit:merge-window-sizing — an observation too old for a provider-sized window acquires nothing; with a refresh the attempt re-reads and continues', async () => {
  const stale = work({ observation: observed(120_000 - mergeWindowFloorMs + 5_000) });
  let acquired = false; const store = broker(() => stale);
  await assert.rejects(mergeWork(config, stale, store.snapshot, async () => { acquired = true; return { execution }; }, async () => ({}), verify, github().run, execution.owner, store.commit),
    /merge deferred: the GitHub observation leaves \d+ s of merge window/);
  assert.equal(acquired, false);
  let current = stale; let refreshed = 0;
  const refreshing = broker(() => current);
  const result = await mergeWork(config, stale, refreshing.snapshot, refreshing.acquire, async () => ({}), verify, github().run, execution.owner, refreshing.commit, undefined,
    async () => { refreshed++; current = work({ observation: observed(0) }); });
  assert.equal(refreshed, 1); assert.match(result.result, /merge requested/);
});
