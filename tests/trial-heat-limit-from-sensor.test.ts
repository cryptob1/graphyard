import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { trialContainerLaunch } from '../src/merge-writer/trial-container.js';
import { trialHotCelsius, trialStartOrder } from '../src/merge-writer/trial-load.js';

const proof = 'e2e:trial-heat-limit-from-sensor';

// GY-3376: the real launcher against an injected hwmon tree, with stand-in docker and df CLIs.
async function host(label: string, sensor: { name: string; celsius: number; crit?: number; max?: number }) {
  const base = await temporaryDirectory(label, process.cwd());
  const bin = join(base, 'bin'), hwmon = join(base, 'hwmon'), log = join(base, 'docker.log'), dir = join(hwmon, 'hwmon0');
  await mkdir(bin); await mkdir(dir, { recursive: true });
  await writeFile(join(bin, 'docker'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\nexit 0\n`);
  await writeFile(join(bin, 'df'), '#!/bin/sh\necho Avail\necho 100000000000\n');
  await chmod(join(bin, 'docker'), 0o755); await chmod(join(bin, 'df'), 0o755);
  await writeFile(join(dir, 'name'), `${sensor.name}\n`);
  await writeFile(join(dir, 'temp1_input'), `${sensor.celsius * 1000}\n`);
  if (sensor.crit) await writeFile(join(dir, 'temp1_crit'), `${sensor.crit * 1000}\n`);
  if (sensor.max) await writeFile(join(dir, 'temp1_max'), `${sensor.max * 1000}\n`);
  const [program, ...words] = trialContainerLaunch({ image: 'graphyard-trial:local', mounts: [[base, '/scratch', false]], network: 'none',
    load: { slots: join(base, 'slots'), cap: 2, order: trialStartOrder.merge, hotCelsius: trialHotCelsius, floorBytes: 30e9, hwmon, pressureBoundSeconds: 600, waitBoundSeconds: null } });
  const child: ChildProcess = spawn(program!, [...words, 'true'], { cwd: base, env: { PATH: `${bin}:/usr/bin:/bin` }, stdio: ['ignore', 'ignore', 'pipe'] });
  let said = '';
  child.stderr!.on('data', chunk => { said += chunk; });
  const started = async () => (await readFile(log, 'utf8').catch(() => '')).includes(' start ');
  try {
    for (let waited = 0; !(await started()) && !said.includes('waiting'); waited += 50) {
      assert.ok(waited < 15_000, 'the launcher either starts or says it waits');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return { started: await started(), said };
  } finally {
    if (child.exitCode === null) { const gone = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM'); await gone; }
    await rm(base, { recursive: true, force: true });
  }
}

test(`${proof} — a coretemp sensor with a 105C critical point starts a trial at 98C`, async () => {
  const run = await host('heat-crit-cool', { name: 'coretemp', celsius: 98, crit: 105 });
  assert.equal(run.started, true, run.said);
  assert.doesNotMatch(run.said, /waiting/);
});

test(`${proof} — the same sensor at 103C waits, naming the reading and the 102C limit`, async () => {
  const run = await host('heat-crit-hot', { name: 'coretemp', celsius: 103, crit: 105 });
  assert.equal(run.started, false);
  assert.match(run.said, /waiting: a CPU sensor reads 103C, at or over its 102C limit/);
});

test(`${proof} — a sensor with only a 100C max waits at 97C and goes at 96C`, async () => {
  const hot = await host('heat-max-hot', { name: 'k10temp', celsius: 97, max: 100 });
  assert.equal(hot.started, false);
  assert.match(hot.said, /reads 97C, at or over its 97C limit/);
  assert.equal((await host('heat-max-cool', { name: 'k10temp', celsius: 96, max: 100 })).started, true);
});

test(`${proof} — a sensor with neither waits at 95C and goes at 94C`, async () => {
  const hot = await host('heat-none-hot', { name: 'coretemp', celsius: 95 });
  assert.equal(hot.started, false);
  assert.match(hot.said, /reads 95C, at or over its 95C limit/);
  assert.equal((await host('heat-none-cool', { name: 'coretemp', celsius: 94 })).started, true);
});

test(`${proof} — a hot non-CPU sensor (nvme) is ignored`, async () => {
  assert.equal((await host('heat-nvme', { name: 'nvme', celsius: 110, crit: 85 })).started, true);
});
