import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FleetLaunchAccount } from '../src/fleet.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3338: agy's hourly smoke test failed for over an hour with "mkdir
// /tmp/graphyard-agy-smoke-*/.gemini/antigravity-cli: file exists" — the harness's scratch home,
// not the account. Each smoke test now starts from a clean home of its own and removes it after.

delete process.env.AGY_CONFIG_DIR;

test('e2e:smoke-test-clean-home — two smoke tests of one account in a row both pass over a leftover smoke home, and none remains', async () => {
  const { agySmoke } = await import('../src/runner/roles.js');
  const scratch = await temporaryDirectory('smoke-clean-home');
  const tmp = join(scratch, 'tmp'), login = join(scratch, 'agy-1'), bin = join(scratch, 'bin');
  for (const directory of [tmp, login, bin]) mkdirSync(directory);
  writeFileSync(join(login, 'antigravity-oauth-token'), 'token');
  // A stand-in agy that, like the real one, creates its config directory on start and fails on one that is in its way.
  const agy = join(bin, 'agy');
  writeFileSync(agy, '#!/bin/sh\nset -e\nmkdir -p "$HOME/.gemini/antigravity-cli"\n[ -r "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" ] || { echo "Authentication required."; exit 1; }\necho OK\n');
  chmodSync(agy, 0o755);
  const account: Pick<FleetLaunchAccount, 'name' | 'home' | 'fleet'> = { name: 'agy-1', home: login, fleet: { runtime: 'agy', contract: { kind: agy, args: [], environment: {}, homeVariable: 'AGY_CONFIG_DIR', modelFlag: null, toolsFlag: null, login: null, loginFile: null } as any, model: 'agy', modelId: null, session: 'smoke', reason: 'smoke test', role: 'worker', revision: 1 } as any };

  const previous = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  try {
    // An interrupted earlier test of this account left its smoke home behind, with the config directory agy made in it.
    mkdirSync(join(tmp, 'graphyard-agy-smoke-agy-1', '.gemini', 'antigravity-cli'), { recursive: true });
    assert.deepEqual(await agySmoke(account, { timeoutMs: 10_000 }), { ok: true, error: null });
    assert.deepEqual(await agySmoke(account, { timeoutMs: 10_000 }), { ok: true, error: null });
    assert.deepEqual(readdirSync(tmp).filter(name => name.startsWith('graphyard-agy-smoke-')), [], 'no smoke home remains');
  } finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
});
