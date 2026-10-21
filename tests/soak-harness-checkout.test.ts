import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { masterConfigSchema, masterHarness, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonAction, type DaemonEffects } from '../src/master-daemon.js';
import { clearDoctorRuns, doctorRunsSettled, type DoctorEffects } from '../src/daemon/doctor.js';
import { doctorSettingsSchema } from '../src/master/doctor-settings.js';
import { harnessDrift } from '../src/harness.js';
import { installUnitsFile, perInstallUnits } from '../src/install/units.js';
import type { Runner } from '../src/runner/types.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1662. The loop's checkout validation before it applies the Claude harness contract, over a
 * simulated working day of the real loop: a cycle a minute for eight hours over the loop's own
 * checkout (its CLI's), the doctor every five minutes. The unit serving the loop is broken three
 * times — it runs another checkout, then it cannot be read, then it runs another checkout while the
 * host widens the plan — and each is repaired. The checkout's units record is then removed twice:
 * once while the unit serving the loop runs it, which the loop repairs itself by recording its own
 * units (GY-1692, GY-1666's second half) exactly once, on that cycle, and never again while the record
 * stands; and once while the unit runs another checkout, which stays refused — a unit that cannot
 * prove it runs this checkout never has units recorded for it — until the unit runs this checkout
 * again, when the loop records them. The validation repeats every cycle, so after every cycle and at
 * the end: a refused window is journaled once as a waiting row that is neither refreshed nor retried
 * as a fault, nothing is written while the unit is refused, the first cycle after a repair closes the
 * row (healing drift, or with nothing to apply when the contract already holds), drift never survives
 * an accepted cycle, nothing reaches an isolation record or a failing fault run, and every system
 * invariant the loop checks holds.
 */
const minute = 60_000, hour = 60 * minute, start = Date.parse('2026-10-10T06:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const key = 'remedy:harness:claude';
/** The windows the serving unit is refused in, how it is broken in each, and the minutes the host widens the plan. */
const refused = [{ from: 0, to: 60, broken: 'elsewhere' }, { from: 120, to: 180, broken: 'unreadable' }, { from: 240, to: 300, broken: 'elsewhere' }, { from: 440, to: 470, broken: 'unrecorded-elsewhere' }] as const;
const widenings = [0, 250, 360];
/** The minutes the checkout's units record is removed at: while the serving unit runs it (adopted), and as the unit is pointed elsewhere (refused until it runs it again). */
const removals = [400, 440];
const unitText = (checkout: string) => `[Unit]\nDescription=Graphyard master\n\n[Service]\nWorkingDirectory=${checkout}\nExecStart=/usr/bin/node ${checkout}/bin/graphyard.mjs master run\n`;

const config = (root: string): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(root, '.graphyard-credentials/master/token'), cliPath: join(root, 'bin/graphyard.mjs'),
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { intervalSeconds: 60 } });

test('unit:soak-harness-checkout-invariants — over a simulated day a refused serving unit is journaled once per window as a waiting row, nothing is applied while it stands, the first cycle after each repair closes it, and every system invariant holds', { timeout: 300_000 }, async () => {
  clearDoctorRuns();
  const root = await temporaryDirectory('soak-harness-checkout'), units = await temporaryDirectory('soak-harness-checkout-units');
  try {
    execFileSync('git', ['init', '-q', root]);
    await mkdir(join(root, '.graphyard'), { recursive: true });
    await writeFile(join(root, installUnitsFile), JSON.stringify(perInstallUnits('owner/project')));
    await writeFile(join(root, '.gitignore'), '.claude/settings.local.json\n.graphyard/\n');
    const master = config(root), plan = masterHarness(root, master, 'claude'), serving = perInstallUnits('owner/project').master, unit = join(units, serving);
    const file = join(root, '.claude/settings.local.json'), absent = plan.deny.at(-1)!.rule;
    const widened = JSON.stringify({ permissions: { allow: [...plan.allow.map(entry => entry.rule), 'Bash(npm test)'], deny: [...plan.deny.map(entry => entry.rule).filter(rule => rule !== absent), 'Bash(rm -rf /)'] }, model: 'opus' });
    await mkdir(join(root, '.claude'), { recursive: true });

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
      closeSession: () => {}, dispatch: async () => {}, persist: async () => {},
      observeDeployment: async () => ({ source: 'endpoint', sha: 'd'.repeat(40), at: iso(now), reason: null, deployed: [], pending: [] }), recordDeployment: async () => {},
      research: { cwd: join(root, '.graphyard/research-scratch') }, doctor, harness: { servingUnit: serving, unitDirectory: units },
    } as unknown as DaemonEffects;

    const state = emptyDaemonState(master);
    const violations: string[] = [], harnessActions: (DaemonAction & { minute: number })[] = [], recordedAt: number[] = [];
    let writes = 0, recordedText: string | null = null;
    const unitsRecord = () => readFile(join(root, installUnitsFile), 'utf8').catch(() => null);
    for (let cycle = 0; now < start + 8 * hour; cycle++, now += minute) {
      const at = (now - start) / minute;
      const window = refused.find(range => at >= range.from && at < range.to);
      // The serving unit as the operator leaves it this minute: broken inside a window, running this checkout otherwise.
      await rm(unit, { recursive: true, force: true });
      // The units record is removed at each removal minute and never rewritten by hand: what stands afterwards is the loop's own.
      if (removals.includes(at)) await rm(join(root, installUnitsFile), { force: true });
      if (window?.broken === 'unreadable') await mkdir(unit);
      else await writeFile(unit, unitText(window?.broken === 'elsewhere' || window?.broken === 'unrecorded-elsewhere' ? '/srv/another/graphyard' : root));
      if (widenings.includes(at)) await writeFile(file, widened);
      const before = await readFile(file, 'utf8'), recordBefore = await unitsRecord();
      const drifted = !!await harnessDrift(root, plan);
      const result = await runCycle(master, state, effects, () => now);
      await doctorRunsSettled();
      const after = await readFile(file, 'utf8'), recordAfter = await unitsRecord();
      if (after !== before) writes++;
      if (recordBefore === null && recordAfter !== null) recordedAt.push(at);
      for (const action of result.actions) if (action.kind === 'config' && /harness contract/i.test(action.detail)) harnessActions.push({ ...action, minute: at });
      for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle} (+${at} min): ${check.invariant} — ${check.reading}`);

      const row = state.actions[key];
      assert.deepEqual(Object.keys(state.actions).filter(name => name.startsWith('isolated:')), [], `cycle ${cycle}: a failure reached an isolation record`);
      assert.equal(state.faults.failing[key], undefined, `cycle ${cycle} (+${at} min): a refusal opened a failing fault run`);
      if (window) {
        // Refused: one waiting row from the window's first minute, never refreshed, nothing written however long it stands.
        assert.equal(row?.state, 'waiting', `cycle ${cycle} (+${at} min): ${row?.detail}`);
        assert.equal(row!.at, iso(start + window.from * minute), `cycle ${cycle} (+${at} min): the waiting row was refreshed`);
        assert.ok(row!.detail.includes(window.broken === 'unrecorded-elsewhere' ? `${root} records no units` : unit), row!.detail);
        assert.equal(after, before, `cycle ${cycle} (+${at} min): the contract was applied while the serving unit is refused`);
        // A unit that cannot prove it runs this checkout never has units recorded for it (GY-1692): the record stays absent for the whole window.
        if (window.broken === 'unrecorded-elsewhere') assert.equal(recordAfter, null, `cycle ${cycle} (+${at} min): units were recorded while the serving unit runs another checkout`);
        else assert.equal(recordAfter, recordBefore, `cycle ${cycle} (+${at} min): the units record changed while the serving unit is refused`);
      } else {
        // Accepted: the row is closed and no drift survives.
        assert.equal(row?.state, 'done', `cycle ${cycle} (+${at} min): ${row?.detail}`);
        assert.equal(await harnessDrift(root, plan), null, `cycle ${cycle} (+${at} min): drift survived an accepted cycle`);
        if (!drifted) assert.equal(after, before, `cycle ${cycle} (+${at} min): the settings were written without drift to heal`);
        // The checkout records this install's own units after every accepted cycle: the loop's record, once made, stands unchanged.
        assert.deepEqual(JSON.parse(recordAfter!), perInstallUnits('owner/project'), `cycle ${cycle} (+${at} min): the units record is not this install's own`);
        if (recordBefore !== null) assert.equal(recordAfter, recordBefore, `cycle ${cycle} (+${at} min): a standing units record was rewritten`);
        if (recordBefore === null) { assert.match(row!.detail, /^Recorded this install's units/, `cycle ${cycle} (+${at} min): ${row!.detail}`); recordedText = recordAfter; }
        else assert.ok(!result.actions.some(action => /^Recorded/.test(action.detail)), `cycle ${cycle} (+${at} min): units were recorded again while the record stands`);
      }
      const settings = JSON.parse(after);
      assert.ok(settings.permissions.allow.includes('Bash(npm test)') && settings.permissions.deny.includes('Bash(rm -rf /)') && settings.model === 'opus', `cycle ${cycle}: the operator's entries were lost`);
    }
    assert.deepEqual(violations, [], 'every system invariant holds after every cycle');

    // Each window is one waiting line, on its first minute, naming why the unit was refused.
    const waiting = harnessActions.filter(action => action.state === 'waiting');
    assert.deepEqual(waiting.map(action => action.minute), refused.map(range => range.from), 'each refused window is journaled once');
    assert.match(waiting[0]!.detail, /runs \/srv\/another\/graphyard, not /);
    assert.match(waiting[1]!.detail, /could not be read \(EISDIR\)/);
    assert.match(waiting[3]!.detail, /records no units .* Run graphyard master init in /);
    // Each repair closes its row on the first accepted cycle: by healing the drift that stood, or with nothing to apply.
    const done = harnessActions.filter(action => action.state === 'done');
    assert.deepEqual(done.map(action => action.minute), [60, 180, 300, 360, 400, 470], 'one closing line per repair, per widening outside a window, and per adoption of the units record');
    assert.match(done[0]!.detail, /^Applied the Claude harness contract/);
    assert.match(done[1]!.detail, /already holds .* the earlier waiting row is resolved with nothing to apply/);
    assert.match(done[2]!.detail, new RegExp(`^Applied the Claude harness contract.*added deny ${absent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(done[3]!.detail, /^Applied the Claude harness contract/);
    // Adoption (GY-1692): the record removed while the unit runs this checkout is recorded on that very cycle, from the serving unit,
    // and closes with nothing to apply; the one removed as the unit was pointed elsewhere is recorded the first cycle the unit runs this checkout again.
    assert.deepEqual(recordedAt, [400, 470], 'the loop records its own units exactly once per removal, never while the serving unit is refused');
    assert.match(done[4]!.detail, new RegExp(`^Recorded this install's units \\(${serving}, graphyard-executor-owner-project@\\.service\\) in ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${installUnitsFile} from ${serving}, the unit serving the loop, which runs it\\. The Claude harness contract already holds .*: nothing to apply$`));
    assert.match(done[5]!.detail, /^Recorded this install's units .* the earlier waiting row is resolved with nothing to apply$/);
    assert.equal(harnessActions.filter(action => /^Recorded/.test(action.detail)).length, 2, 'no other line records units');
    assert.equal(await unitsRecord(), recordedText, 'the record the loop made stands unchanged to the end of the day');
    assert.equal(writes, done.filter(action => action.detail.startsWith('Applied')).length, 'the settings file is written exactly once per heal');
    assert.equal(state.actions[key]?.state, 'done', 'the day ends healed');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(units, { recursive: true, force: true });
  }
});
