import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { freePort } from '../src/cli/test-isolation.js';
import { cliChangesOf, installDatabaseUrl, liveEffects, renderPlan, runUpgrade, upgradePlan, type UpgradeInputs } from '../src/cli/upgrade.js';
import { localPaths } from '../src/install/local-runtime.js';
import { Store } from '../src/store.js';
import type { InstallRecord } from '../src/install/secrets.js';
import { checkoutRelease } from '../src/release.js';
import { startPostgres } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3524: `graphyard upgrade` backs up the install's own database, read from its recorded deploy
// settings, so an agent identity that cannot read DATABASE_URL can still run it.
const now = new Date(0).toISOString();
const localRecord = { version: 1, installId: 'acme-app', repository: 'acme/app', provider: 'local', baseBranch: 'main', reviewPolicy: 'agent', principals: [], noGithubApp: true,
  deployment: { local: true, port: 4999, image: null }, createdAt: now, updatedAt: now } as unknown as InstallRecord;

/** A local install's directory whose recorded cluster is a real running Postgres. */
async function localInstall() {
  const cluster = await startPostgres();
  const { port, password } = (url => ({ port: url.port, password: decodeURIComponent(url.password) }))(new URL(cluster.url));
  const admin = new pg.Client({ connectionString: cluster.url });
  await admin.connect();
  try { await admin.query('CREATE DATABASE graphyard'); } finally { await admin.end(); }
  const migrated = new URL(cluster.url); migrated.pathname = '/graphyard';
  const store = new Store(migrated.href);
  try { await store.init(); } finally { await store.close(); }
  const directory = await temporaryDirectory('upgrade-own-database'), paths = localPaths(directory);
  await mkdir(paths.postgres, { recursive: true });
  await writeFile(paths.passwordFile, `${password}\n`, { mode: 0o600 });
  await writeFile(paths.portFile, `${port}\n`);
  await writeFile(paths.environment, JSON.stringify({ HOST: '127.0.0.1', PORT: '4999' }), { mode: 0o600 });
  return { directory, password, cluster };
}

const withoutDatabaseUrl = async <T>(body: () => Promise<T>) => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try { return await body(); } finally { if (saved !== undefined) process.env.DATABASE_URL = saved; }
};

const inputsFor = (overrides: Partial<UpgradeInputs>): UpgradeInputs => ({ cliRoot: '/opt/graphyard', repoRoot: '/work/app', current: { version: '2026.10.16', revision: 'a'.repeat(40), released: true },
  target: { version: '2026.10.17', revision: 'b'.repeat(40), schema: 4 }, databaseSchema: 4, install: localRecord, url: 'http://127.0.0.1:4999', backupFile: '/unused', cliChanges: [], databaseUrl: null, ...overrides });

test('integration:upgrade-finds-own-database — with no DATABASE_URL, upgrade backs up the recorded install\'s own database without printing its credential, and stops as before when none is recorded', async () => {
  const { directory, password, cluster } = await localInstall();
  try {
    await withoutDatabaseUrl(async () => {
      const databaseUrl = await installDatabaseUrl(directory, localRecord);
      assert.ok(databaseUrl, 'the recorded install names its own database');
      const backupFile = join(directory, 'backups', 'before.json'), recordFile = join(directory, 'upgrade.json');
      const inputs = inputsFor({ backupFile, databaseUrl });
      const plan = upgradePlan(inputs);
      const printed: string[] = [];
      const log = console.log, error = console.error;
      console.log = (...args: unknown[]) => { printed.push(args.join(' ')); }; console.error = console.log;
      try {
        const live = liveEffects(inputs, recordFile);
        const result = await runUpgrade(plan, { record: live.record, run: step => step.id === 'backup' ? live.run(step) : Promise.resolve() });
        assert.deepEqual(result, { ok: true, steps: plan.steps.map(step => step.id) }, 'the backup ran against the install\'s own database and the upgrade proceeded');
      } finally { console.log = log; console.error = error; }
      const backup = await readFile(backupFile, 'utf8');
      assert.ok(JSON.parse(backup), 'the backup was taken');
      for (const [what, text] of [['the plan', renderPlan(plan)], ['the record', await readFile(recordFile, 'utf8')], ['the output', printed.join('\n')], ['the backup', backup]] as const)
        assert.ok(!text.includes(password), `${what} never carries the database credential`);

      // No install recorded and no DATABASE_URL: the same refusal as before, before any change.
      assert.equal(await installDatabaseUrl(null, null), null);
      assert.equal(await installDatabaseUrl(directory, null), null);
      const bare = inputsFor({ install: null, backupFile: join(directory, 'backups', 'never.json'), databaseUrl: null });
      await assert.rejects(liveEffects(bare, recordFile).run(upgradePlan(bare).steps.find(step => step.id === 'backup')!), /^Error: Set DATABASE_URL to the Graphyard database so the upgrade can back it up before the server migrates it$/);
      assert.ok(!existsSync(bare.backupFile));
    });
    // An explicit DATABASE_URL still wins over the record.
    process.env.DATABASE_URL = 'postgres://explicit@example.invalid/db';
    try { assert.equal(await installDatabaseUrl(directory, localRecord), 'postgres://explicit@example.invalid/db'); } finally { delete process.env.DATABASE_URL; }
  } finally { await cluster.stop(); }
});

