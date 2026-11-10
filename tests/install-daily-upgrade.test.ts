import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { graphyardRepository } from '../src/scenarios.js';
import { graphyardVerifiedRef } from '../src/release.js';
import { fetchVerifiedRef } from '../src/cli/upgrade.js';
import { controlPlaneRecordPath, controlPlaneStaleLines, controlPlaneSummary, controlPlaneRetryMs, deployOnce, deployRecordPath, readControlPlaneRecord, readDeployRecord, writeControlPlaneRecord, type ControlPlaneRecord, type DeployWatchPorts } from '../src/deploy-watch.js';
import { controlPlaneStep } from '../src/daemon/control-plane.js';
import { emptyDaemonState, daemonStatePath } from '../src/daemon/state.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { MasterConfig } from '../src/master.js';
import { gateRecordPath, readGateRecord } from '../src/batch-gate.js';
import { cycleUntil, git, pipelineWorld, rollout, worldLoop } from './helpers/pipeline-world.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3199: every install updates its own control plane — the Graphyard server, loop and CLI — to
// the latest batch-gate-verified commit at least daily, on the deploy watch's own pass. The unit
// cases prove the record, the failed upgrade's behaviour and what master status and the daily
// diagnostics read; the e2e case runs the real loop for Graphyard's own repository (the gate
// publishing refs/graphyard/verified) and a second install's watch upgrading to exactly that
// commit, never an unverified main tip.

const a = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', b = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', c = 'cccccccccccccccccccccccccccccccccccccccc';
const unverified = 'dddddddddddddddddddddddddddddddddddddddd';

/** The watch's ports over a record root, with the verified ref and health scripted. */
function ports(input: { head: string; verified: string | null; fetched?: string; onHealth?: (commit: string) => void }): DeployWatchPorts & { healthCalls: string[] } {
  const healthCalls: string[] = [];
  return {
    fetch: async () => input.fetched ?? unverified,
    verifiedUpstream: async () => input.verified,
    head: async () => input.head,
    build: async () => {}, restart: async () => {}, checkout: async () => {}, pin: async () => {}, prune: async () => {},
    health: async commit => { healthCalls.push(commit); input.onHealth?.(commit); },
    schema: async () => 7, database: async () => 7,
    healthCalls,
  };
}

/** The control-plane record's failedAt, moved back past the retry window so the next pass retries. */
async function ageFailedStep(root: string, hours: number) {
  const file = controlPlaneRecordPath(root), record = readControlPlaneRecord(file)!;
  await writeControlPlaneRecord(file, { ...record, failedAt: new Date(Date.now() - hours * 3_600_000).toISOString() });
}

test('unit:tests/install-daily-upgrade.test.ts — an install for another repository adopts exactly the latest verified commit, never an unverified main tip, and keeps its control-plane record beside the deploy record', async () => {
  const root = await temporaryDirectory('install-daily-upgrade-record');
  const outcome = await deployOnce(deployRecordPath(root), ports({ head: a, verified: b }), () => {}, graphyardRepository);
  assert.equal(outcome, 'deployed');
  assert.equal(readDeployRecord(deployRecordPath(root))?.tip, b, 'the verified commit is served');
  const control = readControlPlaneRecord(controlPlaneRecordPath(root));
  assert.ok(control, 'the watch writes .graphyard/control-plane.json');
  assert.deepEqual(
    { commit: control!.commit, verified: control!.verified, failedStep: control!.failedStep, checked: !!control!.checkedAt, updated: !!control!.updatedAt, seen: !!control!.verifiedSeenAt },
    { commit: b, verified: b, failedStep: null, checked: true, updated: true, seen: true },
    'the record names the commit it runs, the verified commit it saw, and its check and update clock');
  assert.notEqual(deployRecordPath(root), controlPlaneRecordPath(root), 'the control plane\'s state is its own record, never deploy.json');

  // With no verified ref published, nothing deploys — the fetched main tip is never a substitute.
  const quiet = await temporaryDirectory('install-daily-upgrade-none');
  assert.equal(await deployOnce(deployRecordPath(quiet), ports({ head: a, verified: null }), () => {}, graphyardRepository), 'unchanged');
  assert.notEqual(readDeployRecord(deployRecordPath(quiet))?.tip ?? null, unverified, 'an unverified main tip is never adopted');
  assert.ok(readControlPlaneRecord(controlPlaneRecordPath(quiet))?.checkedAt, 'the check itself is still recorded');

  // An install gating Graphyard itself keeps following its own gate's verified commit (GY-3119).
  const own = await temporaryDirectory('install-daily-upgrade-own');
  await mkdir(join(own, '.graphyard'), { recursive: true });
  await writeFile(join(own, '.graphyard', 'main-gate.json'), JSON.stringify({ repository: graphyardRepository, verified: c, verifiedAt: new Date().toISOString(), inFlight: null, attempt: { recuts: 0, timeouts: 0 }, held: null, lastOutcome: null, results: {}, merges: [], catalogMs: null, diagnosticsAt: null, at: new Date().toISOString() }));
  assert.equal(await deployOnce(deployRecordPath(own), ports({ head: a, verified: b, fetched: unverified }), () => {}, graphyardRepository), 'deployed');
  assert.equal(readDeployRecord(deployRecordPath(own))?.tip, c, 'the gate\'s verified commit wins over both the upstream ref and the fetched tip');
});

