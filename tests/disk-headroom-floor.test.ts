import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCycle } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { mergeWriterIdle, mergeWriterSummary, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { masterCauses } from '../src/daemon/master-stalled-delivery.js';
import { processPidNamespace, processStartTicks } from '../src/tmp-reclaim.js';
import type { MergePorts } from '../src/merge-writer/executor.js';
import { masterConfigSchema, type WorkerProfile } from '../src/master.js';
import type { Work } from '../src/model.js';
import { readySpecCheck } from './helpers/spec-check.js';

// GY-3122: below the free-space floor the loop reclaims only its own leftovers, and while still below starts no trial or worker.

const start = Date.parse('2030-04-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const tip = sha('main-tip');
const worker = { name: 'w1', principal: 'w1-principal', agentName: 'agent-w1', mode: 'launch', kind: 'claude', credentialFile: '/outside/w1.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;
// Built lazily, and the headroom module imported in each test, so a base without them fails each case rather than the file.
const headroom = () => import('../src/daemon/disk-headroom.js');
const diskHeadroomKey = 'disk-headroom';
const makeConfig = () => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [worker], run: { diskFloorGb: 30, mergeWriter: { deployKeyFile: '/keys/deploy', retrials: 3 } } });
const gates = (passed: string[]) => ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: passed.includes(name), reasons: passed.includes(name) ? [] : [`${name} refused`] }));
const item = (fields: Record<string, unknown>) => ({
  description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
  policy: { checks: ['test'], review: true }, revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(start - 60_000),
  ready: true, epoch: 0, lease: null, workspaces: [], submission: null, candidate: null, reworkRequested: false, scenarioRequirements: [], evidence: [],
  specCheck: readySpecCheck(new Date().toISOString()),
  observation: null, blocker: null, violations: [], sessions: [], gates: gates(['ready']), stage: 'ready', ...fields,
}) as unknown as Work;

/** A claimable item and a submitted head: a cycle with room dispatches the one and trials the other. */
function fixture(free: number[], reclaimed: string[] = []) {
  const candidate = { sha: sha('head2'), baseSha: tip, pr: 2, branch: 'graphyard/gy-2-1', author: 'worker' };
  const work = [
    item({ id: 'w1', key: 'GY-1', title: 'Claimable' }),
    item({ id: 'w2', key: 'GY-2', title: 'Submitted', stage: 'build', epoch: 1, submission: { epoch: 1, pr: 2 }, candidate, gates: gates(['ready', 'build', 'review', 'test']),
      observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, baseTip: tip, baseTipContained: true, at: iso(start) } }),
  ];
  const seen = { dispatched: [] as string[], trials: 0, reclaims: 0, readings: 0 };
  const ports: MergePorts = {
    baseBranch: 'main', retrials: 3, now: () => start, fetch: async () => tip,
    merge: async head => ({ mergeSha: sha(`merge:${head}`), files: ['src/app.ts'] }),
    trial: async () => { seen.trials += 1; return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 10, logTail: '', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } }; },
    push: async () => 'pushed', holds: async () => false, record: async () => {},
  };
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: iso(start) }),
    agents: () => [], herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({ w1: { available: true, reason: null } }),
    closeSession: () => {},
    dispatch: async target => { seen.dispatched.push(target.key); return { pane: 'p1', epoch: 1 }; },
    mergeWriter: ports as MergeWriterReads,
    diskVolumes: async () => [{ path: '/home', freeBytes: free[Math.min(seen.readings++, free.length - 1)]! * 1e9 }],
    reclaimDisk: async () => { seen.reclaims += 1; return reclaimed; },
    persist: async () => {},
  };
  return { work, effects, seen };
}

let config: ReturnType<typeof makeConfig>;
test.beforeEach(() => { config = makeConfig(); });

test('unit:disk-headroom-floor — above the floor the cycle changes nothing: no reclaim, no shortage, the worker dispatched and the head trialled', async () => {
  const { effects, seen } = fixture([200]);
  const state = emptyDaemonState(config);
  await runCycle(config, state, effects, () => start);
  await mergeWriterIdle(state);
  assert.equal(seen.reclaims, 0, 'nothing is reclaimed above the floor');
  assert.equal(state.diskHeadroom, null);
  assert.ok(!Object.keys(state.actions).some(key => key.startsWith('disk')), Object.keys(state.actions).join(', '));
  assert.deepEqual(seen.dispatched, ['GY-1']);
  assert.equal(seen.trials, 1);
});

