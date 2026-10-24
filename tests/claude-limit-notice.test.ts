import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { detectRuntimeExhaustion } from '../src/master/environments.js';
import { accountHeldForRole, providerLimit } from '../src/model/capacity.js';
import { masterConfigSchema, observedExhaustions, recordObservedExhaustion, selectAccount, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2962: Claude sessions stopped on the newer limit wordings and sat idle under live leases,
// because the loop's limit handling knew neither phrasing's hold: `You've hit your session limit ·
// resets 1:30am (America/Los_Angeles)` and `You've reached your Fable limit. Run /usage-credits to
// continue or switch models with /model.` (and the usage wording beside them). Each is its provider
// saying the account is spent: the session limit carries the parsed 1:30am local as its reset, the
// session and usage wordings with no readable reset are held the default 6 hours, and the Fable
// wording — which names no reset at all — until the next 08:00 local, so the fleet's next selection
// fails over instead of asking the spent account again.
// The new hold is imported inside the test, so an exercise against the base fails it as a test case (GY-2947).

/** The pane lines the four incidents ended on (GY-2962): the notices as Claude prints them. */
const sessionWithReset = 'You\'ve hit your session limit · resets 1:30am (America/Los_Angeles)';
const sessionBare = 'You\'ve hit your session limit';
const usageBare = 'You\'ve hit your usage limit';
const fable = 'You\'ve reached your Fable limit. Run /usage-credits to continue or switch models with /model.';
/** The fixed clock the parsers are handed (GY-1694): the 06:51Z incident, before the 1:30am America/Los_Angeles reset. */
const now = Date.parse('2026-10-24T06:51:00Z');

test('unit:claude-limit-wordings-recognised — Claude\'s session, usage and Fable limit wordings are limit signals with the expected resets, and the account is held in the fleet\'s next selection', async () => {
  const { claudeSessionLimitHoldMs } = await import('../src/model/capacity.js');
  // The session limit's own reset: 1:30am America/Los_Angeles read in that zone (PDT, UTC-7).
  const session = detectRuntimeExhaustion(`${sessionWithReset}\n`, 'claude', now);
  assert.ok(session, 'the session limit wording is an exhaustion');
  assert.match(session.reason, /session limit/);
  assert.equal(session.resetsAt, '2026-10-24T08:30:00.000Z', 'the parsed 1:30am America/Los_Angeles reset is the hold');
  // The session and usage wordings with no readable reset take the default 6-hour hold.
  const bare = detectRuntimeExhaustion(`${sessionBare}\n`, 'claude', now);
  assert.ok(bare, 'the bare session limit wording is an exhaustion');
  assert.equal(bare.resetsAt, new Date(now + claudeSessionLimitHoldMs).toISOString(), 'no reset in the text holds the account the default 6 hours');
  const usage = providerLimit(usageBare, now);
  assert.ok(usage, 'the usage limit wording is a limit in a headless error too');
  assert.equal(usage.resetsAt, new Date(now + claudeSessionLimitHoldMs).toISOString(), 'the usage wording with no reset takes the same default 6 hours');
  // The Fable wording names no reset: the account is held until the next 08:00 local.
  const fableSignal = detectRuntimeExhaustion(`${fable}\n`, 'claude', now);
  assert.ok(fableSignal, 'the Fable limit wording is an exhaustion');
  assert.match(fableSignal.reason, /Fable limit/);
  assert.ok(Date.parse(fableSignal.resetsAt!) > now, 'the Fable hold is ahead of the notice');
  assert.equal(new Intl.DateTimeFormat('en-US', { hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(Date.parse(fableSignal.resetsAt!)), '08:00', 'the Fable hold lands on the next 08:00 local');
  // The headless path's parser carries the same signals for the same texts.
  assert.equal(providerLimit(sessionWithReset, now)?.resetsAt, session.resetsAt);
  assert.equal(providerLimit(fable, now)?.resetsAt, fableSignal.resetsAt);
  // An agent's prose about a limit is not the banner: unknown reset, as before (GY-2943).
  assert.equal(providerLimit('the worker wrote: you have hit your session limit, it thinks', now)?.resetsAt, null);

  // The account the notice spent is held for the fleet's next selection: recorded with the Fable
  // signal's reset, selection fails over to the healthy account and refuses the held one outright.
  const root = await temporaryDirectory('claude-limit-notice');
  const credentialFile = join(root, 'coordinator.token');
  await writeFile(credentialFile, 't'.repeat(40), { mode: 0o600 });
  for (const name of ['claude-a', 'claude-b']) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'x' } }));
  }
  const worker = (accounts: string[]) => ({ name: 'builder', principal: 'worker-a', agentName: 'agent-builder', mode: 'launch', kind: 'claude', credentialFile: join(root, 'builder.token'), accounts }) as unknown as WorkerProfile;
  const config = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile, cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1, hostId: 'machine-a', masterAgentName: 'gy-master', workers: [worker(['claude-a', 'claude-b'])],
    environments: [{ name: 'claude-a', kind: 'claude', home: join(root, 'claude-a') }, { name: 'claude-b', kind: 'claude', home: join(root, 'claude-b') }],
  }) as MasterConfig;
  await recordObservedExhaustion(config, 'claude-a', { at: new Date(now).toISOString(), resetsAt: fableSignal.resetsAt, reason: fableSignal.reason, role: 'worker', profile: 'builder', work: 'GY-48' }, now);
  const held = await observedExhaustions(config, now);
  assert.equal(accountHeldForRole(held, 'claude-a', now), true, 'the account is held while its reset is ahead');
  assert.equal(accountHeldForRole(held, 'claude-b', now), false);
  const chosen = await selectAccount(config, 'worker', config.workers[0], { quota: false, now: () => now, cacheMs: 0, work: 'GY-48' });
  assert.equal(chosen.account?.name, 'claude-b', "the fleet's next selection fails over to the healthy account");
  const solo = masterConfigSchema.parse({ ...config, workers: [worker(['claude-a'])] }) as MasterConfig;
  await assert.rejects(selectAccount(solo, 'worker', solo.workers[0], { quota: false, now: () => now, cacheMs: 0, work: 'GY-48' }), /exhausted its quota mid-session/, 'a profile with only the held account waits for its reset');
});
