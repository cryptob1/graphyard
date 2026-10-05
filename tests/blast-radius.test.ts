import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Work } from '../src/model.js';
import { blastRadius } from '../src/model/blast-radius.js';
// @ts-expect-error Dependency-free fixture script.
import { fixtureApi, fixtureStatus, fixtureWork, NOW } from '../scripts/dashboard-fixture.mjs';
import { live } from '../browser-tests/ui-board.js';
import { unknownFeatures } from '../web/features.js';
import WorkDetails from '../web/pages/work-details.js';

/**
 * GY-972: every candidate carries a plain-sentence merge danger and blast radius, derived from
 * its scope and its landability verdict. The raw gate reasons never appear in it.
 */
const candidate = { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 7, branch: 'graphyard/gy-1-1', author: 'worker' };
const file = (path: string, additions = 10, deletions = 2, status: 'added' | 'modified' | 'removed' = 'modified') => ({ path, status, sha: 'c'.repeat(40), additions, deletions, binary: false });
const reasons = {
  review: 'Independent approval of the current commit is required',
  acceptance: 'AC-1: unit:x needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy',
  merge: 'Pull request is not mergeable against the current base',
};
function subject(overrides: Partial<Work> = {}, observation: Partial<NonNullable<Work['observation']>> = {}): Work {
  const files = observation.scopeFiles ?? [file('src/model/gates.ts'), file('tests/gates.test.ts'), file('docs/coordination.md', 3, 1)];
  return {
    candidate, plannedFiles: ['src/model/gates.ts', 'tests/', 'docs/'],
    policy: { checks: ['test', 'typecheck'], review: true } as Work['policy'],
    criteria: [{ id: 'AC-1', text: 'x', proofs: ['unit:x'] }] as Work['criteria'],
    gates: [
      { name: 'build', passed: true, reasons: [] }, { name: 'test', passed: true, reasons: [] },
      { name: 'review', passed: false, reasons: [reasons.review] }, { name: 'acceptance', passed: false, reasons: [reasons.acceptance] },
      { name: 'merge', passed: false, reasons: [reasons.merge] },
    ],
    observation: { candidate, files: files.map(entry => entry.path), scopeFiles: files, merged: false, mergeSha: null, mergeable: true, protected: true, checks: [], reviews: [], at: '2026-09-30T00:00:00Z', landing: { base: 'main' }, ...observation } as Work['observation'],
    ...overrides,
  } as Work;
}

test('unit:candidate-blast-radius-summary a code-only change reads as a low-danger two-way door in plain sentences', () => {
  const radius = blastRadius(subject());
  assert.equal(radius.danger, 'low'); assert.equal(radius.door, 'two-way');
  assert.equal(radius.headline, 'Merge danger: low · two-way door');
  assert.equal(radius.touches, 'It changes 3 files (28 lines) in the server code (1), tests (1) and documentation (1).');
  assert.match(radius.doorway, /^Two-way door: .*undoing it is a revert\.$/);
  assert.equal(radius.reverts, 'If it lands and misbehaves, reverting its merge commit restores those 3 files.');
  assert.deepEqual(radius.sentences, [radius.touches, radius.doorway, radius.reverts, radius.guard]);
});

test('unit:candidate-blast-radius-summary the merge guard is described by what it checks, with what is still missing, never by raw gate reasons', () => {
  const radius = blastRadius(subject());
  assert.equal(radius.guard, 'Before it merges, the merge guard checks that the builder has handed the work in, the automated checks test and typecheck pass on this exact code, someone other than the builder approves this exact code, the proof its requirements name passes on it and it merges cleanly onto main and puts back no file outside its plan. Still missing: approval, proof and clean merge.');
  const all = radius.sentences.join(' ');
  for (const reason of Object.values(reasons)) assert.ok(!all.includes(reason), `no raw reason: ${reason}`);
  assert.doesNotMatch(all, /needs trusted passing evidence|epoch|policy revision|\bPR\b|\bCI\b|[0-9a-f]{40}/);
  const passing = blastRadius(subject({ gates: [], policy: { checks: ['test'], review: false } as Work['policy'] }));
  assert.match(passing.guard, /the automated check test passes on this exact code, the proof .* Every one of these holds now\.$/);
  assert.doesNotMatch(passing.guard, /approves/, 'no review clause when the policy requires none');
});

