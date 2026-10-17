import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { Validation } from '../src/validation.js';
import { principalSchema, server } from '../src/server.js';
import { delegationLimitDrift } from '../src/delegation.js';
import { authorizedForProof, effectiveAuthority } from '../src/proof-grants.js';
import { deliveryState } from '../src/model/delivery.js';
import { deliveryLabel, deliveryOutcome } from '../src/model/format.js';
import type { Observation, Principal, Work } from '../src/model.js';
import { principalCommand } from '../src/cli/install.js';
import { applyInstall, buildPlan, prepareInstall } from '../src/install/index.js';
import { fingerprint, reconcileRoster, rosterEntry, tokenFile } from '../src/install/secrets.js';
import { externalRunsImportGrant, observeShaGrant } from '../src/server/principals.js';
import { freePort } from '../src/cli/test-isolation.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { recordLegacyMerger } from './helpers/legacy-merger.js';
import { deployedRoster, harness, REPOSITORY, type Harness } from './install-harness.js';

// GY-1912: a dedicated producer holding only delivery:observe-sha records which commit production
// serves through the GY-1861 endpoint, and nothing else: it imports no run, submits no proof, reads
// no ledger and holds no reviewer slot. Deployed is what its observation can say; Production verified
// still needs an independently authorized, applicable passing smoke at the exact observed release.

const observer: Principal = { id: 'huck-observer', role: 'producer', sessionKind: 'ai', grants: [observeShaGrant] };
const importer: Principal = { id: 'huck-engineer', role: 'producer', sessionKind: 'ai', grants: [externalRunsImportGrant] };
const proofProducer: Principal = { id: 'proof-producer', role: 'producer', proofs: ['integration:claim-safety'] };
const smokeRunner: Principal = { id: 'smoke-runner', role: 'producer', proofs: ['e2e:deploy-smoke'] };
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const principals = [observer, importer, proofProducer, smokeRunner, operator, worker];
const tokens = new Map(principals.map(p => [p.id, `${p.id}-${'t'.repeat(40)}`]));
const head = 'a'.repeat(40), base = 'b'.repeat(40), runSha = 'e'.repeat(40), tagObject = '7'.repeat(40);
const sha = (label: string) => label.repeat(40).slice(0, 40);
const production = { id: 'production', revision: 1 }, uat = { id: 'uat', revision: 1 };
const candidate = { id: '20261017T090000Z', sha: runSha, cutAt: new Date(Date.now() - 3_600_000).toISOString(), trigger: 'manual', since: null, items: [] };
/** Containment the fake provider reports: a served commit contains exactly the merges listed for it. */
const ancestry = new Map<string, Set<string>>();
const github = {
  config: { repository: REPOSITORY },
  async request(path: string) {
    if (path.startsWith('/git/matching-refs/tags/rc/')) return /page=1(?:&|$)/.test(path) ? [{ ref: `refs/tags/rc/${candidate.id}`, object: { sha: tagObject, type: 'tag' } }] : [];
    if (path === `/git/tags/${tagObject}`) return { object: { sha: runSha, type: 'commit' }, message: JSON.stringify(candidate) };
    throw new Error(`unexpected GitHub read ${path}`);
  },
  async contains(ancestor: string, descendant: string) { return ancestor === descendant || !!ancestry.get(descendant)?.has(ancestor); },
};
let database: EmbeddedPostgres, store: Store, engine: Engine, validation: Validation, http: ReturnType<typeof server>, url: string, scratch: string;

