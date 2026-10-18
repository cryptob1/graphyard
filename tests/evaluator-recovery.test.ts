import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { Validation, type ValidationRequest } from '../src/validation.js';
import { currentEvidence, evaluateWithRecovery, evaluationRetries, evaluationRetryBackoffMs, type Principal, type ScopeFile, type Work } from '../src/model.js';
import type { ReplayRecord } from '../src/evidence-replay.js';
import type { ArtifactBackend } from '../src/artifacts.js';
import { defineScenario } from '../src/scenarios.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1841: evaluator recovery. Judging a proof's retained evidence is an evaluation the pinned
 * verifier performs, and it can end for reasons that are not the change's — the artifacts were
 * never retained, the bytes cannot be read, the verifier crashed. The explicit rule of
 * model/evidence.ts retries such an evaluator-error against the same retained evidence at most
 * twice with a widening backoff, never against new evidence; a fail the verifier reached is never
 * retried; a pass on any attempt is the evaluation's result; every attempt is kept with its
 * outcome, cause and time; and after the retries are exhausted the record carries the evaluator
 * errors as a fault — never a failed proof. Everything runs against a disposable real Postgres
 * database; the artifact backend is an in-memory double whose reads the tests fault on purpose.
 */
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const runner: Principal = { id: 'runner', role: 'worker' };
const collector: Principal = { id: 'collector', role: 'producer', proofs: [] };
const builder: Principal = { id: 'builder', role: 'producer' };
const reader: Principal = { id: 'auditor', role: 'reader' };
const principals = [operator, worker, runner, collector, builder, reader];
const attestationPublicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
const sha = (label: string) => label.repeat(40).slice(0, 40);
const head = sha('1'), base = sha('b');
const digest = `sha256:${'c'.repeat(64)}`, inputs = `sha256:${'d'.repeat(64)}`;
let pg: EmbeddedPostgres, store: Store, engine: Engine, validation: Validation;
let serial = 0;
/** The recovery rule's retry waits on the proof-result path, recorded instead of slept. */
const waits: number[] = [];

