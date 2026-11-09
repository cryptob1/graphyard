import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { answering, readServeRecord, serveOnce, serveRecordPath } from '../src/serve-app.js';
import { managedServePorts } from '../src/cli/upgrade.js';
import { defaultChildRun } from '../src/child-runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2993: a commit counts as served only when the answer on the served port is the serve the
// pass started. The port is chosen once and kept in served.json (GY-3201); when another process
// has since taken it, the restarted serve exits without
// binding it and the pass records the commit as failed, with a reason naming the port — never as
// served, and its required cases never run against the foreign holder, whose answers would
// otherwise stand in for the serve's own (the verified-true-against-the-wrong-process report).

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const freePort = () => new Promise<number>((accept, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => accept(port)); });
});

const buildJs = [
  'const fs = require("node:fs");',
  'fs.mkdirSync("dist", { recursive: true });',
  'fs.writeFileSync("dist/index.txt", "served\\n");',
].join('\n');
const serveJs = [
  'const http = require("node:http"), fs = require("node:fs"), path = require("node:path");',
  'const port = Number(process.env.PORT);',
  'http.createServer((request, response) => {',
  '  const url = request.url.split("?")[0];',
  '  const name = url === "/" ? "index.txt" : `${url.slice(1)}.txt`;',
  '  fs.readFile(path.join("dist", name), (error, body) => {',
  '    if (error) { response.writeHead(404).end("missing\\n"); return; }',
  '    response.writeHead(200, { "Content-Type": "text/plain" }).end(body);',
  '  });',
  '}).listen(port, "127.0.0.1");',
].join('\n');
/** The node application graphyard.json declares (GY-3201): built and started at the root, on the PORT the pass gives it. */
const graphyardJson = JSON.stringify({ delivery: { mode: 'local', applications: [{ id: 'app', kind: 'node', directory: '.', build: 'node build.js', start: 'node serve.js' }] } });
const packageJson = JSON.stringify({ name: 'fixture-foreign-port', version: '1.0.0', private: true }) + '\n';
const packageLock = `${JSON.stringify({ name: 'fixture-foreign-port', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture-foreign-port', version: '1.0.0', license: 'ISC' } } }, null, 2)}\n`;
/** The required case the foreign holder would pass: GET / expecting 200 is exactly what it answers. */
const caseFile = `${JSON.stringify({ id: 'served-case-home', title: 'The served app answers /', tags: ['served'], target: 'any', required: true, steps: [{ kind: 'http', method: 'GET', path: '/', status: 200 }] }, null, 2)}\n`;

test('integration:serve-refuses-foreign-port-holder — a serve that cannot bind a held port records the commit as failed, with a reason naming the port, and never as served or verified against the holder', { timeout: 240_000 }, async () => {
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const base = await temporaryDirectory('serve-foreign-port');
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), root = join(base, 'checkout');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, pusher);
  const files: Record<string, string> = {
    'package.json': packageJson, 'package-lock.json': packageLock, 'build.js': buildJs, 'serve.js': serveJs,
    'e2e/cases/served-case-home.json': caseFile, 'graphyard.json': graphyardJson,
  };
  for (const [name, text] of Object.entries(files)) { await mkdir(join(pusher, name, '..'), { recursive: true }); await writeFile(join(pusher, name), text); }
  git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', 'the app'); git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  git(base, 'clone', '-q', origin, root);
  const tip = git(root, 'rev-parse', 'refs/remotes/origin/main');

  // The record keeps the port an earlier serve was given, and a process the serve pass did not
  // start now holds it — on 0.0.0.0, like the listener the report saw — and answers what the
  // required case asks for.
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(serveRecordPath(root), JSON.stringify({ commit: null, url, failed: null, reason: null, pid: null, at: new Date().toISOString() }));
  const holder = spawn('node', ['-e', `require("node:http").createServer((request, response) => response.writeHead(200).end("foreign\\n")).listen(${port}, "0.0.0.0")`], { stdio: 'ignore' });
  try {
    const deadline = Date.now() + 10_000;
    while (!(await answering(url)) && Date.now() < deadline && holder.exitCode === null) await new Promise(accept => setTimeout(accept, 100));
    assert.equal(await answering(url), true, 'the foreign holder answers the recorded port before the pass runs');
    const ports = managedServePorts({ root, baseBranch: 'main', run: defaultChildRun });

    // The started serve exits without binding: the pass records the commit as failed, with a
    // reason naming the port — not as served, with no case run against the holder.
    assert.equal(await serveOnce(serveRecordPath(root), ports, () => {}), 'failed');
    const record = readServeRecord(serveRecordPath(root));
    assert.equal(record?.failed, tip);
    assert.equal(record?.commit, null);
    assert.match(record?.reason ?? '', new RegExp(`port ${port}`));
    assert.equal(record?.check ?? null, null);
    // The holder keeps the port: the pass stopped nothing it did not start.
    assert.equal(await answering(url), true);
  } finally { holder.kill('SIGKILL'); }
});
