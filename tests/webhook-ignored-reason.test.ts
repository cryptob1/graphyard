import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { GitHub } from '../src/github.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { recordLegacyMerger } from './helpers/legacy-merger.js';

// GY-1731: a verified webhook delivery that wakes no job answers 202 with a named `ignored` reason
// (our own check run included) and logs it with the delivery ID and event, so a deliberately ignored delivery is told from a lost one.

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker' };
const secret = 'webhook-ignored-reason-secret';
const github = { config: { repository: 'owner/project', appId: 1234, installationId: 1, base: 'main' } } as unknown as GitHub;
let database: EmbeddedPostgres, store: Store, engine: Engine;
let http: ReturnType<typeof server>, url: string;
let pr = 7310;

before(async () => {
  const port = Number(process.env.GRAPHYARD_WEBHOOK_IGNORED_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1731);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('webhook-ignored-reason'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init(); await recordLegacyMerger(store);
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.submissionObserver = null;
  process.env.GITHUB_WEBHOOK_SECRET = secret;
  http = server(engine, [{ ...operator, token: 'o'.repeat(32) }, { ...implementer, token: 'w'.repeat(32) }], github);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

async function submitted(title: string): Promise<Work> {
  let item = await engine.execute(operator, 'create', null, { title, plannedFiles: ['src/server/routes/github.ts'], criteria: [{ id: 'AC-1', text: 'Ignored', proofs: ['integration:webhook-ignored-reason'] }] }, randomUUID());
  item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
  item = await engine.execute(implementer, 'claim', item.id, {}, randomUUID());
  item = await engine.execute(implementer, 'workspace', item.id, { epoch: item.epoch, host: 'machine-a', path: `/tmp/ignored/${item.id}`, branch: `graphyard/${item.key.toLowerCase()}-1` }, randomUUID());
  return engine.execute(implementer, 'submit', item.id, { epoch: item.epoch, pr: ++pr }, randomUUID());
}

/** Deliver a signed payload, capturing what the server logs while it answers. */
async function deliver(delivery: string, event: string, payload: unknown) {
  const raw = JSON.stringify({ repository: { full_name: 'owner/project' }, ...payload as object });
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    const response = await fetch(`${url}/api/github/webhook`, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-GitHub-Delivery': delivery, 'X-GitHub-Event': event, 'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` } });
    return { status: response.status, body: await response.json() as { accepted: boolean; ignored?: string }, logged };
  } finally { console.error = original; }
}

function assertIgnored(result: Awaited<ReturnType<typeof deliver>>, delivery: string, event: string, reason: string) {
  assert.equal(result.status, 202);
  assert.deepEqual(result.body, { accepted: true, ignored: reason });
  assert.ok(result.body.ignored, 'the ignored reason is non-empty');
  const line = result.logged.find(entry => entry.includes(delivery));
  assert.ok(line, `the server logs delivery ${delivery}: ${JSON.stringify(result.logged)}`);
  assert.ok(line.includes(`(${event})`), `the log names event ${event}: ${line}`);
  assert.ok(line.endsWith(reason), `the log names the reason ${reason}: ${line}`);
}

test('integration:webhook-ignored-reason — a delivery naming no subject, naming only items with no open job, or repeating a received delivery ID answers 202 with a named ignored reason logged with its delivery ID and event; a delivery that wakes a job carries no ignored field', async () => {
  const item = await submitted('Woken by its pull request');
  const job = async () => (await store.pool.query('SELECT generation FROM jobs WHERE work_id=$1', [item.id])).rows[0];
  assert.ok(await job(), 'submission enqueues the item\'s job');
  const before = Number((await job()).generation);

  // A delivery that wakes a job answers without an ignored field and logs no ignore reason.
  const waking = randomUUID();
  const woken = await deliver(waking, 'pull_request', { action: 'synchronize', pull_request: { number: item.submission!.pr } });
  assert.equal(woken.status, 202); assert.deepEqual(woken.body, { accepted: true });
  assert.ok(!('ignored' in woken.body));
  assert.equal(woken.logged.filter(entry => entry.includes(waking)).length, 0, 'a waking delivery logs no ignore reason');
  assert.equal(Number((await job()).generation), before + 1, 'the delivery woke the item\'s job');

  // The same delivery ID again is a duplicate: accepted, ignored, and it wakes nothing.
  assertIgnored(await deliver(waking, 'pull_request', { action: 'synchronize', pull_request: { number: item.submission!.pr } }), waking, 'pull_request', 'duplicate delivery');
  assert.equal(Number((await job()).generation), before + 1, 'a duplicate wakes nothing');

  // A payload that names no pull request, commit or branch has no subject.
  const subjectless = randomUUID();
  assertIgnored(await deliver(subjectless, 'ping', { zen: 'Keep it logically awesome.' }), subjectless, 'ping', 'no subject');

  // A pull request no item submitted names no open job.
  const unknown = randomUUID();
  assertIgnored(await deliver(unknown, 'pull_request', { action: 'closed', pull_request: { number: pr + 1000 } }), unknown, 'pull_request', 'no open job');

  // An item whose job is gone, as a delivered item's is, names no open job either.
  const finished = await submitted('Finished, its job gone');
  await store.pool.query('DELETE FROM jobs WHERE work_id=$1', [finished.id]);
  const done = randomUUID();
  assertIgnored(await deliver(done, 'check_run', { check_run: { head_sha: 'e'.repeat(40), pull_requests: [{ number: finished.submission!.pr }], app: { id: -1 } } }), done, 'check_run', 'no open job');
  assert.equal(Number((await job()).generation), before + 1, 'a delivery about another item wakes nothing here');

  // Our own check run naming no pull request, commit or branch is suppressed, but still says why.
  const own = randomUUID();
  assertIgnored(await deliver(own, 'check_run', { action: 'completed', check_run: { app: { id: 1234 } } }), own, 'check_run', 'own check');
  // Even when it names the item's pull request, our own check wakes nothing.
  const ownNamed = randomUUID();
  assertIgnored(await deliver(ownNamed, 'check_run', { check_run: { head_sha: 'f'.repeat(40), pull_requests: [{ number: item.submission!.pr }], app: { id: 1234 } } }), ownNamed, 'check_run', 'own check');
  assert.equal(Number((await job()).generation), before + 1, 'our own check wakes nothing');
});
