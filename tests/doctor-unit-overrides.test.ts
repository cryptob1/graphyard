import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupFromZeroChecks, setupLine } from '../src/setup-from-zero.js';
import { perInstallUnits } from '../src/install/units.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-2159: the install writes no drop-in, so `graphyard doctor` prints one FAIL line for each drop-in
 * systemd applies to the install's loop or executor units, naming its path, and one PASS when there
 * is none. systemctl is stubbed: a fake user manager answering `show` with DropInPaths.
 */

const units = perInstallUnits('owner/overrides');

async function checkout() {
  const root = await temporaryDirectory('unit-overrides-root');
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(join(root, '.graphyard/units.json'), JSON.stringify(units));
  return root;
}

/** A fake user manager: DROPINS maps a unit to the drop-in paths `show` reports for it; INSTANCES are the executor slots it lists. */
function systemd(dropIns: Record<string, string[]>, instances: string[] = []) {
  const calls: string[][] = [];
  const systemctl = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'list-units') return instances.map(unit => `${unit} loaded active running Graphyard executor`).join('\n');
    if (args[0] !== 'show') return '';
    const unit = args[args.length - 1];
    return `LoadState=loaded\nDropInPaths=${(dropIns[unit] ?? []).join(' ')}\n`;
  };
  return { calls, systemctl };
}

const doctor = async (root: string, systemctl: (args: string[]) => string) =>
  (await setupFromZeroChecks({ root, env: {}, status: null, environments: join(root, 'none'), sandbox: () => null, loopCode: null, systemctl, platform: 'linux' }))
    .filter(check => check.id === 'unit-overrides').map(setupLine);

test('unit:doctor-unit-overrides — a drop-in the install did not write on a managed unit is one FAIL line naming its path', async () => {
  const root = await checkout(), dropIn = join(root, 'override.conf');
  await writeFile(dropIn, '[Service]\nEnvironment=GRAPHYARD_URL=http://stopgap:4310\n');
  const lines = await doctor(root, systemd({ [units.master]: [dropIn] }).systemctl);
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`^FAIL unit-overrides: ${dropIn} overrides ${units.master}, which the install did not write \\(Environment=GRAPHYARD_URL=http://stopgap:4310\\)`));
  assert.match(lines[0], new RegExp(`rm ${dropIn} && systemctl --user daemon-reload && systemctl --user restart ${units.master}`));
});

test('unit:doctor-unit-overrides — a template drop-in shown on every executor slot is reported once', async () => {
  const root = await checkout(), dropIn = `/etc/systemd/user/${units.executorTemplate}.d/stopgap.conf`;
  const slots = [1, 2].map(slot => units.executorTemplate.replace('@.service', `@${slot}.service`));
  const lines = await doctor(root, systemd(Object.fromEntries(slots.map(slot => [slot, [dropIn]])), slots).systemctl);
  assert.deepEqual(lines.map(line => line.split(' overrides')[0]), [`FAIL unit-overrides: ${dropIn}`]);
});

test('unit:doctor-unit-overrides — with no drop-in it prints PASS; a checkout recording no units prints no line', async () => {
  const root = await checkout(), manager = systemd({});
  assert.deepEqual(await doctor(root, manager.systemctl), [`PASS unit-overrides: no drop-in overrides ${units.master} or its executors`]);
  assert.ok(manager.calls.some(args => args[0] === 'show' && args.at(-1) === units.master));
  const bare = await temporaryDirectory('unit-overrides-bare'), untouched = systemd({});
  assert.deepEqual(await doctor(bare, untouched.systemctl), []);
  assert.deepEqual(untouched.calls, []);
});

test('unit:doctor-unit-overrides — a user manager that cannot be asked fails rather than passing', async () => {
  const lines = await doctor(await checkout(), () => { throw new Error('Failed to connect to user scope bus'); });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^FAIL unit-overrides: systemctl --user could not be asked .*Failed to connect to user scope bus/);
});
