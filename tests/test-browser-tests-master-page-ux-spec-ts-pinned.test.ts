import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// GY-3368: e2e:master-page-ux failed on the batch gate and passed its re-run. Two causes:
// - a reconnect attempt that failed while the page was offline checked /api/status after the network
//   returned, got 200 and took the failure for a refusal: the terminal stopped retrying for good
//   ("refused: Not available…", reproduced 2 runs in 64 under 16 workers). The page now makes one more
//   attempt before it calls a failed socket refused.
// - the spec sampled data-terminal="reconnecting", a state held for one 250 ms retry delay, between
//   expect's 100/350/850 ms polls. The page records every state it enters and the spec counts there.
test('unit:test-browser-tests-master-page-ux-spec-ts-pinned — a socket that failed offline is retried before it is called refused, and master-page-ux reads recorded terminal states', () => {
  const terminal = readFileSync('web/components/live-terminal.tsx', 'utf8');
  const refusal = terminal.indexOf("setReason('Not available: sign in, and check the session still has a pane.')");
  assert.ok(refusal > 0, 'the live terminal still refuses an unavailable pane');
  assert.match(terminal.slice(0, refusal), /if \(response && response\.status < 500\) \{[\s\S]*if \(!doubted\) \{ doubted = true; connect\(\); return; \}\s*$/, 'one more attempt runs before a failed socket is called refused');
  assert.match(terminal, /socket\.onopen = \(\) => \{ opened = true; doubted = false; \};/, 'an opened socket clears the doubt, so a later refusal again gets its retry');

  const spec = readFileSync('browser-tests/master-page-ux.spec.ts', 'utf8');
  assert.doesNotMatch(spec, /toHaveAttribute\('data-terminal', 'reconnecting'\)/, 'no single sample of the 250 ms reconnecting state');
  assert.match(spec, /new MutationObserver\([\s\S]*attributeFilter: \['data-terminal'\]/, 'every data-terminal change is recorded from page load');
  const drops = spec.split("f.child.send('drop-terminals');").slice(1, 3);
  assert.equal(drops.length, 2, 'both reconnecting drops are found');
  drops.forEach((after, index) => assert.ok(after.trimStart().startsWith(`await expect.poll(f.reconnects).toBe(${index + 1});`), `drop ${index + 1} waits for reconnect ${index + 1} in the record`));
});
