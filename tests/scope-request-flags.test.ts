import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-522, server half: the CLI's flag parsing is gone with the command it served (GY-1991 —
// `scope-request` files nothing), and the server still refuses a flag-shaped path on every route
// that records one, whatever the client sends.
const repository = 'owner/scope-flags';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, implementer].map(principal => ({ ...principal, token: `flags-${principal.id}-${'x'.repeat(32)}` }));
const master = { id: 'master-operator', token: `master-operator-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements'] };
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const call = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const result = await call(credential, method, path, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const input = (title: string) => ({ title, plannedFiles: ['src/widget/Layout.tsx'], criteria: [{ id: 'AC-1', text: 'Layout renders', proofs: ['unit:layout'] }], reason: 'Operator goal: a flag is never a planned path' });
const revision = (work: Work, plannedFiles: string[]) => ({ expectedPolicyRevision: work.policyRevision, criteria: work.criteria, dependencies: work.dependencies, plannedFiles, exclusiveResources: work.exclusiveResources ?? [], producerProofs: work.producerProofs ?? [] });

async function claimed(title: string) {
  let work = await ok(master.token, 'POST', 'work', input(title)) as Work;
  work = await ok(master.token, 'POST', `work/${work.id}/ready`, { expectedRevision: work.revision, reason: 'Ready for the flag attempt' }) as Work;
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  return reload(work.id);
}

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 437;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('scope-flags-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('scope_flags_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/scope_flags_test`); await store.init();
  engine = new Engine(store, 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  await ok(token(operator), 'POST', 'operator-agents', { id: master.id, displayName: master.id, capabilities: master.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: master.token, reason: 'Onboarding provisions the master operator agent' });
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('unit:planned-path-rejects-flags — the server refuses a scope request and a requirements revision naming a path that begins with -, naming the entry', async () => {
  const work = await claimed('flag paths');
  const scope = await call(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: ['docs/widget.md', '--wait'], reason: 'Documentation for the widget' });
  assert.equal(scope.status, 422, JSON.stringify(scope.body));
  assert.match(scope.body.error, /'--wait' begins with '-'/);
  const typed = await call(token(implementer), 'POST', `work/${work.id}/request`, { type: 'scope-request', epoch: work.epoch, paths: ['-x'], reason: 'Documentation for the widget' });
  assert.equal(typed.status, 422, JSON.stringify(typed.body));
  assert.match(typed.body.error, /'-x' begins with '-'/);
  assert.equal((await reload(work.id)).scopeRequest ?? null, null, 'nothing was recorded');

  // The worker's legitimate ask still files.
  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: ['docs/widget.md'], reason: 'Documentation for the widget' });

  const current = await reload(work.id);
  const direct = await call(master.token, 'POST', `work/${work.id}/requirements`, { ...revision(current, [...current.plannedFiles, '--wait']), reason: 'Widen for the worker' });
  assert.equal(direct.status, 422, JSON.stringify(direct.body));
  assert.match(direct.body.error, /plannedFiles entry '--wait' begins with '-'/);
  const decided = await call(master.token, 'POST', `work/${work.id}/decide`, { action: 'requirements', input: revision(current, [...current.plannedFiles, '--wait']), reason: 'Widen for the worker' });
  assert.equal(decided.status, 422, JSON.stringify(decided.body));
  assert.match(decided.body.error, /plannedFiles entry '--wait' begins with '-'/);
  const admin = await call(token(operator), 'POST', `work/${work.id}/requirements`, { ...revision(current, ['-src/']), reason: 'Operator revision' });
  assert.equal(admin.status, 422, JSON.stringify(admin.body));
  assert.equal((await reload(work.id)).plannedFiles.some(path => path.startsWith('-')), false);
});
