import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupMaster } from '../src/master.js';
import * as checklist from '../src/model/setup-checklist.js';
import { setupChecklist } from '../src/model/setup-checklist.js';
import { setupFromZeroChecks, setupLine, setupSteps } from '../src/setup-from-zero.js';
import { managedInstructions, setupRepository } from '../src/repository-setup.js';
import { managedServerUrl } from '../src/sync.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1553 AC-4: while `/api/status` reports `mergeWriter.merger` as `control-plane`, the Setup
 * checklist items and doctor's setup-from-zero checks `github-app`, `reviewer-app` and
 * `branch-protection` pass as `not required (merger: control-plane)`, and the AGENTS.md worker
 * block tells the worker to submit with `complete GY-N EPOCH --head SHA`; under the `github`
 * merger (or an older server that reports none) every one of them keeps its current text.
 */
const notRequired = ['github-app', 'reviewer-app', 'branch-protection'] as const;
// Namespace reads, so a test against code without these symbols fails as a test case, not at load.
const mergerNotRequired: string = (checklist as any).mergerNotRequired;
const statusControlPlaneMerger = (status: any) => (checklist as any).statusControlPlaneMerger(status);
/** A fresh install with no App, no reviewer App and no protection, only a worker account. */
const bare = (merger: 'github' | 'control-plane' | null) => ({
  actor: { role: 'admin' }, github: false, githubAppId: null, githubRepository: null, baseBranch: 'main', reviewerApps: [],
  appPermissions: null, setup: { protection: 'none', loop: true, supervision: 'autonomous' },
  fleet: { roles: [{ role: 'worker', accounts: ['claude-a'] }], accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, eligible: true }] },
  ...(merger ? { mergeWriter: { merger, since: merger === 'control-plane' ? '2026-10-08T00:00:00.000Z' : null, setBy: merger === 'control-plane' ? 'human-operator' : null, reason: null, event: null, line: null } } : {}),
});

test('unit:setup-checklist-control-plane — the Setup checklist passes github-app, reviewer-app and branch-protection as not required while the control plane is the merge writer, keeps every other item, and judges them as before under the github merger', () => {
  assert.equal(mergerNotRequired, 'not required (merger: control-plane)');
  assert.equal(statusControlPlaneMerger(bare('control-plane')), true);
  assert.equal(statusControlPlaneMerger(bare('github')), false); assert.equal(statusControlPlaneMerger(bare(null)), false); assert.equal(statusControlPlaneMerger(null), false);

  const control = setupChecklist(bare('control-plane'));
  assert.deepEqual(control.map(item => item.id), ['github-app', 'reviewer-app', 'account:worker', 'account:reviewer', 'branch-protection', 'master-loop'], 'the items stay, in order');
  for (const id of notRequired) {
    const item = control.find(entry => entry.id === id)!;
    assert.deepEqual({ done: item.done, line: item.line, action: item.action, human: item.human }, { done: true, line: mergerNotRequired, action: null, human: false }, `${id} reads as passed and asks nothing`);
  }
  assert.equal(control.find(item => item.id === 'account:worker')!.done, true, 'the worker account is still judged');
  assert.equal(control.find(item => item.id === 'account:reviewer')!.done, false, 'the reviewing account is still required');
  assert.deepEqual(setupChecklist(bare(null), { merger: 'control-plane' }).map(item => [item.id, item.done, item.line]), control.map(item => [item.id, item.done, item.line]), 'the option says the same before the status reports the setting');
  const supervised = setupChecklist({ ...bare('control-plane'), setup: { ...bare('control-plane').setup, supervision: 'supervised' } });
  assert.ok(!supervised.some(item => item.id === 'reviewer-app' || item.id === 'account:reviewer'), 'supervision still removes the reviewer items');
  assert.deepEqual(supervised.filter(item => item.id === 'github-app' || item.id === 'branch-protection').map(item => item.line), [mergerNotRequired, mergerNotRequired]);

  for (const merger of ['github', null] as const) {
    const items = setupChecklist(bare(merger));
    assert.deepEqual(items.map(item => item.id), control.map(item => item.id));
    for (const id of notRequired) {
      const item = items.find(entry => entry.id === id)!;
      assert.equal(item.done, false, `${merger ?? 'no'} merger: ${id} is still required`);
      assert.notEqual(item.line, mergerNotRequired); assert.ok(item.action, `${id} still offers its action`);
    }
    assert.deepEqual(setupChecklist(bare(merger), { merger: 'github' }), items);
  }
  const github = setupChecklist(bare('github'));
  assert.equal(github.find(item => item.id === 'github-app')!.line, 'Create the App that lets Graphyard work in your repository, then install it there.');
  assert.equal(github.find(item => item.id === 'branch-protection')!.line, 'Turned on by itself once the GitHub App is installed.');
});

