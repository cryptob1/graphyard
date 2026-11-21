import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// GY-3477: browser-tests/change-priority.spec.ts failed on the batch gate at 182ee71a1449 and passed its re-run.
// The Work page polls /api through the spec's page.route proxy for as long as the page lives. The spec closed
// its fixture server and Postgres store while that proxy was still routed, so on a loaded host a poll in
// flight at that instant had its route.fetch reject after the test returned, and the Playwright worker died
// (exit code 7, GY-3555). The proxy is now removed, ignoring a fetch already in flight, before the server closes.
test('unit:test-browser-tests-change-priority-spec-ts-pinned — the spec unroutes its API proxy before it closes the fixture server', () => {
  const spec = readFileSync(join(process.cwd(), 'browser-tests/change-priority.spec.ts'), 'utf8');
  assert.match(spec, /await page\.route\('\*\*\/api\/\*\*'/, 'the spec proxies /api to its fixture server');
  const start = spec.lastIndexOf('} finally {');
  assert.ok(start >= 0, 'the spec tears down in a finally block');
  const teardown = spec.slice(start);
  const unroute = teardown.indexOf("await page.unrouteAll({ behavior: 'ignoreErrors' });"), close = teardown.indexOf('await f.close();');
  assert.ok(close >= 0, 'the teardown closes the fixture server');
  assert.ok(unroute >= 0 && unroute < close, 'the proxy is removed, ignoring an in-flight fetch, before the fixture server closes');
});
