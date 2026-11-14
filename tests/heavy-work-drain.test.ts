import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { mergeWriterIdle, mergeWriterSummary, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { batchGateStep } from '../src/daemon/cycle-batch-gate.js';
import { workerVerificationPump } from '../src/daemon/worker-verification.js';
import { operationsCommand } from '../src/cli/master/operations.js';
import type { MasterSession } from '../src/cli/master/session.js';
import type { MergeRecordEvent } from '../src/merge-writer/executor.js';
import { acquireVerificationSlot, readHeavyDrain, requestHeavyDrain, resumeHeavyDrain, verificationSlotsDirectory } from '../src/master/verification-slots.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3304: the Chief drains the host's heavy work for another project's verification window. A job
// already running finishes; new merge trials, batch gates, declared checks, host worker verification
// and sessions' own suites wait, while the loop keeps cycling and reporting. Resume admits what
// waited with every gate it had; a restart keeps the drain and who asked for it.

const start = Date.parse('2030-06-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const githubDouble = new Proxy({}, { get: (_, name) => { throw new Error(`the merge writer step called GitHub (${String(name)})`); } });
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Two queued heads; head 1's trial runs until the test lets it finish. */
function world(directory: string) {
  const main = [sha('base')], trials: number[] = [], recorded = new Map<number, MergeRecordEvent[]>(), merges = new Map<string, number>();
  let finish!: () => void;
  const running = new Promise<void>(resolve => { finish = resolve; });
  const head = (n: number) => sha(`head${n}`);
  const snapshot = (): Work[] => [1, 2].map(n => {
    const events = recorded.get(n) ?? [], landed = events.find(event => event.kind === 'pushed');
    const intent = events.filter(event => event.kind === 'intent').at(-1) as Extract<MergeRecordEvent, { kind: 'intent' }> | undefined;
    const delivered = events.some(event => event.kind === 'reconciled');
    const ledger = intent ? { key: `GY-${n}`, state: delivered ? 'reconciled' : landed ? 'pushed' : 'intent', head: intent.head, baseTip: intent.baseTip, mergeSha: intent.mergeSha, risk: intent.risk, intentAt: intent.at, pushedAt: landed ? iso(start) : null, observedTip: delivered ? main[0] : null, refusal: null, events: events.length } : null;
    const candidate = { sha: head(n), baseSha: sha('base'), pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' };
    return {
      id: `w${n}`, key: `GY-${n}`, description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
      policy: { checks: ['test'], review: true }, revision: 1, policyRevision: 1, createdAt: iso(start + n * 1000), updatedAt: iso(start), stageEnteredAt: iso(start + n * 1000),
      ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: n }, candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [], mergeLedger: ledger,
      observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: delivered, mergeSha: delivered ? ledger!.mergeSha : null, mergeable: true, protected: false, baseTip: main[0], baseTipContained: true, at: iso(start) },
      gates: ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: name !== 'test' && name !== 'merge', reasons: [] })),
      ...(delivered ? { stage: 'done', delivery: { mergedAt: iso(start), mergeSha: ledger!.mergeSha!, authorizationRevision: 1 } } : { stage: 'build' }),
    } as unknown as Work;
  });
  const ports = (): MergeWriterReads => ({
    baseBranch: 'main', now: () => start, parallel: 1, drain: () => readHeavyDrain(directory),
    fetch: async () => main[0]!,
    merge: async (sha1, baseTip) => { const n = [1, 2].find(entry => head(entry) === sha1)!, mergeSha = sha(`merge:${sha1}:${baseTip}`); merges.set(mergeSha, n); return { mergeSha, files: [`src/item-${n}.ts`] }; },
    trial: async mergeSha => {
      const n = merges.get(mergeSha)!;
      trials.push(n);
      if (n === 1) await running;
      return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } };
    },
    push: async (mergeSha, baseTip) => { if (baseTip !== main[0]) return 'rejected'; main.unshift(mergeSha); return 'pushed'; },
    holds: async commit => main.includes(commit),
    record: async (item, event) => { const n = Number(item.key.slice(3)); recorded.set(n, [...(recorded.get(n) ?? []), event]); },
  });
  const effects = () => ({ agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: snapshot(), now: iso(start) }), closeSession: () => {}, dispatch: async () => {},
    decisions: async () => ({ decisions: [] }), persist: async () => {}, github: githubDouble, merge: githubDouble, mergeWriter: ports(),
    rework: async () => {} }) as unknown as DaemonEffects;
  const kinds = (n: number) => (recorded.get(n) ?? []).map(event => event.kind);
  return { trials, finish, effects, kinds };
}

