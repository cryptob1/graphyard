import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { checkAgentEnvironment } from '../src/master/environments.js';

test('manual:review-followups-triaged GY-1159.5: OpenCode accounts configured for non-Z.AI providers do not probe api.z.ai or leak non-Z.AI credentials (Finding 8)', async () => {
  const directory = await temporaryDirectory('gy-1159-zai-probe');
  const home = join(directory, 'opencode-home');
  await mkdir(home, { recursive: true });

  // 1. Configure OpenRouter credentials in a key file and where OpenCode stores provider logins
  const openrouterKey = 'sk-or-v1-super-secret-openrouter-key-12345';
  await writeFile(join(home, 'openrouter.key'), openrouterKey);
  await writeFile(join(home, 'auth.json'), JSON.stringify({ key: openrouterKey }));
  await mkdir(join(home, 'opencode'), { recursive: true });
  await writeFile(join(home, 'opencode', 'auth.json'), JSON.stringify({ openrouter: { type: 'api', key: openrouterKey } }));

  let fetchCalls: { url: string; headers: Record<string, string> }[] = [];
  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), headers: (init?.headers as Record<string, string>) ?? {} });
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, msg: 'success', data: { limits: [] } }),
      text: async () => '{"code":0}',
    } as any;
  }) as unknown as typeof fetch;

  // Case A: OpenCode environment with plan 'openrouter' and keyFile 'openrouter.key'
  const nonZaiEnv = {
    name: 'opencode-openrouter',
    kind: 'opencode' as const,
    home,
    plan: 'openrouter',
    keyFile: 'openrouter.key',
  };

  const health = await checkAgentEnvironment(nonZaiEnv as any, { fetch: mockFetch });
  assert.equal(health.loggedIn, true, 'account with auth.json/key file is recognized as logged in');
  assert.equal(fetchCalls.length, 0, 'mockFetch to api.z.ai must NEVER be called for non-Z.AI plan');
  assert.ok(health.note?.includes('OpenCode exposes no provider quota Graphyard can read'), 'note indicates provider reports limits in session');

  // Case B: OpenCode environment with keyVariable 'OPENROUTER_API_KEY'
  const nonZaiEnvVar = {
    name: 'opencode-var',
    kind: 'opencode' as const,
    home,
    keyVariable: 'OPENROUTER_API_KEY',
  };

  fetchCalls = [];
  const healthVar = await checkAgentEnvironment(nonZaiEnvVar as any, { fetch: mockFetch });
  assert.equal(fetchCalls.length, 0, 'mockFetch to api.z.ai must NEVER be called when keyVariable is non-Z.AI');

  // Case C: Z.AI environment with zai.key
  const zaiHome = join(directory, 'zai-home');
  await mkdir(zaiHome, { recursive: true });
  const zaiKey = 'zai-api-key-test-abc';
  await writeFile(join(zaiHome, 'zai.key'), zaiKey);

  fetchCalls = [];
  const zaiEnv = {
    name: 'opencode-zai',
    kind: 'opencode' as const,
    home: zaiHome,
    plan: 'zai',
  };

  const zaiHealth = await checkAgentEnvironment(zaiEnv as any, { fetch: mockFetch });
  assert.equal(zaiHealth.loggedIn, true);
  assert.equal(fetchCalls.length, 1, 'mockFetch to api.z.ai IS called for Z.AI account');
  assert.ok(fetchCalls[0].url.includes('api.z.ai'), 'fetch target is api.z.ai');
  assert.equal(fetchCalls[0].headers.Authorization, `Bearer ${zaiKey}`, 'fetch Authorization header sends Z.AI key');
});
