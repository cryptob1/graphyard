import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertMergeCandidate, buildMasterStatus, dispatchWork, loadMasterConfig, managedMasterInstructions, mergeWork, runWorkerBootstrap, saveWorkerProfile, setupMaster, startMaster, workerProfileSchema } from '../src/master.js';
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
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main' }));
function work(overrides: Partial<Work> = {}) {
  const candidate = { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' };
  return { id: 'work-id', key: 'GY-42', title: 'Prove the master flow', description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:master'] }], policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'merge', revision: 9, policyRevision: 2, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 42 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [{ name: 'merge', passed: true, reasons: [] }], violations: [], mergeAuthorization: { sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 2, at: new Date().toISOString() }, ...overrides } as Work;
}

test('master instructions are managed idempotently without replacing repository rules', () => {
  const original = '# Local rules\nKeep this text.\n'; const first = managedMasterInstructions(original);
  assert.ok(first.startsWith(original)); assert.match(first, /dedicated, visible master-agent session/);
  assert.equal(managedMasterInstructions(first), first);
  assert.throws(() => managedMasterInstructions(first + first), /markers/);
});

test('master init verifies a coordinator and repository before writing private local configuration', async () => {
  const root = await repository(); const credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-master-credentials-'));
  try {
    const result = await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory }, coordinatorStatus as typeof fetch);
    assert.equal(result.autoMerge, true); assert.equal(result.role, 'coordinator');
    assert.equal((await stat(join(root, '.graphyard/master.json'))).mode & 0o777, 0o600);
    assert.equal(execFileSync('git', ['check-ignore', '.graphyard/master.json'], { cwd: root, encoding: 'utf8' }).trim(), '.graphyard/master.json');
    assert.match(await readFile(join(root, 'AGENTS.md'), 'utf8'), /Graphyard master agent/);
    const master = await loadMasterConfig(root); assert.equal(await readFile(master.credentialFile, 'utf8'), coordinatorToken); assert.equal(master.baseBranch, 'main'); assert.equal(master.credentialFile.startsWith(`${root}/`), false);
    assert.equal((await readFile(join(root, '.graphyard/master.json'), 'utf8')).includes(coordinatorToken), false);
    const workerConnection = JSON.stringify({ url: 'https://graphyard.example', token: workerToken, cliPath: launcher, hostId: 'machine-a' });
    await writeFile(join(root, '.graphyard/connection.json'), workerConnection, { mode: 0o600 });
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory }, coordinatorStatus as typeof fetch);
    assert.equal(await readFile(join(root, '.graphyard/connection.json'), 'utf8'), workerConnection, 'master setup must not replace a worker connection');
    await assert.rejects(setupMaster(root, { url: 'https://graphyard.example', token: workerToken, cliPath: launcher, credentialDirectory }, (async () => new Response(JSON.stringify({ actor: { id: 'worker', role: 'worker' }, repository: 'owner/project', baseBranch: 'main' }))) as typeof fetch), /coordinator credential/);
    await assert.rejects(setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory }, (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: null, baseBranch: 'main' }))) as typeof fetch), /bound to a GitHub repository/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});

test('worker profiles support existing sessions and launch profiles without embedded secrets', async () => {
  assert.equal(workerProfileSchema.safeParse({ name: 'existing', principal: 'worker-a', agentName: 'eng-a', mode: 'existing' }).success, true);
  assert.equal(workerProfileSchema.safeParse({ name: 'launch', principal: 'worker-b', agentName: 'eng-b', mode: 'launch', kind: 'codex', credentialFile: '/private/worker.token', environment: { OPENAI_API_KEY: 'secret' } }).success, false);
  assert.equal(workerProfileSchema.safeParse({ name: 'launch', principal: 'worker-b', agentName: 'eng-b', mode: 'launch', kind: 'codex', credentialFile: '/private/worker.token', environment: { CODEX_HOME: 'bad\nvalue' } }).success, false);
  assert.equal(workerProfileSchema.safeParse({ name: 'launch', principal: 'worker-b', agentName: 'eng-b', mode: 'launch', kind: 'codex', credentialFile: '/private/worker.token', environment: { CODEX_HOME: '/profiles/two' } }).success, true);
});

