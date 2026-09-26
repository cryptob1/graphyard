import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal, Work } from '../src/model.js';
import { decisionCapabilities, decisionInputs, decisionPrecondition } from '../src/model/approval.js';
import { faultClassItem, recurringClasses as classes, type FaultInstance, type FaultClassPolicy } from '../src/model/fault-classes.js';
import { registryRoles, roleSchema, fleetRoles } from '../src/model/registry.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { standingFaultClassItem, clearDiagnoses, diagnosesSettled, diagnosisStep, diagnosisSubjects, emptyDaemonState, runCycle, type DaemonEffects, type DiagnosticianEffects, type DiagnosisContext, type DiagnosisSubject } from '../src/master-daemon.js';
import type { Cycle } from '../src/daemon/cycle.js';
import { diagnosisPayloadSchema, diagnosticianSettings, type DiagnosisPayload } from '../src/runner/payloads.js';
import type { RunOptions, RunResult, Runner } from '../src/runner/types.js';
import { graphyardTools as piTools, schemaErrors, diagnoseParameters } from '../integrations/pi/index.js';

// GY-439: every stall the master diagnosed by hand — reading the journal, the server log, GitHub and
// the code, then filing the fix — is the diagnostician's now. A recurring-fault item gets a headless
// diagnosis within the cycle it is filed; the diagnosis closes it as a duplicate of the open item that
// already covers the cause, or files and releases a root-cause fix item, each through the two-party
// decision; and a recurrence before that fix is delivered links to the recurring item rather than
// filing afresh. Each test is named for the proof it produces.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
/** The recurrence rule as the loop runs it: the closed recurring item stands until its answer is delivered. */
const recurringClasses = (instances: readonly FaultInstance[], work: readonly Work[], rule: FaultClassPolicy, now: number) => classes(instances, work, rule, now, standingFaultClassItem);
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const hour = 3_600_000, minute = 60_000;
const policy = { threshold: 3, windowHours: 24 };
const settings = diagnosticianSettings({ diagnostician: { invariantBoundMinutes: 30 } });

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [] });
}
function item(key: string, overrides: Partial<Work> = {}): Work {
  return {
    id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/x.ts'], stage: 'backlog', revision: 1, policyRevision: 1,
    createdAt: iso(-hour), updatedAt: iso(0), stageEnteredAt: iso(-hour), ready: false, epoch: 0, lease: null, workspaces: [],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [], ...overrides,
  } as unknown as Work;
}
const blocked = (key: string, text = `${key} waits on the merge of PR #77, which never lands`) => item(key, { blocker: text });

/** A runner that answers with `respond`'s payload through the options' own validation, or ends without one on null. */
function fakeRunner(name: string, respond: (prompt: string) => unknown, seen: { runner: string; prompt: string; options: RunOptions<unknown> }[]): Runner {
  return {
    name,
    start<T>(prompt: string, options: RunOptions<T>) {
      seen.push({ runner: name, prompt, options: options as RunOptions<unknown> });
      const payload = respond(prompt);
      let result: RunResult<T>;
      if (payload === null) result = { ok: false, failure: { reason: 'no-payload', detail: 'the run ended without a graphyard_diagnose call' }, payloads: [] };
      else {
        try { const parsed = options.validate(payload); result = { ok: true, tool: options.tool, payload: parsed, payloads: [parsed] }; }
        catch (error) { result = { ok: false, failure: { reason: 'invalid-payload', detail: String(error) }, payloads: [] }; }
      }
      return { id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {}, result: async () => result };
    },
  };
}
const diagnosis = (subject: string, answer: Partial<DiagnosisPayload>): unknown => ({
  subject, cause: 'The merge queue never re-reads a CLEAN pull request after its base moves, so the gate waits on an observation nobody refreshes',
  evidence: { logLines: ['2030-01-01T11:40:00Z merge GY-1 waiting: observation older than two minutes'], commands: ['gh pr view 77 --json mergeStateStatus: CLEAN'] },
  faultClass: 'stalled-gate', ...answer,
});
const fix = { title: 'Refresh the observation of a CLEAN candidate after its base moves', description: 'The merge gate waits on a stale observation.', type: 'bug' as const, priority: 1,
  criteria: [{ id: 'AC-1', text: 'A CLEAN candidate whose base moved is observed again within one cycle, by a test', proofs: ['unit:clean-candidate-refreshed'] }],
  plannedFiles: ['src/merge-queue.ts', 'tests/clean-refresh.test.ts'] };

