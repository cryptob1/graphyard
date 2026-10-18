import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { principalSchema, server } from '../src/server.js';
import type { Principal } from '../src/model.js';
import { authorizedForProof, effectiveAuthority } from '../src/proof-grants.js';
import { principalCommand } from '../src/cli/install.js';
import { applyInstall, buildPlan, prepareInstall } from '../src/install/index.js';
import { fingerprint, plannedPrincipals, reconcileRoster, rosterEntry, tokenFile } from '../src/install/secrets.js';
import { externalRunsImportGrant } from '../src/server/principals.js';
import { freePort } from '../src/cli/test-isolation.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { deployedRoster, harness, REPOSITORY, type Harness } from './install-harness.js';

// GY-1879: an installation keeps its principal roster in install.json as a durable record and every
// apply reconciles with it instead of rewriting it. `graphyard principal add|remove` edits one entry,
// writes GRAPHYARD_PRINCIPALS alone and reads the served roster back; a producer is created only with
// an explicit grant, and the external-results lane's grant, external-runs:import, authorizes nothing else.

const GRANT = externalRunsImportGrant;
const SERVICE = 'graphyard-owner-project';
/** Every deployment variable write the fake Railway transport recorded, newest last. */
const variableWrites = (fixture: Harness) => fixture.transport.commands.filter(command => command.program === 'railway' && ((command.args[0] === 'variables' && command.args.includes('--set')) || command.args[0] === 'variable'));
const redeploys = (fixture: Harness) => fixture.commandLines().filter(line => line.startsWith('railway redeploy')).length;
const uploads = (fixture: Harness) => fixture.commandLines().filter(line => line.startsWith('railway up')).length;
const recordOf = async (directory: string) => JSON.parse(await readFile(join(directory, 'install.json'), 'utf8'));
const withoutToken = ({ token: _token, ...principal }: { token: string }) => principal;
const huck = { id: 'huck-engineer', role: 'producer', sessionKind: 'ai', grants: [GRANT] };

/** A Railway account that remembers what the installer created, so a rerun observes its own service. */
function statefulRailway(state: { project: boolean }) {
  return [
    { match: 'railway status --json', result: () => state.project ? JSON.stringify({ name: SERVICE, services: { edges: [{ node: { name: 'Postgres' } }, { node: { name: SERVICE } }] } }) : { stdout: '', stderr: 'no linked project', code: 1 } },
    { match: 'railway init', result: () => { state.project = true; return ''; } },
    { match: 'git/ref/heads/release', result: { stdout: '', stderr: 'gh: Not Found (HTTP 404)', code: 1 } },
    { match: `repos/${REPOSITORY}/environments`, result: JSON.stringify({ environments: [] }) },
  ];
}
const principal = (fixture: Harness, args: string[]) => principalCommand(args, { ...fixture.deps, cwd: fixture.root });

