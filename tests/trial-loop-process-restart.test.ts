import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { pipelineWorld, git } from './helpers/pipeline-world.js';
import { trialRunsDirectory, stopTrialRun } from '../src/merge-writer/trial-run.js';
import type { DaemonState } from '../src/daemon/state.js';

const waitFor = async <T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string, ms = 60000): Promise<T> => {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    assert.ok(Date.now() - start < ms, label + ': ' + JSON.stringify(value));
    await delay(100);
  }
};

test('e2e:trial-survives-loop-restart — one and three SIGTERM restarts retain the running trial while main moves', { timeout: 240000 }, async () => {
  for (const restarts of [0, 1, 3]) {
    const world = await pipelineWorld('trial-loop-restart');
    const cursor = join(world.root, 'cursor.json');
    await mkdir(world.trials, { recursive: true });
    const item = await world.submit('Slow trial', { 'item.txt': 'item\n' });
    let child: ChildProcess | undefined, errors = '';
    const start = () => {
      child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./helpers/trial-restart-process.ts', import.meta.url)),
        JSON.stringify({ checkout: world.checkout, trials: world.trials, url: world.url, config: world.config, database: world.database, cursor })],
        { stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr!.on('data', data => { errors += data; });
    };
    const stop = async () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child!.kill('SIGKILL'), 2000);
      await exited; clearTimeout(timer);
    };
    const state = async (): Promise<DaemonState | null> => {
      try { return JSON.parse(await readFile(cursor, 'utf8')); } catch { return null; }
    };
    try {
      start();
      const initial = (await waitFor(state, value => value?.mergeWriter.inFlight?.step === 'tests', 'tests step starts'))!.mergeWriter.inFlight!;
      const commandsPath = join(world.trials, 'commands.jsonl');
      const commands = async () => (await readFile(commandsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      await waitFor(commands, rows => rows.some(row => row.step === 'tests'), 'slow test command started');
      let restartMs = 0;
      for (let index = 0; index < restarts; index++) {
        const before = Date.now();
        await stop();
        // Another head landed during this trial. Adoption must not cancel the original merge.
        git(world.checkout, 'checkout', '-q', '--detach', world.main());
        await writeFile(join(world.checkout, 'other.txt'), 'main moved ' + index);
        git(world.checkout, 'add', 'other.txt'); git(world.checkout, 'commit', '-qm', 'Other landing');
        git(world.checkout, 'push', '-q', 'origin', 'HEAD:main');
        const previousAdoption = (await state())?.actions['merge-writer-trial-adoption']?.at;
        start();
        const resumed = (await waitFor(state, value => Boolean(value?.actions['merge-writer-trial-adoption']) && value!.actions['merge-writer-trial-adoption']!.at !== previousAdoption &&
          value!.mergeWriter.inFlight?.step === 'tests', 'trial adopted'))!.mergeWriter.inFlight!;
        // Give this process a full cycle: a prior cursor alone must not satisfy the restart check.
        await delay(1200);
        const current = (await state())!.mergeWriter.inFlight!;
        assert.equal(current?.attempt, initial.attempt, errors);
        assert.equal(current?.startedAt, initial.startedAt);
        assert.deepEqual(resumed.run, initial.run);
        assert.deepEqual(current.run, initial.run);
        assert.deepEqual((await commands()).map(row => row.step), ['install', 'build', 'tests']);
        restartMs += Date.now() - before;
      }
      await waitFor(world.work, work => work.find(entry => entry.id === item.id)?.mergeLedger?.state === 'reconciled', 'one merge completes: ' + errors);
      const rows = await commands();
      assert.deepEqual(rows.map(row => row.step), ['install', 'build', 'tests']);
      assert.ok(Date.now() - rows[2].at < 25000 + restartMs + 10000, 'completion stays within one uninterrupted trial plus restarts');
      const events = await world.store.events(item.id);
      assert.equal(events.filter(event => event.kind === 'merge.trial').length, 1);
      assert.equal(events.filter(event => event.kind === 'merge.pushed').length, 1);
      assert.equal((await readdir(trialRunsDirectory(world.checkout))).length, 1);
      assert.equal((await world.work()).find(entry => entry.id === item.id)!.mergeLedger!.mergeSha, world.main());
    } finally {
      await stop();
      for (const name of await readdir(trialRunsDirectory(world.checkout)).catch(() => []))
        await stopTrialRun({ directory: join(trialRunsDirectory(world.checkout), name) });
      await world.close();
    }
  }
});
