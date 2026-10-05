import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import type { MasterConfig } from '../src/master.js';
import { candidateKey, emptyDaemonState } from '../src/master-daemon.js';
import { mergeStep } from '../src/daemon/cycle-delivery.js';
import type { Cycle } from '../src/daemon/cycle.js';

// GY-1088 names this file for its proof: manual:fault-class-proof. The master loop filed 4 proof
// faults in 24 hours on 1 October 2026, every one the same timing failure: the required test check
// went red because integration:cycle-within-interval measured one coordination cycle over the
// 100-item ledger at 20.7–23.0 s against its 20 s budget. The recorded baseline for that cycle is
// 186 ms (tests/helpers/timing-baseline.json), so the runners were not slow by a factor of a hundred:
// the cycle had grown. Its merge step re-read the whole ledger once per merge candidate before the
// guarded merge (GY-192), and the 100-item ledger has sixteen candidates at the merge stage — one
// cycle read plus sixteen step reads, each a whole-ledger snapshot. Locally the step took 5.2 s of
// a 5.5 s cycle; a CI runner's slower reads took it past the budget.
//
// Each instance the item lists is replayed here on a virtual clock: a snapshot read costs what the
// instance's own run implies (its measured cycle over the reads the base made), and the replayed
// cycle must stay within the budget. Against the base each subtest fails: the instance reproduces.

interface Instance { id: string; at: string; kind: 'timing-failure'; subject: string; name: string; test: string; measuredMs: number; budgetMs: number }
const instances: Instance[] = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/gy-1088-proof-faults.json', import.meta.url)), 'utf8'));

// The integration ledger (tests/work-snapshot-latency.test.ts): 100 items cycling through six
// stages, so every sixth one, sixteen in all, is at the merge stage.
const ledgerItems = 100, mergeCandidates = Array.from({ length: ledgerItems }, (_, index) => index).filter(index => index % 6 === 4).length;
/** The reads the base made in that cycle: its own snapshot, and one more per merge candidate. */
const baseReads = 1 + mergeCandidates;

const base = 'b'.repeat(40);
const sha = (n: number, head = 1) => `${n.toString(16).padStart(4, '0')}${head.toString(16).padStart(4, '0')}`.padEnd(40, 'a');
/** A merge candidate with every gate passed, as the loop's cycle snapshot holds it. */
const candidate = (n: number, extra: Partial<Work> = {}): Work => ({
  id: `work-${n}`, key: `GY-${n}`, title: `GY-${n}`, stage: 'merge', revision: 1, policyRevision: 1, epoch: 1,
  candidate: { sha: sha(n), baseSha: base, pr: n, branch: `graphyard/gy-${n}-1`, author: 'implementer' }, submission: { epoch: 1, pr: n },
  gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'merge', passed: true, reasons: [] }], violations: [], observation: null, ...extra,
}) as unknown as Work;

/**
 * One merge step over `count` candidates on a virtual clock. Every snapshot read advances the clock
 * by `readCostMs`. Since GY-1235 GitHub merges and the step only raises escalations for merges it
 * observed without passing gates, so it has nothing to read the ledger afresh for.
 */
async function mergeStepOver(count: number, options: { readCostMs?: number } = {}) {
  let clock = Date.parse('2026-10-01T22:00:00Z'), reads = 0;
  const open = Array.from({ length: count }, (_, index) => candidate(index + 1));
  const master = { url: 'https://graphyard.example', repository: 'owner/project', autoMerge: true } as MasterConfig;
  const state = emptyDaemonState(master);
  const effects = {
    snapshot: async () => { reads++; clock += options.readCostMs ?? 0; return { work: open, now: new Date(clock).toISOString() }; },
    persist: async () => {},
  };
  const started = clock;
  const performed: Cycle['performed'] = [];
  await mergeStep({ config: master, state, effects, now: () => clock, performed, open, isolate: async (_kind: unknown, _item: unknown, _name: unknown, body: () => Promise<unknown>) => body() } as unknown as Cycle);
  return { reads, performed, state, elapsedMs: clock - started };
}

test('manual:fault-class-proof — the item lists 4 instances, each the coordination cycle over its interval budget', () => {
  assert.equal(instances.length, 4);
  assert.equal(new Set(instances.map(instance => instance.id)).size, 4);
  assert.deepEqual([...new Set(instances.map(instance => `${instance.kind} ${instance.name} ${instance.test} ${instance.budgetMs}`))], ['timing-failure cycle-within-interval.duration integration:cycle-within-interval 20000']);
  assert.ok(instances.every(instance => instance.measuredMs > instance.budgetMs));
  assert.deepEqual(instances.map(instance => instance.subject), ['GY-1036', 'GY-612', 'GY-1078', 'GY-957']);
  assert.equal(mergeCandidates, 16);
});

for (const instance of instances) {
  test(`manual:fault-class-proof — ${instance.id}: the cycle that measured ${instance.measuredMs}ms stays within its ${instance.budgetMs}ms budget when replayed at that run's read cost`, async () => {
    // What one whole-ledger read cost on that runner, if the base's reads were the whole cycle.
    const readCostMs = instance.measuredMs / baseReads;
    const step = await mergeStepOver(mergeCandidates, { readCostMs });
    const replayedMs = readCostMs + step.elapsedMs;
    assert.ok(replayedMs <= instance.budgetMs, `replayed cycle ${Math.round(replayedMs)}ms (${1 + step.reads} ledger reads at ${Math.round(readCostMs)}ms) is within ${instance.budgetMs}ms`);
  });
}

test('manual:fault-class-proof — the merge step reads no ledger of its own, however many candidates it holds', async () => {
  // GitHub merges (GY-1235): the guarded merge and its per-candidate fresh read are gone, so the
  // step costs the cycle nothing beyond the cycle's own snapshot.
  for (const count of [0, 1, mergeCandidates, 170]) assert.equal((await mergeStepOver(count)).reads, 0, `${count} candidate(s): no read for the step`);
});
