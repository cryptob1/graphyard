import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { classifyAttention, faultCatalogue, faultClasses, faultClassOf, faultClassItem, faultKinds, groupFaults, isFaultKind, escalationFaultKind, noteFault, recurringClasses, trackFaults, workFaults, type FaultClass, type FaultInstance } from '../src/model/fault-classes.js';
import { workOriginSchema } from '../src/model/interventions.js';
import { escalationTriggers, type Work } from '../src/model.js';
import { controlPlaneAttention, installationSources, masterConfigSchema, workAttentionCauses, type MasterConfig } from '../src/master.js';
import { cycleFailureAttentionAfter, cycleFaults, daemonActionFaultKind, daemonActionKinds, daemonEffects, daemonSummary, emptyDaemonState, fileRecurringFaultClasses, loopAttention, loopLiveness, noteCycleFailure, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { faulted } from '../src/master-status.js';
import { predictQueue } from '../src/merge-queue.js';
import { NOW, boardApi, boardStatus, boardWork } from '../browser-tests/ui-board.js';
import OverviewPage from '../web/pages/overview.js';
import type { Dashboard } from '../web/pages/dashboard.js';

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
      'github-budget', 'intervention-pattern', 'throughput', 'executor', 'setup', 'installation', 'sudo', 'unrunnable-remedy', 'role-capacity', 'concurrency-starved', 'fleet']],
    ['work item record', ['containment', 'human-request', 'scope-request', 'proof-gap', 'role-capacity', 'scope-violation', 'blocker', 'sandbox-blocker']],
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
    { subject: 'somewhere', text: 'A line nobody catalogued' },
  ]);
  assert.deepEqual(worded.map(entry => entry.faultClass), ['scope', 'review-convergence', 'observation', 'stalled-gate', 'unclassified']);
  // Escalations on an item, one class per trigger.
  const escalated = item('GY-7', { escalations: escalationTriggers.map(trigger => ({ trigger, reason: `${trigger} raised`, actor: 'graphyard', at: iso(0) })) } as Partial<Work>);
  assert.deepEqual(workFaults(escalated, clock).map(entry => entry.faultClass), ['session-liveness', 'proof', 'review-convergence', 'scope']);
  // A failed loop action is a pipeline fault with its class, on the action and in the cycle's faults.
  state.actions['dispatch:work-8:0'] = { kind: 'dispatch', work: 'GY-8', principal: 'worker', state: 'failed', detail: 'Herdr refused the launch', attempts: 1, epoch: 0, cycle: 0, at: iso(0) };
  assert.deepEqual(cycleFaults(state, [], clock).map(entry => [entry.subject, entry.kind, entry.faultClass]), [['GY-8', 'action:dispatch', 'session-liveness']]);
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
  open[0].scopeRequest = { epoch: 1, paths: ['docs/x.md'], reason: 'docs', requestedBy: 'graphyard-claude-1', at: new Date(NOW).toISOString() } as Work['scopeRequest'];
  open[1].scopeRequest = { epoch: 1, paths: ['docs/y.md'], reason: 'docs', requestedBy: 'graphyard-claude-2', at: new Date(NOW).toISOString() } as Work['scopeRequest'];
  const expected = groupFaults(open.flatMap(entry => workFaults(entry, NOW)));
  const noop = () => {};
  const render = (work: Work[]) => renderToStaticMarkup(createElement(OverviewPage, {
    token: 'fixture', work, status: boardStatus('admin'), error: '', connected: true, lastUpdated: '12:00:00', view: 'work', setView: noop, filter: null, setFilter: noop,
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
  const scope = (key: string) => item(key, { scopeRequest: { epoch: 1, paths: ['docs/x.md'], reason: 'docs', requestedBy: 'w', at: iso(0) } } as Partial<Work>);
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
  const root = await mkdtemp(join(tmpdir(), 'graphyard-fault-root-')), secrets = await mkdtemp(join(tmpdir(), 'graphyard-fault-secrets-'));
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

test('unit:recurring-class-item — a fault that clears and returns is a new instance', () => {
  const record = { instances: [] as FaultInstance[], open: {} as Record<string, string> };
  const observation = { kind: 'scope-request' as const, faultClass: 'scope' as const, subject: 'GY-1', text: 'needs files' };
  assert.equal(trackFaults(record, [observation], iso(0)).length, 1);
  assert.equal(trackFaults(record, [observation], iso(60_000)).length, 0, 'still standing: the same instance');
  assert.equal(record.instances[0].lastSeenAt, iso(60_000));
  trackFaults(record, [], iso(120_000));
  assert.equal(trackFaults(record, [observation], iso(180_000)).length, 1, 'cleared and back: a second instance');
  noteFault(record, { kind: 'loop-failures', faultClass: 'loop', subject: 'loop', text: 'failed' }, iso(200_000));
  assert.deepEqual(record.instances.map(entry => entry.faultClass), ['scope', 'scope', 'loop']);
});
