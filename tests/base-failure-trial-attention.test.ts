import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseFailureStep, baseFailureAttention } from '../src/daemon/cycle-base-failures.js';
import { baseFailureReason } from '../src/merge-writer/executor.js';
import { emptyDaemonState } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { Work } from '../src/model.js';

// GY-1834 / GY-2010 / GY-2186: the merge writer holds a head whose failing tests fail on the base
// tip too; the base-failure step raises that from the item's merge ledger as one attention line per
// failing test, and files nothing — the master repairs the base.

const clock = Date.parse('2030-02-01T00:00:00Z');
const sha = (n: number) => String(n).padStart(40, 'b');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 0, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const held = (n: number, tests: string[], reason = baseFailureReason({ tip: sha(900), files: ['tests/clock.test.ts'], tests })) => ({
  id: `work-${n}`, key: `GY-${n}`, title: `Item ${n}`, stage: 'test', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
  candidate: { sha: sha(n), baseSha: sha(900), pr: 0, branch: `graphyard/gy-${n}-1`, author: 'worker' },
  mergeLedger: { key: `GY-${n}`, state: 'refused', head: sha(n), baseTip: sha(900), mergeSha: null, risk: null, intentAt: null, pushedAt: null, observedTip: null, refusal: { reason, at: new Date(clock).toISOString() }, events: 3 },
}) as unknown as Work;

function cycleOf(work: Work[], state = emptyDaemonState(config)) {
  return { config, state, clock, now: () => clock, performed: [], snapshot: { work, now: new Date(clock).toISOString() },
    isolate: async (_kind: string, _item: unknown, _name: string, body: () => Promise<unknown>) => body(),
    effects: { persist: async () => {}, github: new Proxy({}, { get: (_, name) => { throw new Error(`the step called GitHub (${String(name)})`); } }) } } as unknown as Cycle;
}

test('unit:base-failure-trial-attention — a head the merge writer held on a base failure raises one attention line per failing test, and the records clear once no item shows them', async () => {
  const tests = ['unit:clock-works — the clock works'];
  const state = emptyDaemonState(config);
  // A record an older loop kept from a GitHub check run of the base, naming an item an older loop filed: nothing shows it now.
  state.baseFailures['legacy-check'] = { test: 'unit:old — old', check: 'test', baseSha: sha(1), jobId: 7, url: null, raisedAt: new Date(clock).toISOString(), blocks: [], item: 'GY-980', cleared: null };
  const work = [held(1, tests), held(2, tests)];
  const setAside = await baseFailureStep(cycleOf(work, state));
  assert.deepEqual([...setAside.keys()], [], 'the writer holds the head itself: nothing is set aside from a GitHub check');
  assert.equal(state.baseFailures['legacy-check'], undefined, 'a record no item shows is cleared');
  assert.equal(Object.keys(state.baseFailures).length, 2, 'one record per held item and failing set');
  // The two records name the same failing test: one attention line, naming both candidates.
  const lines = baseFailureAttention(Object.values(state.baseFailures), config.baseBranch);
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.match(lines[0]!.text, /Base branch main fails the trial test "unit:clock-works — the clock works"/);
  assert.match(lines[0]!.text, /blocking GY-1, GY-2; no rework is requested for it/, 'the line names the candidates it holds and files nothing');
  await baseFailureStep(cycleOf(work, state));
  assert.equal(Object.keys(state.baseFailures).length, 2, 'the records stand while the head is held');
  // A new trial of a new head no longer shows it: the record clears.
  await baseFailureStep(cycleOf([{ ...work[0]!, mergeLedger: { ...work[0]!.mergeLedger!, state: 'reconciled', refusal: null } } as Work], state));
  assert.equal(Object.keys(state.baseFailures).length, 0, 'cleared once no item shows it');
  assert.deepEqual(baseFailureAttention(Object.values(state.baseFailures), config.baseBranch), []);
});