before(async () => {
  const port = Number(process.env.GRAPHYARD_EVALUATOR_RECOVERY_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1841);
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('evaluator-recovery'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('evaluator_recovery_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/evaluator_recovery_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'test/repository'); validation = new Validation(engine, principals, 'test/repository');
  validation.evaluationRecovery = { sleep: async ms => { waits.push(ms); } };
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });
const id = () => randomUUID();
async function current(workId: string) { return (await store.list()).find(w => w.id === workId)!; }

/** An in-memory artifact backend whose reads a test can fault: each failure is one host fault, named per call. */
class FaultyBackend implements ArtifactBackend {
  readonly kind = 's3' as const;
  readonly label = 'memory/faulty';
  readonly objects = new Map<string, Buffer>();
  readonly reads: string[] = [];
  failures = 0;
  /** Locations whose every read throws, whatever `failures` holds. */
  readonly broken = new Set<string>();
  /** Database sessions holding an open transaction, sampled at each read. */
  readonly openTransactions: number[] = [];
  async put(location: string, bytes: Buffer) { this.objects.set(location, bytes); }
  async get(location: string) {
    this.reads.push(location);
    this.openTransactions.push(Number((await store.pool.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state LIKE 'idle in transaction%'")).rows[0].count));
    if (this.failures > 0 || this.broken.has(location)) { this.failures = Math.max(0, this.failures - 1); throw new Error(`host fault ${this.reads.length}`); }
    return this.objects.get(location) ?? null;
  }
  async delete(location: string) { this.objects.delete(location); }
  async exists(location: string) { return this.objects.has(location); }
}

type Fixture = { n: number; w: Work; r: ValidationRequest; proof: string; environment: { id: string; revision: number }; runnerRef: { id: string; revision: number }; collectorRef: { id: string; revision: number }; builderRef: { id: string; revision: number }; bundle: { id: string; revision: number }; backend: FaultyBackend };
const file = (path: string, label: string | null): ScopeFile => ({ path, status: 'modified', sha: label === null ? null : sha(label), additions: 1, deletions: 0, binary: false });
const files = [file('src/app.ts', 'a')];

async function fixture(): Promise<Fixture> {
  const n = ++serial;
  const environment = { id: `preview-${n}`, revision: 1 }, runnerRef = { id: `runner-${n}`, revision: 1 }, collectorRef = { id: `collector-${n}`, revision: 1 }, builderRef = { id: `builder-${n}`, revision: 1 }, bundle = { id: `bundle-${n}`, revision: 1 }, proof = `e2e:recovery-${n}`;
  collector.proofs!.push(proof);
  const scenario = await defineScenario(store, operator, { id: `recovery-${n}`, title: 'Behavior', purpose: 'Prove behavior', steps: ['Execute'], expected: ['Correct'], environment: environment.id, runner: 'playwright', testPath: 'tests/behavior.spec.ts' }, id());
  await validation.define(operator, { kind: 'environment', id: environment.id, expectedRevision: 0, repository: 'test/repository', url: 'https://preview.example.test', instance: `instance-${n}`, immutable: true, services: ['api'], resources: [`test-account-${n}`] }, id());
  for (const [ref, actor, role] of [[runnerRef, runner, 'runner'], [collectorRef, collector, 'collector'], [builderRef, builder, 'builder']] as const) await validation.define(operator, { kind: 'registration', id: ref.id, expectedRevision: 0, principalId: actor.id, role, environment, adapterVersion: 'test-v1', proofs: role === 'collector' ? [proof] : [], enabled: true, ...(role === 'runner' ? { executionHost: 'unix:///var/run/docker.sock', attestationPublicKey, executionNetwork: 'gy-isolated' } : {}) }, id());
  await validation.define(operator, { kind: 'bundle', id: bundle.id, expectedRevision: 0, scenario: scenario.id, scenarioRevision: scenario.revision, scenarioHash: scenario.hash, digest, runnerImageDigest: inputs, reportFormat: 'graphyard-playwright-v1' }, id());
  let w = await engine.execute(operator, 'create', null, { title: `Evaluator recovery ${n}`, criteria: [{ id: 'AC-1', text: 'Behavior is proven', proofs: [proof] }] }, id());
  w = await engine.execute(operator, 'ready', w.id, {}, id()); w = await engine.execute(worker, 'claim', w.id, {}, id());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/recovery-${n}`, branch: `graphyard/recovery-${n}` }, id());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: n }, id());
  w = await engine.observe(w.id, w.revision, { candidate: { sha: head, baseSha: base, pr: n, branch: `graphyard/recovery-${n}`, author: 'implementer' }, checks: [{ name: 'test', appId: 15368, result: 'success' }, { name: 'typecheck', appId: 15368, result: 'success' }], reviews: [{ reviewer: 'other', sha: head, state: 'APPROVED' }], merged: false, mergeSha: null, protected: true, mergeable: true, files: files.map(f => f.path), at: new Date().toISOString(), scopeFiles: files }) as Work;
  const build = await validation.attestBuild(builder, { registration: builderRef, workId: w.id, expectedWorkRevision: w.revision, sourceSha: head, baseSha: base, buildInputsDigest: inputs, artifacts: [{ service: 'api', digest }], provenanceUrl: 'https://ci.example.test/build/1' }, id()) as { id: string };
  const backend = new FaultyBackend();
  validation.artifactBackend = backend;
  const c = await validation.createCandidate(operator, { workId: w.id, expectedWorkRevision: (await current(w.id)).revision, proof, environment, bundle, buildAttestationId: build.id, requiredArtifacts: ['inventory', 'report'], artifactStorage: 'postgres' }, id()) as { id: string };
  const r = await validation.createRequest(operator, { candidateId: c.id, expectedWorkRevision: (await current(w.id)).revision, runner: runnerRef, collector: collectorRef, deadline: new Date(Date.now() + 600_000).toISOString(), maxAttempts: 3 }, id()) as ValidationRequest;
  return { n, w, r, proof, environment, runnerRef, collectorRef, builderRef, bundle, backend };
}

/** Dispatch the fixture's request, acknowledge it and hand collection to the collector. */
async function start(f: Fixture) {
  const d: any = await validation.dispatch(runner, { registration: f.runnerRef }, id()); assert.equal(d.request?.id, f.r.id, d.reason);
  const command = { requestId: d.request.id as string, attemptId: d.attempt.id as string, epoch: d.attempt.epoch as number };
  await validation.runnerCommand(runner, 'ack', command, id());
  await validation.collectionAuthority(collector, command);
  return command;
}

const playwrightDocument = (executed: boolean, failed = false) => ({ format: 'graphyard-playwright-v1', declared: [{ id: 'a'.repeat(64), expected: 'passed', location: { file: 'tests/behavior.spec.ts', line: 1, column: 1 } }, { id: 'b'.repeat(64), expected: 'passed', location: { file: 'tests/behavior.spec.ts', line: 9, column: 1 } }],
  executions: executed ? [{ id: 'a'.repeat(64), status: failed ? 'failed' : 'passed', retry: 0 }, { id: 'b'.repeat(64), status: 'passed', retry: 0 }] : [], steps: [], errors: 0, overflow: false, status: failed ? 'failed' : 'passed' });
const upload = (command: { requestId: string; attemptId: string; epoch: number }, name: string, document: unknown) => ({ ...command, name, mediaType: 'application/json', bytes: Buffer.from(JSON.stringify(document)).toString('base64'), capturePolicy: 'approved-test-data-only' });

/** Retain both artifacts for the attempt and have the collector claim the pass; `failures` faults that many backend reads of the result's own evaluation. */
async function retain(f: Fixture, command: Awaited<ReturnType<typeof start>>, report = playwrightDocument(true), options: { failures?: number; skipped?: number; expect?: boolean; tamper?: (backend: FaultyBackend) => void } = {}) {
  const inventory: any = await validation.uploadArtifact(collector, upload(command, 'inventory', playwrightDocument(false)), id());
  const executed: any = await validation.uploadArtifact(collector, upload(command, 'report', report), id());
  options.tamper?.(f.backend);
  f.backend.failures = options.failures ?? 0;
  const result: any = await validation.result(collector, { ...command, execution: 'completed', behavior: 'passed', executed: 2, skipped: options.skipped ?? 0, inventoryComplete: true, target: { instance: `instance-${f.n}`, artifacts: [{ service: 'api', digest }], measurement: 'provider', coversEntireRun: true, attribution: 'matched' }, bundleDigest: digest, runnerImageDigest: inputs, artifacts: [{ name: 'inventory', digest: inventory.digest, url: inventory.url }, { name: 'report', digest: executed.digest, url: executed.url }], artifactState: 'verified', executionSettled: true, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } }, id());
  if (options.expect ?? true) assert.equal(result.passed, true, result.reasons.join('; '));
  f.backend.failures = 0;
  return { inventory, executed, result };
}
/** The request's last attempt, as the store holds it. */
async function storedAttempt(requestId: string) { return (await store.pool.query('SELECT document FROM validation_requests WHERE id=$1', [requestId])).rows[0].document.attempts.at(-1); }

test('unit:evaluator-error-retried — an evaluator-error is retried against the same retained evidence at most twice, a fail is never retried, and a pass on retry is the result', async () => {
  // The rule itself, without a database: exactly two retries at most, with the widening backoff.
  const ruleWaits: number[] = [];
  const exhausted = await evaluateWithRecovery('graphyard-playwright-v1', async () => ({ error: 'the evaluator crashed' }), { sleep: async ms => { ruleWaits.push(ms); } });
  assert.equal(exhausted.attempts.length, evaluationRetries + 1, 'the first attempt plus at most two retries');
  assert.deepEqual(ruleWaits, [evaluationRetryBackoffMs, evaluationRetryBackoffMs * 2]);
  let judged = 0;
  const failed = await evaluateWithRecovery('graphyard-playwright-v1', async () => { judged++; return 'fail'; }, { sleep: async () => assert.fail('a fail is never retried') });
  assert.equal(failed.outcome, 'fail'); assert.equal(failed.attempts.length, 1); assert.equal(judged, 1); assert.equal(failed.fault, null);
  const recovered = await evaluateWithRecovery('graphyard-playwright-v1', async () => judged++ === 1 ? { error: 'once' } : 'pass', { sleep: async () => {} });
  assert.equal(recovered.outcome, 'pass'); assert.equal(recovered.attempts.length, 2); assert.equal(recovered.fault, null);
  const crashed = await evaluateWithRecovery('graphyard-playwright-v1', () => { throw new Error('the evaluator crashed'); }, { retries: 0, sleep: async () => {} });
  assert.equal(crashed.outcome, 'evaluator-error'); assert.equal(crashed.attempts.length, 1); assert.equal(crashed.attempts[0].cause, 'the evaluator crashed');

  // Against a real attempt: a host fault on the first read is an evaluator-error, and the retry
  // judges the same retained evidence — the same two pinned artifacts, no new evidence — to a pass.
  const f = await fixture();
  const command = await start(f);
  await retain(f, command);
  f.backend.reads.length = 0; // the result's own evaluation read the set once; count the replay's reads alone
  f.backend.failures = 1; // the first read of the first artifact throws: the host ran out of resources
  const replay = await validation.replay.replay(reader, { requestId: command.requestId, attemptId: command.attemptId }) as ReplayRecord;
  assert.equal(replay.evaluation.attempts.length, 2, JSON.stringify(replay.evaluation));
  assert.equal(replay.evaluation.attempts[0].outcome, 'evaluator-error');
  assert.match(replay.evaluation.attempts[0].cause!, /Backend read failed: host fault/);
  assert.equal(replay.evaluation.attempts[1].outcome, 'pass'); assert.equal(replay.evaluation.attempts[1].cause, null);
  assert.equal(replay.evaluation.outcome, 'pass', 'a pass on retry is the evaluation’s result');
  assert.equal(replay.evaluation.fault, null);
  assert.equal(replay.outcome, 'consistent', JSON.stringify(replay.differences));
  assert.equal(replay.verification?.passed, true);
  assert.equal(replay.coverage.behavior.status, 'covered');
  assert.equal(f.backend.reads.length, 4, 'two reads per attempt: the faulted one and its retry');
  assert.equal(new Set(f.backend.reads).size, 2, 'only the two retained artifacts were ever read — the same pinned evidence, never new evidence');
  // The replay's cost is every attempt's I/O: the faulted attempt still read the second artifact.
  const finalBytes = replay.artifacts.reduce((sum, x) => sum + x.bytes, 0);
  assert.equal(replay.cost.artifactsRead, 3, 'one read in the faulted attempt plus two in its retry');
  assert.equal(replay.cost.bytesRead, finalBytes + replay.artifacts.find(x => x.name !== replay.artifacts[0].name)!.bytes, JSON.stringify(replay.cost));

  // A verdict the verifier reached is not retried, whatever it disagrees with: one attempt, one fail.
  const g = await fixture();
  const gCommand = await start(g);
  await retain(g, gCommand, playwrightDocument(true, true));
  const contradiction = await validation.replay.replay(reader, { requestId: gCommand.requestId, attemptId: gCommand.attemptId }) as ReplayRecord;
  assert.equal(contradiction.outcome, 'inconsistent');
  assert.equal(contradiction.evaluation.attempts.length, 1, 'a fail is a verdict on the change and is never retried');
  assert.equal(contradiction.evaluation.attempts[0].outcome, 'fail'); assert.equal(contradiction.evaluation.attempts[0].cause, null);
  assert.equal(contradiction.evaluation.outcome, 'fail'); assert.equal(contradiction.evaluation.fault, null);
  assert.match(contradiction.differences.join('\n'), /Replayed verdict failed but the collector reported behavior passed/);

  // The authorized proof-result path: the collector's result is itself evaluated under the rule.
  // A host fault while reading the retained evidence is an evaluator-error; the retry re-reads the
  // same pinned rows and its pass is the proof's result — the item's trusted pass evidence.
  const p = await fixture();
  const pCommand = await start(p);
  waits.length = 0;
  const { result: recoveredResult } = await retain(p, pCommand, playwrightDocument(true), { failures: 1 });
  assert.equal(recoveredResult.passed, true);
  const proven = currentEvidence(await current(p.w.id), p.proof)!;
  assert.equal(proven.result, 'pass', 'the pass on retry is the proof’s result');
  assert.equal(proven.trusted, true);
  assert.equal(proven.evaluation?.outcome, 'pass');
  assert.deepEqual(proven.evaluation?.attempts.map(x => x.outcome), ['evaluator-error', 'pass']);
  assert.match(proven.evaluation!.attempts[0].cause!, /Backend read of inventory failed: host fault/);
  assert.deepEqual(waits, [evaluationRetryBackoffMs], 'one retry, spaced by the first backoff');
  assert.equal(new Set(p.backend.reads).size, 2, 'the retry read the same two pinned artifacts, never new evidence');
  assert.equal((await current(p.w.id)).validation?.[p.proof]?.fault, undefined);
  // The reads and the backoff between them happen before the result's coordination transaction:
  // no database session holds a transaction open while the artifact store is read.
  assert.deepEqual(p.backend.openTransactions.slice(-3), [0, 0, 0], 'an artifact-store wait never holds a database connection');

  // A fail the collector's result earns is a verdict and is never retried, even with the host
  // faulting every read: the report's own fail stands, never replaced by the read fault.
  const q = await fixture();
  const qCommand = await start(q);
  const { result: failedResult } = await retain(q, qCommand, playwrightDocument(true), { skipped: 1, expect: false, failures: Number.MAX_SAFE_INTEGER });
  assert.equal(failedResult.passed, false); assert.equal(failedResult.fault, undefined);
  const refuted = currentEvidence(await current(q.w.id), q.proof)!;
  assert.equal(refuted.result, 'fail');
  assert.equal((await current(q.w.id)).validation?.[q.proof]?.fault, undefined);
  assert.deepEqual(refuted.evaluation?.attempts.map(x => x.outcome), ['fail'], 'a fail is judged once');
  assert.equal((await storedAttempt(qCommand.requestId)).evaluation.attempts.length, 1);

  // A digest fail on an earlier artifact is a verdict the evaluator reached: a read error on a
  // later artifact neither retries it nor replaces it with an evaluator fault.
  const m = await fixture();
  const mCommand = await start(m);
  waits.length = 0;
  const { result: mixedResult } = await retain(m, mCommand, playwrightDocument(true), { expect: false, tamper: backend => {
    const [inventoryAt, reportAt] = [...backend.objects.keys()];
    backend.objects.set(inventoryAt, Buffer.from('tampered inventory bytes'));
    backend.broken.add(reportAt);
  } });
  assert.equal(mixedResult.passed, false); assert.equal(mixedResult.fault, undefined);
  assert.match(mixedResult.reasons.join('\n'), /Private artifact inventory bytes fail the digest recorded at upload/);
  const mixed = currentEvidence(await current(m.w.id), m.proof)!;
  assert.equal(mixed.result, 'fail', 'the established digest fail is the proof’s result');
  assert.deepEqual(mixed.evaluation?.attempts.map(x => x.outcome), ['fail'], 'the digest fail is judged once, never retried');
  assert.equal((await current(m.w.id)).validation?.[m.proof]?.fault, undefined);
  assert.deepEqual(waits, [], 'no retry backoff after a reached fail');
  assert.equal(m.backend.reads.length, 1, 'nothing after the failing artifact is read');
});

test('unit:evaluation-attempts-kept — every attempt is kept with its outcome, cause and time, and exhausted retries leave the evaluator errors as a fault, never a failed proof', async () => {
  const f = await fixture();
  const command = await start(f);
  await retain(f, command);
  const before = await current(f.w.id);
  f.backend.failures = Number.MAX_SAFE_INTEGER; // the host never recovers within this evaluation
  const replay = await validation.replay.replay(reader, { requestId: command.requestId, attemptId: command.attemptId }) as ReplayRecord;
  // Every attempt is appended, none overwritten: three distinct records, each with its outcome, cause and time.
  assert.equal(replay.evaluation.attempts.length, evaluationRetries + 1, JSON.stringify(replay.evaluation));
  assert.ok(replay.evaluation.attempts.every(try_ => try_.outcome === 'evaluator-error'), 'no attempt was judged');
  assert.ok(replay.evaluation.attempts.every(try_ => typeof try_.at === 'string' && try_.at.length > 0), 'each attempt carries its time');
  assert.ok(replay.evaluation.attempts.every((try_, index) => index === 0 || Date.parse(replay.evaluation.attempts[index].at) >= Date.parse(replay.evaluation.attempts[index - 1].at)));
  assert.deepEqual(replay.evaluation.attempts.map(try_ => try_.evaluator), replay.evaluation.attempts.map(() => 'graphyard-playwright-v1'), 'each attempt names the pinned evaluator');
  const causes = new Set(replay.evaluation.attempts.map(try_ => try_.cause));
  assert.equal(causes.size, replay.evaluation.attempts.length, 'each attempt kept its own cause, none overwritten');
  for (const attempt of replay.evaluation.attempts) assert.match(attempt.cause!, /Backend read failed: host fault/);
  // After the retries the item shows the evaluator errors as a fault, not a failed proof.
  assert.equal(replay.evaluation.outcome, 'evaluator-error');
  assert.deepEqual(replay.evaluation.fault, { kind: 'evaluator-error', errors: replay.evaluation.attempts.map(try_ => try_.cause) });
  assert.equal(replay.outcome, 'unmeasured', 'the record is a fault of the evaluation, never a verdict');
  assert.equal(replay.verification, null);
  assert.match(replay.coverage.behavior.reason, /lack the instrumentation to replay/);
  const after = await current(f.w.id);
  assert.equal(after.evidence.length, before.evidence.length, 'the faulting evaluation appends nothing to the item');
  assert.ok(after.evidence.every(entry => entry.result !== 'fail'), 'no failed proof was recorded');
  assert.equal(after.revision, before.revision);
  const analytics = await validation.replay.analytics();
  assert.ok(analytics.replays.faults >= 1, 'the exhausted evaluation is counted as a fault');

  // The authorized proof-result path: exhausted retries on the collector's own result are the
  // item's fault on its proof selection, every attempt kept, and no failed proof is recorded.
  const h = await fixture();
  const hCommand = await start(h);
  waits.length = 0;
  const hBefore = await current(h.w.id);
  const { result } = await retain(h, hCommand, playwrightDocument(true), { failures: Number.MAX_SAFE_INTEGER, expect: false });
  assert.equal(result.passed, false);
  assert.equal(result.fault.kind, 'evaluator-error');
  assert.equal(result.fault.errors.length, evaluationRetries + 1);
  assert.deepEqual(waits, [evaluationRetryBackoffMs, evaluationRetryBackoffMs * 2]);
  const hAfter = await current(h.w.id);
  // No evidence at all: the errors are a fault of the evaluation, never a failed proof.
  assert.equal(hAfter.evidence.length, hBefore.evidence.length);
  assert.equal(currentEvidence(hAfter, h.proof), undefined);
  const fault = hAfter.validation?.[h.proof]?.fault;
  assert.ok(fault, 'the item reports the evaluator errors as a fault on its proof selection');
  assert.equal(fault.kind, 'evaluator-error');
  assert.equal(fault.requestId, hCommand.requestId); assert.equal(fault.attemptId, hCommand.attemptId);
  assert.equal(fault.attempts.length, evaluationRetries + 1);
  assert.ok(fault.attempts.every(x => x.outcome === 'evaluator-error' && x.evaluator === 'graphyard-playwright-v1' && typeof x.at === 'string' && /Backend read of inventory failed: host fault/.test(x.cause!)));
  assert.equal(new Set(fault.attempts.map(x => x.cause)).size, fault.attempts.length, 'every attempt kept its own cause');
  assert.deepEqual(fault.errors, fault.attempts.map(x => x.cause));
  // The proof record of the attempt keeps every evaluation attempt too.
  const attempt = await storedAttempt(hCommand.requestId);
  assert.deepEqual(attempt.evaluation.attempts, fault.attempts);
  assert.deepEqual(attempt.evaluation.fault, { kind: 'evaluator-error', errors: fault.errors });
  const events = (await store.pool.query("SELECT kind FROM events WHERE work_id=$1 AND kind='validation.evaluation-fault'", [h.w.id])).rows;
  assert.equal(events.length, 1);
  // Operator analytics read the same attempt as an evaluator fault, never a failed proof.
  const live = (await validation.replay.analytics()).groups.find(g => g.proof === h.proof)!;
  assert.ok(live.outcomes.evaluatorError >= 1, JSON.stringify(live.outcomes));
  assert.equal(live.outcomes.failed, 0, 'an exhausted evaluation is not counted as a failed proof');
});