test('unit:principal-upsert-remove-single-entry-readback — principal add writes exactly one roster entry to GRAPHYARD_PRINCIPALS and install.json, changes no other variable, entry or token, reads the principal back from the control plane with its role and grant, and is a no-op when repeated; principal remove removes only that entry, with readback, and is a no-op when repeated', async () => {
  const fixture = await harness({ provider: 'railway' });
  try {
    const session = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'railway' }, fixture.deps);
    await applyInstall(session, await buildPlan(session));
    const directory = session.directory;
    const before = deployedRoster(fixture.transport), recordBefore = await recordOf(directory);
    const writesBefore = variableWrites(fixture).length, redeploysBefore = redeploys(fixture), uploadsBefore = uploads(fixture);
    assert.deepEqual(before.map(entry => entry.id), ['owner-project-operator', 'owner-project-master', 'owner-project-worker-1', 'owner-project-dashboard']);

    // Add: one entry, one variable, one redeploy, no upload, and the served roster lists it with its role and grant.
    const added = await principal(fixture, ['add', 'huck-engineer', '--role', 'producer', '--grant', GRANT]);
    assert.equal(added.changed, true);
    assert.deepEqual(added.principal, huck);
    assert.deepEqual(added.deployment, { provider: 'railway', service: SERVICE, variables: ['GRAPHYARD_PRINCIPALS'], rewritten: false });
    assert.deepEqual(added.readback.principal, huck, 'the control plane lists the principal with its role and grant');
    assert.equal(added.readback.principals, before.length + 1);
    const writes = variableWrites(fixture).slice(writesBefore);
    assert.equal(writes.length, 1, `exactly one variable is written: ${writes.map(command => command.args.join(' ')).join('; ')}`);
    assert.deepEqual(writes[0].args, ['variable', 'set', '--service', SERVICE, '--skip-deploys', '--stdin', 'GRAPHYARD_PRINCIPALS']);
    assert.equal(redeploys(fixture), redeploysBefore + 1); assert.equal(uploads(fixture), uploadsBefore, 'the checkout is never uploaded for a roster edit');
    const after = deployedRoster(fixture.transport);
    assert.deepEqual(after.slice(0, before.length), before, 'no other principal\'s entry or token changed');
    assert.equal(after.length, before.length + 1);
    const deployed = after[before.length];
    assert.deepEqual(withoutToken(deployed), huck, 'the entry carries the role, the declared kind and the grant, and nothing else');
    assert.ok(deployed.token.length >= 32);
    principalSchema.parse(after);
    // install.json keeps the roster: the entry, its source and the credential's fingerprint; every other field stands.
    const recordAfter = await recordOf(directory);
    assert.deepEqual(recordAfter.principals, [...recordBefore.principals, { ...huck, source: 'principal', fingerprint: fingerprint(deployed.token) }]);
    assert.deepEqual({ ...recordAfter, principals: null, updatedAt: null }, { ...recordBefore, principals: null, updatedAt: null });
    const file = tokenFile(directory, 'huck-engineer');
    assert.equal(added.tokenFile, file);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await readFile(file, 'utf8')).trim(), deployed.token);
    assert.ok(!JSON.stringify(added).includes(deployed.token), 'the command output never carries the credential');

    // Repeating the add changes nothing: no write, no redeploy, the record byte for byte, and the readback alone.
    const recordText = await readFile(join(directory, 'install.json'), 'utf8');
    const again = await principal(fixture, ['add', 'huck-engineer', '--role', 'producer', '--grant', GRANT]);
    assert.equal(again.changed, false); assert.equal(again.deployment, null);
    assert.deepEqual(again.readback.principal, huck);
    assert.equal(variableWrites(fixture).length, writesBefore + 1); assert.equal(redeploys(fixture), redeploysBefore + 1);
    assert.equal(await readFile(join(directory, 'install.json'), 'utf8'), recordText);
    assert.equal((await readFile(file, 'utf8')).trim(), deployed.token, 'the credential never rotates');
    // An unchanged add whose token file was lost mints nothing: a fresh token would be one the deployment never serves.
    await rm(file);
    await assert.rejects(principal(fixture, ['add', 'huck-engineer', '--role', 'producer', '--grant', GRANT]), /No credential is saved for huck-engineer .* nothing was minted or written/);
    await assert.rejects(stat(file), { code: 'ENOENT' }, 'no replacement credential is written');
    assert.equal(variableWrites(fixture).length, writesBefore + 1); assert.equal(redeploys(fixture), redeploysBefore + 1);
    assert.equal(await readFile(join(directory, 'install.json'), 'utf8'), recordText);
    assert.deepEqual(deployedRoster(fixture.transport), after, 'the deployed credential stands');
    await writeFile(file, `${deployed.token}\n`, { mode: 0o600 });

    // Remove: only that entry goes, the served roster no longer lists it, and its credential leaves this machine.
    const removed = await principal(fixture, ['remove', 'huck-engineer']);
    assert.equal(removed.changed, true);
    assert.deepEqual(removed.principal, { id: 'huck-engineer' });
    assert.equal(removed.readback.principal, null); assert.equal(removed.readback.principals, before.length);
    assert.deepEqual(deployedRoster(fixture.transport), before);
    assert.deepEqual((await recordOf(directory)).principals, recordBefore.principals);
    await assert.rejects(stat(file), { code: 'ENOENT' });
    assert.equal(variableWrites(fixture).length, writesBefore + 2); assert.equal(redeploys(fixture), redeploysBefore + 2);
    const removedAgain = await principal(fixture, ['remove', 'huck-engineer']);
    assert.equal(removedAgain.changed, false); assert.equal(removedAgain.deployment, null);
    assert.equal(variableWrites(fixture).length, writesBefore + 2);

    // The installer's own principals are planned by install --apply, never edited here; the entry is judged before anything is read.
    await assert.rejects(principal(fixture, ['add', 'owner-project-worker-1', '--role', 'worker']), /installer's own principals/);
    await assert.rejects(principal(fixture, ['remove', 'owner-project-operator']), /installer's own principals/);
    await assert.rejects(principal(fixture, ['add', 'huck-engineer', '--role', 'producer']), /explicit grant/);
    await assert.rejects(principal(fixture, ['add', 'huck-engineer', '--role', 'worker', '--grant', GRANT]), /grant names a producer lane/);
    await assert.rejects(principal(fixture, ['add', 'huck-engineer', '--role', 'producer', '--grant', 'e2e:record']), /Unknown grant e2e:record/);
    await assert.rejects(principal(fixture, ['add', 'bad id', '--role', 'reader']), /principal id is/);
    await assert.rejects(principal(fixture, ['remove', 'huck-engineer', '--role', 'reader']), /takes only ID/);
    assert.equal(variableWrites(fixture).length, writesBefore + 2, 'a refused command writes nothing');
  } finally { await fixture.cleanup(); }
});