test('unit:disk-headroom-floor — below the floor after reclaiming, no trial or worker starts, the shortage is named for master status and wakes the master; once room returns both start again', async () => {
  const { work, effects, seen } = fixture([12, 14], ['container graphyard-trial-abc']);
  const state = emptyDaemonState(config);
  await runCycle(config, state, effects, () => start);
  await mergeWriterIdle(state);
  assert.equal(seen.reclaims, 1, 'Graphyard\'s own leftovers are reclaimed first');
  assert.ok(Object.values(state.actions).some(action => action.kind === 'reclaim' && action.detail.includes('container graphyard-trial-abc')), 'the reclaim is recorded');
  assert.deepEqual(seen.dispatched, [], 'no worker starts below the floor');
  assert.equal(seen.trials, 0, 'no merge trial starts below the floor');
  assert.equal(state.mergeWriter.inFlight, null);
  assert.match(state.diskHeadroom?.shortage ?? '', /\/home has 14\.0 GB free, below the 30\.0 GB floor/, 'master status names the shortage');
  assert.equal(state.actions[diskHeadroomKey]?.state, 'failed');
  assert.ok(masterCauses(work, state.actions).some(cause => cause.key === 'disk-headroom' && cause.detail.includes('/home')), 'the master is told');

  // Room again: the shortage clears, and the worker and trial start.
  const roomy = fixture([100]);
  await runCycle(config, state, roomy.effects, () => start + 60_000);
  await mergeWriterIdle(state);
  assert.equal(roomy.seen.reclaims, 0);
  assert.equal(state.diskHeadroom, null);
  assert.equal(state.actions[diskHeadroomKey]?.state, 'done');
  assert.ok(!masterCauses(roomy.work, state.actions).some(cause => cause.key === 'disk-headroom'));
  assert.deepEqual(roomy.seen.dispatched, ['GY-1']);
  assert.equal(roomy.seen.trials, 1);
});

