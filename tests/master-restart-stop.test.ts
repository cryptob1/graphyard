import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { detachedLaunch } from '../src/runner/pi.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1432: every self-upgrade restart of graphyard-master.service hung in 'final-sigterm' for the
 * full TimeoutStopSec. The loop's scratch runs (triage, diagnosis) lie in the unit's own cgroup,
 * and the watchdog bounding each one ran `trap '' TERM; sleep N`: an ignored TERM is inherited
 * across exec, so the `sleep` outlived the unit's stop signal — and, once Pi had exited, the
 * shell's KILL of the watchdog subshell left that `sleep` orphaned in the cgroup until its bound.
 *
 * systemd stops a unit by sending KillSignal to every process in its cgroup. These tests do the
 * same to every process in the run's session (the run leads its own session, so its session is
 * exactly what it put in the unit's cgroup), without needing a user manager. Each is named for the
 * proof it produces: unit:detached-launch-no-term-immune-children,
 * integration:master-restart-stop-completes and integration:master-stop-leaves-no-orphans.
 */

const linux = process.platform === 'linux';
const skip = linux ? false : 'reads /proc';
/** A scratch run's bound, as the runner computes it: far longer than any test waits. */
const boundSeconds = 600;

/** Every live process in a session: pid, command and its ignored-signal mask. */
function sessionMembers(sid: number) {
  const members: { pid: number; comm: string; ignored: bigint }[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8'), end = stat.lastIndexOf(') ');
      const fields = stat.slice(end + 2).split(' ');
      if (fields[0] === 'Z' || Number(fields[3]) !== sid) continue;
      const status = readFileSync(`/proc/${entry}/status`, 'utf8');
      const ignored = BigInt(`0x${/^SigIgn:\s*([0-9a-f]+)/m.exec(status)?.[1] ?? '0'}`);
      members.push({ pid: Number(entry), comm: readlinkSync(`/proc/${entry}/exe`).split('/').pop() ?? '', ignored });
    } catch { /* gone meanwhile */ }
  }
  return members;
}
const ignoresTerm = (mask: bigint) => (mask & (1n << 14n)) !== 0n; // SIGTERM is 15; bit 15-1

/** Starts a bounded scratch run of `command` the way the runner does: detached, leading its own session. */
async function launch(command: string, args: string[]) {
  const directory = await temporaryDirectory('master-restart-stop');
  const run = detachedLaunch(directory, 'scratch', command, args, 'setsid', [], boundSeconds);
  const child = spawn(run.file, run.args, { stdio: 'ignore', detached: true });
  child.unref();
  const sid = child.pid!;
  // The shell, the watchdog subshell, its sleep and the run itself.
  for (let i = 0; i < 100 && sessionMembers(sid).length < 4; i++) await delay(20);
  const exit = async () => {
    for (let i = 0; i < 200 && !existsSync(`${directory}/exit`); i++) await delay(25);
    return existsSync(`${directory}/exit`) ? readFileSync(`${directory}/exit`, 'utf8').trim() : null;
  };
  return { directory, sid, exit };
}
/** What systemd does at a unit's stop: KillSignal to every process in the cgroup at once. */
function stopUnit(sid: number) {
  for (const member of sessionMembers(sid)) try { process.kill(member.pid, 'SIGTERM'); } catch { /* gone */ }
}
async function drained(sid: number, withinMs: number) {
  // Empty on three reads in a row: a process mid-exec can drop out of a /proc scan.
  const started = Date.now();
  let empty = 0;
  while (empty < 3 && Date.now() - started < withinMs) { empty = sessionMembers(sid).length ? 0 : empty + 1; await delay(40); }
  return { left: sessionMembers(sid), tookMs: Date.now() - started };
}
const cleanup = (sid: number) => { for (const member of sessionMembers(sid)) try { process.kill(member.pid, 'SIGKILL'); } catch { /* gone */ } };

