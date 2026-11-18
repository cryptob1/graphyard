import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sessionLaunch } from '../src/runner/pi.js';
import { sessionScopes, sessionSlice } from '../src/session-share.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3438: the kernel's fair sharing of real session scopes, measured from their cgroup cpu.stat.
// It needs a systemd user manager to start scopes, which a merge trial's container lacks: there it
// is skipped, and the post-deploy reading (AC-3) shows it on the serving host.
const hostOnly = (() => { try { execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore', timeout: 5_000 }); return false; } catch { return 'no systemd user manager answers here'; } })();

/** Starts a session scope running `script` the way a session launch does, and stops it on `close`. */
async function liveSession(name: string, script: string) {
  const base = await temporaryDirectory(`session-fair-share-${name}`);
  const id = `fair-${name}-${process.pid}-${Date.now()}`, unit = `graphyard-run-${id}.scope`, cgroup = join(sessionSlice(), unit);
  const launch = sessionLaunch(base, id, '/bin/sh', ['-c', script], 'systemd');
  const child: ChildProcess = spawn(launch.file, launch.args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let refused = '';
  child.on('error', error => { refused += error.message; });
  child.stderr!.on('data', chunk => { refused += chunk; });
  let started = false;
  for (let tries = 0; tries < 50 && !started; tries++) { started = await readFile(join(cgroup, 'cpu.stat'), 'utf8').then(() => true, () => false); if (!started) await delay(100); }
  assert.ok(started, `systemd-run started no scope ${unit}: ${refused.trim() || 'no error printed'}`);
  return {
    unit, cgroup,
    file: (name: string) => readFile(join(cgroup, name), 'utf8').then(text => text.trim()),
    usage: async () => Number(/^usage_usec (\d+)/m.exec(await readFile(join(cgroup, 'cpu.stat'), 'utf8'))![1]),
    close: () => { try { execFileSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' }); } catch {} child.kill(); },
  };
}
const busy = (processes: number, pin = '') => `for i in $(seq ${processes}); do ${pin}sh -c 'while :; do :; done' & done; wait`;

test('live:session-fair-share — a lone session running 16 busy processes may use the whole machine: no CPUQuota or MemoryMax on its scope', { skip: hostOnly }, async () => {
  const lone = await liveSession('lone', busy(16));
  try {
    assert.equal(await lone.file('cpu.max'), 'max 100000', 'no CPUQuota');
    assert.equal(await lone.file('memory.max'), 'max', 'no MemoryMax');
    assert.equal(await lone.file('cpu.weight'), '100');
    assert.equal(await lone.file('io.weight').catch(() => 'default 100'), 'default 100');
    assert.match(await lone.file('memory.high'), /^\d+$/, 'MemoryHigh at its share');
    assert.ok(sessionScopes().some(scope => scope.unit === lone.unit), 'the loop lists it as a live session');
    await delay(1_000);
    const before = await lone.usage(), from = performance.now();
    await delay(4_000);
    const cores = ((await lone.usage()) - before) / ((performance.now() - from) * 1000);
    const floor = Math.min(4, availableParallelism() / 2);
    assert.ok(cores > floor, `the lone session used ${cores.toFixed(2)} cores, more than ${floor}: nothing caps it`);
  } finally { lone.close(); }
});

test('live:session-fair-share — two sessions on one contended CPU, one running 16 busy processes and one running 1, each get about half of it', { skip: hostOnly }, async () => {
  // Both pinned to the same CPU, so they contend whatever else the host runs: without equal session
  // weights the 16 processes would take 16/17 of it.
  const cpu = availableParallelism() - 1, pin = `taskset -c ${cpu} `;
  const greedy = await liveSession('greedy', busy(16, pin)), modest = await liveSession('modest', busy(1, pin));
  try {
    await delay(1_000);
    const before = [await greedy.usage(), await modest.usage()];
    await delay(5_000);
    const used = [(await greedy.usage()) - before[0]!, (await modest.usage()) - before[1]!];
    const half = used[0]! / (used[0]! + used[1]!);
    assert.ok(half > 0.3 && half < 0.7, `the 16-process session took ${Math.round(half * 100)}% of the contended CPU, the 1-process session ${Math.round((1 - half) * 100)}%: each about half`);
  } finally { greedy.close(); modest.close(); }
});
