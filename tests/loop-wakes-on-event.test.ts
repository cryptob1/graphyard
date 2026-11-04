import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { emptyDaemonState, runDaemon, writeDaemonState, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// The loop waits out its interval only when nothing happened: an event another actor writes to the
// ledger (a submission, a verdict, an unblock, a release) starts the next cycle within one poll.

async function loop(intervalMs: number, script: (ledger: { seq: number; actor: string }[], cycles: number[]) => Promise<void>) {
  const credentials = await temporaryDirectory('loop-wakes-on-event');
  const credentialFile = join(credentials, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config = masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:5', credentialFile, cliPath: '/bin/true',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const ledger: { seq: number; actor: string }[] = [{ seq: 1, actor: 'worker-old' }], cycles: number[] = [];
  const started = Date.now(), host = new EventEmitter() as unknown as NodeJS.Process;
  const effects: DaemonEffects = {
    agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {},
    snapshot: async () => { cycles.push(Date.now() - started); return { work: [], now: new Date().toISOString() }; },
    persist: current => writeDaemonState(config, current),
  };
  const run = runDaemon(config, emptyDaemonState(config), effects, { intervalMs, identity: { pid: process.pid, host: 'machine-a' }, process: host, log: () => {},
    events: { read: async () => [...ledger].reverse(), self: 'coordinator-loop', pollMs: 100 } });
  await script(ledger, cycles);
  host.emit('SIGTERM');
  await run;
  return cycles;
}

test('integration:loop-wakes-on-event — a submission wakes a loop on a long interval at once, a burst is one cycle, the loop\'s own events and silence wait out the interval', async () => {
  const cycles = await loop(60_000, async (ledger, cycles) => {
    await delay(500);
    assert.equal(cycles.length, 1, 'nothing new: the interval applies');
    ledger.push({ seq: 2, actor: 'coordinator-loop' });
    await delay(500);
    assert.equal(cycles.length, 1, 'the loop\'s own events never wake it');
    ledger.push({ seq: 3, actor: 'worker-a' }, { seq: 4, actor: 'reviewer-b' }, { seq: 5, actor: 'master' });
    await delay(1_000);
    assert.equal(cycles.length, 2, 'a burst of submissions and verdicts is one cycle');
    await delay(800);
  });
  assert.equal(cycles.length, 2);
  assert.ok(cycles[1] < 3_000, `the woken cycle ran within seconds, not the 60 s interval (${cycles[1]} ms)`);
});

test('integration:loop-wakes-on-event — with no events the interval still bounds the wait', async () => {
  const cycles = await loop(700, async () => { await delay(1_600); });
  assert.equal(cycles.length, 3);
  assert.ok(cycles[1] >= 650 && cycles[2] >= 1_300, `cycles keep the interval: ${cycles.join(', ')}`);
});
