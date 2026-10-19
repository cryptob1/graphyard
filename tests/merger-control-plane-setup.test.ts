import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupMaster } from '../src/master.js';
import { mergerNotRequired, setupChecklist } from '../src/model/setup-checklist.js';
import { setupFromZeroChecks, setupLine, setupSteps } from '../src/setup-from-zero.js';
import { applyProposal, managedInstructions, scanProposal, setupRepository } from '../src/repository-setup.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1553 AC-4: the control plane is the only merge writer, so for every unsupervised install the
 * Setup checklist items and doctor's setup-from-zero checks `github-app` and `reviewer-app` pass as
 * `not required (merger: control-plane)`, no branch-protection item is judged, and the AGENTS.md
 * worker block tells the worker to submit with `complete GY-N EPOCH --head SHA`.
 */
const notRequired = ['github-app', 'reviewer-app'] as const;
/** A fresh install with no App and no reviewer App, only a worker account; an old `github` mergeWriter changes nothing. */
const bare = (supervision = 'autonomous') => ({
  actor: { role: 'admin' }, github: false, githubAppId: null, githubRepository: null, baseBranch: 'main', reviewerApps: [],
  appPermissions: null, setup: { loop: true, supervision },
  fleet: { roles: [{ role: 'worker', accounts: ['claude-a'] }], accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, eligible: true }] },
  mergeWriter: { merger: 'github' },
});

test('unit:setup-checklist-control-plane — the Setup checklist passes github-app and reviewer-app as not required for every install, supervised or not, judges no branch protection and no merger, and judges the App only on up\'s App path', () => {
  assert.equal(mergerNotRequired, 'not required (merger: control-plane)');
  const control = setupChecklist(bare());
  assert.deepEqual(control.map(item => item.id), ['github-app', 'reviewer-app', 'account:worker', 'account:reviewer', 'master-loop']);
  for (const id of notRequired) {
    const item = control.find(entry => entry.id === id)!;
    assert.deepEqual({ done: item.done, line: item.line, action: item.action, human: item.human }, { done: true, line: mergerNotRequired, action: null, human: false }, `${id} reads as passed and asks nothing`);
  }
  assert.equal(control.find(item => item.id === 'account:worker')!.done, true, 'the worker account is still judged');
  assert.equal(control.find(item => item.id === 'account:reviewer')!.done, false, 'the reviewing account is still required');
  // GY-1978: a supervised install's heads are reviewed by an agent and merged by the control plane too, so its checklist is the same.
  assert.deepEqual(setupChecklist(bare('supervised')), control, 'supervision changes no step');
  assert.equal(setupChecklist(bare(), { githubApps: true }).find(item => item.id === 'github-app')!.done, false, 'up\'s own App path judges its App');
});

test('unit:setup-checklist-control-plane — doctor\'s setup-from-zero checks print PASS github-app and reviewer-app as not required for an unsupervised install, naming their steps, and judge no branch protection or merger', async () => {
  const root = await temporaryDirectory('merger-control-plane-setup');
  const checks = await setupFromZeroChecks({ root, env: {}, status: bare(), environments: join(root, 'none'), sandbox: () => null });
  assert.deepEqual(checks.map(check => check.id).slice(0, 4), ['control-plane', 'credentials-file', 'github-app', 'reviewer-app'], 'the lines keep their order');
  const lines = checks.filter(check => (notRequired as readonly string[]).includes(check.id));
  assert.deepEqual(lines.map(setupLine), ['PASS github-app: not required (merger: control-plane)', 'PASS reviewer-app: not required (merger: control-plane)']);
  assert.deepEqual(lines.map(check => check.step), [setupSteps.app, setupSteps.reviewer], 'each line still names its checklist step');
  assert.ok(!checks.some(check => check.id === 'branch-protection' || check.id === 'merger'), 'no branch protection or merger line');
});

test('unit:agents-block-control-plane — the AGENTS.md worker block says complete GY-N EPOCH --head SHA with no push or pull request, and this repository\'s own block is a faithful rendering', async () => {
  const block = managedInstructions('# Rules\n');
  assert.match(block, /Submit the commit with `complete GY-N EPOCH --head SHA` \(the control plane is the merge\nwriter; the shared object store already holds SHA\)\. This reports implementation\ncompletion and ends your lease in the same transaction; it does not set Done\./);
  assert.ok(!block.includes('PR_NUMBER') && !/\bpush\b/.test(block.replace(/nothing is pushed/g, '')), 'the block names no pull request and asks for no push');
  assert.match(block, /`complete` your last action: do not heartbeat or edit after it\./);
  assert.equal(managedInstructions(block), block, 'regenerating keeps it exactly once');
  const agents = await readFile(join(import.meta.dirname, '../AGENTS.md'), 'utf8');
  assert.ok(!/uses Graphyard at \S+ for ownership/.test(agents), 'this repository\'s AGENTS.md names no server: the origin lives in ignored .graphyard/connection.json (GY-2240)');
  assert.equal(managedInstructions(agents), agents, 'this repository\'s AGENTS.md is the rendering, regenerated to match');
});

test('unit:agents-block-control-plane — master init (with no GitHub App), worker init and init --apply write the --head block whatever merger the status reports', async () => {
  const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
  const expected = managedInstructions('');
  const repository = async (label: string) => {
    const root = await temporaryDirectory(label);
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    return root;
  };
  const master = await repository('merger-agents-block'), credentials = await temporaryDirectory('merger-agents-block-credentials');
  const status = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: null, mergeWriter: { merger: 'github' } }));
  await setupMaster(master, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'wE' }, status as typeof fetch);
  assert.equal(await readFile(join(master, 'AGENTS.md'), 'utf8'), expected, 'master init writes the --head block with no App');

  const worker = await repository('merger-worker-init');
  const fetcher = (async () => new Response(JSON.stringify({ actor: { id: 'worker-a', role: 'worker' }, repository: 'owner/project', mergeWriter: { merger: 'github' } }))) as typeof fetch;
  await setupRepository(worker, { url: 'https://graphyard.example', cliPath: launcher, hostId: 'host-a', token: 'worker-token-'.padEnd(40, 'x') }, { fetcher, executors: false });
  assert.equal(await readFile(join(worker, 'AGENTS.md'), 'utf8'), expected, 'worker init writes the --head block');

  const applied = await repository('merger-apply');
  const proposal = await scanProposal(applied, { url: 'https://graphyard.example', runtimes: [] });
  await applyProposal(applied, proposal, { url: 'https://graphyard.example', installed: { directory: '/tmp/graphyard-install-fixture', githubApp: { appId: 1, slug: 'graphyard-owner-project' } } });
  assert.equal(await readFile(join(applied, 'AGENTS.md'), 'utf8'), expected, 'init --apply writes the --head block');
});
