import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { releaseLedgerGit } from './helpers/release-ledger-git.js';

// GY-1860: a producer imports an external run through POST /api/validation/import. The plane binds
// it to the release candidate whose head is exactly the run's sha (read from the `rc/` tags through
// the GitHub adapter), refuses any other credential and any sha no candidate was cut at, keeps every
// verdict — skipped stays skipped — with the run's provenance, idempotently by run id, and the
// imports leave the candidate's hold exactly as importedRunVerdict judges them.

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const reader: Principal = { id: 'auditor', role: 'reader' };
// Importing needs the external-runs:import grant (GY-1879) beside the producer role; it grants nothing else.
const producer: Principal = { id: 'huck-producer', role: 'producer', grants: ['external-runs:import'] };
// A second producer principal: a candidate the first producer bound refuses its imports (N4).
const otherProducer: Principal = { id: 'ci-collector', role: 'producer', grants: ['external-runs:import'] };
// A producer with proof authority but no import grant: refused at the import route, naming the grant.
const ungrantedProducer: Principal = { id: 'unit-collector', role: 'producer', proofs: ['unit:*'] };
// An operator agent with no capability, as the release-filing identity is: it reads the hold and never imports.
const releaseFiler: Principal = { id: 'graphyard-release-follow-up', role: 'operator-agent', capabilities: [], scope: { repositories: ['owner/project'], workItems: [] } };
const principals = [operator, worker, reader, producer, otherProducer, ungrantedProducer, releaseFiler];
const tokens = new Map(principals.map(p => [p.id, `${p.id}-${'t'.repeat(40)}`]));

// Six candidates cut at six heads; `elsewhere` is a commit no candidate holds.
const boundSha = 'a'.repeat(40), holdSha = 'b'.repeat(40), versionSha = 'c'.repeat(40), elsewhere = 'd'.repeat(40);
const unknownSha = 'f'.repeat(40), pointerSha = 'ab'.repeat(20), producerSha = 'cd'.repeat(20);
const candidates = [
  { id: '20261017T010000Z', sha: boundSha }, { id: '20261017T020000Z', sha: holdSha }, { id: '20261017T030000Z', sha: versionSha },
  { id: '20261017T040000Z', sha: unknownSha }, { id: '20261017T050000Z', sha: pointerSha }, { id: '20261017T060000Z', sha: producerSha },
].map(entry => ({ ...entry, cutAt: `${entry.id.slice(0, 4)}-${entry.id.slice(4, 6)}-${entry.id.slice(6, 8)}T${entry.id.slice(9, 11)}:00:00.000Z`, trigger: 'manual', since: null, items: [] }));
const tagObject = (index: number) => String(index + 1).repeat(40);
/** The release ledger the import reads from the coordinator checkout: the `rc/` tag refs, and each annotated tag carrying its candidate record. `down` fails every read. */
const github = releaseLedgerGit(() => candidates, tagObject);

