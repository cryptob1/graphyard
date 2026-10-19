import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';
import { emptyDaemonState, type DaemonState } from '../src/master-daemon.js';
import { performSelfUpgrade, type DeployPorts, type SelfUpgradeDeps } from '../src/daemon/upgrade.js';

/** The new exports, imported in each test so a reverted source fails the case, not the file (graphyard verify's exercise). */
const upgrade = () => import('../src/daemon/upgrade.js') as Promise<Record<string, any>>;
const cliUpgrade = () => import('../src/cli/upgrade.js') as Promise<Record<string, any>>;
import { coordinatorCheckoutGuard } from '../src/daemon/run.js';
import { checkoutRelease } from '../src/release.js';
import { installIdFor } from '../src/install/types.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1982: the loop deploys each new base tip between cycles through fake deploy, health and
 * end-to-end ports, records it on the cursor's release reading and restarts onto it; a failed tip
 * is rolled back to the recorded release, unless it migrated the database.
 */

const full = (prefix: string) => prefix.padEnd(40, '0');
const released = full('a1a1a1a1a1a1'), tip = full('b2b2b2b2b2b2'), next = full('c3c3c3c3c3c3');
const start = Date.parse('2026-10-18T12:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();

const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/nonexistent/coordinator.token', cliPath: '/nonexistent/bin/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });

/** A clean, detached coordinator checkout at `head`; a fetch finds `originTip`; every ancestry read answers "not contained". */
class FakeGit {
  checkouts: string[] = [];
  diff = 'src/daemon/run.ts\n';
  constructor(public head: string, public originTip: string) {}
  run = async (command: string, args: string[]): Promise<string> => {
    assert.equal(command, 'git');
    const [op, ...operands] = args.slice(2);
    if (op === 'rev-parse') return `${operands[0] === 'HEAD' ? this.head : this.originTip}\n`;
    if (op === 'symbolic-ref') throw Object.assign(new Error('fatal: not a symbolic ref'), { status: 1 });
    if (op === 'status') return '';
    if (op === 'fetch') return '';
    if (op === 'diff') return this.diff;
    if (op === 'checkout') { this.head = operands[2]; this.checkouts.push(operands[2]); return ''; }
    if (op === 'merge-base') throw Object.assign(new Error('not an ancestor'), { status: 1 });
    throw new Error(`fake git cannot answer: git ${args.slice(2).join(' ')}`);
  };
}

/** Fake ports: every call is recorded as `step:commit-prefix`; `fails` names the step that throws for a commit; `holds` keeps the deploy step itself in flight, before anything is recorded, until it is released. */
function fakePorts(options: { fails?: Record<string, string>; schemas?: { target: number | null; database: number | null }; holds?: Promise<void> } = {}) {
  const calls: string[] = [], pins: string[] = [];
  const step = (name: 'deploy' | 'health' | 'e2e') => async (commit: string) => {
    if (options.holds && name === 'deploy') await options.holds;
    calls.push(`${name}:${commit.slice(0, 12)}`);
    if (options.fails?.[commit] === name) throw new Error(`${name} refused ${commit.slice(0, 12)}`);
  };
  const ports: DeployPorts = { deploy: step('deploy'), health: step('health'), e2e: step('e2e'),
    schemas: async () => options.schemas ?? { target: 7, database: 7 }, pin: async commit => { pins.push(commit); } };
  return { ports, calls, pins };
}

/** GY-2344: the deploy started off the pass settles in the background; the cursor shows it when it does. */
async function settled(until: () => boolean) {
  for (let waited = 0; waited < 5_000 && !until(); waited += 5) await sleep(5);
  assert.ok(until(), 'the off-cycle deploy never settled');
}

function deps(fake: FakeGit, clock: { now: number }, ports: DeployPorts, fleet: { self: number }): SelfUpgradeDeps {
  return { root: '/coordinator', run: fake.run, now: () => clock.now, deploy: async () => ports,
    restartSelf: async () => { fleet.self += 1; } };
}