test('unit:tests/install-daily-upgrade.test.ts — a failed upgrade keeps the previous version, records the failed step in its own record, retries on a later pass, and clears the step once it passes', async () => {
  const root = await temporaryDirectory('install-daily-upgrade-failure');
  const failing = { failing: false };
  const watch = (verified: string, head: string) => ports({ head, verified, onHealth: commit => { if (failing.failing && commit === verified) throw new Error('/healthz reports the server unhealthy'); } });
  const record = () => readControlPlaneRecord(controlPlaneRecordPath(root))!;

  assert.equal(await deployOnce(deployRecordPath(root), watch(b, a), () => {}, graphyardRepository), 'deployed');
  const firstUpdate = record().updatedAt;
  failing.failing = true;
  assert.equal(await deployOnce(deployRecordPath(root), watch(c, b), () => {}, graphyardRepository), 'rolled-back');
  assert.equal(readDeployRecord(deployRecordPath(root))?.tip, b, 'the install keeps its previous Graphyard version');
  assert.deepEqual(
    { commit: record().commit, failedStep: record().failedStep, updatedAt: record().updatedAt, reason: record().failedReason?.includes('unhealthy') },
    { commit: b, failedStep: 'health', updatedAt: firstUpdate, reason: true },
    'the failed step and its reason are recorded, and the update clock stands still');

  // Within the retry window the pass leaves the failure alone; past it, the upgrade runs again.
  assert.equal((await deployOnce(deployRecordPath(root), watch(c, b), () => {}, graphyardRepository) as string), 'unchanged', 'a fresh failure is not retried at once');
  await ageFailedStep(root, 2);
  assert.equal(await deployOnce(deployRecordPath(root), watch(c, b), () => {}, graphyardRepository), 'rolled-back', 'the upgrade is retried on a later daily pass');
  assert.ok(record().failedAt && Date.now() - Date.parse(record().failedAt!) < controlPlaneRetryMs, 'the retry records its own failure time');

  await ageFailedStep(root, 2);
  failing.failing = false;
  assert.equal(await deployOnce(deployRecordPath(root), watch(c, b), () => {}, graphyardRepository), 'deployed');
  assert.deepEqual(
    { commit: record().commit, failedStep: record().failedStep, updated: record().updatedAt !== firstUpdate },
    { commit: c, failedStep: null, updated: true },
    'a passing upgrade moves the commit, clears the failed step and advances the update clock');
});

test('unit:tests/install-daily-upgrade.test.ts — the master loop of Graphyard\'s own install files one item naming the failed step, not one per retry', async () => {
  const root = await temporaryDirectory('install-daily-upgrade-filing');
  await writeControlPlaneRecord(controlPlaneRecordPath(root), { commit: b, verified: c, verifiedSeenAt: new Date().toISOString(), failedStep: 'health', failedReason: 'health failed: /healthz reports the server unhealthy', failedAt: new Date().toISOString() });
  const filed: { title: string; description: string; key: string }[] = [];
  const config = { url: 'http://127.0.0.1:5', repository: graphyardRepository, hostId: 'test-host' } as unknown as MasterConfig;
  const cycle = { config, state: emptyDaemonState(config), clock: Date.now(), log: () => {}, effects: { mergeWriter: { gate: { root }, createWork: async (input: { title: string; description: string }, key: string) => { filed.push({ ...input, key }); return { key: 'GY-999' }; } } } } as unknown as Parameters<typeof controlPlaneStep>[0];
  await controlPlaneStep(cycle);
  await controlPlaneStep(cycle); // the retry reads the same record and files nothing
  assert.equal(filed.length, 1, 'one item, however many passes fail at the same step of the same commit');
  assert.match(filed[0]!.title, /stuck at health/);
  assert.match(filed[0]!.description, /fails at health/, 'the item names the failed step');
  assert.match(filed[0]!.key, new RegExp(`control-plane-upgrade:${c}:health`), 'the filing is idempotent per verified commit and failed step');
});

