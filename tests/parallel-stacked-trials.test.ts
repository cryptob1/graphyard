import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { mergeWriterIdle, mergeWriterSummary, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { MergeRecordEvent } from '../src/merge-writer/executor.js';
import { trialFailurePrefix } from '../src/model/rework-ground.js';
import type { MergeLedgerState } from '../src/model/merge-ledger.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';

// Stacked parallel trials: the merge writer trials queue position 1 on the base tip, position 2 on
// position 1's merge commit and position 3 on position 2's, all at once, and pushes them strictly in
// queue order, each only onto the tip it was trialled on. A failing position re-trials only the
// positions stacked on it, on the tip as it stands.

const start = Date.parse('2030-06-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy', retrials: 3 } } });
const githubDouble = new Proxy({}, { get: (_, name) => { throw new Error(`the merge writer step called GitHub (${String(name)})`); } });
const trialMs = 150;

/** main's first-parent chain, the merge commits the writer made, what it recorded, and every trial with the heads its commit holds. */
class World {
  main = [sha('base')];
  pushes: string[] = [];
  parents = new Map<string, string>();
  contents = new Map<string, number[]>();
  recorded = new Map<number, MergeRecordEvent[]>();
  trials: { heads: number[]; baseTip: string }[] = [];
  running = 0; widest = 0;
  constructor(readonly count: number, readonly failing: number[] = []) {}
  head(n: number) { return sha(`head${n}`); }
  ledger(n: number) {
    let ledger = null as MergeLedgerState | null;
    for (const event of this.recorded.get(n) ?? []) {
      if (event.kind === 'intent') ledger = { key: `GY-${n}`, state: 'intent', head: event.head, baseTip: event.baseTip, mergeSha: event.mergeSha, risk: event.risk, intentAt: event.at, pushedAt: null, observedTip: null, refusal: null, events: (ledger?.events ?? 0) + 1 };
      else if (event.kind === 'pushed' && ledger) ledger = { ...ledger, state: 'pushed', pushedAt: event.pushedAt, events: ledger.events + 1 };
      else if (event.kind === 'reconciled' && ledger) ledger = { ...ledger, state: 'reconciled', observedTip: event.observedTip, events: ledger.events + 1 };
      else if (event.kind === 'refused') ledger = { key: `GY-${n}`, head: event.head, baseTip: null, mergeSha: null, risk: null, intentAt: null, pushedAt: null, observedTip: null, events: 1, ...ledger, state: 'refused', refusal: { kind: 'merge', reason: event.reason } };
    }
    return ledger;
  }
  snapshot(): Work[] {
    return Array.from({ length: this.count }, (_, index) => index + 1).map(n => {
      const ledger = this.ledger(n), delivered = ledger?.state === 'reconciled';
      const candidate = { sha: this.head(n), baseSha: sha('base'), pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' };
      return {
        id: `w${n}`, key: `GY-${n}`, description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
        policy: { checks: ['test'], review: true }, revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(start + n * 1000),
        ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: n }, candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [], mergeLedger: ledger,
        observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: delivered, mergeSha: delivered ? ledger!.mergeSha : null, mergeable: true, protected: false, baseTip: this.main[0], baseTipContained: true, at: iso(start) },
        gates: ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: name !== 'test' && name !== 'merge', reasons: [] })),
        ...(delivered ? { stage: 'done', delivery: { mergedAt: ledger!.pushedAt!, mergeSha: ledger!.mergeSha!, authorizationRevision: 1 } } : { stage: 'build' }),
      } as unknown as Work;
    });
  }
  ports(): MergeWriterReads {
    const world = this;
    return {
      baseBranch: 'main', retrials: 3, now: () => start, parallel: 3,
      fetch: async () => world.main[0]!,
      merge: async (head, baseTip) => {
        const n = Array.from({ length: world.count }, (_, index) => index + 1).find(entry => world.head(entry) === head)!;
        const mergeSha = sha(`merge:${head}:${baseTip}`);
        world.parents.set(mergeSha, baseTip);
        world.contents.set(mergeSha, [...(world.main.includes(baseTip) ? [] : world.contents.get(baseTip) ?? []), n]);
        return { mergeSha, files: ['src/app.ts'] };
      },
      trial: async (mergeSha, _files, _item, baseTip) => {
        const heads = world.contents.get(mergeSha)!;
        world.trials.push({ heads, baseTip: baseTip! });
        world.running += 1; world.widest = Math.max(world.widest, world.running);
        // A trial holds until the stack's three are running (or a bound passes), so serial trials could never meet here.
        for (let waited = 0; world.trials.length < 3 && waited < 2_000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5));
        await new Promise(resolve => setTimeout(resolve, trialMs));
        world.running -= 1;
        const failed = heads.some(n => world.failing.includes(n));
        return { build: 'pass', tests: { passed: failed ? 0 : 1, failed: failed ? ['tests/item.test.ts'] : [], files: 1 }, durationMs: trialMs, logTail: '', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: failed ? 1 : 0 } } };
      },
      push: async (mergeSha, baseTip) => {
        if (baseTip !== world.main[0]) return 'rejected';
        world.main.unshift(mergeSha);
        world.pushes.push(mergeSha);
        return 'pushed';
      },
      holds: async commit => world.main.includes(commit),
      record: async (item, event) => { const n = Number(item.key.slice(3)); world.recorded.set(n, [...(world.recorded.get(n) ?? []), event]); },
    };
  }
}

