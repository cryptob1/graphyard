import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { withDatabase } from './helpers/postgres.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { runTrial, trialAffordableFiles, trialShardBreadth } from '../src/merge-writer/trial.js';
import * as trialLoad from '../src/merge-writer/trial-load.js';
const { trialSlotCount } = trialLoad;
import * as writer from '../src/daemon/cycle-merge-writer.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
const { busyTrialSlots, mergeWriterIdle, mergeWriterStep, trialShareAllowance } = writer;
import { bootstrapGate, gateRecordPath, writeGateRecord } from '../src/batch-gate.js';
import { batchGateStep } from '../src/daemon/cycle-batch-gate.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { masterConfigSchema } from '../src/master.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { Work } from '../src/model.js';

const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/token', cliPath: '/bin/graphyard', repository: 'fixture/lanes', baseBranch: 'main', hostId: 'fixture', masterAgentName: 'master', workers: [] });
const ample = async () => ({ totalBytes: 128 * 2 ** 30, availableBytes: 100 * 2 ** 30 });
const small = async () => ({ totalBytes: 8 * 2 ** 30, availableBytes: 7 * 2 ** 30 });
const files = Array.from({ length: 24 }, (_, i) => `tests/file-${i}.test.ts`);
const identity = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();

async function repository() {
  const root = await temporaryDirectory('share-cores-repo'), base = await temporaryDirectory('share-cores-base');
  git(root, 'init', '-q', '-b', 'main');
  const content = {
    'package.json': JSON.stringify({ name: 'fixture', scripts: { build: 'true' } }),
    'graphyard.json': JSON.stringify({ delivery: { mergeGate: { perCandidate: [], preMerge: [{ check: 'test', command: 'node scripts/tests.mjs', source: 'script', reason: 'fixture', selection: { command: 'node scripts/select.mjs', pattern: '^tests/[\\w./-]+\\.test\\.ts$' } }] } } }),
    'scripts/select.mjs': '', 'scripts/tests.mjs': '',
    ...Object.fromEntries(files.map(file => [file, 'fixture\n'])),
  };
  for (const [path, text] of Object.entries(content)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'fixture');
  return { root, base, mergeSha: git(root, 'rev-parse', 'HEAD') };
}
const commands: ChildRun = async (command, args, options) => {
  if (command === 'npm') return '';
  if (command === 'node' && args[0] === 'scripts/select.mjs') return files.join('\n');
  if (command === 'node' && args[0] === 'scripts/tests.mjs') return '';
  return defaultChildRun(command, args, options);
};

// The same allocation and shard runner used by both detached and in-process trials.
test('e2e:trial-lanes-share-cores — real trial sizing shares 24 cores and retains the memory cap', { timeout: 120_000 }, async () => {
  const fixture = await repository();
  for (const [busy, expected] of [[1, 24], [4, 6], [12, 2], [24, 2]]) {
    const timings: string[] = [];
    const allowance = trialShareAllowance(busy, 60_000, 24);
    const result = await runTrial({ ...fixture, changedFiles: files, cores: 24, ...allowance, memory: ample, run: commands, onTiming: step => timings.push(step) });
    assert.equal(result.build, 'pass', result.logTail);
    assert.equal(result.tests.passed, 24, result.logTail);
    assert.deepEqual(timings.filter(step => step.includes('lanes')), [`tests: ${expected} lanes, breadth 1`]);
  }
  const budget = await trialAffordableFiles(small);
  assert.equal(trialShardBreadth(24, 24, budget).lanes, 2);
  const slots = trialSlotCount(24, 12, await trialAffordableFiles(ample));
  const lanes = trialShardBreadth(trialShareAllowance(slots, 60_000, 24).cores!, 24).lanes;
  assert.equal(slots, 12);
  assert.ok(lanes >= 2 && slots * lanes <= 24 + lanes);
  assert.equal(trialSlotCount(24, 12, budget), 1);
  assert.equal(trialSlotCount(24, 4, 100), 4, 'configured parallel is only an upper bound');
});

