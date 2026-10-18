import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewPrompt, simplicityParagraph } from '../src/reviewer.js';
import { workerPrompt } from '../src/master/dispatch.js';
import { plannerPrompt } from '../src/daemon/planner.js';
import { acceptancePrompt } from '../src/daemon/acceptance.js';
import { masterRequest } from '../src/master/master-session.js';
import { masterConfigSchema } from '../src/master.js';
import { recordGoal } from '../src/model/goal.js';
import type { Goal } from '../src/model/goal.js';

// GY-1999: the shared simplicity paragraph (GY-1993's operator instruction) is defined once, in
// src/reviewer.ts, and carried verbatim by every role prompt — worker, reviewer, planner,
// acceptance-drafting and master — and by the top of AGENTS.md, replacing nothing else there.

const root = fileURLToPath(new URL('..', import.meta.url));
/** A distinctive fragment that only the paragraph contains, so the once-definition scan cannot match a prompt's own wording. */
const fragment = 'Prefer deleting code to adding it';
const builderSources = ['src/master/dispatch.ts', 'src/daemon/planner.ts', 'src/daemon/acceptance.ts', 'src/master/master-session.ts'];

const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/outside/graphyard.mjs',
  repository: 'cryptob1/graphyard', baseBranch: 'main', githubAppId: 1234, hostId: 'vishrog', masterAgentName: 'graphyard-master-graphyard', autoMerge: true, mergeMethod: 'merge', workers: [] });
const binding = { key: 'GY-42', pr: 42, sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 2 };
/** A goal the acceptance-drafting and planner prompts read: only its plain fields and the optional refusal/acceptance reads. */
const goal = (key: string): Goal => {
  const at = new Date().toISOString();
  return recordGoal({ statement: `Customers can ${key} without waiting`, users: ['Customers'], constraints: [], deployTarget: 'uat then production' }, key, { actor: { id: 'master', role: 'coordinator', sessionKind: 'ai' }, at });
};

test('unit:simplicity-principle — every role prompt carries the shared simplicity paragraph, defined once in src/reviewer.ts, and AGENTS.md leads with it', async () => {
  const prompts = {
    worker: workerPrompt({ cliPath: config.cliPath }, { key: 'GY-42', title: 'Carry the paragraph' }, { principal: 'graphyard-test-1' }, 1),
    reviewer: reviewPrompt({ repository: 'owner/project' }, binding),
    planner: plannerPrompt({ repository: 'owner/project' }, goal('GOAL-1')),
    acceptance: acceptancePrompt({ repository: 'owner/project' }, goal('GOAL-2'), { outcomes: [] }),
    master: masterRequest(config, 'Durable handover text stands in for the launcher\'s handover.'),
  };
  for (const [role, prompt] of Object.entries(prompts))
    assert.ok(prompt.includes(simplicityParagraph.trim()), `the ${role} prompt interpolates the shared simplicity paragraph verbatim`);

  // Defined once: the paragraph's wording lives only in src/reviewer.ts; the other four builders
  // import the constant, so none of them restates the sentence group in its own source.
  const home = await readFile(join(root, 'src/reviewer.ts'), 'utf8');
  assert.ok(home.includes(`export const simplicityParagraph`), 'the constant is exported from src/reviewer.ts');
  for (const source of builderSources) {
    const text = await readFile(join(root, source), 'utf8');
    assert.ok(!text.includes(fragment), `${source} imports the paragraph instead of restating it`);
    assert.ok(text.includes('simplicityParagraph'), `${source} interpolates the constant`);
  }

  // The same paragraph opens AGENTS.md, above the coordination rules, replacing nothing.
  const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes(simplicityParagraph.trim()), 'AGENTS.md carries the same paragraph');
  const heading = agents.indexOf('# Working on Graphyard');
  assert.ok(agents.indexOf(simplicityParagraph.trim()) > heading, 'it sits under the title, not above the file');
  assert.ok(agents.indexOf(simplicityParagraph.trim()) < agents.indexOf('Keep the control plane independent'), 'it is at the top of the page');
});

test('the paragraph is an input-free constant: a builder that gains no input stays byte-identical', () => {
  // Purity (the prompts' own invariant): the constant adds no input, so two calls with the same
  // inputs stay byte-identical, and the paragraph is exactly what the interpolation contributes.
  assert.equal(workerPrompt({ cliPath: config.cliPath }, { key: 'GY-42', title: 'T' }, { principal: 'graphyard-test-1' }, 1),
    workerPrompt({ cliPath: config.cliPath }, { key: 'GY-42', title: 'T' }, { principal: 'graphyard-test-1' }, 1));
  assert.equal(reviewPrompt({ repository: 'owner/project' }, binding), reviewPrompt({ repository: 'owner/project' }, binding));
});