function releasedState(promotionReading: (...args: any[]) => any): DaemonState {
  const state = emptyDaemonState(master);
  state.release = { commit: released, dirty: false };
  state.deployment = null;
  state.promotion = promotionReading(null, iso(start - 60_000), { mainSha: released, promotedSha: released, promotedAt: iso(start - 60_000) });
  return state;
}

test('unit:continuous-deploy-advances-release — a base tip that differs from the recorded release is deployed off the cycle while the loop keeps cycling, no second deploy starts meanwhile, the settled reading names it, and the pass after the settle restarts onto it', async t => {
  const { deployKey, deployLine, promotionReading } = await upgrade();
  const state = releasedState(promotionReading), fake = new FakeGit(released, tip), clock = { now: start };
  let holdE2e = () => {};
  const held = new Promise<void>(resolve => { holdE2e = resolve; });
  t.after(async () => { holdE2e(); await sleep(20); });
  const { ports, calls, pins } = fakePorts({ holds: held }), fleet = { self: 0 };
  const guard = coordinatorCheckoutGuard({
    state: () => state, read: async () => ({ root: '/coordinator', commit: fake.head, modified: [], untracked: [] }),
    agents: async () => [], snapshot: async () => ({ work: [] as Work[], now: iso(clock.now) }), persist: async () => {}, now: () => clock.now, log: () => {}, applies: () => true,
  });
  assert.equal(await guard.start(released), null);
  const upgradePass = () => guard.betweenCycles(current => performSelfUpgrade(master, current, deps(fake, clock, ports, fleet)));

  // The pass starts the deploy off the cycle and returns at once: the settled reading still names the old release, and nothing has run yet.
  const first = await upgradePass();
  assert.equal(first.refusal, null);
  assert.equal(first.upgraded?.outcome, 'skipped');
  assert.match(first.upgraded?.outcome === 'skipped' ? first.upgraded.reason : '', /deploying base tip/);
  assert.equal(state.promotion?.promotedSha, released, 'the pass returned before the deploy settled');
  assert.deepEqual(calls, [], 'the sequence runs off the pass');
  // Cycles pass while the deploy is still in flight: no second deploy starts.
  clock.now += 60_000;
  const mid = await upgradePass();
  assert.equal(mid.refusal, null, 'the deploy holding the checkout is never the guard\'s drift');
  assert.equal(mid.upgraded?.outcome, 'skipped');
  assert.match(mid.upgraded?.outcome === 'skipped' ? mid.upgraded.reason : '', /starts no second deploy/);
  assert.deepEqual(calls, [], 'the running deploy is not started again');
  assert.equal(state.promotion?.promotedSha, released, 'the settled reading stands until the deploy ends');
  // The deploy ends: the settle records the release reading and its action.
  holdE2e();
  await settled(() => state.promotion?.promotedSha === tip);
  assert.deepEqual(calls, [`deploy:${tip.slice(0, 12)}`, `health:${tip.slice(0, 12)}`, `e2e:${tip.slice(0, 12)}`], 'the tip ran the upgrade sequence, then health, then end to end');
  assert.equal(state.promotion?.mainSha, tip);
  assert.equal(state.promotion?.promotedAt, iso(start + 60_000), 'stamped with the clock as it stood when the settle landed');
  assert.equal(state.promotion?.deployFailed, null);
  assert.equal(deployLine(state.promotion?.deployFailed), null);
  assert.deepEqual(pins, [tip], 'the deployed tip is pinned known good');
  assert.equal(state.actions[deployKey]?.state, 'done');
  // The pass after the settle finds the checkout at the served tip and restarts onto it.
  clock.now += 60_000;
  const third = await upgradePass();
  assert.equal(third.upgraded?.outcome, 'upgraded');
  assert.equal(fleet.self, 1, 'the loop requests its own restart onto it');
  assert.equal(guard.expected(), tip, 'the loop\'s own deploy is never drift');

  // The process the supervisor starts runs the tip: the next pass deploys nothing.
  state.release = { commit: tip, dirty: false };
  calls.length = 0;
  clock.now += 60_000;
  const settledPass = await upgradePass();
  assert.equal(settledPass.upgraded?.outcome, 'up-to-date');
  assert.deepEqual(calls, [], 'the recorded release is not deployed again');

  // A tip touching no loaded code is deployed and restarted onto all the same.
  fake.originTip = next; fake.diff = 'docs/delivery.md\n';
  clock.now += 60_000;
  assert.equal((await upgradePass()).upgraded?.outcome, 'skipped', 'the docs-only tip\'s deploy starts off the cycle');
  await settled(() => state.promotion?.promotedSha === next);
  clock.now += 60_000;
  assert.equal((await upgradePass()).upgraded?.outcome, 'upgraded');
  assert.equal(fleet.self, 2, 'a docs-only deploy still restarts the loop onto it');
});

