import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertDispatchable, assertMasterBinding, assessContainment, snapshotWithClock, verifyContainmentDeath, assertMergeCandidate, assertMergeProtection, assertQueuedLanding, buildMasterStatus, continueMergeBatch, currentMergeCandidates, dispatchWork, githubProviderDelay, inspectWorkerCredentials, loadMasterConfig, managedMasterInstructions, mergeWork, observeHerdrAgents, prepareWorkerLaunch, saveWorkerProfile, setupMaster, startMaster, workerProfileSchema } from '../src/master.js';
import type { Work } from '../src/model.js';

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const workerToken = 'worker-token-'.padEnd(40, 'x');
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-master-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  return root;
}
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const validProtection = { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: 'Graphyard / merge', app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
function work(overrides: Partial<Work> = {}) {
  const candidate = { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' };
  const queue = { sequence: 1, enqueuedAt: '2030-01-01T00:30:00Z', policyRevision: 2,
    speculation: { ref: 'refs/graphyard/queue/gy-42', tip: candidate.sha, base: candidate.baseSha, baseTree: 'e'.repeat(40), predecessors: [], policyRevision: 2, publishedAt: '2030-01-01T00:31:00Z' } };
  return { id: 'work-id', key: 'GY-42', queue, title: 'Prove the master flow', description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:master'] }], policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'merge', revision: 9, policyRevision: 2, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 42 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [{ name: 'merge', passed: true, reasons: [] }], violations: [], mergeAuthorization: { sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 2, at: new Date().toISOString() }, ...overrides } as Work;
}

test('master instructions are managed idempotently without replacing repository rules', () => {
  const bootstrap = "The initial MVP is a single-agent bootstrap under the operator's supervision. Do not launch other agents for bootstrap work.";
  const original = `# Local rules\n${bootstrap}\nKeep this text.\n`; const first = managedMasterInstructions(original);
  assert.ok(first.startsWith(original)); assert.match(first, /dedicated, visible master-agent session/);
  assert.match(first, /Keep cycling: status, dispatch ready work, shepherd review and proof collection,\nguarded merge, then deployment verification/);
  assert.match(first, /both conditions hold:\n\(1\) every in-scope item is Done or has a genuinely external blocker recorded in\nGraphyard; and \(2\) the merged change is deployed and live-verified against the exact\ndeployed release, or a genuinely external deployment blocker is recorded in Graphyard/);
  assert.match(first, /An observed merge alone does\nnot end the loop/);
  for (const condition of ['Ordinary review', 'rework', 'idle workers', 'proof setup', 'Close finished agent sessions']) assert.match(first, new RegExp(condition));
  assert.equal(first.split(bootstrap).length - 1, 1, 'master setup preserves the protected bootstrap rule byte-for-byte');
  assert.equal(managedMasterInstructions(first), first);
  assert.throws(() => managedMasterInstructions(first + first), /markers/);
});

test('master init verifies a coordinator and repository before writing private local configuration', async () => {
  const root = await repository(); const credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-master-credentials-'));
  try {
    const result = await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, herdrWorkspace: 'workspace-graphyard' }, coordinatorStatus as typeof fetch);
    assert.equal(result.autoMerge, true); assert.equal(result.role, 'coordinator');
    assert.equal((await stat(join(root, '.graphyard/master.json'))).mode & 0o777, 0o600);
    assert.equal(execFileSync('git', ['check-ignore', '.graphyard/master.json'], { cwd: root, encoding: 'utf8' }).trim(), '.graphyard/master.json');
    assert.match(await readFile(join(root, 'AGENTS.md'), 'utf8'), /Graphyard master agent/);
    const master = await loadMasterConfig(root); assert.equal(await readFile(master.credentialFile, 'utf8'), coordinatorToken); assert.equal(master.baseBranch, 'main'); assert.equal(master.herdrWorkspace, 'workspace-graphyard'); assert.equal(master.credentialFile.startsWith(`${root}/`), false);
    assert.equal((await readFile(join(root, '.graphyard/master.json'), 'utf8')).includes(coordinatorToken), false);
    const workerConnection = JSON.stringify({ url: 'https://graphyard.example', token: workerToken, cliPath: launcher, hostId: 'machine-a' });
    await writeFile(join(root, '.graphyard/connection.json'), workerConnection, { mode: 0o600 });
    await assert.rejects(setupMaster(root, { url: 'https://other.example', token: coordinatorToken, cliPath: launcher, credentialDirectory }, coordinatorStatus as typeof fetch), /another Graphyard server/);
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, herdrWorkspace: 'workspace-graphyard' }, coordinatorStatus as typeof fetch);
    assert.equal(await readFile(join(root, '.graphyard/connection.json'), 'utf8'), workerConnection, 'master setup must not replace a worker connection');
    await assert.rejects(setupMaster(root, { url: 'https://graphyard.example', token: workerToken, cliPath: launcher, credentialDirectory }, (async () => new Response(JSON.stringify({ actor: { id: 'worker', role: 'worker' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch), /coordinator credential/);
    await assert.rejects(setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory }, (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: null, baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch), /bound to a GitHub repository/);
    const linkedConfig = join(credentialDirectory, 'linked-inside'); await symlink(root, linkedConfig, 'dir');
    await assert.rejects(setupMaster(root, { url: 'https://graphyard.example', token: `${coordinatorToken}-symlink`, cliPath: launcher, credentialDirectory: linkedConfig }, coordinatorStatus as typeof fetch), /outside every worktree/);
    assert.deepEqual(await readdir(join(root, 'masters')), [], 'canonical-path refusal occurs before credential bytes are written');
    const localCredential = join(root, 'coordinator.token'); await writeFile(localCredential, coordinatorToken, { mode: 0o600 });
    await writeFile(join(root, '.graphyard/master.json'), JSON.stringify({ ...master, credentialFile: localCredential }), { mode: 0o600 });
    await assert.rejects(loadMasterConfig(root), /outside the repository/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});

test('master init refuses a coordinator destination in a sibling worktree before writing a token', async () => {
  const root = await repository(); const siblingParent = await mkdtemp(join(tmpdir(), 'graphyard-master-sibling-')); const sibling = join(siblingParent, 'worktree');
  try {
    execFileSync('git', ['-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: root });
    execFileSync('git', ['worktree', 'add', '--detach', sibling], { cwd: root, stdio: 'ignore' });
    const destination = join(sibling, 'private');
    await assert.rejects(setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: destination }, coordinatorStatus as typeof fetch), /outside every worktree/);
    assert.deepEqual(await readdir(join(destination, 'masters')), [], 'setup may create the directory but writes no credential bytes before refusal');
  } finally { try { execFileSync('git', ['worktree', 'remove', '--force', sibling], { cwd: root, stdio: 'ignore' }); } catch {} await rm(root, { recursive: true, force: true }); await rm(siblingParent, { recursive: true, force: true }); }
});

test('worker profiles support existing sessions and launch profiles without embedded secrets', async () => {
  assert.equal(workerProfileSchema.safeParse({ name: 'existing', principal: 'worker-a', agentName: 'eng-a', mode: 'existing' }).success, true);
  assert.equal(workerProfileSchema.safeParse({ name: 'launch', principal: 'worker-b', agentName: 'eng-b', mode: 'launch', kind: 'codex', credentialFile: '/private/worker.token', environment: { OPENAI_API_KEY: 'secret' } }).success, false);
  assert.equal(workerProfileSchema.safeParse({ name: 'launch', principal: 'worker-b', agentName: 'eng-b', mode: 'launch', kind: 'codex', credentialFile: '/private/worker.token', environment: { GRAPHYARD_REQUEST_ID: 'persistent' } }).success, false);
  assert.equal(workerProfileSchema.safeParse({ name: 'launch', principal: 'worker-b', agentName: 'eng-b', mode: 'launch', kind: 'codex', credentialFile: '/private/worker.token', environment: { CODEX_HOME: 'bad\nvalue' } }).success, false);
  assert.equal(workerProfileSchema.safeParse({ name: 'launch', principal: 'worker-b', agentName: 'eng-b', mode: 'launch', kind: 'codex', credentialFile: '/private/worker.token', environment: { CODEX_HOME: '/profiles/two' } }).success, true);
});

test('master status derives ownership from Graphyard and only joins Herdr health', () => {
  const active = work({ stage: 'build', lease: { owner: 'worker-a', epoch: 3, expiresAt: '2030-01-01T00:10:00Z' }, gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted'] }] });
  const result = buildMasterStatus({ work: [active], now: '2030-01-01T00:00:00Z' }, [{ name: 'profile-a', principal: 'worker-a', agentName: 'eng-a', mode: 'existing', agentArgs: [], approvals: 'auto', environment: {} }], [{ name: 'eng-a', agent_status: 'working', pane_id: 'p1' }]);
  assert.equal(result.work[0].owner, 'worker-a'); assert.equal(result.work[0].session, 'working'); assert.equal(result.counts.active, 1);
  const spoofed = buildMasterStatus({ work: [active], now: '2030-01-01T00:20:00Z' }, [], [{ name: 'worker-a', agent_status: 'working' }]);
  assert.equal(spoofed.work[0].owner, null, 'Herdr cannot extend an expired Graphyard assignment');
  const unavailable = observeHerdrAgents(() => { throw new Error('daemon unavailable'); });
  assert.equal(unavailable.available, false); assert.deepEqual(unavailable.agents, []); assert.match(unavailable.reason!, /Graphyard work state remains authoritative/);
});

test('master commands refuse a changed repository or managed base binding', () => {
  const config = { version: 1 as const, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge' as const, workers: [], reviewers: [], run: { intervalSeconds: 20, deploymentShaField: 'commit' } };
  assert.doesNotThrow(() => assertMasterBinding(config, { actor: { role: 'coordinator' }, repository: 'OWNER/project', baseBranch: 'main', githubAppId: 1234 }));
  assert.throws(() => assertMasterBinding(config, { actor: { role: 'coordinator' }, repository: 'owner/other', baseBranch: 'main', githubAppId: 1234 }), /rerun master init/);
  assert.throws(() => assertMasterBinding(config, { actor: { role: 'coordinator' }, repository: 'owner/project', baseBranch: 'release', githubAppId: 1234 }), /rerun master init/);
  assert.throws(() => assertMasterBinding(config, { actor: { role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 9999 }), /rerun master init/);
});

test('dispatch launches through watch and requires lifecycle-reported readiness before prompting', async () => {
  const root = await repository(); const credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-master-credentials-')); const calls: string[][] = [];
  try {
    const credential = join(credentialDirectory, 'worker.token'); await writeFile(credential, workerToken, { mode: 0o600 });
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, herdrWorkspace: 'workspace-graphyard' }, coordinatorStatus as typeof fetch);
    const profile = { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch' as const, kind: 'codex' as const, credentialFile: credential, agentArgs: [], approvals: 'auto' as const, environment: {} };
    let probes = 0;
    const result = await dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null }), profile, [], (_command, args) => { calls.push(args); return JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'p1', tab_id: 't1' }, tab: { tab_id: 't1' } } : args[1] === 'get' ? { type: 'agent_info', agent: { pane_id: 'p1', agent_status: ++probes === 1 ? 'working' : 'idle' } } : {} }); }, undefined, async () => ({ epoch: 4, path: join(root, 'assigned'), base: 'c'.repeat(40) }));
    assert.match(result.ownership, /supervising/);
    assert.deepEqual(calls[0].slice(0, 4), ['tab', 'create', '--workspace', 'workspace-graphyard']); assert.ok(calls[0].includes('GRAPHYARD_HERDR_AGENT_KIND=codex'));
    assert.deepEqual(calls[1].slice(0, 3), ['pane', 'run', 'p1']); assert.match(calls[1][3], /watch' 'GY-42' '4' '--' 'codex'/); assert.equal(probes, 2);
    assert.deepEqual(calls.at(-1)!.slice(0, 3), ['agent', 'prompt', 'eng-a']); assert.doesNotMatch(calls.at(-1)![3], /coordinator-token/);
    const failedCalls: string[][] = []; let releasedEpoch = 0;
    await assert.rejects(dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null }), profile, [], (_command, args) => { failedCalls.push(args); return JSON.stringify({ result: args[0] === 'tab' ? { pane_id: 'late-pane' } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} }); }, undefined, async () => ({ epoch: 5, path: join(root, 'late'), base: 'd'.repeat(40) }), async (_root, _key, epoch) => { releasedEpoch = epoch; }, 1), /did not become visible/);
    assert.equal(releasedEpoch, 5); assert.deepEqual(failedCalls.at(-2), ['pane', 'close', 'late-pane']); assert.deepEqual(failedCalls.at(-1), ['pane', 'list']);
    const promptCalls: string[][] = []; let promptRelease = 0;
    await assert.rejects(dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null }), profile, [], (_command, args) => {
      promptCalls.push(args); if (args[1] === 'prompt') throw new Error('prompt refused');
      return JSON.stringify({ result: args[0] === 'tab' ? { pane_id: 'prompt-pane' } : args[1] === 'get' ? { type: 'agent_info', agent: { pane_id: 'prompt-pane', agent_status: 'idle' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
    }, undefined, async () => ({ epoch: 6, path: join(root, 'prompt'), base: 'e'.repeat(40) }), async (_root, _key, epoch) => { promptRelease = epoch; }), /prompt refused/);
    assert.equal(promptRelease, 6); assert.deepEqual(promptCalls.at(-2), ['pane', 'close', 'prompt-pane']); assert.deepEqual(promptCalls.at(-1), ['pane', 'list']);
    let unsafeRelease = false;
    await assert.rejects(dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null }), profile, [], (_command, args) => {
      if (args[0] === 'pane' && args[1] === 'close') throw new Error('daemon unavailable');
      return JSON.stringify({ result: args[0] === 'tab' ? { pane_id: 'unsafe-pane' } : {} });
    }, undefined, async () => ({ epoch: 7, path: join(root, 'unsafe'), base: 'f'.repeat(40) }), async () => { unsafeRelease = true; }, 1), /retained epoch 7/);
    assert.equal(unsafeRelease, false, 'ownership remains fenced until pane shutdown is confirmed');
    let malformedRelease = 0; const malformedCalls: string[][] = [];
    let cleanupProbes = 0;
    await assert.rejects(dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null }), profile, [], (_command, args) => {
      malformedCalls.push(args);
      return JSON.stringify({ result: args[0] === 'tab' && args[1] === 'create' ? { type: 'tab_created', root_pane: { pane_id: null }, tab: { tab_id: 'worker-malformed-tab' } } : args[0] === 'tab' && args[1] === 'list' ? { tabs: ++cleanupProbes === 1 ? [{ tab_id: 'worker-malformed-tab' }] : [] } : {} });
    }, undefined, async () => ({ epoch: 8, path: join(root, 'malformed'), base: '1'.repeat(40) }), async (_root, _key, epoch) => { malformedRelease = epoch; }), /valid new pane/);
    assert.equal(malformedRelease, 8); assert.equal(cleanupProbes, 2); assert.deepEqual(malformedCalls.at(-3), ['tab', 'close', 'worker-malformed-tab']); assert.deepEqual(malformedCalls.at(-1), ['tab', 'list']);
    let blockedProbes = 0, blockedRelease = 0; const blockedStarted = performance.now();
    await assert.rejects(dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null }), profile, [], (_command, args) => {
      if (args[0] === 'agent' && args[1] === 'get') { blockedProbes++; return JSON.stringify({ result: { agent: { pane_id: 'blocked-pane', agent_status: 'blocked' } } }); }
      return JSON.stringify({ result: args[0] === 'tab' ? { pane_id: 'blocked-pane' } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
    }, undefined, async () => ({ epoch: 9, path: join(root, 'blocked'), base: '2'.repeat(40) }), async (_root, _key, epoch) => { blockedRelease = epoch; }, 5_000), /blocked before it is ready/);
    assert.equal(blockedProbes, 1); assert.equal(blockedRelease, 9); assert.ok(performance.now() - blockedStarted < 1_000, 'blocked state must bypass lookup retries');
    const existing = { name: 'existing', principal: 'worker-a', agentName: 'existing-a', mode: 'existing' as const, agentArgs: [], approvals: 'auto' as const, environment: {} };
    await assert.rejects(dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null }), existing, [{ name: 'existing-a', agent_status: 'idle', cwd: root }]), /cannot be safely adopted/);
    const dependency = work({ id: 'dependency', key: 'GY-41', stage: 'build' });
    await assert.rejects(dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null, dependencies: [dependency.id] }), profile, [], undefined, [dependency]), /unfinished dependencies/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});

