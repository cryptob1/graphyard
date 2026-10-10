import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { masterConfigSchema, masterHarness, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonAction, type DaemonEffects } from '../src/master-daemon.js';
import { clearDoctorRuns, doctorRunsSettled, type DoctorEffects } from '../src/daemon/doctor.js';
import { doctorSettingsSchema } from '../src/master/doctor-settings.js';
import { harnessDrift } from '../src/harness.js';
import type { Runner } from '../src/runner/types.js';
import { installUnitsFile, perInstallUnits } from '../src/install/units.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1652. The loop's harness remedy over a simulated working day of the real loop: a cycle a
 * minute for eight hours over the loop's own checkout, the doctor every ten minutes. The host widens
 * the plan three times (a second install's unit appears, so the installed settings lack a generated
 * deny), and once the checkout turns unwritable for half an hour while drift stands. The remedy
 * repeats every cycle, so after every cycle and at the end: drift never survives a writable cycle,
 * the settings file is written only on a cycle that found drift, each heal is one journal line, the
 * unwritable window is journaled once rather than once a cycle while every cycle in it refreshes the
 * standing failure up to the window's last minute, the operator's own entries are never
 * lost, nothing reaches an isolation record, and every system invariant the loop checks holds.
 */
const minute = 60_000, hour = 60 * minute, start = Date.parse('2026-10-10T06:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const asRoot = process.getuid?.() === 0; // root ignores directory modes, so a chmod cannot make the checkout unwritable
/** The minutes the host widens the plan, and the window the checkout cannot be written in (drift appears inside it). */
const widenings = [0, 60, 125, 300], unwritable = { from: 120, to: 150 };

// The loop's managed state names its checkout (GY-1664): the launcher lives in it and its .graphyard/master.json records the loop.
const config = (root: string): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(root, '.graphyard-credentials/master/token'), cliPath: join(root, 'bin/graphyard.mjs'),
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { intervalSeconds: 60 } });