test('unit:continuous-deploy-rolls-back — a tip failing health or end to end is rolled back to the recorded release through the same sequence once the off-cycle deploy settles, recorded with its step and reason in one status line, and attempted at most twice until the base tip moves', async () => {
  const { deployKey, deployLine, promotionReading } = await upgrade();
  const state = releasedState(promotionReading), fake = new FakeGit(released, tip), clock = { now: start };
  const fails: Record<string, string> = { [tip]: 'health' };
  const { ports, calls } = fakePorts({ fails }), fleet = { self: 0 };
  const guard = coordinatorCheckoutGuard({
    state: () => state, read: async () => ({ root: '/coordinator', commit: fake.head, modified: [], untracked: [] }),
    agents: async () => [], snapshot: async () => ({ work: [] as Work[], now: iso(clock.now) }), persist: async () => {}, now: () => clock.now, log: () => {}, applies: () => true,
  });
  assert.equal(await guard.start(released), null);
  const upgradePass = () => guard.betweenCycles(current => performSelfUpgrade(master, current, deps(fake, clock, ports, fleet)));

  // The first attempt starts off the cycle and fails health; the settle rolls the release back.
  const first = await upgradePass();
  assert.equal(first.upgraded?.outcome, 'skipped');
  await settled(() => !!state.promotion?.deployFailed);
  assert.deepEqual(calls, [`deploy:${tip.slice(0, 12)}`, `health:${tip.slice(0, 12)}`, `deploy:${released.slice(0, 12)}`, `health:${released.slice(0, 12)}`],
    'the recorded release is redeployed through the same sequence');
  assert.equal(fake.head, released, 'the checkout is back on the recorded release');
  assert.equal(state.promotion?.promotedSha, released, 'the release reading still names the recorded release');
  assert.deepEqual({ ...state.promotion?.deployFailed, at: undefined }, { sha: tip, step: 'health', reason: `health refused ${tip.slice(0, 12)}`, rolledBackTo: released, kept: false, attempts: 1, at: undefined });
  const line = `deploy of ${tip.slice(0, 12)} failed at health: health refused ${tip.slice(0, 12)}; rolled back to ${released.slice(0, 12)}`;
  assert.equal(deployLine(state.promotion?.deployFailed), line, 'master status shows one line naming both commits');
  assert.equal(state.actions[deployKey]?.state, 'failed');
  assert.equal(state.actions[deployKey]?.detail, line);
  assert.equal(fleet.self, 0, 'nothing restarts onto the failed tip');

  // The second attempt fails end to end this time; the third pass deploys nothing.
  fails[tip] = 'e2e';
  calls.length = 0;
  clock.now += 60_000;
  assert.equal((await upgradePass()).upgraded?.outcome, 'skipped', 'the second attempt starts off the cycle');
  await settled(() => state.promotion?.deployFailed?.attempts === 2);
  assert.deepEqual(calls.slice(0, 3), [`deploy:${tip.slice(0, 12)}`, `health:${tip.slice(0, 12)}`, `e2e:${tip.slice(0, 12)}`]);
  assert.deepEqual(calls.slice(3), [`deploy:${released.slice(0, 12)}`, `health:${released.slice(0, 12)}`], 'an end-to-end failure rolls back as well');
  assert.equal(state.promotion?.deployFailed?.step, 'e2e');
  assert.equal(state.promotion?.deployFailed?.attempts, 2);
  assert.equal(deployLine(state.promotion?.deployFailed), `deploy of ${tip.slice(0, 12)} failed at e2e: e2e refused ${tip.slice(0, 12)}; rolled back to ${released.slice(0, 12)}`,
    'the end-to-end failure reads as rolled back, never as not rolled back');
  calls.length = 0;
  clock.now += 60_000;
  const third = await upgradePass();
  assert.equal(third.upgraded?.outcome, 'skipped');
  assert.match(third.upgraded?.outcome === 'skipped' ? third.upgraded.reason : '', /its end-to-end run already failed and deploying the same commit again changes nothing, so it waits for the base branch to move/,
    'GY-2518: the second failure was the end-to-end step, so the tip is spent on it, not on the attempt count');
  assert.deepEqual(calls, [], 'a tip that failed twice is not attempted again');
  assert.equal(fake.head, released);

  // The base tip moves: the new tip is deployed.
  fake.originTip = next;
  clock.now += 60_000;
  assert.equal((await upgradePass()).upgraded?.outcome, 'skipped', 'the new tip\'s deploy starts off the cycle');
  await settled(() => state.promotion?.promotedSha === next);
  assert.deepEqual(calls, [`deploy:${next.slice(0, 12)}`, `health:${next.slice(0, 12)}`, `e2e:${next.slice(0, 12)}`]);
  clock.now += 60_000;
  assert.equal((await upgradePass()).upgraded?.outcome, 'upgraded', 'the loop restarts onto the deployed tip');
  assert.equal(state.promotion?.promotedSha, next);
  assert.equal(deployLine(state.promotion?.deployFailed), null, 'a deploy that passes clears the failure line');
});

