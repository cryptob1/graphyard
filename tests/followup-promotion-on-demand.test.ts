import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { followUpItem, type LaunchThread } from '../src/review-threads.js';
import { followUpEntries, followUpParent } from '../src/model/machine-backlog.js';
import { workCommands } from '../src/cli/work.js';
import type { Principal, Work } from '../src/model.js';

// GY-896 AC-2 against the real control plane: a recorded follow-up batch stays retrievable by
// item and by PR, and the `work promote-followup` command promotes one finding to its own item —
// exactly once: a rerun finds the item the first run created and never files a duplicate.

const repository = 'owner/followup-promotion';
const operator: Principal = { id: 'promotion-operator', role: 'admin', sessionKind: 'ai' };
const credentials = [operator].map(principal => ({ ...principal, token: `promotion-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const call = async (path: string, body?: unknown, key: string = randomUUID()) => {
  const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token(operator)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
/** The CLI context's `api`, against the test server. */
const api = async (path: string, data?: unknown, requestId?: string) => {
  const result = await call(path, data, requestId);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const reload = async (key: string) => (await store.list()).find(item => item.key === key)!;
const thread = (id: string, path: string, excerpt: string): LaunchThread =>
  ({ id, author: 'graphyard-reviewer', path, line: 30, outdated: false, excerpt, url: `https://github.com/${repository}/pull/7#discussion-r-${id}` });
const promote = workCommands.find(command => command.name === 'promote-followup')!;
/** The real command handler, as the launcher invokes it. */
const runPromote = async (id: string, index: string) => {
  const printed: any[] = [];
  await promote.run!({ id, args: [index], api, print: (value: unknown) => printed.push(value) } as any, undefined);
  return printed[0]!;
};

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 470;
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-promotion-db-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('promotion_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/promotion_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('unit:followup-promotion-on-demand — an operator promotes one finding to its own item once, and the batch stays retrievable', async () => {
  const parent = await api('work', { title: 'Parent', plannedFiles: ['src/a.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:a'] }] }) as Work;
  const batch = await api('work', { ...followUpItem({ key: parent.key, workId: parent.id, pr: 7, sha: 'b'.repeat(40), reviewId: 11 }, [thread('T1', 'src/a.ts', 'the retry is unbounded')], [{ path: 'src/b.ts', line: null, text: 'the cache never expires' }]), policy: { checks: ['test'], review: true } }) as Work;

  // Retrievable by item ...
  assert.deepEqual(followUpEntries(await api(`work/${batch.key}`)).map(entry => entry.path), ['src/a.ts', 'src/b.ts']);
  // ... and by PR: the batch's title names the pull request its approval reviewed.
  const byPr = (await api('work-snapshot')).work.filter((item: any) => followUpParent(item) === parent.key && item.title.includes('(PR #7)'));
  assert.deepEqual(byPr.map((item: any) => item.key), [batch.key]);

  // Promotion: one finding becomes its own item, planned on the finding's file, carrying a
  // required proof and depending on the followed-up item.
  const first = await runPromote(batch.key, '1');
  assert.equal(first.duplicate, false);
  const promoted = await reload(first.item.key);
  assert.equal(promoted.title, `Promoted follow-up ${batch.key} finding 1: the retry is unbounded`);
  assert.equal(promoted.stage, 'backlog');
  assert.deepEqual(promoted.criteria[0].proofs, ['manual:review-followup-addressed']);
  assert.ok(promoted.criteria[0].proofs.length >= 1, 'the promoted criterion carries a required proof');
  assert.deepEqual(promoted.producerProofs, ['manual:review-followup-addressed']);
  assert.deepEqual(promoted.dependencies, [parent.id]);
  assert.deepEqual(promoted.plannedFiles, ['src/a.ts']);
  assert.match(promoted.description, new RegExp(`Promoted from ${batch.key}`));
  assert.match(promoted.description, /the retry is unbounded/);
  // A promoted item is an ordinary item, not its parent's second follow-up item.
  assert.equal(followUpParent(promoted), null);

  // The same promotion again finds the item the first run created: no duplicate is filed.
  const again = await runPromote(batch.key, '1');
  assert.equal(again.duplicate, true);
  assert.equal(again.item.key, first.item.key);
  assert.equal((await store.list()).filter(item => item.title === `Promoted follow-up ${batch.key} finding 1: the retry is unbounded`).length, 1);

  // The other finding promotes separately, to its own item.
  const second = await runPromote(batch.key, '2');
  assert.notEqual(second.item.key, first.item.key);
  assert.deepEqual((await reload(second.item.key)).plannedFiles, ['src/b.ts']);

  // Refusals: an item that is not a follow-up batch, and an index beyond the findings.
  await assert.rejects(runPromote(parent.key, '1'), /not a review follow-up item/);
  await assert.rejects(runPromote(batch.key, '9'), /no finding 9/);
});
