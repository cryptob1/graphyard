import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { setupFromZeroChecks, setupLine } from '../src/setup-from-zero.js';

// GY-3319: below Landlock ABI 9 doctor's FAIL line names the ABI found, the ABI required and the
// Ubuntu 26.04 fix, and the README prerequisites name the same requirement and fix.

async function landlockLine(abi: number) {
  const root = await temporaryDirectory('doctor-landlock-abi');
  const checks = await setupFromZeroChecks({ root, status: null, environments: root, sandbox: () => null, loopCode: null, systemctl: () => '', platform: 'darwin', landlockAbi: () => abi });
  const lines = checks.filter(check => check.id === 'landlock').map(setupLine);
  assert.equal(lines.length, 1, 'one landlock line');
  return lines[0];
}

test('unit:tests/doctor-landlock-abi.test.ts — doctor FAILs ABI 8 naming ABI 9 and the Ubuntu 26.04 kernel fix', async () => {
  const line = await landlockLine(8);
  assert.match(line, /^FAIL landlock:/);
  assert.match(line, /Landlock ABI 8/);
  assert.match(line, /Landlock ABI 9/);
  assert.match(line, /fix:.*Ubuntu 26\.04.*linux-image-oem-7\.3/);
});

test('unit:tests/doctor-landlock-abi.test.ts — doctor PASSes ABI 9', async () => {
  assert.match(await landlockLine(9), /^PASS landlock: Landlock ABI 9/);
});

test('unit:tests/doctor-landlock-abi.test.ts — README prerequisites name Landlock ABI 9 and the same fix', async () => {
  const prerequisites = (await readFile('README.md', 'utf8')).split('\n').find(line => line.startsWith('Prerequisites')) ?? '';
  assert.match(prerequisites, /Landlock ABI 9\+/);
  assert.match(prerequisites, /Ubuntu 26\.04.*linux-image-oem-7\.3/);
});
