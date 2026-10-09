import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { keepVerdicts, shadowGateSummary, shadowKeptVerdicts, shadowVerdictSchema } from '../src/daemon/cycle-shadow.js';
import {
  cursorVerdict, isPlaceholderVerdict, placeholderRunnerFailure, shadowDisagreementDetail, shadowGateAttention,
  shadowExplanationPairsMax, trialCauseLength, trialFailureCause, shadowReportWithExplanations, type ShadowVerdict,
} from '../src/merge-writer/shadow.js';
import type { Work } from '../src/model.js';
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
  // A later agree-pass on a new head of the same item does not drop an earlier unexplained disagreement.
  const later = verdict('GY-1', { head: sha('h1-later'), baseTip: tip, outcome: 'agree-pass', at: iso(start + 60_000), tests: { passed: 3, failed: [], files: 3 } });
  assert.deepEqual(shadowGateAttention([a, later]).map(line => line.text.match(/GY-\d+/)?.[0]), ['GY-1']);
  assert.equal(shadowGateAttention([a, later], [{ key: 'GY-1', head: a.head, baseTip: tip }]).length, 0);
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

test('unit:keep-verdicts-prefer-disagreements — keepVerdicts evicts non-disagreements before a standing shadow-only-fail or shadow-missed', () => {
  const open = {
    id: 'w-open', key: 'GY-open', stage: 'build', candidate: { sha: sha('open-head') },
  } as unknown as Work;
  const disagreement = verdict('GY-old', { id: 'w-old', head: sha('old-head'), outcome: 'shadow-only-fail' });
  const filler = Array.from({ length: shadowKeptVerdicts }, (_, index) => verdict(`GY-f${index}`, {
    id: `w-f${index}`, head: sha(`f${index}`), outcome: 'agree-pass', tests: { passed: 1, failed: [], files: 1 },
  }));
  const kept = keepVerdicts([disagreement, ...filler, {
    ...verdict('GY-open', { id: 'w-open', head: sha('open-head'), outcome: 'pending' }),
  }], [open]);
  assert.equal(kept.length, shadowKeptVerdicts);
  assert.ok(kept.some(entry => entry.key === 'GY-old' && entry.outcome === 'shadow-only-fail'), 'a standing disagreement survives while agree-pass rows make room');
  assert.ok(kept.some(entry => entry.key === 'GY-open'), 'an open head also survives');
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
  // The loop's per-cycle read names the pairs it holds and gets back which are explained, as
  // identifiers alone: no reason, evidence or logTail, and nothing it did not ask about.
  const other = { key, head: sha('explain-other'), baseTip };
  const loopRead = await request(token(coordinator), `shadow-explanations?pair=${key}:${head}:${baseTip}&pair=${other.key}:${other.head}:${other.baseTip}`);
  assert.equal(loopRead.status, 200, JSON.stringify(loopRead.body));
  assert.deepEqual(loopRead.body, { explanations: [{ key, head, baseTip }] });
  assert.deepEqual((await request(token(coordinator), `shadow-explanations?pair=${other.key}:${other.head}:${other.baseTip}`)).body, { explanations: [] });
  // The read is bounded: it names at least one pair and at most shadowExplanationPairsMax.
  assert.equal((await request(token(coordinator), 'shadow-explanations')).status, 400);
  const tooMany = Array.from({ length: shadowExplanationPairsMax + 1 }, (_, n) => `pair=${key}:${sha(`many${n}`)}:${baseTip}`).join('&');
  assert.equal((await request(token(coordinator), `shadow-explanations?${tooMany}`)).status, 400);
  assert.equal((await request(token(worker), `shadow-explanations?pair=${key}:${head}:${baseTip}`)).status, 403);
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
  const listing = await request(token(coordinator), 'shadow-disagreements');
  assert.ok((listing.body.disagreements as { key: string; explained: boolean }[]).some(entry => entry.key === key && !entry.explained));
  const refused = await request(token(admin), 'merger', { merger: 'control-plane', reason: 'Switch while unexplained' });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(JSON.stringify(refused.body), new RegExp(`unexplained shadow disagreements stand:.*${key}`));
  // github is never refused for unexplained disagreements.
  const settings = new MergerSettings(store);
  await assert.rejects(settings.change(admin, { merger: 'github', reason: 'already' }, randomUUID()), /already github/);
  await request(token(admin), `work/${id}/shadow-explain`, { head, baseTip, reason: 'Explained so merger-refused test cleans up' });
});

