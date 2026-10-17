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
// ffmpeg commands that reproduce both files from its frames.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`);
const text = (path: string) => read(path).toString('utf8');
const sha256 = (path: string) => createHash('sha256').update(read(path)).digest('hex');

test('unit:readme-walkthrough-assets — README embeds the walkthrough GIF above its first section heading wrapped in a link to the MP4, both by repository-relative path, and the committed video files carry their pinned digests', () => {
  // The committed renders are exactly the reviewed walkthrough: a re-encode, resize or re-render
  // would silently replace them with different pixels, so their digests are pinned here.
  assert.equal(sha256('docs/diagrams/how-graphyard-works.gif'), 'd92236045486d66221a12b8791452de8d8352bedb1c75a5b8b3ac6fb3eeb6fc9', 'the GIF digest matches the reviewed render');
  assert.equal(sha256('docs/diagrams/how-graphyard-works.mp4'), '94e151c86263d62262571feccfb1e4f63175bd6c534711533e47dd95ba72cca9', 'the MP4 digest matches the reviewed render');

  const readme = text('README.md');
  const firstHeading = readme.search(/^#{2,6}\s/m);
  assert.ok(firstHeading > 0, 'README has a section heading the embed sits above');
  const embed = /\[!\[([^\]]+)\]\(([^)]+)\)\]\(([^)]+)\)/.exec(readme.slice(0, firstHeading));
  assert.ok(embed, 'README embeds the GIF as an image wrapped in a link, above its first section heading');
  const [, alt, image, link] = embed;
  assert.match(alt, /How Graphyard works/);
  assert.equal(image, 'docs/diagrams/how-graphyard-works.gif', 'the inline image is the committed GIF by repository-relative path');
  assert.equal(link, 'docs/diagrams/how-graphyard-works.mp4', 'the wrapper links the committed MP4 by repository-relative path');
});

test('unit:readme-walkthrough-source — the animation source and its frame renderer are committed beside the assets, the renderer imports playwright by bare name, and its header comment names the ffmpeg commands that reproduce both files', () => {
  const html = text('scripts/walkthrough/how-graphyard-works.html');
  assert.match(html, /<title>How Graphyard Works<\/title>/, 'the committed source is the walkthrough animation page');
  assert.match(html, /id="scrub"/, 'the page carries the scrubber the renderer seeks');

  const renderer = text('scripts/walkthrough/render.mjs');
  assert.match(renderer, /import \{ chromium \} from 'playwright'/, 'playwright is imported by bare name, resolved from the install');
  assert.doesNotMatch(renderer, /from '\//, 'no absolute-path import pins the renderer to one checkout');
  // The header comment carries the encoding that turns the frames into the committed files.
  assert.match(renderer, /ffmpeg -framerate 10 -i frames\/f%05d\.png -vf scale=1200:-2:flags=lanczos,format=yuv420p -c:v libx264 -crf 24 -preset slow -movflags \+faststart/, 'the MP4 command');
  assert.match(renderer, /palettegen=max_colors=64:stats_mode=diff\[p\];\[b\]\[p\]paletteuse=dither=none:diff_mode=rectangle" -fps_mode cfr/, 'the GIF command, with the -fps_mode cfr that keeps repeated frames');
});
