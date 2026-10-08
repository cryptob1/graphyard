import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { shadowGateSummary } from '../src/daemon/cycle-shadow.js';
import {
  isPlaceholderVerdict, placeholderRunnerFailure, shadowDisagreementDetail, shadowGateAttention,
  shadowReportWithExplanations, type ShadowVerdict,
} from '../src/merge-writer/shadow.js';
import { MergerSettings } from '../src/merger-mode.js';
import type { Principal } from '../src/model.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1560: explain shadow-gate disagreements from the record and refuse the control-plane merger
 * switch while one stands unexplained.
 */

const start = Date.parse('2030-04-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const tip = sha('main-tip');
const repository = 'owner/project';

const admin: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const reader: Principal = { id: 'dashboard-reader', role: 'reader' };
const credentials = [admin, coordinator, worker, reader].map(principal => ({
  ...principal, token: `${principal.id}-token-${'x'.repeat(32)}`,
}));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;

const placeholderTests = { passed: 486, failed: [placeholderRunnerFailure], files: 486 };
const verdict = (key: string, overrides: Partial<ShadowVerdict> = {}): ShadowVerdict => ({
  key, id: `w-${key}`, head: sha(`h-${key}`), baseTip: tip, mergeSha: sha(`m-${key}`), risk: 'normal',
  build: 'pass', tests: { passed: 3, failed: ['tests/x.test.ts'], files: 4 }, conflict: [], durationMs: 1000,
  at: iso(start), outcome: 'shadow-only-fail', ...overrides,
});

let pg: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1560;
  pg = new EmbeddedPostgres({
    databaseDir: await temporaryDirectory('shadow-disagreement'), user: 'graphyard', password: 'testing-only',
    port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'],
  });
  await pg.initialise(); await pg.start(); await pg.createDatabase('shadow_disagreement_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/shadow_disagreement_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null; engine.directMergeEnvironment = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
  if (pg) await pg.stop();
});

async function request(credential: string, path: string, body?: unknown, key = randomUUID(), method?: string) {
  const verb = method ?? (body === undefined ? 'GET' : 'POST');
  const response = await fetch(`${url}/api/${path}`, {
    method: verb,
    headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

let keySerial = 9000;

/**
 * Seed a done item whose delivery of `head` makes a failing shadow.verdict a shadow-only-fail, and
 * record that verdict. Uses the ledger directly (same shape as the standing cursor rows) so the
 * explanation and merger checks read the record without re-running a trial.
 */
async function deliveredDisagreement(head: string, baseTip: string, tests: ShadowVerdict['tests'], fields: { logTail?: string; trialMergeSha?: string } = {}) {
  const id = randomUUID();
  const itemKey = `GY-${++keySerial}`;
  const trialMergeSha = fields.trialMergeSha ?? sha(`trial-${head}`);
  const document = {
    id, key: itemKey, title: itemKey, description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }],
    policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: ['src/a.ts'], revision: 1, policyRevision: 1,
    createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(start), ready: true, epoch: 1, lease: null,
    workspaces: [], submission: { epoch: 1, pr: keySerial },
    candidate: { sha: head, baseSha: baseTip, pr: keySerial, branch: `graphyard/${itemKey}-1`, author: 'implementer' },
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: { merged: true, candidate: { sha: head }, checks: [] },
    blocker: null, violations: [], gates: [], stage: 'done',
    delivery: { mergedAt: iso(start), mergeSha: sha(`delivery-${head}`), authorizationRevision: 1 },
  };
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [id, JSON.stringify(document)]);
  const body = {
    head, baseTip, mergeSha: trialMergeSha, risk: 'normal' as const, build: 'pass' as const,
    tests, conflict: [] as string[], durationMs: 1000, ...(fields.logTail ? { logTail: fields.logTail } : {}),
  };
  const recorded = await request(token(coordinator), `work/${id}/shadow-verdict`, body);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  return { id, key: itemKey, head, baseTip, mergeSha: trialMergeSha, tests };
}

