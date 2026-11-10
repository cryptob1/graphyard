import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { guideText, guideTopicList } from '../src/guide.js';

// GY-3230: the unscoped npm name `graphyard` belongs to someone else, so Graphyard publishes as
// @cryptob1/graphyard and nothing a user reads may tell them to run the unscoped package.
const root = new URL('..', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const help = (...args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', new URL('src/cli.ts', root).pathname, ...args], { encoding: 'utf8' });
const unscoped = /npx\s+(?:--yes\s+)?graphyard\b/;

test('unit:tests/npm-package-name.test.ts — package.json names @cryptob1/graphyard with the graphyard bin', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.equal(manifest.name, '@cryptob1/graphyard');
  assert.deepEqual(manifest.bin, { graphyard: './bin/graphyard.mjs' });
});

test('unit:tests/npm-package-name.test.ts — the README Quick start runs npx @cryptob1/graphyard up', () => {
  const start = read('README.md').split('## Quick start\n')[1]!.split('\n## ')[0]!;
  assert.match(start, /npx @cryptob1\/graphyard up --repo OWNER\/NAME/);
});

test('unit:tests/npm-package-name.test.ts — README, docs, guide text, printed help and printed instructions never say unscoped npx graphyard', () => {
  const texts: Record<string, string> = {
    'README.md': read('README.md'),
    'docs/walkthrough.md': read('docs/walkthrough.md'),
    'bin/bootstrap.mjs': read('bin/bootstrap.mjs'),
    'src/publish-verified.ts': read('src/publish-verified.ts'),
    'graphyard --help': help('--help'),
    'graphyard up --help': help('up', '--help'),
  };
  for (const topic of guideTopicList) texts[`guide ${topic}`] = guideText(topic);
  for (const [name, text] of Object.entries(texts)) assert.doesNotMatch(text, unscoped, `${name} tells a user to run unscoped npx graphyard`);
});
