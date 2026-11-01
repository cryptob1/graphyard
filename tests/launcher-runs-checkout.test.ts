import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, cp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-3000: the launcher always runs this checkout's own src/cli.ts. A stale .graphyard/held-cli.json
 * pointing at another snapshot is ignored; up (removeHeldCliPin) removes it. Proof: unit:launcher-runs-checkout.
 */
const source = fileURLToPath(new URL('..', import.meta.url));

test('unit:launcher-runs-checkout — a stale held-cli.json pointing at another snapshot still runs this checkout\'s guide complete, and removeHeldCliPin removes the pin', async () => {
  const checkout = await temporaryDirectory('launcher-runs-checkout');
  await cp(join(source, 'bin'), join(checkout, 'bin'), { recursive: true });
  await cp(join(source, 'src'), join(checkout, 'src'), { recursive: true });
  await symlink(fileURLToPath(new URL('../..', import.meta.resolve('tsx'))), join(checkout, 'node_modules'));
  await cp(join(source, 'package.json'), join(checkout, 'package.json'));
  const launcher = join(checkout, 'bin', 'graphyard.mjs');
  const snapshot = await temporaryDirectory('launcher-runs-checkout-snapshot');
  await mkdir(join(snapshot, 'src'), { recursive: true });
  await writeFile(join(snapshot, 'src', 'cli.ts'), "console.log('SNAPSHOT_MARKER'); process.exit(0);\n");
  const pin = join(checkout, '.graphyard', 'held-cli.json');
  await mkdir(join(checkout, '.graphyard'), { recursive: true });
  await writeFile(pin, JSON.stringify({ commit: 'c'.repeat(40), root: snapshot, loop: true }));
  const out = execFileSync(process.execPath, [launcher, 'guide', 'complete'], { encoding: 'utf8', cwd: checkout });
  assert.match(out, /complete GY-N EPOCH --head/, 'the checkout\'s own guide answered');
  assert.doesNotMatch(out, /SNAPSHOT_MARKER/, 'the snapshot\'s cli was not loaded');
  const review = execFileSync(process.execPath, [launcher, 'guide', 'review'], { encoding: 'utf8', cwd: checkout });
  assert.match(review, /BLOCKING/);
  assert.doesNotMatch(review, /SNAPSHOT_MARKER/);
  const { removeHeldCliPin } = await import('../src/repository-setup.js');
  await removeHeldCliPin(checkout);
  await assert.rejects(() => access(pin), 'up removes the stale pin');
});
