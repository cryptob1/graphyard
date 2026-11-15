import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { withDatabase } from './helpers/postgres.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Work } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, type DaemonState } from '../src/daemon/state.js';
import { runDaemon } from '../src/daemon/run.js';
import { loopLiveness } from '../src/daemon/liveness.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { coordinationViewHeader } from '../src/server/work-view.js';
import { loopPresenceHeader } from '../src/model/loop-presence.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3341: a slow host must not make the loop's own supervisor kill it while it still progresses,
// and a cycle's cost must not grow with every item ever created.

/** The fixture ledger's shape: the core install on 2026-11-15, 3,300 done items and 34 open. */
const DONE = 3_300, OPEN = 34;
const coordinatorToken = 'c'.repeat(40);
const iso = (at: number) => new Date(at).toISOString();
// Real-clock times: the store's recent-merge window compares against statement_timestamp(), not the cycle's clock.
const started = Date.now();
const sha = (seed: string, pad = 'a') => `${seed}`.padEnd(40, pad);

let store: Store; let http: ReturnType<typeof server>; let origin: string; let directory: string;
let config: MasterConfig;

/** A settled done item: delivered long ago, its histories carrying the marker only its whole document holds. */
function doneItem(index: number): Work {
  const id = randomUUID(), key = `GY-D${index + 1}`, at = iso(started - 48 * 3_600_000);
  const head = sha(`${index.toString(16)}d`, 'd');
  const marker = (n: number) => `settled-history:${key} attempt ${n}`;
  return {
    id, key, title: `Delivered ${key}`, description: `The history of ${key}, kept on the ledger.`, type: 'feature', priority: 2, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'It works', proofs: ['unit:item-works'] }], policy: { checks: ['test'], review: true },
    stage: 'done', revision: 3, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: false, epoch: 2,
    lease: null, workspaces: [], submission: null, reworkRequested: false, scenarioRequirements: [], blocker: null, violations: [],
    candidate: { sha: head, baseSha: sha('base'), pr: 1000 + index, branch: `graphyard/gy-${index + 1}-2`, author: 'worker-a' },
    evidence: [{ id: randomUUID(), proof: 'unit:item-works', sha: head, baseSha: sha('base'), policyRevision: 1, producer: 'proof-runner', trusted: true, result: 'pass', executed: 3, skipped: 0, at, environment: 'node', url: `https://ci.example/${index}` },
      { id: randomUUID(), proof: 'e2e:item-e2e', sha: head, baseSha: sha('base'), policyRevision: 1, producer: 'proof-runner', trusted: true, result: 'pass', executed: 1, skipped: 0, at, environment: 'node', url: `https://ci.example/${index}-e2e` }],
    observation: { source: 'control-plane', candidate: { sha: head, baseSha: sha('base') }, files: [`src/module-${index}.ts`], checks: [{ name: 'test', conclusion: 'success' }], reviews: [], merged: true, mergeSha: sha(`${index.toString(16)}m`, 'm'), mergeable: true, protected: false, baseTip: sha('base'), baseTipContained: true, at },
    delivery: { mergedAt: at, mergeSha: sha(`${index.toString(16)}m`, 'm'), authorizationRevision: 3 },
    gates: [{ name: 'build', passed: true, reasons: [] }],
    pipeline: { reworkRounds: 0, attempts: Array.from({ length: 6 }, (_, n) => ({ epoch: n + 1, claimedAt: at, endedAt: at, end: 'complete', note: marker(n) })) },
    sessions: Array.from({ length: 6 }, (_, n) => ({ id: `worker-a:${n}`, kind: 'implementation', principal: 'worker-a', runtime: 'claude', host: 'machine-a', subject: `${key}: attempt ${n}`, startedAt: at, updatedAt: at, endedAt: at, state: 'finished', outcome: marker(n) })),
  } as unknown as Work;
}

/** An open item in one of the stages a live yard holds. */
function openItem(index: number, dependencies: string[] = []): Work {
  const id = randomUUID(), key = `GY-O${index + 1}`, at = iso(started - 600_000);
  const stage = (['ready', 'build', 'review', 'test', 'merge'] as const)[index % 5];
  const head = sha(`${index.toString(16)}o`, 'o');
  return {
    id, key, title: `Open ${key}`, description: `Work in flight.`, type: 'feature', priority: index % 3, dependencies,
    criteria: [{ id: 'AC-1', text: 'It works', proofs: ['unit:item-works'] }], policy: { checks: ['test'], review: true },
    stage, revision: 2, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1,
    lease: null, workspaces: [], submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [],
    candidate: stage === 'ready' ? null : { sha: head, baseSha: sha('base'), pr: 2000 + index, branch: `graphyard/gy-${index + 900}-1`, author: 'worker-a' },
    observation: null, gates: [{ name: 'ready', passed: true, reasons: [] }],
  } as unknown as Work;
}

