import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { processJob, type GitHub } from '../src/github.js';
import { checkRerunLimit } from '../src/merge-queue.js';
import { failedTestsMarker } from '../src/master/base-break-refresh.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { recordLegacyMerger } from './helpers/legacy-merger.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { baseFailureReason } from '../src/merge-writer/executor.js';
import type { MainGuardRevert } from '../src/main-guard.js';
import type { Observation, Principal, Work } from '../src/model.js';

// GY-1834. A day of five-minute loop cycles over the base failures the merge writer and the main
// guard prove. Four items are held 'base failure' on every cycle's new base tip — the same tests for
// a third of the day, then other tests on new heads, then a wider set — and a delivered item's revert
// was abandoned because main fails the tests its own CI failed, until main passes again. The loop
// files one P0 item per failure at once, never a second one for a failure re-held on a newer tip or
// by another item, sends nothing to rework, and keeps no record of a failure no item shows any more.

const start = Date.parse('2030-03-01T00:00:00Z'), interval = 5 * 60_000, cycles = 24 * 60 / 5, third = cycles / 3;
const iso = (at: number) => new Date(at).toISOString();
const sha = (n: number) => n.toString(16).padStart(40, 'a');
const sets = [['tests/locked-read.test.ts › unit:reconcile-lock-hold-bounded — bounded'], ['tests/fleet.test.ts › unit:fleet-panel-renders — renders'],
  ['tests/locked-read.test.ts › unit:reconcile-lock-hold-bounded — bounded', 'tests/queue.test.ts › unit:queue-carry-keeps — keeps']];
const mainTests = ['tests/docs.test.ts › unit:docs-budget-holds — holds'];

function item(n: number, fields: Record<string, unknown>): Work {
  return { id: `id-${n}`, key: `GY-${n}`, title: `Item ${n}`, description: '', type: 'feature', priority: 1, dependencies: [], plannedFiles: ['src/app.ts'],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }], policy: { checks: ['test'], review: true }, ready: true, epoch: 1, lease: null,
    revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(start), workspaces: [], submission: { epoch: 1, pr: n },
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], gates: [], ...fields } as unknown as Work;
}

test('unit:soak-base-failure-attribution — over a day of loop cycles each base failure the merge writer or the main guard proved files one P0 item at once, none is sent to rework, and no record outlives its failure', async () => {
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  const state = emptyDaemonState(config);
  const held = [1, 2, 3, 4].map(n => item(n, { stage: 'test' }));
  const revert: MainGuardRevert = { mergeSha: sha(9_000), pr: 90, failing: ['test'], revert: { pr: 91, head: sha(9_001) }, state: 'abandoned', at: iso(start), settledAt: iso(start),
    revertSha: null, reason: 'main fails the same tests', cause: 'base-failure', baseFailure: { shared: [{ check: 'test', tests: mainTests, run: 300, revertRun: 400 }], cleared: null } };
  const delivered = item(5, { stage: 'done', delivery: { mergedAt: iso(start), mergeSha: sha(9_000), authorizationRevision: 1 }, mainGuardReverts: [revert] });
  const work: Work[] = [...held, delivered];
  const byKey = new Map<string, string>(), filed: string[] = [];
  let now = start, largest = 0;
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work, now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async () => { throw new Error('the soak decides nothing: a base failure requests no rework'); }, decisions: async () => ({ decisions: [] }),
    persist: async () => {},
    // The coordinator answers a retried key with the item it filed under it.
    fileBaseFailure: async (input: { title: string }, key: string) => {
      if (!byKey.has(key)) { filed.push(input.title); byKey.set(key, `GY-${800 + filed.length}`); }
      return { key: byKey.get(key)! } as Work;
    },
  } as unknown as DaemonEffects;

  for (let n = 0; n < cycles; n++) {
    now = start + n * interval;
    const phase = Math.floor(n / third), tip = sha(1_000 + n);
    for (const [index, entry] of held.entries()) {
      // Each phase is a new head of each item; within it, the head is held again on every new tip.
      const head = sha(100 * (phase + 1) + index);
      entry.candidate = { sha: head, baseSha: tip, pr: index + 1, branch: `graphyard/gy-${index + 1}-1`, author: 'implementer' };
      entry.mergeLedger = { key: entry.key, state: 'refused', head, baseTip: tip, mergeSha: sha(5_000 + n), risk: 'medium', intentAt: iso(now - 60_000), pushedAt: null, observedTip: null,
        refusal: { kind: 'merge', reason: baseFailureReason({ tip, files: ['tests/some.test.ts'], tests: sets[phase]! }) }, events: n + 1 };
    }
    // Main passes again in the last third: the guard clears the shared failure.
    if (phase === 2) revert.baseFailure!.cleared ??= { at: iso(now), sha: tip };
    await runCycle(config, state, effects, () => now);
    largest = Math.max(largest, Object.keys(state.baseFailures).length);
  }

  assert.deepEqual([...filed].sort(), [
    `Base branch main fails trial test: ${sets[0]![0]}`,
    `Base branch main fails test test: ${mainTests[0]}`,
    `Base branch main fails trial test: ${sets[1]![0]}`,
    `Base branch main fails trial test: ${sets[2]!.join(', ')}`,
  ].sort(), 'one P0 item per failure: re-held on newer tips and by other items it names the item already filed');
  assert.equal(filed.length, 4);
  assert.ok(largest <= held.length + 1, `one record per held head and per shared main failure, never more (largest ${largest})`);
  assert.deepEqual(Object.keys(state.baseFailures).filter(key => key.startsWith('main-guard:')), [], 'the cleared main failure leaves no record');
  assert.equal(Object.keys(state.baseFailures).filter(key => key.startsWith('trial:')).length, held.length, 'only the failures the items still show are kept');
  assert.ok(held.every(entry => !entry.reworkRequested), 'nothing is sent to rework');
});

