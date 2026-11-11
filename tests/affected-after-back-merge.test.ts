import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { runTrial, trialMerge } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3250: a candidate that changes only pm and has back-merged a main commit touching sites
// (already on the trial base) builds pm and its dependents, never sites, and the trial log names
// each selected package and why. Huck's PM-only item built @hello-huck/sites so. The case fetches
// pnpm and turbo through the registry on its first run.

const identity = {
  GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com',
  GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
const sharedCache = process.env.npm_config_cache || join(homedir(), '.npm');
const run: ChildRun = (command, args, { wrapper: _wrapper, ...options } = {}) =>
  defaultChildRun(command, args, { ...options, ...(options.env ? { env: { ...options.env, npm_config_cache: sharedCache } } : {}) });

const platforms = ['darwin-64', 'darwin-arm64', 'linux-64', 'linux-arm64', 'windows-64', 'windows-arm64'];
const integrity: Record<string, string> = {
  'darwin-64': 'sha512-By4idRap5+nLnMuRzLB4qkOPRlvNdyY1ne4VJYDyUoUB11H94k7uif9mbe3JT8JSNXs1D68uMcBj6hJ/jMQRvA==',
  'darwin-arm64': 'sha512-pyEYlVcuexOPa92p0Wlwl9YT1Is5D60lxN3ItWm3g30YLvFaUq86TF4BBWg5ZAc0uMTnrOzCvuCsOBTdzUWnRQ==',
  'linux-64': 'sha512-1tYeR/IDZ5HEdsb0jNq2L2xam5nMQ+g80tlV2BZmv4OFw+pMcUM0mMmUcfc5wXPPNHVNPuDMjh9Y8G8HgXPLZA==',
  'linux-arm64': 'sha512-HuekQxvVGhUd46g1Im/DKdOtglHr4/gguZAvzEpPUgtxNkztSa8lWhQEGQ+EmPQ0n7w19qjThFU+OfEEd0uvlw==',
  'windows-64': 'sha512-UJOP3BkbreY3/JlMgJR6ZiimxYIBn+c+B4tnBIxD0E9c3Estmk+XoVNVBNBottZLNRXe3/ScgOU4+/k8tIWysg==',
  'windows-arm64': 'sha512-xOkEjF3ws/b/YNlc+bvJHMYBn+vL+QbEISZFVi0qS+ImmhA1X3/gmNmBrjjIG3dg6aeN+n6gQitzSkXQ286qJQ==',
};
const lockfile = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    devDependencies:
      turbo:
        specifier: 2.11.10
        version: 2.11.10

  apps/console:
    dependencies:
      pm:
        specifier: workspace:*
        version: link:../../packages/pm

  packages/pm: {}

  packages/sites: {}

packages:

${platforms.map(platform => `  '@turbo/${platform}@2.11.10':
    resolution: {integrity: ${integrity[platform]}}
    cpu: [${platform.endsWith('arm64') ? 'arm64' : 'x64'}]
    os: [${platform.startsWith('darwin') ? 'darwin' : platform.startsWith('linux') ? 'android, linux' : 'win32'}]
`).join('\n')}
  turbo@2.11.10:
    resolution: {integrity: sha512-3GJYwig8ygEI89oaOZdduJX8/aw6O9eRPYHoIt6T3FZl9hkKjiyIspufJoVgqXihPoJu8M5CSV0DlZvzfohBCw==}
    hasBin: true

snapshots:

${platforms.map(platform => `  '@turbo/${platform}@2.11.10':\n    optional: true\n`).join('\n')}
  turbo@2.11.10:
    optionalDependencies:
${platforms.map(platform => `      '@turbo/${platform}': 2.11.10`).join('\n')}
`;
const build = (label: string) => `import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('dist', { recursive: true });\nwriteFileSync('dist/index.txt', ${JSON.stringify(label)});\n`;
const pkg = (name: string, dependencies?: Record<string, string>) => JSON.stringify({ name, version: '1.0.0', private: true, scripts: { build: 'node build.mjs' }, ...(dependencies ? { dependencies } : {}) });
/** A pnpm + turbo workspace: pm, sites, and console depending on pm. */
const workspace: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'workspace', private: true, packageManager: 'pnpm@10.34.9', scripts: { test: 'node -e 0' }, devDependencies: { turbo: '2.11.10' } }, null, 2),
  'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
  'pnpm-lock.yaml': lockfile,
  'turbo.json': JSON.stringify({ tasks: { build: { dependsOn: ['^build'], outputs: ['dist/**'] } } }),
  '.gitignore': 'node_modules\ndist\n.turbo\n',
  'packages/pm/package.json': pkg('pm'),
  'packages/pm/build.mjs': build('pm'),
  'packages/sites/package.json': pkg('sites'),
  'packages/sites/build.mjs': build('sites'),
  'apps/console/package.json': pkg('console', { pm: 'workspace:*' }),
  'apps/console/build.mjs': build('console'),
};
const write = async (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
};
const commit = async (root: string, files: Record<string, string>, message: string) => {
  await write(root, files);
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
};

test('integration:affected-after-back-merge — a candidate changing only pm that back-merged a main commit touching sites builds pm and its dependent console, never sites, and the log names each selected package and why', async () => {
  const root = await temporaryDirectory('affected-after-back-merge', tmpdir());
  git(root, 'init', '-q', '-b', 'main');
  await commit(root, workspace, 'base');
  git(root, 'checkout', '-q', '-b', 'graphyard/gy-1-1');
  await commit(root, { 'packages/pm/build.mjs': `// pm change\n${build('pm')}` }, 'pm change');
  git(root, 'checkout', '-q', 'main');
  // main moves on with a sites change; the candidate back-merges it.
  const baseTip = await commit(root, { 'packages/sites/build.mjs': `// sites change\n${build('sites')}` }, 'sites change');
  git(root, 'checkout', '-q', 'graphyard/gy-1-1');
  git(root, 'merge', '-q', '--no-ff', '--no-edit', 'main');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '--detach', baseTip);

  const merged = await trialMerge(async args => git(root, ...args), { head, baseTip });
  assert.ok('mergeSha' in merged);
  const trial = await runTrial({
    root, base: await temporaryDirectory('affected-after-back-merge-root', tmpdir()), mergeSha: merged.mergeSha, baseTip,
    changedFiles: git(root, 'diff', '--name-only', baseTip, merged.mergeSha).split('\n').filter(Boolean),
    timeoutMs: 300_000, environment: { PATH: process.env.PATH! }, run, retries: 0,
  });
  assert.equal(trial.build, 'pass', trial.logTail);
  const built = ['pm', 'sites', 'console'].filter(name => new RegExp(`^${name}:build: `, 'm').test(trial.logTail));
  assert.deepEqual(built, ['pm', 'console'], trial.logTail);
  assert.match(trial.logTail, /^affected packages: pm \(changed\), console \(depends on pm\)$/m, trial.logTail);
});
