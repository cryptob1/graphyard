import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { executionAttestationPayload } from '../src/runner-collector.js';
import { captureTrackedRoot, linuxProcessRecord, signalTrackedProcesses, supervise, systemdContainment } from '../src/supervisor.js';
import { acknowledgeContainment, containmentCredentials, establishContainment, isConfirmedCoordinationRefusal, revalidateContainment, settleContainment } from '../src/quarantine.js';

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const renewal = (duration = 2000) => ({ updatedAt: new Date().toISOString(), lease: { epoch: 1, expiresAt: new Date(Date.now() + duration).toISOString() } });
const hasSystemdUserScope = process.platform === 'linux' && spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' }).status === 0;

test('quarantine establishment reconciles a committed lost response with the same parent-only capability and request key', async () => {
  const first = containmentCredentials(), second = containmentCredentials();
  assert.notEqual(second.settlementToken, first.settlementToken, 'capabilities are random and invocation-local');
  assert.notEqual(second.requestId, first.requestId, 'request keys are stable only within one bounded attempt');
  const keys: string[] = []; let committed: any; let calls = 0;
  const result = await establishContainment(async requestId => {
    keys.push(requestId); calls++;
    committed ??= { exclusiveResources: ['staging'], containmentQuarantine: { owner: 'worker-a', epoch: 7, settlementHash: first.settlementHash } };
    if (calls === 1) throw new TypeError('response terminated after commit');
    return committed;
  }, { epoch: 7, settlementHash: first.settlementHash, exclusiveResources: ['staging'], requestId: first.requestId }, { attempts: 2, retryMs: 0 });
  assert.equal(result, committed); assert.deepEqual(keys, [first.requestId, first.requestId]);
});

test('quarantine establishment never confirms a mismatched fence or retries a server refusal', async () => {
  const expected = { ...containmentCredentials(), epoch: 8, exclusiveResources: ['database'] }; let calls = 0;
  await assert.rejects(establishContainment(async () => ({ exclusiveResources: [], containmentQuarantine: { epoch: 8, settlementHash: expected.settlementHash } }),
    expected, { attempts: 2, retryMs: 0 }), /could not confirm.*mismatched/);
  const refusal = Object.assign(new Error('lease expired'), { confirmedRefusal: true });
  await assert.rejects(establishContainment(async () => { calls++; throw refusal; }, expected), /lease expired/);
  assert.equal(calls, 1);
});

test('launch acknowledgement reconciles a committed lost response with one durable request', async () => {
  const credentials = containmentCredentials();
  const expected = { principal: 'worker-a', epoch: 7, settlementHash: credentials.settlementHash, exclusiveResources: ['staging'], requestId: credentials.requestId };
  const keys: string[] = []; let calls = 0;
  const acknowledged = { updatedAt: '2030-01-01T00:00:00Z', lease: { owner: 'worker-a', epoch: 7, expiresAt: '2030-01-01T00:01:00Z' }, exclusiveResources: ['staging'], containmentQuarantine: { epoch: 7, settlementHash: credentials.settlementHash, launchAcknowledgedAt: '2030-01-01T00:00:00Z', launchExpiresAt: '2030-01-01T00:02:00Z' } };
  const result = await acknowledgeContainment(async key => {
    keys.push(key);
    if (++calls === 1) throw new TypeError('response lost after commit');
    return acknowledged;
  }, expected, { attempts: 2, retryMs: 0 });
  assert.equal(result, acknowledged); assert.deepEqual(keys, [expected.requestId, expected.requestId]);
});

test('launch acknowledgement binds owner and epoch and requires lease lifetime through response arrival', async () => {
  const credentials = containmentCredentials();
  const expected = { principal: 'worker-a', epoch: 17, settlementHash: credentials.settlementHash, exclusiveResources: [], requestId: credentials.requestId };
  const healthy = { updatedAt: '2030-01-01T00:00:00.000Z', lease: { owner: 'worker-a', epoch: 17, expiresAt: '2030-01-01T00:00:01.000Z' }, exclusiveResources: [], containmentQuarantine: { epoch: 17, settlementHash: credentials.settlementHash, launchAcknowledgedAt: '2030-01-01T00:00:00.000Z', launchExpiresAt: '2030-01-01T00:02:00.000Z' } };
  for (const response of [
    { ...healthy, lease: { ...healthy.lease, owner: 'worker-b' } },
    { ...healthy, lease: { ...healthy.lease, epoch: 16 } },
  ]) await assert.rejects(acknowledgeContainment(async () => response, expected, { attempts: 1 }), /mismatched/);
  for (const [expiresAt, elapsed] of [['2030-01-01T00:00:00.000Z', 0], ['2030-01-01T00:00:01.000Z', 1000]] as const) {
    let monotonic = 0;
    await assert.rejects(acknowledgeContainment(async () => { monotonic = elapsed; return { ...healthy, lease: { ...healthy.lease, expiresAt } }; }, expected,
      { attempts: 1, monotonicNow: () => monotonic }), /worker lease expired/);
  }
  let monotonic = 0;
  const result = await acknowledgeContainment(async () => { monotonic = 999; return healthy; }, expected, { attempts: 1, monotonicNow: () => monotonic });
  assert.equal(result, healthy);
  monotonic = 0;
  await assert.rejects(acknowledgeContainment(async () => {
    monotonic = 120_000;
    return { ...healthy, lease: { ...healthy.lease, expiresAt: '2030-01-01T00:03:20.000Z' } };
  }, expected, { attempts: 1, monotonicNow: () => monotonic }), /launch authority expired/);
});

test('fresh prelaunch state rejects stale receipt replay, expiry, workspace and resource mutation', () => {
  const credentials = containmentCredentials();
  const workspace = { owner: 'worker-a', epoch: 7, host: 'host-a', path: '/work/GY-7', branch: 'graphyard/gy-7-7' };
  const expected = { workId: 'work-7', principal: 'worker-a', epoch: 7, settlementHash: credentials.settlementHash, exclusiveResources: ['staging'], workspace };
  const work = { id: 'work-7', lease: { owner: 'worker-a', epoch: 7, expiresAt: '2030-01-01T00:02:00Z' }, workspaces: [workspace], exclusiveResources: ['staging'], containmentQuarantine: { owner: 'worker-a', epoch: 7, at: '2030-01-01T00:00:00Z', settlementHash: credentials.settlementHash } } as any;
  const snapshot = (value = work, now = '2030-01-01T00:01:00Z') => ({ now, work: [value] });
  assert.equal(revalidateContainment(snapshot(), expected), work);
  for (const stale of [
    { ...work, lease: { owner: 'worker-b', epoch: 8, expiresAt: '2030-01-01T00:03:00Z' }, containmentQuarantine: null },
    { ...work, lease: { ...work.lease, expiresAt: '2030-01-01T00:01:00Z' } },
  ]) assert.throws(() => revalidateContainment(snapshot(stale), expected), (error: any) => error.settleAllowed === false);
  assert.throws(() => revalidateContainment(snapshot({ ...work, workspaces: [{ ...workspace, path: '/work/mutated' }] }), expected), (error: any) => error.settleAllowed === true);
  assert.throws(() => revalidateContainment(snapshot({ ...work, exclusiveResources: ['production'] }), expected), (error: any) => error.settleAllowed === true);
  assert.throws(() => revalidateContainment({ now: 'ambiguous', work: [work] }, expected), (error: any) => error.settleAllowed === false);
});

