import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// GY-1519 AC-8: the Main watch paragraph of docs/recovery.md describes each read route by what it
// actually returns. GET /api/main-watch (src/server/routes/main-watch.ts) answers the policy only:
// the acknowledgements and the direct-merge windows. The unexplained commits live in
// state.mainWatch, which only `graphyard master main-watch status` (src/cli/master/operations.ts)
// prints. The independent review of PR #1016 found the paragraph claiming the route reads them.
const docs = readFileSync(fileURLToPath(new URL('../docs/recovery.md', import.meta.url)), 'utf8');
const paragraph = docs.split(/^## Main watch\s*$/m)[1]?.split(/\n## /)[0]?.trim() ?? '';

test('unit:main-watch-docs-wording — the Main watch paragraph says GET /api/main-watch returns the acknowledgements and direct-merge windows', () => {
  assert.ok(paragraph, 'docs/recovery.md has a Main watch section');
  assert.match(paragraph, /`GET \/api\/main-watch` returns the acknowledgements and direct-merge windows/, 'the route is described by the policy it returns');
  assert.doesNotMatch(paragraph, /Read them with `GET \/api\/main-watch`/, 'the route is not said to read the unexplained commits');
});

test('unit:main-watch-docs-wording — the Main watch paragraph says `graphyard master main-watch status` prints the unexplained commits', () => {
  assert.match(paragraph, /`graphyard master main-watch status` prints the unexplained (main )?commits/, 'the command is the one place the unexplained commits are printed');
  assert.ok(paragraph.split(/\s+/).length <= 60, `at most 60 words: ${paragraph.split(/\s+/).length}`);
});
