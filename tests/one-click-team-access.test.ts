import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyTailnetCommand, readTailnet, runUp, tailscaleMissingNote, type UpDependencies } from '../src/up.js';
import { fakeTailscale } from './helpers/fake-tailscale.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3294: one machine, many installs, one port each.

async function up(root: string, port: number, machineDir: string, path: string) {
  await mkdir(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const previous = process.env.PATH, notes: string[] = [];
  process.env.PATH = path;
  try {
    const dependencies = {
      root, emit: (event: { kind: string; text?: string }) => { if (event.kind === 'note') notes.push(event.text!); }, now: Date.now, sleep: async () => {},
      serverUrl: async () => `http://127.0.0.1:${port}`, masterToken: async () => null, status: async () => null, publishOnboarding: async () => null,
      gh: async () => ({ code: 0, stdout: '{}' }), git: async () => ({ code: 0, stdout: '' }), cli: async () => ({ code: 0, stdout: '{}' }),
      tailnet: readTailnet, applyTailnet: applyTailnetCommand, machineDir, humanWaitMs: 0, machineWaitMs: 0,
    } as unknown as UpDependencies;
    const result = await runUp({ repository: `owner/install-${port}` } as Parameters<typeof runUp>[0], dependencies);
    return { reachableUrl: result.reachableUrl, notes };
  } finally { process.env.PATH = previous; }
}

test('unit:tests/one-click-team-access.test.ts — up serves each install on its own port by default, idempotently, and carries on without Tailscale', async () => {
  const host = await temporaryDirectory('team-access-host'), machineDir = join(host, 'machine');
  await fakeTailscale(host);
  const path = `${join(host, 'bin')}:${process.env.PATH}`;
  const a = await up(join(host, 'a'), 4311, machineDir, path);
  const b = await up(join(host, 'b'), 4312, machineDir, path);
  assert.equal(a.reachableUrl, 'http://yard.tail-test.ts.net:4311');
  assert.equal(b.reachableUrl, 'http://yard.tail-test.ts.net:4312');
  const rerun = await up(join(host, 'a'), 4311, machineDir, path);
  assert.equal(rerun.reachableUrl, 'http://yard.tail-test.ts.net:4311');
  const calls = (await readFile(join(host, 'calls.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const serves = calls.filter(args => args[0] === 'serve');
  assert.deepEqual(serves, [
    ['serve', '--bg', '--http=4311', 'http://127.0.0.1:4311'], ['serve', '--bg', '--http=4312', 'http://127.0.0.1:4312'], ['serve', '--bg', '--http=4311', 'http://127.0.0.1:4311'],
  ], 'every run forwards its own port automatically, with no --share-tailnet, and never resets another');
  assert.deepEqual(JSON.parse(await readFile(join(host, 'serve.json'), 'utf8')), { 4311: 'http://127.0.0.1:4311', 4312: 'http://127.0.0.1:4312' }, 'rerunning A keeps B served');
  assert.deepEqual(JSON.parse(await readFile(join(machineDir, 'tailnet.json'), 'utf8')), { dnsName: 'yard.tail-test.ts.net.', ip: '100.64.0.7', deviceId: 'nFAKE123CNTRL' });

  const bare = await temporaryDirectory('team-access-no-tailscale');
  await mkdir(join(bare, 'empty'));
  const local = await up(join(bare, 'c'), 4313, join(bare, 'machine'), join(bare, 'empty'));
  assert.equal(local.reachableUrl, null, 'without Tailscale the install continues on this machine only');
  assert.ok(!local.notes.some(note => /did not finish/.test(note)));
  assert.ok(local.notes.includes(tailscaleMissingNote), 'a host without Tailscale gets one install instruction');
  assert.match(tailscaleMissingNote, /install Tailscale \(https:\/\/tailscale\.com\/download\).*rerun graphyard up/);
});