test('master status derives ownership from Graphyard and only joins Herdr health', () => {
  const active = work({ stage: 'build', lease: { owner: 'worker-a', epoch: 3, expiresAt: '2030-01-01T00:10:00Z' }, gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted'] }] });
  const result = buildMasterStatus({ work: [active], now: '2030-01-01T00:00:00Z' }, [{ name: 'profile-a', principal: 'worker-a', agentName: 'eng-a', mode: 'existing', agentArgs: [], environment: {} }], [{ name: 'eng-a', agent_status: 'working', pane_id: 'p1' }]);
  assert.equal(result.work[0].owner, 'worker-a'); assert.equal(result.work[0].session, 'working'); assert.equal(result.counts.active, 1);
  const spoofed = buildMasterStatus({ work: [active], now: '2030-01-01T00:20:00Z' }, [], [{ name: 'worker-a', agent_status: 'working' }]);
  assert.equal(spoofed.work[0].owner, null, 'Herdr cannot extend an expired Graphyard assignment');
});

test('dispatch launches a worker through the supervised claim and worktree bootstrap', async () => {
  const root = await repository(); const credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-master-credentials-')); const calls: string[][] = [];
  try {
    const credential = join(root, 'worker.token'); await writeFile(credential, workerToken, { mode: 0o600 });
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory }, coordinatorStatus as typeof fetch);
    const profile = { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch' as const, kind: 'codex' as const, credentialFile: credential, agentArgs: [], environment: {} };
    const result = await dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null }), profile, [], (_command, args) => { calls.push(args); return JSON.stringify({ result: args[0] === 'tab' ? { pane_id: 'p1' } : args[1] === 'get' ? { pane_id: 'p1', agent_status: 'working' } : {} }); });
    assert.match(result.ownership, /supervising/);
    assert.deepEqual(calls[1].slice(0, 3), ['pane', 'run', 'p1']); assert.match(calls[1][3], /master worker-run 'GY-42' 'launch'/);
    assert.deepEqual(calls.at(-1)!.slice(0, 3), ['agent', 'prompt', 'eng-a']); assert.doesNotMatch(calls.at(-1)![3], /coordinator-token/);
    const existing = { name: 'existing', principal: 'worker-a', agentName: 'existing-a', mode: 'existing' as const, agentArgs: [], environment: {} };
    await assert.rejects(dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null }), existing, [{ name: 'existing-a', agent_status: 'idle', cwd: root }]), /cannot be safely adopted/);
    const dependency = work({ id: 'dependency', key: 'GY-41', stage: 'build' });
    await assert.rejects(dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null, dependencies: [dependency.id] }), profile, [], undefined, [dependency]), /unfinished dependencies/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});

test('master start creates a visible non-focused coordinator session with no credential argument', async () => {
  const root = await repository(); const credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-master-credentials-')); const calls: string[][] = [];
  try {
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory }, coordinatorStatus as typeof fetch);
    const result = await startMaster(root, 'codex', ['--model', 'reviewer'], [], (_command, args) => {
      calls.push(args);
      return JSON.stringify({ result: args[0] === 'tab' ? { pane_id: 'pane-master' } : {} });
    });
    assert.equal(result.focusChanged, false); assert.equal(result.pane, 'pane-master');
    assert.ok(calls[0].includes('--no-focus')); assert.ok(calls[1].includes('codex'));
    assert.match(calls[2].at(-1)!, /dedicated Graphyard master agent/);
    assert.equal(JSON.stringify(calls).includes(coordinatorToken), false);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});

