import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { masterConfigSchema } from '../src/master.js';
import { emptyDaemonState, type DaemonEffects } from '../src/master-daemon.js';
import type { Cycle } from '../src/daemon/cycle.js';
import { isClosed, type Principal, type Work } from '../src/model.js';
import * as model from '../src/model.js';
import type { Services } from '../src/server/routes.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// Time-bomb allowance (GY-1694): the 2026-10-13 instants are the fixture's own clock, judged against the explicit `now` below; Date.now() stamps nothing judged.

// GY-1779: GY-1724, GY-1725 and GY-1759 sat escalated past their windows for "the loop's reading" that
// no loop step recorded. The deployment-verification step now takes every due loop-owned reading on the
// release the control plane serves, through the post-deploy-checks filer and the proof's reader, records
// it as trusted evidence bound as loopObservation reads it, closes a pass as delivered-observation in the
// same pass, raises the escalation of a fail naming the measured values, and records why a reading this
// host cannot take was not taken. Every new module is imported at call time, so the base tree fails a case.
const hour = 3_600_000, now = Date.parse('2026-10-13T12:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const filed = sha('a'), serving = sha('b'), mergeSha = sha('c');
const parentId = '11111111-1111-4111-8111-111111111111';
const proof = 'manual:post-deploy/webhook-deliveries-clean-24h', own = 'manual:webhook-deliveries-clean-24h-on-serving-release';
const base = (n: number, extra: Partial<Work> = {}): Work => ({
  id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, key: `GY-${n}`, title: `Item ${n}`, description: '', type: 'chore', priority: 1, stage: 'ready', ready: true, epoch: 0, revision: 3, policyRevision: 1,
  createdAt: iso(now - 30 * hour), updatedAt: iso(now - 2 * hour), stageEnteredAt: iso(now - 2 * hour), lease: null, lastAssignment: null, systemDriven: true, implementers: [],
  workspaces: [], sessions: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], criteria: [], plannedFiles: [],
  policy: { checks: ['test', 'typecheck'], review: true }, dependencies: [],
  gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }],
  ...extra,
}) as unknown as Work;
const parent = base(1700, { id: parentId, stage: 'done', ready: true, criteria: [{ id: 'AC-2', text: 'A 24-hour window of live GitHub activity shows zero failed webhook deliveries', proofs: [proof] }],
  delivery: { mergeSha, mergedAt: iso(now - 40 * hour), deployment: { sha: filed, mergeSha, source: 'endpoint', observedAt: iso(now - 30 * hour), covers: 'descendant', at: iso(now - 30 * hour), observer: 'graphyard-master' } } } as Partial<Work>);
/** A follow-up the filer filed for `parent` AC-2 on the filed release, window closed an hour ago. */
const followUp = (n: number, extra: Partial<Work> = {}) => base(n, { description: `Post-deploy follow-up: post-deploy:${parentId}:AC-2:${proof}:${filed}\n\nowed`,
  criteria: [{ id: 'AC-1', text: `From this head against the serving release ${filed.slice(0, 12)} that carries GY-1700's merge: zero failed webhook deliveries over 24 hours`, proofs: [own] }],
  observationWindow: { notBefore: iso(now - hour), basis: 'criterion-window', detail: 'the 24-hour live window ran' }, ...extra });

async function cycleOver(work: Work[], directory: string, reader: DaemonEffects['readPostDeploy'], at = now) {
  const token = join(directory, 'coordinator.token');
  await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: join(directory, 'graphyard.mjs'), repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], run: { deploymentReuseMinutes: 0 } });
  const state = emptyDaemonState(config);
  const recorded: { key: string; reading: Record<string, unknown> }[] = [], closed: { key: string; release: string; reason: string; idempotency: string }[] = [];
  const { localPostDeployChecks } = await import('../src/master-verification.js');
  const effects: DaemonEffects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work, now: iso(at) }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, persist: async () => {},
    observeDeployment: async () => ({ source: 'endpoint', sha: serving, at: iso(at - 60_000), reason: null, deployed: work.filter(item => item.stage === 'done' && item.delivery && item.key !== 'GY-1733').map(item => item.key), pending: [], requests: 1 }) as never,
    recordDeployment: async () => {}, requestSmoke: () => {},
    recordReading: async (item: Work, reading: Parameters<NonNullable<DaemonEffects['recordReading']>>[1]) => { recorded.push({ key: item.key, reading }); item.evidence.push({ id: randomUUID(), producer: 'graphyard-master', trusted: true, executed: 1, skipped: 0, at: iso(at), proof: reading.proof, sha: reading.sha, baseSha: reading.baseSha, policyRevision: reading.policyRevision, result: reading.result, reading: { detail: reading.detail } }); },
    closeObservation: async (item: Work, release: string, reason: string, idempotency: string) => { closed.push({ key: item.key, release, reason, idempotency }); },
    postDeployFiler: localPostDeployChecks, readPostDeploy: reader,
  } as unknown as DaemonEffects;
  const cycle = { config, state, effects, now: () => at, clock: at, clockOffset: { min: 0, max: 0 }, performed: [], snapshot: { work, now: iso(at) }, open: work.filter(item => item.stage !== 'done'),
    isolate: async (_kind: string, _item: unknown, _name: string, body: () => Promise<unknown>) => body(), detached: false, launcher: { busy: () => false }, timings: { step: async (_name: string, body: () => Promise<unknown>) => body() } } as unknown as Cycle;
  const { deploymentStep } = await import('../src/daemon/cycle-delivery.js');
  await deploymentStep(cycle);
  return { state, recorded, closed, cycle, again: async () => { cycle.state.cycle++; cycle.performed.length = 0; await deploymentStep(cycle); } };
}

