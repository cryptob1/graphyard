import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import { defaultRepositoryPolicy, setRepositoryPolicy } from '../src/model/repository-policy.js';

// GY-2965: every user-facing item owes an end-to-end proof.
// AC-1: master create and requirements refuse a feature or bug item without an e2e: proof, naming
// the case format and the opt-out; each is accepted with an e2e: proof, with the opt-out sentence,
// or as a chore.
// AC-3: create refuses an e2e: proof in a repository declaring neither e2e.serve nor a previewable
// application, naming the declaration to add; docs/validation.md documents the rule.

const servePolicy = { ...defaultRepositoryPolicy, e2e: { pendingOutcomes: 'non-blocking' as const, serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } };

let pg: InstanceType<typeof EmbeddedPostgres>, store: Store, engine: Engine;
const operator: Principal = { id: 'operator', role: 'admin' };
const id = () => randomUUID();
const feature = (overrides: Record<string, unknown> = {}) => ({ title: 'A user-visible change', criteria: [{ id: 'AC-1', text: 'The change works', proofs: ['unit:works'] }], ...overrides });
const bug = (overrides: Record<string, unknown> = {}) => ({ ...feature(overrides), type: 'bug', title: 'A user-visible break' });
const chore = (overrides: Record<string, unknown> = {}) => ({ ...feature(overrides), type: 'chore' });
const withE2e = (input: Record<string, unknown>) => ({ ...input, criteria: [{ id: 'AC-1', text: 'The change works', proofs: ['e2e:capacity-limit-redispatch'] }] });

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 402;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('user-facing-e2e'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('user_facing_e2e_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/user_facing_e2e_test`); await store.init();
  engine = new Engine(store, 120, 'owner/project');
  engine.operatorAuthorizer = async (_db, _now, actor) => actor;
  setRepositoryPolicy(servePolicy);
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

test('unit:user-facing-items-require-e2e-proof — create refuses a feature item and a bug item without an e2e: proof, naming the case format and the opt-out', async () => {
  for (const [name, input] of [['feature', feature()], ['bug', bug()]] as const) {
    const refusal = await engine.execute(operator, 'create', null, input, id()).catch((error: Error) => error.message);
    const message = JSON.parse(refusal).map((issue: { message: string }) => issue.message).join('\n');
    assert.match(message, new RegExp(`a ${name} item a user can see owes an end-to-end proof`));
    assert.match(message, /e2e\/cases\/NAME\.json/, 'the refusal names the case format');
    assert.match(message, /No user-facing change/, 'the refusal names the opt-out');
  }
});

test('unit:user-facing-items-require-e2e-proof — create accepts a feature and a bug item with an e2e: proof, with the opt-out sentence, and a chore without any', async () => {
  for (const input of [withE2e(feature()), withE2e(bug())]) {
    const work = await engine.execute(operator, 'create', null, input, id());
    assert.equal(work.type === 'bug' ? work.type : 'feature', work.type);
    assert.equal(work.scenarioRequirements.length, 1, 'the e2e proof pins its scenario');
  }
  const opted = { ...feature(), description: 'No user-facing change: the refactor moves code without changing behaviour' };
  const optedBug = { ...bug(), description: 'No user-facing change: a crash fix behind a flag nothing serves yet' };
  for (const input of [opted, optedBug]) {
    const work = await engine.execute(operator, 'create', null, input, id());
    assert.equal(work.criteria[0].proofs[0], 'unit:works');
  }
  const choreWork = await engine.execute(operator, 'create', null, chore(), id());
  assert.equal(choreWork.type, 'chore');
  // The opt-out needs a reason: the bare sentence is no opt-out.
  await assert.rejects(engine.execute(operator, 'create', null, { ...feature(), description: 'No user-facing change:' }, id()), /owes an end-to-end proof/);
});

test('unit:user-facing-items-require-e2e-proof — requirements refuses a revision that drops the item\u2019s e2e proof and accepts one that keeps it or opts out', async () => {
  const work = await engine.execute(operator, 'create', null, withE2e(feature()), id()) as Work;
  const revision = { expectedPolicyRevision: work.policyRevision, reason: 'Rewriting the criteria', dependencies: [], exclusiveResources: [] };
  await assert.rejects(engine.execute(operator, 'requirements', work.id, { ...revision, criteria: [{ id: 'AC-1', text: 'The change works', proofs: ['unit:works'] }] }, id()),
    /owes an end-to-end proof[\s\S]*e2e\/cases\/NAME\.json[\s\S]*No user-facing change/);
  await assert.rejects(engine.execute(operator, 'requirements', work.id, { ...revision, criteria: [{ id: 'AC-1', text: 'The change works', proofs: ['integration:works'] }] }, id()),
    /owes an end-to-end proof/);
  const revised = await engine.execute(operator, 'requirements', work.id, { ...revision,
    criteria: [{ id: 'AC-1', text: 'The change works', proofs: ['e2e:capacity-limit-redispatch', 'unit:works'] }] }, id());
  assert.equal(revised.criteria[0].proofs[0], 'e2e:capacity-limit-redispatch');
  const opted = await engine.execute(operator, 'create', null, { ...feature(), description: 'No user-facing change: docs only' }, id()) as Work;
  const revisedOpted = await engine.execute(operator, 'requirements', opted.id,
    { expectedPolicyRevision: opted.policyRevision, reason: 'Rewriting the criteria', dependencies: [], exclusiveResources: [], criteria: [{ id: 'AC-1', text: 'Still no behaviour', proofs: ['unit:docs'] }] }, id());
  assert.equal(revisedOpted.criteria[0].proofs[0], 'unit:docs', 'the opt-out sentence on the item excuses its revisions');
  const choreItem = await engine.execute(operator, 'create', null, chore(), id()) as Work;
  const revisedChore = await engine.execute(operator, 'requirements', choreItem.id,
    { expectedPolicyRevision: choreItem.policyRevision, reason: 'Rewriting the criteria', dependencies: [], exclusiveResources: [], criteria: [{ id: 'AC-1', text: 'Holds', proofs: ['unit:chore'] }] }, id());
  assert.equal(revisedChore.criteria[0].proofs[0], 'unit:chore');
});

test('unit:e2e-serve-declaration-required-and-documented — create refuses an e2e: proof where the repository declares neither e2e.serve nor a previewable application, naming the declaration', async () => {
  setRepositoryPolicy({ ...defaultRepositoryPolicy, e2e: { pendingOutcomes: 'non-blocking', serve: null } });
  try {
    const refusal = await engine.execute(operator, 'create', null, withE2e(feature()), id()).catch((error: Error) => error.message);
    const message = JSON.parse(refusal).map((issue: { message: string }) => issue.message).join('\n');
    assert.match(message, /e2e:capacity-limit-redispatch has no way to serve a head/);
    assert.match(message, /"e2e": \{ "serve": \{ "command", "url", "readySeconds" \} \} in graphyard\.json/);
    assert.match(message, /delivery\.applications/);
  } finally { setRepositoryPolicy(servePolicy); }
  const accepted = await engine.execute(operator, 'create', null, withE2e(feature()), id());
  assert.equal(accepted.scenarioRequirements.length, 1, 'with the serve declared, the same create is accepted');
});

test('unit:e2e-serve-declaration-required-and-documented — docs/validation.md describes the per-item rule, the binding, the serve declaration and the opt-out', () => {
  const docs = readFileSync(join('docs', 'validation.md'), 'utf8');
  for (const named of ['every user-facing', 'e2e:NAME', 'e2e/cases/NAME.json', 'e2e.serve', 'readySeconds', 'No user-facing change:']) {
    assert.ok(docs.toLowerCase().includes(named.toLowerCase()) || docs.includes(named), `docs/validation.md names ${named}`);
  }
});