test('e2e:heavy-work-drain — a running trial finishes under a drain while queued merge trials and the batch gate wait and the loop keeps cycling; resume admits them with every gate, and a restart keeps the drain', { timeout: 60_000 }, async () => {
  const base = await temporaryDirectory('heavy-drain'), directory = verificationSlotsDirectory(base);
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { worktreeRoot: base, mergeWriter: { deployKeyFile: '/keys/deploy' } } });
  const yard = world(directory);
  let state = emptyDaemonState(config), effects = yard.effects();
  await runCycle(config, state, effects, () => start);
  assert.deepEqual(yard.trials, [1], 'one job runs');

  // The Chief drains through its CLI, naming why and who asked.
  const session = { id: 'drain', args: ['Huck', 'Release83', 'quiet', 'window'], print: (value: unknown) => value, root: base, master: config, coordinator: { actor: { id: 'huck-chief' } } } as unknown as MasterSession;
  const drained = await operationsCommand(session) as { drained: boolean; reason: string; requestedBy: string; detail: string };
  assert.equal(drained.drained, true);
  assert.equal(drained.reason, 'Huck Release83 quiet window');
  assert.equal(drained.requestedBy, 'huck-chief');
  assert.match(drained.detail, /Running jobs finish.*master resume/);

  // The running trial finishes and lands; the queued head starts no trial while cycles go on.
  yard.finish();
  await mergeWriterIdle(state);
  for (let minute = 1; minute <= 3; minute++) { await runCycle(config, state, effects, () => start + minute * 60_000); await mergeWriterIdle(state); }
  assert.ok(yard.kinds(1).includes('pushed'), 'the job running before the drain finished and landed');
  assert.deepEqual(yard.trials, [1], 'no new merge trial starts while drained');
  assert.equal(state.cycle, 4, 'the loop keeps cycling: claims, heartbeats and status go on');
  assert.deepEqual(mergeWriterSummary(state.mergeWriter, start).queue.map(entry => entry.key), ['GY-2'], 'the waiting head keeps its queue place');

  // The batch gate starts nothing while drained.
  let gitCalls = 0;
  const gateReads = { ...effects.mergeWriter!, git: async () => { gitCalls++; throw new Error('git'); }, gate: { root: base, repository: 'owner/project' } } as MergeWriterReads;
  const gateCycle = { state, effects: { ...effects, mergeWriter: gateReads }, snapshot: { work: [], now: iso(start) }, now: () => start, log: () => {} } as unknown as Parameters<typeof batchGateStep>[0];
  assert.equal(await batchGateStep(gateCycle), null);
  assert.equal(gitCalls, 0, 'no batch gate starts while drained');

  // A restart — a fresh loop state reading the same host — keeps the drain, its reason and who asked.
  state = emptyDaemonState(config); effects = yard.effects();
  for (let minute = 4; minute <= 5; minute++) { await runCycle(config, state, effects, () => start + minute * 60_000); await mergeWriterIdle(state); }
  assert.deepEqual(yard.trials, [1], 'the restarted loop still starts no trial');
  assert.deepEqual({ reason: readHeavyDrain(directory)?.reason, requestedBy: readHeavyDrain(directory)?.requestedBy }, { reason: 'Huck Release83 quiet window', requestedBy: 'huck-chief' });

  // Resume admits the waiting head with every gate: its own trial, proof counts, push and reconcile.
  const resumed = await operationsCommand({ ...session, id: 'resume', args: [] } as unknown as MasterSession) as { resumed: boolean };
  assert.equal(resumed.resumed, true);
  for (let minute = 6; minute <= 8; minute++) { await runCycle(config, state, effects, () => start + minute * 60_000); await mergeWriterIdle(state); }
  assert.deepEqual(yard.trials, [1, 2], 'the waiting head is trialled after resume');
  assert.deepEqual(yard.kinds(2).slice(0, 3), ['intent', 'trial', 'pushed'], 'it lands through its own trial, as before the drain');
  await batchGateStep(gateCycle).catch(() => null);
  assert.ok(gitCalls > 0, 'the batch gate runs again after resume');
});

test('e2e:heavy-work-drain — declared checks and worker verification stay queued, and a session suite waits while one already running finishes', { timeout: 30_000 }, async () => {
  const base = await temporaryDirectory('heavy-drain-host'), directory = verificationSlotsDirectory(base);
  const takes: unknown[] = [];
  const pump = workerVerificationPump(base, () => 'machine-a', async (path, body) => { if (path === 'worker-verifications/take') takes.push(body); return []; }, () => base);

  const running = await acquireVerificationSlot({ directory, slots: 2, label: 'npm test (running)', drainable: true });
  requestHeavyDrain(directory, 'Huck quiet window', 'huck-chief');
  await pump();
  assert.equal(takes.length, 0, 'no declared check or worker verification is taken from the control plane while drained');

  const lines: string[] = [];
  let started = false;
  const waiting = acquireVerificationSlot({ directory, slots: 2, label: 'npm test (new)', drainable: true, pollMs: 20, onWait: line => lines.push(line) }).then(held => { started = true; return held; });
  await settle(150);
  assert.equal(started, false, 'a new session suite waits though a slot is free');
  assert.match(lines[0]!, /npm test \(new\) waits: Heavy work is drained .* by huck-chief: Huck quiet window/);
  running.release();
  await settle(100);
  assert.equal(started, false, 'the running suite finished; the new one still waits for resume');

  assert.equal(resumeHeavyDrain(directory)?.requestedBy, 'huck-chief');
  (await waiting).release();
  assert.equal(started, true, 'resume admits the waiting suite');
  await pump();
  assert.equal(takes.length, 1, 'resume takes queued worker verification and declared checks again');
});