test('launch profiles verify a private worker credential and match its principal', async () => {
  const root = await repository(); const credential = join(root, 'worker.token'); const credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-master-credentials-'));
  try {
    await writeFile(credential, workerToken, { mode: 0o600 });
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory }, coordinatorStatus as typeof fetch);
    const result = await saveWorkerProfile(root, { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: credential }, async token => ({ actor: { id: token === workerToken ? 'worker-a' : 'wrong', role: 'worker' } }));
    assert.equal(result.workers, 1); assert.equal((await loadMasterConfig(root)).workers[0].credentialFile, credential);
    await chmod(credential, 0o644);
    await assert.rejects(saveWorkerProfile(root, { name: 'other', principal: 'worker-b', agentName: 'eng-b', mode: 'launch', kind: 'claude', credentialFile: credential }, async () => ({ actor: { id: 'worker-b', role: 'worker' } })), /0600/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
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

test('worker bootstrap claims, creates the assigned worktree, and launches the agent under watch', async () => {
  const root = await repository(); const credential = join(root, 'worker.token'); const credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-master-credentials-')); const calls: { args: string[]; options: any }[] = []; let launch: any;
  try {
    await writeFile(credential, workerToken, { mode: 0o600 });
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory }, coordinatorStatus as typeof fetch);
    await saveWorkerProfile(root, { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: credential }, async () => ({ actor: { id: 'worker-a', role: 'worker' } }));
    const code = await runWorkerBootstrap(root, 'GY-42', 'launch', (_command, args, options) => {
      calls.push({ args, options });
      return args[1] === 'claim' ? JSON.stringify({ epoch: 4, lease: { owner: 'worker-a' } }) : JSON.stringify({ path: join(root, 'assigned') });
    }, (_command, args, options) => { launch = { args, options }; return 0; });
    assert.equal(code, 0); assert.equal(calls[0].args[1], 'claim'); assert.equal(calls[1].args[1], 'worktree');
    assert.deepEqual(launch.args.slice(0, 6), [launcher, 'watch', 'GY-42', '4', '--', 'codex']);
    assert.equal(launch.options.cwd, join(root, 'assigned')); assert.equal(launch.options.env.GRAPHYARD_TOKEN, undefined); assert.equal(launch.options.env.GRAPHYARD_TOKEN_FILE, credential);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});

test('routine merge is exact-candidate, double-checked, and never uses an admin bypass', async () => {
  const candidate = work({ observation: { at: new Date().toISOString(), candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' } } as any }); const config = { version: 1 as const, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge' as const, workers: [] };
  const calls: string[][] = [];
  const result = await mergeWork(config, candidate, async () => ({ work: [candidate], now: new Date().toISOString() }), (_command, args) => {
    calls.push(args);
    return args[1] === 'view' ? JSON.stringify({ headRefOid: candidate.candidate!.sha, baseRefOid: candidate.candidate!.baseSha, baseRefName: 'main', state: 'OPEN', isDraft: false }) : '';
  });
  assert.equal(result.result.startsWith('merge requested'), true);
  assert.deepEqual(calls[1].slice(0, 3), ['pr', 'merge', '42']); assert.ok(calls[1].includes('--match-head-commit')); assert.equal(calls[1].includes('--admin'), false);
  assert.throws(() => assertMergeCandidate(work({ gates: [{ name: 'acceptance', passed: false, reasons: ['Human approval required'] }] })), /does not have/);
  let reads = 0; await assert.rejects(mergeWork(config, candidate, async () => ({ work: [reads++ ? work({ revision: 10 }) : candidate], now: new Date().toISOString() }), () => JSON.stringify({ headRefOid: candidate.candidate!.sha, baseRefOid: candidate.candidate!.baseSha, baseRefName: 'main', state: 'OPEN', isDraft: false })), /changed after/);
  await assert.rejects(mergeWork(config, candidate, async () => ({ work: [candidate], now: new Date().toISOString() }), () => JSON.stringify({ headRefOid: candidate.candidate!.sha, baseRefOid: candidate.candidate!.baseSha, baseRefName: 'release', state: 'OPEN', isDraft: false })), /changed on GitHub/);
  const stale = work({ observation: { at: '2000-01-01T00:00:00Z' } as any });
  await assert.rejects(mergeWork(config, stale, async () => ({ work: [stale], now: new Date().toISOString() })), /does not have/);
});