interface Harness {
  diagnostician: DiagnosticianEffects; seen: { runner: string; prompt: string; options: RunOptions<unknown> }[]; contexts: { subject: DiagnosisSubject; pullRequests: number[] }[];
  filed: { input: any; key: string }[]; requested: { work: string; action: string; reason: string; input: Record<string, unknown>; id: string }[];
  approvers: { work: string; decision: string }[]; outcomes: Map<string, { state: string; approvedBy?: string; refusal?: { approver: string; reason: string } }>;
}
function harness(primary: (prompt: string) => unknown, fallback: (prompt: string) => unknown = primary, context: DiagnosisContext = {
  journal: ['2030-01-01T11:40:00Z graphyard-master: merge GY-1 waiting: observation older than two minutes'],
  serverLog: ['2030-01-01T11:41:00Z POST /api/work/GY-1/observe 409 stale candidate'],
  pullRequests: [{ number: 77, state: { number: 77, mergeStateStatus: 'CLEAN', state: 'OPEN' } }],
}): Harness {
  const h: Harness = { seen: [], contexts: [], filed: [], requested: [], approvers: [], outcomes: new Map(), diagnostician: undefined as unknown as DiagnosticianEffects };
  h.diagnostician = {
    settings, cwd: '/checkout/project',
    runner: async attempt => attempt === 'primary' ? { runner: fakeRunner('pi', primary, h.seen), runtime: 'pi', model: settings.model } : { runner: fakeRunner('pi-fallback', fallback, h.seen), runtime: 'pi', model: settings.fallbackModel },
    context: async (subject, pullRequests) => { h.contexts.push({ subject, pullRequests }); return context; },
    file: async (input, key) => { h.filed.push({ input, key }); return item(`GY-${200 + h.filed.length}`, { title: input.title, priority: input.priority, criteria: input.criteria, plannedFiles: input.plannedFiles } as unknown as Partial<Work>); },
    decide: async (work, action, reason, input) => { const id = randomUUID(); h.requested.push({ work: work.key, action, reason, input, id }); h.outcomes.set(id, { state: 'requested' }); return { id }; },
  };
  return h;
}
function effects(h: Harness, work: () => Work[], now: () => number): DaemonEffects {
  return {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: work().map(entry => ({ ...entry })), now: new Date(now()).toISOString() }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    faultClassPolicy: policy, persist: async () => {},
    fileFaultClass: async (input: any) => item('GY-101', { title: input.title, origin: input.origin, description: input.description, type: 'bug', priority: input.priority } as Partial<Work>),
    diagnostician: h.diagnostician,
    approver: async (target: Work, decision: string) => { h.approvers.push({ work: target.key, decision }); return { agentName: `approver-${decision.slice(0, 8)}`, pane: null }; },
    decisions: async (target: Work) => ({ decisions: h.requested.filter(entry => entry.work === target.key).map(entry => {
      const outcome = h.outcomes.get(entry.id)!;
      return { id: entry.id, action: entry.action, state: outcome.state, input: entry.input, approvedBy: outcome.approvedBy ?? null, refusal: outcome.refusal ?? null };
    }) }),
  } as unknown as DaemonEffects;
}
/** One diagnosis step over a snapshot, as the cycle runs it after filing recurring classes. */
async function step(state: ReturnType<typeof emptyDaemonState>, fx: DaemonEffects, work: Work[], at: number) {
  const cycle = { config: config(), state, effects: fx, now: () => at, snapshot: { work, now: new Date(at).toISOString() }, clock: at, performed: [], isolate: async (_kind: string, _item: unknown, _name: string, body: () => Promise<unknown>) => body() } as unknown as Cycle;
  await diagnosisStep(cycle);
  await diagnosesSettled();
  return cycle.performed;
}
/** A recurring-fault item as the loop files it, with its three instances recorded and linked. */
function recurring(state: ReturnType<typeof emptyDaemonState>) {
  const instances: FaultInstance[] = ['GY-1', 'GY-2', 'GY-3'].map((subject, index) => ({ id: `blocker|${subject}|${iso(-index * minute)}`, kind: 'blocker', faultClass: 'stalled-gate',
    subject, text: `${subject} waits on the merge of PR #77`, at: iso(-index * minute), lastSeenAt: iso(0), linkedTo: 'GY-101' }));
  state.faults.instances.push(...instances);
  const input = faultClassItem({ faultClass: 'stalled-gate', recent: instances }, policy, clock);
  return item('GY-101', { title: input.title, description: input.description, origin: input.origin, type: 'bug', priority: 1 } as Partial<Work>);
}
afterEach(() => clearDiagnoses());

