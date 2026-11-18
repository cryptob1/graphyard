import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// GY-3442: the batch gate's check test:browser-tests/night-yard-theme.spec.ts failed once and passed its
// re-run. Traces under load showed the runner starved for seconds between steps: its press('w') landed
// 2.5 s after press('g'), past the g w chord's two-second window, so the page stayed on Master; and after
// the reload its own route handlers answered the first reads 4 s late, past the default 5 s wait. The spec
// returns to Work by the sidebar (keyboard-palette.spec.ts proves g w) and waits 15 s after each page load.
test('unit:test-browser-tests-night-yard-theme-spec-ts-pinned — the theme spec takes no timed key chord and waits out a loaded runner after each page load', () => {
  const spec = readFileSync('browser-tests/night-yard-theme.spec.ts', 'utf8');
  assert.doesNotMatch(spec, /keyboard\.press\('g'\)/, 'no g w chord: a starved runner can land the second key past its window');
  assert.match(spec, /getByRole\('navigation', \{ name: 'Primary' \}\)\.getByRole\('button', \{ name: 'Work', exact: true \}\)\.click\(\)/, 'the spec returns to Work by the sidebar');
  assert.match(spec, /const live = \{ timeout: 15_000 \}/);
  const work = "getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible";
  assert.ok(spec.includes(`click();\n  await expect(page.${work}(live)`), 'the sign-in load waits with the live timeout');
  assert.ok(spec.includes(`reload();\n  await expect(page.${work}(live)`), 'the reload waits with the live timeout');
});