test('integration:merger-refused-reopened-shadow-missed — a shadow-passed head whose merge was reverted and the item reopened still refuses control-plane until explained (delivered merge recovered from the ledger)', async () => {
  const head = sha('missed-head'), baseTip = sha('missed-tip'), deliverySha = sha('missed-delivery');
  const id = randomUUID(), itemKey = `GY-${++keySerial}`;
  const document = {
    id, key: itemKey, title: itemKey, description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }],
    policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: ['src/a.ts'], revision: 1, policyRevision: 1,
    createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(start), ready: true, epoch: 1, lease: null,
    workspaces: [], submission: null, candidate: null, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: null, blocker: null, violations: [], gates: [], stage: 'ready', delivery: null,
    mainGuardReverts: [{
      mergeSha: deliverySha, pr: keySerial, failing: ['test'], revert: null, state: 'merged',
      at: iso(start), settledAt: iso(start), revertSha: sha(`revert-${head}`), reason: 'broke main',
    }],
  };
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [id, JSON.stringify(document)]);
  // Historical delivery of this head (cleared from the document on reopen) stays on the ledger.
  await store.pool.query(
    `INSERT INTO events(work_id, actor, kind, payload) VALUES ($1,$2,'github.observed',$3)`,
    [id, coordinator.id, JSON.stringify({
      work: {
        candidate: { sha: head, baseSha: baseTip, pr: keySerial, branch: `graphyard/${itemKey}-1`, author: 'implementer' },
        delivery: { mergedAt: iso(start), mergeSha: deliverySha, authorizationRevision: 1 },
      },
    })],
  );
  const recorded = await request(token(coordinator), `work/${id}/shadow-verdict`, {
    head, baseTip, mergeSha: sha(`trial-${head}`), risk: 'normal', build: 'pass',
    tests: { passed: 4, failed: [], files: 4 }, conflict: [], durationMs: 500,
  });
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  const standing = await request(token(reader), 'shadow-disagreements');
  assert.ok((standing.body.disagreements as { key: string; outcome: string; explained: boolean }[])
    .some(entry => entry.key === itemKey && entry.outcome === 'shadow-missed' && !entry.explained),
  JSON.stringify(standing.body.disagreements));
  const refused = await request(token(admin), 'merger', { merger: 'control-plane', reason: 'Must refuse reopened shadow-missed' });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(JSON.stringify(refused.body), new RegExp(itemKey));
  await request(token(admin), `work/${id}/shadow-explain`, {
    head, baseTip, reason: `${itemKey} shadow-missed: main guard reverted delivery ${deliverySha}; explained for test cleanup`,
  });
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

/**
 * GY-1564: GY-1535 head 77da3de0's shadow.verdict as the ledger records it (trial merge 953e1ac6 on
 * c8c8c70e): build pass, ten failing files, and the log tail ending in the runner's summary.
 */
const gy1535 = {
  head: '77da3de0b3866447cf5fac627474dfd5195ae531', baseTip: 'c8c8c70e6ff94282ebab98fd659264e9cf4e19db', mergeSha: '953e1ac6a610979bdeca5b008726e81df4d4cdeb',
  tests: { passed: 490, files: 500, failed: [
    'tests/approver-launch-record.test.ts', 'tests/graphyard-up.test.ts', 'tests/master-agent-envs.test.ts', 'tests/master-loop-resilience.test.ts',
    'tests/registry-drives-launch.test.ts', 'tests/resource-fault-recurrence.test.ts', 'tests/resource-reading-moment.test.ts', 'tests/revert-recheck.test.ts',
    'tests/unattended-cycle.test.ts', 'tests/worktree-reclaim.test.ts',
  ] },
  logTail: [
    '✔ unit:zero-touch-onboarding — `graphyard up --agent --goal FILE` on a fresh repository reaches a merged first planned item (901.456929ms)',
    'ℹ tests 115', 'ℹ pass 114', 'ℹ fail 1', '', '✖ failing tests:', '',
    'test at tests/worktree-reclaim.test.ts:1:11072',
    '✖ integration:worktree-dependency-reuse — a fresh attempt starts from a clean checkout of its exact head and shares one install instead of paying for a private copy (138.148351ms)',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:',
    '  + actual - expected', '  ', '  + []', '  - [', "  -   { how: 'mirrored', name: 'node_modules' }", '  - ]', '',
    '[exit status 1]',
  ].join('\n'),
};

