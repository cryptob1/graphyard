import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bootstrapGate, gateRecordPath, readGateRecord, writeGateRecord, type GateRecord } from '../src/batch-gate.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { runDaemon } from '../src/daemon/run.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3161: a release handover stops the loop and kills the gate's git fetch with it. That is no gate
// outcome: main-gate.json keeps its last one and the journal stays quiet. A fetch failing while the
// loop keeps running is still an error.

const repository = 'owner/project';
const fetchFailure = 'Command failed: git -C /checkout fetch --no-tags origin main';
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository, baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy' } } });
const unused = new Proxy({}, { get: (_, name) => { throw new Error(`the gate cycle called ${String(name)}`); } });

/** One loop cycle whose gate fetch runs `interrupted` and then fails; answers the journal and the record's file. */
async function cycleWithFailingFetch(label: string, interrupted: (stop: () => void) => void) {
  const root = await temporaryDirectory(label), file = gateRecordPath(root);
  await mkdir(join(root, '.graphyard'), { recursive: true });
  const previous: GateRecord = { ...bootstrapGate(repository, 'a'.repeat(40)), diagnosticsAt: new Date().toISOString(),
    lastOutcome: { tip: 'b'.repeat(40), outcome: 'verified', reason: null, finishedAt: '2030-01-01T00:00:00.000Z' } };
  await writeGateRecord(file, previous);
  const host = new EventEmitter() as unknown as NodeJS.Process, logs: string[] = [];
  const mergeWriter = { baseBranch: 'main', now: Date.now, gate: { root, repository }, git: async () => '',
    fetch: async () => { interrupted(() => host.emit('SIGUSR2')); throw new Error(fetchFailure); } } as unknown as MergeWriterReads;
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), snapshot: async () => ({ work: [], now: new Date().toISOString() }),
    closeSession: () => {}, dispatch: async () => {}, decisions: async () => ({ decisions: [] }), persist: async () => {}, github: unused, merge: unused, mergeWriter } as unknown as DaemonEffects;
  await runDaemon(config, emptyDaemonState(config), effects, { once: true, intervalMs: 20_000, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGUSR2'], process: host, log: line => logs.push(line) });
  return { file, logs, previous };
}

test('unit:gate-handover-fetch-not-error — a gate fetch interrupted by the loop stopping leaves lastOutcome unchanged and logs no merge failed line; one failing while the loop runs is still recorded as error (GY-3161)', async () => {
  const handover = await cycleWithFailingFetch('gate-handover', stop => stop());
  await delay(250); // the gate settles beside the cycle, after the loop has returned
  assert.deepEqual(readGateRecord(handover.file)!.lastOutcome, handover.previous.lastOutcome, 'the interrupted cycle is no outcome');
  assert.deepEqual(handover.logs.filter(line => line.includes('merge failed')), [], 'the journal stays quiet');

  const outage = await cycleWithFailingFetch('gate-fetch-outage', () => {});
  for (let waited = 0; readGateRecord(outage.file)!.lastOutcome?.outcome !== 'error' && waited < 5_000; waited += 20) await delay(20);
  const recorded = readGateRecord(outage.file)!.lastOutcome!;
  assert.deepEqual([recorded.outcome, recorded.reason], ['error', fetchFailure]);
  for (let waited = 0; !outage.logs.some(line => line.includes('merge failed')) && waited < 5_000; waited += 20) await delay(20);
  assert.ok(outage.logs.some(line => line.includes('merge failed') && line.includes(fetchFailure)), 'the journal names the failure');
});
