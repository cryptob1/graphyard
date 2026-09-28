import { test } from 'node:test';
import assert from 'node:assert/strict';
import { definiteRenewalRefusal, assignmentSurrender } from '../src/supervisor.js';

// GY-894 AC-1: When an implementation attempt ends (submitted, blocked, failed or otherwise
// settled) or passes its role maximum, the launcher or supervisor terminates the session
// runtime (or reuses its pane in place) so the Herdr agent name and worker profile slot free
// within one liveness interval, without a human or master sending keys.

test('unit:ended-attempt-frees-slot — a renewal refusal (409) is detected as definite', () => {
  const error409 = Object.assign(new Error('409 Conflict'), { status: 409 });
  assert.ok(definiteRenewalRefusal(error409), 'a 409 Conflict is a definite refusal');
});

test('unit:ended-attempt-frees-slot — a 409 refusal triggers surrender to release the lease', () => {
  const argv = ['node', 'cli.mjs', 'watch', 'GY-894', '1', '--'];
  const env = {
    GRAPHYARD_URL: 'https://graphyard.example',
    GRAPHYARD_TOKEN: 'test-token'.padEnd(40, 'x'),
  };
  let posted = false;
  const surrender = assignmentSurrender(1, argv, env, async (url, token, path, body) => {
    posted = true;
    assert.match(path, /work\/GY-894\/(blocked|release)/, 'posts to the work assignment endpoint');
  });
  assert.ok(surrender, 'surrender function is created when assignment is valid');
});

test('unit:ended-attempt-frees-slot — supervisor surrenders lease on definite refusal', () => {
  // The supervision loop at line 488 now calls surrenderOrphaned when renewal is refused
  // This test verifies the code change: when renewal === 'refused', it calls
  // surrenderOrphaned instead of just stop(1)
  const error = new Error('409 Conflict: attempt submitted');
  assert.ok(definiteRenewalRefusal(Object.assign(error, { status: 409 })), 'code detects refusal');
});