/** GY-1528 head 2186dd85's recorded log tail from the runner's summary on (ledger seq 2439697). */
const gy1528LogTail = [
  'ℹ tests 68', 'ℹ suites 0', 'ℹ pass 67', 'ℹ fail 1', 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0', 'ℹ duration_ms 5859.54096', '', '✖ failing tests:', '',
  'test at tests/worktree-reclaim.test.ts:1:11072',
  '✖ integration:worktree-dependency-reuse — a fresh attempt starts from a clean checkout of its exact head and shares one install instead of paying for a private copy (130.912959ms)',
  '  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:', '  + actual - expected', '  ', '  + []', '  - [', '  -   {',
  "  -     how: 'mirrored',", "  -     name: 'node_modules',", "  -     source: '/tmp/graphyard-reclaim-N6oAPH/node_modules'", '  -   }', '  - ]', '  ',
  '      at TestContext.<anonymous> (/home/vish/.local/share/graphyard/worktrees/graphyard-7dc8733c9f87/graphyard-trial-gy-1528-c30d4b1-3e9bb531/checkout/tests/worktree-reclaim.test.ts:231:12)',
  '      at async Test.run (node:internal/test_runner/test:1088:7)', '      at async Test.processPendingSubtests (node:internal/test_runner/test:763:7) {',
  '    generatedMessage: true,', "    code: 'ERR_ASSERTION',", '    actual: [],',
  "    expected: [ { name: 'node_modules', source: '/tmp/graphyard-reclaim-N6oAPH/node_modules', how: 'mirrored' } ],", "    operator: 'deepStrictEqual'", '  }', '',
  '[exit status 1]',
].join('\n');

