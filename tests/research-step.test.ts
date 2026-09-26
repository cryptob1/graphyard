import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Work } from '../src/model.js';
import { researchStatus, requirementsRevision, type ResearchRecord } from '../src/research.js';
import { classifyWait, computeFlow, deriveFacts, flowDrilldown, gateFactStep, stepMoves, type FlowDataset, type FlowFact, type LedgerEvent } from '../src/flow-analytics.js';
import { prSteps, researchStepState, stepIds, stepSince } from '../web/pr-steps.js';
import StepsBar, { StepsDetail } from '../web/components/steps-bar.js';
import WorkCard from '../web/components/work-card.js';
import WorkDetails from '../web/pages/work-details.js';
import WorkersPage from '../web/pages/workers.js';
import { LandedPerDay, ResearchEffect, WhereTimeGoes } from '../web/pages/insights-flow.js';
import { groupOf, nextActor } from '../web/groups.js';
import { noRelease, releaseView } from '../web/release.js';

// GY-434: research is a first-class step. The step model leads with it — before Build — and every
// step display shows it in order with its state: done once a brief is recorded, current while a
// run is live or awaited, skipped (never missing, never failed) where no brief will exist. The
// item page shows the brief itself and what the run cost, Workers lists live runs, and flow
// analytics record time in research and research's effect. Everything here is pure: no database,
// no runner, no control plane — the derivations the dashboard and the report draw.

const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const hour = 3_600_000, minute = 60_000, day = 86_400_000;
const at = (ms: number) => new Date(NOW + ms).toISOString();

const gates = (spec: Record<string, string[]> = {}) =>
  ['ready', 'build', 'test', 'review', 'acceptance', 'merge'].map(name => ({
    name, passed: (spec[name] ?? []).length === 0, reasons: spec[name] ?? [],
  }));
const building = gates({ build: ['Worker has not submitted implementation for this attempt'] });

