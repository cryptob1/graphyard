import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The glossary, the primary operations page, and the rendered diagrams are documentation
 * contracts: the role terms every guide relies on, a page an operator can skim in three minutes,
 * and images that read without the page around them. These checks keep those properties from
 * drifting silently.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');
const docs = readdirSync(`${root}docs`, { recursive: true, withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.md')).map(e => `${e.parentPath.slice(root.length)}/${e.name}`);

test('the glossary defines the eight distinctions once, with a canonical usage each', () => {
  const glossary = read('docs/glossary.md');
  const headings = [...glossary.matchAll(/^### \d\. (.+)$/gm)].map(m => m[1]);
  assert.deepEqual(headings, [
    'Human operator (human authority)', 'AI agent', 'Agent session (Herdr-managed session or runtime)', 'Principal, role, and credential',
    'Worker lease and worktree', 'Independent reviewer and proof producer', 'Graphyard control plane', 'Herdr runtime',
  ]);
  assert.equal((glossary.match(/\*\*Canonical usage:\*\*/g) ?? []).length, 8, 'every distinction states its canonical usage');
  for (const role of ['admin', 'operator-agent', 'coordinator', 'slice-lead', 'worker', 'producer', 'reader']) assert.match(glossary, new RegExp(`^\\| \`${role}\` \\|`, 'm'), `the roles table covers ${role}`);
  assert.match(glossary, /^## Diagram legend$/m);
});

test('the primary operations page fits a three-minute skim and keeps its structure', () => {
  const page = read('docs/operations.md');
  // HTML comments (the index declaration) are not rendered on GitHub or in the app.
  const withoutCode = page.replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, '');
  const body = withoutCode.split(/^## Deeper references$/m)[0];
  assert.ok(withoutCode.length < page.length, 'the page keeps at least one recipe command block');
  // Inline code spans count as one word each; navigation is the trailing references list.
  const words = body.replace(/`[^`]*`/g, 'x').split(/\s+/).filter(Boolean).length;
  assert.ok(words <= 650, `operations.md body is ${words} words excluding code and navigation; the budget is 650`);
  for (const heading of ['## Daily checklist', '## Incident decision tree', '## Recovery recipes', '## Safety facts that never change', '## Deeper references']) assert.ok(page.includes(heading), `operations.md keeps ${heading}`);
  for (const link of ['operations-reference.md#lost-worker-before-submission', 'operations-reference.md#submitted-implementation-needs-rework', 'operations-reference.md#supervisor-died-leaving-a-containment-quarantine', 'operations-reference.md#master-coordination-loop', 'operations-reference.md#merge-bypass', 'operations-reference.md#bootstrap-mode-for-a-self-proving-change']) assert.ok(page.includes(link), `each recipe links its deeper reference: ${link}`);
  // The safety facts the split must not lose, on the page itself.
  for (const fact of ['Never weaken requirements', 'No AI principal can', 'never bypass', 'Never attest a stop you have not confirmed', 'no bypass, no lifecycle-state endpoint', 'append-only']) assert.ok(page.includes(fact), `operations.md states: ${fact}`);
  const reference = read('docs/operations-reference.md');
  for (const heading of ['## Master coordination loop', '## Proof authority grants', '## Setup proposals and drift', '## Scale limits', '## Credentials', '### Concurrent reconciliation']) assert.ok(reference.includes(heading), `operations-reference.md keeps ${heading}`);
});

test('every diagram is self-describing and every use of one has alt text and an adjacent text equivalent', () => {
  const diagrams = readdirSync(`${root}docs/diagrams`).filter(name => name.endsWith('.svg'));
  assert.ok(diagrams.length >= 3);
  for (const name of diagrams) {
    const svg = read(`docs/diagrams/${name}`);
    assert.match(svg, /<svg[^>]*role="img"[^>]*aria-labelledby="title desc"/, `${name} is labelled for assistive technology`);
    assert.match(svg, /<title id="title">[^<]{10,}<\/title>/, `${name} carries a title`);
    assert.match(svg, /<desc id="desc">[^<]{80,}<\/desc>/, `${name} carries a long description`);
    assert.match(svg, /viewBox="0 0 560 \d+"/, `${name} scales from a fixed viewBox`);
    assert.ok(svg.includes('Legend (glossary terms)'), `${name} draws the glossary legend`);
    assert.ok(!/<script|<image|href="http|@import|url\((?!#)/.test(svg), `${name} is self-contained`);
  }
  const used = new Set<string>();
  for (const file of docs) {
    const text = read(file);
    for (const match of text.matchAll(/^!\[([^\]]*)\]\(([^)]+)\)$/gm)) {
      const [, alt, src] = match;
      assert.ok(alt.trim().length >= 40, `${file}: image ${src} needs a descriptive alt text`);
      used.add(src.split('/').at(-1)!);
      const following = text.slice(match.index! + match[0].length, match.index! + match[0].length + 400);
      assert.match(following, /Text equivalent/, `${file}: image ${src} needs an adjacent text equivalent`);
    }
    assert.ok(!text.includes('```mermaid'), `${file}: Mermaid fences do not render in the in-app docs; use a diagram under docs/diagrams/`);
  }
  for (const name of diagrams) assert.ok(used.has(name), `docs/diagrams/${name} is used by a page`);
});

test('the in-app docs navigation lists every page the index links', () => {
  const nav = read('web/docs.tsx');
  for (const page of ['glossary', 'operations-reference', 'development']) assert.ok(nav.includes(`['${page}',`), `web/docs.tsx lists ${page}`);
  assert.match(nav, /import\.meta\.glob\('\.\.\/docs\/\*\*\/\*\.svg'/, 'diagrams are bundled from docs/');
});
