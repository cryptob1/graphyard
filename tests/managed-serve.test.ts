import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { masterStatusReport } from '../src/cli/master-status.js';
import { defaultChildRun } from '../src/child-runner.js';
import { managedServePorts } from '../src/cli/upgrade.js';
import { readServeRecord, servedApplication, serveOnce, serveRecordPath } from '../src/serve-app.js';
import { setupFromZeroChecks, setupLine, type SetupCheck } from '../src/setup-from-zero.js';
import type { MasterConfig } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2976, GY-3201: a managed repository whose graphyard.json declares a node application has its
// main installed at the root, built in the application's directory and started there on a loopback
// port (PORT) after every merge, and master status, the dashboard and doctor report it. A
// repository that declares none reports exactly what it reported before.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const freePort = () => new Promise<number>((accept, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => accept(port)); });
});
/** Waits until the URL answers, so a just-restarted serve process is judged by its answer, not its spawn. */
const untilAnswers = async (url: string) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch(url).then(response => response.ok, () => false)) return;
    await new Promise(accept => setTimeout(accept, 100));
  }
  throw new Error(`${url} never answered`);
};
/** Waits until the URL stops answering, so a killed serve is judged gone by its port, not its pid. */
const untilSilent = async (url: string) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await fetch(url).then(() => true, () => false))) return;
    await new Promise(accept => setTimeout(accept, 100));
  }
  throw new Error(`${url} never went silent`);
};
const stopServing = (root: string) => {
  const pid = readServeRecord(serveRecordPath(root))?.pid;
  if (pid) try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
};
/** Commits `files` to the pusher and pushes them to main; answers the new tip. */
const push = async (pusher: string, files: Record<string, string>, what: string) => {
  for (const [name, text] of Object.entries(files)) { await mkdir(join(pusher, name, '..'), { recursive: true }); await writeFile(join(pusher, name), text); }
  git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', what); git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  return git(pusher, 'rev-parse', 'HEAD');
};

/** The build the fixture declares, run in apps/game: it fails when main's fail.txt says so, else it writes the head commit as the app's answer. */
const buildJs = [
  'const fs = require("node:fs"), { execSync } = require("node:child_process");',
  'if (fs.readFileSync("fail.txt", "utf8").trim() === "yes") { console.error("the build was told to fail"); process.exit(1); }',
  'fs.mkdirSync("dist", { recursive: true });',
  'fs.writeFileSync("dist/commit.txt", String(execSync("git rev-parse HEAD", { encoding: "utf8" })).trim());',
].join('\n');
/** The start the fixture declares: it answers the commit its build built, on the PORT it is given. */
const serveJs = [
  'const http = require("node:http"), fs = require("node:fs");',
  'const port = Number(process.env.PORT);',
  'http.createServer((request, response) => {',
  '  let commit = "unknown"; try { commit = fs.readFileSync("dist/commit.txt", "utf8").trim(); } catch {}',
  `  response.writeHead(200, { "Content-Type": "text/plain" }).end(commit + "\\n");`,
  '}).listen(port, "127.0.0.1");',
].join('\n');
/** The workspace app graphyard.json declares: its lockfile at the root, its build and start in apps/game. */
const application = { id: 'game', kind: 'node', directory: 'apps/game', build: 'node build.js', start: 'node serve.js' };
const graphyardJson = JSON.stringify({ delivery: { mode: 'local', applications: [{ id: 'site', kind: 'static', directory: 'public', build: null }, application] } });

/** A minimal npm package and its lockfile, so the fixture's install is the npm ci a real app runs. */
const packageJson = JSON.stringify({ name: 'fixture-game', version: '1.0.0', private: true }) + '\n';
const packageLock = `${JSON.stringify({ name: 'fixture-game', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture-game', version: '1.0.0', license: 'ISC' } } }, null, 2)}\n`;