before(async () => {
  // A free port: verify runs each proof of this file at once, and a fixed port collides between them.
  const port = await freePort();
  scratch = await temporaryDirectory('delivery-observer-lane');
  database = new EmbeddedPostgres({ databaseDir: join(scratch, 'pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('observer_lane_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/observer_lane_test`); await store.init(); await recordLegacyMerger(store);
  engine = new Engine(store, [15368], 120, REPOSITORY); validation = new Validation(engine, principals, REPOSITORY);
  http = server(engine, principals.map(p => ({ ...p, token: tokens.get(p.id)! })), github as any);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
  for (const env of [production, uat])
    await validation.define(operator, { kind: 'environment', id: env.id, expectedRevision: 0, repository: REPOSITORY, url: `https://${env.id}.example.test`, instance: `instance-${env.id}`, immutable: true, services: ['api', 'web'], resources: [`account-${env.id}`] }, randomUUID());
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); if (scratch) await rm(scratch, { recursive: true, force: true }); });

async function call(method: string, path: string, actor: Principal, data?: unknown, key: string = randomUUID()) {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${tokens.get(actor.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: method === 'GET' ? undefined : JSON.stringify(data ?? {}) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}
/** Every row of every table, so a refusal is shown to have written nothing anywhere. */
async function rows() {
  const tables = (await store.pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`)).rows.map(row => row.table_name as string);
  const counts: Record<string, number> = {};
  for (const table of tables) counts[table] = Number((await store.pool.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n);
  return counts;
}
const observation = (observed: string, overrides: Record<string, unknown> = {}) => ({ environment: production, sha: observed, services: ['api', 'web'], observedAt: new Date().toISOString(), ...overrides });
const run = (runId: string) => ({ format: 'graphyard-external-run-v1', producer: 'huck', sha: runSha, runId, cases: [{ id: 'login', verdict: 'passed', required: true }] });
const reload = async (w: Work) => (await store.workItem(w.id))!;
let serial = 0;

/** A smoke-required item delivered the way production reaches it: an authorized, independently observed merge. */
async function delivered(mergeSha: string) {
  const id = () => randomUUID();
  let w = await engine.execute(operator, 'create', null, { title: `Observed change ${++serial}`, criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }], policy: { checks: ['test', 'typecheck'], review: true, deploySmoke: true } }, id());
  w = await engine.execute(operator, 'ready', w.id, {}, id()); w = await engine.execute(worker, 'claim', w.id, {}, id());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/observer-lane-${serial}`, branch: `graphyard/observer-lane-${serial}` }, id());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: serial }, id());
  const observed = (): Observation => ({ clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: serial, branch: `graphyard/observer-lane-${serial}`, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }],
    protected: true, mergeable: true, merged: false, mergeSha: null, files: [], scopeFiles: [], at: new Date().toISOString() });
  w = await engine.observe(w.id, w.revision, observed());
  w = await engine.execute(proofProducer, 'evidence', w.id, { proof: 'integration:claim-safety', sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 5, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } }, id());
  w = await engine.observe(w.id, (await reload(w)).revision, observed());
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  w = await engine.observe(w.id, (await reload(w)).revision, { ...observed(), merged: true, mergedAt, mergeSha });
  assert.equal(w.stage, 'done'); assert.equal(deliveryState(w), 'awaiting-deployment');
  return w;
}

// Every route the observer lane is refused, each named by AC-1, with the request a real caller would send.
const refusedRoutes: [string, string, unknown?][] = [
  ['POST', 'validation/import', run('observer-run')],
  ['GET', `validation/import/${runSha}`],
  ['POST', `validation/import/${runSha}/seal`, { candidate: candidate.id }],
  ['POST', 'delivery/observe', { snapshotId: 'digest' }],
  ['POST', 'delivery/notify', { environment: production.id, provider: 'railway' }],
  ...['select', 'build', 'release', 'approve', 'lease', 'rollback', 'rollback-claim', 'rollback-settle', 'rollback-resolve', 'sweep'].map((command): [string, string, unknown] => ['POST', `delivery/${command}`, {}]),
  ['POST', 'deployments', { provider: 'railway', sha: head }],
  ['POST', 'work/GY-1/evidence', { proof: 'e2e:deploy-smoke', sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 1, skipped: 0 }],
  ['POST', `proof-grants/${observer.id}/grant`, { patterns: ['e2e:deploy-smoke'], reason: 'self-grant' }],
  ['POST', 'work', { title: 't' }],
  ['POST', 'work/GY-1/note', { note: 'n' }],
  ['POST', 'work/GY-1/closed-question', { question: 'q' }],
  ['POST', 'decisions', {}],
  ['POST', 'agent-registry/observe', { sessions: [] }],
  ['POST', `agent-registry/sessions/${randomUUID()}/end`, {}],
  ['GET', 'events'],
  ['GET', 'work/GY-1'],
  ['GET', 'work/GY-1/decisions'],
  ['GET', 'delivery'],
  ['GET', 'delivery/observations?environment=production'],
  ['GET', 'proof-grants'],
  ['GET', `proof-grants/${importer.id}/history`],
  ['GET', 'validation'],
  // Public /api/ routes too: the lane credential is held to its lane before they run.
  ['POST', 'sign-in', {}],
  ['POST', 'signin/claim', { code: 'x'.repeat(32) }],
];
const observerRefusal = /outside the delivery:observe-sha lane of producer huck-observer: it may record a deployment observation by commit \(POST \/api\/delivery\/observe-sha\) and read its own principal/;

