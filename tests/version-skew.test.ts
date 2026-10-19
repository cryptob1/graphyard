// GY-1960: version skew is named, not a 400. A CLI whose release differs from the server's reads
// the release /healthz serves once per invocation and refuses by name — both releases and
// `graphyard upgrade` — instead of sending a request the server's schemas answer as a bare 400
// Invalid input; an Invalid input answer that arrives anyway (the server moved between the read
// and the request) is reported as that same skew message. Equal versions, and a server that names
// no release at all, behave exactly as before. The same item makes the local state files
// forward-tolerant: master.json, connection.json and the daemon cursor keep fields a newer
// version wrote through read and write, so a rollback or a held-CLI snapshot neither fails nor
// silently drops what a newer version recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import { createContext, releaseSkew, versionSkewMessage } from '../src/cli/context.js';
import { loadStoredMasterConfig, masterConfigSchema } from '../src/master.js';
import { loadConnection, setupRepository } from '../src/repository-setup.js';
import { daemonStatePath, emptyDaemonState, readDaemonState, writeDaemonState } from '../src/daemon/state.js';
import { carryUndeclared } from '../src/daemon/state-cursor.js';
import { noteConfigReload } from '../src/master-daemon.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const checkout = fileURLToPath(new URL('..', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, '0');
const listen = (server: Server) => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));
const origin = (server: Server) => `http://127.0.0.1:${(server.address() as any).port}`;
/** A config whose declared fields all parse; the fixtures add the unknown fields beside it. */
const masterConfig = (credentialFile: string) => ({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
async function writeCoordinatorCredential(label: string) {
  const directory = await temporaryDirectory(`${label}-credentials`);
  const file = join(directory, 'coordinator.token');
  await writeFile(file, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  return file;
}
async function gitRepository(label: string) {
  const root = await temporaryDirectory(label);
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

test('unit:version-skew — the comparison rules: a server that names no release never refuses, a released CLI compares versions, an unreleased build compares commits', () => {
  const released = { version: '1.4.2', released: true, commit: null };
  const unreleased = { version: '0.1.0', released: false, commit: sha40('head') };
  assert.equal(releaseSkew(released, null), null);
  assert.equal(releaseSkew(released, {}), null, 'a server that names no release says nothing about skew');
  assert.equal(releaseSkew(released, { version: ' 1.4.2 ' }), null, 'the served version is read trimmed');
  assert.equal(releaseSkew(released, { version: '1.4.2', commit: sha40('other') }), null, 'equal versions behave as today, whatever the commits');
  assert.equal(releaseSkew(released, { version: '2.0.0' }), versionSkewMessage('1.4.2', '2.0.0'));
  assert.equal(releaseSkew(unreleased, { version: '0.0.0-dev', commit: sha40('head').toUpperCase() }), null, 'an unreleased build on the commit the server serves proceeds, whatever its case');
  assert.equal(releaseSkew(unreleased, { version: '0.0.0-dev', commit: sha40('deployed') }), versionSkewMessage(`commit ${sha40('head')}`, `commit ${sha40('deployed')}`));
  assert.equal(releaseSkew(unreleased, { version: '0.0.0-dev' }), versionSkewMessage('0.1.0', '0.0.0-dev'), 'with either commit unknown, versions are what is left to compare');
  assert.equal(releaseSkew(unreleased, { version: '0.1.0', commit: 'main' }), null, 'a ref is not a commit, so nothing compares and nothing refuses');
});

test('unit:version-skew — a CLI whose release differs from the server refuses naming both releases and graphyard upgrade, and sends no request', async () => {
  const cwd = await gitRepository('version-skew-refusal');
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/healthz') return response.end(JSON.stringify({ ok: true, version: '2.0.0', commit: sha40('deployed') }));
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'Not found' }));
  });
  await listen(server);
  try {
    const failure = await exec(process.execPath, [launcher, 'status', 'GY-1'], { cwd, env: { ...process.env, GRAPHYARD_VERSION: '1.4.2', GRAPHYARD_TOKEN: 'test-only', GRAPHYARD_URL: origin(server) } }).then(() => null, (error: any) => error);
    assert.match(failure?.stderr, /CLI 1\.4\.2 and server 2\.0\.0 differ: run graphyard upgrade/);
    assert.deepEqual(requests, ['/healthz'], 'the skewed invocation is refused before its first API request');
  } finally { await close(server); }
});

