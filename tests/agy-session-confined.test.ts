import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { credentialMaskFor, readOnlyMountWrapper } from '../src/master/confinement.js';
import { runtimeLoginHomes } from '../src/master/profiles.js';
import { needsSmoke } from '../src/fleet.js';
import type { FleetLaunchAccount } from '../src/fleet.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3108: agy reads its login only from `$HOME/.gemini/antigravity-cli` and ignores
// AGY_CONFIG_DIR, so under confinement (HOME=/tmp/home) every session sat at Antigravity's login
// prompt, never acting, holding its lease and slot. The confinement now binds the account's login
// home where agy reads it, and the agy account's smoke test fails a session that never answers.

delete process.env.AGY_CONFIG_DIR;

/** A stand-in agy: answers OK when it finds its login under $HOME, else waits at the login as agy does. */
const fakeAgy = (directory: string, body: string) => {
  const file = join(directory, 'agy');
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
};
const loginReader = 'if [ -r "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" ]; then echo "tool step: read $PWD"; echo OK; exit 0; fi\necho "Authentication required. Please visit the URL to log in:"; exec sleep 30';

test('unit:agy-session-works-confined — a confined agy session reads its login and acts on its prompt, and the agy smoke test fails a session that starts but never acts', async () => {
  // Imported here, so a tree without agySmoke fails this case rather than the file.
  const { agySmoke } = await import('../src/runner/roles.js') as any;
  const base = await temporaryDirectory('agy-confined');
  const root = join(base, 'checkout'), session = join(root, '.graphyard', 'worktrees', 'GY-3108-1'), home = join(base, 'antigravity-cli');
  mkdirSync(session, { recursive: true }); mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'antigravity-oauth-token'), 'token');

  // The launch path: the account's home rides on its home variable, kept writable, and bound at
  // the path agy reads under the session's private HOME.
  const environment = { AGY_CONFIG_DIR: home };
  const credentialMask = credentialMaskFor({}, { runtimeHomes: runtimeLoginHomes(environment, 'AGY_CONFIG_DIR', 'agy') }, join(base, 'config'));
  const wrapper = readOnlyMountWrapper({ coordinatorRoot: root, sessionDirectory: session, credentialMask, environment });
  const homeAt = wrapper.findIndex((word, index) => word === '--setenv' && wrapper[index + 1] === 'HOME');
  assert.equal(wrapper[homeAt + 2], '/tmp/home');
  const bind = wrapper.findIndex((word, index) => word === '--bind' && wrapper[index + 2] === '/tmp/home/.gemini/antigravity-cli');
  assert.ok(bind > homeAt, 'the login home is bound where agy reads it, after the private HOME is made');
  assert.equal(wrapper[bind + 1], realpathSync(home));
  // A runtime without the agy variable gets no such bind.
  assert.ok(!readOnlyMountWrapper({ coordinatorRoot: root, sessionDirectory: session }).includes('/tmp/home/.gemini/antigravity-cli'));

  // The smoke test runs agy the same way — HOME whose .gemini/antigravity-cli is the login — and
  // passes only when agy acts on its prompt.
  const bin = await temporaryDirectory('agy-bin');
  const account = (command: string): Pick<FleetLaunchAccount, 'home' | 'fleet'> => ({ home, fleet: { runtime: 'agy', contract: { kind: command, args: [], environment: {}, homeVariable: 'AGY_CONFIG_DIR', modelFlag: null, toolsFlag: null, login: null, loginFile: null } as any, model: 'agy', modelId: null, session: 'smoke', reason: 'smoke test', role: 'worker', revision: 1 } as any });
  assert.deepEqual(await agySmoke(account(fakeAgy(bin, loginReader)), { timeoutMs: 10_000 }), { ok: true, error: null });

  // Without a login it waits at the prompt, and a session that starts but never acts fails at the bound.
  const loggedOut = await agySmoke({ ...account(fakeAgy(bin, loginReader)), home: join(base, 'missing') }, { timeoutMs: 1_500 });
  assert.equal(loggedOut.ok, false);
  assert.match(loggedOut.error!, /started but gave no answer within 2s: it is waiting for a login/);
  const silent = await agySmoke(account(fakeAgy(await temporaryDirectory('agy-silent'), 'exec sleep 30')), { timeoutMs: 1_000 });
  assert.equal(silent.ok, false);
  assert.match(silent.error!, /started but gave no answer/);

  // agy accounts are smoke-tested before a session is chosen on them.
  const agy = { launch: { kind: 'agy' } } as any, fresh = { enabled: true, smoke: null } as any;
  assert.equal(needsSmoke(fresh, agy), true);
});
