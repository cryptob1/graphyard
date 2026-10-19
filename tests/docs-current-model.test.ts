import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * GY-2172: the documentation describes the simplified Graphyard — the control plane as the only
 * merger, with nothing from GitHub but the git remote. No page under docs/ or README.md mentions
 * a GitHub App, branch protection, a pull request, release candidates, UAT promotion, plannedFiles
 * or scope requests, except the one sentence in docs/install.md that names the deploy key (the
 * install's only GitHub step). This word list proves it: a page that reintroduces the old model by
 * name fails here with the page and the term.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');

const FORBIDDEN: [string, RegExp][] = [
  ['GitHub App', /GitHub App/i],
  ['branch protection', /branch protection/i],
  ['pull request', /pull request/i],
  ['release candidate', /release[- ]candidate/i],
  ['UAT promotion', /\bUAT\b/],
  ['plannedFiles', /plannedFiles/],
  ['scope request', /scope request/i],
];

/** Prose sentences outside code fences; a sentence is where a reader's quote would end. */
const sentences = (text: string) => text.replace(/```[\s\S]*?```/g, '\n\n').split(/(?<=[.!?])\s+|\n\s*\n/).map(sentence => sentence.trim()).filter(Boolean);

test('unit:docs-current-model — no docs page or README names the old model, except the one install.md sentence naming the deploy key', () => {
  const pages = ['README.md', ...readdirSync(`${root}docs`, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => `${entry.parentPath.slice(root.length)}/${entry.name}`)];
  assert.ok(pages.some(page => page.endsWith('docs/README.md')), 'the generated index is checked too');
  const failures: string[] = [];
  let deployKeyAllowance = 0;
  for (const page of pages) {
    for (const sentence of sentences(read(page))) {
      for (const [label, pattern] of FORBIDDEN) {
        if (!pattern.test(sentence)) continue;
        // The one exception: install.md's sentence naming the deploy key, the only GitHub step.
        if (page === 'docs/install.md' && /deploy key/i.test(sentence)) { deployKeyAllowance += 1; continue; }
        failures.push(`${page} says ${label}: "${sentence.slice(0, 100)}"`);
      }
    }
  }
  assert.ok(deployKeyAllowance <= 1, `the deploy-key exception covers one sentence, found ${deployKeyAllowance}`);
  assert.deepEqual(failures, [], `the docs name the retired model: ${failures.join(' | ')}`);
});
