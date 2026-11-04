import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { acquireVerificationSlot, declareSlotFiles, heldSlots, othersDeclaredFiles } from '../src/master/verification-slots.js';
import { declareTrialFiles, trialAffordableFiles, trialEnvironment, trialShardBreadth } from '../src/merge-writer/trial.js';
import { trialContainerWords } from '../src/merge-writer/trial-container.js';

const root = join(import.meta.dirname, '..');
function assertHostPidOneAlive() {
  try { process.kill(1, 0); } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'EPERM'); }
}
const memory = async () => ({ totalBytes: 64 * 2 ** 30, availableBytes: 40 * 2 ** 30 });
async function waitFor(file: string, child: ReturnType<typeof spawn>, output: () => string) {
  const deadline = Date.now() + 30_000;
  while (!existsSync(file)) {
    assert.equal(child.exitCode, null, output());
    assert.ok(Date.now() < deadline, output());
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('integration:verification-owner-identity — host release, live safety and interrupted trial breadth', async () => {
  const directory = await temporaryDirectory('verification-owner');
  const held = await acquireVerificationSlot({ directory, slots: 1, label: 'live host' });
  declareSlotFiles(held, 4);
  assert.equal(othersDeclaredFiles(directory), 0, 'own process identity is excluded');
  assert.equal(heldSlots(directory).length, 1, 'budget reads preserve live holders');
  held.release();
  assert.equal(heldSlots(directory).length, 0);
  const baseline = await trialAffordableFiles(memory, directory);
  const ready = join(directory, 'ready');
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { declareTrialFiles } from ${JSON.stringify(join(root, 'src/merge-writer/trial.ts'))};
    import { writeFileSync } from 'node:fs';
    await declareTrialFiles(${JSON.stringify(directory)}, 'interrupted', 46);
    writeFileSync(${JSON.stringify(ready)}, 'ready');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'ignore', 'pipe'] });
  let output = ''; child.stderr!.on('data', chunk => output += chunk);
  try {
    await waitFor(ready, child, () => output);
    assert.equal(await trialAffordableFiles(memory, directory), baseline! - 46);
    assert.equal(heldSlots(directory).length, 1);
    const ownerFile = join(directory, 'slot-1000', 'owner.json');
    await writeFile(ownerFile, JSON.stringify({ ...JSON.parse(readFileSync(ownerFile, 'utf8')), pid: process.pid }));
    assert.equal(await trialAffordableFiles(memory, directory), baseline! - 46, 'same numeric PID is still another owner');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    assert.equal(await trialAffordableFiles(memory, directory), baseline, 'first plan reclaims before subtracting declarations');
    assert.equal(heldSlots(directory).length, 0);
    const release = await declareTrialFiles(directory, 'ordinary', 3);
    assert.equal(heldSlots(directory)[0].owner?.files, 3);
    await release();
    assert.equal(heldSlots(directory).length, 0);
  } finally { child.kill('SIGKILL'); }
});

test('integration:verification-owner-identity — private container PID collision preserves live owner then recovers first host plan', { timeout: 60_000 }, async () => {
  const directory = await temporaryDirectory('verification-private', root);
  const ready = join(directory, 'ready'), interrupt = join(directory, 'interrupt');
  const baseline = await trialAffordableFiles(memory, directory);
  const wrapper = trialContainerWords([directory]);
  // PID 1 in the nested private root collides with the caller's live PID 1.
  // This uses the ordinary trial container, including its real nested namespace support.
  const script = `
    import { acquireVerificationSlot, declareSlotFiles } from '/graphyard-harness/src/master/verification-slots.ts';
    import { existsSync, writeFileSync } from 'node:fs';
    const held = await acquireVerificationSlot({ directory: ${JSON.stringify(directory)}, slots: 1, label: 'private suite' });
    declareSlotFiles(held, 46);
    writeFileSync(${JSON.stringify(ready)}, String(process.pid));
    setInterval(() => { if (existsSync(${JSON.stringify(interrupt)})) process.kill(process.pid, 'SIGKILL'); }, 20);
  `;
  const child = spawn(wrapper[0], [...wrapper.slice(1), 'bwrap', '--unshare-user', '--unshare-pid', '--as-pid-1', '--ro-bind', '/', '/',
    '--proc', '/proc', '--dev', '/dev', '--bind', directory, directory, '--', 'node', '--import', '/graphyard-harness/node_modules/tsx/dist/loader.mjs', '--input-type=module', '-e', script],
    { cwd: directory, env: { ...trialEnvironment(), PATH: '/usr/local/bin:/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let output = ''; child.stderr!.on('data', chunk => output += chunk);
  try {
    await waitFor(ready, child, () => output);
    assert.equal(Number(readFileSync(ready, 'utf8')), 1);
    assertHostPidOneAlive();
    assert.equal(await trialAffordableFiles(memory, directory), baseline! - 46);
    assert.equal(heldSlots(directory).length, 1, 'foreign live owner is retained');
    const exited = once(child, 'exit');
    await writeFile(interrupt, 'kill'); await exited;
    assertHostPidOneAlive();
    assert.equal(await trialAffordableFiles(memory, directory), baseline);
    assert.deepEqual(trialShardBreadth(24, 24, await trialAffordableFiles(memory, directory)), trialShardBreadth(24, 24, baseline));
    const held = await acquireVerificationSlot({ directory, slots: 1, label: 'host successor' });
    assert.equal(held.slot, 0); held.release();
    assert.equal(heldSlots(directory).length, 0);
  } finally { child.kill('SIGKILL'); }
});
