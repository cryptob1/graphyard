import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { reviewPrompt, reviewStandard } from '../src/reviewer.js';
import { pinnedCases, singleCaseWarnings } from '../src/model.js';
import type { Principal } from '../src/model.js';

/**
 * GY-2975: a criterion whose proof pins one seed, fixture or input is flagged when the item is
 * created and when its review judges it, so a head cannot pass by tuning to the single case the
 * proof checks. A warning in the create/revise response and on the item, and an instruction in the
 * reviewer's brief — no new gate, no refusal.
 */
const warningOf = (id: string) => `${id} checks one case; a head can pass it by tuning to that case — name at least three, or say why one is enough.`;
const multi = { id: 'AC-2', text: 'The campaign completes every mission on seeds 42, 7 and 1', proofs: ['unit:campaign-everywhere'] };
const single = { id: 'AC-1', text: 'The campaign completes every mission on seed 42', proofs: ['unit:campaign-seed-42'] };

const operator: Principal = { id: 'operator', role: 'admin' };
let pg: InstanceType<typeof EmbeddedPostgres>, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, token: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 2975;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('single-case-criterion'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('single_case_criterion_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/single_case_criterion_test`); await store.init();
  engine = new Engine(store, 120, 'owner/project');
  http = server(engine, [{ ...operator, token: token = `${operator.id}-${'t'.repeat(32)}` }], null);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pg) await pg.stop(); });

const api = async (path: string, data?: unknown, key: string = randomUUID()) => {
  const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: data === undefined ? undefined : JSON.stringify(data) });
  const body = await response.json() as any;
  if (!response.ok) throw Object.assign(new Error(body?.error ?? `HTTP ${response.status}`), { status: response.status });
  return body;
};

test('unit:single-case-criterion-warned-at-create — the create succeeds with exactly one single-case warning naming the pinned criterion, in the response and on the item', async () => {
  const created = await api('work', { title: 'Single-case create', type: 'chore', priority: 3, criteria: [single, multi] });
  assert.equal(created.stage, 'backlog', 'the create succeeds');
  assert.deepEqual(created.warnings, [warningOf('AC-1')], 'exactly one warning, naming the first criterion');
  const read = await api(`work/${created.id}`);
  assert.deepEqual(read.warnings, [warningOf('AC-1')], 'the item\'s read model carries the same warning');
});

test('unit:single-case-criterion-warned-at-create — several named cases carry no warning, and a revision rejudges the warning from the revised criteria', async () => {
  const created = await api('work', { title: 'No single case', type: 'chore', priority: 3, criteria: [multi] });
  assert.equal(created.warnings, undefined, 'three named seeds carry no warning');
  assert.equal((await api(`work/${created.id}`)).warnings, undefined);
  const revised = await api(`work/${created.id}/requirements`, { expectedPolicyRevision: created.policyRevision, reason: 'Narrow the check', criteria: [single], dependencies: [], exclusiveResources: [] });
  assert.deepEqual(revised.warnings, [warningOf('AC-1')], 'the revision warns for the single seed');
  const widened = await api(`work/${created.id}/requirements`, { expectedPolicyRevision: revised.policyRevision, reason: 'Sample several cases', criteria: [{ ...multi, id: 'AC-3' }], dependencies: [], exclusiveResources: [] });
  assert.equal(widened.warnings, undefined, 'widening the criteria drops the warning');
  assert.equal((await api(`work/${widened.id}`)).warnings, undefined);
});

test('unit:single-case-criterion-warned-at-create — a pinned fixture path or ?seed= input is one case; a path beside seeds is several', () => {
  assert.deepEqual(singleCaseWarnings([{ id: 'AC-1', text: 'The level at fixtures/one.json loads' }]), [warningOf('AC-1')]);
  assert.deepEqual(singleCaseWarnings([{ id: 'AC-1', text: 'The run replays with ?seed=42' }]), [warningOf('AC-1')]);
  assert.deepEqual(singleCaseWarnings([{ id: 'AC-1', text: 'fixtures/one.json and fixtures/two.json both load' }]), [], 'two fixtures are two cases');
  assert.deepEqual(singleCaseWarnings([{ id: 'AC-1', text: 'The campaign completes 20/20 missions on seed 42 and the soak at fixtures/soak.json stays clean' }]), [], 'a seed beside a fixture is two cases');
  assert.deepEqual(pinnedCases('The seeds 42, 7 and 1 all complete'), ['42', '7', '1']);
});

const head = 'a'.repeat(40), base = 'b'.repeat(40);

test('unit:reviewer-brief-checks-another-case — the brief tells the reviewer to run one other case and request changes when only the pinned case works; without one the instruction is absent', () => {
  const standard = reviewStandard({ key: 'GY-1', head, base }, [single, multi]);
  assert.match(standard, /AC-1 checks one case: a head can pass by tuning to that case\. /);
  assert.match(standard, /run the head once on one other case its own commands accept — another seed or input — quote both results, and request changes when the head works only on the pinned case\. /);
  assert.ok(!standard.includes('AC-2 checks one case'), 'the criterion naming three seeds is not flagged');
  const plain = reviewStandard({ key: 'GY-1', head, base }, [{ id: 'AC-1', text: 'The change works at its head', proofs: ['unit:works'] }]);
  assert.ok(!plain.includes('one case'), 'no single-case instruction without a single-case criterion');
  const github = reviewPrompt({ repository: 'owner/project' }, { key: 'GY-1', pr: 1, sha: head, baseSha: base, policyRevision: 1 }, undefined, undefined, [single]);
  assert.match(github, /AC-1 checks one case/);
  assert.ok(!reviewPrompt({ repository: 'owner/project' }, { key: 'GY-1', pr: 1, sha: head, baseSha: base, policyRevision: 1 }).includes('one case'), 'the github brief without criteria stays as it was');
});