test('unit:tests/install-daily-upgrade.test.ts — master status shows the control plane\'s commit, last check and last update, and the daily diagnostics reports a stale check and a commit over a day behind the latest verified one', async () => {
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const record = (over: Partial<ControlPlaneRecord>): ControlPlaneRecord => ({ commit: b, checkedAt: hoursAgo(1), updatedAt: hoursAgo(1), verified: b, verifiedSeenAt: hoursAgo(1), failedStep: null, failedReason: null, failedAt: null, at: hoursAgo(1), ...over });
  const now = Date.now();
  assert.deepEqual(controlPlaneStaleLines(null, now), [], 'no record reports nothing');
  assert.deepEqual(controlPlaneStaleLines(record({}), now), [], 'a current install passes the diagnostics silently');
  assert.deepEqual(controlPlaneStaleLines(record({ checkedAt: hoursAgo(25) }), now).length, 1, 'a check over 24 hours old is reported');
  assert.match(controlPlaneStaleLines(record({ checkedAt: hoursAgo(25) }), now)[0]!, /last check for a verified Graphyard commit is 25 hours old/);
  assert.deepEqual(controlPlaneStaleLines(record({ verified: c, verifiedSeenAt: hoursAgo(2) }), now), [], 'a verified commit first seen recently is not yet stale');
  assert.match(controlPlaneStaleLines(record({ verified: c, verifiedSeenAt: hoursAgo(26) }), now)[0]!, new RegExp(`still runs ${b.slice(0, 12)} while the verified commit ${c.slice(0, 12)} was first seen 26 hours ago`), 'the install\'s first sighting of the verified commit is the staleness clock');
  assert.deepEqual(controlPlaneStaleLines(record({ commit: c, verified: c, verifiedSeenAt: hoursAgo(26) }), now), [], 'an install running the verified commit is never stale, however long ago it first saw it');
  assert.equal(controlPlaneStaleLines(record({ checkedAt: hoursAgo(30), verified: c, verifiedSeenAt: hoursAgo(26) }), now).length, 2, 'both staleness rules report independently');

  const summary = controlPlaneSummary(record({ verified: c, verifiedSeenAt: hoursAgo(26), failedStep: 'health', failedReason: 'unhealthy' }), now);
  assert.deepEqual(
    { commit: summary!.commit, verified: summary!.verified, failedStep: summary!.failedStep, checkedAt: !!summary!.checkedAt, updatedAt: !!summary!.updatedAt, stale: summary!.stale.length },
    { commit: b.slice(0, 12), verified: c.slice(0, 12), failedStep: 'health', checkedAt: true, updatedAt: true, stale: 1 },
    'the summary master status embeds names the commit, the clocks and the staleness');

  // The status page itself reads the record from the install's root.
  const root = await temporaryDirectory('install-daily-upgrade-status');
  await writeControlPlaneRecord(controlPlaneRecordPath(root), record({ verified: c, verifiedSeenAt: hoursAgo(26) }));
  const config = { url: 'http://127.0.0.1:5', repository: 'owner/game', credentialFile: join(root, 'coordinator.token'), hostId: 'test-host', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 } } as unknown as MasterConfig;
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(daemonStatePath(config), JSON.stringify(emptyDaemonState(config)));
  const report = await masterStatusReport(root, config, async () => ({ work: [], now: new Date().toISOString() }), async () => `${b}\n`);
  assert.equal(report.controlPlaneUpdate?.commit, b.slice(0, 12), 'master status shows the control plane\'s Graphyard commit');
  assert.equal(report.controlPlaneUpdate?.verified, c.slice(0, 12), 'and the latest verified commit it has seen');
  assert.ok(report.controlPlaneUpdate?.checkedAt && report.controlPlaneUpdate.updatedAt, 'with its last check and last update times');
  assert.equal(report.controlPlaneUpdate?.stale.length, 1, 'and the diagnostics line for a commit over a day behind');
});

