import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { checkAgentEnvironment } from '../src/master/environments.js';
import { opencodeAuthList } from '../src/master/runtimes.js';

// GY-3414: opencode-a/b/c each held an `opencode/auth.json` with a Z.AI key, so the registry read
// them as logged in, while OpenCode itself listed no authenticated provider, ran the free fallback
// model and stopped every review at once. The login an OpenCode account has is now the one
// `opencode auth list` reports for the account's XDG_DATA_HOME.
const scratch = await temporaryDirectory('opencode-login-probe');
const bin = join(scratch, 'bin'), calls = join(scratch, 'calls');
await mkdir(bin);
// A stand-in OpenCode 2.x: it records what it was asked and under which data home, and lists a
// provider only for a home OpenCode itself took the login into (marked `taken`).
await writeFile(join(bin, 'opencode'), `#!/bin/sh
[ "$2" = --help ] && { echo '  --standalone  Run with a private server'; exit 0; }
echo "$* XDG_DATA_HOME=$XDG_DATA_HOME" >> ${JSON.stringify(calls)}
if [ -e "$XDG_DATA_HOME/opencode/taken" ]; then echo 'Z.AI Coding Plan  API key  stored'; else echo 'No authenticated integrations'; fi
`, { mode: 0o755 });
const path = process.env.PATH;
process.env.PATH = `${bin}:${path}`;
after(() => { process.env.PATH = path; });

async function home(name: string, taken: boolean) {
  const directory = join(scratch, name);
  await mkdir(join(directory, 'opencode'), { recursive: true });
  await writeFile(join(directory, 'opencode', 'auth.json'), JSON.stringify({ 'zai-coding-plan': { type: 'api', key: `${name}-key` } }), { mode: 0o600 });
  if (taken) await writeFile(join(directory, 'opencode', 'taken'), '');
  return directory;
}
const probe = { quota: false, cacheMs: 0, opencodeAuth: opencodeAuthList };

test('integration:opencode-login-probe — an auth.json OpenCode lists no provider for reads as not logged in, with a plain reason', async () => {
  const directory = await home('opencode-a', false);
  const health = await checkAgentEnvironment({ name: 'opencode-a', kind: 'opencode', home: directory, plan: 'zai', declaredPlan: 'zai' }, probe);
  assert.equal(health.loggedIn, false);
  assert.equal(health.reason, 'opencode-a is not logged in: opencode auth list shows no authenticated provider');
  assert.match(health.login ?? '', /opencode auth login/);
  assert.match(await readFile(calls, 'utf8'), new RegExp(`^auth list --standalone XDG_DATA_HOME=${directory}$`, 'm'), 'the runtime is asked, standalone, under the account\'s own data home');
});

test('integration:opencode-login-probe — an account OpenCode lists an authenticated provider for is logged in', async () => {
  const directory = await home('opencode-b', true);
  const health = await checkAgentEnvironment({ name: 'opencode-b', kind: 'opencode', home: directory, plan: 'zai', declaredPlan: 'zai' }, probe);
  assert.equal(health.loggedIn, true);
  assert.equal(health.reason, null);
});

test('integration:opencode-login-probe — an OpenCode that cannot answer leaves the account not logged in, naming the failure', async () => {
  const directory = await home('opencode-c', true);
  const health = await checkAgentEnvironment({ name: 'opencode-c', kind: 'opencode', home: directory, plan: 'zai', declaredPlan: 'zai' }, { ...probe, opencodeAuth: async () => { throw new Error('spawn opencode ENOENT'); } });
  assert.equal(health.loggedIn, false);
  assert.equal(health.reason, 'opencode-c is not logged in: opencode auth list failed: spawn opencode ENOENT');
});
