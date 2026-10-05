import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { checkAgentEnvironment } from '../src/master/environments.js';

// An OpenCode home logged in to Anthropic by OAuth, holding no Z.AI key: Z.AI-specific probing reads it as logged out,
// generic OpenCode probing as logged in, so `loggedIn` shows which way zaiAccount classified the account.
async function anthropicOpencodeHome(label: string) {
  const home = await temporaryDirectory(label);
  await mkdir(join(home, 'opencode'), { recursive: true });
  await writeFile(join(home, 'opencode/auth.json'), JSON.stringify({ anthropic: { type: 'oauth', access: 'access-token', refresh: 'refresh-token' } }));
  return home;
}

test('unit:gy-1239-finding-1 — declaredPlan: undefined on an OpenCode account with derived plan zai is not Z.AI-specific', async () => {
  const home = await anthropicOpencodeHome('gy-1239-declared-undefined');
  const health = await checkAgentEnvironment({ name: 'opencode-a', kind: 'opencode' as any, home, plan: 'zai-a', declaredPlan: undefined }, { quota: false });
  assert.equal(health.loggedIn, true, 'an explicitly undeclared plan must not fall back to the derived zai plan and probe the account as Z.AI');
});

test('unit:gy-1239-finding-1 — an absent declaredPlan falls back to the derived plan', async () => {
  const home = await anthropicOpencodeHome('gy-1239-declared-absent');
  const health = await checkAgentEnvironment({ name: 'opencode-a', kind: 'opencode' as any, home, plan: 'zai-a' }, { quota: false });
  assert.equal(health.loggedIn, false, 'without a declaredPlan key the derived zai plan makes the account Z.AI-specific, and it holds no Z.AI key');
});

test('unit:gy-1239-finding-1 — declaredPlan: null on an OpenCode account with derived plan zai is not Z.AI-specific', async () => {
  const home = await anthropicOpencodeHome('gy-1239-declared-null');
  const health = await checkAgentEnvironment({ name: 'opencode-a', kind: 'opencode' as any, home, plan: 'zai-a', declaredPlan: null }, { quota: false });
  assert.equal(health.loggedIn, true);
});
