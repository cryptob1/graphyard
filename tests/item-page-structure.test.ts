import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Work } from '../src/model.js';
import { predictQueue } from '../src/merge-queue.js';
// @ts-expect-error the checked-in dashboard fixture is plain JavaScript
import { fixtureApi, fixtureStatus, fixtureWork, NOW, visibleWords } from '../scripts/dashboard-fixture.mjs';
import { live } from '../browser-tests/ui-board.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import WorkDetails from '../web/pages/work-details.js';
import { activityLabel, historyLabel, historyPage, overlapLine, plainLines, whatIsLeft } from '../web/item-page.js';
import { eventHistoryLimits } from '../src/events-history.js';
import type { Command } from '../src/engine.js';
import { nextActor, groupWithin } from '../web/groups.js';
import { prSteps } from '../web/pr-steps.js';
import { describeHumanRequest } from '../src/model/human-request.js';

// GY-171: the item page below its first screen. Each section answers one question, in plain words,
// in a fixed order, and everything technical is one click down in a single collapsed section.

const board = () => (fixtureWork() as any[]).map(live) as unknown as Work[];
const noop = () => {};
const at = (ms: number) => new Date(NOW + ms).toISOString();
const minute = 60_000;
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function dashboard(work: Work[], overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    token: 'fixture', work, status: fixtureStatus('admin'), error: '', connected: true, lastUpdated: '12:00:00', view: 'work', setView: noop, filter: null, setFilter: noop,
    selected: null, setSelected: noop, creating: false, setCreating: noop, busy: false, setBusy: noop, observedAt: NOW, jobs: [], query: '', setQuery: noop,
    operatorAgents: [], operatorAgentsError: null, features: {} as any, events: fixtureApi('events') as any[], editingRequirements: false, setEditingRequirements: noop, codexAvailable: false,
    queue: predictQueue(work, NOW), sessionEpoch: { current: 0 }, api: async (path: string) => fixtureApi(path, 'admin'), refresh: async () => {}, action: async () => {},
    setError: noop, signOut: noop, ...overrides,
  } as Dashboard;
}
const page = (item: Work, all: Work[], overrides: Partial<Dashboard> = {}) => renderToStaticMarkup(createElement(WorkDetails, { ...dashboard(all, overrides), item }));

/**
 * A real-shaped item in the middle of review, as `graphyard status` returns one: handed in, its
 * checks passed, waiting for an independent approval, two proofs owed and the merge not yet
 * observed — the control plane's own gate reasons, a running implementation session with its
 * attach command, an open scope request and a computed next action.
 */
function midReview(base: Work): Work {
  return {
    ...base, id: 'gy-171-probe', key: 'GY-171', stage: 'review', plannedFiles: ['web/', 'tests/item-page-structure.test.ts'],
    criteria: [
      { id: 'AC-1', text: 'Below the existing summary the item page shows What is left, Requirements, Pull request and Activity in this order. A test renders a real-shaped item mid-review and asserts the section order.', proofs: ['unit:item-page-sections'] },
      { id: 'AC-2', text: 'Everything technical sits in one collapsed Technical details section, and planned-file overlaps render as a single line.', proofs: ['unit:item-page-technical-collapsed'] },
    ],
    gates: [
      { name: 'ready', passed: true, reasons: [] },
      { name: 'build', passed: true, reasons: [] },
      { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] },
      { name: 'test', passed: true, reasons: [] },
      { name: 'acceptance', passed: false, reasons: [
        'AC-1: unit:item-page-sections needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy',
        'AC-2: unit:item-page-technical-collapsed needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy',
      ] },
      { name: 'merge', passed: false, reasons: ['GitHub observation missing or older than two minutes', 'Pull request is not mergeable against the current base'] },
    ],
    sessions: [{ id: 'graphyard-cursor-1:1', tab: null, head: null, host: 'vishrog', kind: 'implementation', pane: 'w1V:p32M', role: null, epoch: null, state: 'running', attach: 'herdr pane attach w1V:p32M --workspace w1V',
      endedAt: null, outcome: null, runtime: 'claude', subject: 'GY-171: item page hierarchy', agentName: null, principal: 'graphyard-cursor-1', startedAt: at(-20 * minute), updatedAt: at(-20 * minute), workspace: 'w1V', transcript: null }],
    agentRequests: [{ id: 'scope-1', type: 'scope-request', epoch: 1, requestedBy: 'graphyard-cursor-1', at: at(-10 * minute), reason: 'The browser suite pins the old section name', paths: ['browser-tests/dashboard.spec.ts'],
      decider: { who: 'Master agent', command: 'graphyard master scope GY-171' }, releasedLease: false, state: 'open' }],
    nextAction: { kind: 'request-review', gate: 'review', refusal: 'Independent approval of the current commit is required', reason: 'the candidate passed the build gate', llmRole: 'judgment' },
  } as unknown as Work;
}

