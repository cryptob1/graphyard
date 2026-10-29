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
import { parseServeDeclaration, readServeRecord, serveOnce, serveRecordPath } from '../src/serve-app.js';
import { setupFromZeroChecks, setupLine, type SetupCheck } from '../src/setup-from-zero.js';
import type { MasterConfig } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2976: a managed repository declaring .graphyard/serve.json has its main built and served on a
// loopback port after every merge, and master status, the dashboard and doctor report it. A
// repository that declares nothing reports exactly what it reported before.

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
const stopServing = (root: string) => {
  const pid = readServeRecord(serveRecordPath(root))?.pid;
  if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
};
/** Commits `files` to the pusher and pushes them to main; answers the new tip. */
const push = async (pusher: string, files: Record<string, string>, what: string) => {
  for (const [name, text] of Object.entries(files)) { await mkdir(join(pusher, name, '..'), { recursive: true }); await writeFile(join(pusher, name), text); }
  git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', what); git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  return git(pusher, 'rev-parse', 'HEAD');
};

/** The build the fixture declares: it fails when main's fail.txt says so, else it writes the head commit as the app's answer. */
const buildJs = [
  'const fs = require("node:fs"), { execSync } = require("node:child_process");',
  'if (fs.readFileSync("fail.txt", "utf8").trim() === "yes") { console.error("the build was told to fail"); process.exit(1); }',
  'fs.mkdirSync("dist", { recursive: true });',
  'fs.writeFileSync("dist/commit.txt", String(execSync("git rev-parse HEAD", { encoding: "utf8" })).trim());',
].join('\n');
/** The serve the fixture declares: it answers the commit its build built, on the declared port. */
const serveJs = [
  'const http = require("node:http"), fs = require("node:fs");',
  'const port = Number(process.argv[process.argv.indexOf("--port") + 1]);',
  'http.createServer((request, response) => {',
  '  let commit = "unknown"; try { commit = fs.readFileSync("dist/commit.txt", "utf8").trim(); } catch {}',
  `  response.writeHead(200, { "Content-Type": "text/plain" }).end(commit + "\\n");`,
  '}).listen(port, "127.0.0.1");',
].join('\n');
const declarationFile = (port: number) => JSON.stringify({ build: ['node', 'build.js'], serve: ['node', 'serve.js', '--port', String(port)], port });

/** A minimal npm package and its lockfile, so the fixture's install is the npm ci a real app runs. */
const packageJson = JSON.stringify({ name: 'fixture-game', version: '1.0.0', private: true }) + '\n';
const packageLock = `${JSON.stringify({ name: 'fixture-game', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture-game', version: '1.0.0', license: 'ISC' } } }, null, 2)}\n`;

/** A fixture managed repository: an origin, a pusher that commits to it, and the launcher checkout, with the serve declaration on main. */
async function managedRepository(label: string, port: number) {
  const base = await temporaryDirectory(label);
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), root = join(base, 'checkout');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, pusher);
  await push(pusher, { 'package.json': packageJson, 'package-lock.json': packageLock, 'build.js': buildJs, 'serve.js': serveJs, 'fail.txt': 'no' }, 'the build and its serve');
  await push(pusher, { '.graphyard/serve.json': declarationFile(port) }, 'declare the serve');
  git(base, 'clone', '-q', origin, root);
  return { root, pusher, push };
}

/** The master status page for a fixture root, with the real credential, Herdr and daemon reads the page runs. */
const statusOf = (root: string, repository: string) => masterStatusReport(root, {
  url: 'http://127.0.0.1:5', repository, credentialFile: join(root, 'coordinator.token'), hostId: 'test-host', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 },
} as unknown as MasterConfig, async () => ({ work: [], now: new Date().toISOString() }));

const servedCommit = async (url: string) => (await (await fetch(url)).text()).trim();
const escaped = (url: string) => url.replace(/[.:]/g, match => `\\${match}`);

test('unit:managed-repo-main-served-after-merge — the deploy pass checks a declared main out, builds and serves it; a merged main moves what the port answers, and master status reports the URL, the served commit and atMain; a failing build keeps the previous commit serving and records the failure', async () => {
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const { root, pusher, push } = await managedRepository('managed-serve', port);
  const declaration = parseServeDeclaration(declarationFile(port), 'serve.json');
  assert.deepEqual(declaration, { build: ['node', 'build.js'], serve: ['node', 'serve.js', '--port', String(port)], port });
  try {
    const ports = managedServePorts({ root, baseBranch: 'main', run: defaultChildRun });

    // First pass: main's tip (the declaration commit) is checked out into the install's own serve
    // checkout, built and served on the declared loopback port.
    const first = git(root, 'rev-parse', 'refs/remotes/origin/main');
    assert.equal(await serveOnce(serveRecordPath(root), ports, () => {}), 'served');
    const record = readServeRecord(serveRecordPath(root));
    assert.equal(record?.commit, first);
    assert.equal(record?.url, url);
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
    assert.equal(readServeRecord(serveRecordPath(root))?.commit, second);
    const secondStatus = (await statusOf(root, 'owner/game')).serving;
    assert.deepEqual(
      { commit: secondStatus.commit, main: secondStatus.main, atMain: secondStatus.atMain },
      { commit: second.slice(0, 12), main: second.slice(0, 12), atMain: true });

    // A build that fails on the next commit: the previous commit keeps serving, the failure is recorded.
    const third = await push(pusher, { 'game.txt': 'C\n', 'fail.txt': 'yes' }, 'C');
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
    assert.equal(failedStatus.serve.url, url, 'the URL is still the declared one');
    assert.match(failedStatus.serve.failure?.reason ?? '', /the build was told to fail/);

    // The failed tip waits for the next one, like every deploy watch.
    assert.equal(await serveOnce(serveRecordPath(root), ports, () => {}), 'unchanged');
  } finally { stopServing(root); }
});

