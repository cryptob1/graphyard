import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { freePort } from '../src/cli/test-isolation.js';
import { liveEffects, runUpgrade, upgradeFailure, upgradePlan, type UpgradeInputs } from '../src/cli/upgrade.js';
import type { InstallRecord } from '../src/install/secrets.js';
import { checkoutRelease } from '../src/release.js';
import { Store, advisoryLocks } from '../src/store.js';
import { startPostgres } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3538: `graphyard upgrade` backs up the database with the running release's CLI before it moves
// the checkout, so a target at a newer schema generation never runs the backup against the older database.
const repositoryRoot = new URL('..', import.meta.url).pathname;
const now = new Date(0).toISOString();
const localRecord = { version: 1, installId: 'acme-app', repository: 'acme/app', provider: 'local', baseBranch: 'main', reviewPolicy: 'agent', principals: [], noGithubApp: true,
  deployment: { local: true, port: 4999, image: null }, createdAt: now, updatedAt: now } as unknown as InstallRecord;
const own = (...args: string[]) => execFileSync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8' }).trim();

/** A CLI checkout at the release just before the newest schema generation, and the tip one generation newer. */
async function cliCheckout() {
  const root = await temporaryDirectory('upgrade-backup-cli');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'advice.detachedHead=false', ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  await writeFile(join(root, '.git/objects/info/alternates'), `${join(own('rev-parse', '--path-format=absolute', '--git-common-dir'), 'objects')}\n`);
  const newer = own('rev-parse', 'HEAD');
  const previous = own('rev-parse', `${own('log', '-1', '--format=%H', newer, '--', 'src/store/schema-lineage.ts')}^`);
  git('checkout', '--quiet', '--detach', previous);
  let modules = repositoryRoot;
  while (!existsSync(join(modules, 'node_modules'))) modules = dirname(modules);
  await symlink(join(modules, 'node_modules'), join(root, 'node_modules'));
  await writeFile(join(root, '.git/info/exclude'), 'node_modules\n');
  return { root, previous, newer };
}

/** A real cluster with an empty graphyard database. */
async function database() {
  const cluster = await startPostgres();
  const admin = new pg.Client({ connectionString: cluster.url });
  await admin.connect();
  try { await admin.query('CREATE DATABASE graphyard'); } finally { await admin.end(); }
  const url = new URL(cluster.url); url.pathname = '/graphyard';
  return { cluster, url: url.href };
}

const cliRun = (root: string, databaseUrl: string, ...args: string[]) =>
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64_000_000, env: { ...process.env, DATABASE_URL: databaseUrl } });
const schemaOf = async (url: string) => { const store = new Store(url); try { return await store.schema(); } finally { await store.close(); } };

const inputsFor = (cliRoot: string, newer: string, databaseUrl: string, backupFile: string, schema: number, url = 'http://127.0.0.1:4999'): UpgradeInputs => ({
  cliRoot, repoRoot: cliRoot, current: checkoutRelease(cliRoot), target: { version: `unreleased ${newer.slice(0, 12)}`, revision: newer, schema: schema + 1 },
  databaseSchema: schema, install: localRecord, url, backupFile, cliChanges: [], databaseUrl });

