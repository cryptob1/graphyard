import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { attentionKind, classifyAttention, faultCatalogue, faultClasses, faultClassOf, faultClassItem, faultKinds, groupFaults, isFaultKind, escalationFaultKind, noteActionOutcome, noteFault, recurringClasses, retainedFaultInstances, statusFaults, trackFaults, workFaults, type FaultClass, type FaultInstance } from '../src/model/fault-classes.js';
import { workOriginSchema } from '../src/model/interventions.js';
import { escalationTriggers, type Work } from '../src/model.js';
import { applyRegistryMutation, emptyRegistry, fleetRoles, fleetView, proposedRuntimes, type AgentRegistry, type FleetSession } from '../src/model/registry.js';
import { agentOwner, buildMasterStatus, controlPlaneAttention, installationSources, masterConfigSchema, workAttentionCauses, type AttentionItem, type MasterConfig } from '../src/master.js';
import { cycleFailureAttentionAfter, cycleFaults, daemonActionFaultKind, daemonActionKinds, daemonEffects, daemonSummary, emptyDaemonState, endFailingRuns, fileRecurringFaultClasses, herdrFaultKinds, loopAttention, loopLiveness, noteConfigReload, noteCycleFailure, noteWatchdog, onceAnnotations, faultObservationIntervalMs, deploymentObservationSchema, pruneDaemonState, reconcilePendingActions, retainedActions, runCycle, storeAction, timingFaultAttention, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { attributeAttention, derivedAttention, faulted } from '../src/master-status.js';
import { unansweredRequestAttention } from '../src/cli/unanswered-requests.js';
import { retryStopAttention } from '../src/retry-stop.js';
import { stoppedFollowUpAttention, type ReviewRecord } from '../src/reviewer.js';
import type { ResourceReading } from '../src/master-resources.js';
import { predictQueue } from '../src/merge-queue.js';
import { describeHumanRequest } from '../src/model/human-request.js';
import { ExecutorRegistry, describeUnserved, executorLiveMs, executorReport } from '../src/model/executor-presence.js';
import type { ActionRow } from '../src/model/actions.js';
import { executorRunnableKinds, type NextActionKind } from '../src/model/action-kinds.js';
import { detailChanged } from '../src/daemon/decisions.js';
import { performSelfUpgrade } from '../src/daemon/upgrade.js';
import { executorFleet } from '../src/cli/executor-report.js';
import { loopMergerExecutorKinds, writeExecutorDeclaration, type SystemctlRunner } from '../src/repository-setup.js';
import { loopSupervision, loopSupervisionAttention } from '../src/supervisor.js';
import { fleetStatus } from '../src/master/attention.js';
import type { FleetView } from '../src/model/registry.js';
import { scopeRefusalBlocker } from '../src/model/scope.js';
import { NOW, boardApi, boardStatus, boardWork } from '../browser-tests/ui-board.js';
import OverviewPage from '../web/pages/overview.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-173: recurring faults were fixed one instance at a time, and noticing that several symptoms
// share a cause was a coordinator's memory. Every fault the loop records now carries a class from
// one shipped catalogue, status and the dashboard group by class, and a class that recurs past the
// threshold files one structural item that later instances link to.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const hour = 3_600_000;
const policy = { threshold: 3, windowHours: 24 };

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [] });
}
function item(key: string, overrides: Partial<Work> = {}): Work {
  return {
    id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'backlog', revision: 1, policyRevision: 1,
    createdAt: iso(-hour), updatedAt: iso(0), stageEnteredAt: iso(-hour), ready: false, epoch: 0, lease: null, workspaces: [],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [], ...overrides,
  } as unknown as Work;
}
const blocked = (key: string) => item(key, { blocker: `${key} waits on a vendor API that has not answered` });
const instance = (faultClass: FaultClass, subject: string, offsetMs: number, linkedTo: string | null = null): FaultInstance =>
  ({ id: `${faultClass}|${subject}|${iso(offsetMs)}`, kind: faultCatalogue[faultClass][0], faultClass, subject, text: `${subject} fault`, at: iso(offsetMs), lastSeenAt: iso(offsetMs), linkedTo });

test('unit:fault-classes — every existing attention kind maps to exactly one class of the shipped catalogue', () => {
  // No kind is listed under two classes, and every class the catalogue names is a shipped class.
  const listed = faultClasses.flatMap(faultClass => faultCatalogue[faultClass].map(kind => ({ kind, faultClass })));
  for (const { kind } of listed) assert.equal(listed.filter(entry => entry.kind === kind).length, 1, `${kind} is listed under exactly one class`);
  assert.deepEqual(new Set(faultKinds), new Set(listed.map(entry => entry.kind)));
  for (const example of ['session-liveness', 'review-convergence', 'scope', 'overlap-hold', 'observation', 'deployment', 'configuration']) assert.ok((faultClasses as readonly string[]).includes(example), `${example} is a shipped class`);
  // Every attention kind a source raises is in the catalogue, under a real class.
  const sources: [string, readonly string[]][] = [
    ['work item attention causes', workAttentionCauses],
    ['installation attention sources', installationSources],
    ['escalation triggers', escalationTriggers.map(escalationFaultKind)],
    ['failed loop actions', daemonActionKinds.map(daemonActionFaultKind)],
    ['loop attention', ['loop-liveness', 'loop-cost', 'loop-failures', 'loop-silence', 'delivery-budget', 'loop-cursor', 'dispatch-failures']],
    ['master status builders', ['disk-pressure', 'resource-bound', 'ledger-refusal', 'scope-request', 'consent-hold', 'review-conflict', 'unobtainable-review', 'decision-refused', 'decision-stale', 'decision-unanswered',
      'approver-launch', 'stalled-action', 'stalled-item', 'unanswered-request', 'stuck-request', 'overlong-session', 'context-overflow', 'timing-failure', 'agent-request', 'owed-decision', 'generated-files',
      'github-budget', 'intervention-pattern', 'throughput', 'executor', 'setup', 'installation', 'sudo', 'unrunnable-remedy', 'role-capacity', 'concurrency-starved', 'fleet', 'fleet-capacity', 'actorless',
      'nonexercising-proof', 'retry-stopped']],
    ['work item record', ['containment', 'human-request', 'scope-request', 'proof-gap', 'role-capacity', 'scope-violation', 'blocker', 'sandbox-blocker', 'workflow-permission']],
  ];
  for (const [source, kinds] of sources) for (const kind of kinds) {
    assert.ok(isFaultKind(kind), `${source}: ${kind} is in the catalogue`);
    assert.notEqual(faultClassOf(kind), 'unclassified', `${source}: ${kind} has a class`);
  }
  assert.equal(faultClassOf('lease-loss'), 'unclassified', 'a kind nobody catalogued is unclassified, never silently put somewhere');
  assert.equal(faultClassOf('escalation:lease-loss'), 'session-liveness');
  assert.equal(faultClassOf('scope-request'), 'scope');
  assert.equal(faultClassOf('hold-overdue'), 'overlap-hold');
});

test('unit:fault-classes — attention items, escalations and pipeline faults carry their class', async () => {
  // Attention a builder raised with its kind, and attention recognised by its wording.
  const installation = controlPlaneAttention({ appPermissions: { attention: ['App lacks Contents: write'] }, heldJobs: 2, production: null });
  assert.deepEqual(installation.attentionItems.map(entry => [entry.kind, entry.faultClass]), [['app-permissions', 'configuration'], ['held-jobs', 'configuration']]);
  const state = emptyDaemonState(config());
  const liveness = loopLiveness(state, clock, 20_000, 'machine-a');
  for (const entry of loopAttention({ liveness })) assert.equal(entry.faultClass, 'loop', entry.text);
  const worded = classifyAttention([
    { subject: 'GY-4', text: 'graphyard-claude-1 needs files outside plannedFiles: src/cli/x.ts — the command moved' },
    { subject: 'GY-5', text: 'Review of GY-5 head 0123456789ab (PR #9) is conflicted: two verdicts' },
    { subject: 'github', text: 'GitHub requests are paused until 12:00' },
    { subject: 'GY-6', text: 'GY-6 has held its review gate for 3 hours with no action named and nothing moving it: x' },
    { subject: 'GY-6', text: 'GY-6 candidate 0123456789ab has been submitted for 9m with no review request, no producer request, no rework request and no named wait; missing a reviewer' },
    { subject: 'somewhere', text: 'A line nobody catalogued' },
  ]);
  assert.deepEqual(worded.map(entry => entry.faultClass), ['scope', 'review-convergence', 'observation', 'stalled-gate', 'stalled-gate', 'unclassified']);
  assert.equal(worded[4].kind, 'actorless');
  // GY-729: GY-185 reworded the stalled-action line and the signature still named the old wording, so
  // every stalled action since read as unclassified. These are the three recorded instances verbatim.
  const stalledLines = classifyAttention([
    { subject: 'GY-646', text: "GY-646's request-review action is stalled, retried only on a widening backoff: 3 attempts in a row failed for one unchanged reason — GY-646 GitHub observation is missing or older than two minutes — and it has been open 12m over 4 attempt(s); next attempt at 2026-09-26T16:04:33.888Z. Nothing changes by attempting it again while that condition stands" },
    { subject: 'GY-446', text: "GY-446's resync action is stalled, retried only on a widening backoff: 4 attempts in a row failed for one unchanged reason — The operation was aborted due to timeout — and it has been open 29m over 4 attempt(s). Nothing changes by attempting it again while that condition stands" },
    { subject: 'GY-551', text: "GY-551's resync action is stalled, retried only on a widening backoff: 4 attempts in a row failed for one unchanged reason — The operation was aborted due to timeout — and it has been open 29m over 4 attempt(s); next attempt at 2026-09-26T16:58:11.374Z. Nothing changes by attempting it again while that condition stands" },
    { subject: 'GY-131', text: "GY-131's request-review action is stalled, not retrying: 3 attempts in a row failed for one unchanged reason — reviewer busy" },
  ]);
  assert.deepEqual(stalledLines.map(entry => [entry.kind, entry.faultClass]), Array(4).fill(['stalled-action', 'stalled-gate']), 'a stalled action is classified in its current wording and its pre-GY-185 one');
  // Escalations on an item, one class per trigger.
  const escalated = item('GY-7', { escalations: escalationTriggers.map(trigger => ({ trigger, reason: `${trigger} raised`, actor: 'graphyard', at: iso(0) })) } as Partial<Work>);
  assert.deepEqual(workFaults(escalated, clock).map(entry => entry.faultClass), ['session-liveness', 'proof', 'review-convergence', 'scope']);
  // A failed loop action is a pipeline fault with its class, on the action and as a recorded instance.
  const dispatched = storeAction(state, 'dispatch:work-8:0', { kind: 'dispatch', work: 'GY-8', principal: 'worker', state: 'failed', detail: 'Herdr refused the launch', attempts: 1, epoch: 0, cycle: 0, at: iso(0) });
  assert.equal(dispatched.faultClass, 'session-liveness');
  assert.deepEqual(state.faults.instances.map(entry => [entry.subject, entry.kind, entry.faultClass]), [['GY-8', 'action:dispatch', 'session-liveness']]);
  // Failures written outside the cycle's own steps carry their class too: an action a restart
  // interrupted, a refused configuration reload and a refused watchdog window. A merge a restart
  // interrupted is the exception (GY-1087): asking GitHub again for the same head is a retry.
  const restarted = emptyDaemonState(config());
  storeAction(restarted, 'session:work-9:1', { kind: 'session', work: 'GY-9', principal: 'worker', state: 'started', detail: 'Launching', attempts: 1, epoch: 1, cycle: 0, at: iso(0) });
  storeAction(restarted, 'merge:work-9:1', { kind: 'merge', work: 'GY-9', principal: null, state: 'started', detail: 'Merging', attempts: 1, epoch: 1, cycle: 0, at: iso(0) });
  const resumed = reconcilePendingActions(restarted, [item('GY-9')], clock);
  assert.deepEqual(resumed.map(entry => [entry.kind, entry.state, entry.faultClass]), [['session', 'indeterminate', 'session-liveness'], ['merge', 'failed', undefined]]);
  const [refused] = await noteConfigReload(restarted, { at: iso(1000), changed: [], refused: 'workers[0].agentName is stale' } as any, async () => {});
  assert.equal(refused.faultClass, 'configuration', 'a refused reload is a configuration fault');
  const [watchdog] = await noteWatchdog(restarted, { windowMs: 1000, refusal: 'The watchdog window is shorter than the interval' } as any, iso(2000), async () => {});
  assert.equal(watchdog.faultClass, 'configuration');
  assert.deepEqual(restarted.faults.instances.map(entry => entry.faultClass), ['session-liveness', 'configuration', 'configuration'], 'each is a recorded instance');
  assert.ok(Object.values(restarted.actions).every(action => (action.kind !== 'merge' && (action.state === 'failed' || action.state === 'indeterminate')) === !!action.faultClass), 'every failed action but the retried merge, and only a failed one, carries a class');
  let persisted = 0;
  const failing = { snapshot: async () => ({ work: [], now: iso(0) }), persist: async () => { persisted++; } } as unknown as DaemonEffects;
  await runCycle(config(), state, { ...failing, agents: () => [], credentials: async () => ({}), observeDeployment: async () => { throw new Error('the deployment endpoint timed out'); } } as unknown as DaemonEffects, () => clock);
  const deployment = Object.values(state.actions).find(action => action.kind === 'deployment');
  assert.equal(deployment?.state, 'failed');
  assert.equal(deployment?.faultClass, 'deployment', 'the loop records the failed action with its class');
  assert.ok(persisted > 0, 'the cursor was written');
  // A run of failed cycles is one loop fault once it reaches the attention bound.
  const failures = emptyDaemonState(config());
  for (let attempt = 0; attempt < cycleFailureAttentionAfter + 1; attempt++) await noteCycleFailure(failures, new Error('snapshot timed out'), 'cycle', { now: clock + attempt * 1000, intervalMs: 20_000, persist: async () => {} });
  assert.deepEqual(failures.faults.instances.map(entry => [entry.kind, entry.faultClass]), [['loop-failures', 'loop']]);
});

