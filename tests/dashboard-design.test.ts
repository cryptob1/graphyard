import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The operator-approved dashboard design GY-161 builds to: one artboard per page, each declaring
// the size it is previewed at.
const artboards = ['Main', 'Item', 'Workers', 'Phone', 'Insights', 'System'];

test('unit:dashboard-design-checked-in — design/dashboard holds the Main, Item, Workers, Phone, Insights and System artboards, each declaring its $preview size', async () => {
  for (const name of artboards) {
    const html = await readFile(new URL(`../design/dashboard/${name}.dc.html`, import.meta.url), 'utf8');
    const props = html.match(/data-props='([^']*)'/);
    assert.ok(props, `${name}.dc.html declares its script props`);
    const preview = JSON.parse(props[1]).$preview;
    assert.ok(Number.isInteger(preview?.width) && preview.width > 0, `${name}.dc.html declares a $preview width`);
    assert.ok(Number.isInteger(preview?.height) && preview.height > 0, `${name}.dc.html declares a $preview height`);
  }
});