test('unit:version-skew — equal versions behave as today: the release is read once and the request is made', async () => {
  const cwd = await gitRepository('version-skew-equal');
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/healthz') return response.end(JSON.stringify({ ok: true, version: '2.0.0', revision: 'unknown', commit: sha40('deployed') }));
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'Not found' }));
  });
  await listen(server);
  try {
    const failure = await exec(process.execPath, [launcher, 'status', 'GY-1'], { cwd, env: { ...process.env, GRAPHYARD_VERSION: '2.0.0', GRAPHYARD_TOKEN: 'test-only', GRAPHYARD_URL: origin(server) } }).then(() => null, (error: any) => error);
    assert.match(failure?.stderr, /Unknown work item GY-1/, 'the equal-version invocation reaches the server and fails as it always did');
    assert.deepEqual(requests, ['/healthz', '/api/work/GY-1']);
  } finally { await close(server); }
});

test('unit:version-skew — an unreleased build compares commits: another commit refuses by name, the served commit proceeds', async () => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim();
  const cwd = await gitRepository('version-skew-commits');
  const requests: string[] = [];
  let servingCommit = sha40('deployed');
  const server = createServer((request, response) => {
    requests.push(request.url!);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/healthz') return response.end(JSON.stringify({ ok: true, version: '0.0.0-dev', commit: servingCommit }));
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'Not found' }));
  });
  await listen(server);
  const env = { ...process.env, GRAPHYARD_TOKEN: 'test-only', GRAPHYARD_URL: origin(server) } as Record<string, string | undefined>;
  delete env.GRAPHYARD_VERSION; // an unreleased build: no stamped release, so the commit is what it compares
  try {
    const behind = await exec(process.execPath, [launcher, 'status', 'GY-1'], { cwd, env }).then(() => null, (error: any) => error);
    assert.match(behind?.stderr, new RegExp(`CLI commit ${head} and server commit ${servingCommit} differ: run graphyard upgrade`));
    assert.deepEqual(requests, ['/healthz']);
    requests.length = 0;
    servingCommit = head;
    const current = await exec(process.execPath, [launcher, 'status', 'GY-1'], { cwd, env }).then(() => null, (error: any) => error);
    assert.match(current?.stderr, /Unknown work item GY-1/, 'a checkout at the served commit proceeds');
    assert.deepEqual(requests, ['/healthz', '/api/work/GY-1']);
  } finally { await close(server); }
});

test('unit:version-skew — an unstamped CLI on a dated checkout takes its release from the same source /healthz does, so the checkout\'s own tag with no commit proceeds and another release still refuses', async () => {
  // The dated checkout is staged with a git that answers `rev-parse HEAD` and `tag --points-at HEAD` in the
  // install root: no GRAPHYARD_VERSION is set, so the CLI's identity comes from checkoutRelease — the same
  // source /healthz serves — and a server reporting that tag with `commit: null` (no build identity) must
  // not refuse, which the package version the CLI once fell back to could not know.
  const fakeBin = await temporaryDirectory('version-skew-dated-git');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const scriptedHead = 'b'.repeat(40);
  await writeFile(join(fakeBin, 'git'), `#!/bin/sh\nif [ "$1 $2" = "rev-parse HEAD" ] && [ -z "$3" ]; then echo ${scriptedHead}; elif [ "$1" = tag ]; then echo 2026.10.17; else exec '${realGit}' "$@"; fi\n`, { mode: 0o755 });
  const cwd = await gitRepository('version-skew-dated');
  const requests: string[] = [];
  let servingVersion = '2026.10.17';
  const server = createServer((request, response) => {
    requests.push(request.url!);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/healthz') return response.end(JSON.stringify({ ok: true, version: servingVersion, commit: null }));
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'Not found' }));
  });
  await listen(server);
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, GRAPHYARD_TOKEN: 'test-only', GRAPHYARD_URL: origin(server) } as Record<string, string | undefined>;
  delete env.GRAPHYARD_VERSION; // unstamped: the checkout's own release is what both sides report
  try {
    const current = await exec(process.execPath, [launcher, 'status', 'GY-1'], { cwd, env }).then(() => null, (error: any) => error);
    assert.match(current?.stderr, /Unknown work item GY-1/, 'the checkout\'s own dated tag is the served release: the invocation proceeds with no commit named anywhere');
    assert.deepEqual(requests, ['/healthz', '/api/work/GY-1']);
    requests.length = 0;
    servingVersion = '2026.10.18';
    const behind = await exec(process.execPath, [launcher, 'status', 'GY-1'], { cwd, env }).then(() => null, (error: any) => error);
    assert.match(behind?.stderr, /CLI 2026\.10\.17 and server 2026\.10\.18 differ: run graphyard upgrade/);
    assert.deepEqual(requests, ['/healthz'], 'the skewed invocation is refused before its first API request');
  } finally { await close(server); }
});