test('unit:setup-checklist-control-plane — doctor\'s setup-from-zero checks print PASS github-app, reviewer-app and branch-protection as not required under the control-plane merger, name their steps, and fail as before under the github merger', async () => {
  const root = await temporaryDirectory('merger-control-plane-setup');
  const input = (merger: 'github' | 'control-plane' | null) => ({ root, env: {}, status: bare(merger), environments: join(root, 'none'), sandbox: () => null, github: () => { throw new Error('gh: Branch not protected (HTTP 404)'); } });
  const control = await setupFromZeroChecks(input('control-plane'));
  assert.deepEqual(control.map(check => check.id).slice(0, 5), ['control-plane', 'credentials-file', 'github-app', 'reviewer-app', 'branch-protection'], 'the lines keep their order');
  assert.deepEqual(control.filter(check => (notRequired as readonly string[]).includes(check.id)).map(setupLine),
    ['PASS github-app: not required (merger: control-plane)', 'PASS reviewer-app: not required (merger: control-plane)', 'PASS branch-protection: not required (merger: control-plane)']);
  assert.deepEqual(control.filter(check => (notRequired as readonly string[]).includes(check.id)).map(check => check.step), [setupSteps.app, setupSteps.reviewer, setupSteps.protection], 'each line still names its checklist step');
  assert.equal(control.find(check => check.id === 'control-plane')!.status, 'pass', 'the plane itself is judged as before');
  for (const merger of ['github', null] as const) {
    const checks = await setupFromZeroChecks(input(merger));
    assert.deepEqual(checks.map(check => check.id), control.map(check => check.id));
    assert.deepEqual(checks.filter(check => (notRequired as readonly string[]).includes(check.id)).map(check => [check.id, check.status]), notRequired.map(id => [id, 'fail']), `${merger ?? 'no'} merger: the three prerequisites are still required`);
    assert.match(setupLine(checks.find(check => check.id === 'github-app')!), /^FAIL github-app: the server reports no bound GitHub App \(fix: /);
  }
});

test('unit:agents-block-control-plane — the AGENTS.md worker block says complete GY-N EPOCH --head SHA while the control plane is the merge writer, keeps the current pull-request text otherwise, and this repository\'s own block is a faithful rendering', async () => {
  const url = 'https://graphyard.example';
  const github = managedInstructions('# Rules\n', url);
  assert.equal(managedInstructions('# Rules\n', url, { merger: 'github' }), github, 'the github merger renders the current text');
  assert.equal(managedInstructions('# Rules\n', url, { merger: null }), github, 'a server that reports no merger renders the current text');
  assert.match(github, /Submit the PR with `complete GY-N EPOCH PR_NUMBER`\. This reports implementation\ncompletion and ends your lease in the same transaction; it does not set Done\./);
  assert.ok(!github.includes('--head'), 'the github block never mentions --head');

  const control = managedInstructions('# Rules\n', url, { merger: 'control-plane' });
  assert.match(control, /Submit the commit with `complete GY-N EPOCH --head SHA` \(the control plane is the merge\nwriter: nothing is pushed, the shared object store already holds SHA\)\. This reports\nimplementation completion and ends your lease in the same transaction; it does not set\nDone\./);
  assert.ok(!control.includes('PR_NUMBER'), 'the control-plane block names no pull request');
  assert.match(control, /refused, naming the files and the shipped work they belong to, when the commit\nreverts, deletes or rewrites files outside plannedFiles/);
  assert.match(control, /Make `complete` your last action: do not heartbeat, edit, or push after it\./);
  const paragraphs = (text: string) => text.split(/\n\n/).filter(paragraph => !/complete GY-N EPOCH/.test(paragraph));
  assert.deepEqual(paragraphs(control), paragraphs(github), 'only the submission paragraph differs');
  assert.equal(managedInstructions(control, url, { merger: 'github' }), github, 'regenerating a control-plane block under the github merger restores the current text');
  assert.equal(managedInstructions(github, url, { merger: 'control-plane' }), control, 'and the other way round');
  assert.equal(managedInstructions(control, url, { merger: 'control-plane' }), control, 'regenerating keeps it exactly once');

  const agents = await readFile(join(import.meta.dirname, '../AGENTS.md'), 'utf8');
  const recorded = managedServerUrl(agents);
  assert.ok(recorded, 'this repository\'s AGENTS.md names its server');
  assert.ok([managedInstructions(agents, recorded!), managedInstructions(agents, recorded!, { merger: 'control-plane' })].includes(agents), 'this repository\'s AGENTS.md is one of the two renderings, regenerated to match');
});

test('unit:agents-block-control-plane — master init renders the worker block from the merger /api/status reports: --head SHA under control-plane (including with no GitHub App), the pull-request text under github, and a rerun after the setting changes rewrites it', async () => {
  const root = await temporaryDirectory('merger-agents-block'), credentials = await temporaryDirectory('merger-agents-block-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
  const init = async (merger: 'github' | 'control-plane' | null, appId: number | null = 1234) => {
    const status = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: appId, ...(merger ? { mergeWriter: { merger } } : {}) }));
    await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'wE' }, status as typeof fetch);
    return readFile(join(root, 'AGENTS.md'), 'utf8');
  };
  // Control-plane installs correctly have no App: master init must still write the --head block.
  const control = await init('control-plane', null);
  assert.match(control, /Submit the commit with `complete GY-N EPOCH --head SHA`/); assert.ok(!control.includes('PR_NUMBER'));
  assert.equal(control, managedInstructions('', 'https://graphyard.example', { merger: 'control-plane' }), 'master init writes the control-plane rendering with no App');
  await assert.rejects(init('github', null), /identify its GitHub App/, 'github merger still refuses a missing App');
  const github = await init('github', 1234);
  assert.match(github, /Submit the PR with `complete GY-N EPOCH PR_NUMBER`/); assert.ok(!github.includes('--head'));
  assert.equal(github, managedInstructions('', 'https://graphyard.example'), 'a rerun under the github merger restores the current text');
  assert.equal(await init(null, 1234), github, 'a server that reports no merger renders the current text');
});

