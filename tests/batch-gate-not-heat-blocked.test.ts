import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapGate, gateLimitMs, runGate, type GatePorts } from '../src/batch-gate.js';
import { trialContainerLaunch } from '../src/merge-writer/trial-container.js';
import { trialLoad } from '../src/merge-writer/trial-load.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3444 AC-7: the heat launch wait never stops a batch gate check from starting — gate checks run
// at the halved trial cap while hot, other starts still wait — and each check's budget is the
// gate's own remaining time, so excused waiting extends the check too.

const minute = 60_000;

test('integration:batch-gate-not-heat-blocked — at 99C a gate check starts within half the cap while a merge trial waits on heat, and a second gate check waits for the halved cap', async () => {
  const base = await temporaryDirectory('gate-heat', process.cwd());
  const bin = join(base, 'bin'), hwmon = join(base, 'hwmon'), slots = join(base, 'slots'), log = join(base, 'docker.log'), children: ChildProcess[] = [];
  await mkdir(bin); await mkdir(join(hwmon, 'k10temp'), { recursive: true });
  await writeFile(join(hwmon, 'k10temp', 'name'), 'k10temp\n');
  await writeFile(join(hwmon, 'k10temp', 'temp1_input'), '99000\n');
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
  const launch = async (who: 'gate' | 'merge') => {
    const load = { ...await trialLoad(join(base, 'install'), who, 4, 4), slots, hwmon, hotCelsius: 95, floorBytes: 30e9 };
    if (who === 'gate') assert.equal(load.hotCap, Math.floor(load.cap / 2), 'the gate\'s hot cap is half the cap');
    const [program, ...words] = trialContainerLaunch({ image: 'graphyard-trial:local', mounts: [[base, '/scratch', false]], network: 'none', load: { ...load, cap: 2, ...(who === 'gate' ? { hotCap: 1 } : {}) } });
    const child = spawn(program!, [...words, 'sleep', '600'], { cwd: base, env: { PATH: `${bin}:/usr/bin:/bin` }, stdio: ['ignore', 'ignore', 'pipe'] });
    let said = '';
    child.stderr!.on('data', chunk => { said += chunk; });
    children.push(child);
    return { child, said: () => said };
  };
  const until = async (condition: () => boolean | Promise<boolean>, what: string) => {
    for (let waited = 0; !(await condition()); waited += 50) { assert.ok(waited < 15_000, what); await new Promise(resolve => setTimeout(resolve, 50)); }
  };
  const started = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(line => line.includes(' start ')).length;
  try {
    const merge = await launch('merge');
    await until(() => merge.said().includes('waiting: a CPU sensor reads 99C'), 'the merge trial waits on heat');
    const gate = await launch('gate');
    await until(async () => await started() === 1, 'the gate check starts despite the heat');
    assert.doesNotMatch(gate.said(), /CPU sensor/, 'the gate never waited on heat');
    const second = await launch('gate');
    await until(() => second.said().includes('waiting: the machine-wide cap of 1 trial containers is reached'), 'a second gate check waits for the halved cap');
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(await started(), 1, 'the merge trial still waits on heat, and the halved cap holds');
  } finally { for (const child of children) if (child.exitCode === null && child.signalCode === null) { const gone = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM'); await gone; } }
});

test('integration:batch-gate-not-heat-blocked — a check\'s budget is the gate\'s own remaining time: 50 minutes of excused waiting extend it, and it is stopped once its own time is spent', async () => {
  const clock = { now: Date.parse('2026-11-17T08:00:00Z') };
  let waiting = false, signal: AbortSignal | undefined;
  const ports: GatePorts = {
    now: () => clock.now, fetch: async () => 'b'.repeat(40), landings: async () => [], files: async () => ['src/a.ts'], catalog: async () => [], core: async () => [],
    waiting: () => waiting, revert: async () => { throw new Error('unused'); }, file: async () => ({ item: null }),
    run: (_commit, _checks, _files, _timeoutMs, stop) => { signal = stop; return new Promise<string[]>((_, reject) => stop!.addEventListener('abort', () => reject(new Error('stopped')))); },
  };
  const gate = runGate(ports, bootstrapGate('owner/project', 'a'.repeat(40)));
  const sleep = () => new Promise(resolve => setTimeout(resolve, 1300));
  await sleep();
  waiting = true; clock.now += 50 * minute; await sleep();
  assert.equal(signal?.aborted, false, '50 minutes waiting on heat or a slot do not spend the check\'s budget');
  waiting = false; clock.now += gateLimitMs - 10 * minute; await sleep();
  assert.equal(signal?.aborted, false, 'inside its own time the check runs on');
  clock.now += 11 * minute; await sleep();
  assert.equal(signal?.aborted, true, 'past its own time the check is stopped');
  assert.equal((await gate).outcome, 'timeout');
});
