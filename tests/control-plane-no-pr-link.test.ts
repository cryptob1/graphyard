import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { plainStatus } from '../src/model/plain-status.js';
import { CandidatePr } from '../web/candidate.js';
import ShippedPage from '../web/pages/shipped.js';
import type { Observation, Work } from '../src/model/work.js';
import type { Dashboard } from '../web/pages/dashboard.js';

// GY-3173: the control plane is the merge writer and opens no pull request. The number a
// control-plane candidate carries is its own change number, which on GitHub is somebody else's
// pull request, so every surface that names the item — its plain status sentences, the candidate
// link, the Shipped page — names its commit instead: the merge commit once merged, the head
// before it. Pull-request-mode items keep naming and linking their pull request.

const NOW = Date.parse('2030-06-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const minute = 60_000;
const head = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const mergeSha = 'f0e1d2c3b4a5968778695a4b3c2d1e0f1a2b3c4d';
const base = '0123456789abcdef0123456789abcdef01234567';
const candidate = { sha: head, baseSha: base, pr: 12, branch: 'graphyard/gy-3173-1', author: 'worker-a' };
const repository = 'owner/graphyard';
const commit = (sha: string) => `https://github.com/${repository}/commit/${sha}`;

/** The item's observation as the control plane records it, or as GitHub did before it became the merge writer. */
const observation = (controlPlane: boolean, merged: boolean): Observation => ({
  ...(controlPlane ? { source: 'control-plane' as const } : {}),
  candidate, checks: [], reviews: [], merged, mergeSha: merged ? mergeSha : null,
  mergeable: true, protected: !controlPlane, files: ['src/app.ts'], at: iso(-30 * minute),
}) as Observation;

const passed = () => ['ready', 'build', 'review', 'test', 'acceptance', 'merge'].map(name => ({ name, passed: true, reasons: [] as string[] }));
const refusing = (gate: string, reasons: string[]) => passed().map(entry => entry.name === gate ? { ...entry, passed: false, reasons } : entry);

/** One item in each shape its sentences are read in; only `fields` turns the scenario. */
function item(fields: Partial<Work> = {}): Work {
  return {
    id: 'w-GY-31', key: 'GY-31', title: 'Name the merge commit', type: 'bug', description: '', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:control-plane-no-pr-link'] }], policy: { checks: ['test'], review: true },
    stage: 'done', revision: 1, policyRevision: 1, ready: true, epoch: 1, lease: null, workspaces: [],
    submission: { epoch: 1, pr: 12 }, candidate, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: observation(true, true), blocker: null, gates: passed(), violations: [],
    createdAt: iso(-5 * 60 * minute), updatedAt: iso(-30 * minute), stageEnteredAt: iso(-30 * minute), ...fields,
  } as unknown as Work;
}

test('unit:tests/control-plane-no-pr-link.test.ts — a control-plane item\'s plain status names its commit, never a pull request; a pull-request item keeps its PR', () => {
  // Shipped: the merge commit the control plane pushed.
  assert.equal(plainStatus(item(), NOW).sentence, `Shipped in commit ${mergeSha.slice(0, 8)}`);
  // Handed in, waiting for review: the head before the merge.
  const reviewing: Partial<Work> = { stage: 'review', observation: observation(true, false), gates: refusing('review', ['Independent approval of the current commit is required']) };
  assert.equal(plainStatus(item(reviewing), NOW).sentence, `Waiting for review of commit ${head.slice(0, 8)}`);
  // Sent back and reclaimed: the builder is named and no pull request is promised, because none will exist.
  const rework: Partial<Work> = { stage: 'build', reworkRequested: true, observation: observation(true, false),
    lease: { owner: 'worker-a', epoch: 2, expiresAt: iso(30 * minute) }, lastAssignment: { owner: 'worker-a', epoch: 2, displayName: 'Cedar', claimedAt: iso(-20 * minute) },
    gates: refusing('build', ['Worker has not submitted implementation for this attempt']) };
  assert.equal(plainStatus(item(rework), NOW).sentence, 'Cedar is building it');
  for (const shape of [item(), item(reviewing), item(rework)]) assert.doesNotMatch(plainStatus(shape, NOW).sentence, /PR #|pull/i);
  // The same shapes observed by GitHub keep their pull request.
  assert.equal(plainStatus(item({ observation: observation(false, true) }), NOW).sentence, 'Shipped in PR #12');
  assert.equal(plainStatus(item({ ...reviewing, observation: observation(false, false) }), NOW).sentence, 'Waiting for review of PR #12');
});

test('unit:tests/control-plane-no-pr-link.test.ts — the candidate component links a control-plane item\'s commit and a pull-request item\'s pull request', () => {
  // Merged by the control plane: the merge commit, never a /pull/ URL.
  const merged = renderToStaticMarkup(createElement(CandidatePr, { repository, candidate, workKey: 'GY-31', observation: observation(true, true) }));
  assert.match(merged, new RegExp(`href="${commit(mergeSha)}"`));
  assert.ok(merged.includes(`>${mergeSha.slice(0, 8)}</code>`), 'the short merge commit is the text');
  assert.ok(!merged.includes('/pull/') && !merged.includes('PR #'), merged);
  // Not merged yet: the head before the merge.
  const open = renderToStaticMarkup(createElement(CandidatePr, { repository, candidate, workKey: 'GY-31', observation: observation(true, false) }));
  assert.match(open, new RegExp(`href="${commit(head)}"`));
  assert.ok(!open.includes('/pull/'), open);
  // A pull-request item keeps its pull request link.
  const pr = renderToStaticMarkup(createElement(CandidatePr, { repository, candidate, workKey: 'GY-31', observation: observation(false, false) }));
  assert.match(pr, /href="https:\/\/github\.com\/owner\/graphyard\/pull\/12"/);
  assert.match(pr, /PR #12/);
});

test('unit:tests/control-plane-no-pr-link.test.ts — the Shipped page links a control-plane item\'s merge commit, never a pull request', () => {
  const page = (work: Work) => renderToStaticMarkup(createElement(ShippedPage, { work: [work], status: { repository }, observedAt: NOW, setSelected: () => {} } as unknown as Dashboard));
  const shipped = page(item());
  assert.match(shipped, new RegExp(`href="${commit(mergeSha)}"`));
  assert.doesNotMatch(shipped, /\/pull\/|PR #\d/);
  // A pull-request item's row keeps its pull request link.
  assert.match(page(item({ observation: observation(false, true) })), /href="https:\/\/github\.com\/owner\/graphyard\/pull\/12"/);
});
