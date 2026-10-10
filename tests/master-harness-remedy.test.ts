import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema, masterHarness, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, type DaemonEffects } from '../src/master-daemon.js';
import { emptyHeldDecisions } from '../src/daemon/decision-reads.js';
import { Launcher, type Cycle } from '../src/daemon/cycle.js';
import { Timings } from '../src/master/timings.js';
// A namespace import: a run without this change's remedy still loads the file, and its cases fail instead of the import.
import * as doctor from '../src/daemon/doctor.js';
import { routineRemedies, type DoctorEffects } from '../src/daemon/doctor.js';
import { harnessDrift, writeHarnessPermissions } from '../src/harness.js';
import { masterHarnessDrift } from '../src/cli/master/fleet.js';
import { installUnitsFile, legacyLoopUnit, perInstallUnits } from '../src/install/units.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1652: harness drift healed only from the vantage that read it, and the one recurring automated
// reader — the doctor, whose checkout GY-888 binds read-only — always met EROFS. The loop now
// applies the contract itself each cycle, and a read-only reader names its vantage instead of
// reporting the doomed in-place apply.

const launcher = resolve(fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)));
const observedAt = '2026-10-10T14:00:00.000Z';
const config = (credentialFile: string, cliPath = launcher): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
const settingsFile = (root: string) => join(root, '.claude/settings.local.json');
const asRoot = process.getuid?.() === 0; // root ignores directory modes, so a chmod cannot make the checkout read-only

/**
 * A checkout the loop manages — its `.graphyard/master.json` records the loop's launcher in it, and
 * it records its units — whose installed settings carry the plan minus one generated deny, plus the
 * operator's own entries.
 */
async function checkout() {
  const root = await temporaryDirectory('harness-remedy');
  execFileSync('git', ['init', '-q', root]);
  const master = config(join(root, '.graphyard-credentials/master/token'), join(root, 'bin/graphyard.mjs'));
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(join(root, '.graphyard/master.json'), JSON.stringify(master));
  await writeFile(join(root, installUnitsFile), JSON.stringify(perInstallUnits(master.repository)));
  const plan = masterHarness(root, master, 'claude');
  const absent = plan.deny.at(-1)!.rule;
  const installed = { permissions: { allow: [...plan.allow.map(entry => entry.rule), 'Bash(npm test)'], deny: [...plan.deny.map(entry => entry.rule).filter(rule => rule !== absent), 'Bash(rm -rf /)'] }, model: 'opus' };
  await mkdir(join(root, '.claude'), { recursive: true });
  await writeFile(settingsFile(root), JSON.stringify(installed));
  await writeFile(join(root, '.gitignore'), '.claude/settings.local.json\n');
  return { root, master, plan, absent, installed, cleanup: async () => { await chmod(join(root, '.claude'), 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }); } };
}

/**
 * One loop cycle over no work; `wired` picks the effects it carries (every loop carries research, which
 * the real loop points at its research scratch; the doctor only with an operator-agent identity), and
 * `research` the checkout research names, `root` unless given.
 */
function cycle(root: string, master: MasterConfig, wired: { research?: boolean; doctor?: boolean } = { research: true, doctor: true }, research = root): Cycle {
  const clock = Date.parse(observedAt);
  const effects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [], now: observedAt }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: observedAt, reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    ...(wired.research ? { research: { cwd: research } } : {}),
    ...(wired.doctor ? { doctor: { cwd: root } as DoctorEffects } : {}),
  } as unknown as DaemonEffects;
  return {
    config: master, state: emptyDaemonState(master), effects, now: () => clock, snapshot: { work: [], now: observedAt }, clock, clockOffset: { min: 0, max: 0 },
    performed: [], agents: [], credentials: {}, open: [], owns: () => false, heldBy: () => null, timings: new Timings(() => clock),
    launcher: new Launcher(Number.POSITIVE_INFINITY), launch: () => false, detached: false, heldDecisions: emptyHeldDecisions(), closedPanes: new Set(),
    isolate: async (_kind, _item, _name, body) => await body(), baseFailed: new Map(), exhaustedProofs: async () => [],
  } as Cycle;
}

