import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { setupFromZeroChecks, setupLine } from '../src/setup-from-zero.js';

// GY-3325: the README prerequisites name the Node major package.json requires and how to install it per distro,
// and doctor under an older Node fails with that major.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const major = Number(/^>=\s*(\d+)$/.exec(JSON.parse(read('package.json')).engines.node)![1]);

test('e2e:readme-prerequisites — the README names the engines Node major and install commands for Ubuntu/Debian, Arch and macOS', () => {
  const prerequisites = read('README.md').split('\n').find(line => line.startsWith('Prerequisites'))!;
  assert.match(prerequisites, new RegExp(`Node ${major}\\+`));
  assert.ok(prerequisites.includes(`Ubuntu/Debian: \`curl -fsSL https://deb.nodesource.com/setup_${major}.x | sudo bash - && sudo apt install nodejs\``));
  assert.ok(prerequisites.includes('Arch: `sudo pacman -S nodejs npm`'));
  assert.ok(prerequisites.includes(`macOS: \`brew install node@${major}\``));
});

test('e2e:readme-prerequisites — doctor under an older Node prints a FAIL line naming the required major', async () => {
  const root = await temporaryDirectory('readme-prerequisites');
  execFileSync('git', ['init', root], { stdio: 'ignore' });
  const doctor = (nodeVersion: string) => setupFromZeroChecks({ root, env: {}, status: null, environments: join(root, 'agents'), loopCode: null, systemctl: () => '', platform: 'linux', sandbox: () => null, nodeVersion })
    .then(checks => setupLine(checks.find(check => check.id === 'node')!));
  assert.match(await doctor(`${major - 2}.11.0`), new RegExp(`^FAIL node: Node ${major - 2}\\.11\\.0; Graphyard needs Node ${major} or newer \\(fix: install Node ${major} or newer`));
  assert.match(await doctor(`${major}.1.0`), /^PASS node:/);
});
