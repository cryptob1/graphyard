import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { daemonStateSchema, emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { advisoryActionKey, advisoryChore, advisoryIdle, advisoryKeptDue, advisoryKeptRuns, advisoryKeptUnfiled, mergeWriterIdle, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { workerHarnessPlan } from '../src/master/harness.js';
import type { MergeRecordEvent } from '../src/merge-writer/executor.js';
import { systemInvariants } from '../src/model/invariants.js';
import type { MergeLedgerState } from '../src/model/merge-ledger.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';

/**
 * GY-1528: the control-plane switches over a simulated day of the real loop's cycles, in the real
 * step order. Items are submitted every quarter hour, each with a standing scope request, and the
 * merge writer delivers them one at a time. After each merge the advisory budget tests run once on
 * its merge commit: some fail (each failing test files one chore), some cannot run at all, one run
 * hangs until the loop restarts, the loop restarts at other points too (its state read back from
 * JSON, every in-memory run lost), the chore route refuses some first attempts, and the merger read
 * fails for stretches. The loop must run every delivered merge's advisory tests, file each failing
 * (merge, test) chore exactly once and never revert, never decide, widen or re-plan a scope request,
 * install no scope-guard hook, keep its state bounded, and hold every system invariant
 * docs/master-agent.md#system-invariants names.
 */
const minute = 60_000;
const start = Date.parse('2030-05-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy', retrials: 3 } } });
const githubDouble = new Proxy({}, { get: (_, name) => { throw new Error(`a control-plane cycle called GitHub (${String(name)})`); } });
const docs = fileURLToPath(new URL('../docs/master-agent.md', import.meta.url));

/** The day's script, by item ordinal and cycle. */
const items = 80, submitEveryMs = 15 * minute, cycleMs = 2 * minute, cycles = (24 * 60) / 2;
const advisoryFails = (n: number) => n % 7 === 0;
const advisoryCannotRun = (n: number) => n % 13 === 0 && !advisoryFails(n);
const advisoryHangs = (n: number) => n === 30;
const choreRouteRefusesFirst = (n: number) => n % 14 === 0;
const mergerUnreadable = (cycle: number) => cycle > 0 && cycle % 50 < 2;
const restartAt = (cycle: number) => cycle === 300 || cycle === 501;
const failing = ['tests/hotspots.test.ts', 'tests/module-budgets.test.ts'];

