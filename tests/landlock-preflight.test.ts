import { test } from 'node:test';
import assert from 'node:assert/strict';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { runUp, type UpDependencies, type UpEvent } from '../src/up.js';
import { setupFromZeroChecks, setupLine } from '../src/setup-from-zero.js';

// GY-3169: socket confinement refuses every session below Landlock ABI 9, so up's preflight refuses
// such a host before installing anything, and doctor prints one FAIL line for it.

async function upWith(abi: number) {
  const root = await temporaryDirectory('landlock-preflight');
  const events: UpEvent[] = [];
  const installs: string[][] = [];
  const deps: UpDependencies = {
    root, emit: event => events.push(event), now: () => 0, sleep: async () => {},
    serverUrl: async () => 'http://127.0.0.1:4310', masterToken: async () => 'm'.repeat(40), status: async () => null,
    publishOnboarding: async () => null,
    landlockAbi: () => abi,
    cli: async args => {
      installs.push(args);
      return args.includes('--plan')
        ? { code: 0, stdout: JSON.stringify({ preflight: [{ name: 'GitHub CLI', ok: true }] }) }
        : { code: 1, stdout: '', stderr: 'the run stops after preflight' };
    },
    gh: async () => ({ code: 0, stdout: '', stderr: '' }),
    git: async () => ({ code: 0, stdout: 'git@github.com:owner/project.git', stderr: '' }),
  };
  const result = await runUp({ repository: 'owner/project', provider: 'compose', agent: false, master: 'claude' }, deps);
  return { result, events, installs };
}

const stepEvents = (events: UpEvent[], name: string) => events.filter((event: any) => event.step === name);

test('unit:tests/landlock-preflight.test.ts — up preflight refuses Landlock ABI 8 before install, naming ABI 9 or newer', async () => {
  const { result, events, installs } = await upWith(8);
  assert.equal(result.ok, false);
  const text = JSON.stringify(result) + JSON.stringify(events);
  assert.match(text, /Landlock ABI 8/);
  assert.match(text, /Landlock ABI 9 or newer/);
  assert.match(text, /Linux 7\.0/);
  assert.deepEqual(installs, [], 'nothing was planned or installed');
});

test('unit:tests/landlock-preflight.test.ts — up preflight passes Landlock ABI 9', async () => {
  const { events, installs } = await upWith(9);
  assert.ok(installs.some(args => args.includes('--plan')), 'preflight went on to the install plan');
  assert.ok(stepEvents(events, 'preflight').some((event: any) => event.state === 'done'), JSON.stringify(events));
  assert.doesNotMatch(JSON.stringify(events), /Landlock/);
});

for (const [abi, status] of [[8, 'FAIL'], [9, 'PASS'], [10, 'PASS']] as const) {
  test(`unit:tests/landlock-preflight.test.ts — doctor prints ${status} for Landlock ABI ${abi}`, async () => {
    const root = await temporaryDirectory('landlock-doctor');
    const checks = await setupFromZeroChecks({ root, status: null, environments: root, sandbox: () => null, loopCode: null, systemctl: () => '', platform: 'darwin', landlockAbi: () => abi });
    const lines = checks.filter(check => check.id === 'landlock').map(setupLine);
    assert.equal(lines.length, 1, 'one landlock line');
    assert.ok(lines[0].startsWith(`${status} landlock:`), lines[0]);
    assert.match(lines[0], new RegExp(`Landlock ABI ${abi}`));
    if (status === 'FAIL') assert.match(lines[0], /Landlock ABI 9 or newer/);
  });
}