test('integration:harness-remedy-loop-cycle — the loop\'s routine remedies apply the Claude harness contract to its own checkout when a plan rule is missing, journal it once, and keep operator entries', async () => {
  const { root, master, absent, installed, cleanup } = await checkout();
  try {
    const looped = cycle(root, master);
    await routineRemedies(looped);
    const settings = JSON.parse(await readFile(settingsFile(root), 'utf8'));
    assert.ok(settings.permissions.deny.includes(absent), `${absent} is written by the loop`);
    assert.ok(settings.permissions.allow.includes('Bash(npm test)') && settings.permissions.deny.includes('Bash(rm -rf /)'), 'operator-added rules are kept');
    assert.equal(settings.model, 'opus', 'other settings are kept');
    assert.equal(await harnessDrift(root, masterHarness(root, master, 'claude')), null, 'the settings now match the plan');
    const journaled = looped.state.actions['remedy:harness:claude'];
    assert.equal(journaled?.state, 'done');
    assert.equal(journaled?.kind, 'config');
    assert.ok(journaled?.detail.includes(`added deny ${absent}`), journaled?.detail);
    assert.equal(looped.performed.length, 1, 'one journal line for the one apply');

    // Idempotent: a cycle with nothing drifted writes and journals nothing.
    const before = await readFile(settingsFile(root), 'utf8');
    await routineRemedies(looped);
    assert.equal(looped.performed.length, 1);
    assert.equal(await readFile(settingsFile(root), 'utf8'), before);

    // Drift again (a new second-install unit widens the plan): the next cycle heals it again.
    await writeFile(settingsFile(root), JSON.stringify(installed));
    await routineRemedies(looped);
    assert.ok(JSON.parse(await readFile(settingsFile(root), 'utf8')).permissions.deny.includes(absent));
    assert.equal(looped.performed.length, 2);
    assert.equal(looped.state.actions['remedy:harness:claude']?.attempts, 2);

    // A loop with no doctor (no operator-agent identity, or the doctor off) still owns the checkout its managed state names, so its remedy still heals it.
    await writeFile(settingsFile(root), JSON.stringify(installed));
    const undoctored = cycle(root, master, { research: true });
    await routineRemedies(undoctored);
    assert.ok(JSON.parse(await readFile(settingsFile(root), 'utf8')).permissions.deny.includes(absent), 'a loop without a doctor heals the drift');
    assert.equal(undoctored.performed.length, 1);
    assert.equal(undoctored.state.actions['remedy:harness:claude']?.state, 'done');
    // A launcher whose checkout records no managed state for this loop, with no doctor, names no checkout: research alone never does, so nothing is repaired.
    await writeFile(settingsFile(root), JSON.stringify(installed));
    const unmanaged = cycle(root, config(master.credentialFile), { research: true });
    await routineRemedies(unmanaged);
    assert.equal(unmanaged.performed.length, 0);
    assert.deepEqual(JSON.parse(await readFile(settingsFile(root), 'utf8')), installed, 'nothing was written');
    // With the doctor wired, its checkout is the fallback.
    const fallback = cycle(root, config(master.credentialFile), { doctor: true });
    await routineRemedies(fallback);
    assert.equal(fallback.state.actions['remedy:harness:claude']?.state, 'done', 'the doctor\'s checkout is the fallback');

    // A write the loop cannot make is journaled once per cause and retried every cycle.
    if (!asRoot) {
      await writeFile(settingsFile(root), JSON.stringify(installed));
      await chmod(join(root, '.claude'), 0o500);
      const refused = cycle(root, master);
      await routineRemedies(refused);
      // A later cycle meeting the same cause moves the standing row's time, so the fault window keeps the failure open while it lasts.
      const later = Date.parse(observedAt) + 3 * 3_600_000;
      refused.now = () => later;
      await routineRemedies(refused);
      assert.equal(refused.performed.length, 1, 'the same failure is journaled once');
      assert.equal(refused.state.actions['remedy:harness:claude']?.at, new Date(later).toISOString(), 'the standing failure is refreshed, not left to lapse');
      assert.equal(refused.state.actions['remedy:harness:claude']?.state, 'failed');
      assert.match(refused.state.actions['remedy:harness:claude']!.detail, /^Could not apply the Claude harness contract from the loop's own process: EACCES/);
      await chmod(join(root, '.claude'), 0o700);
      await routineRemedies(refused);
      assert.equal(refused.state.actions['remedy:harness:claude']?.state, 'done', 'the next cycle that can write heals it');
    }
  } finally { await cleanup(); }
});

test('unit:harness-apply-keeps-operator-entries — the loop\'s harness remedy writes as writeHarnessPermissions with apply=true does: the missing plan rule is added and every operator-added allow, deny and setting is kept', async () => {
  const { root, master, plan, absent, installed, cleanup } = await checkout();
  try {
    assert.deepEqual((await writeHarnessPermissions(root, plan, false)).added.map(entry => entry.rule), [absent], 'the dry run names the one missing rule');
    const looped = cycle(root, master);
    await doctor.applyHarnessContract(looped);
    const settings = JSON.parse(await readFile(settingsFile(root), 'utf8'));
    assert.deepEqual(settings.permissions.allow, installed.permissions.allow, 'every allow is kept, the operator\'s included');
    assert.deepEqual(settings.permissions.deny, [...installed.permissions.deny, absent], 'every deny is kept and the missing one appended');
    assert.equal(settings.model, 'opus');
    assert.deepEqual((await writeHarnessPermissions(root, plan, false)).added, [], 'nothing is left for --apply to add');
  } finally { await cleanup(); }
});

test('unit:harness-drift-readonly-row — a status read whose vantage cannot write the checkout names the drift and the read-only vantage, attempts no apply, and never reports the auto-apply failure', async () => {
  const { root, master, absent, installed, cleanup } = await checkout();
  try {
    for (const code of ['EROFS', 'EACCES', 'EPERM']) {
      const item = await masterHarnessDrift(root, master, {
        log: () => assert.fail('nothing was repaired'),
        writable: async () => { throw Object.assign(new Error(`${code}: read-only file system, access '${root}/.claude'`), { code }); },
      });
      assert.ok(item, 'the drift is still reported');
      assert.equal(item.subject, 'harness');
      assert.ok(item.text.startsWith(`Harness drift in .claude/settings.local.json: missing deny ${absent}.`), item.text);
      assert.ok(item.text.includes(`This vantage reads the checkout read-only (${code})`), item.text);
      assert.match(item.text, /the loop's own harness remedy applies the contract/);
      assert.doesNotMatch(item.text, /Applying it automatically failed/);
      assert.deepEqual(item.drift!.missing, [{ list: 'deny', rule: absent }]);
    }
    assert.deepEqual(JSON.parse(await readFile(settingsFile(root), 'utf8')), installed, 'no write was attempted');
    // Any other failure is still the standing self-heal failure it was.
    const other = await masterHarnessDrift(root, master, { log: () => assert.fail('nothing was repaired'), writable: async () => { throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); } });
    assert.match(other!.text, /Applying it automatically failed: EIO/);
  } finally { await cleanup(); }
});

test('integration:master-status-confined-no-apply — master status\'s harness read from a checkout this process cannot write reports the read-only vantage and leaves the settings untouched; the loop\'s remedy then heals it', { skip: asRoot && 'root ignores directory modes' }, async () => {
  const { root, master, absent, installed, cleanup } = await checkout();
  try {
    await chmod(join(root, '.claude'), 0o500);
    // Exactly the call `master status` makes (src/cli/master/operations.ts).
    const logged: string[] = [];
    const item = await masterHarnessDrift(root, master, { log: line => logged.push(line) });
    assert.deepEqual(logged, [], 'no repair is claimed');
    assert.ok(item?.text.includes('This vantage reads the checkout read-only (EACCES)'), item?.text);
    assert.doesNotMatch(item!.text, /Applying it automatically failed/);
    assert.deepEqual(JSON.parse(await readFile(settingsFile(root), 'utf8')), installed, 'the settings are untouched');
    await chmod(join(root, '.claude'), 0o700);
    // The loop, which owns the checkout, applies the contract; the next status read reports nothing.
    await routineRemedies(cycle(root, master));
    assert.ok(JSON.parse(await readFile(settingsFile(root), 'utf8')).permissions.deny.includes(absent));
    assert.equal(await masterHarnessDrift(root, master, { repair: false }), null);
  } finally { await cleanup(); }
});

/** A detached scratch checkout, as the loop's research scratch is: no units, no configuration. */
async function scratch() {
  const directory = await temporaryDirectory('harness-remedy-scratch');
  execFileSync('git', ['init', '-q', directory]);
  return directory;
}

test('integration:harness-remedy-ignores-research-scratch — with research pointing at a units-less scratch checkout, the remedy applies the contract to the checkout the loop\'s managed state names and journals the done action', async () => {
  const { root, master, absent, cleanup } = await checkout();
  const research = await scratch();
  try {
    for (const wired of [{ research: true }, { research: true, doctor: true }]) {
      const looped = cycle(root, master, wired, research);
      // The doctor, when wired, also reads the scratch: managed state still wins over it.
      if (wired.doctor) (looped.effects as unknown as { doctor: { cwd: string } }).doctor.cwd = research;
      await mkdir(join(root, '.claude'), { recursive: true });
      await routineRemedies(looped);
      const journaled = looped.state.actions['remedy:harness:claude'];
      assert.equal(journaled?.state, 'done', journaled?.detail);
      assert.match(journaled!.detail, /^Applied the Claude harness contract to \.claude\/settings\.local\.json/);
      assert.doesNotMatch(journaled!.detail, new RegExp(research.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.ok(JSON.parse(await readFile(settingsFile(root), 'utf8')).permissions.deny.includes(absent), 'the managed checkout is healed');
      await assert.rejects(readFile(settingsFile(research), 'utf8'), { code: 'ENOENT' }, 'nothing is written into the research scratch');
      // Drift again for the next wiring.
      const settings = JSON.parse(await readFile(settingsFile(root), 'utf8'));
      settings.permissions.deny = settings.permissions.deny.filter((rule: string) => rule !== absent);
      await writeFile(settingsFile(root), JSON.stringify(settings));
    }
  } finally { await cleanup(); await rm(research, { recursive: true, force: true }); }
});

test('unit:harness-remedy-unitsless-refusal-names-init — a managed checkout that records no units and that no legacy-named unit runs is refused naming graphyard master init --token-stdin in that checkout', async () => {
  const { root, master, installed, cleanup } = await checkout();
  const units = await temporaryDirectory('harness-remedy-units');
  try {
    await rm(join(root, installUnitsFile));
    assert.equal(doctor.unrecordedUnitsFault(root, units), `${root}, the checkout the loop's managed state names, records no units (.graphyard/units.json is absent) and no legacy-named unit runs it; run graphyard master init --token-stdin in ${root} to record this install's units`);
    const looped = cycle(root, master, { research: true }, await scratch());
    await doctor.applyHarnessContract(looped);
    const failed = looped.state.actions['remedy:harness:claude'];
    assert.equal(failed?.state, 'failed');
    assert.ok(failed!.detail.includes(`run graphyard master init --token-stdin in ${root}`), failed!.detail);
    assert.deepEqual(JSON.parse(await readFile(settingsFile(root), 'utf8')), installed, 'nothing was written');
    // A legacy-named unit that runs the checkout itself is its alias: no refusal.
    await writeFile(join(units, legacyLoopUnit), `[Service]\nWorkingDirectory=${root}\nExecStart=/usr/bin/node ${root}/bin/graphyard.mjs master run\n`);
    assert.equal(doctor.unrecordedUnitsFault(root, units), null);
    // A recorded checkout is never refused.
    await rm(join(units, legacyLoopUnit));
    await writeFile(join(root, installUnitsFile), JSON.stringify(perInstallUnits(master.repository)));
    assert.equal(doctor.unrecordedUnitsFault(root, units), null);
  } finally { await cleanup(); await rm(units, { recursive: true, force: true }); }
});

test('integration:harness-remedy-legacy-mismatch-named — a managed checkout that records no units while a legacy unit runs another checkout names the unit, that checkout and the master-init remedy in the managed checkout, journals it once and refreshes it while it stands', async () => {
  const { root, master, installed, cleanup } = await checkout();
  const home = await temporaryDirectory('harness-remedy-home'), other = await scratch();
  const saved = process.env.XDG_CONFIG_HOME;
  try {
    await rm(join(root, installUnitsFile));
    const unitDirectory = join(home, 'systemd/user'), unitPath = join(unitDirectory, legacyLoopUnit);
    await mkdir(unitDirectory, { recursive: true });
    await writeFile(unitPath, `[Service]\nWorkingDirectory=${other}\nExecStart=/usr/bin/node ${other}/bin/graphyard.mjs master run\n`);
    process.env.XDG_CONFIG_HOME = home; // the loop reads the host's user unit directory, as it does in production
    const looped = cycle(root, master, { research: true, doctor: true }, await scratch());
    await routineRemedies(looped);
    const later = Date.parse(observedAt) + 3_600_000;
    looped.now = () => later;
    await routineRemedies(looped);
    const failed = looped.state.actions['remedy:harness:claude'];
    assert.equal(failed?.state, 'failed');
    assert.equal(failed?.detail, `Could not apply the Claude harness contract from the loop's own process: ${root}, the checkout the loop's managed state names, records no units (.graphyard/units.json is absent), and the legacy unit ${unitPath} runs another checkout (${other}); run graphyard master init --token-stdin in ${root} to record this install's own units`);
    assert.doesNotMatch(failed!.detail, /LegacyUnitRefusal/);
    assert.equal(looped.performed.length, 1, 'the fault is journaled once');
    assert.equal(failed?.at, new Date(later).toISOString(), 'the standing fault is refreshed');
    assert.deepEqual(JSON.parse(await readFile(settingsFile(root), 'utf8')), installed, 'nothing was written');
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved;
    await cleanup(); await rm(home, { recursive: true, force: true }); await rm(other, { recursive: true, force: true });
  }
});
