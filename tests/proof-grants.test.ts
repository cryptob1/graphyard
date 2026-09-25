import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { ProofGrants, authorityRegistry, authorizedForProof, unauthorizedProofs } from '../src/proof-grants.js';
import { grantPatternSchema, grantsAuthorize, proofMatchesGrant, type Principal, type Work } from '../src/model.js';
import { proofAuthorization, proofGaps } from '../src/coordination.js';

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const auditor: Principal = { id: 'auditor', role: 'reader' };
const ci: Principal = { id: 'ci', role: 'producer', proofs: ['integration:seeded-name'] };
const acceptance: Principal = { id: 'acceptance', role: 'producer' };
const principals = [operator, worker, coordinator, auditor, ci, acceptance];
const tokens = new Map(principals.map(p => [p.id, `${p.id}-${'t'.repeat(32)}`]));
const head = 'a'.repeat(40), baseSha = 'b'.repeat(40);

let database: EmbeddedPostgres, store: Store, engine: Engine;
let http: ReturnType<typeof server>, url: string;
const id = () => randomUUID();

before(async () => {
  const port = Number(process.env.GRAPHYARD_GRANT_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 3);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-grants-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('grants_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/grants_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  http = server(engine, principals.map(p => ({ ...p, token: tokens.get(p.id)! })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

async function call(path: string, actor: Principal, data?: unknown) {
  const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${tokens.get(actor.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': id() },
    body: data === undefined ? undefined : JSON.stringify(data) });
  return { status: response.status, body: await response.json() as any };
}
const grant = (actor: Principal, target: string, patterns: string[], reason = 'Authorized by the operator') => call(`proof-grants/${target}/grant`, actor, { patterns, reason });
const revoke = (actor: Principal, target: string, patterns: string[], reason = 'Withdrawn by the operator') => call(`proof-grants/${target}/revoke`, actor, { patterns, reason });
async function workFor(proofs: string[]) {
  return engine.execute(operator, 'create', null, { title: 'Proof authority fixture', criteria: [{ id: 'AC-1', text: 'Behavior is proven', proofs }] }, id()) as Promise<Work>;
}
async function submitEvidence(actor: Principal, work: Work, proof: string) {
  const updated = await engine.execute(actor, 'evidence', work.id, { proof, sha: head, baseSha, policyRevision: work.policyRevision, result: 'pass', executed: 4, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } }, id());
  return updated.evidence.at(-1)!;
}
const trustOf = async (actor: Principal, proof: string) => store.transaction(db => authorizedForProof(db, actor, proof));

// ---------------------------------------------------------------------------
// unit:proof-grant-patterns
// ---------------------------------------------------------------------------
test('unit:proof-grant-patterns an exact grant authorizes only that proof name', () => {
  assert.equal(proofMatchesGrant('integration:claim-safety', 'integration:claim-safety'), true);
  assert.equal(proofMatchesGrant('integration:claim-safety', 'integration:claim-safety-extra'), false);
  assert.equal(proofMatchesGrant('integration:claim-safety', 'unit:claim-safety'), false);
  assert.equal(proofMatchesGrant('integration:claim-safety', 'integration:other'), false);
});

test('unit:proof-grant-patterns a kind wildcard stays inside its own proof kind', () => {
  assert.equal(proofMatchesGrant('integration:*', 'integration:anything/at-all'), true);
  assert.equal(proofMatchesGrant('integration:*', 'unit:anything'), false);
  assert.equal(proofMatchesGrant('manual:*', 'manual:proof-grants-docs-ui'), true);
  assert.equal(proofMatchesGrant('manual:*', 'e2e:proof-grants-docs-ui'), false);
});

test('unit:proof-grant-patterns a bounded prefix authorizes strictly below its own segment', () => {
  assert.equal(proofMatchesGrant('manual:gy-43/*', 'manual:gy-43/docs-ui'), true);
  assert.equal(proofMatchesGrant('manual:gy-43/*', 'manual:gy-43/nested/deeper'), true);
  // The prefix segment itself is not authorized, and a textual sibling is not a child.
  assert.equal(proofMatchesGrant('manual:gy-43/*', 'manual:gy-43'), false);
  assert.equal(proofMatchesGrant('manual:gy-43/*', 'manual:gy-430/docs'), false);
  assert.equal(proofMatchesGrant('manual:gy-43/*', 'manual:gy-43/'), false);
  assert.equal(proofMatchesGrant('integration:a/b/*', 'integration:a/b/c'), true);
  assert.equal(proofMatchesGrant('integration:a/b/*', 'integration:a/other'), false);
});

test('unit:proof-grant-patterns the schema refuses unbounded or malformed authority', () => {
  for (const accepted of ['integration:*', 'unit:claim-safety', 'manual:gy-43/*', 'e2e:a/b/c', 'integration:a.b_c-d'])
    assert.equal(grantPatternSchema.safeParse(accepted).success, true, accepted);
  for (const refused of ['*', '*:*', 'integration:', 'integration:**', 'integration:*/x', 'integration:a*', 'other:*', 'integration:a b', 'integration:a/', ' integration:*'])
    assert.equal(grantPatternSchema.safeParse(refused).success, false, refused);
});

test('unit:proof-grant-patterns a proof is authorized when any single pattern matches', () => {
  const patterns = ['unit:*', 'integration:claim-safety', 'manual:gy-43/*'];
  assert.equal(grantsAuthorize(patterns, 'unit:anything'), true);
  assert.equal(grantsAuthorize(patterns, 'integration:claim-safety'), true);
  assert.equal(grantsAuthorize(patterns, 'manual:gy-43/docs-ui'), true);
  assert.equal(grantsAuthorize(patterns, 'integration:other'), false);
  assert.equal(grantsAuthorize([], 'unit:anything'), false);
});

// ---------------------------------------------------------------------------
// integration:proof-grants-mutation
// ---------------------------------------------------------------------------
test('integration:proof-grants-mutation an operator grant takes effect immediately and is auditable', async () => {
  const proof = 'integration:mutation-live';
  assert.equal(await trustOf(ci, proof), false);
  const granted = await grant(operator, ci.id, [proof]);
  assert.equal(granted.status, 200);
  assert.deepEqual(granted.body.patterns.includes(proof), true);
  assert.equal(granted.body.lastMutation.kind, 'grant');
  assert.equal(granted.body.lastMutation.actor, operator.id);
  // No process restart, no redeploy: the very next authorization decision honors the grant.
  assert.equal(await trustOf(ci, proof), true);
  const work = await workFor([proof]);
  assert.equal((await submitEvidence(ci, work, proof)).trusted, true);
});

test('integration:proof-grants-mutation revocation withdraws authority immediately', async () => {
  const proof = 'integration:mutation-revoked';
  await grant(operator, ci.id, [proof]);
  assert.equal(await trustOf(ci, proof), true);
  const revoked = await revoke(operator, ci.id, [proof], 'Runner decommissioned');
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.patterns.includes(proof), false);
  assert.equal(await trustOf(ci, proof), false);
  const work = await workFor([proof]);
  assert.equal((await submitEvidence(ci, work, proof)).trusted, false);
});

test('integration:proof-grants-mutation bounded patterns authorize a whole lane without naming each proof', async () => {
  await grant(operator, acceptance.id, ['manual:gy-43/*'], 'Designated acceptance witness for GY-43');
  assert.equal(await trustOf(acceptance, 'manual:gy-43/docs-ui'), true);
  assert.equal(await trustOf(acceptance, 'manual:gy-43/second-name-never-configured'), true);
  // The pattern is bounded: it does not leak into a neighboring lane.
  assert.equal(await trustOf(acceptance, 'manual:gy-44/docs-ui'), false);
  assert.equal(await trustOf(acceptance, 'integration:gy-43/anything'), false);
});

test('integration:proof-grants-mutation every change appends immutable history and an event', async () => {
  await grant(operator, acceptance.id, ['unit:history-probe'], 'First authority');
  await revoke(operator, acceptance.id, ['unit:history-probe'], 'Withdrawn after the run');
  const history = (await call(`proof-grants/${acceptance.id}/history`, operator)).body as any[];
  const probe = history.filter(row => row.patterns.includes('unit:history-probe'));
  assert.deepEqual(probe.map(row => row.kind), ['grant', 'revoke']);
  assert.deepEqual(probe.map(row => row.reason), ['First authority', 'Withdrawn after the run']);
  assert.equal(probe.every(row => row.actor === operator.id), true);
  // Revisions are monotonic and prior rows are never rewritten.
  assert.deepEqual(history.map(row => row.revision), history.map(row => row.revision).sort((a, b) => a - b));
  await assert.rejects(store.pool.query('DELETE FROM proof_grant_history WHERE principal_id=$1', [acceptance.id]), /append-only/);
  const events = (await store.pool.query("SELECT actor,kind,payload FROM events WHERE kind LIKE 'proof-grant.%' ORDER BY seq")).rows;
  assert.equal(events.some(row => row.kind === 'proof-grant.grant' && row.payload.target === acceptance.id), true);
  assert.equal(events.some(row => row.kind === 'proof-grant.revoke' && row.payload.target === acceptance.id), true);
});

test('integration:proof-grants-mutation refuses non-operators, unknown principals, and malformed authority', async () => {
  for (const actor of [worker, coordinator, auditor, ci]) {
    const attempt = await grant(actor, ci.id, ['integration:self-service']);
    assert.equal(attempt.status, 403, `${actor.role} must not grant proof authority`);
  }
  assert.equal((await grant(operator, 'nobody', ['integration:anything'])).status, 404);
  assert.equal((await grant(operator, ci.id, ['*'])).status, 400);
  assert.equal((await grant(operator, ci.id, [])).status, 400);
  // A revoke names an exact recorded pattern; it never silently succeeds as a no-op.
  assert.equal((await revoke(operator, ci.id, ['integration:never-granted'])).status, 409);
});

test('integration:proof-grants-mutation replays idempotently and refuses a stale expected revision', async () => {
  const key = id();
  const request = (body: unknown) => fetch(`${url}/api/proof-grants/${ci.id}/grant`, { method: 'POST',
    headers: { Authorization: `Bearer ${tokens.get(operator.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  const payload = { patterns: ['integration:idempotent-probe'], reason: 'Replay probe' };
  const first = await (await request(payload)).json() as any;
  const replay = await (await request(payload)).json() as any;
  assert.deepEqual(replay, first);
  const conflict = await request({ ...payload, reason: 'Different input' });
  assert.equal(conflict.status, 409);
  const stale = await call(`proof-grants/${ci.id}/grant`, operator, { patterns: ['integration:stale-probe'], reason: 'Stale revision', expectedRevision: 0 });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /revision changed/i);
});

// ---------------------------------------------------------------------------
// integration:proof-grants-enforcement
// ---------------------------------------------------------------------------
test('integration:proof-grants-enforcement worker, reader, and coordinator can never receive a grant', async () => {
  for (const actor of [worker, auditor, coordinator]) {
    const attempt = await grant(operator, actor.id, ['integration:escalation']);
    assert.equal(attempt.status, 403, `${actor.role} must never hold proof authority`);
    assert.match(attempt.body.error, /never hold proof authority/);
    assert.equal(await trustOf(actor, 'integration:escalation'), false);
  }
  // Even the credential-level trust decision refuses these roles outright.
  const work = await workFor(['integration:escalation']);
  const submitted = await submitEvidence(worker, work, 'integration:escalation');
  assert.equal(submitted.trusted, false);
  assert.equal(submitted.producer, worker.id);
});

test('integration:proof-grants-enforcement the manual operator lane is a role, not a grantable authority', async () => {
  const attempt = await grant(operator, operator.id, ['integration:operator-widening']);
  assert.equal(attempt.status, 403);
  assert.match(attempt.body.error, /producer principals/);
  assert.equal(await trustOf(operator, 'manual:operator-witness'), true);
  assert.equal(await trustOf(operator, 'integration:operator-widening'), false);
});

test('integration:proof-grants-enforcement evidence for an ungranted name is recorded but never trusted', async () => {
  const proof = 'integration:enforcement-ungranted';
  const work = await workFor([proof]);
  const untrusted = await submitEvidence(ci, work, proof);
  assert.equal(untrusted.trusted, false);
  await grant(operator, ci.id, [proof]);
  const current = (await store.list()).find(w => w.id === work.id)!;
  const trusted = await submitEvidence(ci, current, proof);
  assert.equal(trusted.trusted, true);
  // The earlier untrusted row is retained for audit rather than rewritten.
  const rows = (await store.list()).find(w => w.id === work.id)!.evidence.filter(e => e.proof === proof);
  assert.deepEqual(rows.map(e => e.trusted), [false, true]);
});

test('integration:proof-grants-enforcement the environment allowlist is a bootstrap seed only', async () => {
  const seedOnly: Principal = { id: 'seeded-producer', role: 'producer', proofs: ['integration:seed-a'] };
  const bootstrap = new ProofGrants(store, [operator, seedOnly]);
  // Before materialization the environment allowlist still decides, so a deployment keeps working.
  assert.equal(await trustOf(seedOnly, 'integration:seed-a'), true);
  const seeded = await bootstrap.seed();
  assert.deepEqual(seeded.map(record => record.principalId), [seedOnly.id]);
  assert.deepEqual(seeded[0].patterns, ['integration:seed-a']);
  assert.equal(seeded[0].seededFrom.includes('integration:seed-a'), true);
  // Revoking a seeded name takes effect with no redeploy, even though this process still
  // holds the original environment value, and a later restart never resurrects it.
  await bootstrap.revoke(operator, seedOnly.id, { patterns: ['integration:seed-a'], reason: 'Environment authority withdrawn inside Graphyard' }, id());
  assert.equal(await trustOf(seedOnly, 'integration:seed-a'), false);
  assert.deepEqual(await bootstrap.seed(), []);
  assert.equal(await trustOf(seedOnly, 'integration:seed-a'), false);
  // An environment edit after materialization confers nothing; only a grant does.
  const widened: Principal = { ...seedOnly, proofs: ['integration:seed-a', 'integration:seed-b'] };
  assert.equal(await trustOf(widened, 'integration:seed-b'), false);
});

test('integration:proof-grants-enforcement the live authority registry excludes every ungrantable role', async () => {
  const registry = await store.transaction(db => authorityRegistry(db, principals));
  assert.equal(registry.some(entry => entry.principalId === worker.id), false);
  assert.equal(registry.some(entry => entry.principalId === coordinator.id), false);
  assert.equal(registry.find(entry => entry.principalId === operator.id)?.patterns.join(), 'manual:*');
  assert.equal(registry.find(entry => entry.principalId === ci.id)?.source, 'grant');
});

// ---------------------------------------------------------------------------
// integration:proof-grants-gap-report
// ---------------------------------------------------------------------------
test('integration:proof-grants-gap-report work creation names every proof with no authorized producer', async () => {
  const covered = 'integration:gap-covered', orphan = 'integration:gap-orphan';
  await grant(operator, ci.id, [covered]);
  const work = await workFor([covered, orphan, 'manual:gap-witness']);
  // The manual lane is covered by the operator role; only the orphan is unproducible.
  assert.deepEqual(work.proofGaps, [orphan]);
});

test('integration:proof-grants-gap-report a manual proof a producer must run is a gap until a producer holds it, whatever the admin role covers', async () => {
  const proof = 'manual:gap-producer-lane';
  const create = () => engine.execute(operator, 'create', null, { title: 'Producer lane fixture', producerProofs: [proof],
    criteria: [{ id: 'AC-1', text: 'Behavior is proven', proofs: [proof, 'manual:gap-attested'] }] }, id()) as Promise<Work>;
  const work = await create();
  // The attested manual proof stays covered by the operator role; the producer lane is not.
  assert.deepEqual(work.proofGaps, [proof]);
  await grant(operator, acceptance.id, [proof]);
  assert.deepEqual((await create()).proofGaps, []);
  const revised = await engine.execute(operator, 'requirements', work.id, {
    expectedPolicyRevision: work.policyRevision, reason: 'Restate the outcome after granting the producer lane', producerProofs: [proof],
    criteria: [{ id: 'AC-1', text: 'Behavior is proven', proofs: [proof] }], dependencies: [], plannedFiles: [], exclusiveResources: [],
  }, id()) as Work;
  assert.deepEqual(revised.proofGaps, []);
});

test('integration:proof-grants-gap-report closing the gap with a grant clears it on the next intent revision', async () => {
  const proof = 'integration:gap-closing';
  const work = await workFor([proof]);
  assert.deepEqual(work.proofGaps, [proof]);
  await grant(operator, ci.id, [proof]);
  const revised = await engine.execute(operator, 'requirements', work.id, {
    expectedPolicyRevision: work.policyRevision, reason: 'Restate the outcome after granting proof authority',
    criteria: [{ id: 'AC-1', text: 'Behavior is proven', proofs: [proof] }], dependencies: [], plannedFiles: [], exclusiveResources: [],
  }, id());
  assert.deepEqual(revised.proofGaps, []);
});

test('integration:proof-grants-gap-report a policy-required post-deployment proof is reported like a criterion proof', async () => {
  const covered = 'integration:gap-smoke-covered';
  await grant(operator, ci.id, [covered]);
  const create = (deploySmoke: boolean) => engine.execute(operator, 'create', null, { title: 'Smoke authority fixture', policy: { checks: ['test'], review: true, deploySmoke },
    criteria: [{ id: 'AC-1', text: 'Behavior is proven', proofs: [covered] }] }, id()) as Promise<Work>;
  assert.deepEqual((await create(false)).proofGaps, []);
  const work = await create(true);
  assert.deepEqual(work.proofGaps, ['e2e:deploy-smoke'], 'nobody can produce the smoke proof the policy asks for');
  await grant(operator, ci.id, ['e2e:deploy-smoke']);
  const revised = await engine.execute(operator, 'requirements', work.id, {
    expectedPolicyRevision: work.policyRevision, reason: 'Restate the outcome after granting smoke authority',
    criteria: [{ id: 'AC-1', text: 'Behavior is proven', proofs: [covered] }], dependencies: [], plannedFiles: [], exclusiveResources: [],
  }, id()) as Work;
  assert.deepEqual(revised.proofGaps, []);
});

test('integration:proof-grants-gap-report the live registry reports who may produce each required proof', async () => {
  const proof = 'integration:gap-live-registry';
  await grant(operator, ci.id, [proof]);
  const work = await workFor([proof, 'manual:gap-live-witness', 'unit:gap-live-orphan']);
  const authorities = await store.transaction(db => authorityRegistry(db, principals));
  const report = proofAuthorization(work, authorities);
  assert.deepEqual(report.find(entry => entry.proof === proof)?.producers, [ci.id]);
  assert.deepEqual(report.find(entry => entry.proof === 'manual:gap-live-witness')?.producers, [operator.id]);
  assert.deepEqual(proofGaps(work, authorities), ['unit:gap-live-orphan']);
  assert.deepEqual(await store.transaction(db => unauthorizedProofs(db, principals, [proof, 'unit:gap-live-orphan'])), ['unit:gap-live-orphan']);
});

test('integration:proof-grants-gap-report the operator dashboard reads the same live authority set', async () => {
  const read = await call('proof-grants', operator);
  assert.equal(read.status, 200);
  assert.equal(read.body.authorities.some((entry: any) => entry.principalId === ci.id && entry.source === 'grant'), true);
  assert.equal(read.body.authorities.some((entry: any) => entry.principalId === worker.id), false);
  // A producer sees only its own authority; an operator agent is refused outright.
  const own = await call('proof-grants', ci);
  assert.deepEqual(own.body.authorities.map((entry: any) => entry.principalId), [ci.id]);
  assert.equal((await call('proof-grants', auditor)).status, 200);
});