/** A fixture managed repository: an origin, a pusher that commits to it, and the launcher checkout, with the node application declared on main. */
async function managedRepository(label: string) {
  const base = await temporaryDirectory(label);
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), root = join(base, 'checkout');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, pusher);
  await push(pusher, { 'package.json': packageJson, 'package-lock.json': packageLock, 'apps/game/build.js': buildJs, 'apps/game/serve.js': serveJs, 'apps/game/fail.txt': 'no' }, 'the build and its serve');
  await push(pusher, { 'graphyard.json': graphyardJson }, 'declare the node application');
  git(base, 'clone', '-q', origin, root);
  return { root, pusher, push };
}

/** The master status page for a fixture root, with the real credential, Herdr and daemon reads the page runs. */
const statusOf = (root: string, repository: string) => masterStatusReport(root, {
  url: 'http://127.0.0.1:5', repository, credentialFile: join(root, 'coordinator.token'), hostId: 'test-host', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 },
} as unknown as MasterConfig, async () => ({ work: [], now: new Date().toISOString() }));

const servedCommit = async (url: string) => (await (await fetch(url)).text()).trim();
const escaped = (url: string) => url.replace(/[.:]/g, match => `\\${match}`);

test('unit:tests/managed-serve.test.ts — the deploy pass serves the node application main declares: installed at the root, built and started in its directory on a free PORT; a merged main moves what the port answers, and master status reports the URL, the served commit and atMain; a failing build keeps the previous commit serving and records the failure', async () => {
  const { root, pusher, push } = await managedRepository('managed-serve');
  assert.deepEqual(servedApplication(graphyardJson), application, 'the first node application is the one served; the static site is for previews only');
  try {
    const ports = managedServePorts({ root, baseBranch: 'main', run: defaultChildRun });

    // First pass: main's tip (the declaration commit) is checked out into the install's own serve
    // checkout, installed, built and started on a free loopback port.
    const first = git(root, 'rev-parse', 'refs/remotes/origin/main');
    assert.equal(await serveOnce(serveRecordPath(root), ports, () => {}), 'served');
    const record = readServeRecord(serveRecordPath(root));
    assert.equal(record?.commit, first);
    const url = record!.url!;
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    await untilAnswers(url);
    assert.equal(await servedCommit(url), first, 'the port answers the commit the pass served');

    // Master status reports the URL, the served commit and atMain true.
    const firstStatus = (await statusOf(root, 'owner/game')).serving;
    assert.ok(firstStatus.serve, 'the declared serve is reported');
    assert.deepEqual(
      { unconfigured: firstStatus.unconfigured, commit: firstStatus.commit, main: firstStatus.main, atMain: firstStatus.atMain, url: firstStatus.serve.url, failure: firstStatus.serve.failure },
      { unconfigured: false, commit: first.slice(0, 12), main: first.slice(0, 12), atMain: true, url, failure: null });
    assert.equal(firstStatus.pending, 0, 'the served commit is main, so nothing merged is uncarrried');

    // A merged main moves what the port answers.
    const second = await push(pusher, { 'game.txt': 'B\n' }, 'B');
    assert.equal(await serveOnce(serveRecordPath(root), ports, () => {}), 'served');
    await untilAnswers(url);
    assert.equal(await servedCommit(url), second, 'the served commit moved to the new main');
    assert.deepEqual({ commit: readServeRecord(serveRecordPath(root))?.commit, url: readServeRecord(serveRecordPath(root))?.url }, { commit: second, url }, 'the URL stays the same across deploys');
    const secondStatus = (await statusOf(root, 'owner/game')).serving;
    assert.deepEqual(
      { commit: secondStatus.commit, main: secondStatus.main, atMain: secondStatus.atMain },
      { commit: second.slice(0, 12), main: second.slice(0, 12), atMain: true });

    // A build that fails on the next commit: the previous commit keeps serving, the failure is recorded.
    const third = await push(pusher, { 'game.txt': 'C\n', 'apps/game/fail.txt': 'yes' }, 'C');
    assert.equal(await serveOnce(serveRecordPath(root), ports, () => {}), 'failed');
    const failed = readServeRecord(serveRecordPath(root));
    assert.deepEqual({ commit: failed?.commit, failed: failed?.failed }, { commit: second, failed: third });
    assert.match(failed?.reason ?? '', /the build was told to fail/);
    await untilAnswers(url);
    assert.equal(await servedCommit(url), second, 'the previous commit still serves');
    const failedStatus = (await statusOf(root, 'owner/game')).serving;
    assert.ok(failedStatus.serve, 'the declared serve is still reported');
    assert.deepEqual(
      { commit: failedStatus.commit, atMain: failedStatus.atMain, tip: failedStatus.failedDeploy?.tip, restoring: failedStatus.failedDeploy?.restoring },
      { commit: second.slice(0, 12), atMain: false, tip: third.slice(0, 12), restoring: null });
    assert.match(failedStatus.failedDeploy?.reason ?? '', /the build was told to fail/, 'the failure is recorded with why');
    assert.equal(failedStatus.serve.url, url, 'the URL is still the served one');
    assert.match(failedStatus.serve.failure?.reason ?? '', /the build was told to fail/);

    // The failed tip waits for the next one, like every deploy watch.
    assert.equal(await serveOnce(serveRecordPath(root), ports, () => {}), 'unchanged');
  } finally { stopServing(root); }
});

