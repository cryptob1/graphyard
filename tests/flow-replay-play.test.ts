import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { replayFrames, replaySeconds } from '../web/flow-replay.js';
import { ReplaySection, replayLoop, type FrameClock } from '../web/pages/insights-flow.js';

// GY-204: the Flow page's "Last 24 hours, replayed" behaves like a video — still at its first
// frame under a large play button until the viewer presses it, then played once.
const root = new URL('..', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');
const NOW = Date.parse('2026-09-24T12:00:00Z');
const hour = 3_600_000;
const frames = replayFrames([
  { key: 'GY-1', from: null, to: 'build', at: new Date(NOW - 20 * hour).toISOString() },
  { key: 'GY-1', from: 'build', to: 'test', at: new Date(NOW - 12 * hour).toISOString() },
  { key: 'GY-2', from: null, to: 'build', at: new Date(NOW - 6 * hour).toISOString() },
  { key: 'GY-2', from: 'build', to: 'review', at: new Date(NOW - 2 * hour).toISOString() },
], NOW);

/** A frame clock advanced by hand: each animation frame fires at the next 16 ms step. */
function handClock() {
  let now = 1_000, next = 1;
  const pending = new Map<number, (at: number) => void>();
  const clock: FrameClock = { now: () => now, request: tick => { pending.set(next, tick); return next++; }, cancel: frame => { pending.delete(frame); } };
  const advance = (ms: number) => {
    const end = now + ms;
    while (now < end) { now = Math.min(end, now + 16); const due = [...pending.values()]; pending.clear(); for (const tick of due) tick(now); }
  };
  return { clock, advance, pending };
}

/** The replay as the page runs it: its state, pressed and paused by hand, on a hand clock. */
function player() {
  const { clock, advance, pending } = handClock();
  const state = { t: 0, playing: false };
  let stop: (() => void) | undefined;
  const run = () => { stop?.(); stop = replayLoop(state.playing, state.t, clock, t => { state.t = t; }, playing => { state.playing = playing; run(); }); };
  const render = () => renderToStaticMarkup(createElement(ReplaySection, { frames, truncated: false, initial: { ...state }, clock }));
  // The overlay button's onClick and the pause control's, as the page wires them.
  const press = () => { if (state.t >= 1) state.t = 0; state.playing = true; run(); };
  const pause = () => { state.playing = false; run(); };
  return { state, advance, pending, render, press, pause };
}

const overlay = (html: string) => /<button type="button" class="replay-overlay"([^>]*)>/.exec(html);

test('unit:replay-no-autoplay — after the flow data loads the replay stands still at its first frame under a large play button, and time passing never starts it', async () => {
  assert.ok(frames.length > 0);
  // The replay as the Flow page mounts it once the flow data has loaded.
  const html = renderToStaticMarkup(createElement(ReplaySection, { frames, truncated: false }));
  const button = overlay(html);
  assert.ok(button, 'the overlay play button is present');
  assert.match(button![1], /aria-label="Play the last 24 hours"/);
  assert.match(button![1], /data-replay="play"/);
  assert.doesNotMatch(button![1], /hidden/, 'the overlay is shown');
  assert.match(html, /<span class="replay-disc"><svg[^>]*aria-hidden="true"[\s\S]*?<path d="M8 5.5v13l10.5-6.5z"/, 'a round button with a play icon');
  assert.match(html, /class="replay-stage" data-playing="false" data-position="0"/, 'still, at the first frame');
  assert.doesNotMatch(html, /Pause the replay/);
  // Time passes and nothing moves: the loop is never scheduled while the viewer has not pressed play.
  const p = player();
  p.advance(replaySeconds * 1000 * 2);
  assert.equal(p.pending.size, 0);
  assert.deepEqual(p.state, { t: 0, playing: false });
  assert.match(p.render(), /data-playing="false" data-position="0"/);
  // Loading the page never sets playing: the load callbacks (the report and the replay rows, read
  // apart since GY-705) only store what was read.
  const source = await read('web/pages/insights-flow.tsx');
  const load = /readFlowReport\(api\)\.then\(([\s\S]*?)\);\n[\s\S]*?readReplay\(api, now\)\.then\(([\s\S]*?)\);\n/.exec(source)!;
  for (const callback of [load[1], load[2]]) assert.doesNotMatch(callback, /setPlaying|setT\(/);
  assert.match(load[2], /setFrames\(replay\.frames\)/);
  assert.equal([...source.matchAll(/setPlaying\(true\)/g)].length, 1, 'playing is set true in one place only');
  assert.match(source, /onClick=\{\(\) => \{ if \(t >= 1\) setT\(0\); setPlaying\(true\); \}\}/, 'and that place is the play button');
  assert.match(source, /useState\(initial\?\.playing \?\? false\)/);
});

test('unit:replay-plays-on-press — pressing play runs the replay once over replaySeconds with a pause control, pause stops it, and the end shows a replay button', async () => {
  const p = player();
  p.press();
  assert.equal(p.state.playing, true);
  let html = p.render();
  assert.match(overlay(html)![1], /hidden=""/, 'the overlay hides while it plays');
  assert.match(html, /<button type="button" class="text-button replay-pause" aria-label="Pause the replay">Pause<\/button>/, 'a small pause control replaces it');
  // Playback progresses with the clock, at replaySeconds for the whole day.
  p.advance(replaySeconds * 1000 / 4);
  assert.ok(Math.abs(p.state.t - 0.25) < 0.01, `a quarter through, at ${p.state.t}`);
  p.advance(replaySeconds * 1000 / 4);
  const half = p.state.t;
  assert.ok(Math.abs(half - 0.5) < 0.01, `half through, at ${half}`);
  // Pause stops it where it stands.
  p.pause();
  p.advance(replaySeconds * 1000);
  assert.equal(p.state.t, half); assert.equal(p.state.playing, false); assert.equal(p.pending.size, 0);
  html = p.render();
  assert.match(overlay(html)![1], /aria-label="Play the last 24 hours"/, 'paused, the play button comes back');
  assert.doesNotMatch(html, /Pause the replay/);
  // Play resumes from there and the replay runs once, to the last frame, then stops.
  p.press();
  p.advance(replaySeconds * 1000 / 2 + 100);
  assert.equal(p.state.t, 1); assert.equal(p.state.playing, false); assert.equal(p.pending.size, 0, 'it runs once, not in a loop');
  html = p.render();
  const end = overlay(html)![1];
  assert.match(end, /aria-label="Replay the last 24 hours"/); assert.match(end, /data-replay="replay"/); assert.doesNotMatch(end, /hidden/);
  assert.match(html, /data-playing="false" data-position="1"/, 'the last frame');
  // Replay starts over from the first frame.
  p.press();
  assert.equal(p.state.t, 0); assert.equal(p.state.playing, true);
  p.advance(replaySeconds * 1000 + 100);
  assert.equal(p.state.t, 1); assert.equal(p.state.playing, false);
  // Under prefers-reduced-motion the overlay is replaced by the step-through slider and nothing animates.
  const source = await read('web/pages/insights-flow.tsx');
  assert.match(source, /\{!reducedMotion\(\) && <button type="button" className="replay-overlay"/);
  assert.match(source, /<input type="range"[^>]*aria-label="Replay position"/);
  assert.match(source, /if \(!playing \|\| reducedMotion\(\)\) return;/);
  const original = (globalThis as any).window;
  (globalThis as any).window = { matchMedia: (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' }) };
  try {
    const reduced = renderToStaticMarkup(createElement(ReplaySection, { frames, truncated: false }));
    assert.equal(overlay(reduced), null, 'no overlay under reduced motion');
    assert.match(reduced, /<input type="range" min="0" max="1000" aria-label="Replay position" value="1000"/, 'the slider, at the last frame');
    const { clock, advance, pending } = handClock();
    let t = 0;
    assert.equal(replayLoop(true, 0, clock, next => { t = next; }, () => {}), undefined);
    advance(replaySeconds * 1000); assert.equal(pending.size, 0); assert.equal(t, 0);
  } finally { (globalThis as any).window = original; }
});

test('unit:replay-overlay-screenshot — the overlay spans the replay under a translucent scrim with a focusable button of at least 64 px in the dashboard colours, captured at 1280 and 375 px', async () => {
  const css = await read('web/style.css');
  const rule = (selector: string) => new RegExp(`${selector.replace(/[.[\]=:-]/g, m => `\\${m}`)}\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  assert.match(rule('.replay-stage'), /position:relative/);
  const scrim = rule('.replay-overlay');
  assert.match(scrim, /position:absolute/); assert.match(scrim, /inset:0/, 'it spans the replay section');
  assert.match(scrim, /background:color-mix\(in srgb,var\(--bg\) \d+%,transparent\)/, 'a translucent scrim in the page colour');
  assert.match(rule('.replay-overlay[hidden]'), /display:none/);
  const disc = rule('.replay-disc');
  assert.match(disc, /border-radius:50%/, 'a round button');
  for (const size of [/(?:^|;)width:(\d+)px/, /(?:^|;)height:(\d+)px/, /min-width:(\d+)px/, /min-height:(\d+)px/]) assert.ok(Number(size.exec(disc)?.[1]) >= 64, `${size} ≥ 64 px`);
  assert.match(disc, /background:var\(--accent\)/); assert.match(disc, /color:var\(--on-accent\)/);
  // Keyboard-focusable (a real <button>) with a visible focus ring drawn in a token colour.
  assert.match(rule('.replay-overlay:focus-visible .replay-disc'), /outline:3px solid var\(--text\)/);
  // Its colours are the dashboard's tokens alone, so it follows whichever theme the tokens define.
  const block = css.slice(css.indexOf('.replay-stage{'), css.indexOf('\n', css.indexOf('.replay-stage{')));
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(?:white|black)\b/i);
  // The browser suite captures the Flow page with the overlay at 1280 px and 375 px wide.
  const spec = await read('browser-tests/screenshots.spec.ts');
  assert.match(spec, /replayOverlayWidths = \[\{ name: 'laptop', width: 1280[^\]]*\{ name: 'small-phone', width: 375/);
  assert.match(spec, /getByRole\('button', \{ name: 'Play the last 24 hours' \}\)/);
  assert.match(spec, /page\.screenshot\(\{ path: `\$\{out\}\/insights-replay-overlay-\$\{viewport\.width\}\.png`/);
});

test('unit:replay-scrub — outside reduced motion the replay position is a draggable slider that follows playback, and dragging it pauses the replay at the chosen point (GY-288)', async () => {
  const p = player();
  p.press();
  p.advance(replaySeconds * 1000 / 4);
  const html = p.render();
  const slider = /<input type="range" min="0" max="1000" aria-label="Replay position" value="(\d+)"\/>/.exec(html);
  assert.ok(slider, 'a range input, not a read-only progress bar');
  assert.ok(Math.abs(Number(slider![1]) - 250) <= 10, `it follows playback, at ${slider![1]}`);
  assert.doesNotMatch(html, /role="progressbar"/);
  // The slider's change handler, as the page wires it: it pauses, then moves to the dragged point.
  const source = await read('web/pages/insights-flow.tsx');
  assert.match(source, /aria-label="Replay position" onChange=\{e => \{ setPlaying\(false\); setT\(Number\(e\.target\.value\) \/ 1000\); \}\}/);
  p.state.playing = false; p.state.t = 0.7; p.pause();
  p.advance(replaySeconds * 1000);
  assert.deepEqual(p.state, { t: 0.7, playing: false }, 'the scrubbed point holds');
  assert.match(overlay(p.render())![1], /aria-label="Play the last 24 hours"/);
  // Play resumes from the scrubbed point, not the start.
  p.press();
  p.advance(replaySeconds * 1000 * 0.1);
  assert.ok(Math.abs(p.state.t - 0.8) < 0.01, `resumed from the scrubbed point, at ${p.state.t}`);
});