test('unit:installer-roster-keeps-named-external-producer-across-apply — a later full install --apply and a later install --observe-only --apply keep a principal added by principal add with its id, role, grants and token while planning their own principals; --observe-only creates no worker or producer, keeps the ones registered, and is no longer refused because install.json records one', async () => {
  // A full installation: principal add, then a second full apply plans operator, master, worker and dashboard and keeps huck-engineer.
  const first = await harness({ provider: 'railway' });
  let rerun: Harness | undefined;
  try {
    const session = await prepareInstall(first.root, { repository: REPOSITORY, provider: 'railway' }, first.deps);
    await applyInstall(session, await buildPlan(session));
    const added = await principal(first, ['add', 'huck-engineer', '--role', 'producer', '--grant', GRANT]);
    assert.equal(added.changed, true);
    const token = (await readFile(tokenFile(session.directory, 'huck-engineer'), 'utf8')).trim();
    rerun = await harness({ provider: 'railway', installed: true, root: first.root, configHome: first.configHome });
    const again = await prepareInstall(rerun.root, { repository: REPOSITORY, provider: 'railway' }, rerun.deps);
    const plan = await buildPlan(again);
    assert.deepEqual(plan.principals.map(entry => entry.id), ['owner-project-operator', 'owner-project-master', 'owner-project-worker-1', 'owner-project-dashboard', 'huck-engineer']);
    await applyInstall(again, plan);
    const roster = deployedRoster(rerun.transport);
    assert.deepEqual(roster.map(entry => entry.id), plan.principals.map(entry => entry.id));
    assert.deepEqual(roster.at(-1), { ...huck, token }, 'the added producer is deployed again with its id, role, grants and token unchanged');
    assert.deepEqual((await recordOf(session.directory)).principals.at(-1), { ...huck, source: 'principal', fingerprint: fingerprint(token) });
    assert.equal(roster.find(entry => entry.id === 'owner-project-worker-1')!.token, deployedRoster(first.transport).find(entry => entry.id === 'owner-project-worker-1')!.token);
  } finally { await first.cleanup(); }

  // An observation-only installation: it plans no worker or producer, keeps the ones principal add registered, and is not refused for recording them.
  const railway = { project: false };
  const observed = await harness({ provider: 'railway', extraResponses: statefulRailway(railway), statusBody: { actor: { id: 'owner-project-operator', role: 'admin' }, repository: REPOSITORY, github: false, githubAppId: null, githubInstallationId: null } });
  try {
    const prepare = () => prepareInstall(observed.root, { repository: REPOSITORY, provider: 'railway', observeOnly: true }, observed.deps, 'apply');
    const session = await prepare();
    await applyInstall(session, await buildPlan(session));
    assert.deepEqual(deployedRoster(observed.transport).map(entry => entry.id), ['owner-project-operator', 'owner-project-master', 'owner-project-dashboard']);
    await principal(observed, ['add', 'huck-engineer', '--role', 'producer', '--grant', GRANT]);
    await principal(observed, ['add', 'huck-runner', '--role', 'worker']);
    const tokens = Object.fromEntries(deployedRoster(observed.transport).map(entry => [entry.id, entry.token]));
    const second = await prepare();
    const plan = await buildPlan(second);
    assert.ok(plan.preflight.every(item => item.ok), `observation-only is refused: ${JSON.stringify(plan.preflight.filter(item => !item.ok))}`);
    assert.ok(!plan.preflight.some(item => item.name === 'Principals'), 'the recorded worker and producer no longer refuse the apply');
    assert.deepEqual(plan.principals.map(entry => [entry.id, entry.role]), [['owner-project-operator', 'admin'], ['owner-project-master', 'coordinator'], ['owner-project-dashboard', 'reader'], ['huck-engineer', 'producer'], ['huck-runner', 'worker']], 'the plan keeps the registered worker and producer and creates none of its own');
    assert.ok(plan.actions.find(action => action.id === 'local.workers')!.state === 'held');
    await applyInstall(second, plan);
    const roster = deployedRoster(observed.transport);
    assert.deepEqual(Object.fromEntries(roster.map(entry => [entry.id, entry.token])), tokens, 'every credential, the planned ones and the registered ones, is deployed unchanged');
    assert.deepEqual(roster.filter(entry => entry.id.startsWith('huck-')).map(withoutToken), [huck, { id: 'huck-runner', role: 'worker', sessionKind: 'ai' }]);
    const record = await recordOf(session.directory);
    assert.deepEqual(record.principals.filter((entry: { source?: string }) => entry.source === 'principal').map(({ fingerprint: _f, ...entry }: { fingerprint: string }) => entry), [{ ...huck, source: 'principal' }, { id: 'huck-runner', role: 'worker', sessionKind: 'ai', source: 'principal' }]);
  } finally { await observed.cleanup(); }

  // A worker an earlier full apply registered is kept by observation-only too; a full apply retires only what its own plan drops.
  const planned = plannedPrincipals('owner-project', { workers: 2 });
  const recorded = [...planned.map(entry => ({ ...entry })), { id: 'huck-engineer', role: 'producer' as const, sessionKind: 'ai' as const, grants: [GRANT], source: 'principal' as const }];
  const observeOnlyPlan = plannedPrincipals('owner-project').filter(entry => entry.role !== 'worker' && entry.role !== 'producer');
  assert.deepEqual(reconcileRoster(observeOnlyPlan, recorded, { observeOnly: true }).map(entry => entry.id), ['owner-project-operator', 'owner-project-master', 'owner-project-dashboard', 'owner-project-worker-1', 'owner-project-worker-2', 'huck-engineer']);
  assert.deepEqual(reconcileRoster(plannedPrincipals('owner-project', { workers: 1 }), recorded).map(entry => entry.id), ['owner-project-operator', 'owner-project-master', 'owner-project-worker-1', 'owner-project-dashboard', 'huck-engineer']);

  // A registered entry the plan would produce under the same id is refused, full or observation-only, never replaced by the planned principal.
  const registeredCi = { id: 'owner-project-ci', role: 'producer' as const, sessionKind: 'ai' as const, grants: [GRANT], source: 'principal' as const };
  assert.throws(() => reconcileRoster(plannedPrincipals('owner-project', { producerProofs: ['unit:*'] }), [registeredCi]), /owner-project-ci is registered by graphyard principal add as producer with grants external-runs:import, and this apply plans its own producer under the same id; nothing was written/);
  const registeredOperator = { id: 'owner-project-operator', role: 'reader' as const, sessionKind: 'ai' as const, source: 'principal' as const };
  assert.throws(() => reconcileRoster(observeOnlyPlan, [registeredOperator], { observeOnly: true }), /owner-project-operator is registered by graphyard principal add as reader/);
});