test('unit:version-skew — an Invalid input answer from a server at a different version is reported as the skew message, and a same-version one is not', async () => {
  const savedUrl = process.env.GRAPHYARD_URL, savedToken = process.env.GRAPHYARD_TOKEN, savedVersion = process.env.GRAPHYARD_VERSION;
  let healthzReads = 0;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/healthz') {
      healthzReads++;
      // Reads 1–2: the probe at the gate cannot read a release; reads 3–4: it reads this CLI's own; reads 5–6: always its own. Each second read answers what the server serves after the 400.
      const version = healthzReads === 2 || healthzReads === 4 ? '9.9.0' : '1.0.0';
      if (healthzReads === 1) { response.statusCode = 500; return response.end('{}'); }
      return response.end(JSON.stringify({ ok: true, version, commit: sha40('deployed') }));
    }
    response.statusCode = 400;
    return response.end(JSON.stringify({ error: 'Invalid input', issues: [{ path: ['work'], message: 'older shape' }] }));
  });
  await listen(server);
  try {
    process.env.GRAPHYARD_URL = origin(server);
    process.env.GRAPHYARD_TOKEN = 'test-only';
    process.env.GRAPHYARD_VERSION = '1.0.0';
    // The gate's own read could not name a release, the request met Invalid input, and the re-read names the other version: the skew, by its name.
    const unreadable = await createContext('status', 'GY-1', [], false);
    await assert.rejects(unreadable.api('work/GY-1'), /CLI 1\.0\.0 and server 9\.9\.0 differ: run graphyard upgrade/);
    // The gate read this CLI's own release, the server moved to another before the request, and its Invalid input is reported as that move.
    const upgraded = await createContext('status', 'GY-1', [], false);
    await assert.rejects(upgraded.api('work/GY-1'), /CLI 1\.0\.0 and server 9\.9\.0 differ: run graphyard upgrade/);
    // A same-version server's Invalid input is the validation answer it always was.
    const same = await createContext('status', 'GY-1', [], false);
    await assert.rejects(same.api('work/GY-1'), (error: any) => { assert.equal(error.status, 400); assert.match(error.message, /Invalid input/); assert.doesNotMatch(error.message, /differ: run graphyard upgrade/); return true; });
  } finally {
    await close(server);
    if (savedUrl === undefined) delete process.env.GRAPHYARD_URL; else process.env.GRAPHYARD_URL = savedUrl;
    if (savedToken === undefined) delete process.env.GRAPHYARD_TOKEN; else process.env.GRAPHYARD_TOKEN = savedToken;
    if (savedVersion === undefined) delete process.env.GRAPHYARD_VERSION; else process.env.GRAPHYARD_VERSION = savedVersion;
  }
});