test('stale quarantine replay never launches or settles against another owner', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'graphyard-stale-replay-')), marker = join(cwd, 'launched');
  const containment = { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'yes')`], signal: () => {}, empty: () => true };
  let settlements = 0;
  try {
    await assert.rejects(supervise('ignored', [], 7, async () => ({ ...renewal(), lease: { ...renewal().lease, epoch: 7 } }), { containment, detached: false, quarantine: {
      establish: async () => ({ containmentQuarantine: { owner: 'worker-a', epoch: 7 } }),
      revalidate: async () => { throw Object.assign(new Error('fresh owner is worker-b epoch 8'), { settleAllowed: false }); },
      settle: async () => { settlements++; },
    } }), /fresh owner is worker-b epoch 8/);
    await assert.rejects(stat(marker), { code: 'ENOENT' }); assert.equal(settlements, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('authorized prelaunch mismatch settles once without launching', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'graphyard-owned-mismatch-')), marker = join(cwd, 'launched');
  const containment = { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'yes')`], signal: () => {}, empty: () => true };
  let settlements = 0;
  try {
    await assert.rejects(supervise('ignored', [], 7, async () => ({ ...renewal(), lease: { ...renewal().lease, epoch: 7 } }), { containment, detached: false, quarantine: {
      establish: async () => {},
      revalidate: async () => { throw Object.assign(new Error('workspace changed'), { settleAllowed: true }); },
      settle: async () => { settlements++; },
    } }), /workspace changed/);
    await assert.rejects(stat(marker), { code: 'ENOENT' }); assert.equal(settlements, 1);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('HTTP 408 and 429 remain ambiguous while known coordination refusals are definitive', async () => {
  const credentials = containmentCredentials();
  const expected = { epoch: 5, settlementHash: credentials.settlementHash, exclusiveResources: ['staging'], requestId: credentials.requestId };
  const keys: string[] = []; let calls = 0;
  const established = await establishContainment(async key => {
    keys.push(key); calls++;
    if (calls < 3) {
      const status = calls === 1 ? 408 : 429, body = { error: 'ambiguous proxy response' };
      throw Object.assign(new Error(body.error), { confirmedRefusal: isConfirmedCoordinationRefusal(status, body) });
    }
    return { exclusiveResources: expected.exclusiveResources, containmentQuarantine: { epoch: expected.epoch, settlementHash: expected.settlementHash } };
  }, expected, { attempts: 3, retryMs: 0 });
  assert.equal(established.containmentQuarantine.epoch, 5);
  assert.deepEqual(keys, [credentials.requestId, credentials.requestId, credentials.requestId]);

  const settlementKey = 'stable-settlement-key', bodies: unknown[] = []; calls = 0;
  await settleContainment(async (key, body) => {
    assert.equal(key, settlementKey); bodies.push(body); calls++;
    if (calls < 3) {
      const status = calls === 1 ? 429 : 408, response = { error: 'ambiguous gateway response' };
      throw Object.assign(new Error(response.error), { confirmedRefusal: isConfirmedCoordinationRefusal(status, response) });
    }
    return { epoch: 5, exclusiveResources: expected.exclusiveResources, containmentQuarantine: null };
  }, { ...expected, settlementToken: credentials.settlementToken, requestId: settlementKey }, { attempts: 3, retryMs: 0 });
  assert.equal(bodies.length, 3); assert.equal(bodies[0], bodies[1]); assert.equal(bodies[1], bodies[2]);
  assert.equal(isConfirmedCoordinationRefusal(409, { error: 'lease expired' }), true);
  assert.equal(isConfirmedCoordinationRefusal(409, { error: { code: 'lease_conflict', message: 'lease expired' } }), true);
  assert.equal(isConfirmedCoordinationRefusal(400, { message: 'not a Graphyard refusal' }), false);
  assert.equal(isConfirmedCoordinationRefusal(409, { error: { message: 'proxy-generated body' } }), false);
  assert.equal(isConfirmedCoordinationRefusal(429, { error: { code: 'rate_limited', message: 'try later' } }), false);
});

test('containment settlement replays a committed lost response with an identical key and body', async () => {
  const credentials = containmentCredentials(); const keys: string[] = []; const bodies: unknown[] = []; let calls = 0;
  const settled = { epoch: 7, exclusiveResources: ['staging'], containmentQuarantine: null };
  assert.equal(await settleContainment(async (key, body) => {
    keys.push(key); bodies.push(body); calls++;
    if (calls === 1) throw new TypeError('response terminated after commit');
    return settled;
  }, { epoch: 7, settlementToken: credentials.settlementToken, settlementHash: credentials.settlementHash, exclusiveResources: ['staging'], requestId: credentials.requestId }, { attempts: 2, retryMs: 0 }), settled);
  assert.deepEqual(keys, [credentials.requestId, credentials.requestId]);
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(bodies[0], { epoch: 7, settlementToken: credentials.settlementToken });
});

test('containment settlement retries a transient pre-commit failure with an identical request', async () => {
  const credentials = containmentCredentials(); const observations: Array<[string, unknown]> = []; let calls = 0;
  await settleContainment(async (key, body) => {
    observations.push([key, body]);
    if (++calls === 1) throw new TypeError('connection refused before commit');
    return { epoch: 4, exclusiveResources: ['database'], containmentQuarantine: null };
  }, { epoch: 4, settlementToken: credentials.settlementToken, settlementHash: credentials.settlementHash, exclusiveResources: ['database'], requestId: credentials.requestId }, { attempts: 2, retryMs: 0 });
  assert.equal(observations.length, 2); assert.equal(observations[0][0], observations[1][0]); assert.equal(observations[0][1], observations[1][1]);
});

test('containment settlement does not retry confirmed refusal and fails closed on mismatched reconciliation', async () => {
  const credentials = containmentCredentials(); const expected = { epoch: 3, settlementToken: credentials.settlementToken, settlementHash: credentials.settlementHash, exclusiveResources: ['staging'], requestId: credentials.requestId };
  let calls = 0; const refusal = Object.assign(new Error('capability refused'), { confirmedRefusal: true });
  await assert.rejects(settleContainment(async () => { calls++; throw refusal; }, expected), /capability refused/);
  assert.equal(calls, 1);
  await assert.rejects(settleContainment(async () => ({ epoch: 2, exclusiveResources: [], containmentQuarantine: null }), expected, { attempts: 2, retryMs: 0 }), /could not confirm.*mismatched/);
  await assert.rejects(settleContainment(async () => ({ epoch: 3, exclusiveResources: ['staging'], containmentQuarantine: null }), { ...expected, settlementHash: 'f'.repeat(64) }), /capability does not match/);
});

test('containment settlement bounds persistent ambiguity after one child launch without capability leakage', async () => {
  const credentials = containmentCredentials(); const cwd = await mkdtemp(join(tmpdir(), 'graphyard-settlement-')); const launches = join(cwd, 'launches'); let attempts = 0;
  const baselineInt = process.listenerCount('SIGINT'), baselineTerm = process.listenerCount('SIGTERM');
  const child = `const fs=require('node:fs'),crypto=require('node:crypto');const hash=${JSON.stringify(credentials.settlementHash)};if(Object.values(process.env).some(value=>crypto.createHash('sha256').update(value??'').digest('hex')===hash))process.exit(91);fs.appendFileSync(${JSON.stringify(launches)},'launched\\n')`;
  const containment = { command: process.execPath, args: ['-e', child], signal: () => {}, empty: () => true };
  try {
    await assert.rejects(supervise('ignored', [], 9, async () => ({ ...renewal(), lease: { ...renewal().lease, epoch: 9 } }), { containment, detached: false, graceMs: 1, quarantine: {
      establish: async () => {},
      settle: () => settleContainment(async (_key, body) => {
        attempts++; assert.equal(body.settlementToken, credentials.settlementToken);
        assert.equal(process.listenerCount('SIGINT'), baselineInt + 1); assert.equal(process.listenerCount('SIGTERM'), baselineTerm + 1);
        process.emit(attempts % 2 ? 'SIGINT' : 'SIGTERM', attempts % 2 ? 'SIGINT' : 'SIGTERM');
        throw new TypeError('response unavailable');
      },
        { epoch: 9, settlementToken: credentials.settlementToken, settlementHash: credentials.settlementHash, exclusiveResources: [], requestId: credentials.requestId }, { attempts: 3, retryMs: 0 }),
    } }), /could not confirm containment settlement after 3 attempts/);
    assert.equal(attempts, 3); assert.equal(await readFile(launches, 'utf8'), 'launched\n');
    assert.equal(process.listenerCount('SIGINT'), baselineInt); assert.equal(process.listenerCount('SIGTERM'), baselineTerm);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a prelaunch signal reconciles and settles a committed quarantine without launching a child', async () => {
  const credentials = containmentCredentials();
  const expected = { epoch: 9, settlementHash: credentials.settlementHash, exclusiveResources: ['staging'], requestId: credentials.requestId };
  const cwd = await mkdtemp(join(tmpdir(), 'graphyard-prelaunch-signal-')), marker = join(cwd, 'launched');
  const baselineInt = process.listenerCount('SIGINT'), baselineTerm = process.listenerCount('SIGTERM');
  const establishKeys: string[] = [], settleKeys: string[] = []; const settleBodies: unknown[] = [];
  let establishCalls = 0, settleCalls = 0;
  const committed = { exclusiveResources: expected.exclusiveResources, containmentQuarantine: { epoch: expected.epoch, settlementHash: expected.settlementHash } };
  const containment = {
    command: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, Object.values(process.env).join('\\n'))`],
    signal: () => assert.fail('no worker exists to signal'),
    empty: () => assert.fail('no worker containment needs verification'),
  };
  try {
    assert.equal(await supervise('ignored', [], 9, async () => ({ ...renewal(), lease: { ...renewal().lease, epoch: 9 } }), { containment, detached: false, quarantine: {
      establish: () => establishContainment(async key => {
        establishCalls++;
        assert.equal(process.listenerCount('SIGINT'), baselineInt + 1); assert.equal(process.listenerCount('SIGTERM'), baselineTerm + 1);
        if (establishCalls === 1) process.emit('SIGINT', 'SIGINT'); // Interrupted before the request is sent.
        establishKeys.push(key);
        if (establishCalls === 1) { process.emit('SIGTERM', 'SIGTERM'); throw new TypeError('committed response was lost'); }
        return committed;
      }, expected, { attempts: 3, retryMs: 0 }),
      settle: () => settleContainment(async (key, body) => {
        settleKeys.push(key); settleBodies.push(body); settleCalls++;
        assert.equal(process.listenerCount('SIGINT'), baselineInt + 1); assert.equal(process.listenerCount('SIGTERM'), baselineTerm + 1);
        process.emit(settleCalls % 2 ? 'SIGTERM' : 'SIGINT', settleCalls % 2 ? 'SIGTERM' : 'SIGINT');
        if (settleCalls < 3) {
          const status = settleCalls === 1 ? 408 : 429, response = { error: 'ambiguous gateway response' };
          throw Object.assign(new Error(response.error), { confirmedRefusal: isConfirmedCoordinationRefusal(status, response) });
        }
        return { epoch: expected.epoch, exclusiveResources: expected.exclusiveResources, containmentQuarantine: null };
      }, { ...expected, settlementToken: credentials.settlementToken, requestId: 'stable-prelaunch-settlement' }, { attempts: 3, retryMs: 0 }),
    } }), 1);
    assert.deepEqual(establishKeys, [credentials.requestId, credentials.requestId]);
    assert.deepEqual(settleKeys, Array(3).fill('stable-prelaunch-settlement'));
    assert.equal(settleBodies[0], settleBodies[1]); assert.equal(settleBodies[1], settleBodies[2]);
    assert.deepEqual(settleBodies[0], { epoch: 9, settlementToken: credentials.settlementToken });
    await assert.rejects(stat(marker), { code: 'ENOENT' });
    assert.equal(process.listenerCount('SIGINT'), baselineInt); assert.equal(process.listenerCount('SIGTERM'), baselineTerm);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a prelaunch signal fails closed on persistent establishment ambiguity and cleans up handlers', async () => {
  const credentials = containmentCredentials(); const expected = { epoch: 6, settlementHash: credentials.settlementHash, exclusiveResources: [], requestId: credentials.requestId };
  const cwd = await mkdtemp(join(tmpdir(), 'graphyard-prelaunch-ambiguous-')), marker = join(cwd, 'launched');
  const baselineInt = process.listenerCount('SIGINT'), baselineTerm = process.listenerCount('SIGTERM');
  let attempts = 0, settlements = 0;
  const containment = { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'yes')`], signal: () => {}, empty: () => true };
  try {
    await assert.rejects(supervise('ignored', [], 6, async () => ({ ...renewal(), lease: { ...renewal().lease, epoch: 6 } }), { containment, detached: false, quarantine: {
      establish: () => establishContainment(async key => {
        assert.equal(key, credentials.requestId); attempts++;
        assert.equal(process.listenerCount('SIGINT'), baselineInt + 1); assert.equal(process.listenerCount('SIGTERM'), baselineTerm + 1);
        process.emit(attempts % 2 ? 'SIGINT' : 'SIGTERM', attempts % 2 ? 'SIGINT' : 'SIGTERM');
        throw new TypeError('response unavailable');
      }, expected, { attempts: 3, retryMs: 0 }),
      settle: async () => { settlements++; },
    } }), /could not confirm containment quarantine establishment after 3 attempts/);
    assert.equal(attempts, 3); assert.equal(settlements, 0); await assert.rejects(stat(marker), { code: 'ENOENT' });
    assert.equal(process.listenerCount('SIGINT'), baselineInt); assert.equal(process.listenerCount('SIGTERM'), baselineTerm);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('foreground establishment refusal removes prelaunch signal handlers without launching', async () => {
  const baselineInt = process.listenerCount('SIGINT'), baselineTerm = process.listenerCount('SIGTERM');
  const refusal = Object.assign(new Error('lease expired'), { confirmedRefusal: true });
  const containment = { command: 'ignored', args: [], signal: () => {}, empty: () => true };
  await assert.rejects(supervise('ignored', [], 1, async () => renewal(), { containment, detached: false, quarantine: { establish: async () => { throw refusal; }, settle: async () => {} } }), /lease expired/);
  assert.equal(process.listenerCount('SIGINT'), baselineInt); assert.equal(process.listenerCount('SIGTERM'), baselineTerm);
});

test('master-only commands ignore an unrelated unavailable worker token file', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'graphyard-master-lazy-token-'));
  try {
    await exec('git', ['init', '-q'], { cwd });
    await mkdir(join(cwd, '.graphyard')); await writeFile(join(cwd, '.graphyard/connection.json'), '{broken', { mode: 0o644 });
    const result = await exec(process.execPath, [launcher, 'master', 'guide'], { cwd, env: { ...process.env, GRAPHYARD_TOKEN_FILE: join(cwd, 'removed-worker.token'), GRAPHYARD_HOST_ID: '   ' } });
    assert.match(result.stdout, /Master-agent operating mode/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('installed CLI resolves its runtime from another repository and includes submitted rework in next using the work snapshot clock', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'graphyard cli '));
  const http = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({now:'2026-01-01T00:01:00Z',work:[{ id: 'rework', stage: 'build', ready: true, reworkRequested: true, submission: { pr: 1 }, dependencies: [], priority: 1 },{id:'active',stage:'build',ready:true,dependencies:[],priority:1,lease:{expiresAt:'2026-01-01T00:02:00Z'}},{id:'expired',stage:'build',ready:true,dependencies:[],priority:1,lease:{expiresAt:'2026-01-01T00:00:00Z'}},{id:'quarantined',key:'GY-Q',stage:'build',ready:true,dependencies:[],priority:1,exclusiveResources:['staging'],lease:{expiresAt:'2026-01-01T00:00:00Z'},containmentQuarantine:{epoch:1}},{id:'shared',stage:'ready',ready:true,dependencies:[],priority:1,exclusiveResources:['staging']},{id:'unrelated',stage:'ready',ready:true,dependencies:[],priority:1,exclusiveResources:['other']}]})); });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
  try {
    assert.match((await exec(process.execPath, [launcher, '--help'], { cwd })).stdout, /Graphyard 0.1/);
    const { stdout } = await exec(process.execPath, [launcher, 'next'], { cwd, env: { ...process.env, GRAPHYARD_TOKEN: 'test-only', GRAPHYARD_URL: `http://127.0.0.1:${(http.address() as any).port}` } });
    assert.deepEqual(JSON.parse(stdout).map((w:any)=>w.id), ['rework','expired','unrelated']);
  } finally { await new Promise<void>(r => http.close(() => r())); await rm(cwd, { recursive: true, force: true }); }
});

