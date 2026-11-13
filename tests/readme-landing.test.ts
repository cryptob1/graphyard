import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

// GY-3198: README is a short landing page; the walkthrough re-render steps live in docs/walkthrough.md.
const root = new URL('..', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

test('unit:tests/readme-landing.test.ts — README is a short landing page naming AI coding agents, Claude Code and Codex, with Why, Where things run, Quick start and Learn more sections', () => {
  const readme = read('README.md');
  const words = readme.trim().split(/\s+/).length;
  assert.ok(words <= 460, `README is at most 460 words: ${words}`);

  const [title, , pitch] = readme.split('\n');
  assert.equal(title, '# Graphyard', 'README opens with an H1');
  for (const name of ['AI coding agents', 'Claude Code', 'Codex']) assert.ok(pitch.includes(name), `the one-line value proposition names ${name}`);

  const sections = [...readme.matchAll(/^## (.+)$/gm)].map(match => match[1]);
  assert.deepEqual(sections, ['Why Graphyard', 'Where things run', 'Quick start', 'Learn more']);
  const where = readme.split('\n## Where things run\n')[1]?.split('\n## ')[0] ?? '';
  assert.ok(where.trim().split(/\s+/).length < 250, 'the Where things run section is under 250 words');

  const alt = readme.match(/!\[([^\]]*)\]\(docs\/diagrams\/how-graphyard-works\.gif\)/)?.[1] ?? '';
  assert.ok(alt.split(/\s+/).length >= 8, `the GIF has descriptive alt text: "${alt}"`);

  assert.match(readme, /\]\(docs\/walkthrough\.md\)/, 'README links the walkthrough re-render steps');
  assert.doesNotMatch(readme, /render\.mjs|ffmpeg|makegif/, 'README carries no re-render commands');
  assert.ok(existsSync(new URL('docs/walkthrough.md', root)));
  const walkthrough = read('docs/walkthrough.md');
  for (const step of ['scripts/walkthrough/render.mjs', 'ffmpeg', 'scripts/walkthrough/makegif.py']) assert.ok(walkthrough.includes(step), `docs/walkthrough.md carries ${step}`);
});
