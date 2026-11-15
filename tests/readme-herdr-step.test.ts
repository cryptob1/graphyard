import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { setupFromZeroChecks, setupLine } from '../src/setup-from-zero.js';

// GY-3324: the README's setup has a Herdr step with its install command, and doctor's Herdr line names it.
const herdrLine = async (path: string) => {
  const root = await temporaryDirectory('readme-herdr-step');
  const checks = await setupFromZeroChecks({ root, env: { PATH: path }, status: null, environments: root, sandbox: () => null, loopCode: null, systemctl: () => '', platform: 'darwin' });
  return checks.filter(check => check.id === 'herdr').map(setupLine);
};

test('e2e:readme-herdr-step — without herdr on PATH doctor FAILs naming the README Herdr step, which carries the install command', async () => {
  const lines = await herdrLine(await temporaryDirectory('readme-herdr-empty'));
  assert.equal(lines.length, 1, 'one herdr line');
  const install = 'curl -fsSL https://herdr.dev/install.sh | sh';
  assert.ok(lines[0].startsWith('FAIL herdr: herdr is not on PATH'), lines[0]);
  assert.ok(lines[0].includes(`README's Herdr prerequisite`) && lines[0].includes(install), lines[0]);
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /Herdr \(`herdr --version`; install: `curl -fsSL https:\/\/herdr\.dev\/install\.sh \| sh`\)/);
});

test('e2e:readme-herdr-step — with herdr on PATH the doctor line is PASS', async () => {
  const bin = await temporaryDirectory('readme-herdr-bin');
  await writeFile(join(bin, 'herdr'), '#!/bin/sh\n'); await chmod(join(bin, 'herdr'), 0o755);
  const lines = await herdrLine(bin);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], `PASS herdr: herdr is on PATH at ${join(bin, 'herdr')}`);
});
