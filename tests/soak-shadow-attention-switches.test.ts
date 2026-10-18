import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { shadowIdle, shadowReads } from '../src/daemon/cycle-shadow.js';
import type { ShadowExplanationRef } from '../src/merge-writer/shadow.js';
import type { MergerMode } from '../src/merger-mode.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';

/**
 * GY-1748: the shadow step's attention lines through merger mode changes over many cycles, heads and items.
 * Twelve items each fail their trial and are merged by GitHub; the merger then moves github → control-plane →
 * github → control-plane → github while the explanations read fails or answers. Under control-plane every
 * line is cleared and none raised whatever that read does; back under github each disagreement first
 * recorded under control-plane (and each cleared one) gains its line; the lines never exceed one per item.
 * The clock is a constant handed in, so nothing here reads the wall clock.
 */
const at = '2030-03-01T00:00:00.000Z', now = () => 1_898_121_600_000;
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const tip = sha('main-tip');
const items = 12;
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const githubDouble = new Proxy({}, { get: (_, name) => { throw new Error(`the shadow step called GitHub (${String(name)})`); } });
const work = (n: number, merged: boolean): Work => ({
  id: `w${n}`, key: `GY-${n}`, description: '', type: 'feature', priority: 1, dependencies: [], criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: [],
  revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: n },
  candidate: { sha: sha(`head${n}`), baseSha: sha('base'), pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' }, reworkRequested: false,
  scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], gates: [],
  ...(merged ? { stage: 'done', delivery: { mergedAt: at, mergeSha: sha(`gh-merge-${n}`), authorizationRevision: 1 } } : { stage: 'review' }),
}) as unknown as Work;
const git = ((command: string, args: string[]) => {
  const sub = args[2];
  if (sub === 'rev-parse') return `${tip}\n`;
  if (sub === 'merge-tree') return `${sha('tree')}\0`;
  if (sub === 'commit-tree') return `${sha(`merge-${args.join(' ')}`)}\n`;
  if (sub === 'diff') return 'src/a.ts\n';
  return '';
}) as never;

test('unit:soak-shadow-attention-switches — shadow attention stays bounded and is cleared and re-raised correctly through merger mode changes and explanation-read failures', { timeout: 120_000 }, async () => {
  let mode: MergerMode = 'github', explainRead: 'fails' | 'none' | 'all' = 'none', merged = false, mergerDown = false;
  const reads = shadowReads(config, '/coordinator', git, { base: '/w', record: async () => {},
    explanations: async pairs => {
      if (explainRead === 'fails') throw new Error('explanations endpoint down');
      return explainRead === 'all' ? pairs as ShadowExplanationRef[] : [];
    },
    trial: async () => ({ build: 'pass', tests: { passed: 0, failed: ['tests/x.test.ts'], files: 1 }, durationMs: 1000, logTail: 'not ok 1 - tests/x.test.ts', runnerExit: 1 }) });
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: Array.from({ length: items }, (_, index) => work(index + 1, merged)), now: at }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at, reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, decisions: async () => ({ decisions: [] }), persist: async () => {},
    github: githubDouble, merge: githubDouble, shadow: reads, mergeWriter: { merger: async () => { if (mergerDown) throw new Error('merger read down'); return mode; } } } as unknown as DaemonEffects;
  let state = emptyDaemonState(config);
  const lines = () => Object.keys(state.actions).filter(name => /^shadow:GY-\d+$/.test(name));
  const phase = async (cycles: number, check: () => void) => {
    for (let cycle = 0; cycle < cycles; cycle++) {
      await runCycle(config, state, effects, now);
      await shadowIdle(state);
      assert.ok(lines().length <= items, 'at most one line per item');
      check();
    }
  };
  // Trials run beside GitHub's gate: the verdicts are pending, nothing is raised.
  await phase(items + 2, () => assert.deepEqual(lines(), []));
  assert.equal(state.shadow.length, items);
  merged = true;
  // First recorded under the control-plane merger, with the explanations endpoint down: no line, verdicts kept.
  mode = 'control-plane'; explainRead = 'fails';
  await phase(10, () => assert.deepEqual(lines(), []));
  assert.ok(state.shadow.every(verdict => verdict.outcome === 'shadow-only-fail'));
  // Back to github: each disagreement gains its line though its verdict never changed.
  mode = 'github';
  await phase(5, () => {});
  assert.equal(lines().length, items, 'every disagreement raises its line');
  // Control-plane again with the endpoint still down: every standing line clears.
  mode = 'control-plane';
  await phase(3, () => {});
  assert.deepEqual(lines(), [], 'cleared whatever the explanations read did');
  // Github with an unexplained ledger re-raises; once every pair is explained the lines clear.
  mode = 'github'; explainRead = 'none';
  await phase(3, () => {});
  assert.equal(lines().length, items, 're-raised');
  explainRead = 'all';
  await phase(3, () => {});
  assert.deepEqual(lines(), [], 'explained pairs clear');
  assert.equal(state.shadow.length, items, 'the verdicts stay on the record');
  // A daemon restart under github: a fresh state holds the persisted unexplained verdicts and no action, and raises every line.
  explainRead = 'none';
  const persisted = state.shadow.map(verdict => ({ ...verdict }));
  state = emptyDaemonState(config);
  state.shadow = persisted;
  assert.deepEqual(lines(), [], 'the restarted state holds no line');
  await phase(3, () => {});
  assert.equal(lines().length, items, 'a restart in github mode raises every standing disagreement');
  // A restart under the control-plane merger whose first merger read fails: the mode is unknown, so no line is raised; once a read succeeds the mode governs.
  mode = 'control-plane'; mergerDown = true;
  state = emptyDaemonState(config);
  state.shadow = persisted.map(verdict => ({ ...verdict }));
  await phase(5, () => assert.deepEqual(lines(), [], 'an unknown mode raises no line'));
  mergerDown = false;
  await phase(3, () => assert.deepEqual(lines(), [], 'the control-plane merger raises none'));
  mode = 'github';
  await phase(3, () => {});
  assert.equal(lines().length, items, 'github mode raises every standing disagreement once the mode is known');
});
