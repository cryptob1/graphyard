import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// GY-1916: the two-minute 'How Graphyard works' walkthrough sits on the repository's GitHub front
// page. GitHub strips scripts from READMEs, so the animation ships as rendered video: the GIF is
// the inline image (GitHub renders a committed GIF inline but not a committed MP4), wrapped in a
// link to the MP4. The renders are committed byte-identical to what scripts/walkthrough produces,
// so the digests here pin the assets, and the renderer committed beside the source names the
// commands that reproduce both files from its frames.
// GY-1919: the ffmpeg GIF froze browsers on a blank stage — its first frame was a blank transition
// and 1,340 of its 1,341 frames were 1x1 transparent patches over that base, which browsers
// composite as a frozen picture (ffmpeg's own decoder hid the bug, which is why the per-frame
// checks passed). The GIF is now built by scripts/walkthrough/makegif.py from the same frames, and
// the structural checks in unit:readme-walkthrough-gif-plays read its playability facts — a full
// opaque first frame, the 120.1 s running time, the forever loop — straight from the bytes.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`);
const text = (path: string) => read(path).toString('utf8');
const sha256 = (path: string) => createHash('sha256').update(read(path)).digest('hex');

test('unit:readme-walkthrough-assets — README embeds the walkthrough GIF above its first section heading wrapped in a link to the MP4, both by repository-relative path, the committed video files carry their pinned digests, and the GIF is built by the committed Pillow builder named in the renderer header', () => {
  // The committed renders are exactly the reviewed walkthrough: a re-encode, resize or re-render
  // would silently replace them with different pixels, so their digests are pinned here. The GIF
  // digest is the browser-playable Pillow build; the ffmpeg GIF it replaced (d92236045486d662...)
  // fails this pin and the structural checks in unit:readme-walkthrough-gif-plays.
  assert.equal(sha256('docs/diagrams/how-graphyard-works.gif'), '02749d218be0ca36ada0705c59f827f71f52ac98a425188393d78ed3b3026060', 'the GIF digest matches the reviewed Pillow build');
  assert.equal(sha256('docs/diagrams/how-graphyard-works.mp4'), 'ea8b187dfda82c831f7552964b980a10c8b810bce0e41c47c6df4725ff5581fc', 'the MP4 digest matches the reviewed render');

  const readme = text('README.md');
  const firstHeading = readme.search(/^#{2,6}\s/m);
  assert.ok(firstHeading > 0, 'README has a section heading the embed sits above');
  const embed = /\[!\[([^\]]+)\]\(([^)]+)\)\]\(([^)]+)\)/.exec(readme.slice(0, firstHeading));
  assert.ok(embed, 'README embeds the GIF as an image wrapped in a link, above its first section heading');
  const [, alt, image, link] = embed;
  assert.match(alt, /How Graphyard works/);
  assert.equal(image, 'docs/diagrams/how-graphyard-works.gif', 'the inline image is the committed GIF by repository-relative path');
  assert.equal(link, 'docs/diagrams/how-graphyard-works.mp4', 'the wrapper links the committed MP4 by repository-relative path');

  // GY-1919: the GIF comes from the committed Pillow builder, and the renderer's header names the
  // makegif.py command instead of the ffmpeg GIF encoding that froze browsers on a blank frame.
  const builder = text('scripts/walkthrough/makegif.py');
  assert.match(builder, /from PIL import Image/, 'makegif.py builds the GIF with Pillow');
  assert.match(builder, /loop=0/, 'makegif.py writes loop 0, forever');
  assert.match(builder, /disposal=1/, 'makegif.py writes disposal 1, so browsers keep the base frame under patches');
  const renderer = text('scripts/walkthrough/render.mjs');
  assert.match(renderer, /uv run --no-project --with pillow python -I scripts\/walkthrough\/makegif\.py frames 10 800 docs\/diagrams\/how-graphyard-works\.gif/, 'the header gives the makegif.py command for the GIF');
  assert.doesNotMatch(renderer, /palettegen|diff_mode=rectangle|-fps_mode cfr/, 'the ffmpeg GIF encoding is gone from the header');
  assert.match(renderer, /ffmpeg -framerate 10 -i frames\/f%05d\.png -vf scale=1200:-2:flags=lanczos,format=yuv420p -c:v libx264 -crf 24 -preset slow -movflags \+faststart/, 'the MP4 command stays');
});

