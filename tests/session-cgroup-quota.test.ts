import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { piRunner, sessionLaunch } from '../src/runner/pi.js';
import { runsDirectory } from '../src/runner/registry.js';
import { graphyardTools } from '../src/runner/payloads.js';
import { systemdContainment } from '../src/session-watch.js';
import { sessionScopeProperties, sessionScopes, sessionShare, sessionSlice } from '../src/session-share.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3438: a worker started 16 browsers at once (GY-3411) and nothing noticed: the loop limits only
// what it launches, and the per-session test budget is an env hint agents ignore. Every agent
// session's systemd scope now carries CPUQuota and MemoryMax set to its share — the host's cores
// divided by the live sessions, never under two cores, memory in the same proportion.

const gib = 2 ** 30;

test('integration:session-cgroup-quota — the share is the cores divided by the live sessions, never under two cores, with memory in proportion', () => {
  assert.deepEqual(sessionShare(1, 24, 64 * gib), { cores: 24, memoryBytes: 64 * gib });
  assert.deepEqual(sessionShare(8, 24, 64 * gib), { cores: 3, memoryBytes: 8 * gib });
  assert.deepEqual(sessionShare(20, 24, 64 * gib), { cores: 2, memoryBytes: Math.floor(64 * gib / 12) }, 'never under two cores');
  // A session launched now counts itself among the live sessions.
  assert.deepEqual(sessionScopeProperties(9, 24, 64 * gib), ['-p', 'CPUQuota=267%', '-p', `MemoryMax=${Math.floor(64 * gib * 24 / 9 / 24)}`]);
});

test('integration:session-cgroup-quota — worker, reviewer and producer launches all carry the share on their scope', async () => {
  const share = /^-p CPUQuota=\d+% -p MemoryMax=\d+$/;
  // A worker under `graphyard watch` (a pane session).
  const watched = systemdContainment('codex', ['exec'], (() => '') as unknown as typeof execFileSync);
  assert.match(watched.args.slice(4, watched.args.indexOf('--')).join(' '), share, 'a watched worker scope carries the share');
  // A headless worker or reviewer run (headless-session.ts spawnHeadless launches through sessionLaunch).
  const headless = sessionLaunch('/runs/r1', 'r1', 'claude', ['-p', 'Review it'], 'systemd');
  assert.match(headless.args.slice(5, headless.args.indexOf('--')).join(' '), share, 'a headless session scope carries the share');
  assert.equal(sessionLaunch('/runs/r1', 'r1', 'claude', [], 'setsid').file, '/bin/sh', 'no scope, no share');
  // A producer run on Pi.
  const base = await temporaryDirectory('session-cgroup-quota');
  const cwd = join(base, 'coordinator', '.graphyard', 'worktrees', 'GY-1-1');
  await mkdir(cwd, { recursive: true });
  const spawned: string[][] = [];
  const runner = piRunner({ command: 'pi', containment: 'systemd', pollMs: 20,
    spawn: ((file: string, args: string[]) => { spawned.push([file, ...args]); return spawn('true'); }) as unknown as typeof spawn });
  const run = runner.start('Prove it', { tool: graphyardTools.evidence, validate: value => value, timeoutMs: 60_000, cwd, runs: runsDirectory(join(base, 'coordinator')) });
  run.cancel('the test only inspects the launch');
  await run.result();
  assert.equal(spawned[0]![0], 'systemd-run');
  assert.match(spawned[0]!.slice(6, spawned[0]!.indexOf('--')).join(' '), share, 'a producer scope carries the share');
});

test('integration:session-cgroup-quota — a session given a 2-core share that starts 16 busy processes stays within its CPUQuota and MemoryMax, as its cgroup counts', async () => {
  const base = await temporaryDirectory('session-cgroup-quota-live');
  const id = `quota-${process.pid}-${Date.now()}`, unit = `graphyard-run-${id}.scope`, slice = sessionSlice();
  // 1000 live sessions: the share is the two-core floor.
  const properties = sessionScopeProperties(1000);
  assert.equal(properties[1], 'CPUQuota=200%');
  const busy = 'for i in $(seq 16); do (while :; do :; done) & done; wait';
  const launch = sessionLaunch(base, id, '/bin/sh', ['-c', busy], 'systemd');
  // The launch takes the share of the sessions live now; this one pins the floor to measure it.
  const args = launch.args.map(arg => arg.startsWith('CPUQuota=') ? properties[1]! : arg.startsWith('MemoryMax=') ? properties[3]! : arg);
  const child = spawn(launch.file, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let refused = '';
  child.stderr!.on('data', chunk => { refused += chunk; });
  try {
    const cgroup = join(slice, unit);
    const usage = async () => Number(/^usage_usec (\d+)/m.exec(await readFile(join(cgroup, 'cpu.stat'), 'utf8'))![1]);
    let started = false;
    for (let tries = 0; tries < 50 && !started; tries++) { started = await readFile(join(cgroup, 'cpu.stat'), 'utf8').then(() => true, () => false); if (!started) await delay(100); }
    assert.ok(started, `systemd-run started no scope ${unit}: ${refused.trim() || 'no error printed'}`);
    await delay(1_000);
    const before = await usage(), from = performance.now();
    await delay(5_000);
    const used = (await usage()) - before, elapsed = (performance.now() - from) * 1000;
    const cores = used / elapsed;
    assert.ok(cores > 1, `the busy processes ran (${cores.toFixed(2)} cores)`);
    assert.ok(cores <= 2.2, `16 busy processes stayed within the 2-core quota: ${cores.toFixed(2)} cores`);
    assert.equal((await readFile(join(cgroup, 'cpu.max'), 'utf8')).trim(), '200000 100000');
    const memoryMax = Number((await readFile(join(cgroup, 'memory.max'), 'utf8')).trim());
    assert.equal(memoryMax, Number(properties[3]!.slice('MemoryMax='.length)));
    assert.ok(Number((await readFile(join(cgroup, 'memory.current'), 'utf8')).trim()) <= memoryMax, 'memory stays within MemoryMax');
    // The loop reads it back as a live session with its caps.
    const scope = sessionScopes(slice).find(entry => entry.unit === unit);
    assert.ok(scope, 'the loop lists the capped scope as a live session');
    assert.equal(scope.cpuCap, 2);
    assert.equal(scope.memoryCap, memoryMax);
  } finally {
    try { execFileSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' }); } catch {}
    child.kill();
  }
});
