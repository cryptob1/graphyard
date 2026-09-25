import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateKey, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, mergeWork, type MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';

// GY-195: on GY-183 a guarded merge's provider call ended with an unknown outcome. The next cycle
// mergeWork reported the retained execution as success, the loop recorded the merge as done and
// never asked again, and once the execution was cleared the open, mergeable pull request sat at
// the merge stage with no actor until a human merged it.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
const validProtection = { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: 'Graphyard / merge', app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };

async function masterConfig() {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-merge-outcome-'));
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  return { config, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const execution = () => ({ id: '44444444-4444-4444-8444-444444444444', owner: 'master', sha, baseSha, policyRevision: 2, authorizationRevision: 9,
  issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString() });
/** An execution whose provider call was committed and whose outcome GitHub has not yet reported. */
const retained = () => ({ ...execution(), verifiedAt: new Date(Date.now() - 50_000).toISOString(), committingAt: new Date(Date.now() - 40_000).toISOString(), clockOffset: { min: 0, max: 0 } });

function work(overrides: Partial<Work> = {}) {
  const candidate = { sha, baseSha, pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' };
  const queue = { sequence: 1, enqueuedAt: '2030-01-01T00:30:00Z', policyRevision: 2,
    speculation: { ref: 'refs/graphyard/queue/gy-42', tip: sha, base: baseSha, baseTree: 'e'.repeat(40), predecessors: [], policyRevision: 2, publishedAt: '2030-01-01T00:31:00Z' } };
  return { id: 'work-id', key: 'GY-42', queue, title: 'Merge outcome', description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:merge'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'merge', revision: 9, policyRevision: 2, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 42 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: { at: new Date().toISOString(), candidate, reviews: [] }, blocker: null, gates: [{ name: 'merge', passed: true, reasons: [] }], violations: [],
    mergeAuthorization: { sha, baseSha, policyRevision: 2, at: new Date().toISOString() }, ...overrides } as Work;
}

/** GitHub as the broker sees it; every provider merge call is counted. */
function github() {
  const calls: string[][] = [];
  const run = (_command: string, args: string[]) => {
    calls.push(args);
    if (args[1] === 'view') return JSON.stringify({ headRefOid: sha, baseRefName: 'main', state: 'OPEN', isDraft: false });
    if (args[1]?.includes('/git/ref/heads/')) return JSON.stringify({ ref: 'refs/heads/main', object: { type: 'commit', sha: baseSha } });
    if (args[1]?.includes('/check-runs')) return JSON.stringify({ check_runs: [{ name: 'Graphyard / merge', status: 'completed', conclusion: 'success', started_at: new Date().toISOString(), app: { id: 1234 } }] });
    if (args.includes('--include')) return `Date: ${new Date().toUTCString()}\n\n{}`;
    if (args[1] === '--method') return JSON.stringify({ merged: true, sha: 'c'.repeat(40) });
    return JSON.stringify(validProtection);
  };
  return { calls, run, providerCalls: () => calls.filter(args => args[1] === '--method').length };
}

/** The control plane as the loop and the broker read it; `item` is swapped between cycles. */
function plane(initial: Work) {
  let item = initial; let acquired = 0;
  const snapshot = async () => ({ work: [item], now: new Date().toISOString() });
  const acquire = async () => { acquired++; const granted = execution(); item = { ...item, mergeExecution: granted }; return { execution: granted }; };
  const commit = async () => { const committingAt = new Date(Date.now() - 2000).toISOString(); item = { ...item, mergeExecution: { ...item.mergeExecution!, committingAt } }; return { executionId: execution().id, sha, committingAt }; };
  const verify = async () => ({ executionId: execution().id, sha, verifiedAt: new Date(Date.now() - 2000).toISOString(), providerDelayMs: 0, clockOffset: { min: 0, max: 0 } });
  return { set: (next: Work) => { item = next; }, snapshot, acquire, commit, verify, acquired: () => acquired };
}

function loop(config: MasterConfig, broker: ReturnType<typeof plane>, gh: ReturnType<typeof github>): DaemonEffects {
  return {
    agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: broker.snapshot,
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, requestSmoke: () => {}, recordDeployment: async () => {},
    merge: item => mergeWork(config, item, broker.snapshot, broker.acquire, async () => {}, broker.verify, gh.run, 'master', broker.commit),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    persist: async () => {},
  };
}

test('unit:unknown-outcome-not-done — a retained execution with an unknown outcome is pending, recorded as waiting, and asked again every cycle', async () => {
  const { config, cleanup } = await masterConfig();
  try {
    const item = work({ mergeExecution: retained() });
    const broker = plane(item); const gh = github();
    const reported = await mergeWork(config, item, broker.snapshot, broker.acquire, async () => {}, broker.verify, gh.run, 'master', broker.commit) as { pending?: boolean; merged?: boolean; result: string };
    assert.equal(reported.pending, true, 'the unknown outcome is reported as pending');
    assert.notEqual(reported.merged, true, 'and never as merged');
    assert.equal(gh.providerCalls(), 0, 'no provider call is made while the execution is retained');

    const state = emptyDaemonState(config);
    for (let cycle = 0; cycle < 3; cycle++) {
      const result = await runCycle(config, state, loop(config, broker, gh));
      const merge = result.actions.find(action => action.kind === 'merge');
      assert.ok(merge, `cycle ${cycle} re-evaluates the retained execution`);
      assert.equal(merge.state, 'waiting', 'the loop records the pending outcome as waiting, not done');
      assert.match(merge.detail, /unknown/);
    }
    assert.equal(state.actions[candidateKey('merge', item)].state, 'waiting');
    assert.equal(gh.providerCalls(), 0);
    assert.equal(broker.acquired(), 0);
  } finally { await cleanup(); }
});

test('unit:cleared-execution-retried — an execution cleared while the pull request stays open is merged again within one cycle', async () => {
  const { config, cleanup } = await masterConfig();
  try {
    const item = work({ mergeExecution: retained() });
    const broker = plane(item); const gh = github();
    const state = emptyDaemonState(config);
    const first = await runCycle(config, state, loop(config, broker, gh));
    assert.equal(first.actions.find(action => action.kind === 'merge')?.state, 'waiting');
    assert.equal(gh.providerCalls(), 0);

    // Reconciliation expired and cleared the execution; GitHub still shows the pull request open.
    broker.set(work({ mergeExecution: null, observation: { at: new Date().toISOString(), candidate: item.candidate, reviews: [] } as unknown as Work['observation'] }));
    const second = await runCycle(config, state, loop(config, broker, gh));
    const merge = second.actions.find(action => action.kind === 'merge');
    assert.ok(merge, 'the next cycle attempts the guarded merge again');
    assert.equal(broker.acquired(), 1, 'a fresh execution is acquired');
    assert.equal(gh.providerCalls(), 1, 'the provider merge is called once');
    assert.equal(merge.state, 'done', `the retried merge is requested: ${merge.detail}`);
    assert.match(merge.detail, /merge requested/);
  } finally { await cleanup(); }
});

test('unit:unknown-outcome-merged-delivered — a merge GitHub shows under the retained execution is delivered from the observation without another provider call', async () => {
  const { config, cleanup } = await masterConfig();
  try {
    const item = work({ mergeExecution: retained() });
    const broker = plane(item); const gh = github();
    const state = emptyDaemonState(config);
    assert.equal((await runCycle(config, state, loop(config, broker, gh))).actions.find(action => action.kind === 'merge')?.state, 'waiting');

    const merged = work({ mergeExecution: retained(), observation: { at: new Date().toISOString(), candidate: item.candidate, merged: true, mergeSha: 'c'.repeat(40), reviews: [] } as unknown as Work['observation'] });
    broker.set(merged);
    const reported = await mergeWork(config, merged, broker.snapshot, broker.acquire, async () => {}, broker.verify, gh.run, 'master', broker.commit) as { pending?: boolean; merged?: boolean; result: string };
    assert.equal(reported.merged, true, 'the observed merge is reported as merged');
    assert.notEqual(reported.pending, true);
    const result = await runCycle(config, state, loop(config, broker, gh));
    const merge = result.actions.find(action => action.kind === 'merge');
    assert.equal(merge?.state, 'done');
    assert.match(merge!.detail, /delivers it from that observation without another provider call/);
    assert.equal(gh.providerCalls(), 0, 'no provider merge call is made for an observed merge');
    assert.equal(broker.acquired(), 0);

    // Once delivered, the item leaves the merge stage and the loop asks nothing further of GitHub.
    broker.set({ ...merged, stage: 'done' });
    const after = await runCycle(config, state, loop(config, broker, gh));
    assert.equal(after.actions.some(action => action.kind === 'merge'), false);
    assert.equal(gh.providerCalls(), 0);
  } finally { await cleanup(); }
});
