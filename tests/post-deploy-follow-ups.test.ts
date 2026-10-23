import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import { criterionWindowDays, criterionWindowHours, observationWindowFor } from '../src/model/observation-window.js';

// GY-1698: a post-deploy follow-up for a windowed criterion — an intervention rate below a threshold
// per N days, a hold for N consecutive days — can produce nothing before the window has run. GY-1689
// was filed at 03:36Z for GY-1685's 03:11Z merge and released at 06:39Z; the intervention report
// projected its reading no earlier than 2026-10-17T14:31Z, and two worker attempts, a review and two
// approver sessions were spent on it. The follow-up now carries the earliest instant its reading can
// exist (AC-1), and a released follow-up is not dispatched before it (AC-2).

const day = 86_400_000;
const mergeSha = 'f1984c1183521617660bdad738e72456315428ea';
const mergedAt = '2026-10-11T03:11:02Z';
const gy1685Id = 'b896515a-0def-4a4d-95f5-e7de00578d81';
const rate = { id: 'AC-1', text: 'below 3 per 7 days', proofs: ['manual:post-deploy/rate'] };

/** GY-1685 as delivered: merged at 03:11Z, its deployment observed on the release that is its own merge. */
const delivered = (overrides: Partial<Work> = {}): Work => ({
  id: gy1685Id, key: 'GY-1685', title: 'Recurring escalation interventions at the build stage: 3 in 7 days', description: '', type: 'bug', priority: 1,
  dependencies: [], criteria: [rate], policy: { checks: ['test', 'typecheck'], review: true }, 
  stage: 'done', revision: 40, policyRevision: 1, createdAt: '2026-10-11T02:07:11.287Z', updatedAt: mergedAt, stageEnteredAt: mergedAt, ready: true, epoch: 1, lease: null,
  workspaces: [{ host: 'vishrog', path: '/w', branch: 'graphyard/gy-1685-1', epoch: 1, owner: 'graphyard-codex-2' }], candidate: null, submission: { epoch: 1, pr: 1110 }, reworkRequested: false,
  scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [],
  delivery: { mergeSha, mergedAt, evidenceAsOf: mergedAt, authorizationRevision: 334 } as never, ...overrides,
} as Work);
const iso = (ms: number) => new Date(ms).toISOString();

// GY-1727: on 2026-10-12 master verify-deployment filed GY-1721 (GY-1684 AC-1, a rate per 7 days) and
// GY-1724 (GY-1700 AC-2, a 24-hour window of live webhook deliveries) against the already serving
// release ba607f8a809e with no window, and both were dispatched at once. The 7-day reading cannot exist
// before GY-1684's merge plus 7 days; the 24-hour one before the release was first observed serving
// GY-1700 plus 24 hours — "24-hour" and "24h" named no window the filer recognised.
const gy1700 = delivered({ id: 'e03bc94f-82f4-481d-a443-4b4e6abe9eb6', key: 'GY-1700', criteria: [
  { id: 'AC-2', text: 'A 24-hour window of live GitHub activity on cryptob1/graphyard shows zero failed webhook deliveries (no 5xx, no connection failures) in the App\'s advanced delivery log at github.com/settings/apps/graphyard-cryptob1-graphyard/advanced.', proofs: ['manual:post-deploy/webhook-deliveries-clean-24h'] },
  { id: 'AC-3', text: 'The github-budget attention row in graphyard master status clears when a delivery arrives and does not re-fire during 24h of live repository activity while at least one pull request is open.', proofs: ['manual:post-deploy/github-budget-attention-row-clears'] }],
  delivery: { mergeSha: 'a14965e4ad9ad52069ce7dc0c5d5aabdbf4f8b43', mergedAt: '2026-10-11T15:08:24Z', evidenceAsOf: '2026-10-11T15:08:24Z', authorizationRevision: 1 } as never });

test('unit:criterion-window-hours — an hour-denominated window is read like a day-denominated one: "over 24 hours" and "within 24 hours" give notBefore 24 hours after the merge, or after the release was first observed serving', () => {
  for (const text of ['zero failed deliveries over 24 hours', 'the row clears within 24 hours', 'a 24-hour window', 'during 24h of activity', 'over 24 hrs of activity', 'across 24hours'])
    assert.equal(criterionWindowHours(text), 24, text);
  assert.equal(criterionWindowHours('over 6 hours, then within 24 hours'), 24, 'the longest named window is the reading\'s');
  assert.equal(criterionWindowHours('per 7 days'), null);
  assert.equal(criterionWindowHours('the 3 hosts report healthy'), null);
  const merged = gy1700.delivery!.mergedAt, mergedMs24 = Date.parse(merged) + day;
  for (const text of ['Zero failed webhook deliveries over 24 hours', 'The attention row clears within 24 hours']) {
    const hours = observationWindowFor(gy1700, { id: 'AC-2', text })!;
    const days = observationWindowFor(gy1700, { id: 'AC-2', text: text.replace('24 hours', '1 day') })!;
    assert.equal(criterionWindowDays(text.replace('24 hours', '1 day')), 1);
    assert.deepEqual([hours.notBefore, hours.basis], [iso(mergedMs24), 'criterion-window'], `${text}: merge plus 24 hours`);
    assert.equal(hours.notBefore, days.notBefore, `${text}: the same instant as the one-day window`);
    const servedAt = Date.parse('2026-10-12T07:33:40.939Z');
    assert.equal(observationWindowFor(gy1700, { id: 'AC-2', text }, servedAt)!.notBefore, iso(servedAt + day), `${text}: first observed serving plus 24 hours`);
  }
});