test('dispatch claimability permits operator-authorized rework independent of display stage', () => {
  const rework = work({ stage: 'build', reworkRequested: true, lease: null });
  assert.doesNotThrow(() => assertDispatchable(rework, [rework], '2030-01-01T00:00:00Z'));
  assert.throws(() => assertDispatchable(work({ stage: 'merge', reworkRequested: false }), [], '2030-01-01T00:00:00Z'), /operator-authorized rework/);
  assert.throws(() => assertDispatchable(work({ stage: 'ready', submission: null, lease: { owner: 'worker-a', epoch: 2, expiresAt: '2030-01-01T00:01:00Z' } }), [], '2030-01-01T00:00:00Z'), /active owner/);
  assert.throws(() => assertDispatchable(work({ stage: 'ready', submission: null, lease: null, containmentQuarantine: { owner: 'worker-a', epoch: 2, at: '2030-01-01T00:00:00Z', settlementHash: 'a'.repeat(64) } }), [], '2030-01-01T00:02:00Z'), /unverified worker containment/);
  const candidate = work({ id: 'candidate', key: 'GY-43', stage: 'ready', submission: null, lease: null, exclusiveResources: ['staging'] });
  const quarantined = work({ id: 'quarantined', key: 'GY-44', lease: { owner: 'worker-b', epoch: 3, expiresAt: '2029-12-31T23:59:00Z' }, exclusiveResources: ['staging'], containmentQuarantine: { owner: 'worker-b', epoch: 3, at: '2029-12-31T23:58:00Z', settlementHash: 'b'.repeat(64) } });
  assert.throws(() => assertDispatchable(candidate, [candidate, quarantined], '2030-01-01T00:00:00Z'), /staging held by GY-44/);
});