test('CLI preserves admin ready and sends the current revision and audit reason for scoped mutations', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'graphyard-operator-cli-'));
  const requests: { url: string; body: any }[] = [];
  const work = { id: 'task-id', key: 'GY-7', revision: 12 };
  const http = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') return res.end(JSON.stringify([work]));
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url!, body: JSON.parse(raw) }); res.end(JSON.stringify(work));
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, GRAPHYARD_TOKEN: 'operator-token', GRAPHYARD_URL: `http://127.0.0.1:${(http.address() as any).port}` };
  try {
    await exec(process.execPath, [launcher, 'ready', 'GY-7'], { cwd, env });
    await exec(process.execPath, [launcher, 'ready', 'GY-7', 'Requirements', 'approved'], { cwd, env });
    await exec(process.execPath, [launcher, 'unblock', 'GY-7', 'Dependency', 'resolved'], { cwd, env });
    assert.deepEqual(requests, [
      { url: '/api/work/task-id/ready', body: {} },
      { url: '/api/work/task-id/ready', body: { expectedRevision: 12, reason: 'Requirements approved' } },
      { url: '/api/work/task-id/unblock', body: { expectedRevision: 12, reason: 'Dependency resolved' } },
    ]);
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); await rm(cwd, { recursive: true, force: true }); }
});

test('watch refuses the wrong workspace and uses a fresh heartbeat key despite command retry configuration', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'graphyard-watch-'));
  let registeredPath = tmpdir(), role = 'worker'; const keys: string[] = [];
  const http = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/status') { res.end(JSON.stringify({ actor: { role } })); return; }
    if (req.method === 'POST') { keys.push(String(req.headers['idempotency-key'])); res.end(JSON.stringify(renewal())); }
    else res.end(JSON.stringify([{ id: 'task', key: 'GY-1', workspaces: [{ epoch: 1, host: hostname(), path: registeredPath }] }]));
  });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
  const env: NodeJS.ProcessEnv = { ...process.env, GRAPHYARD_HOST_ID: hostname(), GRAPHYARD_TOKEN: 'test-only', GRAPHYARD_REQUEST_ID: 'replayed-command', GRAPHYARD_URL: `http://127.0.0.1:${(http.address() as any).port}` };
  delete env.HERDR_ENV; delete env.GRAPHYARD_HERDR_AGENT_KIND;
  try {
    await assert.rejects(exec(process.execPath, [launcher, 'watch', 'GY-1', '1', '--', process.execPath, '-e', 'process.exit(0)'], { cwd, env }), /assigned workspace/);
    assert.equal(keys.length, 0); registeredPath = cwd;
    role = 'admin';
    await assert.rejects(exec(process.execPath, [launcher, 'watch', 'GY-1', '1', '--', process.execPath, '-e', 'process.exit(0)'], { cwd, env }), /requires a worker credential/);
    assert.equal(keys.length, 0); role = 'worker';
    await exec(process.execPath, [launcher, 'watch', 'GY-1', '1', '--', process.execPath, '-e', 'process.exit(0)'], { cwd, env });
    assert.equal(keys.length, 1); assert.notEqual(keys[0], 'replayed-command');
  } finally { await new Promise<void>(r => http.close(() => r())); await rm(cwd, { recursive: true, force: true }); }
});

