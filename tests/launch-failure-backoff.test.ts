import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchFailureFixture } from './helpers/launch-failure-fixture.js';

// GY-3413: a work item whose worker launch keeps failing with one reason stops relaunching and
// appears in master status attention with that reason, instead of a fresh epoch every cycle.
test('e2e:launch-failure-backoff — a launch that keeps failing with one reason stops relaunching and master status attention names it', async () => {
  const f = await launchFailureFixture();
  for (let at = 0; at <= 120_000; at += 8_000) await f.cycle(at);
  assert.equal(f.launches(), 2, `two failed launches, then none for two minutes of 8 s cycles; got ${f.launches()}`);
  const status = await f.status(120_000);
  const line = status.attention.find((entry: { subject?: string }) => entry.subject === 'GY-1');
  assert.ok(line, `master status attention carries the item: ${JSON.stringify(status.attention)}`);
  assert.ok(line.text.includes('Submitted workspace branch is missing'), line.text);
});