test('unit:readme-walkthrough-source — the animation source and its frame renderer are committed beside the assets, the renderer imports playwright by bare name, and its header keeps the MP4 encoding beside the Pillow GIF builder', () => {
  const html = text('scripts/walkthrough/how-graphyard-works.html');
  assert.match(html, /<title>How Graphyard Works<\/title>/, 'the committed source is the walkthrough animation page');
  assert.match(html, /id="scrub"/, 'the page carries the scrubber the renderer seeks');

  const renderer = text('scripts/walkthrough/render.mjs');
  assert.match(renderer, /import \{ chromium \} from 'playwright'/, 'playwright is imported by bare name, resolved from the install');
  assert.doesNotMatch(renderer, /from '\//, 'no absolute-path import pins the renderer to one checkout');
  // The header comment carries the encoding that turns the frames into the committed MP4.
  assert.match(renderer, /ffmpeg -framerate 10 -i frames\/f%05d\.png -vf scale=1200:-2:flags=lanczos,format=yuv420p -c:v libx264 -crf 24 -preset slow -movflags \+faststart/, 'the MP4 command');
});

/** Walks a GIF's block stream: the logical screen, every frame's image descriptor and
 *  graphic-control extension, and the NETSCAPE loop count. Structural reads, no browser needed. */
function parseGif(bytes: Buffer) {
  assert.match(bytes.subarray(0, 6).toString('latin1'), /^GIF8[79]a$/, 'the file is a GIF');
  const width = bytes[6] | bytes[7] << 8;
  const height = bytes[8] | bytes[9] << 8;
  const globalTable = bytes[10] & 0x80 ? 2 << (bytes[10] & 0x07) : 0;
  let at = 13 + globalTable * 3;
  const frames: { left: number; top: number; width: number; height: number; control: { packed: number; delayCs: number } | null }[] = [];
  let control: { packed: number; delayCs: number } | null = null;
  let loop: number | null = null;
  while (at < bytes.length && bytes[at] !== 0x3b) { // 0x3b: trailer
    if (bytes[at] === 0x21) { // extension: label byte, then size-prefixed sub-blocks
      const label = bytes[at + 1];
      at += 2;
      const payload: number[] = [];
      while (bytes[at] !== 0) { const size = bytes[at]; for (let k = 1; k <= size; k++) payload.push(bytes[at + k]); at += size + 1; }
      at += 1;
      if (label === 0xf9 && payload.length >= 4) control = { packed: payload[0], delayCs: payload[1] | payload[2] << 8 };
      // NETSCAPE2.0: an 11-byte identifier, then the sub-block id and the 2-byte loop count.
      if (label === 0xff && payload.length >= 14 && Buffer.from(payload.slice(0, 11)).toString('latin1') === 'NETSCAPE2.0') loop = payload[12] | payload[13] << 8;
    } else if (bytes[at] === 0x2c) { // image descriptor
      const localTable = bytes[at + 9] & 0x80 ? 2 << (bytes[at + 9] & 0x07) : 0;
      frames.push({ left: bytes[at + 1] | bytes[at + 2] << 8, top: bytes[at + 3] | bytes[at + 4] << 8, width: bytes[at + 5] | bytes[at + 6] << 8, height: bytes[at + 7] | bytes[at + 8] << 8, control });
      control = null;
      at += 10 + localTable * 3 + 1; // descriptor, optional local table, LZW minimum code size
      while (bytes[at] !== 0) at += bytes[at] + 1; // the LZW data sub-blocks, then their terminator
      at += 1;
    } else {
      assert.fail(`unknown GIF block 0x${bytes[at].toString(16)} at byte ${at}`);
    }
  }
  return { width, height, frames, loop };
}

test('unit:readme-walkthrough-gif-plays — the committed GIF opens on a full opaque 800x509 first frame, runs 12,010 centiseconds and loops forever, read from its bytes, so browsers play it where the ffmpeg GIF froze', () => {
  const { width, height, frames, loop } = parseGif(read('docs/diagrams/how-graphyard-works.gif'));
  assert.equal(width, 800, 'the logical screen is the 800-wide embed');
  assert.equal(height, 509, 'the logical screen is the 510-high walkthrough stage');
  const first = frames[0];
  assert.ok(first, 'the GIF has a first frame');
  assert.deepEqual([first.left, first.top, first.width, first.height], [0, 0, width, height], 'the first frame paints the whole logical screen, not a later scene');
  // ffmpeg's diff_mode=rectangle GIF patched 1,340 of its 1,341 frames with 1x1 transparent
  // rectangles over a blank transition base; browsers composited that as a frozen blank stage.
  // Every frame here is opaque, so every patch lands on kept pixels.
  assert.ok(frames.every(frame => frame.control), 'every frame carries a graphic-control extension');
  const transparent = frames.filter(frame => frame.control!.packed & 0x01);
  assert.deepEqual(transparent, [], 'no frame carries a transparent colour');
  assert.equal(frames.reduce((sum, frame) => sum + frame.control!.delayCs, 0), 12010, 'the frame delays sum to 12,010 centiseconds, the full 120.1 s at real speed');
  assert.equal(loop, 0, 'the NETSCAPE loop count is 0: forever');
});
