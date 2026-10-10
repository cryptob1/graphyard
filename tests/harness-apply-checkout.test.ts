import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { masterConfigSchema, masterHarness, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runDaemon, type DaemonEffects } from '../src/master-daemon.js';
import { emptyHeldDecisions } from '../src/daemon/decision-reads.js';
import { Launcher, type Cycle } from '../src/daemon/cycle.js';
import { Timings } from '../src/master/timings.js';
// A namespace import: a run without this change still loads the file, and its cases fail instead of the import.
import * as harness from '../src/master/harness.js';
import { routineRemedies } from '../src/daemon/doctor.js';
import { harnessDrift } from '../src/harness.js';
import { installUnitsFile, legacyLoopUnit, perInstallUnits } from '../src/install/units.js';
import { loopScratchCheckout } from '../src/producer.js';
import { worktreeRoot } from '../src/install/worktree-root.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1662: the loop applied the Claude harness contract against the checkout its research effect
// names, which runDaemon rewrites to the research scratch worktree. That worktree records no units,
// and on a host whose legacy unit runs another checkout every cycle failed with the legacy unit
// refusal, its remedy naming `master init` in the scratch. The apply now resolves the loop's own
// checkout, and a checkout it may not apply against is refused once, naming the checkout, the
// remedy and the unit to update.

const observedAt = '2026-10-10T18:00:00.000Z';
const key = 'remedy:harness:claude';
// The loop's managed checkout is the one its CLI runs from (coordinatorCheckoutRoot(cliPath)), so each checkout's config names its own CLI.
const config = (root: string, extra: Record<string, unknown> = {}): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(root, '.graphyard-credentials/master/token'), cliPath: join(root, 'bin/graphyard.mjs'),
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], ...extra });
const settingsFile = (root: string) => join(root, '.claude/settings.local.json');
const unitText = (checkout: string) => `[Unit]\nDescription=Graphyard master\n\n[Service]\nWorkingDirectory=${checkout}\nExecStart=/usr/bin/node ${checkout}/bin/graphyard.mjs master run\n`;

/** A git checkout whose settings lack one generated deny of its plan; `units` records the install's own units. */
async function checkout(label: string, units: boolean) {
  const root = await temporaryDirectory(label);
  execFileSync('git', ['init', '-q', root]);
  if (units) { await mkdir(join(root, '.graphyard'), { recursive: true }); await writeFile(join(root, installUnitsFile), JSON.stringify(perInstallUnits('owner/project'))); }
  const plan = masterHarness(root, config(root), 'claude'), absent = plan.deny.at(-1)!.rule;
  await mkdir(join(root, '.claude'), { recursive: true });
  await writeFile(settingsFile(root), JSON.stringify({ permissions: { allow: plan.allow.map(entry => entry.rule), deny: plan.deny.map(entry => entry.rule).filter(rule => rule !== absent) } }));
  await writeFile(join(root, '.gitignore'), '.claude/settings.local.json\n.graphyard/\n');
  return { root, absent };
}

/** One loop cycle over no work with these effects. */
function cycle(master: MasterConfig, wired: Partial<DaemonEffects>): Cycle {
  const clock = Date.parse(observedAt);
  const effects = { agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [], now: observedAt }), persist: async () => {}, ...wired } as unknown as DaemonEffects;
  return {
    config: master, state: emptyDaemonState(master), effects, now: () => clock, snapshot: { work: [], now: observedAt }, clock, clockOffset: { min: 0, max: 0 },
    performed: [], agents: [], credentials: {}, open: [], owns: () => false, heldBy: () => null, timings: new Timings(() => clock),
    launcher: new Launcher(Number.POSITIVE_INFINITY), launch: () => false, detached: false, heldDecisions: emptyHeldDecisions(), closedPanes: new Set(),
    isolate: async (_kind, _item, _name, body) => await body(), baseFailed: new Map(), exhaustedProofs: async () => [],
  } as Cycle;
}

