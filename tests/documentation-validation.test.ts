import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Match the actual renderer's browser selection inside the private trial image.
if (existsSync('/etc/graphyard-trial')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/graphyard-browsers';
const { chromium } = await import('@playwright/test');

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const html = join(root, 'scripts/walkthrough/how-graphyard-works.html');

test('integration:documentation-validation — generated guides and links resolve; the walkthrough renders frames and its chapters, scrubber and playback work', { timeout: 120_000 }, async () => {
  await run(process.execPath, ['scripts/check-docs.mjs'], { cwd: root });
  const frames = await temporaryDirectory('documentation-frames');
  // Exercise the actual media renderer sparsely; the full committed assets are decoded separately.
  await run(process.execPath, ['scripts/walkthrough/render.mjs', html, frames, '0.1'], { cwd: root, timeout: 90_000 });
  const names = (await readdir(frames)).filter(name => name.endsWith('.png')).sort();
  assert.equal(names.length, 13);
  const first = await readFile(join(frames, names[0]));
  assert.deepEqual([...first.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(first.readUInt32BE(16) >= 800);
  assert.ok(first.readUInt32BE(20) >= 500);
  for (const name of names) {
    const frame = await readFile(join(frames, name));
    assert.deepEqual([...frame.subarray(16, 24)], [...first.subarray(16, 24)], 'caption changes must not resize video frames');
  }
  assert.notDeepEqual(await readFile(join(frames, names[6])), first, 'later scenes render different content');

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(html).href);
    const visibleText = () => page.locator('#stage text:visible').allTextContents();
    await page.locator('#scrub').fill('0');
    assert.ok((await visibleText()).length >= 6, 'the opening stage is populated before playback');
    const chapters = page.locator('#chapters button');
    assert.equal(await chapters.count(), 10);
    const captions = new Set<string>();
    for (let i = 0; i < 10; i++) {
      await chapters.nth(i).click();
      assert.equal(await chapters.nth(i).getAttribute('class'), 'on');
      captions.add(await page.locator('#caption').innerText());
      // Seek beyond each entrance transition, as the video renderer does.
      await page.locator('#scrub').evaluate(input => {
        const slider = input as HTMLInputElement;
        slider.value = String(Number(slider.value) + 2);
        slider.dispatchEvent(new Event('input'));
      });
      assert.ok((await visibleText()).length > 1, `scene ${i + 1} has content`);
    }
    assert.equal(captions.size, 10, 'chapter navigation updates captions');
    await page.locator('#scrub').fill('0');
    await page.locator('#play').click();
    await page.waitForFunction(() => Number((document.getElementById('scrub') as HTMLInputElement).value) > 0.1);
    await page.locator('#play').click();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