test('unit:state-files-forward-tolerant — master.json reads and writes an unknown top-level and nested field back unchanged', async () => {
  const root = await gitRepository('skew-master-config');
  const coordinatorToken = await writeCoordinatorCredential('skew-master-config');
  const file = join(root, '.graphyard/master.json');
  await mkdir(dirname(file), { recursive: true });
  const futureField = { addedBy: 'a newer version', at: 12 }, futureBrowser = { since: 'a newer version' };
  await writeFile(file, JSON.stringify({ ...masterConfig(coordinatorToken), futureField, browser: { profile: 'Default', futureBrowser }, run: { futureRun: true } }), { mode: 0o600 });
  const loaded = await loadStoredMasterConfig(root);
  assert.deepEqual((loaded as any).futureField, futureField, 'the unknown top-level field parses');
  assert.deepEqual((loaded.browser as any).futureBrowser, futureBrowser, 'the unknown nested field parses');
  assert.equal((loaded.run as any).futureRun, true, 'an unknown field under a prefaulted record (run) parses');
  // Writers parse before they save; the unknown fields ride the parse back into the file.
  await writeFile(file, JSON.stringify(masterConfigSchema.parse(loaded), null, 2), { mode: 0o600 });
  const reread = await loadStoredMasterConfig(root);
  assert.deepEqual((reread as any).futureField, futureField);
  assert.deepEqual((reread.browser as any).futureBrowser, futureBrowser, 'the unknown nested field survives the round-trip');
  // Declared fields still validate: a malformed one refuses the load as before.
  await writeFile(file, JSON.stringify({ ...masterConfig(coordinatorToken), browser: { profile: 42 } }), { mode: 0o600 });
  await assert.rejects(loadStoredMasterConfig(root));
});

test('unit:state-files-forward-tolerant — connection.json reads and writes an unknown field back unchanged', async () => {
  const root = await gitRepository('skew-connection');
  const file = join(root, '.graphyard/connection.json');
  await mkdir(dirname(file), { recursive: true });
  const futureConnection = { addedBy: 'a newer CLI' };
  await writeFile(file, JSON.stringify({ url: 'http://127.0.0.1:4310', cliPath: launcher, hostId: 'host-a', token: 'worker-token-'.padEnd(40, 'x'), futureConnection }), { mode: 0o600 });
  const loaded = await loadConnection(root);
  assert.ok(loaded);
  assert.equal(loaded.url, 'http://127.0.0.1:4310');
  assert.deepEqual((loaded as any).futureConnection, futureConnection, 'the unknown field parses');
  // The writer serializes the parsed object back (setupRepository does), unknown field included.
  await writeFile(file, JSON.stringify(loaded, null, 2), { mode: 0o600 });
  const reread = await loadConnection(root);
  assert.deepEqual((reread as any)!.futureConnection, futureConnection, 'the unknown field survives the round-trip');
  // A malformed declared field still refuses the read.
  await writeFile(file, JSON.stringify({ url: 'http://127.0.0.1:4310', cliPath: launcher, hostId: '' }), { mode: 0o600 });
  await assert.rejects(loadConnection(root));
});