for (const withGate of [false, true]) test(`e2e:trial-lanes-share-cores — ${withGate ? 'with gate' : 'ample host'}: six Postgres queued candidates obey host slots and record real trial lanes; a batch gate occupies a slot`, { timeout: 120_000 }, async () => {
  const store = await withDatabase('trial-lanes-share-cores'); await store.init();
  const fixture = await repository(), state = emptyDaemonState(config);
  const now = Date.now(), at = new Date(now).toISOString();
  const baseTip = 'a'.repeat(40);
  let releaseGate!: () => void;
  const gateWait = new Promise<void>(resolve => { releaseGate = resolve; });
  let started = 0, active = 0, peak = 0;
  let releaseTrials!: () => void;
  const trialWait = new Promise<void>(resolve => { releaseTrials = resolve; });
  const reads: MergeWriterReads = {
    baseBranch: 'main', now: () => now, parallel: 12, cores: 24,
    // Four affordable files cap admission at two trials; the gate consumes one.
    memory: withGate ? async () => ({ totalBytes: 8 * 2 ** 30, availableBytes: 8 * 2 ** 30 }) : ample,
    fetch: async () => baseTip,
    merge: async () => ({ mergeSha: fixture.mergeSha, files }),
    trial: async (_sha, _files, _item, _base, _step, onTiming, _heads, share) => {
      started++; active++; peak = Math.max(peak, active);
      try {
        await trialWait;
        const result = await runTrial({ ...fixture, changedFiles: files, cores: 24, ...trialShareAllowance(share, 60_000, 24), memory: ample, run: commands, onTiming });
        return { ...result, files, proofs: {} };
      } finally { active--; }
    },
    push: async () => 'pushed', holds: async () => true, record: async () => {},
  };
  let gateFlight: Awaited<ReturnType<typeof batchGateStep>> = null;
  try {
    for (let i = 1; i <= 6; i++) {
      const candidate = { sha: String(i).repeat(40), baseSha: baseTip, pr: i, branch: `graphyard/gy-${i}-1`, author: 'worker' };
      const work = { id: randomUUID(), key: `GY-${i}`, title: `Candidate ${i}`, type: 'chore', description: '', priority: 1, dependencies: [], criteria: [], policy: { checks: ['test'], review: true }, revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: i }, candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [], stage: 'build',
        observation: { source: 'control-plane', candidate, files, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, baseTip, baseTipContained: true, at },
        gates: ['ready', 'build', 'review'].map(name => ({ name, passed: true, reasons: [] })),
      };
      await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
    }
    const work = (await store.pool.query('SELECT document FROM work_items ORDER BY document->>\'key\'')).rows.map(row => row.document as Work);
    const effects = { mergeWriter: reads, persist: async () => {}, rework: async () => {} };
    const cycle = { state, effects, now: () => now, snapshot: { work, now: at }, performed: [], log: () => {} } as unknown as Cycle;
    // A real batch-gate flight held in fetch, so it is busy while the writer selects slots.
    const gateReads = { ...reads, gate: { root: fixture.root, repository: 'fixture/lanes' }, git: async () => '', fetch: async () => { await gateWait; return baseTip; } };
    await writeGateRecord(gateRecordPath(fixture.root), { ...bootstrapGate('fixture/lanes', baseTip), diagnosticsAt: at });
    if (withGate) gateFlight = await batchGateStep({ ...cycle, effects: { ...cycle.effects, mergeWriter: gateReads } });
    await gateFlight?.diagnostics;
    assert.equal(busyTrialSlots(state), withGate ? 1 : 0, 'the batch gate is counted');
    const expected = withGate ? 1 : 6;
    await mergeWriterStep(cycle);
    for (let i = 0; started < expected && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(started, expected, 'queued candidates fit the CPU and memory bound including the gate');
    await mergeWriterStep(cycle);
    assert.equal(started, expected, 'another cycle cannot overfill the slots');
    releaseTrials();
    await mergeWriterIdle(state);
    assert.equal(peak, expected);
    assert.equal(state.mergeWriter.trials?.length, expected);
    for (const trial of state.mergeWriter.trials!) assert.ok(trial.steps.some(entry => entry.step === `tests: ${withGate ? 12 : 4} lanes, breadth 1`), JSON.stringify(trial));
  } finally { releaseTrials(); releaseGate(); await mergeWriterIdle(state); await gateFlight?.gate; await gateFlight?.diagnostics; await store.close(); }
});
