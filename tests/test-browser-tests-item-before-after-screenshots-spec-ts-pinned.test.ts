import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// GY-3391: the batch gate's check test:browser-tests/item-before-after-screenshots.spec.ts failed once
// and passed its re-run. The item page renders each screenshot's img as soon as its blob URL is set,
// and the spec read naturalWidth right after the two imgs appeared — before a slow host had loaded
// them, so a width of 0 failed the test. The spec now decodes every image before it reads its width.
test('unit:test-browser-tests-item-before-after-screenshots-spec-ts-pinned — the spec decodes each screenshot before it reads its width', () => {
  const spec = readFileSync('browser-tests/item-before-after-screenshots.spec.ts', 'utf8');
  const read = spec.indexOf('image.naturalWidth');
  assert.ok(read > 0, 'the spec reads each screenshot\'s natural width');
  const decoded = spec.lastIndexOf('await image.decode()', read);
  assert.ok(decoded > 0 && !spec.slice(decoded, read).includes(';\n'), 'each image is decoded just before its natural width is read');
});
