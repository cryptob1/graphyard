import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { supervise } from '../src/supervisor.js';

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const renewal = (duration = 2000) => ({ updatedAt: new Date().toISOString(), lease: { epoch: 1, expiresAt: new Date(Date.now() + duration).toISOString() } });

test('installed CLI resolves its runtime from another repository and includes submitted rework in next', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'graphyard cli '));
  const http = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify([{ id: 'rework', stage: 'build', ready: true, reworkRequested: true, submission: { pr: 1 }, dependencies: [], priority: 1 }])); });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
  try {
    assert.match((await exec(process.execPath, [launcher, '--help'], { cwd })).stdout, /Graphyard 0.1/);
    const { stdout } = await exec(process.execPath, [launcher, 'next'], { cwd, env: { ...process.env, GRAPHYARD_TOKEN: 'test-only', GRAPHYARD_URL: `http://127.0.0.1:${(http.address() as any).port}` } });
    assert.equal(JSON.parse(stdout)[0].id, 'rework');
  } finally { await new Promise<void>(r => http.close(() => r())); await rm(cwd, { recursive: true, force: true }); }
});

test('watch refuses the wrong workspace and uses a fresh heartbeat key despite command retry configuration', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'graphyard-watch-'));
  let registeredPath = tmpdir(); const keys: string[] = [];
  const http = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') { keys.push(String(req.headers['idempotency-key'])); res.end(JSON.stringify(renewal())); }
    else res.end(JSON.stringify([{ id: 'task', key: 'GY-1', workspaces: [{ epoch: 1, host: hostname(), path: registeredPath }] }]));
  });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
  const env = { ...process.env, GRAPHYARD_HOST_ID: hostname(), GRAPHYARD_TOKEN: 'test-only', GRAPHYARD_REQUEST_ID: 'replayed-command', GRAPHYARD_URL: `http://127.0.0.1:${(http.address() as any).port}` };
  try {
    await assert.rejects(exec(process.execPath, [launcher, 'watch', 'GY-1', '1', '--', process.execPath, '-e', 'process.exit(0)'], { cwd, env }), /assigned workspace/);
    assert.equal(keys.length, 0); registeredPath = cwd;
    await exec(process.execPath, [launcher, 'watch', 'GY-1', '1', '--', process.execPath, '-e', 'process.exit(0)'], { cwd, env });
    assert.equal(keys.length, 1); assert.notEqual(keys[0], 'replayed-command');
  } finally { await new Promise<void>(r => http.close(() => r())); await rm(cwd, { recursive: true, force: true }); }
});

test('supervisor stops a worker when renewal hangs beyond the granted lease', async () => {
  let count = 0; const started = performance.now();
  const code = await supervise(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},20)"], 1,
    async () => ++count === 1 ? renewal(200) : new Promise(() => {}), { intervalMs: 25, graceMs: 50 });
  assert.equal(code, 1); assert.equal(count, 2); assert.ok(performance.now() - started < 2000);
});

test('supervisor kills surviving descendants even after their group leader exits successfully', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'graphyard-descendants-')), output = join(cwd, 'ticks');
  const descendant = `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); fs.appendFileSync(${JSON.stringify(output)},'.'); process.send('ready'); setInterval(()=>fs.appendFileSync(${JSON.stringify(output)},'.'),10)`;
  const leader = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']}); c.on('message',()=>process.exit(0))`;
  try {
    assert.equal(await supervise(process.execPath, ['-e', leader], 1, async () => renewal(), { intervalMs: 100, graceMs: 75 }), 0);
    await delay(50); const stopped = await readFile(output, 'utf8'); await delay(75);
    assert.equal(await readFile(output, 'utf8'), stopped);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
