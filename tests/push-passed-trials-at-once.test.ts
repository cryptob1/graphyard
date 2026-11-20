import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { foldMergeLedger } from '../src/model-boundary/merge-ledger.js';
import { mergeWriterIdle, mergeWriterStep, mergeWriterSummary, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { masterConfigSchema } from '../src/master.js';
import { itemLine } from '../src/cli/master-status.js';
import { mergeRecordKinds, trialAheadOfReviewReason, type MergeRecordEvent, type MergeTrialRun } from '../src/merge-writer/executor.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { Observation, Work } from '../src/model/work.js';

const start = Date.parse('2030-05-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const base = sha('base');
const item = (key: string, ageMinutes: number): Work => {
  const head = sha(`head:${key}`);
  return {
    id: `w-${key}`, key, title: key, type: 'feature', description: '', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
    policy: { checks: ['test'], review: true }, stage: 'build', revision: 1, policyRevision: 1, ready: true, epoch: 1, lease: null,
    workspaces: [], submission: { epoch: 1, pr: 7 },
    candidate: { sha: head, baseSha: base, pr: 7, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: { source: 'control-plane', candidate: { sha: head, baseSha: base, pr: 7, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' }, checks: [], reviews: [], merged: false, mergeSha: null,
      mergeable: true, protected: true, files: ['src/app.ts'], at: iso(start), baseTip: base } as unknown as Observation,
    blocker: null, gates: ['build', 'review'].map(name => ({ name, passed: true, reasons: [] })), violations: [],
    createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(start - ageMinutes * 60_000),
  } as unknown as Work;
};

const pass: MergeTrialRun = { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: ['src/app.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } };
async function world(verdict = pass) {
  const slow = item('GY-1', 30), ready = item('GY-2', 20), work = [slow];
  const state = emptyDaemonState(config), events: { kind: string; payload: unknown; work: string }[] = [];
  let held: string | null = null;
  let tip = base, release!: (run: MergeTrialRun) => void, running = false;
  const trials: string[] = [], pushes: string[] = [];
  const record = async (target: Pick<Work, 'id' | 'key'>, event: MergeRecordEvent) => {
    const { kind, ...fields } = event;
    events.push({ kind: mergeRecordKinds[kind], payload: kind === 'intent' ? { key: target.key, ...fields } : kind === 'refused' ? { ...fields, kind: 'merge' } : fields, work: target.key });
    const ledger = foldMergeLedger(events);
    for (const entry of [slow, ready]) entry.mergeLedger = ledger[entry.key];
    if (kind === 'reconciled') {
      const entry = work.find(entry => entry.key === target.key)!;
      entry.stage = 'done'; entry.observation = { ...entry.observation!, merged: true };
    }
  };
  const reads: MergeWriterReads = {
    parallel: 1, baseBranch: 'main', now: () => start, fetch: async () => tip,
    merge: async head => ({ mergeSha: sha(`merge:${head}`), files: ['src/app.ts'] }),
    trial: async (_merge, _files, target) => {
      trials.push(target.key);
      if (target.key !== slow.key) return pass;
      running = true;
      const result = await new Promise<MergeTrialRun>(resolve => { release = resolve; });
      running = false; return result;
    },
    holds: async commit => commit === tip,
    push: async (commit, expected) => { if (tip !== expected) return 'rejected'; pushes.push(commit); tip = commit; return 'pushed'; },
    hold: async () => held, record,
  };
  const step = () => mergeWriterStep({ state, effects: { mergeWriter: reads, persist: async () => {}, rework: async () => {} }, now: () => start, snapshot: { work }, performed: [] } as unknown as Cycle);
  await step();
  for (let n = 0; !running && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(running);
  work.push(ready);
  const head = ready.candidate!.sha, mergeSha = sha(`merge:${head}`);
  await record(ready, { kind: 'intent', head, baseTip: base, mergeSha, risk: 'normal', at: iso(start) });
  await record(ready, { kind: 'trial', head, baseTip: base, mergeSha, outcome: 'verdict', build: verdict.build, tests: verdict.tests, files: verdict.files, proofs: verdict.proofs, durationMs: 1, attempts: [] });
  return { ready, slow, state, step, trials, pushes, mergeSha, aheadOfReview: () => record(ready, { kind: 'refused', head, reason: trialAheadOfReviewReason(ready.key) }), hold: () => { held = 'review pending'; }, running: () => running, move: () => { tip = sha('moved'); }, close: async () => { release(pass); await mergeWriterIdle(state); } };
}

test('integration:push-passed-trials-at-once — a passed queued candidate pushes in one cycle while the only trial slot is occupied', async () => {
  const w = await world();
  try {
    await w.step();
    assert.deepEqual(w.pushes, [w.mergeSha]);
    assert.ok(w.running(), 'the other trial has not ended');
    assert.equal(w.ready.mergeLedger?.state, 'reconciled');
    assert.deepEqual(w.trials, ['GY-1'], 'the passed candidate needs no second trial');
  } finally { await w.close(); }
});

test('integration:push-passed-trials-at-once — a moved base leaves the candidate on the normal trial path', async () => {
  const w = await world();
  try {
    w.move(); await w.step();
    assert.deepEqual(w.pushes, []);
    assert.equal(w.ready.mergeLedger?.state, 'intent');
    assert.ok(w.running());
  } finally { await w.close(); }
  for (let n = 0; n < 4; n++) { await w.step(); await mergeWriterIdle(w.state); }
  assert.ok(w.trials.includes('GY-2'), 'the moved-base candidate is retrialled normally');
});

test('e2e:push-passed-trials-at-once — master status shows the passed candidate merged while the other trial runs', async () => {
  const w = await world();
  try {
    await w.step();
    assert.equal(itemLine(w.ready, start).stage, 'Done');
    assert.equal(mergeWriterSummary(w.state.mergeWriter, start).inFlight?.key, w.slow.key);
    assert.ok(w.running());
  } finally { await w.close(); }
});

test('integration:push-passed-trials-at-once — failed verdicts and landing holds never push beside a running trial', async () => {
  for (const verdict of [{ ...pass, build: 'fail' as const }, { ...pass, tests: { passed: 0, failed: ['src/app.ts'], files: 1 } }, pass]) {
    const w = await world(verdict);
    try {
      if (verdict === pass) w.hold();
      await w.step();
      assert.deepEqual(w.pushes, []);
      assert.ok(w.running());
    } finally { await w.close(); }
  }
});


test('integration:push-passed-trials-at-once — a trial kept ahead of review lands once approved without taking a trial slot', async () => {
  const w = await world();
  try {
    await w.aheadOfReview();
    await w.step();
    assert.deepEqual(w.pushes, [w.mergeSha]);
    assert.equal(w.ready.mergeLedger?.state, 'reconciled');
    assert.deepEqual(w.trials, ['GY-1']);
    assert.ok(w.running());
  } finally { await w.close(); }
});
