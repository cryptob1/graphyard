// Renders the walkthrough's SVG stage + caption to PNG frames by seeking its scrubber.
// usage: node render.mjs HTML OUTDIR FPS
//
// See docs/walkthrough.md for complete rendering, encoding and decode commands.
// HTML uses local font fallbacks and a fixed caption height so all frames share dimensions.
import { chromium } from 'playwright';
const [html, out, fpsArg] = process.argv.slice(2);
const fps = Number(fpsArg || 10);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 900 }, deviceScaleFactor: 1.6, colorScheme: 'light' });
await page.goto('file://' + html);
await page.evaluate(() => document.fonts.ready);
await page.addStyleTag({ content: '.controls,.chapters{display:none!important} .player{border-radius:0}' });
const player = page.locator('.player');
const duration = 120;
const total = Math.round(duration * fps);
for (let i = 0; i <= total; i++) {
  await page.evaluate(t => { const s = document.getElementById('scrub'); s.value = t; s.dispatchEvent(new Event('input')); }, i / fps);
  await player.screenshot({ path: `${out}/f${String(i).padStart(5, '0')}.png` });
}
await browser.close();
console.log('frames', total + 1);