test('implementation subprocesses do not inherit Graphyard server credentials', async () => {
  const previous = process.env.GRAPHYARD_PRINCIPALS;
  process.env.GRAPHYARD_PRINCIPALS = 'test-only-server-credential';
  try {
    const code = await supervise(process.execPath, ['-e', "process.exit(process.env.GRAPHYARD_PRINCIPALS === undefined ? 0 : 1)"], 1, async () => renewal(), { graceMs: 25 });
    assert.equal(code, 0);
  } finally { if (previous === undefined) delete process.env.GRAPHYARD_PRINCIPALS; else process.env.GRAPHYARD_PRINCIPALS = previous; }
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

test('foreground Herdr containment kills a descendant forked after SIGTERM and reparented', { skip: !hasSystemdUserScope }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'graphyard-foreground-descendants-')), output = join(cwd, 'ticks');
  const descendant = `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); fs.appendFileSync(${JSON.stringify(output)},'.'); setInterval(()=>fs.appendFileSync(${JSON.stringify(output)},'.'),10)`;
  const leader = `process.on('SIGTERM',()=>{require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});process.exit(0)});setInterval(()=>{},20)`;
  try {
    let renewals = 0;
    assert.equal(await supervise(process.execPath, ['-e', leader], 1, async () => ++renewals === 1 ? renewal(150) : new Promise(() => {}), { detached: false, intervalMs: 25, graceMs: 75, quarantine: { establish: async () => {}, settle: async () => {} } }), 1);
    await delay(50); const stopped = await readFile(output, 'utf8'); await delay(75);
    assert.equal(await readFile(output, 'utf8'), stopped);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('foreground fallback does not signal a reused descendant PID', () => {
  const tracked = new Map<number, string>(); const signalled: number[] = [];
  const initial = new Map([[100, { ppid: 1, identity: 'root-start' }], [101, { ppid: 100, identity: 'child-start' }]]);
  captureTrackedRoot(100, tracked, initial.get(100)!);
  signalTrackedProcesses(100, tracked, initial, 'SIGTERM', pid => { signalled.push(pid); });
  assert.deepEqual(signalled, [101, 100]); signalled.length = 0;
  signalTrackedProcesses(100, tracked, new Map([[101, { ppid: 55, identity: 'unrelated-start' }]]), 'SIGKILL', pid => { signalled.push(pid); });
  assert.deepEqual(signalled, []); assert.equal(tracked.has(101), false);
});

test('foreground fallback never enrolls an uncached initial root or its descendants', () => {
  const tracked = new Map<number, string>(); const signalled: number[] = [];
  const rows = new Map([[100, { ppid: 1, identity: 'reused-root' }], [101, { ppid: 100, identity: 'unrelated-child' }]]);
  signalTrackedProcesses(100, tracked, rows, 'SIGKILL', pid => { signalled.push(pid); });
  assert.deepEqual(signalled, []);
  assert.deepEqual([...tracked], []);
});

test('foreground fallback with an exited cached root cannot adopt a reused root or descendant', () => {
  const tracked = new Map<number, string>([[100, 'original-root']]); const signalled: number[] = [];
  const rows = new Map([[100, { ppid: 1, identity: 'replacement-root' }], [101, { ppid: 100, identity: 'replacement-child' }]]);
  signalTrackedProcesses(100, tracked, rows, 'SIGKILL', pid => { signalled.push(pid); });
  assert.deepEqual(signalled, []);
  assert.deepEqual([...tracked], []);
});

test('foreground fallback does not traverse descendants of a reused cached parent PID', () => {
  const tracked = new Map<number, string>([[100, 'root-start'], [101, 'child-start']]); const signalled: number[] = [];
  const rows = new Map([[100, { ppid: 1, identity: 'root-start' }], [101, { ppid: 55, identity: 'reused-start' }], [102, { ppid: 101, identity: 'unrelated-child-start' }]]);
  signalTrackedProcesses(100, tracked, rows, 'SIGKILL', pid => { signalled.push(pid); });
  assert.deepEqual(signalled, [100]);
  assert.deepEqual([...tracked], [[100, 'root-start']]);
});

test('Linux process identity uses the kernel start-time field without one-second collisions', () => {
  const stat = (start: string, name = 'worker (nested) name') => `123 (${name}) S 42 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${start} 0`;
  assert.deepEqual(linuxProcessRecord(stat('987654321')), { ppid: 42, identity: '987654321' });
  assert.notEqual(linuxProcessRecord(stat('987654321'))?.identity, linuxProcessRecord(stat('987654322'))?.identity);
  assert.equal(linuxProcessRecord('malformed'), null);
});

test('systemd containment propagates unavailable or failing scope kills', () => {
  const calls: string[][] = [];
  const containment = systemdContainment('worker', [], ((command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (args.includes('kill')) throw new Error('systemctl unavailable');
    return '';
  }) as any);
  assert.throws(() => containment.signal('SIGKILL'), /systemctl unavailable/);
  assert.ok(calls.some(call => call.includes('kill')));
});

test('systemd containment recognizes only a specifically unloaded scope after a failed query', () => {
  let mode: 'unloaded' | 'manager' | 'active' = 'unloaded';
  const containment = systemdContainment('worker', [], ((command: string, args: string[]) => {
    if (args.includes('show-environment')) return '';
    if (mode === 'unloaded') throw Object.assign(new Error('scope disappeared'), { status: 1, stdout: 'LoadState=not-found\nActiveState=inactive\n' });
    if (mode === 'manager') throw Object.assign(new Error('Failed to connect to bus'), { status: 1, stdout: '' });
    return 'LoadState=loaded\nActiveState=active\n';
  }) as any);
  assert.equal(containment.empty(), true);
  mode = 'manager'; assert.throws(() => containment.empty(), /connect to bus/);
  mode = 'active'; assert.equal(containment.empty(), false);
});

test('unloaded-scope fallback cannot signal a replacement for an uncached exited root', () => {
  const containment = systemdContainment('worker', [], ((command: string, args: string[]) => {
    if (args.includes('show-environment')) return '';
    if (args.includes('kill')) throw new Error('scope unloaded before signal');
    return 'LoadState=not-found\nActiveState=inactive\n';
  }) as any);
  const tracked = new Map<number, string>(); const signalled: number[] = [];
  assert.throws(() => containment.signal('SIGKILL'), /scope unloaded/);
  signalTrackedProcesses(100, tracked, new Map([[100, { ppid: 1, identity: 'replacement' }], [101, { ppid: 100, identity: 'replacement-child' }]]), 'SIGKILL', pid => { signalled.push(pid); });
  assert.deepEqual(signalled, []);
  assert.equal(containment.empty(), true);
});

test('systemd containment polls active and deactivating states before clean unloaded-scope settlement', async () => {
  const states = ['active', 'deactivating']; let settled = 0;
  const containment = systemdContainment(process.execPath, ['-e', 'process.exit(0)'], ((command: string, args: string[]) => {
    if (args.includes('show-environment') || args.includes('kill')) return '';
    const state = states.shift();
    if (state) return `LoadState=loaded\nActiveState=${state}\n`;
    throw Object.assign(new Error('unit not found'), { status: 1, stdout: 'LoadState=not-found\nActiveState=inactive\n' });
  }) as any);
  assert.equal(await supervise('ignored', [], 1, async () => renewal(), { containment, detached: false, graceMs: 10, shutdownPollMs: 1, shutdownTimeoutMs: 100, quarantine: { establish: async () => {}, settle: async () => { settled++; } } }), 0);
  assert.equal(states.length, 0); assert.equal(settled, 1);
});

test('supervisor fails closed when a scope kill fails and shutdown cannot be verified', async () => {
  const containment = {
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    signal: () => { throw new Error('scope kill failed'); },
    empty: () => false,
  };
  let established = 0, settled = 0;
  await assert.rejects(supervise('ignored', [], 1, async () => renewal(), { containment, detached: false, graceMs: 10, shutdownPollMs: 1, shutdownTimeoutMs: 5, quarantine: { establish: async () => { established++; }, settle: async () => { settled++; } } }), /shutdown could not be verified: scope kill failed/);
  assert.equal(established, 1); assert.equal(settled, 0, 'an unverifiable shutdown must retain its durable quarantine');
});

test('supervisor accepts a failed scope signal only when the scope is verified empty', async () => {
  const containment = {
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    signal: () => { throw new Error('scope already gone'); },
    empty: () => true,
  };
  let established = 0, settled = 0;
  assert.equal(await supervise('ignored', [], 1, async () => renewal(), { containment, detached: false, graceMs: 10, quarantine: { establish: async () => { established++; }, settle: async () => { settled++; } } }), 0);
  assert.equal(established, 1); assert.equal(settled, 1);
});

test('supervisor polls a stopping scope after SIGKILL before settling quarantine', async () => {
  let reads = 0, settled = 0;
  const containment = {
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    signal: () => {},
    empty: () => ++reads >= 3,
  };
  assert.equal(await supervise('ignored', [], 1, async () => renewal(), { containment, detached: false, graceMs: 10, shutdownPollMs: 1, shutdownTimeoutMs: 100, quarantine: { establish: async () => {}, settle: async () => { settled++; } } }), 0);
  assert.equal(reads, 3); assert.equal(settled, 1);
});

test('supervisor retains signal handlers through verification and settlement, then removes them', async () => {
  const baselineInt = process.listenerCount('SIGINT'), baselineTerm = process.listenerCount('SIGTERM');
  let reads = 0, settlements = 0, signals = 0;
  const containment = {
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    signal: () => { signals++; },
    empty: () => {
      assert.equal(process.listenerCount('SIGINT'), baselineInt + 1);
      assert.equal(process.listenerCount('SIGTERM'), baselineTerm + 1);
      if (++reads === 1) { process.emit('SIGINT', 'SIGINT'); process.emit('SIGTERM', 'SIGTERM'); }
      return reads >= 2;
    },
  };
  assert.equal(await supervise('ignored', [], 1, async () => renewal(), { containment, detached: false, graceMs: 1, shutdownPollMs: 1, shutdownTimeoutMs: 100, quarantine: {
    establish: async () => {},
    settle: async () => {
      settlements++;
      assert.equal(process.listenerCount('SIGINT'), baselineInt + 1);
      assert.equal(process.listenerCount('SIGTERM'), baselineTerm + 1);
      process.emit('SIGINT', 'SIGINT'); process.emit('SIGTERM', 'SIGTERM');
    },
  } }), 0);
  assert.equal(settlements, 1); assert.ok(signals >= 2, 'repeated signals continue targeting the existing containment');
  assert.equal(process.listenerCount('SIGINT'), baselineInt); assert.equal(process.listenerCount('SIGTERM'), baselineTerm);
});

test('supervisor retains quarantine only after bounded scope shutdown verification times out', async () => {
  let reads = 0, settled = 0;
  const containment = {
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    signal: () => {},
    empty: () => { reads++; return false; },
  };
  await assert.rejects(supervise('ignored', [], 1, async () => renewal(), { containment, detached: false, graceMs: 10, shutdownPollMs: 1, shutdownTimeoutMs: 5, quarantine: { establish: async () => {}, settle: async () => { settled++; } } }), /shutdown could not be verified/);
  assert.ok(reads > 1); assert.equal(settled, 0);
});

test('foreground containment refuses to launch before a durable quarantine exists', async () => {
  const containment = { command: process.execPath, args: ['-e', 'process.exit(0)'], signal: () => {}, empty: () => true };
  await assert.rejects(supervise('ignored', [], 1, async () => renewal(), { containment, detached: false }), /durable Graphyard containment quarantine/);
});

test('macOS foreground Herdr supervision refuses before launch without durable containment', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'graphyard-darwin-refusal-')), marker = join(cwd, 'launched');
  try {
    await assert.rejects(supervise(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'yes')`], 1, async () => renewal(), { detached: false, platform: 'darwin' }), /not supported on darwin/);
    await assert.rejects(stat(marker), { code: 'ENOENT' });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

 test('handoff pairs ownership with its work observation rather than a later status clock', async () => {
  const cwd=await mkdtemp(join(tmpdir(),'graphyard-handoff-'));const requests:string[]=[];
  const http=createServer((req,res)=>{requests.push(req.url!);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/api/status'?{actor:{id:'worker-a',role:'worker'},now:'2026-01-01T00:02:00Z'}:{now:'2026-01-01T00:00:00Z',work:[{id:'task',key:'GY-1',lease:{owner:'worker-a',epoch:7,expiresAt:'2026-01-01T00:01:00Z'},workspaces:[{epoch:7,host:'machine-a',path:cwd}]}]}))});
  await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));
  try{const result=await exec(process.execPath,[launcher,'handoff','GY-1'],{cwd,env:{...process.env,GRAPHYARD_TOKEN:'fixture',GRAPHYARD_HOST_ID:'machine-a',GRAPHYARD_URL:`http://127.0.0.1:${(http.address() as any).port}`}});assert.match(JSON.parse(result.stdout).commands.join(' '),/watch/);assert.deepEqual(requests.sort(),['/api/status','/api/work-snapshot']);}
  finally{await new Promise<void>(r=>http.close(()=>r()));await rm(cwd,{recursive:true,force:true});}
 });

 test('worktree verifies the checkout before reserving a workspace or creating a branch', async () => {
  const cwd=await mkdtemp(join(tmpdir(),'graphyard-repository-fence-'));let reservations=0;
  const http=createServer((req,res)=>{res.setHeader('Content-Type','application/json');
    if(req.url==='/api/status')res.end(JSON.stringify({repository:'OWNER/project',actor:{id:'worker-a',role:'worker'}}));
    else if(req.method==='POST'){reservations++;res.end('{}');}
    else res.end(JSON.stringify([{id:'task',key:'GY-1',workspaces:[]}]));
  });
  await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));
  const env={...process.env,GRAPHYARD_TOKEN:'fixture',GRAPHYARD_URL:`http://127.0.0.1:${(http.address() as any).port}`};
  try {
    await exec('git',['init','-q'],{cwd});await exec('git',['-c','user.name=Test','-c','user.email=test@localhost','commit','--allow-empty','-m','Initial'],{cwd});
    await assert.rejects(exec(process.execPath,[launcher,'worktree','GY-1','1'],{cwd,env}),/Cannot verify/);
    await exec('git',['remote','add','origin','git@github.com:other/project.git'],{cwd});
    await assert.rejects(exec(process.execPath,[launcher,'worktree','GY-1','1'],{cwd,env}),/different repositories/);
    assert.equal(reservations,0);await assert.rejects(stat(join(cwd,'.graphyard/worktrees/GY-1-1')));
    await assert.rejects(exec('git',['show-ref','--verify','refs/heads/graphyard/gy-1-1'],{cwd}));
    await exec('git',['remote','set-url','origin','ssh://git@github.com/owner/project.git'],{cwd});
    const created=await exec(process.execPath,[launcher,'worktree','GY-1','1'],{cwd,env});
    assert.equal(JSON.parse(created.stdout).path,join(cwd,'.graphyard/worktrees/GY-1-1'),'worktree stdout remains machine-readable JSON');
    assert.equal(reservations,1);assert.ok((await stat(join(cwd,'.graphyard/worktrees/GY-1-1'))).isDirectory());
  } finally {await new Promise<void>(r=>http.close(()=>r()));await rm(cwd,{recursive:true,force:true});}
 });

