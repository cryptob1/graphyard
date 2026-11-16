import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { spawnHeadless } from '../src/headless-session.js';

// GY-3414: OpenCode prints its error as a JSON event on standard output and nothing on standard
// error, so a review that stopped at once inside bubblewrap was recorded as "bwrap exited with
// code 1" alone. The failure now carries the runtime's own words, as a stderr-printing runtime's
// (Muse) already did.
const opencodeError = JSON.stringify({ type: 'error', timestamp: 1, sessionID: 'ses_1', error: { type: 'provider.free-limit', message: 'Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.', status: 429 } });

async function wrapperExiting(body: string) {
  const directory = await temporaryDirectory('headless-failure-summary');
  // Named as the confinement wrapper is: the run's command is bwrap, the runtime runs inside it.
  const bwrap = join(directory, 'bwrap');
  await writeFile(bwrap, `#!/bin/sh\n${body}\nexit 1\n`, { mode: 0o755 });
  return { bwrap, directory };
}
const failure = async (body: string) => {
  const { bwrap, directory } = await wrapperExiting(body);
  return spawnHeadless(bwrap, [], { cwd: directory, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 60_000, run: join(directory, 'run'), signal: new AbortController().signal, detached: new AbortController().signal }).then(() => assert.fail('the run failed'), (error: Error) => error.message);
};

test('integration:headless-failure-summary — a run that exits inside bwrap with its error on stdout names the runtime\'s own error', async () => {
  const message = await failure(`echo '{"type":"step_start","sessionID":"ses_1"}'\necho ${JSON.stringify(opencodeError)}`);
  assert.match(message, /bwrap exited with code 1: Free usage limit reached\. Connect a provider/);
});

test('integration:headless-failure-summary — standard error still speaks first, as for Muse', async () => {
  const message = await failure(`echo 'progress on stdout'\necho 'muse: not signed in' >&2`);
  assert.match(message, /bwrap exited with code 1: muse: not signed in$/);
});

test('integration:headless-failure-summary — a plain last line of stdout is the cause when nothing else is said', async () => {
  const message = await failure(`echo 'Error: model zai-coding-plan/glm-9 not found'`);
  assert.match(message, /bwrap exited with code 1: Error: model zai-coding-plan\/glm-9 not found$/);
});