class World {
  main = [sha('base')];
  pushes: string[] = [];
  recorded = new Map<number, MergeRecordEvent[]>();
  submitted = new Map<number, number>();
  merges = new Map<string, number>();
  advisoryRuns = new Map<string, number>();
  chores = new Map<string, string>();
  choreAttempts = new Map<string, number>();
  scopeCalls: string[] = [];
  hanging = false; hung = false; cycle = 0;
  constructor(readonly now: () => number) {}
  head(n: number) { return sha(`head${n}`); }
  snapshot(): Work[] {
    const now = this.now();
    return [...this.submitted].filter(([, at]) => at <= now).map(([n, submittedAt]) => {
      let ledger = null as MergeLedgerState | null;
      for (const event of this.recorded.get(n) ?? []) {
        if (event.kind === 'intent') ledger = { key: `GY-${n}`, state: 'intent', head: event.head, baseTip: event.baseTip, mergeSha: event.mergeSha, risk: event.risk, intentAt: event.at, pushedAt: null, observedTip: null, refusal: null, events: (ledger?.events ?? 0) + 1 };
        else if (event.kind === 'pushed' && ledger) ledger = { ...ledger, state: 'pushed', pushedAt: event.pushedAt, events: ledger.events + 1 };
        else if (event.kind === 'reconciled' && ledger) ledger = { ...ledger, state: 'reconciled', observedTip: event.observedTip, events: ledger.events + 1 };
      }
      const delivered = ledger?.state === 'reconciled';
      const candidate = { sha: this.head(n), baseSha: sha('base'), pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' };
      return {
        id: `w${n}`, key: `GY-${n}`, description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
        policy: { checks: ['test'], review: true }, plannedFiles: ['src/app.ts'], revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(submittedAt),
        ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: n }, candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [], mergeLedger: ledger,
        // A standing scope request for a file outside plannedFiles: under the control plane nothing decides, widens or re-plans it.
        scopeRequest: { epoch: 1, at: iso(submittedAt), paths: ['src/other.ts'], requestedBy: 'worker', reason: 'needs it' },
        observation: { source: 'control-plane', candidate, files: ['src/app.ts', 'src/other.ts'], checks: [], reviews: [], merged: delivered, mergeSha: delivered ? ledger!.mergeSha : null, mergeable: true, protected: false, baseTip: this.main[0], baseTipContained: true, at: iso(now) },
        gates: ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: name === 'build' || name === 'ready' || name === 'review', reasons: [] })),
        ...(delivered ? { stage: 'done', delivery: { mergedAt: ledger!.pushedAt ?? iso(now), mergeSha: ledger!.mergeSha!, authorizationRevision: 1 } } : { stage: 'build' }),
      } as unknown as Work;
    });
  }
  ports(): MergeWriterReads {
    const world = this;
    return {
      baseBranch: 'main', retrials: 3, now: this.now,
      merger: async () => { if (mergerUnreadable(world.cycle)) throw new Error('status: HTTP 503'); return 'control-plane'; },
      fetch: async () => world.main[0]!,
      merge: async (head, baseTip) => { const mergeSha = sha(`merge:${head}:${baseTip}`); world.merges.set(mergeSha, Number([...world.submitted.keys()].find(n => world.head(n) === head))); return { mergeSha, files: ['src/app.ts', 'src/other.ts'] }; },
      trial: async (mergeSha) => ({ build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1000, logTail: mergeSha, files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } }),
      push: async (mergeSha, baseTip) => { if (baseTip !== world.main[0]) return 'rejected'; world.main.unshift(mergeSha); world.pushes.push(mergeSha); return 'pushed'; },
      holds: async mergeSha => world.main.includes(mergeSha),
      record: async (item, event) => { const n = Number(item.key.slice(3)); world.recorded.set(n, [...(world.recorded.get(n) ?? []), event]); },
      advisory: async mergeSha => {
        const n = world.merges.get(mergeSha)!, runs = (world.advisoryRuns.get(mergeSha) ?? 0) + 1;
        world.advisoryRuns.set(mergeSha, runs);
        if (advisoryHangs(n) && runs === 1) { world.hanging = true; world.hung = true; return new Promise(() => {}); }
        await new Promise(resolve => setTimeout(resolve, 1));
        if (advisoryCannotRun(n)) throw new Error('the advisory trial checkout could not be made');
        return { build: 'pass', failed: advisoryFails(n) ? [...failing, 'scripts/ci-tests.mjs advisory'] : [] };
      },
    };
  }
  /** The work route: idempotent per key, as the coordinator's is; some first attempts refused. */
  fileChore = async (input: { title: string; type: string }, key: string) => {
    const attempts = (this.choreAttempts.get(key) ?? 0) + 1;
    this.choreAttempts.set(key, attempts);
    const n = this.merges.get(key.split(':')[1]!)!;
    if (choreRouteRefusesFirst(n) && attempts === 1) throw new Error('work: route down (HTTP 503)');
    assert.equal(input.type, 'chore');
    if (!this.chores.has(key)) this.chores.set(key, `GY-${1000 + this.chores.size}`);
    return { key: this.chores.get(key)! } as Work;
  };
}

