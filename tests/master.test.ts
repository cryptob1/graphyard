import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertDispatchable, assertMasterBinding, dispatchWork, inspectWorkerCredentials, loadMasterConfig, masterInstructions, observeHerdrAgents, prepareWorkerLaunch, saveWorkerProfile, setupMaster, startMaster, workerProfileSchema } from '../src/master.js';
import { expandTypedCommand, startedAtOnce } from './helpers/launch-shell.js';
import { autonomyContract } from '../src/autonomy.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { readySpecCheck } from './helpers/spec-check.js';
// Time-bomb allowance (GY-1694): every 2030-01-01 instant is judged at a 2030 `now`/observedAt the test passes (localNow pinned where the probe runs); the lone new Date() status call carries no fixture instant.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const workerToken = 'worker-token-'.padEnd(40, 'x');
async function repository() {
  const root = await temporaryDirectory('master');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  return root;
}
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
function work(overrides: Partial<Work> = {}) {
  const candidate = { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' };
  return { id: 'work-id', key: 'GY-42', title: 'Prove the master flow', description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:master'] }], policy: { checks: ['test'], review: true }, stage: 'merge', revision: 9, policyRevision: 2, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 42 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [{ name: 'merge', passed: true, reasons: [] }], violations: [],
  // GY-2992: a released feature dispatches only with its spec check reported; this fixture stands after it did.
  specCheck: readySpecCheck(new Date().toISOString(), 2), mergeAuthorization: { sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 2, at: new Date().toISOString() }, ...overrides } as Work;
}

test('master instructions carry the operating loop the master guide prints first', () => {
  const first = masterInstructions;
  assert.match(first, /dedicated, visible master-agent session/);
  assert.match(first, /Keep cycling: status, dispatch ready work, shepherd review, record what the merge\nwriter's trial and push landed\. Repeat until both conditions hold/);
  assert.match(first, /\(1\) every in-scope item is Done or has a genuinely external blocker recorded in\nGraphyard; and \(2\) the release health line in `master status` is healthy, or a\ngenuinely external deployment blocker is recorded in Graphyard as a follow-up work item/);
  assert.match(first, /An item is delivered at merge; release health is one status line/);
  assert.doesNotMatch(first, /verify-deployment/);
  for (const condition of ['Ordinary review', 'rework', 'idle workers', 'proof setup', 'Close finished agent\\s+sessions']) assert.match(first, new RegExp(condition));
  assert.ok(!first.includes('graphyard-master -->'), 'the instructions are no AGENTS.md block');
});

test('master init verifies a coordinator and repository before writing private local configuration', async () => {
  const root = await repository(); const credentialDirectory = await temporaryDirectory('master-credentials');
  try {
    const result = await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, herdrWorkspace: 'workspace-graphyard' }, coordinatorStatus as typeof fetch);
    assert.equal(result.autoMerge, true); assert.equal(result.role, 'coordinator');
    assert.deepEqual(result.attention, []); assert.match(result.next, /^Run graphyard master reviewer setup .* then graphyard master start/);
    // A permission the installed App lacks is announced with the migration path, and never blocks setup.
    const shortfall = 'App graphyard-owner-project lacks Contents: write (installed with read), which branch refresh needs to push base refreshes and main-guard revert branches onto the managed repository; accept the pending permission request at https://github.com/settings/installations/4242';
    const short = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, appPermissions: { app: 'graphyard-owner-project', installationUrl: 'https://github.com/settings/installations/4242', verifiedAt: '2030-01-01T00:00:00Z', error: null, suspended: false, missing: [{ permission: 'contents', required: 'write', granted: 'read', features: ['merge-queue'], reasons: [] }], attention: [shortfall] }, heldJobs: 2 }));
    const announced = await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, herdrWorkspace: 'workspace-graphyard' }, short as typeof fetch);
    assert.equal(announced.attention[0], shortfall); assert.match(announced.attention[1], /2 integration jobs are held/);
    assert.match(announced.next, /github-setup --update-permissions/);
    assert.equal((await stat(join(root, '.graphyard/master.json'))).mode & 0o777, 0o600);
    assert.equal(execFileSync('git', ['check-ignore', '.graphyard/master.json'], { cwd: root, encoding: 'utf8' }).trim(), '.graphyard/master.json');
    const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
    assert.match(agents, /## Graphyard coordination/); assert.doesNotMatch(agents, /Graphyard master agent|graphyard-master -->/, 'master init writes the worker block only');
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
  const root = await repository(); const siblingParent = await temporaryDirectory('master-sibling'); const sibling = join(siblingParent, 'worktree');
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

test('Muse launch profiles validate like every other runtime and carry no embedded secrets', () => {
  const muse = { name: 'muse-primary', principal: 'muse-1', agentName: 'engineering-muse-1', mode: 'launch', kind: 'muse', credentialFile: '/private/muse-1.token' };
  const parsed = workerProfileSchema.parse({ ...muse, agentArgs: ['--approval-mode', 'never', '--trust-workspace'] });
  assert.equal(parsed.kind, 'muse'); assert.equal(parsed.approvals, 'auto'); assert.deepEqual(parsed.agentArgs, ['--approval-mode', 'never', '--trust-workspace']);
  assert.equal(workerProfileSchema.safeParse({ ...muse, credentialFile: undefined }).success, false, 'a launched Muse worker needs its own credential file');
  assert.equal(workerProfileSchema.safeParse({ ...muse, credentialFile: 'relative/muse.token' }).success, false);
  assert.equal(workerProfileSchema.safeParse({ ...muse, environment: { MUSE_API_KEY: 'secret' } }).success, false, 'provider secrets belong to the runtime login, not the profile');
  assert.equal(workerProfileSchema.safeParse({ ...muse, environment: { GRAPHYARD_TOKEN: 'coordinator' } }).success, false, 'GRAPHYARD_ variables are owned by the launcher');
  assert.equal(workerProfileSchema.safeParse({ ...muse, mode: 'existing', kind: undefined, credentialFile: undefined }).success, true);
  assert.equal(workerProfileSchema.safeParse({ ...muse, kind: 'muse-code' }).success, false);
});

test('an unavailable Herdr leaves Graphyard work state authoritative', async () => {
  const unavailable = await observeHerdrAgents(() => { throw new Error('daemon unavailable'); });
  assert.equal(unavailable.available, false); assert.deepEqual(unavailable.agents, []); assert.match(unavailable.reason!, /Graphyard work state remains authoritative/);
});

test('master commands refuse a changed repository or managed base binding', () => {
  const config = { version: 1 as const, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge' as const, workers: [], reviewers: [], producers: [], run: { intervalSeconds: 20, deploymentShaField: 'commit', dispatchIntervalSeconds: 10, producerTimeoutMinutes: 120 } };
  assert.doesNotThrow(() => assertMasterBinding(config, { actor: { role: 'coordinator' }, repository: 'OWNER/project', baseBranch: 'main', githubAppId: 1234 }));
  assert.throws(() => assertMasterBinding(config, { actor: { role: 'coordinator' }, repository: 'owner/other', baseBranch: 'main', githubAppId: 1234 }), /rerun master init/);
  assert.throws(() => assertMasterBinding(config, { actor: { role: 'coordinator' }, repository: 'owner/project', baseBranch: 'release', githubAppId: 1234 }), /rerun master init/);
  // GY-2010: the control plane serves no GitHub App, so a master configured with one still binds.
  assert.doesNotThrow(() => assertMasterBinding(config, { actor: { role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main' }));
});

test('dispatch launches through watch, with the instruction on the supervised command line, and accepts a session already working on it', async () => {
  const root = await repository(); const credentialDirectory = await temporaryDirectory('master-credentials'); const calls: string[][] = [];
  try {
    const credential = join(credentialDirectory, 'worker.token'); await writeFile(credential, workerToken, { mode: 0o600 });
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, herdrWorkspace: 'workspace-graphyard' }, coordinatorStatus as typeof fetch);
    const profile = { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch' as const, kind: 'codex' as const, credentialFile: credential, agentArgs: [], approvals: 'auto' as const, environment: {} };
    let probes = 0;
    const result = await dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null }), profile, [], (_command, args) => { calls.push(args); return JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'p1', tab_id: 't1' }, tab: { tab_id: 't1' } } : args[1] === 'get' ? { type: 'agent_info', agent: { pane_id: 'p1', agent: 'codex', agent_status: ++probes === 1 ? 'working' : 'idle' } } : {} }); }, undefined, async () => ({ epoch: 4, path: join(root, 'assigned'), base: 'c'.repeat(40) }));
    assert.match(result.ownership, /supervising/);
    assert.deepEqual(calls[0].slice(0, 4), ['tab', 'create', '--workspace', 'workspace-graphyard']); assert.ok(calls[0].includes('GRAPHYARD_HERDR_AGENT_KIND=codex'));
    assert.deepEqual(calls[1].slice(0, 3), ['pane', 'run', 'p1']); assert.match(calls[1][3], / watch GY-42 4 -- codex /);
    // GY-93: the instruction is the session's own first request, the last argument of the
    // supervised command — since GY-121 read by the shell from the request file the short typed
    // line references; a session already working on it is ready, and nothing is pasted.
    assert.match(calls[1][3], /"\$\(cat "\$GY\.request"\)"$/); assert.doesNotMatch(calls[1][3], /Implement GY-42|coordinator-token/);
    const typed = expandTypedCommand(calls[1][3]);
    assert.equal(typed.stem, join(root, 'assigned', '.graphyard/launch/eng-a')); assert.ok(typed.args.at(-1)!.startsWith(`${autonomyContract} Implement GY-42: `), 'Codex loads no role file, so the autonomy contract leads the request (GY-184)'); assert.match(typed.args.at(-1)!, /Implement GY-42: .*complete/);
    assert.equal(probes, 1, 'a session working on its request is accepted at first sight'); assert.equal(result.delivery, 'request');
    assert.deepEqual(calls.at(-1)!.slice(0, 3), ['agent', 'rename', 'p1']); assert.equal(calls.some(call => call[0] === 'agent' && call[1] === 'prompt'), false);
    const failedCalls: string[][] = []; let releasedEpoch = 0;
    await assert.rejects(dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null }), profile, [], (_command, args) => { failedCalls.push(args); return JSON.stringify({ result: args[0] === 'tab' ? { pane_id: 'late-pane' } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} }); }, undefined, async () => ({ epoch: 5, path: join(root, 'late'), base: 'd'.repeat(40) }), async (_root, _key, epoch) => { releasedEpoch = epoch; }, 1), /the codex runtime never started within 0 s in pane late-pane \(no runtime under the pane\)/);
    assert.equal(releasedEpoch, 5); assert.deepEqual(failedCalls.at(-2), ['pane', 'close', 'late-pane']); assert.deepEqual(failedCalls.at(-1), ['pane', 'list']);
    const promptCalls: string[][] = []; let promptRelease = 0;
    await assert.rejects(dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null }), profile, [], (_command, args) => {
      promptCalls.push(args); if (args[1] === 'rename') throw new Error('rename refused');
      return JSON.stringify({ result: args[0] === 'tab' ? { pane_id: 'prompt-pane' } : args[1] === 'get' ? { type: 'agent_info', agent: { pane_id: 'prompt-pane', agent: 'codex', agent_status: 'idle' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
    }, undefined, async () => ({ epoch: 6, path: join(root, 'prompt'), base: 'e'.repeat(40) }), async (_root, _key, epoch) => { promptRelease = epoch; }), /rename refused/);
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
      if (args[0] === 'agent' && args[1] === 'get') { blockedProbes++; return JSON.stringify({ result: { agent: { pane_id: 'blocked-pane', agent: 'codex', agent_status: 'blocked' } } }); }
      if (args[0] === 'pane' && args[1] === 'read') return '❯ No, keep this model\n  Yes, switch models\n';
      return JSON.stringify({ result: args[0] === 'tab' ? { pane_id: 'blocked-pane' } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
    }, undefined, async () => ({ epoch: 9, path: join(root, 'blocked'), base: '2'.repeat(40) }), async (_root, _key, epoch) => { blockedRelease = epoch; }, 5_000), /blocked before it is ready/);
    assert.equal(blockedProbes, 1); assert.equal(blockedRelease, 9); assert.ok(performance.now() - blockedStarted < 1_000, 'blocked state must bypass lookup retries');
    await assert.rejects(dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null }), profile, [], (_command, args) => {
      if (args[0] === 'agent' && args[1] === 'get') return JSON.stringify({ result: { agent: { pane_id: 'blocked-pane', agent: 'codex', agent_status: 'blocked' } } });
      if (args[0] === 'pane' && args[1] === 'read') return '❯ No, keep this model\n  Yes, switch models\n';
      return JSON.stringify({ result: args[0] === 'tab' ? { pane_id: 'blocked-pane' } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
    }, undefined, async () => ({ epoch: 9, path: join(root, 'blocked'), base: '2'.repeat(40) }), async () => {}, 5_000), /blocked on a dialog the launcher does not recognise: "❯ No, keep this model \/ Yes, switch models"\); the pane last showed: "Yes, switch models"/, 'GY-121, GY-1561: the refusal shows the dialog the runtime is blocked on');
    // Claude Code's folder-trust menu with its question scrolled out of view is named by its options (GY-1561).
    await assert.rejects(dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null }), profile, [], (_command, args) => {
      if (args[0] === 'agent' && args[1] === 'get') return JSON.stringify({ result: { agent: { pane_id: 'blocked-pane', agent: 'codex', agent_status: 'blocked' } } });
      if (args[0] === 'pane' && args[1] === 'read') return '❯ No, exit\n  Yes, I trust this folder\n';
      return JSON.stringify({ result: args[0] === 'tab' ? { pane_id: 'blocked-pane' } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
    }, undefined, async () => ({ epoch: 9, path: join(root, 'blocked'), base: '2'.repeat(40) }), async () => {}, 5_000), /stopped at a workspace-trust prompt in pane blocked-pane .*"❯ No, exit \/ Yes, I trust this folder"/);
    const existing = { name: 'existing', principal: 'worker-a', agentName: 'existing-a', mode: 'existing' as const, agentArgs: [], approvals: 'auto' as const, environment: {} };
    await assert.rejects(dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null }), existing, [{ name: 'existing-a', agent_status: 'idle', cwd: root }]), /cannot be safely adopted/);
    const dependency = work({ id: 'dependency', key: 'GY-41', stage: 'build' });
    await assert.rejects(dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null, dependencies: [dependency.id] }), profile, [], undefined, [dependency]), /unfinished dependencies/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});

