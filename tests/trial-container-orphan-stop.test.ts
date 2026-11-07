import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { ChildRun } from '../src/child-runner.js';
import { stopOrphanTrialContainers } from '../src/daemon/disk-headroom.js';
import { trialContainerLaunch } from '../src/merge-writer/trial-container.js';

test('unit:tests/trial-container-orphan-stop.test.ts — the sweep stops a running trial container whose checkout is gone or that outlived twice the deadline, never a current one', async () => {
  const base = await temporaryDirectory('orphan-trial', process.cwd());
  const live = join(base, 'live');
  await mkdir(live);
  const now = Date.parse('2026-11-06T12:00:00Z'), maxAgeMs = 40 * 60_000;
  const started = (minutes: number) => new Date(now - minutes * 60_000).toISOString().replace('Z', '123456Z');
  const calls: string[][] = [];
  const run = (async (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'ps') return 'graphyard-trial-current\ngraphyard-trial-gone\ngraphyard-trial-old\n';
    if (args[0] === 'inspect') return [
      `/graphyard-trial-current\t${started(10)}\t${live}`,
      `/graphyard-trial-gone\t${started(10)}\t${join(base, 'verify-deleted')}`,
      `/graphyard-trial-old\t${started(23 * 60)}\t${live}`,
    ].join('\n');
    return '';
  }) as ChildRun;
  const stopped = await stopOrphanTrialContainers(run, maxAgeMs, now);
  assert.deepEqual(stopped, ['container graphyard-trial-gone', 'container graphyard-trial-old']);
  assert.deepEqual(calls.filter(args => args[0] === 'rm'), [['rm', '--force', 'graphyard-trial-gone'], ['rm', '--force', 'graphyard-trial-old']], 'a current trial\'s container is left alone');
  assert.ok(calls[0]!.includes('status=running'), 'running trial containers are what it judges');
});

// A stand-in docker CLI: it logs each call; `start` holds the attached client until `rm` ends it, as Docker does.
const fakeDocker = (log: string) => `#!/bin/sh
echo "$*" >> ${JSON.stringify(log)}
case "$3" in
  start) echo $$ > ${JSON.stringify(log + '.client')}; exec sleep 60 ;;
  rm) kill "$(cat ${JSON.stringify(log + '.client')})" 2>/dev/null; exit 0 ;;
esac
exit 0
`;

async function launched(base: string, deadline?: number) {
  const bin = join(base, 'bin'), log = join(base, 'docker.log');
  await mkdir(bin);
  await writeFile(join(bin, 'docker'), fakeDocker(log));
  await chmod(join(bin, 'docker'), 0o755);
  const [program, ...words] = trialContainerLaunch({ image: 'graphyard-trial:local', mounts: [], network: 'none', deadline });
  const child = spawn(program!, [...words, 'sleep', '600'], { cwd: base, env: { PATH: `${bin}:/usr/bin:/bin` }, stdio: 'ignore' });
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  for (let waited = 0; !(await calls()).some(line => line.includes(' start ')); waited += 50) {
    assert.ok(waited < 10_000, 'the launcher starts its container');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return { child, calls };
}

test('unit:tests/trial-container-orphan-stop.test.ts — a trial container stops at the trial deadline by itself, and an aborted trial removes its container', async () => {
  const base = await temporaryDirectory('trial-deadline', process.cwd());
  const deadline = Date.now() + 90_000;
  const { child, calls } = await launched(base, deadline);
  const create = (await calls()).find(line => line.includes(' create '))!;
  const bounded = / --entrypoint \/usr\/bin\/env graphyard-trial:local \/usr\/bin\/timeout --kill-after=10 (\d+) sleep 600$/.exec(create);
  assert.ok(bounded, `the container's command is bounded by the trial deadline: ${create}`);
  assert.ok(Number(bounded[1]) >= 85 && Number(bounded[1]) <= 90, 'the bound is the time left to the deadline');
  // Aborting the trial (its runner signals the launcher) leaves no container running.
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
  const name = /--name (graphyard-trial-[0-9a-f]+)/.exec(create)![1]!;
  assert.ok((await calls()).some(line => line.endsWith(`rm --force ${name}`)), 'the aborted trial\'s container is removed');
});