test('master start creates a visible non-focused coordinator session with no credential argument', async () => {
  const root = await repository(); const credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-master-credentials-')); const calls: string[][] = [];
  try {
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, herdrWorkspace: 'workspace-graphyard' }, coordinatorStatus as typeof fetch);
    const result = await startMaster(root, 'codex', ['--model', 'reviewer'], [], (_command, args) => {
      calls.push(args);
      return JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'pane-master', tab_id: 'tab-master' }, tab: { tab_id: 'tab-master' } } : {} });
    });
    assert.equal(result.focusChanged, false); assert.equal(result.pane, 'pane-master');
    assert.ok(calls[0].includes('--no-focus')); assert.deepEqual(calls[0].slice(0, 4), ['tab', 'create', '--workspace', 'workspace-graphyard']); assert.ok(calls[1].includes('codex'));
    assert.match(calls[2].at(-1)!, /dedicated Graphyard master agent/);
    assert.equal(JSON.stringify(calls).includes(coordinatorToken), false);
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, autoMerge: false }, coordinatorStatus as typeof fetch);
    const manualCalls: string[][] = [];
    await startMaster(root, 'codex', [], [], (_command, args) => { manualCalls.push(args); return JSON.stringify({ result: args[0] === 'tab' ? { pane_id: 'manual-master' } : {} }); });
    assert.match(manualCalls[2].at(-1)!, /Automatic merging is disabled.*explicit operator approval/);
    const failedCalls: string[][] = [];
    await assert.rejects(startMaster(root, 'codex', [], [], (_command, args) => {
      failedCalls.push(args); if (args[1] === 'prompt') throw new Error('prompt refused');
      return JSON.stringify({ result: args[0] === 'tab' ? { pane_id: 'failed-master' } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
    }), /prompt refused/);
    assert.deepEqual(failedCalls.at(-2), ['pane', 'close', 'failed-master']); assert.deepEqual(failedCalls.at(-1), ['pane', 'list']);
    const malformedCalls: string[][] = [];
    await assert.rejects(startMaster(root, 'codex', [], [], (_command, args) => {
      malformedCalls.push(args);
      return JSON.stringify({ result: args[0] === 'tab' && args[1] === 'create' ? { type: 'tab_created', root_pane: { pane_id: 42 }, tab: { tab_id: 'malformed-tab' } } : args[0] === 'tab' && args[1] === 'list' ? { tabs: [] } : {} });
    }), /valid new pane/);
    assert.deepEqual(malformedCalls.at(-2), ['tab', 'close', 'malformed-tab']); assert.deepEqual(malformedCalls.at(-1), ['tab', 'list']);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});

