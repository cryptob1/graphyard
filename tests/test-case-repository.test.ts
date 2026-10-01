import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { Validation } from '../src/validation.js';
import { server } from '../src/server.js';
import type { Observation, Principal, Work } from '../src/model.js';
import { caseResult, flakiness, scenarioOf, type ScenarioRun } from '../src/model/test-cases.js';

// GY-162: the test-case repository. A case is a versioned scenario; each trusted run of it is
// appended to its history, bound to the commit and the run that produced it; a builder cannot
// record one. Read through the same HTTP API the Tests page reads.
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const producer: Principal = { id: 'e2e-producer', role: 'producer', proofs: ['e2e:*'] };
const runner: Principal = { id: 'runner', role: 'worker' };
const collector: Principal = { id: 'collector', role: 'producer', proofs: ['e2e:*'] };
const builder: Principal = { id: 'builder', role: 'producer' };
const principals = [operator, worker, producer, runner, collector, builder];
const tokens = new Map(principals.map(p => [p.id, `${p.id}-${'t'.repeat(32)}`]));
const head = 'c'.repeat(40), base = 'd'.repeat(40), repository = 'owner/project';
const attestationPublicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
const bundleDigest = `sha256:${'1'.repeat(64)}`, imageDigest = `sha256:${'2'.repeat(64)}`;

