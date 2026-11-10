import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { runTrial, trialMerge, readOnlyPath, trialAttempts, trialTemporaryVariables, TrialReadOnlyError } from '../src/merge-writer/trial.js';
import { mergeOne, type MergePorts } from '../src/merge-writer/executor.js';
import { awaitsMerge, readOnlyTrialBlocker } from '../src/model/merge-queue.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';

// GY-3229: in a linked worktree turbo writes its cache under the MAIN checkout's .turbo/cache,
// which the trial and worker verification mount read-only (Huck's onboarding failed so). Turbo's
// cache goes under the run's own scratch instead, and a step that still hits a read-only file
// system is the host's fault: one blocker naming the path, never a rework asking for a new head.
// The case fetches pnpm and turbo through the registry on its first run.

const identity = {
  GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com',
  GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
const sharedCache = process.env.npm_config_cache || join(homedir(), '.npm');
// The trial's children run here directly, not in the trial container, with the host's npm cache.
const run: ChildRun = (command, args, { wrapper: _wrapper, ...options } = {}) =>
  defaultChildRun(command, args, { ...options, ...(options.env ? { env: { ...options.env, npm_config_cache: sharedCache } } : {}) });

const build = `import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('dist', { recursive: true });\nwriteFileSync('dist/index.txt', 'built');\n`;
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

  apps/one:
    dependencies:
      shared:
        specifier: workspace:*
        version: link:../../packages/shared

  packages/shared: {}

packages:

${['darwin-64', 'darwin-arm64', 'linux-64', 'linux-arm64', 'windows-64', 'windows-arm64'].map(platform => `  '@turbo/${platform}@2.11.10':
    resolution: {integrity: ${{
      'darwin-64': 'sha512-By4idRap5+nLnMuRzLB4qkOPRlvNdyY1ne4VJYDyUoUB11H94k7uif9mbe3JT8JSNXs1D68uMcBj6hJ/jMQRvA==',
      'darwin-arm64': 'sha512-pyEYlVcuexOPa92p0Wlwl9YT1Is5D60lxN3ItWm3g30YLvFaUq86TF4BBWg5ZAc0uMTnrOzCvuCsOBTdzUWnRQ==',
      'linux-64': 'sha512-1tYeR/IDZ5HEdsb0jNq2L2xam5nMQ+g80tlV2BZmv4OFw+pMcUM0mMmUcfc5wXPPNHVNPuDMjh9Y8G8HgXPLZA==',
      'linux-arm64': 'sha512-HuekQxvVGhUd46g1Im/DKdOtglHr4/gguZAvzEpPUgtxNkztSa8lWhQEGQ+EmPQ0n7w19qjThFU+OfEEd0uvlw==',
      'windows-64': 'sha512-UJOP3BkbreY3/JlMgJR6ZiimxYIBn+c+B4tnBIxD0E9c3Estmk+XoVNVBNBottZLNRXe3/ScgOU4+/k8tIWysg==',
      'windows-arm64': 'sha512-xOkEjF3ws/b/YNlc+bvJHMYBn+vL+QbEISZFVi0qS+ImmhA1X3/gmNmBrjjIG3dg6aeN+n6gQitzSkXQ286qJQ==',
    }[platform]}}
    cpu: [${platform.endsWith('arm64') ? 'arm64' : 'x64'}]
    os: [${platform.startsWith('darwin') ? 'darwin' : platform.startsWith('linux') ? 'android, linux' : 'win32'}]
`).join('\n')}
  turbo@2.11.10:
    resolution: {integrity: sha512-3GJYwig8ygEI89oaOZdduJX8/aw6O9eRPYHoIt6T3FZl9hkKjiyIspufJoVgqXihPoJu8M5CSV0DlZvzfohBCw==}
    hasBin: true

snapshots:

${['darwin-64', 'darwin-arm64', 'linux-64', 'linux-arm64', 'windows-64', 'windows-arm64'].map(platform => `  '@turbo/${platform}@2.11.10':\n    optional: true\n`).join('\n')}
  turbo@2.11.10:
    optionalDependencies:
${['darwin-64', 'darwin-arm64', 'linux-64', 'linux-arm64', 'windows-64', 'windows-arm64'].map(platform => `      '@turbo/${platform}': 2.11.10`).join('\n')}
`;
/** A pnpm + turbo workspace: one app building after the shared package it depends on. */
const turboWorkspace: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'workspace', private: true, packageManager: 'pnpm@10.34.9', scripts: { test: 'node -e 0' }, devDependencies: { turbo: '2.11.10' } }, null, 2),
  'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
  'pnpm-lock.yaml': lockfile,
  'turbo.json': JSON.stringify({ tasks: { build: { dependsOn: ['^build'], outputs: ['dist/**'] } } }),
  '.gitignore': 'node_modules\ndist\n.turbo\n',
  'apps/one/package.json': JSON.stringify({ name: 'one', version: '1.0.0', private: true, scripts: { build: 'node build.mjs' }, dependencies: { shared: 'workspace:*' } }),
  'apps/one/build.mjs': build,
  'packages/shared/package.json': JSON.stringify({ name: 'shared', version: '1.0.0', private: true, scripts: { build: 'node build.mjs' } }),
  'packages/shared/build.mjs': build,
  'e2e/cases/fixture.json': JSON.stringify({ id: 'fixture', title: 'Fixture', target: 'any', required: false, steps: [{ kind: 'command', name: 'builds', run: 'node --eval 0' }] }),
};
const write = async (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
};
/** A repository at `root` whose base holds the workspace and whose head applies `change`; answers both commits. */
async function repository(root: string, change: Record<string, string>) {
  git(root, 'init', '-q', '-b', 'main');
  await write(root, turboWorkspace);
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '-b', 'graphyard/gy-1-1');
  await write(root, change);
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'change');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '--detach', base);
  return { base, head };
}
const trialOf = async (root: string, base: string, head: string, retries = 0) => {
  const merged = await trialMerge(async args => git(root, ...args), { head, baseTip: base });
  assert.ok('mergeSha' in merged);
  return runTrial({
    root, base: await temporaryDirectory('turbo-writable-cache-root', tmpdir()), mergeSha: merged.mergeSha, baseTip: base,
    changedFiles: git(root, 'diff', '--name-only', base, head).split('\n').filter(Boolean),
    timeoutMs: 300_000, environment: { PATH: process.env.PATH! }, run, retries,
  });
};

test('integration:turbo-writable-cache — a turbo workspace whose checkout root is read-only builds in the merge trial with turbo\'s cache under the run\'s scratch, leaving no .turbo in the checkout', async () => {
  // Worker verification and the local complete rerun take the same variables for their scratch.
  assert.equal(trialTemporaryVariables('/scratch/t').TURBO_CACHE_DIR, '/scratch/t/turbo');
  const root = await temporaryDirectory('turbo-writable-cache', tmpdir());
  const { base, head } = await repository(root, { 'apps/one/build.mjs': `// changed\n${build}` });
  // The checkout root is read-only, as the trial container mounts it; its .git stays writable for the trial's worktree.
  await chmod(root, 0o555);
  try {
    const trial = await trialOf(root, base, head);
    assert.equal(trial.build, 'pass', trial.logTail);
    assert.match(trial.logTail, /turbo run build/);
    assert.equal(existsSync(join(root, '.turbo')), false, 'turbo wrote no cache into the read-only checkout');
  } finally { await chmod(root, 0o755); }
});

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'worker', role: 'worker' };
const coordinator: Principal = { id: 'coordinator', role: 'coordinator' };

