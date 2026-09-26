import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { liveScopeWidening } from '../src/model/scope.js';
import type { MasterConfig } from '../src/master.js';
import type { Principal, ScopeFile, Work } from '../src/model.js';
import { regressionRefusals } from '../src/regression-guard.js';
import { approveScopeRequest, scopeRequestAttention } from '../src/cli/master-status.js';
import { Store } from '../src/store.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-76: a purely additive plannedFiles widening applies to an item under an active lease
// without ending the attempt, a worker asks for it through a scope request the master approves
// with one command, and every non-additive change under a lease is still refused. Each test is
// named for the proof it produces.
const repository = 'owner/live-scope';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, implementer].map(principal => ({ ...principal, token: `scope-${principal.id}-${'x'.repeat(32)}` }));
const master = { id: 'master-operator', token: `master-operator-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements'] };
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, operatorTokenFile: string;
const specFile: ScopeFile = { path: 'web/Widget.spec.tsx', status: 'modified', sha: 'c'.repeat(40), baseSha: 'd'.repeat(40), additions: 4, deletions: 2, binary: false };
const reason = 'The browser specs assert the layout this item removes';

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
const events = async (work: Work) => (await store.pool.query('SELECT actor, kind, payload FROM events WHERE work_id=$1 ORDER BY seq', [work.id])).rows;
const input = (title: string) => ({ title, plannedFiles: ['src/widget/Layout.tsx'], criteria: [{ id: 'AC-1', text: 'Layout renders', proofs: ['unit:layout'] }], reason: 'Operator goal: scope widening never forces a hand-back' });
const widen = (work: Work, paths: string[]) => ({ expectedPolicyRevision: work.policyRevision, criteria: work.criteria, dependencies: work.dependencies, plannedFiles: [...work.plannedFiles, ...paths], exclusiveResources: work.exclusiveResources ?? [], producerProofs: work.producerProofs ?? [] });

async function claimed(title: string) {
  let work = await ok(master.token, 'POST', 'work', input(title)) as Work;
  work = await ok(master.token, 'POST', `work/${work.id}/ready`, { expectedRevision: work.revision, reason: 'Ready for the live-scope attempt' }) as Work;
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(implementer, 'workspace', work.id, { epoch: work.epoch, host: 'scope-host', path: `/tmp/scope/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, randomUUID());
  return reload(work.id);
}
const masterScopeConfig = () => ({ url, operatorAgent: { credentialFile: operatorTokenFile } }) as unknown as MasterConfig;
const snapshotRead = (path: string) => ok(token(operator), 'GET', path);

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 21;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('live-scope-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('live_scope_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/live_scope_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  await ok(token(operator), 'POST', 'operator-agents', { id: master.id, displayName: master.id, capabilities: master.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: master.token, reason: 'Onboarding provisions the master operator agent' });
  operatorTokenFile = join(await temporaryDirectory('live-scope'), 'operator.token');
  await writeFile(operatorTokenFile, `${master.token}\n`, { mode: 0o600 });
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('integration:live-scope-widening — an additive plannedFiles widening applies under a live lease and reaches the worker scope check immediately', async () => {
  let work = await claimed('widening');
  assert.ok(work.lease && work.lease.owner === implementer.id && Date.parse(work.lease.expiresAt) > Date.now());
  assert.ok(regressionRefusals(work, { scopeFiles: [specFile] }, []).length, 'before widening, the spec file is outside plannedFiles and refused');

  const widened = await ok(master.token, 'POST', `work/${work.id}/requirements`, { ...widen(work, [specFile.path]), reason });
  work = await reload(work.id);
  assert.deepEqual(work.plannedFiles, ['src/widget/Layout.tsx', specFile.path]);
  assert.equal(work.policyRevision, widened.policyRevision);
  assert.ok(work.lease && work.lease.epoch === widened.epoch && work.lease.owner === implementer.id, 'the attempt keeps its lease');
  const ledger = await events(work);
  const row = ledger.filter(entry => entry.kind === 'requirements').at(-1)!;
  assert.equal(row.actor, master.id);
  assert.equal(row.payload.details.liveScopeWidening, true);
  assert.deepEqual(row.payload.details.before.plannedFiles, ['src/widget/Layout.tsx']);
  assert.ok(row.payload.work.plannedFiles.includes(specFile.path));
  const beats = await engine.execute(implementer, 'heartbeat', work.id, { epoch: work.epoch }, randomUUID());
  assert.ok(Date.parse(beats.lease!.expiresAt) >= Date.parse(work.lease!.expiresAt), 'the worker keeps heartbeating the same attempt');
  assert.equal(regressionRefusals(work, { scopeFiles: [specFile] }, []).length, 0, 'the worker scope check sees the widened scope immediately');

  for (const broken of [
    { ...widen(work, []), plannedFiles: work.plannedFiles.slice(1) },
    { ...widen(work, []), criteria: [{ ...work.criteria[0], text: 'Layout renders everywhere' }] },
  ]) {
    const refused = await call(master.token, 'POST', `work/${work.id}/requirements`, { ...broken, reason: 'Under a live lease nothing else may change' });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.error, /Stop and release the active worker before revising requirements/);
  }
  work = await reload(work.id);
  assert.deepEqual(work.plannedFiles, ['src/widget/Layout.tsx', specFile.path], 'refused revisions change nothing');

  await engine.execute(implementer, 'quarantine', work.id, { epoch: work.epoch, settlementHash: 'e'.repeat(64) }, randomUUID());
  const quarantined = await call(master.token, 'POST', `work/${work.id}/requirements`, { ...widen(work, []), reason: 'A no-op under quarantine is still a revision' });
  assert.match(quarantined.body.error, /quarantined by unverified containment from epoch 1; requirements remain immutable until settlement or stopped-worker recovery/);
  await ok(master.token, 'POST', `work/${work.id}/requirements`, { ...widen(work, ['docs/widget.md']), reason: 'The docs page embeds the layout' });
  work = await reload(work.id);
  assert.deepEqual(work.plannedFiles, ['src/widget/Layout.tsx', specFile.path, 'docs/widget.md']);
  assert.ok(work.containmentQuarantine && work.containmentQuarantine.epoch === work.epoch, 'the live quarantine survives a live widening');
  assert.ok(work.lease && work.lease.epoch === work.epoch, 'the live lease survives a live widening');
});

