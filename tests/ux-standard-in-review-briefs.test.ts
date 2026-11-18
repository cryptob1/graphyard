import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { workerPrompt } from '../src/master/dispatch.js';
import { reviewPrompt } from '../src/reviewer.js';

// GY-3478: the AGENTS.md UX standard reaches every worker brief, every code review of a web/ change
// and the product reviewer, word for word; a review of a change outside web/ is left without it.
const agents = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8');
const section = /## UX standard\n\n(.+)\n/.exec(agents)?.[1] ?? '';
const head = 'a'.repeat(40), base = 'b'.repeat(40), cli = '/opt/graphyard.mjs';
const binding = { key: 'GY-1', pr: 1, sha: head, baseSha: base, policyRevision: 1 };
const codeReview = (files: string[]) => reviewPrompt({ repository: 'owner/project', cliPath: cli }, binding, undefined, undefined, [], undefined, files,
  undefined, undefined, undefined, { head, baseTip: base });

test('unit:ux-standard-in-review-briefs — the AGENTS.md UX standard is in the worker brief, web/ code reviews and the product review', () => {
  assert.ok(section.startsWith('UX standard:'), 'AGENTS.md has a UX standard section');
  assert.ok(section.split(/\s+/).length <= 80, 'the standard is at most 80 words');
  const product = reviewPrompt({ repository: 'owner/project', cliPath: cli }, binding, undefined, undefined, [], undefined, undefined, undefined, undefined, undefined,
    { product: true, head, baseTip: base, noApp: true });
  assert.ok(product.includes(section), 'the product review carries the standard');
  assert.match(product, /Request changes on any violation of this UX standard, with a screenshot of it/);
  assert.ok(codeReview(['web/pages/x.tsx']).includes(section), 'a code review of a web/ change carries the standard');
  assert.ok(workerPrompt({ cliPath: cli }, { key: 'GY-1', title: 'Example' }, { principal: 'graphyard-worker-1' }, 1).includes(section), 'the worker brief carries the standard');
  assert.ok(!codeReview(['src/app.ts']).includes(section), 'a code review touching only src/ omits it');
});