test('unit:detached-launch-no-term-immune-children — no process a bounded detached launch starts ignores SIGTERM, and the bound is still enforced on the run', { skip }, async () => {
  const run = await launch('sleep', ['1000']);
  try {
    const members = sessionMembers(run.sid);
    assert.ok(members.length >= 4, `the run, its shell and its watchdog are up: ${JSON.stringify(members.map(member => member.comm))}`);
    assert.deepEqual(members.filter(member => ignoresTerm(member.ignored)).map(member => `${member.pid} ${member.comm}`), [], 'nothing in the launch is immune to the unit\'s stop signal');
  } finally { cleanup(run.sid); }
  // The script itself never ignores TERM around a long wait: only for the instant the watchdog signals its own group.
  const script = detachedLaunch('/run', 'x', 'pi', [], 'setsid', [], boundSeconds).args[1];
  assert.doesNotMatch(script, /trap '' TERM; sleep/);
  assert.match(script, /trap '' TERM; kill -TERM -\$\$; trap 'exit 0' TERM;/);

  // The bound still ends the run: a one-second bound stops a run that would sleep for minutes.
  const directory = await temporaryDirectory('master-restart-bound');
  const bounded = detachedLaunch(directory, 'bounded', 'sleep', ['1000'], 'setsid', [], 1);
  const child = spawn(bounded.file, bounded.args, { stdio: 'ignore', detached: true });
  child.unref();
  try {
    const { left } = await drained(child.pid!, 10_000);
    assert.deepEqual(left, [], 'the watchdog stopped the whole run at its bound, and nothing of it lingers');
    assert.equal(readFileSync(`${directory}/exit`, 'utf8').trim(), '143', 'the run ended on the watchdog\'s TERM and its exit was recorded');
  } finally { cleanup(child.pid!); }
  // A run that ignores TERM itself is KILLed once the grace after the bound has passed.
  const stubborn = await temporaryDirectory('master-restart-stubborn');
  const immune = detachedLaunch(stubborn, 'stubborn', 'sh', ['-c', "trap '' TERM; sleep 1000"], 'setsid', [], 1);
  const ignoring = spawn(immune.file, immune.args, { stdio: 'ignore', detached: true });
  ignoring.unref();
  try {
    const { left, tookMs } = await drained(ignoring.pid!, 15_000);
    assert.deepEqual(left, [], 'the group was KILLed after the grace');
    assert.ok(tookMs >= 4_000, `the run had its grace before the KILL (${tookMs}ms)`);
  } finally { cleanup(ignoring.pid!); }
});

test('integration:master-restart-stop-completes — a unit stop reaches every process of a bounded scratch run: the session drains in seconds, never waiting out TimeoutStopSec, and the run\'s exit is recorded', { skip }, async () => {
  for (let restart = 1; restart <= 3; restart++) {
    const run = await launch('sleep', ['1000']);
    try {
      stopUnit(run.sid);
      const { left, tookMs } = await drained(run.sid, 10_000);
      assert.deepEqual(left.map(member => `${member.pid} ${member.comm}`), [], `restart ${restart}: every process left the unit on its stop signal`);
      assert.ok(tookMs < 5_000, `restart ${restart}: the stop took ${tookMs}ms, seconds rather than TimeoutStopSec`);
      assert.equal(await run.exit(), '143', `restart ${restart}: the shell recorded the run's exit on the stop signal`);
    } finally { cleanup(run.sid); }
  }
});

test('integration:master-stop-leaves-no-orphans — a scratch run that ends by itself takes its watchdog and the watchdog\'s sleep with it, so nothing is left for a later stop to wait on', { skip }, async () => {
  const run = await launch('sleep', ['1']);
  try {
    const { left, tookMs } = await drained(run.sid, 8_000);
    assert.deepEqual(left.map(member => `${member.pid} ${member.comm}`), [], 'no watchdog sleep outlives the run it bounded');
    assert.ok(tookMs < 6_000, `the session emptied ${tookMs}ms after the run, not at its ${boundSeconds}s bound`);
    assert.equal(await run.exit(), '0');
  } finally { cleanup(run.sid); }
  // And a stop that arrives after the run ended finds nothing at all.
  const stopped = await launch('sleep', ['1000']);
  try {
    stopUnit(stopped.sid);
    assert.deepEqual((await drained(stopped.sid, 5_000)).left, []);
  } finally { cleanup(stopped.sid); }
});
