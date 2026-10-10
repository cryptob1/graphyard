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
import { routineRemedies, type DoctorEffects } from '../src/daemon/doctor.js';
import { harnessDrift, writeHarnessPermissions } from '../src/harness.js';
import { masterHarnessDrift } from '../src/cli/master/fleet.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1652: harness drift healed only from the vantage that read it, and the one recurring automated
// reader — the doctor, whose checkout GY-888 binds read-only — always met EROFS. The loop now
// applies the contract itself each cycle, and a read-only reader names its vantage instead of
// reporting the doomed in-place apply.

const launcher = resolve(fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)));
const observedAt = '2026-10-10T14:00:00.000Z';
const config = (credentialFile: string): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
const settingsFile = (root: string) => join(root, '.claude/settings.local.json');
const asRoot = process.getuid?.() === 0; // root ignores directory modes, so a chmod cannot make the checkout read-only

/** A checkout whose installed settings carry the plan minus one generated deny, plus the operator's own entries. */
async function checkout() {
  const root = await temporaryDirectory('harness-remedy');
  execFileSync('git', ['init', '-q', root]);
  const master = config(join(root, '.graphyard-credentials/master/token'));
  const plan = masterHarness(root, master, 'claude');
  const absent = plan.deny.at(-1)!.rule;
  const installed = { permissions: { allow: [...plan.allow.map(entry => entry.rule), 'Bash(npm test)'], deny: [...plan.deny.map(entry => entry.rule).filter(rule => rule !== absent), 'Bash(rm -rf /)'] }, model: 'opus' };
  await mkdir(join(root, '.claude'), { recursive: true });
  await writeFile(settingsFile(root), JSON.stringify(installed));
  await writeFile(join(root, '.gitignore'), '.claude/settings.local.json\n');
  return { root, master, plan, absent, installed, cleanup: async () => { await chmod(join(root, '.claude'), 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }); } };
}

/** One loop cycle over no work whose doctor reads `root`, the loop's own checkout. */
function cycle(root: string, master: MasterConfig): Cycle {
  const clock = Date.parse(observedAt);
  const effects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [], now: observedAt }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: observedAt, reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    doctor: { cwd: root } as DoctorEffects,
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

    // A loop with no doctor has no confined reader to stand in for: the remedy is not wired.
    await writeFile(settingsFile(root), JSON.stringify(installed));
    const bare = cycle(root, master); delete (bare.effects as Partial<DaemonEffects>).doctor;
    await routineRemedies(bare);
    assert.equal(bare.performed.length, 0);

    // A write the loop cannot make is journaled once per cause and retried every cycle.
    if (!asRoot) {
      await chmod(join(root, '.claude'), 0o500);
      const refused = cycle(root, master);
      await routineRemedies(refused);
      await routineRemedies(refused);
      assert.equal(refused.performed.length, 1, 'the same failure is journaled once');
      assert.equal(refused.state.actions['remedy:harness:claude']?.state, 'failed');
      assert.match(refused.state.actions['remedy:harness:claude']!.detail, /^Could not apply the Claude harness contract from the loop's own process: EACCES/);
      await chmod(join(root, '.claude'), 0o700);
      await routineRemedies(refused);
      assert.equal(refused.state.actions['remedy:harness:claude']?.state, 'done', 'the next cycle that can write heals it');
    }
  } finally { await cleanup(); }
});

test('unit:harness-apply-keeps-operator-entries — writeHarnessPermissions with apply=true adds the missing plan rule and keeps every operator-added allow, deny and setting', async () => {
  const { root, plan, absent, installed, cleanup } = await checkout();
  try {
    const written = await writeHarnessPermissions(root, plan, true);
    assert.equal(written.applied, true);
    assert.deepEqual(written.added.map(entry => entry.rule), [absent]);
    assert.deepEqual(written.removed, []);
    const settings = JSON.parse(await readFile(settingsFile(root), 'utf8'));
    assert.deepEqual(settings.permissions.allow, installed.permissions.allow, 'every allow is kept, the operator\'s included');
    assert.deepEqual(settings.permissions.deny, [...installed.permissions.deny, absent], 'every deny is kept and the missing one appended');
    assert.equal(settings.model, 'opus');
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