test('unit:fault-classes — master status and the dashboard group open problems by class with a count', () => {
  const items = [
    { subject: 'GY-1', text: 'graphyard-claude-1 needs files outside plannedFiles: a.ts — x', role: 'master' as const, approvedBy: null, human: false, humanOnly: null, next: 'graphyard master scope GY-1' },
    { subject: 'GY-2', text: 'graphyard-claude-2 needs files outside plannedFiles: b.ts — y', role: 'master' as const, approvedBy: null, human: false, humanOnly: null, next: 'graphyard master scope GY-2' },
    { subject: 'GY-3', text: 'GY-3 is held by a registered resource at its bound: review ledger. Reclaim', role: 'master' as const, approvedBy: null, human: false, humanOnly: null, next: 'Reclaim', kind: 'resource-bound' as const },
    { subject: 'loop', text: 'The master loop has not cycled', role: 'master' as const, approvedBy: null, human: false, humanOnly: null, next: 'restart', kind: 'loop-liveness' as const },
  ];
  const report = faulted(items);
  assert.ok(report.attentionItems.every(entry => faultClasses.includes(entry.faultClass)), 'every listed item carries its class');
  assert.deepEqual(report.faults.map(group => [group.faultClass, group.count]), [['scope', 2], ['resources', 1], ['loop', 1]]);
  assert.deepEqual(report.faults[0].subjects, ['GY-1', 'GY-2']);
  assert.equal(report.faults.reduce((total, group) => total + group.count, 0), report.attentionItems.length, 'the counts add up to the list');

  // The dashboard's Work page: the same grouping over each open item's own record.
  const work = boardWork() as unknown as Work[];
  const open = work.filter(entry => entry.stage !== 'done');
  // Requests open past the loop's bound (GY-1085): one still being decided within it is no fault.
  open[0].scopeRequest = { epoch: 1, paths: ['docs/x.md'], reason: 'docs', requestedBy: 'graphyard-claude-1', at: new Date(NOW - hour).toISOString() } as Work['scopeRequest'];
  open[1].scopeRequest = { epoch: 1, paths: ['docs/y.md'], reason: 'docs', requestedBy: 'graphyard-claude-2', at: new Date(NOW - hour).toISOString() } as Work['scopeRequest'];
  open[0].lease = { owner: 'graphyard-claude-1', epoch: 1, expiresAt: new Date(NOW + hour).toISOString() };
  open[1].lease = { owner: 'graphyard-claude-2', epoch: 1, expiresAt: new Date(NOW + hour).toISOString() };
  const expected = groupFaults(open.flatMap(entry => workFaults(entry, NOW)));
  const noop = () => {};
  const render = (work: Work[], status: object = boardStatus('admin')) => renderToStaticMarkup(createElement(OverviewPage, {
    token: 'fixture', work, status, error: '', connected: true, lastUpdated: '12:00:00', view: 'work', setView: noop, filter: null, setFilter: noop,
    selected: null, setSelected: noop, creating: false, setCreating: noop, busy: false, setBusy: noop, observedAt: NOW, jobs: [], query: '', setQuery: noop,
    operatorAgents: [], operatorAgentsError: null, features: { validation: null, releases: null, automation: null }, events: [], editingRequirements: false, setEditingRequirements: noop,
    codexAvailable: false, queue: predictQueue(work, NOW), sessionEpoch: { current: 0 }, api: async (path: string) => boardApi(path, 'admin'), refresh: async () => {},
    action: async () => {}, setError: noop, signOut: noop,
  } as unknown as Dashboard));
  const page = render(work);
  assert.match(page, /aria-label="Problems by class"/);
  const scope = expected.find(group => group.faultClass === 'scope')!;
  assert.ok(scope.count >= 2, 'both scope requests are counted');
  for (const group of expected) assert.match(page, new RegExp(`data-fault-class="${group.faultClass}"[^>]*>(?:(?!</li>)[\\s\\S])*<strong>${group.count}</strong>`), `${group.faultClass} shows its count`);
  // One open problem is its own row already: there is nothing to group.
  const fixture = boardWork() as unknown as Work[];
  const one = fixture.find(entry => workFaults(entry, NOW).length === 1)!;
  const single = fixture.filter(entry => entry === one || !workFaults(entry, NOW).length);
  assert.equal(single.flatMap(entry => workFaults(entry, NOW)).length, 1, 'the fixture keeps exactly one open problem');
  assert.doesNotMatch(render(single), /Problems by class/);
  // Problems the control plane's status reports beside no item are grouped too: with no item-level
  // problem at all, two App permission lines and an unserved executor still draw the grouping.
  const quiet = fixture.filter(entry => !workFaults(entry, NOW).length);
  const troubled = { ...boardStatus('admin'), appPermissions: { attention: ['The App lacks Checks: write', 'The App lacks Contents: write'] }, executors: { live: 1, attention: [{ kind: 'merge', text: 'No executor serves merge' }] } };
  assert.deepEqual(groupFaults(statusFaults(troubled)).map(group => [group.faultClass, group.count]), [['configuration', 3]]);
  // Production lag and deployment incidents master status raises are grouped under deployment, as master status groups them.
  const lagging = { ...troubled, production: { attention: ['main is 3 commits ahead of production (serving abc123): build failed', '1 delivered item has an open deployment incident: GY-7 (failed)'] } };
  assert.deepEqual(groupFaults(statusFaults(lagging)).map(group => [group.faultClass, group.count]).sort(), [['configuration', 3], ['deployment', 2]]);
  assert.deepEqual(statusFaults(lagging).filter(fault => fault.kind === 'production').map(fault => fault.text), lagging.production.attention);
  assert.match(render(quiet, troubled), /data-fault-class="configuration"[^>]*>(?:(?!<\/li>)[\s\S])*<strong>3<\/strong>/, 'the status-level problems are counted under their class');
  assert.match(render([], troubled), /data-fault-class="configuration"[^>]*>(?:(?!<\/li>)[\s\S])*<strong>3<\/strong>/, 'with no work at all the status-level problems are still grouped');
});

test('unit:recurring-class-item — below the threshold nothing is filed', async () => {
  const filed: unknown[] = [];
  const effects = { fileFaultClass: async (input: unknown) => { filed.push(input); return item('GY-99'); }, faultClassPolicy: policy, persist: async () => {} } as unknown as DaemonEffects;
  const state = emptyDaemonState(config());
  const work = [blocked('GY-1'), blocked('GY-2')];
  trackFaults(state.faults, cycleFaults(state, work, clock), iso(0));
  await fileRecurringFaultClasses(state, effects, work, clock, () => clock, []);
  assert.equal(filed.length, 0, 'two instances in the window are below a threshold of three');
  // The same two faults standing for many cycles are still two instances, not a recurrence.
  for (let cycle = 1; cycle <= 5; cycle++) trackFaults(state.faults, cycleFaults(state, work, clock + cycle * 60_000), iso(cycle * 60_000));
  assert.equal(state.faults.instances.length, 2);
  await fileRecurringFaultClasses(state, effects, work, clock + 5 * 60_000, () => clock, []);
  assert.equal(filed.length, 0);
  // Instances outside the window do not count towards it either.
  assert.deepEqual(recurringClasses([instance('scope', 'GY-1', -30 * hour), instance('scope', 'GY-2', -26 * hour), instance('scope', 'GY-3', -1 * hour)], [], policy, clock).map(entry => entry.file), [false]);
});

test('unit:recurring-class-item — a class past the threshold files one item as the operator-agent, and later instances link to it', async () => {
  const filed: { input: any; key: string }[] = [];
  let backlog: Work[] = [blocked('GY-1'), blocked('GY-2'), blocked('GY-3')];
  const effects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: backlog.map(entry => ({ ...entry })), now: new Date(now).toISOString() }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    faultClassPolicy: policy, persist: async () => {},
    fileFaultClass: async (input: any, key: string) => { filed.push({ input, key }); const created = item(`GY-${100 + filed.length}`, { title: input.title, origin: input.origin } as Partial<Work>); return created; },
  } as unknown as DaemonEffects;
  let now = clock;
  const state = emptyDaemonState(config());
  const cycle = await runCycle(config(), state, effects, () => now);
  assert.equal(filed.length, 1, 'three stalled-gate faults in the window file one item');
  const { input } = filed[0];
  assert.equal(input.origin.faultClass.class, 'stalled-gate', 'the item records the class it closes');
  assert.doesNotThrow(() => workOriginSchema.parse(input.origin), 'the origin is one the control plane accepts on create');
  assert.deepEqual(input.origin.faultClass.instances.map((entry: { subject: string }) => entry.subject).sort(), ['GY-1', 'GY-2', 'GY-3'], 'it lists the instances');
  for (const key of ['GY-1', 'GY-2', 'GY-3']) assert.match(input.description, new RegExp(`blocker on ${key}: ${key} waits on a vendor API`));
  assert.match(input.title, /^Recurring stalled-gate faults: 3 in 24 hours/);
  assert.equal(input.policy, undefined, 'the default policy: independent review, which operator-created work must require');
  assert.match(filed[0].key, /^fault-class:stalled-gate:[0-9a-f]{32}$/, 'a stable idempotency key: a retried filing returns the same item');
  assert.ok(cycle.actions.some(action => action.kind === 'fault' && action.state === 'done' && action.work === 'GY-101'), `the cycle reports the filing: ${JSON.stringify(cycle.actions)}`);
  assert.deepEqual(state.faults.instances.filter(entry => entry.faultClass === 'stalled-gate').map(entry => entry.linkedTo), ['GY-101', 'GY-101', 'GY-101'], 'the filed instances are linked to the item');

  // The filed item is open: a further instance of the class links to it, and nothing is filed again.
  const standing = item('GY-101', { origin: input.origin, title: input.title } as Partial<Work>);
  backlog = [...backlog, blocked('GY-4'), standing];
  now = clock + 10 * 60_000;
  await runCycle(config(), state, effects, () => now);
  assert.equal(filed.length, 1, 'one item per recurring class');
  const later = state.faults.instances.find(entry => entry.subject === 'GY-4')!;
  assert.equal(later.linkedTo, 'GY-101', 'the later instance is linked to the open item');
  // Even well past the threshold, while the item is open.
  backlog = [...backlog, blocked('GY-5'), blocked('GY-6'), blocked('GY-7')];
  now = clock + 20 * 60_000;
  await runCycle(config(), state, effects, () => now);
  assert.equal(filed.length, 1);
  assert.ok(state.faults.instances.filter(entry => entry.faultClass === 'stalled-gate').every(entry => entry.linkedTo === 'GY-101'), 'every later instance links to the open item');
  const summary = daemonSummary(state, now, 20_000, 'machine-a');
  assert.deepEqual(summary.faults.classes.find(entry => entry.faultClass === 'stalled-gate')?.items, ['GY-101'], 'master status names the item standing for the class');

  // Another class is judged on its own: two scope faults file nothing, a third files its own item.
  const scope = (key: string) => item(key, { scopeRequest: { epoch: 1, paths: ['docs/x.md'], reason: 'docs', requestedBy: 'w', at: iso(0) }, lease: { owner: 'w', epoch: 1, expiresAt: iso(2 * hour) } } as Partial<Work>);
  backlog = [...backlog, scope('GY-8'), scope('GY-9')];
  now = clock + 30 * 60_000;
  await runCycle(config(), state, effects, () => now);
  const classesFiled = () => filed.map(entry => entry.input.origin.faultClass.class as string);
  assert.ok(!classesFiled().includes('scope'), `two scope faults file nothing: ${classesFiled()}`);
  backlog = [...backlog, scope('GY-10')];
  now = clock + 40 * 60_000;
  await runCycle(config(), state, effects, () => now);
  assert.equal(classesFiled().filter(name => name === 'scope').length, 1, `the third scope fault files the scope item: ${classesFiled()}`);
  assert.equal(new Set(classesFiled()).size, filed.length, `one item per recurring class: ${classesFiled()}`);
  assert.equal(classesFiled().filter(name => name === 'stalled-gate').length, 1);

  // Once the class's item is delivered, instances it linked stay its own: they never file a second one.
  const done = { ...standing, stage: 'done' } as Work;
  assert.deepEqual(recurringClasses(state.faults.instances, [done], policy, now).filter(entry => entry.faultClass === 'stalled-gate'), []);
});

test('unit:recurring-class-item — the loop files through the master operator-agent identity', async () => {
  const root = await temporaryDirectory('fault-root'), secrets = await temporaryDirectory('fault-secrets');
  try {
    execFileSync('git', ['init', '-q', root]);
    const token = join(secrets, 'operator.token');
    await writeFile(token, 'operator-token-'.padEnd(48, 'x'), { mode: 0o600 });
    const posted: { url: string; auth: string | null; key: string | null; body: any }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      posted.push({ url, auth: headers.get('Authorization'), key: headers.get('Idempotency-Key'), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(item('GY-200', { origin: JSON.parse(String(init.body)).origin } as Partial<Work>)), { status: 201 });
    }) as typeof fetch;
    const deps = { snapshot: async () => ({ work: [], now: iso(0) }), mutate: async () => { throw new Error('not used'); }, executor: { principal: 'coordinator', instance: 'fault' }, fetcher };
    assert.equal(daemonEffects(root, config(), deps).fileFaultClass, undefined, 'without an operator-agent identity the loop files nothing');
    const effects = daemonEffects(root, { ...config(), operatorAgent: { id: 'graphyard-master-operator', credentialFile: token } } as MasterConfig, deps);
    const recent = [instance('scope', 'GY-1', -3 * hour), instance('scope', 'GY-2', -2 * hour), instance('scope', 'GY-3', -hour)];
    const created = await effects.fileFaultClass!(faultClassItem({ faultClass: 'scope', recent }, policy, clock), 'fault-class:scope:abc');
    assert.equal(created.key, 'GY-200');
    assert.equal(posted.length, 1);
    assert.equal(posted[0].url, 'https://graphyard.example/api/work');
    assert.equal(posted[0].auth, `Bearer ${'operator-token-'.padEnd(48, 'x')}`, 'the operator-agent credential, never the coordinator\'s');
    assert.equal(posted[0].key, 'fault-class:scope:abc');
    assert.equal(posted[0].body.origin.faultClass.class, 'scope');
    assert.ok(posted[0].body.reason.length > 0, 'operator-agent mutations carry a reason');
  } finally {
    await rm(root, { recursive: true, force: true }); await rm(secrets, { recursive: true, force: true });
  }
});