test('unit:tests/managed-serve.test.ts — a serve that died is served again and the record names the new process, so the next restart tracks what holds the port', async () => {
  const { root } = await managedRepository('managed-serve-restart');
  try {
    const ports = managedServePorts({ root, baseBranch: 'main', run: defaultChildRun });
    assert.equal(await serveOnce(serveRecordPath(root), ports, () => {}), 'served');
    const first = readServeRecord(serveRecordPath(root));
    const url = first!.url!;
    assert.ok(first?.pid);
    const commit = first.commit as string;
    await untilAnswers(url);

    // The serve process dies (a reboot, a crash): the record keeps the commit, the port goes dead.
    process.kill(-first.pid!, 'SIGKILL');
    await untilSilent(url);

    // The re-serve path serves the build the checkout already holds and writes the NEW pid, so the
    // record tracks the process that actually answers; killing it again silences the port, and the
    // next pass serves it again under a fresh pid.
    let previous = first.pid!;
    for (let round = 0; round < 2; round++) {
      assert.equal(await serveOnce(serveRecordPath(root), ports, () => {}), 'restarted');
      const again = readServeRecord(serveRecordPath(root));
      assert.notEqual(again?.pid, previous, 'the dead pid is replaced by the new serve process\'s');
      assert.doesNotThrow(() => process.kill(again!.pid!, 0), 'the recorded pid is alive');
      await untilAnswers(url);
      assert.equal(await servedCommit(url), commit, 'the same commit serves again');
      process.kill(-again!.pid!, 'SIGKILL');
      await untilSilent(url);
      const kept = readServeRecord(serveRecordPath(root));
      assert.deepEqual({ commit: kept?.commit, failed: kept?.failed }, { commit, failed: null });
      previous = again!.pid!;
    }
  } finally { stopServing(root); }
});

test('unit:tests/managed-serve.test.ts — a serve that never answers is recorded as the failure it is, with nothing claimed served', async () => {
  const { root, pusher, push } = await managedRepository('managed-serve-dead');
  try {
    const ports = managedServePorts({ root, baseBranch: 'main', run: defaultChildRun });
    assert.equal(await serveOnce(serveRecordPath(root), ports, () => {}), 'served');
    const url = readServeRecord(serveRecordPath(root))!.url!;
    await untilAnswers(url);

    // The next commit's serve command exits without ever binding the port: the restart stopped the
    // previous serve, nothing answers, and the pass records the failure instead of the commit.
    const dead = await push(pusher, { 'apps/game/serve.js': 'process.exit(0);\n' }, 'a serve that exits');
    assert.equal(await serveOnce(serveRecordPath(root), ports, () => {}, { answerTimeoutMs: 1_000 }), 'failed');
    const record = readServeRecord(serveRecordPath(root));
    assert.deepEqual({ commit: record?.commit, failed: record?.failed }, { commit: null, failed: dead });
    assert.match(record?.reason ?? '', /the serve did not answer/);
    await untilSilent(url);
    const status = (await statusOf(root, 'owner/game')).serving;
    assert.deepEqual({ unconfigured: status.unconfigured, commit: status.commit, atMain: status.atMain }, { unconfigured: true, commit: null, atMain: null });
    assert.equal(status.serve?.url, url, 'the served URL is still reported');
    assert.match(status.serve?.failure?.reason ?? '', /the serve did not answer/);

    // A serve failure waits for the next merge, like a build failure.
    assert.equal(await serveOnce(serveRecordPath(root), ports, () => {}, { answerTimeoutMs: 1_000 }), 'unchanged');
  } finally { stopServing(root); }
});