test('unit:item-page-sections — below the summary the item page shows What is left (plain lines grouped by step, naming who clears them), Requirements, Pull request and Activity, in that order, and no raw gate reason outside the collapsed technical section', () => {
  const all = board();
  const item = midReview(all.find(entry => entry.key === 'GY-15')!);
  const work = [...all, item];
  const html = page(item, work);
  const technical = html.indexOf('<details class="more-details" aria-label="Technical details">');
  assert.ok(technical > 0, 'the page has a Technical details section');
  const above = html.slice(0, technical);

  // The order: the summary (status sentence, who acts next, the seven-step tracker), then the four sections, then the technical detail.
  const order = ['class="status-sentence', 'Who acts next:', 'class="steps-detail', 'aria-label="What is left"', 'aria-label="Requirements"', 'aria-label="Pull request"', 'aria-label="Activity"', 'aria-label="Technical details"'].map(needle => html.indexOf(needle));
  assert.ok(order.every(index => index >= 0), `every section is rendered: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'summary, What is left, Requirements, Pull request, Activity, Technical details');

  // What is left: one plain line per unmet requirement, grouped by step, each group naming who clears it.
  const groups = whatIsLeft(item, NOW);
  assert.deepEqual(groups.map(group => [group.label, group.who, group.current]), [['Review', 'Reviewer agent', true], ['Prove', 'Prover agent', false], ['Merge', 'Builder agent', false]]);
  for (const group of groups) {
    const gate = item.gates.find(entry => ({ Review: 'review', Prove: 'acceptance', Merge: 'merge' } as Record<string, string>)[group.label] === entry.name)!;
    assert.deepEqual(group.lines, plainLines(gate), `${group.label}: every line is the gate reason's plain translation`);
  }
  assert.deepEqual(groups.flatMap(group => group.lines), ['Waiting for someone else to approve the latest code', 'The proof unit:item-page-sections has not passed yet', 'The proof unit:item-page-technical-collapsed has not passed yet', 'Graphyard is re-checking GitHub', 'The pull request conflicts with the main branch']);
  const left = html.slice(html.indexOf('aria-label="What is left"'), html.indexOf('aria-label="Requirements"'));
  assert.match(left, /<small>5 things<\/small>/);
  assert.match(left, /<section class="left-step" aria-label="Review step"><h3>Review <small>· cleared by Reviewer agent<\/small><\/h3>/);
  // The current step is open; the later steps are one click down, each still named with who clears it.
  assert.match(left, /<details class="later-steps"><summary>Later steps \(2\)<\/summary><section class="left-step" aria-label="Prove step"><h3>Prove <small>· cleared by Prover agent<\/small><\/h3>[\s\S]*<section class="left-step" aria-label="Merge step"><h3>Merge <small>· cleared by Builder agent<\/small><\/h3>/);
  assert.equal(left.match(/<li>/g)?.length, 5, 'one line per unmet requirement');

  // Requirements: one line per criterion with a met or pending mark; the full text on expand.
  const requirements = html.slice(html.indexOf('aria-label="Requirements"'), html.indexOf('aria-label="Pull request"'));
  assert.equal(requirements.match(/<details class="criterion-full"><summary><span class="criterion-mark" title="Pending">○<\/span> <span class="mono">AC-\d<\/span>/g)?.length, 2, 'each criterion once, marked pending');
  for (const ac of item.criteria) assert.ok(requirements.includes(`<p>${escape(ac.text)}</p></details>`), `${ac.id}: full text behind its line`);
  const shown = visibleWords(html.replace('<details class="panel requirements"', '<details open class="panel requirements"')).join(' ');
  assert.match(shown, /AC-1 Below the existing summary the item page shows What is left, Requirements, Pull request… unit:item-page-sections pending/, 'one line: the first sentence, capped');
  assert.doesNotMatch(shown, /A test renders a real-shaped item mid-review/, 'the rest waits for the expand');
  // A criterion whose every proof passed is marked met (GY-16 in the fixture: two of its three proofs passed).
  const proven = all.find(entry => entry.key === 'GY-16')!;
  const marks = [...page(proven, all).matchAll(/<span class="criterion-mark" title="(Met|Pending)">[✓○]<\/span> <span class="mono">(AC-\d)<\/span>/g)].map(match => `${match[2]} ${match[1]}`);
  assert.deepEqual(marks, ['AC-1 Met', 'AC-2 Met', 'AC-3 Pending']);

  // Pull request: link, 8-character commit, changed-file count, checks and review state.
  const pr = html.slice(html.indexOf('aria-label="Pull request"'), html.indexOf('aria-label="Activity"'));
  assert.match(pr, /<dt>Link<\/dt><dd><a class="pr-open" href="https:\/\/github\.com\/[^"]+\/pull\/42"/);
  assert.match(pr, /<code class="sha" title="d{40}">d{8}<\/code>/);
  assert.match(pr, /<dt>Changes<\/dt><dd>1 file<\/dd>/);
  assert.match(pr, /<dt>Checks<\/dt><dd>test passed · typecheck passed<\/dd>/);
  assert.match(pr, /<dt>Review<\/dt><dd>Waiting for approval<\/dd>/);

  // Activity: the latest few events in plain words; the full history on expand.
  const activity = html.slice(html.indexOf('aria-label="Activity"'), technical);
  assert.deepEqual([...activity.matchAll(/<li>([^<]+) <small>/g)].map(match => match[1]), ['Picked up by a builder', 'Released for work', 'Created']);
  assert.match(activity, /<details class="full-history"><summary>History \(3 events; routine GitHub checks and heartbeats left out\)<\/summary><section aria-label="Work history">/);
  const many = Array.from({ length: 9 }, (_, i) => ({ seq: 9 - i, kind: 'github.observed', actor: 'github', created_at: at(-i * minute) }));
  assert.equal(page(item, work, { events: many }).match(/<li>Graphyard checked GitHub <small>/g)?.length, 3, 'only the latest few above the fold');

  // No raw gate reason appears outside the collapsed technical section; inside it every one is kept.
  for (const gate of item.gates) for (const reason of gate.reasons) {
    assert.ok(!above.includes(escape(reason)) && !above.includes(reason), `raw reason outside Technical details: ${reason}`);
    assert.ok(html.slice(technical).includes(escape(reason)), `raw reason kept under Technical details: ${reason}`);
  }
  for (const fragment of ['needs trusted passing evidence', 'executed &gt; 0', 'older than two minutes', 'not mergeable against the current base', 'Independent approval of the current commit']) assert.ok(!above.includes(fragment), fragment);
});