test('unit:continuous-deploy-no-rollback-across-migration — a failed tip that migrated the database is kept once its off-cycle deploy settles, its line says why, and the pass after the settle restarts onto the kept release with no served-release observation holding it', async () => {
  const { deployKey, deployLine, promotionReading } = await upgrade();
  const state = releasedState(promotionReading), fake = new FakeGit(released, tip), clock = { now: start };
  // Production is observed serving the recorded release, which does not contain the tip: the
  // release-lagged hold (GY-1585) would have held the restart onto it.
  state.deployment = { source: 'github', sha: released, at: iso(start), reason: null, deployed: ['GY-1'], pending: ['GY-2'] } as unknown as DaemonState['deployment'];
  const { ports, calls } = fakePorts({ fails: { [tip]: 'health' }, schemas: { target: 8, database: 7 } }), fleet = { self: 0 };
  const upgradePass = () => performSelfUpgrade(master, state, deps(fake, clock, ports, fleet));

  assert.equal((await upgradePass()).outcome, 'skipped', 'the deploy starts off the cycle');
  await settled(() => !!state.promotion?.deployFailed);
  assert.deepEqual(calls, [`deploy:${tip.slice(0, 12)}`, `health:${tip.slice(0, 12)}`], 'the older release is never redeployed onto the migrated database');
  assert.equal(state.promotion?.deployFailed?.kept, true);
  assert.equal(state.promotion?.deployFailed?.rolledBackTo, null);
  assert.equal(state.promotion?.promotedSha, tip, 'the loop keeps the new release');
  assert.equal(deployLine(state.promotion?.deployFailed), `deploy of ${tip.slice(0, 12)} failed at health: health refused ${tip.slice(0, 12)}; the release was kept because the database was migrated`);
  clock.now += 60_000;
  const outcome = await upgradePass();
  assert.equal(outcome.outcome, 'upgraded', 'the restart onto the kept release goes ahead once it settles');
  assert.equal(fleet.self, 1);
  assert.notEqual(state.upgrade.stalled?.cause, 'release-lagged', 'no restart is held for a served-release observation');
  assert.equal(state.actions['upgrade:held'], undefined);
});

