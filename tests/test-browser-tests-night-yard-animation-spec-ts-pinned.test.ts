import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// GY-3369: the batch gate's check test:browser-tests/night-yard-animation.spec.ts failed once and passed
// its re-run. The type-out case polled the line's clip-path for 4 s of wall time; a loaded trial host
// rendered no frame in that window, a CSS animation's time stands still until one comes, and the poll
// read the line still closed (inset(0px 100% 0px 0px)). The case now reads the wipe on the animation's
// own record — set to its start, then finished — and the shared sign-in wait allows a loaded host 15 s.
const spec = readFileSync('browser-tests/night-yard-animation.spec.ts', 'utf8');

test('unit:test-browser-tests-night-yard-animation-spec-ts-pinned — the type-out wipe is read on the animation, never timed against the wall clock', () => {
  assert.doesNotMatch(spec, /clipPath\), \{ timeout/, 'no wall-clock poll waits for the CSS animation to finish');
  assert.match(spec, /getAnimations\(\)[\s\S]{0,200}currentTime = 0;[\s\S]{0,120}\.finish\(\);/, 'the wipe is read at its start and after finish() on its own animation');
  assert.match(spec, /closed: 'inset\(0px 100% 0px 0px\)', open: 'none'/, 'the line starts closed and finishes open');
  const serve = spec.slice(spec.indexOf('async function serve'), spec.indexOf('return state;'));
  assert.match(serve, /level: 1 \}\)\)\.toBeVisible\(live\)/, 'the sign-in wait for the Work page allows a loaded host');
});