test('unit:scope-switches-control-plane — a simulated day on the real loop under the control-plane merger: every delivered merge gets its advisory run, each failing (merge, test) files exactly one chore through restarts, hung runs, refused filings and unreadable merger stretches, nothing is reverted, no scope request is decided, widened or re-planned, no scope-guard hook is installed, state stays bounded, and every system invariant docs/master-agent.md names holds', { timeout: 300_000 }, async () => {
  let now = start;
  const world = new World(() => now);
  for (let n = 1; n <= items; n++) world.submitted.set(n, start + n * submitEveryMs);
  const scopeSpy = (name: string) => async () => { world.scopeCalls.push(name); throw new Error(`${name} must not run under the control plane`); };
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: world.snapshot(), now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, decisions: async () => ({ decisions: [] }), persist: async () => {},
    github: githubDouble, merge: githubDouble, shadow: null, mergeWriter: world.ports(), fileFaultClass: world.fileChore,
    decide: scopeSpy('decide'), decideScope: scopeSpy('decideScope'), widenScope: scopeSpy('widenScope'), replan: scopeSpy('replan'), baseSuccessions: scopeSpy('baseSuccessions') } as unknown as DaemonEffects;
  let state: DaemonState = emptyDaemonState(config);
  const invariantNames = new Set<string>();
  let restarts = 0;
  for (let cycle = 0; cycle < cycles; cycle++) {
    now = start + cycle * cycleMs; world.cycle = cycle;
    // A restart: the persisted state comes back through JSON; every run and merge in this process's memory is gone.
    if (restartAt(cycle) || world.hanging) { state = daemonStateSchema.parse(JSON.parse(JSON.stringify(state))); world.hanging = false; restarts += 1; }
    await runCycle(config, state, effects, () => now);
    await mergeWriterIdle(state);
    if (!world.hanging) await advisoryIdle(state);
    const advisory = state.mergeWriter.advisory;
    assert.ok(!advisory || (advisory.due.length <= advisoryKeptDue && advisory.ran.length <= advisoryKeptRuns && advisory.unfiled.length <= advisoryKeptUnfiled), `cycle ${cycle}: the advisory state is bounded`);
    for (const check of state.invariants.report) { invariantNames.add(check.invariant); assert.ok(check.holds, `cycle ${cycle}: invariant ${check.invariant} is violated: ${check.line}`); }
    if (cycle % 60 === 0) for (const item of world.snapshot()) assert.equal(workerHarnessPlan({ cliPath: '/bin/graphyard', branch: `graphyard/${item.key.toLowerCase()}-1`, baseBranch: 'main', credentialHome: '/creds', key: item.key, epoch: 1, mergeWriter: 'control-plane' }).hooks, undefined, `${item.key}: no scope-guard hook`);
  }
  // Settle what the last cycles left owed.
  for (let extra = 0; extra < 5; extra++) { now += cycleMs; world.cycle = cycles + extra; await runCycle(config, state, effects, () => now); await mergeWriterIdle(state); await advisoryIdle(state); }

  assert.ok(world.hung && restarts >= 3, 'the hung run and the scripted restarts happened');
  assert.deepEqual(world.scopeCalls, [], 'no scope request was decided, widened or re-planned, the unreadable merger stretches included');
  const final = world.snapshot();
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => item.key), [], 'every item is delivered');
  assert.equal(new Set(world.pushes).size, items, 'each merge commit pushed once');
  // Every delivered merge had its advisory run at least once; only an interrupted run is run again.
  for (const mergeSha of world.pushes) {
    const runs = world.advisoryRuns.get(mergeSha) ?? 0, n = world.merges.get(mergeSha)!;
    assert.ok(runs >= 1, `GY-${n}: the advisory tests ran on ${mergeSha.slice(0, 12)}`);
    assert.ok(runs <= 2, `GY-${n}: ran ${runs} times; only a restart reruns one`);
    if (advisoryHangs(n)) assert.equal(runs, 2, 'the hung run ran again after the restart');
  }
  // Exactly one chore per failing (merge, test), whatever the restarts and refused filings; none for a run that could not run.
  const expected = world.pushes.filter(mergeSha => advisoryFails(world.merges.get(mergeSha)!)).flatMap(mergeSha => failing.map(test => `advisory-test:${mergeSha}:${test}`)).sort();
  assert.ok(expected.length > 0);
  assert.deepEqual([...world.chores.keys()].sort(), expected, 'each failing (merge, test) filed one chore');
  for (const key of expected) {
    const [, mergeSha, test] = key.split(':');
    assert.equal(state.actions[advisoryActionKey(mergeSha!, test!)]?.state, 'done', `${key} recorded filed`);
    assert.equal(advisoryChore(test!, mergeSha!, `GY-${world.merges.get(mergeSha!)}`).type, 'chore');
  }
  assert.ok(expected.some(key => (world.choreAttempts.get(key) ?? 0) > 1), 'a refused filing was retried');
  assert.ok(world.pushes.some(mergeSha => advisoryCannotRun(world.merges.get(mergeSha)!) && state.actions[`merge-writer-advisory:${mergeSha}`]?.state === 'failed'), 'a run that could not run is recorded, never filed or reverted');
  assert.ok(![...world.recorded.values()].flat().some(event => (event as { kind: string }).kind === 'revert'), 'nothing is reverted');
  assert.deepEqual(state.mergeWriter.advisory?.due, [], 'nothing is still owed');
  assert.deepEqual(state.mergeWriter.advisory?.unfiled, [], 'nothing is left unfiled');
  // The state round-trips, and every invariant the guide names was judged.
  assert.deepEqual(daemonStateSchema.parse(JSON.parse(JSON.stringify(state))).mergeWriter, state.mergeWriter);
  const guide = readFileSync(docs, 'utf8');
  const section = guide.slice(guide.indexOf('### System invariants'), guide.indexOf('## Research and diagnosis'));
  for (const invariant of systemInvariants) { assert.ok(section.includes(`\`${invariant}\``), `docs/master-agent.md#system-invariants names ${invariant}`); assert.ok(invariantNames.has(invariant), `${invariant} was judged over the day`); }
});