test('e2e:install-daily-upgrade — an install for another repository upgrades its control plane on its own to the gate-verified commit Graphyard publishes, never an unverified main tip, keeping its previous version through a failed upgrade and retrying', { timeout: 560_000 }, async () => {
  // Graphyard's own install: the world gates Graphyard itself, so its gate publishes the verified ref.
  const yard = await pipelineWorld('install-daily-upgrade', {}, graphyardRepository);
  // The install for another repository: its own records root, and a CLI checkout cloned from Graphyard's origin.
  const install = await temporaryDirectory('install-daily-upgrade-install');
  const root = join(install, 'game'), cli = join(install, 'graphyard-cli');
  await mkdir(root, { recursive: true });
  execFileSync('git', ['clone', '-q', yard.origin, cli], { stdio: 'ignore' });
  git(cli, 'checkout', '-q', '--detach', yard.base);
  const built: string[] = [];
  const health = { failing: false };
  const watch = (): DeployWatchPorts => ({
    fetch: async () => { git(cli, 'fetch', '-q', 'origin', 'main'); return git(cli, 'rev-parse', 'refs/remotes/origin/main'); },
    verifiedUpstream: () => fetchVerifiedRef(async (...args: string[]) => git(cli, ...args), yard.origin),
    head: async () => git(cli, 'rev-parse', 'HEAD'),
    contains: async (ancestor, commit) => { try { git(cli, 'merge-base', '--is-ancestor', ancestor, commit); return true; } catch { return false; } },
    build: async commit => { built.push(commit); },
    restart: async () => {}, checkout: async () => {}, pin: async () => {}, prune: async () => {},
    health: async commit => { if (health.failing && commit === verifiedRef()) throw new Error('/healthz reports the server unhealthy'); },
    schema: async () => 7, database: async () => 7,
  });
  const pass = () => deployOnce(deployRecordPath(root), watch(), () => {}, graphyardRepository);
  const control = () => readControlPlaneRecord(controlPlaneRecordPath(root));
  const verifiedRef = () => git(yard.origin, 'rev-parse', '--verify', graphyardVerifiedRef);
  try {
    await rollout(yard);
    const loop = worldLoop(yard, { gate: true });

    // The gate verifies a merged tip and publishes it; a later main tip the gate has not verified never moves the ref.
    const first = await yard.submit('A verified change', { 'site/index.html': '<!doctype html><title>verified</title>\n' });
    await cycleUntil(loop, `${first.key} lands`, async () => (await yard.work()).find(item => item.id === first.id)?.stage === 'done');
    await cycleUntil(loop, 'the gate verifies it', () => readGateRecord(gateRecordPath(yard.checkout))?.verified === yard.main());
    const verified = yard.main();
    assert.notEqual(verified, yard.base, 'the verified commit is the landed merge, not the rollout base');
    assert.equal(verifiedRef(), verified, 'the batch gate publishes its verified commit at refs/graphyard/verified');
    loop.gating(false);
    const second = await yard.submit('An unverified main tip', { 'site/index.html': '<!doctype html><title>unverified</title>\n' });
    await cycleUntil(loop, `${second.key} lands unverified`, async () => (await yard.work()).find(item => item.id === second.id)?.stage === 'done');
    assert.notEqual(yard.main(), verified);
    assert.equal(verifiedRef(), verified, 'a main tip the gate has not verified never moves the ref');

    // The other install's own pass upgrades it to exactly the verified commit.
    assert.equal(await pass(), 'deployed');
    assert.equal(readDeployRecord(deployRecordPath(root))?.tip, verified, 'the install serves the verified commit');
    assert.equal(git(cli, 'rev-parse', 'refs/remotes/origin/main'), yard.main(), 'the pass did fetch the newer unverified main tip');
    assert.deepEqual(built, [verified], 'and built exactly the verified commit, never the unverified tip');
    assert.deepEqual({ commit: control()?.commit, verified: control()?.verified, failedStep: control()?.failedStep, updated: !!control()?.updatedAt, checked: !!control()?.checkedAt },
      { commit: verified, verified: verified, failedStep: null, updated: true, checked: true }, 'its control-plane record names the commit it now runs');

    // A failed upgrade to the next verified commit keeps the previous version, records the step, and retries.
    const third = await yard.submit('A second verified change', { 'site/index.html': '<!doctype html><title>verified again</title>\n' });
    loop.gating(true);
    await cycleUntil(loop, `${third.key} lands and the gate verifies it`, () => readGateRecord(gateRecordPath(yard.checkout))?.verified === yard.main());
    const verified2 = yard.main();
    assert.equal(verifiedRef(), verified2);
    health.failing = true;
    assert.equal(await pass(), 'rolled-back');
    assert.equal(readDeployRecord(deployRecordPath(root))?.tip, verified, 'a failing upgrade keeps the previous version serving');
    assert.equal(control()?.commit, verified);
    assert.equal(control()?.failedStep, 'health', 'the failed step is recorded');
    assert.equal(await pass(), 'unchanged', 'a fresh failure is not retried at once');
    await ageFailedStep(root, 2);
    assert.equal(await pass(), 'rolled-back', 'a later pass retries the failed upgrade');
    assert.equal(built.filter(commit => commit === verified2).length, 2, 'the retry ran the upgrade steps again');
    await ageFailedStep(root, 2);
    health.failing = false;
    assert.equal(await pass(), 'deployed');
    assert.deepEqual({ commit: control()?.commit, failedStep: control()?.failedStep },
      { commit: verified2, failedStep: null }, 'a passing retry moves the install and clears the failed step');
  } finally { await yard.close(); }
});