test('integration:upgrade-backup-before-checkout — the backup runs first, on the running release\'s code against its own schema generation; it streams a ledger larger than its heap with no statement timeout and db verify and restore accept it; a failed backup changes nothing and names its cause in one line', async () => {
  const { cluster, url } = await database();
  const { root, previous, newer } = await cliCheckout();
  try {
    cliRun(root, url, 'db', 'migrate');
    const schema = await schemaOf(url);
    const directory = await temporaryDirectory('upgrade-backup');
    const inputs = inputsFor(root, newer, url, join(directory, 'backups', 'before.json'), schema);
    const plan = upgradePlan(inputs);
    assert.deepEqual(plan.steps.map(step => step.id), ['backup', 'checkout', 'npm-ci', 'redeploy', 'restart', 'refresh', 'health'], 'the backup precedes the checkout move');

    const live = liveEffects(inputs, join(directory, 'upgrade.json'));
    const seen: string[] = [];
    const result = await runUpgrade(plan, { record: live.record, async run(step) {
      seen.push(`${step.id}@${checkoutRelease(root).revision}`);
      if (step.id === 'backup' || step.id === 'checkout') await live.run(step);
    } });
    assert.deepEqual(result, { ok: true, steps: plan.steps.map(step => step.id) }, 'an upgrade from generation N to N+1 completes every step');
    assert.equal(seen[0], `backup@${previous}`, 'the backup ran while the checkout still held the running release');
    assert.equal(JSON.parse(readFileSync(inputs.backupFile, 'utf8')).schemaVersion, schema, 'the backup carries the database\'s own generation');
    assert.equal(checkoutRelease(root).revision, newer, 'the checkout moved after the backup');

    // A failed backup: nothing after it runs, the checkout stays put, and the message is one line naming the cause.
    execFileSync('git', ['-C', root, 'checkout', '--quiet', '--detach', previous]);
    const dead = inputsFor(root, newer, 'postgres://graphyard:testing-only@127.0.0.1:1/graphyard', join(directory, 'backups', 'never.json'), schema);
    const deadLive = liveEffects(dead, join(directory, 'upgrade.json'));
    const ran: string[] = [];
    const failed = await runUpgrade(upgradePlan(dead), { record: deadLive.record, async run(step) { ran.push(step.id); if (step.id === 'backup' || step.id === 'checkout') await deadLive.run(step); } });
    assert.deepEqual(ran, ['backup'], 'nothing runs after the failed backup');
    assert.equal(checkoutRelease(root).revision, previous, 'the CLI checkout is untouched');
    assert.ok(!existsSync(dead.backupFile));
    assert.ok(!failed.ok);
    const message = upgradeFailure(failed);
    assert.ok(!message.includes('\n'), `one line: ${message}`);
    assert.match(message, /^upgrade stopped at backup: .*ECONNREFUSED.*; nothing was changed$/);

    // The release under test, on a ledger with a large events table: the upgrade's backup streams it to
    // disk in a heap far smaller than the table, with no statement timeout, and db verify and db restore
    // read the file back in the same heap.
    const create = async (name: string) => {
      const admin = new pg.Client({ connectionString: url });
      await admin.connect();
      try { await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
      const named = new URL(url); named.pathname = `/${name}`; return named.href;
    };
    const current = await create('current'), restored = await create('restored');
    const migrated = new Store(current);
    try { await migrated.init(); } finally { await migrated.close(); }
    const seeding = new pg.Client({ connectionString: current });
    await seeding.connect();
    try { await seeding.query(`INSERT INTO events(actor,kind,payload) SELECT 'seed','test.large',jsonb_build_object('blob',repeat(md5(i::text),3200)) FROM generate_series(1,4000) i`); }
    finally { await seeding.end(); }
    const large = { ...inputsFor(repositoryRoot, newer, current, join(directory, 'backups', 'large.json'), schema + 1), current: checkoutRelease(repositoryRoot) };
    const holder = new pg.Client({ connectionString: current });
    await holder.connect();
    const heap = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `${heap ?? ''} --max-old-space-size=160`.trim();
    try {
      // The role's timeout is shorter than the wait for a restore's lock, and the backup still completes.
      await holder.query(`ALTER ROLE graphyard IN DATABASE current SET statement_timeout = 200`);
      await holder.query('SELECT pg_advisory_lock($1)', [advisoryLocks.backup]);
      // The server releases the lock a second later on its own: the backup step blocks this process while it runs.
      const released = holder.query('SELECT pg_sleep(1), pg_advisory_unlock($1)', [advisoryLocks.backup]);
      await liveEffects(large, join(directory, 'upgrade.json')).run(upgradePlan(large).steps.find(step => step.id === 'backup')!);
      await released;
      assert.ok(statSync(large.backupFile).size > 400_000_000, 'the ledger is larger than the backup\'s heap');
      const verified = JSON.parse(cliRun(repositoryRoot, current, 'db', 'verify', large.backupFile));
      assert.equal(verified.valid, true); assert.equal(verified.rows.events, 4000);
      const back = JSON.parse(cliRun(repositoryRoot, restored, 'db', 'restore', large.backupFile));
      assert.equal(back.counts.events, 4000, 'the restore read the file back');
    } finally {
      if (heap === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = heap;
      await holder.query('ALTER ROLE graphyard IN DATABASE current RESET statement_timeout').catch(() => {});
      await holder.end();
    }
  } finally { await cluster.stop(); }
});

test('e2e:upgrade-backup-before-checkout — an install on schema N upgrades to a commit with schema N+1 and /healthz reports the new commit', async () => {
  const { cluster, url: databaseUrl } = await database();
  const { root, previous, newer } = await cliCheckout();
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  let server: ChildProcess | null = null;
  // The install's server, as its runtime starts it: the checkout's code on the install's database, which it migrates.
  const serve = async (commit: string) => {
    if (server && server.exitCode === null) await new Promise(resolve => { server!.once('exit', resolve); server!.kill(); });
    const { DATABASE_URL: _d, GRAPHYARD_VERSION: _v, GRAPHYARD_BUILD_REVISION: _r, GRAPHYARD_BUILD_SHA: _s, ...host } = process.env;
    server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: root, stdio: 'ignore',
      env: { ...host, DATABASE_URL: databaseUrl, HOST: '127.0.0.1', PORT: String(port), GRAPHYARD_VERSION: `unreleased ${commit.slice(0, 12)}`, GRAPHYARD_BUILD_REVISION: commit,
        GRAPHYARD_PRINCIPALS: JSON.stringify([{ id: 'admin', role: 'admin', token: 'a'.repeat(32) }]) } });
    for (let attempt = 0; attempt < 600; attempt++) {
      try { const body = await (await fetch(`${url}/healthz`)).json() as { commit?: string }; if (body.commit === commit) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`the server never answered /healthz at ${commit}`);
  };
  try {
    await serve(previous);
    const schema = await schemaOf(databaseUrl);
    const directory = await temporaryDirectory('upgrade-backup-e2e');
    const inputs = inputsFor(root, newer, databaseUrl, join(directory, 'backups', 'before.json'), schema, url);
    const plan = upgradePlan(inputs);
    const live = liveEffects(inputs, join(directory, 'upgrade.json'));
    // The backup and checkout run as graphyard upgrade runs them; the redeploy restarts the server on the
    // checked-out code, which migrates the database. npm ci, the loop restart and the refresh need a
    // network or a host supervisor and change nothing /healthz serves.
    const result = await runUpgrade(plan, { record: live.record, async run(step) {
      if (step.id === 'backup' || step.id === 'checkout') return live.run(step);
      if (step.id === 'redeploy') return serve(newer);
      if (step.id === 'health') assert.equal(((await (await fetch(`${url}/healthz`)).json()) as { commit?: string }).commit, newer, '/healthz reports the new commit');
    } });
    assert.deepEqual(result, { ok: true, steps: plan.steps.map(step => step.id) });
    assert.equal(JSON.parse(readFileSync(inputs.backupFile, 'utf8')).schemaVersion, schema, 'the backup was taken at generation N');
    assert.equal(await schemaOf(databaseUrl), schema + 1, 'the new server migrated the database to generation N+1');
  } finally {
    const running = server as ChildProcess | null;
    if (running && running.exitCode === null) await new Promise(resolve => { running.once('exit', resolve); running.kill(); });
    await cluster.stop();
  }
});
