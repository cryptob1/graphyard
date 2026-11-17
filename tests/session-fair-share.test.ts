import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { piRunner, sessionLaunch } from '../src/runner/pi.js';
import { runsDirectory } from '../src/runner/registry.js';
import { graphyardTools } from '../src/runner/payloads.js';
import { systemdContainment } from '../src/session-watch.js';
import { controlPlaneWeight, sessionScopeProperties, sessionShare } from '../src/session-share.js';
import { loopUnitText } from '../src/install/loop-unit.js';
import { herdrServerUnitText } from '../src/herdr-host.js';
import { composeBundle, type AdapterContext } from '../src/install/adapters.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3438: a worker started 16 browsers at once (GY-3411) and nothing noticed: the loop limits only
// what it launches, and the per-session test budget is an env hint agents ignore. Every agent
// session's systemd scope now carries an equal CPUWeight and IOWeight and a MemoryHigh at its share,
// and no hard cap: a lone session may use the whole machine, and under contention the kernel gives
// each session about the same CPU however many processes it runs. The loop, its master (Herdr's
// server), the server and the database carry a higher CPUWeight. The kernel's sharing itself is
// measured from cgroup cpu.stat on a host with a user manager: tests/session-fair-share-live.test.ts.

const gib = 2 ** 30;

test('integration:session-fair-share — session scopes carry equal CPUWeight and IOWeight and MemoryHigh at their share, never a CPUQuota or MemoryMax', () => {
  assert.deepEqual(sessionShare(1, 24, 64 * gib), { cores: 24, memoryBytes: 64 * gib }, 'a lone session\'s share is the whole machine');
  assert.deepEqual(sessionShare(8, 24, 64 * gib), { cores: 3, memoryBytes: 8 * gib });
  assert.deepEqual(sessionShare(20, 24, 64 * gib), { cores: 2, memoryBytes: Math.floor(64 * gib / 12) }, 'never under two cores');
  // A session launched now counts itself among the live sessions.
  assert.deepEqual(sessionScopeProperties(9, 24, 64 * gib), ['-p', 'CPUWeight=100', '-p', 'IOWeight=100', '-p', `MemoryHigh=${Math.floor(64 * gib * (24 / 9) / 24)}`]);
  assert.ok(!sessionScopeProperties(9, 24, 64 * gib).some(word => /CPUQuota|MemoryMax/.test(word)), 'no hard cap');
});

test('integration:session-fair-share — worker, reviewer and producer launches all carry the share on their scope', async () => {
  const share = /^-p CPUWeight=100 -p IOWeight=100 -p MemoryHigh=\d+$/;
  // A worker under `graphyard watch` (a pane session).
  const watched = systemdContainment('codex', ['exec'], (() => '') as unknown as typeof execFileSync);
  assert.match(watched.args.slice(4, watched.args.indexOf('--')).join(' '), share, 'a watched worker scope carries the share');
  // A headless worker or reviewer run (headless-session.ts spawnHeadless launches through sessionLaunch).
  const headless = sessionLaunch('/runs/r1', 'r1', 'claude', ['-p', 'Review it'], 'systemd');
  assert.match(headless.args.slice(5, headless.args.indexOf('--')).join(' '), share, 'a headless session scope carries the share');
  assert.equal(sessionLaunch('/runs/r1', 'r1', 'claude', [], 'setsid').file, '/bin/sh', 'no scope, no share');
  // A producer run on Pi.
  const base = await temporaryDirectory('session-fair-share');
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

test('integration:session-fair-share — the loop, the master, the server and the database carry a higher CPUWeight than any session', () => {
  assert.ok(controlPlaneWeight > 100);
  const weight = new RegExp(`^CPUWeight=${controlPlaneWeight}$`, 'm');
  assert.match(loopUnitText({ root: '/checkout', cliPath: '/checkout/bin/graphyard.mjs', repository: 'owner/project', intervalSeconds: 20, installDir: '/install' }), weight, 'the loop');
  assert.match(herdrServerUnitText('/usr/bin/herdr', null, '/usr/bin'), weight, 'the master, in its Herdr pane');
  const compose = composeBundle({ workdir: '/fixture', installId: 'test', image: 'graphyard:test', port: 4310 } as AdapterContext, []).find(file => file.path.endsWith('compose.yaml'))!.content;
  // Docker maps cpu_shares to the cgroup v2 weight as 1 + (shares - 2) * 9999 / 262142.
  const shares = [...compose.matchAll(/^ {4}cpu_shares: (\d+)$/gm)].map(match => Number(match[1]));
  assert.equal(shares.length, 2, 'the database and the server');
  for (const value of shares) assert.equal(Math.floor(1 + (value - 2) * 9999 / 262142), controlPlaneWeight);
});