test('unit:soak-harness-remedy-invariants — over a simulated day the loop heals every harness drift on the next writable cycle with one journal line, writes nothing otherwise, journals an unwritable checkout once, keeps operator entries, and every system invariant holds', { timeout: 300_000 }, async () => {
  clearDoctorRuns();
  const root = await temporaryDirectory('soak-harness-remedy'), scratch = await temporaryDirectory('soak-harness-remedy-scratch');
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['init', '-q', scratch]);
    const master = config(root);
    await mkdir(join(root, '.graphyard'), { recursive: true });
    await writeFile(join(root, '.graphyard/master.json'), JSON.stringify(master));
    await writeFile(join(root, installUnitsFile), JSON.stringify(perInstallUnits(master.repository)));
    const plan = masterHarness(root, master, 'claude');
    const file = join(root, '.claude/settings.local.json'), directory = join(root, '.claude');
    const absent = plan.deny.at(-1)!.rule;
    const widened = JSON.stringify({ permissions: { allow: [...plan.allow.map(entry => entry.rule), 'Bash(npm test)'], deny: [...plan.deny.map(entry => entry.rule).filter(rule => rule !== absent), 'Bash(rm -rf /)'] }, model: 'opus' });
    await mkdir(directory, { recursive: true });
    await writeFile(join(root, '.gitignore'), '.claude/settings.local.json\n');

    let now = start, doctorRuns = 0;
    const doctor: DoctorEffects = {
      settings: { ...doctorSettingsSchema.parse({}), command: 'pi' }, cwd: root, env: {},
      runner: async () => ({ runtime: 'pi', model: 'soak/doctor', release: async () => {}, runner: { name: 'pi', start: (_prompt: string, options: { tool: string }) => {
        const payload = { findings: [], actions: [], filed: [] };
        return { id: `soak-doctor-${doctorRuns++}`, events: [], onEvent: () => () => {}, cancel: () => {}, result: async () => ({ ok: true as const, tool: options.tool, payload, payloads: [payload] }) };
      } } as unknown as Runner }),
      file: async () => { throw new Error('the doctor files nothing on this day'); },
      recordRun: async () => {},
    };
    const effects = {
      agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
      snapshot: async () => ({ work: [], now: iso(now) }),
      closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, persist: async () => {},
      observeDeployment: async () => ({ source: 'endpoint', sha: 'd'.repeat(40), at: iso(now), reason: null, deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
      research: { cwd: scratch }, doctor, // as the real loop wires them: research names its units-less scratch, never the checkout; the doctor reads the checkout
    } as unknown as DaemonEffects;

    const state = emptyDaemonState(master);
    const violations: string[] = [], harnessActions: (DaemonAction & { minute: number })[] = [];
    let writes = 0, drifts = 0, lastLocked: string | undefined;
    const standing = new Set<number>();
    for (let cycle = 0; now < start + 8 * hour; cycle++, now += minute) {
      const at = (now - start) / minute;
      if (widenings.includes(at)) await writeFile(file, widened);
      const locked = !asRoot && at >= unwritable.from && at < unwritable.to;
      await chmod(directory, locked ? 0o500 : 0o700);
      const before = await readFile(file, 'utf8');
      const drifted = !!await harnessDrift(root, plan);
      if (drifted) drifts++;
      const result = await runCycle(master, state, effects, () => now);
      await doctorRunsSettled();
      const after = await readFile(file, 'utf8');
      if (after !== before) writes++;
      for (const action of result.actions) if (action.kind === 'config' && /harness contract/.test(action.detail)) harnessActions.push({ ...action, minute: at });
      for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle} (+${at} min): ${check.invariant} — ${check.reading}`);

      // After every cycle: a drifted writable checkout is healed this cycle, nothing is written without drift, and the operator's entries stand.
      assert.deepEqual(Object.keys(state.actions).filter(key => key.startsWith('isolated:')), [], `cycle ${cycle}: a failure reached an isolation record`);
      if (!locked) assert.equal(await harnessDrift(root, plan), null, `cycle ${cycle} (+${at} min): drift survived a writable cycle`);
      if (!drifted || locked) assert.equal(after, before, `cycle ${cycle} (+${at} min): the settings were written without drift to heal`);
      // Inside the unwritable window the one standing failure is refreshed by every cycle that meets it again:
      // its time is this cycle's, its attempt count stays that of the one journaled failure, so the fault
      // window never sees the run end while it lasts. The first writable cycle after it heals the row.
      const row = state.actions['remedy:harness:claude'];
      if (locked && drifted) {
        assert.equal(row?.state, 'failed', `cycle ${cycle} (+${at} min): the unwritable checkout stands as a failure`);
        assert.equal(row?.at, iso(now), `cycle ${cycle} (+${at} min): the standing failure was not refreshed this cycle`);
        standing.add(row!.attempts);
        if (at === unwritable.to - 1) lastLocked = row!.at;
      }
      if (!asRoot && at === unwritable.to) {
        assert.equal(lastLocked, iso(start + (unwritable.to - 1) * minute), 'the last unwritable cycle refreshed the standing failure, up to the window boundary');
        assert.equal(row?.state, 'done', 'the first writable cycle after the window heals the standing failure');
      }
      const settings = JSON.parse(after);
      assert.ok(settings.permissions.allow.includes('Bash(npm test)') && settings.permissions.deny.includes('Bash(rm -rf /)') && settings.model === 'opus', `cycle ${cycle}: the operator's entries were lost`);
    }
    assert.deepEqual(violations, [], 'every system invariant holds after every cycle');

    // Each widening is healed once: on its own cycle when writable, on the first writable cycle after the window otherwise.
    const healed = harnessActions.filter(action => action.state === 'done');
    const expected = asRoot ? widenings : widenings.map(at => at >= unwritable.from && at < unwritable.to ? unwritable.to : at);
    assert.deepEqual(healed.map(action => action.minute), expected, 'one heal per widening, on the first cycle that could write it');
    assert.equal(writes, healed.length, 'the settings file is written exactly once per heal');
    for (const action of healed) assert.ok(action.detail.includes(`added deny ${absent}`), action.detail);
    // The unwritable window is one journal line, not one per cycle, though the remedy retried every cycle in it.
    const failed = harnessActions.filter(action => action.state === 'failed');
    assert.equal(failed.length, asRoot ? 0 : 1, `the unwritable window is journaled once: ${failed.map(action => `+${action.minute}m`).join(', ')}`);
    if (!asRoot) {
      assert.equal(failed[0]!.minute, widenings.find(at => at >= unwritable.from && at < unwritable.to));
      assert.ok(drifts > widenings.length, 'drift stood through the window, so the remedy met it on every cycle there');
      assert.equal(standing.size, 1, 'every refresh kept the one journaled failure\'s attempt count: no cycle re-recorded it');
    }
    assert.equal(state.actions['remedy:harness:claude']?.state, 'done', 'the day ends healed');
  } finally {
    await chmod(join(root, '.claude'), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});