test('unit:tests/managed-serve.test.ts — a repository declaring no node application reports exactly what it reported before and the pass does nothing; doctor prints a FAIL line naming the URL when a declared serve does not answer', async () => {
  // A managed repository that declares nothing: the pass records nothing, and master status reads
  // exactly what it read before this feature — unconfigured, no served commit, no atMain claim, no
  // failure, main's tip named, and the serve fields null when nothing is declared.
  const base = await temporaryDirectory('serve-optional');
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), root = join(base, 'checkout');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, pusher);
  await push(pusher, { 'game.txt': 'the game\n', 'graphyard.json': JSON.stringify({ delivery: { mode: 'local', applications: [{ id: 'site', kind: 'static', directory: 'public', build: null }] } }) }, 'the game, declaring only a static site');
  git(base, 'clone', '-q', origin, root);
  const main = git(root, 'rev-parse', 'refs/remotes/origin/main');

  const ports = managedServePorts({ root, baseBranch: 'main', run: defaultChildRun });
  assert.equal(await serveOnce(serveRecordPath(root), ports, () => {}), 'absent');
  assert.equal(readServeRecord(serveRecordPath(root)), null, 'nothing was recorded');

  assert.deepEqual((await statusOf(root, 'owner/game')).serving,
    { unconfigured: true, commit: null, main: main.slice(0, 12), atMain: null, failedDeploy: null, serve: null });
  // doctor prints no serve line for a repository that declares nothing.
  const doctorInput = { root, env: {}, status: null, reachable: true, environments: '/nonexistent', sandbox: () => null };
  assert.equal((await setupFromZeroChecks(doctorInput)).find(check => check.id === 'serve'), undefined);

  // A declared serve that does not answer: one FAIL line naming the URL, the last build failure with it.
  const dead = await freePort();
  const deadUrl = `http://127.0.0.1:${dead}`;
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(serveRecordPath(root), `${JSON.stringify({ commit: main, url: deadUrl, failed: main, reason: 'the build was told to fail', pid: null, at: new Date().toISOString() }, null, 2)}\n`);
  const checks = await setupFromZeroChecks(doctorInput);
  const serve = checks.find(check => check.id === 'serve') as SetupCheck | undefined;
  assert.ok(serve, 'doctor checks the declared serve');
  assert.equal(serve.status, 'fail');
  assert.match(serve.detail, new RegExp(`does not answer ${escaped(deadUrl)}`));
  assert.match(serve.detail, /the build of .* failed last: the build was told to fail/);
  assert.match(setupLine(serve), new RegExp(`^FAIL serve: .*${escaped(deadUrl)}`));

  // A declared serve that answers: one PASS line naming the URL.
  const server = createHttpServer((request, response) => response.writeHead(200).end('served'));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const live = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await writeFile(serveRecordPath(root), `${JSON.stringify({ commit: main, url: live, failed: null, reason: null, pid: null, at: new Date().toISOString() }, null, 2)}\n`);
    const liveServe = (await setupFromZeroChecks(doctorInput)).find(check => check.id === 'serve') as SetupCheck | undefined;
    assert.ok(liveServe);
    assert.equal(liveServe.status, 'pass');
    assert.match(liveServe.detail, new RegExp(`${escaped(live)} answers at ${main.slice(0, 12)}`));
  } finally { await new Promise<void>(done => server.close(() => done())); }
});

