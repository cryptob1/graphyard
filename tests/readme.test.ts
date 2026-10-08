import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * GY-1514: README.md is the first page a reader, human or agent, opens. It says in plain words what
 * Graphyard is and what it is for, walks the path of one change in at most eight steps a non-engineer
 * can follow, draws that path as a Mermaid flowchart whose every node the steps name, and keeps the
 * links and the one-command setup under a short "Start here" section, inside 600 words.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const readme = readFileSync(`${root}README.md`, 'utf8');
/** Words as `wc -w` counts them: maximal runs of non-whitespace, markup and code included. */
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
/** The body of the `## heading` section: from its heading line to the next `##` heading or the end. */
const section = (heading: string) => {
  const match = readme.match(new RegExp(`^## ${heading}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  assert.ok(match, `README.md has a "## ${heading}" section`);
  return match[1];
};
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).filter(Boolean);

/** Vocabulary the opening may not use: a first-time reader has no definition for it yet (AC-1). */
const INTERNAL_VOCABULARY = ['lease', 'epoch', 'principal', 'proof producer', 'candidate'];

test('unit:readme-plain-opening — README.md opens with one sentence saying what Graphyard is and one saying its goal, both free of Graphyard-internal vocabulary', () => {
  const [title, opening] = readme.split(/\n\s*\n/);
  assert.equal(title.trim(), '# Graphyard', 'the page starts with its title');
  const [what, goal, ...rest] = sentences(opening.trim());
  assert.deepEqual(rest, [], `the opening is exactly two sentences: ${opening}`);
  assert.match(what, /^Graphyard is a control plane that runs a team of AI coding agents on a repository\.$/, 'the first sentence says what Graphyard is');
  assert.match(goal, /^Its goal is software that ships itself: agents build, verify, review and release/, 'the second sentence states the goal');
  for (const decision of ['goals and priorities', 'spending money or opening accounts', 'issuing credentials']) assert.ok(goal.includes(decision), `the goal keeps the human's decision "${decision}"`);
  for (const term of INTERNAL_VOCABULARY) assert.ok(!new RegExp(`\\b${term}s?\\b`, 'i').test(opening), `the opening does not say "${term}"`);
});

/** What the eight steps must cover, each as a phrase a reader can find in the step that covers it (AC-2). */
const COVERAGE: [string, RegExp][] = [
  ['a goal is given', /\bgoal\b/i],
  ['a planner turns it into small work items with acceptance criteria', /planner[^\n]*work items[^\n]*acceptance criteria/i],
  ['a worker agent builds each item on its own branch', /worker agent[^\n]*its own branch/i],
  ['Graphyard checks the change merged onto main (build and tests) and merges it itself', /checks the merged tree[^\n]*build[^\n]*tests[^\n]*merge to main itself/i],
  ['an independent agent reviews it, before merge for sensitive changes and after for the rest', /independent agent[^\n]*review[^\n]*before the merge for sensitive changes[^\n]*after the merge for everything else/i],
  ['every ~10 merges a release candidate goes to a test environment and the end-to-end suite runs', /every ten merges[^\n]*release candidate[^\n]*test environment[^\n]*end-to-end/i],
  ['passing candidates are promoted to production and verified', /promoted to production[^\n]*verified/i],
  ['failures are reverted or fixed by a new item', /reverted or fixed[^\n]*new work item/i],
];

const steps = () => section('How it works').split('\n').filter(line => /^\d+\. /.test(line)).map(line => line.replace(/^\d+\. /, ''));

test('unit:readme-how-it-works-steps — the "How it works" section is at most eight numbered one-sentence steps covering the whole path, and states that only Graphyard writes to main', () => {
  const list = steps();
  assert.ok(list.length > 0 && list.length <= 8, `at most eight steps, found ${list.length}`);
  list.forEach((step, index) => {
    assert.equal(sentences(step).length, 1, `step ${index + 1} is one sentence: ${step}`);
    assert.ok(words(step) <= 40, `step ${index + 1} is short enough to follow (${words(step)} words)`);
    assert.ok(!/[`#]|\[[^\]]+\]\(/.test(step), `step ${index + 1} is prose, not code or links`);
  });
  const body = list.join('\n');
  for (const [topic, pattern] of COVERAGE) assert.match(body, pattern, `a step covers: ${topic}`);
  assert.match(section('How it works'), /Only Graphyard writes to main/, 'the section states that only Graphyard writes to main');
});

/** The nodes of the flowchart: every `id[label]` or `id["label"]` definition, by id (AC-3). */
function flowchartNodes(block: string) {
  const nodes = new Map<string, string>();
  for (const match of block.matchAll(/\b([A-Za-z]\w*)\[("?)([^\]"]+)\2\]/g)) nodes.set(match[1], match[3].trim());
  return nodes;
}
/** Every node id an edge touches, defined or not, so a dangling reference counts as a node too. */
const referencedIds = (block: string) => new Set(block.replace(/^\s*flowchart \w+/m, '').replace(/\[[^\]]*\]/g, '').replace(/\|[^|]*\|/g, '').split(/[^A-Za-z0-9_]+/).filter(token => /^[A-Z]\w*$/.test(token)));

test('unit:readme-flow-diagram — README.md has a Mermaid flowchart of the path with at most ten nodes, each named in the "How it works" steps, and a failure edge back to a new work item', () => {
  const fence = readme.match(/```mermaid\n([\s\S]*?)```/);
  assert.ok(fence, 'README.md has a ```mermaid fenced block');
  const block = fence[1];
  assert.match(block, /^\s*flowchart (LR|TD)\b/, 'the block is a flowchart LR or TD');
  const nodes = flowchartNodes(block);
  assert.ok(nodes.size >= 8 && nodes.size <= 10, `between eight and ten nodes, found ${nodes.size}: ${[...nodes.values()].join(', ')}`);
  for (const id of referencedIds(block)) assert.ok(nodes.has(id), `node ${id} is defined with a label`);
  const stepText = steps().join('\n').toLowerCase();
  for (const [id, label] of nodes) assert.ok(stepText.includes(label.toLowerCase()), `node ${id} "${label}" appears in the How it works steps`);
  const labels = [...nodes.values()];
  for (const expected of ['Goal', 'Planner', 'Work items', 'Worker builds', 'Merge to main', 'Review', 'Release candidate', 'UAT + E2E', 'Production verified']) assert.ok(labels.includes(expected), `the path has a "${expected}" node`);
  assert.ok(labels.some(label => /checks the merged tree/i.test(label)), 'the path has the "Graphyard checks the merged tree" node');
  assert.match(block, /sensitive[^\n]*before/i, 'the review edge says sensitive changes are reviewed before the merge');
  assert.match(block, /normal[^\n]*after/i, 'the review edge says normal changes are reviewed after the merge');
  const workItems = [...nodes].find(([, label]) => label === 'Work items')![0];
  assert.match(block, new RegExp(`-[.-]+>\\s*\\|[^|]*failure[^|]*\\|\\s*${workItems}\\b`, 'i'), 'a failure edge leads back to a new work item');
  assert.equal(flowchartNodes('X[Goal] --> Y["UAT + E2E"]').get('Y'), 'UAT + E2E', 'quoted labels are read without their quotes');
  assert.deepEqual([...referencedIds('A[Goal] --> B[Planner]\n  B -.->|failure| C')], ['A', 'B', 'C'], 'a dangling id is a referenced node');
  assert.match(readme.slice(fence.index! + fence[0].length, fence.index! + fence[0].length + 200), /Text equivalent/, 'the diagram has an adjacent text equivalent');
});

/** The links the README kept from before GY-1514, each under the "Start here" section (AC-4). */
const LINKS = ['docs/setup-from-zero.md', 'docs/install.md', 'docs/how-graphyard-works.md', 'docs/onboarding.md', 'docs/README.md', 'AGENTS.md', 'docs/development.md', 'LICENSE'];
const WORD_BUDGET = 600;

test('unit:readme-budget-and-links — README.md keeps its links and the one-command setup under a short "Start here" section and stays within 600 words as wc -w counts them', () => {
  const start = section('Start here');
  for (const target of LINKS) assert.match(start, new RegExp(`\\]\\(${target.replace(/[.]/g, '\\.')}\\)`), `Start here links ${target}`);
  assert.match(start, /```sh\ngraphyard up --agent --goal GOAL\.md\n```/, 'Start here states the one-command setup');
  assert.match(start, /docs\/install\.md\) is the primary install path/, 'Start here names the primary install path scripts/check-docs.mjs requires');
  assert.ok(words(start) <= 120, `Start here is short (${words(start)} words)`);
  assert.ok(words(readme) <= WORD_BUDGET, `README.md is within ${WORD_BUDGET} words (${words(readme)})`);
  assert.equal(words('one  two\tthree\n\n`four` [five](six.md)'), 5, 'words are counted as wc -w counts them');
});