test('unit:recurring-class-item — retained action history is not a standing fault: each run of failures is one instance', async () => {
  // Upgrading onto a cursor that already holds old failures records nothing from them and files nothing.
  const state = emptyDaemonState(config());
  for (const [index, key] of ['escalation:config:a', 'escalation:config:b', 'escalation:config:c', 'escalation:watchdog:1000'].entries())
    state.actions[key] = { kind: 'escalation', work: null, principal: null, state: 'failed', detail: `old refusal ${index}`, attempts: 1, epoch: null, cycle: 0, at: iso(-hour) };
  const filed: unknown[] = [];
  const effects = { fileFaultClass: async (input: unknown) => { filed.push(input); return item('GY-99'); }, faultClassPolicy: policy, persist: async () => {} } as unknown as DaemonEffects;
  for (let cycle = 0; cycle < 3; cycle++) { trackFaults(state.faults, cycleFaults(state, [], clock + cycle * 60_000), iso(cycle * 60_000)); await fileRecurringFaultClasses(state, effects, [], clock + cycle * 60_000, () => clock, []); }
  assert.equal(state.faults.instances.length, 0, 'the history is not re-observed');
  assert.equal(filed.length, 0);
  // One action failing on every retry is one instance; a success ends it, and a later failure is a new one.
  const attempt = (outcome: 'started' | 'failed' | 'done', offset: number) => storeAction(state, 'deployment:work-1:x', { kind: 'deployment', work: 'GY-1', principal: null, state: outcome, detail: outcome, attempts: 1, epoch: null, cycle: 0, at: iso(offset) });
  for (let retry = 0; retry < 4; retry++) { attempt('started', retry * 1000); attempt('failed', retry * 1000 + 500); }
  assert.equal(state.faults.instances.length, 1, 'four failed retries of one action are one instance');
  assert.equal(state.faults.instances[0].lastSeenAt, iso(3500));
  attempt('started', 5000); attempt('done', 5500);
  assert.equal(attempt('done', 5500).faultClass, undefined, 'a successful action carries no class');
  attempt('started', 6000); attempt('failed', 6500);
  assert.equal(state.faults.instances.length, 2, 'failing again after a success is a new instance');
  await fileRecurringFaultClasses(state, effects, [], clock + 7000, () => clock, []);
  assert.equal(filed.length, 0, 'two deployment instances stay below the threshold');
});

test('unit:recurring-class-item — a fault that clears and returns is a new instance', () => {
  const record = { instances: [] as FaultInstance[], open: {} as Record<string, string>, failing: {} as Record<string, string> };
  const observation = { kind: 'scope-request' as const, faultClass: 'scope' as const, subject: 'GY-1', text: 'needs files' };
  assert.equal(trackFaults(record, [observation], iso(0)).length, 1);
  assert.equal(trackFaults(record, [observation], iso(60_000)).length, 0, 'still standing: the same instance');
  assert.equal(record.instances[0].lastSeenAt, iso(60_000));
  trackFaults(record, [], iso(120_000));
  assert.equal(trackFaults(record, [observation], iso(180_000)).length, 1, 'cleared and back: a second instance');
  noteFault(record, { kind: 'loop-failures', faultClass: 'loop', subject: 'loop', text: 'failed' }, iso(200_000));
  assert.deepEqual(record.instances.map(entry => entry.faultClass), ['scope', 'scope', 'loop']);
  // Past the retention bound the oldest instances go, never the one a standing fault still is.
  const churn = (index: number) => ({ kind: 'blocker' as const, faultClass: 'stalled-gate' as const, subject: `GY-${index + 100}`, text: 'blocked' });
  for (let index = 0; index < 1200; index++) trackFaults(record, [observation, churn(index)], iso(240_000 + index));
  assert.ok(record.instances.length <= 1001, `history stays bounded: ${record.instances.length}`);
  assert.equal(trackFaults(record, [observation], iso(2_000_000)).length, 0, 'the fault that never cleared is still one instance');
  assert.equal(record.instances.filter(entry => entry.kind === 'scope-request' && entry.at === iso(180_000)).length, 1);
});

test('unit:recurring-class-item — derived and status-level faults reach recurrence tracking and file their class', async () => {
  const filed: any[] = [];
  let backlog: Work[] = [];
  let status: Record<string, unknown> = { github: true };
  const effects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: backlog.map(entry => ({ ...entry })), now: new Date(now).toISOString() }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    faultClassPolicy: policy, persist: async () => {}, controlPlane: async () => status,
    fileFaultClass: async (input: any) => { filed.push(input); return item(`GY-${100 + filed.length}`, { title: input.title, origin: input.origin } as Partial<Work>); },
  } as unknown as DaemonEffects;
  let now = clock;
  const state = emptyDaemonState(config());
  const classesFiled = () => filed.map(input => input.origin.faultClass.class as string);
  // Derived attention: a leased item whose worker session Herdr does not show is a session-liveness fault,
  // which no item's own record carries. One standing session stays one instance however many cycles see it.
  const leased = (key: string) => item(key, { stage: 'build', lease: { owner: 'graphyard-worker-1', epoch: 1, expiresAt: iso(10 * hour) } } as Partial<Work>);
  backlog = [leased('GY-1')];
  for (let minute = 0; minute < 3; minute++) { now = clock + minute * 60_000; await runCycle(config(), state, effects, () => now); }
  assert.equal(state.faults.instances.filter(entry => entry.faultClass === 'session-liveness').length, 1, `one standing session fault is one instance: ${JSON.stringify(state.faults.instances)}`);
  assert.deepEqual(classesFiled(), [], 'below the threshold nothing is filed');
  backlog = [leased('GY-1'), leased('GY-2'), leased('GY-3')];
  now = clock + 5 * 60_000;
  await runCycle(config(), state, effects, () => now);
  assert.deepEqual(classesFiled(), ['session-liveness'], 'the third session-liveness fault files its class');
  assert.deepEqual(filed[0].origin.faultClass.instances.map((entry: { kind: string }) => entry.kind), ['session', 'session', 'session']);
  // Its criterion is one the candidate can prove before merge; the post-ship quiet is the loop's own count, never merge evidence.
  assert.match(filed[0].criteria[0].text, /removed at the candidate: each instance listed on this item is reproduced against the base and shown not to recur against the candidate/);
  assert.doesNotMatch(filed[0].criteria[0].text, /ships|after/);

  // Status-level: an App permission shortfall the control plane reports, cleared and raised again three times.
  for (let round = 0; round < 3; round++) {
    status = { github: true, appPermissions: { attention: [`The GitHub App lacks checks: write (round ${round})`] } };
    now = clock + (10 + round * 2) * 60_000; await runCycle(config(), state, effects, () => now);
    status = { github: true };
    now += 60_000; await runCycle(config(), state, effects, () => now);
  }
  assert.equal(state.faults.instances.filter(entry => entry.faultClass === 'configuration').length, 3, 'a shortfall that clears and returns is a new instance each time');
  assert.deepEqual(classesFiled(), ['session-liveness', 'configuration'], 'the recurring status-level class files its own item');
  // A failed integration job on the coordination read is an observation fault, with or without the status read.
  assert.deepEqual(cycleFaults(state, [], clock, { jobs: [{ work_id: 'GY-1', error: 'GitHub answered 502' }, { work_id: 'GY-2', error: null }, { work_id: 'GY-3' }] }).map(fault => [fault.kind, fault.faultClass, fault.subject]), [['integration-job', 'observation', 'GY-1']], 'a healthy scheduled job is no fault');
  // An item's own fault and the same fault derived again for it are one observation, not two.
  const both = cycleFaults(state, [blocked('GY-9')], clock, { config: config() });
  assert.equal(both.filter(fault => fault.subject === 'GY-9').length, 1, `one blocker is one fault: ${JSON.stringify(both)}`);
});

test('unit:recurring-class-item — a typed wait is one fault, not also a generic blocker', () => {
  const parked = item('GY-11', { blocker: describeHumanRequest({ kind: 'money-or-accounts', needed: 'a paid Railway plan' }),
    humanRequest: { id: 'h1', kind: 'money-or-accounts', reason: 'the deploy needs a paid plan', needed: 'a paid Railway plan', requestedBy: 'graphyard-worker-1', epoch: 1, at: iso(-hour) } } as Partial<Work>);
  assert.deepEqual(workFaults(parked, clock).map(fault => fault.kind), ['human-request'], 'the park is one human-decision fault');
  const refused = item('GY-12', { blocker: `${scopeRefusalBlocker}: docs/ is outside the implied scope`,
    scopeRequest: { paths: ['docs/'], reason: 'docs', requestedBy: 'graphyard-worker-1', epoch: 1, at: iso(-hour) }, lease: { owner: 'graphyard-worker-1', epoch: 1, expiresAt: iso(hour) } } as Partial<Work>);
  assert.deepEqual(workFaults(refused, clock).map(fault => fault.kind), ['scope-request'], 'the refused scope request is one scope fault');
  // A blocker that is not a typed wait's restatement still counts.
  assert.deepEqual(workFaults(item('GY-13', { blocker: 'npm test fails on a missing fixture', scopeRequest: parked.scopeRequest } as Partial<Work>), clock).map(fault => fault.kind), ['blocker']);
  // Three parked items count toward human-decision only, so they can file at most one item.
  const record = { instances: [] as FaultInstance[], open: {} as Record<string, string>, failing: {} as Record<string, string> };
  trackFaults(record, cycleFaults(emptyDaemonState(config()), ['GY-21', 'GY-22', 'GY-23'].map(key => ({ ...parked, id: `work-${key}`, key })), clock), iso(0));
  assert.deepEqual([...new Set(record.instances.map(entry => entry.faultClass))], ['human-decision']);
  assert.deepEqual(recurringClasses(record.instances, [], policy, clock).filter(entry => entry.file).map(entry => entry.faultClass), ['human-decision']);
});

test('unit:recurring-class-item — containment grace window is no fault; lapsed quarantine is a containment fault', () => {
  const fenced = item('GY-14', {
    containmentQuarantine: {
      at: iso(-60_000), epoch: 1, owner: 'worker-1',
      leaseExpiresAt: iso(30_000), launchExpiresAt: iso(-60_000), settlementHash: 'a'.repeat(64),
      scope: { pid: 1234, unit: 'u.scope' },
    },
    lease: null,
  } as Partial<Work>);
  assert.deepEqual(workFaults(fenced, clock).map(fault => fault.kind), [], 'grace window is no fault');
  assert.deepEqual(cycleFaults(emptyDaemonState(config()), [fenced], clock, { config: config() }).filter(fault => fault.faultClass === 'containment'), [], 'cycleFaults produces no containment fault during grace');

  // After grace window has elapsed (120s past leaseExpiresAt)
  const lapsedClock = clock + 180_000;
  assert.deepEqual(workFaults(fenced, lapsedClock).map(fault => fault.kind), ['containment'], 'lapsed quarantine is a containment fault');
  assert.equal(cycleFaults(emptyDaemonState(config()), [fenced], lapsedClock, { config: config() }).filter(fault => fault.faultClass === 'containment').length, 1);
});

test('unit:recurring-class-item — a recurring human-decision class keeps the decision with the human', () => {
  const recent = [instance('human-decision', 'GY-1', -3 * hour), instance('human-decision', 'GY-2', -2 * hour), instance('human-decision', 'GY-3', -hour)];
  const filed = faultClassItem({ faultClass: 'human-decision', recent }, policy, clock);
  assert.match(filed.criteria[0].text, /judged necessary .* or avoidable/);
  assert.match(filed.criteria[0].text, /every necessary decision is still refused to every agent and answered only in the human's own session/);
  assert.doesNotMatch(filed.criteria[0].text, /shared cause .* removed/);
  assert.match(filed.description, /does not move any of them to an agent or weaken that boundary/);
  assert.doesNotMatch(filed.description, /so the product handles the case itself/);
  assert.equal(filed.origin.faultClass.class, 'human-decision', 'the item still records the class it closes');
  // Every other class keeps the remove-the-cause requirement.
  assert.match(faultClassItem({ faultClass: 'scope', recent }, policy, clock).criteria[0].text, /shared cause of the recurring scope faults is found and removed/);
});

test('unit:recurring-class-item — attention master status adds after buildMasterStatus reaches recurrence tracking', async () => {
  const filed: any[] = [];
  let reported: { subject: string; text: string }[] = [];
  const seen: unknown[] = [];
  const effects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [], now: new Date(now).toISOString() }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    faultClassPolicy: policy, persist: async () => {}, controlPlane: async () => ({ github: true }),
    reportedAttention: async (_work: Work[], coordinator: unknown, observed: unknown) => { seen.push({ coordinator, observed }); return { items: reported }; },
    fileFaultClass: async (input: any) => { filed.push(input); return item(`GY-${100 + filed.length}`, { title: input.title, origin: input.origin } as Partial<Work>); },
  } as unknown as DaemonEffects;
  let now = clock;
  const state = emptyDaemonState(config());
  // An escalation context over budget is appended by master status after buildMasterStatus (GY-138).
  const overflow = (key: string) => ({ subject: key, text: `The escalation context for ${key} assembled to 40,000 bytes, over its 32,000-byte budget` });
  for (const [round, key] of ['GY-1', 'GY-2', 'GY-3'].entries()) {
    reported = [overflow(key)];
    now = clock + round * 60_000; await runCycle(config(), state, effects, () => now);
  }
  assert.ok(seen.length >= 3, 'the loop reads the report-only attention every cycle, with the control plane status');
  assert.deepEqual(state.faults.instances.filter(entry => entry.faultClass === 'decision').map(entry => [entry.kind, entry.faultClass, entry.subject]),
    [['context-overflow', 'decision', 'GY-1'], ['context-overflow', 'decision', 'GY-2'], ['context-overflow', 'decision', 'GY-3']]);
  assert.deepEqual(filed.map(input => input.origin.faultClass.class), ['decision'], 'the recurring report-only class files its item');
  // A failing read is itself a loop fault, and the cycle goes on.
  (effects as any).reportedAttention = async () => { throw new Error('status read refused'); };
  now = clock + 10 * 60_000; await runCycle(config(), state, effects, () => now);
  assert.ok(state.faults.instances.some(entry => entry.kind === 'loop-failures' && /status read refused/.test(entry.text)));
  // The loop's wiring reads it with the coordinator's credential whether or not the operator-agent identity is
  // provisioned: only filing needs that identity, so an installation without it still counts every recurrence.
  const deps = { snapshot: async () => ({ work: [], now: iso(0) }), mutate: async () => { throw new Error('not used'); }, executor: { principal: 'coordinator', instance: 'fault' } };
  const unprovisioned = daemonEffects('/nonexistent', config(), deps);
  assert.equal(typeof unprovisioned.reportedAttention, 'function', 'report-only faults are read without an operator-agent identity');
  assert.equal(unprovisioned.fileFaultClass, undefined, 'filing still needs the operator-agent identity');
  assert.equal(typeof daemonEffects('/nonexistent', { ...config(), operatorAgent: { id: 'graphyard-master-operator', credentialFile: '/outside/operator.token' } } as MasterConfig, deps).reportedAttention, 'function');
  // Without the identity the report-only faults keep standing as the same instances, and a later recurrence still counts.
  reported = ['GY-1', 'GY-2', 'GY-3'].map(overflow);
  const tracked = emptyDaemonState(config()), bare = { ...effects, reportedAttention: async () => ({ items: reported }), fileFaultClass: undefined } as unknown as DaemonEffects;
  for (let round = 0; round < 2; round++) { now = clock + (20 + round) * 60_000; await runCycle(config(), tracked, bare, () => now); }
  assert.equal(tracked.faults.instances.filter(entry => entry.faultClass === 'decision').length, 3, 'the standing report-only faults are tracked, once each');
  assert.equal(Object.keys(tracked.faults.open).length >= 3, true, 'they still stand, so provisioning the identity later opens no spurious recurrence');
});