test('unit:placeholder-verdict-cause — a verdict whose failing list is exactly the pre-GY-1548 placeholder with build pass and passed = files is recognized, and its attention line names the fabricated-runner-failure cause', () => {
  assert.equal(placeholderRunnerFailure, 'tests/helpers/run-tests.ts');
  assert.equal(isPlaceholderVerdict({ build: 'pass', tests: placeholderTests }), true);
  assert.equal(isPlaceholderVerdict({ build: 'pass', tests: { passed: 485, failed: [placeholderRunnerFailure], files: 486 } }), false, 'passed must equal files');
  assert.equal(isPlaceholderVerdict({ build: 'fail', tests: placeholderTests }), false);
  assert.equal(isPlaceholderVerdict({ build: 'pass', tests: { passed: 1, failed: ['tests/x.test.ts'], files: 1 } }), false);
  const line = shadowDisagreementDetail(verdict('GY-1523', {
    head: '9b30324fc4f3b10d1b74c63efcb35df6d5f05071',
    tests: placeholderTests, outcome: 'shadow-only-fail',
  }));
  assert.match(line, /fabricated-runner-failure placeholder tests\/helpers\/run-tests\.ts/);
  assert.match(line, /pre-GY-1548/);
  const ordinary = shadowDisagreementDetail(verdict('GY-1', { outcome: 'shadow-only-fail' }));
  assert.match(ordinary, /the shadow trial failed it but GitHub merged it/);
  assert.doesNotMatch(ordinary, /fabricated-runner-failure/);
});

test('unit:attention-omits-explained — master status shadowGate attention lists a disagreement until it is explained and stops listing it once explained', () => {
  const a = verdict('GY-1', { head: sha('h1'), baseTip: tip, outcome: 'shadow-only-fail' });
  const b = verdict('GY-2', { head: sha('h2'), baseTip: tip, outcome: 'shadow-missed', tests: { passed: 3, failed: [], files: 3 } });
  assert.deepEqual(shadowGateAttention([a, b]).map(line => line.text.match(/GY-\d+/)?.[0]).sort(), ['GY-1', 'GY-2']);
  const explained = shadowGateAttention([a, b], [{ key: 'GY-1', head: a.head, baseTip: tip }]);
  assert.deepEqual(explained.map(line => line.text.match(/GY-\d+/)?.[0]), ['GY-2']);
  assert.deepEqual(shadowGateAttention([a, b], [
    { key: 'GY-1', head: a.head, baseTip: tip },
    { key: 'GY-2', head: b.head, baseTip: tip },
  ]), []);
});