test('unit:disk-headroom-floor — below the floor a failing serve starts no revert trial and an owed retrial keeps its place; once room returns the revert flies', async () => {
  const served = sha('served-serve'), landing = sha('merge:landing');
  // The checkout's first-parent range between the verified baseline and the failing serve: one
  // landing, GY-2's merge — exactly what naming a culprit needs.
  const git = async (args: string[]) => {
    if (args[0] === 'log') return `${landing}\0${tip}\0Merge GY-2: Submitted\n`;
    if (args[0] === 'merge-tree') return `${sha('tree')}\0\n`;
    if (args[0] === 'commit-tree') return `${sha('revert')}\n`;
    if (args[0] === 'diff') return 'src/app.ts\n';
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const failingServe = { commit: served, check: { verified: false, case: 'case-item', step: 'step 1', reason: 'wanted 200, got 404' } };
  const tried: unknown[] = [];
  const revertFixture = (free: number[]) => {
    const built = fixture(free);
    const reads = built.effects.mergeWriter as MergeWriterReads;
    reads.git = git;
    reads.serveRecord = async () => failingServe;
    const inner = reads.trial.bind(reads);
    reads.trial = async (mergeSha, files, item, ...rest) => { tried.push(item); return inner(mergeSha, files, item, ...rest); };
    return built;
  };
  // What a passing serve left (the baseline), and a revert attempt that settled owing a retrial an hour ago.
  const state = emptyDaemonState(config);
  state.mergeWriter.serveRevert = { lastVerified: tip, reverts: [], held: null,
    retry: { serve: served, culprit: 'GY-2', mergeSha: landing, baseTip: tip, reason: 'the base tip fails the same checks', at: iso(start - 3_600_000) }, answered: null };

  const short = revertFixture([12, 14]);
  await runCycle(config, state, short.effects, () => start);
  await mergeWriterIdle(state);
  assert.equal(short.seen.trials, 0, 'no revert trial starts below the floor');
  assert.equal(state.mergeWriter.inFlight, null);
  assert.equal(state.mergeWriter.serveRevert?.retry?.serve, served, 'the owed retrial keeps its place while the shortage stands');
  assert.ok(state.diskHeadroom);

  // Room again: the retrial flies — one trial, the revert's proofless pseudo-item under the culprit's key.
  const roomy = revertFixture([100]);
  await runCycle(config, state, roomy.effects, () => start + 60_000);
  await mergeWriterIdle(state);
  assert.equal(state.diskHeadroom, null);
  assert.equal(state.mergeWriter.serveRevert?.retry, null, 'the retrial the room released is taken');
  assert.deepEqual(tried, [{ key: 'GY-2', criteria: [] }], 'the revert flew through the writer\'s own trial');
  assert.equal(mergeWriterSummary(state.mergeWriter).inFlight?.revert?.revertSha, sha('revert'), 'the revert flight is admitted');
  assert.equal(roomy.seen.trials, 1);
});

test('unit:disk-headroom-floor — a reclaim that restores the floor holds nothing', async () => {
  const { effects, seen } = fixture([20, 45], ['image graphyard-trial:old']);
  const state = emptyDaemonState(config);
  await runCycle(config, state, effects, () => start);
  await mergeWriterIdle(state);
  assert.equal(seen.reclaims, 1);
  assert.equal(state.diskHeadroom, null);
  assert.equal(state.actions[diskHeadroomKey], undefined);
  assert.deepEqual(seen.dispatched, ['GY-1']);
  assert.equal(seen.trials, 1);
});

test('unit:disk-headroom-floor — the reclaim removes only Graphyard-created leftovers: dead trials\' scratch, stopped trial containers and unused trial images', async () => {
  const root = mkdtempSync(join(tmpdir(), 'headroom-')), temporary = join(root, 'tmp'), checkouts = join(root, 'trials');
  try {
    const marker = (directory: string, pid: number) => { mkdirSync(directory, { recursive: true }); writeFileSync(`${directory}.owner`, JSON.stringify({ pid, startedAt: pid === process.pid ? processStartTicks(pid) : null, pidNamespace: processPidNamespace(), at: iso(start) })); };
    const gone = 2 ** 22 + 12345;
    marker(join(temporary, 'gy-tdead'), gone);
    marker(join(temporary, 'gy-hdead'), gone);
    marker(join(temporary, 'gy-tlive'), process.pid);
    marker(join(temporary, 'someone-else'), gone);
    mkdirSync(join(temporary, 'gy-tunmarked'));
    marker(join(checkouts, 'gy-cdead'), gone);
    const docker: string[][] = [];
    const run = async (command: string, args: string[]) => {
      assert.equal(command, 'docker');
      docker.push(args);
      if (args[0] === 'ps') return 'graphyard-trial-1a2b\npostgres-dev\n';
      if (args[0] === 'images') return 'graphyard-trial:local\ngraphyard-trial:old\n';
      return '';
    };
    const { reclaimGraphyardLeftovers } = await headroom();
    const removed = await reclaimGraphyardLeftovers(run, { temporary: [temporary], checkouts: [checkouts] });
    assert.ok(!existsSync(join(temporary, 'gy-tdead')) && !existsSync(join(temporary, 'gy-hdead')) && !existsSync(join(checkouts, 'gy-cdead')), 'a dead trial\'s scratch goes');
    assert.ok(existsSync(join(temporary, 'gy-tlive')), 'a live trial\'s scratch stays');
    assert.ok(existsSync(join(temporary, 'someone-else')) && existsSync(join(temporary, 'gy-tunmarked')), 'what Graphyard did not mark as its own stays');
    assert.deepEqual(docker.filter(args => args[0] === 'rm' || args[0] === 'image').map(args => args.join(' ')), ['rm graphyard-trial-1a2b', 'image rm graphyard-trial:old'], 'only stopped trial containers and unused trial images, never forced');
    assert.ok(removed.includes('container graphyard-trial-1a2b') && removed.includes('image graphyard-trial:old'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
