import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { backupDigest, createBackup, restoreBackup } from '../src/backup.js';
import { migrationDigestComment, migrationDigests } from '../src/store/schema.js';
import { defaultMergerMode, recordedMergerMode } from '../src/merger-mode.js';
import { mergerDoctorLine } from '../src/cli/merger.js';
import { checklistGreen, legacyMergerLine, mergerMigrationCommand, setupChecklist } from '../src/model/setup-checklist.js';
import { setupFromZeroChecks, setupLine } from '../src/setup-from-zero.js';
import { recordedUp, runUp, upControlPlaneSteps, upCommandFlags, upRequestFromArgs, upStateFile, upSteps, upStepsFor, upUsage, type UpDependencies, type UpEvent } from '../src/up.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1833: the control-plane merger is the shipped default for every installation. A plane with no
 * recorded merger event reads as control-plane, one that recorded github keeps it, and a database
 * that held history before the default changed is pinned to github by its migration. `graphyard up`
 * sets up the control-plane path unless `--merger github`, which records github itself. The Setup
 * checklist and doctor flag a github install as legacy with its migration command.
 */
let pg: EmbeddedPostgres, store: Store, database: string, port: number;
before(async () => {
  port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1833;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('merger-default'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('merger_default_test');
  database = `postgres://graphyard:testing-only@127.0.0.1:${port}/merger_default_test`;
  store = new Store(database); await store.init();
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

const mergerRows = async () => (await store.pool.query("SELECT actor, payload FROM events WHERE work_id IS NULL AND kind='policy.merger.set' ORDER BY seq")).rows;
/** Makes the next migration see the pin's DDL as new, as a database an older release migrated does. */
const forgetPinDigest = async () => {
  const digests = migrationDigests();
  delete digests.tables.merger_default_pin;
  await store.pool.query(`COMMENT ON TABLE graphyard_schema IS ${migrationDigestComment(digests)}`);
};

const status = (merger: 'github' | 'control-plane', extra: Record<string, unknown> = {}) => ({
  actor: { role: 'admin' }, github: merger === 'github', githubAppId: merger === 'github' ? 7 : null, reviewerApps: [], appPermissions: null,
  setup: { protection: 'none', loop: true, supervision: 'autonomous' }, fleet: { roles: [], accounts: [] },
  mergeWriter: { merger, since: null, setBy: null, reason: null, event: null, line: null }, ...extra,
});

/** A simulated host for up: install finishes, accounts and the loop are green, the plane reads MERGER. */
function upWorld(initial: 'github' | 'control-plane', host: { claim: string | null } | null = null) {
  const calls: string[][] = [];
  const mergers: { requestId: string; merger: string; token: string }[] = [];
  const deployKeys: string[] = [];
  let installed = false, loop = false, merger = initial, clock = 0;
  const deps = (checkout: string, events: UpEvent[]): UpDependencies => ({
    root: checkout, pollMs: 1, emit: event => { events.push(event); },
    now: () => clock, sleep: async ms => { clock += ms; },
    serverUrl: async () => installed ? 'http://127.0.0.1:4310' : null,
    masterToken: async () => installed ? 'm'.repeat(40) : null,
    // A host install keeps the admin credential on the host: none on this machine, only its one-time claim's.
    operatorToken: async () => host ? null : 'a'.repeat(40),
    signIn: async () => null,
    redeemClaim: async claim => host?.claim && claim.endsWith(`#claim=${host.claim}`) ? 'h'.repeat(48) : null,
    status: async () => installed ? {
      github: true, githubRepository: 'owner/project', appPermissions: { missing: [] }, reviewerApps: [{ id: 'claude', appId: 9 }],
      mergeWriter: { merger, setBy: null },
      fleet: { roles: [{ role: 'worker', accounts: ['claude-a'] }, { role: 'reviewer', accounts: ['claude-a'] }], accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, smoke: { result: 'pass' } }] },
      setup: { protection: 'checks', loop },
    } : null,
    publishOnboarding: async () => null,
    onboardingMerged: async () => true,
    installDirectory: () => join(checkout, 'install-dir'),
    ensureDeployKey: async (installDir, repository) => { deployKeys.push(repository); return join(installDir, 'deploy-key'); },
    setMerger: async (token, requestId, next) => { mergers.push({ requestId, merger: next, token }); merger = next; },
    gh: async args => args[1] === 'view' ? { code: 0, stdout: '{"name":"project"}' } : { code: 1, stdout: '', stderr: 'unexpected' },
    async cli(args) {
      calls.push(args);
      if (args[0] === 'install' && args.includes('--plan')) return { code: 0, stdout: JSON.stringify({ installId: 'owner-project', installDirectory: join(checkout, 'install-dir'), principals: [{ id: 'owner-project-operator', role: 'admin', sessionKind: 'human' }], preflight: [{ name: 'GitHub CLI', ok: true }], browserApps: [] }) };
      if (args[0] === 'install' && args.includes('--apply')) {
        installed = true;
        return { code: 0, stdout: JSON.stringify(host ? { ok: true, principals: [{ id: 'owner-project-operator', role: 'admin', tokenFile: '/var/lib/graphyard/tokens/owner-project-operator.token' }], signIn: `http://127.0.0.1:4310/#claim=${host.claim ?? 'spent'.repeat(4)}`, host: { host: 'graphyard-owner-project', masterIdentities: true, units: [] } } : { ok: true }) };
      }
      if (args.join(' ') === 'master restart') { loop = true; return { code: 0, stdout: '{}' }; }
      return { code: 0, stdout: '{}' };
    },
  });
  return { calls, mergers, deployKeys, deps, merger: () => merger };
}

test('unit:merger-default-control-plane — a plane with no recorded merger reads control-plane, a recorded github keeps it, and a database that held history before the default changed is pinned to github once', async () => {
  assert.equal(defaultMergerMode, 'control-plane');
  const none = await recordedMergerMode({ query: async () => ({ rows: [] }) } as any);
  assert.deepEqual(none, { merger: 'control-plane', since: null, setBy: null, reason: null, event: null });
  const github = await recordedMergerMode({ query: async () => ({ rows: [{ seq: 4, actor: 'human-operator', payload: { merger: 'github', reason: 'kept' }, created_at: '2026-10-16T00:00:00.000Z' }] }) } as any);
  assert.equal(github.merger, 'github'); assert.equal(github.setBy, 'human-operator');
  assert.equal(mergerDoctorLine(null), 'merger: control-plane (default)');
  assert.equal(mergerDoctorLine({ merger: 'control-plane', since: null, setBy: null }), 'merger: control-plane (default)');

  // A new database migrates with no events: nothing is recorded and it reads control-plane, even after history arrives.
  assert.deepEqual(await mergerRows(), []);
  assert.equal((await recordedMergerMode(store.pool)).merger, 'control-plane');
  await store.pool.query("INSERT INTO events(work_id, actor, kind, payload) VALUES(NULL, 'human-operator', 'test.history', '{}')");
  await store.init();
  assert.equal((await recordedMergerMode(store.pool)).merger, 'control-plane', 'a restart of a new install never pins it');
  // A rollback and a later upgrade re-run the pin's DDL: its marker says this database started on the new default.
  await forgetPinDigest(); await store.init();
  assert.deepEqual(await mergerRows(), [], 'a re-run never pins a database that started on the new default');

  // A database an older release migrated: history, no merger event and no pin marker. The upgrade pins github once.
  await store.pool.query('DROP TABLE merger_default_pin');
  await forgetPinDigest(); await store.init();
  const pinned = await mergerRows();
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].payload.merger, 'github');
  assert.match(pinned[0].payload.reason, /graphyard up --merger control-plane/);
  assert.equal((await recordedMergerMode(store.pool)).merger, 'github', 'the existing install keeps the merger it ran with');
  await store.init(); await forgetPinDigest(); await store.init();
  assert.equal((await mergerRows()).length, 1, 'the pin is written once');
});