test('unit:tests/managed-serve.test.ts — a malformed node application is named, never served', () => {
  assert.throws(() => servedApplication(JSON.stringify({ delivery: { applications: [{ id: 'game', kind: 'node', directory: 'apps/game', build: null }] } })), /"game": start/);
  assert.throws(() => servedApplication(JSON.stringify({ delivery: { applications: [{ id: 'game', kind: 'node', directory: 'apps/game', build: null, start: 'node serve.js', port: 4400 }] } })), /Unrecognized key/);
  assert.throws(() => servedApplication('not json'), /not valid JSON/);
  assert.equal(servedApplication('{}'), null);
});

test('unit:tests/managed-serve.test.ts — the dashboard release line links the declared serve and names the last build failure', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ReleaseLine } = await import('../web/components/top-bar.js');
  const markup = (status: any) => renderToStaticMarkup(createElement(ReleaseLine, { status }))!;
  const text = (raw: string) => raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const url = 'http://127.0.0.1:4400';
  const serving = { unconfigured: false, commit: 'a'.repeat(40), main: 'a'.repeat(40), atMain: true, failedDeploy: null, pending: 0, serve: { url, failure: null } };

  // A URL is present: the Served line carries the link.
  const served = markup({ serving, deploy: null });
  assert.match(served, new RegExp(`href="${url}"`));
  assert.match(text(served), new RegExp(`Serving ${'a'.repeat(8)} .* Served \\u00b7 127\\.0\\.0\\.1:4400`));

  // The last build failure is named beside the commit that still serves, and the link stands.
  // The required cases' verdict (GY-2983) names itself between them: not yet run while no check
  // is recorded, verified once every required case passed, the failing case and step once one broke.
  const failing = markup({ serving: { ...serving, commit: 'b'.repeat(40), atMain: false, pending: 2,
    failedDeploy: { tip: 'c'.repeat(40), reason: 'the build was told to fail', restoring: null },
    serve: { url, failure: { commit: 'c'.repeat(40), reason: 'the build was told to fail' } } }, deploy: null });
  assert.match(text(failing), /Serving b{8} · 2 merged changes not carried yet · not yet run · build of c{8} failed: the build was told to fail · Served · 127\.0\.0\.1:4400/);

  const verified = markup({ serving: { ...serving, commit: 'b'.repeat(40), atMain: false, pending: 2,
    serve: { url, failure: null, check: { verified: true, case: null, step: null, reason: null } } }, deploy: null });
  assert.match(text(verified), /Serving b{8} · 2 merged changes not carried yet · verified · Served · 127\.0\.0\.1:4400/);

  const brokenCase = markup({ serving: { ...serving, commit: 'b'.repeat(40), atMain: false, pending: 2,
    serve: { url, failure: null, check: { verified: false, case: 'fixture-home', step: 'step 1 GET /ready', reason: 'expected status 200, got 404' } } }, deploy: null });
  assert.match(text(brokenCase), /Serving b{8} · 2 merged changes not carried yet · failing fixture-home: step 1 GET \/ready · Served · 127\.0\.0\.1:4400/);

  // Nothing served yet (the first build failed): no served commit is claimed, the failure is named, the URL links.
  const unserved = markup({ serving: { ...serving, unconfigured: true, commit: null, atMain: null, pending: null,
    failedDeploy: { tip: 'c'.repeat(40), reason: 'the build was told to fail', restoring: null },
    serve: { url, failure: { commit: 'c'.repeat(40), reason: 'the build was told to fail' } } }, deploy: null });
  assert.match(text(unserved), /No serve yet · main a{8} · build of c{8} failed: the build was told to fail · Served · 127\.0\.0\.1:4400/);

  // Nothing declared: the managed install's line stays exactly what it was (GY-2964).
  assert.match(text(markup({ serving: { unconfigured: true, commit: null, main: 'd'.repeat(40), atMain: null, failedDeploy: null, pending: null, serve: null },
    deploy: { repository: 'owner/game', configured: false, tip: null, at: null, main: 'd'.repeat(40), pending: null } })), new RegExp(`No deploy configured · main ${'d'.repeat(8)}`));
});