test('integration:loop-records-due-observation-reading — the deployment-verification step reads every due loop-owned item on the serving release through the filer and the reader, records the reading bound as loopObservation reads it, closes a pass as delivered-observation and raises a fail naming the measured values', async () => {
  const { loopObservation } = model as unknown as { loopObservation: (work: Work, at: Date, all: Work[]) => { due: boolean } | null };
  const passing = followUp(1724), failing = followUp(1726), untakeable = followUp(1727), windowed = followUp(1728, { observationWindow: { notBefore: iso(now + 6 * hour), basis: 'criterion-window', detail: 'later' } });
  // GY-1725 as it stands: an unsubmitted pre-GY-1762 worker candidate left in build is read the same way.
  const inBuild = followUp(1725, { stage: 'build', epoch: 3, plannedFiles: ['verification/post-deploy-github-budget-row.md'], candidate: { pr: 1172, sha: sha('d'), baseSha: sha('e'), author: 'bot', branch: 'graphyard/gy-1725-3', createdAt: iso(now - 5 * hour) } } as Partial<Work>);
  // The parent already carries a trusted passing observation of the proof on the serving release: the filer reads it observed, and no reader runs.
  const observedParent = { ...parent, id: '22222222-2222-4222-8222-222222222222', key: 'GY-1749', evidence: [{ id: randomUUID(), proof, sha: serving, baseSha: mergeSha, policyRevision: 1, producer: 'graphyard-producer', trusted: true, result: 'pass', executed: 1, skipped: 0, at: iso(now - hour) }] } as Work;
  const observed = followUp(1759, { description: `Post-deploy follow-up: post-deploy:${observedParent.id}:AC-2:${proof}:${filed}\n\nowed` });
  const asked: string[] = [];
  const reader: DaemonEffects['readPostDeploy'] = async input => {
    asked.push(input.item.key);
    assert.equal(input.proof, proof, 'the reader is asked for the parent\'s declared proof'); assert.equal(input.release, serving); assert.equal(input.criterion?.id, 'AC-2');
    if (input.item.key === 'GY-1726') return { result: 'fail', detail: 'the advanced delivery log shows 3 failed deliveries (2 × 502, 1 connection failure) in the 24 hours to 2026-10-13T12:00Z' };
    if (input.item.key === 'GY-1727') return { unavailable: 'the App\'s advanced delivery log needs a browser sign-in no loop step holds' };
    return { result: 'pass', detail: 'the advanced delivery log shows 0 failed deliveries in the 24 hours to 2026-10-13T12:00Z' };
  };
  const work = [parent, observedParent, passing, failing, untakeable, windowed, inBuild, observed];
  for (const item of [passing, failing, untakeable, inBuild, observed]) assert.equal(loopObservation(item, new Date(now), work)?.due, true, `${item.key} is due`);
  assert.equal(loopObservation(windowed, new Date(now), work)?.due, false);
  const directory = await temporaryDirectory('loop-readings');
  const run = await cycleOver(work, directory, reader);
  // Every due reading was taken on the serving release — a later release than the follow-ups were filed for, observed carrying the parent's merge — never the windowed one.
  assert.deepEqual(asked.sort(), ['GY-1724', 'GY-1725', 'GY-1726', 'GY-1727'], 'the observed parent\'s follow-up needs no reader: the filer reads it observed');
  const reading = (key: string) => run.recorded.find(entry => entry.key === key)?.reading;
  for (const key of ['GY-1724', 'GY-1725', 'GY-1726', 'GY-1759']) assert.deepEqual([reading(key)?.proof, reading(key)?.sha, reading(key)?.baseSha, reading(key)?.policyRevision], [own, serving, mergeSha, 1], `${key}'s reading is bound as loopObservation reads it`);
  assert.equal(reading('GY-1727'), undefined, 'a reading this host cannot take is not recorded');
  assert.equal(reading('GY-1728'), undefined, 'a reading that cannot exist yet is not taken');
  assert.deepEqual([reading('GY-1724')?.result, reading('GY-1725')?.result, reading('GY-1726')?.result, reading('GY-1759')?.result], ['pass', 'pass', 'fail', 'pass']);
  assert.match(String(reading('GY-1759')?.detail), /post-deploy-checks filer reads GY-1749 AC-2's manual:post-deploy\/webhook-deliveries-clean-24h observed on release bbbbbbbbbbbb/);
  // The recorded reading ends the wait as loopObservation reads it, on the serving release rather than the filed one.
  for (const item of [passing, inBuild, observed]) assert.equal(loopObservation(item, new Date(now), work), null, `${item.key}'s wait ended`);
  assert.equal(loopObservation(failing, new Date(now), work)?.due, true, 'a failed reading leaves the wait standing');
  // A pass closes the item as delivered-observation in the same pass, on the release it was read on.
  assert.deepEqual(run.closed.map(entry => [entry.key, entry.release]).sort(), [['GY-1724', serving], ['GY-1725', serving], ['GY-1759', serving]]);
  assert.match(run.closed.find(entry => entry.key === 'GY-1724')!.reason, /passed on the serving release bbbbbbbbbbbb: manual:webhook-deliveries-clean-24h-on-serving-release: the advanced delivery log shows 0 failed deliveries/);
  assert.equal(run.closed.find(entry => entry.key === 'GY-1724')!.idempotency, `reading:close:${passing.id}:${serving}`);
  // A fail records the reading, raises the item's escalation naming the measured values and is asked again on the backoff, never closed.
  const escalation = run.state.actions[`escalation:reading:${failing.id}:${serving}`];
  assert.equal(escalation?.kind, 'escalation');
  assert.match(escalation!.detail, /GY-1726's reading of manual:webhook-deliveries-clean-24h-on-serving-release failed on the serving release bbbbbbbbbbbb: .*3 failed deliveries \(2 × 502, 1 connection failure\)/);
  assert.equal(run.state.actions[`reading:${failing.id}:${serving}`]?.state, 'waiting');
  // A reading this host cannot take records why, so the item is never left owed to nobody.
  const untaken = run.state.actions[`reading:${untakeable.id}:${serving}`];
  assert.equal(untaken?.state, 'waiting');
  assert.match(untaken!.detail, /GY-1727's reading is due on release bbbbbbbbbbbb and cannot be taken from this host: manual:webhook-deliveries-clean-24h-on-serving-release: the App's advanced delivery log needs a browser sign-in/);
  assert.equal(run.state.actions[`reading:${windowed.id}:${serving}`], undefined);
  assert.equal(run.state.actions[`reading:${passing.id}:${serving}`]?.state, 'done');
  assert.match(run.state.actions[`reading:${passing.id}:${serving}`]!.detail, /closed it as delivered-observation/);
  // The next cycle records nothing twice: a done reading stands, and the failed one is read again on its backoff but, failing again, is not recorded a second time.
  const before = run.recorded.length, askedBefore = asked.length;
  await run.again();
  assert.equal(run.recorded.length, before);
  assert.deepEqual(asked.slice(askedBefore), ['GY-1726', 'GY-1727'], 'the failed and the untakeable readings are asked again; the done ones never');
  assert.equal(run.state.actions[`reading:${failing.id}:${serving}`]?.attempts, 2);
  assert.equal(run.closed.length, 3);
});

test('integration:loop-records-due-observation-reading — the serving release not yet observed carrying the parent\'s merge, or unobserved this cycle, records why and takes no reading', async () => {
  const item = followUp(1731), directory = await temporaryDirectory('loop-readings-unserved');
  const other = { ...parent, id: '33333333-3333-4333-8333-333333333333', key: 'GY-1733' } as Work;
  const orphan = followUp(1732, { description: `Post-deploy follow-up: post-deploy:${other.id}:AC-2:${proof}:${filed}\n\nowed` });
  const run = await cycleOver([parent, other, item, orphan], directory, async () => ({ result: 'pass', detail: 'clean' }));
  assert.deepEqual(run.recorded.map(entry => entry.key), ['GY-1731']);
  const unserved = run.state.actions[`reading:${orphan.id}:${serving}`];
  assert.equal(unserved?.state, 'waiting');
  assert.match(unserved!.detail, /release the control plane serves \(bbbbbbbbbbbb\) is not observed carrying GY-1733's merge cccccccccccc/);
});

// The control plane's side of the same pass, against a real Postgres: the coordinator's `reading`
// command records the trusted evidence loopObservation binds to a later serving release, refuses a
// reading of anything else, and closing as delivered-observation closes the superseded pull request.
const repository = 'owner/loop-readings';
const operator: Principal = { id: 'readings-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'readings-master', role: 'coordinator', sessionKind: 'ai' };
const worker: Principal = { id: 'readings-worker', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, worker].map(principal => ({ ...principal, token: `readings-${principal.id}-${'x'.repeat(32)}` }));
let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 191;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('loop-readings-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('readings_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/readings_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null;
});
after(async () => { await store?.close(); await database?.stop(); });
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
/** An item created through the engine, then written as the control plane would have left it: the fixture for what the reading binds to. */
async function plant(shape: Work): Promise<Work> {
  const created = await engine.execute(operator, 'create', null, { title: shape.title, plannedFiles: ['src/readings/'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:readings'] }] }, randomUUID()) as Work;
  const { id, key, ...rest } = shape;
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [created.id, JSON.stringify({ ...created, ...rest, id: created.id, key: created.key })]);
  return reload(created.id);
}

test('integration:loop-records-due-observation-reading — the coordinator records the reading as trusted evidence bound to the serving release, refuses one off the parent\'s merge or on another item, and the delivered-observation close closes the superseded pull request', async () => {
  const { loopObservation } = model as unknown as { loopObservation: (work: Work, at: Date, all: Work[]) => { due: boolean } | null };
  const delivered = await plant(parent);
  const item = await plant({ ...followUp(0, { stage: 'build', epoch: 2, candidate: { pr: 1172, sha: sha('d'), baseSha: sha('e'), author: 'bot', branch: 'graphyard/gy-x-2', createdAt: iso(now - hour) } } as Partial<Work>), description: `Post-deploy follow-up: post-deploy:${delivered.id}:AC-2:${proof}:${filed}\n\nowed` } as Work);
  const code = await plant(base(0, { criteria: [{ id: 'AC-1', text: 'Code', proofs: ['unit:code'] }] }));
  const reading = { proof: own, sha: serving, baseSha: mergeSha, policyRevision: 1, result: 'pass' as const, detail: 'the advanced delivery log shows 0 failed deliveries in 24 hours' };
  await assert.rejects(engine.execute(worker, 'reading', item.id, reading, randomUUID()), /Coordinator permission required/);
  await assert.rejects(engine.execute(coordinator, 'reading', code.id, { ...reading, proof: 'unit:code' }, randomUUID()), /not a loop-owned observation item/);
  await assert.rejects(engine.execute(coordinator, 'reading', item.id, { ...reading, baseSha: sha('f') }, randomUUID()), /bound to the parent delivery's merge/);
  const read = await engine.execute(coordinator, 'reading', item.id, reading, randomUUID()) as Work;
  const [entry] = read.evidence;
  assert.deepEqual([entry.trusted, entry.producer, entry.sha, entry.baseSha, entry.result, entry.reading], [true, coordinator.id, serving, mergeSha, 'pass', { detail: reading.detail }]);
  assert.equal(loopObservation(read, new Date(now), [delivered]), null, 'the loop\'s reading on the later serving release ends the wait');
  // The close as delivered-observation closes the open pull request as superseded by the reading, then the item.
  const closedPulls: { pr: number; reason: string }[] = [];
  const github = { closeSupersededPullRequest: async (pr: number, reason: string) => { closedPulls.push({ pr, reason }); return 'closed' as const; } };
  const { closeWork } = await import('../src/server/close.js');
  const services = { engine, github, repository, principals: [] } as unknown as Services;
  await assert.rejects(closeWork(services, coordinator, item.id, { kind: 'delivered-observation', reason: 'read', ref: null }, randomUUID()), /names the release its reading was taken on/);
  const closed = await closeWork(services, coordinator, item.id, { kind: 'delivered-observation', reason: `${read.key}'s reading passed on the serving release`, ref: serving }, randomUUID()) as Work;
  assert.deepEqual([closed.stage, closed.closure?.kind, closed.closure?.ref, closed.closure?.by, isClosed(closed)], ['done', 'delivered-observation', serving, coordinator.id, true]);
  assert.deepEqual(closedPulls.map(pull => pull.pr), [1172]);
  assert.match(closedPulls[0].reason, /superseded by that reading/);
  const audit = (await store.pool.query("SELECT payload FROM events WHERE work_id=$1 AND kind='work.closed'", [item.id])).rows[0].payload;
  assert.deepEqual(audit.details.pullRequest, { pr: 1172, outcome: 'closed' });
});
