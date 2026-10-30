import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { masterStatusReport } from '../src/cli/master-status.js';
import { defaultChildRun } from '../src/child-runner.js';
import { managedServePorts } from '../src/cli/upgrade.js';
import { readServeRecord, serveOnce, serveRecordPath } from '../src/serve-app.js';
import type { MasterConfig } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2983: a served app is live-verified. Once the deploy unit's serve pass serves a new main, the
// commit's own required E2E cases run against the served URL and the pass records the verdict for
// that exact commit in .graphyard/served.json; master status's serving block reports the same. A
// failing case is the release health the master acts on: serving does not stop and nothing rolls
// back.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const freePort = () => new Promise<number>((accept, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => accept(port)); });
});
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

/** The build the fixture declares: it copies every declared page into dist/. */
const buildJs = [
  'const fs = require("node:fs");',
  'fs.mkdirSync("dist", { recursive: true });',
  'fs.writeFileSync("dist/index.txt", "served\\n");',
  'if (fs.existsSync("ready.txt")) fs.copyFileSync("ready.txt", "dist/ready.txt");',
].join('\n');
/** The serve the fixture declares: it answers every dist file, 404 for one it has not built. */
const serveJs = [
  'const http = require("node:http"), fs = require("node:fs"), path = require("node:path");',
  'const port = Number(process.argv[process.argv.indexOf("--port") + 1]);',
  'http.createServer((request, response) => {',
  '  const url = request.url.split("?")[0];',
  '  const name = url === "/" ? "index.txt" : `${url.slice(1)}.txt`;',
  '  fs.readFile(path.join("dist", name), (error, body) => {',
  '    if (error) { response.writeHead(404).end("missing\\n"); return; }',
  '    response.writeHead(200, { "Content-Type": "text/plain" }).end(body);',
  '  });',
  '}).listen(port, "127.0.0.1");',
].join('\n');
const declarationFile = (port: number) => JSON.stringify({ build: ['node', 'build.js'], serve: ['node', 'serve.js', '--port', String(port)], port });

/** A minimal npm package and its lockfile, so the fixture's install is the npm ci a real app runs. */
const packageJson = JSON.stringify({ name: 'fixture-served', version: '1.0.0', private: true }) + '\n';
const packageLock = `${JSON.stringify({ name: 'fixture-served', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture-served', version: '1.0.0', license: 'ISC' } } }, null, 2)}\n`;

/** The two required cases the fixture declares: one the served app always passes, one that passes only once the app builds the page it asks for. */
const caseFile = (id: string, path: string) => `${JSON.stringify({ id, title: `The served app answers ${path}`, tags: ['served'], target: 'any', required: true, steps: [{ kind: 'http', method: 'GET', path, status: 200 }] }, null, 2)}\n`;

/** A fixture managed repository: an origin, a pusher that commits to it, and the launcher checkout, with the serve declaration, the app and its two required cases on main. */
async function managedRepository(label: string, port: number) {
  const base = await temporaryDirectory(label);
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), root = join(base, 'checkout');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, pusher);
  await push(pusher, { 'package.json': packageJson, 'package-lock.json': packageLock, 'build.js': buildJs, 'serve.js': serveJs, 'e2e/cases/served-case-home.json': caseFile('served-case-home', '/'), 'e2e/cases/served-case-ready.json': caseFile('served-case-ready', '/ready'), '.graphyard/serve.json': declarationFile(port) }, 'the app and its required cases');
  git(base, 'clone', '-q', origin, root);
  return { root, pusher, push };
}

/** The master status page for a fixture root, with the real credential, Herdr and daemon reads the page runs. */
const statusOf = (root: string, repository: string) => masterStatusReport(root, {
  url: 'http://127.0.0.1:5', repository, credentialFile: join(root, 'coordinator.token'), hostId: 'test-host', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 },
} as unknown as MasterConfig, async () => ({ work: [], now: new Date().toISOString() }));

test('unit:served-app-runs-required-cases — a served commit is live-verified: its own required cases run against the served URL, the pass records the verdict for that exact commit, and master status reports the same', async () => {
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const { root, pusher, push } = await managedRepository('served-required-cases', port);
  try {
    const ports = managedServePorts({ root, baseBranch: 'main', run: defaultChildRun });

    // First serve: the app does not build the page served-case-ready asks for, so that required
    // case fails against the served URL while served-case-home passes. The pass records the
    // commit, verified false, and the failing case and step.
    const broken = git(root, 'rev-parse', 'refs/remotes/origin/main');
    assert.equal(await serveOnce(serveRecordPath(root), ports, () => {}), 'served');
    const record = readServeRecord(serveRecordPath(root));
    assert.deepEqual(
      { commit: record?.commit, verified: record?.check?.verified, case: record?.check?.case, step: record?.check?.step },
      { commit: broken, verified: false, case: 'served-case-ready', step: 'step 1 GET /ready' });
    assert.match(record?.check?.reason ?? '', /expected status 200, got 404/);

    // Master status's serving block reports the same verdict for the same commit.
    const brokenStatus = (await statusOf(root, 'owner/game')).serving;
    assert.deepEqual(
      { commit: brokenStatus.commit, verified: brokenStatus.serve?.check?.verified, case: brokenStatus.serve?.check?.case, step: brokenStatus.serve?.check?.step },
      { commit: broken.slice(0, 12), verified: false, case: 'served-case-ready', step: 'step 1 GET /ready' });

    // The fix is a new main: both required cases now pass against the URL the new commit serves,
    // and the verdict is recorded for that exact commit.
    const fixed = await push(pusher, { 'ready.txt': 'ready\n' }, 'build the page the case asks for');
    assert.equal(await serveOnce(serveRecordPath(root), ports, () => {}), 'served');
    const fixedRecord = readServeRecord(serveRecordPath(root));
    assert.deepEqual(
      { commit: fixedRecord?.commit, check: fixedRecord?.check },
      { commit: fixed, check: { verified: true, case: null, step: null, reason: null } });
    const fixedStatus = (await statusOf(root, 'owner/game')).serving;
    assert.deepEqual(
      { commit: fixedStatus.commit, atMain: fixedStatus.atMain, check: fixedStatus.serve?.check },
      { commit: fixed.slice(0, 12), atMain: true, check: { verified: true, case: null, step: null, reason: null } });

    // The same commit served again keeps the verdict its cases earned.
    process.kill(fixedRecord!.pid!, 'SIGKILL');
    assert.equal(await serveOnce(serveRecordPath(root), ports, () => {}), 'restarted');
    assert.deepEqual(readServeRecord(serveRecordPath(root))?.check, { verified: true, case: null, step: null, reason: null });

    // A main with no required cases is vacuously verified: the pass records verified true, nothing failed.
    git(pusher, 'rm', '-q', 'e2e/cases/served-case-home.json', 'e2e/cases/served-case-ready.json');
    git(pusher, 'commit', '-q', '-m', 'no required cases'); git(pusher, 'push', '-q', 'origin', 'HEAD:main');
    const bare = git(pusher, 'rev-parse', 'HEAD');
    assert.equal(await serveOnce(serveRecordPath(root), ports, () => {}), 'served');
    const bareRecord = readServeRecord(serveRecordPath(root));
    assert.deepEqual({ commit: bareRecord?.commit, check: bareRecord?.check }, { commit: bare, check: { verified: true, case: null, step: null, reason: null } });
  } finally { stopServing(root); }
});