test('unit:recurring-class-item — a required check red on the clock reaches recurrence tracking as the timing-failure class, whatever its name', async () => {
  // A policy check name may hold spaces; master status names the failure with it verbatim.
  const check = 'Integration / test';
  const red = (key: string, id: number) => item(key, { stage: 'test', policy: { checks: [check], review: true }, candidate: { sha: `${id}`.padStart(40, 'a'), pr: id },
    observation: { at: iso(0), candidate: { sha: `${id}`.padStart(40, 'a'), pr: id }, checks: [{ name: check, result: 'failure', id, attempt: 1 }], reviews: [] },
    gates: [{ name: 'test', passed: false, reasons: [`Required CI check ${check} has not passed on the current candidate`] }] } as unknown as Partial<Work>);
  const work = [red('GY-1', 7001), red('GY-2', 7002), red('GY-3', 7003)];
  const timing = { name: 'snapshot.p95', test: 'integration:snapshot', statistic: 'p95', measuredMs: 2092, budgetMs: 2000, comparison: '<', samples: 100, warmupDiscarded: 5, otherFailures: 0 };
  const reads: number[] = [];
  const annotations = onceAnnotations(async id => { reads.push(id); return [{ message: `graphyard-timing:${JSON.stringify(timing)}` }]; });
  const items = await timingFaultAttention(work, 'owner/project', annotations);
  assert.deepEqual(classifyAttention(items).map(entry => [entry.subject, entry.kind, entry.faultClass]),
    [['GY-1', 'timing-failure', 'proof'], ['GY-2', 'timing-failure', 'proof'], ['GY-3', 'timing-failure', 'proof']], `a check name with spaces is still a timing failure: ${JSON.stringify(items)}`);
  const state = emptyDaemonState(config());
  trackFaults(state.faults, cycleFaults(state, work, clock, { config: config(), reported: items }), iso(0));
  assert.deepEqual(state.faults.instances.filter(entry => entry.kind === 'timing-failure').map(entry => entry.subject), ['GY-1', 'GY-2', 'GY-3']);
  assert.deepEqual(recurringClasses(state.faults.instances, work, policy, clock).filter(entry => entry.file).map(entry => entry.faultClass), ['proof'], 'three timing failures in the window file the proof item');
  // A completed run's annotations are read once however many cycles look; a failed read is read again.
  await timingFaultAttention(work, 'owner/project', annotations);
  assert.deepEqual(reads, [7001, 7002, 7003]);
  let failures = 0;
  const flaky = onceAnnotations(async () => { if (failures++ === 0) throw new Error('GitHub answered 502'); return []; });
  await assert.rejects(flaky(1)); assert.deepEqual(await flaky(1), []); assert.equal(failures, 2);
});

test('unit:recurring-class-item — review conflicts and the other lines status derives after buildMasterStatus reach the loop', async () => {
  const conflicted = (key: string, sha: string): Work => item(key, { stage: 'review', reviewConflict: { state: 'conflicted', key, pr: 7, sha, baseSha: 'b'.repeat(40), policyRevision: 1, reviewer: 'graphyard-reviewer[bot]', requestId: null, at: iso(-hour), reason: 'two verdicts',
    verdicts: [{ id: 1, reviewer: 'graphyard-reviewer[bot]', state: 'APPROVED', submittedAt: iso(-hour), observedAt: iso(-hour), requestId: null }, { id: 2, reviewer: 'graphyard-reviewer[bot]', state: 'CHANGES_REQUESTED', submittedAt: iso(-hour), observedAt: iso(-hour), requestId: null }] } } as Partial<Work>);
  const work = [conflicted('GY-1', 'a'.repeat(40)), conflicted('GY-2', 'c'.repeat(40)), conflicted('GY-3', 'd'.repeat(40))];
  const snapshot = { work, now: iso(0) };
  // The same builder master status uses: the loop reads it with the ledgers, and without the report's rows.
  const derived = await derivedAttention('/nonexistent', config(), async () => ({}), { github: true }, snapshot, { reviews: [], producers: [], runtime: { available: true, agents: [] }, trees: [] });
  assert.deepEqual(derived.conflicted.map(entry => entry.subject), ['GY-1', 'GY-2', 'GY-3']);
  assert.deepEqual(classifyAttention(derived.items).filter(entry => entry.kind === 'review-conflict').map(entry => [entry.subject, entry.faultClass]),
    [['GY-1', 'review-convergence'], ['GY-2', 'review-convergence'], ['GY-3', 'review-convergence']]);
  const state = emptyDaemonState(config());
  trackFaults(state.faults, cycleFaults(state, work, clock, { config: config(), reported: derived.items }), iso(0));
  assert.deepEqual(state.faults.instances.filter(entry => entry.kind === 'review-conflict').map(entry => entry.subject), ['GY-1', 'GY-2', 'GY-3']);
  assert.deepEqual(recurringClasses(state.faults.instances, work, policy, clock).filter(entry => entry.file).map(entry => entry.faultClass), ['review-convergence'],
    'three review conflicts in the window file the review-convergence item');
});

test('unit:recurring-class-item — the fault record stays bounded when failing runs never succeed', () => {
  const record = { instances: [] as FaultInstance[], open: {} as Record<string, string>, failing: {} as Record<string, string> };
  // One-shot failures (timestamped keys) that never record a success: every one is a failing run.
  for (let index = 0; index < retainedFaultInstances + 50; index += 1)
    noteActionOutcome(record, `config:${index}`, 'failed', { kind: 'action:config', faultClass: 'configuration', subject: 'installation', text: `refused ${index}` }, iso(index));
  assert.equal(record.instances.length, retainedFaultInstances, 'the bound holds even when every instance is a standing run');
  const kept = new Set(record.instances.map(entry => entry.id));
  assert.ok(Object.values(record.failing).every(id => kept.has(id)), 'no failing reference outlives its instance');
  assert.equal(Object.keys(record.failing).length, retainedFaultInstances);
});

test('unit:recurring-class-item — a failing run ends when its action is retired, succeeds or stays silent for the window', () => {
  const state = emptyDaemonState(config());
  const fail = (key: string, at: number, row: 'failed' | 'done' | 'started' | null) => {
    noteActionOutcome(state.faults, key, 'failed', { kind: 'action:refresh', faultClass: 'observation', subject: key, text: 'failed' }, iso(at));
    if (row) state.actions[key] = { kind: 'refresh', work: null, principal: null, state: row, detail: 'x', attempts: 1, cycle: 1, epoch: null, at: iso(at) } as any;
  };
  fail('refresh:retired', -hour, null); fail('refresh:done', -hour, 'done'); fail('refresh:silent', -25 * hour, 'failed');
  fail('refresh:running', -hour, 'failed'); fail('refresh:retrying', -2 * hour, 'started');
  endFailingRuns(state, policy, clock);
  assert.deepEqual(Object.keys(state.faults.failing).sort(), ['refresh:retrying', 'refresh:running']);
  // The cursor bound never retires a row whose run still stands (GY-1086): that row is the fault's
  // only record, and retiring it reopened a standing refusal as a new instance every hour. Once the
  // window has ended the run, pruning retires the row, and a run whose row is gone ends with it.
  for (let index = 0; index <= retainedActions; index += 1) state.actions[`old:${index}`] = { kind: 'refresh', work: null, principal: null, state: 'done', detail: 'x', attempts: 1, cycle: 1, epoch: null, at: iso(-48 * hour + index) } as any;
  state.actions['refresh:running'].at = iso(-72 * hour);
  pruneDaemonState(state);
  assert.equal(state.actions['refresh:running']?.state, 'failed', 'the oldest row stays while its run stands');
  assert.deepEqual(Object.keys(state.faults.failing).sort(), ['refresh:retrying', 'refresh:running']);
  endFailingRuns(state, policy, clock);
  pruneDaemonState(state);
  assert.equal(state.actions['refresh:running'], undefined);
  assert.deepEqual(Object.keys(state.faults.failing), ['refresh:retrying']);
  delete state.actions['refresh:retrying'];
  pruneDaemonState(state);
  assert.deepEqual(Object.keys(state.faults.failing), [], 'a run whose row is retired has ended');
});

test('unit:recurring-class-item — the loop reads status-level faults with coordinator visibility, so held jobs and production recur', async () => {
  const secrets = await temporaryDirectory('fault-secrets');
  try {
    const coordinatorToken = join(secrets, 'coordinator.token'), operatorToken = join(secrets, 'operator.token');
    await writeFile(coordinatorToken, 'coordinator-token-'.padEnd(48, 'c'), { mode: 0o600 });
    await writeFile(operatorToken, 'operator-token-'.padEnd(48, 'o'), { mode: 0o600 });
    // What /api/status answers a coordinator: the held jobs and production an operator-agent read withholds.
    const coordinatorView = { github: true, heldJobs: 2, jobs: [], production: { error: 'The deployment provider answered 503' } };
    const reads: { url: string; auth: string | null; method: string }[] = [];
    const fetcher = (async (url: string, init: RequestInit = {}) => {
      reads.push({ url, auth: new Headers(init.headers).get('Authorization'), method: init.method ?? 'GET' });
      return new Response(JSON.stringify(coordinatorView), { status: 200 });
    }) as typeof fetch;
    const deps = { snapshot: async () => ({ work: [], now: iso(0) }), mutate: async () => { throw new Error('not used'); }, executor: { principal: 'coordinator', instance: 'fault' }, fetcher };
    const withCoordinator = { ...config(), credentialFile: coordinatorToken } as MasterConfig;
    for (const source of [withCoordinator, { ...withCoordinator, operatorAgent: { id: 'graphyard-master-operator', credentialFile: operatorToken } } as MasterConfig]) {
      reads.length = 0;
      const status = await daemonEffects('/nonexistent', source, deps).controlPlane!();
      assert.deepEqual(reads, [{ url: 'https://graphyard.example/api/status', auth: `Bearer ${'coordinator-token-'.padEnd(48, 'c')}`, method: 'GET' }], 'the coordinator credential, never the operator-agent read that withholds these');
      const faults = cycleFaults(emptyDaemonState(source), [], clock, { config: source, status }).map(fault => `${fault.kind}:${fault.faultClass}`);
      assert.ok(faults.includes('held-jobs:configuration'), `held jobs are a configuration fault: ${faults.join(', ')}`);
      assert.ok(faults.includes('production:deployment'), `a production incident is a deployment fault: ${faults.join(', ')}`);
      assert.ok(!faults.includes('integration-job:observation'), 'held jobs are not reclassified as generic integration-job faults');
    }
    // Recurring past the threshold, the deployment class files its item.
    const filed: any[] = [];
    let status: Record<string, unknown> = { github: true };
    const effects = {
      agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [], now: iso(0) }),
      observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
      faultClassPolicy: policy, persist: async () => {}, controlPlane: async () => status,
      fileFaultClass: async (input: any) => { filed.push(input); return item(`GY-${300 + filed.length}`, { title: input.title, origin: input.origin } as Partial<Work>); },
    } as unknown as DaemonEffects;
    const state = emptyDaemonState(config());
    let now = clock;
    for (let round = 0; round < 3; round++) {
      status = { github: true, production: { error: `The deployment provider answered 503 (round ${round})` } };
      now = clock + round * 2 * 60_000; await runCycle(config(), state, effects, () => now);
      status = { github: true };
      now += 60_000; await runCycle(config(), state, effects, () => now);
    }
    assert.deepEqual(filed.map(input => input.origin.faultClass.class), ['deployment'], 'the recurring production fault files the deployment class once');
  } finally {
    await rm(secrets, { recursive: true, force: true });
  }
});