test('unit:diagnostician-launched — a recurring-fault item is diagnosed within the cycle that files it, with its instances, excerpts and pull requests', async () => {
  const h = harness(prompt => diagnosis(/subject "([^"]+)"/.exec(prompt)![1], { covering: 'GY-50' }));
  const backlog = [blocked('GY-1'), blocked('GY-2'), blocked('GY-3', 'GY-3 waits on the merge of its candidate'), item('GY-50', { title: 'Refresh stale merge observations', stage: 'build' } as Partial<Work>)];
  backlog[2] = { ...backlog[2], candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 88, branch: 'graphyard/gy-3-1', author: 'w' } } as Work;
  let now = clock;
  const state = emptyDaemonState(config());
  const fx = effects(h, () => backlog, () => now);
  const cycle = await runCycle(config(), state, fx, () => now);
  await diagnosesSettled();

  // Launched in the very cycle the recurring item was filed: one primary run, headless, with the diagnose tool only.
  assert.equal(h.seen.length, 1, 'one diagnostician run for the filed item');
  const [run] = h.seen;
  assert.equal(run.options.tool, 'graphyard_diagnose');
  assert.deepEqual(run.options.env, { GRAPHYARD_PI_ROLE: 'diagnostician' });
  assert.equal(run.options.cwd, '/checkout/project', 'it reads the repository checkout');
  assert.equal(run.options.timeoutMs, settings.timeoutMinutes * minute);
  assert.ok(cycle.actions.some(action => action.kind === 'diagnosis' && action.work === 'GY-101' && /Launched the diagnostician/.test(action.detail)), JSON.stringify(cycle.actions));

  // The payload: the item, its instances, the journal and server-log excerpts, and the named pull requests' state.
  assert.equal(h.contexts.length, 1);
  assert.equal(h.contexts[0].subject.id, 'GY-101');
  assert.deepEqual(h.contexts[0].pullRequests.sort(), [77, 88], 'the PR its instances name and the candidate of the item they are on');
  const given = JSON.parse(run.prompt.slice(run.prompt.indexOf('{')));
  assert.equal(given.item.key, 'GY-101');
  assert.match(given.item.title, /^Recurring stalled-gate faults: 3 in 24 hours/);
  assert.deepEqual(given.instances.map((entry: { subject: string }) => entry.subject).sort(), ['GY-1', 'GY-2', 'GY-3']);
  assert.ok(given.instances.some((entry: { text: string }) => /PR #77/.test(entry.text)));
  assert.deepEqual(given.journal, ['2030-01-01T11:40:00Z graphyard-master: merge GY-1 waiting: observation older than two minutes']);
  assert.deepEqual(given.serverLog, ['2030-01-01T11:41:00Z POST /api/work/GY-1/observe 409 stale candidate']);
  assert.equal(given.pullRequests[0].number, 77);
  assert.match(given.pullRequests[0].state, /CLEAN/);
  assert.ok(given.openItems.some((line: string) => line.startsWith('GY-50 ')), 'the open items it may name as covering');
  assert.match(run.prompt, /read-only/);

  // The next cycle records the structured diagnosis: cause, evidence, fault class and the covering item.
  now = clock + minute;
  await runCycle(config(), state, fx, () => now);
  const recorded = state.diagnoses['GY-101'];
  assert.equal(recorded.kind, 'recurring');
  assert.match(recorded.diagnosis!.cause, /never re-reads a CLEAN pull request/);
  assert.deepEqual(recorded.diagnosis!.evidence.commands, ['gh pr view 77 --json mergeStateStatus: CLEAN']);
  assert.equal(recorded.diagnosis!.faultClass, 'stalled-gate');
  assert.equal(recorded.diagnosis!.covering, 'GY-50');
  assert.deepEqual(recorded.runs.map(entry => [entry.model, entry.result]), [[settings.model, 'diagnosed']]);
  assert.equal(h.seen.length, 1, 'one diagnosis per item: it is not launched again');
});

test('unit:diagnostician-launched — a run with no valid diagnosis falls back once to the stronger model', async () => {
  const h = harness(() => null, prompt => diagnosis(/subject "([^"]+)"/.exec(prompt)![1], { covering: 'GY-50' }));
  const state = emptyDaemonState(config()), work = [recurring(state), item('GY-50', { stage: 'build' } as Partial<Work>)];
  await step(state, effects(h, () => work, () => clock), work, clock);
  await step(state, effects(h, () => work, () => clock), work, clock + minute);
  assert.deepEqual(h.seen.map(entry => entry.runner), ['pi', 'pi-fallback']);
  assert.deepEqual(state.diagnoses['GY-101'].runs.map(entry => [entry.model, entry.result]), [[settings.model, 'no-payload'], [settings.fallbackModel, 'diagnosed']]);
  assert.equal(state.diagnoses['GY-101'].diagnosis?.covering, 'GY-50');

  // Both failing records the failure, and nothing is closed or filed.
  clearDiagnoses();
  const none = harness(() => ({ subject: 'GY-101', cause: 'no evidence' }), () => null);
  const other = emptyDaemonState(config()), items = [recurring(other)];
  await step(other, effects(none, () => items, () => clock), items, clock);
  await step(other, effects(none, () => items, () => clock), items, clock + minute);
  assert.equal(other.diagnoses['GY-101'].state, 'failed');
  assert.deepEqual(other.diagnoses['GY-101'].runs.map(entry => entry.result), ['invalid-payload', 'no-payload']);
  assert.equal(none.requested.length + none.filed.length, 0);
});

test('unit:diagnostician-launched — an invariant violation is diagnosed once it persists past its bound', async () => {
  const h = harness(prompt => diagnosis(/subject "([^"]+)"/.exec(prompt)![1], { covering: 'GY-50' }));
  const state = emptyDaemonState(config()), work = [item('GY-50', { stage: 'build' } as Partial<Work>)];
  const violation: FaultInstance = { id: `invariant:one-follow-up|GY-9|${iso(0)}`, kind: 'invariant:one-follow-up', faultClass: 'unclassified', subject: 'GY-9', text: 'GY-9 has 2 open follow-up items', at: iso(0), lastSeenAt: iso(0), linkedTo: null };
  state.faults.instances.push(violation); state.faults.open[`${violation.kind}|GY-9|x`] = violation.id;
  assert.deepEqual(diagnosisSubjects(state, work, clock + 29 * minute, settings), [], 'within its bound it is not diagnosed');
  assert.deepEqual(diagnosisSubjects(state, work, clock + 31 * minute, settings).map(subject => [subject.kind, subject.id]), [['invariant', violation.id]]);
  await step(state, effects(h, () => work, () => clock), work, clock + 31 * minute);
  await step(state, effects(h, () => work, () => clock), work, clock + 32 * minute);
  assert.equal(h.seen.length, 1);
  assert.equal(state.diagnoses[violation.id].state, 'answered');
  assert.equal(violation.linkedTo, 'GY-50', 'the violation is linked to the item that covers it');
  assert.equal(h.requested.length, 0, 'nothing to close for a violation');
});

test('unit:diagnosis-files-fix — a fix diagnosis files the item, releases it at the diagnosed priority and closes the recurring item, each only once an independent approver approves', async () => {
  const h = harness(() => diagnosis('GY-101', { fix }));
  const state = emptyDaemonState(config());
  let work = [recurring(state)];
  const fx = effects(h, () => work, () => clock);
  await step(state, fx, work, clock);
  await step(state, fx, work, clock + minute);

  // Filed with the diagnosis's criteria and planned files, at its priority, unreleased; its release requested and put to an approver.
  assert.equal(h.filed.length, 1);
  const [{ input, key }] = h.filed;
  assert.equal(input.title, fix.title);
  assert.equal(input.priority, 1);
  assert.deepEqual(input.criteria.map((criterion: { proofs: string[] }) => criterion.proofs), [['unit:clean-candidate-refreshed']]);
  assert.deepEqual(input.plannedFiles, fix.plannedFiles);
  assert.match(input.description, /Cause: The merge queue never re-reads/);
  assert.match(input.description, /log: 2030-01-01T11:40:00Z merge GY-1 waiting/);
  assert.match(key, /^diagnosis:[0-9a-f]{24}:fix$/, 'a retried filing returns the same item');
  const fixKey = 'GY-201';
  assert.deepEqual(h.requested.map(entry => [entry.work, entry.action]), [[fixKey, 'release']]);
  assert.deepEqual(h.approvers, [{ work: fixKey, decision: h.requested[0].id }], 'the independent approver is launched for it');
  assert.equal(state.diagnoses['GY-101'].state, 'releasing');

  // The approver gate: while the release is not applied, nothing further happens.
  work = [...work, item(fixKey, { priority: 1 } as Partial<Work>)];
  await step(state, fx, work, clock + 2 * minute);
  h.outcomes.set(h.requested[0].id, { state: 'approved', approvedBy: 'approver-agent' });
  await step(state, fx, work, clock + 3 * minute);
  assert.equal(h.requested.length, 1, 'no closure is requested before the release is applied');

  // Applied: the recurring item's closure, as a duplicate of the fix item, is requested and put to an approver.
  h.outcomes.set(h.requested[0].id, { state: 'applied', approvedBy: 'approver-agent' });
  await step(state, fx, work, clock + 4 * minute);
  assert.deepEqual(h.requested.map(entry => [entry.work, entry.action]), [[fixKey, 'release'], ['GY-101', 'close']]);
  assert.deepEqual(h.requested[1].input, { kind: 'duplicate', ref: fixKey }, 'the recurring item records the fix item that answers it');
  assert.equal(h.approvers.at(-1)!.decision, h.requested[1].id);
  await step(state, fx, work, clock + 5 * minute);
  assert.equal(state.diagnoses['GY-101'].state, 'closing', 'still waiting on the approver');
  h.outcomes.set(h.requested[1].id, { state: 'applied', approvedBy: 'approver-agent' });
  await step(state, fx, work, clock + 6 * minute);
  assert.equal(state.diagnoses['GY-101'].state, 'answered');
  assert.equal(state.diagnoses['GY-101'].answeredBy, fixKey);
});

test('unit:diagnosis-files-fix — a covering item closes the recurring item as its duplicate; a refused decision, or a fix master create would refuse, changes nothing', async () => {
  // The duplicate path: nothing is filed; the closure names the covering item and waits on the approver.
  const h = harness(() => diagnosis('GY-101', { covering: 'GY-50' }));
  const state = emptyDaemonState(config()), work = [recurring(state), item('GY-50', { stage: 'build' } as Partial<Work>)];
  const fx = effects(h, () => work, () => clock);
  await step(state, fx, work, clock);
  await step(state, fx, work, clock + minute);
  assert.equal(h.filed.length, 0);
  assert.deepEqual(h.requested.map(entry => [entry.work, entry.action, entry.input]), [['GY-101', 'close', { kind: 'duplicate', ref: 'GY-50' }]]);
  assert.equal(h.approvers.length, 1);
  // The approver refuses: the diagnosis stands refused and nothing more is requested.
  h.outcomes.set(h.requested[0].id, { state: 'refused', refusal: { approver: 'approver-agent', reason: 'GY-50 fixes a different stall' } });
  await step(state, fx, work, clock + 2 * minute);
  await step(state, fx, work, clock + 3 * minute);
  assert.equal(state.diagnoses['GY-101'].state, 'refused');
  assert.match(state.diagnoses['GY-101'].detail, /GY-50 fixes a different stall/);
  assert.equal(h.requested.length, 1);

  // A fix master create would refuse — a root-level directory scope — files nothing.
  clearDiagnoses();
  const broad = harness(() => diagnosis('GY-101', { fix: { ...fix, plannedFiles: ['src/'] } }));
  const other = emptyDaemonState(config()), items = [recurring(other)];
  await step(other, effects(broad, () => items, () => clock), items, clock);
  await step(other, effects(broad, () => items, () => clock), items, clock + minute);
  assert.equal(other.diagnoses['GY-101'].state, 'failed');
  assert.match(other.diagnoses['GY-101'].detail, /master create refused a high-conflict scope/);
  assert.equal(broad.filed.length + broad.requested.length, 0);
});

test('unit:diagnosis-files-fix — a recurrence before the fix is delivered links to the recurring item; one after it files afresh', () => {
  const state = emptyDaemonState(config());
  const answered = { ...recurring(state), stage: 'done', closure: { kind: 'duplicate', ref: 'GY-201', reason: 'answered', by: 'master', at: iso(0), from: 'backlog' } } as unknown as Work;
  const later = ['GY-4', 'GY-5', 'GY-6'].map((subject, index): FaultInstance => ({ id: `blocker|${subject}|${iso(hour + index)}`, kind: 'blocker', faultClass: 'stalled-gate', subject, text: 'x', at: iso(hour + index), lastSeenAt: iso(hour + index), linkedTo: null }));
  const fixOpen = item('GY-201', { stage: 'build' } as Partial<Work>);
  assert.equal(standingFaultClassItem([answered, fixOpen], 'stalled-gate')?.key, 'GY-101');
  const before = recurringClasses(later, [answered, fixOpen], policy, clock + 2 * hour).find(entry => entry.faultClass === 'stalled-gate')!;
  assert.equal(before.file, false, 'the fix is not delivered: nothing is filed');
  assert.equal(before.item?.key, 'GY-101', 'the recurrence links to the recurring item');
  const delivered = { ...fixOpen, stage: 'done' } as Work;
  const afterDelivery = recurringClasses(later, [answered, delivered], policy, clock + 2 * hour).find(entry => entry.faultClass === 'stalled-gate')!;
  assert.equal(afterDelivery.item, null);
  assert.equal(afterDelivery.file, true, 'the fix is delivered and the class recurred: a new item is filed');
  // A fix that was itself closed undelivered leaves the recurring item standing.
  const abandoned = { ...fixOpen, stage: 'done', closure: { kind: 'obsolete', ref: null } } as unknown as Work;
  assert.equal(recurringClasses(later, [answered, abandoned], policy, clock + 2 * hour).find(entry => entry.faultClass === 'stalled-gate')!.file, false);
});

test('unit:diagnostician-launched — the role is a registry role and the Pi extension offers the diagnostician only its tool', () => {
  assert.ok((registryRoles as readonly string[]).includes('diagnostician'));
  assert.ok(!(fleetRoles as readonly string[]).includes('diagnostician'), 'never proposed or reported missing: it runs on Pi until configured');
  assert.doesNotThrow(() => roleSchema.parse({ name: 'diagnostician', accounts: ['pi-a'], concurrency: 1 }));
  assert.deepEqual(settings.model, 'zai/glm-5.3-flash');
  assert.notEqual(settings.fallbackModel, settings.model, 'the fallback is a stronger model');
  const tools = piTools('diagnostician');
  assert.deepEqual(tools.map(tool => tool.name), ['graphyard_diagnose']);
  const payload = diagnosis('GY-101', { fix });
  assert.deepEqual(schemaErrors(diagnoseParameters, payload), []);
  assert.doesNotThrow(() => diagnosisPayloadSchema.parse(payload));
  assert.throws(() => diagnosisPayloadSchema.parse(diagnosis('GY-101', { fix, covering: 'GY-50' })), /exactly one answer/);
  assert.throws(() => diagnosisPayloadSchema.parse({ ...(diagnosis('GY-101', { covering: 'GY-50' }) as object), evidence: { logLines: [], commands: [] } }), /log lines or commands/);
  assert.ok(!piTools('approver').some(tool => tool.name === 'graphyard_diagnose'));
});

// ---- The close decision against the real engine: requested by the master, applied only on an independent approval ----
const repository = 'owner/diagnostician';
const operator: Principal = { id: 'diagnosis-operator', role: 'admin', sessionKind: 'human' };
const credentials = [{ ...operator, token: `diagnosis-operator-${'x'.repeat(32)}` }];
const master = { id: 'diagnosis-master', token: `diagnosis-master-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'decision:approve'] };
const approver = { id: 'diagnosis-approver', token: `diagnosis-approver-${'a'.repeat(32)}`, capabilities: ['decision:approve'] };
let database: EmbeddedPostgres, store: Store, http: ReturnType<typeof server>, url: string;
const call = async (credential: string, path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (credential: string, path: string, body?: unknown) => { const result = await call(credential, path, body); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 439;
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-diagnostician-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('diagnostician_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/diagnostician_test`); await store.init();
  const engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const agent of [master, approver])
    await ok(credentials[0].token, 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Onboarding provisions agent identities' });
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('unit:diagnosis-files-fix — release and closure are two-party decisions the engine applies only on an independent approval', async () => {
  assert.equal(decisionCapabilities.close, 'intent:create', 'the capability master close demands');
  const instances: FaultInstance[] = ['GY-1', 'GY-2', 'GY-3'].map(subject => ({ id: `blocker|${subject}|${iso(0)}`, kind: 'blocker', faultClass: 'stalled-gate', subject, text: `${subject} stalls`, at: iso(0), lastSeenAt: iso(0), linkedTo: null }));
  const recurringItem = await ok(master.token, 'work', faultClassItem({ faultClass: 'stalled-gate', recent: instances }, policy, clock)) as Work;
  const fixItem = await ok(master.token, 'work', { ...fix, reason: 'The diagnostician found the root cause' }) as Work;
  assert.equal(fixItem.priority, 1);
  assert.equal(fixItem.ready, false, 'filed unreleased');

  // Release: requested by the master, refused to the master itself, applied on the approver's approval.
  const release = await ok(master.token, `work/${fixItem.key}/decide`, { action: 'release', input: { expectedRevision: fixItem.revision }, reason: 'Release the diagnosed fix' });
  assert.equal((await call(master.token, `work/${fixItem.key}/approve`, { decision: release.id, reason: 'self' })).status, 403, 'the requester may not approve');
  assert.equal((await store.list()).find(entry => entry.id === fixItem.id)!.ready, false, 'nothing applied without the independent approval');
  await ok(approver.token, `work/${fixItem.key}/approve`, { decision: release.id, reason: 'The diagnosis is sound' });
  assert.equal((await store.list()).find(entry => entry.id === fixItem.id)!.ready, true);

  // Closure: the recurring item closed as a duplicate of the fix, on the same two-party rule.
  assert.doesNotThrow(() => decisionInputs.close.parse({ kind: 'duplicate', ref: fixItem.key, expectedRevision: recurringItem.revision }));
  assert.match(decisionPrecondition('close', { kind: 'duplicate', ref: fixItem.key, expectedRevision: recurringItem.revision + 1 }, recurringItem) ?? '', /Task revision changed/);
  const close = await ok(master.token, `work/${recurringItem.key}/decide`, { action: 'close', input: { kind: 'duplicate', ref: fixItem.key, expectedRevision: recurringItem.revision }, reason: `Answered by ${fixItem.key}` });
  assert.equal((await call(master.token, `work/${recurringItem.key}/approve`, { decision: close.id, reason: 'self' })).status, 403);
  assert.equal((await store.list()).find(entry => entry.id === recurringItem.id)!.stage, 'backlog');
  const applied = await ok(approver.token, `work/${recurringItem.key}/approve`, { decision: close.id, reason: 'The fix answers it' });
  assert.equal(applied.state, 'applied', JSON.stringify(applied));
  const closed = (await store.list()).find(entry => entry.id === recurringItem.id)!;
  assert.equal(closed.stage, 'done');
  assert.deepEqual([closed.closure?.kind, closed.closure?.ref], ['duplicate', fixItem.key], 'the recurring item records the fix item answering it');
  assert.match(closed.closure!.reason, new RegExp(`approved by ${approver.id}`));

  // With the fix open the class stands on the closed recurring item; delivered, it files afresh.
  const all = await store.list();
  assert.equal(standingFaultClassItem(all, 'stalled-gate')?.key, recurringItem.key);
  const later = instances.map(entry => ({ ...entry, id: `${entry.id}#later`, at: iso(hour), linkedTo: null }));
  assert.equal(recurringClasses(later, all, policy, clock + 2 * hour).find(entry => entry.faultClass === 'stalled-gate')!.file, false);
  const delivered = all.map(entry => entry.id === fixItem.id ? { ...entry, stage: 'done' } as Work : entry);
  assert.equal(recurringClasses(later, delivered, policy, clock + 2 * hour).find(entry => entry.faultClass === 'stalled-gate')!.file, true);
});