const repositoryRoot = new URL('..', import.meta.url).pathname;

/** A clean install's CLI checkout of this repository's code, with a newer commit to upgrade to. */
async function cliCheckout() {
  const root = await temporaryDirectory('upgrade-own-database-cli');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=gate', '-c', 'user.email=gate@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'advice.detachedHead=false', ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  const objects = execFileSync('git', ['-C', repositoryRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  await writeFile(join(root, '.git/objects/info/alternates'), `${join(objects, 'objects')}\n`);
  git('checkout', '--quiet', '--detach', execFileSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  let modules = repositoryRoot;
  while (!existsSync(join(modules, 'node_modules'))) modules = dirname(modules);
  await symlink(join(modules, 'node_modules'), join(root, 'node_modules'));
  await writeFile(join(root, '.git/info/exclude'), 'node_modules\n');
  const previous = git('rev-parse', 'HEAD');
  git('commit', '--quiet', '--allow-empty', '-m', 'newer');
  const newer = git('rev-parse', 'HEAD');
  git('checkout', '--quiet', '--detach', previous);
  return { root, previous, newer };
}

test('e2e:upgrade-finds-own-database — a clean install upgrades to a newer commit with no DATABASE_URL in the environment and /healthz reports the new commit', async () => {
  const { directory, cluster } = await localInstall();
  const { root: cliRoot, previous, newer } = await cliCheckout();
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  let server: ChildProcess | null = null;
  // The install's server, as its runtime starts it: the checkout's code on the install's own database.
  const serve = async (commit: string, databaseUrl: string) => {
    if (server && server.exitCode === null) await new Promise(resolve => { server!.once('exit', resolve); server!.kill(); });
    const { DATABASE_URL: _d, GRAPHYARD_VERSION: _v, GRAPHYARD_BUILD_REVISION: _r, GRAPHYARD_BUILD_SHA: _s, ...host } = process.env;
    server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: cliRoot, stdio: 'ignore',
      env: { ...host, DATABASE_URL: databaseUrl, HOST: '127.0.0.1', PORT: String(port), GRAPHYARD_VERSION: `unreleased ${commit.slice(0, 12)}`, GRAPHYARD_BUILD_REVISION: commit,
        GRAPHYARD_PRINCIPALS: JSON.stringify([{ id: 'admin', role: 'admin', token: 'a'.repeat(32) }]) } });
    for (let attempt = 0; attempt < 600; attempt++) {
      try { const body = await (await fetch(`${url}/healthz`)).json() as { commit?: string }; if (body.commit === commit) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`the server never answered /healthz at ${commit}`);
  };
  try {
    await withoutDatabaseUrl(async () => {
      const databaseUrl = await installDatabaseUrl(directory, localRecord);
      assert.ok(databaseUrl, 'the install names its own database');
      await serve(previous, databaseUrl);
      const target = { version: `unreleased ${newer.slice(0, 12)}`, revision: newer, schema: null };
      const inputs: UpgradeInputs = { cliRoot, repoRoot: cliRoot, current: checkoutRelease(cliRoot), target, databaseSchema: 0, install: localRecord, url,
        backupFile: join(directory, 'backups', 'before-newer.json'), cliChanges: cliChangesOf(cliRoot), databaseUrl };
      const plan = upgradePlan(inputs);
      const live = liveEffects(inputs, join(directory, 'upgrade.json'));
      // checkout, the backup and the strict /healthz check run as graphyard upgrade runs them; the
      // redeploy restarts the install's server on the checked-out code. npm ci, the loop restart and
      // the generated-file refresh need a network or a host supervisor and change nothing /healthz serves.
      const result = await runUpgrade(plan, { record: live.record, async run(step) {
        if (step.id === 'checkout' || step.id === 'backup') return live.run(step);
        if (step.id === 'redeploy') return serve(newer, databaseUrl!);
        if (step.id === 'health') {
          const body = await (await fetch(`${url}/healthz`)).json() as { commit?: string };
          assert.equal(body.commit, newer, '/healthz reports the new commit');
        }
      } });
      assert.deepEqual(result, { ok: true, steps: plan.steps.map(step => step.id) });
      assert.ok(existsSync(inputs.backupFile), 'the pre-upgrade backup was taken from the install\'s own database');
      assert.equal(checkoutRelease(cliRoot).revision, newer);
    });
  } finally {
    const running = server as ChildProcess | null;
    if (running && running.exitCode === null) await new Promise(resolve => { running.once('exit', resolve); running.kill(); });
    await cluster.stop();
  }
});