test('unit:recurring-class-item — a failed control-plane read ends no standing fault, so transient failures file nothing', async () => {
  const filed: any[] = [];
  let read: 'ok' | 'fail' = 'ok';
  const effects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [], now: iso(0) }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    faultClassPolicy: policy, persist: async () => {},
    controlPlane: async () => { if (read === 'fail') throw new Error('status read timed out'); return { github: true, heldJobs: 1, jobs: [] }; },
    reportedAttention: async () => ({ items: [] }),
    fileFaultClass: async (input: any) => { filed.push(input); return item(`GY-${400 + filed.length}`, { title: input.title, origin: input.origin } as Partial<Work>); },
  } as unknown as DaemonEffects;
  const state = emptyDaemonState(config());
  // The held job stands throughout; every other read of the status fails.
  for (let round = 0; round < 7; round++) {
    read = round % 2 ? 'fail' : 'ok';
    const now = clock + round * 60_000; await runCycle(config(), state, effects, () => now);
  }
  assert.equal(state.faults.instances.filter(entry => entry.kind === 'held-jobs').length, 1, 'one standing fault is one instance across the unread cycles');
  assert.deepEqual(filed, [], 'transient read failures neither reopen the standing fault nor file its class');
  // A cycle that read everything and no longer sees the fault ends it; its return is a new instance.
  const record = { instances: [] as FaultInstance[], open: {} as Record<string, string>, failing: {} as Record<string, string> };
  const held = { kind: 'held-jobs' as const, faultClass: 'configuration' as const, subject: 'installation', text: 'held' };
  trackFaults(record, [held], iso(0)); trackFaults(record, [], iso(60_000), true);
  assert.equal(trackFaults(record, [held], iso(120_000)).length, 0, 'partial: still the same instance');
  trackFaults(record, [], iso(180_000));
  assert.equal(trackFaults(record, [held], iso(240_000)).length, 1, 'a full read that cleared it ends it');
});

test('unit:fault-classes — unserved executor attention is classified once, as the executor configuration fault', () => {
  const unserved = describeUnserved({ live: [], unserved: [{ kind: 'merge', key: 'GY-1', requestedAt: iso(-hour), waitedMs: hour, start: 'graphyard executor start' }] } as any);
  const reported = unserved.map(entry => ({ subject: entry.keys[0], text: entry.text })) as AttentionItem[];
  const down = { subject: 'GY-2', text: `Every declared executor slot on this host is down (graphyard-executor@1.service inactive) while 1 action(s) are pending, the oldest merge for GY-2 since ${iso(-hour)}; GET /api/actions failed` };
  assert.deepEqual(classifyAttention([...reported, down]).map(entry => [entry.subject, entry.kind, entry.faultClass]), [['GY-1', 'executor', 'configuration'], ['GY-2', 'executor', 'configuration']]);
  // The status carries the same unserved lines: with the reported attention read, they are not a second fault.
  const status = { github: true, executors: { live: 0, attention: unserved } } as any;
  const state = emptyDaemonState(config());
  const faults = cycleFaults(state, [], clock, { config: config(), status, reported }).filter(fault => fault.faultClass === 'configuration' || fault.faultClass === 'unclassified');
  assert.deepEqual(faults.map(fault => [fault.subject, fault.kind]), [['GY-1', 'executor']]);
  // Without the reported attention (the dashboard's read), the status's copy is the one fault.
  assert.deepEqual(cycleFaults(state, [], clock, { config: config(), status }).filter(fault => fault.kind === 'executor').map(fault => fault.subject), ['executors']);
});

test('unit:recurring-class-item — distinct faults of one kind on one subject are as many instances as the dashboard counts', async () => {
  const lines = ['App lacks Contents: write', 'App lacks Checks: read', 'App lacks Pull requests: write'];
  const status = { github: true, appPermissions: { attention: lines } };
  const faults = statusFaults(status).filter(fault => fault.kind === 'app-permissions');
  assert.equal(faults.length, 3);
  const record = { instances: [] as FaultInstance[], open: {} as Record<string, string>, failing: {} as Record<string, string> };
  assert.equal(trackFaults(record, faults, iso(0)).length, 3, 'three distinct installation faults open three instances');
  assert.equal(new Set(record.instances.map(entry => entry.id)).size, 3, 'each instance has its own id');
  assert.equal(groupFaults(faults).find(group => group.faultClass === faults[0].faultClass)!.count, record.instances.length, 'the record agrees with the dashboard count');
  assert.equal(trackFaults(record, faults, iso(60_000)).length, 0, 'still standing: the same three instances');
  trackFaults(record, faults.slice(0, 2), iso(120_000));
  assert.equal(Object.keys(record.open).length, 2, 'one fewer ends one');
  assert.equal(trackFaults(record, faults, iso(180_000)).length, 1, 'its return is one new instance');
  // Three distinct faults of the class in the window reach the threshold, so the loop files it once.
  const filed: any[] = [];
  const effects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [], now: iso(0) }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    faultClassPolicy: policy, persist: async () => {}, controlPlane: async () => status, reportedAttention: async () => ({ items: [] }),
    fileFaultClass: async (input: any) => { filed.push(input); return item(`GY-${500 + filed.length}`, { title: input.title, origin: input.origin } as Partial<Work>); },
  } as unknown as DaemonEffects;
  const state = emptyDaemonState(config());
  await runCycle(config(), state, effects, () => clock);
  assert.deepEqual(filed.map(input => [input.origin.faultClass.class, input.origin.faultClass.count]), [[faults[0].faultClass, 3]]);
});

test('unit:recurring-class-item — the loop reads the attention master status adds with the coordinator credential, so intervention patterns recur', async () => {
  const secrets = await temporaryDirectory('fault-secrets');
  try {
    const coordinatorToken = join(secrets, 'coordinator.token'), operatorToken = join(secrets, 'operator.token');
    const coordinator = 'coordinator-token-'.padEnd(48, 'c'), operator = 'operator-token-'.padEnd(48, 'o');
    await writeFile(coordinatorToken, coordinator, { mode: 0o600 });
    await writeFile(operatorToken, operator, { mode: 0o600 });
    const reads: { path: string; auth: string | null }[] = [];
    // What the control plane answers: the intervention report refuses operator-agent callers (routes/interventions.ts).
    const fetcher = (async (url: string, init: RequestInit = {}) => {
      const path = url.replace('https://graphyard.example/api/', ''), auth = new Headers(init.headers).get('Authorization');
      reads.push({ path, auth });
      if (path.startsWith('interventions')) {
        if (auth !== `Bearer ${coordinator}`) return new Response(JSON.stringify({ error: 'Route is not available to operator agents' }), { status: 403 });
        return new Response(JSON.stringify({ window: { days: 7 }, deliveries: 0, total: 3, open: 3, waitedMs: 0, ratePerDelivery: null, byKind: {}, byStage: {}, costliest: [], judgements: [], ledger: null,
          patterns: [{ kind: 'blocked', stage: 'build', count: 3, threshold: 3, crossed: true, work: null }] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;
    const deps = { snapshot: async () => ({ work: [], now: iso(0) }), mutate: async () => { throw new Error('not used'); }, executor: { principal: 'coordinator', instance: 'fault' }, fetcher };
    const source = { ...config(), credentialFile: coordinatorToken, operatorAgent: { id: 'graphyard-master-operator', credentialFile: operatorToken } } as MasterConfig;
    const effects = daemonEffects(await temporaryDirectory('root', secrets), source, deps);
    const { items: reported } = await effects.reportedAttention!([], { github: true } as any, { agents: [], approvals: [], loop: {} as any, now: iso(0) });
    const interventionReads = reads.filter(entry => entry.path.startsWith('interventions'));
    assert.ok(interventionReads.length > 0, `the intervention report is read: ${reads.map(entry => entry.path).join(', ')}`);
    assert.ok(reads.every(entry => entry.auth === `Bearer ${coordinator}`), 'every read is the coordinator\'s, as master status reads them');
    const pattern = classifyAttention(reported).filter(entry => entry.kind === 'intervention-pattern');
    assert.equal(pattern.length, 1, `the crossed pattern reaches the loop: ${JSON.stringify(reported)}`);
    assert.ok(cycleFaults(emptyDaemonState(source), [], clock, { config: source, reported }).some(fault => fault.kind === 'intervention-pattern'), 'and is a fault the loop tracks');
  } finally {
    await rm(secrets, { recursive: true, force: true });
  }
});

test('unit:recurring-class-item — the loop tracks the report\'s final attribution, so one cause is one fault', async () => {
  // A reviewer that looks busy because a finished pane holds its name: the report names the resource in place of the symptom.
  const reading = { id: 'agent-names', resource: 'agent-names', title: 'Herdr agent names', unit: 'names', used: 1, bound: 1, headroom: 0, warnBelow: 1, state: 'exhausted', owner: 'master',
    reclaim: 'graphyard master reclaim', remedy: 'Close the finished pane holding graphyard-reviewer', detail: 'graphyard-reviewer (finished pane)', reclaimable: 1 } as unknown as ResourceReading;
  const symptom = (key: string): AttentionItem => ({ subject: key, text: `${key}'s reviewer agent graphyard-reviewer is busy in Herdr, so its review cannot be launched`, kind: 'launch-review', ...agentOwner('master', 'wait') });
  const attributed: unknown[] = [];
  const effects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [], now: new Date(now).toISOString() }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    faultClassPolicy: policy, persist: async () => {}, controlPlane: async () => ({ github: true }),
    reportedAttention: async () => ({ items: [symptom('GY-1')], attribute: (status: { work: any[]; attentionItems: AttentionItem[] }) => { attributed.push(status); return attributeAttention(status.attentionItems, [reading]); } }),
  } as unknown as DaemonEffects;
  let now = clock;
  const state = emptyDaemonState(config());
  await runCycle(config(), state, effects, () => now);
  assert.equal(attributed.length, 1, 'the report\'s attribution runs over the cycle\'s list');
  assert.deepEqual(state.faults.instances.filter(entry => entry.subject === 'GY-1').map(entry => [entry.kind, entry.faultClass]), [['resource-bound', 'resources']],
    'the session symptom is tracked as the resource it names, not also as session liveness');
  // Without the report's attribution the raw symptom stands for itself.
  const raw = cycleFaults(emptyDaemonState(config()), [], clock, { config: config(), reported: [symptom('GY-2')] });
  assert.deepEqual(raw.filter(fault => fault.subject === 'GY-2').map(fault => fault.kind), ['launch-review']);
});

test('unit:recurring-class-item — distinct faults of one class on one item are each tracked; a restatement is not', () => {
  const escalated = item('GY-1', { stage: 'review', escalations: [{ trigger: 'security-concern', reason: 'a token is logged', actor: 'graphyard', at: iso(0) }] } as Partial<Work>);
  const conflict: AttentionItem = { subject: 'GY-1', text: 'Review of GY-1 head abcdef123456 (PR #7) is conflicted: two verdicts answered one request', ...agentOwner('control plane', 'wait') };
  const faults = cycleFaults(emptyDaemonState(config()), [escalated], clock, { config: config(), reported: [conflict] });
  assert.deepEqual(faults.filter(fault => fault.subject === 'GY-1').map(fault => [fault.kind, fault.faultClass]),
    [['escalation:security-concern', 'review-convergence'], ['review-conflict', 'review-convergence']], 'the conflict is its own fault beside the escalation');
  // A derived line restating the item's own blocker under another kind is that blocker.
  const stalled: AttentionItem = { subject: 'GY-2', text: 'GY-2 has held its build gate for 3h0m with no action named and nothing moving it: nothing', ...agentOwner('master', 'file it') };
  assert.deepEqual(cycleFaults(emptyDaemonState(config()), [blocked('GY-2')], clock, { config: config(), reported: [stalled] }).filter(fault => fault.subject === 'GY-2').map(fault => fault.kind), ['blocker']);
});

test('unit:recurring-class-item — a fault fixed while another of its kind appears on the subject ends, and the other opens', () => {
  const record = { instances: [] as FaultInstance[], open: {} as Record<string, string>, failing: {} as Record<string, string> };
  const missing = (permission: string, age: string) => ({ ...statusFaults({ github: true, appPermissions: { attention: [`The App lacks ${permission}: write (missing for ${age})`] } })[0] });
  trackFaults(record, [missing('Checks', '59m'), missing('Contents', '59m'), missing('Issues', '59m')], iso(0));
  assert.equal(record.instances.length, 3);
  // The figures move while the faults stand: the same three faults, no new instance.
  assert.deepEqual(trackFaults(record, [missing('Checks', '1h0m'), missing('Contents', '1h0m'), missing('Issues', '1h0m')], iso(60_000)), []);
  // Checks is granted and Pull requests goes missing in the same cycle: the count is unchanged, but one fault ended and another opened.
  const opened = trackFaults(record, [missing('Contents', '1h1m'), missing('Issues', '1h1m'), missing('Pull requests', '1m')], iso(120_000));
  assert.deepEqual(opened.map(entry => entry.text), ['The App lacks Pull requests: write (missing for 1m)']);
  const standing = new Set(Object.values(record.open));
  assert.deepEqual(record.instances.filter(entry => standing.has(entry.id)).map(entry => /lacks (.+): write/.exec(entry.text)![1]).sort(), ['Contents', 'Issues', 'Pull requests'],
    'no standing instance still describes the granted permission');
  assert.equal(new Set(record.instances.map(entry => entry.id)).size, record.instances.length, 'every instance has its own id');
});

test('unit:recurring-class-item — a filing interrupted by a restart is retried, or adopted when its item stands', async () => {
  const filed: string[] = [];
  const effects = { fileFaultClass: async (_input: unknown, key: string) => { filed.push(key); return item('GY-50', { origin: { faultClass: { class: 'stalled-gate' } } } as Partial<Work>); }, faultClassPolicy: policy, persist: async () => {} } as unknown as DaemonEffects;
  const state = emptyDaemonState(config());
  const work = [blocked('GY-1'), blocked('GY-2'), blocked('GY-3')];
  trackFaults(state.faults, cycleFaults(state, work, clock), iso(0));
  // The daemon stopped after recording the filing as started and before the reply.
  storeAction(state, 'fault:stalled-gate', { kind: 'fault', work: null, principal: null, state: 'started', detail: 'Filing', attempts: 1, epoch: null, cycle: state.cycle, at: iso(0) });
  const [resumed] = reconcilePendingActions(state, work, clock);
  assert.equal(resumed.state, 'failed', 'with no item standing for the class the filing is retryable, not indeterminate');
  state.cycle += 1;
  await fileRecurringFaultClasses(state, effects, work, clock, () => clock, []);
  assert.equal(filed.length, 1, 'the interrupted filing is made again, under the idempotency key naming the same instances');
  assert.equal(state.actions['fault:stalled-gate'].state, 'done');
  // When the item the interrupted filing made does stand, the restart adopts it.
  const again = emptyDaemonState(config());
  storeAction(again, 'fault:stalled-gate', { kind: 'fault', work: null, principal: null, state: 'started', detail: 'Filing', attempts: 1, epoch: null, cycle: 0, at: iso(0) });
  const standing = item('GY-51', { stage: 'backlog', origin: { faultClass: { class: 'stalled-gate', threshold: 3, windowHours: 24, count: 3, instances: [], detectedAt: iso(0) } } } as Partial<Work>);
  assert.deepEqual(reconcilePendingActions(again, [blocked('GY-1'), standing], clock).map(entry => [entry.state, entry.work]), [['done', 'GY-51']]);
});

test('unit:recurring-class-item — a scope request from an attempt that no longer holds the lease is no standing fault', () => {
  const request = { paths: ['docs/'], reason: 'docs', requestedBy: 'graphyard-worker-1', epoch: 1, at: iso(-hour) };
  const faults = (lease: Work['lease']) => workFaults(item('GY-14', { scopeRequest: request, lease } as Partial<Work>), clock).map(fault => fault.kind);
  assert.deepEqual(faults({ owner: 'graphyard-worker-1', epoch: 1, expiresAt: iso(hour) }), ['scope-request'], 'the live attempt\'s request stands');
  assert.deepEqual(faults({ owner: 'graphyard-worker-1', epoch: 1, expiresAt: iso(-1) }), [], 'an expired lease leaves the request moot');
  assert.deepEqual(faults({ owner: 'graphyard-worker-2', epoch: 2, expiresAt: iso(hour) }), [], 'a later attempt\'s lease does not revive it');
  assert.deepEqual(faults(null), [], 'nor does no lease at all');
  // Three expired attempts' requests file no scope item.
  const record = { instances: [] as FaultInstance[], open: {} as Record<string, string>, failing: {} as Record<string, string> };
  const moot = ['GY-31', 'GY-32', 'GY-33'].map(key => item(key, { scopeRequest: request, lease: null } as Partial<Work>));
  trackFaults(record, cycleFaults(emptyDaemonState(config()), moot, clock), iso(0));
  assert.deepEqual(recurringClasses(record.instances, [], policy, clock).filter(entry => entry.file), []);
});

test('unit:recurring-class-item — a guarded merge the gate refused is no fault, so refusals file nothing', async () => {
  const filed: unknown[] = [];
  const candidates = ['GY-41', 'GY-42', 'GY-43'].map((key, index) => item(key, { stage: 'merge', epoch: 1, candidate: { sha: String(index + 1).repeat(40), branch: `graphyard/${key}`, pr: 40 + index } } as unknown as Partial<Work>));
  let refusal = 'the review gate has not passed';
  const effects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: candidates.map(entry => ({ ...entry })), now: new Date(now).toISOString() }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    merge: async () => { throw new Error(refusal); },
    faultClassPolicy: policy, persist: async () => {}, fileFaultClass: async (input: unknown) => { filed.push(input); return item('GY-199'); },
  } as unknown as DaemonEffects;
  let now = clock;
  const state = emptyDaemonState(config());
  for (let round = 0; round < 4; round++) { now = clock + round * 10 * 60_000; await runCycle(config(), state, effects, () => now); }
  const merges = Object.values(state.actions).filter(action => action.kind === 'merge');
  assert.equal(merges.length, 3, `each candidate's merge was tried: ${JSON.stringify(state.actions)}`);
  assert.ok(merges.every(action => action.state === 'failed' && action.faultClass === undefined), 'a refusal stays retryable and carries no class');
  assert.deepEqual(state.faults.instances.filter(entry => entry.faultClass === 'merge'), [], 'no refusal opens a merge instance');
  assert.deepEqual(filed, [], 'three refusals file no structural item');
  // A merge whose outcome is unknown is still the merge fault it was.
  storeAction(state, 'merge:work-GY-44:1', { kind: 'merge', work: 'GY-44', principal: null, state: 'indeterminate', detail: 'Resumed: interrupted', attempts: 1, epoch: 1, cycle: 0, at: iso(0) });
  assert.deepEqual(state.faults.instances.filter(entry => entry.faultClass === 'merge').map(entry => entry.subject), ['GY-44']);
});

test('unit:recurring-class-item — a starved reviewer or producer role reaches the loop, so its capacity item can be filed', async () => {
  const waiting = (key: string, id: string) => item(key, { stage: 'review', autoDispatch: { review: { id, state: 'requested', provider: 'github', requestedAt: iso(-hour) }, producers: [], history: [] } } as unknown as Partial<Work>);
  const work = [waiting('GY-1', 'r1'), waiting('GY-2', 'r2')];
  const master = { ...config(), reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude', kind: 'claude', approvals: 'auto', agentArgs: [], environment: {} }] } as unknown as MasterConfig;
  // The one reviewer slot is held by a live session while two requests have waited an hour for it.
  const derived = await derivedAttention('/nonexistent', master, async () => ({}), { github: true }, { work, now: iso(0) },
    { reviews: [], producers: [], runtime: { available: true, agents: [{ name: 'review-claude', agent_status: 'working' }] as never }, trees: [], standalone: true });
  const starved = classifyAttention(derived.items).filter(entry => entry.kind === 'concurrency-starved');
  assert.deepEqual(starved.map(entry => [entry.subject, entry.faultClass]), [['reviewer concurrency', 'capacity']], JSON.stringify(derived.items));
  const state = emptyDaemonState(master);
  trackFaults(state.faults, cycleFaults(state, work, clock, { config: master, reported: derived.items }), iso(0));
  assert.deepEqual(state.faults.instances.filter(entry => entry.kind === 'concurrency-starved').map(entry => entry.faultClass), ['capacity'], 'the starved role is a tracked capacity instance');
});

test('unit:recurring-class-item — the loop tracks its own cost, silence and delivery-budget lines', async () => {
  const state = emptyDaemonState(config());
  const lines = loopAttention({ liveness: { state: 'running', detail: 'ok', restart: 'restart' } as never, budget: { met: false, reasons: ['approval→merge p90 is 3h, over 1h'] } as never,
    silence: { breached: true, budgetMs: 30 * 60_000, actionable: 2, longest: { work: 'GY-9', detail: 'GY-9 merge', idleMs: 45 * 60_000 } } as never });
  assert.deepEqual(lines.map(line => line.kind).sort(), ['delivery-budget', 'loop-silence']);
  trackFaults(state.faults, cycleFaults(state, [], clock, { config: config(), loop: lines }), iso(0));
  assert.deepEqual(state.faults.instances.map(entry => [entry.kind, entry.faultClass]).sort(), [['delivery-budget', 'loop'], ['loop-silence', 'loop']]);
  // The running loop passes them itself: a latency budget it misses is a loop instance without any report read.
  const effects = { agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [], now: iso(0) }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }), faultClassPolicy: policy, persist: async () => {} } as unknown as DaemonEffects;
  const cycling = emptyDaemonState(config());
  // The previous cycle's own work overran the interval: the next cycle records that cost.
  cycling.metrics.push({ cycle: 0, at: iso(-60_000), durationMs: 10 * config().run.intervalSeconds * 1000, childWaitMs: 0, open: 0, actions: 0 } as never);
  await runCycle(config(), cycling, effects, () => clock);
  assert.deepEqual(cycling.faults.instances.filter(entry => entry.kind === 'loop-cost').map(entry => [entry.subject, entry.faultClass]), [['loop', 'loop']], JSON.stringify(cycling.faults.instances));
  assert.ok(!cycling.faults.instances.some(entry => entry.kind === 'loop-liveness'), 'a cycling loop never records itself as absent');
});

