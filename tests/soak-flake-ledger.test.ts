import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import type { FlakeLedger } from '../src/model/flake-ledger.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';

// GY-1498. A day of five-minute loop cycles in which every cycle sees one more check that passed
// only on its rerun, each failing three of a rotating set of tests: the flake step reads each
// failed job's log once, files at most one fix item per test, and keeps the ledger in its bound.

const start = Date.parse('2030-01-10T00:00:00Z'), interval = 5 * 60_000, cycles = 24 * 60 / 5;
const iso = (at: number) => new Date(at).toISOString();
const sha = (n: number) => String(n).padStart(40, 'c');
const proofTests = ['unit:fleet-panel-renders — renders', 'unit:merge-queue-holds — holds', 'unit:lease-renews — renews'];
const noProof = (n: number) => `a test with no proof id ${n % 7}`;
/** An item as the snapshot lists it, around the fields the flake step reads. */
const item = (fields: Record<string, unknown>) => ({
  description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item'] }],
  policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: [], revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start),
  stageEnteredAt: iso(start), ready: true, epoch: 1, lease: null, workspaces: [], submission: null, candidate: null, reworkRequested: false,
  scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], gates: [], ...fields,
}) as unknown as Work;

test('unit:soak-flake-ledger — over a day of loop cycles with recurring flakes each failed job log is read once, at most one item is filed per test, and the ledger stays within its bound', async () => {
  // Loaded here, so a loop without the flake ledger fails this case rather than the file.
  const { flakeLedgerLimit } = await import('../src/model/flake-ledger.js').catch(() => ({ flakeLedgerLimit: 500 }));
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  const state = emptyDaemonState(config);
  const work: Work[] = [], reads = new Map<number, number>(), filed: string[] = [];
  let now = start, ledger: FlakeLedger = { version: 1, entries: [], read: {}, filed: {} }, largest = 0, writes = 0;
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work, now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async () => { throw new Error('the soak decides nothing'); }, decisions: async () => ({ decisions: [] }),
    persist: async () => {},
    flakeLedger: { read: async () => structuredClone(ledger), write: async (next: FlakeLedger) => { ledger = structuredClone(next); largest = Math.max(largest, ledger.entries.length); writes += 1; } },
    failedTests: async (job: number) => {
      reads.set(job, (reads.get(job) ?? 0) + 1);
      return [proofTests[job % 3], proofTests[(job + 1) % 3], noProof(job)];
    },
    fileFaultClass: async (input: { title: string }) => {
      filed.push(input.title);
      // The filed item stays open for the rest of the day, as an undelivered fix would.
      const filedItem = item({ id: `filed-${filed.length}`, key: `GY-${900 + filed.length}`, title: input.title, stage: 'ready' });
      work.push(filedItem);
      return filedItem;
    },
  } as unknown as DaemonEffects;

  for (let n = 0; n < cycles; n++) {
    now = start + n * interval;
    // Every cycle, one more merged item whose `test` check passed on its rerun; every third a main guard flake too.
    work.push(item({ id: `work-${n}`, key: `GY-${n}`, title: `Item ${n}`, stage: 'done', submission: { epoch: 1, pr: n },
      checkReruns: [{ sha: sha(n), check: 'test', failedRunId: 10_000 + n, state: 'passed', at: iso(now - 120_000), rerunId: 20_000 + n, resolvedAt: iso(now - 60_000) }],
      ...(n % 3 === 0 ? { mainGuardFlakes: [{ mergeSha: sha(1_000 + n), check: 'test', failedRunId: 30_000 + n, rerunRunId: 40_000 + n, at: iso(now - 30_000) }] } : {}),
    }));
    await runCycle(config, state, effects, () => now);
  }

  const jobs = cycles + Math.ceil(cycles / 3);
  assert.equal(reads.size, jobs, 'every failed job is read');
  assert.ok([...reads.values()].every(count => count === 1), 'and each exactly once');
  assert.deepEqual(filed.sort(), proofTests.map(name => `Flaky test: ${name}`).sort(), 'one item per flaky test with a proof id, and none for a test without');
  assert.ok(largest <= flakeLedgerLimit && ledger.entries.length === flakeLedgerLimit, `the ledger stays within its bound (largest ${largest})`);
  assert.ok(writes <= cycles + filed.length, 'the ledger is written only when it changes');
});
