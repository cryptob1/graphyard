import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { masterConfigSchema, runAutonomyCommand, type AutonomyDependencies, type MasterConfig } from '../src/master.js';
import { unblockAttempts } from '../src/master/unblock.js';
import { Store } from '../src/store.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1103: `graphyard master unblock` read the item, then wrote with the revision it read; an
// observation or heartbeat landing in between refused the write with 'Task revision changed'
// and the operator reran it by hand. The CLI now reloads and retries while the same blocker
// stands, and reports a cleared or changed blocker instead. Each test drives the race against a
// real engine: the item moves after the CLI's snapshot read and before its write.
const repository = 'owner/unblock-retry';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const implementer: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const roster = [operator, coordinator, implementer];
const credentials = roster.map(principal => ({ ...principal, token: `unblock-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
const master = { id: 'master-operator', token: `master-operator-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'intent:unblock'] };
const root = fileURLToPath(new URL('..', import.meta.url));
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
let masterRoot: string, credentialDirectory: string, config: MasterConfig;

const api = async (credential: string, path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const unblocks = async (work: Work) => (await store.pool.query(`SELECT actor FROM events WHERE work_id=$1 AND kind='unblock' ORDER BY seq`, [work.id])).rows.map(row => row.actor);

/** A released, claimed item its worker has reported blocked. */
async function blocked(title: string, reason = 'Waiting on an external decision', keepLease = false) {
  let work = await api(master.token, 'work', { title, description: `Why ${title}`, plannedFiles: [`src/${title}.ts`], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], reason: 'Operator goal' }) as Work;
  work = await engine.execute(operator, 'ready', work.id, { reason: 'Next by priority' }, randomUUID());
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  const lease = work.lease!;
  work = await engine.execute(implementer, 'blocked', work.id, { epoch: work.epoch, reason }, randomUUID());
  assert.equal(work.blocker, reason);
  if (keepLease) {
    // An attempt blocked before GY-1008 held its lease, which heartbeated on 2026-10-01.
    await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{lease}',$2::jsonb) WHERE id=$1", [work.id, JSON.stringify(lease)]);
    return reload(work.id);
  }
  return work;
}

/** The CLI's dependencies, with `race` run after each snapshot read and before the write it feeds. */
function racing(race: (read: number) => Promise<void>) {
  let reads = 0;
  const dependencies: AutonomyDependencies = { readSecret: async () => '', agents: () => [], daemonLock: async () => null,
    coordinator: async path => { const result = await api(token(coordinator), path); if (path === 'work-snapshot') await race(++reads); return result; } };
  return { dependencies, reads: () => reads };
}

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 103;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('unblock-retry'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('unblock_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/unblock_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  await api(token(operator), 'operator-agents', { id: master.id, displayName: master.id, capabilities: master.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: master.token, reason: 'Onboarding provisions agent identities' });
  masterRoot = await temporaryDirectory('unblock-root');
  execFileSync('git', ['init', '-q', masterRoot]);
  await writeFile(join(masterRoot, '.gitignore'), '.graphyard/\n');
  credentialDirectory = await temporaryDirectory('unblock-credentials');
  await writeFile(join(credentialDirectory, 'master.token'), token(coordinator), { mode: 0o600 });
  await writeFile(join(credentialDirectory, 'master-operator.token'), master.token, { mode: 0o600 });
  config = masterConfigSchema.parse({ version: 1, url, credentialFile: join(credentialDirectory, 'master.token'), cliPath: join(root, 'bin/graphyard.mjs'), repository, baseBranch: 'main', githubAppId: 1234, hostId: 'unblock-host', masterAgentName: 'graphyard-master-unblock',
    operatorAgent: { id: master.id, credentialFile: join(credentialDirectory, 'master-operator.token') } });
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); await rm(masterRoot, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); });