test('unit:item-page-technical-collapsed — gate internals, sessions with attach commands, review provider, next action and executors and agent requests sit in one collapsed Technical details section; four overlapping items make exactly one overlap line', () => {
  const all = board();
  const item = midReview(all.find(entry => entry.key === 'GY-15')!);
  const html = page(item, [...all, item]);
  // One Technical details section, closed.
  assert.equal(html.match(/<details[^>]*aria-label="Technical details"/g)?.length, 1);
  assert.match(html, /<details class="more-details" aria-label="Technical details"><summary>Technical details<\/summary>/);
  const technical = html.indexOf('<details class="more-details" aria-label="Technical details">');
  const above = html.slice(0, technical), inside = html.slice(technical);
  assert.doesNotMatch(inside.slice(0, inside.indexOf('>') + 1), /\sopen/, 'collapsed');
  // Everything technical is inside it, and none of it is above it.
  const technicalParts = ['<h3>Gate decisions</h3>', '<h3>Sessions (1)</h3>', 'herdr pane attach w1V:p32M --workspace w1V', '<h3>Code review</h3>', 'Provider: Formal GitHub approval',
    '<h3>Next action and executors</h3>', '<code>request-review</code>', '<h3>Agent requests (1)</h3>', 'graphyard master scope GY-171', 'graphyard-cursor-1'];
  for (const part of technicalParts) {
    assert.ok(inside.includes(part), `inside Technical details: ${part}`);
    assert.ok(!above.includes(part), `not above Technical details: ${part}`);
  }
  // Nothing past the summary is visible: the section shows only its summary until opened.
  const visible = visibleWords(inside).join(' ');
  assert.equal(visible, 'Technical details');
  // It is the last thing on the page: nothing technical follows it outside a collapsed section.
  assert.ok(html.endsWith('</details></article>'));

  // Planned-file overlaps: four overlapping items make one line naming each of them and the shared paths.
  const peers = ['GY-166', 'GY-167', 'GY-168', 'GY-169'].map((key, i) => ({ ...item, id: `peer-${i}`, key, plannedFiles: i < 2 ? ['tests/'] : ['web/pages/'], observation: { ...item.observation!, files: [] }, sessions: [], agentRequests: [] }) as unknown as Work);
  const overlapping = { ...item, plannedFiles: ['web/', 'tests/'], observation: { ...item.observation!, files: [] } } as Work;
  const work = [...all, overlapping, ...peers];
  const line = overlapLine(overlapping, work);
  assert.equal(line, 'Shares files with GY-166, GY-167, GY-168, GY-169 (tests/, web/)');
  const rendered = page(overlapping, work);
  assert.equal(rendered.match(/class="overlap-line"/g)?.length, 1, 'exactly one overlap line');
  assert.equal(rendered.match(/Shares files with/g)?.length, 1);
  assert.doesNotMatch(rendered, /Possible overlap with/, 'no box per overlapping item');
  assert.ok(rendered.indexOf('class="overlap-line"') > rendered.indexOf('aria-label="Technical details"'), 'the overlap line is technical detail');
  // Two overlapping items name only themselves; none makes no line at all.
  assert.equal(overlapLine(overlapping, [...all, overlapping, ...peers.slice(0, 2)]), 'Shares files with GY-166, GY-167 (tests/)');
  const alone = { ...overlapping, plannedFiles: ['docs/'] } as Work;
  assert.equal(overlapLine(alone, [...all, alone]), null);
  assert.doesNotMatch(page(alone, [...all, alone]), /overlap-line/);
});

