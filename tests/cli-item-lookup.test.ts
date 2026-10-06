import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));

// One case per proof: integration:cli-resolves-one-item (GY-1377).
test('integration:cli-resolves-one-item — claim, heartbeat and status resolve their item through GET /api/work/:id, never the whole fleet, and an unknown key is refused as before', async () => {
  const cwd = await temporaryDirectory('cli-one-item');
  const work = { id: 'task-id', key: 'GY-7', revision: 3, stage: 'build' };
  const requests: string[] = [];
  const http = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    for await (const _ of req) { /* drain */ }
    res.setHeader('Content-Type', 'application/json');
    const path = req.url!.split('?')[0];
    // The fleet read fails outright: a command that still depended on it could not succeed.
    if (path === '/api/work') { res.statusCode = 500; return res.end(JSON.stringify({ error: 'fleet read unavailable' })); }
    if (req.method === 'GET' && (path === '/api/work/GY-7' || path === '/api/work/task-id')) return res.end(JSON.stringify(work));
    if (req.method === 'GET' && path.startsWith('/api/work/')) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'Work item not found' })); }
    if (req.method === 'GET' && path === '/api/retro/standing') return res.end(JSON.stringify({ standing: [] }));
    if (req.method === 'POST' && path === '/api/work/task-id/claim') return res.end(JSON.stringify({ epoch: 1 }));
    if (req.method === 'POST' && path === '/api/work/task-id/heartbeat') return res.end(JSON.stringify({ epoch: 1, expiresAt: '2026-01-01T00:02:00Z' }));
    res.statusCode = 404; res.end(JSON.stringify({ error: 'unexpected' }));
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, GRAPHYARD_TOKEN: 'worker-token', GRAPHYARD_TOKEN_FILE: undefined, GRAPHYARD_REQUEST_ID: undefined, GRAPHYARD_URL: `http://127.0.0.1:${(http.address() as any).port}` };
  try {
    assert.deepEqual(JSON.parse((await exec(process.execPath, [launcher, 'claim', 'GY-7'], { cwd, env })).stdout), { epoch: 1 });
    assert.equal(JSON.parse((await exec(process.execPath, [launcher, 'heartbeat', 'GY-7', '1'], { cwd, env })).stdout).epoch, 1);
    assert.equal(JSON.parse((await exec(process.execPath, [launcher, 'status', 'task-id'], { cwd, env })).stdout).key, 'GY-7');
    await assert.rejects(exec(process.execPath, [launcher, 'status', 'GY-404'], { cwd, env }), (error: any) => /Unknown work item GY-404/.test(error.stderr) && error.code === 1);
    await assert.rejects(exec(process.execPath, [launcher, 'claim', 'GY-404'], { cwd, env }), (error: any) => /Unknown work item GY-404/.test(error.stderr));
    assert.ok(!requests.some(line => /^GET \/api\/work(\?|$)/.test(line)), `GET /api/work was requested: ${requests.join(', ')}`);
    assert.ok(requests.includes('GET /api/work/GY-7') && requests.includes('GET /api/work/task-id') && requests.includes('GET /api/work/GY-404'));
    assert.ok(requests.includes('POST /api/work/task-id/claim') && requests.includes('POST /api/work/task-id/heartbeat'));
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); await rm(cwd, { recursive: true, force: true }); }
});