// GY-1834 under GitHub delivery: a day of hourly heads pushed to one pull request, each observed by
// the GitHub job every five minutes with its required check failed. Three heads in four fail one of
// the item's criterion proofs; every fourth fails only a shared test. The proof-aware decision runs
// on each head's owed rerun: a proof failure is never rerun and stands as the head's at once, its
// failed tests read once, and the repeated job on the same head adds nothing; a shared failure is
// rerun exactly once. The job requests no rework itself and the rerun record stays in its bound.
let database: EmbeddedPostgres | null = null, store: Store | null = null;
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

test('unit:soak-base-failure-attribution — over a day of hourly heads whose required check fails, a head that failed a criterion proof is never rerun and stays held without churn on every observation, while a shared failure is rerun once per head', async () => {
  const port = Number(process.env.GRAPHYARD_SOAK_ATTRIBUTION_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1835);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('soak-base-failure-attribution'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  const db = store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await db.init(); await recordLegacyMerger(db);
  const engine = new Engine(db, [15368], 120, 'owner/project'); engine.controlPlaneAppId = 1234;
  const operator: Principal = { id: 'operator', role: 'admin' }, worker: Principal = { id: 'agent-a', role: 'worker' };
  const proof = 'unit:item-works', proofFailure = [`tests/item-works.test.ts › ${proof} — works`], shared = ['tests/locked-read.test.ts › unit:reconcile-lock-hold-bounded — bounded'];
  let work = await engine.execute(operator, 'create', null, { title: 'Held head', plannedFiles: ['src/app.ts'], criteria: [{ id: 'AC-1', text: 'Works', proofs: [proof] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/soak-attribution/${work.id}`, branch: 'graphyard/gy-1-1' }, randomUUID());
  work = await engine.execute(worker, 'submit', work.id, { epoch: 1, pr: 1834 }, randomUUID());
  const id = work.id, branch = work.workspaces[0].branch;

  const heads = 24, perHead = 60 / 5;
  const reruns: number[] = [], reads: number[] = [];
  let candidate = { sha: sha(0), baseSha: sha(1) }, runId = 0, failing = proofFailure, now = start;
  const seen = (): Observation => ({ clockOffset: { min: 0, max: 0 }, candidate: { ...candidate, pr: 1834, branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'failure', appId: 15368, id: runId }], reviews: [{ id: runId, reviewer: 'graphyard-reviewer[bot]', sha: candidate.sha, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha(2), baseTipContained: true, files: ['src/app.ts'], scopeFiles: [], at: iso(now) } as Observation);
  const github = { observe: async () => seen(), rerunFailedJobs: async (job: number) => { reruns.push(job); return { runId: job + 1_000_000 }; },
    checkRunAnnotations: async (job: number) => { reads.push(job); return [{ message: `${failedTestsMarker}${JSON.stringify({ failed: failing })}` }]; },
    requestCodex: async () => { throw new Error('no review request expected'); }, publish: async () => {} } as unknown as GitHub;
  const expected = { refused: 0, rerun: 0 };

  for (let h = 0; h < heads; h++) {
    // A new head, its own failed check run; every fourth fails only the shared test.
    candidate = { sha: sha(10_000 + h), baseSha: sha(1) }; runId = 5_000 + h;
    const ownProof = h % 4 !== 3; failing = ownProof ? proofFailure : shared;
    if (ownProof) expected.refused += 1; else expected.rerun += 1;
    let settled: string | null = null;
    for (let n = 0; n < perHead; n++) {
      now = start + (h * perHead + n) * interval;
      await db.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [id]);
      await processJob(engine, github);
      const current = (await db.list()).find(entry => entry.id === id)!;
      const entry = current.checkReruns!.find(rerun => rerun.sha === candidate.sha);
      assert.ok(entry, `head ${h}: its failed check is recorded once`);
      assert.equal(current.checkReruns!.filter(rerun => rerun.sha === candidate.sha).length, 1, `head ${h}: one rerun record however often it is observed`);
      assert.ok(current.checkReruns!.length <= checkRerunLimit, 'the rerun record stays in its bound');
      assert.equal(current.reworkRequested, false, 'the job never requests rework itself');
      assert.equal(current.gates.find(gate => gate.name === 'test')?.passed, false, `head ${h}: held by its failed check`);
      const state = `${entry!.state}:${entry!.detail ?? ''}`;
      if (settled) assert.equal(state, settled, `head ${h}: its settled rerun record never churns on a later observation`);
      else if (entry!.state !== 'owed') settled = state;
      if (ownProof) assert.match(state, /^refused:.*criterion proof tests\/item-works\.test\.ts › unit:item-works/, `head ${h}: a proof failure stands as the head's at once`);
    }
  }
  assert.equal(reruns.length, expected.rerun, 'only the shared failures are rerun, once per head');
  assert.ok(reruns.every(job => (job - 5_000) % 4 === 3), 'never the run of a head that failed a proof');
  assert.equal(reads.filter(job => (job - 5_000) % 4 !== 3).length, expected.refused, 'a proof-failing head\'s failed tests are read once');
});