test('integration:restricted-sha-observer-route-boundary — a producer holding only delivery:observe-sha records an observation by commit, reads only its own principal, and is refused every other route before any effect; the import-only producer stays refused the observation and keeps its lane; proof producers keep their behaviour', async () => {
  const w = await delivered(sha('1'));
  // Its only mutation: the GY-1861 observation, through the existing contract.
  const recorded = await call('POST', 'delivery/observe-sha', observer, observation(w.delivery!.mergeSha));
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.deepEqual(recorded.body.deployed, [w.key]);
  const self = await call('GET', 'principals', observer);
  assert.equal(self.status, 200);
  assert.deepEqual(self.body.principals, [{ id: observer.id, role: 'producer', sessionKind: 'ai', grants: [observeShaGrant], leases: [] }], 'only itself, with its one grant');

  for (const [method, path, data] of refusedRoutes) {
    const before = await rows();
    const refused = await call(method, path, observer, data);
    assert.equal(refused.status, 403, `${method} /api/${path} is refused: ${JSON.stringify(refused.body)}`);
    assert.match(refused.body.error, observerRefusal, `${method} /api/${path} names the lane`);
    assert.deepEqual(await rows(), before, `${method} /api/${path} writes no event or row`);
  }

  // The import-only producer is unchanged: refused the observation by its own lane, still importing and reading itself.
  const before = await rows();
  const importerRefused = await call('POST', 'delivery/observe-sha', importer, observation(w.delivery!.mergeSha));
  assert.equal(importerRefused.status, 403);
  assert.match(importerRefused.body.error, /POST \/api\/delivery\/observe-sha is outside the external-runs:import lane of producer huck-engineer: it may import a run, read its own imports and read its own principal/);
  assert.deepEqual(await rows(), before, 'the refused observation writes nothing');
  const imported = await call('POST', 'validation/import', importer, run('importer-run'));
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.deepEqual((await call('GET', `validation/import/${runSha}`, importer)).body.runs.map((record: { run: { runId: string } }) => record.run.runId), ['importer-run']);
  assert.deepEqual((await call('GET', 'principals', importer)).body.principals, [{ id: importer.id, role: 'producer', sessionKind: 'ai', grants: [externalRunsImportGrant], leases: [] }]);

  // Neither lane holds proof authority or a reviewer slot; the observer is no reviewer.
  const client = await store.pool.connect();
  try {
    for (const lane of [observer, importer]) {
      assert.deepEqual((await effectiveAuthority(client, lane)).patterns, [], `${lane.id} holds no proof authority`);
      for (const proof of ['e2e:deploy-smoke', 'integration:claim-safety', 'manual:audit']) assert.equal(await authorizedForProof(client, lane, proof), false, `${lane.id} may not produce ${proof}`);
    }
  } finally { client.release(); }
  assert.deepEqual(delegationLimitDrift([operator, proofProducer, smokeRunner, observer, importer], { GRAPHYARD_MAX_REVIEWERS: '2' }), [], 'neither lane producer holds a reviewer slot');
  const delegation = await call('GET', 'delegation', operator);
  assert.ok(!JSON.stringify(delegation.body?.reviewers ?? []).includes(observer.id), 'the observer is never listed as a reviewer');

  // Proof producers keep a producer's access: they read the ledger, and still observe by commit as GY-1861 allowed.
  for (const producer of [proofProducer, smokeRunner]) {
    assert.equal((await call('GET', 'events', producer)).status, 200, `${producer.id} reads the ledger`);
    for (const [method, path, data] of refusedRoutes)
      assert.doesNotMatch(String((await call(method, path, producer, data)).body?.error ?? ''), /lane of producer/, `${producer.id} at ${method} /api/${path}`);
  }
  const byProof = await call('POST', 'delivery/observe-sha', proofProducer, observation(sha('2')));
  assert.equal(byProof.status, 200, JSON.stringify(byProof.body));

  // The observer lane is a dedicated principal: the server roster refuses it beside another grant.
  principalSchema.parse([{ ...observer, token: tokens.get(observer.id) }]);
  assert.throws(() => principalSchema.parse([{ ...observer, grants: [observeShaGrant, externalRunsImportGrant], token: tokens.get(observer.id) }]), /delivery:observe-sha is held by a dedicated principal/);
});

