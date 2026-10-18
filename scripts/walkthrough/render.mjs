// Renders the walkthrough's SVG stage + caption to PNG frames by seeking its scrubber.
// usage: node render.mjs HTML OUTDIR FPS
//
// The committed assets (docs/diagrams/how-graphyard-works.gif and .mp4) are these frames encoded
// with the commands below. To reproduce them byte-comparable, render at FPS 10 and run from OUTDIR:
//   MP4: ffmpeg -framerate 10 -i frames/f%05d.png -vf scale=1200:-2:flags=lanczos,format=yuv420p -c:v libx264 -crf 24 -preset slow -movflags +faststart docs/diagrams/how-graphyard-works.mp4
//   GIF: uv run --no-project --with pillow python -I scripts/walkthrough/makegif.py frames 10 800 docs/diagrams/how-graphyard-works.gif
// makegif.py merges identical consecutive frames into one longer frame, quantises to one shared
// 96-colour palette with no dithering, and writes opaque frames with disposal 1 and loop 0, so its
// first frame paints the whole stage and browsers composite every patch onto kept pixels. (The
// ffmpeg GIF this replaced drew every changed rectangle as a transparent patch over a blank
// transition first frame, so browsers froze on a blank stage that ffmpeg's own decoder hid.)
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