function item(overrides: Partial<Work> = {}): Work {
  return {
    id: overrides.id ?? '11111111-1111-4111-8111-111111111111', key: 'GY-1', title: 'Research as a step', description: 'Research before build', type: 'feature', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'The research step renders everywhere steps do.', proofs: ['unit:research-step-rendered'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['web/pr-steps.ts'], stage: 'ready', revision: 3, policyRevision: 1,
    createdAt: at(-2 * day), updatedAt: at(0), stageEnteredAt: at(-hour), ready: true,
    epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: building, violations: [],
    ...overrides,
  } as Work;
}

const revision = requirementsRevision({ title: 'Research as a step', description: 'Research before build', criteria: [{ id: 'AC-1', text: 'The research step renders everywhere steps do.', proofs: ['unit:research-step-rendered'] }] });

function brief(state: ResearchRecord['state'], startedAgo: number, endedAgo: number | null, tokens: number | null = 12_000): ResearchRecord {
  const askedAt = at(-(endedAgo ?? startedAgo));
  return {
    revision, state, startedAt: at(-startedAgo), endedAt: endedAgo === null ? null : at(-endedAgo),
    runtime: 'pi', model: 'zai/glm-5.3-flash', timeoutMs: 15 * minute, tokenBudget: 200_000, tokens,
    failure: state === 'failed' ? { reason: 'timeout', detail: 'No research run finished within 15 minutes; build proceeds without a brief' } : null,
    recordedBy: 'graphyard-master',
    brief: state === 'recorded' ? {
      existingCode: [{ path: 'web/pr-steps.ts', note: 'the step model every display reads' }, { path: 'src/flow-analytics.ts', note: 'the flow facts the report aggregates' }],
      patterns: [{ pattern: 'Design doc before implementation', source: 'https://rfc.example' }],
      risks: ['a run that never ends must not hold dispatch', 'a stale brief must not read as current'],
      approach: 'Lead the step model with research and derive its state from the item record.',
    } : null,
    questions: [
      { id: '6a1e0a58-0000-4000-8000-000000000001', kind: 'goals-and-priorities', question: 'Should the brief be collapsed on the item page?', why: 'The first screen stays lean.', recommendation: 'Collapsed by default, one click to open', at: askedAt, deadline: at(hour),
        answer: { by: 'operator', at: at(-minute), text: 'Collapsed by default, one click to open', differs: false, epoch: 1, inFlight: false, waitedMs: minute } },
      { id: '6a1e0a58-0000-4000-8000-000000000002', kind: 'goals-and-priorities', question: 'How much of the token spend should show?', why: 'Research cost is operator-visible.', recommendation: 'Model, duration and tokens under the summary', at: askedAt, deadline: at(hour), answer: null },
    ],
  };
}

test('unit:research-step-rendered — the step model leads with research: done on a researched feature, current while researching, skipped on a bug, and every display shows it in order with its state', () => {
  assert.deepEqual([...stepIds], ['research', 'build', 'validate', 'test', 'review', 'prove', 'merge', 'deploy'], 'research is the first step');
  const researching = item({ researchBrief: brief('running', 5 * minute, null, null) });
  const researched = item({ id: '22222222-2222-4222-8222-222222222222', key: 'GY-2', researchBrief: brief('recorded', 30 * minute, 5 * minute) });
  const skippedBug = item({ id: '33333333-3333-4333-8333-333333333333', key: 'GY-3', type: 'bug' });
  const failedResearch = item({ id: '44444444-4444-4444-8444-444444444444', key: 'GY-4', researchBrief: brief('failed', 30 * minute, 16 * minute, null) });

  // A researching feature: research is the current step, live or awaited, and the research agent acts.
  const live = prSteps(researching, NOW);
  assert.equal(researchStepState(researching, NOW), 'current');
  assert.equal(live.current, 'research');
  assert.equal(live.steps[0].state, 'current');
  assert.equal(live.label, 'Researching · the research session is writing the brief');
  assert.equal(live.who, 'Research agent');
  // A researched feature: the brief is recorded, research is done, build is what waits.
  const done = prSteps(researched, NOW);
  assert.equal(researchStepState(researched, NOW), 'done');
  assert.equal(done.steps[0].id, 'research');
  assert.equal(done.steps[0].state, 'done', 'a recorded brief is done');
  assert.equal(done.current, 'build', 'with the brief in hand, the build is the step that waits');
  // A skipped bug: research never ran and never will — skipped, never missing, never failed, never pending.
  const bug = prSteps(skippedBug, NOW);
  assert.equal(researchStepState(skippedBug, NOW), 'skipped');
  assert.equal(bug.steps[0].state, 'skipped', 'a skipped bug renders research as skipped');
  assert.equal(bug.current, 'build');
  assert.equal(bug.steps.every(step => step.state !== ('failed' as string)), true, 'no step reads as failed');
  // A failed research run is skipped too: the build proceeds without a brief.
  assert.equal(prSteps(failedResearch, NOW).steps[0].state, 'skipped', 'a failed run renders as skipped, never failed');
  // Research not configured: the loop publishes that it does not research (status
  // `research.configured`), so a released feature no run will start for reads skipped — before a
  // builder claims it and after. Only on a loop that researches is it pending, awaiting its run.
  const configured = { ...noRelease, researchConfigured: true };
  assert.equal(releaseView({ research: { configured: true } }).researchConfigured, true, 'the status read carries whether the loop researches');
  assert.equal(releaseView({}).researchConfigured, false, 'a loop that never said so does not research');
  const released = item({ id: '88888888-8888-4888-8888-888888888888', key: 'GY-8' });
  assert.equal(researchStepState(released, NOW), 'skipped', 'unconfigured, before a claim: a released feature reads skipped, not pending');
  assert.equal(prSteps(released, NOW).steps[0].state, 'skipped');
  assert.equal(prSteps(released, NOW).current, 'build', 'with no research to wait for, the build is the step that waits');
  assert.equal(researchStepState(released, NOW, true), 'pending', 'configured, before a claim: its run has still to start');
  assert.equal(prSteps(released, NOW, configured).steps[0].state, 'pending');
  const claimedUnresearched = item({ id: '66666666-6666-4666-8666-666666666666', key: 'GY-6', lease: { owner: 'worker-1', epoch: 1, expiresAt: at(hour) } } as Partial<Work>);
  assert.equal(researchStepState(claimedUnresearched, NOW), 'skipped', 'unconfigured, after a claim: a feature built without research reads skipped');
  assert.equal(researchStepState(claimedUnresearched, NOW, true), 'skipped', 'configured, after a claim without a run: skipped, not pending');
  assert.equal(prSteps(claimedUnresearched, NOW, configured).steps[0].state, 'skipped');
  assert.equal(researchStepState(item({ research: false } as Partial<Work>), NOW), 'skipped', 'research: false skips the step');
  // Handed in or merged without a brief, research still reads skipped, never done; with one, done.
  const handedIn = item({ id: '77777777-7777-4777-8777-777777777777', key: 'GY-7', type: 'bug', submission: { pr: 7, epoch: 1, submittedAt: at(-hour) } as any, gates: gates({ review: ['Independent approval of the current commit is required'] }) });
  assert.equal(prSteps(handedIn, NOW).steps[0].state, 'skipped', 'handed-in unresearched work keeps research skipped');
  assert.equal(prSteps({ ...handedIn, stage: 'done', gates: gates() } as Work, NOW).steps[0].state, 'skipped', 'merged unresearched work keeps research skipped');
  assert.equal(prSteps({ ...researched, submission: { pr: 8, epoch: 1, submittedAt: at(-hour) } as any, stage: 'done', gates: gates() } as Work, NOW).steps[0].state, 'done', 'merged researched work reads research done');
  // Past its bound, a still-running record is awaited no longer: pending until the loop fails it.
  assert.equal(researchStepState(researching, NOW + 20 * minute), 'pending');

  // Every display shows the step in order with its state.
  const markup = (element: ReactElement) => renderToStaticMarkup(element);
  const liveBar = markup(createElement(StepsBar, { steps: live }));
  assert.match(liveBar, /data-step="research" data-state="current"/);
  assert.match(liveBar, /Researching · the research session is writing the brief/);
  assert.match(markup(createElement(StepsBar, { steps: done })), /data-step="research" data-state="done"/);
  const bugBar = markup(createElement(StepsBar, { steps: bug }));
  assert.match(bugBar, /data-step="research" data-state="skipped"/, 'the skipped step is its own segment');
  assert.equal((bugBar.match(/data-step="/g) ?? []).length, stepIds.length, 'skipped is a segment, never missing');
  // The item page's step list names the skipped step Skipped, not Pending.
  const detail = markup(createElement(StepsDetail, { steps: bug }));
  assert.match(detail, /data-step="research" data-state="skipped"/);
  assert.match(detail, /<span class="step-mark"[^>]*>–<\/span>Research/);
  assert.match(detail, /<span class="step-note">Skipped<\/span>/);
  // The board: a researching item is somebody working on it, and the research agent acts next.
  assert.equal(groupOf(researching, NOW), 'moving', 'a researching feature is moving, not waiting for a worker');
  assert.deepEqual(nextActor(researching, 'moving', NOW), { who: 'Research agent', does: live.label });
  // The work card draws the same bar and the same current step.
  const card = markup(createElement(WorkCard, { item: researching, now: NOW, onOpen: () => {} }));
  assert.match(card, /data-step="research" data-state="current"/);
  assert.ok(card.includes(live.label), 'the card labels the researching step');
  // The research step keeps its own start: the "In step" clock runs from the run's start.
  assert.equal(stepSince(researching, NOW), researching.researchBrief!.startedAt);
  assert.equal(stepSince(researched, NOW), researched.stageEnteredAt, 'a researched feature keeps the builder clock');
  // The gate-based reading of recorded facts is unchanged: research never comes from a gate fact.
  assert.equal(gateFactStep({ stage: 'ready', unmet: ['build'], firstUnmet: 'build', reasons: ['Worker has not submitted implementation for this attempt'], hasCandidate: false, researchRunning: true }), null,
    'research moves come from the research facts, not the gates');
});

test('unit:research-brief-visible — the item page shows the brief itself, its cost collapsed by default, and Workers lists live research runs as Researches sessions', () => {
  const noop = () => {};
  const researched = item({ researchBrief: brief('recorded', 30 * minute, 5 * minute) });
  const dashboard = (work: Work[]) => ({
    token: 'fixture', work, status: { actor: { id: 'operator', role: 'admin' }, repository: 'fixture/shop' }, error: '', connected: true, lastUpdated: '12:00:00',
    view: 'work', setView: noop, filter: null, setFilter: noop, selected: null, setSelected: noop, creating: false, setCreating: noop, busy: false, setBusy: noop,
    observedAt: NOW, jobs: [], query: '', setQuery: noop, operatorAgents: [], operatorAgentsError: null, features: { validation: null, releases: null, automation: null },
    events: [], editingRequirements: false, setEditingRequirements: noop, codexAvailable: false, queue: [], sessionEpoch: { current: 0 },
    api: async () => ({}), refresh: async () => {}, action: async () => {}, setError: noop, signOut: noop,
  }) as any;
  const page = renderToStaticMarkup(createElement(WorkDetails, { ...dashboard([researched]), item: researched }));
  // The brief panel is collapsed by default and one click to open.
  const panel = /<details class="panel research-brief" data-research="recorded" aria-label="Research brief">([\s\S]*?)<\/details>/.exec(page)?.[1];
  assert.ok(panel, 'the item page has a research brief panel');
  assert.doesNotMatch(page, /<details class="panel research-brief"[^>]*\sopen/, 'collapsed by default');
  // Every brief section is there: approach, existing code paths, patterns, risks, questions with state.
  assert.match(panel, /<h3>Approach<\/h3><p>Lead the step model with research/);
  assert.match(panel, /<h3>Existing code<\/h3>/);
  assert.match(panel, /<code>web\/pr-steps\.ts<\/code> — the step model every display reads/);
  assert.match(panel, /<h3>Patterns and prior art<\/h3>/);
  assert.match(panel, /Design doc before implementation <small>\(https:\/\/rfc\.example\)<\/small>/);
  assert.match(panel, /<h3>Risks and edge cases<\/h3>/);
  assert.match(panel, /a run that never ends must not hold dispatch/);
  assert.match(panel, /<h3>Product questions<\/h3>/);
  assert.match(panel, /answered by operator: Collapsed by default, one click to open/, 'the answered question shows its answer');
  assert.match(panel, /provisional, built on the recommendation: Model, duration and tokens under the summary/, 'the open question shows its recommendation');
  // The cost: model, duration and token spend, on the summary line.
  assert.match(page, /Research brief <small>zai\/glm-5.3-flash · 25m · ≈12,000 tokens<\/small>/);
  // A failed run and a running one read as themselves, never as a brief.
  const failed = item({ id: '44444444-4444-4444-8444-444444444444', key: 'GY-4', researchBrief: brief('failed', 30 * minute, 16 * minute, null) });
  assert.match(renderToStaticMarkup(createElement(WorkDetails, { ...dashboard([failed]), item: failed })), /data-research="failed"[\s\S]*produced no brief/);
  const running = item({ id: '55555555-5555-4555-8555-555555555555', key: 'GY-5', researchBrief: brief('running', 5 * minute, null, null) });
  assert.match(renderToStaticMarkup(createElement(WorkDetails, { ...dashboard([running]), item: running })), /data-research="running"[\s\S]*writing the brief now/);
  // Workers: the live run is a session row of its own — role Researches, the model, its item, since when.
  const workers = renderToStaticMarkup(createElement(WorkersPage, { ...dashboard([researched, running]), observedAt: NOW, setSelected: noop }));
  assert.match(workers, /data-role="researches"/, 'the research run is listed as a session');
  assert.match(workers, /<td data-label="Role">Researches<\/td>/);
  assert.match(workers, /Researching GY-5 on zai\/glm-5.3-flash before build/, 'the row names the model it runs on');
  assert.match(workers, /data-spent="300000"/, 'the row counts from when the run started');
  assert.match(workers, /<span class="mono">GY-5<\/span>/, 'the row names its item');
  // A brief already recorded holds no Workers row: the run is over.
  assert.doesNotMatch(workers, /Researching GY-1/, 'a recorded brief is not a live research session');
});

test('unit:research-in-flow-analytics — flow analytics record time in research, the step history and waiting categories include it, and research\u2019s effect is compared from ledger events', () => {
  const head = 'a'.repeat(40), base = 'b'.repeat(40);
  // Two features: GY-1 researched before its build (a 30-minute run, then a rework-free review);
  // GY-2 built straight from the ticket, one rework round, one review demanding changes.
  const researched = item({ researchBrief: brief('recorded', 30 * minute, 0) });
  const unresearched = item({ id: '22222222-2222-4222-8222-222222222222', key: 'GY-2', createdAt: at(-day) });
  const event = (work: Work, kind: string, when: number): LedgerEvent =>
    ({ seq: ++sequence, work_id: work.id, actor: 'fixture', kind, payload: { work }, created_at: at(when) });
  let sequence = 0;
  const events: LedgerEvent[] = [
    event(researched, 'create', -2 * day),
    event(researched, 'ready', -2 * day + minute),
    // The research run: started half an hour before build, its brief recorded at the half hour.
    event({ ...researched, researchBrief: brief('running', 30 * minute, null, null) }, 'research.started', -30 * minute),
    event(researched, 'research.recorded', 0),
    event({ ...researched, lease: { owner: 'worker-1', epoch: 1, expiresAt: at(hour) }, stage: 'build', stageEnteredAt: at(minute) }, 'claim', minute),
    event(unresearched, 'create', -day),
    event(unresearched, 'ready', -day + minute),
    event({ ...unresearched, lease: { owner: 'worker-2', epoch: 1, expiresAt: at(hour) }, stage: 'build', stageEnteredAt: at(-3 * hour) }, 'claim', -3 * hour),
    event({ ...unresearched, candidate: { pr: 501, sha: head, baseSha: base, branch: 'graphyard/gy-2-1', author: 'worker-2', createdAt: at(-2 * hour) }, stage: 'review', stageEnteredAt: at(-2 * hour),
      observation: { candidate: { pr: 501, sha: head, baseSha: base, branch: 'graphyard/gy-2-1', author: 'worker-2', createdAt: at(-2 * hour) }, reviews: [{ id: 1, reviewer: 'reviewer-1', state: 'CHANGES_REQUESTED', sha: head, submittedAt: at(-hour) }], checks: [], files: ['web/pr-steps.ts'] } as any }, 'github.observed', -hour),
    event({ ...unresearched, candidate: { pr: 501, sha: head, baseSha: base, branch: 'graphyard/gy-2-1', author: 'worker-2', createdAt: at(-2 * hour) }, reworkRequested: true, stage: 'build', stageEnteredAt: at(-30 * minute) }, 'rework', -30 * minute),
  ];
  const facts: FlowFact[] = [];
  const states = new Map<string, any>();
  for (const ledgerEvent of events) {
    const state = states.get(ledgerEvent.work_id) ?? {};
    states.set(ledgerEvent.work_id, state);
    facts.push(...deriveFacts(ledgerEvent, state));
  }
  const latest = (kind: string, workId: string) => facts.filter(fact => fact.kind === kind && fact.workId === workId).at(-1);
  const dataset = {
    observedAt: at(2 * minute), from: at(-7 * day), to: at(2 * minute), days: 7 as const,
    work: [researched, unresearched], included: [researched, unresearched], facts,
    latest: ['work.created', 'work.released', 'gates.changed', 'lease.claimed', 'candidate.observed', 'rework.requested', 'research.recorded']
      .flatMap(kind => [latest(kind, researched.id), latest(kind, unresearched.id)]).filter((fact): fact is FlowFact => !!fact),
    carryIn: [], deployments: [], mergedForDeployments: [], scanned: facts.length, truncated: false, workTruncated: false, deploymentsTruncated: false, deploymentMergesTruncated: false,
    projection: { lastEvent: sequence, updatedAt: at(2 * minute), pendingEvents: 0, pendingCapped: false },
  } as unknown as FlowDataset;
  const report = computeFlow(dataset, { days: 7 });
  // Time in research, from the run's start to its recorded brief.
  assert.equal(report.research.runs, 1);
  assert.equal(report.research.briefs, 1);
  assert.equal(report.research.duration.n, 1, 'the run is timed from start to brief');
  assert.equal(report.research.duration.medianMs, 30 * minute);
  // The step dwell has a research stay, and the step history plays the two research moves.
  const researchDwell = report.stepDwell.find(entry => entry.step === 'research')!;
  assert.equal(researchDwell.n, 1);
  assert.equal(researchDwell.medianMs, 30 * minute);
  const moves = stepMoves(dataset, researched);
  assert.deepEqual(moves.map(move => `${move.from ?? 'outside'}>${move.to ?? 'outside'}`), ['outside>research', 'research>outside', 'outside>build']);
  const drilldown = flowDrilldown(dataset, report, { metric: 'steps' });
  const details = drilldown.rows.filter(row => row.workKey === 'GY-1').map(row => row.detail);
  assert.ok(details.includes('outside to research') && details.includes('research to outside'), 'the step-move history includes research');
  // Where work is waiting: a released item with a live run is Researching, not merely in implementation.
  assert.equal(classifyWait({ released: true, hasCandidate: false, researchRunning: true, unmet: ['build'] }, false), 'research');
  assert.ok(report.bottleneck.categories.some(category => category.id === 'research'), 'the bottleneck summary carries the research category');
  // The effect: the researched feature reworked nothing and drew no findings; the unresearched one drew one of each.
  assert.equal(report.research.effect.researched.items, 1);
  assert.equal(report.research.effect.unresearched.items, 1);
  assert.equal(report.research.effect.researched.reworkRounds.median, 0);
  assert.equal(report.research.effect.unresearched.reworkRounds.median, 1);
  assert.equal(report.research.effect.researched.reviewFindings.median, 0);
  assert.equal(report.research.effect.unresearched.reviewFindings.median, 1);
  assert.ok(report.definitions.research, 'the report defines the research metric');
  // A feature researched before the window opened is researched, never counted as unresearched:
  // its brief is in the item's latest facts even though the window holds none of its research facts.
  const earlier = item({ id: '99999999-9999-4999-8999-999999999999', key: 'GY-9', researchBrief: brief('recorded', 10 * day + 30 * minute, 10 * day), createdAt: at(-11 * day) });
  const earlierState = {};
  const earlierFacts = [
    event(earlier, 'create', -11 * day), event(earlier, 'ready', -11 * day + minute),
    event({ ...earlier, researchBrief: brief('running', 10 * day + 30 * minute, null, null) }, 'research.started', -10 * day - 30 * minute),
    event(earlier, 'research.recorded', -10 * day),
  ].flatMap(ledgerEvent => deriveFacts(ledgerEvent, earlierState));
  const earlierLatest = ['work.created', 'research.recorded'].map(kind => earlierFacts.filter(fact => fact.kind === kind).at(-1)!);
  assert.equal(earlierLatest.length, 2);
  const withEarlier = computeFlow({ ...dataset, work: [...dataset.work, earlier], included: [...dataset.included, earlier], latest: [...dataset.latest, ...earlierLatest] } as FlowDataset, { days: 7 });
  assert.equal(withEarlier.research.runs, 1, 'the earlier run is outside the window');
  assert.equal(withEarlier.research.effect.researched.items, 2, 'researched before the window still counts as researched');
  assert.equal(withEarlier.research.effect.unresearched.items, 1, 'and never dilutes the unresearched cohort');
  // Insights draws research as a step: its median in where the time goes, and its effect panel.
  const insights = (element: ReactElement) => renderToStaticMarkup(element);
  assert.match(insights(createElement(WhereTimeGoes, { report })), /Research/, 'where the time goes lists the research step');
  const effect = insights(createElement(ResearchEffect, { report }));
  assert.match(effect, /1 run · 1 brief · 0 without a brief · median 30m/);
  assert.match(effect, /<small>last 7 days<\/small>/);
  assert.match(insights(createElement(ResearchEffect, { report: { ...report, window: { ...report.window, days: 30 } } })), /<small>last 30 days<\/small>/, 'the panel names the report window');
  assert.match(effect, /<tr data-cohort="researched"><th scope="row">Researched<\/th><td>1<\/td><td>0\.0<\/td><td>0\.0<\/td><\/tr>/);
  assert.match(effect, /<tr data-cohort="unresearched"><th scope="row">Not researched<\/th><td>1<\/td><td>1\.0<\/td><td>1\.0<\/td><\/tr>/);
  // Landed per day splits each day's deliveries by whether they were built from a brief.
  assert.ok(report.throughput.every(entry => typeof entry.researched === 'number'), 'every landed day counts its researched deliveries');
  const landed = insights(createElement(LandedPerDay, { report: { ...report, throughput: [{ bucket: at(-day), delivered: 3, researched: 2, covered: true }] } }));
  assert.match(landed, /data-researched="2"/);
  assert.match(landed, /3 on [0-9-]+, 2 built from a research brief/);
  // master status counts research runs live, waiting and failed.
  const live = item({ id: '33333333-3333-4333-8333-333333333333', key: 'GY-3', researchBrief: brief('running', 5 * minute, null, null) });
  const failed = item({ id: '44444444-4444-4444-8444-444444444444', key: 'GY-4', researchBrief: brief('failed', 30 * minute, 16 * minute, null) });
  const waiting = item({ id: '55555555-5555-4555-8555-555555555555', key: 'GY-5' });
  const built = { ...unresearched, candidate: { pr: 501, sha: head, baseSha: base } } as Work;
  const claimed = item({ id: '66666666-6666-4666-8666-666666666666', key: 'GY-6', lease: { owner: 'worker-1', epoch: 1, expiresAt: at(hour) } } as Partial<Work>);
  const counts = researchStatus([researched, built, live, failed, waiting, claimed], NOW, true);
  assert.deepEqual(counts.live.map(line => line.key), ['GY-3']);
  assert.equal(counts.live[0].model, 'zai/glm-5.3-flash');
  assert.deepEqual(counts.failed.map(line => line.key), ['GY-4']);
  assert.deepEqual(counts.waiting.map(line => line.key), ['GY-5'], 'a released feature with no run is waiting for its research; one a builder holds is not');
  // A loop that does not research has no run to wait for: nothing is waiting, before a claim or after.
  const unconfigured = researchStatus([researched, built, live, failed, waiting, claimed], NOW, false);
  assert.deepEqual(unconfigured.waiting, [], 'unconfigured, no released feature waits for research');
  assert.deepEqual(unconfigured.live.map(line => line.key), ['GY-3'], 'a run already recorded is still reported as it stands');
});
