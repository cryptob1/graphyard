import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { candidateKey, emptyDaemonState, mergeRetryCapMs, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, mergeWork } from '../src/master.js';
import type { Work } from '../src/model.js';

// GY-183 and GY-176 were stranded behind a committed merge execution whose provider call ended
// without an answer: the loop recorded the merge done, the broker refused a new attempt, and
// nothing asked GitHub what the call had done. Merging is idempotent, so the pull request itself
// answers (GY-202).

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234,
  hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
const validProtection = { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: 'Graphyard / merge', app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
const sha = 'a'.repeat(40), baseSha = 'b'.repeat(40), mergeCommit = 'c'.repeat(40), owner = 'graphyard-master#daemon-1';

function work(overrides: Partial<Work> = {}) {
  const candidate = { sha, baseSha, pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' };
  const queue = { sequence: 1, enqueuedAt: '2030-01-01T00:30:00Z', policyRevision: 2,
    speculation: { ref: 'refs/graphyard/queue/gy-42', tip: sha, base: baseSha, baseTree: 'e'.repeat(40), predecessors: [], policyRevision: 2, publishedAt: '2030-01-01T00:31:00Z' } };
  return { id: 'work-id', key: 'GY-42', queue, title: 'Unknown merge outcome', description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:merge'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'merge', revision: 9, policyRevision: 2, createdAt: new Date(Date.now() - 3_600_000).toISOString(), updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1, lease: null,
    workspaces: [], candidate, submission: { epoch: 1, pr: 42 }, reworkRequested: false, scenarioRequirements: [], evidence: [{ proof: 'unit:merge' }],
    observation: { at: new Date().toISOString(), candidate, reviews: [], checks: [] }, blocker: null, gates: [{ name: 'merge', passed: true, reasons: [] }], violations: [],
    mergeAuthorization: { sha, baseSha, policyRevision: 2, at: new Date().toISOString() }, ...overrides } as Work;
}
/** An execution the broker committed to the provider, still inside its authority: no expiry has passed. */
const committed = () => ({ id: '11111111-1111-4111-8111-111111111111', owner, sha, baseSha, policyRevision: 2, authorizationRevision: 9, issuedAt: new Date(Date.now() - 10_000).toISOString(),
  expiresAt: new Date(Date.now() + 100_000).toISOString(), verifiedAt: new Date(Date.now() - 8_000).toISOString(), committingAt: new Date(Date.now() - 6_000).toISOString(), clockOffset: { min: 0, max: 0 } });

/** The record as the broker and the loop read it, with every broker step counted. */
function record(initial: Work) {
  let item = initial; let fresh = 0;
  const steps = { acquired: [] as string[], cancelled: [] as string[], refreshed: 0 };
  const read = async () => ({ work: [item], now: new Date().toISOString() });
  return {
    steps, read, set: (next: Partial<Work>) => { item = { ...item, ...next } as Work; },
    acquire: async () => {
      const execution = { id: `22222222-2222-4222-8222-22222222222${fresh++}`, owner, sha, baseSha, policyRevision: 2, authorizationRevision: 9, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString() };
      steps.acquired.push(execution.id); item = { ...item, mergeExecution: execution }; return { execution };
    },
    cancel: async (_work: Work, execution: { id: string }) => { steps.cancelled.push(execution.id); item = { ...item, mergeExecution: null }; },
    verify: async () => ({ executionId: item.mergeExecution!.id, sha, verifiedAt: new Date(Date.now() - 2000).toISOString(), providerDelayMs: 0, clockOffset: { min: 0, max: 0 } }),
    commit: async () => { const committingAt = new Date(Date.now() - 2000).toISOString(); item = { ...item, mergeExecution: { ...item.mergeExecution!, committingAt } }; return { executionId: item.mergeExecution!.id, sha, committingAt }; },
  };
}
/** GitHub, answering the pull request read from `pull` and a provider merge with its merge commit. */
function github(pull: () => unknown) {
  const calls: string[][] = [];
  const run = (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'api' && args[1] === 'repos/owner/project/pulls/42') return JSON.stringify(pull());
    if (args[1] === 'view') return JSON.stringify({ headRefOid: sha, baseRefName: 'main', state: 'OPEN', isDraft: false });
    if (args[1]?.includes('/git/ref/heads/')) return JSON.stringify({ ref: 'refs/heads/main', object: { type: 'commit', sha: baseSha } });
    if (args[1]?.includes('/check-runs')) return JSON.stringify({ check_runs: [{ name: 'Graphyard / merge', status: 'completed', conclusion: 'success', started_at: new Date().toISOString(), app: { id: 1234 } }] });
    if (args.includes('--include')) return `Date: ${new Date().toUTCString()}\n\n{}`;
    if (args[1] === '--method') return JSON.stringify({ merged: true, sha: mergeCommit });
    return JSON.stringify(validProtection);
  };
  return { calls, run, reads: () => calls.filter(args => args[1] === 'repos/owner/project/pulls/42').length, provider: () => calls.filter(args => args[1] === '--method').length };
}
function effects(overrides: Partial<DaemonEffects>): DaemonEffects {
  return {
    agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [], now: new Date().toISOString() }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    merge: async () => ({ result: 'merge requested' }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {}, ...overrides,
  };
}

test('unit:unknown-merge-reconciled-from-github — GitHub showing the pull request merged records the delivery from merge_commit_sha on the next tick and closes the execution, with no new attempt', async () => {
  const store = record(work({ mergeExecution: committed() }));
  const gh = github(() => ({ number: 42, state: 'closed', merged: true, merge_commit_sha: mergeCommit, merged_at: new Date().toISOString(), head: { sha }, base: { ref: 'main' } }));
  // The observation the refresh asks for is what records the delivery: from the merge commit GitHub reports.
  const refresh = async () => {
    store.steps.refreshed++;
    const pull = JSON.parse(gh.run('gh', ['api', 'repos/owner/project/pulls/42']));
    store.set({ stage: 'done', mergeExecution: null, delivery: { mergedAt: pull.merged_at, mergeSha: pull.merge_commit_sha, authorizationRevision: 9 } } as Partial<Work>);
  };
  const state = emptyDaemonState(config); const started = Date.now();
  const result = await runCycle(config, state, effects({ snapshot: store.read,
    merge: item => mergeWork(config, item, store.read, store.acquire, store.cancel, store.verify, gh.run, owner, store.commit, undefined, refresh) }));
  const merge = result.actions.find(action => action.kind === 'merge')!;
  assert.equal(merge.state, 'done', merge.detail);
  assert.match(merge.detail, new RegExp(`merged as ${mergeCommit.slice(0, 12)}; the delivery is recorded from that merge commit and execution 11111111-1111-4111-8111-111111111111 is closed`));
  const [delivered] = (await store.read()).work;
  assert.equal(delivered.stage, 'done'); assert.equal(delivered.delivery?.mergeSha, mergeCommit); assert.equal(delivered.mergeExecution, null);
  assert.equal(store.steps.refreshed, 1, 'the observation that records the delivery was asked for once');
  assert.deepEqual([store.steps.acquired, store.steps.cancelled, gh.provider()], [[], [], 0], 'a merged pull request is never cancelled or merged again');
  assert.ok(Date.parse(committed().expiresAt) > Date.now() && Date.now() - started < 10_000, 'resolved inside the authority, without waiting for expiry');
});

test('unit:unknown-merge-reconciled-from-github — GitHub showing the pull request open at the committed head cancels the execution and retries the guarded merge exactly once in the same tick', async () => {
  const execution = committed();
  const store = record(work({ mergeExecution: execution }));
  const gh = github(() => ({ number: 42, state: 'open', merged: false, merge_commit_sha: null, merged_at: null, head: { sha }, base: { ref: 'main' } }));
  const state = emptyDaemonState(config);
  const result = await runCycle(config, state, effects({ snapshot: store.read,
    merge: item => mergeWork(config, item, store.read, store.acquire, store.cancel, store.verify, gh.run, owner, store.commit, undefined, async () => { store.steps.refreshed++; }) }));
  const merge = result.actions.find(action => action.kind === 'merge')!;
  assert.equal(merge.state, 'done', merge.detail);
  assert.equal(gh.reads(), 1, 'the unknown outcome was read from GitHub once');
  assert.deepEqual(store.steps.cancelled, [execution.id], 'the unmerged committed execution was cancelled, not left to expire');
  assert.equal(store.steps.acquired.length, 1, 'exactly one retry acquired a fresh execution');
  assert.equal(gh.provider(), 1, 'exactly one retried provider merge');
  assert.ok(Date.parse(execution.expiresAt) > Date.now(), 'the retry ran while the old authority had not yet expired');
  assert.equal(state.actions[candidateKey('merge', work())].state, 'done');
});

test('unit:unknown-merge-reconciled-from-github — an open pull request whose head moved is not retried, and another instance\'s live execution is left to it', async () => {
  const moved = record(work({ mergeExecution: committed() }));
  const elsewhere = github(() => ({ number: 42, state: 'open', merged: false, head: { sha: 'd'.repeat(40) }, base: { ref: 'main' } }));
  await assert.rejects(mergeWork(config, work({ mergeExecution: committed() }), moved.read, moved.acquire, moved.cancel, moved.verify, elsewhere.run, owner, moved.commit), /the candidate moved, so the merge is not retried/);
  assert.deepEqual([moved.steps.cancelled, moved.steps.acquired, elsewhere.provider()], [[], [], 0]);
  const foreign = record(work({ mergeExecution: { ...committed(), owner: 'graphyard-master#interactive' } }));
  const open = github(() => ({ number: 42, state: 'open', merged: false, head: { sha }, base: { ref: 'main' } }));
  await assert.rejects(mergeWork(config, work({ mergeExecution: { ...committed(), owner: 'graphyard-master#interactive' } }), foreign.read, foreign.acquire, foreign.cancel, foreign.verify, open.run, owner, foreign.commit), /stands down without cancelling it/);
  assert.deepEqual([foreign.steps.cancelled, foreign.steps.acquired, open.provider()], [[], [], 0]);
});

const mergeable = (candidateSha = sha, stage: Work['stage'] = 'merge') => work({ stage, candidate: { sha: candidateSha, baseSha, pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' } });
/** Tick the loop every 20 s for `ticks` ticks on a fake clock, reading the item `at` each tick. */
async function tick(ticks: number, at: (tick: number) => Work, merge: (item: Work, tick: number) => Promise<unknown>) {
  const state = emptyDaemonState(config); const calls: { tick: number; sha: string }[] = []; const start = Date.parse('2030-01-01T00:00:00Z');
  for (let index = 0; index < ticks; index++) {
    const item = at(index);
    await runCycle(config, state, effects({ snapshot: async () => ({ work: [item], now: new Date().toISOString() }),
      merge: async candidate => { calls.push({ tick: index, sha: candidate.candidate!.sha }); return merge(candidate, index); } }), () => start + index * 20_000);
  }
  return { state, calls };
}

test('unit:merge-retries-until-merged-or-head-moves — an unknown outcome keeps retrying across ticks, never more than a minute apart, and stops on a merged observation', async () => {
  const { state, calls } = await tick(30, () => mergeable(), async (_item, index) => {
    if (index < 20) throw new Error('gh: Bad Gateway (HTTP 502); the merge outcome is unknown, so Graphyard retained execution x until observation or expiry');
    return { result: 'merge requested', merged: { sha: mergeCommit, at: null } };
  });
  assert.ok(calls.length >= 7, `retries continue across ticks (saw ${calls.length})`);
  for (let index = 1; index < calls.length; index++) assert.ok((calls[index].tick - calls[index - 1].tick) * 20_000 <= mergeRetryCapMs + 20_000, `retry ${index} waited at most the one-minute cap plus one tick`);
  const merged = calls.findIndex(call => call.tick >= 20);
  assert.ok(merged >= 0, 'the retry that GitHub answered merged ran'); assert.equal(calls.length, merged + 1, 'no retry after the merged observation');
  assert.equal(state.actions[candidateKey('merge', mergeable())].state, 'done');
});

test('unit:merge-retries-until-merged-or-head-moves — an attempt without a merged observation is never recorded done, and retries stop once the head moves', async () => {
  const moved = 'd'.repeat(40);
  const { state, calls } = await tick(24, index => index < 12 ? mergeable() : mergeable(moved, 'review'), async () => ({ result: 'merge requested', merged: null }));
  const before = calls.filter(call => call.tick < 12), after = calls.filter(call => call.tick >= 12);
  assert.ok(before.length >= 4, `retries continue while the head is unchanged (saw ${before.length})`);
  assert.equal(before.every(call => call.sha === sha), true);
  assert.deepEqual(after, [], 'no merge is attempted for the old head once it moved');
  const key = state.actions[candidateKey('merge', mergeable())];
  assert.equal(key.state, 'failed', 'an attempt GitHub never showed merged is not done'); assert.match(key.detail, /without GitHub showing the pull request merged/);
});
