import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { daemonStateSchema, emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { mergeWriterIdle, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { MergeRecordEvent } from '../src/merge-writer/executor.js';
import type { MergeLedgerState } from '../src/model/merge-ledger.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';

/**
 * GY-1528: the control-plane switches over a simulated day of the real loop's cycles, in the real
 * step order. Items are submitted every quarter hour and the
 * merge writer delivers them one at a time, through restarts (its state read back from JSON, every
 * in-memory flight lost) and stretches where the merger read fails. The loop must deliver every
 * submitted item, never revert, never request a decision, and keep its state bounded.
 */
const minute = 60_000;
const start = Date.parse('2030-05-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy', retrials: 3 } } });
const githubDouble = new Proxy({}, { get: (_, name) => { throw new Error(`a control-plane cycle called GitHub (${String(name)})`); } });

/** The day's script, by item ordinal and cycle. */
const items = 80, submitEveryMs = 15 * minute, cycleMs = 2 * minute, cycles = (24 * 60) / 2;
const restartAt = (cycle: number) => cycle === 300 || cycle === 501;

class World {
  main = [sha('base')];
  pushes: string[] = [];
  recorded = new Map<number, MergeRecordEvent[]>();
  submitted = new Map<number, number>();
  merges = new Map<string, number>();
  scopeCalls: string[] = [];
  cycle = 0;
  constructor(readonly now: () => number) {}
  head(n: number) { return sha(`head${n}`); }
  snapshot(): Work[] {
    const now = this.now();
    return [...this.submitted].filter(([, at]) => at <= now).map(([n, submittedAt]) => {
      let ledger = null as MergeLedgerState | null;
      for (const event of this.recorded.get(n) ?? []) {
        if (event.kind === 'intent') ledger = { key: `GY-${n}`, state: 'intent', head: event.head, baseTip: event.baseTip, mergeSha: event.mergeSha, risk: event.risk, intentAt: event.at, pushedAt: null, observedTip: null, refusal: null, events: (ledger?.events ?? 0) + 1 };
        else if (event.kind === 'pushed' && ledger) ledger = { ...ledger, state: 'pushed', pushedAt: event.pushedAt, events: ledger.events + 1 };
        else if (event.kind === 'reconciled' && ledger) ledger = { ...ledger, state: 'reconciled', observedTip: event.observedTip, events: ledger.events + 1 };
      }
      const delivered = ledger?.state === 'reconciled';
      const candidate = { sha: this.head(n), baseSha: sha('base'), pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' };
      return {
        id: `w${n}`, key: `GY-${n}`, description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
        policy: { checks: ['test'], review: true }, revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(submittedAt),
        ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: n }, candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [], mergeLedger: ledger,
        observation: { source: 'control-plane', candidate, files: ['src/app.ts', 'src/other.ts'], checks: [], reviews: [], merged: delivered, mergeSha: delivered ? ledger!.mergeSha : null, mergeable: true, protected: false, baseTip: this.main[0], baseTipContained: true, at: iso(now) },
        gates: ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: name === 'build' || name === 'ready' || name === 'review', reasons: [] })),
        ...(delivered ? { stage: 'done', delivery: { mergedAt: ledger!.pushedAt ?? iso(now), mergeSha: ledger!.mergeSha!, authorizationRevision: 1 } } : { stage: 'build' }),
      } as unknown as Work;
    });
  }
  ports(): MergeWriterReads {
    const world = this;
    return {
      baseBranch: 'main', retrials: 3, now: this.now,
      fetch: async () => world.main[0]!,
      merge: async (head, baseTip) => { const mergeSha = sha(`merge:${head}:${baseTip}`); world.merges.set(mergeSha, Number([...world.submitted.keys()].find(n => world.head(n) === head))); return { mergeSha, files: ['src/app.ts', 'src/other.ts'] }; },
      trial: async (mergeSha) => ({ build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1000, logTail: mergeSha, files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } }),
      push: async (mergeSha, baseTip) => { if (baseTip !== world.main[0]) return 'rejected'; world.main.unshift(mergeSha); world.pushes.push(mergeSha); return 'pushed'; },
      holds: async mergeSha => world.main.includes(mergeSha),
      record: async (item, event) => { const n = Number(item.key.slice(3)); world.recorded.set(n, [...(world.recorded.get(n) ?? []), event]); },
    };
  }
}

test('unit:scope-switches-control-plane — a simulated day on the real loop under the control-plane merger: every submitted item is delivered through restarts and unreadable merger stretches, nothing is reverted, no decision is requested, and state stays bounded', { timeout: 300_000 }, async () => {
  let now = start;
  const world = new World(() => now);
  for (let n = 1; n <= items; n++) world.submitted.set(n, start + n * submitEveryMs);
  const scopeSpy = (name: string) => async () => { world.scopeCalls.push(name); throw new Error(`${name} must not run under the control plane`); };
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: world.snapshot(), now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {},
    decisions: async () => ({ decisions: [] }), persist: async () => {},
    github: githubDouble, merge: githubDouble, mergeWriter: world.ports(),
    decide: scopeSpy('decide') } as unknown as DaemonEffects;
  let state: DaemonState = emptyDaemonState(config);
  let restarts = 0;
  for (let cycle = 0; cycle < cycles; cycle++) {
    now = start + cycle * cycleMs; world.cycle = cycle;
    // A restart: the persisted state comes back through JSON; every flight in this process's memory is gone.
    if (restartAt(cycle)) { state = daemonStateSchema.parse(JSON.parse(JSON.stringify(state))); restarts += 1; }
    await runCycle(config, state, effects, () => now);
    await mergeWriterIdle(state);
  }
  // Settle what the last cycles left owed.
  for (let extra = 0; extra < 5; extra++) { now += cycleMs; world.cycle = cycles + extra; await runCycle(config, state, effects, () => now); await mergeWriterIdle(state); }

  assert.ok(restarts >= 2, 'the scripted restarts happened');
  assert.deepEqual(world.scopeCalls, [], 'no decision was requested, the unreadable merger stretches included');
  const final = world.snapshot();
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => item.key), [], 'every item is delivered');
  assert.equal(new Set(world.pushes).size, items, 'each merge commit pushed once');
  assert.ok(![...world.recorded.values()].flat().some(event => (event as { kind: string }).kind === 'revert'), 'nothing is reverted');
  // The state round-trips.
  assert.deepEqual(daemonStateSchema.parse(JSON.parse(JSON.stringify(state))).mergeWriter, state.mergeWriter);
});
