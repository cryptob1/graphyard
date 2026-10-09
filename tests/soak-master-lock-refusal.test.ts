import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runDaemon, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { readLockRefusal, recordingLockRefusal, unsupervisedHolderAttention, type LockRefusal } from '../src/master/loop-restart.js';
import type { InvariantCheck } from '../src/model/invariants.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1603 over simulated days, through the real loop. An unsupervised `master run` holds this
 * repository's lock and cycles; this install's unit restarts its own `master run` every RestartSec
 * into the same lock refusal, each one passing through `recordingLockRefusal` exactly as the
 * `master run` command does; and `master status` reads the cursor and the refusal record at any
 * moment, including while a refusal is being written. Invariants, after every cycle of the holder:
 * every system invariant docs/master-agent.md lists is judged and holds; status names the holder
 * with a count that equals the refusals so far and never falls; and once the holder is gone the
 * unit's run takes the lock, nothing more is refused, and status raises nothing.
 */
const minute = 60_000, cycleMs = 15 * minute, days = 2, restartSec = 10_000;
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const unit = { unit: 'graphyard-master-soak.service', mainPid: 0 };
/** The system invariants docs/master-agent.md documents as judged every cycle. */
async function documentedInvariants() {
  const guide = await readFile(new URL('../docs/master-agent.md', import.meta.url), 'utf8');
  const line = guide.split('\n').find(entry => entry.startsWith('Per cycle (`daemon.invariants.lines`)'))!;
  return [...line.matchAll(/`([a-z0-9-]+)` \(/g)].map(match => match[1]);
}

test('unit:soak-lock-refusal-visible — over two simulated days the real loop holds the lock outside the unit while the unit\'s master run is refused on it every cycle: every documented system invariant holds after every cycle, status names the holder on every read with a count that tracks the refusals, and once the holder is gone the unit\'s run takes the lock and status raises nothing', { timeout: 600_000 }, async () => {
  const root = await temporaryDirectory('soak-lock-refusal');
  execFileSync('git', ['init', '-q', root]);
  await mkdir(join(root, '.graphyard'), { recursive: true });
  const credentialFile = join(root, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'soak-host',
    masterAgentName: 'graphyard-master-soak', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const documented = await documentedInvariants();
  assert.ok(documented.length >= 7, `docs/master-agent.md lists the per-cycle invariants: ${documented.join(', ')}`);

  const start = Date.parse('2030-01-01T00:00:00Z');
  let elapsed = 0;
  const now = () => start + elapsed, iso = () => new Date(now()).toISOString();
  // The unsupervised loop's process: its pid is the one on the lock, alive until master restart stops it.
  const holder = spawn('sleep', ['600'], { stdio: 'ignore' });
  const holderPid = holder.pid!;
  /** The cursor as the loop last persisted it: what `master run` and `master status` read. */
  let cursor: DaemonState | null = null;
  const effects = (persist: DaemonEffects['persist'], snapshot: DaemonEffects['snapshot']): DaemonEffects => ({
    agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot, closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist,
  });
  const cleanCheckout = () => ({ root: '/', commit: null, modified: [], untracked: [] });
  /** One unit restart: `master run` reads the cursor, and its runDaemon is refused on the holder's lock. */
  let refusals = 0;
  const unitRun = async () => {
    const read = structuredClone(cursor!), held = read.lock && read.lock.pid !== process.pid ? read.lock : null;
    const run = runDaemon(master, read, effects(async () => {}, async () => ({ work: [], now: iso() })), { once: true, intervalMs: cycleMs, identity: { pid: process.pid, host: master.hostId }, signals: [], now, log: () => {}, checkout: cleanCheckout });
    return recordingLockRefusal(root, held, run);
  };
  /** `master status`: the refusal record against the live lock on the cursor. */
  const status = async () => {
    const refusal = await readLockRefusal(root);
    return { refusal, item: unsupervisedHolderAttention({ refusal, lock: cursor?.lock ?? null, hostId: master.hostId, unit }) };
  };

  const violations: string[] = [], misses: string[] = [], judged = new Set<string>();
  let cycles = 0, statusReads = 0, last = 0;
  const totalCycles = days * 24 * 60 * minute / cycleMs;
  const snapshot: DaemonEffects['snapshot'] = async () => {
    // After the previous cycle: every documented invariant judged and holding.
    if (cycles > 0) {
      const report = (cursor?.invariants.report ?? []) as InvariantCheck[];
      for (const check of report) { judged.add(check.invariant); if (!check.holds) violations.push(`cycle ${cycles} (+${elapsed / minute} min): ${check.line}`); }
      for (const name of documented) if (!report.some(check => check.invariant === name)) violations.push(`cycle ${cycles}: ${name} was not judged`);
    }
    if (cycles >= totalCycles) process.emit('SIGUSR2' as NodeJS.Signals);
    return { work: [], now: iso() };
  };
  /** The holder's sleep between cycles: the simulated interval passes, and the unit restarts into the refusal every RestartSec of it while status reads race each refusal's write. */
  const wake = { sleep: async () => {
    cycles++;
    for (let restart = 0; restart < 3; restart++) {
      elapsed += restartSec;
      const reading = Promise.all([status(), status()]);
      await assert.rejects(unitRun(), new RegExp(`Another Graphyard master loop holds this repository \\(pid ${holderPid} on ${master.hostId}`));
      refusals++;
      const reads = [...await reading, await status()];
      for (const [index, read] of reads.entries()) {
        statusReads++;
        // Only the reads begun before the very first refusal may find no record yet.
        if (!read.refusal || !read.item) { if (refusals > 1 || index === reads.length - 1) misses.push(`cycle ${cycles}: ${read.refusal ? 'no attention' : 'no record'}`); continue; }
        if (read.refusal.count < last) misses.push(`cycle ${cycles}: count fell from ${last} to ${read.refusal.count}`);
        last = Math.max(last, read.refusal.count);
        if (!read.item.text.includes(`pid ${holderPid} on ${master.hostId}`)) misses.push(`cycle ${cycles}: attention names another holder: ${read.item.text}`);
      }
      const settled = await readLockRefusal(root);
      if (settled?.count !== refusals) misses.push(`cycle ${cycles}: ${settled?.count} refusal(s) recorded of ${refusals}`);
    }
    elapsed = cycles * cycleMs;
    return [] as string[];
  } };

  const holderState = emptyDaemonState(master);
  let lastHeld: DaemonState['lock'] = null;
  const persist: DaemonEffects['persist'] = async state => { cursor = structuredClone(state); if (state.lock) lastHeld = structuredClone(state.lock); };
  const result = await runDaemon(master, holderState, effects(persist, snapshot), { intervalMs: 1, identity: { pid: holderPid, host: master.hostId }, signals: ['SIGUSR2'], now, log: () => {}, checkout: cleanCheckout, wake });

  assert.deepEqual(result.failed, [], 'no cycle of the holder failed');
  assert.ok(result.cycles.length >= totalCycles, `the holder cycled through ${days} simulated days: ${result.cycles.length} cycles`);
  for (const check of (cursor!.invariants.report ?? []) as InvariantCheck[]) if (!check.holds) violations.push(`last cycle: ${check.line}`);
  assert.deepEqual([...documented].filter(name => !judged.has(name)), [], 'every documented invariant was judged');
  assert.deepEqual(violations, [], 'every system invariant held after every cycle');
  assert.deepEqual(misses, [], 'status named the unsupervised holder on every read, with a count that tracked every refusal');
  assert.ok(statusReads >= refusals * 3 - 2, `status read throughout: ${statusReads} reads over ${refusals} refusals`);
  const recorded = (await readLockRefusal(root)) as LockRefusal;
  assert.equal(recorded.count, refusals); assert.equal(recorded.holder.pid, holderPid);
  assert.deepEqual((await readdir(join(root, '.graphyard'))).filter(name => name.startsWith('master-lock-refusal.json.')), [], 'every published refusal left no temporary file');

  // master restart stops the holder; its lock is left on the cursor as a killed process leaves it.
  holder.kill('SIGTERM');
  await new Promise(done => holder.exitCode !== null || holder.signalCode !== null ? done(null) : holder.once('exit', done));
  cursor = { ...structuredClone(cursor!), lock: lastHeld };
  assert.equal((await status()).item, null, 'a holder that is gone raises nothing');
  const taken = await unitRun();
  assert.equal(taken.cycles.length, 1, 'the unit\'s run takes the reclaimed lock and cycles');
  assert.equal((await readLockRefusal(root))?.count, refusals, 'a run that took the lock records no refusal');
  assert.equal(unsupervisedHolderAttention({ refusal: recorded, lock: { ...lastHeld!, pid: process.pid }, hostId: master.hostId, unit: { ...unit, mainPid: process.pid } }), null, 'the unit\'s own loop is never an unsupervised holder');
});