test('Muse dispatch runs the installed binary through claim, assigned worktree, Herdr, and watch with its own credential only', async () => {
  const root = await repository(); const credentialDirectory = await temporaryDirectory('master-credentials'); const calls: string[][] = [];
  const previousToken = process.env.GRAPHYARD_TOKEN; process.env.GRAPHYARD_TOKEN = coordinatorToken;
  try {
    const credential = join(credentialDirectory, 'muse-1.token'); await writeFile(credential, workerToken, { mode: 0o600 });
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, herdrWorkspace: 'workspace-graphyard' }, coordinatorStatus as typeof fetch);
    await assert.rejects(saveWorkerProfile(root, { name: 'muse-primary', principal: 'muse-1', agentName: 'engineering-muse-1', mode: 'launch', kind: 'muse', credentialFile: credential }, async () => ({ actor: { id: 'muse-1', role: 'coordinator' } })), /worker role/);
    await assert.rejects(saveWorkerProfile(root, { name: 'muse-primary', principal: 'muse-1', agentName: 'engineering-muse-1', mode: 'launch', kind: 'muse', credentialFile: credential }, async () => ({ actor: { id: 'muse-2', role: 'worker' } })), /profile principal/);
    const saved = await saveWorkerProfile(root, { name: 'muse-primary', principal: 'muse-1', agentName: 'engineering-muse-1', mode: 'launch', kind: 'muse', credentialFile: credential, agentArgs: ['--approval-mode', 'never', '--trust-workspace'] }, async token => ({ actor: { id: token === workerToken ? 'muse-1' : 'wrong', role: 'worker' } }));
    // Muse's own recipe (GY-184) is exactly the arguments this profile already configures, so Graphyard adds nothing.
    assert.equal(saved.launch!.applied, true); assert.match(saved.launch!.reason!, /already configures the runtime approval flags/); assert.deepEqual(saved.launch!.args, ['--approval-mode', 'never', '--trust-workspace']);
    const profile = (await loadMasterConfig(root)).workers[0];
    assert.equal(profile.kind, 'muse');
    // The claim runs under the profile's own credential file: the coordinator token in the
    // master's environment never reaches the worker process.
    const prepareCalls: { args: string[]; options: any }[] = []; const base = 'c'.repeat(40);
    const prepared = await prepareWorkerLaunch(root, 'GY-42', 'muse-primary', (command, args, options) => {
      prepareCalls.push({ args, options });
      if (command === 'git') return args[0] === 'rev-parse' ? `${base}\n` : '';
      return args[1] === 'claim' ? JSON.stringify({ epoch: 4, lease: { owner: 'muse-1' } }) : JSON.stringify({ path: join(root, 'assigned') });
    });
    assert.equal(prepared.epoch, 4); const claim = prepareCalls.find(call => call.args[1] === 'claim')!;
    assert.equal(claim.options.env.GRAPHYARD_TOKEN_FILE, credential); assert.equal(claim.options.env.GRAPHYARD_TOKEN, undefined); assert.equal(claim.options.env.GRAPHYARD_MASTER_TOKEN, undefined);
    let probes = 0;
    const result = await dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null }), profile, [], (_command, args) => { calls.push(args); return JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'muse-pane', tab_id: 'muse-tab' }, tab: { tab_id: 'muse-tab' } } : args[1] === 'get' ? { type: 'agent_info', agent: { pane_id: 'muse-pane', agent: 'muse', agent_status: ++probes === 1 ? 'working' : 'idle' } } : {} }); }, undefined, async () => ({ epoch: 4, path: join(root, 'assigned'), base }), undefined, undefined, undefined, { start: { wait: () => {} } });
    assert.match(result.ownership, /supervising/); assert.equal(result.principal, 'muse-1'); assert.equal(result.launch.applied, true);
    const tab = calls[0]; assert.deepEqual(tab.slice(0, 4), ['tab', 'create', '--workspace', 'workspace-graphyard']);
    assert.equal(tab[tab.indexOf('--cwd') + 1], join(root, 'assigned'));
    const tabEnvironment = tab.flatMap((argument, index) => argument === '--env' ? [tab[index + 1]] : []);
    assert.ok(tabEnvironment.includes(`GRAPHYARD_TOKEN_FILE=${credential}`)); assert.ok(tabEnvironment.includes('GRAPHYARD_HERDR_AGENT_KIND=muse'));
    assert.ok(tabEnvironment.every(entry => !entry.startsWith('GRAPHYARD_TOKEN=') && !entry.startsWith('GRAPHYARD_MASTER_TOKEN=') && !entry.includes(coordinatorToken)), 'the Muse tab receives only its own credential file');
    assert.deepEqual(calls[1].slice(0, 3), ['pane', 'run', 'muse-pane']);
    assert.match(calls[1][3], / watch GY-42 4 -- muse --approval-mode never --trust-workspace "\$\(cat "\$GY\.request"\)"$/, 'Muse starts only under graphyard watch with the profile arguments, on its own positional request (GY-184)');
    assert.match(calls[1][3], /^GY=/, 'the line references the request file');
    assert.doesNotMatch(calls[1][3], /herdr agent start|GRAPHYARD_TOKEN/);
    // Muse takes its request on its command line, so it is never prompted after it starts.
    assert.equal(probes, 1, 'a Muse session seen working has started'); assert.equal(result.delivery, 'request');
    assert.deepEqual(calls.at(-1)!.slice(0, 3), ['agent', 'rename', 'muse-pane']); assert.equal(calls.some(call => call[0] === 'agent' && call[1] === 'prompt'), false);
    assert.match(await readFile(join(root, 'assigned/.graphyard/launch/engineering-muse-1.request'), 'utf8'), /principal muse-1/); assert.equal(JSON.stringify(calls).includes(coordinatorToken), false); assert.equal(JSON.stringify(calls).includes(workerToken), false);
    // A Muse session that never becomes visible is closed and its epoch released; one Herdr
    // cannot confirm closed keeps the epoch fenced.
    const failedCalls: string[][] = []; let releasedEpoch = 0;
    await assert.rejects(dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null }), profile, [], (_command, args) => { failedCalls.push(args); return JSON.stringify({ result: args[0] === 'tab' ? { pane_id: 'late-muse' } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} }); }, undefined, async () => ({ epoch: 5, path: join(root, 'late'), base }), async (_root, _key, epoch) => { releasedEpoch = epoch; }, 1), /the muse runtime never started within 0 s in pane late-muse \(no runtime under the pane\)/);
    assert.equal(releasedEpoch, 5); assert.deepEqual(failedCalls.at(-2), ['pane', 'close', 'late-muse']); assert.deepEqual(failedCalls.at(-1), ['pane', 'list']);
    let blockedRelease = 0;
    await assert.rejects(dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null }), profile, [], (_command, args) => {
      if (args[0] === 'agent' && args[1] === 'get') return JSON.stringify({ result: { agent: { pane_id: 'blocked-muse', agent: 'muse', agent_status: 'blocked' } } });
      return JSON.stringify({ result: args[0] === 'tab' ? { pane_id: 'blocked-muse' } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
    }, undefined, async () => ({ epoch: 6, path: join(root, 'blocked'), base }), async (_root, _key, epoch) => { blockedRelease = epoch; }, 5_000), /blocked before it is ready/);
    assert.equal(blockedRelease, 6);
    let unsafeRelease = false;
    await assert.rejects(dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null }), profile, [], (_command, args) => {
      if (args[0] === 'pane' && args[1] === 'close') throw new Error('daemon unavailable');
      return JSON.stringify({ result: args[0] === 'tab' ? { pane_id: 'unsafe-muse' } : {} });
    }, undefined, async () => ({ epoch: 7, path: join(root, 'unsafe'), base }), async () => { unsafeRelease = true; }, 1), /retained epoch 7/);
    assert.equal(unsafeRelease, false, 'ownership remains fenced until Muse pane shutdown is confirmed');
    // An already-running Muse session is observable but never adopted for new work.
    await assert.rejects(dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null }), profile, [{ name: 'engineering-muse-1', agent: 'muse', agent_status: 'idle', cwd: root }]), /already visible in Herdr/);
    const existing = { ...profile, name: 'muse-existing', principal: 'muse-2', agentName: 'engineering-muse-2', mode: 'existing' as const, kind: undefined, credentialFile: undefined };
    await assert.rejects(dispatchWork(root, work({ stage: 'ready', lease: null, submission: null, candidate: null, mergeAuthorization: null }), existing, [{ name: 'engineering-muse-2', agent: 'muse', agent_status: 'idle', cwd: root }]), /cannot be safely adopted/);
  } finally {
    if (previousToken === undefined) delete process.env.GRAPHYARD_TOKEN; else process.env.GRAPHYARD_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true });
  }
});