test('unit:installer-roster-keeps-named-external-producer-across-apply — an apply whose plan produces the id of an entry principal add registered is refused before any write: an import-only producer is never replaced by the planned proof producer while its token stands', async () => {
  const first = await harness({ provider: 'railway' });
  try {
    const session = await prepareInstall(first.root, { repository: REPOSITORY, provider: 'railway' }, first.deps);
    await applyInstall(session, await buildPlan(session));
    assert.equal((await principal(first, ['add', 'owner-project-ci', '--role', 'producer', '--grant', GRANT])).changed, true);
    const recordText = await readFile(join(session.directory, 'install.json'), 'utf8'), roster = deployedRoster(first.transport), writes = variableWrites(first).length;
    await assert.rejects(prepareInstall(first.root, { repository: REPOSITORY, provider: 'railway', producerProofs: ['unit:*'] }, first.deps), /owner-project-ci is registered by graphyard principal add as producer with grants external-runs:import.*graphyard principal remove owner-project-ci/);
    assert.equal(await readFile(join(session.directory, 'install.json'), 'utf8'), recordText, 'install.json is unchanged');
    assert.deepEqual(deployedRoster(first.transport), roster, 'the registered entry keeps its role and grant and gains no proofs');
    assert.equal(variableWrites(first).length, writes);
  } finally { await first.cleanup(); }
});

// --- The import route: the grant admits a run, its absence is refused by name, and it authorizes nothing else. ---

