import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * GY-1785: since GY-1718 the E2E cases a change names run, before the merge, against a preview of
 * the merged tree (docs/delivery.md describes it). README.md's "How it works" says so in its step
 * 4, and the steps this change does not touch read exactly as they do on main today.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const readme = readFileSync(`${root}README.md`, 'utf8');
/** The numbered steps of the `## How it works` section, without their numbers. */
const steps = () => {
  const section = readme.match(/^## How it works[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  assert.ok(section, 'README.md has a "## How it works" section');
  return section[1].split('\n').filter(line => /^\d+\. /.test(line)).map(line => line.replace(/^\d+\. /, ''));
};

/** Steps 1 to 5 as GY-2172 left them (its steps 6-8 describe the simplified flow), pinned here so a
 * later edit cannot quietly reword the walk. */
const UNCHANGED_ON_MAIN: Record<number, string> = {
  1: 'You give Graphyard a goal in a plain-language file.',
  2: 'A planner agent turns the goal into small work items with acceptance criteria.',
  3: 'A worker agent takes over: the worker builds each work item on its own branch.',
  5: 'An independent agent reviews, before the merge for sensitive changes and after the merge for everything else, by default.',
  6: 'Graphyard merges to main, and every merge deploys on its own: health and end-to-end checks run on the live release.',
  7: 'A failed check rolls the release back and hands the change back to a worker with the failure attached.',
  8: 'Only Graphyard writes to main.',
};

test('unit:readme-step-4-preview — README.md step 4 says the build and tests check includes the change\'s E2E cases run against a preview of the merged tree, and steps 1-3 and 5-8 read as on main today', () => {
  const list = steps();
  assert.equal(list.length, 8, `the walk is eight steps, found ${list.length}`);
  const step4 = list[3];
  assert.match(step4, /\bE2E\b/, 'step 4 names the E2E cases');
  assert.match(step4, /\bpreview\b/i, 'step 4 names the preview they run against');
  assert.match(step4, /checks the merged tree/, 'the preview is a preview of the merged tree step 4 opens with');
  assert.match(step4, /merge to main itself/, 'step 4 keeps that Graphyard does the merge itself');
  assert.equal(step4.split(/(?<=[.!?])\s+/).length, 1, `step 4 is one sentence: ${step4}`);
  for (const [number, text] of Object.entries(UNCHANGED_ON_MAIN)) {
    assert.equal(list[Number(number) - 1], text, `step ${number} reads as on main today`);
  }
});