test('unit:cycle-shadow-disagreement-explanation — the GY-1535 head 77da3de0 (trial merge 953e1ac6) and GY-1528 head 2186dd85 (trial merge c30d4b16) shadow-only-fails each name the failing test, file and error its trial record carries, from the cursor and from the ledger', async () => {
  assert.equal(trialFailureCause(gy1535.logTail),
    'integration:worktree-dependency-reuse (tests/worktree-reclaim.test.ts): AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal');
  // A trial keeps FORCE_COLOR: the same summary colored by the spec reporter names the same cause.
  const colored = gy1535.logTail.split('\n').map(line => line && `\u001b[31m${line}\u001b[39m`).join('\n');
  assert.equal(trialFailureCause(colored), trialFailureCause(gy1535.logTail));
  // A trial concatenates its groups' output: each group's summary names only its own failures, and a
  // later `failing tests:` heading, or a group's passing output between them, is never named as a test.
  const groups = [
    gy1535.logTail,
    '✔ unit:between — passes (1ms)', 'ℹ tests 3', 'ℹ fail 1', '', '✖ failing tests:', '',
    'test at tests/other.test.ts:2:3', '✖ unit:other — breaks (2ms)', '  Error: second group', '',
    '\u001b[31m✖ failing tests:\u001b[39m', '', 'test at tests/worktree-reclaim.test.ts:1:11072',
    '✖ integration:worktree-dependency-reuse — a fresh attempt starts from a clean checkout of its exact head and shares one install instead of paying for a private copy (1ms)',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:', '[exit status 1]',
  ].join('\n');
  assert.equal(trialFailureCause(groups),
    'integration:worktree-dependency-reuse (tests/worktree-reclaim.test.ts): AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal; unit:other (tests/other.test.ts): Error: second group');
  assert.doesNotMatch(trialFailureCause(groups)!, /failing tests|unit:between/);
  // The loop's cursor drops the log but keeps the cause, and its strict schema accepts it.
  const kept = cursorVerdict({ ...verdict('GY-1535', { head: gy1535.head, baseTip: gy1535.baseTip, mergeSha: gy1535.mergeSha, tests: gy1535.tests }), logTail: gy1535.logTail });
  assert.equal('logTail' in kept, false);
  assert.match(kept.cause!, /integration:worktree-dependency-reuse/);
  assert.equal(shadowVerdictSchema.safeParse(kept).success, true);
  const line = shadowDisagreementDetail(kept);
  assert.match(line, /GY-1535 head 77da3de0b3866447cf5fac627474dfd5195ae531 is shadow-only-fail \(trial merge 953e1ac6a610979bdeca5b008726e81df4d4cdeb\)/);
  assert.match(line, /10 of 500 test files failed in the trial \(tests\/approver-launch-record\.test\.ts, .* and 5 more\)/);
  assert.match(line, /the trial log names integration:worktree-dependency-reuse \(tests\/worktree-reclaim\.test\.ts\): AssertionError/);
  assert.doesNotMatch(line, /merged it\. Report only/, 'not the bare line');
  // The ledger's standing list carries the cause read from the recorded log, and master status's
  // attention names it even when the cursor's older copy of the pair has none.
  const { id, key } = await deliveredDisagreement(gy1535.head, gy1535.baseTip, gy1535.tests, { logTail: gy1535.logTail, trialMergeSha: gy1535.mergeSha });
  const listing = await request(token(reader), 'shadow-disagreements');
  const standing = (listing.body.disagreements as { key: string; cause: string | null }[]).find(entry => entry.key === key)!;
  assert.match(standing.cause!, /^integration:worktree-dependency-reuse \(tests\/worktree-reclaim\.test\.ts\)/);
  const cursorCopy = verdict(key, { head: gy1535.head, baseTip: gy1535.baseTip, mergeSha: gy1535.mergeSha, tests: gy1535.tests, at: iso(start + 1) });
  const ledgerCopy = verdict(key, { head: gy1535.head, baseTip: gy1535.baseTip, mergeSha: gy1535.mergeSha, tests: gy1535.tests, at: iso(0), cause: standing.cause! });
  const [attention] = shadowGateAttention([cursorCopy, ledgerCopy]);
  assert.match(attention!.text, /the trial log names integration:worktree-dependency-reuse/);
  await request(token(admin), `work/${id}/shadow-explain`, { head: gy1535.head, baseTip: gy1535.baseTip, reason: 'GY-1564 test cleanup' });
  // GY-1528 head 2186dd85 (trial merge c30d4b16 on 157b7134), merged by GitHub after its own
  // shadow-only-fail: its recorded log tail, stack and assertion object included, names its cause too.
  const gy1528 = { head: '2186dd853a8d089129e2b2f0ba87a9a9a8d5d62a', baseTip: '157b71349d7915cdf5776bbf0bb968725244643a', mergeSha: 'c30d4b1624deae333183d6112a5a1261fca3e027',
    tests: { ...gy1535.tests, passed: 487, files: 497 }, logTail: gy1528LogTail };
  assert.equal(trialFailureCause(gy1528.logTail),
    'integration:worktree-dependency-reuse (tests/worktree-reclaim.test.ts): AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal');
  const gy1528Line = shadowDisagreementDetail({ ...verdict('GY-1528', { head: gy1528.head, baseTip: gy1528.baseTip, mergeSha: gy1528.mergeSha, tests: gy1528.tests }), logTail: gy1528.logTail });
  assert.match(gy1528Line, /GY-1528 head 2186dd853a8d089129e2b2f0ba87a9a9a8d5d62a is shadow-only-fail \(trial merge c30d4b1624deae333183d6112a5a1261fca3e027\); the shadow trial failed it but GitHub merged it: 10 of 497 test files failed/);
  assert.match(gy1528Line, /the trial log names integration:worktree-dependency-reuse \(tests\/worktree-reclaim\.test\.ts\): AssertionError \[ERR_ASSERTION\]: Expected values to be strictly deep-equal\. Report only/);
  const second = await deliveredDisagreement(gy1528.head, gy1528.baseTip, gy1528.tests, { logTail: gy1528.logTail, trialMergeSha: gy1528.mergeSha });
  const standing1528 = ((await request(token(reader), 'shadow-disagreements')).body.disagreements as { key: string; cause: string | null }[]).find(entry => entry.key === second.key)!;
  assert.equal(standing1528.cause, trialFailureCause(gy1528.logTail));
  const [line1528] = shadowGateAttention([verdict(second.key, { head: gy1528.head, baseTip: gy1528.baseTip, mergeSha: gy1528.mergeSha, tests: gy1528.tests, cause: standing1528.cause! })]);
  assert.match(line1528!.text, /the trial log names integration:worktree-dependency-reuse/);
  assert.doesNotMatch(line1528!.text, /merged it\. Report only/, 'not the bare line');
  await request(token(admin), `work/${second.id}/shadow-explain`, { head: gy1528.head, baseTip: gy1528.baseTip, reason: 'GY-1564 test cleanup' });
});