test('unit:harness-apply-checkout-resolution — the loop applies the harness contract to its own checkout, never the units-less scratch its research names; a units-less checkout beside a legacy unit running elsewhere, and a serving unit running another checkout, are refused once naming the checkout, master init and the unit to update', async () => {
  const own = await checkout('harness-own', true), scratch = await checkout('harness-scratch', false);
  const units = await temporaryDirectory('harness-units'), elsewhere = '/srv/another/graphyard';
  await writeFile(join(units, legacyLoopUnit), unitText(elsewhere));
  const master = config(own.root);

  // The loop's own checkout is applied against, though research names the scratch.
  const looped = cycle(master, { research: { cwd: scratch.root }, harness: { unitDirectory: units } });
  await routineRemedies(looped);
  assert.equal(looped.state.actions[key]?.state, 'done', looped.state.actions[key]?.detail);
  assert.equal(await harnessDrift(own.root, masterHarness(own.root, master, 'claude')), null, 'the own checkout is healed');
  assert.ok(!JSON.parse(await readFile(settingsFile(scratch.root), 'utf8')).permissions.deny.includes(scratch.absent), 'the scratch worktree is never written');

  // The units-less case: refused naming the checkout and master init, journaled once, no fault, nothing written.
  const before = await readFile(settingsFile(scratch.root), 'utf8');
  const unitless = cycle(config(scratch.root), { harness: { unitDirectory: units } });
  await routineRemedies(unitless);
  const refused = unitless.state.actions[key]!;
  assert.equal(refused.state, 'waiting');
  assert.ok(refused.detail.startsWith('The harness contract was not applied: '), refused.detail);
  assert.ok(refused.detail.includes(`${scratch.root} records no units (${installUnitsFile} is absent)`), refused.detail);
  assert.ok(refused.detail.includes(`legacy unit ${join(units, legacyLoopUnit)} runs another checkout (${elsewhere})`), refused.detail);
  assert.ok(refused.detail.includes(`Run graphyard master init in ${scratch.root}`), refused.detail);
  assert.equal(refused.faultClass, undefined, 'a refusal waiting on the operator is no action:config fault');
  assert.equal(unitless.state.faults.failing[key], undefined, 'no failing run is opened');
  assert.equal(unitless.performed.length, 1);
  assert.equal(await readFile(settingsFile(scratch.root), 'utf8'), before, 'nothing is applied against the refused checkout');
  // The next cycle meets the same refusal: nothing is journaled, refreshed or retried as a fault.
  const later = Date.parse(observedAt) + 3_600_000;
  unitless.now = () => later;
  await routineRemedies(unitless);
  assert.equal(unitless.performed.length, 1, 'the refusal does not repeat on the next cycle');
  assert.equal(unitless.state.actions[key]!.at, refused.at, 'the row is not refreshed');
  // The remedy: once the checkout records its units, the next cycle applies.
  await mkdir(join(scratch.root, '.graphyard'), { recursive: true });
  await writeFile(join(scratch.root, installUnitsFile), JSON.stringify(perInstallUnits('owner/project')));
  await routineRemedies(unitless);
  assert.equal(unitless.state.actions[key]?.state, 'done', unitless.state.actions[key]?.detail);

  // A pre-GY-1441 install whose legacy unit runs it is its own alias: no units recorded, still applied.
  const aliased = await checkout('harness-alias', false), aliasUnits = await temporaryDirectory('harness-alias-units');
  await writeFile(join(aliasUnits, legacyLoopUnit), unitText(aliased.root));
  const alias = cycle(config(aliased.root), { harness: { unitDirectory: aliasUnits, servingUnit: legacyLoopUnit } });
  await routineRemedies(alias);
  assert.equal(alias.state.actions[key]?.state, 'done', alias.state.actions[key]?.detail);

  // The legacy-unit-points-elsewhere case for the serving unit: the apply names the unit to update rather than apply.
  assert.throws(() => harness.harnessApplyCheckout(own.root, { servingUnit: legacyLoopUnit, unitDirectory: units }), (error: unknown) => {
    assert.ok(error instanceof harness.HarnessCheckoutRefusal);
    assert.equal(error.unit, join(units, legacyLoopUnit));
    assert.equal(error.root, own.root);
    assert.match(error.message, new RegExp(`the unit serving this loop, ${join(units, legacyLoopUnit).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, runs ${elsewhere}, not ${own.root}`));
    assert.match(error.message, /Update .* \(its WorkingDirectory and ExecStart\) to run /);
    return true;
  });
  // A serving unit that runs this checkout, or none at all, is no refusal.
  assert.deepEqual(harness.harnessApplyCheckout(aliased.root, { servingUnit: legacyLoopUnit, unitDirectory: aliasUnits }).units.master, legacyLoopUnit);
  assert.equal(harness.harnessApplyCheckout(own.root, { servingUnit: null, unitDirectory: units }).units.master, perInstallUnits('owner/project').master);
});