test('unit:serve-optional-and-doctor-checks-it — a repository without serve.json reports exactly what it reported before and the pass does nothing; doctor prints a FAIL line naming the URL when a declared serve does not answer', async () => {
  // A managed repository that declares nothing: the pass records nothing, and master status reads
  // exactly what it read before this feature — unconfigured, no served commit, no atMain claim, no
  // failure, main's tip named, and the serve fields null when nothing is declared.
  const base = await temporaryDirectory('serve-optional');
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), root = join(base, 'checkout');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, pusher);
  await push(pusher, { 'game.txt': 'the game\n' }, 'the game');
  git(base, 'clone', '-q', origin, root);
  const main = git(root, 'rev-parse', 'refs/remotes/origin/main');

  const ports = managedServePorts({ root, baseBranch: 'main', run: defaultChildRun });
  assert.equal(await serveOnce(serveRecordPath(root), ports, () => {}), 'absent');
  assert.equal(readServeRecord(serveRecordPath(root)), null, 'nothing was recorded');

  assert.deepEqual((await statusOf(root, 'owner/game')).serving,
    { unconfigured: true, commit: null, main: main.slice(0, 12), atMain: null, failedDeploy: null, pending: null, serve: null });
  // doctor prints no serve line for a repository that declares nothing.
  const doctorInput = { root, env: {}, status: null, reachable: true, environments: '/nonexistent', sandbox: () => null };
  assert.equal((await setupFromZeroChecks(doctorInput)).find(check => check.id === 'serve'), undefined);

  // A declared serve that does not answer: one FAIL line naming the URL, the last build failure with it.
  const dead = await freePort();
  const deadUrl = `http://127.0.0.1:${dead}`;
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

test('unit:managed-repo-main-served-after-merge — a malformed declaration is named, never served', () => {
  assert.throws(() => parseServeDeclaration('{"build": "npm run build", "port": 4400}', '.graphyard/serve.json'), /serve\.json: build/);
  assert.throws(() => parseServeDeclaration('not json'), /not valid JSON/);
  assert.throws(() => parseServeDeclaration('{"build": ["npm", "run", "build"], "serve": ["npx", "vite"], "port": "4400"}'), /port/);
  assert.equal(parseServeDeclaration(''), null);
});

test('unit:managed-repo-main-served-after-merge — the dashboard release line links the declared serve and names the last build failure', async () => {
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
  const failing = markup({ serving: { ...serving, commit: 'b'.repeat(40), atMain: false, pending: 2,
    failedDeploy: { tip: 'c'.repeat(40), reason: 'the build was told to fail', restoring: null },
    serve: { url, failure: { commit: 'c'.repeat(40), reason: 'the build was told to fail' } } }, deploy: null });
  assert.match(text(failing), /Serving b{8} · 2 merged changes not carried yet · build of c{8} failed: the build was told to fail · Served · 127\.0\.0\.1:4400/);

  // Nothing served yet (the first build failed): no served commit is claimed, the failure is named, the URL links.
  const unserved = markup({ serving: { ...serving, unconfigured: true, commit: null, atMain: null, pending: null,
    failedDeploy: { tip: 'c'.repeat(40), reason: 'the build was told to fail', restoring: null },
    serve: { url, failure: { commit: 'c'.repeat(40), reason: 'the build was told to fail' } } }, deploy: null });
  assert.match(text(unserved), /No serve yet · main a{8} · build of c{8} failed: the build was told to fail · Served · 127\.0\.0\.1:4400/);

  // Nothing declared: the managed install's line stays exactly what it was (GY-2964).
  assert.match(text(markup({ serving: { unconfigured: true, commit: null, main: 'd'.repeat(40), atMain: null, failedDeploy: null, pending: null, serve: null },
    deploy: { repository: 'owner/game', configured: false, tip: null, at: null, main: 'd'.repeat(40), pending: null } })), new RegExp(`No deploy configured · main ${'d'.repeat(8)}`));
});