before(async () => {
  store = await withDatabase('loop-cycle-cost'); await store.init();
  const done = Array.from({ length: DONE }, (_, index) => doneItem(index));
  // One done item merged inside the recent-changes window, which the loop's read keeps for the project memory.
  (done[1]!.delivery as { mergedAt: string }).mergedAt = iso(started - 2 * 3_600_000);
  const open = Array.from({ length: OPEN }, (_, index) => openItem(index));
  // One open item references a done one: "what they reference" is the one done item a cycle still reads.
  open[0] = openItem(0, [done[0]!.id]);
  const insert = async (item: Work) => {
    await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [item.id, JSON.stringify(item)]);
    if (item.stage !== 'done') await store.pool.query('INSERT INTO jobs(work_id) VALUES($1)', [item.id]);
  };
  for (const item of [...done, ...open]) await insert(item);
  http = server(new Engine(store, 120, 'owner/project'), [{ id: 'coordinator', role: 'coordinator', token: coordinatorToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  directory = await temporaryDirectory('loop-cycle-cost');
  const credentialFile = join(directory, 'coordinator.token'); await writeFile(credentialFile, coordinatorToken, { mode: 0o600 });
  config = masterConfigSchema.parse({ version: 1, url: origin, credentialFile, cliPath: process.execPath, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
});

after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

/** The loop's own read: the coordination view, named to the control plane as the live loop's poll. */
async function loopSnapshot() {
  const response = await fetch(`${origin}/api/work-snapshot`, { headers: { Authorization: `Bearer ${coordinatorToken}`, [coordinationViewHeader]: 'coordination', [loopPresenceHeader]: '30' }, signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  assert.equal(response.status, 200, text.slice(0, 500));
  return JSON.parse(text) as { work: Work[]; now: string };
}

test('integration:loop-cycle-cost — one cycle on a 3,300-done 34-open ledger loads no done item and stays cheap', async () => {
  await loopSnapshot(); // warm-up: connection setup, plans and JIT never enter the measurement
  const state: DaemonState = emptyDaemonState(config);
  const effects: DaemonEffects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({}),
    snapshot: loopSnapshot,
    closeSession: () => {}, dispatch: async () => {},
    persist: async () => {},
  };
  const cpu = process.cpuUsage(), rss = process.memoryUsage.rss();
  let peakRss = rss;
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage.rss()); }, 5);
  sampler.unref();
  const result = await runDaemon(config, state, effects, { once: true, intervalMs: 30_000, identity: { pid: process.pid, host: 'machine-a' }, signals: [], log: () => {} });
  clearInterval(sampler);
  const used = process.cpuUsage(cpu);
  const cpuMs = (used.user + used.system) / 1000, peakMb = (peakRss - rss) / 1024 / 1024;
  console.log(`[loop-cycle-cost] one cycle: ${cpuMs.toFixed(0)} ms CPU, peak +${peakMb.toFixed(1)} MB RSS over ${rss / 1024 / 1024} MB, ${result.cycles.length} cycle(s)`);
  const snapshot = await loopSnapshot();
  const done = snapshot.work.filter(item => item.stage === 'done');
  console.log(`[loop-cycle-cost] the loop's snapshot holds ${snapshot.work.length} item(s), ${done.length} of them done`);
  assert.equal(snapshot.work.filter(item => item.stage !== 'done').length, OPEN, 'every open item is in the loop\'s snapshot');
  assert.deepEqual(done.map(item => item.key).sort(), ['GY-D1', 'GY-D2'], 'the done items in the loop\'s snapshot are the one an open item references and the one that merged within the recent-changes window');
  // A read by any other coordination reader (the worker's sync) still sees every settled summary.
  const workerRead = await fetch(`${origin}/api/work-snapshot`, { headers: { Authorization: `Bearer ${coordinatorToken}`, [coordinationViewHeader]: 'coordination' } });
  const workerView = await workerRead.json() as { work: Work[] };
  assert.equal(workerView.work.length, DONE + OPEN, 'a coordination read that is not the loop\'s own poll still holds every item');
  // The bounds, set from the measured after value (41 ms CPU, +0.9 MB on the loaded host this was
  // written on; the base tip measured 423 ms CPU over the same cycle, every done item in the read).
  assert.ok(cpuMs < cycleCpuBudgetMs, `one cycle spent ${cpuMs.toFixed(0)} ms CPU, over the ${cycleCpuBudgetMs} ms bound`);
  assert.ok(peakMb < cyclePeakMemoryBudgetMb, `one cycle peaked +${peakMb.toFixed(1)} MB RSS, over the ${cyclePeakMemoryBudgetMb} MB bound`);
});

/** What one cycle may spend on a 3,300-done 34-open ledger: set from the measured after value, with room for a slower host. */
const cycleCpuBudgetMs = 250, cyclePeakMemoryBudgetMb = 64;

// ---- The watchdog half (GY-3341): a slow but progressing cycle is never its own supervisor's kill ----------

/** The unit watchdog this loop runs under: a 1.5 s window, so a cycle of 2 s outlasts it while each step still settles. */
const watchdogWindowMs = 1_500, watchdogIntervalMs = 500, perEffectDelayMs = 400;
const environment = { NOTIFY_SOCKET: '/run/systemd/notify', WATCHDOG_USEC: String(watchdogWindowMs * 1000) };

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * The slow host: every effect the loop calls takes `perEffectDelayMs` longer than it should, so the
 * cycle's steps in total outlast the watchdog window while each one still settles — the loop is
 * slow, but it never stops progressing. The supervisor's notification is the one effect never slowed:
 * it is what the test watches.
 */
function slowEffects(effects: DaemonEffects, ms: number): DaemonEffects {
  return new Proxy(effects, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || property === 'notify') return value;
      return async (...args: unknown[]) => { const result = await (value as (...args: unknown[]) => unknown).apply(target, args); await delay(ms); return result; };
    },
  });
}