test('rework worktree reopens the exact observed PR branch while preserving its prior checkout', async () => {
  const cwd=await mkdtemp(join(tmpdir(),'graphyard-rework-'));let reservations=0;let candidate='';
  const branch='graphyard/gy-1-1';
  const http=createServer((req,res)=>{res.setHeader('Content-Type','application/json');
    if(req.url==='/api/status')res.end(JSON.stringify({repository:'owner/project',actor:{id:'worker-a',role:'worker'}}));
    else if(req.method==='POST'){reservations++;res.end('{}');}
    else res.end(JSON.stringify([{id:'task',key:'GY-1',submission:{epoch:1,pr:1},candidate:{sha:candidate},workspaces:[{epoch:1,branch}],reworkRequested:true}]));
  });
  await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));
  const fakeBin=join(cwd,'fake-bin');await mkdir(fakeBin);const gitBinary=(await exec('which',['git'])).stdout.trim();
  const gitWrapper=join(fakeBin,'git');await writeFile(gitWrapper,`#!/bin/sh\nif [ "$1" = "fetch" ]; then exit 0; fi\nexec "${gitBinary}" "$@"\n`);await chmod(gitWrapper,0o755);
  const env={...process.env,PATH:`${fakeBin}:${process.env.PATH}`,GRAPHYARD_TOKEN:'fixture',GRAPHYARD_URL:`http://127.0.0.1:${(http.address() as any).port}`};
  try {
    await exec('git',['init','-q','--initial-branch',branch],{cwd});
    await writeFile(join(cwd,'feature.txt'),'submitted implementation\n');
    await exec('git',['add','feature.txt'],{cwd});await exec('git',['-c','user.name=Test','-c','user.email=test@localhost','commit','-m','Submitted implementation'],{cwd});
    const priorHead=(await exec('git',['rev-parse','HEAD'],{cwd})).stdout.trim();
    candidate=(await exec('git',['-c','user.name=Test','-c','user.email=test@localhost','commit-tree',`${priorHead}^{tree}`,'-p',priorHead,'-m','Remote candidate'],{cwd})).stdout.trim();
    await exec('git',['remote','add','origin','https://github.com/owner/project.git'],{cwd});
    await exec('git',['update-ref',`refs/remotes/origin/${branch}`,candidate],{cwd});
    const result=JSON.parse((await exec(process.execPath,[launcher,'worktree','GY-1','2','a'.repeat(40)],{cwd,env})).stdout);
    assert.equal(reservations,1);assert.equal(result.branch,branch);
    assert.equal((await exec('git',['-C',result.path,'rev-parse','HEAD'],{cwd})).stdout.trim(),candidate);
    assert.equal((await exec('git',['-C',result.path,'symbolic-ref','--short','HEAD'],{cwd})).stdout.trim(),branch);
    assert.equal((await exec('git',['rev-parse','HEAD'],{cwd})).stdout.trim(),priorHead,'prior checkout stays at its historical commit');
    await assert.rejects(exec('git',['symbolic-ref','--short','HEAD'],{cwd}));
    assert.equal((await readFile(join(cwd,'feature.txt'),'utf8')).trim(),'submitted implementation','prior worktree remains intact');
  } finally {await new Promise<void>(r=>http.close(()=>r()));await rm(cwd,{recursive:true,force:true});}
});

 test('handoff uses the active CLI or explicit override instead of a stale saved launcher', async () => {
  const cwd=await mkdtemp(join(tmpdir(),'graphyard-active-cli-'));
  const http=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/api/status'?{actor:{id:'worker-a',role:'worker'}}:{now:'2026-01-01T00:00:00Z',work:[{id:'task',key:'GY-1',lease:{owner:'worker-a',epoch:1,expiresAt:'2026-01-01T00:01:00Z'},workspaces:[{epoch:1,host:'machine-a',path:cwd}]}]}));});
  await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(http.address() as any).port}`;
  const env:NodeJS.ProcessEnv={...process.env,GRAPHYARD_URL:url,GRAPHYARD_TOKEN:'fixture',GRAPHYARD_HOST_ID:'machine-a'};delete env.GRAPHYARD_CLI;
  try {
    await exec('git',['init','-q'],{cwd});await mkdir(join(cwd,'.graphyard'));
    await writeFile(join(cwd,'.graphyard/connection.json'),JSON.stringify({url,token:'fixture'.padEnd(40,'x'),hostId:'machine-a',cliPath:'/removed/graphyard/bin/graphyard.mjs'}),{mode:0o600});
    const commands=async (settings:NodeJS.ProcessEnv)=>JSON.parse((await exec(process.execPath,[launcher,'handoff','GY-1'],{cwd,env:settings})).stdout).commands.join(' ');
    assert.ok((await commands(env)).includes(launcher));
    const override=join(cwd,'active.mjs');await writeFile(override,'// fixture launcher');
    assert.ok((await commands({...env,GRAPHYARD_CLI:override})).includes(override));
    for(const invalid of ['',join(cwd,'missing.mjs')])await assert.rejects(commands({...env,GRAPHYARD_CLI:invalid}),/launcher/);
  } finally {await new Promise<void>(r=>http.close(()=>r()));await rm(cwd,{recursive:true,force:true});}
 });

test('the packaged runner path is usable from the CLI and refuses evidence-producer credentials', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'graphyard-runner-cli-'));
  let role = 'producer';
  let collectionAuthority: unknown;
  const posts: string[] = [];
  const http = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/status') { res.end(JSON.stringify({ actor: { id: 'preview-runner', role, ...(role === 'producer' ? { proofs: ['e2e:booking'] } : {}) } })); return; }
    if (req.url === '/api/validation/collection-authority') { posts.push(String(req.url)); res.end(JSON.stringify(collectionAuthority)); return; }
    posts.push(String(req.url)); res.end('{}');
  });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
  const env = { ...process.env, GRAPHYARD_TOKEN: 'test-only', GRAPHYARD_URL: `http://127.0.0.1:${(http.address() as any).port}` };
  try {
    const oracle = join(cwd, 'oracle'); await mkdir(oracle); await mkdir(join(cwd, 'out'), { mode: 0o700 }); await mkdir(join(cwd, 'boundary'), { mode: 0o700 });
    await writeFile(join(oracle, 'suite.spec.ts'), 'approved assertion');
    const bundle = JSON.parse((await exec(process.execPath, [launcher, 'runner', 'bundle-digest', oracle], { cwd, env })).stdout);
    assert.match(bundle.digest, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(bundle.files.map((f: any) => f.path), ['suite.spec.ts']);

    const plan = join(cwd, 'runner.json');
    await writeFile(plan, JSON.stringify({ registration: { id: 'preview-runner', revision: 1 }, imageRepository: 'example/graphyard-runner',
      oraclePath: oracle, outputPath: join(cwd, 'out'), timeoutMs: 60_000, runAsUser: `${process.getuid!()}:${process.getgid!()}`,
      supervisor: { command: process.execPath, args: [launcher, 'runner', 'supervise'] } }));
    // A producer credential could publish evidence about its own execution.
    await assert.rejects(exec(process.execPath, [launcher, 'runner', 'attempt', plan], { cwd, env }), /worker-scoped runner credential/);
    assert.deepEqual(posts, []);
    role = 'worker';
    // A worker credential proceeds to dispatch; the stub offers no eligible request.
    assert.equal(JSON.parse((await exec(process.execPath, [launcher, 'runner', 'attempt', plan], { cwd, env })).stdout).dispatched, false);
    assert.deepEqual(posts, ['/api/validation/dispatch']);

    await writeFile(join(cwd, 'collect.json'), JSON.stringify({ grant: {}, record: {}, outputPath: join(cwd, 'out'), requiredArtifacts: ['report'], expected: { instance: 'x', artifacts: [] }, observations: [] }));
    await assert.rejects(exec(process.execPath, [launcher, 'runner', 'collect', join(cwd, 'collect.json')], { cwd, env }));
    assert.deepEqual(posts, ['/api/validation/dispatch']);

    // A record that does not even bind to the configuration it arrived with is refused
    // before any authority is taken: taking collection authority moves the live request to
    // `collecting` and revokes the runner's heartbeats, and neither can be undone, so a
    // local mistake must not spend the attempt's one collection transition.
    const grant = { requestId: randomUUID(), attemptId: randomUUID(), epoch: 1, runner: { id: 'preview-runner', revision: 1 },
      executionHost: 'unix:///var/run/docker.sock', attestationPublicKey: 'test-public-key-material-at-least-32-bytes', executionNetwork: 'gy-test',
      bundleDigest: bundle.digest, runnerImageDigest: `sha256:${'b'.repeat(64)}`, targetUrl: 'https://preview.example.test/', deadline: '2026-09-16T01:00:00.000Z',
      reportFormat: 'graphyard-playwright-v1' as const, testAccountDigest: null };
    collectionAuthority = grant;
    const record = { grant, startedAt: '2026-09-16T00:00:00.000Z', finishedAt: '2026-09-16T00:01:00.000Z',
      phases: [{ phase: 'enumerate', exitCode: 0, timedOut: false, durationMs: 1 }, { phase: 'execute', exitCode: 0, timedOut: false, durationMs: 2 }],
      bundleDigestBefore: bundle.digest, bundleDigestAfter: bundle.digest, runnerImageDigest: grant.runnerImageDigest,
      outcome: 'completed', refusals: [], outputPath: '/srv/graphyard/attempts/previous',
      settlement: { settled: true, containers: [{ name: `graphyard-enumerate-${grant.attemptId}`, state: 'absent' }, { name: `graphyard-execute-${grant.attemptId}`, state: 'absent' }] } };
    await writeFile(join(cwd, 'stale.json'), JSON.stringify({ grant, record, outputPath: join(cwd, 'out'), requiredArtifacts: ['inventory', 'report'],
      expected: { instance: 'preview-7f3a', artifacts: [{ service: 'api', digest: `sha256:${'c'.repeat(64)}` }] }, observations: [], executionAttestation: {} }));
    await assert.rejects(exec(process.execPath, [launcher, 'runner', 'collect', join(cwd, 'stale.json')], { cwd, env }),
      /before taking collection authority: The collected directory is not the output boundary this execution recorded/);
    assert.deepEqual(posts, ['/api/validation/dispatch'], 'no collection transition is spent on a locally invalid configuration');

    // What the collector re-reads still decides. A configuration that binds to itself but
    // not to the authority Graphyard holds takes collection authority — the runner may no
    // longer act either way — and is then refused before the boundary is read.
    const boundaryPath = await realpath(join(cwd, 'boundary'));
    const bound = { ...record, outputPath: boundaryPath };
    collectionAuthority = { ...grant, epoch: 2 };
    await writeFile(join(cwd, 'superseded.json'), JSON.stringify({ grant, record: bound, outputPath: boundaryPath, requiredArtifacts: ['inventory', 'report'],
      expected: { instance: 'preview-7f3a', artifacts: [{ service: 'api', digest: `sha256:${'c'.repeat(64)}` }] }, observations: [], executionAttestation: {} }));
    await assert.rejects(exec(process.execPath, [launcher, 'runner', 'collect', join(cwd, 'superseded.json')], { cwd, env }),
      /before reading the execution boundary: The execution record does not hold the authority the collector independently re-read/);
    assert.deepEqual(posts, ['/api/validation/dispatch', '/api/validation/collection-authority']);
    collectionAuthority = grant;

    // Uploading is gated on the host attestation, never the other way round. A live grant
    // and a boundary full of schema-valid reports still publishes no artifact when the
    // attestation does not cover those bytes: an artifact name is immutable for the
    // attempt, so consuming it here would lock out the real evidence for good. The
    // refusal itself is still published, because a blocked attempt is a visible state.
    const boundary = boundaryPath;
    const testId = createHash('sha256').update('books are listed').digest('hex');
    const inventory = { format: 'graphyard-playwright-v1', declared: [{ id: testId, expected: 'passed', location: { file: 'suite.spec.ts', line: 1, column: 1 } }], executions: [], steps: [], errors: 0, overflow: false, status: 'passed' };
    await writeFile(join(boundary, 'inventory.json'), JSON.stringify(inventory));
    await writeFile(join(boundary, 'report.json'), JSON.stringify({ ...inventory, executions: [{ id: testId, status: 'passed', retry: 0 }] }));
    const collected = { ...record, outputPath: boundary };
    // A structurally valid attestation that covers none of the collected bytes, and whose
    // signature cannot verify against the pinned key.
    const unattested = { payload: executionAttestationPayload({ grant, execution: collected as any, artifacts: [] }), signature: 'AAAA' };
    await writeFile(join(cwd, 'unattested.json'), JSON.stringify({ grant, record: collected, outputPath: boundary, requiredArtifacts: ['inventory', 'report'],
      expected: { instance: 'preview-7f3a', artifacts: [{ service: 'api', digest: `sha256:${'c'.repeat(64)}` }] }, observations: [], executionAttestation: unattested }));
    const refused = JSON.parse((await exec(process.execPath, [launcher, 'runner', 'collect', join(cwd, 'unattested.json')], { cwd, env })).stdout);
    assert.equal(refused.report.behavior, 'blocked');
    assert.ok(refused.refusals.some((r: string) => /signature is invalid/.test(r)));
    const called: string[] = [...posts];
    assert.ok(!called.includes('/api/validation/artifacts'), 'no artifact name is consumed for bytes the attestor did not measure');
    assert.ok(called.includes('/api/validation/result'), 'the refusal is still published rather than silently dropped');
    await assert.rejects(exec(process.execPath, [launcher, 'runner', 'nonsense'], { cwd, env }), /Use runner inspect/);
  } finally { await new Promise<void>(r => http.close(() => r())); await rm(cwd, { recursive: true, force: true }); }
});