test('the Activity section reads the kinds the ledger records — command names and the control plane\'s own facts — and never calls a page of history the full history', () => {
  // Every command is recorded under its own name (src/engine.ts save(db, work, actor, command, …)); each reads as what happened.
  // Typed over every command: a command added to the engine without a plain label fails typecheck here.
  const commands: Record<Command, true> = { create: true, ready: true, requirements: true, reviewpolicy: true, unblock: true, rework: true, resolve: true, recover: true, claim: true, rereview: true,
    heartbeat: true, quarantine: true, launch: true, settle: true, autosettle: true, release: true, workspace: true, submit: true, blocked: true, scope: true, autoscope: true, evidence: true,
    deployment: true, revoke: true, session: true, request: true, repair: true };
  for (const command of Object.keys(commands)) assert.notEqual(activityLabel(command), 'Updated', `command ${command} has a plain label`);
  assert.deepEqual(['create', 'ready', 'claim', 'submit', 'rework', 'review.requested', 'merge.execution.committed', 'delivery.verified', 'human.requested', 'github.observed'].map(activityLabel),
    ['Created', 'Released for work', 'Picked up by a builder', 'Handed in', 'Sent back for changes', 'Review requested', 'Merged', 'Live in production', 'Asked you for a decision', 'Graphyard checked GitHub']);
  // The merge and the release serving it are two facts: the feed never shows two merges.
  assert.notEqual(activityLabel('delivery.verified'), activityLabel('merge.execution.committed'));
  assert.equal(activityLabel('something.unheard.of'), 'Updated');
  // The page reads one page of /api/events and does not follow the cursor.
  assert.equal(historyPage, eventHistoryLimits.page);
  // The page reads without routine=include, so no label ever calls the loaded rows the full history.
  assert.equal(historyLabel(3), 'History (3 events; routine GitHub checks and heartbeats left out)');
  assert.equal(historyLabel(historyPage), `Latest ${historyPage} events — older history and routine GitHub checks and heartbeats are not loaded here`);
  const all = board();
  const item = midReview(all.find(entry => entry.key === 'GY-15')!);
  const full = Array.from({ length: historyPage }, (_, i) => ({ seq: historyPage - i, kind: 'claim', actor: 'worker-3', created_at: at(-i * minute) }));
  const html = page(item, [...all, item], { events: full });
  assert.match(html, /<summary>Latest 300 events — older history and routine GitHub checks and heartbeats are not loaded here<\/summary>/);
  assert.doesNotMatch(html, /Full history/);
});

