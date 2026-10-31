import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { managedServePorts } from '../src/cli/upgrade.js';
import { defaultChildRun } from '../src/child-runner.js';
import { readServeRecord, serveOnce, serveRecordPath } from '../src/serve-app.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2985: what was live keeps serving. Once a second commit is served, the previously served
// build is built again in its own baseline checkout and serves on the port beside the declared
// one, and the live-verification pass runs the served commit's required cases with BASELINE_URL
// set to it — so a compare case judges the new build against what users had. On the first serve
// no baseline exists: the cases run once, as today.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const freePort = () => new Promise<number>((accept, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => accept(port)); });
});
/** Commits `files` to the pusher and pushes them to main; answers the new tip. */
const push = async (pusher: string, files: Record<string, string>, what: string) => {
  for (const [name, text] of Object.entries(files)) { await mkdir(join(pusher, name, '..'), { recursive: true }); await writeFile(join(pusher, name), text); }
  git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', what); git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  return git(pusher, 'rev-parse', 'HEAD');
};

/** The build the fixture declares: it writes the commit it built, and a page, into dist/. */
const buildJs = [
  'const fs = require("node:fs"), { execSync } = require("node:child_process");',
  'fs.mkdirSync("dist", { recursive: true });',
  'fs.writeFileSync("dist/commit.txt", String(execSync("git rev-parse HEAD", { encoding: "utf8" })).trim());',
  'fs.writeFileSync("dist/index.txt", "served\\n");',
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
const packageJson = JSON.stringify({ name: 'fixture-baseline', version: '1.0.0', private: true }) + '\n';
const packageLock = `${JSON.stringify({ name: 'fixture-baseline', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture-baseline', version: '1.0.0', license: 'ISC' } } }, null, 2)}\n`;

/** The required case a compare case stands for: it passes only against a live BASELINE_URL. */
const caseFile = JSON.stringify({ id: 'baseline-checked', title: 'The baseline answers', tags: ['served'], target: 'any', required: true, steps: [{ kind: 'command', run: 'node -e "fetch(process.env.BASELINE_URL + \'/commit\').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"', timeoutSeconds: 30 }], secrets: [] }, null, 2);

/** A fixture managed repository: an origin, a pusher that commits to it, and the launcher checkout, with the serve declaration, the app and its required case on main. */
async function managedRepository(label: string, port: number) {
  const base = await temporaryDirectory(label);
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), root = join(base, 'checkout');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, pusher);
  await push(pusher, { 'package.json': packageJson, 'package-lock.json': packageLock, 'build.js': buildJs, 'serve.js': serveJs, 'e2e/cases/baseline-checked.json': caseFile, '.graphyard/serve.json': declarationFile(port) }, 'the app and its required case');
  git(base, 'clone', '-q', origin, root);
  return { root, pusher, push };
}

test('unit:served-app-baseline — a second served build keeps the previously served build on the port beside it as BASELINE_URL, the live-verification cases run with it, and on the first serve nothing does', async () => {
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const { root, pusher, push } = await managedRepository('served-app-baseline', port);
  const stopAll = () => {
    const record = readServeRecord(serveRecordPath(root));
    for (const tracked of [record, record?.baseline]) if (tracked?.pid) try { process.kill(-tracked.pid, 'SIGKILL'); } catch { /* already gone */ }
  };
  try {
    const ports = managedServePorts({ root, baseBranch: 'main', run: defaultChildRun });

    // First serve: there is no baseline, so no BASELINE_URL — the compare-style required case runs
    // once and fails, which the pass records without stopping the serve. No baseline is recorded.
    const first = git(root, 'rev-parse', 'refs/remotes/origin/main');
    assert.equal(await serveOnce(serveRecordPath(root), ports, () => {}), 'served');
    const firstRecord = readServeRecord(serveRecordPath(root));
    assert.equal(firstRecord?.commit, first);
    assert.equal(firstRecord?.check?.verified, false);
    assert.equal(firstRecord?.check?.case, 'baseline-checked');
    assert.equal(firstRecord?.baseline ?? null, null);

    // Second serve: the previously served build is built in its own baseline checkout and serves
    // on the port beside the declared one; the case runs with BASELINE_URL set to it and passes.
    const second = await push(pusher, { 'index.txt': 'served two\n' }, 'the next tip');
    assert.equal(await serveOnce(serveRecordPath(root), ports, () => {}), 'served');
    const secondRecord = readServeRecord(serveRecordPath(root));
    assert.equal(secondRecord?.commit, second);
    assert.deepEqual({ ...secondRecord?.check, reason: null }, { verified: true, case: null, step: null, reason: null });
    assert.equal(secondRecord?.baseline?.commit, first);
    assert.equal(secondRecord?.baseline?.url, `http://127.0.0.1:${port + 1}`);
    const baselineAnswer = await fetch(`${secondRecord?.baseline?.url}/commit`).then(response => response.text(), () => '');
    assert.equal(baselineAnswer.trim(), first, 'the baseline serves the previously served build');
    const servedAnswer = await fetch(`${url}/commit`).then(response => response.text(), () => '');
    assert.equal(servedAnswer.trim(), second, 'the new build still serves the declared port');
  } finally { stopAll(); }
});
