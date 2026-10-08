import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { mergerModes, recordedMergerMode } from '../src/merger-mode.js';
import { mergerCommand, mergerDoctorLine } from '../src/cli/merger.js';
import { mergeWriterLine } from '../src/cli/status-attention.js';
import { unhandled, type MasterSession } from '../src/cli/master/session.js';
import type { Observation, Principal } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/** The merger install setting: `policy.merger.set` on the ledger, admin-only, surfaced as mergeWriter, and read by nothing yet. */
const repository = 'owner/project';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const reader: Principal = { id: 'dashboard-reader', role: 'reader' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const credentials = [operator, coordinator, reader, worker].map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
const agent = { id: 'merger-operator-agent', token: `merger-operator-agent-${'m'.repeat(32)}` };
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
let pg: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 161;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('merger-setting'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('merger_setting_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/merger_setting_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null; engine.directMergeEnvironment = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const created = await request(token(operator), 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: ['decision:merge'], scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'A read-only operator agent' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pg) await pg.stop(); });

async function request(credential: string, path: string, body?: unknown, key = randomUUID()) {
  const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
const setRows = async () => (await store.pool.query("SELECT actor, payload FROM events WHERE kind='policy.merger.set' AND work_id IS NULL ORDER BY seq")).rows;

test('integration:merger-setting-admin-only — only an admin credential changes the merger; coordinator, reader, worker and operator-agent identities get 403 and nothing is recorded, while the first four roles read it', async () => {
  assert.deepEqual([...mergerModes], ['github', 'control-plane']);
  for (const credential of [token(coordinator), token(reader), token(worker), agent.token]) {
    const refused = await request(credential, 'merger', { merger: 'control-plane', reason: 'agents may not switch the writer' });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
  }
  assert.equal((await setRows()).length, 0);
  for (const credential of [token(operator), token(coordinator), token(reader), agent.token]) {
    const read = await request(credential, 'merger');
    assert.equal(read.status, 200, JSON.stringify(read.body)); assert.equal(read.body.merger, 'github'); assert.equal(read.body.setBy, null);
  }
  assert.equal((await request(token(worker), 'merger')).status, 403);
  assert.equal((await request(token(operator), 'merger', { merger: 'bogus', reason: 'bad mode' })).status, 400);
  assert.equal((await request(token(operator), 'merger', { merger: 'control-plane' })).status, 400);
});

test('integration:merger-setting-recorded-and-idempotent — the newest policy.merger.set event wins, a retry with the same key replays, a reused key with other input and setting the mode in force are refused', async () => {
  assert.equal((await recordedMergerMode(store.pool)).merger, 'github');
  assert.equal((await request(token(operator), 'merger', { merger: 'github', reason: 'already the default' })).status, 409);
  const key = randomUUID();
  const first = await request(token(operator), 'merger', { merger: 'control-plane', reason: 'Shadow mode passed' }, key);
  assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.merger, 'control-plane'); assert.equal(first.body.setBy, operator.id); assert.equal(first.body.reason, 'Shadow mode passed');
  const replay = await request(token(operator), 'merger', { merger: 'control-plane', reason: 'Shadow mode passed' }, key);
  assert.equal(replay.status, 200); assert.deepEqual(replay.body, first.body);
  assert.equal((await setRows()).length, 1, 'the retry recorded nothing');
  assert.equal((await request(token(operator), 'merger', { merger: 'github', reason: 'different' }, key)).status, 409);
  assert.equal((await request(token(operator), 'merger', { merger: 'control-plane', reason: 'again' })).status, 409);
  assert.equal((await recordedMergerMode(store.pool)).merger, 'control-plane');
  const back = await request(token(operator), 'merger', { merger: 'github', reason: 'Roll back' });
  assert.equal(back.status, 200); assert.equal(back.body.history.length, 2); assert.equal(back.body.merger, 'github');
  assert.deepEqual((await setRows()).map(row => row.payload.merger), ['control-plane', 'github']);
});

test('integration:merger-setting-status-field — /api/status carries mergeWriter, with a line only while the control plane merges', async () => {
  const github = (await request(token(coordinator), 'status')).body.mergeWriter;
  assert.equal(github.merger, 'github'); assert.equal(github.line, null); assert.equal(github.setBy, operator.id);
  assert.equal((await request(token(operator), 'merger', { merger: 'control-plane', reason: 'Switch' })).status, 200);
  const control = (await request(token(coordinator), 'status')).body.mergeWriter;
  assert.deepEqual(Object.keys(control).filter(key => ['merger', 'since', 'setBy', 'reason', 'line'].includes(key)).sort(), ['line', 'merger', 'reason', 'setBy', 'since']);
  assert.equal(control.merger, 'control-plane'); assert.equal(control.reason, 'Switch'); assert.match(control.line, /^The control plane is the merge writer since .*, set by human-operator \(Switch\)$/);
  assert.equal((await request(token(operator), 'merger', { merger: 'github', reason: 'Back' })).status, 200);
});

/** One item from creation to an observed open pull request; the parts of the result that must not depend on the setting. */
async function scenario(n: number) {
  let w = await engine.execute(operator, 'create', null, { title: `Merger scenario ${n}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID()); w = await engine.execute(worker, 'claim', w.id, {}, randomUUID());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/merger-${n}`, branch: `graphyard/merger-${n}` }, randomUUID());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: 900 + n }, randomUUID());
  const observation: Observation = { clockOffset: { min: 0, max: 0 }, candidate: { sha: sha('merger-scenario'), baseSha: 'b'.repeat(40), pr: 900 + n, branch: w.workspaces[0].branch, author: 'implementer' },
    checks: [], reviews: [], protected: true, mergeable: true, merged: false, prState: 'open', mergeSha: null, mergedAt: null, baseTip: 'b'.repeat(40), baseTree: '7e'.repeat(20), files: [], scopeFiles: [], at: new Date().toISOString() };
  const observed = await engine.observe(w.id, (await store.list()).find(item => item.id === w.id)!.revision, observation);
  // The item's own key, id and pull request number are the only things that may differ between two runs.
  const dispatched = (item: typeof observed) => [item.autoDispatch?.review, ...(item.autoDispatch?.producers ?? [])].filter(Boolean).map((request: any) => ({ kind: request.kind, state: request.state, sha: request.sha, proofs: request.proofs ?? null }));
  const view = (item: typeof observed) => JSON.parse(JSON.stringify({ stage: item.stage, ready: item.ready, violations: item.violations, gates: item.gates.map(gate => ({ name: gate.name, passed: gate.passed, reasons: gate.reasons })), nextAction: item.nextAction ?? null, dispatch: dispatched(item) })
    .replace(/"requestId":"[0-9a-f]{32}"/g, '"requestId":"R"').split(item.key).join('GY-N').split(item.id).join('ID').split(`"pr":${900 + n}`).join('"pr":0'));
  return { submitted: view(w), observed: view(observed) };
}

test('integration:merger-setting-no-behaviour-change — the same submit, observe and evaluate scenario gives identical results with the setting recorded github and control-plane', async () => {
  assert.equal((await recordedMergerMode(store.pool)).merger, 'github');
  const github = await scenario(1);
  assert.equal((await request(token(operator), 'merger', { merger: 'control-plane', reason: 'Compare behaviour' })).status, 200);
  assert.equal((await recordedMergerMode(store.pool)).merger, 'control-plane');
  const control = await scenario(2);
  assert.deepEqual(control, github);
  assert.equal((await request(token(operator), 'merger', { merger: 'github', reason: 'Done comparing' })).status, 200);
});

function fakeSession(id: string, args: string[], calls: any[]): MasterSession {
  return { id, args, print: (value: unknown) => calls.push(['print', value]), masterToken: 'master-token',
    masterApi: async (path: string) => { calls.push(['get', path]); return { merger: 'github', history: [] }; },
    masterMutation: async (path: string, data: unknown, requestId: string, credential: string) => { calls.push(['post', path, data, requestId, credential]); return { merger: (data as any).merger }; } } as unknown as MasterSession;
}

test('unit:merger-cli — `master merger` prints the setting, `master merger MODE --reason TEXT` posts it with an Idempotency-Key and the admin credential, and anything else is refused', async () => {
  let calls: any[] = [];
  await mergerCommand(fakeSession('merger', [], calls), {});
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [['get', 'merger'], ['print', { merger: 'github', history: [] }]]);
  calls = [];
  await mergerCommand(fakeSession('merger', ['control-plane', '--reason', 'Shadow passed'], calls), { GRAPHYARD_TOKEN: 'admin-token' });
  assert.deepEqual(calls[0].slice(0, 3), ['post', 'merger', { merger: 'control-plane', reason: 'Shadow passed' }]);
  assert.match(calls[0][3], /^[0-9a-f-]{36}$/); assert.equal(calls[0][4], 'admin-token');
  assert.deepEqual(calls[1], ['print', { merger: 'control-plane' }]);
  await assert.rejects(mergerCommand(fakeSession('merger', ['control-plane'], []), {}), /--reason TEXT/);
  await assert.rejects(mergerCommand(fakeSession('merger', ['bogus', '--reason', 'x'], []), {}), /Use master merger/);
  assert.equal(await mergerCommand(fakeSession('status', [], []), {}), unhandled);
});

test('unit:merger-status-line — master status leads with a mergeWriter sentence only while the mode is control-plane', () => {
  assert.deepEqual(mergeWriterLine({ mergeWriter: { merger: 'github', line: null } }), {});
  assert.deepEqual(mergeWriterLine({}), {});
  assert.deepEqual(mergeWriterLine({ mergeWriter: { merger: 'control-plane', line: 'The control plane is the merge writer since T, set by a (r)' } }), { mergeWriter: 'The control plane is the merge writer since T, set by a (r)' });
});

test('unit:merger-doctor-line — doctor prints `merger: MODE (set by ACTOR at TIME)` or `merger: github (default)`', () => {
  assert.equal(mergerDoctorLine({ merger: 'github', since: null, setBy: null }), 'merger: github (default)');
  assert.equal(mergerDoctorLine(null), 'merger: github (default)');
  assert.equal(mergerDoctorLine({ merger: 'control-plane', since: '2026-10-08T07:00:00.000Z', setBy: 'human-operator' }), 'merger: control-plane (set by human-operator at 2026-10-08T07:00:00.000Z)');
});
