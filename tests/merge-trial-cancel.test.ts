import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { foldMergeLedger } from '../src/model-boundary/merge-ledger.js';
import { mergeWriterIdle, mergeWriterStep, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { masterConfigSchema } from '../src/master.js';
import { runChild } from '../src/child-runner.js';
import { mergeRecordKinds, type MergePorts, type MergeRecordEvent } from '../src/merge-writer/executor.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { Observation, Work } from '../src/model/work.js';

// GY-3099: a merge trial carrying a head that is refused or replaced while it runs is cancelled the
// next cycle. GY-3120: each head trials alone, so the heads beside it are never cancelled.

const start = Date.parse('2030-05-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const base = sha('base');

const candidateOf = (key: string, head: string) => ({ sha: head, baseSha: base, pr: 7, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' });
const item = (key: string, ageMinutes: number): Work => {
  const head = sha(`head:${key}`);
  return {
    id: `w-${key}`, key, title: key, type: 'feature', description: '', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
    policy: { checks: ['test'], review: true }, stage: 'build', revision: 1, policyRevision: 1, ready: true, epoch: 1, lease: null,
    workspaces: [], submission: { epoch: 1, pr: 7 }, candidate: candidateOf(key, head), reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: { source: 'control-plane', candidate: candidateOf(key, head), checks: [], reviews: [], merged: false, mergeSha: null,
      mergeable: true, protected: true, files: ['src/app.ts'], at: iso(start), baseTip: base } as unknown as Observation,
    blocker: null, gates: ['build', 'review'].map(name => ({ name, passed: true, reasons: [] })), violations: [],
    createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(start - ageMinutes * 60_000),
  } as unknown as Work;
};

/** The step over `work` with fake ports: `hang`'s first trial runs until it is cancelled, every other one passes and delivers. */
function harness(work: Work[], hang: string) {
  const trials: { heads: string[]; signal: AbortSignal | undefined; finished: boolean }[] = [], events: { key: string; event: MergeRecordEvent }[] = [];
  const ledgerEvents: { kind: string; payload: unknown; work: string }[] = [];
  const fold = () => { const folded = foldMergeLedger(ledgerEvents as never); for (const entry of work) (entry as { mergeLedger?: unknown }).mergeLedger = folded[entry.key] ?? null; };
  const ports: MergePorts = {
    baseBranch: 'main', now: () => start,
    fetch: async () => base,
    merge: async (head, tip) => ({ mergeSha: sha(`merge:${tip}:${head}`), files: ['src/app.ts'] }),
    trial: async (_mergeSha, _files, _item, _baseTip, _onStep, _onTiming, heads, _share, signal) => {
      const trial = { heads: (heads ?? []).map(entry => entry.key), signal, finished: false };
      trials.push(trial);
      // The hanging head's first test step never finishes on its own: only its cancellation ends it.
      if (trial.heads[0] === hang && trials.filter(entry => entry.heads[0] === hang).length === 1) await new Promise(() => {});
      trial.finished = true;
      return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: ['src/app.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } };
    },
    push: async () => 'pushed', holds: async () => false,
    record: async (target, event) => {
      events.push({ key: target.key, event });
      const { kind, ...fields } = event as typeof event & { kind: string };
      const payload = kind === 'intent' ? { key: target.key, ...fields } : kind === 'refused' ? { ...fields, kind: 'merge' } : fields;
      ledgerEvents.push({ kind: mergeRecordKinds[kind], payload, work: target.key });
      if (kind === 'reconciled') { const observed = work.find(entry => entry.key === target.key)!; observed.stage = 'done'; observed.observation = { ...observed.observation!, merged: true, mergeSha: (event as { mergeSha: string }).mergeSha }; }
      fold();
      return {};
    },
  };
  const reads: MergeWriterReads = { ...ports, parallel: 3 };
  const state = emptyDaemonState(config);
  const effects = { mergeWriter: reads, persist: async () => {}, rework: async () => {} };
  let clock = start;
  const step = async () => { clock += 1000; await mergeWriterStep({ state, effects, now: () => clock, snapshot: { work }, performed: [] } as unknown as Cycle); };
  return { state, trials, events, step };
}

const settle = async (made: ReturnType<typeof harness>) => { for (let cycle = 0; cycle < 10; cycle++) { await made.step(); await mergeWriterIdle(made.state); } };

test('unit:merge-trial-cancels-on-refusal — a running trial whose head gets a new head is cancelled the next cycle; the heads trialled beside it land uncancelled, and the new head is trialled afresh', async () => {
  const work = [item('GY-1', 30), item('GY-2', 20), item('GY-3', 10)];
  const made = harness(work, 'GY-2');
  await made.step();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(made.trials.map(entry => entry.heads).sort(), [['GY-1'], ['GY-2'], ['GY-3']], 'each head is trialled alone, all at once');
  const hung = made.trials.find(entry => entry.heads[0] === 'GY-2')!;
  assert.ok(hung.signal && !hung.signal.aborted);
  // GY-2's worker submits a new head while the trial runs.
  const replaced = sha('head:GY-2:second');
  work[1]!.candidate = candidateOf('GY-2', replaced);
  (work[1]!.observation as { candidate: unknown }).candidate = candidateOf('GY-2', replaced);
  await made.step();
  assert.ok(hung.signal!.aborted, 'the cycle that sees the new head cancels its trial and kills its children');
  assert.ok(made.trials.filter(entry => entry !== hung).every(entry => !entry.signal?.aborted && entry.finished), 'no other head\'s trial is cancelled');
  await mergeWriterIdle(made.state);
  assert.equal(hung.finished, false, 'the flight settled without waiting for the test step');
  assert.deepEqual(work.map(entry => entry.stage), ['done', 'build', 'done'], 'the heads beside it landed');
  await made.step();
  // The harness mutates the item in place, so the settled action is keyed by the head the item now carries.
  assert.match(made.state.actions[`merge-writer:GY-2:${replaced}`]?.detail ?? '', /trial was cancelled because GY-2's head .* was replaced/);
  assert.equal(made.state.mergeWriter.reworks.length, 0, 'no head is refused to rework');
  await settle(made);
  assert.deepEqual(made.trials.slice(3).map(entry => entry.heads), [['GY-2']], 'GY-2\'s new head is trialled afresh');
  assert.deepEqual(work.map(entry => entry.stage), ['done', 'done', 'done']);
  assert.equal(made.events.filter(({ key, event }) => key === 'GY-2' && event.kind === 'reconciled').length, 1);
});

test('unit:merge-trial-cancels-on-refusal — a running trial whose head is returned for rework is cancelled and the head is not merged', async () => {
  const work = [item('GY-1', 30), item('GY-2', 20)];
  const made = harness(work, 'GY-1');
  await made.step();
  await new Promise(resolve => setImmediate(resolve));
  work[0]!.reworkRequested = true;
  await made.step();
  assert.ok(made.trials[0]!.signal!.aborted);
  await mergeWriterIdle(made.state);
  await settle(made);
  assert.deepEqual(made.trials.map(entry => entry.heads), [['GY-1'], ['GY-2']], 'the reworked head is never trialled again; the head beside it landed on its own trial');
  assert.deepEqual(work.map(entry => entry.stage), ['build', 'done']);
});

test('unit:merge-trial-cancels-on-refusal — an aborted signal kills a running child at once', async () => {
  const controller = new AbortController(), began = Date.now();
  const child = runChild('sleep', ['30'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(child, (error: { signal?: string }) => error.signal === 'SIGTERM');
  assert.ok(Date.now() - began < 5000);
});