/** A real Git checkout whose HEAD stands detached at `commit`: the tree a deploy builds from. */
async function checkoutAt(label: string): Promise<{ root: string; commit: string }> {
  const root = await temporaryDirectory(label);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=gate', '-c', 'user.email=gate@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('commit', '--quiet', '--allow-empty', '-m', 'previous');
  const previous = git('rev-parse', 'HEAD');
  git('commit', '--quiet', '--allow-empty', '-m', 'deployed');
  const commit = git('rev-parse', 'HEAD');
  git('checkout', '--quiet', '--detach', previous);
  git('checkout', '--quiet', '--detach', commit);
  return { root, commit };
}

test('unit:continuous-deploy-builds-target-commit — the continuous deploy\u2019s redeploy builds the image from the deployed commit\u2019s tree and stamps it with that commit, so /healthz?strict reports the deployed commit after the step, whatever commit the loop\u2019s own code root holds', async () => {
  const { deployPorts } = await cliUpgrade();
  const { root: cliRoot, commit: deployed } = await checkoutAt('continuous-deploy-builds');
  const repoRoot = await temporaryDirectory('continuous-deploy-repo');
  const record = { version: 1, installId: 'continuous-deploy-fixture', repository: 'continuous-deploy/fixture', provider: 'compose', baseBranch: 'main',
    deployment: { sshHost: null, sshUser: 'root', local: false, port: 4311, image: 'graphyard-local:continuous-deploy-fixture' },
    principals: [], createdAt: 'fixture', updatedAt: 'fixture' };
  const configHome = await temporaryDirectory('continuous-deploy-config');
  await mkdir(join(configHome, installIdFor('continuous-deploy/fixture')), { recursive: true });
  await writeFile(join(configHome, installIdFor('continuous-deploy/fixture'), 'install.json'), JSON.stringify(record), { mode: 0o600 });
  const withoutConfigHome = process.env.GRAPHYARD_CONFIG_HOME;
  process.env.GRAPHYARD_CONFIG_HOME = configHome;
  try {
    // The loop's own code root holds another commit (a held snapshot the launcher redirects to):
    // the redeploy the deploy runs must not depend on it, only on the checkout deployTip moved.
    const withoutCheckoutRoot = process.env.GRAPHYARD_CHECKOUT_ROOT;
    process.env.GRAPHYARD_CHECKOUT_ROOT = (await checkoutAt('continuous-deploy-loop')).root;
    try {
      const calls: { command: string; args: string[]; cwd: string | undefined }[] = [];
      const run = async (command: string, args: string[], options?: { cwd?: string }) => { calls.push({ command, args, cwd: options?.cwd }); return ''; };
      const ports = await deployPorts({ cliRoot, repoRoot, repository: 'continuous-deploy/fixture', url: 'http://127.0.0.1:4311', run });
      assert.ok(typeof ports === 'object', `deployPorts refused: ${ports}`);
      await ports.deploy(deployed);
      // One sh per step: npm ci installs the deployed tree's dependencies in the checkout the
      // deploy moved; the redeploy runs the checked-out CLI from the repository root, its preview
      // and apply halves both naming that checkout as the build source.
      const install = `node "${join(cliRoot, 'bin/graphyard.mjs')}" install --repo continuous-deploy/fixture --provider compose --base-branch main --port 4311 --review-policy github --observe-only --image graphyard-local:continuous-deploy-fixture`;
      assert.deepEqual(calls.map(call => call.command), ['sh', 'sh']);
      assert.deepEqual(calls.map(call => call.cwd), [cliRoot, repoRoot]);
      assert.equal(calls[0].args[1], `npm ci --prefix "${cliRoot}"`);
      assert.equal(calls[1].args[1], `${install} --source-root ${cliRoot} --plan && ${install} --source-root ${cliRoot} --apply`);
      // The build source is the deployed commit's tree, so the image stamps that commit and
      // /healthz?strict reports it after the step.
      assert.equal(execFileSync('git', ['-C', cliRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), deployed);
      assert.equal(checkoutRelease(cliRoot).version, `unreleased ${deployed.slice(0, 12)}`);
    } finally { if (withoutCheckoutRoot === undefined) delete process.env.GRAPHYARD_CHECKOUT_ROOT; else process.env.GRAPHYARD_CHECKOUT_ROOT = withoutCheckoutRoot; }
  } finally { if (withoutConfigHome === undefined) delete process.env.GRAPHYARD_CONFIG_HOME; else process.env.GRAPHYARD_CONFIG_HOME = withoutConfigHome; }
});

/** A compose install record under a temp config home, the install `deployPorts` reads its identity and image from. */
async function composeInstall(config: string) {
  const directory = join(config, 'owner-repo');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'install.json'), JSON.stringify({ version: 1, installId: 'owner-repo', repository: 'owner/repo', provider: 'compose', baseBranch: 'main', createdAt: iso(start), updatedAt: iso(start) }));
  return directory;
}