test('integration:turbo-writable-cache — a build step failing with \'Read-only file system\' records one blocker naming the path and does not send the item back for a new head', { timeout: 600_000 }, async () => {
  // Turbo's own report wraps the path across lines; the blocker names it whole.
  assert.equal(readOnlyPath('  x IO error: failed to create directory `/home/vish/code/huck-\n  | graphyard/.turbo/cache`\n  `-> Read-only file system (os error 30)\n'), '/home/vish/code/huck-graphyard/.turbo/cache');
  const root = await temporaryDirectory('turbo-read-only', tmpdir());
  const path = '/srv/checkout/.turbo/cache';
  const { base, head } = await repository(root, { 'apps/one/build.mjs': `console.error("Error: EROFS: read-only file system, mkdir '${path}'");\nprocess.exit(1);\n` });
  let store: Store | undefined, http: ReturnType<typeof server> | undefined;
  try {
    store = await withDatabase('turbo-writable-cache'); await store.init();
    const engine = new Engine(store, 120, 'owner/proofs');
    engine.gitRunner = gitRunnerFor(root); engine.baseBranch = 'main';
    const token = 'fixture-coordinator-' + 'x'.repeat(32);
    http = server(engine, [{ ...coordinator, token }]);
    await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    let work = await engine.execute(operator, 'create', null, { type: 'chore', title: 'turbo app', criteria: [{ id: 'AC-1', text: 'Builds', proofs: ['unit:builds', 'e2e:fixture'] }] }, randomUUID());
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
    await engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'fixture', path: root, branch: 'graphyard/gy-1-1' }, randomUUID());
    work = await engine.execute(worker, 'submit', work.id, { epoch: work.epoch, head }, randomUUID());
    let trials = 0;
    const ports: MergePorts = {
      baseBranch: 'main', now: Date.now,
      fetch: async () => base,
      merge: async headSha => {
        const merged = await trialMerge(async args => git(root, ...args), { head: headSha, baseTip: base });
        assert.ok('mergeSha' in merged);
        return { mergeSha: merged.mergeSha, files: git(root, 'diff', '--name-only', base, head).split('\n').filter(Boolean) };
      },
      trial: async () => { trials++; return trialOf(root, base, head, 1) as never; },
      push: async () => { throw new Error('a read-only build never pushes'); },
      holds: async () => false,
      record: async (item, event) => {
        const answer = await fetch(`${url}/api/work/${item.id}/merge-record`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(event) });
        assert.equal(answer.status, 200, await answer.text());
      },
    };
    const failed = await mergeOne(ports, work).then(() => null, (error: unknown) => error);
    assert.ok(failed instanceof TrialReadOnlyError, String(failed));
    assert.equal(failed.path, path);
    assert.equal(trials, 1);
    let current: Work = (await store.workDocument(work.id))!;
    assert.ok(current.blocker?.startsWith(readOnlyTrialBlocker), String(current.blocker));
    assert.ok(current.blocker!.includes(path), current.blocker!);
    assert.equal(current.reworkRequested, false, 'no new head is asked for');
    assert.equal(awaitsMerge(current, { [current.key]: current.mergeLedger! }, Date.now()), false, 'the queue holds the head while the blocker stands');
    // A repeated record keeps the one blocker.
    const blocker = current.blocker;
    await ports.record(current, { kind: 'trial', head, baseTip: base, mergeSha: current.mergeLedger!.mergeSha!, outcome: 'host-failure', phase: 'build', reason: failed.message.slice(0, 900), phases: { install: 0, build: 0, selection: 0, tests: 0 }, attempts: trialAttempts(failed), durationMs: 0 });
    current = (await store.workDocument(work.id))!;
    assert.equal(current.blocker, blocker);
    assert.equal(current.reworkRequested, false);
  } finally {
    if (http) await new Promise<void>(resolve => http!.close(() => resolve()));
    if (store) await store.close();
  }
});
