import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertMergeCandidate, buildMasterStatus, dispatchWork, loadMasterConfig, managedMasterInstructions, mergeWork, saveWorkerProfile, setupMaster, startMaster, workerProfileSchema } from '../src/master.js';
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
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project' }));
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
  const root = await repository();
  try {
    const result = await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher }, coordinatorStatus as typeof fetch);
    assert.equal(result.autoMerge, true); assert.equal(result.role, 'coordinator');
    assert.equal((await stat(join(root, '.graphyard/master.json'))).mode & 0o777, 0o600);
    assert.equal(execFileSync('git', ['check-ignore', '.graphyard/master.json'], { cwd: root, encoding: 'utf8' }).trim(), '.graphyard/master.json');
    assert.match(await readFile(join(root, 'AGENTS.md'), 'utf8'), /Graphyard master agent/);
    assert.equal((await loadMasterConfig(root)).token, coordinatorToken);
    const workerConnection = JSON.stringify({ url: 'https://graphyard.example', token: workerToken, cliPath: launcher, hostId: 'machine-a' });
    await writeFile(join(root, '.graphyard/connection.json'), workerConnection, { mode: 0o600 });
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher }, coordinatorStatus as typeof fetch);
    assert.equal(await readFile(join(root, '.graphyard/connection.json'), 'utf8'), workerConnection, 'master setup must not replace a worker connection');
    await assert.rejects(setupMaster(root, { url: 'https://graphyard.example', token: workerToken, cliPath: launcher }, (async () => new Response(JSON.stringify({ actor: { id: 'worker', role: 'worker' }, repository: 'owner/project' }))) as typeof fetch), /coordinator credential/);
  } finally { await rm(root, { recursive: true, force: true }); }
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

test('dispatch prompts an existing worker to claim for itself and never records ownership', async () => {
  const root = await repository(); const calls: string[][] = [];
  try {
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher }, coordinatorStatus as typeof fetch);
    const profile = { name: 'existing', principal: 'worker-a', agentName: 'eng-a', mode: 'existing' as const, agentArgs: [], environment: {} };
    const result = await dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null }), profile, [{ name: 'eng-a', agent_status: 'idle', pane_id: 'p1', cwd: root }], (_command, args) => { calls.push(args); return JSON.stringify({ result: {} }); });
    assert.equal(result.ownership, 'pending worker claim');
    assert.deepEqual(calls[0].slice(0, 3), ['agent', 'prompt', 'eng-a']);
    assert.match(calls[0][3], /First run .* claim GY-42/); assert.doesNotMatch(calls[0][3], /coordinator-token/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('master start creates a visible non-focused coordinator session with no credential argument', async () => {
  const root = await repository(); const calls: string[][] = [];
  try {
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher }, coordinatorStatus as typeof fetch);
    const result = await startMaster(root, 'codex', ['--model', 'reviewer'], [], (_command, args) => {
      calls.push(args);
      return JSON.stringify({ result: args[0] === 'tab' ? { pane_id: 'pane-master' } : {} });
    });
    assert.equal(result.focusChanged, false); assert.equal(result.pane, 'pane-master');
    assert.ok(calls[0].includes('--no-focus')); assert.ok(calls[1].includes('codex'));
    assert.match(calls[2].at(-1)!, /dedicated Graphyard master agent/);
    assert.equal(JSON.stringify(calls).includes(coordinatorToken), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('launch profiles verify a private worker credential and match its principal', async () => {
  const root = await repository(); const credential = join(root, 'worker.token');
  try {
    await writeFile(credential, workerToken, { mode: 0o600 });
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher }, coordinatorStatus as typeof fetch);
    const result = await saveWorkerProfile(root, { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: credential }, async token => ({ actor: { id: token === workerToken ? 'worker-a' : 'wrong', role: 'worker' } }));
    assert.equal(result.workers, 1); assert.equal((await loadMasterConfig(root)).workers[0].credentialFile, credential);
    await chmod(credential, 0o644);
    await assert.rejects(saveWorkerProfile(root, { name: 'other', principal: 'worker-b', agentName: 'eng-b', mode: 'launch', kind: 'claude', credentialFile: credential }, async () => ({ actor: { id: 'worker-b', role: 'worker' } })), /0600/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('routine merge is exact-candidate, double-checked, and never uses an admin bypass', async () => {
  const candidate = work(); const config = { version: 1 as const, url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, repository: 'owner/project', hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge' as const, workers: [] };
  const calls: string[][] = [];
  const result = await mergeWork(config, candidate, async () => ({ work: [candidate], now: new Date().toISOString() }), (_command, args) => {
    calls.push(args);
    return args[1] === 'view' ? JSON.stringify({ headRefOid: candidate.candidate!.sha, baseRefOid: candidate.candidate!.baseSha, state: 'OPEN', isDraft: false }) : '';
  });
  assert.equal(result.result.startsWith('merge requested'), true);
  assert.deepEqual(calls[1].slice(0, 3), ['pr', 'merge', '42']); assert.ok(calls[1].includes('--match-head-commit')); assert.equal(calls[1].includes('--admin'), false);
  assert.throws(() => assertMergeCandidate(work({ gates: [{ name: 'acceptance', passed: false, reasons: ['Human approval required'] }] })), /does not have/);
  await assert.rejects(mergeWork(config, candidate, async () => ({ work: [work({ revision: 10 })], now: '' }), () => JSON.stringify({ headRefOid: candidate.candidate!.sha, baseRefOid: candidate.candidate!.baseSha, state: 'OPEN', isDraft: false })), /changed after/);
});