test('unit:candidate-blast-radius-summary schema, deployment and workflow changes are one-way doors a revert does not take back', () => {
  const schema = blastRadius(subject({}, { scopeFiles: [file('src/store/schema.ts'), file('src/store/tables/work.ts')] }));
  assert.equal(schema.door, 'one-way'); assert.equal(schema.danger, 'high');
  assert.equal(schema.headline, 'Merge danger: high · one-way door');
  assert.equal(schema.doorway, 'One-way door: it changes the database schema, which acts outside the code once it lands.');
  assert.equal(schema.reverts, 'If it lands and misbehaves, reverting its merge commit restores those 2 files, but not data already migrated in a live database.');
  const infra = blastRadius(subject({ plannedFiles: [] }, { scopeFiles: [file('Dockerfile'), file('.github/workflows/ci.yml')] }));
  assert.match(infra.doorway, /installation and deployment and the GitHub workflows/);
  assert.match(infra.reverts, /but not infrastructure a deploy has already applied and anything the workflows published/);
});

test('unit:candidate-blast-radius-summary scope beyond the plan, carried work, deletions, size and conflicts raise the danger', () => {
  const outside = blastRadius(subject({}, { scopeFiles: [file('src/model/gates.ts'), file('src/engine.ts')] }));
  assert.equal(outside.danger, 'high'); assert.match(outside.touches, /One of them is outside its plan\.$/);
  const carried = blastRadius(subject({}, { landing: { base: 'main', foreign: [{ key: 'GY-5', pr: 5, head: 'd'.repeat(40) }] } }));
  assert.equal(carried.danger, 'high'); assert.match(carried.reverts, /carries unfinished work from GY-5, which a revert would take out too\.$/);
  const deleting = blastRadius(subject({}, { scopeFiles: [file('tests/old.test.ts', 0, 40, 'removed')] }));
  assert.equal(deleting.danger, 'medium'); assert.match(deleting.touches, /, deleting 1 file\.$/); assert.match(deleting.reverts, /restores that file\./);
  const large = blastRadius(subject({}, { scopeFiles: [file('src/model/gates.ts', 500, 0)] }));
  assert.equal(large.danger, 'medium');
  const conflicting = blastRadius(subject({}, { conflicting: true }));
  assert.equal(conflicting.danger, 'high'); assert.equal(conflicting.headline, 'Merge danger: high · two-way door · conflicts with the base branch');
  const merged = blastRadius(subject({}, { merged: true, mergeSha: 'e'.repeat(40) }));
  assert.match(merged.reverts, /^Reverting its merge commit restores those 3 files\.$/);
});

test('unit:candidate-blast-radius-summary an unread head or a missing pull request says its reach is not known yet', () => {
  const stale = blastRadius(subject({ candidate: { ...candidate, sha: 'f'.repeat(40) } }));
  assert.equal(stale.danger, 'unknown'); assert.equal(stale.door, null); assert.equal(stale.headline, 'Merge danger: not known yet');
  assert.match(stale.touches, /has not read which files the latest code changes yet/);
  const none = blastRadius(subject({ candidate: null, observation: null }));
  assert.equal(none.touches, 'There is no pull request yet, so nothing is touched.');
  assert.equal(none.sentences.length, 4);
  // A partial reading of the current head (no file list yet) must not break the item page.
  const partial = blastRadius({ candidate, observation: { candidate }, gates: [{ name: 'merge', passed: false, reasons: [] }] } as unknown as Work);
  assert.equal(partial.touches, 'It changes no files.');
  assert.match(partial.guard, /Still missing: clean merge\.$/);
});

test('unit:candidate-blast-radius-summary the item view renders the summary for every candidate', () => {
  const work = (fixtureWork() as any[]).map(live) as Work[];
  const noop = () => {};
  const withCandidate = work.filter(item => item.candidate);
  assert.ok(withCandidate.length > 0, 'the fixture has candidates');
  for (const item of withCandidate) {
    const html = renderToStaticMarkup(createElement(WorkDetails, {
      token: 'fixture', work, status: fixtureStatus('admin'), observedAt: NOW, jobs: [], events: [], busy: false, codexAvailable: false,
      features: unknownFeatures, editingRequirements: false, setEditingRequirements: noop, action: async () => {}, api: async (path: string) => fixtureApi(path, 'admin'),
      refresh: async () => {}, setSelected: noop, setView: noop, sessionEpoch: { current: 0 }, item,
    } as any));
    const radius = blastRadius(item);
    assert.match(html, new RegExp(`<details class="blast-radius danger-${radius.danger}"><summary>${radius.headline}</summary>`), item.key);
    for (const sentence of radius.sentences) assert.ok(html.includes(`<li>${sentence.replace(/&/g, '&amp;')}</li>`), `${item.key}: ${sentence}`);
  }
  const bare = work.find(item => !item.candidate);
  if (bare) assert.doesNotMatch(renderToStaticMarkup(createElement(WorkDetails, { work, status: fixtureStatus('admin'), observedAt: NOW, jobs: [], events: [], features: unknownFeatures, sessionEpoch: { current: 0 }, setSelected: noop, item: bare } as any)), /blast-radius/);
});