test('unit:recurring-class-item — a Herdr outage opens no session faults and ends none that stand', async () => {
  const master = { ...config(), workers: [{ name: 'claude-worker', principal: 'worker-a', agentName: 'work-claude', mode: 'launch', kind: 'claude', credentialFile: '/outside/worker.token', approvals: 'auto', agentArgs: [], environment: {} }] } as unknown as MasterConfig;
  const leased = item('GY-1', { stage: 'build', ready: true, epoch: 1, lease: { owner: 'worker-a', epoch: 1, expiresAt: iso(hour) } } as Partial<Work>);
  const state = emptyDaemonState(master);
  // Herdr unreadable: the assigned session is not reported, which is no evidence it is gone.
  assert.ok(!cycleFaults(state, [leased], clock, { config: master, agents: [], herdrUnavailable: true }).some(entry => herdrFaultKinds.has(entry.kind)), 'no session-derived fault is observed while Herdr is unread');
  // A session fault that stands is kept through the outage, and ends on a full read that no longer sees it.
  const missing = cycleFaults(state, [leased], clock, { config: master, agents: [] }).filter(entry => entry.kind === 'session');
  assert.equal(missing.length, 1);
  trackFaults(state.faults, missing, iso(0));
  trackFaults(state.faults, [], iso(60_000), herdrFaultKinds);
  assert.equal(trackFaults(state.faults, missing, iso(120_000)).length, 0, 'the outage ended nothing, so its return is no new instance');
  trackFaults(state.faults, [{ kind: 'held-jobs', faultClass: 'configuration', subject: 'installation', text: 'held' }], iso(180_000), herdrFaultKinds);
  assert.equal(Object.values(state.faults.open).length, 2, 'only the unread kinds are kept; a full read of the rest still tracks them');
  // The loop's wiring: a failed Herdr read reaches the report as unavailable, and three live leases file nothing.
  const filed: unknown[] = [], observed: unknown[] = [];
  const work = ['GY-1', 'GY-2', 'GY-3'].map((key, index) => item(key, { stage: 'build', ready: true, epoch: 1, lease: { owner: `worker-${index}`, epoch: 1, expiresAt: iso(hour) } } as Partial<Work>));
  const three = { ...master, workers: [0, 1, 2].map(index => ({ ...master.workers[0], name: `worker-${index}`, principal: `worker-${index}`, agentName: `work-${index}`, mode: 'existing' })) } as MasterConfig;
  const effects = { agents: () => [], herdr: async () => ({ agents: [], available: false }), credentials: async () => ({}), snapshot: async () => ({ work, now: iso(0) }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }), faultClassPolicy: policy, persist: async () => {},
    controlPlane: async () => ({ github: true }), reportedAttention: async (_work: Work[], _coordinator: unknown, seen: { available?: boolean }) => { observed.push(seen.available); return { items: [] }; },
    fileFaultClass: async (input: unknown) => { filed.push(input); return item('GY-99'); } } as unknown as DaemonEffects;
  const outage = emptyDaemonState(three);
  for (let round = 0; round < 3; round++) await runCycle(three, outage, effects, () => clock + round * 60_000);
  assert.ok(observed.length && observed.every(value => value === false), 'the report reads Herdr as unavailable');
  assert.ok(!outage.faults.instances.some(entry => entry.kind === 'session'), JSON.stringify(outage.faults.instances));
  assert.deepEqual(filed, [], 'a Herdr outage files no session-liveness item');
  // A missing session read with Herdr up stands through a cycle Herdr cannot be read, as the same instance.
  let up = true;
  const one = { ...three, workers: [three.workers[0]] } as MasterConfig, standing = emptyDaemonState(one);
  const flapping = { ...effects, herdr: async () => ({ agents: [], available: up }), snapshot: async () => ({ work: [work[0]], now: iso(0) }) } as unknown as DaemonEffects;
  for (const [round, available] of [true, false, true].entries()) { up = available; await runCycle(one, standing, flapping, () => clock + round * 60_000); }
  assert.equal(standing.faults.instances.filter(entry => entry.kind === 'session').length, 1, `the outage cycle ended nothing: ${JSON.stringify(standing.faults.instances)}`);
});

// GY-368: follow-ups from the approved review of GY-173.
test('unit:recurring-class-item — a fault reworded while it stands alone on its subject keeps its instance', () => {
  const record = { instances: [] as FaultInstance[], open: {} as Record<string, string>, failing: {} as Record<string, string> };
  const blocker = (text: string) => ({ kind: 'blocker' as const, faultClass: 'stalled-gate' as const, subject: 'GY-1', text });
  assert.equal(trackFaults(record, [blocker('npm test fails on a missing fixture')], iso(0)).length, 1);
  assert.deepEqual(trackFaults(record, [blocker('Still blocked: the fixture the tests read was never committed')], iso(60_000)), [], 'the same blocker restated is the same instance');
  assert.deepEqual(trackFaults(record, [blocker('Waiting on the fixture upload')], iso(120_000)), []);
  assert.equal(record.instances.length, 1, 'one cause counts once toward its class');
  assert.equal(record.instances[0].text, 'Waiting on the fixture upload');
  assert.equal(record.instances[0].lastSeenAt, iso(120_000));
  // Rewording carries only a lone fault: two of a kind on the subject stay told apart by their wording (see the fixed-while-another-appears test).
  trackFaults(record, [], iso(180_000));
  assert.equal(trackFaults(record, [blocker('Waiting on the fixture upload')], iso(240_000)).length, 1, 'cleared and back is still a new instance');
});

test('unit:recurring-class-item — standing faults are observed on a slower cadence than the loop cycles', async () => {
  let reads = 0;
  const effects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [], now: iso(0) }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    faultClassPolicy: policy, persist: async () => {},
    controlPlane: async () => { reads++; return { github: true, heldJobs: 1, jobs: [] }; },
    reportedAttention: async () => { reads++; return { items: [] }; },
  } as unknown as DaemonEffects;
  const state = emptyDaemonState(config());
  const interval = config().run.intervalSeconds * 1000;
  for (let at = 0; at < faultObservationIntervalMs; at += interval) await runCycle(config(), state, effects, () => clock + at);
  assert.equal(reads, 2, 'cycles inside the interval reuse the last observation: one control-plane read and one attention read');
  assert.equal(state.faults.instances.filter(entry => entry.kind === 'held-jobs').length, 1);
  await runCycle(config(), state, effects, () => clock + faultObservationIntervalMs);
  assert.equal(reads, 4, 'the next interval reads again');
  assert.equal(state.faults.observedAt, iso(faultObservationIntervalMs));
  assert.equal(state.faults.instances.filter(entry => entry.kind === 'held-jobs').length, 1, 'the fault standing across the interval is still one instance');
});