test('launch profiles verify a private worker credential and match its principal', async () => {
  const root = await repository(); const credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-master-credentials-')); const credential = join(credentialDirectory, 'worker.token'); const siblingParent = await mkdtemp(join(tmpdir(), 'graphyard-sibling-')); const sibling = join(siblingParent, 'worktree');
  try {
    await writeFile(credential, workerToken, { mode: 0o600 });
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, hostId: 'stable-host', autoMerge: false, mergeMethod: 'squash' }, coordinatorStatus as typeof fetch);
    const result = await saveWorkerProfile(root, { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: credential }, async token => ({ actor: { id: token === workerToken ? 'worker-a' : 'wrong', role: 'worker' } }));
    assert.equal(result.workers, 1); assert.equal((await loadMasterConfig(root)).workers[0].credentialFile, credential);
    const before = await loadMasterConfig(root); await rm(before.credentialFile);
    await setupMaster(root, { url: 'https://graphyard.example', token: `${coordinatorToken}-replacement`, cliPath: launcher, credentialDirectory }, coordinatorStatus as typeof fetch);
    const recovered = await loadMasterConfig(root); assert.equal(recovered.workers.length, 1); assert.equal(recovered.hostId, 'stable-host'); assert.equal(recovered.autoMerge, false); assert.equal(recovered.mergeMethod, 'squash');
    await rm(credential);
    assert.equal((await loadMasterConfig(root)).workers.length, 1, 'one unavailable worker must not disable coordinator commands');
    const health = await inspectWorkerCredentials(root, recovered.workers); assert.equal(health.launch.available, false); assert.match(health.launch.reason!, /worker\.token|ENOENT/);
    const status = buildMasterStatus({ work: [], now: new Date().toISOString() }, recovered.workers, [], health); assert.equal(status.workers[0].credential.available, false);
    await writeFile(credential, workerToken, { mode: 0o600 });
    await chmod(credential, 0o644);
    await assert.rejects(saveWorkerProfile(root, { name: 'other', principal: 'worker-b', agentName: 'eng-b', mode: 'launch', kind: 'claude', credentialFile: credential }, async () => ({ actor: { id: 'worker-b', role: 'worker' } })), /0600/);
    await chmod(credential, 0o600);
    await writeFile(join(root, 'worker-local.token'), workerToken, { mode: 0o600 });
    await assert.rejects(saveWorkerProfile(root, { name: 'local', principal: 'worker-c', agentName: 'eng-c', mode: 'launch', kind: 'codex', credentialFile: join(root, 'worker-local.token') }, async () => ({ actor: { id: 'worker-c', role: 'worker' } })), /outside every worktree/);
    execFileSync('git', ['-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: root });
    execFileSync('git', ['worktree', 'add', '--detach', sibling], { cwd: root, stdio: 'ignore' });
    const siblingCredential = join(sibling, 'worker.token'); await writeFile(siblingCredential, workerToken, { mode: 0o600 });
    await assert.rejects(saveWorkerProfile(root, { name: 'sibling', principal: 'worker-d', agentName: 'eng-d', mode: 'launch', kind: 'codex', credentialFile: siblingCredential }, async () => ({ actor: { id: 'worker-d', role: 'worker' } })), /every worktree/);
  } finally { try { execFileSync('git', ['worktree', 'remove', '--force', sibling], { cwd: root, stdio: 'ignore' }); } catch {} await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); await rm(siblingParent, { recursive: true, force: true }); }
});

