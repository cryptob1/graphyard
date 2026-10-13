import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { shadowIdle, shadowReads } from '../src/daemon/cycle-shadow.js';
import { shadowGateAttention, type ShadowVerdict } from '../src/merge-writer/shadow.js';
import type { MergerMode } from '../src/merger-mode.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';

// GY-1748: a shadow-only-fail asks to be explained before the switch to control-plane merging; once the control plane is the merger the row is history.
// The instants are fixed literals and the clock is a constant handed in, so nothing here reads the wall clock.

const at = '2030-03-01T00:00:00.000Z', now = () => 1_898_121_600_000;
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const tip = sha('main-tip');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const item = (fields: Record<string, unknown>) => ({
  description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item'] }],
  policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: [], revision: 1, policyRevision: 1, createdAt: at, updatedAt: at,
  stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [], submission: null, candidate: null, reworkRequested: false,
  scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], gates: [], stage: 'build', ...fields,
}) as unknown as Work;
const submitted = (n: number, fields: Record<string, unknown> = {}) => item({ id: `w${n}`, key: `GY-${n}`, submission: { epoch: 1, pr: n },
  candidate: { sha: sha(`head${n}`), baseSha: sha('base'), pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' }, ...fields });
const failing = { build: 'pass' as const, tests: { passed: 1, failed: ['tests/x.test.ts'], files: 2 }, durationMs: 3000, logTail: 'not ok 1 - tests/x.test.ts' };
const failedVerdict = (key: string): ShadowVerdict => ({ key, id: `w-${key}`, head: sha(`h-${key}`), baseTip: tip, mergeSha: sha(`m-${key}`), risk: 'normal', build: 'pass', tests: failing.tests, conflict: [], durationMs: 1000, at, outcome: 'shadow-only-fail' });

const git = ((command: string, args: string[]) => {
  const sub = args[2];
  if (sub === 'rev-parse') return `${tip}\n`;
  if (sub === 'merge-tree') return `${sha('tree')}\0`;
  if (sub === 'commit-tree') return `${sha('merge')}\n`;
  if (sub === 'diff') return 'src/store/schema.ts\n';
  return '';
}) as never;
const githubDouble = new Proxy({}, { get: (_, name) => { throw new Error(`the shadow step called GitHub (${String(name)})`); } });
function effectsFor(work: () => Work[], shadow: ReturnType<typeof shadowReads>, merger: () => Promise<MergerMode>) {
  return {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: work(), now: at }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at, reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, decisions: async () => ({ decisions: [] }), persist: async () => {},
    github: githubDouble, merge: githubDouble, shadow, mergeWriter: { merger },
  } as unknown as DaemonEffects;
}

/** One head the shadow trial fails and GitHub then merges, run under the given merger; returns the attention lines raised and the final state. */
async function disagree(merger: () => Promise<MergerMode>) {
  const reads = shadowReads(config, '/coordinator', git, { base: '/w', record: async () => {}, trial: async () => failing });
  let merged = false;
  const work = () => [merged ? submitted(6, { stage: 'done', delivery: { mergedAt: at, mergeSha: sha('gh-merge-6'), authorizationRevision: 1 } }) : submitted(6)];
  const state = emptyDaemonState(config), effects = effectsFor(work, reads, merger);
  for (let cycle = 0; cycle < 3; cycle++) { await runCycle(config, state, effects, now); await shadowIdle(state); }
  merged = true;
  const raised: string[] = [];
  for (let cycle = 0; cycle < 3; cycle++) { raised.push(...(await runCycle(config, state, effects, now)).actions.filter(action => action.detail.startsWith('Shadow merge gate:')).map(action => action.detail)); await shadowIdle(state); }
  return { raised, state };
}

test('unit:shadow-rows-quiet-after-switch — with the merger in control-plane mode a shadow-only-fail raises no attention row and stays in the verdict record; in shadow (github) mode it raises the row as today', async () => {
  // The pure attention read.
  const verdicts = [failedVerdict('GY-1'), failedVerdict('GY-2')];
  assert.equal(shadowGateAttention(verdicts).length, 2, 'the default is the shadow mode');
  assert.equal(shadowGateAttention(verdicts, [], 'github').length, 2);
  assert.deepEqual(shadowGateAttention(verdicts, [], 'control-plane'), [], 'history after the switch');
  // The loop: shadow mode raises one escalation row and records the action.
  const shadow = await disagree(async () => 'github');
  assert.equal(shadow.state.shadow[0]?.outcome, 'shadow-only-fail');
  assert.equal(shadow.raised.length, 1, 'one row in shadow mode');
  assert.ok(shadow.state.actions['shadow:GY-6'], 'the row stands in the loop state');
  // Control-plane mode: the verdict is recorded and re-judged, no row is raised.
  const control = await disagree(async () => 'control-plane');
  assert.equal(control.state.shadow[0]?.outcome, 'shadow-only-fail', 'the verdict stays on the record');
  assert.deepEqual(control.raised, []);
  assert.ok(!control.state.actions['shadow:GY-6'], 'no row in the loop state');
  // A row raised while still in shadow mode is cleared once the control plane becomes the merger.
  let mode: MergerMode = 'github';
  const reads = shadowReads(config, '/coordinator', git, { base: '/w', record: async () => {}, trial: async () => failing });
  let merged = false;
  const work = () => [merged ? submitted(6, { stage: 'done', delivery: { mergedAt: at, mergeSha: sha('gh-merge-6'), authorizationRevision: 1 } }) : submitted(6)];
  const state = emptyDaemonState(config), effects = effectsFor(work, reads, async () => mode);
  for (let cycle = 0; cycle < 3; cycle++) { await runCycle(config, state, effects, now); await shadowIdle(state); }
  merged = true;
  for (let cycle = 0; cycle < 3; cycle++) { await runCycle(config, state, effects, now); await shadowIdle(state); }
  assert.ok(state.actions['shadow:GY-6'], 'raised in shadow mode');
  mode = 'control-plane';
  await runCycle(config, state, effects, now);
  assert.ok(!state.actions['shadow:GY-6'], 'cleared after the switch');
  assert.equal(state.shadow[0]?.outcome, 'shadow-only-fail', 'the verdict is kept');
});

test('unit:shadow-attention-test-file — the item\'s tests live in tests/shadow-attention-after-switch.test.ts', () => {
  assert.ok(import.meta.url.endsWith('/tests/shadow-attention-after-switch.test.ts'));
  assert.deepEqual(shadowGateAttention([failedVerdict('GY-3')], [], 'control-plane'), [], 'the file holds the switch behaviour, not only its name');
  assert.equal(shadowGateAttention([failedVerdict('GY-3')], [], 'github').length, 1);
});