test('What is left names who clears each step from the refusal itself: exhausted reviewers and unverified branch protection are the master agent\'s, not the reviewer\'s or the builder\'s', () => {
  const all = board();
  const base = midReview(all.find(entry => entry.key === 'GY-15')!);
  const gate = (name: string, reasons: string[]) => ({ name, passed: reasons.length === 0, reasons });
  // Every reviewer profile exhausted, current step Review: the panel and "Who acts next" agree on the master agent.
  const exhausted = { ...base, gates: [gate('ready', []), gate('build', []), gate('test', []), gate('acceptance', []), gate('merge', ['GitHub observation missing or older than two minutes']),
    gate('review', ['Every configured reviewer profile is exhausted for this candidate (reviewer-a); add reviewer capacity or select another review provider'])] } as unknown as Work;
  const work = [...all, exhausted];
  const [current] = whatIsLeft(exhausted, NOW);
  assert.deepEqual([current.label, current.who], ['Review', 'Master agent']);
  assert.equal(prSteps(exhausted, NOW).who, 'Master agent');
  assert.equal(nextActor(exhausted, groupWithin(exhausted, work, NOW), NOW).who, 'Master agent');
  assert.match(page(exhausted, work), /<h3>Review <small>· cleared by Master agent<\/small><\/h3>/);
  // Branch protection not verified, as a later step: the master agent, not the builder.
  const protection = { ...base, gates: [gate('ready', []), gate('build', []), gate('test', []), gate('acceptance', []), gate('review', ['Independent approval of the current commit is required']),
    gate('merge', ['Required Graphyard check and merge-queue branch protection have not been verified'])] } as unknown as Work;
  assert.deepEqual(whatIsLeft(protection, NOW).map(group => [group.label, group.who]), [['Review', 'Reviewer agent'], ['Merge', 'Master agent']]);
  // A conflict with the base and unresolved review threads are the builder's to clear on a new head.
  const threads = { ...protection, gates: [...protection.gates.filter(entry => entry.name !== 'merge'), gate('merge', ['Branch protection requires conversation resolution and 2 review threads are unresolved on 594f711015d0: a on b:1; c on d:2. GitHub blocks the merge until each is resolved'])] } as unknown as Work;
  assert.deepEqual(whatIsLeft(threads, NOW).map(group => [group.label, group.who]), [['Review', 'Reviewer agent'], ['Merge', 'Builder agent']]);
  // A blocker recorded before the hand-in fails the ready gate: the item is Blocked, and only the
  // master agent clears it — the What is left group and Who acts next both say so.
  const blocker = 'Needs the staging database credentials';
  const blocked = { ...base, submission: null, candidate: null, observation: null, reworkRequested: false, blocker, lease: { owner: 'graphyard-codex-1', epoch: 1, expiresAt: at(30 * minute) },
    gates: [gate('ready', [blocker]), gate('build', ['Worker has not submitted implementation for this attempt', 'Pull request has not been independently observed']),
      gate('review', ['Independent approval of the current commit is required']), gate('test', []), gate('acceptance', []), gate('merge', ['GitHub observation missing or older than two minutes'])] } as unknown as Work;
  const blockedAll = [...all, blocked];
  const [held] = whatIsLeft(blocked, NOW);
  assert.deepEqual([held.label, held.who], ['Build', 'Master agent']);
  assert.ok(held.lines.some(line => line.includes(blocker)), 'the blocker is shown as written');
  assert.equal(nextActor(blocked, groupWithin(blocked, blockedAll, NOW), NOW).who, 'Master agent');
  assert.match(page(blocked, blockedAll), /<h3>Build <small>· cleared by Master agent<\/small><\/h3>/);
  // A parked human-only decision is also a ready-gate blocker, but it is yours: the panel agrees
  // with "Who acts next" and the request card.
  const request = { id: 'hr-1', kind: 'money-or-accounts' as const, needed: 'A Railway workspace for the staging proof', reason: 'The proof needs a paid workspace', requestedBy: 'graphyard-codex-1', at: at(-minute), epoch: 1, answer: null };
  const parkedBlocker = describeHumanRequest(request);
  const parked = { ...blocked, blocker: parkedBlocker, humanRequest: request, lease: null,
    gates: [gate('ready', [parkedBlocker]), ...blocked.gates.filter(entry => entry.name !== 'ready')] } as unknown as Work;
  const parkedAll = [...all, parked];
  assert.deepEqual(whatIsLeft(parked, NOW).map(group => [group.label, group.who])[0], ['Build', 'You']);
  assert.equal(nextActor(parked, groupWithin(parked, parkedAll, NOW), NOW).who, 'You');
  assert.match(page(parked, parkedAll), /<h3>Build <small>· cleared by You<\/small><\/h3>/);
  // An item not yet released from the backlog: only the master agent releases it, not the builder
  // assignment the Build step would otherwise name.
  const unreleased = { ...blocked, blocker: null, ready: false, lease: null,
    gates: [gate('ready', ['Not released from backlog']), ...blocked.gates.filter(entry => entry.name !== 'ready')] } as unknown as Work;
  const unreleasedAll = [...all, unreleased];
  assert.deepEqual(whatIsLeft(unreleased, NOW).map(group => [group.label, group.who])[0], ['Build', 'Master agent']);
  assert.equal(nextActor(unreleased, groupWithin(unreleased, unreleasedAll, NOW), NOW).who, 'Master agent');
});
