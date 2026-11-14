import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3317: a CLI release is a Git worktree whose .git names the source checkout of the host that
// made it. Copied to another host, Git cannot read it, and the CLI reported `unreleased unknown`, so
// the version check refused every command. The CLI now reads the commit its release recorded at
// creation; without that file it names the file and the command that records it.

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const listen = (server: Server) => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));

/** Host A: a Graphyard source checkout, a CLI release worktree of it under the install directory, and a managed checkout connected to `url`. */
async function hostA(root: string, url: string) {
  const source = join(root, 'graphyard');
  await mkdir(source, { recursive: true });
  for (const entry of ['src', 'bin', 'package.json']) await cp(join(repository, entry), join(source, entry), { recursive: true });
  git(source, 'init', '-q', '-b', 'main'); git(source, 'add', '-A'); git(source, 'commit', '-q', '-m', 'release');
  const commit = git(source, 'rev-parse', 'HEAD');
  const release = join(root, 'install', 'deploy', 'build', '.graphyard', 'cli-releases', commit);
  await mkdir(join(release, '..'), { recursive: true });
  git(source, 'worktree', 'add', '-q', '--detach', release, commit);
  await symlink(join(repository, 'node_modules'), join(release, 'node_modules'));
  await mkdir(join(release, '.graphyard'));
  await writeFile(join(release, '.graphyard', 'cli-ready'), commit);
  const checkout = join(root, 'project');
  await mkdir(join(checkout, '.graphyard'), { recursive: true });
  git(checkout, 'init', '-q', '-b', 'main');
  await writeFile(join(checkout, '.graphyard', 'connection.json'), JSON.stringify({ url, cliPath: join(release, 'bin', 'graphyard.mjs'), hostId: 'host-a', token: 't'.repeat(40) }), { mode: 0o600 });
  return { commit, releaseFrom: (base: string) => join(base, 'install', 'deploy', 'build', '.graphyard', 'cli-releases', commit) };
}

test('e2e:cli-identity-after-move — a CLI release copied to another host passes the version check, a missing identity file is named with its repair, and a really older CLI is still refused', async () => {
  let served = { version: '', commit: '' };
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/healthz') return response.end(JSON.stringify({ ok: true, ...served }));
    if (request.url === '/api/work/GY-1') return response.end(JSON.stringify({ id: 'work-1', key: 'GY-1', epoch: 1, stage: 'build' }));
    response.statusCode = 404; response.end(JSON.stringify({ error: 'Not found' }));
  });
  await listen(server);
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const base = await temporaryDirectory('cli-identity-move');
  const [a, b] = [join(base, 'host-a'), join(base, 'host b')];
  try {
    const { commit, releaseFrom } = await hostA(a, url);
    served = { version: `unreleased ${commit.slice(0, 12)}`, commit };

    // The move: install files and checkout copied to host B, hostId and cliPath re-pointed, and host A — with the source checkout the release's .git names — gone.
    await cp(join(a, 'install'), join(b, 'install'), { recursive: true, verbatimSymlinks: true });
    await cp(join(a, 'project'), join(b, 'project'), { recursive: true });
    await rm(a, { recursive: true, force: true });
    const release = releaseFrom(b), cli = join(release, 'bin', 'graphyard.mjs'), checkout = join(b, 'project');
    const connection = join(checkout, '.graphyard', 'connection.json');
    await writeFile(connection, JSON.stringify({ url, cliPath: cli, hostId: 'host-b', token: 't'.repeat(40) }));
    await chmod(connection, 0o600);
    assert.throws(() => git(release, 'rev-parse', 'HEAD'), 'Git cannot read the copied release, as on the moved host');

    const env = { ...process.env } as Record<string, string | undefined>;
    for (const name of ['GRAPHYARD_URL', 'GRAPHYARD_TOKEN', 'GRAPHYARD_TOKEN_FILE', 'GRAPHYARD_VERSION', 'GRAPHYARD_BUILD_REVISION', 'GRAPHYARD_HOST_ID', 'GRAPHYARD_CLI', 'GRAPHYARD_REPOSITORY_ROOT']) delete env[name];
    const status = () => exec(process.execPath, [cli, 'status', 'GY-1', '--json'], { cwd: checkout, env }).then(r => ({ code: 0, ...r }), (error: any) => ({ code: error.code as number, stdout: error.stdout as string, stderr: error.stderr as string }));

    // The copied checkout's plain CLI reads its release from the identity file and passes the check.
    const moved = await status();
    assert.equal(moved.code, 0, `status succeeds from the copied checkout: ${moved.stderr}`);
    assert.equal(JSON.parse(moved.stdout).key, 'GY-1');
    assert.ok(requests.includes('GET /api/work/GY-1'), 'the request reached the server');

    // Without the identity file the refusal names the file and the repair command, and that command repairs it.
    const identity = join(release, '.graphyard', 'cli-ready');
    await unlink(identity);
    const refused = await status();
    assert.notEqual(refused.code, 0, 'status is refused without any readable release');
    const repair = /repair it with: (.+ upgrade --repair-identity)$/m.exec(refused.stderr);
    assert.ok(refused.stderr.includes(identity), `the refusal names the missing file: ${refused.stderr}`);
    assert.ok(repair, `the refusal names the repair command: ${refused.stderr}`);
    await exec('sh', ['-c', repair[1]], { cwd: checkout, env });
    const repaired = await status();
    assert.equal(repaired.code, 0, `status succeeds after the repair command: ${repaired.stderr}`);

    // A CLI really older than the server is still refused.
    const newer = 'f'.repeat(40);
    served = { version: `unreleased ${newer.slice(0, 12)}`, commit: newer };
    const older = await status();
    assert.notEqual(older.code, 0, 'a CLI older than the server is refused');
    assert.match(older.stderr, new RegExp(`CLI commit ${commit} and server commit ${newer} differ: run graphyard upgrade`));
  } finally {
    await close(server);
    await rm(base, { recursive: true, force: true });
  }
});
