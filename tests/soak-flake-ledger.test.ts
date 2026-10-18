import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import type { FlakeLedger } from '../src/model/flake-ledger.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';

const start = Date.parse('2030-01-10T00:00:00Z'), interval = 5 * 60_000, cycles = 24 * 60 / 5;
const iso = (at: number) => new Date(at).toISOString();
const sha = (n: number) => String(n).padStart(40, 'c');
/** An item as the snapshot lists it, around the fields the flake step reads. */
const item = (fields: Record<string, unknown>) => ({
  description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item'] }],
  policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: [], revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start),
  stageEnteredAt: iso(start), ready: true, epoch: 1, lease: null, workspaces: [], submission: null, candidate: null, reworkRequested: false,
  scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], gates: [], ...fields,
}) as unknown as Work;

// GY-1834. A day of five-minute loop cycles in which the merge writer's trials flake: every cycle
// one more trial records a flake on its item's merge ledger, the same items trialled again on new
// heads, each naming tests from a rotating set that are no proof of their item, and every fourth
// the item's own proof as well. Each loop cycle starts as a restarted loop would, from the stored
// ledger only: every merge commit is read once, a test that is no proof of its item files one fix
// item on its first flake, the item's own proof only past the repeat threshold, and the ledger and
// each item's kept flakes stay within their bounds.
test('unit:soak-trial-flakes — over a day of loop cycles the merge writer\'s durable trial flakes are each read once, file one item per test, and stay bounded', async () => {
  const { flakeLedgerLimit } = await import('../src/model/flake-ledger.js');
  const { mergeLedgerFlakeLimit } = await import('../src/model/merge-ledger.js');
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  const state = emptyDaemonState(config);
  const others = ['unit:fleet-panel-renders — renders', 'unit:merge-queue-holds — holds', 'unit:lease-renews — renews', 'unit:docs-budget-holds — holds', 'unit:queue-carry-keeps — keeps'];
  const own = 'unit:item-works — works';
  const items = Array.from({ length: 6 }, (_, n) => item({ id: `trialled-${n}`, key: `GY-${700 + n}`, title: `Trialled ${n}`, stage: 'test',
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }], mergeLedger: { key: `GY-${700 + n}`, state: 'refused', head: null, baseTip: null, mergeSha: null, risk: null, intentAt: null, pushedAt: null, observedTip: null, refusal: null, events: 0, flakes: [] } }));
  const work: Work[] = [...items], filed: string[] = [];
  let now = start, ledger: FlakeLedger = { version: 1, entries: [], read: {}, filed: {} }, largest = 0, kept = 0;
  const base = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work, now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async () => { throw new Error('the soak decides nothing'); }, decisions: async () => ({ decisions: [] }),
    persist: async () => {},
    fileFaultClass: async (input: { title: string }) => {
      filed.push(input.title);
      const filedItem = item({ id: `filed-${filed.length}`, key: `GY-${900 + filed.length}`, title: input.title, stage: 'ready' });
      work.push(filedItem);
      return filedItem;
    },
  };
  for (let n = 0; n < cycles; n++) {
    now = start + n * interval;
    const target = items[n % items.length]!, flakes = target.mergeLedger!.flakes!;
    const tests = [others[n % others.length]!, ...(n % 4 === 0 ? [own] : [])];
    flakes.push({ head: sha(5_000 + n), mergeSha: sha(6_000 + n), files: ['tests/some.test.ts'], tests, at: iso(now - 30_000) });
    flakes.splice(0, Math.max(0, flakes.length - mergeLedgerFlakeLimit));
    kept = Math.max(kept, flakes.length);
    // A new store object every cycle: the loop restarted, and only the stored ledger and the items remain.
    const flakeLedger = { read: async () => structuredClone(ledger), write: async (next: FlakeLedger) => { ledger = structuredClone(next); largest = Math.max(largest, ledger.entries.length); } };
    await runCycle(config, state, { ...base, flakeLedger } as unknown as DaemonEffects, () => now);
  }
  const trialReads = Object.keys(ledger.read).filter(key => key.startsWith('trial:'));
  assert.equal(trialReads.length, cycles, 'every trial merge commit is read once');
  assert.equal(ledger.entries.filter(entry => entry.source === 'trial-rerun' && entry.test === own).length, Math.ceil(cycles / 4), 'and none twice');
  assert.deepEqual(filed.sort(), [...others, own].map(name => `Flaky test: ${name}`).sort(), 'one item per test: the others on their first flake, the item\'s own proof once it flaked repeatedly');
  assert.ok(largest <= flakeLedgerLimit, `the ledger stays within its bound (largest ${largest})`);
  assert.ok(kept <= mergeLedgerFlakeLimit, 'each item keeps a bounded list of its trial flakes');
});