function heartbeatEffects(work: Work[] = []): { effects: DaemonEffects; beats: number[]; now: () => number } {
  const beats: number[] = [], startedAt = Date.now();
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: new Date().toISOString() }),
    agents: () => [], herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({}),
    closeSession: () => {}, dispatch: async () => {},
    persist: async () => {},
    notify: async beat => { if (beat === 'alive') beats.push(Date.now() - startedAt); },
  };
  return { effects, beats, now: () => Date.now() };
}

test('unit:loop-survives-slow-host — a cycle whose steps in total outlast the watchdog window still feeds it keep-alives and is not reported as stalled', async () => {
  const { effects, beats } = heartbeatEffects();
  const state = emptyDaemonState(config);
  const seen: string[] = [];
  const daemon = runDaemon(config, state, slowEffects(effects, perEffectDelayMs), {
    once: true, intervalMs: watchdogIntervalMs, identity: { pid: process.pid, host: 'machine-a' }, signals: [], environment,
    log: () => {},
  });
  // The liveness a reader would report while the cycle runs: sampled until the once-run releases its lock.
  const watching = (async () => {
    let last: string | null = null;
    while (state.lock !== null) {
      const liveness = loopLiveness(state, Date.now(), watchdogIntervalMs);
      if (liveness.state !== last) { seen.push(liveness.state); last = liveness.state; }
      await delay(100);
    }
  })();
  await daemon;
  await watching;
  const cycleEnd = beats.at(-1) ?? Number.POSITIVE_INFINITY;
  const during = beats.filter(at => at < cycleEnd - 1);
  console.log(`[loop-survives-slow-host] keep-alives at ${beats.join(' ms, ')} ms; liveness read ${seen.join(' then ')}`);
  assert.ok(during.length >= 2, `the loop sent ${during.length} keep-alive(s) during a cycle that outlasts the ${watchdogWindowMs} ms window, not only at its end`);
  assert.ok(!seen.includes('stalled'), `a progressing cycle was reported ${seen.join(' then ')} — never stalled`);
  assert.ok(seen.length >= 1 && seen.every(entry => entry === 'running'), `every liveness reading while the cycle ran said running, not ${seen.join(' then ')}`);
});

test('unit:loop-survives-slow-host — a loop that makes no progress for the watchdog interval sends no keep-alive and reads stalled', async () => {
  const { effects, beats, now } = heartbeatEffects();
  // The first snapshot never settles: nothing in the cycle completes, so nothing progresses.
  let unlatch: (() => void) | null = null;
  const hung = new Promise<never>((_, reject) => { unlatch = () => reject(new Error('the control plane never answered')); });
  const stalled = { ...effects, snapshot: () => hung } as DaemonEffects;
  const state = emptyDaemonState(config);
  const daemon = runDaemon(config, state, slowEffects(stalled, perEffectDelayMs), {
    once: true, intervalMs: watchdogIntervalMs, identity: { pid: process.pid, host: 'machine-a' }, signals: [], environment,
    log: () => {},
  });
  const silenceFrom = watchdogWindowMs + 600;
  await delay(watchdogWindowMs + 3_000);
  const liveness = loopLiveness(state, now(), watchdogIntervalMs);
  const silent = beats.filter(at => at > silenceFrom);
  console.log(`[loop-survives-slow-host] a hung cycle: keep-alives at ${beats.join(' ms, ') || 'never'} ms, liveness ${liveness.state}`);
  assert.equal(silent.length, 0, `a loop with no progress for the window still sent ${silent.length} keep-alive(s) past ${silenceFrom} ms`);
  assert.equal(liveness.state, 'stalled', `a hung cycle reads ${liveness.state}`);
  unlatch!();
  const result = await daemon;
  assert.equal(result.failed.length, 1, 'the hung cycle is recorded as the failure it is, and the loop keeps its contract with the supervisor by going silent for it');
});