test('unit:docs-word-budget — docs/delivery-redesign.md states the merger refuses while a shadow disagreement stands unexplained in at most 25 net words', () => {
  const docs = readFileSync(fileURLToPath(new URL('../docs/delivery-redesign.md', import.meta.url)), 'utf8');
  assert.match(docs, /`POST \/api\/merger` `control-plane` refuses while any shadow disagreement stands unexplained/);
  const base = ['origin/main', 'HEAD^1'].map(ref => {
    try { return execFileSync('git', ['show', `${ref}:docs/delivery-redesign.md`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return null; }
  }).find(text => text !== null) ?? null;
  const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
  if (base) assert.ok(words(docs) - words(base) <= 25, `delivery-redesign grew by ${words(docs) - words(base)} words, at most 25`);
});

test('integration:shadowgate-report-splits-explained — the shadowGate report separates unexplained from explained disagreement counts', () => {
  const entries = [
    verdict('GY-1', { outcome: 'shadow-only-fail', head: sha('a') }),
    verdict('GY-2', { outcome: 'shadow-missed', head: sha('b'), tests: { passed: 2, failed: [], files: 2 } }),
    verdict('GY-3', { outcome: 'agree-pass', head: sha('c'), tests: { passed: 2, failed: [], files: 2 } }),
  ];
  const none = shadowReportWithExplanations(entries, []);
  assert.equal(none.unexplainedDisagreements, 2);
  assert.equal(none.explainedDisagreements, 0);
  const half = shadowGateSummary(entries, [{ key: 'GY-1', head: entries[0]!.head, baseTip: tip }]);
  assert.equal(half.unexplainedDisagreements, 1);
  assert.equal(half.explainedDisagreements, 1);
  const all = shadowGateSummary(entries, [
    { key: 'GY-1', head: entries[0]!.head, baseTip: tip },
    { key: 'GY-2', head: entries[1]!.head, baseTip: tip },
  ]);
  assert.equal(all.unexplainedDisagreements, 0);
  assert.equal(all.explainedDisagreements, 2);
});

test('integration:shadow-disagreement-explain-idempotent — a coordinator/admin POST records one explanation per (key, head, baseTip), idempotent under an Idempotency-Key, citing the verdict evidence', async () => {
  const head = sha('explain-head'), baseTip = sha('explain-tip');
  const { id, key, mergeSha } = await deliveredDisagreement(head, baseTip, {
    passed: 10, failed: ['tests/a.test.ts'], files: 12,
  }, { logTail: 'not ok 1 - tests/a.test.ts\n[exit status 1]' });
  const list = await request(token(coordinator), 'shadow-disagreements');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.placeholderFailure, placeholderRunnerFailure);
  assert.equal(list.body.explanations.length, 0);
  for (const credential of [token(worker), token(reader)]) {
    assert.equal((await request(credential, `work/${id}/shadow-explain`, { head, baseTip, reason: 'no' })).status, 403);
  }
  const reason = `False positive: trial merge ${mergeSha} named tests/a.test.ts; host flake, GitHub kept the head.`;
  const key1 = randomUUID();
  const first = await request(token(coordinator), `work/${id}/shadow-explain`, { head, baseTip, reason }, key1);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.already, false);
  assert.equal(first.body.key, key);
  assert.equal(first.body.actor, coordinator.id);
  assert.equal(first.body.evidence.mergeSha, mergeSha);
  assert.deepEqual(first.body.evidence.failed, ['tests/a.test.ts']);
  assert.equal(first.body.evidence.logTail, 'not ok 1 - tests/a.test.ts\n[exit status 1]');
  const replay = await request(token(coordinator), `work/${id}/shadow-explain`, { head, baseTip, reason }, key1);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
  assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM events WHERE kind='shadow.disagreement.explained'")).rows[0].n, 1);
  assert.equal((await request(token(coordinator), `work/${id}/shadow-explain`, { head, baseTip, reason: 'other' }, key1)).status, 409);
  // A second POST for the same pair (new key) returns the existing explanation without writing another event.
  const again = await request(token(admin), `work/${id}/shadow-explain`, { head, baseTip, reason: 'different wording' }, randomUUID());
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.already, true);
  assert.equal(again.body.reason, reason);
  assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM events WHERE kind='shadow.disagreement.explained'")).rows[0].n, 1);
  const after = await request(token(reader), 'shadow-disagreements');
  assert.equal(after.body.explanations.length, 1);
  assert.equal(after.body.explanations[0].key, key);
});

test('manual:explain-standing-disagreements — the two standing disagreements (GY-1523 head 9b30324fc4f3, GY-1549 head d205ce97ea6e) are explainable through the mechanism without re-running any trial', async () => {
  const standing = [
    { label: 'GY-1523', head: '9b30324fc4f3b10d1b74c63efcb35df6d5f05071', files: 486, mergeSha: 'b02f268d48a8f859434ecb65d62831133d8bb3d1' },
    { label: 'GY-1549', head: 'd205ce97ea6e5ee3d6e5e083d14eefccd7b0ff0b', files: 462, mergeSha: '37df2a951778f41b27b5ed30f797b2580f6a4d2d' },
  ] as const;
  for (const entry of standing) {
    assert.equal(isPlaceholderVerdict({
      build: 'pass',
      tests: { passed: entry.files, failed: [placeholderRunnerFailure], files: entry.files },
    }), true, `${entry.label} matches the fabricated-runner placeholder signature`);
    const baseTip = sha(`base-${entry.label}`);
    const { id, key } = await deliveredDisagreement(entry.head, baseTip, {
      passed: entry.files, failed: [placeholderRunnerFailure], files: entry.files,
    }, { trialMergeSha: entry.mergeSha });
    // No logTail on the standing verdicts (they predate the field); the explanation still cites mergeSha and failed.
    const explained = await request(token(admin), `work/${id}/shadow-explain`, {
      head: entry.head, baseTip,
      reason: `${entry.label} shadow-only-fail is the pre-GY-1548 fabricated-runner-failure placeholder; GitHub merged head ${entry.head}; no trial re-run.`,
    });
    assert.equal(explained.status, 200, JSON.stringify(explained.body));
    assert.equal(explained.body.evidence.placeholder, true);
    assert.deepEqual(explained.body.evidence.failed, [placeholderRunnerFailure]);
    assert.equal(explained.body.evidence.mergeSha, entry.mergeSha);
    assert.equal('logTail' in explained.body.evidence, false, 'standing verdicts carry no logTail');
    assert.equal(shadowGateAttention([verdict(key, {
      head: entry.head, baseTip, tests: { passed: entry.files, failed: [placeholderRunnerFailure], files: entry.files },
      mergeSha: entry.mergeSha, outcome: 'shadow-only-fail',
    })], [{ key, head: entry.head, baseTip }]).length, 0);
  }
});

