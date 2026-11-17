import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { headlessArgv } from '../src/headless-session.js';
import { onSearchPath } from '../src/runtime-binary.js';

// GY-3425 e2e: the headless opencode worker's command line, run against this host's installed
// opencode, runs past start: no usage text, no flag refusal, no immediate exit. A host without
// opencode runs it against a stand-in that, like an older opencode, has no --standalone.
const scratch = await temporaryDirectory('opencode-worker-starts');
const xdg = Object.fromEntries(await Promise.all(['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME'].map(async name => [name, await temporaryDirectory(name.toLowerCase(), scratch)])));
let path = process.env.PATH ?? '';
if (!onSearchPath('opencode', path)) {
  const bin = join(scratch, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'opencode'), `#!/bin/sh
for a in "$@"; do case "$a" in --help) echo 'USAGE'; exit 0;; --standalone) echo 'USAGE'; echo 'ERROR Unknown flag --standalone' >&2; exit 1;; esac; done
echo '{"type":"step_start"}'; sleep 30
`, { mode: 0o755 });
  path = `${bin}:${path}`;
}
const env = { ...process.env, ...xdg, PATH: path };

test('e2e:opencode-worker-starts — a headless opencode worker launch on this host runs past start', async () => {
  const argv = await headlessArgv({ kind: 'opencode', args: [] }, 'Reply with the single word OK.', env);
  const child = spawn(argv[0]!, argv.slice(1), { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exit = await Promise.race([new Promise<number | null>(done => child.on('close', done)), new Promise<'running'>(done => setTimeout(() => done('running'), 5_000))]);
  child.kill('SIGKILL');
  assert.doesNotMatch(output, /\bUSAGE\b|Invalid value for flag|Unknown flag/i, `${argv.join(' ')} printed its usage: ${output.slice(0, 600)}`);
  assert.ok(exit === 'running' || (exit === 0 && /"type"/.test(output)), `${argv.join(' ')} exited at once (${exit}): ${output.slice(0, 600)}`);
});
