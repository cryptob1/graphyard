import { test } from 'node:test';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { masterConfigSchema, workerProfileSchema, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { accountLaunch } from '../src/master/environments.js';
import { installWorkerHarness, prepareSessionHarness, sessionHarnessPlan, workerHarnessPlan } from '../src/master/harness.js';
import { coordinatorCheckoutRoot, workerConfinementRefusal } from '../src/master/profiles.js';
import { grantWorkerPaths, runtimeSandboxes, workerPaths, writablePaths } from '../src/worker-sandbox.js';

// GY-857: workers are confined to their assigned worktrees — worker sessions once wrote
// half-finished files into the coordinator checkout by absolute path.

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const addedDirectories = (args: string[], cwd: string) => args.flatMap((arg, index) => arg === '--add-dir' ? [join(cwd, args[index + 1])] : []);

/** A coordinator checkout laid out like a Graphyard installation, with one managed assignment worktree. */
async function coordinatorFixture() {
  const root = await temporaryDirectory('checkout-guard');
  const credentials = join(root, 'credentials');
  await mkdir(credentials, { recursive: true, mode: 0o700 });
  const credentialFile = join(credentials, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const main = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', main], { stdio: 'ignore' });
  git(main, 'config', 'user.email', 't@example.com');
  git(main, 'config', 'user.name', 'T');
  await mkdir(join(main, 'src'), { recursive: true });
  await mkdir(join(main, 'bin'), { recursive: true });
  await mkdir(join(main, 'tests'), { recursive: true });
  await mkdir(join(main, '.claude'), { recursive: true });
  await writeFile(join(main, 'bin', 'graphyard.mjs'), '#!/usr/bin/env node\n');
  await writeFile(join(main, 'src', 'loop.ts'), 'export const loop = 1;\n');
  await writeFile(join(main, 'tests', 'base.test.ts'), 'import { test } from "node:test";\n');
  await writeFile(join(main, '.gitignore'), '.graphyard/\n.claude/settings.local.json\n');
  await writeFile(join(main, '.claude', 'settings.json'), '{}\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'base');
  const worktree = join(main, '.graphyard', 'worktrees', 'GY-1-1');
  git(main, 'worktree', 'add', '-q', '-b', 'graphyard/gy-1-1', worktree);
  const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: join(main, 'bin', 'graphyard.mjs'),
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  return { root, main, worktree, credentials, credentialFile, config, dispose: () => Promise.resolve() };
}

type Fixture = Awaited<ReturnType<typeof coordinatorFixture>>;
const workerProfiles = (fixture: Fixture): WorkerProfile[] => {
  const base = { mode: 'launch' as const, approvals: 'auto' as const, principal: 'graphyard-worker-1', credentialFile: join(fixture.credentials, 'worker.token') };
  return ([
    { ...base, name: 'claude-worker', agentName: 'graphyard-claude-1', kind: 'claude' as const, agentArgs: [], environment: {} },
    { ...base, name: 'codex-worker', agentName: 'graphyard-codex-1', kind: 'codex' as const, agentArgs: [], environment: {} },
    { ...base, name: 'opencode-worker', agentName: 'graphyard-opencode-1', kind: 'opencode' as const, agentArgs: [], environment: {} },
  ]).map(profile => workerProfileSchema.parse(profile));
};

test('unit:worker-confined-to-worktree — every worker profile is launched with writes confined to its assigned worktree; the coordinator checkout is not writable from it', async () => {
  const fixture = await coordinatorFixture();
  try {
    const { main, worktree, config, credentials } = fixture;
    const paths = workerPaths(worktree);
    const writable = writablePaths({ ...paths, commonDir: paths.commonDir ?? join(main, '.git') });
    for (const profile of workerProfiles(fixture)) {
      // The profile as configured launches: no confinement opt-out, and the effective launch
      // grants nothing but the worktree and its Git admin directories (the opencode launch derives
      // its repository-tree permission itself, GY-2959).
      assert.equal(workerConfinementRefusal(profile), null, `${profile.name} as configured launches`);
      const launch = accountLaunch(profile, null, { repositoryRoot: main });
      const args = grantWorkerPaths(profile.kind, launch.args, writable, worktree);
      const granted = addedDirectories(args, worktree);
      if (profile.kind === 'codex') {
        assert.equal(runtimeSandboxes.codex.mode(args), 'workspace-write', 'the codex worker keeps its workspace-write sandbox');
        assert.deepEqual(granted, writable.filter(path => path !== worktree), 'only the Git admin directories are granted beside the worktree');
        assert.ok(granted.every(path => path.endsWith('/.git') || path.includes('/.git/')), `the coordinator checkout's working files are granted to no codex worker: ${granted.join(', ')}`);
      }
      if (profile.kind === 'opencode') {
        const grant = JSON.parse(launch.environment.OPENCODE_PERMISSION).external_directory;
        assert.equal(grant[`${main}/**`], 'allow', 'the opencode worker works the repository tree without prompting: its own bisect worktree beside the assigned one is granted');
        assert.equal(grant[`${main}/.graphyard/**`], 'allow', 'the managed worktrees under .graphyard are granted beside it');
        assert.equal(grant['*'], 'deny', 'the opencode worker reaches no path outside the repository');
      }
      if (profile.kind !== 'claude') continue;
      // Claude Code is confined by its harness rules: both files the session reads deny writing
      // the coordinator checkout's own files, and neither names the worktree itself.
      const coordinator = coordinatorCheckoutRoot(config.cliPath);
      const rules = workerHarnessPlan({ cliPath: config.cliPath, branch: 'graphyard/gy-1-1', baseBranch: 'main', credentialHome: credentials });
      const denials = rules.deny.filter(rule => /^(Edit|Write)\(\/\//.test(rule.rule));
      for (const area of ['src', 'tests', 'scripts', 'bin', 'docs']) {
        assert.ok(denials.some(rule => rule.rule === `Edit(//${coordinator.replace(/^\//, '')}/${area}/**)`), `the worker rules deny editing ${area}/ in the coordinator checkout`);
        assert.ok(denials.some(rule => rule.rule === `Write(//${coordinator.replace(/^\//, '')}/${area}/**)`), `the worker rules deny writing ${area}/ in the coordinator checkout`);
      }
      assert.ok(rules.deny.every(rule => !rule.rule.includes(worktree)), 'no worker rule denies the assigned worktree itself');
      const written = await installWorkerHarness(config, profile, 'GY-1', { epoch: 1, path: worktree, base: 'c'.repeat(40) });
      assert.equal(written.applied, true, 'the worker rules were written into the worktree');
      const settings = JSON.parse(await readFile(join(worktree, '.claude', 'settings.local.json'), 'utf8'));
      assert.ok(settings.permissions.deny.includes(`Edit(//${coordinator.replace(/^\//, '')}/src/**)`), 'the worktree settings deny editing the coordinator checkout');
      const session = await prepareSessionHarness(main, config, { role: 'worker', kind: 'claude', profile: profile.name, branch: 'graphyard/gy-1-1', credentialFiles: [profile.credentialFile!] });
      assert.ok(session.file, 'the worker role file was written');
      const role = JSON.parse(await readFile(session.file!, 'utf8'));
      assert.ok(role.permissions.deny.includes(`Write(//${coordinator.replace(/^\//, '')}/docs/**)`), 'the role file denies writing the coordinator checkout');
      const rolePlan = sessionHarnessPlan({ role: 'worker', kind: 'claude', cliPath: config.cliPath, repository: config.repository, baseBranch: config.baseBranch, credentialHome: credentials, credentialDirectories: [], branch: 'graphyard/gy-1-1' });
      assert.ok(rolePlan.deny.some(rule => rule.rule.startsWith('Edit(//')), 'the session harness carries the coordinator checkout denials');
      // A profile that would turn the confinement off never installs a harness, so it never launches.
      await assert.rejects(installWorkerHarness(config, { ...profile, agentArgs: ['--dangerously-skip-permissions'] }, 'GY-1', { epoch: 1, path: worktree, base: 'c'.repeat(40) }), /cannot launch with --dangerously-skip-permissions/);
    }
    // The other half: each confined runtime refuses the settings that would unconfine it.
    assert.match(workerConfinementRefusal({ kind: 'codex', agentArgs: ['--sandbox', 'danger-full-access'], environment: {} })!, /workspace-write/);
    assert.match(workerConfinementRefusal({ kind: 'claude', agentArgs: ['--yolo'], environment: {} })!, /--yolo/);
  } finally { await fixture.dispose(); }
});