test('unit:recurring-class-item — daemonSummary reports faults under the policy the loop files by', () => {
  const state = emptyDaemonState(config());
  const injected = { threshold: 7, windowHours: 2 };
  assert.deepEqual(daemonSummary(state, clock, 20_000, 'machine-a', injected).faults.policy, injected);
  const previous = { threshold: process.env.GRAPHYARD_FAULT_CLASS_THRESHOLD, windowHours: process.env.GRAPHYARD_FAULT_CLASS_WINDOW_HOURS };
  process.env.GRAPHYARD_FAULT_CLASS_THRESHOLD = '5'; process.env.GRAPHYARD_FAULT_CLASS_WINDOW_HOURS = '6';
  try { assert.deepEqual(daemonSummary(state, clock, 20_000, 'machine-a').faults.policy, { threshold: 5, windowHours: 6 }, 'absent, the environment\'s'); }
  finally {
    for (const [name, value] of [['GRAPHYARD_FAULT_CLASS_THRESHOLD', previous.threshold], ['GRAPHYARD_FAULT_CLASS_WINDOW_HOURS', previous.windowHours]] as const)
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
// GY-1086's proof, manual:fault-class-configuration, is the tests below. The master loop filed 18
// configuration faults in 24 hours on 1 October 2026 — "a permission, variable, setup step, executor
// or sandbox rule the installation lacks". The installation lacked none of them. The shared cause:
// the loop read a state the product is in by design, or on its way through, as a configuration gap,
// and counted one standing refusal again every time its own cursor bound forgot it.
//
//   - executor (4): a pending merge row "no executor serves" — on an installation where the master
//     loop is the one merger (GY-245) and the executors are declared without merge on purpose;
//   - executor (1): "no executor is alive" read off a control plane's in-memory presence that had
//     heard from nobody yet;
//   - setup (2), executor slots (2): systemd units read while `deactivating`, the state every restart
//     passes through — the loop's own self-upgrade hand-off, an operator's restart;
//   - fleet (2): a role at its concurrency limit (capacity working), and the opt-in master role not
//     yet named, which the loop's own master step already records as a wait and not a fault;
//   - action:config (6 + 1): upgrade:refused and escalation:dirty-checkout are written once while
//     they stand; the row went oldest, the 500-row cursor bound retired it, and the next cycle
//     refused afresh as a new instance — six for one operator hold on the coordinator checkout.
//
// Each instance is replayed against the shipped code. Against the base each test fails on its first
// assertion, the instance recurring; against the candidate it does not.

const instances = {
  merge: ['executor|GY-1063|2026-10-01T13:27:57.751Z', 'executor|GY-980|2026-10-01T13:36:37.333Z', 'executor|GY-1063|2026-10-01T14:32:06.820Z', 'executor|GY-566|2026-10-01T22:16:21.164Z'],
  presence: ['executor|GY-859|2026-10-01T17:23:33.080Z'],
  stopping: ['setup|setup|2026-10-01T15:49:12.364Z', 'setup|setup|2026-10-01T22:14:48.524Z', 'executor|executors|2026-10-01T22:14:48.524Z', 'executor|executors|2026-10-01T22:14:48.524Z#1'],
  fleet: ['fleet|fleet|2026-10-01T14:36:57.269Z', 'fleet|fleet|2026-10-01T17:23:33.080Z'],
  refusal: ['action:config|upgrade:refused|2026-10-01T14:25:15.429Z', 'action:config|upgrade:refused|2026-10-01T15:33:29.852Z', 'action:config|upgrade:refused|2026-10-01T18:11:52.788Z',
    'action:config|upgrade:refused|2026-10-01T19:33:20.278Z', 'action:config|upgrade:refused|2026-10-01T20:52:08.903Z', 'action:config|upgrade:refused|2026-10-01T21:59:36.232Z'],
  dirty: ['action:config|escalation:dirty-checkout|2026-10-01T15:46:00.796Z'],
};

test('manual:fault-class-configuration — the item lists 18 instances, and every one is replayed below', () => {
  const all = Object.values(instances).flat();
  assert.equal(all.length, 18);
  assert.equal(new Set(all).size, 18);
  for (const id of all) assert.equal(faultClassOf(id.split('|')[0]), 'configuration', id);
});

const pendingRow = (key: string, kind: NextActionKind, requestedAt: string): Work => ({
  id: `work-${key}`, key, stage: 'build',
  actionQueue: { history: [], actions: [{ id: `${kind}-${key}`, kind, work: `work-${key}`, key, inputs: { kind } as ActionRow['inputs'], gate: null, refusal: null, reason: `${key} needs ${kind}`,
    binding: `${kind}:1`, requestedBy: 'graphyard', requestedAt, state: 'pending', claim: null, attempts: 0, history: [] } as ActionRow] },
} as unknown as Work);

/** A coordinator host that declared two slots without merge, as `--install` writes them beside a merging loop. */
async function declaredHost(slot: string) {
  const root = await temporaryDirectory('config-faults');
  execFileSync('git', ['init', '-q', root]);
  await mkdir(join(root, '.graphyard'), { recursive: true, mode: 0o700 });
  await writeExecutorDeclaration(root, { version: 1, count: 2, kinds: [...loopMergerExecutorKinds], intervalSeconds: 5 });
  const run: SystemctlRunner = args => {
    if (args[0] === 'is-active') { if (slot === 'active') return 'active'; throw Object.assign(new Error(slot), { stdout: `${slot}\n` }); }
    return '';
  };
  return { root, run };
}

for (const id of instances.merge) {
  const [, key, at] = id.split('|');
  test(`manual:fault-class-configuration — ${id}: a merge row is the merging loop's, never an executor the fleet lacks`, async () => {
    const now = new Date(Date.parse(at));
    const registry = new ExecutorRegistry(new Date(now.getTime() - 3_600_000));
    for (const slot of [1, 2]) registry.observe({ executor: `graphyard-master@vishrog/${slot}`, host: 'vishrog', principal: 'graphyard-master', kinds: [...loopMergerExecutorKinds] }, now);
    const work = [pendingRow(key, 'merge', new Date(now.getTime() - 7 * 60_000).toISOString())];
    const report = executorReport(work, registry, now);
    const { root, run } = await declaredHost('active');
    try {
      const loop = async () => ({ name: 'the master loop (graphyard-master.service, automatic merging on)' });
      const fleet = await executorFleet(root, async () => ({ executors: report }), { work, now: now.toISOString() }, run, loop);
      assert.deepEqual(fleet.attention.map(item => item.text).filter(text => /^Nothing can run merge/.test(text)), [], 'no executor is asked for merge beside a merging loop');
      // Without a merging loop the same row is a real gap, named as before.
      const alone = await executorFleet(root, async () => ({ executors: report }), { work, now: now.toISOString() }, run, async () => null);
      assert.match(alone.attention[0].text, new RegExp(`^Nothing can run merge: ${key} has waited 7m`));
      assert.equal(attentionKind({ subject: key, text: alone.attention[0].text }), 'executor');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test(`manual:fault-class-configuration — ${instances.presence[0]}: a control plane that has heard from nobody yet does not report the fleet dead`, () => {
  const now = new Date('2026-10-01T17:23:33.080Z');
  const work = [pendingRow('GY-859', 'resync', '2026-10-01T17:06:00.000Z'), pendingRow('GY-860', 'resync', '2026-10-01T17:10:00.000Z')];
  const listening = executorReport(work, new ExecutorRegistry(new Date(now.getTime() - 10_000)), now);
  assert.deepEqual(listening.unserved, [], 'ten seconds after a restart, no executor has had its turn to poll');
  // A full liveness window later, an empty registry is a dead fleet, and says so.
  const silent = executorReport(work, new ExecutorRegistry(new Date(now.getTime() - executorLiveMs - 1)), now);
  assert.deepEqual(silent.unserved.map(entry => entry.key), ['GY-859', 'GY-860']);
  // One executor heard inside the first window is judged at once: the warm-up never hides a kind nobody serves.
  const early = new ExecutorRegistry(new Date(now.getTime() - 10_000));
  early.observe({ executor: 'e/1', host: 'h', principal: 'p', kinds: executorRunnableKinds.filter(kind => kind !== 'resync') }, now);
  assert.deepEqual(executorReport(work, early, now).unserved.map(entry => entry.kind), ['resync', 'resync']);
});

for (const id of instances.stopping) {
  const [kind] = id.split('|');
  test(`manual:fault-class-configuration — ${id}: a unit systemd is stopping is a restart in passage, not a supervisor or slot that is down`, async () => {
    if (kind === 'setup') {
      const home = await temporaryDirectory('config-faults-home');
      try {
        const host = (active: string) => ({ platform: 'linux' as const, home, temporaryDirectories: [], run: (command: string, args: string[]) => {
          if (command === 'loginctl') return 'yes';
          if (args.includes('is-active')) { if (active === 'active') return 'active'; throw Object.assign(new Error(active), { stdout: `${active}\n` }); }
          if (args.includes('is-enabled')) return 'enabled';
          return '';
        } });
        const stopping = loopSupervisionAttention(await loopSupervision({ root: home, cliPath: launcher }, host('deactivating'))).map(item => item.text);
        assert.deepEqual(stopping.filter(text => /installed but not running/.test(text)), [], 'the loop reading its own unit mid-restart');
        const stopped = loopSupervisionAttention(await loopSupervision({ root: home, cliPath: launcher }, host('inactive'))).map(item => item.text);
        assert.ok(stopped.some(text => /installed but not running/.test(text)), 'a unit that stays stopped is still named');
      } finally { await rm(home, { recursive: true, force: true }); }
      return;
    }
    const now = new Date('2026-10-01T22:14:48.524Z');
    const registry = new ExecutorRegistry(new Date(now.getTime() - 3_600_000));
    registry.observe({ executor: 'graphyard-master@vishrog/1', host: 'vishrog', principal: 'graphyard-master', kinds: [...loopMergerExecutorKinds] }, now);
    const report = executorReport([], registry, now);
    for (const [state, named] of [['deactivating', false], ['failed', true]] as const) {
      const { root, run } = await declaredHost(state);
      try {
        const fleet = await executorFleet(root, async () => ({ executors: report }), { work: [], now: now.toISOString() }, run, async () => null);
        const lines = fleet.attention.map(item => item.text).filter(text => /^Executor slot \d is /.test(text));
        assert.equal(lines.length, named ? 2 : 0, `slots ${state}: ${lines.join(' | ')}`);
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  });
}

const fleet = (attention: string[]) => ({ revision: 1, updatedAt: null, configured: true, host: 'vishrog', runtimes: [], models: [], accounts: [], roles: [], sessions: [], refusals: [], lastMutation: null, attention }) as unknown as FleetView;
for (const [id, line] of [[instances.fleet[0], 'role reviewer is at its concurrency limit (6 of 6 live)'],
  [instances.fleet[1], 'role master is not configured; the durable loop launches no master session until graphyard master registry role set master ACCOUNT[,ACCOUNT…] --reason REASON names its accounts']] as const) {
  test(`manual:fault-class-configuration — ${id}: "${line.slice(0, 40)}…" is the fleet as configured, not a configuration it lacks`, () => {
    const control = 'role producer is not configured; its sessions launch from local profiles until it is';
    const items = fleetStatus(fleet([line, control])).attentionItems;
    assert.deepEqual(items.map(item => item.text), [control], 'only the line naming a gap is raised');
    assert.equal(items[0].kind, 'fleet');
  });
}

// The loop's refusals, replayed over the cycles of the day: each cycle the refusal is observed again,
// the loop's other work resolves enough actions to pass the cursor bound, and the cursor is pruned.
const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/nonexistent/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
function churn(state: DaemonState, at: number, cycle: number) {
  for (let index = 0; index <= retainedActions; index += 1)
    state.actions[`merge:churn-${cycle}-${index}`] = { kind: 'merge', work: `GY-${index}`, principal: null, state: 'done', detail: 'merged', attempts: 1, epoch: null, cycle, at: new Date(at + index).toISOString() } as DaemonState['actions'][string];
  pruneDaemonState(state);
  endFailingRuns(state, policy, at + retainedActions + 1);
}
const opened = (state: DaemonState, subject: string) => state.faults.instances.filter(entry => entry.kind === 'action:config' && entry.subject === subject);

test(`manual:fault-class-configuration — ${instances.refusal.join(', ')}: one hold on the coordinator checkout is one instance for as long as it stands`, async () => {
  const start = Date.parse('2026-10-01T14:25:15.429Z'), step = 80 * 60_000;
  const tip = 'b'.repeat(40);
  let head = '2a2d311349c4'.padEnd(40, '0'), now = start;
  const run = async (_command: string, args: string[]) => {
    const op = args[2];
    if (op === 'rev-parse') return `${args[3] === 'HEAD' ? head : tip}\n`;
    if (op === 'symbolic-ref') return 'refs/heads/coordinator/hold-until-gy-1005';
    if (op === 'status' || op === 'fetch') return '';
    throw new Error(`fake git cannot answer: git ${args.slice(2).join(' ')}`);
  };
  const state = emptyDaemonState(master);
  state.deployment = deploymentObservationSchema.parse({ source: 'endpoint', sha: tip, at: new Date(start).toISOString(), reason: null, deployed: ['GY-1'], pending: [] });
  // A day and a half of cycles; the operator commits on the hold branch at 18:11, as on the day.
  for (let cycle = 0; cycle < 27; cycle += 1) {
    if (now >= Date.parse('2026-10-01T18:11:52.788Z')) head = 'f0de7bd665ac'.padEnd(40, '0');
    const outcome = await performSelfUpgrade(master, state, { root: '/coordinator', run, now: () => now });
    assert.equal(outcome.outcome, 'refused');
    churn(state, now + 1, cycle);
    now += step;
  }
  assert.equal(opened(state, 'upgrade:refused').length, 1, `the hold opened ${opened(state, 'upgrade:refused').length} instances`);
  assert.match(state.actions['upgrade:refused']!.detail, /at f0de7bd665ac untouched: HEAD holds refs\/heads\/coordinator\/hold-until-gy-1005/);
  // The hold ends: the checkout is detached at the tip, the refusal clears, and a later hold is a new instance.
  head = tip;
  await performSelfUpgrade(master, state, { root: '/coordinator', run: async (command, args) => args[2] === 'symbolic-ref' ? Promise.reject(Object.assign(new Error('not a symbolic ref'), { status: 1 })) : run(command, args), now: () => now });
  assert.equal(state.upgrade.refused, null);
});

test(`manual:fault-class-configuration — ${instances.dirty[0]}: a dirty checkout refused between cycles is one instance while it stands`, () => {
  // The loop's checkout guard (daemon/run.ts) writes the escalation only when its detail changes,
  // exactly as here; the row then has to outlive the cursor bound for the refusal to stay one fault.
  const key = 'escalation:dirty-checkout';
  const detail = 'the master loop refuses to start, self-upgrade or restart from the coordinator checkout at /home/vish/code/graphyard: it holds uncommitted work at 2a2d311349c4 — 2 modified and 0 untracked source dirty path(s): src/daemon/cycle-delivery.ts, tests/master-daemon.test.ts';
  const state = emptyDaemonState(master);
  let now = Date.parse('2026-10-01T15:46:00.796Z');
  for (let cycle = 0; cycle < 12; cycle += 1) {
    if (detailChanged(state.actions[key], detail))
      storeAction(state, key, { kind: 'escalation', work: null, principal: null, state: 'failed', detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, epoch: null, cycle, at: new Date(now).toISOString() }, 'action:config');
    churn(state, now + 1, cycle);
    now += 30 * 60_000;
  }
  assert.equal(opened(state, key).length, 1, `the dirty checkout opened ${opened(state, key).length} instances`);
  assert.equal(Object.keys(state.actions).length <= retainedActions + 1, true, 'the cursor bound still holds');
});

// GY-950: a worker role at its concurrency limit was filed under the configuration class, though the
// product itself treats the same refusal as a wait for a slot. GY-947's tripping instance was a
// saturated, healthy fleet: 8 of 8 worker sessions live, every one on work.
function saturatedFleet(idle = 0): AgentRegistry {
  const at = iso(-hour);
  let registry = emptyRegistry();
  const change = (kind: Parameters<typeof applyRegistryMutation>[1], input: unknown) => { registry = applyRegistryMutation(registry, kind, input, { actor: 'operator', at }).registry; };
  change('apply', { runtimes: [proposedRuntimes.find(runtime => runtime.name === 'claude')!], models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: [{ name: 'claude-primary', runtime: 'claude', model: 'opus', credential: { host: 'machine-a', home: '/agents/claude-primary' } }],
    roles: fleetRoles.map(name => ({ name, accounts: ['claude-primary'], concurrency: name === 'worker' ? 8 : 2 })), reason: 'fixture' });
  const session = (index: number): FleetSession => ({ id: `worker-session-${index}`, role: 'worker', account: 'claude-primary', runtime: 'claude', model: 'opus', host: 'machine-a',
    work: index < 8 - idle ? `GY-${500 + index}` : null, principal: `graphyard-worker-${index}`, selectedAt: at, selectedBy: 'master', reason: 'fixture', skipped: [], endedAt: null, endReason: null });
  registry.sessions.push(...Array.from({ length: 8 }, (_, index) => session(index)));
  return registry;
}
const fleetFaults = (registry: AgentRegistry, host: string | null) => {
  const state = emptyDaemonState(config());
  trackFaults(state.faults, cycleFaults(state, [], clock, { config: config(), status: { github: true, fleet: fleetView(registry, clock, host) } as never }), iso(0));
  return state.faults.instances;
};

test('unit:full-role-on-work-raises-no-configuration-fault — a worker role at its limit with every session on work raises no fleet attention and no configuration instance', () => {
  for (const host of [null, 'machine-a']) {
    const view = fleetView(saturatedFleet(), clock, host), worker = view.roles.find(role => role.role === 'worker')!;
    assert.match(worker.blocked!, /role worker is at its concurrency limit \(8 of 8 live/, 'the role still says why it cannot launch');
    assert.deepEqual(view.attention, [], `a full role whose sessions all carry work is a wait for a slot (host ${host})`);
    assert.deepEqual(fleetStatus(view).attentionItems, []);
    const status = buildMasterStatus({ work: [], now: iso(0) }, [], [], {}, {}, { pending: [], completed: [] }, 'main', { fleet: view });
    assert.deepEqual(status.attentionItems.filter(entry => entry.subject === 'fleet'), []);
    const instances = fleetFaults(saturatedFleet(), host);
    assert.deepEqual(instances.filter(entry => entry.faultClass === 'configuration'), [], `the configuration detector records nothing: ${JSON.stringify(instances)}`);
    assert.deepEqual(instances.filter(entry => entry.subject === 'fleet'), []);
  }
});

test('unit:unaccounted-role-sessions-raise-capacity-not-configuration — a full role holding sessions with no work raises one line naming them, classified as capacity', () => {
  for (const host of [null, 'machine-a']) {
    const view = fleetView(saturatedFleet(2), clock, host);
    assert.deepEqual(view.attention, ['role worker is at its concurrency limit (8 of 8 live) with 2 sessions carrying no work: worker-session-6 (claude-primary), worker-session-7 (claude-primary)']);
    const [raised, ...rest] = fleetStatus(view).attentionItems;
    assert.deepEqual(rest, []);
    assert.deepEqual([raised.subject, raised.kind, raised.faultClass, raised.role, raised.human], ['fleet', 'fleet-capacity', 'capacity', 'master', false]);
    assert.match(raised.next, /master registry session end ID --reason REASON/);
    const instances = fleetFaults(saturatedFleet(2), host);
    assert.deepEqual(instances.map(entry => [entry.kind, entry.faultClass, entry.subject]), [['fleet-capacity', 'capacity', 'fleet']], JSON.stringify(instances));
  }
  // A role at its limit by a master session (which never carries work) is accounted for.
  let registry = saturatedFleet();
  registry = applyRegistryMutation(registry, 'role.set', { role: { name: 'master', accounts: ['claude-primary'], concurrency: 1 }, reason: 'fixture' }, { actor: 'operator', at: iso(-hour) }).registry;
  registry.sessions.push({ ...registry.sessions[0], id: 'master-session', role: 'master', work: null });
  assert.deepEqual(fleetView(registry, clock).attention.filter(line => /role master/.test(line)), []);
});

test('unit:fault-classes — the fleet at-limit line is capacity; the genuine registry-configuration lines stay configuration', () => {
  assert.deepEqual(faultClasses.filter(faultClass => (faultCatalogue[faultClass] as readonly string[]).includes('fleet-capacity')), ['capacity']);
  assert.equal(faultClassOf('fleet'), 'configuration');
  const view = { ...fleetView(saturatedFleet(1), clock), attention: ['role worker is at its concurrency limit (8 of 8 live) with 1 session carrying no work: s (a)', 'role approver is not configured; its sessions launch from local profiles until it is', 'idle serves no role; name it in a role or remove it'] };
  assert.deepEqual(fleetStatus(view).attentionItems.map(entry => [entry.kind, entry.faultClass]), [['fleet-capacity', 'capacity'], ['fleet', 'configuration'], ['fleet', 'configuration']]);
  // A paused role is the operator's own setting, still raised as before.
  const paused = applyRegistryMutation(saturatedFleet(), 'role.set', { role: { name: 'producer', accounts: ['claude-primary'], concurrency: 0 }, reason: 'fixture' }, { actor: 'operator', at: iso(-hour) }).registry;
  assert.ok(fleetView(paused, clock, 'machine-a').attention.includes('role producer is paused (concurrency 0)'));
});

test('manual:fault-class-configuration — GY-947\'s fleet instance (role worker at its limit, 8 of 8 live) recurs on the candidate as a capacity instance or none, never configuration', () => {
  // The instance as GY-947 recorded it: fleet on fleet, "role worker is at its concurrency limit (8 of 8 live)", every session on work.
  for (const idle of [0, 3]) for (const host of [null, 'machine-a']) {
    const instances = fleetFaults(saturatedFleet(idle), host).filter(entry => entry.subject === 'fleet');
    assert.deepEqual(instances.filter(entry => entry.faultClass === 'configuration'), [], `no configuration instance (idle ${idle}, host ${host}): ${JSON.stringify(instances)}`);
    assert.ok(instances.every(entry => entry.faultClass === 'capacity'), JSON.stringify(instances));
    assert.equal(instances.length, idle ? 1 : 0);
  }
});

// GY-915: the non-exercising-proof rework line (GY-817) and the stopped-retry line (GY-598) set no
// kind and matched no signature, so every instance was counted as unclassified and the loop filed
// grab-bag GY-889 for them. These are the instance texts listed on GY-889: the 2026-09-27 trio
// verbatim as the loop recorded them, GY-831's as recorded up to its truncation, and GY-876's and
// GY-727's in the builder's wording.
const gy889Lines = [
  { subject: 'GY-537', text: 'The loop stopped retrying follow-up filing for approval 5327884989 (PR #372) for GY-537: 10 consecutive attempts failed with the same client error, so another attempt would get the same answer — the follow-ups could not be appended to GY-808: Graphyard refused the follow-ups for GY-808 (409): Idempotency key reused with different input' },
  { subject: 'GY-853', text: 'GY-853 is awaiting rework for a non-exercising proof: unit:worker-submits-sandbox-failures-to-ci was recorded as not exercising AC-1 on 1d49f9919749: the mutation removing "Workers submit when their own criteria pass; the full test suite is CI\'s gate. The submission policy rule is exported from src/master/harness.ts and included in the worker prompt in src/master/dispatch.ts." survived — unit:worker-submits-sandbox-failures-to-ci does not exercise AC-1: no case ran against the tree with "Workers' },
  { subject: 'GY-888', text: 'GY-888 is awaiting rework for a non-exercising proof: unit:coordinator-write-blocked-for-shell was recorded as not exercising AC-1 on 70826ae41197: the mutation removing "assertion that write operations to read-only mounted coordinator checkout fail with Permission denied or Read-only error" survived — unit:coordinator-write-blocked-for-shell does not exercise AC-1: it passed against the tree with "assertion that write operations to read-only mounted coordinator checkout fail with Permission den' },
  { subject: 'GY-831', text: 'GY-831 is awaiting rework for a non-exercising proof: unit:carried-approval-rebinds was recorded as not exercising unit:carried-approval-rebinds on 5b4ac3a6decb: the mutation removing "refreshedCarriedApproval function re-binds a carried approval from an earlier pull request to a newer approval of …' },
  { subject: 'GY-876', text: 'GY-876 is awaiting rework for a non-exercising proof: unit:master-status-fast was recorded as not exercising AC-1 on 71edb8fc5b78: the mutation removing "the bounded status read" survived. The unit proofs are a defect of the candidate\'s tests, as a failing proof is; the loop requests the rework decision and the next head is proven afresh' },
  { subject: 'GY-727', text: 'GY-727 is awaiting rework for a non-exercising proof: unit:gy727-proof was recorded as not exercising AC-1 on 2823718ea08d: the mutation removing "the guarded branch" survived. The unit proofs are a defect of the candidate\'s tests, as a failing proof is; the loop requests the rework decision and the next head is proven afresh' },
];

test('unit:gy889-attention-lines-classified — every GY-889 instance line has a catalogue kind with a real class', () => {
  for (const line of gy889Lines) {
    const kind = attentionKind(line);
    assert.notEqual(kind, 'unclassified', `${line.subject}: ${line.text}`);
    assert.notEqual(faultClassOf(kind), 'unclassified', `${line.subject}: ${kind}`);
  }
  assert.deepEqual(gy889Lines.map(line => attentionKind(line)), ['retry-stopped', ...Array(5).fill('nonexercising-proof')]);
  assert.deepEqual(classifyAttention(gy889Lines).map(entry => entry.faultClass), ['loop', ...Array(5).fill('proof')]);
});

test('unit:nonexercising-proof-kind — the non-exercising-proof rework line is a proof fault', () => {
  const finding = 'unit:widget-renders was recorded as not exercising AC-1 on 0123456789ab: the mutation removing "the widget" survived';
  const producer = { requestId: 'request-1', sinceMs: 3 * hour, group: 'unit', session: { state: 'completed', attempt: 1, resolution: `evidence does not exercise its criterion: ${finding}`, verdict: null }, unexercised: [finding] };
  const [line, ...rest] = unansweredRequestAttention([{ key: 'GY-42', dispatch: { review: null, producers: [producer] } }]);
  assert.equal(rest.length, 0);
  assert.match(line.text, /^GY-42 is awaiting rework for a non-exercising proof: /);
  assert.equal(line.kind, 'nonexercising-proof');
  assert.equal(faultClassOf(line.kind!), 'proof');
  const [classifiedLine] = classifyAttention([line]);
  assert.deepEqual([classifiedLine.kind, classifiedLine.faultClass], ['nonexercising-proof', 'proof']);
  // The same line without its kind, as a recorded instance carries it, is recognised by its wording.
  assert.equal(attentionKind({ subject: line.subject, text: line.text }), 'nonexercising-proof');
  // A producer request that settled with no finding stays the unanswered request it was.
  const { unexercised: _finding, ...plain } = producer;
  assert.equal(attentionKind(unansweredRequestAttention([{ key: 'GY-42', dispatch: { review: null, producers: [plain] } }])[0]), 'unanswered-request');
});

test('unit:retry-stop-kind — the stopped-retry line is a loop fault', () => {
  const error = 'Graphyard refused the follow-ups for GY-808 (409): Idempotency key reused with different input';
  const direct = retryStopAttention({ step: 'follow-up filing for approval 77 (PR #64)', item: 'GY-64', error, count: 10, at: iso(0) });
  const record = { key: 'GY-64', pr: 64, followUps: { reviewId: 77, stoppedAt: iso(0), clientError: { error, count: 10 } } } as unknown as ReviewRecord;
  const [stopped, ...rest] = stoppedFollowUpAttention([record]);
  assert.equal(rest.length, 0);
  for (const line of [direct, stopped]) {
    assert.match(line.text, /^The loop stopped retrying follow-up filing for approval 77 \(PR #64\) for GY-64: 10 consecutive attempts/);
    assert.equal(line.kind, 'retry-stopped');
    assert.equal(faultClassOf(line.kind!), 'loop');
    assert.deepEqual(classifyAttention([line]).map(entry => [entry.kind, entry.faultClass]), [['retry-stopped', 'loop']]);
    assert.equal(attentionKind({ subject: line.subject, text: line.text }), 'retry-stopped', 'recognised by its wording without the kind');
  }
});
