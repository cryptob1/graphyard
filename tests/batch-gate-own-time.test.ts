import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapGate, gateLimitMs, runGate, type GatePorts, type GateRecord } from '../src/batch-gate.js';
import { trialContainerLaunch } from '../src/merge-writer/trial-container.js';
import { gateCpuShares, trialLoad, trialStartOrder, trialStartWaiting } from '../src/merge-writer/trial-load.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3444 AC-5: the gate's bound measures its own work, not its waits for a trial slot or CPU; its
// containers run under a higher CPU weight than merge trials and worker verification; and a gate
// held for timing out retries on main's newest tip within one cycle instead of staying held.

const verified = 'a'.repeat(40), tip = 'b'.repeat(40), newer = 'c'.repeat(40);
const minute = 60_000;

function gatePorts(run: GatePorts['run'], clock: { now: number }, waiting: () => boolean, fetch = async () => tip): GatePorts {
  return { now: () => clock.now, fetch, landings: async () => [], files: async () => ['src/a.ts'], catalog: async () => [], core: async () => [],
    run, waiting, revert: async () => { throw new Error('unused'); }, file: async () => ({ item: null }) };
}

test('integration:batch-gate-own-time — 40 minutes waiting for a slot and 30 of work stay inside the 45-minute bound, and the wait is kept on the record for a restart; the same 70 minutes of work time out', async () => {
  const clock = { now: Date.parse('2026-11-17T08:00:00Z') };
  let waiting = false;
  const kept: number[] = [];
  const ports = gatePorts(async () => {
    waiting = true; clock.now += 40 * minute;
    await new Promise(resolve => setTimeout(resolve, 1300)); // the gate samples its waits while the run goes on
    waiting = false; clock.now += 30 * minute;
    return [];
  }, clock, () => waiting);
  const record: GateRecord = bootstrapGate('owner/project', verified);
  ports.checkpoint = async () => { if (record.inFlight?.waitedMs) kept.push(record.inFlight.waitedMs); };
  const outcome = await runGate(ports, record);
  assert.equal(outcome.outcome, 'verified', 'the wait is not the gate\'s own time');
  assert.ok(kept.at(-1)! >= 40 * minute, 'the waited time rides the record, so a restart keeps it');

  const busy = { now: Date.parse('2026-11-17T08:00:00Z') };
  const working = gatePorts(async () => { busy.now += 70 * minute; return []; }, busy, () => false);
  const slow = await runGate(working, bootstrapGate('owner/project', verified));
  assert.equal(slow.outcome, 'timeout', '70 minutes of the gate\'s own work is past its bound');
  assert.equal(gateLimitMs, 45 * minute);
});

test('integration:batch-gate-own-time — a timed-out gate never holds: the next run retries at once on main\'s newest tip, and a timeout hold an older loop wrote clears without a cool-off', async () => {
  const clock = { now: Date.parse('2026-11-17T08:00:00Z') };
  let main = tip;
  const gated: string[] = [];
  const ports = gatePorts(async commit => { gated.push(commit); if (commit === tip) clock.now += gateLimitMs + 1; return []; }, clock, () => false, async () => main);
  const record = bootstrapGate('owner/project', verified);
  record.held = { tip, reason: `the batch gate timed out twice (past 45 minutes) on ${tip.slice(0, 12)}; ${verified.slice(0, 12)} stays served`, at: new Date(clock.now).toISOString() };
  assert.equal((await runGate(ports, record)).outcome, 'timeout', 'the old timeout hold cleared at once and the tip ran');
  assert.equal(record.held, null, 'a timeout holds nothing');
  main = newer;
  assert.equal((await runGate(ports, record)).outcome, 'verified');
  assert.deepEqual(gated, [tip, newer], 'the retry gated main\'s newest tip');
  assert.equal(record.verified, newer);
});

test('integration:batch-gate-own-time — a gate start waiting for a slot is visible to the gate and its container runs under a higher CPU weight than a merge trial', async () => {
  const base = await temporaryDirectory('gate-own-time', process.cwd());
  const bin = join(base, 'bin'), hwmon = join(base, 'hwmon'), slots = join(base, 'slots'), log = join(base, 'docker.log'), children: ChildProcess[] = [];
  await mkdir(bin); await mkdir(hwmon);
  await writeFile(join(bin, 'docker'), `#!/bin/sh
echo "$*" >> ${JSON.stringify(log)}
case "$3" in
  start) for name; do :; done; echo $$ > ${JSON.stringify(log)}."$name"; exec sleep 60 ;;
  rm) for name; do :; done; kill "$(cat ${JSON.stringify(log)}."$name")" 2>/dev/null; exit 0 ;;
esac
exit 0
`);
  await writeFile(join(bin, 'df'), '#!/bin/sh\necho Avail\necho 100000000000\n');
  await chmod(join(bin, 'docker'), 0o755); await chmod(join(bin, 'df'), 0o755);
  const root = join(base, 'install');
  const launch = async (who: 'gate' | 'merge') => {
    const load = { ...await trialLoad(root, who), slots, cap: 1, hwmon, hotCelsius: 95, floorBytes: 30e9 };
    const [program, ...words] = trialContainerLaunch({ image: 'graphyard-trial:local', mounts: [[base, '/scratch', false]], network: 'none', load });
    const child = spawn(program!, [...words, 'sleep', '600'], { cwd: base, env: { PATH: `${bin}:/usr/bin:/bin` }, stdio: ['ignore', 'ignore', 'pipe'] });
    let said = '';
    child.stderr!.on('data', chunk => { said += chunk; });
    children.push(child);
    return { child, said: () => said };
  };
  const until = async (condition: () => boolean | Promise<boolean>, what: string) => {
    for (let waited = 0; !(await condition()); waited += 50) { assert.ok(waited < 15_000, what); await new Promise(resolve => setTimeout(resolve, 50)); }
  };
  const creates = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(line => line.includes(' create '));
  const end = async (child: ChildProcess) => { const gone = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM'); await gone; };
  try {
    assert.ok(trialStartOrder.gate < trialStartOrder.merge);
    const merge = await launch('merge');
    await until(async () => (await creates()).length === 1, 'the merge trial takes the one slot');
    assert.doesNotMatch((await creates())[0]!, /--cpu-shares/, 'a merge trial keeps Docker\'s default CPU weight');
    assert.equal(trialStartWaiting('gate', slots), false, 'no gate start waits yet');
    const gate = await launch('gate');
    await until(() => gate.said().includes('waiting'), 'the gate start waits for the slot');
    assert.equal(trialStartWaiting('gate', slots), true, 'the gate sees its start waiting, time its bound does not count');
    assert.equal(trialStartWaiting('merge', slots), false);
    await end(merge.child);
    await until(() => gate.said().includes('starting'), 'the gate starts once the slot frees');
    await until(() => !trialStartWaiting('gate', slots), 'its wait ends with the start');
    const gateCreate = (await creates())[1]!;
    assert.match(gateCreate, new RegExp(`--cpu-shares=${gateCpuShares}`), 'the gate container runs under the higher CPU weight');
    assert.ok(gateCpuShares > 1024, 'higher than the default weight merge trials and worker verification run under');
  } finally { for (const child of children) if (child.exitCode === null && child.signalCode === null) await end(child); }
});
