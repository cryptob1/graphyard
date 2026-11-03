<!-- page: Understand or contribute | 2 | render and inspect opening media -->
# Render the opening walkthrough

Edit `scripts/walkthrough/how-graphyard-works.html`, including its stage, captions and static explanation. It uses local font fallbacks, a fixed caption height, ten scenes and a meaningful first frame. The opening distinguishes master AI, loop program, workers and Graphyard ownership. The failure scene shows the loop handing a failed check to the master; the static explanation covers changed-cause prompts and the fallback heartbeat.

## Render and encode

From the repository root, with Playwright Chromium, ffmpeg and uv available:

Install Chromium with `npx playwright install chromium` if needed. Set `WALKTHROUGH_BROWSERS_PATH` to an existing browser cache for rendering and validation, including `complete` rechecks that reset `PLAYWRIGHT_BROWSERS_PATH` under a fresh HOME. Otherwise Playwright uses its configured cache. Private merge trials always use the browser bundled at `/opt/graphyard-browsers`.

```sh
frames=$(mktemp -d)
node scripts/walkthrough/render.mjs "$PWD/scripts/walkthrough/how-graphyard-works.html" "$frames" 10
ffmpeg -y -framerate 10 -i "$frames/f%05d.png" -vf scale=1200:-2:flags=lanczos,format=yuv420p -c:v libx264 -crf 24 -preset slow -movflags +faststart docs/diagrams/how-graphyard-works.mp4
uv run --no-project --with pillow python -I scripts/walkthrough/makegif.py "$frames" 10 800 docs/diagrams/how-graphyard-works.gif
```

Use a writable `UV_CACHE_DIR` if the default cache is unavailable. Frames include both endpoints: 1201 at 10 fps, or 120.1 seconds. GIF encoding merges identical frames with their duration and uses a shared palette; its first frame is opaque. Output widths are 1200 for MP4 and 800 for GIF.

## Validate

```sh
npm run docs:check
node "$GRAPHYARD_CLI" verify GY-3048
ffprobe -v error -show_entries stream=codec_name,width,height,duration:format=duration -of json docs/diagrams/how-graphyard-works.mp4
ffprobe -v error -show_entries stream=codec_name,width,height,duration:format=duration -of json docs/diagrams/how-graphyard-works.gif
ffmpeg -v error -i docs/diagrams/how-graphyard-works.mp4 -f null -
ffmpeg -v error -i docs/diagrams/how-graphyard-works.gif -f null -
```

`integration:documentation-validation` invokes the docs checker, renders sample frames with the actual renderer, and exercises chapter navigation, scrubbing and playback. It needs Chromium; media decoding stays outside the test suite. Also inspect decoded frames at 0, 15, 28, 55, 75, 90, 103 and 116 seconds for clipping, legibility and correct role labels. Open the HTML to check the static explanation and controls. README links to the committed GIF and MP4.

SVG diagrams use a different generator: edit `scripts/render-docs-diagrams.mjs` and run `node scripts/render-docs-diagrams.mjs`.

The [rewrite review](../scripts/walkthrough/rewrite-review.md) records the reviewed files, word counts and validation results.
