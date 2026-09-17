import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertDispatchable, assertMasterBinding, assertMergeCandidate, assertMergeProtection, buildMasterStatus, continueMergeBatch, currentMergeCandidates, dispatchWork, githubProviderDelay, inspectWorkerCredentials, loadMasterConfig, managedMasterInstructions, mergeWork, observeHerdrAgents, prepareWorkerLaunch, saveWorkerProfile, setupMaster, startMaster, workerProfileSchema } from '../src/master.js';
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
const validProtection = { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: true, checks: [{ context: 'Graphyard / merge', app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
function work(overrides: Partial<Work> = {}) {
  const candidate = { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' };
  return { id: 'work-id', key: 'GY-42', title: 'Prove the master flow', description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:master'] }], policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'merge', revision: 9, policyRevision: 2, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 42 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [{ name: 'merge', passed: true, reasons: [] }], violations: [], mergeAuthorization: { sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 2, at: new Date().toISOString() }, ...overrides } as Work;
}

test('master instructions are managed idempotently without replacing repository rules', () => {
  const bootstrap = "The initial MVP is a single-agent bootstrap under the operator's supervision. Do not launch other agents for bootstrap work.";
  const original = `# Local rules\n${bootstrap}\nKeep this text.\n`; const first = managedMasterInstructions(original);
  assert.ok(first.startsWith(original)); assert.match(first, /dedicated, visible master-agent session/);
  assert.match(first, /Keep cycling: status, dispatch ready work, shepherd review and proof collection,\nguarded merge, then deployment verification/);
  for (const condition of ['Ordinary review', 'rework', 'idle workers', 'proof setup', 'Close\nfinished agent sessions']) assert.match(first, new RegExp(condition));
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
  const result = buildMasterStatus({ work: [active], now: '2030-01-01T00:00:00Z' }, [{ name: 'profile-a', principal: 'worker-a', agentName: 'eng-a', mode: 'existing', agentArgs: [], environment: {} }], [{ name: 'eng-a', agent_status: 'working', pane_id: 'p1' }]);
  assert.equal(result.work[0].owner, 'worker-a'); assert.equal(result.work[0].session, 'working'); assert.equal(result.counts.active, 1);
  const spoofed = buildMasterStatus({ work: [active], now: '2030-01-01T00:20:00Z' }, [], [{ name: 'worker-a', agent_status: 'working' }]);
  assert.equal(spoofed.work[0].owner, null, 'Herdr cannot extend an expired Graphyard assignment');
  const unavailable = observeHerdrAgents(() => { throw new Error('daemon unavailable'); });
  assert.equal(unavailable.available, false); assert.deepEqual(unavailable.agents, []); assert.match(unavailable.reason!, /Graphyard work state remains authoritative/);
});

test('master commands refuse a changed repository or managed base binding', () => {
  const config = { version: 1 as const, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge' as const, workers: [] };
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
    const profile = { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch' as const, kind: 'codex' as const, credentialFile: credential, agentArgs: [], environment: {} };
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
    const existing = { name: 'existing', principal: 'worker-a', agentName: 'existing-a', mode: 'existing' as const, agentArgs: [], environment: {} };
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

test('routine merge is exact-candidate, double-checked, and never uses an admin bypass', async () => {
  const candidate = work({ observation: { at: new Date().toISOString(), candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' } } as any }); const config = { version: 1 as const, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge' as const, workers: [] };
  const calls: string[][] = [];
  const execution = { id: '11111111-1111-4111-8111-111111111111', owner: 'master', sha: candidate.candidate!.sha, baseSha: candidate.candidate!.baseSha, policyRevision: 2, authorizationRevision: candidate.revision, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString() };
  const acquire = async () => ({ execution }); const cancel = async () => ({}); const verify = async () => ({ executionId: execution.id, sha: execution.sha, verifiedAt: new Date(Date.now() - 2000).toISOString(), providerDelayMs: 0 });
  const result = await mergeWork(config, candidate, async () => ({ work: [candidate], now: new Date().toISOString() }), acquire, cancel, verify, (_command, args) => {
    calls.push(args);
    if (args[1] === 'view') return JSON.stringify({ headRefOid: candidate.candidate!.sha, baseRefOid: candidate.candidate!.baseSha, baseRefName: 'main', state: 'OPEN', isDraft: false });
    if (args.includes('--include')) return `Date: ${new Date().toUTCString()}\n\n{}`;
    return args[1] === '--method' ? JSON.stringify({ merged: true, sha: 'c'.repeat(40) }) : JSON.stringify(validProtection);
  });
  assert.equal(result.result.startsWith('merge requested'), true);
  assert.deepEqual(calls[4].slice(0, 3), ['api', '--method', 'PUT']); assert.ok(calls[4].includes(`sha=${candidate.candidate!.sha}`)); assert.equal(calls[4].includes('--admin'), false);
  assert.doesNotThrow(() => assertMergeProtection(validProtection, config, candidate));
  assert.throws(() => assertMergeProtection({ ...validProtection, required_status_checks: { ...validProtection.required_status_checks, checks: [] } }, config, candidate), /protection changed/);
  assert.throws(() => assertMergeCandidate(work({ gates: [{ name: 'acceptance', passed: false, reasons: ['Human approval required'] }] })), /does not have/);
  let reads = 0; await assert.rejects(mergeWork(config, candidate, async () => ({ work: [reads++ ? work({ revision: 10 }) : candidate], now: new Date().toISOString() }), acquire, cancel, verify, () => JSON.stringify({ headRefOid: candidate.candidate!.sha, baseRefOid: candidate.candidate!.baseSha, baseRefName: 'main', state: 'OPEN', isDraft: false })), /changed after/);
  await assert.rejects(mergeWork(config, candidate, async () => ({ work: [candidate], now: new Date().toISOString() }), acquire, cancel, verify, () => JSON.stringify({ headRefOid: candidate.candidate!.sha, baseRefOid: candidate.candidate!.baseSha, baseRefName: 'release', state: 'OPEN', isDraft: false })), /changed on GitHub/);
  const stale = work({ observation: { at: '2000-01-01T00:00:00Z' } as any });
  await assert.rejects(mergeWork(config, stale, async () => ({ work: [stale], now: new Date().toISOString() }), acquire, cancel, verify), /does not have/);
  let cancelled = '';
  await assert.rejects(mergeWork(config, candidate, async () => ({ work: [candidate], now: new Date().toISOString() }), acquire, async (_work, authority) => { cancelled = authority.id; }, verify, (_command, args) => {
    if (args[1] === 'view') return JSON.stringify({ headRefOid: candidate.candidate!.sha, baseRefOid: candidate.candidate!.baseSha, baseRefName: 'main', state: 'OPEN', isDraft: false });
    if (args.includes('--include')) return `Date: ${new Date().toUTCString()}\n\n{}`;
    if (args[1] !== '--method') return JSON.stringify(validProtection);
    throw new Error('provider response lost');
  }), /outcome is unknown/);
  assert.equal(cancelled, '', 'an unknown provider outcome retains authority');
  await assert.rejects(mergeWork(config, candidate, async () => ({ work: [candidate], now: new Date().toISOString() }), acquire, async (_work, authority) => { cancelled = authority.id; }, verify, (_command, args) => {
    if (args[1] === 'view') return JSON.stringify({ headRefOid: candidate.candidate!.sha, baseRefOid: candidate.candidate!.baseSha, baseRefName: 'main', state: 'OPEN', isDraft: false });
    if (args.includes('--include')) return `Date: ${new Date().toUTCString()}\n\n{}`;
    if (args[1] !== '--method') return JSON.stringify(validProtection);
    return JSON.stringify({ merged: false, message: 'branch protection refused merge' });
  }), /branch protection refused merge/);
  assert.equal(cancelled, execution.id);
  cancelled = '';
  await assert.rejects(mergeWork(config, candidate, async () => ({ work: [candidate], now: new Date().toISOString() }), acquire, async (_work, authority) => { cancelled = authority.id; }, async () => { throw new Error('verification response lost'); }, (_command, args) => {
    if (args[1] === 'view') return JSON.stringify({ headRefOid: candidate.candidate!.sha, baseRefOid: candidate.candidate!.baseSha, baseRefName: 'main', state: 'OPEN', isDraft: false });
    return JSON.stringify(validProtection);
  }), /retained execution/);
  assert.equal(cancelled, '', 'an unknown verification outcome retains authority for replay');
  const confirmed = Object.assign(new Error('verification refused'), { confirmedRefusal: true });
  await assert.rejects(mergeWork(config, candidate, async () => ({ work: [candidate], now: new Date().toISOString() }), acquire, async (_work, authority) => { cancelled = authority.id; }, async () => { throw confirmed; }, (_command, args) => {
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
});

test('manual merge remains guarded when automatic merge is disabled and GitHub clock skew is covered', async () => {
  assert.equal(githubProviderDelay(Date.parse('2026-01-01T00:00:05.250Z'), 200, 'HTTP/2 200\r\nDate: Thu, 01 Jan 2026 00:00:02 GMT\r\n\r\n{}'), 4000);
  assert.equal(githubProviderDelay(Date.parse('2026-01-01T00:00:05.250Z'), 800, 'Date: Thu, 01 Jan 2026 00:00:06 GMT\n\n{}'), 800);
  assert.throws(() => githubProviderDelay(Date.now(), 0, '{}'), /server time/);
  const candidate = work({ observation: { at: new Date().toISOString(), candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' } } as any });
  const config = { version: 1 as const, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: false, mergeMethod: 'merge' as const, workers: [] };
  const execution = { id: '11111111-1111-4111-8111-111111111111', owner: 'master', sha: candidate.candidate!.sha, baseSha: candidate.candidate!.baseSha, policyRevision: 2, authorizationRevision: candidate.revision, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString() };
  const result = await mergeWork(config, candidate, async () => ({ work: [candidate], now: new Date().toISOString() }), async () => ({ execution }), async () => ({}), async () => ({ executionId: execution.id, sha: execution.sha, verifiedAt: new Date(Date.now() - 2000).toISOString(), providerDelayMs: 0 }), (_command, args) => {
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