test('integration:merger-refused-unexplained — POST /api/merger control-plane is refused while an unexplained shadow disagreement stands, naming the keys; setting github is never refused', async () => {
  const head = sha('refuse-head'), baseTip = sha('refuse-tip');
  const { id, key } = await deliveredDisagreement(head, baseTip, { passed: 1, failed: ['tests/z.test.ts'], files: 2 });
  const refused = await request(token(admin), 'merger', { merger: 'control-plane', reason: 'Switch while unexplained' });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(JSON.stringify(refused.body), new RegExp(`unexplained shadow disagreements stand:.*${key}`));
  // github is never refused for unexplained disagreements.
  const settings = new MergerSettings(store);
  await assert.rejects(settings.change(admin, { merger: 'github', reason: 'already' }, randomUUID()), /already github/);
  await request(token(admin), `work/${id}/shadow-explain`, { head, baseTip, reason: 'Explained so merger-refused test cleans up' });
});

test('integration:merger-applies-when-explained — POST /api/merger control-plane applies once every disagreement is explained; github is never refused', async () => {
  const head = sha('apply-head'), baseTip = sha('apply-tip');
  const { id, key } = await deliveredDisagreement(head, baseTip, { passed: 2, failed: ['tests/y.test.ts'], files: 3 });
  assert.equal((await request(token(admin), 'merger', { merger: 'control-plane', reason: 'too soon' })).status, 409);
  const explained = await request(token(coordinator), `work/${id}/shadow-explain`, {
    head, baseTip, reason: `Explained ${key}: host flake on tests/y.test.ts`,
  });
  assert.equal(explained.status, 200, JSON.stringify(explained.body));
  // Clear any other unexplained leftovers so the switch can apply.
  const listing = await request(token(coordinator), 'shadow-disagreements');
  const open = (await store.pool.query(
    `SELECT i.key, e.payload->>'head' AS head, e.payload->>'baseTip' AS "baseTip", i.id::text AS id
     FROM events e JOIN work_index i ON i.id = e.work_id WHERE e.kind='shadow.verdict'`,
  )).rows as { key: string; head: string; baseTip: string; id: string }[];
  const explainedPairs = new Set((listing.body.explanations as { key: string; head: string; baseTip: string }[])
    .map(entry => `${entry.key}:${entry.head}:${entry.baseTip}`));
  for (const row of open) {
    const pair = `${row.key}:${row.head}:${row.baseTip}`;
    if (explainedPairs.has(pair)) continue;
    const result = await request(token(admin), `work/${row.id}/shadow-explain`, {
      head: row.head, baseTip: row.baseTip, reason: `Clear leftover ${row.key} for merger apply test`,
    });
    assert.ok([200, 404].includes(result.status), JSON.stringify(result.body));
    if (result.status === 200) explainedPairs.add(pair);
  }
  const applied = await request(token(admin), 'merger', { merger: 'control-plane', reason: 'Every disagreement explained' });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.merger, 'control-plane');
  const back = await request(token(admin), 'merger', { merger: 'github', reason: 'Roll back; github never refused' });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.merger, 'github');
});