test('unit:agents-block-control-plane — worker init (setupRepository) passes the recorded merger into the AGENTS.md block: --head SHA under control-plane, the pull-request text under github', async () => {
  const root = await temporaryDirectory('merger-worker-init');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
  const token = 'worker-token-'.padEnd(40, 'x');
  const run = async (merger: 'github' | 'control-plane' | null) => {
    const fetcher = (async () => new Response(JSON.stringify({
      actor: { id: 'worker-a', role: 'worker' }, repository: 'owner/project',
      ...(merger ? { mergeWriter: { merger } } : {}),
    }))) as typeof fetch;
    await setupRepository(root, { url: 'https://graphyard.example', cliPath: launcher, hostId: 'host-a', token }, { fetcher, executors: false });
    return readFile(join(root, 'AGENTS.md'), 'utf8');
  };
  const control = await run('control-plane');
  assert.match(control, /Submit the commit with `complete GY-N EPOCH --head SHA`/); assert.ok(!control.includes('PR_NUMBER'));
  assert.equal(control, managedInstructions('', 'https://graphyard.example', { merger: 'control-plane' }));
  const github = await run('github');
  assert.match(github, /Submit the PR with `complete GY-N EPOCH PR_NUMBER`/); assert.ok(!github.includes('--head'));
  assert.equal(github, managedInstructions('', 'https://graphyard.example'));
  assert.equal(await run(null), github, 'a server that reports no merger keeps the pull-request text');
  // Rerunning under control-plane after a github write must restore --head, not leave PR_NUMBER.
  assert.equal(await run('control-plane'), control);
});
