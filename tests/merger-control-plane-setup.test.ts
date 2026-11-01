import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupMaster } from '../src/master.js';
import { setupChecklist } from '../src/model/setup-checklist.js';
import { setupFromZeroChecks } from '../src/setup-from-zero.js';
import { applyProposal, managedInstructions, scanProposal, setupRepository } from '../src/repository-setup.js';
import { guideText } from '../src/guide.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1553 AC-4, retired further by GY-3003: the control plane is the only merge writer, so the
 * Setup checklist and doctor's setup-from-zero checks name no GitHub App or reviewer App step at
 * all, no branch-protection item is judged, and the AGENTS.md worker block tells the worker to
 * submit with `complete GY-N EPOCH --head SHA`.
 */
/** A fresh install with no App and no reviewer App, only a worker account; an old `github` mergeWriter changes nothing. */
const bare = (supervision = 'autonomous') => ({
  actor: { role: 'admin' }, github: false, githubAppId: null, githubRepository: null, baseBranch: 'main',
  setup: { loop: true, supervision },
  fleet: { roles: [{ role: 'worker', accounts: ['claude-a'] }], accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, eligible: true }] },
  mergeWriter: { merger: 'github' },
});

test('unit:setup-checklist-control-plane — the Setup checklist names no GitHub App or reviewer App step for any install, judges no branch protection and no merger', () => {
  const control = setupChecklist(bare());
  assert.deepEqual(control.map(item => item.id), ['account:worker', 'account:reviewer', 'master-loop']);
  assert.equal(control.find(item => item.id === 'account:worker')!.done, true, 'the worker account is still judged');
  assert.equal(control.find(item => item.id === 'account:reviewer')!.done, false, 'the reviewing account is still required');
  // GY-1978: a supervised install's heads are reviewed by an agent and merged by the control plane too, so its checklist is the same.
  assert.deepEqual(setupChecklist(bare('supervised')), control, 'supervision changes no step');
});

test('unit:setup-checklist-control-plane — doctor\'s setup-from-zero checks name no GitHub App, reviewer App or branch-protection line for an unsupervised install', async () => {
  const root = await temporaryDirectory('merger-control-plane-setup');
  const checks = await setupFromZeroChecks({ root, env: {}, status: bare(), environments: join(root, 'none'), sandbox: () => null });
  assert.deepEqual(checks.map(check => check.id), ['control-plane', 'credentials-file', 'agent-environments', 'worker-sandbox']);
  assert.ok(!checks.some(check => check.id === 'github-app' || check.id === 'reviewer-app'), 'no App line');
  assert.ok(!checks.some(check => check.id === 'branch-protection' || check.id === 'merger'), 'no branch protection or merger line');
});

test('unit:agents-block-control-plane — the AGENTS.md worker block says complete GY-N EPOCH --head SHA with no push or pull request, and this repository\'s own block is a faithful rendering', async () => {
  const block = managedInstructions('# Rules\n');
  assert.match(block, /Submit with `complete GY-N EPOCH --head SHA`; make `complete` your last action\./);
  assert.ok(!block.includes('PR_NUMBER') && !/\bpush\b/.test(block.replace(/nothing is pushed/g, '')), 'the block names no pull request and asks for no push');
  // GY-2972: the submit semantics the block no longer carries print from guide complete.
  assert.match(guideText('complete').replace(/\s+/g, ' '), /Submit the commit with `complete GY-N EPOCH --head SHA` \(the control plane is the merge writer; the shared object store already holds SHA\)\. This reports implementation completion and ends your lease in the same transaction; it does not set Done\./);
  assert.match(guideText('complete'), /Make `complete` your last action: do not heartbeat or edit after it\./);
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
  await setupRepository(worker, { url: 'https://graphyard.example', cliPath: launcher, hostId: 'host-a', token: 'worker-token-'.padEnd(40, 'x') }, { fetcher });
  assert.equal(await readFile(join(worker, 'AGENTS.md'), 'utf8'), expected, 'worker init writes the --head block');

  const applied = await repository('merger-apply');
  const proposal = await scanProposal(applied, { url: 'https://graphyard.example', runtimes: [] });
  await applyProposal(applied, proposal, { url: 'https://graphyard.example', installed: { directory: '/tmp/graphyard-install-fixture', githubApp: { appId: 1, slug: 'graphyard-owner-project' } } });
  assert.equal(await readFile(join(applied, 'AGENTS.md'), 'utf8'), expected, 'init --apply writes the --head block');
});