test('integration:restricted-sha-observer-deployed-not-verified — the observer\'s complete current production observation marks only contained deliveries Deployed, durably under its identity and idempotently; malformed, stale, partial, future and non-contained readings stay refused or awaiting; and no observation yields Production verified without applicable independently authorized passing smoke', async () => {
  const contained = await delivered(sha('3')), exact = await delivered(sha('4')), outside = await delivered(sha('5')), failing = await delivered(sha('6'));
  const served = sha('7');
  ancestry.set(served, new Set([contained.delivery!.mergeSha]));

  // Refusals the GY-1861 contract makes keep their meaning for the observer, and write nothing.
  const refusals: [Record<string, unknown>, RegExp][] = [
    [observation('not-a-sha'), /Invalid input/],
    [observation(served, { environment: { ...production, revision: 2 } }), /revision|not current|superseded/i],
    [observation(served, { environment: uat }), /Only the production environment \('production'\) records a deployment by commit; 'uat' is not it/],
    [observation(served, { services: ['web'] }), /must cover every service of 'production'; missing: api/],
    [observation(served, { services: ['api', 'web', 'worker'] }), /Services that 'production' does not define: worker/],
    [observation(served, { observedAt: new Date(Date.now() + 3_600_000).toISOString() }), /cannot lie in the future/],
  ];
  for (const [input, error] of refusals) {
    const before = await rows();
    const refused = await call('POST', 'delivery/observe-sha', observer, input);
    assert.ok(refused.status >= 400 && refused.status < 500 && refused.status !== 403, `${JSON.stringify(input)}: ${refused.status} ${JSON.stringify(refused.body)}`);
    assert.match(JSON.stringify(refused.body), error);
    assert.deepEqual(await rows(), before, `${JSON.stringify(input)} writes nothing`);
  }
  for (const w of [contained, exact, outside]) assert.equal((await reload(w)).delivery!.deployment, undefined);

  // A complete current observation: only the merges the served commit contains are marked, under the observer's identity.
  const input = observation(served), key = randomUUID();
  const result = await call('POST', 'delivery/observe-sha', observer, input, key);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.deployed, [contained.key]);
  for (const other of [exact, outside, failing]) assert.ok(result.body.awaiting.some((row: { key: string; reason: string }) => row.key === other.key && /does not contain merge/.test(row.reason)), `${other.key} awaits`);
  const deployment = (await reload(contained)).delivery!.deployment!;
  assert.deepEqual({ sha: deployment.sha, covers: deployment.covers, observer: deployment.observer, source: deployment.source }, { sha: served, covers: 'descendant', observer: observer.id, source: 'endpoint' });
  for (const other of [exact, outside, failing]) assert.equal((await reload(other)).delivery!.deployment, undefined, `${other.key} is not contained and stays awaiting deployment`);
  const history = (await store.pool.query(`SELECT actor, payload FROM events WHERE kind='delivery.sha-observed' AND payload->>'sha'=$1`, [served])).rows;
  assert.equal(history.length, 1); assert.equal(history[0].actor, observer.id); assert.equal(history[0].payload.observer, observer.id);
  assert.equal((await store.pool.query(`SELECT count(*)::int AS n FROM events WHERE work_id=$1 AND kind='deployment' AND actor=$2`, [contained.id, observer.id])).rows[0].n, 1, 'the item\'s own history names the observer');

  // Idempotent: the same key replays, a new key returns the one recorded observation and marks nothing again.
  assert.deepEqual((await call('POST', 'delivery/observe-sha', observer, input, key)).body, result.body);
  const repeat = await call('POST', 'delivery/observe-sha', observer, observation(served));
  assert.equal(repeat.body.duplicate, true); assert.equal(repeat.body.id, result.body.id); assert.deepEqual(repeat.body.deployed, []);
  assert.equal((await reload(contained)).delivery!.deployment!.at, deployment.at);

  // Deployed is all an observation says: the smoke-required item reads Deployed, awaiting verification.
  for (const marked of [contained]) {
    assert.equal(deliveryState(await reload(marked)), 'awaiting-smoke');
    assert.match(deliveryOutcome(await reload(marked))!, new RegExp(`^${deliveryLabel['awaiting-smoke']}`));
  }
  const exactResult = await call('POST', 'delivery/observe-sha', observer, observation(exact.delivery!.mergeSha));
  assert.deepEqual(exactResult.body.deployed, [exact.key]);
  assert.equal(deliveryState(await reload(exact)), 'awaiting-smoke', 'an exact observation is Deployed, never verified');
  ancestry.set(sha('8'), new Set([failing.delivery!.mergeSha]));
  assert.deepEqual((await call('POST', 'delivery/observe-sha', observer, observation(sha('8')))).body.deployed, [failing.key]);

  const smoke = (w: Work, extra: Record<string, unknown> = {}) => ({ proof: 'e2e:deploy-smoke', sha: w.delivery!.deployment!.sha, baseSha: w.delivery!.mergeSha, policyRevision: 1, result: 'pass', executed: 3, skipped: 0, ...extra });
  let w = await reload(contained);
  // The observer cannot submit or fabricate smoke: the lane refuses the route, and its credential is no proof authority even past it.
  const before = await rows();
  const byObserver = await call('POST', `work/${w.key}/evidence`, observer, smoke(w));
  assert.equal(byObserver.status, 403); assert.match(byObserver.body.error, observerRefusal);
  await assert.rejects(engine.execute(observer, 'evidence', w.id, smoke(w), randomUUID()), /only from a producer authorized for that proof/);
  for (const unauthorized of [worker, operator, proofProducer]) await assert.rejects(engine.execute(unauthorized, 'evidence', w.id, smoke(w), randomUUID()), /only from a producer authorized for that proof/);
  assert.deepEqual(await rows(), before, 'no refused smoke is stored');
  // Wrong-SHA smoke is refused outright: only the exact observed release counts.
  await assert.rejects(engine.execute(smokeRunner, 'evidence', w.id, smoke(w, { sha: w.delivery!.mergeSha }), randomUUID()), /must name the observed deployed commit/);
  await assert.rejects(engine.execute(smokeRunner, 'evidence', w.id, smoke(w, { baseSha: served }), randomUUID()), /must name the observed deployed commit/);
  assert.equal(deliveryState(await reload(w)), 'awaiting-smoke');
  // A pass that skipped a case, or executed none, verifies nothing.
  w = await engine.execute(smokeRunner, 'evidence', w.id, smoke(w, { skipped: 1 }), randomUUID());
  assert.equal(deliveryState(w), 'awaiting-smoke', 'skipped smoke never verifies');
  w = await engine.execute(smokeRunner, 'evidence', w.id, smoke(w, { executed: 0 }), randomUUID());
  assert.equal(deliveryState(w), 'awaiting-smoke', 'a smoke that executed nothing never verifies');
  // A smoke result bound to another release is inapplicable, whatever it says.
  assert.equal(deliveryState({ ...w, delivery: { ...w.delivery!, smoke: { ...w.delivery!.smoke!, executed: 3, skipped: 0, sha: sha('9') } } }), 'awaiting-smoke');
  // A failed smoke is a failure on record, never verification.
  let f = await reload(failing);
  f = await engine.execute(smokeRunner, 'evidence', f.id, smoke(f, { result: 'fail' }), randomUUID());
  assert.equal(deliveryState(f), 'delivered-with-failure'); assert.notEqual(deliveryOutcome(f), deliveryLabel['smoke-passed']);
  // Only the independently authorized applicable passing smoke at the exact observed release verifies it.
  w = await engine.execute(smokeRunner, 'evidence', w.id, smoke(w), randomUUID());
  assert.equal(deliveryState(w), 'smoke-passed');
  assert.match(deliveryOutcome(w)!, /^Production verified — release /);
  assert.equal(w.delivery!.smoke!.producer, smokeRunner.id);
  assert.equal(deliveryState(await reload(exact)), 'awaiting-smoke', 'another delivery the observer marked is still only Deployed');
});