test('the runner holds authority while the host attestor executes and signs the attempt', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'graphyard-supervision-'));
  const posts: string[] = [];
  const requestId = randomUUID(), attemptId = randomUUID();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const attestationPublicKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const deadline = new Date(Date.now() + 600_000).toISOString();
  let bundleDigest = '';
  // The attempt authority Graphyard holds, and the lease state the attestor reads for
  // itself. `dispatched` until the runner acknowledges under its own worker credential.
  let attempt = { state: 'dispatched', acknowledged: false };
  const authorityReads: string[] = [];
  const authority = () => ({ requestId, attemptId, epoch: 1, runner: { id: 'preview-runner', revision: 1 },
    executionHost: 'unix:///var/run/docker.sock', attestationPublicKey, executionNetwork: 'gy-isolated',
    bundleDigest, runnerImageDigest: `sha256:${'b'.repeat(64)}`, targetUrl: 'https://preview.example.test/', deadline, testAccountDigest: null });
  const http = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/status') { res.end(JSON.stringify({ actor: { id: 'preview-runner', role: 'worker' } })); return; }
    if (req.url === `/api/validation/attempt/${requestId}`) {
      authorityReads.push(attempt.state);
      res.end(JSON.stringify({ grant: authority(), ...attempt, expiresAt: new Date(Date.now() + 60_000).toISOString(), now: new Date().toISOString() }));
      return;
    }
    posts.push(String(req.url).replace('/api/validation/', ''));
    if (req.url === '/api/validation/ack') { attempt = { state: 'running', acknowledged: true }; res.end('{}'); return; }
    if (req.url !== '/api/validation/dispatch') { res.end('{}'); return; }
    res.end(JSON.stringify({
      request: { id: requestId, deadline },
      attempt: { id: attemptId, epoch: 1 },
      bundle: { digest: bundleDigest, runnerImageDigest: `sha256:${'b'.repeat(64)}` },
      environment: { instance: 'preview-7f3a', url: 'https://preview.example.test/' },
      build: { artifacts: [{ service: 'api', digest: `sha256:${'c'.repeat(64)}` }] },
      // The approved execution boundary is operator-versioned authority, not runner input.
      executionAuthority: { host: 'unix:///var/run/docker.sock', network: 'gy-isolated', attestationPublicKey, testAccountDigest: null },
    }));
  });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
  // Whether this host happens to have a working Docker daemon must not decide what the
  // attempt observes. This stub answers every invocation the way an unreachable daemon
  // does, so the attestor can start no container and can confirm no container removed.
  const fakeBin = join(cwd, 'fake-bin');
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, GRAPHYARD_TOKEN: 'test-only', GRAPHYARD_URL: `http://127.0.0.1:${(http.address() as any).port}` };
  try {
    await mkdir(fakeBin);
    await writeFile(join(fakeBin, 'docker'), '#!/bin/sh\nexit 1\n'); await chmod(join(fakeBin, 'docker'), 0o755);
    const oracle = join(cwd, 'oracle'), output = join(cwd, 'out'), key = join(cwd, 'attestor.key');
    await mkdir(oracle, { mode: 0o755 }); await mkdir(output, { mode: 0o700 });
    await writeFile(join(oracle, 'suite.spec.ts'), 'approved assertion');
    await writeFile(key, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
    bundleDigest = JSON.parse((await exec(process.execPath, [launcher, 'runner', 'bundle-digest', oracle], { cwd, env })).stdout).digest;

    // The host attestor takes its signing key, its server and its read-only credential
    // from its own environment. A runner that could name any of them could choose a key it
    // holds, or a server that answers whatever it likes about current attempt authority.
    const attestorToken = join(cwd, 'attestor.token');
    await writeFile(attestorToken, 'attestor-read-only\n', { mode: 0o600 });
    const attestorEnv = { ...env, GRAPHYARD_ATTESTOR_KEY: key, GRAPHYARD_ATTESTOR_URL: env.GRAPHYARD_URL, GRAPHYARD_ATTESTOR_TOKEN_FILE: attestorToken };
    const containerUid = process.getuid!() === 10001 ? 10002 : 10001;
    const runAsUser = `${containerUid}:${process.getgid!()}`;
    const plan = join(cwd, 'runner.json');
    await writeFile(plan, JSON.stringify({ registration: { id: 'preview-runner', revision: 1 }, imageRepository: 'example/graphyard-runner',
      oraclePath: oracle, outputPath: output, timeoutMs: 60_000, runAsUser,
      supervisor: { command: process.execPath, args: [launcher, 'runner', 'supervise'] } }));
    const attempted = JSON.parse((await exec(process.execPath, [launcher, 'runner', 'attempt', plan], { cwd, env: attestorEnv, maxBuffer: 8 << 20 })).stdout);

    // Acknowledgement sits between the attestor's preflight and its first container.
    assert.deepEqual(posts, ['dispatch', 'ack']);
    // And the attestor checked the control plane itself, twice: once before provisioning
    // anything, and once after the runner claimed to have acknowledged. The second read is
    // what actually releases the containers, so `proceed` on the pipe decides nothing.
    assert.deepEqual(authorityReads, ['dispatched', 'running']);
    // The runner observed nothing: it forwards the record the attestor signed. No
    // container could run here, so the attempt is blocked — and blocked is what it
    // reports, over the attestor's signature rather than the runner's word.
    assert.equal(attempted.record.grant.executionNetwork, 'gy-isolated');
    assert.equal(attempted.record.outcome, 'failed');
    assert.ok(attempted.record.refusals.some((r: string) => /settlement is unverified/.test(r)));
    assert.equal(attempted.attestation.payload.attemptId, attemptId);
    assert.ok(verify(null, Buffer.from(JSON.stringify(attempted.attestation.payload)),
      attestationPublicKey, Buffer.from(attempted.attestation.signature, 'base64')));

    // The attestor refuses to sign at all without a private key of its own, and refuses a
    // key any other account on the host could read.
    const attempt2Grant = attempted.record.grant;
    const supervision = JSON.stringify({ plan: { grant: attempt2Grant, imageRepository: 'example/graphyard-runner',
      oraclePath: oracle, outputPath: output, timeoutMs: 60_000, runAsUser } });
    // The attestor reads its supervision request from stdin, so the two lines have to be
    // written to a live pipe and the stream closed — `execFile` has no `input` option, and
    // an unwritten pipe would leave a command that gets as far as reading waiting forever.
    const supervise = (settings: NodeJS.ProcessEnv, request = supervision) => new Promise<string>((settled, refused) => {
      const child = spawn(process.execPath, [launcher, 'runner', 'supervise'], { cwd, env: settings as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', diagnostics = '';
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { out += chunk; });
      child.stderr.on('data', chunk => { diagnostics += chunk; });
      child.on('error', refused);
      child.on('close', code => code === 0 ? settled(out) : refused(new Error(diagnostics || `supervise exited ${code}`)));
      child.stdin.end(`${request}\n{"proceed":true}\n`);
    });
    await assert.rejects(supervise(env), /GRAPHYARD_ATTESTOR_KEY/);

    // `proceed: true` on the pipe is a sequencing signal, not authority. Whatever the
    // caller says, the attestor starts containers only for the attempt Graphyard holds.
    const substituted = JSON.stringify({ plan: { ...JSON.parse(supervision).plan,
      grant: { ...attempt2Grant, targetUrl: 'https://attacker.example.test/' } } });
    await assert.rejects(supervise(attestorEnv, substituted), /does not carry the attempt authority Graphyard dispatched/);
    // An attempt nobody acknowledged, and one whose authority the collector has already
    // taken over, are both refused before the first container rather than executed.
    for (const held of [{ state: 'dispatched', acknowledged: false }, { state: 'collecting', acknowledged: true }]) {
      attempt = held;
      await assert.rejects(supervise(attestorEnv), /does not hold this attempt as acknowledged and executing/);
    }
    attempt = { state: 'running', acknowledged: true };
    // A missing or world-readable credential refuses just as the signing key does: an
    // attestor that cannot verify authority independently must not execute at all.
    await assert.rejects(supervise({ ...attestorEnv, GRAPHYARD_ATTESTOR_TOKEN_FILE: undefined }), /GRAPHYARD_ATTESTOR_URL and GRAPHYARD_ATTESTOR_TOKEN_FILE/);
    await chmod(attestorToken, 0o644);
    await assert.rejects(supervise(attestorEnv), /Graphyard credential must be a private regular file/);
    await chmod(attestorToken, 0o600);
    await chmod(key, 0o644);
    await assert.rejects(supervise(attestorEnv), /private key must be a private regular file/);
  } finally { await new Promise<void>(r => http.close(() => r())); await rm(cwd, { recursive: true, force: true }); }
});

