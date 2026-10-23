import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRuntimeExhaustion, providerLimitNotices } from '../src/master/environments.js';
// Time-bomb allowance (GY-1694): the 2026-09-26 and 2026-10-03 instants are the fixed now handed to detectRuntimeExhaustion and the resets it parses from notices.

// GY-421: mid-session exhaustion is recognized only from the runtime's own provider-authored
// limit notice. GY-402's epoch 2 was failed over on the worker's own narration — "tmp disk
// quota is exhausted (a known local issue)…" — while claude-c had 86% of its 5-hour window left:
// a generic quota-exhausted pattern had matched the prose about a disk. A session's output is
// judged against its runtime's own provider limit messages (the catalogs in
// src/master/environments.ts), and a worker that writes "quota" about anything is working, not
// exhausted. Each test is named for the proof it produces.

// The transcript the incident turned on: the worker's own narration of a /tmp disk quota, which
// the generic patterns of the time matched as a provider limit notice.
const gy402Transcript = `● Update(src/daemon/cycle-sessions.ts)
  ⎿ tmp disk quota is exhausted (a known local issue). Clearing the tsx cache, as the memory note recommends, then rerunning.
`;

test('unit:exhaustion-only-provider-notice: only the runtime\'s own provider limit notice is an exhaustion, and the agent\'s prose about a quota never is', () => {
  const now = Date.parse('2026-09-26T02:00:00Z');
  // Free text an agent writes about a quota — a disk's, a summary's — is a failover on nothing.
  for (const prose of [
    gy402Transcript,
    'The /tmp quota is exhausted on this box; I cleared the cache and will rerun.',
    'we are out of quota on the disk, cleaning up now',
    'GY-89: escalate once when every account quota is exhausted',
    'Added a test for the rate limit reached path',
    'Done: the dispatcher now waits when the usage limit is reached.',
    'Error: I fixed the rate limit reached bug and updated the docs',
  ]) for (const runtime of ['claude', 'codex', 'opencode', 'cursor', undefined]) {
    assert.equal(detectRuntimeExhaustion(prose, runtime, now), null, `${runtime ?? 'unnamed'}: ${prose}`);
  }
  // The provider-authored notices, per runtime, with the reset time each names.
  assert.deepEqual(detectRuntimeExhaustion("⎿ You've hit your usage limit · resets 2026-10-01T00:00:00Z\n", 'claude', now),
    { reason: "You've hit your usage limit · resets 2026-10-01T00:00:00Z", resetsAt: '2026-10-01T00:00:00.000Z' });
  assert.equal(detectRuntimeExhaustion('Claude AI usage limit reached|1790409600', 'claude', now)!.resetsAt, new Date(1790409600_000).toISOString());
  assert.equal(detectRuntimeExhaustion("You've reached your usage limit for Codex. It resets 2026-10-02T00:00:00Z", 'codex', now)!.resetsAt, '2026-10-02T00:00:00.000Z');
  assert.equal(detectRuntimeExhaustion('Error: Weekly usage limit reached for GLM Coding Plan.\nYour quota will reset at 2026-09-26 08:30:00 UTC', 'opencode', now)!.resetsAt, '2026-09-26T08:30:00.000Z');
  assert.ok(detectRuntimeExhaustion("You've reached your spend limit for this billing cycle. It resets on 10/8.", 'cursor', now), 'a cursor spend limit is its provider\'s notice');
  const api429 = detectRuntimeExhaustion('Rate limit reached for requests', 'codex', now);
  assert.ok(api429, 'a notice that names no time is still an exhaustion');
  assert.equal(api429.resetsAt, null, 'it records an unknown reset rather than a guess');
  // A runtime with no catalog of its own is judged against the provider APIs' shared usage errors,
  // behind the severity label every runtime draws in front of them.
  assert.ok(detectRuntimeExhaustion('Error code: 429 - You exceeded your current quota, please check your plan and billing details.', 'gemini', now), 'the provider API\'s usage error is a notice on any runtime');
  assert.equal(detectRuntimeExhaustion(gy402Transcript, 'gemini', now), null, 'the shared provider errors never match the agent\'s own prose either');
});

// GY-1135: the tail every agy session ended on when the account ran out of quota on 2026-10-03,
// with the Error ID line and the prompt chrome agy draws beneath it.
const agyQuotaTail = `● Read(src/master/environments.ts)
  ⎿ Read 693 lines

⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h31m31s.
Error ID: d4cc65e4-8b0a-404d-9aca-a0fbf11c691c-5

╭──────────────────────────────────────────────────────────────╮
│ >                                                            │
╰──────────────────────────────────────────────────────────────╯
  ? for shortcuts                                  agy · gemini
`;

test('unit:agy-quota-notice-detected — agy\'s "Individual quota reached" notice is its provider saying the account is spent, with the reset it names', () => {
  const now = Date.parse('2026-10-03T04:45:00Z');
  const signal = detectRuntimeExhaustion(agyQuotaTail, 'agy', now);
  assert.ok(signal, 'the agy quota notice is an exhaustion');
  assert.equal(signal.reason, 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h31m31s.');
  assert.equal(signal.resetsAt, new Date(now + (3600 + 31 * 60 + 31) * 1000).toISOString(), 'the reset is 1h31m31s after the observation');
  assert.equal(signal.resetsAt, '2026-10-03T06:16:31.000Z');
  assert.ok(providerLimitNotices.agy, 'agy has its own entry in the catalogs');
  // An agent's prose about a quota, on agy, is still work, not a failover.
  for (const prose of [
    gy402Transcript,
    'I added detection for the Individual quota reached notice; resets in 1h are parsed now.',
    'Done: when the individual quota reached banner appears, the loop holds the account. Please upgrade your subscription tests pass.',
    'Individual quota reached handling is covered by tests',
  ]) assert.equal(detectRuntimeExhaustion(prose, 'agy', now), null, prose);
});