test('unit:merger-default-control-plane — a restore keeps the merger the backed-up install ran with: a backup taken before the pin existed is pinned to github over its restored ledger, and a new-default backup restores as control-plane', async () => {
  const fresh = async (name: string) => { await pg.createDatabase(name); const target = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/${name}`); await target.init(); return target; };
  // An install that started on the new default: history, no merger event, an unpinned marker.
  const source = await fresh('merger_default_source');
  try {
    await source.pool.query("INSERT INTO events(work_id, actor, kind, payload) VALUES(NULL, 'human-operator', 'test.history', '{}')");
    const current = await createBackup(source.pool);
    assert.ok(current.tables.some(table => table.name === 'merger_default_pin'), 'a backup carries the marker');
    const kept = await fresh('merger_default_kept');
    try {
      await restoreBackup(kept.pool, current);
      assert.equal((await recordedMergerMode(kept.pool)).merger, 'control-plane', 'a new-default install restores on the new default');
    } finally { await kept.close(); }

    // The same ledger as a release before GY-1833 backed it up: no marker table and no merger event.
    const { digest: _digest, ...body } = { ...current, tables: current.tables.filter(table => table.name !== 'merger_default_pin') }; void _digest;
    const legacy = { ...body, digest: backupDigest(body) };
    const restored = await fresh('merger_default_restored');
    try {
      assert.equal((await recordedMergerMode(restored.pool)).merger, 'control-plane', 'the empty target decided unpinned');
      const result = await restoreBackup(restored.pool, legacy);
      assert.ok(!result.tablesLeftEmpty.includes('merger_default_pin'), 'the marker is re-derived, not left empty');
      const mode = await recordedMergerMode(restored.pool);
      assert.equal(mode.merger, 'github', 'the restored legacy install keeps github');
      assert.match(String(mode.reason), /graphyard up --merger control-plane/);
      // The pin appended after the restored sequences: the next event takes a fresh sequence number.
      await restored.pool.query("INSERT INTO events(work_id, actor, kind, payload) VALUES(NULL, 'human-operator', 'test.after', '{}')");
      await restored.init();
      assert.equal((await restored.pool.query("SELECT count(*)::int AS n FROM events WHERE kind='policy.merger.set'")).rows[0].n, 1, 'pinned once');
    } finally { await restored.close(); }
  } finally { await source.close(); }
});

test('unit:merger-default-control-plane — graphyard up without --merger plans the control-plane path (deploy key, merger setting, no GitHub Apps); --merger github plans the App path and records github', async () => {
  const bare = upRequestFromArgs(['--repo', 'owner/project']);
  assert.equal(bare.merger, 'control-plane');
  assert.deepEqual([...upStepsFor(bare)], [...upControlPlaneSteps]);
  assert.ok((upStepsFor(bare) as readonly string[]).includes('deploy-key') && (upStepsFor(bare) as readonly string[]).includes('merger-setting'));
  const legacy = upRequestFromArgs(['--repo', 'owner/project', '--merger', 'github']);
  assert.equal(legacy.merger, 'github');
  assert.deepEqual([...upStepsFor(legacy)], [...upSteps]);
  assert.equal(upRequestFromArgs(['--repo', 'owner/project', '--local']).merger, 'github', 'supervised mode merges on GitHub');
  assert.match(upUsage, /--merger control-plane\|github +who merges heads: the control plane \(default; deploy key, no Apps\), or github Apps \(legacy\)/);
  assert.match(upCommandFlags(legacy), / --merger github/, 'a printed legacy rerun names its merger');

  const checkout = await temporaryDirectory('merger-default-up');
  const world = upWorld('control-plane');
  const events: UpEvent[] = [];
  const result = await runUp(bare, world.deps(checkout, events));
  assert.equal(result.exitCode, 0, result.next);
  assert.deepEqual(result.completed, [...upControlPlaneSteps].filter(step => step !== 'goal'));
  const installs = world.calls.filter(args => args[0] === 'install');
  assert.ok(installs.length && installs.every(args => args.includes('--no-github-app') && !args.includes('--reviewer')), 'no GitHub App is registered');
  assert.deepEqual(world.deployKeys, ['owner/project']);
  assert.deepEqual(world.mergers, [], 'a plane already reading control-plane is not posted again');

  const githubCheckout = await temporaryDirectory('merger-default-up-github');
  const app = upWorld('control-plane');
  const appResult = await runUp(legacy, app.deps(githubCheckout, []));
  assert.equal(appResult.exitCode, 0, appResult.next);
  assert.deepEqual(appResult.completed, [...upSteps].filter(step => step !== 'goal'));
  const appInstalls = app.calls.filter(args => args[0] === 'install');
  assert.ok(appInstalls.every(args => !args.includes('--no-github-app') && args.includes('--reviewer')), 'the App path registers Apps');
  assert.deepEqual(app.deployKeys, []);
  assert.deepEqual(app.mergers.map(entry => entry.merger), ['github'], 'the legacy path records github, since the plane would read control-plane');
  assert.equal(app.merger(), 'github');
  assert.equal(appResult.checklist.find(item => item.id === 'merger')?.done, false, 'up finishes green with the legacy line still failing');

  // A host install keeps the admin credential on the host: the github merger is recorded with the credential its
  // one-time claim yields, and with neither that nor a local one up stops before onboarding, never finishing unrecorded.
  const hosted = upWorld('control-plane', { claim: 'c'.repeat(20) });
  const hostedResult = await runUp(legacy, hosted.deps(await temporaryDirectory('merger-default-up-host'), []));
  assert.equal(hostedResult.exitCode, 0, hostedResult.next);
  assert.deepEqual(hosted.mergers.map(entry => [entry.merger, entry.token]), [['github', 'h'.repeat(48)]]);
  assert.equal(hosted.merger(), 'github');
  const stranded = upWorld('control-plane', { claim: null });
  const strandedEvents: UpEvent[] = [];
  const strandedResult = await runUp(legacy, stranded.deps(await temporaryDirectory('merger-default-up-host-missing'), strandedEvents));
  assert.equal(strandedResult.exitCode, 2, strandedResult.next);
  assert.match(strandedResult.next, /^merger-setting: the operator's admin credential is not on this machine.*run graphyard master merger github --reason TEXT with it on graphyard-owner-project and rerun graphyard up .*--merger github/);
  assert.deepEqual(stranded.mergers, []);
  assert.equal(stranded.merger(), 'control-plane', 'the plane still reads control-plane');
  assert.ok(!stranded.calls.some(args => args[0] === 'init'), 'so no onboarding runs');
  assert.ok(!strandedResult.completed.includes('onboarding') && !strandedResult.completed.includes('master-loop'));

  // The migration command: a rerun with --merger control-plane over the recorded github run keeps the shared steps.
  assert.equal(recordedUp(githubCheckout)?.merger, 'github');
  const migrate = upRequestFromArgs(['--merger', 'control-plane'], recordedUp(githubCheckout));
  assert.equal(migrate.merger, 'control-plane');
  const migrateEvents: UpEvent[] = [];
  const migrated = await runUp(migrate, app.deps(githubCheckout, migrateEvents));
  assert.equal(migrated.exitCode, 0, migrated.next);
  const started = migrateEvents.flatMap(event => event.kind === 'step' && event.state === 'start' ? [event.step] : []);
  assert.deepEqual(started, ['deploy-key', 'merger-setting'], 'only the control-plane steps run');
  assert.deepEqual(app.mergers.map(entry => entry.merger), ['github', 'control-plane']);
  assert.notEqual(app.mergers[0].requestId, app.mergers[1].requestId, 'each setting has its own idempotency key');
  assert.equal(JSON.parse(await readFile(upStateFile(githubCheckout), 'utf8')).merger, 'control-plane');
  assert.throws(() => upRequestFromArgs(['--merger', 'github'], recordedUp(githubCheckout)), /--merger github conflicts with control-plane/, 'the reverse is not a migration');

  // A run recorded before the merger field existed took the github path.
  const old = await temporaryDirectory('merger-default-old-state');
  await mkdir(join(old, '.graphyard'), { recursive: true });
  await writeFile(upStateFile(old), JSON.stringify({ version: 1, repository: 'owner/project', provider: 'compose', completed: [], noHerdr: false, goal: null }));
  assert.equal(upRequestFromArgs([], recordedUp(old)).merger, 'github');
});

test('unit:legacy-merger-flagged — the Setup checklist and doctor report a github install as one FAIL line naming graphyard up --merger control-plane, and a control-plane install as PASS', async () => {
  assert.equal(mergerMigrationCommand, 'graphyard up --merger control-plane');
  const legacy = setupChecklist(status('github'));
  const flagged = legacy.filter(item => item.id === 'merger');
  assert.equal(flagged.length, 1);
  assert.deepEqual({ done: flagged[0].done, advisory: flagged[0].advisory, line: flagged[0].line }, { done: false, advisory: true, line: legacyMergerLine });
  assert.match(flagged[0].line, /^Legacy: .*graphyard up --merger control-plane.*deploy key/);
  const otherwiseGreen = legacy.map(item => item.id === 'merger' ? item : { ...item, done: true });
  assert.equal(checklistGreen(otherwiseGreen), true, 'the legacy line holds no setup back');
  const current = setupChecklist(status('control-plane')).filter(item => item.id === 'merger');
  assert.deepEqual(current.map(item => [item.done, item.line]), [[true, 'The control plane merges each tested change itself.']]);
  assert.ok(!setupChecklist({ ...status('github'), setup: { protection: 'none', loop: true, supervision: 'supervised' } }).some(item => item.id === 'merger'), 'supervised mode merges on GitHub by design');
  assert.ok(!setupChecklist(null).some(item => item.id === 'merger'), 'an unanswered plane names no merger');
  assert.equal(setupChecklist(null, { merger: 'github' }).filter(item => item.id === 'merger').length, 1, 'up names its own merger');

  const root = await temporaryDirectory('merger-default-doctor');
  const input = (merger: 'github' | 'control-plane') => ({ root, env: {}, status: status(merger), environments: join(root, 'none'), sandbox: () => null, github: () => { throw new Error('gh: Branch not protected (HTTP 404)'); } });
  const github = (await setupFromZeroChecks(input('github'))).filter(check => check.id === 'merger').map(setupLine);
  assert.equal(github.length, 1);
  assert.match(github[0], /^FAIL merger: GitHub merges this installation's changes, the legacy mode; .*deploy key.* \(fix: run graphyard up --merger control-plane /);
  const control = (await setupFromZeroChecks(input('control-plane'))).filter(check => check.id === 'merger').map(setupLine);
  assert.deepEqual(control, ['PASS merger: The control plane merges each tested change itself.']);
});

