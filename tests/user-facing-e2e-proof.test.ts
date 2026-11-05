import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { withDatabase } from './helpers/postgres.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import { defaultRepositoryPolicy } from '../src/model/repository-policy.js';
import { setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import { defineScenario } from '../src/scenarios.js';
import { server } from '../src/server.js';
import { parseCase } from '../src/e2e/case.js';
import { runCases } from '../src/e2e/runner.js';

// GY-3037: every item owes an end-to-end proof — a new case or an existing one, with no chore
// exemption and no opt-out.
// AC-1: create and requirements refuse a chore, a bug and a feature without an e2e: proof, whatever
// the description opens with; each is accepted with an e2e: proof.
// AC-3: create refuses an e2e: proof in a repository declaring neither e2e.serve nor a previewable
// application, naming the declaration to add.

const servePolicy = { ...defaultRepositoryPolicy, e2e: { pendingOutcomes: 'non-blocking' as const, serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } };

let store: Store, engine: Engine;
const operator: Principal = { id: 'operator', role: 'admin' };
const id = () => randomUUID();
const item = (overrides: Record<string, unknown> = {}) => ({ title: 'A change', criteria: [{ id: 'AC-1', text: 'The change works', proofs: ['unit:works'] }], ...overrides });
const of = (type: string, overrides: Record<string, unknown> = {}) => item({ ...overrides, type });
const withE2e = (input: Record<string, unknown>) => ({ ...input, criteria: [{ id: 'AC-1', text: 'The change works', proofs: ['e2e:home-shows-change'] }] });
const refusalOf = async (input: Record<string, unknown>) => {
  const refusal = await engine.execute(operator, 'create', null, input, id()).then(() => '', (error: Error) => error.message);
  return JSON.parse(refusal).map((issue: { message: string }) => issue.message).join('\n');
};

before(async () => {
  store = await withDatabase('user-facing-e2e-proof'); await store.init();
  engine = new Engine(store, 120, 'owner/project');
  engine.operatorAuthorizer = async (_db, _now, actor) => actor;
  setRepositoryPolicy(servePolicy);
  // GY-1708: create resolves each e2e: proof's scenario, so this fixture registers the one it names.
  await defineScenario(store, operator, { id: 'home-shows-change', title: 'The home page shows the change', purpose: 'The home page shows the change',
    steps: ['open /'], expected: ['the change is shown'], environment: 'any', runner: 'graphyard-e2e', testPath: 'e2e/cases/home-shows-change.json' }, id());
});
after(async () => { if (store) await store.close(); });

test('unit:every-item-owes-e2e-proof — the shipped E2E cases exercise filing against the served API', async () => {
  const token = 'e2e-filing-test-'.padEnd(40, 'x');
  engine.principals = [operator];
  const http = server(engine, [{ ...operator, token }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  try {
    const cases = ['every-item-owes-e2e', 'create-work-item'].map(name => {
      const file = `e2e/cases/${name}.json`;
      return { file, definition: parseCase(file, readFileSync(file, 'utf8')) };
    });
    const report = await runCases(cases, { url: `http://127.0.0.1:${(http.address() as any).port}`, token, withholdSecrets: true });
    assert.equal(report.failed, 0, JSON.stringify(report.cases));
    assert.equal(report.passed, 2);
    assert.equal(report.cases[0].executed, 9);
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); }
});

test('unit:every-item-owes-e2e-proof — create refuses a chore, a bug and a feature without an e2e: proof, naming the case format', async () => {
  for (const type of ['chore', 'bug', 'feature'] as const) {
    const message = await refusalOf(of(type));
    assert.match(message, new RegExp(`a ${type} item owes an end-to-end proof`), `a ${type} is refused`);
    assert.match(message, /e2e\/cases\/NAME\.json/, 'the refusal names the case format');
    assert.doesNotMatch(message, /No user-facing change/, 'no opt-out is named: there is none');
  }
});

test('unit:every-item-owes-e2e-proof — a description opening "No user-facing change:" does not change that, and each type is accepted with an e2e: proof', async () => {
  for (const type of ['chore', 'bug', 'feature'] as const) {
    const opted = await refusalOf(of(type, { description: 'No user-facing change: the refactor moves code without changing behaviour' }));
    assert.match(opted, new RegExp(`a ${type} item owes an end-to-end proof`), `the opt-out sentence does not excuse a ${type}`);
    const work = await engine.execute(operator, 'create', null, withE2e(of(type, { description: 'No user-facing change: internal work' })), id()) as Work;
    assert.equal(work.type, type);
    assert.equal(work.scenarioRequirements.length, 1, 'the e2e proof pins its scenario');
  }
});

test('unit:every-item-owes-e2e-proof — requirements refuses a revision that drops the item\u2019s e2e proof and accepts one that keeps it, of every type', async () => {
  for (const type of ['chore', 'bug', 'feature'] as const) {
    const work = await engine.execute(operator, 'create', null, withE2e(of(type, { description: 'No user-facing change: internal work' })), id()) as Work;
    assert.equal(work.type, type);
    const revision = { expectedPolicyRevision: work.policyRevision, reason: 'Rewriting the criteria', dependencies: [], exclusiveResources: [] };
    await assert.rejects(engine.execute(operator, 'requirements', work.id, { ...revision, criteria: [{ id: 'AC-1', text: 'The change works', proofs: ['unit:works'] }] }, id()),
      /owes an end-to-end proof[\s\S]*e2e\/cases\/NAME\.json/);
    await assert.rejects(engine.execute(operator, 'requirements', work.id, { ...revision, criteria: [{ id: 'AC-1', text: 'Still no behaviour', proofs: ['unit:docs'] }] }, id()),
      /owes an end-to-end proof/, 'a revision that drops the proof is refused whatever the item\u2019s description says');
    const revised = await engine.execute(operator, 'requirements', work.id, { ...revision,
      criteria: [{ id: 'AC-1', text: 'The change works', proofs: ['e2e:home-shows-change', 'unit:works'] }] }, id());
    assert.equal(revised.criteria[0].proofs[0], 'e2e:home-shows-change');
  }
});

test('unit:e2e-serve-declaration-required-and-documented — create refuses an e2e: proof where the repository declares neither e2e.serve nor a previewable application, naming the declaration', async () => {
  setRepositoryPolicy({ ...defaultRepositoryPolicy, e2e: { pendingOutcomes: 'non-blocking', serve: null } });
  try {
    const message = await refusalOf(withE2e(of('chore')));
    assert.match(message, /e2e:home-shows-change has no way to serve a head/);
    assert.match(message, /"e2e": \{ "serve": \{ "command", "url", "readySeconds" \} \} in graphyard\.json/);
    assert.match(message, /delivery\.applications/);
  } finally { setRepositoryPolicy(servePolicy); }
  const accepted = await engine.execute(operator, 'create', null, withE2e(of('chore')), id());
  assert.equal(accepted.scenarioRequirements.length, 1, 'with the serve declared, the same create is accepted');
});