test('unit:merger-mode-refuses-unexplained-disagreement — a shadow-only-fail whose record names no cause says the evidence is missing, and the control-plane switch stays refused until it is explained', async () => {
  for (const logTail of [undefined, 'some output\n[exit status 1]']) {
    const line = shadowDisagreementDetail({ ...verdict('GY-9', { tests: { passed: 3, failed: ['tests/x.test.ts'], files: 4 } }), ...(logTail ? { logTail } : {}) });
    assert.match(line, /1 of 4 test files failed in the trial \(tests\/x\.test\.ts\); the record names no failing cause .* missing evidence/);
  }
  assert.match(shadowDisagreementDetail(verdict('GY-9', { conflict: ['src/a.ts'] })), /the trial merge conflicted on src\/a\.ts; the record names no failing cause/);
  assert.match(shadowDisagreementDetail({ ...verdict('GY-9', { build: 'fail', tests: { passed: 0, failed: [], files: 0 } }), logTail: "src/a.ts(1,1): error TS2304: Cannot find name 'x'." }),
    /the trial build failed; the trial log names src\/a\.ts\(1,1\): error TS2304/);
  assert.ok(trialFailureCause(`✖ failing tests:\n${Array.from({ length: 20 }, (_, n) => `✖ unit:case-${n} — ${'x'.repeat(40)}`).join('\n')}`)!.length <= trialCauseLength);
  const head = sha('no-cause-head'), baseTip = sha('no-cause-tip');
  const { id, key } = await deliveredDisagreement(head, baseTip, { passed: 1, failed: ['tests/q.test.ts'], files: 2 });
  const listing = await request(token(reader), 'shadow-disagreements');
  assert.equal((listing.body.disagreements as { key: string; cause: string | null }[]).find(entry => entry.key === key)!.cause, null);
  const refused = await request(token(admin), 'merger', { merger: 'control-plane', reason: 'No cause recorded' });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(JSON.stringify(refused.body), new RegExp(`unexplained shadow disagreements stand:.*${key}`));
  await request(token(admin), `work/${id}/shadow-explain`, { head, baseTip, reason: 'GY-1564 test cleanup' });
});

test('unit:cycle-shadow-record-regression — GY-1523 (9b30324f/b02f268d) and GY-1549 (d205ce97/37df2a95) still name the placeholder-runner cause, and agree-fail verdicts raise no attention', () => {
  for (const entry of [
    { key: 'GY-1523', head: '9b30324fc4f3b10d1b74c63efcb35df6d5f05071', files: 486, mergeSha: 'b02f268d48a8f859434ecb65d62831133d8bb3d1' },
    { key: 'GY-1549', head: 'd205ce97ea6e5ee3d6e5e083d14eefccd7b0ff0b', files: 462, mergeSha: '37df2a951778f41b27b5ed30f797b2580f6a4d2d' },
  ]) {
    const recorded = verdict(entry.key, { head: entry.head, mergeSha: entry.mergeSha, tests: { passed: entry.files, failed: [placeholderRunnerFailure], files: entry.files } });
    for (const line of [shadowDisagreementDetail(recorded), shadowDisagreementDetail(cursorVerdict({ ...recorded, logTail: gy1535.logTail }))]) {
      assert.match(line, new RegExp(`${entry.key} head ${entry.head} is shadow-only-fail \\(trial merge ${entry.mergeSha}\\); the failure is the fabricated-runner-failure placeholder tests/helpers/run-tests\\.ts \\(pre-GY-1548`));
    }
  }
  const agreeFail = verdict('GY-7', { outcome: 'agree-fail', logTail: gy1535.logTail });
  assert.deepEqual(shadowGateAttention([agreeFail]), []);
  assert.equal(cursorVerdict(agreeFail).outcome, 'agree-fail');
});