test('unit:state-files-forward-tolerant — setupRepository keeps what a newer CLI wrote when an older CLI\'s declared-only setup rewrites the file', async () => {
  const root = await gitRepository('skew-connection-writer');
  const fetcher = async () => new Response(JSON.stringify({ actor: { id: 'worker-a', role: 'worker' } }));
  const input = { url: 'http://127.0.0.1:4310', cliPath: launcher, hostId: 'host-a', token: 'worker-token-'.padEnd(40, 'x') };
  try {
    // The newer CLI's setup declares a field this version does not know; the forward-tolerant schema keeps it and the writer writes it.
    await setupRepository(root, { ...input, futureConnection: { addedBy: 'a newer CLI' } } as any, { fetcher });
    assert.deepEqual((await loadConnection(root) as any)!.futureConnection, { addedBy: 'a newer CLI' });
    // The older CLI's rerun builds its input fresh from the fields it declares — the exact drop the item forbids.
    await setupRepository(root, { ...input }, { fetcher });
    const reread = await loadConnection(root) as any;
    assert.deepEqual(reread!.futureConnection, { addedBy: 'a newer CLI' }, 'the rerun kept the newer field the file already held');
    assert.equal(reread!.hostId, 'host-a');
    assert.equal(reread!.principal, 'worker-a', 'the rerun still writes the fields it verifies');
    // Setup rerun against a newly selected server with no credential (install.ts drops the saved one):
    // only undeclared fields ride along, so server A's token and principal never pair with server B.
    await setupRepository(root, { url: 'http://localhost:4311', cliPath: launcher, hostId: 'host-a' }, { fetcher });
    const moved = await loadConnection(root) as any;
    assert.equal(moved!.url, 'http://localhost:4311');
    assert.equal(moved!.token, undefined, 'the old server\'s token is not carried to the new one');
    assert.equal(moved!.principal, undefined, 'the old server\'s principal is not carried to the new one');
    assert.deepEqual(moved!.futureConnection, { addedBy: 'a newer CLI' }, 'the unknown field is still kept');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:state-files-forward-tolerant — the daemon cursor reads and writes unknown top-level and nested fields back unchanged', async () => {
  const root = await gitRepository('skew-cursor');
  const master = masterConfigSchema.parse(masterConfig(await writeCoordinatorCredential('skew-cursor')));
  const file = daemonStatePath(master);
  const futureTop = { addedBy: 'a newer loop' }, futureNested = { since: 'a newer loop' };
  const base = { ...emptyDaemonState(master), cycle: 7, config: { at: 'cursor-write', changed: [], refused: null, futureNested } };
  await writeFile(file, JSON.stringify({ ...base, futureTop }));
  const loaded = await readDaemonState(root, master);
  assert.equal(loaded.cycle, 7);
  assert.deepEqual((loaded as any).futureTop, futureTop, 'the unknown top-level field parses');
  assert.deepEqual((loaded.config as any).futureNested, futureNested, 'the unknown nested field parses');
  await writeDaemonState(master, loaded);
  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(written.futureTop, futureTop, 'the unknown top-level field is written back unchanged');
  assert.deepEqual(written.config.futureNested, futureNested, 'the unknown nested field is written back unchanged');
  const again = await readDaemonState(root, master);
  assert.deepEqual((again as any).futureTop, futureTop);
  // Declared fields still validate: a malformed one refuses the read as before.
  await writeFile(file, JSON.stringify({ ...base, futureTop, cycle: 'seven' }));
  await assert.rejects(readDaemonState(root, master));
});

test('unit:state-files-forward-tolerant — the loop\'s own rewrites of its release and reload records keep the unknown fields nested under them', async () => {
  const root = await gitRepository('skew-cursor-records');
  const master = masterConfigSchema.parse(masterConfig(await writeCoordinatorCredential('skew-cursor-records')));
  const file = daemonStatePath(master);
  const futureRelease = { builtBy: 'a newer loop' }, futureReload = { since: 'a newer loop' };
  await writeFile(file, JSON.stringify({ ...emptyDaemonState(master), release: { commit: sha40('a'), dirty: false, futureRelease }, config: { at: 'newer-loop', changed: [], refused: null, futureReload } }));
  const state = await readDaemonState(root, master);
  const persist = (current: typeof state) => writeDaemonState(master, current);
  // A reload replaces the record's declared reading; the unknown field rides under it.
  await noteConfigReload(state, { config: master, changed: ['maxWorkers'], at: '2030-01-01T00:00:00.000Z', refused: null }, persist);
  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(written.config.futureReload, futureReload, 'the reload record keeps the unknown field');
  assert.deepEqual(written.config.changed, ['maxWorkers'], 'the reload record names this reload');
  assert.deepEqual(carryUndeclared(state.release, { commit: sha40('b'), dirty: false }), { commit: sha40('b'), dirty: false, futureRelease }, 'a release this process loaded keeps the unknown field under its own commit');
  assert.equal(carryUndeclared(state.release, null), null, 'an unknown release clears the record as before');
});
