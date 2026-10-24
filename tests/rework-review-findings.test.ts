import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neededRework, standingVerdict } from '../src/daemon/rework.js';
import { appliedReworkBrief, reworkBriefMax, reworkBriefSection } from '../src/master/rework-brief.js';
import type { Work } from '../src/model.js';

// GY-2946: a control-plane CHANGES_REQUESTED verdict's rework reason carries the review body and
// its BLOCKING findings, so the next worker's request names what to fix instead of only the sha.

const head = 'c'.repeat(40), base = 'd'.repeat(40), at = '2026-10-24T04:30:00.000Z';
const finding = 'mission vehicle indexes go stale when parking.ts compacts the array; use stable identity';

function item(review: { body?: string; blocking?: string[] }): Work {
  const candidate = { sha: head, baseSha: base, pr: 64, branch: 'graphyard/gy-64-1', author: 'worker' };
  return {
    id: 'gy-64', key: 'GY-64', title: 'Vehicle parking', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [], policy: { checks: ['test'], review: true }, stage: 'review', revision: 4, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 2, lease: null, workspaces: [], candidate,
    submission: { epoch: 2, pr: 64 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [],
    observation: {
      candidate, checks: [], merged: false, mergeSha: null, mergeable: true, protected: true,
      files: ['src/a.ts'], scopeFiles: [], at, baseTip: base, baseTree: base, baseTipContained: true,
      reviews: [{ reviewer: 'review-claude-a', sha: head, state: 'CHANGES_REQUESTED', submittedAt: at, source: 'control-plane', ...review }],
    },
  } as unknown as Work;
}

test('unit:rework-reason-carries-review-findings — a control-plane CHANGES_REQUESTED rework reason carries BLOCKING findings, else the body, bounded for the brief', () => {
  const withFindings = standingVerdict(item({
    body: `## Review\n\nBLOCKING: ${finding}\n\nFollow-up finding: tidy a comment`,
    blocking: [finding],
  }));
  assert.ok(withFindings, 'a CHANGES_REQUESTED entry stands');
  assert.match(withFindings.reason, /review-claude-a requested changes on c{12}/);
  assert.match(withFindings.reason, new RegExp(`BLOCKING: ${finding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(withFindings.reason.includes('Follow-up finding'), false, 'follow-ups are not the rework grounds');
  const rework = neededRework(item({ blocking: [finding], body: `BLOCKING: ${finding}` }));
  assert.ok(rework?.reason.includes(finding), 'lastRework.reason the loop records carries the finding');

  const bodyOnly = 'The parking compaction invalidates stored vehicle indexes; remap or use stable ids.';
  const withoutFindings = standingVerdict(item({ body: bodyOnly }));
  assert.ok(withoutFindings?.reason.includes(bodyOnly), 'with no BLOCKING lines the body itself is the detail');

  const oversized = 'x'.repeat(reworkBriefMax + 500);
  const bounded = standingVerdict(item({ body: oversized }));
  assert.ok(bounded);
  assert.ok(bounded.reason.length <= reworkBriefMax + 120, 'the detail is cut so the brief still fits reworkBriefMax');
  assert.match(bounded.reason, /…$/, 'a cut body ends with an ellipsis');
});

test('unit:rework-brief-names-findings — the next round\'s worker request contains the finding text, not only requested changes on <sha>', () => {
  const work = item({ blocking: [finding], body: `BLOCKING: ${finding}` });
  const rework = neededRework(work)!;
  const briefed = {
    ...work,
    lastRework: { reason: rework.reason, binding: rework.binding, at },
    pipeline: { attempts: [], submittedAt: '2026-10-24T04:00:00.000Z', reworkRounds: 1, interventions: { blocked: 0, requirements: 0 }, resubmittedAt: null },
  } as Work;
  const applied = appliedReworkBrief(briefed);
  assert.ok(applied?.reason.includes(finding));
  const section = reworkBriefSection(briefed, applied);
  assert.match(section, /This attempt is a rework round/);
  assert.match(section, /requested changes on c{12}/);
  assert.ok(section.includes(finding), 'the worker request names the finding, not only the sha line');
});