// --- The roster: principal add registers the observer as its own lane-only producer. ---

const SERVICE = 'graphyard-owner-project';
const observerEntry = { id: 'huck-observer', role: 'producer', sessionKind: 'ai', grants: [observeShaGrant] };
const importerEntry = { id: 'huck-engineer', role: 'producer', sessionKind: 'ai', grants: [externalRunsImportGrant] };
const variableWrites = (fixture: Harness) => fixture.transport.commands.filter(command => command.program === 'railway' && ((command.args[0] === 'variables' && command.args.includes('--set')) || command.args[0] === 'variable'));
const sourceUploads = (fixture: Harness) => fixture.commandLines().filter(line => line.startsWith('railway up') || /docker (build|push)|image/.test(line)).length;
const recordOf = async (directory: string) => JSON.parse(await readFile(join(directory, 'install.json'), 'utf8'));
const withoutToken = ({ token: _token, ...entry }: { token: string }) => entry;
const principal = (fixture: Harness, args: string[]) => principalCommand(args, { ...fixture.deps, cwd: fixture.root });

test('integration:restricted-sha-observer-roster — principal add registers delivery:observe-sha as a separate lane-only producer, a rerun is a no-op, it reads back and is removed, a later install --apply keeps it, and the import-only principal, collision refusal, apply lock, file permissions and credential secrecy all stand', async () => {
  const fixture = await harness({ provider: 'railway' });
  let rerun: Harness | undefined;
  try {
    const session = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'railway' }, fixture.deps);
    await applyInstall(session, await buildPlan(session));
    const directory = session.directory;
    assert.equal((await principal(fixture, ['add', 'huck-engineer', '--role', 'producer', '--grant', externalRunsImportGrant])).changed, true);
    const before = deployedRoster(fixture.transport), importerToken = before.find(entry => entry.id === importerEntry.id)!.token;
    const writes = variableWrites(fixture).length, uploads = sourceUploads(fixture);

    // Add: one roster entry, GRAPHYARD_PRINCIPALS alone, no source or image deployment, readback naming the lane.
    const added = await principal(fixture, ['add', 'huck-observer', '--role', 'producer', '--grant', observeShaGrant]);
    assert.equal(added.changed, true);
    assert.deepEqual(added.principal, observerEntry);
    assert.deepEqual(added.deployment, { provider: 'railway', service: SERVICE, variables: ['GRAPHYARD_PRINCIPALS'], rewritten: false });
    assert.deepEqual(added.readback.principal, observerEntry, 'the control plane serves the observer with its one grant');
    assert.equal(variableWrites(fixture).length, writes + 1); assert.equal(sourceUploads(fixture), uploads, 'no source or image is deployed for a roster edit');
    const after = deployedRoster(fixture.transport);
    assert.deepEqual(after.slice(0, before.length), before, 'the import-only principal and every other entry are unchanged');
    const deployed = after.at(-1)!;
    assert.deepEqual(withoutToken(deployed), observerEntry);
    assert.notEqual(deployed.token, importerToken, 'the observer is its own credential');
    principalSchema.parse(after);
    const file = tokenFile(directory, observerEntry.id);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await readFile(file, 'utf8')).trim(), deployed.token);
    assert.ok(!JSON.stringify(added).includes(deployed.token), 'the command output never carries the credential');
    assert.deepEqual((await recordOf(directory)).principals.at(-1), { ...observerEntry, source: 'principal', fingerprint: fingerprint(deployed.token) });

    // A rerun changes nothing and reads back.
    const recordText = await readFile(join(directory, 'install.json'), 'utf8');
    const again = await principal(fixture, ['add', 'huck-observer', '--role', 'producer', '--grant', observeShaGrant]);
    assert.equal(again.changed, false); assert.equal(again.deployment, null);
    assert.deepEqual(again.readback.principal, observerEntry);
    assert.equal(variableWrites(fixture).length, writes + 1);
    assert.equal(await readFile(join(directory, 'install.json'), 'utf8'), recordText);

    // The lane is a dedicated principal: never beside another grant, and never moved onto the import-only principal.
    await assert.rejects(principal(fixture, ['add', 'huck-dual', '--role', 'producer', '--grant', observeShaGrant, '--grant', externalRunsImportGrant]), /delivery:observe-sha is held by a dedicated observer principal/);
    await assert.rejects(principal(fixture, ['add', 'huck-engineer', '--role', 'producer', '--grant', observeShaGrant]), /huck-engineer holds external-runs:import; delivery:observe-sha is held by a dedicated principal/);
    await assert.rejects(principal(fixture, ['add', 'huck-observer', '--role', 'producer', '--grant', externalRunsImportGrant]), /huck-observer holds delivery:observe-sha; delivery:observe-sha is held by a dedicated principal/);
    await assert.rejects(principal(fixture, ['add', 'huck-reader', '--role', 'reader', '--grant', observeShaGrant]), /grant names a producer lane/);
    assert.equal(variableWrites(fixture).length, writes + 1, 'a refused add writes nothing');
    assert.deepEqual(deployedRoster(fixture.transport), after);

    // A later full install --apply keeps the observer with its grant and token, and the importer untouched.
    rerun = await harness({ provider: 'railway', installed: true, root: fixture.root, configHome: fixture.configHome });
    const reapplied = await prepareInstall(rerun.root, { repository: REPOSITORY, provider: 'railway' }, rerun.deps);
    const plan = await buildPlan(reapplied);
    assert.deepEqual(plan.principals.slice(-2).map(entry => entry.id), ['huck-engineer', 'huck-observer']);
    await applyInstall(reapplied, plan);
    const reconciled = deployedRoster(rerun.transport);
    assert.deepEqual(reconciled.at(-1), { ...observerEntry, token: deployed.token });
    assert.deepEqual(reconciled.at(-2), { ...importerEntry, token: importerToken });
    // A plan producing the observer's id is refused, never replacing it.
    assert.throws(() => reconcileRoster([{ id: 'huck-observer', role: 'producer', proofs: ['unit:*'], sessionKind: 'ai' }], [{ ...rosterEntry({ id: 'huck-observer', role: 'producer', grants: [observeShaGrant] }) }]), /huck-observer is registered by graphyard principal add as producer with grants delivery:observe-sha/);
    // The apply lock: an install --apply planned before an edit is refused once the edit lands.
    const stale = await prepareInstall(rerun.root, { repository: REPOSITORY, provider: 'railway' }, rerun.deps);
    const stalePlan = await buildPlan(stale);
    assert.equal((await principal(rerun, ['remove', 'huck-observer'])).changed, true);
    await assert.rejects(applyInstall(stale, stalePlan), /roster in .*install\.json changed after this apply was planned/);

    // Removed: only the observer goes, its credential leaves this machine, and a repeat is a no-op.
    assert.deepEqual(deployedRoster(rerun.transport).filter(entry => entry.id.startsWith('huck-')).map(withoutToken), [importerEntry]);
    await assert.rejects(stat(file), { code: 'ENOENT' });
    assert.equal((await principal(rerun, ['remove', 'huck-observer'])).changed, false);
    assert.deepEqual((await recordOf(directory)).principals.filter((entry: { source?: string }) => entry.source === 'principal').map(({ fingerprint: _f, ...entry }: { fingerprint: string }) => entry), [{ ...importerEntry, source: 'principal' }]);
  } finally { await fixture.cleanup(); }
});
