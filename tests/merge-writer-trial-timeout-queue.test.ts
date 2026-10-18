import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { foldMergeLedger } from '../src/model/merge-ledger.js';
import { mergeWriterIdle, mergeWriterStep, trialTimeoutReason, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { TrialTimeoutError } from '../src/merge-writer/trial.js';
import { trialFailurePrefix } from '../src/model/rework-ground.js';
import { mergeRecordKinds, type MergePorts, type MergeRecordEvent } from '../src/merge-writer/executor.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { Observation, Work } from '../src/model/work.js';

// GY-2079: a trial timeout measures the host, not the merge, but GY-2053's head timed out twice and
// was retried first each time, so the serial merge writer delivered nothing for hours while eight
// submitted heads waited. A timed-out head now yields its turn — tried after every other queued
// head — and a head that times out again where another head's trial passed is refused to rework
// (`trial failed`: the timeouts and the slow files the runner named) instead of retrying unbounded.

const start = Date.parse('2030-05-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const base = sha('base');
/** The timed-out trial's log: the runner names the files it was still running when the budget ran out. */
const timeoutTail = '$ node --import tsx tests/helpers/run-tests.ts --files-from tests-1.txt\nok 1 - tests/fast.test.ts\nnot ok 2 - tests/slow.test.ts\n';

const item = (key: string, ageMinutes: number): Work => {
  const head = sha(`head:${key}`);
  return {
    id: `w-${key}`, key, title: key, type: 'feature', description: '', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/app.ts'], stage: 'build', revision: 1, policyRevision: 1, ready: true, epoch: 1, lease: null,
    workspaces: [], submission: { epoch: 1, pr: 7 },
    candidate: { sha: head, baseSha: base, pr: 7, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: { source: 'control-plane', candidate: { sha: head, baseSha: base, pr: 7, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' }, checks: [], reviews: [], merged: false, mergeSha: null,
      mergeable: true, protected: true, files: ['src/app.ts'], at: iso(start), baseTip: base } as unknown as Observation,
    blocker: null, gates: ['build', 'review'].map(name => ({ name, passed: true, reasons: [] })), violations: [],
    createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(start - ageMinutes * 60_000),
  } as unknown as Work;
};

interface Harness {
  work: Work[];
  state: ReturnType<typeof emptyDaemonState>;
  trials: string[];
  events: { key: string; event: MergeRecordEvent }[];
  decided: { key: string; action: string; reason: string; input: unknown }[];
  step: () => Promise<void>;
}

/**
 * The step against a snapshot of `work` items and fake ports: trials of `slowKeys` time out (naming
 * `timeoutTail`), every other trial passes and delivers; the records fold onto the snapshot's items
 * exactly as the control plane's ledger would.
 */
function harness(work: Work[], slowKeys: readonly string[]): Harness {
  const made: Harness = { work, state: emptyDaemonState(config), trials: [], events: [], decided: [], step: async () => {} };
  const ledgerEvents: { kind: string; payload: unknown; work: string }[] = [];
  // The record route (server/merge-record.ts): the payload it stores drops `kind`, an intent gains the item's key, a refusal records kind 'merge', and a reconciliation delivers the item.
  const fold = () => { const folded = foldMergeLedger(ledgerEvents as never); for (const entry of work) (entry as { mergeLedger?: unknown }).mergeLedger = folded[entry.key] ?? null; };
  const ports: MergePorts = {
    baseBranch: 'main', retrials: 1, now: () => start,
    fetch: async () => base,
    merge: async head => ({ mergeSha: sha(`merge:${head}`), files: ['src/app.ts'] }),
    trial: async (_mergeSha, _files, picked) => {
      made.trials.push(picked.key);
      if (slowKeys.includes(picked.key)) throw new TrialTimeoutError('tests', 1_200_000, timeoutTail);
      return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: ['src/app.ts'], proofs: {} };
    },
    push: async () => 'pushed', holds: async () => false,
    record: async (target, event) => {
      made.events.push({ key: target.key, event });
      const { kind, ...fields } = event as typeof event & { kind: string };
      const payload = kind === 'intent' ? { key: target.key, ...fields } : kind === 'refused' ? { ...fields, kind: 'merge' } : fields;
      ledgerEvents.push({ kind: mergeRecordKinds[kind], payload, work: target.key });
      if (kind === 'reconciled') { const observed = target as Work; observed.stage = 'done'; if (observed.observation) observed.observation = { ...observed.observation, merged: true, mergeSha: (event as { mergeSha: string }).mergeSha }; }
      fold();
      return {};
    },
  };
  const reads: MergeWriterReads = { ...ports, merger: async () => 'control-plane' };
  const effects = { mergeWriter: reads, persist: async () => {}, decide: async (picked: Work, action: string, reason: string, input: unknown) => { made.decided.push({ key: picked.key, action, reason, input }); return { id: `d-${made.decided.length + 1}` }; } };
  let clock = start;
  made.step = async () => {
    clock += 1000;
    await mergeWriterStep({ state: made.state, effects, now: () => clock, snapshot: { work }, performed: [] } as unknown as Cycle);
  };
  return made;
}

test('unit:trial-timeout-yields-queue-turn — after a trial timeout the timed-out head is tried after every other queued head rather than first', async () => {
  const made = harness([item('GY-1', 30), item('GY-2', 20), item('GY-3', 10)], ['GY-1']);
  const { state, step } = made;
  // GY-1 is the oldest, so it merges first — and its trial times out.
  await step(); await mergeWriterIdle(state);
  assert.deepEqual(made.trials, ['GY-1']);
  // The settled timeout counts and yields; the intent the trial left open is settled first, so the
  // queue turns over only the cycle after, and GY-2 — not GY-1 — takes it.
  await step();
  assert.deepEqual(state.mergeWriter.timeouts?.map(entry => [entry.key, entry.count, entry.reason]) ?? [], [['GY-1', 1, null]]);
  assert.match(state.actions[`merge-writer:GY-1:${sha('head:GY-1')}`]?.detail ?? '', /yields its turn and is tried after every other queued head/);
  await step(); await mergeWriterIdle(state);
  assert.deepEqual(state.mergeWriter.queue.map(entry => entry.key), ['GY-2', 'GY-3', 'GY-1'], 'the timed-out head keeps its place only behind every other queued head');
  assert.deepEqual(made.trials, ['GY-1', 'GY-2'], 'GY-2 had the turn the timeout yielded');
  // GY-2 delivers, then GY-3; only then is GY-1 tried again. A cycle that lands a merge starts no trial.
  await step(); await mergeWriterIdle(state);
  await step(); await mergeWriterIdle(state);
  await step(); await mergeWriterIdle(state);
  await step(); await mergeWriterIdle(state);
  assert.deepEqual(made.trials, ['GY-1', 'GY-2', 'GY-3', 'GY-1']);
});

test('unit:repeated-trial-timeout-refused-to-rework — a head that times out its trial repeatedly while other heads\' trials pass is refused with a recorded ground and returned to rework instead of being retried without bound', async () => {
  const made = harness([item('GY-1', 30), item('GY-2', 20)], ['GY-1']);
  const { state, step } = made;
  const head = sha('head:GY-1');
  // First trial of GY-1 times out; the head yields; GY-2 takes the turn and its trial passes.
  await step(); await mergeWriterIdle(state);
  await step();
  await step(); await mergeWriterIdle(state);
  // GY-1 is tried again — after GY-2 — and times out once more, now where another head passed. The
  // cycle that settles it counts the second timeout, settles the intent the trial left open, then
  // refuses the head: the refusal is the ledger's last word for it, naming the slow files the runner
  // reported, and the rework it grounds is owed.
  await step();
  await step(); await mergeWriterIdle(state);
  await step();
  assert.deepEqual(made.trials, ['GY-1', 'GY-2', 'GY-1']);
  assert.deepEqual(state.mergeWriter.timeouts?.map(entry => [entry.key, entry.count, entry.othersPassed]) ?? [], [['GY-1', 2, false]]);
  const refusals = made.events.filter(({ key, event }) => key === 'GY-1' && (event as { kind: string }).kind === 'refused' && String((event as { reason?: string }).reason ?? '').startsWith(trialFailurePrefix)).map(({ event }) => event as { reason: string });
  assert.deepEqual(refusals.map(entry => entry.reason), [trialTimeoutReason(2, ['tests/fast.test.ts', 'tests/slow.test.ts'])], 'the refusal names the slow test files where the runner reported them');
  assert.ok(refusals[0]!.reason.startsWith(`${trialFailurePrefix}: the trial timed out 2 times while other heads' trials passed`));
  assert.deepEqual(state.mergeWriter.refusals.map(entry => [entry.key, entry.reason]), [['GY-1', refusals[0]!.reason]]);
  assert.deepEqual(state.mergeWriter.reworks.map(entry => [entry.key, entry.head, entry.reason]), [['GY-1', head, refusals[0]!.reason]]);
  assert.match(state.actions[`merge-writer:GY-1:${head}`]?.detail ?? '', /timed out its trial 2 times while other heads' trials passed: refused/);
  // The rework is requested the next cycle, grounded exactly as a failed trial grounds one.
  await step();
  assert.deepEqual(made.decided.map(entry => [entry.key, entry.action]), [['GY-1', 'rework']]);
  assert.equal((made.decided[0]!.input as { binding: string }).binding, `${head}:merge-writer-trial-failed`);
  // The refused head is not retried without bound: the queue drops it for its trial-failure refusal,
  // and once the rework is applied no further trial runs.
  assert.equal(state.mergeWriter.queue.length, 0, 'the queue drops a head its trial-failure refusal holds');
  const item1 = made.work[0]!;
  (item1 as { reworkRequested: boolean }).reworkRequested = true;
  await step(); await mergeWriterIdle(state); await step();
  assert.deepEqual(made.trials, ['GY-1', 'GY-2', 'GY-1'], 'no trial beyond the bound');
  assert.deepEqual(state.mergeWriter.timeouts ?? [], [], 'the yield of a head the queue no longer holds is pruned');
});

test('unit:repeated-trial-timeout-refused-to-rework — a timeout where no other head passed is host noise: it neither counts toward the bound nor refuses', async () => {
  const made = harness([item('GY-9', 5)], ['GY-9']);
  const { state, step } = made;
  await step(); await mergeWriterIdle(state);
  await step();
  await step(); await mergeWriterIdle(state);
  await step();
  assert.deepEqual(made.trials, ['GY-9', 'GY-9'], 'alone on the queue the head keeps being tried');
  assert.deepEqual(state.mergeWriter.timeouts?.map(entry => [entry.key, entry.count, entry.othersPassed, entry.reason]) ?? [], [['GY-9', 1, false, null]], 'the second timeout counted nothing: no other head passed since the first');
  assert.equal(made.events.filter(({ event }) => (event as { kind: string }).kind === 'refused' && String((event as { reason?: string }).reason ?? '').startsWith(trialFailurePrefix)).length, 0);
  assert.deepEqual([state.mergeWriter.refusals, state.mergeWriter.reworks, made.decided], [[], [], []]);
});
