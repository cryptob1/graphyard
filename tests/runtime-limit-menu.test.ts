import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRuntimePrompt } from '../src/master.js';
import { detectRuntimeExhaustion } from '../src/master/environments.js';
import { parseResetTime } from '../src/model/capacity.js';

// Time-bomb allowance (GY-1694): the 2026-10-09 `now` is explicit and the Oct 10/12 resets carry no year, so parseResetTime rolls them forward past any real Date.now().

// GY-1566: a Claude worker launched onto a spent account printed its limit notice and then its
// usage-limit menu, and sat blocked on it for 32 minutes: Herdr reported the pane blocked, the
// supervisor kept renewing the lease, and nothing failed it over. The menu is now read as the
// account's exhaustion, with the reset time its notice names; the loop never chooses on it — one
// choice spends money, which only a person may do.

/** The screen GY-1565 epoch 3 stood on, as Claude Code drew it. */
const limitMenu = `● Reading GY-1565 before editing.
  ⎿  You've hit your weekly limit · resets Oct 10, 10pm (America/Los_Angeles)

 What do you want to do?

 ❯ 1. Stop and wait for limit to reset
   2. Wait here, then continue automatically at Oct 10, 10pm
   3. Switch to usage credits

 Enter to confirm · Esc to cancel
`;
const notice = "You've hit your weekly limit · resets Oct 10, 10pm (America/Los_Angeles)";
/** The same menu as a later Claude Code draws it (read off a live pane on 2026-10-09): no-break spaces, a rule above, and a funds choice. */
const fundsMenu = `  Ran 1 shell command
  ⎿\u00a0 You've hit your weekly limit\u00a0· resets Oct 12, 3pm (America/Los_Angeles)
     Use your limit reset to reset it now: clau.de/reset

✻ Cogitated for 22s · done 1:10 PM
${'▔'.repeat(80)}
   What do you want to do?

   ❯\u00a01. Stop and wait for limit to reset
     2. Wait here, then continue automatically at Oct 12, 3pm
     3. Add funds to continue with usage credits

   Enter to confirm · Esc to cancel
`;

test('unit:runtime-limit-menu-detected — Claude\'s usage-limit menu is the account\'s exhaustion with its parsed reset, and is never answered', () => {
  const now = Date.parse('2026-10-09T02:49:00Z');
  const prompt = classifyRuntimePrompt(limitMenu, now)!;
  assert.equal(prompt.kind, 'usage-limit');
  assert.equal(prompt.keys, null, 'the loop sends the menu no keys: never "Switch to usage credits"');
  assert.equal(prompt.answer, null);
  assert.match(prompt.text, /What do you want to do\? \/ 1\. Stop and wait for limit to reset/);
  // 10pm in Los Angeles on Oct 10 (PDT, UTC-7), whatever zone the host runs in.
  assert.deepEqual(prompt.exhaustion, { reason: notice, resetsAt: '2026-10-11T05:00:00.000Z' });
  assert.deepEqual(detectRuntimeExhaustion(limitMenu, 'claude', now), prompt.exhaustion, 'the stopped-session judge reads the same menu');
  assert.deepEqual(detectRuntimeExhaustion(limitMenu, undefined, now), prompt.exhaustion, 'whatever runtime the profile names');
  const funds = classifyRuntimePrompt(fundsMenu, now)!;
  assert.equal(funds.kind, 'usage-limit');
  assert.equal(funds.keys, null, 'nor "Add funds to continue with usage credits"');
  assert.equal(funds.exhaustion!.resetsAt, '2026-10-12T22:00:00.000Z', '3pm in Los Angeles on Oct 12');
  assert.match(funds.exhaustion!.reason, /^You've hit your weekly limit/);
  // Drawn in a box, with escapes and its notice behind a label, it is the same menu.
  const boxed = `\u001b[2m⎿ API Error: Claude Code · ${notice}\u001b[0m\n╭────────────╮\n│ What do you want to do?   │\n│ ❯ 1. Stop and wait for limit to reset │\n│   2. Wait here, then continue automatically at Oct 10, 10pm │\n│   3. Switch to usage credits │\n╰────────────╯\n Enter to confirm · Esc to cancel`;
  assert.equal(classifyRuntimePrompt(boxed, now)!.kind, 'usage-limit');
  assert.equal(detectRuntimeExhaustion(boxed, 'claude', now)!.resetsAt, '2026-10-11T05:00:00.000Z');
  // With its notice scrolled away, the wait choice names the reset.
  const bare = limitMenu.replace(/^.*weekly limit.*$/m, '');
  assert.equal(classifyRuntimePrompt(bare, now)!.kind, 'usage-limit');
  assert.equal(classifyRuntimePrompt(bare, now)!.exhaustion!.resetsAt, new Date(2026, 9, 10, 22, 0).toISOString(), 'the wait choice is read in the host\'s zone');
  // A zone-less timestamp beside the zone the notice names is that zone's wall clock, whatever the host's.
  assert.equal(parseResetTime('resets 2026-10-10 22:00 (America/Los_Angeles)', now), '2026-10-11T05:00:00.000Z');
  assert.equal(parseResetTime('resets 2026-10-10 22:00:00Z (America/Los_Angeles)', now), '2026-10-10T22:00:00.000Z', 'an explicit offset wins');

  // An agent's prose about the menu or about a quota is not the menu.
  for (const prose of [
    // The menu's choices quoted in a summary, with prose after them.
    `Options the runtime offers:\n 1. Stop and wait for limit to reset\n 2. Wait here, then continue automatically\n 3. Switch to usage credits\nI will implement the failover next.`,
    // No question directly above the choices.
    `${notice}\n 1. Stop and wait for limit to reset\n 3. Switch to usage credits`,
    // The question, but not the runtime's choices.
    ` What do you want to do?\n ❯ 1. Yes\n   2. No`,
    // The question and its choices quoted bare, as an agent's summary ends, with no notice, cursor or key hint.
    ` What do you want to do?\n 1. Stop and wait for limit to reset\n 2. Wait here, then continue automatically at Oct 10, 10pm\n 3. Switch to usage credits`,
    // The notice, the question and the choices all quoted in an agent's prose: no cursor, no key hint.
    `● Claude prints "${notice}" and then asks:\n What do you want to do?\n 1. Stop and wait for limit to reset\n 2. Wait here, then continue automatically\n 3. Switch to usage credits\n● Writing the fixture next.`,
    // A cursor, but no key hint below.
    ` What do you want to do?\n ❯ 1. Stop and wait for limit to reset\n   2. Wait here, then continue automatically at Oct 10, 10pm`,
    // The stop choice alone.
    ` What do you want to do?\n ❯ 1. Stop and wait for limit to reset\n   2. Something else`,
    '● tmp disk quota is exhausted (a known local issue). Clearing the tsx cache, then rerunning.',
  ]) {
    assert.notEqual(classifyRuntimePrompt(prose, now)?.kind, 'usage-limit', prose);
    if (!prose.includes(notice)) assert.equal(detectRuntimeExhaustion(prose, 'claude', now), null, prose);
  }
});