test('integration:harness-contract-apply — a loop run (runDaemon, research rewritten to its scratch worktree) applies the contract to its own checkout without a config fault; a serving unit running another checkout is reported once, naming the unit, and applied after it is updated', async () => {
  const own = await checkout('harness-loop', true), managed = await temporaryDirectory('harness-loop-worktrees');
  execFileSync('git', ['-C', own.root, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base']);
  const master = config(own.root, { run: { intervalSeconds: 30, worktreeRoot: managed } });
  // The scratch a restarted loop takes up (openResearchScratch): runDaemon rewrites research's cwd to it.
  const scratch = loopScratchCheckout(worktreeRoot(own.root, master)).directory;
  await mkdir(scratch, { recursive: true });
  const units = await temporaryDirectory('harness-loop-units'), serving = 'graphyard-master-owner-project.service';
  await writeFile(join(units, serving), unitText('/srv/another/graphyard'));
  const run = async (wired: Partial<DaemonEffects>, state = emptyDaemonState(master)) => {
    const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), snapshot: async () => ({ work: [], now: new Date().toISOString() }),
      closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, persist: async () => {},
      observeDeployment: async () => ({ source: 'endpoint', sha: 'd'.repeat(40), at: new Date().toISOString(), reason: null, deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
      research: { cwd: own.root }, ...wired } as unknown as DaemonEffects;
    await runDaemon(master, state, effects, { once: true, intervalMs: 5, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGUSR2'], repository: own.root, checkout: () => ({ root: own.root, commit: null, modified: [], untracked: [] }) as never, log: () => {} });
    return state;
  };
  // Wired as daemonEffects wires a loop that serves no unit; runDaemon moves research to its scratch, and the apply still targets the CLI's checkout.
  const state = await run({});
  assert.equal(state.actions[key]?.state, 'done', state.actions[key]?.detail);
  assert.equal(state.actions[key]!.faultClass, undefined);
  assert.equal(await harnessDrift(own.root, masterHarness(own.root, master, 'claude')), null, 'the loop\'s own checkout was applied against');
  assert.ok(!existsSync(settingsFile(scratch)), 'the research scratch runDaemon moved research to is never written');

  // The serving unit runs another checkout: reported once with the unit to update, the own checkout left as it was.
  const drifted = await readFile(settingsFile(own.root), 'utf8').then(text => JSON.parse(text));
  drifted.permissions.deny = drifted.permissions.deny.filter((rule: string) => rule !== own.absent);
  await writeFile(settingsFile(own.root), JSON.stringify(drifted));
  const mismatched = await run({ harness: { servingUnit: serving, unitDirectory: units } });
  assert.equal(mismatched.actions[key]?.state, 'waiting');
  assert.ok(mismatched.actions[key]!.detail.includes(`the unit serving this loop, ${join(units, serving)}, runs /srv/another/graphyard, not ${own.root}`), mismatched.actions[key]!.detail);
  assert.ok(!JSON.parse(await readFile(settingsFile(own.root), 'utf8')).permissions.deny.includes(own.absent), 'nothing is applied while the unit runs another checkout');
  // Updated, the next loop run applies.
  await writeFile(join(units, serving), unitText(own.root));
  await run({ harness: { servingUnit: serving, unitDirectory: units } }, mismatched);
  assert.equal(mismatched.actions[key]?.state, 'done', mismatched.actions[key]?.detail);
  assert.ok(JSON.parse(await readFile(settingsFile(own.root), 'utf8')).permissions.deny.includes(own.absent));
});

test('integration:harness-remedy-ignores-research-scratch — the remedy resolves the loop\'s managed checkout (coordinatorCheckoutRoot(cliPath), the doctor\'s cwd as fallback), never research\'s cwd: a units-less research scratch beside a legacy unit running elsewhere is never applied against, and the managed checkout is healed and journaled done', async () => {
  const own = await checkout('harness-managed', true), scratch = await checkout('harness-research-scratch', false);
  const units = await temporaryDirectory('harness-managed-units');
  await writeFile(join(units, legacyLoopUnit), unitText('/srv/another/graphyard'));
  const scratchBefore = await readFile(settingsFile(scratch.root), 'utf8');
  // Research names the scratch, which on its own would be refused (no units, legacy unit elsewhere); the doctor names it too, but the CLI's checkout wins.
  const master = config(own.root);
  const looped = cycle(master, { research: { cwd: scratch.root }, doctor: { cwd: scratch.root } as never, harness: { unitDirectory: units } });
  await routineRemedies(looped);
  const row = looped.state.actions[key]!;
  assert.equal(row.state, 'done', row.detail);
  assert.equal(row.faultClass, undefined);
  assert.equal(await harnessDrift(own.root, masterHarness(own.root, master, 'claude')), null, 'the managed checkout is healed');
  assert.equal(await readFile(settingsFile(scratch.root), 'utf8'), scratchBefore, 'the research scratch is never written');

  // With no CLI path recorded, the doctor's checkout is the fallback; research's cwd is still never used.
  const fallback = await checkout('harness-doctor-fallback', true);
  const doctored = cycle(config(fallback.root, { cliPath: '' }), { research: { cwd: scratch.root }, doctor: { cwd: fallback.root } as never, harness: { unitDirectory: units } });
  await routineRemedies(doctored);
  assert.equal(doctored.state.actions[key]?.state, 'done', doctored.state.actions[key]?.detail);
  assert.equal(await harnessDrift(fallback.root, masterHarness(fallback.root, config(fallback.root), 'claude')), null);
  const neither = cycle(config(scratch.root, { cliPath: '' }), { research: { cwd: scratch.root }, harness: { unitDirectory: units } });
  await routineRemedies(neither);
  assert.equal(neither.state.actions[key], undefined, 'research alone names no checkout to apply against');
  assert.equal(await readFile(settingsFile(scratch.root), 'utf8'), scratchBefore);
});