test('unit:continuous-deploy-e2e-principal — the installer issues an e2e identity that may create items, and the deploy\u2019s end-to-end step authenticates with its credential, so a case\u2019s create step answers 200, not 403', async () => {
  const { plannedPrincipals, e2ePrincipalId } = await import('../src/install/secrets.js') as Record<string, any>;
  const { deployPorts } = await import('../src/cli/upgrade.js') as Record<string, any>;
  const e2ePrincipal = plannedPrincipals('demo').find((principal: any) => principal.id === e2ePrincipalId('demo'));
  assert.deepEqual(e2ePrincipal, { id: 'demo-e2e', role: 'admin', sessionKind: 'ai' },
    'the roster carries an e2e identity, an admin \u2014 the roster role whose principal the create path admits \u2014 issued by the installer as the other loop identities are');

  const config = await temporaryDirectory('deploy-e2e-config'), checkout = await temporaryDirectory('deploy-e2e-checkout');
  const directory = await composeInstall(config);
  const e2eToken = 'e2e'.padEnd(40, '0'), loopToken = 'loop'.padEnd(40, '0');
  await mkdir(join(directory, 'tokens'), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'tokens', 'owner-repo-e2e.token'), `${e2eToken}\n`, { mode: 0o600 });
  await writeFile(join(directory, 'tokens', 'owner-repo-master.token'), `${loopToken}\n`, { mode: 0o600 });
  // The real create-work-item case, in a checkout of its own: its first step is the create the loop credential failed with 403.
  await mkdir(join(checkout, 'e2e', 'cases'), { recursive: true });
  await writeFile(join(checkout, 'e2e', 'cases', 'create-work-item.json'), await readFile(fileURLToPath(new URL('../e2e/cases/create-work-item.json', import.meta.url)), 'utf8'));

  const seen: { path: string; method: string; authorization: string | null }[] = [];
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
    seen.push({ path, method: init?.method ?? 'GET', authorization: init?.headers ? new Headers(init.headers).get('authorization') : null });
    if (path === '/healthz') return Response.json({ ok: true, healthy: true });
    if (path === '/api/merger') return Response.json({ mode: 'control-plane' });
    if (path === '/api/work' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return Response.json({ id: 'work-1', key: 'GY-1', stage: 'backlog', title: body.title });
    }
    if (path === '/api/work') return Response.json([{ id: 'work-1', key: 'GY-1' }]);
    return Response.json({});
  }) as typeof fetch;
  const savedHome = process.env.GRAPHYARD_CONFIG_HOME, savedFetch = global.fetch;
  process.env.GRAPHYARD_CONFIG_HOME = config;
  global.fetch = mockFetch;
  try {
    const ports = await deployPorts({ cliRoot: checkout, repoRoot: join(checkout, 'repo'), repository: 'owner/repo', url: 'http://127.0.0.1:4311', run: async () => '' });
    assert.equal(typeof ports, 'object', 'a compose install has deploy ports');
    await (ports as any).e2e(); // a failing case would throw: the create answered 200 and held its expects
    const create = seen.find(entry => entry.path === '/api/work' && entry.method === 'POST');
    assert.ok(create, 'the case\u2019s create-an-item step ran');
    assert.equal(create!.authorization, `Bearer ${e2eToken}`, 'the end-to-end step authenticates as the install\u2019s e2e principal');
    assert.ok(seen.every(entry => entry.authorization !== `Bearer ${loopToken}`), 'the loop\u2019s own coordinator credential authenticates nothing');
  } finally {
    if (savedHome === undefined) delete process.env.GRAPHYARD_CONFIG_HOME; else process.env.GRAPHYARD_CONFIG_HOME = savedHome;
    global.fetch = savedFetch;
  }
});