test('dispatch claimability permits operator-authorized rework independent of display stage', () => {
  const rework = work({ stage: 'build', reworkRequested: true, lease: null });
  assert.doesNotThrow(() => assertDispatchable(rework, [rework], '2030-01-01T00:00:00Z'));
  assert.throws(() => assertDispatchable(work({ stage: 'merge', reworkRequested: false }), [], '2030-01-01T00:00:00Z'), /operator-authorized rework/);
  assert.throws(() => assertDispatchable(work({ stage: 'ready', submission: null, lease: { owner: 'worker-a', epoch: 2, expiresAt: '2030-01-01T00:01:00Z' } }), [], '2030-01-01T00:00:00Z'), /active owner/);
  const candidate = work({ id: 'candidate', key: 'GY-43', stage: 'ready', submission: null, lease: null, exclusiveResources: ['staging'] });
  const holder = work({ id: 'holder', key: 'GY-44', lease: { owner: 'worker-b', epoch: 3, expiresAt: '2030-01-01T00:05:00Z' }, exclusiveResources: ['staging'] });
  assert.throws(() => assertDispatchable(candidate, [candidate, holder], '2030-01-01T00:00:00Z'), /staging held by GY-44/);
});

test('master start creates a visible non-focused coordinator session with no credential argument', async () => {
  const root = await repository(); const credentialDirectory = await temporaryDirectory('master-credentials'); const calls: string[][] = [];
  try {
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, herdrWorkspace: 'workspace-graphyard' }, coordinatorStatus as typeof fetch);
    const result = await startMaster(root, 'codex', ['--model', 'reviewer'], [], (_command, args) => {
      calls.push(args);
      return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'pane-master', tab_id: 'tab-master' }, tab: { tab_id: 'tab-master' } } : {} });
    });
    assert.equal(result.focusChanged, false); assert.equal(result.pane, 'pane-master');
    assert.ok(calls[0].includes('--no-focus')); assert.deepEqual(calls[0].slice(0, 4), ['tab', 'create', '--workspace', 'workspace-graphyard']);
    // GY-93: the master's instruction is its own first request, the positional prompt of its
    // start; since GY-121 the shell reads it from the request file the typed line references.
    assert.deepEqual(calls[1].slice(0, 3), ['pane', 'run', 'pane-master']);
    const master = expandTypedCommand(calls[1][3]);
    assert.equal(master.kind, 'codex'); assert.equal(master.stem, join(root, '.graphyard/launch', (await loadMasterConfig(root)).masterAgentName)); assert.match(master.args.at(-1)!, /dedicated Graphyard master agent/); assert.equal(result.delivery, 'request');
    assert.equal(calls.some(call => call[0] === 'agent' && call[1] === 'prompt'), false, 'nothing is pasted into the master session');
    assert.equal(JSON.stringify(calls).includes(coordinatorToken), false);
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, autoMerge: false }, coordinatorStatus as typeof fetch);
    const manualCalls: string[][] = [];
    await startMaster(root, 'codex', [], [], (_command, args) => { manualCalls.push(args); return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { pane_id: 'manual-master' } : {} }); });
    assert.doesNotMatch(expandTypedCommand(manualCalls[1][3]).args.at(-1)!, /Automatic merging is disabled/, 'autoMerge off asks for no merge approval: GitHub merges');
    const failedCalls: string[][] = [];
    await assert.rejects(startMaster(root, 'codex', [], [], (_command, args) => {
      failedCalls.push(args); if (args[0] === 'pane' && args[1] === 'run') throw new Error('start refused');
      return JSON.stringify({ result: args[0] === 'tab' ? { pane_id: 'failed-master' } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
    }), /start refused/);
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
  const root = await repository(); const credentialDirectory = await temporaryDirectory('master-credentials'); const credential = join(credentialDirectory, 'worker.token'); const siblingParent = await temporaryDirectory('sibling'); const sibling = join(siblingParent, 'worktree');
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
  const root = await repository(); const credentialDirectory = await temporaryDirectory('master-credentials'); const credential = join(credentialDirectory, 'worker.token'); const calls: { args: string[]; options: any }[] = [];
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
    assert.equal(failed.at(-1)![1], 'unclaim'); assert.equal(failed.at(-1)![3], '6');
    const changedIdentity: string[][] = [];
    await assert.rejects(prepareWorkerLaunch(root, 'GY-42', 'launch', (command, args) => {
      changedIdentity.push(args);
      if (command === 'git') return args[0] === 'rev-parse' ? `${base}\n` : '';
      if (args[1] === 'claim') return JSON.stringify({ epoch: 7, lease: { owner: 'rotated-worker' } });
      return '{}';
    }), /unexpected assignment identity/);
    assert.equal(changedIdentity.at(-1)![1], 'unclaim'); assert.equal(changedIdentity.at(-1)![3], '7');
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/other/project.git'], { cwd: root });
    await assert.rejects(prepareWorkerLaunch(root, 'GY-42', 'launch'), /different repositories/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});
