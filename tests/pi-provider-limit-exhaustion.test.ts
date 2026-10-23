import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRuntimeExhaustion, providerLimitNotices } from '../src/master/environments.js';

// GY-1817: a pi worker whose provider answered `429 code 1310 Weekly/Monthly Limit Exhausted`
// was read as ordinarily idle. pi now has its own entry in the provider limit catalogs, and its
// zone-less reset wall clock is read in UTC: the provider names no zone, so the hold must not drift
// by whatever offset the loop host sits in.

// The 2026-10-15 and 2026-10-17 instants are the observed incident's fixed clock, handed in whole —
// neither Date.now() nor new Date() is read anywhere in this file.

/** The pane GY-1816 epoch 1 ended on (2026-10-15T00:26Z): the provider's answer, then pi giving up. Herdr read the session idle. */
const limitError = 'Error: 429: {"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-17 08:27:35"}';
const piPane = `● Reading GY-1816 before editing.
  ⎿ Read 40 lines

${limitError}
Retry failed after 3 attempts
`;
/** 2026-10-15T01:10:00Z, the instant the notice was read. */
const observedAt = Date.parse('2026-10-15T01:10:00Z');
/** 2026-10-17T08:27:35Z, the reset the notice names, read in UTC: 55h17m35s after the fixed clock. */
const resetAt = new Date(observedAt + ((55 * 60 + 17) * 60 + 35) * 1000).toISOString();

test('unit:pi-provider-limit-exhaustion — pi\'s 429 code 1310 "Weekly/Monthly Limit Exhausted" is its provider saying the account is spent, and its zone-less reset is read in UTC', () => {
  // The loop host is not in the provider's zone: the reset must not drift by the host's offset.
  const zone = process.env.TZ;
  process.env.TZ = 'Asia/Kolkata';
  try {
    const at = Date.parse('2026-10-15T01:10:00Z');
    const signal = detectRuntimeExhaustion(piPane, 'pi', at);
    assert.ok(signal, 'the 1310 notice is an exhaustion');
    assert.equal(signal.reason, '{"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-17 08:27:35"}', 'the notice, behind the runtime\'s own Error label, is the reason');
    assert.equal(signal.resetsAt, resetAt, 'the provider named no zone, so the reset wall clock is read in UTC, not the host\'s');
    // A zone the provider did name is kept, not overwritten by the UTC default.
    const zoned = detectRuntimeExhaustion(piPane.replace('08:27:35"', '08:27:35 UTC"'), 'pi', at);
    assert.equal(zoned?.resetsAt, resetAt, 'an explicit zone survives the UTC default');
    // A zone the provider names in parentheses is that zone's wall clock: 08:27:35 PDT is 15:27:35Z, not 08:27:35Z.
    const named = detectRuntimeExhaustion(piPane.replace('08:27:35"', '08:27:35 (America/Los_Angeles)"'), 'pi', at);
    assert.equal(named?.resetsAt, '2026-10-17T15:27:35.000Z', 'a parenthesized named zone survives the UTC default');
    assert.ok(providerLimitNotices.pi, 'pi has its own entry in the catalogs');
    // Another runtime's catalog does not read pi's banner.
    assert.equal(detectRuntimeExhaustion(piPane, 'claude', at), null, 'the notice is pi\'s catalog, not Claude\'s');
    assert.equal(detectRuntimeExhaustion(piPane, 'codex', at), null, 'the notice is pi\'s catalog, not the shared provider errors');
    // An agent's prose about the limit is work, not a failover (GY-421).
    for (const prose of [
      'Tests pass; the weekly limit exhausted branch is covered.',
      'Handled the case where the Weekly/Monthly Limit Exhausted banner is on screen',
      // The bare phrase leading an agent's own line is not the provider's envelope.
      'Weekly/Monthly Limit Exhausted handling is now covered',
      '  ⎿ tmp disk quota is exhausted (a known local issue). Clearing the tsx cache, then rerunning.',
      'The 429 code 1310 handling resets at 2026-10-17 08:27:35 in the test I just added',
    ]) assert.equal(detectRuntimeExhaustion(prose, 'pi', at), null, prose);
  } finally { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; }
});