const harness = (world: World) => {
  const reworked: string[] = [];
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: world.snapshot(), now: iso(start) }), closeSession: () => {}, dispatch: async () => {},
    decisions: async () => ({ decisions: [] }), persist: async () => {}, github: githubDouble, merge: githubDouble, mergeWriter: world.ports(),
    rework: async (work: Work) => { reworked.push(work.key); } } as unknown as DaemonEffects;
  return { state: emptyDaemonState(config), effects, reworked };
};

test('integration:parallel-stacked-trials — three passing heads trial at once on stacked tips and land in queue order within about one trial\'s time', { timeout: 30_000 }, async () => {
  const world = new World(3);
  const { state, effects } = harness(world);
  const began = Date.now();
  await runCycle(config, state, effects, () => start);
  assert.deepEqual(mergeWriterSummary(state.mergeWriter, start).inFlights?.map(entry => entry.key), ['GY-1', 'GY-2', 'GY-3'], 'master status names every position in flight');
  assert.equal(state.mergeWriter.inFlight?.key, 'GY-1', 'inFlight still names the first position');
  await mergeWriterIdle(state);
  const elapsed = Date.now() - began;
  assert.equal(world.widest, 3, 'the three trials ran at once');
  assert.ok(elapsed < 3 * trialMs, `the stack landed in ${elapsed} ms, under the ${3 * trialMs} ms three serial trials take`);
  const [m1, m2, m3] = world.pushes;
  assert.deepEqual(world.trials.map(entry => entry.heads), [[1], [1, 2], [1, 2, 3]], 'one trial per position, each commit holding the positions before it');
  assert.deepEqual(world.trials.map(entry => entry.baseTip), [sha('base'), m1, m2], 'position 2 trialled on position 1\'s merge commit, position 3 on position 2\'s');
  assert.deepEqual(world.pushes, [sha(`merge:${world.head(1)}:${sha('base')}`), sha(`merge:${world.head(2)}:${m1}`), sha(`merge:${world.head(3)}:${m2}`)], 'pushed in queue order, each onto the tip it was trialled on');
  assert.deepEqual(world.main.slice(0, 3), [m3, m2, m1]);
  for (const n of [1, 2, 3]) assert.deepEqual((world.recorded.get(n) ?? []).map(event => event.kind), ['intent', 'trial', 'pushed', 'reconciled'], `GY-${n} is delivered once`);
  await runCycle(config, state, effects, () => start + 60_000);
  assert.equal(state.mergeWriter.inFlights, undefined, 'a settled flight leaves no position in flight');
  assert.equal(state.mergeWriter.inFlight, null);
});

test('integration:parallel-stacked-trials — when the second fails, the first lands, the second is refused, and the third is re-trialled on a tip without the second and then lands', { timeout: 30_000 }, async () => {
  const world = new World(3, [2]);
  const { state, effects, reworked } = harness(world);
  await runCycle(config, state, effects, () => start);
  await mergeWriterIdle(state);
  const m1 = sha(`merge:${world.head(1)}:${sha('base')}`), m2 = sha(`merge:${world.head(2)}:${m1}`), m3 = sha(`merge:${world.head(3)}:${m1}`);
  assert.deepEqual(world.trials.map(entry => [entry.heads, entry.baseTip]), [[[1], sha('base')], [[1, 2], m1], [[1, 2, 3], m2], [[3], m1]], 'the third was stacked on the second, then re-trialled on main once the first had landed');
  assert.deepEqual(world.pushes, [m1, m3], 'the first lands, then the third on the tip the first left');
  assert.ok(!world.main.includes(m2), 'the failing head never reaches main');
  assert.deepEqual((world.recorded.get(1) ?? []).map(event => event.kind), ['intent', 'trial', 'pushed', 'reconciled']);
  assert.deepEqual((world.recorded.get(2) ?? []).map(event => event.kind), ['intent', 'trial', 'refused']);
  const refusal = world.recorded.get(2)!.find(event => event.kind === 'refused')!;
  assert.ok(refusal.kind === 'refused' && refusal.reason.startsWith(trialFailurePrefix), 'the refusal grounds the second head\'s rework');
  assert.deepEqual((world.recorded.get(3) ?? []).map(event => event.kind), ['intent', 'intent', 'trial', 'pushed', 'reconciled'], 'the stale trial is discarded, never judged against the third, and the third re-trialled');
  assert.deepEqual(world.recorded.get(3)!.filter(event => event.kind === 'intent').map(event => event.kind === 'intent' && event.baseTip), [m2, m1]);
  // The next cycle settles the stack: the two deliveries, the refusal and the rework it grounds.
  await runCycle(config, state, effects, () => start + 60_000);
  assert.deepEqual(state.mergeWriter.refusals.map(entry => entry.key), ['GY-2']);
  assert.deepEqual(reworked, ['GY-2'], 'the failing head returns to a worker');
});
