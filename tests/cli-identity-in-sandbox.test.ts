import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { liveEffects, upgradePlan } from '../src/cli/upgrade.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3569: an in-place upgrade moved a CLI release named for an old commit to a new one, but its
// commit stamp kept the old commit. A worker's sandbox cannot run git on the release, so its CLI
// read the stale stamp and refused every command with "CLI commit X differs from server Y".

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const listen = (server: Server) => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));

test('integration:cli-identity-in-sandbox — after an in-place upgrade, a CLI that cannot run git reports the checked-out commit and status and complete meet no version refusal', async () => {
  let served = { version: '', commit: '' };
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/healthz') return response.end(JSON.stringify({ ok: true, ...served }));
    if (request.url === '/api/work/GY-1') return response.end(JSON.stringify({ id: 'work-1', key: 'GY-1', epoch: 1, stage: 'build' }));
    response.statusCode = 404; response.end(JSON.stringify({ error: 'Not found' }));
  });
  await listen(server);
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const base = await temporaryDirectory('cli-identity-sandbox');
  try {
    // A Graphyard source checkout and a release worktree named for, and stamped with, its old commit.
    const source = join(base, 'graphyard');
    await mkdir(source, { recursive: true });
    for (const entry of ['src', 'bin', 'package.json']) await cp(join(repository, entry), join(source, entry), { recursive: true });
    git(source, 'init', '-q', '-b', 'main'); git(source, 'add', '-A'); git(source, 'commit', '-q', '-m', 'old');
    const old = git(source, 'rev-parse', 'HEAD');
    const release = join(base, 'install', 'deploy', 'build', '.graphyard', 'cli-releases', old);
    await mkdir(dirname(release), { recursive: true });
    git(source, 'worktree', 'add', '-q', '--detach', release, old);
    await symlink(join(repository, 'node_modules'), join(release, 'node_modules'));
    await mkdir(join(release, '.graphyard'));
    await writeFile(join(release, '.graphyard', 'cli-ready'), old);
    await writeFile(join(source, 'NEW'), 'new'); git(source, 'add', '-A'); git(source, 'commit', '-q', '-m', 'new');
    const current = git(source, 'rev-parse', 'HEAD');

    // The upgrade's own checkout step moves the release in place to the new commit.
    const plan = upgradePlan({ cliRoot: release, repoRoot: base, current: { version: `unreleased ${old.slice(0, 12)}`, revision: old, released: false }, target: { version: `unreleased ${current.slice(0, 12)}`, revision: current, schema: null }, databaseSchema: null, install: null, url, cliChanges: [], backupFile: join(base, 'backup.json') } as any);
    await liveEffects({ cliRoot: release, repoRoot: base } as any, join(base, 'upgrade.json')).run(plan.steps.find(step => step.id === 'checkout')!);
    assert.equal(git(release, 'rev-parse', 'HEAD'), current);
    assert.equal((await readFile(join(release, '.graphyard', 'cli-ready'), 'utf8')).trim(), current, 'the checkout move writes its commit into the release');

    // A worker sandbox mounts the release but not the source checkout its .git names, so git cannot read it there.
    await rename(source, `${source}-unmounted`);
    assert.throws(() => git(release, 'rev-parse', 'HEAD'), 'git cannot read the release, as inside a worker sandbox');

    // A managed checkout connected through the release.
    const checkout = join(base, 'project');
    await mkdir(join(checkout, '.graphyard'), { recursive: true });
    git(checkout, 'init', '-q', '-b', 'main');
    await writeFile(join(checkout, '.graphyard', 'connection.json'), JSON.stringify({ url, cliPath: join(release, 'bin', 'graphyard.mjs'), hostId: 'host-a', token: 't'.repeat(40) }), { mode: 0o600 });
    const env = { ...process.env, GRAPHYARD_BUILD_REVISION: old } as Record<string, string | undefined>;
    for (const name of ['GRAPHYARD_URL', 'GRAPHYARD_TOKEN', 'GRAPHYARD_TOKEN_FILE', 'GRAPHYARD_VERSION', 'GRAPHYARD_HOST_ID', 'GRAPHYARD_CLI', 'GRAPHYARD_REPOSITORY_ROOT']) delete env[name];
    const cli = (...args: string[]) => exec(process.execPath, [join(release, 'bin', 'graphyard.mjs'), ...args], { cwd: checkout, env }).then(r => ({ code: 0, ...r }), (error: any) => ({ code: error.code as number, stdout: String(error.stdout), stderr: String(error.stderr) }));

    served = { version: `unreleased ${current.slice(0, 12)}`, commit: current };
    const status = await cli('status', 'GY-1', '--json');
    assert.equal(status.code, 0, `status succeeds inside the sandbox after the upgrade: ${status.stderr}`);
    assert.equal(JSON.parse(status.stdout).key, 'GY-1');
    const complete = await cli('complete', 'GY-1', '1', '--head');
    assert.doesNotMatch(complete.stderr, /differ: run graphyard upgrade/, `complete meets no version refusal: ${complete.stderr}`);
  } finally {
    await close(server);
    await rm(base, { recursive: true, force: true });
  }
});
