import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { linuxProcessRecord, signalTrackedProcesses, supervise, systemdContainment } from '../src/supervisor.js';
import { containmentCredentials, establishContainment, isConfirmedCoordinationRefusal, settleContainment } from '../src/quarantine.js';

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
  const child = `const fs=require('node:fs'),crypto=require('node:crypto');const hash=${JSON.stringify(credentials.settlementHash)};if(Object.values(process.env).some(value=>crypto.createHash('sha256').update(value??'').digest('hex')===hash))process.exit(91);fs.appendFileSync(${JSON.stringify(launches)},'launched\\n')`;
  const containment = { command: process.execPath, args: ['-e', child], signal: () => {}, empty: () => true };
  try {
    await assert.rejects(supervise('ignored', [], 9, async () => ({ ...renewal(), lease: { ...renewal().lease, epoch: 9 } }), { containment, detached: false, graceMs: 1, quarantine: {
      establish: async () => {},
      settle: () => settleContainment(async (_key, body) => { attempts++; assert.equal(body.settlementToken, credentials.settlementToken); throw new TypeError('response unavailable'); },
        { epoch: 9, settlementToken: credentials.settlementToken, settlementHash: credentials.settlementHash, exclusiveResources: [], requestId: credentials.requestId }, { attempts: 3, retryMs: 0 }),
    } }), /could not confirm containment settlement after 3 attempts/);
    assert.equal(attempts, 3); assert.equal(await readFile(launches, 'utf8'), 'launched\n');
  } finally { await rm(cwd, { recursive: true, force: true }); }
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
  const env = { ...process.env, GRAPHYARD_HOST_ID: hostname(), GRAPHYARD_TOKEN: 'test-only', GRAPHYARD_REQUEST_ID: 'replayed-command', GRAPHYARD_URL: `http://127.0.0.1:${(http.address() as any).port}` };
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
  signalTrackedProcesses(100, tracked, new Map([[100, { ppid: 1, identity: 'root-start' }], [101, { ppid: 100, identity: 'child-start' }]]), 'SIGTERM', pid => { signalled.push(pid); });
  assert.deepEqual(signalled, [101, 100]); signalled.length = 0;
  signalTrackedProcesses(100, tracked, new Map([[101, { ppid: 55, identity: 'unrelated-start' }]]), 'SIGKILL', pid => { signalled.push(pid); });
  assert.deepEqual(signalled, []); assert.equal(tracked.has(101), false);
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
