import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { followUpParent } from '../src/model/machine-backlog.js';
import { workCommands } from '../src/cli/work.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-896 AC-2 against the real control plane: a follow-up batch recorded on an approved item stays
// retrievable by item and by pull request (`graphyard followups`), and `graphyard promote-followup`
// promotes one finding to its own work item on an operator's demand — exactly once: a rerun answers
// the item the first run created and never files a duplicate.

const repository = 'owner/followup-promotion';
const operator: Principal = { id: 'promotion-operator', role: 'admin', sessionKind: 'ai' };
const coordinator: Principal = { id: 'promotion-master', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, coordinator].map(principal => ({ ...principal, token: `promotion-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const call = async (principal: Principal, path: string, body?: unknown, key: string = randomUUID()) => {
  const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
/** The CLI context's `api` for `principal`, against the test server. */
const apiAs = (principal: Principal) => async (path: string, data?: unknown, requestId?: string) => {
  const result = await call(principal, path, data, requestId);
  if (result.status !== 200) throw new Error(JSON.stringify(result.body));
  return result.body;
};
const api = apiAs(operator);
const reload = async (key: string) => (await store.list()).find(item => item.key === key)!;
/** A real command handler, as the launcher invokes it. */
const run = async (name: string, id: string, args: string[], as = api) => {
  const printed: any[] = [];
  await workCommands.find(command => command.name === name)!.run!({ id, args, api: as, print: (value: unknown) => printed.push(value) } as any, undefined);
  return printed[0]!;
};

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 470;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('promotion-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('promotion_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/promotion_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('unit:followup-promotion-on-demand — a recorded batch is retrievable by item and PR, and an operator promotes one finding once', async () => {
  const parent = await api('work', { title: 'Parent', plannedFiles: ['src/a.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:a'] }] }) as Work;
  const other = await api('work', { title: 'Other', plannedFiles: ['src/z.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:z'] }] }) as Work;
  const approve = async (work: Work, pr: number, findings: { path: string | null; text: string; ref?: string }[]) => {
    await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{candidate}', $2::jsonb) WHERE id=$1`,
      [work.id, JSON.stringify({ pr, sha: String(pr).padEnd(40, 'e'), author: 'worker', branch: `graphyard/${work.key}`, baseSha: 'd'.repeat(40), createdAt: new Date().toISOString() })]);
    return apiAs(coordinator)(`work/${work.key}/followups`, { findings, reason: `approval of ${work.key}` });
  };
  await approve(parent, 7, [{ path: 'src/a.ts', text: 'the retry is unbounded', ref: `https://github.com/${repository}/pull/7#discussion-r-T1` }, { path: 'src/b.ts', text: 'the cache never expires' }]);
  await approve(other, 8, [{ path: null, text: 'the naming is inconsistent' }]);
  const before = (await store.list()).length;

  // Retrievable by item ...
  const byItem = await run('followups', parent.key, []);
  assert.equal(byItem.key, parent.key);
  assert.deepEqual(byItem.findings.map((finding: any) => [finding.index, finding.path, finding.pr]), [[1, 'src/a.ts', 7], [2, 'src/b.ts', 7]]);
  // ... and by pull request: only the batches recorded for it.
  const byPr = await run('followups', '--pr', ['7']);
  assert.equal(byPr.pr, 7);
  assert.deepEqual(byPr.batches.map((batch: any) => [batch.key, batch.findings.length]), [[parent.key, 2]]);
  assert.deepEqual((await run('followups', '--pr', ['8'])).batches.map((batch: any) => batch.key), [other.key]);

  // Promotion: one finding becomes its own item, planned on the finding's file, carrying a
  // required proof and depending on the approved item.
  const first = await run('promote-followup', parent.key, ['1']);
  assert.equal(first.duplicate, false);
  assert.deepEqual(first.promoted, { from: parent.key, finding: 1, parent: parent.key });
  const promoted = await reload(first.item.key);
  assert.equal(promoted.title, `Promoted follow-up of ${parent.key} (${parent.key} finding 1): the retry is unbounded`);
  assert.equal(promoted.stage, 'backlog');
  assert.deepEqual(promoted.criteria.map(criterion => criterion.proofs), [['manual:review-followup-addressed']]);
  assert.deepEqual(promoted.producerProofs, ['manual:review-followup-addressed']);
  assert.deepEqual(promoted.dependencies, [parent.id]);
  assert.deepEqual(promoted.plannedFiles, ['src/a.ts']);
  assert.match(promoted.description!, /PR #7/);
  assert.match(promoted.description!, /discussion-r-T1/);
  assert.equal(followUpParent(promoted), null, 'a promoted item is an ordinary item, not a follow-up item');
  assert.equal((await store.list()).length, before + 1, 'promotion files exactly one item');

  // The batch marks the finding promoted, and the same promotion again answers that item: no duplicate.
  assert.deepEqual((await run('followups', parent.key, [])).findings.map((finding: any) => finding.promoted), [first.item.key, null]);
  const again = await run('promote-followup', parent.key, ['1']);
  assert.deepEqual([again.duplicate, again.item.key], [true, first.item.key]);
  assert.equal((await store.list()).length, before + 1);

  // The other finding promotes separately, to its own item.
  const second = await run('promote-followup', parent.key, ['2']);
  assert.notEqual(second.item.key, first.item.key);
  assert.deepEqual((await reload(second.item.key)).plannedFiles, ['src/b.ts']);

  // Refusals: an index beyond the findings, an item that holds none, and a caller who is not an operator.
  await assert.rejects(run('promote-followup', parent.key, ['9']), /no finding 9/);
  const bare = await api('work', { title: 'Bare', plannedFiles: ['src/y.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:y'] }] }) as Work;
  await assert.rejects(run('promote-followup', bare.key, ['1']), /holds no follow-up findings/);
  await assert.rejects(run('promote-followup', other.key, ['1'], apiAs(coordinator)), /Only an operator/);
});