test('unit:unblock-retries-stale-revision a heartbeat between the read and the write is retried on the reloaded revision and the blocker clears', async () => {
  const work = await blocked('heartbeat-race', undefined, true);
  // The worker heartbeats right after the CLI's first read, as the loop's observations and heartbeats did on 2026-10-01.
  const run = racing(async read => { if (read === 1) await engine.execute(implementer, 'heartbeat', work.id, { epoch: work.epoch }, randomUUID()); });
  const result = await runAutonomyCommand(masterRoot, config, 'unblock', [work.key, 'The', 'external', 'decision', 'was', 'made'], run.dependencies) as Work;
  assert.equal(result.blocker, null, 'the retry cleared the blocker without operator action');
  assert.equal((await reload(work.id)).blocker, null);
  assert.equal(run.reads(), 2, 'one refused write, one reload, one accepted write');
  assert.deepEqual(await unblocks(work), [master.id], 'exactly one unblock is recorded, by the master operator agent');
});

test('unit:unblock-retries-stale-revision the retry is bounded: a revision that moves on every read is reported after the last attempt', async () => {
  const work = await blocked('always-moving', undefined, true);
  const run = racing(async () => { await engine.execute(implementer, 'heartbeat', work.id, { epoch: work.epoch }, randomUUID()); });
  await assert.rejects(runAutonomyCommand(masterRoot, config, 'unblock', [work.key, 'Cleared'], run.dependencies), /Task revision changed/);
  assert.equal(run.reads(), unblockAttempts, 'one read per attempt, and no more attempts than the bound');
  assert.equal((await reload(work.id)).blocker, 'Waiting on an external decision', 'nothing was unblocked');
  assert.deepEqual(await unblocks(work), []);
});

test('unit:unblock-retries-stale-revision a reload that finds the item no longer blocked reports it and writes nothing', async () => {
  const work = await blocked('cleared-elsewhere');
  const run = racing(async read => { if (read === 1) await engine.execute(operator, 'unblock', work.id, { reason: 'Cleared by the operator', expectedRevision: (await reload(work.id)).revision }, randomUUID()); });
  await assert.rejects(runAutonomyCommand(masterRoot, config, 'unblock', [work.key, 'Cleared'], run.dependencies), new RegExp(`${work.key} is no longer blocked at revision \\d+; nothing was unblocked`));
  assert.equal(run.reads(), 2);
  assert.deepEqual(await unblocks(work), [operator.id], 'only the operator\'s own unblock is recorded');
});

test('unit:unblock-retries-stale-revision a reload that finds a different blocker reports the change and leaves the new blocker standing', async () => {
  const work = await blocked('blocker-changed');
  const run = racing(async read => {
    if (read !== 1) return;
    let item = await engine.execute(operator, 'unblock', work.id, { reason: 'Cleared', expectedRevision: (await reload(work.id)).revision }, randomUUID());
    item = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
    item = await engine.execute(implementer, 'blocked', work.id, { epoch: item.epoch, reason: 'Waiting on a new credential' }, randomUUID());
    assert.equal(item.blocker, 'Waiting on a new credential');
  });
  await assert.rejects(runAutonomyCommand(masterRoot, config, 'unblock', [work.key, 'Cleared'], run.dependencies),
    new RegExp(`${work.key}'s blocker changed at revision \\d+, so it was not unblocked: was "Waiting on an external decision", now "Waiting on a new credential"`));
  assert.equal((await reload(work.id)).blocker, 'Waiting on a new credential', 'the new blocker stands');
  assert.deepEqual(await unblocks(work), [operator.id]);
});

test('unit:unblock-retries-stale-revision a refusal other than a stale revision is reported at once, without a reload', async () => {
  const work = await blocked('not-stale');
  await engine.execute(operator, 'unblock', work.id, { reason: 'Cleared', expectedRevision: work.revision }, randomUUID());
  const run = racing(async () => {});
  await assert.rejects(runAutonomyCommand(masterRoot, config, 'unblock', [work.key, 'Cleared'], run.dependencies), /Task has no blocker to clear/);
  assert.equal(run.reads(), 1);
});