test('unit:continuous-deploy-rollback-stamped \u2014 every redeploy builds with the stamp of the commit it deploys, so a failed deploy rolls back to a release /healthz can name', async () => {
  const { imageBuildArgs } = await import('../src/install/adapters.js') as Record<string, any>;
  const { deployPorts } = await import('../src/cli/upgrade.js') as Record<string, any>;
  const commit = 'c0d33bc39201'.padEnd(40, '0');
  const savedVersion = process.env.GRAPHYARD_VERSION, savedRevision = process.env.GRAPHYARD_BUILD_REVISION, savedDatabase = process.env.DATABASE_URL;
  try {
    delete process.env.GRAPHYARD_VERSION; delete process.env.GRAPHYARD_BUILD_REVISION; delete process.env.DATABASE_URL;
    assert.deepEqual(imageBuildArgs('/somewhere', () => true), [], 'a dirty tree with no vouched stamp builds unnamed, as GY-1977 left it');
    process.env.GRAPHYARD_VERSION = `unreleased ${commit.slice(0, 12)}`;
    process.env.GRAPHYARD_BUILD_REVISION = commit;
    assert.deepEqual(imageBuildArgs('/somewhere', () => true),
      ['--build-arg', `GRAPHYARD_VERSION=unreleased ${commit.slice(0, 12)}`, '--build-arg', `GRAPHYARD_BUILD_REVISION=${commit}`],
      'the deploy\u2019s vouched stamp is the build args verbatim, whatever the tree holds, so /healthz reports the deployed commit');

    const config = await temporaryDirectory('deploy-stamp-config'), checkout = await temporaryDirectory('deploy-stamp-checkout');
    await composeInstall(config);
    const calls: { args: string[]; options: any }[] = [];
    const savedHome = process.env.GRAPHYARD_CONFIG_HOME;
    process.env.GRAPHYARD_CONFIG_HOME = config;
    try {
      const ports = await deployPorts({ cliRoot: checkout, repoRoot: join(checkout, 'repo'), repository: 'owner/repo', url: 'http://127.0.0.1:4311',
        run: ((command: string, args: string[], options: any) => { calls.push({ args, options }); return ''; }) as any });
      await (ports as any).deploy(commit);
      const redeploy = calls.find(entry => entry.args[0] === '-c' && entry.args[1].includes('install --repo'));
      assert.ok(redeploy, 'the redeploy ran through the install adapter');
      assert.equal(redeploy!.options.env.GRAPHYARD_BUILD_REVISION, commit, 'the redeploy\u2019s child builds with the deployed commit as its revision');
      assert.equal(redeploy!.options.env.GRAPHYARD_VERSION, `unreleased ${commit.slice(0, 12)}`, 'and with the deployed commit as its release');
    } finally {
      if (savedHome === undefined) delete process.env.GRAPHYARD_CONFIG_HOME; else process.env.GRAPHYARD_CONFIG_HOME = savedHome;
    }
  } finally {
    if (savedVersion === undefined) delete process.env.GRAPHYARD_VERSION; else process.env.GRAPHYARD_VERSION = savedVersion;
    if (savedRevision === undefined) delete process.env.GRAPHYARD_BUILD_REVISION; else process.env.GRAPHYARD_BUILD_REVISION = savedRevision;
    if (savedDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedDatabase;
  }
});
