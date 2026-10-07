import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import { actionExecution, actionIdleSpans, claimWindow, coordinatorFingerprints, deliveryActions, deployedRevision as revisionOf, loopThroughputMeasurement, measureThroughput, populationRule, recordThroughputMeasurement, throughputStatus, type LoopThroughputOutcome, readThroughputMeasurement, renderThroughput, throughputClaim, throughputClaimVisibility, throughputMeasurementCommand, throughputMeasurementDirectory, unrealReasons, verifyThroughput, type DeployedRelease, type ThroughputReport } from '../src/throughput.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { actionRetryDelay } from '../src/model/actions.js';
import { emptyDaemonState, runCycle, writeDaemonState, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// @ts-expect-error Dependency-free measurement script.
import { claimContainment, main as measureMain, parseArguments } from '../scripts/measure-throughput.mjs';

/**
 * GY-99: post-deploy verification of GY-87's throughput claim.
 *
 * GY-87 demonstrated its claim over a simulated fleet. This says what the deployed release does
 * over real deliveries, and each test is named for the proof it produces:
 * integration:live-throughput-population (AC-2, and the measurement AC-1 and AC-3 are read from)
 * and unit:throughput-claim-visible (AC-4). manual:throughput-without-master-live and
 * manual:throughput-shortfall-recorded are producer sessions against the live control plane; the
 * measurement script they run is exercised here end to end, against a server serving documents
 * this test's engine really wrote.
 *
 * Nothing here relaxes a budget: every threshold comes from `throughputClaim`, and the cases below
 * assert that a miss stays a miss — reported as a finding with the measured values and a follow-up
 * naming what missed and by how much.
 */

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker' };
const executorA: Principal = { id: 'executor-a', role: 'coordinator' };
const executorB: Principal = { id: 'executor-b', role: 'coordinator' };
const launcher = join(fileURLToPath(new URL('..', import.meta.url)), 'bin/graphyard.mjs');
const commit = (label: string) => createHash('sha1').update(label).digest('hex');
const deployedRevision = commit('deployed-release');
const minute = 60_000;

let database: EmbeddedPostgres, store: Store, engine: Engine;
let pr = 900;
before(async () => {
  const port = Number(process.env.GRAPHYARD_LIVE_THROUGHPUT_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 97);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('live-throughput'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.submissionObserver = null;
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const reload = async (item: Work) => (await store.list()).find(entry => entry.id === item.id)!;
const patch = (item: Work, document: Record<string, unknown>) => store.pool.query('UPDATE work_items SET document=document||$2::jsonb WHERE id=$1', [item.id, JSON.stringify(document)]);
const criteria = [{ id: 'AC-1', text: 'Throughput', proofs: ['integration:live-throughput-population'] }];

async function ready(title: string) {
  const created = await engine.execute(operator, 'create', null, { title, plannedFiles: ['src/throughput.ts'], criteria }, randomUUID());
  return engine.execute(operator, 'ready', created.id, {}, randomUUID());
}

/**
 * One stateless executor, run the way `src/auto-dispatch.ts` runs it: ask the control plane for a
 * row it may take for this item, run it, report the result. No snapshot, no cursor, no master.
 */
async function runQueue(item: Work, executor: Principal, host: string) {
  const ran: string[] = [];
  for (let step = 0; step < 4; step++) {
    await engine.reconcile();
    const claimed = await engine.claimNextAction(executor, { host, work: item.id }, randomUUID());
    if (!claimed.action) break;
    await engine.settleClaimedAction(executor, claimed.action.id, { result: 'done', reason: `${claimed.action.kind} run by ${executor.id} on ${host}` }, randomUUID());
    ran.push(claimed.action.kind);
  }
  return ran;
}

/** Push every instant of this item's open action rows back, so a real claim records a real wait. */
async function backdateQueue(item: Work, ms: number) {
  const queue = structuredClone((await reload(item)).actionQueue!);
  const back = (at: string) => new Date(Date.parse(at) - ms).toISOString();
  for (const row of queue.actions) { row.requestedAt = back(row.requestedAt); for (const record of row.history) record.at = back(record.at); }
  await patch(item, { actionQueue: queue });
}

/** The provider's merge fact, the one instant in a delivery the control plane never sets itself. */
async function deliver(item: Work, submitToMergeMs: number, extra: Record<string, unknown> = {}) {
  const current = await reload(item);
  const mergedAt = new Date(Date.parse(current.pipeline!.submittedAt!) + submitToMergeMs).toISOString();
  await patch(item, { stage: 'done', delivery: { mergedAt, mergedAtRepository: mergedAt, mergeSha: commit(item.key), authorizationRevision: 1, ...extra } });
  return reload(item);
}

/** A delivery driven end to end by executors: a dispatch row run, a submission, a review row run. */
async function executorDelivery(title: string, submitToMergeMs: number, options: { idleMs?: number } = {}) {
  let item = await ready(title);
  await engine.reconcile();
  if (options.idleMs) await backdateQueue(item, options.idleMs);
  await runQueue(item, executorA, 'host-1');
  item = await engine.execute(implementer, 'claim', item.id, {}, randomUUID());
  item = await engine.execute(implementer, 'workspace', item.id, { epoch: item.epoch, host: 'machine-a', path: `/tmp/throughput/${item.id}`, branch: `graphyard/${item.key.toLowerCase()}-1` }, randomUUID());
  item = await engine.execute(implementer, 'submit', item.id, { epoch: item.epoch, pr: ++pr }, randomUUID());
  await runQueue(item, executorB, 'host-2');
  return deliver(item, submitToMergeMs);
}

/** A settled delivery as the default snapshot and the coordination view carry it: no histories, no sessions, no timeline. */
const summary = (item: Work) => item.stage === 'done' ? { id: item.id, key: item.key, title: item.title, stage: item.stage, delivery: item.delivery, updatedAt: item.updatedAt, summary: true } as unknown as Work : item;

const release = (overrides: Partial<DeployedRelease> = {}): DeployedRelease =>
  ({ revision: deployedRevision, version: '0.9.1', origin: 'https://graphyard.example', observedAt: new Date().toISOString(), containsClaim: true, reason: null, ...overrides });

test('integration:live-throughput-population — the population rule reads the real ledger: every delivery in the window is named with the executor that claimed each of its actions, a delivery a coordinator was present for is excluded with the reason and still reported with its figures, and the claim is judged against its own budgets', async () => {
  // The claim's own delivery, with the deployment observation that says when a release carrying it
  // began serving. That instant, not its merge, is where a measurement of that release can start.
  const windowStart = new Date(Date.now() - 60 * minute).toISOString();
  let claimItem = await executorDelivery('The inverted loop', 5 * minute);
  await patch(claimItem, { delivery: { ...(await reload(claimItem)).delivery, mergedAt: new Date(Date.now() - 120 * minute).toISOString(), mergedAtRepository: new Date(Date.now() - 120 * minute).toISOString(),
    deployment: { sha: deployedRevision, mergeSha: commit(claimItem.key), source: 'endpoint', observedAt: windowStart, covers: 'exact', at: windowStart, observer: 'coordinator-1' } } });
  claimItem = await reload(claimItem);
  const claimKey = claimItem.key;

  // Ten routine deliveries, each driven through the queue by a stateless executor on its own host.
  const fast: Work[] = [];
  for (let index = 0; index < 10; index++) fast.push(await executorDelivery(`Routine delivery ${index}`, (12 + index * 2) * minute));

  // Two deliveries a coordinator was present for. The first had its dispatch row superseded before
  // any executor ran it — the queue's own record of something outside it moving the item on; the
  // second was handed to a master by a blocked report. Both are real deliveries; neither is
  // evidence about a pipeline with no master session.
  let handRun = await ready('Dispatched by hand');
  await engine.reconcile();
  await backdateQueue(handRun, 20 * minute);
  handRun = await engine.execute(implementer, 'claim', handRun.id, {}, randomUUID());
  handRun = await engine.execute(implementer, 'workspace', handRun.id, { epoch: handRun.epoch, host: 'machine-a', path: `/tmp/throughput/${handRun.id}`, branch: `graphyard/${handRun.key.toLowerCase()}-1` }, randomUUID());
  await engine.reconcile();
  handRun = await engine.execute(implementer, 'submit', handRun.id, { epoch: handRun.epoch, pr: ++pr }, randomUUID());
  await runQueue(handRun, executorA, 'host-1');
  handRun = await deliver(handRun, 24 * minute);
  const handRunRow = (await reload(handRun)).actionQueue!.history.find(row => row.kind === 'dispatch');
  assert.ok(handRunRow?.history.some(record => record.event === 'cancelled'), 'the dispatch row really was superseded before an executor ran it');

  let blocked = await executorDelivery('Blocked and cleared', 18 * minute);
  await patch(blocked, { pipeline: { ...(await reload(blocked)).pipeline, interventions: { blocked: 1, requirements: 0 } } });
  blocked = await reload(blocked);

  // And one that went round three times: a real delivery, reported with its figures, but not one
  // of the routine deliveries the claim is stated over.
  let reworked = await executorDelivery('Three rounds', 55 * minute);
  await patch(reworked, { pipeline: { ...(await reload(reworked)).pipeline, reworkRounds: 2 } });
  reworked = await reload(reworked);

  const work = await store.list();
  const now = Date.now();
  const report = verifyThroughput(work, now, { deployed: release(), claimKey });

  // AC-2: the window, the population rule, every delivery counted, and the executor that claimed
  // each of its actions — all in the report, so a reader checks rather than trusts it.
  assert.equal(report.window.basis, 'deployment-observation');
  assert.equal(report.window.since, windowStart);
  assert.match(report.window.reason, new RegExp(`${claimKey} was observed serving`));
  assert.equal(report.population.rule, populationRule);
  assert.deepEqual(report.deliveries.map(entry => entry.key), fast.map(item => item.key), 'the ten executor-driven deliveries are the population, in merge order');
  for (const entry of report.deliveries) {
    assert.ok(entry.actions.length, `${entry.key} names the actions it needed`);
    assert.deepEqual(entry.executors, [executorA.id, executorB.id], `${entry.key} names the executor that claimed each action`);
    assert.ok(entry.actions.every(action => !action.executor || /^host-[12]$/.test(action.host!)), 'and the host each ran on');
    assert.ok(entry.pr && entry.mergeSha, `${entry.key} points at a real merged pull request`);
  }
  // The excluded deliveries are reported too — with their own figures, so an exclusion cannot
  // quietly drop a slow delivery out of the measurement.
  const excluded = Object.fromEntries(report.excluded.map(entry => [entry.key, entry]));
  assert.deepEqual(Object.keys(excluded).sort(), [handRun.key, blocked.key, reworked.key].sort());
  assert.match(excluded[reworked.key].exclusions.join('; '), /it took 2 rework rounds, so it is not one of the routine deliveries/);
  assert.equal(excluded[reworked.key].submitToMergeMs, 55 * minute);
  assert.match(excluded[handRun.key].exclusions.join('; '), /dispatch action was superseded before any executor ran it/);
  assert.equal(excluded[handRun.key].submitToMergeMs, 24 * minute, 'an excluded delivery still carries the figure it measured');
  assert.match(excluded[blocked.key].exclusions.join('; '), /1 blocked report\(s\) handed it to a master or operator/);
  assert.equal(report.population.delivered, 13, 'the claim item merged before the window and is not in it');

  // AC-1: the verdict, over ten deliveries, against the deployed commit the measurement names.
  assert.equal(report.submitToMerge.count, 10);
  assert.equal(report.submitToMerge.p50Ms, 20 * minute);
  assert.ok(report.idle.maxMs !== null && report.idle.maxMs < throughputClaim.idleActionableMs, `the counted deliveries idled ${report.idle.maxMs}ms`);
  assert.equal(report.met, true); assert.equal(report.verdict, 'verified'); assert.equal(report.shortfall, null);
  assert.match(report.reason, new RegExp(`${throughputClaim.item}'s throughput claim holds on the deployed release ${deployedRevision}`));
  // The exclusions flattered the idle figure, and the report says so rather than leaving it to be noticed.
  assert.ok(report.all.idleMaxMs! > throughputClaim.idleActionableMs);
  assert.match(report.populationEffect!, /longest idle-but-actionable wait over all real deliveries in the window is 20 min/);
  assert.match(renderThroughput(report), /Counted:/);
  assert.match(renderThroughput(report), new RegExp(`${fast[0].key} \\(PR \\d+, merged .*\\): submit→merge 12 min`));

  // AC-3: a real delivery that idled past the bound is a miss, and a miss is a finding with the
  // values measured and a follow-up naming what missed and by how much. The budget is not moved
  // and the population is not narrowed: the slow delivery is counted, not excluded.
  const idled = await executorDelivery('Nobody claimed it for twenty minutes', 16 * minute, { idleMs: 20 * minute });
  const withIdle = verifyThroughput([...work, await reload(idled)], now, { deployed: release(), claimKey });
  assert.equal(withIdle.population.admitted, 11, 'the slow delivery is admitted, not excluded');
  assert.equal(withIdle.met, false); assert.equal(withIdle.verdict, 'unverified');
  assert.equal(withIdle.idle.key, idled.key);
  assert.ok(Math.abs(withIdle.idle.maxMs! - 20 * minute) < minute, `the recorded wait was ${withIdle.idle.maxMs}ms`);
  const idleMiss = withIdle.shortfall!.missed.find(entry => entry.metric === 'idle-actionable')!;
  assert.equal(idleMiss.budget, throughputClaim.idleActionableMs);
  assert.ok(idleMiss.by! > 14 * minute, `${idleMiss.text}`);
  assert.match(idleMiss.text, /past the 5 min bound/);
  assert.match(withIdle.shortfall!.finding, /This is a finding about the design of GY-87/);
  assert.match(withIdle.shortfall!.finding, /the budgets stay as GY-87 stated them and the population rule is not narrowed to make them pass/);
  assert.match(withIdle.shortfall!.followUp.description, /What missed, and by how much/);
  assert.match(withIdle.shortfall!.followUp.description, new RegExp(populationRule.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(withIdle.claim.submitToMergeP50Ms, throughputClaim.submitToMergeP50Ms, 'the budgets the report carries are the claim\'s own');

  // Too few deliveries judge nothing, and say how many are missing rather than passing on nine.
  const nine = verifyThroughput([claimItem, ...fast.slice(1), handRun, blocked], now, { deployed: release(), claimKey });
  assert.equal(nine.met, null); assert.equal(nine.verdict, 'unverified');
  assert.match(nine.shortfall!.missed[0].text, /9 of the 10 deliveries the claim is judged over were made with no master session running; 1 more/);
  // A release that does not carry the claim, or that cannot name itself, verifies nothing.
  assert.match(verifyThroughput(work, now, { deployed: release({ containsClaim: false }), claimKey }).reason, /does not contain .* merge, so its executors are not the ones serving/);
  const unchecked = verifyThroughput(work, now, { deployed: release({ containsClaim: null, reason: 'git could not compare the commits' }), claimKey });
  assert.equal(unchecked.met, null); assert.equal(unchecked.verdict, 'unverified');
  assert.match(unchecked.reason, /could not be established: git could not compare the commits/);
  assert.match(verifyThroughput(work, now, { deployed: release({ revision: 'unknown' }), claimKey }).reason, /reports no build revision/);
  assert.equal(verifyThroughput(work, now, { deployed: release({ revision: null }), claimKey }).met, null);
  // An unnamed release over too few deliveries misses on both counts, and the follow-up says both:
  // the release refusal never hides the population shortfall, and an empty population is reported
  // as nothing measured rather than as zero minutes.
  const unnamedEmpty = verifyThroughput([claimItem], now, { deployed: release({ revision: 'unknown', containsClaim: null }), claimKey });
  assert.deepEqual(unnamedEmpty.shortfall!.missed.map(entry => entry.metric), ['deployed-release', 'population']);
  assert.equal(unnamedEmpty.shortfall!.missed[1].by, throughputClaim.minimumDeliveries);
  assert.match(unnamedEmpty.shortfall!.followUp.description, /What missed, and by how much: the deployed release reports no build revision.*; 0 of the 10 deliveries .*; 10 more are needed/);
  assert.match(unnamedEmpty.shortfall!.followUp.description, /submit→merge p50 n\/a \(no deliveries measured\) against 30 min/);
  assert.match(unnamedEmpty.reason, /reports no build revision, so what was measured cannot be named; 0 of the 10 deliveries/);
  assert.doesNotMatch(renderThroughput(unnamedEmpty), /p50 0 min|idle-but-actionable 0 min|measure 0 min/);
  // Beside a slow window, an empty admitted population is said to measure nothing, not zero.
  const emptyBesideSlow = verifyThroughput(work.filter(item => item.key === claimKey || report.excluded.some(entry => entry.work === item.id)), now, { deployed: release(), claimKey });
  assert.equal(emptyBesideSlow.population.admitted, 0);
  assert.match(emptyBesideSlow.populationEffect!, /while the admitted deliveries measure n\/a \(no deliveries measured\)/);
  assert.match(renderThroughput(unnamedEmpty), /Measured: submit→merge p50 n\/a \(no deliveries measured\)/);
  // The deployed commit comes from the deployment: the release stamp first, else the build identity
  // the platform injects (the same `commit` /healthz serves); never a guess.
  assert.deepEqual(revisionOf({ release: { revision: deployedRevision }, build: { commit: commit('other') } }), { revision: deployedRevision, source: 'release.revision' });
  assert.deepEqual(revisionOf({ release: { revision: 'unknown' }, build: { commit: deployedRevision } }), { revision: deployedRevision, source: 'build.commit' });
  assert.deepEqual(revisionOf({ release: { revision: 'unknown' }, build: { commit: null } }), { revision: 'unknown', source: null });
  assert.deepEqual(revisionOf(undefined), { revision: null, source: null });

  // Nothing synthetic reaches the population: the rule refuses anything it cannot point at in the
  // provider, before it ever asks whether a coordinator was present.
  assert.deepEqual(unrealReasons(fast[0]), []);
  assert.deepEqual(unrealReasons({ ...fast[0], delivery: { ...fast[0].delivery!, mergeSha: 'not-a-commit' } } as Work), ['its delivery records no merge commit (not-a-commit)']);
  assert.deepEqual(unrealReasons({ ...fast[0], key: 'fixture-1' } as Work), ['its key fixture-1 is not a work-item key of this repository']);
  assert.deepEqual(unrealReasons({ ...fast[0], implementers: [], workspaces: [] } as unknown as Work), ['no worker ever held it, so nothing implemented it']);
  const stub = { ...fast[0], id: 'stub', key: 'GY-9999', actionQueue: { actions: [], history: [] } } as unknown as Work;
  assert.match(verifyThroughput([...work, stub], now, { deployed: release(), claimKey }).excluded.find(entry => entry.key === 'GY-9999')!.exclusions.join(''), /no executor completed an action on it/);

  // The window without a deployment observation is the claim's merge, named as the weaker basis.
  assert.equal(claimWindow({ key: 'GY-87', stage: 'done', delivery: { mergedAt: windowStart, mergeSha: commit('x'), authorizationRevision: 1 } } as Work).basis, 'merge-instant');
  assert.match(claimWindow(undefined).reason, /is not delivered, so no window/);
  assert.equal(claimWindow(undefined, windowStart).basis, 'given');
  // Deliberate waits are not idleness: a backoff after a failed attempt is subtracted, a settle
  // window never opens a span, and a row still nobody has claimed is still waiting.
  const at = (offset: number) => new Date(Date.parse(windowStart) + offset).toISOString();
  assert.deepEqual(actionIdleSpans({ requestedAt: at(0), state: 'done', history: [
    { at: at(0), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: '' },
    { at: at(2 * minute), event: 'claimed', requester: 'graphyard', executor: 'executor-a', result: null, reason: '' },
    { at: at(3 * minute), event: 'failed', requester: 'graphyard', executor: 'executor-a', result: 'failed', reason: '' },
    { at: at(3 * minute + actionRetryDelay(1) + minute), event: 'claimed', requester: 'graphyard', executor: 'executor-b', result: null, reason: '' },
    { at: at(5 * minute), event: 'completed', requester: 'graphyard', executor: 'executor-b', result: 'done', reason: '' },
  ] }, Date.parse(windowStart) + 60 * minute).map(span => span.ms), [2 * minute, minute], 'the retry backoff is not counted as idleness');
  assert.deepEqual(actionIdleSpans({ requestedAt: at(0), state: 'done', history: [
    { at: at(0), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: '' },
    { at: at(minute), event: 'claimed', requester: 'graphyard', executor: 'executor-a', result: null, reason: '' },
    { at: at(2 * minute), event: 'failed', requester: 'graphyard', executor: 'executor-a', result: 'failed', reason: '' },
    { at: at(2 * minute + actionRetryDelay(1)), event: 'claimed', requester: 'graphyard', executor: 'executor-b', result: null, reason: '' },
    { at: at(3 * minute), event: 'failed', requester: 'graphyard', executor: 'executor-b', result: 'failed', reason: '' },
    { at: at(3 * minute + actionRetryDelay(2)), event: 'claimed', requester: 'graphyard', executor: 'executor-c', result: null, reason: '' },
    { at: at(5 * minute), event: 'completed', requester: 'graphyard', executor: 'executor-c', result: 'done', reason: '' },
    { at: at(15 * minute), event: 'reopened', requester: 'graphyard', executor: null, result: null, reason: '' },
    { at: at(23 * minute), event: 'claimed', requester: 'graphyard', executor: 'executor-d', result: null, reason: '' },
  ] }, Date.parse(windowStart) + 60 * minute).map(span => span.ms), [minute, 0, 0, 8 * minute], 'a reopened row is immediately actionable and inherits no earlier retry delay');
  assert.deepEqual(actionIdleSpans({ requestedAt: at(0), state: 'pending', history: [{ at: at(0), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: '' }] }, Date.parse(windowStart) + 9 * minute).map(span => span.ms), [9 * minute]);
  assert.deepEqual(actionIdleSpans({ requestedAt: at(0), state: 'done', history: [
    { at: at(0), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: '' },
    { at: at(7 * minute), event: 'cancelled', requester: 'graphyard', executor: null, result: null, reason: 'now needs merge instead' },
  ] }, Date.parse(windowStart) + 60 * minute).map(span => span.ms), [7 * minute], 'a row superseded before anybody ran it waited for exactly as long as it stood');
  // And the fingerprints are read from the item, not asserted about it.
  assert.deepEqual(coordinatorFingerprints(fast[0], deliveryActions(fast[0], now)), []);
  assert.match(coordinatorFingerprints({ ...fast[0], sessions: [{ id: 'master-1', kind: 'coordination', host: 'machine-a' }] } as unknown as Work, [])[0], /a coordination session \(master-1 on machine-a\) was recorded on it/);
  const failedThenSuperseded = actionExecution({ id: 'failed-action', kind: 'merge', work: fast[0].id, key: fast[0].key,
    inputs: { kind: 'merge', pr: 1, sha: commit('candidate'), baseSha: commit('base'), policyRevision: 1 },
    gate: 'merge', refusal: null, reason: '', binding: 'merge:1', requestedBy: 'graphyard', requestedAt: at(0), state: 'pending', claim: null, attempts: 1,
    resolvedAt: at(3 * minute), result: 'failed', resolution: 'provider failed', history: [
      { at: at(0), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: '' },
      { at: at(minute), event: 'claimed', requester: 'graphyard', executor: 'executor-a', result: null, reason: 'attempt 1 claimed by executor-a on host-a' },
      { at: at(2 * minute), event: 'failed', requester: 'graphyard', executor: 'executor-a', result: 'failed', reason: 'provider failed' },
      { at: at(3 * minute), event: 'cancelled', requester: 'graphyard', executor: null, result: null, reason: 'now needs another action' },
    ] }, now);
  assert.equal(failedThenSuperseded.supersededUnexecuted, false);
  assert.deepEqual(coordinatorFingerprints(fast[0], [failedThenSuperseded]), [], 'an executor-run action that failed before supersession is not a coordinator fingerprint');

  // The script the producer sessions run, end to end against a server serving these documents.
  assert.deepEqual(parseArguments(['--claim', 'GY-87', '--since', windowStart]).claim, 'GY-87');
  assert.throws(() => parseArguments(['--claim', 'gy-87']), /takes a work-item key/);
  assert.throws(() => parseArguments(['--since', 'yesterday']), /ISO 8601/);
  assert.throws(() => parseArguments(['--nope']), /Unknown argument/);
  assert.deepEqual(claimContainment({ revision: deployedRevision, mergeSha: deployedRevision, claim: 'GY-87', repository: '.' }), { contains: true, reason: null });
  assert.deepEqual(claimContainment({ revision: 'unknown', mergeSha: commit('a'), claim: 'GY-87', repository: '.' }), { contains: null, reason: 'the deployed release reports no build revision' });
  assert.equal(claimContainment({ revision: deployedRevision, mergeSha: commit('a'), claim: 'GY-87', repository: '.' }, () => ({ status: 1, stderr: '' })).contains, false);
  assert.match(claimContainment({ revision: deployedRevision, mergeSha: commit('a'), claim: 'GY-87', repository: '.' }, () => ({ status: 128, stderr: 'bad object\n' })).reason!, /git could not compare .*: bad object/);

  const snapshot = await store.list();
  // The ledger the script reads, with and without the delivery that idled past the bound.
  let ledger = snapshot.filter(item => item.id !== idled.id);
  let statusRelease: object = { release: { version: '0.9.1', revision: deployedRevision } };
  // The default snapshot serves settled deliveries as summaries (GY-422); `GET /api/work/:id` the whole document.
  const asked: string[] = [];
  const served = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.headers.authorization !== 'Bearer reader-token') { response.statusCode = 401; return response.end('{}'); }
    asked.push(request.url!);
    if (request.url === '/api/status') return response.end(JSON.stringify({ actor: { id: 'reader' }, now: new Date(now).toISOString(), ...statusRelease }));
    if (request.url === '/api/work-snapshot') return response.end(JSON.stringify({ now: new Date(now).toISOString(), work: ledger.map(summary), view: 'bounded' }));
    const whole = /^\/api\/work\/([^/]+)$/.exec(request.url!);
    const item = whole && ledger.find(entry => entry.id === decodeURIComponent(whole[1]));
    if (item) return response.end(JSON.stringify(item));
    response.statusCode = 404; response.end('{}');
  });
  await new Promise<void>(resolve => served.listen(0, '127.0.0.1', resolve));
  const directory = await temporaryDirectory('throughput-measure');
  const logged: string[] = []; const log = console.log; const exitCode = process.exitCode;
  try {
    console.log = (line: string) => { logged.push(String(line)); };
    const environment = { GRAPHYARD_URL: `http://127.0.0.1:${(served.address() as any).port}`, GRAPHYARD_TOKEN: 'reader-token' };
    const recorded = await measureMain(['--claim', claimKey, '--record', directory], environment, { run: () => ({ status: 0, stderr: '' }) }) as ThroughputReport & { recorded: string };
    assert.equal(recorded.verdict, 'verified');
    assert.equal(recorded.deployed.revision, deployedRevision, 'the measurement names the deployed commit it observed');
    assert.equal(recorded.deployed.origin, environment.GRAPHYARD_URL);
    assert.equal(recorded.population.admitted, 10, 'the live read counts every executor-driven delivery in the window');
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    assert.deepEqual((JSON.parse(await readFile(join(directory, files[0]), 'utf8')) as ThroughputReport).population, recorded.population);
    assert.match(logged.join('\n'), /throughput claim: VERIFIED/);
    assert.match(logged.join('\n'), /Excluded:/);
    assert.ok(!asked.some(url => url.includes('view=full')), 'the script never asks for the full work snapshot');
    assert.equal(asked.filter(url => url.startsWith('/api/work/')).length, recorded.population.delivered, 'only the window\'s deliveries are read whole');
    ledger = snapshot.filter(item => item.id !== idled.id); logged.length = 0; process.exitCode = undefined;
    const uncheckedRelease = await measureMain(['--claim', claimKey], environment, { run: () => ({ status: 128, stderr: 'bad object' }) }) as ThroughputReport;
    assert.equal(uncheckedRelease.verdict, 'unverified'); assert.equal(uncheckedRelease.met, null); assert.equal(process.exitCode, 2);
    assert.match(uncheckedRelease.reason, /could not be established/);
    // A build that never stamped a release revision is named by the commit its build identity
    // carries, and the report says which field named it.
    statusRelease = { release: { version: '0.0.0-dev', revision: 'unknown' }, build: { commit: deployedRevision, protocol: 2, source: 'RAILWAY_GIT_COMMIT_SHA' } };
    logged.length = 0; process.exitCode = undefined;
    const fromBuild = await measureMain(['--claim', claimKey], environment, { run: () => ({ status: 0, stderr: '' }) }) as ThroughputReport;
    assert.equal(fromBuild.deployed.revision, deployedRevision); assert.equal(fromBuild.deployed.revisionSource, 'build.commit');
    assert.equal(fromBuild.verdict, 'verified');
    assert.match(logged.join('\n'), new RegExp(`Deployed release: ${deployedRevision} \\(from build\\.commit\\)`));
    statusRelease = { release: { version: '0.9.1', revision: deployedRevision } };
    // The same run over a ledger holding the delivery that idled past the bound: the finding and
    // the follow-up are printed, the report is recorded, and the exit status says it missed — a
    // scheduled measurement can never report a shortfall as a quiet success.
    ledger = snapshot; logged.length = 0; process.exitCode = undefined;
    const missed = await measureMain(['--claim', claimKey, '--record', directory], environment, { run: () => ({ status: 0, stderr: '' }) }) as ThroughputReport & { recorded: string };
    assert.equal(missed.verdict, 'unverified'); assert.equal(process.exitCode, 2);
    assert.equal(missed.population.admitted, 11, 'the slow delivery is measured, not dropped');
    assert.ok(missed.shortfall!.missed.some(entry => entry.metric === 'idle-actionable'));
    assert.match(logged.join('\n'), /throughput claim: UNVERIFIED/);
    assert.match(logged.join('\n'), /Finding: .*finding about the design of GY-87/);
    assert.match(logged.join('\n'), /Follow-up: GY-87's throughput claim is unverified against the deployed release/);
    assert.equal(JSON.parse(await readFile(missed.recorded!, 'utf8')).shortfall.missed.length, missed.shortfall!.missed.length, 'the miss is recorded with its values, not discarded');
    await assert.rejects(measureMain([], { ...environment, GRAPHYARD_TOKEN: 'wrong' }), /refused the control-plane status \(401\)/);
    await assert.rejects(measureMain([], { GRAPHYARD_TOKEN: 'reader-token' }), /Set GRAPHYARD_URL/);
    await assert.rejects(measureMain([], { GRAPHYARD_URL: environment.GRAPHYARD_URL }), /Set GRAPHYARD_TOKEN/);
  } finally {
    console.log = log; process.exitCode = exitCode;
    await new Promise<void>(resolve => served.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('unit:throughput-claim-visible — master status carries GY-87\'s throughput claim as verified or unverified against the release now serving, with what missed, so a delivered-but-unproven claim is visible rather than assumed', async () => {
  const root = await temporaryDirectory('throughput-root');
  try {
    execFileSync('git', ['init', '-q', root]);
    const measured: ThroughputReport = { measuredAt: '2026-09-21T12:00:00.000Z', claim: throughputClaim,
      deployed: { revision: deployedRevision, version: '0.9.1', origin: 'https://graphyard.example', observedAt: '2026-09-21T12:00:00.000Z', containsClaim: true, reason: null },
      window: { since: '2026-09-20T00:00:00.000Z', until: null, basis: 'deployment-observation', reason: 'observed serving' },
      population: { rule: populationRule, delivered: 12, real: 12, admitted: 10, excluded: 2 },
      deliveries: [], excluded: [], submitToMerge: { count: 10, p50Ms: 20 * minute, p90Ms: 28 * minute },
      idle: { maxMs: 90_000, key: 'GY-90', action: 'a', kind: 'merge' },
      all: { count: 12, submitToMerge: { count: 12, p50Ms: 22 * minute, p90Ms: 40 * minute }, idleMaxMs: 20 * minute },
      populationEffect: null, met: true, verdict: 'verified', reason: 'GY-87\'s throughput claim holds', shortfall: null };

    // Nothing measured: the claim is unverified and says so, with the command that measures it.
    const never = throughputClaimVisibility(null, { revision: deployedRevision, version: '0.9.1' }, 12);
    assert.equal(never.verdict, 'unverified');
    assert.match(never.reason, /no post-deploy measurement has ever been recorded/);
    assert.match(never.reason, new RegExp(throughputClaim.statement.slice(0, 40)));
    assert.equal(never.attention!.subject, 'throughput');
    assert.equal(never.attention!.next, throughputMeasurementCommand);
    assert.equal(never.command, throughputMeasurementCommand);
    assert.equal(never.claim.submitToMergeP50Ms, 30 * minute, 'the budgets shown are the claim\'s own');
    // An installation that has delivered nothing has nothing to verify, so it raises nothing.
    assert.equal(throughputClaimVisibility(null, { revision: deployedRevision, version: '0.9.1' }, 0).attention, null);

    // Measured against this release, and met: verified, and nothing to act on.
    const verified = throughputClaimVisibility({ report: measured, file: 'f.json' }, { revision: deployedRevision, version: '0.9.1' }, 12);
    assert.equal(verified.verdict, 'verified'); assert.equal(verified.attention, null); assert.equal(verified.shortfall, null);
    assert.deepEqual(verified.measurement, { at: measured.measuredAt, deployedRevision, admitted: 10, submitToMergeP50Ms: 20 * minute, idleMaxMs: 90_000, file: 'f.json' });
    const ancestryUnknown = throughputClaimVisibility({ report: { ...measured, deployed: { ...measured.deployed, containsClaim: null, reason: 'git lacked the object' } }, file: 'f.json' }, { revision: deployedRevision, version: '0.9.1' }, 12);
    assert.equal(ancestryUnknown.verdict, 'unverified'); assert.ok(ancestryUnknown.attention);
    assert.match(ancestryUnknown.reason, /did not establish.*git lacked the object/);

    // Measured against another release: what is serving now is unproven, whatever that measurement said.
    const moved = throughputClaimVisibility({ report: measured, file: 'f.json' }, { revision: commit('next-release'), version: '0.9.2' }, 12);
    assert.equal(moved.verdict, 'unverified');
    assert.match(moved.reason, new RegExp(`the last measurement was taken against ${deployedRevision} at ${measured.measuredAt}; the release now serving is ${commit('next-release').slice(0, 12)}`));
    assert.ok(moved.attention);
    // A release that cannot name itself cannot be matched to a measurement either.
    assert.match(throughputClaimVisibility({ report: measured, file: 'f.json' }, { revision: 'unknown', version: null }, 12).reason, /reports no build revision/);

    // Measured against this release and missed: unverified, carrying the shortfall as measured.
    const shortfall = { measured: { deliveries: 11, submitToMergeP50Ms: 34 * minute, idleMaxMs: 20 * minute },
      missed: [{ metric: 'submit-to-merge-p50' as const, measured: 34 * minute, budget: 30 * minute, by: 4 * minute, text: 'submit→merge p50 34 min exceeds 30 min by 4 min' }],
      finding: 'a finding about the design', followUp: { title: 'unverified', description: 'what missed' } };
    const missed = throughputClaimVisibility({ report: { ...measured, met: false, verdict: 'unverified', reason: 'p50 34 min exceeds 30 min', shortfall }, file: 'f.json' }, { revision: deployedRevision, version: '0.9.1' }, 12);
    assert.equal(missed.verdict, 'unverified');
    assert.deepEqual(missed.shortfall, shortfall, 'the shortfall is carried as measured, not softened');
    assert.match(missed.attention!.text, /p50 34 min exceeds 30 min/);

    // The recorded measurements are read newest-first, and an unreadable file is skipped.
    assert.equal(await readThroughputMeasurement(root), null);
    const directory = join(root, throughputMeasurementDirectory);
    await writeFile(join(root, 'ignored.json'), 'x').catch(() => {});
    execFileSync('mkdir', ['-p', directory]);
    await writeFile(join(directory, '2026-09-20T10-00-00-000Z.json'), JSON.stringify({ ...measured, verdict: 'unverified' }));
    await writeFile(join(directory, '2026-09-21T10-00-00-000Z.json'), JSON.stringify(measured));
    await writeFile(join(directory, '2026-09-22T10-00-00-000Z.json'), 'not json');
    const read = await readThroughputMeasurement(root);
    assert.equal(read!.report.verdict, 'verified');
    assert.equal(read!.file, join(throughputMeasurementDirectory, '2026-09-21T10-00-00-000Z.json'));

    // And `master status` itself carries it, against the revision the control plane reports.
    const credential = join(root, 'coordinator.token');
    await writeFile(credential, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: credential, cliPath: launcher,
      repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
      autoMerge: true, mergeMethod: 'merge', workers: [], run: { proofWorkflow: 'acceptance.yml' } });
    await writeDaemonState(master, emptyDaemonState(master));
    const delivered = { id: 'd', key: 'GY-1', title: 'Delivered', stage: 'done', type: 'chore', priority: 2, ready: true, epoch: 1, revision: 4, policyRevision: 1,
      createdAt: '2026-09-21T08:00:00.000Z', updatedAt: '2026-09-21T09:00:00.000Z', stageEnteredAt: '2026-09-21T09:00:00.000Z',
      policy: { checks: ['test'], review: true }, criteria: [{ id: 'AC-1', text: 'Delivered', proofs: [] }], plannedFiles: [], dependencies: [], description: '',
      lease: null, workspaces: [], candidate: null, submission: { epoch: 1, pr: 11 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null,
      blocker: null, gates: [], violations: [], delivery: { mergedAt: '2026-09-21T09:00:00.000Z', mergeSha: commit('GY-1'), authorizationRevision: 1 } };
    const masterApi = async (path: string) => path === 'work-snapshot' ? { work: [delivered], now: new Date().toISOString() } : { decisions: [] };
    const report = await masterStatusReport(root, master, masterApi, { actor: { id: 'coordinator-1' }, release: { version: '0.9.1', revision: deployedRevision } }, { commit: null });
    assert.equal(report.throughput.verdict, 'verified');
    assert.equal(report.throughput.deployed.revision, deployedRevision);
    assert.ok(!report.attentionItems.some(item => item.subject === 'throughput'), 'a verified claim raises no attention');
    const stale = await masterStatusReport(root, master, masterApi, { actor: { id: 'coordinator-1' }, release: { version: '0.9.2', revision: commit('next-release') } }, { commit: null });
    assert.equal(stale.throughput.verdict, 'unverified');
    const raised = stale.attentionItems.find(item => item.subject === 'throughput')!;
    assert.match(raised.text, /GY-87's throughput claim is unverified against the deployed release/);
    assert.equal(raised.role, 'master'); assert.equal(raised.human, false); assert.equal(raised.next, throughputMeasurementCommand);
    assert.ok(stale.counts.attention > report.counts.attention, 'and it is counted, so an unproven claim is not reported as all clear');
    // A deployment with no release stamp is matched by its build commit, as the measurement names it.
    const unstamped = await masterStatusReport(root, master, masterApi, { actor: { id: 'coordinator-1' }, release: { version: '0.0.0-dev', revision: 'unknown' }, build: { commit: deployedRevision, protocol: 2 } }, { commit: null });
    assert.equal(unstamped.throughput.deployed.revision, deployedRevision);
    assert.equal(unstamped.throughput.verdict, 'verified');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:throughput-bounded-read — the measurement chooses its window from settled-delivery summaries and reads whole only the deliveries in it, never the full work snapshot of every item', async () => {
  // A claim observed serving in a window of its own, so the deliveries other tests made fall outside it.
  const windowStart = '2099-01-01T00:00:00.000Z', at = (minutes: number) => new Date(Date.parse(windowStart) + minutes * minute).toISOString();
  let claimItem = await executorDelivery('The bounded claim', 5 * minute);
  await patch(claimItem, { delivery: { ...(await reload(claimItem)).delivery, mergedAt: at(-120), mergedAtRepository: at(-120),
    deployment: { sha: deployedRevision, mergeSha: commit(claimItem.key), source: 'endpoint', observedAt: windowStart, covers: 'exact', at: windowStart, observer: 'coordinator-1' } } });
  claimItem = await reload(claimItem);
  const inside: Work[] = [];
  for (let index = 0; index < 3; index++) {
    const item = await executorDelivery(`Bounded delivery ${index}`, 10 * minute);
    await patch(item, { delivery: { ...item.delivery, mergedAt: at(10 + index), mergedAtRepository: at(10 + index) } });
    inside.push(await reload(item));
  }
  const before = await executorDelivery('Merged before the window', 10 * minute);
  await patch(before, { delivery: { ...before.delivery, mergedAt: at(-30), mergedAtRepository: at(-30) } });
  await ready('Still open');

  const whole = await store.list();
  const summaries = whole.map(summary);
  const read: string[] = [];
  const readItem = async (id: string) => { read.push(id); return whole.find(item => item.id === id)!; };
  const now = Date.parse(at(60));
  const { report, read: named } = await measureThroughput(summaries, readItem, now, { deployed: release(), claimKey: claimItem.key });
  assert.deepEqual(new Set(read), new Set(inside.map(item => item.id)), 'exactly the window\'s deliveries are read whole');
  assert.deepEqual(new Set(named), new Set(read));
  assert.equal(read.length, inside.length, 'each is read once');
  assert.ok(read.length < whole.length, 'the read is the window, not the ledger');
  // The bounded read judges exactly what a read of every whole document judges.
  const full = verifyThroughput(whole, now, { deployed: release(), claimKey: claimItem.key });
  assert.deepEqual(report.population, full.population);
  assert.deepEqual(report.submitToMerge, full.submitToMerge);
  assert.deepEqual(report.deliveries.map(record => record.key), full.deliveries.map(record => record.key));
  assert.equal(report.window.basis, 'deployment-observation');
  // An undelivered claim establishes no window, and nothing is read for it.
  read.length = 0;
  const open = await measureThroughput(summaries.filter(item => item.id !== claimItem.id), readItem, now, { deployed: release(), claimKey: claimItem.key });
  assert.deepEqual(read, []); assert.equal(open.report.verdict, 'unverified');
});

test('unit:throughput-recorded-by-loop — after a verified deployment the loop records one throughput measurement for the release now serving, at most once per release, with its coordinator credential, and master status reads it back', async () => {
  const root = await temporaryDirectory('throughput-loop');
  try {
    // GY-87 itself, delivered and observed serving, and the deliveries made since.
    const windowStart = '2100-01-01T00:00:00.000Z', at = (minutes: number) => new Date(Date.parse(windowStart) + minutes * minute).toISOString();
    const claimed = await executorDelivery('The loop-measured claim', 5 * minute);
    await patch(claimed, { delivery: { ...claimed.delivery, mergedAt: at(-60), mergedAtRepository: at(-60),
      deployment: { sha: deployedRevision, mergeSha: commit(claimed.key), source: 'endpoint', observedAt: windowStart, covers: 'exact', at: windowStart, observer: 'coordinator-1' } } });
    for (let index = 0; index < 2; index++) {
      const item = await executorDelivery(`Loop-measured delivery ${index}`, 10 * minute);
      await patch(item, { delivery: { ...item.delivery, mergedAt: at(5 + index), mergedAtRepository: at(5 + index) } });
    }
    // The claim answers to GY-87's key, as it does in this repository's own ledger.
    const work = (await store.list()).map(item => item.id === claimed.id ? { ...item, key: throughputClaim.item } : item);
    const summaries = work.map(summary);
    const byId = new Map(work.map(item => [item.id, item]));
    let revision = deployedRevision, statusReads = 0;
    const read: string[] = [];
    const input = (observedSha: string) => ({ work: summaries, observedSha, now: () => Date.now(), origin: 'https://graphyard.example',
      status: async () => { statusReads++; return { now: new Date().toISOString(), release: { version: '0.9.1', revision } }; },
      readItem: async (id: string) => { read.push(id); return byId.get(id)!; },
      contains: async () => true as boolean | null });

    // The plane still serves a release nobody measured while the deployment record names the new
    // one: nothing is measured, so the new release is never marked measured on the old one's figures.
    revision = commit('previous-release');
    const lagging = await loopThroughputMeasurement(root, input(deployedRevision));
    assert.equal(lagging.outcome, 'waiting'); assert.deepEqual(read, []);
    assert.match(lagging.detail, /not yet measured while the verified deployment is/);
    assert.equal(await readThroughputMeasurement(root), null, 'nothing was recorded for the lagging plane');
    revision = deployedRevision;
    const first = await loopThroughputMeasurement(root, input(deployedRevision));
    assert.equal(first.outcome, 'recorded');
    assert.equal(first.report!.deployed.revision, deployedRevision);
    assert.equal(first.report!.deployed.containsClaim, true);
    assert.ok(first.file!.startsWith(throughputMeasurementDirectory));
    assert.deepEqual(new Set(read), new Set(first.read), 'only the window\'s deliveries were read whole');
    assert.equal(read.length, 2);
    assert.match(first.detail, new RegExp(`Recorded GY-87's throughput measurement for ${deployedRevision.slice(0, 12)}`));
    // master status now reports the claim against the release serving: verified, or the shortfall named.
    const visible = await throughputStatus(root, { release: { version: '0.9.1', revision } }, work);
    assert.equal(visible.measurement!.deployedRevision, deployedRevision);
    assert.equal(visible.verdict, first.report!.verdict);
    if (visible.verdict === 'unverified') assert.ok(visible.shortfall, 'an unverified measurement names its shortfall');
    assert.doesNotMatch(visible.reason, /no post-deploy measurement has ever been recorded/);

    // The same release is never measured twice.
    read.length = 0;
    const again = await loopThroughputMeasurement(root, input(deployedRevision));
    assert.equal(again.outcome, 'current'); assert.deepEqual(read, []);
    assert.equal((await readdir(join(root, throughputMeasurementDirectory))).length, 1);
    // A deployment the plane does not serve yet is waited for, not measured as the old release.
    const next = commit('next-release');
    assert.equal((await loopThroughputMeasurement(root, input(next))).outcome, 'waiting');
    assert.deepEqual(read, []);
    // Once it serves, it is measured, once.
    revision = next;
    const moved = await loopThroughputMeasurement(root, input(next));
    assert.equal(moved.outcome, 'recorded'); assert.equal(moved.report!.deployed.revision, next);
    assert.equal((await readdir(join(root, throughputMeasurementDirectory))).length, 2);
    // Ancestry git cannot answer stays unknown and keeps the claim unverified.
    revision = commit('third-release');
    const unknown = await loopThroughputMeasurement(root, { ...input(revision), contains: async () => null });
    assert.equal(unknown.report!.deployed.containsClaim, null); assert.equal(unknown.report!.verdict, 'unverified');
    // Without GY-87 delivered there is nothing to measure, and the plane is not asked; a simulated
    // ledger names its own delivered claim instead.
    const reads = statusReads;
    assert.equal((await loopThroughputMeasurement(root, { ...input(revision), work: summaries.filter(item => item.key !== throughputClaim.item) })).outcome, 'skipped');
    assert.equal(statusReads, reads);
    revision = commit('fourth-release');
    const named = await loopThroughputMeasurement(root, { ...input(revision), work: (await store.list()).map(summary), claimKey: claimed.key });
    assert.equal(named.outcome, 'recorded'); assert.equal(named.report!.window.basis, 'deployment-observation');
    // The record stays bounded: past the retention the oldest files are retired and the newest still reads back.
    const before = (await readdir(join(root, throughputMeasurementDirectory))).sort();
    assert.equal(before.length, 4);
    const newest = { ...named.report!, measuredAt: new Date(Date.now() + 60_000).toISOString() };
    const kept = await recordThroughputMeasurement(root, newest, undefined, 2);
    const after = (await readdir(join(root, throughputMeasurementDirectory))).sort();
    assert.deepEqual(after, [before[3], kept.split('/').pop()], 'the two newest files remain');
    assert.equal((await readThroughputMeasurement(root))!.report.measuredAt, newest.measuredAt);
  } finally { await rm(root, { recursive: true, force: true }); }

  // The loop's deployment step asks for it after each verified deployment, once per release.
  const directory = await temporaryDirectory('throughput-cycle');
  try {
    const token = join(directory, 'coordinator.token');
    await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: launcher, repository: 'owner/project', baseBranch: 'main',
      githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [],
      // Each cycle here serves a new release a few ms after the last: read live every cycle, not reused (GY-1398).
      run: { deploymentReuseMinutes: 0 } });
    const state = emptyDaemonState(master);
    state.lock = { id: 'lock', pid: process.pid, host: master.hostId, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() };
    const delivered = (await store.list()).find(item => item.stage === 'done')!;
    let observed: { source: 'endpoint' | 'unavailable'; sha: string | null } = { source: 'unavailable', sha: null };
    const asked: string[] = [];
    let answer: () => Promise<LoopThroughputOutcome> = async () => ({ outcome: 'recorded', revision: observed.sha, detail: `Recorded for ${observed.sha}` });
    const effects: DaemonEffects = {
      agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
      snapshot: async () => ({ work: [delivered], now: new Date().toISOString() }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
      observeDeployment: async () => ({ ...observed, at: new Date().toISOString(), reason: observed.sha ? null : 'not configured', deployed: observed.sha ? [delivered.key] : [], pending: observed.sha ? [] : [delivered.key], requests: 0 }) as any,
      recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
      measureThroughput: async (_work, sha) => { asked.push(sha); return answer(); },
    };
    await runCycle(master, state, effects, () => Date.now());
    assert.deepEqual(asked, [], 'no verified deployment, no measurement');
    observed = { source: 'endpoint', sha: commit('served-1') };
    await runCycle(master, state, effects, () => Date.now());
    assert.deepEqual(asked, [commit('served-1')], 'a verified deployment asks for the measurement');
    assert.equal(state.actions[`throughput:${commit('served-1')}`].state, 'done');
    await runCycle(master, state, effects, () => Date.now());
    assert.deepEqual(asked, [commit('served-1')], 'at most once per release');
    // A release the plane does not serve yet is asked again on the failure backoff until it does,
    // never once per cycle; a failure backs off the same way and is retried.
    const served2 = commit('served-2'), askedFor = (sha: string) => asked.filter(entry => entry === sha).length;
    observed = { source: 'endpoint', sha: served2 };
    answer = async () => ({ outcome: 'waiting', revision: commit('served-1'), detail: 'still serving served-1' });
    await runCycle(master, state, effects, () => Date.now());
    await runCycle(master, state, effects, () => Date.now());
    assert.equal(askedFor(served2), 2, 'asked on the cycle after the first wait');
    assert.equal(state.actions[`throughput:${served2}`].state, 'waiting');
    assert.equal(state.actions[`throughput:${served2}`].attempts, 2, 'every ask is counted');
    await runCycle(master, state, effects, () => Date.now());
    assert.equal(askedFor(served2), 2, 'the third cycle waits the backoff out');
    answer = async () => { throw new Error('plane refused work/x (502)'); };
    for (let cycles = 0; cycles < 4 && state.actions[`throughput:${served2}`].state !== 'failed'; cycles++) await runCycle(master, state, effects, () => Date.now());
    assert.equal(state.actions[`throughput:${served2}`].state, 'failed');
    assert.match(state.actions[`throughput:${served2}`].detail, /could not be recorded .*502/);
    answer = async () => ({ outcome: 'recorded', revision: served2, detail: 'Recorded for served-2' });
    for (let cycles = 0; cycles < 10 && state.actions[`throughput:${served2}`].state !== 'done'; cycles++) await runCycle(master, state, effects, () => Date.now());
    assert.equal(state.actions[`throughput:${served2}`].state, 'done');
    const count = asked.length;
    await runCycle(master, state, effects, () => Date.now());
    assert.equal(asked.length, count);
    // A plane that lags for many cycles is asked a handful of times, not once per cycle, and a
    // newer observation supersedes the wait: the superseded release is never asked again.
    const served3 = commit('served-3'), served4 = commit('served-4');
    observed = { source: 'endpoint', sha: served3 };
    answer = async () => ({ outcome: 'waiting', revision: served2, detail: 'still serving served-2' });
    for (let cycles = 0; cycles < 12; cycles++) await runCycle(master, state, effects, () => Date.now());
    assert.ok(askedFor(served3) >= 3 && askedFor(served3) <= 5, `twelve lagging cycles cost ${askedFor(served3)} asks`);
    observed = { source: 'endpoint', sha: served4 };
    answer = async () => ({ outcome: 'recorded', revision: served4, detail: 'Recorded for served-4' });
    const lagged = askedFor(served3);
    for (let cycles = 0; cycles < 10 && state.actions[`throughput:${served4}`]?.state !== 'done'; cycles++) await runCycle(master, state, effects, () => Date.now());
    assert.equal(state.actions[`throughput:${served4}`].state, 'done');
    assert.equal(askedFor(served3), lagged, 'the superseded release is not asked again');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:throughput-same-millisecond-records — measurements recorded in the same millisecond each persist as a distinct file in the unchanged record format, and the ordered read keeps every record in recorded order', async () => {
  const root = await temporaryDirectory('throughput-same-millisecond');
  try {
    const report = (measuredAt: string, admitted: number) => ({ measuredAt, verdict: 'verified', reason: `record ${admitted}` }) as unknown as ThroughputReport;
    const same = '2026-10-07T04:40:48.867Z';
    const files = [];
    for (let index = 0; index < 12; index++) files.push(await recordThroughputMeasurement(root, report(same, index)));
    assert.equal(new Set(files).size, 12, 'every record took its own file');
    assert.equal(files[0], join(throughputMeasurementDirectory, '2026-10-07T04-40-48-867Z.json'), 'the first keeps the existing name');
    assert.equal(files[11], join(throughputMeasurementDirectory, '2026-10-07T04-40-48-867Z_11.json'));
    for (const [index, file] of files.entries()) assert.deepEqual(JSON.parse(await readFile(join(root, file), 'utf8')), { measuredAt: same, verdict: 'verified', reason: `record ${index}` }, 'the record format is unchanged');
    assert.equal((await readdir(join(root, throughputMeasurementDirectory))).length, 12);
    // The newest of the same millisecond reads back, and a later millisecond still orders after them.
    assert.equal((await readThroughputMeasurement(root))!.file, files[11]);
    const later = await recordThroughputMeasurement(root, report('2026-10-07T04:40:48.868Z', 99));
    assert.equal((await readThroughputMeasurement(root))!.file, later);
    // Retention retires the oldest in recorded order, numerically across the suffixes.
    await recordThroughputMeasurement(root, report('2026-10-07T04:40:48.868Z', 100), undefined, 4);
    assert.deepEqual((await readdir(join(root, throughputMeasurementDirectory))).sort(),
      ['2026-10-07T04-40-48-867Z_10.json', '2026-10-07T04-40-48-867Z_11.json', '2026-10-07T04-40-48-868Z.json', '2026-10-07T04-40-48-868Z_1.json']);
    assert.equal((await readThroughputMeasurement(root))!.report.reason, 'record 100');
  } finally { await rm(root, { recursive: true, force: true }); }
});
