import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';

// GY-2086. The loop used to file "Flaky test" items from a flake ledger and one "Advisory test"
// chore per failing post-merge budget test; overnight it filed 46 such items nobody asked for and
// the operator closed them as clutter. Both filers are deleted: a merge trial in which a test fails
// and then passes on its rerun files no work item (nor does anything else the loop sees on its own —
// the per-merge advisory trial itself is gone with GY-3002). A rerun that passes still counts as a
// pass (the PR gate, the main guard and the merge writer's trial judge on the rerun); nothing
// replaces the filers.

const root = fileURLToPath(new URL('..', import.meta.url));
const start = Date.parse('2030-01-10T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (n: number) => String(n).padStart(40, 'c');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const flakyName = 'unit:fleet-panel-renders — the fleet panel renders';

/** An item as the snapshot lists it, around the fields the old flake filer read. */
const item = (fields: Record<string, unknown>) => ({
  description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item'] }],
  policy: { checks: ['test', 'typecheck'], review: true }, revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start),
  stageEnteredAt: iso(start), ready: true, epoch: 1, lease: null, workspaces: [], submission: null, candidate: null, reworkRequested: false,
  scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], gates: [], ...fields,
}) as unknown as Work;

test('unit:no-flake-items — the flake filer is gone: a day of loop cycles over passed reruns and recorded trial flakes files no work item, though the filing effect and the failed-log read stand ready', async () => {
  assert.equal(existsSync(`${root}src/daemon/cycle-flakes.ts`), false, 'src/daemon/cycle-flakes.ts is deleted');
  const writer = await import('../src/daemon/cycle-merge-writer.js') as Record<string, unknown>;
  assert.equal('advisoryChore' in writer, false, 'advisoryChore is deleted');
  const state = emptyDaemonState(config);
  const work: Work[] = [], filed: string[] = [], reads: number[] = [];
  let now = start;
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work, now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {},
    decide: async () => { throw new Error('the soak decides nothing'); }, decisions: async () => ({ decisions: [] }),
    persist: async () => {},
    // What the old filer consumed: each passed rerun's failed log read, and the operator-agent filing route.
    failedTests: async (job: number) => { reads.push(job); return [flakyName]; },
    fileFaultClass: async (input: { title: string }) => { filed.push(input.title); throw new Error(`no work item is filed for a flake (GY-2086): ${input.title}`); },
  } as unknown as DaemonEffects;
  // One merged item whose `test` check failed and passed on its rerun, one whose merge ledger keeps
  // a trial flake (the trial's test files failed and passed on their rerun of the same merge commit),
  // and one with a main guard flake: every shape the flake filer once read.
  work.push(
    item({ id: 'work-1', key: 'GY-1', title: 'Item 1', stage: 'done', submission: { epoch: 1, pr: 1 },
      checkReruns: [{ sha: sha(1), check: 'test', failedRunId: 501, state: 'passed', at: iso(start - 120_000), rerunId: 601, resolvedAt: iso(start - 60_000) }] }),
    item({ id: 'work-2', key: 'GY-2', title: 'Item 2', stage: 'done', submission: { epoch: 1, pr: 2 },
      mergeLedger: { key: 'GY-2', state: 'reconciled', head: sha(2), baseTip: sha(0), mergeSha: sha(20), risk: 'normal', intentAt: iso(start - 60_000), pushedAt: iso(start - 30_000), observedTip: sha(20), refusal: null, events: 3,
        flakes: [{ head: sha(2), mergeSha: sha(20), files: ['tests/fleet-panel.test.ts'], tests: [flakyName], at: iso(start - 30_000) }] } }),
    item({ id: 'work-3', key: 'GY-3', title: 'Item 3', stage: 'done', submission: { epoch: 1, pr: 3 },
      mainGuardFlakes: [{ mergeSha: sha(3), check: 'test', failedRunId: 503, rerunRunId: 603, at: iso(start - 30_000) }] }),
  );
  for (let cycle = 0; cycle < 12; cycle++) {
    now = start + cycle * 5 * 60_000;
    await runCycle(config, state, effects, () => now);
  }
  assert.deepEqual(filed, [], 'no "Flaky test" item is filed, on any cycle');
  assert.deepEqual(reads, [], 'the failed job logs are not read for flake filing either');
  const created = work.filter(entry => !['GY-1', 'GY-2', 'GY-3'].includes(entry.key));
  assert.deepEqual(created, [], 'the loop creates no item of its own for the flakes');
});
