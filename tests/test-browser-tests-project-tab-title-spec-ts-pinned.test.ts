import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// GY-3430: browser-tests/project-tab-title.spec.ts failed on the batch gate and passed its re-run. Its trace showed
// the page painting no frame for seconds after sign-in: the dashboard's first render is CPU-bound, and on a loaded
// trial host it ran past the 5 s default wait. Every wait for that first render — after sign-in and after a reload —
// allows the suite's settled 15 s, as the other dashboard specs already do.
test('unit:test-browser-tests-project-tab-title-spec-ts-pinned — every first-render wait in project-tab-title allows the settled time', () => {
  const spec = readFileSync(join(process.cwd(), 'browser-tests/project-tab-title.spec.ts'), 'utf8');
  assert.match(spec, /const settled = \{ timeout: 15_000 \};/, 'the spec names the settled wait');
  const firstRenders = [...spec.matchAll(/await (open\(page\)|page\.reload\(\));\n\s*(.+)/g)];
  assert.ok(firstRenders.length >= 4, `sign-ins and reloads are found: ${firstRenders.length}`);
  // tabNamesTheProject's own first step is that wait.
  assert.match(spec, /async function tabNamesTheProject\(page: Page, repository: string\) \{\n.+\n\s*await expect\(.+, settled\);/);
  for (const [, step, wait] of firstRenders) assert.match(wait!, /^await (expect\(.+, settled\)|tabNamesTheProject\(page, repository\));$/, `the wait after ${step} allows the settled time: ${wait}`);
});
