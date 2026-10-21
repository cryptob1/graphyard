import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { checkoutRelease, cliRelease, defaultImageFor, packageVersion, releaseInfo, stampedRelease, type Release } from '../src/release.js';
import { renderVersion, versionReport } from '../src/cli/version.js';
import { DEFAULT_IMAGE } from '../src/install/adapters.js';
import { healthRoutes } from '../src/server/routes/health.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1959: `graphyard version` names the CLI's release (the dated tag on its commit, else
// `unreleased <sha>`) and the connected server's, which /healthz reports the same way.
const launcher = resolve('bin/graphyard.mjs');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

async function repository() {
  const cwd = await temporaryDirectory('version-command');
  git(cwd, 'init', '--quiet');
  await writeFile(join(cwd, 'a'), '1'); git(cwd, 'add', 'a'); git(cwd, 'commit', '--quiet', '-m', 'one');
  return cwd;
}

test('unit:version-command — a checkout is the latest dated tag on its HEAD, else unreleased with its short sha', async () => {
  const cwd = await repository();
  const first = git(cwd, 'rev-parse', 'HEAD');
  assert.deepEqual(checkoutRelease(cwd), { version: `unreleased ${first.slice(0, 12)}`, revision: first, released: false });
  git(cwd, 'tag', 'stable'); git(cwd, 'tag', 'rc/1');
  assert.equal(checkoutRelease(cwd).released, false, 'only a dated tag is a release');
  git(cwd, 'tag', '2026.10.17'); git(cwd, 'tag', '-a', '2026.10.17.1', '-m', 'second');
  assert.deepEqual(checkoutRelease(cwd), { version: '2026.10.17.1', revision: first, released: true });
  await writeFile(join(cwd, 'a'), '2'); git(cwd, 'commit', '--quiet', '-am', 'two');
  const second = git(cwd, 'rev-parse', 'HEAD');
  assert.equal(checkoutRelease(cwd).version, `unreleased ${second.slice(0, 12)}`, 'a commit after a release is not that release');
  const outside = await temporaryDirectory('version-no-git');
  assert.deepEqual(checkoutRelease(outside, 'f'.repeat(40)), { version: `unreleased ${'f'.repeat(12)}`, revision: 'f'.repeat(40), released: false });
});

test('unit:version-command — install defaults take the image of the CLI\'s release, else the package.json version release.yml publishes', () => {
  assert.equal(defaultImageFor({ version: '2026.10.17.2', released: true }), 'ghcr.io/cryptob1/graphyard:2026.10.17.2');
  assert.equal(defaultImageFor({ version: 'unreleased abc', released: false }), `ghcr.io/cryptob1/graphyard:${packageVersion}`);
  const own = checkoutRelease(resolve('.'));
  assert.equal(DEFAULT_IMAGE, defaultImageFor(cliRelease()));
  if (!process.env.GRAPHYARD_VERSION) assert.equal(DEFAULT_IMAGE, defaultImageFor(own));
});

test('unit:version-command — /healthz reports the version field the CLI reports, and a stamped image its date version', async () => {
  const saved = { version: process.env.GRAPHYARD_VERSION, revision: process.env.GRAPHYARD_BUILD_REVISION };
  try {
    delete process.env.GRAPHYARD_VERSION;
    const own = checkoutRelease(resolve('.'));
    assert.deepEqual(releaseInfo(), { version: own.version, revision: process.env.GRAPHYARD_BUILD_REVISION || 'unknown' }, 'a checkout claims no served revision it was not stamped with');
    let answered: any;
    const client = { query: async () => ({}), release: () => {} };
    const services = { engine: { store: { pool: { waitingCount: 0, idleCount: 1, connect: async () => client } } }, github: null, build: { commit: 'c'.repeat(40), protocol: 1 }, readiness: false } as any;
    await healthRoutes.routes[0].handle({ services, url: new URL('http://plane/healthz?ready'), send: (_status: number, body: unknown) => { answered = body; return body; } } as any, []);
    assert.equal(answered.version, own.version);
    process.env.GRAPHYARD_VERSION = '2026.10.17'; process.env.GRAPHYARD_BUILD_REVISION = 'a'.repeat(40);
    assert.deepEqual(releaseInfo(), { version: '2026.10.17', revision: 'a'.repeat(40) });
    process.env.GRAPHYARD_VERSION = 'unreleased abcdef123456';
    assert.equal(releaseInfo().version, 'unreleased abcdef123456', 'a candidate image under test reports itself unreleased');
    process.env.GRAPHYARD_VERSION = '0.0.0-dev';
    assert.equal(releaseInfo().version, own.version, 'the Dockerfile\'s default stamp is no release');
    process.env.GRAPHYARD_VERSION = '0.1.0'; process.env.GRAPHYARD_BUILD_REVISION = 'e'.repeat(40);
    assert.deepEqual(releaseInfo(), { version: '0.1.0', revision: 'e'.repeat(40) }, 'release.yml\'s vX.Y.Z image reports the X.Y.Z it was stamped with');
  } finally {
    for (const [name, value] of [['GRAPHYARD_VERSION', saved.version], ['GRAPHYARD_BUILD_REVISION', saved.revision]] as const) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test('unit:version-command — an image without .git is the release its build stamped, for the command, /healthz and the install default alike', () => {
  const noRevision = () => { throw new Error('a stamped revision needs no checkout'); };
  const dated = stampedRelease({ GRAPHYARD_VERSION: '2026.10.17.1', GRAPHYARD_BUILD_REVISION: 'a'.repeat(40) }, noRevision);
  assert.deepEqual(dated, { version: '2026.10.17.1', revision: 'a'.repeat(40), released: true });
  assert.equal(defaultImageFor(dated!), 'ghcr.io/cryptob1/graphyard:2026.10.17.1');
  const legacy = stampedRelease({ GRAPHYARD_VERSION: '0.1.0', GRAPHYARD_BUILD_REVISION: 'b'.repeat(40) }, noRevision);
  assert.deepEqual(legacy, { version: '0.1.0', revision: 'b'.repeat(40), released: true });
  const candidate = stampedRelease({ GRAPHYARD_VERSION: 'unreleased abcdef123456', GRAPHYARD_BUILD_REVISION: 'c'.repeat(40) }, noRevision);
  assert.equal(candidate?.released, false);
  assert.equal(defaultImageFor(candidate!), `ghcr.io/cryptob1/graphyard:${packageVersion}`);
  for (const unstamped of [{}, { GRAPHYARD_VERSION: '' }, { GRAPHYARD_VERSION: '0.0.0-dev' }, { GRAPHYARD_VERSION: 'stable' }]) assert.equal(stampedRelease(unstamped, noRevision), null);
  assert.equal(stampedRelease({ GRAPHYARD_VERSION: '2026.10.17' }, () => 'd'.repeat(40))?.revision, 'd'.repeat(40), 'without a stamped revision the checkout\'s names it');
  const saved = { version: process.env.GRAPHYARD_VERSION, revision: process.env.GRAPHYARD_BUILD_REVISION };
  try {
    process.env.GRAPHYARD_VERSION = '2026.10.17.1'; process.env.GRAPHYARD_BUILD_REVISION = 'a'.repeat(40);
    assert.deepEqual(cliRelease(), dated, 'graphyard version reports the stamp');
    assert.deepEqual(releaseInfo(), { version: dated!.version, revision: dated!.revision }, '/healthz reports the same release');
  } finally {
    for (const [name, value] of [['GRAPHYARD_VERSION', saved.version], ['GRAPHYARD_BUILD_REVISION', saved.revision]] as const) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test('unit:version-command — the report names the CLI release and commit, and the server\'s from /healthz when connected', async () => {
  const release: Release = { version: '2026.10.17', revision: 'b'.repeat(40), released: true };
  assert.deepEqual(await versionReport(release, null), { cli: { version: '2026.10.17', commit: 'b'.repeat(40) }, server: null });
  assert.match(renderVersion(await versionReport(release, null)), /^cli {5}2026\.10\.17 \(commit b{40}\)\nserver  not connected/);
  const asked: string[] = [];
  const fake = (async (url: string) => { asked.push(url); return new Response(JSON.stringify({ ok: true, version: '2026.10.16.1', revision: 'unknown', commit: 'c'.repeat(40) })); }) as unknown as typeof fetch;
  const connected = await versionReport(release, 'https://plane.example', fake);
  assert.deepEqual(asked, ['https://plane.example/healthz']);
  assert.deepEqual(connected.server, { url: 'https://plane.example', version: '2026.10.16.1', commit: 'c'.repeat(40) });
  assert.match(renderVersion(connected), /\nserver  2026\.10\.16\.1 \(commit c{40}\) at https:\/\/plane\.example\nnote    the CLI and the server run different releases$/);
  const down = await versionReport(release, 'https://plane.example', (async () => { throw new Error('connection refused'); }) as unknown as typeof fetch);
  assert.equal(down.server?.error, 'connection refused');
  assert.match(renderVersion(down), /server  https:\/\/plane\.example unreachable: connection refused/);
});

test('unit:version-command — graphyard version prints the CLI release and the connected server\'s', async () => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(request.url === '/healthz' ? JSON.stringify({ ok: true, version: '2026.10.17', commit: 'd'.repeat(40) }) : '{}');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cwd = await temporaryDirectory('version-cli');
    const own = checkoutRelease(resolve('.'));
    const env = { ...process.env, GRAPHYARD_URL: url, GRAPHYARD_TOKEN: '' };
    const { stdout } = await promisify(execFile)(process.execPath, [launcher, 'version', '--json'], { cwd, env });
    assert.deepEqual(JSON.parse(stdout), { cli: { version: own.version, commit: own.revision }, server: { url, version: '2026.10.17', commit: 'd'.repeat(40) } });
    const plain = await promisify(execFile)(process.execPath, [launcher, 'version'], { cwd, env });
    assert.equal(plain.stdout, `cli     ${own.version} (commit ${own.revision})\nserver  2026.10.17 (commit ${'d'.repeat(40)}) at ${url}\n${own.version === '2026.10.17' ? '' : 'note    the CLI and the server run different releases\n'}`);
    const stamped = await promisify(execFile)(process.execPath, [launcher, 'version', '--json'], { cwd, env: { ...env, GRAPHYARD_VERSION: '2026.10.17', GRAPHYARD_BUILD_REVISION: 'd'.repeat(40) } });
    assert.deepEqual(JSON.parse(stamped.stdout).cli, { version: '2026.10.17', commit: 'd'.repeat(40) }, 'a stamped image\'s command reports its stamp, as its /healthz does');
    const help = await promisify(execFile)(process.execPath, [launcher, 'help'], { cwd, env });
    assert.match(help.stdout, /\n {2}version \[--json\]/);
  } finally { server.close(); }
});
