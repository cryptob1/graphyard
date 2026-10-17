// Renders the walkthrough's SVG stage + caption to PNG frames by seeking its scrubber.
// usage: node render.mjs HTML OUTDIR FPS
//
// The committed assets (docs/diagrams/how-graphyard-works.gif and .mp4) are these frames encoded
// with ffmpeg. To reproduce them byte-comparable, render at FPS 10 and run from OUTDIR:
//   MP4: ffmpeg -framerate 10 -i frames/f%05d.png -vf scale=1200:-2:flags=lanczos,format=yuv420p -c:v libx264 -crf 24 -preset slow -movflags +faststart docs/diagrams/how-graphyard-works.mp4
//   GIF: ffmpeg -framerate 10 -i frames/f%05d.png -vf "scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" -fps_mode cfr docs/diagrams/how-graphyard-works.gif
// The GIF needs -fps_mode cfr: without it ffmpeg 9 drops repeated frames and the GIF plays in 60 s.
import { chromium } from 'playwright';
const [html, out, fpsArg] = process.argv.slice(2);
const fps = Number(fpsArg || 10);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 900 }, deviceScaleFactor: 1.6, colorScheme: 'light' });
await page.goto('file://' + html);
await page.evaluate(() => document.fonts.ready);
await page.addStyleTag({ content: '.controls,.chapters{display:none!important} .player{border-radius:0}' });
const player = page.locator('.player');
const duration = 134;
const total = Math.round(duration * fps);
for (let i = 0; i <= total; i++) {
  await page.evaluate(t => { const s = document.getElementById('scrub'); s.value = t; s.dispatchEvent(new Event('input')); }, i / fps);
  await player.screenshot({ path: `${out}/f${String(i).padStart(5, '0')}.png` });
}
await browser.close();
console.log('frames', total + 1);