test('integration:scope-request-flow — the request surfaces to the master and one command applies it without ending the attempt', async () => {
  let work = await claimed('request');
  const requested = await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: [specFile.path], reason }) as Work;
  assert.deepEqual(requested.scopeRequest, { epoch: work.epoch, paths: [specFile.path], reason, requestedBy: implementer.id, at: requested.scopeRequest!.at });
  work = await reload(work.id);
  const ledger = await events(work);
  assert.equal(ledger.filter(entry => entry.kind === 'scope').at(-1)!.actor, implementer.id);

  const now = new Date().toISOString();
  const items = scopeRequestAttention({ work: [work], now });
  assert.equal(items.length, 1);
  assert.equal(items[0].subject, work.key);
  assert.match(items[0].text, new RegExp(`${implementer.id} needs files outside plannedFiles`));
  assert.match(items[0].text, new RegExp(specFile.path.replace('.', '\\.')));
  assert.match(items[0].text, /browser specs assert the layout/);
  assert.equal(items[0].role, 'master');
  assert.equal(items[0].human, false);
  assert.equal(items[0].next, `graphyard master scope ${work.key}`);

  const applied = await approveScopeRequest(process.cwd(), masterScopeConfig(), [work.key], { coordinator: snapshotRead }) as Work;
  assert.deepEqual(applied.plannedFiles, ['src/widget/Layout.tsx', specFile.path]);
  work = await reload(work.id);
  assert.equal(work.scopeRequest, null, 'the answered request is cleared');
  assert.ok(work.lease && work.lease.epoch === requested.epoch, 'the attempt keeps its lease');
  assert.equal(scopeRequestAttention({ work: [work], now: new Date().toISOString() }).length, 0);
  const requirements = (await events(work)).filter(entry => entry.kind === 'requirements').at(-1)!;
  assert.equal(requirements.actor, master.id);
  assert.equal(requirements.payload.details.liveScopeWidening, true);
  assert.match(requirements.payload.details.reason, new RegExp(`Approve ${implementer.id}`));

  const inside = await call(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: ['src/widget/Layout.tsx'], reason: 'already planned' });
  assert.equal(inside.status, 409, JSON.stringify(inside.body));
  assert.match(inside.body.error, /Every named path is already inside plannedFiles/);

  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: ['docs/widget.md'], reason: 'Still needed' });
  work = await reload(work.id);
  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: [], reason: 'Withdrawn by the worker' });
  work = await reload(work.id);
  assert.equal(work.scopeRequest, null, 'the worker can withdraw the request');
  const empty = await call(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: [], reason: 'Nothing to withdraw' });
  assert.match(empty.body.error, /No scope request is open for this attempt/);

  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: ['docs/widget.md'], reason: 'Still needed' });
  work = await reload(work.id);
  await engine.execute(implementer, 'release', work.id, { epoch: work.epoch }, randomUUID());
  work = await reload(work.id);
  assert.equal(scopeRequestAttention({ work: [work], now: new Date().toISOString() }).length, 0, 'a request whose lease ended is never surfaced');
  // The release ended the attempt that asked, so it closed the request (GY-597): nothing is left to approve.
  assert.equal(work.scopeRequest, null, 'the ended attempt\'s request is closed');
  await assert.rejects(approveScopeRequest(process.cwd(), masterScopeConfig(), [work.key], { coordinator: snapshotRead }), /no open scope request to approve/);
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  assert.equal(work.scopeRequest, null, 'a fresh attempt asks afresh');
});

