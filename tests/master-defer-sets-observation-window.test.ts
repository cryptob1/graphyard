import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { runAutonomyCommand, type MasterConfig } from '../src/master.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1740 AC-1: `graphyard master defer GY-N NOT-BEFORE REASON` holds an unleased post-deploy follow-up on its
// observation window and clears its recorded blocker in one write, recorded under the operator agent's name.

const day = 86_400_000, repository = 'owner/master-defer';
const admin: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const operatorAgent = { id: 'graphyard-operator', role: 'operator-agent', sessionKind: 'ai', capabilities: [],
  scope: { repositories: [repository], workItems: ['*'] } } as unknown as Principal;
const followUp = { id: 'AC-1', text: 'From this head against the serving release f1984c118352: the intervention report shows the escalation rate at the build stage below 3 per 7 days after the change ships', proofs: ['manual:intervention-pattern-escalation-build-on-serving-release'] };

let database: EmbeddedPostgres | undefined;
const stores: Store[] = [];
after(async () => { for (const store of stores) await store.close(); if (database) await database.stop(); });

async function plane() {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1740;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('master-defer'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('master_defer');
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/master_defer`); await store.init(); stores.push(store);
  const engine = new Engine(store, 120, repository); engine.submissionObserver = null; engine.operatorAuthorizer = async (_db, _now, actor) => actor;
  const now = async () => ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).getTime();
  /** A released follow-up whose worker blocked on a reading that cannot exist yet, as GY-1689, GY-1721 and GY-1724 did. */
  const claimed = async (criteria: unknown[] = [followUp]) => {
    const work = await engine.execute(admin, 'create', null, { title: `Follow-up ${randomUUID().slice(0, 8)}`, type: 'chore', criteria }, randomUUID());
    return engine.execute(worker, 'claim', (await engine.execute(admin, 'ready', work.id, {}, randomUUID())).id, {}, randomUUID());
  };
  const blocked = async (criteria: unknown[] = [followUp]) => {
    const work = await claimed(criteria);
    const until = new Date(await now() + 2 * day).toISOString();
    return engine.execute(worker, 'blocked', work.id, { epoch: work.epoch, reason: `The observation AC-1 requires cannot exist before ${until}` }, randomUUID());
  };
  return { store, engine, now, claimed, blocked };
}

test('integration:master-defer-sets-observation-window — master defer sets the window and clears the blocker in one write naming the operator agent; refused under an active lease, for a past instant and past the defer bound', { timeout: 300_000 }, async () => {
  const { store, engine, now, claimed, blocked } = await plane();

  // The CLI subcommand sends exactly the engine command, with the operator agent's own credential and the revision it read.
  const item = await blocked(), notBefore = new Date(await now() + 3 * day).toISOString();
  const posted: { path: string; body: any; token: string }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace(/^\/api\//, ''), body = JSON.parse(String(init.body)), token = String((init.headers as Record<string, string>).Authorization).slice(7);
    posted.push({ path, body, token });
    return new Response(JSON.stringify(await engine.execute(operatorAgent, path.split('/')[2] as 'window', path.split('/')[1], body, randomUUID())), { status: 200 });
  }) as unknown as typeof fetch;
  const root = await temporaryDirectory('master-defer-root'), credentialFile = join(await temporaryDirectory('master-defer-credential'), 'operator-agent.token');
  await writeFile(credentialFile, `${'o'.repeat(40)}\n`, { mode: 0o600 });
  execFileSync('git', ['init', '--quiet', root]);
  const config = { url: 'http://127.0.0.1:1', operatorAgent: { id: operatorAgent.id, credentialFile } } as unknown as MasterConfig;
  const deferred = await runAutonomyCommand(root, config, 'defer', [item.key, notBefore, 'the', '7-day', 'window', 'has', 'not', 'elapsed'], {
    coordinator: async () => ({ now: new Date(await now()).toISOString(), work: [await store.workDocument(item.id)] }), readSecret: async () => '', agents: () => [], daemonLock: async () => null, fetcher }) as Work;
  assert.deepEqual(posted.map(call => [call.path, call.body.notBefore, call.body.reason, call.body.expectedRevision]), [[`work/${item.id}/window`, notBefore, 'the 7-day window has not elapsed', item.revision]]);
  assert.equal(posted[0]!.token, 'o'.repeat(40), 'sent with the operator agent credential');
  assert.deepEqual([deferred.blocker, deferred.lease, deferred.observationWindow?.notBefore, deferred.observationWindow?.basis], [null, null, notBefore, 'operator-hold']);
  assert.match(deferred.observationWindow!.detail, /graphyard-operator held it until then: the 7-day window has not elapsed/);
  assert.equal(deferred.revision, item.revision + 1, 'the window and the cleared blocker are one write');
  const history = (await store.pool.query('SELECT actor, kind, payload FROM events WHERE work_id = $1 ORDER BY seq', [item.id])).rows;
  const entry = history.at(-1)!;
  assert.deepEqual([entry.actor, entry.kind], ['graphyard-operator', 'window'], 'the history entry names the operator agent');
  assert.equal(entry.payload.details?.reason ?? entry.payload.reason, 'the 7-day window has not elapsed');

  // A later instant extends the window; an earlier one never shortens it.
  const shorter = await engine.execute(operatorAgent, 'window', item.id, { expectedRevision: deferred.revision, notBefore: new Date(await now() + day).toISOString(), reason: 'an earlier guess' }, randomUUID());
  assert.equal(shorter.observationWindow?.notBefore, notBefore);

  // Refused while a worker holds the item: its worker defers it under its own lease.
  const leased = await claimed();
  const leaseRefusal = await engine.execute(operatorAgent, 'window', leased.id, { expectedRevision: leased.revision, notBefore, reason: 'held' }, randomUUID()).then(() => null, (error: Error) => error.message);
  assert.match(leaseRefusal ?? '', /is held by implementer under epoch 1/);
  assert.equal((await store.workDocument(leased.id))?.observationWindow, undefined, 'nothing was written');

  const fresh = await blocked();
  await assert.rejects(engine.execute(operatorAgent, 'window', fresh.id, { expectedRevision: fresh.revision, notBefore: new Date(await now() - day).toISOString(), reason: 'past' }, randomUUID()), /already passed/);
  await assert.rejects(engine.execute(operatorAgent, 'window', fresh.id, { expectedRevision: fresh.revision, notBefore: new Date(await now() + 31 * day).toISOString(), reason: 'far' }, randomUUID()), /more than 30 days/);
  const ordinary = await blocked([{ id: 'AC-1', text: 'Behaves', proofs: ['integration:behaves'] }]);
  await assert.rejects(engine.execute(operatorAgent, 'window', ordinary.id, { expectedRevision: ordinary.revision, notBefore, reason: 'not a follow-up' }, randomUUID()), /owes no post-deploy observation/);
  // A worker may never set a window this way.
  await assert.rejects(engine.execute(worker, 'window', fresh.id, { expectedRevision: fresh.revision, notBefore, reason: 'a worker' }, randomUUID()), /Coordinator permission required/);
  // A window read against an older revision is refused: what it was derived from has since changed.
  await assert.rejects(engine.execute(operatorAgent, 'window', fresh.id, { expectedRevision: fresh.revision - 1, notBefore, reason: 'stale' }, randomUUID()), /Task revision changed/);
  assert.ok((await store.workDocument(fresh.id))?.blocker, 'every refusal leaves the blocker standing');
});