test('master run executes the durable loop as a supervised process and master status reports its cursor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-master-run-'));
  const credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-master-run-credentials-'));
  const credentialFile = join(credentialDirectory, 'coordinator.token');
  let proofScoped = false;
  const now = () => new Date().toISOString();
  const snapshot = {
    now: now(),
    work: [
      { id: 'blocked-1', key: 'GY-70', title: 'Needs an operator', stage: 'ready', ready: true, blocker: 'Waiting on an external contract', priority: 1, epoch: 0, dependencies: [], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['integration:loop'] }], policy: { checks: ['test'], review: true }, plannedFiles: [], workspaces: [], evidence: [], gates: [{ name: 'ready', passed: false, reasons: ['Waiting on an external contract'] }], violations: [], createdAt: now(), updatedAt: now(), stageEnteredAt: now(), lease: null, candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], observation: null, revision: 1, policyRevision: 1 },
    ],
  };
  const http = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/status') return res.end(JSON.stringify({ actor: { id: 'master', role: 'coordinator', ...(proofScoped ? { proofs: ['integration:loop'] } : {}) }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
    if (req.url === '/api/work-snapshot') return res.end(JSON.stringify({ ...snapshot, now: now() }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as any).port}`;
  try {
    await exec('git', ['init', '-q'], { cwd: root });
    await exec('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    await mkdir(join(root, '.graphyard'));
    await writeFile(join(root, '.graphyard/master.json'), JSON.stringify({ version: 1, url, credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], run: { intervalSeconds: 5, deploymentShaField: 'commit' } }), { mode: 0o600 });
    const env = { ...process.env, GRAPHYARD_URL: url, GRAPHYARD_TOKEN: undefined, GRAPHYARD_TOKEN_FILE: undefined };

    const first = JSON.parse((await exec(process.execPath, [launcher, 'master', 'run', '--once'], { cwd: root, env })).stdout);
    assert.equal(first.cycles, 1); assert.equal(first.coordinator, 'master'); assert.equal(first.intervalSeconds, 5);
    const cursor = join(credentialDirectory, 'coordinator.daemon.json');
    assert.equal((await stat(cursor)).mode & 0o777, 0o600, 'the durable cursor is private');
    const state = JSON.parse(await readFile(cursor, 'utf8'));
    assert.equal(state.cycle, 1); assert.equal(state.lock, null, 'a completed run releases its lock for the supervisor restart');
    assert.equal(state.metrics.length, 1, 'every cycle records stage percentiles');

    // A restart continues the same cursor rather than starting over.
    await exec(process.execPath, [launcher, 'master', 'run', '--once', '--interval', '30'], { cwd: root, env });
    assert.equal(JSON.parse(await readFile(cursor, 'utf8')).cycle, 2);

    const status = JSON.parse((await exec(process.execPath, [launcher, 'master', 'status'], { cwd: root, env })).stdout);
    assert.equal(status.daemon.cycle, 2);
    assert.ok(status.daemon.metrics, 'master status shows what the loop measured');
    assert.deepEqual(status.daemon.unresolved, []);

    await assert.rejects(exec(process.execPath, [launcher, 'master', 'run', '--once', '--interval', '2'], { cwd: root, env }), /whole seconds between 5 and 900/);
    proofScoped = true;
    await assert.rejects(exec(process.execPath, [launcher, 'master', 'run', '--once'], { cwd: root, env }), /refuses a credential that is also allowed to produce evidence/);
  } finally {
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true });
  }
});

test('sync merges origin/BASE without rebasing, passes in-scope and new files, and refuses every out-of-scope file that no longer matches the base', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'graphyard-sync-'));
  const http = createServer((req, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/status' ? { baseBranch: 'main', repository: 'owner/project', actor: { id: 'worker-a', role: 'worker' } }
      : [{ id: 'task', key: 'GY-1', plannedFiles: ['src/scoped/', 'tests/'], workspaces: [{ epoch: 1, host: 'machine-a', path: cwd, branch: 'graphyard/gy-1-1' }] }])); });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
  const env = { ...process.env, GRAPHYARD_TOKEN: 'fixture', GRAPHYARD_URL: `http://127.0.0.1:${(http.address() as any).port}` };
  const origin = join(cwd, 'origin'), clone = join(cwd, 'clone');
  const git = async (repo: string, ...args: string[]) => (await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], { cwd: repo })).stdout.trim();
  const commit = async (repo: string, message: string) => { await git(repo, 'add', '-A'); await git(repo, 'commit', '-q', '-m', message); return git(repo, 'rev-parse', 'HEAD'); };
  const sync = () => exec(process.execPath, [launcher, 'sync', 'GY-1'], { cwd: clone, env });
  const refusal = async () => { try { await sync(); assert.fail('sync must exit non-zero'); } catch (error: any) { assert.equal(error.code, 1); return JSON.parse(error.stdout); } };
  try {
    await mkdir(origin); await git(origin, 'init', '-q', '--initial-branch', 'main');
    await mkdir(join(origin, 'src/scoped'), { recursive: true });
    await writeFile(join(origin, 'src/shipped.ts'), 'export const shipped = 1;\nexport const kept = true;\n'); await writeFile(join(origin, 'src/scoped/feature.ts'), 'feature v0\n');
    await commit(origin, 'Base');
    await exec('git', ['clone', '-q', origin, clone]);
    // sync runs the worker's own git merge, so the clone carries the identity a worker's checkout has.
    await git(clone, 'config', 'user.name', 'Test'); await git(clone, 'config', 'user.email', 'test@localhost');
    await git(clone, 'checkout', '-q', '-b', 'graphyard/gy-1-1');
    await writeFile(join(clone, 'src/scoped/feature.ts'), 'feature v1\n'); const own = await commit(clone, 'Feature');
    // Meanwhile main ships GY-33's change and a new file.
    await writeFile(join(origin, 'src/shipped.ts'), 'export const shipped = 2;\nexport const kept = true;\nexport const added = true;\n'); await writeFile(join(origin, 'src/other.ts'), 'export const other = 1;\n');
    const mainTip = await commit(origin, 'Ship GY-33');
    const clean = JSON.parse((await sync()).stdout);
    assert.equal(clean.ok, true); assert.equal(clean.merged, true); assert.equal(clean.baseTip, mainTip); assert.deepEqual(clean.refused, []);
    assert.deepEqual(clean.files.map((f: any) => [f.path, f.kind]), [['src/scoped/feature.ts', 'in-scope']]);
    await git(clone, 'merge-base', '--is-ancestor', mainTip, 'HEAD'); await git(clone, 'merge-base', '--is-ancestor', own, 'HEAD');
    assert.equal(await git(clone, 'rev-list', '--count', '--merges', 'HEAD'), '1', 'the base branch is merged, never rebased');
    // The worker re-resolves shipped files in favour of its branch and deletes one; a new file is fine.
    await writeFile(join(clone, 'src/shipped.ts'), 'export const shipped = 2;\nexport const kept = true;\n'); await rm(join(clone, 'src/other.ts'));
    await mkdir(join(clone, 'tests')); await writeFile(join(clone, 'src/brand-new.ts'), 'export const fresh = 1;\n'); await writeFile(join(clone, 'tests/new.test.ts'), 'test\n'); await commit(clone, 'Bad resolution');
    const refused = await refusal();
    assert.equal(refused.ok, false); assert.equal(refused.merged, true);
    assert.deepEqual(refused.refused, ['src/other.ts: deleted; the base branch still holds it', 'src/shipped.ts: removes 1 line that the base branch holds and adds nothing']);
    assert.deepEqual(refused.files.filter((f: any) => !f.refused).map((f: any) => [f.path, f.kind]), [['src/brand-new.ts', 'new'], ['src/scoped/feature.ts', 'in-scope'], ['tests/new.test.ts', 'in-scope']]);
    assert.match(refused.next, /git checkout [0-9a-f]{12} -- PATH/);
    await git(clone, 'checkout', mainTip, '--', 'src/shipped.ts', 'src/other.ts'); await commit(clone, 'Restore shipped files');
    assert.equal(JSON.parse((await sync()).stdout).ok, true);
    // A conflicting base change stops before any scope verdict; nothing is rebased or resolved for the worker.
    await writeFile(join(origin, 'src/scoped/feature.ts'), 'feature from main\n'); await commit(origin, 'Conflicting change');
    const conflicted = await refusal();
    assert.equal(conflicted.merged, false); assert.deepEqual(conflicted.conflicts, ['src/scoped/feature.ts']); assert.match(conflicted.next, /Resolve each conflict/);
    await git(clone, 'merge', '--abort');
    await git(clone, 'checkout', '-q', '-b', 'graphyard/gy-9-1');
    await assert.rejects(sync(), /not one/);
  } finally { await new Promise<void>(r => http.close(() => r())); await rm(cwd, { recursive: true, force: true }); }
});
