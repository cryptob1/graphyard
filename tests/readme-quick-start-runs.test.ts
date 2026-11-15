import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { heldVariable } from '../src/master/verification-slots.js';

// GY-3323: until @cryptob1/graphyard is on npm, the Quick start's first path is the repository checkout.
const root = fileURLToPath(new URL('..', import.meta.url));
const start = readFileSync(join(root, 'README.md'), 'utf8').split('## Quick start\n')[1]?.split('\n## ')[0] ?? '';
const blocks = [...start.matchAll(/```sh\n([^`]+)```/g)].map(match => ({ at: match.index, lines: match[1]!.trim().split('\n') }));

test('e2e:readme-quick-start-runs — the Quick start clones, installs, builds and runs up from the checkout, and labels npx as available once published', { timeout: 900_000 }, () => {
  const [checkout, published] = blocks;
  assert.ok(checkout && published, 'the Quick start has a checkout block and a published block');
  const url = 'https://github.com/cryptob1/graphyard.git';
  assert.deepEqual(checkout.lines, [`git clone ${url} && cd graphyard`, 'npm ci', 'npm run build', 'node bin/graphyard.mjs up --repo OWNER/NAME']);
  assert.deepEqual(published.lines, ['npx @cryptob1/graphyard up --repo OWNER/NAME']);
  assert.match(start.slice(0, published.at), /Once published to npm:\s*$/, 'the npx line is labelled as available once published');

  // Run the block in a scratch directory: the clone shares this checkout's objects, npm ci links its installed
  // dependencies, and up prints its usage; the build runs exactly as written, inside this run's verification slot.
  const scratch = mkdtempSync(join(tmpdir(), 'gy-quick-start-'));
  try {
    const script = checkout.lines.map(line => line
      .replace(`git clone ${url}`, `git clone --shared ${JSON.stringify(root)} graphyard`)
      .replace(/^npm ci$/, `ln -s ${JSON.stringify(join(root, 'node_modules'))} node_modules`)
      .replace(/ up --repo OWNER\/NAME$/, ' up --help')).join('\n');
    const output = execFileSync('sh', ['-ec', script], { cwd: scratch, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, [heldVariable]: '1' } });
    assert.match(output, /up --repo OWNER\/NAME/, 'the checkout CLI answers up');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