let database: EmbeddedPostgres, store: Store, http: ReturnType<typeof server>, url: string, scratch: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_VALIDATION_IMPORT_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1860);
  scratch = await temporaryDirectory('validation-import');
  database = new EmbeddedPostgres({ databaseDir: join(scratch, 'pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('validation_import_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/validation_import_test`); await store.init();
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = github.run;
  http = server(engine, principals.map(p => ({ ...p, token: tokens.get(p.id)! })), null);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); if (scratch) await rm(scratch, { recursive: true, force: true }); });

async function call(path: string, actor: Principal, data?: unknown) {
  const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${tokens.get(actor.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { status: response.status, body: await response.json() as any };
}
const imported = async (data: unknown, actor = producer) => { const result = await call('validation/import', actor, data); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
const hold = async (sha: string) => (await call(`validation/import/${sha}`, reader)).body.hold;
const run = (sha: string, runId: string, cases: readonly Record<string, unknown>[], over: Record<string, unknown> = {}) =>
  ({ format: 'graphyard-external-run-v1', producer: 'huck-engineer', runId, sha, cases, ...over });
const trace = 'https://huck.example/runs/r-1/checkout-guest/trace';

test('unit:validation-import-route-binds-by-sha — POST /api/validation/import refuses a non-producer credential, a producer without external-runs:import, and a sha no candidate holds, and persists a producer run at a candidate head idempotently with every verdict, skipped kept, and its provenance', async () => {
  const handIn = run(boundSha, 'huck-run-1', [
    { id: 'checkout-guest', verdict: 'passed', attempts: 1, durationMs: 4310, required: true, result: 'PASS', evidence: [trace] },
    { id: 'search-facet', verdict: 'skipped', attempts: 0, durationMs: 0, result: 'SKIPPED_BY_TAG' },
    { id: 'checkout-card', verdict: 'blocked', attempts: 0, durationMs: 0, reason: 'the payment sandbox was unreachable', result: 'ENV_MISSING' },
  ], { toolVersion: 'huck-engineer 4.2.1', result: 'PARTIAL', environment: 'uat' });

  for (const actor of [worker, reader, operator]) {
    const refused = await call('validation/import', actor, handIn);
    assert.equal(refused.status, 403, `${actor.role} is refused`);
    assert.match(refused.body.error, /producer credential is required/);
  }
  const ungranted = await call('validation/import', ungrantedProducer, handIn);
  assert.equal(ungranted.status, 403, 'a producer without the import grant is refused');
  assert.match(ungranted.body.error, /requires the external-runs:import grant; producer unit-collector holds no grant/);
  const unbound = await call('validation/import', producer, { ...handIn, sha: elsewhere, runId: 'huck-run-elsewhere' });
  assert.equal(unbound.status, 409);
  assert.match(unbound.body.error, new RegExp(`No release candidate was cut at ${elsewhere}`));
  assert.equal(((await call(`validation/import/${elsewhere}`, reader)).body.runs).length, 0, 'a refused run is never recorded');

  const first = await imported(handIn);
  assert.equal(first.replayed, false);
  assert.deepEqual(first.imported.candidate, { id: candidates[0].id, sha: boundSha }, 'the run binds to the candidate cut at its exact head');
  assert.equal(first.imported.importedBy, producer.id);
  const record = first.imported.run;
  assert.equal(record.runId, 'huck-run-1');
  assert.equal(record.producer, 'huck-engineer');
  assert.equal(record.toolVersion, 'huck-engineer 4.2.1');
  assert.equal(record.result, 'PARTIAL');
  assert.deepEqual(record.cases.map((entry: any) => [entry.id, entry.verdict, entry.result]),
    [['checkout-guest', 'passed', 'PASS'], ['search-facet', 'skipped', 'SKIPPED_BY_TAG'], ['checkout-card', 'blocked', 'ENV_MISSING']], 'every verdict as given, skipped never flattened to blocked or unrun');
  assert.deepEqual(record.cases[0].evidence, [trace]);
  assert.equal(record.cases[2].reason, 'the payment sandbox was unreachable');

  const read = (await call(`validation/import/${boundSha}`, reader)).body;
  assert.equal(read.runs.length, 1);
  assert.deepEqual(read.runs[0].run, record, 'the persisted record keeps the run as imported');
  const again = await imported(handIn);
  assert.equal(again.replayed, true, 'the same run again replays its record');
  assert.deepEqual(again.imported, first.imported);
  assert.equal((await call(`validation/import/${boundSha}`, reader)).body.runs.length, 1, 'a replay writes nothing');
  const changed = await call('validation/import', producer, { ...handIn, cases: handIn.cases.slice(0, 1) });
  assert.equal(changed.status, 409);
  assert.match(changed.body.error, /already imported with a different document/);

  // A committed run replays from its record: no GitHub read, so a replay succeeds while GitHub is unreachable.
  github.down = true; const reads = github.reads;
  try {
    const offline = await imported(handIn);
    assert.equal(offline.replayed, true);
    assert.deepEqual(offline.imported, first.imported, 'the replay carries the candidate the run bound to');
    assert.equal(github.reads, reads, 'a replay reads nothing from the ledger');
    assert.equal((await call(`validation/import/${boundSha}`, reader)).body.runs.length, 1, 'an offline replay writes nothing');
    const offlineChanged = await call('validation/import', producer, { ...handIn, cases: handIn.cases.slice(0, 1) });
    assert.equal(offlineChanged.status, 409, 'a different document under a used run id is still refused');
    assert.match(offlineChanged.body.error, /already imported with a different document/);
    const fresh = await call('validation/import', producer, { ...handIn, runId: 'huck-run-new' });
    assert.notEqual(fresh.status, 200, 'a first import needs the ledger read');
  } finally { github.down = false; }

  // The release-filing identity the promotion workflows hold reads the same record and hold; it still cannot import.
  const filed = await call(`validation/import/${boundSha}`, releaseFiler);
  assert.equal(filed.status, 200, JSON.stringify(filed.body));
  assert.deepEqual(filed.body, read, 'the release-filing identity reads what any reader reads');
  assert.equal((await call('validation/import', releaseFiler, { ...handIn, runId: 'filer-run' })).status, 403, 'the release-filing identity never imports');

  // Original results are kept byte for byte, surrounding whitespace included, for the run and each case.
  const spaced = await imported(run(boundSha, 'huck-run-spaced', [{ id: 'checkout-guest', verdict: 'passed', attempts: 1, durationMs: 1, result: ' PASS ' }], { result: '  OK\t'.replace('\t', ' ') }));
  assert.equal(spaced.imported.run.result, '  OK ');
  assert.equal(spaced.imported.run.cases[0].result, ' PASS ');
  const persisted = (await call(`validation/import/${boundSha}`, reader)).body.runs.find((entry: any) => entry.run.runId === 'huck-run-spaced').run;
  assert.equal(persisted.result, '  OK ', 'the run result persists untrimmed');
  assert.equal(persisted.cases[0].result, ' PASS ', 'the case result persists untrimmed');
  const unspaced = await call('validation/import', producer, run(boundSha, 'huck-run-spaced', [{ id: 'checkout-guest', verdict: 'passed', attempts: 1, durationMs: 1, result: 'PASS' }], { result: '  OK ' }));
  assert.equal(unspaced.status, 409, 'documents differing only in result whitespace are distinct');
  assert.equal((await call('validation/import', producer, run(boundSha, 'huck-run-blank', [], { result: '   ' }))).status, 400, 'a blank result is refused');

});

test('unit:validation-import-feeds-hold — a required failed, blocked or unrun case holds the candidate, an all-passing run releases it, and skipped follows the required-case rule', async () => {
  const passing = (id: string) => ({ id, verdict: 'passed', attempts: 1, durationMs: 100, required: true });
  assert.equal((await hold(holdSha)).held, false, 'no import, no hold');

  const held = await imported(run(holdSha, 'hold-1', [
    passing('login'),
    { id: 'pay', verdict: 'failed', attempts: 1, durationMs: 100, required: true },
    { id: 'ship', verdict: 'blocked', attempts: 0, durationMs: 0, required: true, reason: 'no carrier sandbox' },
    { id: 'refund', verdict: 'unrun', attempts: 0, durationMs: 0, required: true },
    { id: 'export', verdict: 'skipped', attempts: 0, durationMs: 0, required: true },
    { id: 'theme', verdict: 'skipped', attempts: 0, durationMs: 0 },
    { id: 'avatar', verdict: 'failed', attempts: 1, durationMs: 100 },
  ]));
  assert.equal(held.verdict.passed, false);
  assert.equal(held.hold.held, true);
  assert.deepEqual(held.hold.cases.map((entry: any) => [entry.id, entry.verdict]).sort(),
    [['export', 'skipped'], ['pay', 'failed'], ['refund', 'unrun'], ['ship', 'blocked']], 'required failed, blocked, unrun and skipped hold; optional skipped and failed do not');
  assert.equal(held.hold.cases.find((entry: any) => entry.id === 'ship').reason, 'no carrier sandbox');
  assert.deepEqual(await hold(holdSha), held.hold, 'the read gives the same hold');

  // A later report that leaves `required` out (it defaults to false) cannot release a required case without a pass.
  const unflagged = await imported(run(holdSha, 'hold-1b', [
    { id: 'pay', verdict: 'failed', attempts: 1, durationMs: 1 },
    { id: 'ship', verdict: 'blocked', attempts: 0, durationMs: 0, reason: 'still no sandbox' },
    { id: 'refund', verdict: 'unrun', attempts: 0, durationMs: 0 },
    { id: 'export', verdict: 'skipped', attempts: 0, durationMs: 0 },
  ]));
  assert.equal(unflagged.hold.held, true, 'dropping the required flag does not release a case that never passed');
  assert.deepEqual(unflagged.hold.cases.map((entry: any) => [entry.id, entry.runId]).sort(),
    [['export', 'hold-1b'], ['pay', 'hold-1b'], ['refund', 'hold-1b'], ['ship', 'hold-1b']], 'each case is held by the newest run that reported it');

  const partly = await imported(run(holdSha, 'hold-2', [passing('pay'), passing('ship')]));
  assert.deepEqual(partly.hold.cases.map((entry: any) => entry.id).sort(), ['export', 'refund'], 'a later pass releases only the cases it reports');

  const released = await imported(run(holdSha, 'hold-3', ['login', 'pay', 'ship', 'refund', 'export'].map(passing)));
  assert.equal(released.verdict.passed, true);
  assert.deepEqual(released.hold, { held: false, cases: [], runs: 4 }, 'an all-passing run releases the candidate');
  assert.equal((await hold(boundSha)).runs, 2, 'the hold is per candidate: another head counts only its own two imports');

  // Sealing closes a released candidate to imports: only an admin or an operator agent seals, and a later import is refused.
  for (const actor of [reader, producer]) assert.equal((await call(`validation/import/${holdSha}/seal`, actor, { candidate: candidates[1].id })).status, 403, `${actor.role} cannot seal`);
  const sealed = await call(`validation/import/${holdSha}/seal`, operator, { candidate: candidates[1].id });
  assert.equal(sealed.status, 200, JSON.stringify(sealed.body));
  assert.equal(sealed.body.sealed, true, 'a released hold is sealed');
  assert.equal((await call(`validation/import/${holdSha}?candidate=${candidates[1].id}`, reader)).body.sealed, true);
  const late = await call('validation/import', producer, run(holdSha, 'hold-late', [{ id: 'pay', verdict: 'failed', attempts: 1, durationMs: 100, required: true }]));
  assert.equal(late.status, 409, JSON.stringify(late.body));
  assert.match(late.body.error, /sealed for promotion/);
});

test('unit:validation-import-case-version-not-inferred — catalogCommitSha is stored as provenance only and never read into a case version', async () => {
  const catalog = 'e'.repeat(40);
  const result = await imported(run(versionSha, 'version-1', [
    { id: 'login', verdict: 'passed', attempts: 1, durationMs: 100, required: true },
    { id: 'pay', verdict: 'passed', attempts: 1, durationMs: 100, required: true, caseVersion: 'pay@7' },
  ], { catalogCommitSha: catalog }));
  const stored = (await call(`validation/import/${versionSha}`, reader)).body.runs[0].run;
  for (const record of [result.imported.run, stored]) {
    assert.equal(record.catalogCommitSha, catalog, 'the catalog commit is kept as provenance');
    assert.equal(record.cases[0].caseVersion, null, 'no case version given: it stays null, never inferred from the catalog commit');
    assert.equal(record.cases[1].caseVersion, 'pay@7', 'a given case version is kept as given');
  }
});

test('unit:validation-import-unknown-duration-attempts — omitted or null durationMs and attempts are stored as null, never 0, and a report-row count stays apart from attempts', async () => {
  const result = await imported(run(unknownSha, 'unknown-1', [
    { id: 'login', verdict: 'passed', required: true },
    { id: 'pay', verdict: 'failed', attempts: null, durationMs: null, required: true, reportRows: 3 },
  ]));
  assert.deepEqual(result.imported.candidate, { id: candidates[3].id, sha: unknownSha }, 'the run still binds to its candidate');
  const stored = (await call(`validation/import/${unknownSha}`, reader)).body.runs[0].run;
  for (const record of [result.imported.run, stored]) {
    for (const entry of record.cases) {
      assert.equal(entry.attempts, null, `${entry.id}: unknown attempts stay null`);
      assert.equal(entry.durationMs, null, `${entry.id}: unknown duration stays null`);
    }
    assert.equal(record.cases[0].reportRows, null);
    assert.equal(record.cases[1].reportRows, 3, 'the report-row count is kept as its own field, never read as attempts');
  }
  assert.deepEqual(result.hold.cases.map((entry: any) => [entry.id, entry.verdict]), [['pay', 'failed']], 'the run still feeds the hold');
  assert.equal((await hold(unknownSha)).held, true);
});

test('unit:validation-import-opaque-evidence — opaque evidence pointers and absent evidence are stored as given and never reported as public links', async () => {
  const pointer = { evidenceId: 'ev-41', storageKey: 'huck/runs/r-41/checkout/trace.zip' };
  const actionsRun = 'https://github.com/owner/project/actions/runs/123456';
  const result = await imported(run(pointerSha, 'pointer-1', [
    { id: 'checkout', verdict: 'failed', attempts: 1, durationMs: 10, required: true, evidence: [pointer] },
    { id: 'search', verdict: 'failed', attempts: 1, durationMs: 10, required: true },
    { id: 'profile', verdict: 'failed', attempts: 1, durationMs: 10, required: true, evidence: [actionsRun] },
  ]));
  const stored = (await call(`validation/import/${pointerSha}`, reader)).body.runs[0].run;
  for (const record of [result.imported.run, stored]) {
    assert.deepEqual(record.cases[0].evidence, [pointer], 'the pointer is stored exactly as given, never turned into a URL');
    assert.deepEqual(record.cases[1].evidence, [], 'no evidence given, none stored');
    assert.deepEqual(record.cases[2].evidence, [actionsRun]);
  }
  const held = new Map<string, any>((await hold(pointerSha)).cases.map((entry: any) => [entry.id, entry]));
  assert.deepEqual(held.get('checkout').evidencePointers, [pointer], 'the hold names the pointer as given');
  for (const id of ['checkout', 'search']) {
    assert.deepEqual(held.get(id).evidence, [], `${id} carries no link artifact`);
    assert.doesNotMatch(JSON.stringify(held.get(id)), /"url"|public/, `${id} is never reported as a public link`);
  }
  // A GitHub Actions run link is an external location only: never available, never trusted proof, never labelled public.
  assert.deepEqual(held.get('profile').evidence, [{ kind: 'report', label: 'imported case evidence', availability: 'external', url: actionsRun }]);
  assert.equal((await call('validation/import', producer, run(pointerSha, 'pointer-bad', [{ id: 'c', verdict: 'passed', attempts: 1, durationMs: 1, evidence: [{}] }]))).status, 400, 'a pointer naming nothing is refused');
});

test('unit:validation-import-bound-producer — the first import binds the candidate to its producer principal; another producer is refused 409, and only the bound producer passing a case clears it', async () => {
  const first = await imported(run(producerSha, 'bound-1', [
    { id: 'login', verdict: 'passed', attempts: 1, durationMs: 1, required: true },
    { id: 'pay', verdict: 'failed', attempts: 1, durationMs: 1, required: true },
  ], { producer: 'shared-name' }));
  assert.equal(first.imported.importedBy, producer.id);

  // Another producer principal — even under the same free-text producer name — is refused, and changes nothing.
  for (const document of [run(producerSha, 'other-1', [{ id: 'pay', verdict: 'passed', attempts: 1, durationMs: 1, required: true }], { producer: 'shared-name' }),
    run(producerSha, 'bound-1', [{ id: 'login', verdict: 'passed', attempts: 1, durationMs: 1, required: true }, { id: 'pay', verdict: 'failed', attempts: 1, durationMs: 1, required: true }], { producer: 'shared-name' })]) {
    const refused = await call('validation/import', otherProducer, document);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.error, new RegExp(`bound to producer ${producer.id}`));
  }
  const afterRefusal = (await call(`validation/import/${producerSha}`, reader)).body;
  assert.equal(afterRefusal.runs.length, 1, 'a refused producer records nothing');
  assert.deepEqual(afterRefusal.hold.cases.map((entry: any) => [entry.id, entry.verdict]), [['pay', 'failed']], 'the earlier required failure still holds');

  // A later run from the bound producer that omits the case does not clear it; only its pass does.
  const omitted = await imported(run(producerSha, 'bound-2', [{ id: 'login', verdict: 'passed', attempts: 1, durationMs: 1, required: true }]));
  assert.deepEqual(omitted.hold.cases.map((entry: any) => [entry.id, entry.runId]), [['pay', 'bound-1']], 'an omitted case stays held by the run that last reported it');
  const passed = await imported(run(producerSha, 'bound-3', [{ id: 'pay', verdict: 'passed', attempts: 1, durationMs: 1, required: true }]));
  assert.deepEqual(passed.hold, { held: false, cases: [], runs: 3 });
});