const operator: Principal = { id: 'operator', role: 'admin' };
const granted: Principal = { id: 'huck-engineer', role: 'producer', sessionKind: 'ai', grants: [GRANT] };
const ungranted: Principal = { id: 'unit-collector', role: 'producer', proofs: ['unit:*'] };
const tokens = new Map([operator, granted, ungranted].map(entry => [entry.id, `${entry.id}-${'t'.repeat(40)}`]));
const sha = 'a'.repeat(40), tagObject = '1'.repeat(40);
const candidate = { id: '20261017T010000Z', sha, cutAt: '2026-10-17T01:00:00.000Z', trigger: 'manual', since: null, items: [] };
/** The GitHub reads the import makes: one `rc/` tag whose annotated record is the candidate cut at `sha`. */
const github = {
  config: { repository: REPOSITORY },
  async request(path: string) {
    if (path.startsWith('/git/matching-refs/tags/rc/')) return /page=1(?:&|$)/.test(path) ? [{ ref: `refs/tags/rc/${candidate.id}`, object: { sha: tagObject, type: 'tag' } }] : [];
    if (path === `/git/tags/${tagObject}`) return { object: { sha, type: 'commit' }, message: JSON.stringify(candidate) };
    throw new Error(`unexpected GitHub read ${path}`);
  },
};
let database: EmbeddedPostgres, store: Store, http: ReturnType<typeof server>, url: string, scratch: string;

