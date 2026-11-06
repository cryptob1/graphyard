import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareInstall, installRequestFromArgs } from '../src/install/index.js';
import { writeInstallRecord } from '../src/install/secrets.js';
import { publishOnboarding, runUp, upRequestFromArgs, upUsage, type UpDependencies } from '../src/up.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

test('unit:tests/up-base-branch.test.ts — up passes --base-branch to install; reruns retain it and onboarding uses its tip', async () => {
  const root = await temporaryDirectory('up-base-branch');
  const configHome = await temporaryDirectory('up-base-branch-config');
  const origin = await temporaryDirectory('up-base-branch-origin');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--bare', '-q', '-b', 'main', origin);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('remote', 'add', 'origin', origin);
  await writeFile(join(root, 'README.md'), 'main\n');
  git('add', '.');
  git('commit', '-qm', 'main');
  git('push', '-q', 'origin', 'main');
  git('checkout', '-qb', 'release/test');
  await writeFile(join(root, 'release.txt'), 'release only\n');
  git('add', '.');
  git('commit', '-qm', 'release');
  git('push', '-q', 'origin', 'release/test');
  const baseTip = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');

  const request = upRequestFromArgs(['--repo', 'owner/project', '--base-branch', 'release/test']);
  assert.equal(request.baseBranch, 'release/test');
  assert.match(upUsage, /--base-branch NAME/);
  const calls: string[][] = [];
  const dependencies: UpDependencies = {
    root, emit: () => {}, now: Date.now, sleep: async () => {},
    serverUrl: async () => null, masterToken: async () => null, status: async () => null,
    publishOnboarding: async () => null,
    gh: async () => ({ code: 0, stdout: '{}' }), git: async () => ({ code: 0, stdout: '' }),
    async cli(args) {
      calls.push(args);
      if (args[0] !== 'install') return { code: 1, stdout: '', stderr: 'stop after install' };
      const { request: inputs } = installRequestFromArgs(args.slice(1));
      const session = await prepareInstall(root, inputs, { configHome }, args.includes('--plan') ? 'plan' : 'apply');
      assert.equal(session.inputs.baseBranch, 'release/test');
      if (args.includes('--apply')) {
        await mkdir(session.directory, { recursive: true });
        await writeInstallRecord(session.directory, {
          version: 1, installId: session.installId, repository: request.repository, provider: 'compose',
          baseBranch: session.inputs.baseBranch, createdAt: '2026-11-06', updatedAt: '2026-11-06',
        }, session.vault);
      }
      return { code: 0, stdout: '{}' };
    },
  };
  const result = await runUp(request, dependencies);
  for (const mode of ['--plan', '--apply']) {
    const args = calls.find(args => args[0] === 'install' && args.includes(mode));
    assert.ok(args, `${mode} ran: ${result.next}`);
    assert.equal(args[args.indexOf('--base-branch') + 1], 'release/test');
  }
  const rerun = upRequestFromArgs(['--repo', 'owner/project']);
  assert.equal(rerun.baseBranch, undefined);
  for (const mode of ['plan', 'apply'] as const) {
    const session = await prepareInstall(root, { repository: rerun.repository, provider: 'compose' }, { configHome }, mode);
    assert.equal(session.inputs.baseBranch, 'release/test', `${mode} keeps the recorded branch`);
  }
  const override = await prepareInstall(root, { repository: request.repository, provider: 'compose', baseBranch: 'main' }, { configHome }, 'plan');
  assert.equal(override.inputs.baseBranch, 'main', 'an explicit choice overrides the record');

  await writeFile(join(root, 'AGENTS.md'), '# Coordination\n');
  await writeFile(join(root, '.gitignore'), '.graphyard/\n');
  await writeFile(join(root, 'graphyard.json'), '{}\n');
  const previous = process.env.GRAPHYARD_CONFIG_HOME;
  process.env.GRAPHYARD_CONFIG_HOME = configHome;
  try {
    const run = (program: string, args: string[], env?: Record<string, string>) => {
      assert.equal(program, 'git', 'the installed branch needs no GitHub default-branch lookup');
      return execFileSync(program, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    };
    const published = await publishOnboarding(root, request.repository, run);
    assert.ok(published);
    assert.equal(git('rev-parse', `${published.commit}^`), baseTip);
    assert.equal(git('show', `${published.commit}:release.txt`), 'release only');
    assert.deepEqual(await publishOnboarding(root, request.repository, run), published, 'rerun publishes the same head');
  } finally {
    if (previous === undefined) delete process.env.GRAPHYARD_CONFIG_HOME;
    else process.env.GRAPHYARD_CONFIG_HOME = previous;
  }
});
