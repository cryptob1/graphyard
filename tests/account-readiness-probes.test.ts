import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkAgentEnvironment } from '../src/master/environments.js';
import { observeAccount } from '../src/fleet.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { chooseSession, emptyRegistry, foldObservations, proposedRuntimes } from '../src/model/registry.js';
import { detectLoggedOut } from '../src/master/logged-out.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3414: on lumina-investor cursor-a held cli-config.json and claude-c .credentials.json, yet
// reviewer selection read both as not logged in, and muse's error naming its missing login file was
// not read as a logout. The probe reads where each runtime keeps its login, a home a confined
// session masks is unknown there, never a logout, and muse's own error holds its account.
const scratch = await temporaryDirectory('account-readiness-probes');
const probe = { quota: false, cacheMs: 0 } as const;
const HOST = 'host-a';

async function observe(name: string, runtime: string, home: string) {
  const registry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: proposedRuntimes.filter(entry => entry.name === runtime), models: [{ name: 'default', id: null }],
    accounts: [{ name, runtime, model: 'default', credential: { host: HOST, home } }], reason: 'fixture',
  }, { actor: 'operator', at: new Date().toISOString() }).registry;
  return (await observeAccount(registry.accounts[0]!, registry.runtimes[0]!, probe, registry.accounts)).quota;
}

test('integration:account-readiness-probes — a cursor account with a signed-in cli-config.json reads logged in', async () => {
  const home = join(scratch, 'cursor-a'); await mkdir(home);
  await writeFile(join(home, 'cli-config.json'), JSON.stringify({ authInfo: { userId: 7, email: 'agent@example.test' } }));
  assert.equal((await checkAgentEnvironment({ name: 'cursor-a', kind: 'cursor', home }, probe)).loggedIn, true);
  assert.equal((await observe('cursor-a', 'cursor', home)).loggedIn, true);
});

test('integration:account-readiness-probes — a claude account with .credentials.json reads logged in', async () => {
  const home = join(scratch, 'claude-c'); await mkdir(home);
  await writeFile(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 } }));
  assert.equal((await observe('claude-c', 'claude', home)).loggedIn, true);
});

test('integration:account-readiness-probes — a home a confined session masks reads unknown there, never logged out', async () => {
  const home = join(scratch, 'claude-masked'); await mkdir(home);
  assert.equal((await observe('claude-masked', 'claude', home)).loggedIn, false, 'outside confinement an empty home is logged out');
  process.env.GRAPHYARD_CONFINEMENT = 'master';
  try {
    assert.equal((await observe('claude-masked', 'claude', home)).loggedIn, null);
    assert.equal((await observe('cursor-masked', 'cursor', home)).loggedIn, null);
  } finally { delete process.env.GRAPHYARD_CONFINEMENT; }
});

test('integration:account-readiness-probes — muse whose login file is missing is held not logged in, naming the path it uses', async () => {
  const said = 'Error: /home/agent/.config/muse/auth.json does not exist; run muse login';
  assert.equal(detectLoggedOut(`starting muse\n${said}\n`), said);
  const now = new Date().toISOString();
  const registry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: proposedRuntimes.filter(entry => entry.name === 'muse'), models: [{ name: 'default', id: null }],
    accounts: [{ name: 'muse-a', runtime: 'muse', model: 'default', credential: { host: HOST, home: null } }],
    roles: [{ name: 'reviewer', accounts: ['muse-a'], concurrency: 1 }], reason: 'fixture',
  }, { actor: 'operator', at: now }).registry;
  foldObservations(registry, { host: HOST, observations: [{ account: 'muse-a', quota: { loggedIn: false, state: 'unknown', usage: [], resetsAt: null, reason: said, session: 'login' } }] }, { actor: 'master', at: now });
  const choice = chooseSession(registry, { role: 'reviewer', host: HOST }, Date.parse(now));
  assert.equal(choice.account, null);
  assert.ok(choice.skipped.some(entry => entry.account === 'muse-a' && entry.reason.includes('muse-a is not logged in') && entry.reason.includes('/.config/muse/auth.json does not exist')), JSON.stringify(choice.skipped));
});