before(async () => {
  // A free port: verify runs each proof of this file at once, and a fixed port collides between them.
  const port = await freePort();
  scratch = await temporaryDirectory('principal-roster');
  database = new EmbeddedPostgres({ databaseDir: join(scratch, 'pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('principal_roster_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/principal_roster_test`); await store.init();
  const engine = new Engine(store, [15368], 120, REPOSITORY);
  http = server(engine, [operator, granted, ungranted].map(entry => ({ ...entry, token: tokens.get(entry.id)! })), github as any);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); if (scratch) await rm(scratch, { recursive: true, force: true }); });

async function call(path: string, actor: Principal, data?: unknown) {
  const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${tokens.get(actor.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { status: response.status, body: await response.json() as any };
}

test('unit:external-import-requires-grant — a producer holding external-runs:import imports a run through POST /api/validation/import; a producer without it is refused 403 naming the grant; the grant authorizes nothing else, so a principal holding only it has no proof authority and submits no trusted evidence; and a producer with no grant at all is refused at principal add as secrets.ts refuses it', async () => {
  const run = { format: 'graphyard-external-run-v1', producer: 'huck', sha, runId: 'huck-run-1', cases: [{ id: 'login', verdict: 'passed', required: true }] };
  const refused = await call('validation/import', ungranted, run);
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /requires the external-runs:import grant; producer unit-collector holds no grant/, 'the refusal names the grant');
  assert.equal((await call(`validation/import/${sha}`, operator)).body.runs.length, 0, 'a refused run is never recorded');

  const imported = await call('validation/import', granted, run);
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.deepEqual(imported.body.imported.candidate, { id: candidate.id, sha });
  assert.equal(imported.body.imported.importedBy, granted.id);
  assert.deepEqual((await call('principals', operator)).body.principals.find((entry: { id: string }) => entry.id === granted.id), { id: granted.id, role: 'producer', sessionKind: 'ai', grants: [GRANT], leases: [] }, 'the served roster lists the grant');

  // The grant is no proof authority: the single question every trusted-evidence path asks answers no for every proof.
  const client = await store.pool.connect();
  try {
    assert.deepEqual(await effectiveAuthority(client, granted), { principalId: granted.id, role: 'producer', patterns: [], source: 'environment' });
    for (const proof of ['unit:anything', 'e2e:login', 'manual:audit', 'external-runs:import']) assert.equal(await authorizedForProof(client, granted, proof), false, `${proof} is not authorized by the import grant`);
    assert.equal(await authorizedForProof(client, ungranted, 'unit:anything'), true, 'proof authority still comes from proofs alone');
  } finally { client.release(); }
  // The server's principal schema admits the grant beside the role and refuses an unknown one.
  principalSchema.parse([{ ...granted, token: tokens.get(granted.id) }]);
  assert.throws(() => principalSchema.parse([{ ...granted, grants: ['proof:*'], token: tokens.get(granted.id) }]));

  // No producer is created without a grant: not by the planner, and not by principal add.
  assert.ok(!plannedPrincipals('owner-project', { producerProofs: [] }).some(entry => entry.role === 'producer'));
  assert.throws(() => rosterEntry({ id: 'huck-engineer', role: 'producer' }), /A producer is created only with an explicit grant \(--grant external-runs:import\|delivery:observe-sha\)/);
  assert.throws(() => rosterEntry({ id: 'huck-engineer', role: 'producer', grants: [] }), /explicit grant/);
  assert.deepEqual(rosterEntry({ id: 'huck-engineer', role: 'producer', grants: [GRANT, GRANT] }), { ...huck, source: 'principal' });
});

test('unit:principal-upsert-remove-single-entry-readback — on a bundle provider (Compose) principal add rewrites the bundle with every deployed value as it stands, App variables bound outside install and an unrelated setting kept, and changes only GRAPHYARD_PRINCIPALS', async () => {
  let fixture: Harness | undefined;
  // `cat` reads back what the installer wrote, as a real machine would.
  const cat = { match: 'cat /', result: (line: string) => fixture!.transport.files.get(line.slice(4))?.content ?? { stdout: '', stderr: 'No such file', code: 1 } };
  fixture = await harness({ provider: 'compose', extraResponses: [cat] });
  try {
    const session = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'compose' }, fixture.deps);
    await applyInstall(session, await buildPlan(session));
    const { workdir } = session.context;
    // Install binds no App (GY-2009); an operator bound App variables and added a setting outside the core variables by hand.
    const env = `${workdir}/server.env`;
    const extra = ['GITHUB_APP_ID=200001', 'GITHUB_INSTALLATION_ID=500', 'OPERATOR_SETTING=keep-me'];
    fixture.transport.files.set(env, { ...fixture.transport.files.get(env)!, content: `${fixture.transport.files.get(env)!.content.trimEnd()}\n${extra.join('\n')}\n` });
    const lines = (text: string) => text.trimEnd().split('\n');
    const before = lines(fixture.transport.files.get(env)!.content);

    const added = await principal(fixture, ['add', 'huck-engineer', '--role', 'producer', '--grant', GRANT]);
    assert.equal(added.changed, true);
    assert.deepEqual(added.deployment, { provider: 'compose', service: session.context.service, variables: ['GRAPHYARD_PRINCIPALS'], rewritten: true });
    assert.deepEqual(added.readback.principal, huck);
    const after = lines(fixture.transport.files.get(env)!.content);
    const principalsLine = (all: string[]) => all.find(line => line.startsWith('GRAPHYARD_PRINCIPALS='));
    assert.deepEqual(after.filter(line => line !== principalsLine(after)).sort(), before.filter(line => line !== principalsLine(before)).sort(), 'every other variable stands as deployed');
    for (const line of extra) assert.ok(after.includes(line), `${line} is kept`);
    assert.deepEqual(deployedRoster(fixture.transport).map(entry => entry.id).at(-1), 'huck-engineer');
  } finally { await fixture.cleanup(); }
});

test('unit:principal-upsert-remove-single-entry-readback — a re-add that changes an entry reads back only once the served roster carries the new fields: a stale served entry under the same id is not taken for the change', async () => {
  const fixture = await harness({ provider: 'railway' });
  try {
    const session = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'railway' }, fixture.deps);
    await applyInstall(session, await buildPlan(session));
    await principal(fixture, ['add', 'huck-engineer', '--role', 'producer', '--grant', GRANT]);
    // The served roster lags the redeploy: the first three reads still list huck-engineer as declared before.
    let reads = 0;
    const stale = (async (input: any, init?: any) => {
      if (String(input).endsWith('/api/principals') && reads++ < 3) return new Response(JSON.stringify({ principals: [{ ...huck, leases: [] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return fixture.deps.fetch!(input, init);
    }) as typeof fetch;
    const changed = await principalCommand(['add', 'huck-engineer', '--role', 'producer', '--session-kind', 'human', '--grant', GRANT], { ...fixture.deps, fetch: stale, cwd: fixture.root });
    assert.equal(changed.changed, true);
    assert.equal(reads, 4, 'the stale entry was read three times and refused as the change');
    assert.deepEqual(changed.readback.principal, { ...huck, sessionKind: 'human' }, 'the readback is the served entry with the requested fields');
  } finally { await fixture.cleanup(); }
});

test('unit:principal-upsert-remove-single-entry-readback — overlapping roster edits never drop each other\'s entry: an edit holds the installation\'s apply lock from reading install.json until it is persisted and read back, so a second add of another id, or an install --apply planned before it, is refused and writes nothing, and once the first finishes both entries stand', async () => {
  const fixture = await harness({ provider: 'railway' });
  try {
    const session = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'railway' }, fixture.deps);
    await applyInstall(session, await buildPlan(session));
    const before = deployedRoster(fixture.transport);
    // A full apply planned now, against the roster before either edit.
    const stalePlan = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'railway' }, fixture.deps);
    const plan = await buildPlan(stalePlan);
    // The first edit is held at its readback, after it deployed and before it returns.
    let hold!: () => void, reached!: () => void;
    const held = new Promise<void>(resolve => { hold = resolve; }), atReadback = new Promise<void>(resolve => { reached = resolve; });
    const paused = (async (input: any, init?: any) => {
      if (String(input).endsWith('/api/principals')) { reached(); await held; }
      return fixture.deps.fetch!(input, init);
    }) as typeof fetch;
    const first = principalCommand(['add', 'huck-engineer', '--role', 'producer', '--grant', GRANT], { ...fixture.deps, fetch: paused, cwd: fixture.root });
    await atReadback;
    const writes = variableWrites(fixture).length;
    await assert.rejects(principal(fixture, ['add', 'huck-reader', '--role', 'reader']), /Another install --apply .* holds the lock/);
    await assert.rejects(principal(fixture, ['remove', 'huck-engineer']), /holds the lock/);
    await assert.rejects(applyInstall(stalePlan, plan), /holds the lock/);
    assert.equal(variableWrites(fixture).length, writes, 'a refused edit or apply writes nothing while the first edit holds the lock');
    hold();
    assert.equal((await first).changed, true);
    // The apply planned before the edit no longer deploys a roster without it.
    await assert.rejects(applyInstall(stalePlan, plan), /roster in .*install\.json changed after this apply was planned/);
    assert.equal(variableWrites(fixture).length, writes);
    const second = await principal(fixture, ['add', 'huck-reader', '--role', 'reader']);
    assert.equal(second.changed, true);
    const roster = deployedRoster(fixture.transport);
    assert.deepEqual(roster.map(entry => entry.id), [...before.map(entry => entry.id), 'huck-engineer', 'huck-reader']);
    assert.deepEqual(roster.slice(0, before.length), before);
    assert.deepEqual((await recordOf(session.directory)).principals.map((entry: { id: string }) => entry.id), roster.map(entry => entry.id));
  } finally { await fixture.cleanup(); }
});

test('unit:principal-upsert-remove-single-entry-readback — principal add reaches the deployment where install --apply reached it: a Hetzner bundle over SSH at the server\'s address, a Docker host at its recorded host and user, a Compose bundle on its own port; principal remove on a self-contained host deletes the removed credential there', async () => {
  const lines = (transport: Harness['transport']) => transport.commands.map(command => [command.program, ...command.args].join(' '));
  // Each remote answers `cat` from the files written to it, as a real machine would.
  const remoteCat = (files: () => Harness['hostFiles']) => ({ match: 'cat /opt/graphyard/', result: (line: string) => files().get(line.slice(4))?.content ?? { stdout: '', stderr: 'No such file', code: 1 } });

  // Hetzner server-only: the bundle is read and rewritten on the server, never on this machine.
  let hetzner: Harness | undefined;
  hetzner = await harness({ provider: 'hetzner', extraResponses: [remoteCat(() => hetzner!.hostFiles)] });
  try {
    const session = await prepareInstall(hetzner.root, { repository: REPOSITORY, provider: 'hetzner', sshKey: 'graphyard-key', maxMonthly: 50, domain: 'graphyard.example.test' }, hetzner.deps);
    await applyInstall(session, await buildPlan(session));
    const added = await principal(hetzner, ['add', 'huck-engineer', '--role', 'producer', '--grant', GRANT]);
    assert.deepEqual(added.readback.principal, huck);
    const env = `${session.context.workdir}/server.env`;
    assert.ok(lines(hetzner.remotes.get('203.0.113.10')!).includes(`cat ${env}`), 'the server\'s bundle is read over SSH at its address');
    assert.ok(!lines(hetzner.transport).includes(`cat ${env}`), 'no local file is taken for the server\'s bundle');
    assert.equal(deployedRoster(hetzner.transport, hetzner.remotes).at(-1)!.id, 'huck-engineer');
  } finally { await hetzner.cleanup(); }

  // A Docker host: the recorded host and SSH user are reached again; a record that predates them is refused before anything is written.
  let docker: Harness | undefined;
  docker = await harness({ provider: 'docker-host', extraResponses: [remoteCat(() => docker!.hostFiles)] });
  try {
    const session = await prepareInstall(docker.root, { repository: REPOSITORY, provider: 'docker-host', sshHost: '203.0.113.30', sshUser: 'deploy', domain: 'graphyard.example.test' }, docker.deps);
    await applyInstall(session, await buildPlan(session));
    assert.deepEqual((await recordOf(session.directory)).deployment, { sshHost: '203.0.113.30', sshUser: 'deploy', local: false, port: null, image: null });
    const reached: string[] = [];
    const ssh = (host: string, user?: string) => { reached.push(`${user}@${host}`); return docker!.deps.ssh!(host, user); };
    const added = await principalCommand(['add', 'huck-engineer', '--role', 'producer', '--grant', GRANT], { ...docker.deps, ssh, cwd: docker.root });
    assert.deepEqual(added.readback.principal, huck);
    assert.ok(reached.length > 0 && reached.every(entry => entry === 'deploy@203.0.113.30'), `every SSH session reaches the recorded host as its user: ${reached.join(', ')}`);
    const record = await recordOf(session.directory);
    await writeFile(join(session.directory, 'install.json'), JSON.stringify({ ...record, deployment: null }));
    await assert.rejects(principal(docker, ['remove', 'huck-engineer']), /does not record the host this installation runs on; rerun graphyard install --apply/);
  } finally { await docker.cleanup(); }

  // Compose on a port of its own: the rewritten bundle keeps publishing it, from the record or, for an older record, from the bundle itself.
  let compose: Harness | undefined;
  const cat = { match: 'cat /', result: (line: string) => compose!.transport.files.get(line.slice(4))?.content ?? { stdout: '', stderr: 'No such file', code: 1 } };
  compose = await harness({ provider: 'compose', extraResponses: [cat] });
  try {
    const session = await prepareInstall(compose.root, { repository: REPOSITORY, provider: 'compose', port: 4317 }, compose.deps);
    await applyInstall(session, await buildPlan(session));
    const bundle = () => compose!.transport.files.get(`${session.context.workdir}/compose.yaml`)!.content;
    assert.match(bundle(), /127\.0\.0\.1:4317:/);
    assert.equal((await recordOf(session.directory)).deployment.port, 4317);
    await principal(compose, ['add', 'huck-engineer', '--role', 'producer', '--grant', GRANT]);
    assert.match(bundle(), /127\.0\.0\.1:4317:/, 'the recorded port is kept');
    const record = await recordOf(session.directory);
    await writeFile(join(session.directory, 'install.json'), JSON.stringify({ ...record, deployment: null }));
    await principal(compose, ['remove', 'huck-engineer']);
    assert.match(bundle(), /127\.0\.0\.1:4317:/, 'an older record keeps the port the bundle publishes');
    assert.doesNotMatch(bundle(), /127\.0\.0\.1:4310:/);
  } finally { await compose.cleanup(); }

  // A self-contained host keeps credentials on the host: removing a principal deletes its token file there and no other.
  let host: Harness | undefined;
  host = await harness({ provider: 'host', serverUrl: 'https://graphyard.example.test', extraResponses: [remoteCat(() => host!.hostFiles)] });
  try {
    const session = await prepareInstall(host.root, { repository: REPOSITORY, provider: 'host', selfContained: true, sshHost: '203.0.113.20', sshUser: 'root', domain: 'graphyard.example.test' }, host.deps);
    await applyInstall(session, await buildPlan(session));
    const tokens = '/home/graphyard/.config/graphyard/owner-project/tokens';
    // The unredeemed dashboard sign-in claim install --apply printed keeps working: a roster edit mints none.
    const claim = () => host!.hostFiles.get(`${session.context.workdir}/server.env`)!.content.split('\n').filter(line => line.startsWith('GRAPHYARD_SIGNIN_CLAIM='));
    const installed = claim();
    assert.equal(installed.length, 1, 'install --apply deploys one sign-in claim');
    const added = await principal(host, ['add', 'huck-engineer', '--role', 'producer', '--grant', GRANT]);
    assert.ok(host.hostFiles.has(`${tokens}/huck-engineer.token`), 'the added credential is written on the host');
    assert.deepEqual(claim(), installed, 'principal add keeps the deployed sign-in claim');
    assert.ok(!('signIn' in added), 'no new sign-in link is minted');
    await principal(host, ['remove', 'huck-engineer']);
    assert.deepEqual(claim(), installed, 'principal remove keeps the deployed sign-in claim');
    const removals = lines(host.remotes.get('203.0.113.20')!).filter(line => line.startsWith('rm -f '));
    assert.deepEqual(removals, [`rm -f ${tokens}/huck-engineer.token`], 'only the removed principal\'s token is deleted');
    assert.ok(!deployedRoster(host.transport, host.remotes).some(entry => entry.id === 'huck-engineer'));
  } finally { await host.cleanup(); }
});