test('a launch profile token file overrides ambient Graphyard credentials', async () => {
  const root = await repository(); const credential = join(root, 'worker.token'); let authorization = '';
  const http = createServer((request, response) => { authorization = String(request.headers.authorization ?? ''); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ actor: { id: 'worker-a', role: 'worker' } })); });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  try {
    await writeFile(credential, workerToken, { mode: 0o600 });
    const url = `http://127.0.0.1:${(http.address() as any).port}`;
    await promisify(execFile)(process.execPath, [launcher, 'status'], { cwd: root, env: { ...process.env, GRAPHYARD_URL: url, GRAPHYARD_TOKEN: 'ambient-admin-token-'.padEnd(40, 'x'), GRAPHYARD_TOKEN_FILE: credential } });
    assert.equal(authorization, `Bearer ${workerToken}`);
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test('worker preparation claims and creates the assigned worktree from the current managed base', async () => {
  const root = await repository(); const credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-master-credentials-')); const credential = join(credentialDirectory, 'worker.token'); const calls: { args: string[]; options: any }[] = [];
  try {
    await writeFile(credential, workerToken, { mode: 0o600 });
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory }, coordinatorStatus as typeof fetch);
    await saveWorkerProfile(root, { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: credential }, async () => ({ actor: { id: 'worker-a', role: 'worker' } }));
    const base = 'c'.repeat(40);
    const previousRequestId = process.env.GRAPHYARD_REQUEST_ID; process.env.GRAPHYARD_REQUEST_ID = 'outer-dispatch-retry';
    const prepared = await prepareWorkerLaunch(root, 'GY-42', 'launch', (command, args, options) => {
      calls.push({ args, options });
      if (command === 'git') return args[0] === 'rev-parse' ? `${base}\n` : '';
      return args[1] === 'claim' ? JSON.stringify({ epoch: 4, lease: { owner: 'worker-a' } }) : JSON.stringify({ path: join(root, 'assigned') });
    });
    assert.equal(prepared.epoch, 4); assert.equal(prepared.path, join(root, 'assigned')); assert.deepEqual(calls[0].args.slice(0, 5), ['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']); assert.equal(calls[2].args[1], 'claim'); assert.equal(calls[3].args[1], 'worktree'); assert.equal(calls[3].args[4], base);
    assert.equal(calls[2].options.env.GRAPHYARD_TOKEN, undefined); assert.equal(calls[2].options.env.GRAPHYARD_TOKEN_FILE, credential); assert.equal(calls[2].options.env.GRAPHYARD_REQUEST_ID, undefined);
    if (previousRequestId === undefined) delete process.env.GRAPHYARD_REQUEST_ID; else process.env.GRAPHYARD_REQUEST_ID = previousRequestId;
    const failed: string[][] = [];
    await assert.rejects(prepareWorkerLaunch(root, 'GY-42', 'launch', (command, args) => {
      failed.push(args);
      if (command === 'git') return args[0] === 'rev-parse' ? `${base}\n` : '';
      if (args[1] === 'claim') return JSON.stringify({ epoch: 6, lease: { owner: 'worker-a' } });
      if (args[1] === 'worktree') throw new Error('checkout failed');
      return '{}';
    }), /checkout failed/);
    assert.equal(failed.at(-1)![1], 'release'); assert.equal(failed.at(-1)![3], '6');
    const changedIdentity: string[][] = [];
    await assert.rejects(prepareWorkerLaunch(root, 'GY-42', 'launch', (command, args) => {
      changedIdentity.push(args);
      if (command === 'git') return args[0] === 'rev-parse' ? `${base}\n` : '';
      if (args[1] === 'claim') return JSON.stringify({ epoch: 7, lease: { owner: 'rotated-worker' } });
      return '{}';
    }), /unexpected assignment identity/);
    assert.equal(changedIdentity.at(-1)![1], 'release'); assert.equal(changedIdentity.at(-1)![3], '7');
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/other/project.git'], { cwd: root });
    await assert.rejects(prepareWorkerLaunch(root, 'GY-42', 'launch'), /different repositories/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});

// A fake store for the broker: before acquire the record carries no execution;
// afterwards it carries the one the engine recorded, which is what the pre-merge
// re-read checks.
function broker(item: Work, active: NonNullable<Work['mergeExecution']>) {
  let held = item.mergeExecution ?? null;
  return [
    async () => ({ work: [held ? { ...item, mergeExecution: held } : item], now: new Date().toISOString() }),
    async () => { held = active; return { execution: active }; },
  ] as const;
}

test('routine merge is exact-candidate, double-checked, and never uses an admin bypass', async () => {
  const candidate = work({ observation: { at: new Date().toISOString(), candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' } } as any }); const config = { version: 1 as const, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge' as const, workers: [], reviewers: [], run: { intervalSeconds: 20, deploymentShaField: 'commit' } };
  const calls: string[][] = [];
  const execution = { id: '11111111-1111-4111-8111-111111111111', owner: 'master', sha: candidate.candidate!.sha, baseSha: candidate.candidate!.baseSha, policyRevision: 2, authorizationRevision: candidate.revision, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString() };
  const acquire = async () => ({ execution }); const cancel = async () => ({}); const verify = async () => ({ executionId: execution.id, sha: execution.sha, verifiedAt: new Date(Date.now() - 2000).toISOString(), providerDelayMs: 0 });
  const result = await mergeWork(config, candidate, ...broker(candidate, execution), cancel, verify, (_command, args) => {
    calls.push(args);
    if (args[1] === 'view') return JSON.stringify({ headRefOid: candidate.candidate!.sha, baseRefOid: candidate.candidate!.baseSha, baseRefName: 'main', state: 'OPEN', isDraft: false });
    if (args.includes('--include')) return `Date: ${new Date().toUTCString()}\n\n{}`;
    return args[1] === '--method' ? JSON.stringify({ merged: true, sha: 'c'.repeat(40) }) : JSON.stringify(validProtection);
  });
  assert.equal(result.result.startsWith('merge requested'), true);
  assert.deepEqual(calls[4].slice(0, 3), ['api', '--method', 'PUT']); assert.ok(calls[4].includes(`sha=${candidate.candidate!.sha}`)); assert.equal(calls[4].includes('--admin'), false);
  assert.doesNotThrow(() => assertMergeProtection(validProtection, config, candidate));
  assert.throws(() => assertMergeProtection({ ...validProtection, required_status_checks: { ...validProtection.required_status_checks, checks: [] } }, config, candidate), /protection changed/);
  assert.throws(() => assertMergeProtection({ ...validProtection, required_status_checks: { ...validProtection.required_status_checks, strict: true } }, config, candidate), /requires branches to be up to date/);
  assert.throws(() => assertMergeCandidate(work({ gates: [{ name: 'acceptance', passed: false, reasons: ['Human approval required'] }] })), /does not have/);
  let reads = 0; await assert.rejects(mergeWork(config, candidate, async () => ({ work: [reads++ ? work({ revision: 10 }) : candidate], now: new Date().toISOString() }), acquire, cancel, verify, () => JSON.stringify({ headRefOid: candidate.candidate!.sha, baseRefOid: candidate.candidate!.baseSha, baseRefName: 'main', state: 'OPEN', isDraft: false })), /changed after/);
  await assert.rejects(mergeWork(config, candidate, ...broker(candidate, execution), cancel, verify, () => JSON.stringify({ headRefOid: candidate.candidate!.sha, baseRefOid: candidate.candidate!.baseSha, baseRefName: 'release', state: 'OPEN', isDraft: false })), /changed on GitHub/);
  const stale = work({ observation: { at: '2000-01-01T00:00:00Z' } as any });
  await assert.rejects(mergeWork(config, stale, async () => ({ work: [stale], now: new Date().toISOString() }), acquire, cancel, verify), /does not have/);
  let cancelled = '';
  await assert.rejects(mergeWork(config, candidate, ...broker(candidate, execution), async (_work, authority) => { cancelled = authority.id; }, verify, (_command, args) => {
    if (args[1] === 'view') return JSON.stringify({ headRefOid: candidate.candidate!.sha, baseRefOid: candidate.candidate!.baseSha, baseRefName: 'main', state: 'OPEN', isDraft: false });
    if (args.includes('--include')) return `Date: ${new Date().toUTCString()}\n\n{}`;
    if (args[1] !== '--method') return JSON.stringify(validProtection);
    throw new Error('provider response lost');
  }), /outcome is unknown/);
  assert.equal(cancelled, '', 'an unknown provider outcome retains authority');
  await assert.rejects(mergeWork(config, candidate, ...broker(candidate, execution), async (_work, authority) => { cancelled = authority.id; }, verify, (_command, args) => {
    if (args[1] === 'view') return JSON.stringify({ headRefOid: candidate.candidate!.sha, baseRefOid: candidate.candidate!.baseSha, baseRefName: 'main', state: 'OPEN', isDraft: false });
    if (args.includes('--include')) return `Date: ${new Date().toUTCString()}\n\n{}`;
    if (args[1] !== '--method') return JSON.stringify(validProtection);
    return JSON.stringify({ merged: false, message: 'branch protection refused merge' });
  }), /branch protection refused merge/);
  assert.equal(cancelled, execution.id);
  cancelled = '';
  await assert.rejects(mergeWork(config, candidate, ...broker(candidate, execution), async (_work, authority) => { cancelled = authority.id; }, async () => { throw new Error('verification response lost'); }, (_command, args) => {
    if (args[1] === 'view') return JSON.stringify({ headRefOid: candidate.candidate!.sha, baseRefOid: candidate.candidate!.baseSha, baseRefName: 'main', state: 'OPEN', isDraft: false });
    return JSON.stringify(validProtection);
  }), /retained execution/);
  assert.equal(cancelled, '', 'an unknown verification outcome retains authority for replay');
  const confirmed = Object.assign(new Error('verification refused'), { confirmedRefusal: true });
  await assert.rejects(mergeWork(config, candidate, ...broker(candidate, execution), async (_work, authority) => { cancelled = authority.id; }, async () => { throw confirmed; }, (_command, args) => {
    if (args[1] === 'view') return JSON.stringify({ headRefOid: candidate.candidate!.sha, baseRefOid: candidate.candidate!.baseSha, baseRefName: 'main', state: 'OPEN', isDraft: false });
    return JSON.stringify(validProtection);
  }), /verification refused/);
  assert.equal(cancelled, execution.id, 'a confirmed verification refusal cancels authority');
  const resumed = work({ observation: candidate.observation, mergeExecution: execution }); let reacquired = false;
  const resumedResult = await mergeWork(config, resumed, async () => ({ work: [resumed], now: new Date().toISOString() }), async () => { reacquired = true; return { execution }; }, cancel, verify, (_command, args) => {
    if (args[1] === 'view') return JSON.stringify({ headRefOid: resumed.candidate!.sha, baseRefOid: resumed.candidate!.baseSha, baseRefName: 'main', state: 'OPEN', isDraft: false });
    if (args.includes('--include')) return `Date: ${new Date().toUTCString()}\n\n{}`;
    return args[1] === '--method' ? JSON.stringify({ merged: true, sha: 'c'.repeat(40) }) : JSON.stringify(validProtection);
  }, execution.owner);
  assert.equal(reacquired, false, 'the owning coordinator resumes its active authority'); assert.match(resumedResult.result, /merge requested/);
  assert.throws(() => assertMergeCandidate(resumed, new Date().toISOString(), 'different-master'), /does not have/);
  const uncertain = work({ observation: candidate.observation, mergeExecution: { ...execution, verifiedAt: new Date().toISOString() } });
  const recovered = await mergeWork(config, uncertain, async () => ({ work: [uncertain], now: new Date().toISOString() }), async () => { throw new Error('must not reacquire'); }, cancel, verify, () => { throw new Error('must not repeat a possibly attempted provider call'); }, execution.owner);
  assert.match(recovered.result, /already committed/);
  const lateExecution = { ...execution, issuedAt: new Date(Date.now() - 110_000).toISOString(), expiresAt: new Date(Date.now() + 10_000).toISOString() };
  const late = work({ observation: candidate.observation, mergeExecution: lateExecution }); cancelled = '';
  await assert.rejects(mergeWork(config, late, async () => ({ work: [late], now: new Date().toISOString() }), async () => { throw new Error('must not reacquire'); }, async (_work, authority) => { cancelled = authority.id; }, verify, (_command, args) => {
    if (args[1] === 'view') return JSON.stringify({ headRefOid: late.candidate!.sha, baseRefOid: late.candidate!.baseSha, baseRefName: 'main', state: 'OPEN', isDraft: false });
    return JSON.stringify(validProtection);
  }, execution.owner), /does not remain valid/);
  assert.equal(cancelled, lateExecution.id, 'a resumed execution uses its actual remaining lifetime');

  // Final verification and the provider call are separated by the clock-ordering
  // delay. A concern raised inside that window fences the execution, and the
  // broker re-reads the record before handing the merge to GitHub, so a lead
  // escalate or send-back after verification is never delivered.
  let providerCalls: string[][] = [];
  const gh = (_command: string, args: string[]) => {
    providerCalls.push(args);
    if (args[1] === 'view') return JSON.stringify({ headRefOid: candidate.candidate!.sha, baseRefOid: candidate.candidate!.baseSha, baseRefName: 'main', state: 'OPEN', isDraft: false });
    if (args.includes('--include')) return `Date: ${new Date().toUTCString()}\n\n{}`;
    return args[1] === '--method' ? JSON.stringify({ merged: true, sha: 'c'.repeat(40) }) : JSON.stringify(validProtection);
  };
  // Each broker run re-reads the record three times: before GitHub verification,
  // after it, and once more immediately before the provider call.
  const afterVerification = (settled: Partial<Work>) => { let reads = 0; return async () => ({ work: [{ ...candidate, mergeExecution: execution, ...(reads++ < 2 ? {} : settled) }], now: new Date().toISOString() }); };
  cancelled = ''; providerCalls = [];
  await assert.rejects(mergeWork(config, candidate, afterVerification({ mergeExecution: { ...execution, fenced: { reason: 'Unresolved security-concern escalation: Unreviewed dependency change', at: new Date().toISOString() } } }),
    acquire, async (_work, authority) => { cancelled = authority.id; }, verify, gh, execution.owner), /was fenced, cancelled, or expired after final verification: Unresolved security-concern/);
  assert.equal(providerCalls.some(args => args[1] === '--method'), false, 'the provider merge call is never made under a fenced execution');
  assert.equal(cancelled, execution.id, 'a refused pre-merge re-read releases the execution');
  cancelled = ''; providerCalls = [];
  await assert.rejects(mergeWork(config, candidate, afterVerification({ mergeAuthorization: null, escalation: { trigger: 'security-concern', reason: 'Unreviewed dependency change', at: new Date().toISOString(), actor: 'product-lead' }, escalations: [{ trigger: 'security-concern', reason: 'Unreviewed dependency change', at: new Date().toISOString(), actor: 'product-lead' }], gates: [{ name: 'merge', passed: false, reasons: ['Unresolved security-concern escalation requires operator resolution: Unreviewed dependency change'] }] }),
    acquire, async (_work, authority) => { cancelled = authority.id; }, verify, gh, execution.owner), /no longer passes every gate after final verification: Unresolved security-concern/);
  assert.equal(providerCalls.some(args => args[1] === '--method'), false, 'a gate that fails after verification stops the provider call');
  assert.equal(cancelled, execution.id);
  // A blocking lead ruling refuses the same way, and an execution cancelled out
  // from under the broker is refused rather than merged.
  cancelled = ''; providerCalls = [];
  await assert.rejects(mergeWork(config, candidate, afterVerification({ mergeExecution: null }), acquire, async (_work, authority) => { cancelled = authority.id; }, verify, gh, execution.owner), /execution is no longer current/);
  assert.equal(providerCalls.some(args => args[1] === '--method'), false);
  // With nothing raised inside the window the same run still delivers.
  providerCalls = [];
  assert.match((await mergeWork(config, candidate, afterVerification({}), acquire, cancel, verify, gh, execution.owner)).result, /merge requested/);
  assert.equal(providerCalls.some(args => args[1] === '--method'), true);
});

test('manual merge remains guarded when automatic merge is disabled and GitHub clock skew is covered', async () => {
  assert.equal(githubProviderDelay(Date.parse('2026-01-01T00:00:05.250Z'), 200, 'HTTP/2 200\r\nDate: Thu, 01 Jan 2026 00:00:02 GMT\r\n\r\n{}'), 4000);
  assert.equal(githubProviderDelay(Date.parse('2026-01-01T00:00:05.250Z'), 800, 'Date: Thu, 01 Jan 2026 00:00:06 GMT\n\n{}'), 800);
  assert.throws(() => githubProviderDelay(Date.now(), 0, '{}'), /server time/);
  const candidate = work({ observation: { at: new Date().toISOString(), candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' } } as any });
  const config = { version: 1 as const, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: false, mergeMethod: 'merge' as const, workers: [], reviewers: [], run: { intervalSeconds: 20, deploymentShaField: 'commit' } };
  const execution = { id: '11111111-1111-4111-8111-111111111111', owner: 'master', sha: candidate.candidate!.sha, baseSha: candidate.candidate!.baseSha, policyRevision: 2, authorizationRevision: candidate.revision, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString() };
  const result = await mergeWork(config, candidate, ...broker(candidate, execution), async () => ({}), async () => ({ executionId: execution.id, sha: execution.sha, verifiedAt: new Date(Date.now() - 2000).toISOString(), providerDelayMs: 0 }), (_command, args) => {
    if (args[1] === 'view') return JSON.stringify({ headRefOid: candidate.candidate!.sha, baseRefOid: candidate.candidate!.baseSha, baseRefName: 'main', state: 'OPEN', isDraft: false });
    if (args.includes('--include')) return `Date: ${new Date().toUTCString()}\n\n{}`;
    return args[1] === '--method' ? JSON.stringify({ merged: true, sha: 'c'.repeat(40) }) : JSON.stringify(validProtection);
  });
  assert.match(result.result, /merge requested/);
});

test('merge-all selection and execution do not let refusing work starve eligible candidates', async () => {
  const now = new Date().toISOString();
  const eligible = work({ observation: { at: now } as any });
  const stale = work({ id: 'stale', key: 'GY-43', observation: { at: '2000-01-01T00:00:00Z' } as any });
  const refusing = work({ id: 'refusing', key: 'GY-44', gates: [{ name: 'merge', passed: false, reasons: ['Protection missing'] }] });
  assert.deepEqual(currentMergeCandidates([stale, eligible, refusing], now).map(item => item.key), ['GY-42']);
  const batch = await continueMergeBatch([{ key: 'GY-50' }, { key: 'GY-51' }], async item => {
    if (item.key === 'GY-50') throw new Error('candidate changed');
    return { key: item.key, result: 'merged' };
  });
  assert.deepEqual(batch, [{ key: 'GY-50', result: 'refused', reason: 'candidate changed' }, { key: 'GY-51', result: 'merged' }]);
});

const queueEntry = (sequence: number, enqueuedAt: string, speculation: any = null) => ({ sequence, enqueuedAt, policyRevision: 2, speculation });

test('master status reports queue position, predicted tip, and per-entry wait time', () => {
  const observedAt = '2030-01-01T01:00:00Z';
  const head = work({ id: 'head-id', key: 'GY-42', observation: { at: observedAt, baseTip: 'b'.repeat(40), candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' } } as any, queue: queueEntry(1, '2030-01-01T00:30:00Z', { ref: 'refs/graphyard/queue/gy-42', tip: 'a'.repeat(40), base: 'b'.repeat(40), baseTree: 'e'.repeat(40), predecessors: [], policyRevision: 2, publishedAt: '2030-01-01T00:31:00Z' }) } as Partial<Work>);
  const next = work({ id: 'next-id', key: 'GY-43', candidate: { sha: 'd'.repeat(40), baseSha: 'a'.repeat(40), pr: 43, branch: 'graphyard/gy-43-1', author: 'worker' },
    observation: { at: observedAt, baseTip: 'b'.repeat(40), candidate: { sha: 'd'.repeat(40), baseSha: 'a'.repeat(40), pr: 43, branch: 'graphyard/gy-43-1', author: 'worker' } } as any,
    queue: queueEntry(2, '2030-01-01T00:45:00Z', { ref: 'refs/graphyard/queue/gy-43', tip: 'd'.repeat(40), base: 'a'.repeat(40), baseTree: 'e'.repeat(40), predecessors: ['GY-42'], policyRevision: 2, publishedAt: observedAt }),
    gates: [{ name: 'merge', passed: false, reasons: ['Merge queue position 2 of 2: GY-42 is ahead'] }] } as Partial<Work>);
  const status = buildMasterStatus({ work: [head, next], now: observedAt }, [], []);
  assert.equal(status.counts.queued, 2);
  assert.deepEqual(status.queue.map(entry => [entry.key, entry.position, entry.size]), [['GY-42', 1, 2], ['GY-43', 2, 2]]);
  assert.equal(status.queue[0].predictedBase, 'b'.repeat(40));
  assert.equal(status.queue[0].predictedTip, 'a'.repeat(40));
  assert.equal(status.queue[0].waitMinutes, 30);
  assert.equal(status.queue[1].predictedBase, 'a'.repeat(40), 'the entry behind predicts against the tip ahead of it');
  assert.deepEqual(status.queue[1].ahead, ['GY-42']);
  assert.equal(status.queue[1].validated, true);
  assert.equal(status.queue[1].waitMinutes, 15);
  assert.equal(status.work[1].queue!.position, 2);
  assert.equal(status.work[1].mergeable, false, 'only the queue head can hold a merge authorization');
});

test('a merge only proceeds while the validated tip still lands its tested tree', () => {
  const tip = 'a'.repeat(40), validatedBase = 'b'.repeat(40), baseTree = 'e'.repeat(40), advanced = 'f'.repeat(40);
  const queued = work({ queue: queueEntry(1, '2030-01-01T00:30:00Z', { ref: 'refs/graphyard/queue/gy-42', tip, base: validatedBase, baseTree, predecessors: ['GY-41'], policyRevision: 2, publishedAt: '2030-01-01T00:31:00Z' }) } as Partial<Work>);
  const authorization = { sha: tip, baseSha: validatedBase };
  const reads: string[][] = [];
  const run = (tree: string) => (_command: string, args: string[]) => { reads.push(args); return JSON.stringify({ commit: { tree: { sha: tree } } }); };
  assert.doesNotThrow(() => assertQueuedLanding(queued, authorization, validatedBase, 'owner/project', run('unused')));
  assert.equal(reads.length, 0, 'an unchanged base needs no extra provider call');
  assert.doesNotThrow(() => assertQueuedLanding(queued, authorization, advanced, 'owner/project', run(baseTree)));
  assert.deepEqual(reads[0], ['api', `repos/owner/project/commits/${advanced}`]);
  assert.throws(() => assertQueuedLanding(queued, authorization, advanced, 'owner/project', run('9'.repeat(40))), /would no longer land its tested tree/);
  assert.throws(() => assertQueuedLanding(work({ queue: null } as Partial<Work>), authorization, validatedBase, 'owner/project', run(baseTree)), /no published merge-queue tip/);
  assert.throws(() => assertQueuedLanding(work({ queue: { ...queued.queue!, speculation: { ...queued.queue!.speculation!, tip: '7'.repeat(40) } } } as Partial<Work>), authorization, validatedBase, 'owner/project', run(baseTree)), /no published merge-queue tip/);
});

test('master status surfaces reviewer failover and exhausted reviewer capacity', () => {
  const profiles = [
    { name: 'claude-reviewer', runtime: 'claude', reviewerApp: 'claude-reviewer', timeoutSeconds: 1800 },
    { name: 'cursor-reviewer', runtime: 'cursor', reviewerApp: 'cursor-reviewer', timeoutSeconds: 900 },
  ];
  const candidate = { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' };
  const failover = (profile: string, runtime: string, exhaustion: 'usage-limit' | 'timeout', nextProfile: string | null, overrides: Record<string, unknown> = {}) =>
    ({ profile, reviewerApp: profile, runtime, exhaustion, reason: `${profile} exhausted`, at: '2030-01-01T00:00:00Z', sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 2, requestCommentId: 5, nextProfile, ...overrides });
  const agentPolicy = { checks: ['test'], review: true, reviewProvider: 'agent' as const, reviewerProfiles: profiles };
  const pending = work({ stage: 'review', policy: agentPolicy, gates: [{ name: 'review', passed: false, reasons: ['Waiting for reviewer profile cursor-reviewer'] }],
    reviewFailovers: [failover('claude-reviewer', 'claude', 'usage-limit', 'cursor-reviewer')] });
  const dispatched = buildMasterStatus({ work: [pending], now: '2030-01-01T00:05:00Z' }, [], []);
  assert.equal(dispatched.work[0].review!.provider, 'agent');
  assert.equal(dispatched.work[0].review!.profile, 'cursor-reviewer');
  assert.equal(dispatched.work[0].review!.runtime, 'cursor');
  assert.equal(dispatched.work[0].review!.exhausted, false);
  assert.deepEqual(dispatched.work[0].review!.failedOver.map(entry => [entry.profile, entry.exhaustion, entry.nextProfile]), [['claude-reviewer', 'usage-limit', 'cursor-reviewer']]);
  assert.equal(dispatched.counts.reviewFailover, 1);
  assert.equal(dispatched.work[0].attention, null);
  const exhausted = work({ stage: 'review', policy: agentPolicy, gates: [{ name: 'review', passed: false, reasons: ['Every configured reviewer profile is exhausted for this candidate'] }],
    reviewFailovers: [failover('claude-reviewer', 'claude', 'usage-limit', 'cursor-reviewer'), failover('cursor-reviewer', 'cursor', 'timeout', null)] });
  const stalled = buildMasterStatus({ work: [exhausted], now: '2030-01-01T00:05:00Z' }, [], []);
  assert.equal(stalled.work[0].review!.profile, null); assert.equal(stalled.work[0].review!.exhausted, true);
  assert.match(stalled.work[0].attention!, /Every configured reviewer profile is exhausted/);
  assert.match(stalled.work[0].attention!, /cursor-reviewer: timeout/);
  assert.equal(stalled.counts.attention, 1);
  // Failover recorded for a superseded candidate is history, not a current capacity problem.
  const rebased = work({ stage: 'review', policy: agentPolicy, gates: [{ name: 'review', passed: false, reasons: ['Waiting'] }],
    reviewFailovers: [failover('claude-reviewer', 'claude', 'usage-limit', null, { sha: 'c'.repeat(40) })] });
  const fresh = buildMasterStatus({ work: [rebased], now: '2030-01-01T00:05:00Z' }, [], []);
  assert.deepEqual(fresh.work[0].review!.failedOver, []); assert.equal(fresh.work[0].review!.profile, 'claude-reviewer');
  assert.equal(fresh.counts.reviewFailover, 0);
  // Codex and formal GitHub policies expose no agent reviewer state at all.
  for (const policy of [{ checks: ['test'], review: true }, { checks: ['test'], review: true, reviewProvider: 'codex' as const }])
    assert.equal(buildMasterStatus({ work: [work({ policy })], now: '2030-01-01T00:05:00Z' }, [], []).work[0].review, null);
});

test('agent review policies keep Graphyard branch protection without a native approval count', () => {
  const config = { version: 1 as const, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge' as const, workers: [], reviewers: [], run: { intervalSeconds: 20, deploymentShaField: 'commit' } };
  const protection = (overrides: Record<string, unknown> = {}) => ({ required_pull_request_reviews: { required_approving_review_count: 0 },
    required_status_checks: { strict: false, checks: [{ context: 'Graphyard / merge', app_id: 1234 }] }, enforce_admins: { enabled: true }, ...overrides });
  const agent = work({ policy: { checks: ['test'], review: true, reviewProvider: 'agent', reviewerProfiles: [{ name: 'claude-reviewer', runtime: 'claude', reviewerApp: 'claude-reviewer', timeoutSeconds: 1800 }] } });
  assert.doesNotThrow(() => assertMergeProtection(protection(), config, agent));
  // Graphyard's own required check and admin enforcement still apply.
  for (const weakened of [{ required_status_checks: { strict: false, checks: [] } }, { enforce_admins: { enabled: false } },
    { required_status_checks: { strict: false, checks: [{ context: 'Graphyard / merge', app_id: 999 }] } }, { allow_force_pushes: { enabled: true } }])
    assert.throws(() => assertMergeProtection(protection(weakened), config, agent), /protection changed/);
  // The merge queue supersedes "require branches to be up to date" for agent review too.
  assert.throws(() => assertMergeProtection(protection({ required_status_checks: { strict: true, checks: [{ context: 'Graphyard / merge', app_id: 1234 }] } }), config, agent),
    /requires branches to be up to date/);
  assert.throws(() => assertMergeProtection(protection(), config, work({ policy: { checks: ['test'], review: true } })), /protection changed/);
});

test('master status reports each containment quarantine and only claims verification it performed', () => {
  const observedAt = '2030-01-01T12:00:00.000Z';
  const lapsed = new Date(Date.parse(observedAt) - 600_000).toISOString();
  const quarantine = { owner: 'worker-a', epoch: 1, at: lapsed, settlementHash: 'a'.repeat(64), launchAcknowledgedAt: lapsed, launchExpiresAt: lapsed, leaseExpiresAt: lapsed };
  const workspace = { host: 'coordinator-host', path: '/srv/worktrees/GY-42-1', branch: 'graphyard/gy-42-1', epoch: 1, owner: 'worker-a' };
  const stranded = work({ stage: 'build', submission: null, candidate: null, queue: null, mergeAuthorization: null, lease: null, containmentQuarantine: quarantine, workspaces: [workspace] });
  const clean = { method: 'linux-proc-systemd' as const, platform: 'linux', uid: 1000, workspacePath: workspace.path, processes: [], scopes: [], inaccessible: 0, unverifiable: [] };
  const probe = () => clean;

  const unverified = buildMasterStatus({ work: [stranded], now: observedAt }, [], []).work[0];
  assert.deepEqual({ settleable: unverified.containment?.settleable, refusals: unverified.containment?.refusals, verifiedAt: unverified.containment?.verifiedAt, attestation: unverified.containment?.attestation },
    { settleable: false, refusals: ['Supervisor absence has not been verified on the registered host'], verifiedAt: null,
      attestation: 'Confirm the previous worker is stopped and use the operator attestation path: rework GY-42 --previous-worker-stopped REASON, or recover-containment GY-42 --previous-worker-stopped REASON once the work is delivered' });
  assert.match(unverified.attention!, /Containment quarantine from epoch 1 blocks dispatch/);

  const verified = assessContainment([stranded], { hostId: 'coordinator-host', observedAt, clockOffset: { min: -5, max: 5 }, localNow: new Date(observedAt), probe } as any);
  const row = buildMasterStatus({ work: [stranded], now: observedAt }, [], [], {}, verified).work[0];
  assert.deepEqual({ settleable: row.containment?.settleable, refusals: row.containment?.refusals, host: row.containment?.host, verifiedAt: row.containment?.verifiedAt, attestation: row.containment?.attestation },
    { settleable: true, refusals: [], host: 'coordinator-host', verifiedAt: observedAt, attestation: null });
  assert.match(row.attention!, /verified settleable; run master settle-containment GY-42/);

  // Another machine's quarantine is not this coordinator's to verify, and a probe that
  // cannot run is a refusal rather than a silent absence.
  assert.deepEqual(assessContainment([stranded], { hostId: 'other-host', observedAt, clockOffset: { min: 0, max: 1 }, probe }), {});
  const broken = assessContainment([stranded], { hostId: 'coordinator-host', observedAt, clockOffset: { min: 0, max: 1 }, probe: () => { throw new Error('systemctl vanished'); } });
  assert.deepEqual({ settleable: broken['work-id'].settleable, refusals: broken['work-id'].refusals },
    { settleable: false, refusals: ['Host verification could not be completed: systemctl vanished'] });
  assert.match(broken['work-id'].attestation, /rework GY-42 --previous-worker-stopped REASON/);

  const live = assessContainment([stranded], { hostId: 'coordinator-host', observedAt, clockOffset: { min: 0, max: 1 }, localNow: new Date(observedAt),
    probe: () => ({ ...clean, processes: [{ pid: 4242, evidence: 'command' as const }] }) } as any);
  assert.deepEqual(live['work-id'].settleable, false);
  assert.match(live['work-id'].refusals[0], /Process 4242 of the contained worker is still present/);
  assert.equal(verifyContainmentDeath(work({ containmentQuarantine: null }), { hostId: 'coordinator-host', observedAt, clockOffset: { min: 0, max: 1 }, probe }).refusals[0],
    'No containment quarantine is recorded for this task');
});

test('the clock the coordinator verifies with is bounded by the read that produced the snapshot', async () => {
  const times = [1_000, 1_400];
  const { snapshot, clockOffset } = await snapshotWithClock(async () => ({ work: [], now: new Date(1_200).toISOString() }), () => times.shift()!);
  assert.deepEqual({ now: snapshot.now, clockOffset }, { now: new Date(1_200).toISOString(), clockOffset: { min: -200, max: 200 } });
  const unreadable = await snapshotWithClock(async () => ({ work: [], now: 'not-a-time' }), () => 1_000);
  assert.deepEqual(unreadable.clockOffset, { min: NaN, max: NaN });
  assert.deepEqual(verifyContainmentDeath(work({ containmentQuarantine: { owner: 'worker-a', epoch: 1, at: '2030-01-01T00:00:00Z', settlementHash: 'a'.repeat(64) },
    workspaces: [{ host: 'coordinator-host', path: '/srv/worktrees/GY-42-1', branch: 'graphyard/gy-42-1', epoch: 1, owner: 'worker-a' }] }),
  { hostId: 'coordinator-host', observedAt: '2030-01-01T12:00:00.000Z', clockOffset: unreadable.clockOffset }).refusals,
  ['The control-plane clock could not be compared with this host']);
});
