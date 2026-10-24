import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { detectRuntimeExhaustion } from '../src/master/environments.js';
import { accountHeldForRole, providerLimit, zaiRateLimitHoldMs } from '../src/model/capacity.js';
import { masterConfigSchema, observedExhaustions, recordObservedExhaustion, selectAccount, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2943: a pi worker on Z.AI stopped on `Error: 429: {"code":"1302","message":"Rate limit reached
// for requests"}` and sat idle while its supervisor renewed the lease, because no capacity notice
// was read and no account was held. The notice is its provider saying the account is spent: the
// envelope (never the bare phrase an agent may write about a rate limit) is a limit signal, and —
// the notice naming no reset — the account is held for the default 15 minutes, so the fleet's next
// selection fails over.

/** The pane the incident ended on: the provider's answer, then pi giving up. Herdr read the session idle. */
const limitError = 'Error: 429: {"code":"1302","message":"Rate limit reached for requests"}';
const piPane = `● Reading GY-31 before editing.
  ⎿ Read 40 lines

${limitError}
Retry failed after 3 attempts: 429 …
`;
/** The fixed clock the parsers are handed (GY-1694): 2026-10-24T01:40:00Z as a millisecond epoch. */
const now = Date.parse('2026-10-24T01:40:00Z');

test('unit:zai-rate-limit-is-a-limit-notice — Z.AI\'s 429 "Rate limit reached" envelope is a limit signal held 15 minutes, and the fleet\'s next selection skips the account', async () => {
  const signal = detectRuntimeExhaustion(piPane, 'pi', now);
  assert.ok(signal, 'the 1302 envelope is an exhaustion');
  assert.match(signal.reason, /Rate limit reached for requests/, 'the notice is the reason');
  assert.equal(signal.resetsAt, new Date(now + zaiRateLimitHoldMs).toISOString(), 'the notice names no reset, so the account is held the default 15 minutes');
  assert.ok(Date.parse(signal.resetsAt!) >= now + 15 * 60_000, 'the reset is no earlier than 15 minutes ahead');
  // The headless path's parser carries the same signal for the same text.
  const headless = providerLimit(limitError, now);
  assert.ok(headless, 'the 429 envelope is a limit in a headless error too');
  assert.equal(headless.resetsAt, signal.resetsAt);
  // The bare phrase an agent may write about a rate limit is prose, never the envelope: unknown reset.
  assert.equal(detectRuntimeExhaustion('Rate limit reached for requests', 'codex', now)?.resetsAt, null);
  assert.equal(detectRuntimeExhaustion('I hit the rate limit reached case in the parser tests', 'pi', now), null);
  assert.equal(providerLimit('Error: 429: {"error":"the request id 42913 mentioned the rate limit"}', now)?.resetsAt, null, 'a 429 with no rate-limit envelope keeps its unknown reset');

  // The account the notice spent is held for the fleet's next selection: recorded with the signal's
  // reset, selection fails over to the healthy account and refuses the held one outright.
  const root = await temporaryDirectory('zai-rate-limit');
  const credentialFile = join(root, 'coordinator.token');
  await writeFile(credentialFile, 't'.repeat(40), { mode: 0o600 });
  for (const name of ['pi-a', 'pi-b']) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'x' } }));
  }
  const worker = (accounts: string[]) => ({ name: 'builder', principal: 'worker-a', agentName: 'agent-builder', mode: 'launch', kind: 'claude', credentialFile: join(root, 'builder.token'), accounts }) as unknown as WorkerProfile;
  const config = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile, cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1, hostId: 'machine-a', masterAgentName: 'gy-master', workers: [worker(['pi-a', 'pi-b'])],
    environments: [{ name: 'pi-a', kind: 'claude', home: join(root, 'pi-a') }, { name: 'pi-b', kind: 'claude', home: join(root, 'pi-b') }],
  }) as MasterConfig;
  await recordObservedExhaustion(config, 'pi-a', { at: new Date(now).toISOString(), resetsAt: signal.resetsAt, reason: signal.reason, role: 'worker', profile: 'builder', work: 'GY-31' }, now);
  const held = await observedExhaustions(config, now);
  assert.equal(accountHeldForRole(held, 'pi-a', now), true, 'the account is held while its reset is ahead');
  assert.equal(accountHeldForRole(held, 'pi-b', now), false);
  assert.equal(accountHeldForRole(held, 'pi-a', Date.parse(signal.resetsAt!) + 1), false, 'after the 15-minute reset the account is free again');
  const chosen = await selectAccount(config, 'worker', config.workers[0], { quota: false, now: () => now, cacheMs: 0, work: 'GY-31' });
  assert.equal(chosen.account?.name, 'pi-b', "the fleet's next selection fails over to the healthy account");
  const solo = masterConfigSchema.parse({ ...config, workers: [worker(['pi-a'])] }) as MasterConfig;
  await assert.rejects(selectAccount(solo, 'worker', solo.workers[0], { quota: false, now: () => now, cacheMs: 0, work: 'GY-31' }), /exhausted its quota mid-session/, 'a profile with only the held account waits for its reset');
});
