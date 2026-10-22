import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonSummary, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { mergeWriterIdle, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { daemonStatePath, readDaemonState } from '../src/daemon/state-cursor.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2087: the shadow trial is gone. The merge writer's trial is the loop's only trial.

const root = fileURLToPath(new URL('..', import.meta.url));
const start = Date.parse('2030-05-01T00:00:00Z'), iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const tip = sha('main-tip');
const configFor = (credentialFile: string) => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy', retrials: 3 } } });
const passed = ['ready', 'build', 'review', 'test'];
const submitted = (n: number, minutesAgo: number) => {
  const candidate = { sha: sha(`head${n}`), baseSha: tip, pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' };
  return {
    id: `w${n}`, key: `GY-${n}`, description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
    policy: { checks: ['test'], review: true }, revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start),
    stageEnteredAt: iso(start - minutesAgo * 60_000), ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: n }, candidate, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, violations: [], stage: 'build',
    gates: ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: passed.includes(name), reasons: passed.includes(name) ? [] : [`${name} refused`] })),
    observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, baseTip: tip },
  } as unknown as Work;
};

test('unit:no-shadow-trial — the shadow gate is deleted: a cycle with submitted heads starts exactly one trial (the merge writer\'s), a cursor carrying old shadow verdicts loads without them, and master status has no shadowGate', async () => {
  assert.ok(!existsSync(join(root, 'src/daemon/cycle-shadow.ts')), 'src/daemon/cycle-shadow.ts is gone');
  assert.doesNotMatch(readFileSync(join(root, 'src/cli/master/operations.ts'), 'utf8'), /shadowGate/, 'master status prints no shadowGate');

  const directory = await temporaryDirectory('no-shadow-trial');
  const config = configFor(join(directory, 'coordinator.token'));
  const work = [submitted(2, 5), submitted(1, 30)];
  const trials: string[] = [];
  const mergeWriter: MergeWriterReads = {
    baseBranch: 'main', retrials: 3, now: () => start, merger: async () => 'control-plane',
    fetch: async () => tip,
    merge: async head => ({ mergeSha: sha(`merge:${head}`), files: ['src/app.ts'] }),
    trial: async mergeSha => { trials.push(mergeSha); return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0, skipped: 0 } } }; },
    push: async () => 'pushed', holds: async () => false, record: async () => undefined,
  };
  // An effects object still carrying the old `shadow` reads: the cycle never touches them.
  const shadow = new Proxy({}, { get: (_, name) => { throw new Error(`the cycle read the deleted shadow gate (${String(name)})`); } });
  const github = new Proxy({}, { get: (_, name) => { throw new Error(`the cycle called GitHub (${String(name)})`); } });
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), snapshot: async () => ({ work, now: iso(start) }),
    closeSession: () => {}, dispatch: async () => {},
    decisions: async () => ({ decisions: [] }), persist: async () => {},
    github, merge: github, shadow, mergeWriter,
  } as unknown as DaemonEffects;
  const state = emptyDaemonState(config), now = () => start;
  await runCycle(config, state, effects, now);
  await mergeWriterIdle(state);
  assert.deepEqual(trials, [sha(`merge:${sha('head1')}`)], 'one trial, the merge writer\'s, of the oldest head');
  assert.ok(!('shadowGate' in daemonSummary(state, start, 60_000, config.hostId)), 'the loop summary has no shadowGate');

  // A cursor an older loop wrote, its shadow verdicts included, loads; the verdicts are dropped.
  const legacy = { ...emptyDaemonState(config), shadow: [{ key: 'GY-1', id: 'w1', head: sha('head1'), baseTip: tip, mergeSha: null, risk: 'normal', build: 'pass', tests: { passed: 0, failed: [], files: 0 }, conflict: [], durationMs: 1, at: iso(start), outcome: 'pending' }] };
  await writeFile(daemonStatePath(config), JSON.stringify(legacy));
  const loaded = await readDaemonState(root, config);
  assert.ok(!('shadow' in loaded), 'the old verdicts are not carried');
  assert.equal(loaded.repository, 'owner/project');
});