test('unit:live-scope-change-guard — only adding planned files is a live widening; removals, criterion and proof changes are not', () => {
  const current = { criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], dependencies: [] as string[], plannedFiles: ['src/a.ts'], exclusiveResources: [] as string[], producerProofs: [] as string[] };
  assert.equal(liveScopeWidening(current, { ...current, plannedFiles: ['src/a.ts', 'src/b.ts'] }), true);
  assert.equal(liveScopeWidening(current, { ...current, plannedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }), true);
  assert.equal(liveScopeWidening(current, { ...current }), false, 'no added file is not a widening');
  assert.equal(liveScopeWidening(current, { ...current, plannedFiles: ['src/b.ts'] }), false, 'removal is not a widening');
  assert.equal(liveScopeWidening(current, { ...current, plannedFiles: ['src/a.ts', 'src/a.ts'] }), false, 'a duplicate is not an added file');
  assert.equal(liveScopeWidening(current, { ...current, criteria: [{ id: 'AC-1', text: 'Works everywhere', proofs: ['unit:works'] }] }), false, 'a criterion rewrite is not a widening');
  assert.equal(liveScopeWidening(current, { ...current, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works-again'] }] }), false, 'a proof change is not a widening');
  assert.equal(liveScopeWidening(current, { ...current, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }, { id: 'AC-2', text: 'More', proofs: ['unit:more'] }] }), false, 'an added criterion is not a scope widening');
  assert.equal(liveScopeWidening(current, { ...current, dependencies: ['5f0f5f0f-0000-4000-8000-000000000000'] }), false, 'a dependency change is not a widening');
  assert.equal(liveScopeWidening(current, { ...current, exclusiveResources: ['db'] }), false, 'a resource change is not a widening');
  assert.equal(liveScopeWidening(current, { ...current, producerProofs: ['manual:audit'] }), false, 'a producer-proof change is not a widening');
  assert.equal(liveScopeWidening({ ...current, producerProofs: undefined }, { ...current, plannedFiles: ['src/a.ts', 'src/b.ts'] }), true, 'unset and empty lists mean the same');
  const bootstrapped = { ...current, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'], bootstrap: { reason: 'harness', contractPaths: ['src/a.ts'], declaredBy: 'op', declaredAt: 't0', policyRevision: 1 } }] };
  const echoed = { ...bootstrapped, criteria: [{ proofs: ['unit:works'], id: 'AC-1', text: 'Works', bootstrap: { policyRevision: 1, declaredAt: 't0', declaredBy: 'op', contractPaths: ['src/a.ts'], reason: 'harness' } }], plannedFiles: ['src/a.ts', 'src/b.ts'] };
  assert.equal(liveScopeWidening(bootstrapped, echoed), true, 'a verbatim echo of the stored criteria, any key order, widens');
});

test('integration:repair-scope-on-requirements — a merge-path repair keeps its plannedFiles within the merge path on every requirements revision (GY-428)', async () => {
  let work = await engine.execute(operator, 'create', randomUUID(), { title: 'Repair the merge path', plannedFiles: ['src/merge-queue.ts'], criteria: [{ id: 'AC-1', text: 'Merges again', proofs: ['unit:merges'] }], repair: 'merge-path' }, randomUUID());
  await assert.rejects(engine.execute(operator, 'requirements', work.id, { ...widen(work, ['src/engine.ts']), reason: 'Widen past the merge path' }, randomUUID()),
    /carries "repair": "merge-path" but plans files outside the merge path .*: src\/engine\.ts/);
  work = await engine.execute(operator, 'requirements', work.id, { ...widen(work, ['src/daemon/cycle.ts']), reason: 'Widen within the merge path' }, randomUUID());
  assert.deepEqual(work.plannedFiles, ['src/merge-queue.ts', 'src/daemon/cycle.ts']);
});