let database: EmbeddedPostgres, store: Store, engine: Engine, validation: Validation, http: ReturnType<typeof server>, url: string;
let pullRequest = 300, cases = 0;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 162;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('test-cases'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('test_cases_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/test_cases_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository);
  validation = new Validation(engine, principals, repository);
  http = server(engine, principals.map(p => ({ ...p, token: tokens.get(p.id)! })), null);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

async function call(path: string, actor: Principal, data?: unknown, key = randomUUID()) {
  const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${tokens.get(actor.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: data === undefined ? undefined : JSON.stringify(data) });
  return { status: response.status, body: await response.json() as any };
}
async function defineCase(id = `booking-sms-${++cases}`) {
  const defined = await call('scenarios', operator, { id, title: `Booking ${id} sends an SMS`, purpose: 'A confirmed booking texts the customer', steps: ['Book'], expected: ['An SMS arrives'], environment: 'staging', runner: 'Playwright', testPath: `tests/e2e/${id}.spec.ts` });
  assert.equal(defined.status, 200, JSON.stringify(defined.body));
  return id;
}
/** A submitted item requiring `e2e:<id>`, whose candidate the control plane has observed at `sha`. */
async function linkedItem(id: string, sha = head, files: string[] = ['src/booking.ts']) {
  let work = await engine.execute(operator, 'create', null, { title: `Ship ${id}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Bookings text the customer', proofs: [`e2e:${id}`] }] }, randomUUID()) as Work;
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'machine-a', path: `/tmp/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}` }, randomUUID());
  work = await engine.execute(worker, 'submit', work.id, { epoch: work.epoch, pr: ++pullRequest }, randomUUID());
  const observation: Observation = { clockOffset: { min: 0, max: 0 }, candidate: { sha, baseSha: base, pr: work.submission!.pr, branch: work.workspaces.at(-1)!.branch, author: 'implementer' },
    checks: [], reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, files, scopeFiles: [], at: new Date().toISOString() };
  return engine.observe(work.id, work.revision, observation);
}
const provenance = (runId: string, runAttempt = 1) => ({ provider: 'github-actions', repository, workflowCommit: 'e'.repeat(40), runId, runAttempt,
  artifact: { id: 1, name: 'playwright-report', digest: `sha256:${'f'.repeat(64)}`, url: `https://github.com/${repository}/actions/runs/${runId}/artifacts/1`, createdAt: '2026-09-01T00:00:00.000Z' } });
const run = (work: Work, overrides: Record<string, unknown> = {}) => ({ proof: work.criteria[0].proofs[0], sha: work.candidate!.sha, baseSha: work.candidate!.baseSha, policyRevision: work.policyRevision,
  result: 'pass', executed: 4, skipped: 0, scenarioRevision: work.scenarioRequirements[0].revision, environment: work.scenarioRequirements[0].environment,
  exercise: { behaviour: 'the SMS send on confirmation', result: 'fail', executed: 4 }, ...overrides });
const summary = async (id: string) => (await call('tests', operator)).body.cases.find((entry: { id: string }) => entry.id === id);
const history = async (id: string, query = '') => call(`tests/${id}/runs${query}`, operator);

test('unit:test-case-repository — a test case is stored with a stable id, title, covered behaviour and the work items that link it', async () => {
  const id = await defineCase();
  const work = await linkedItem(id);
  const entry = await summary(id);
  assert.equal(entry.id, id); assert.equal(entry.title, `Booking ${id} sends an SMS`); assert.equal(entry.purpose, 'A confirmed booking texts the customer');
  assert.equal(entry.revision, 1); assert.equal(entry.changed.by, operator.id);
  assert.deepEqual(entry.links, [{ key: work.key, title: work.title, stage: work.stage, criteria: ['AC-1'] }], 'the criterion that names e2e:ID links the case to its item');
  assert.equal(entry.latest, null); assert.equal(entry.runs, 0);
  // The id is stable: a new revision keeps it, and the case reads as last changed by that revision.
  const revised = await call('scenarios', operator, { id, title: 'Booking texts the customer', purpose: 'Revised behaviour', steps: ['Book'], expected: ['An SMS arrives'], environment: 'staging', runner: 'Playwright', testPath: `tests/e2e/${id}.spec.ts`, expectedRevision: 1 });
  assert.equal(revised.status, 200);
  const after = await summary(id);
  assert.equal(after.revision, 2); assert.equal(after.title, 'Booking texts the customer'); assert.equal(after.links[0].key, work.key);
  assert.equal(scenarioOf('e2e:deploy-smoke'), null, 'post-deployment smoke is a delivery check, not a test case');
});

test('unit:test-case-repository — each trusted run records pass, fail or skipped bound to its exact commit and run, appended to history once', async () => {
  const id = await defineCase();
  const work = await linkedItem(id);
  const key = randomUUID();
  const passed = await call(`work/${work.id}/evidence`, producer, run(work, { provenance: provenance('7001') }), key);
  assert.equal(passed.status, 200, JSON.stringify(passed.body)); assert.equal(passed.body.evidence.at(-1).trusted, true);
  // The same request retried, and the same run published again under a new key, are one history row.
  assert.equal((await call(`work/${work.id}/evidence`, producer, run(work, { provenance: provenance('7001') }), key)).status, 200);
  assert.equal((await call(`work/${work.id}/evidence`, producer, run(work, { provenance: provenance('7001') }))).status, 200);
  assert.equal((await call(`work/${work.id}/evidence`, producer, run(work, { result: 'fail', provenance: provenance('7001', 2) }))).status, 200);
  assert.equal((await call(`work/${work.id}/evidence`, producer, run(work, { executed: 3, skipped: 1 }))).status, 200);
  const { body } = await history(id);
  assert.deepEqual(body.runs.map((entry: ScenarioRun) => entry.result), ['skipped', 'fail', 'pass'], 'newest first; a skip is its own result, never a pass');
  const [skipped, failed, first] = body.runs as ScenarioRun[];
  for (const entry of body.runs as ScenarioRun[]) {
    assert.equal(entry.sha, head); assert.equal(entry.baseSha, base); assert.equal(entry.pr, work.candidate!.pr); assert.equal(entry.workKey, work.key);
    assert.equal(entry.scenarioRevision, 1); assert.equal(entry.environment, 'staging'); assert.equal(entry.producer, producer.id);
  }
  assert.deepEqual(first.run, { kind: 'github-actions', id: '7001', attempt: 1, url: `https://github.com/${repository}/actions/runs/7001/artifacts/1` });
  assert.deepEqual([failed.run.id, failed.run.attempt], ['7001', 2], 'a re-run attempt is a run of its own');
  assert.equal(skipped.run.kind, 'producer'); assert.equal(skipped.run.id, skipped.evidenceId, 'a producer session run is identified by the record it wrote');
  // History is append-only.
  await assert.rejects(store.pool.query('UPDATE scenario_runs SET document = document WHERE scenario=$1', [id]), /append-only/);
  await assert.rejects(store.pool.query('DELETE FROM scenario_runs WHERE scenario=$1', [id]), /append-only/);
  const entry = await summary(id);
  assert.equal(entry.latest.result, 'skipped'); assert.equal(entry.runs, 3); assert.equal(entry.failures, 1); assert.equal(entry.lastFailure.seq, failed.seq);
  assert.equal(entry.flaky, true); assert.match(entry.flakyReason, new RegExp(`passed and failed on commit ${head.slice(0, 8)}`));
  assert.equal(caseResult({ result: 'pass', executed: 0, skipped: 0 }), 'skipped', 'a run that executed nothing did not pass');
});

test('unit:test-case-repository — a worker principal cannot record results: its own assertions, and untrusted passes, never become runs', async () => {
  const id = await defineCase();
  const work = await linkedItem(id);
  const asserted = await call(`work/${work.id}/evidence`, worker, run(work));
  assert.equal(asserted.status, 200); assert.equal(asserted.body.evidence.at(-1).trusted, false, 'a worker records only its own untrusted assertion');
  const failing = await call(`work/${work.id}/evidence`, worker, run(work, { result: 'fail' }));
  assert.equal(failing.body.evidence.at(-1).trusted, false);
  // A granted producer's pass that never exercised its criterion is untrusted too, so not a run.
  const unexercised = await call(`work/${work.id}/evidence`, producer, run(work, { exercise: undefined }));
  assert.equal(unexercised.body.evidence.at(-1).trusted, false);
  assert.deepEqual((await history(id)).body.runs, []);
  const entry = await summary(id);
  assert.equal(entry.latest, null); assert.equal(entry.runs, 0);
  // There is no write route for runs: only the evidence command and the validation collector append them.
  assert.equal((await call('tests', worker, { scenario: id, result: 'pass' })).status, 404);
  assert.equal((await call(`tests/${id}/runs`, worker, { result: 'pass' })).status, 404);
  assert.equal((await store.pool.query('SELECT count(*) AS n FROM scenario_runs WHERE scenario=$1', [id])).rows[0].n, '0');
});

test('unit:test-case-repository — revoked evidence stays in history as withdrawn and never decides the latest result; history pages by sequence', async () => {
  const id = await defineCase();
  const work = await linkedItem(id);
  await call(`work/${work.id}/evidence`, producer, run(work, { provenance: provenance('8001') }));
  await call(`work/${work.id}/evidence`, producer, run(work, { result: 'fail', provenance: provenance('8002') }));
  const revoked = await call(`work/${work.id}/revoke`, producer, { proof: `e2e:${id}`, sha: head, baseSha: base, policyRevision: work.policyRevision, reason: 'The staging target was misconfigured' });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  const entry = await summary(id);
  assert.equal(entry.runs, 2); assert.equal(entry.latest, null, 'every run on this head was withdrawn');
  assert.equal(entry.failures, 0); assert.equal(entry.flaky, false);
  assert.ok(entry.history.every((row: ScenarioRun) => row.withdrawn));
  const page = await history(id, '?limit=1');
  assert.equal(page.body.runs.length, 1); assert.equal(page.body.runs[0].result, 'fail');
  const next = await history(id, `?limit=1&before=${page.body.next}`);
  assert.deepEqual(next.body.runs.map((row: ScenarioRun) => row.result), ['pass']); assert.equal(next.body.next, null);
  assert.equal((await history(id, '?before=abc')).status, 400);
  assert.equal((await history(id, '?limit=500')).status, 400);
});

test('unit:test-case-repository — flaky means a pass and a fail on one commit, or two or more changes in the last 20 runs; skips count as neither', () => {
  const at = (sha: string, result: ScenarioRun['result'], seq: number) => ({ seq, sha, result } as ScenarioRun);
  assert.deepEqual(flakiness([at('a', 'pass', 3), at('b', 'pass', 2), at('c', 'fail', 1)]), { flaky: false, reason: null });
  assert.equal(flakiness([at('a', 'pass', 3), at('b', 'fail', 2), at('c', 'pass', 1)]).flaky, true);
  assert.match(flakiness([at('a', 'pass', 3), at('b', 'fail', 2), at('c', 'pass', 1)]).reason!, /changed 2 times in its last 3 runs/);
  assert.equal(flakiness([at('a', 'pass', 3), at('b', 'skipped', 2), at('c', 'pass', 1)]).flaky, false, 'a skip is not a change');
  assert.equal(flakiness([at('a', 'fail', 2), at('a', 'pass', 1)]).flaky, true, 'a re-run flip on one commit');
  const old = [...Array.from({ length: 20 }, (_, i) => at(`s${i}`, 'pass', 100 - i)), at('x', 'fail', 50), at('y', 'pass', 49)];
  assert.equal(flakiness(old).flaky, false, 'changes older than the window are not counted');
});

/** A full validation fixture for one case: environment, runner/collector/builder registrations, bundle, observed item, candidate and request. */
let fixtures = 0;
async function validationFixture() {
  const n = ++fixtures, id = `booking-sms-validation-${n}`;
  const environment = { id: `staging-${n}`, revision: 1 };
  const runnerRef = { id: `runner-${n}`, revision: 1 }, collectorRef = { id: `collector-${n}`, revision: 1 }, builderRef = { id: `builder-${n}`, revision: 1 }, bundleRef = { id: `bundle-${n}`, revision: 1 };
  const scenario = await call('scenarios', operator, { id, title: `Booking ${id} sends an SMS`, purpose: 'A confirmed booking texts the customer', steps: ['Book'], expected: ['An SMS arrives'], environment: environment.id, runner: 'Playwright', testPath: `tests/e2e/${id}.spec.ts` });
  assert.equal(scenario.status, 200, JSON.stringify(scenario.body));
  await validation.define(operator, { kind: 'environment', id: environment.id, expectedRevision: 0, repository, url: 'https://staging.example.test', instance: `instance-${n}`, immutable: true, services: ['api'], resources: [`test-account-${n}`] }, randomUUID());
  for (const [ref, actor, role] of [[runnerRef, runner, 'runner'], [collectorRef, collector, 'collector'], [builderRef, builder, 'builder']] as const)
    await validation.define(operator, { kind: 'registration', id: ref.id, expectedRevision: 0, principalId: actor.id, role, environment, adapterVersion: 'test-v1', proofs: role === 'collector' ? [`e2e:${id}`] : [], enabled: true,
      ...(role === 'runner' ? { executionHost: 'unix:///var/run/docker.sock', attestationPublicKey, executionNetwork: 'gy-isolated' } : {}) }, randomUUID());
  await validation.define(operator, { kind: 'bundle', id: bundleRef.id, expectedRevision: 0, scenario: id, scenarioRevision: scenario.body.revision, scenarioHash: scenario.body.hash, digest: bundleDigest, runnerImageDigest: imageDigest }, randomUUID());
  let work = await engine.execute(operator, 'create', null, { title: `Ship ${id}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Bookings text the customer', proofs: [`e2e:${id}`] }] }, randomUUID()) as Work;
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'machine-a', path: `/tmp/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}` }, randomUUID());
  work = await engine.execute(worker, 'submit', work.id, { epoch: work.epoch, pr: ++pullRequest }, randomUUID());
  const observation: Observation = { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: work.submission!.pr, branch: work.workspaces.at(-1)!.branch, author: 'implementer' },
    checks: [{ name: 'test', appId: 15368, result: 'success' }, { name: 'typecheck', appId: 15368, result: 'success' }], reviews: [{ reviewer: 'other', sha: head, state: 'APPROVED' }],
    protected: true, mergeable: true, merged: false, mergeSha: null, files: [], scopeFiles: [], at: new Date().toISOString() };
  work = await engine.observe(work.id, work.revision, observation);
  const build: any = await validation.attestBuild(builder, { registration: builderRef, workId: work.id, expectedWorkRevision: work.revision, sourceSha: head, baseSha: base, buildInputsDigest: imageDigest, artifacts: [{ service: 'api', digest: bundleDigest }], provenanceUrl: 'https://ci.example.test/build/1' }, randomUUID());
  const candidate = await validation.createCandidate(operator, { workId: work.id, expectedWorkRevision: work.revision, proof: `e2e:${id}`, environment, bundle: bundleRef, buildAttestationId: build.id, requiredArtifacts: ['report'], artifactStorage: 'external' }, randomUUID()) as any;
  const request = await validation.createRequest(operator, { candidateId: candidate.id, expectedWorkRevision: (await store.list()).find(w => w.id === work.id)!.revision, runner: runnerRef, collector: collectorRef, deadline: new Date(Date.now() + 600_000).toISOString(), maxAttempts: 3 }, randomUUID()) as any;
  return { n, id, request };
}

const validationReport = (f: Awaited<ReturnType<typeof validationFixture>>, behavior: 'passed' | 'failed', command: { requestId: string; attemptId: string; epoch: number }) =>
  ({ ...command, execution: 'completed', behavior, executed: 2, skipped: 0, inventoryComplete: true,
    target: { instance: `instance-${f.n}`, artifacts: [{ service: 'api', digest: bundleDigest }], measurement: 'provider', coversEntireRun: true, attribution: 'matched' },
    bundleDigest, runnerImageDigest: imageDigest, artifacts: [{ name: 'report', digest: bundleDigest, url: 'https://private.example.test/report' }], artifactState: 'verified', executionSettled: true,
    // A trusted pass must exercise its criterion: it holds only beside a stripped run that failed there.
    ...(behavior === 'passed' ? { exercise: { behaviour: 'the behaviour check in the scenario', result: 'fail', executed: 1 } } : {}) });

/** One validated attempt: dispatch, ack, the collection handoff, and the collector's verified result. */
async function runAttempt(f: Awaited<ReturnType<typeof validationFixture>>, behavior: 'passed' | 'failed') {
  const dispatched: any = await validation.dispatch(runner, { registration: { id: `runner-${f.n}`, revision: 1 } }, randomUUID());
  assert.equal(dispatched.request.id, f.request.id);
  const command = { requestId: f.request.id, attemptId: dispatched.attempt.id as string, epoch: dispatched.attempt.epoch as number };
  await validation.runnerCommand(runner, 'ack', command, randomUUID());
  await validation.collectionAuthority(collector, command);
  const key = randomUUID(), report = validationReport(f, behavior, command);
  return { attemptId: command.attemptId, key, report, outcome: await validation.result(collector, report, key) as { accepted: boolean; passed: boolean; reasons?: string[] } };
}

test('unit:test-case-repository — a completed validation attempt followed by a retry records each attempt as its own run', async () => {
  const f = await validationFixture();
  const first = await runAttempt(f, 'passed');
  assert.equal(first.outcome.accepted, true, JSON.stringify(first.outcome)); assert.equal(first.outcome.passed, true);
  let entry = await summary(f.id);
  assert.equal(entry.latest.result, 'pass');
  assert.equal(entry.latest.run.kind, 'validation'); assert.equal(entry.latest.run.id, f.request.id, 'the request is the run identity');
  assert.equal(entry.latest.run.attempt, first.attemptId, 'the attempt is part of the run identity');
  assert.equal(entry.runs, 1); assert.equal(entry.failures, 0);
  // Within one attempt the publish is idempotent: the receipt replays and nothing new appends.
  assert.deepEqual(await validation.result(collector, first.report, first.key), first.outcome);
  assert.equal((await summary(f.id)).runs, 1);
  // The operator retries the settled request under the same request id; the new attempt's result
  // is a second run, so a flip is history — never silently dropped by the first attempt's row.
  await validation.operatorCommand(operator, 'retry', { requestId: f.request.id, epoch: 1, reason: 'Re-run the case after the environment was repaired' }, randomUUID());
  const second = await runAttempt(f, 'failed');
  assert.equal(second.outcome.accepted, true, JSON.stringify(second.outcome)); assert.equal(second.outcome.passed, false);
  const { body } = await history(f.id);
  assert.deepEqual(body.runs.map((row: ScenarioRun) => [row.result, row.run.attempt]), [['fail', second.attemptId], ['pass', first.attemptId]], 'each attempt is its own run, newest first');
  for (const row of body.runs as ScenarioRun[]) {
    assert.equal(row.run.kind, 'validation'); assert.equal(row.run.id, f.request.id);
    assert.equal(row.sha, head); assert.equal(row.baseSha, base); assert.equal(row.pr, pullRequest);
    assert.equal(row.producer, collector.id);
  }
  entry = await summary(f.id);
  assert.equal(entry.latest.result, 'fail', 'the newest attempt decides the current result');
  assert.equal(entry.runs, 2); assert.equal(entry.failures, 1);
  assert.equal(entry.flaky, true); assert.match(entry.flakyReason!, new RegExp(`passed and failed on commit ${head.slice(0, 8)}`));
});
