import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Work } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { clearDoctorRuns, doctorRunsSettled, type DoctorEffects, type DoctorFile } from '../src/daemon/doctor.js';
import { clearDiagnoses, diagnosesSettled, type DiagnosticianEffects } from '../src/daemon/diagnosis.js';
import { doctorSettingsSchema } from '../src/master/doctor-settings.js';
import { diagnosticianSettings, type DiagnosisPayload } from '../src/runner/payloads.js';
import { faultClassItem, type FaultClass, type FaultInstance } from '../src/model/fault-classes.js';
import { RefusedResponse } from '../src/model/refusal.js';
import type { RunOptions, RunResult, Runner } from '../src/runner/types.js';

/**
 * GY-1530. The doctor's filings and the diagnosis step over a simulated day of the real loop: a cycle
 * a minute for twelve hours, the doctor every ten minutes, over the shapes GY-1516 recorded on
 * 2026-10-08. The doctor files one item the create route refuses at once (its proof cites an e2e
 * scenario nothing registers), one the plane's outage queues for retry and then refuses the same
 * way once the plane answers, and one the plane accepts; the diagnostician's runs on one
 * recurring-fault item are both stopped at their bound, and its fix item for another is refused by
 * the create route. Both repeat per cycle — the pending filing's retry, the diagnosis's advance — so
 * after every cycle and at the end: no refused filing is filed again, each refusal opens one
 * proof-class instance (never an unclassified one, never one noted against the outage's), the
 * stopped diagnosis is one session-liveness instance, nothing reaches an isolation record, every
 * escalation names what the master must mend, the diagnostician and approver sessions are bounded,
 * and every system invariant the loop checks holds.
 */
const minute = 60_000, hour = 60 * minute, start = Date.parse('2026-10-08T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const policy = { threshold: 3, windowHours: 24 };
const settings = diagnosticianSettings({ diagnostician: { invariantBoundMinutes: 30, timeoutMinutes: 20 } });
/** The scenarios the repository's e2e/cases register; a proof citing any other is refused by create for ever. */
const registered = new Set(['board', 'create-work-item', 'sign-in', 'tests-page', 'work-item-detail']);
const unregistered = { loop: 'self-upgrade-loaded-revision-clears', merge: 'merge-queue-drains-after-base-move', containment: 'lapsed-fence-settles' };
/** The plane's outage: the doctor's create and run posts meet a 502 between these minutes; the second doctor run (minute 10) lands inside it. */
const outage = { from: 8 * minute, to: 18 * minute };

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { intervalSeconds: 60 } });
}
function item(key: string, at: number, overrides: Partial<Work> = {}): Work {
  return {
    id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/x.ts'], stage: 'backlog', revision: 1, policyRevision: 1,
    createdAt: iso(at), updatedAt: iso(at), stageEnteredAt: iso(at), ready: false, epoch: 0, lease: null, workspaces: [],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [], ...overrides,
  } as unknown as Work;
}
/** A recurring-fault item as the loop filed it an hour before the day, with its three instances recorded and linked. */
function recurring(state: DaemonState, key: string, faultClass: FaultClass, kind: string, text: string): Work {
  const instances: FaultInstance[] = [1, 2, 3].map(n => ({ id: `${kind}|GY-${n}|${iso(start - hour - n * minute)}`, kind, faultClass, subject: `GY-${n}`, text: `${text} (GY-${n})`,
    at: iso(start - hour - n * minute), lastSeenAt: iso(start - hour), linkedTo: key }));
  state.faults.instances.push(...instances);
  const input = faultClassItem({ faultClass, recent: instances }, policy, start - hour);
  return item(key, start - hour, { title: input.title, description: input.description, origin: input.origin, priority: 1 } as Partial<Work>);
}
const filing = (faultClass: FaultClass, title: string, proofs: string[]): DoctorFile => ({ faultClass, priority: 1, title, description: 'The doctor\'s evidence: the bound passed on three items', plannedFiles: [`src/daemon/${faultClass}.ts`],
  criteria: [{ id: 'AC-1', text: `${title}, by a test`, proofs }] });
const filings = {
  refusedAtOnce: filing('merge', 'Merge queue never drains after the base moves', [`e2e:${unregistered.merge}`]),
  refusedOnRetry: filing('containment', 'Lapsed containment fences hold items claimable for hours', [`e2e:${unregistered.containment}`]),
  accepted: filing('stalled-gate', 'Review requests stand unanswered past their bound', ['unit:review-request-reissued']),
};
const fixTitle = 'Restart the loop onto the checkout revision once the dirty-checkout guard clears';
const stoppedAtBound = (): RunResult<never> => ({ ok: false, failure: { reason: 'timeout', detail: `no terminal event within ${settings.timeoutMinutes * 60}s; the run was stopped` }, payloads: [] });

test('unit:soak-invariants-hold — over a simulated day the doctor drops and classifies every filing create refuses, at once or after the plane\'s outage, the diagnosis step names its causes, nothing is re-filed or isolated, and every system invariant holds', { timeout: 300_000 }, async () => {
  clearDoctorRuns(); clearDiagnoses();
  let now = start;
  const state = emptyDaemonState(config());
  const stopped = recurring(state, 'GY-1430', 'decision', 'decision-unanswered', 'the release decision stood unanswered past its grace');
  const refusedFix = recurring(state, 'GY-1473', 'loop', 'loop-cost', 'the loaded-revision bound sat at zero headroom');
  const control = item('GY-50', start - 2 * hour, { title: 'Refresh stale merge observations', type: 'feature' });
  const work: Work[] = [control, stopped, refusedFix];
  const inOutage = () => now - start >= outage.from && now - start < outage.to;

  // The control plane's create route, as the operator-agent post sees it: a 502 while the plane is out, the
  // engine's own 409 for an e2e proof whose scenario nothing registered, else the item, once per idempotency key.
  const creates: { key: string; title: string; at: number; outcome: string; origin: string | null }[] = [];
  const created = new Map<string, Work>();
  let next = 100;
  const create = async (input: any, key: string): Promise<Work> => {
    const log = (outcome: string) => creates.push({ key, title: input.title, at: now, outcome, origin: input.origin?.faultClass?.class ?? null });
    if (inOutage()) { log('502'); throw new RefusedResponse('Graphyard refused work (502): Application failed to respond', 502, null); }
    const scenario = (input.criteria as { proofs: string[] }[]).flatMap(criterion => criterion.proofs).map(proof => /^e2e:(.+)$/.exec(proof)?.[1]).find(name => name && !registered.has(name));
    if (scenario) { log('409'); throw new RefusedResponse(`Graphyard refused work (409): Register E2E scenario ${scenario} before creating work that requires it`, 409, { error: `Register E2E scenario ${scenario} before creating work that requires it` }); }
    log('created');
    if (created.has(key)) return created.get(key)!;
    const filed = item(`GY-${next++}`, now, { title: input.title, description: input.description, priority: input.priority, criteria: input.criteria, plannedFiles: input.plannedFiles, type: input.type ?? 'bug', ...(input.origin ? { origin: input.origin } : {}) } as Partial<Work>);
    work.push(filed); created.set(key, filed);
    return filed;
  };

  // The doctor: a scripted Pi run every interval. Its first report asks two filings, its second (inside the outage) a third, the rest none.
  let doctorRuns = 0;
  const posts: { at: string; ok: boolean }[] = [];
  const doctor: DoctorEffects = {
    settings: { ...doctorSettingsSchema.parse({}), command: 'pi' }, cwd: '/soak/checkout', env: {},
    runner: async () => ({ runtime: 'pi', model: 'soak/doctor', release: async () => {}, runner: { name: 'pi', start: (_prompt: string, options: { tool: string }) => {
      const index = doctorRuns++;
      const payload = { findings: [{ subject: control.key, check: 'worker' as const, detail: 'the scripted finding: this item stood in its stage past the bound', unactionable: false }], actions: [],
        filed: index === 0 ? [filings.refusedAtOnce, filings.accepted] : index === 1 ? [filings.refusedOnRetry] : [] };
      return { id: `soak-doctor-${index}`, events: [], onEvent: () => () => {}, cancel: () => {}, result: async () => ({ ok: true as const, tool: options.tool, payload, payloads: [payload] }) };
    } } as unknown as Runner }),
    file: create,
    recordRun: async run => { posts.push({ at: run.at, ok: !inOutage() }); if (inOutage()) throw new RefusedResponse('Graphyard refused doctor (502): Application failed to respond', 502, null); },
  };

  // The diagnostician: both runs on the first recurring item are stopped at their bound; the second's diagnosis
  // names a fix whose proof cites an unregistered scenario; any other subject is covered by the control item.
  const launched: { subject: string; attempt: string; at: number }[] = [];
  const diagnosisRunner = (attempt: 'primary' | 'fallback'): Runner => ({
    name: 'soak-diagnostician',
    start<T>(prompt: string, options: RunOptions<T>) {
      const given = JSON.parse(prompt.slice(prompt.indexOf('{'))) as { subject: string; faultClass: FaultClass };
      launched.push({ subject: given.subject, attempt, at: now });
      let result: RunResult<T>;
      if (given.subject === stopped.key) result = stoppedAtBound();
      else {
        const payload: DiagnosisPayload = { subject: given.subject, cause: 'The loaded-revision bound sits at zero headroom for hours: the owed restart only retries while an executor holds a claim',
          evidence: { logLines: [`${iso(now)} graphyard-master: loaded revision ok/bound flipped`], commands: ['graphyard master status — the loaded-revision line stood all day'] }, faultClass: given.faultClass, covering: null, fix: null };
        if (given.subject === refusedFix.key) payload.fix = { title: fixTitle, description: 'The dirty-checkout guard stands for hours while HEAD moves under the running loop.', type: 'bug', priority: 1,
          criteria: [{ id: 'AC-1', text: 'The loop restarts onto the checkout revision once the guard clears, by a test', proofs: [`e2e:${unregistered.loop}`] }], plannedFiles: ['src/daemon/self-upgrade.ts'] };
        else payload.covering = control.key;
        try { const parsed = options.validate(payload); result = { ok: true, tool: options.tool, payload: parsed, payloads: [parsed] }; }
        catch (error) { result = { ok: false, failure: { reason: 'invalid-payload', detail: String(error) }, payloads: [] }; }
      }
      return { id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {}, result: async () => result };
    },
  });
  const ledger: { id: string; work: string; action: string; state: string; input: Record<string, any>; approvedBy: string | null; refusal: null; outcome: string | null }[] = [];
  const approvers: { work: string; decision: string; at: number }[] = [];
  const diagnostician: DiagnosticianEffects = {
    settings, cwd: '/soak/checkout',
    runner: async attempt => ({ runner: diagnosisRunner(attempt), runtime: 'pi', model: attempt === 'primary' ? settings.model : settings.fallbackModel }),
    context: async () => ({ journal: [`${iso(now)} graphyard-master: 1 integration job(s) held on a permission shortfall`], serverLog: [`${iso(now)} POST /api/status 200`], pullRequests: [] }),
    file: create,
    decide: async (target, action, _reason, input = {}) => { const id = `decision-${ledger.length + 1}`; ledger.push({ id, work: target.key, action, state: 'requested', input, approvedBy: null, refusal: null, outcome: null }); return { id }; },
  };
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: work.map(entry => structuredClone(entry)), now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, persist: async () => {},
    // Production serves the base all day: the deployment step has nothing to fault, so every instance the day opens is the doctor's or the diagnosis's.
    observeDeployment: async () => ({ source: 'endpoint', sha: 'd'.repeat(40), at: iso(now), reason: null, deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    faultClassPolicy: policy, fileFaultClass: create, doctor, diagnostician,
    // The independent approver judges a close at once: the recurring item is closed as the duplicate the diagnosis named.
    approver: async (target: Work, decision: string) => {
      approvers.push({ work: target.key, decision, at: now });
      const entry = ledger.find(row => row.id === decision)!, closed = work.find(candidate => candidate.key === target.key)!;
      assert.equal(entry.action, 'close', `only close decisions are put to an approver on this day, not ${entry.action}`);
      Object.assign(entry, { state: 'applied', approvedBy: 'graphyard-approver' });
      Object.assign(closed, { stage: 'done', closure: { kind: entry.input.kind, ref: entry.input.ref ?? null, reason: 'soak', by: 'graphyard-approver', at: iso(now), from: closed.stage }, revision: closed.revision + 1, updatedAt: iso(now) });
      return { agentName: `gy-approver-${decision}`, pane: null };
    },
    decisions: async (target: Work) => ({ decisions: ledger.filter(row => row.work === target.key).map(row => structuredClone(row)) }),
  } as unknown as DaemonEffects;

  const violations: string[] = [], failures: { at: number; kind: string; detail: string }[] = [];
  const isolated = () => Object.keys(state.actions).filter(key => key.startsWith('isolated:'));
  const instances = () => state.faults.instances.filter(entry => Date.parse(entry.at) >= start);
  for (let cycle = 0; now < start + 12 * hour; cycle++, now += minute) {
    const result = await runCycle(config(), state, effects, () => now);
    // The doctor run and the diagnostician runs settle beside the cycle; here they settle before the next one, as a minute's interval lets them.
    await doctorRunsSettled(); await diagnosesSettled();
    for (const action of result.actions) if (action.state === 'failed') failures.push({ at: now, kind: action.kind, detail: action.detail });
    for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle} (+${(now - start) / minute} min): ${check.invariant} — ${check.reading}`);
    // After every cycle: nothing reached an isolation record, no instance is unclassified, and at most the outage's one filing is pending.
    assert.deepEqual(isolated(), [], `cycle ${cycle}: a failure was thrown on to the step's isolation record`);
    assert.deepEqual(instances().filter(entry => entry.faultClass === 'unclassified'), [], `cycle ${cycle}: an unclassified instance opened`);
    assert.ok(state.doctor.pendingFiles.length <= 1, `cycle ${cycle}: ${state.doctor.pendingFiles.length} filings pending`);
    if (state.doctor.pendingFiles.length) assert.equal(state.doctor.pendingFiles[0].file.title, filings.refusedOnRetry.title, `cycle ${cycle}: only the filing the outage queued is ever pending`);
  }
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');

  // (a) Filings are bounded: the refused ones reach create once (the queued one once per backoff until the plane answers, then once), never again.
  const of = (title: string) => creates.filter(entry => entry.title === title);
  assert.deepEqual(of(filings.refusedAtOnce.title).map(entry => entry.outcome), ['409'], 'refused at once, never re-filed');
  const retried = of(filings.refusedOnRetry.title);
  assert.ok(retried.length >= 3 && retried.length <= 6, `the queued filing is retried on its backoff through the outage: ${retried.map(entry => `${(entry.at - start) / minute}m ${entry.outcome}`).join(', ')}`);
  assert.deepEqual([...new Set(retried.slice(0, -1).map(entry => entry.outcome))], ['502'], 'every attempt inside the outage met the plane not answering');
  assert.equal(retried.at(-1)!.outcome, '409', 'the first answer the plane gave refused the content');
  assert.ok(retried.at(-1)!.at - start >= outage.to, 'and that answer came once the plane was back');
  assert.deepEqual(of(filings.accepted.title).map(entry => entry.outcome), ['created'], 'the accepted filing was filed once');
  assert.deepEqual(of(fixTitle).map(entry => entry.outcome), ['409'], 'the diagnostician\'s refused fix reached create once, never again');
  assert.deepEqual(state.doctor.pendingFiles, [], 'nothing stays pending');
  const stable = new Map<string, Set<string>>();
  for (const entry of creates) stable.set(entry.title, new Set([...stable.get(entry.title) ?? [], entry.key]));
  for (const [title, keys] of stable) assert.equal(keys.size, 1, `${title}: filed under one stable key: ${[...keys].join(', ')}`);
  // Three proof instances reached the class threshold, so the loop filed one recurring item for the class, once; its diagnosis and the accepted filing's were each answered and closed.
  const recurrences = creates.filter(entry => entry.origin && entry.outcome === 'created');
  assert.deepEqual(recurrences.map(entry => entry.origin), ['stalled-gate', 'proof'], 'the doctor\'s accepted filing and one proof-class recurrence');
  for (const entry of recurrences) {
    const filed = created.get(entry.key)!;
    assert.equal(filed.stage, 'done', `${filed.key} (${entry.origin}) was closed as covered`);
    assert.equal(state.diagnoses[filed.key]?.state, 'answered', `${filed.key}: its diagnosis was answered`);
  }
  assert.equal(ledger.length, 2, `one close decision per diagnosed-and-covered item: ${JSON.stringify(ledger.map(row => [row.work, row.action, row.state]))}`);
  assert.ok(ledger.every(row => row.action === 'close' && row.state === 'applied'));
  assert.equal(approvers.length, 2, 'one approver session per close, none relaunched');

  // (b) Each refusal is one classified instance: the content refusals are the proof class's fix-item (the queued one its own, not noted
  // against the outage's run), the outage is the plane's, and the stopped diagnosis is session-liveness's overlong-session.
  const opened = instances().map(entry => [entry.kind, entry.faultClass, entry.subject] as const);
  assert.deepEqual(opened.filter(entry => entry[0] === 'fix-item').length, 3, `three content refusals: ${JSON.stringify(opened)}`);
  assert.deepEqual(opened.filter(entry => entry[0] === 'overlong-session').map(entry => entry[1]), ['session-liveness']);
  assert.deepEqual(opened.filter(entry => entry[0] === 'plane-unavailable').map(entry => entry[1]), ['deployment', 'deployment'], 'the queued filing\'s retries and the run post that met the outage: one run of failures each');
  assert.deepEqual(opened.filter(entry => !['fix-item', 'overlong-session', 'plane-unavailable'].includes(entry[0])), [], 'no other instance opened all day');
  assert.ok(instances().filter(entry => entry.faultClass === 'proof').every(entry => entry.linkedTo), 'the proof instances link to the recurrence the loop filed');
  const failedKeys = Object.entries(state.actions).filter(([, action]) => action.state === 'failed').map(([key, action]) => [key, action.detail] as const);
  assert.equal(failedKeys.length, 4, `the four designed failures and no other: ${JSON.stringify(failedKeys)}`);
  const detail = (pattern: RegExp) => { const match = failedKeys.find(([, text]) => pattern.test(text)); assert.ok(match, `a failed action matching ${pattern}: ${JSON.stringify(failedKeys)}`); return match![1]; };
  assert.match(detail(/^Could not file "Merge queue never drains/), /, and it is not filed again: master create refused the filing itself for the e2e proof it cites, whose scenario merge-queue-drains-after-base-move has no registered revision: Graphyard refused work \(409\)/);
  assert.match(detail(/^Could not file "Lapsed containment fences/), /, and it is not filed again: master create refused the filing itself for the e2e proof it cites, whose scenario lapsed-fence-settles has no registered revision/);
  assert.equal(detail(/returned no diagnosis of GY-1430/), `The diagnostician returned no diagnosis of GY-1430: ${settings.model} timeout: no terminal event within 1200s; the run was stopped; ${settings.fallbackModel} timeout: no terminal event within 1200s; the run was stopped`);
  assert.equal(detail(/refused the diagnostician's fix item/), `The control plane refused the diagnostician's fix item for GY-1473 as written, so it is not filed again; the diagnosis stands for the master to file by hand: Graphyard refused work (409): Register E2E scenario ${unregistered.loop} before creating work that requires it`);
  // The outage's own failures ended once the plane answered: every run posted, no post left failed.
  assert.deepEqual(state.doctor.unposted, [], 'every doctor run was posted once the plane answered');
  assert.ok(posts.some(post => !post.ok) && posts.filter(post => !post.ok).length <= 4, `the posts that met the outage were retried on their backoff: ${posts.filter(post => !post.ok).length}`);
  assert.deepEqual(failures.filter(entry => entry.kind !== 'fault' && entry.kind !== 'diagnosis'), [], 'no other step failed');

  // (c) Escalations name what the master must mend: one per dropped filing, naming its unregistered scenario; none for the accepted filing.
  const escalations = Object.values(state.actions).filter(action => action.kind === 'escalation').map(action => action.detail);
  const doctorEscalations = escalations.filter(text => text.startsWith('The doctor asked to file'));
  assert.equal(doctorEscalations.length, 2, JSON.stringify(escalations));
  assert.match(doctorEscalations.find(text => text.includes(filings.refusedAtOnce.title))!, new RegExp(`\\(merge, P1\\), but the filing cites e2e:${unregistered.merge}, and no scenario ${unregistered.merge} is registered \\(scenarios register only from e2e/cases files via graphyard e2e sync or an admin's defineScenario\\); register it, or file the item by hand with master create under a proof that exists$`));
  assert.match(doctorEscalations.find(text => text.includes(filings.refusedOnRetry.title))!, new RegExp(`\\(containment, P1\\), but the filing cites e2e:${unregistered.containment}, and no scenario ${unregistered.containment} is registered`));
  assert.ok(!escalations.some(text => text.includes(filings.accepted.title)), 'the accepted filing raised no escalation');

  // (d) Sessions are bounded: the stopped diagnosis took its two runs and the refused fix its one, neither relaunched all day; the doctor ran once per interval.
  const runsOf = (subject: string) => launched.filter(entry => entry.subject === subject).map(entry => entry.attempt);
  assert.deepEqual(runsOf(stopped.key), ['primary', 'fallback'], 'both runs stopped at their bound, then no third all day');
  assert.deepEqual(runsOf(refusedFix.key), ['primary'], 'diagnosed by its first run, its refused fix never diagnosed again');
  assert.equal(launched.length, 5, `two for the stopped diagnosis, one each for the other three subjects: ${JSON.stringify(launched)}`);
  assert.equal(state.diagnoses[stopped.key].state, 'failed');
  assert.deepEqual(state.diagnoses[stopped.key].runs.map(run => run.result), ['timeout', 'timeout']);
  assert.equal(state.diagnoses[refusedFix.key].state, 'failed');
  assert.equal(state.diagnoses[refusedFix.key].fix, null, 'no fix was filed');
  assert.ok(doctorRuns >= 70 && doctorRuns <= 73, `one doctor run per ten minutes over twelve hours: ${doctorRuns}`);
  assert.ok(!state.doctor.runs.some(run => run.state !== 'reported'), `every retained doctor run applied its report: ${state.doctor.runs.map(run => run.state).join(', ')}`);
  clearDoctorRuns(); clearDiagnoses();
});

test('unit:soak-refused-filing-outlives-the-ledger-count — over more than a week of the real loop a refusal create gave once is never repeated, however many other filings it refused before the doctor reported that content again', async () => {
  clearDoctorRuns();
  let now = start;
  const state = emptyDaemonState(config());
  const control = item('GY-50', start - 2 * hour, { title: 'Refresh stale merge observations', type: 'feature' });
  const submitted: string[] = [];
  let next = 100;
  const create = async (input: any): Promise<Work> => {
    // The loop's own recurring-fault items are accepted; only the doctor's filings are refused.
    if (/^Recurring /.test(input.title)) return item(`GY-${next++}`, now, { title: input.title, description: input.description });
    submitted.push(input.title);
    throw new RefusedResponse(`Graphyard refused work (409): Register E2E scenario ${unregistered.loop} before creating work that requires it`, 409, { error: `Register E2E scenario ${unregistered.loop} before creating work that requires it` });
  };
  const distinct = 1100;
  let doctorRuns = 0;
  const doctor: DoctorEffects = {
    settings: { ...doctorSettingsSchema.parse({}), command: 'pi' }, cwd: '/soak/checkout', env: {},
    runner: async () => ({ runtime: 'pi', model: 'soak/doctor', release: async () => {}, runner: { name: 'pi', start: (_prompt: string, options: { tool: string }) => {
      const index = doctorRuns++;
      // The first filing, then more distinct refused filings than the old ledger kept, then the first one reported again, twice.
      const reported = index === 0 || index > distinct ? filing('loop', 'Master loop cannot restart or self-upgrade', [`e2e:${unregistered.loop}`]) : filing('merge', `Malformed filing ${index}`, [`e2e:${unregistered.loop}`]);
      const payload = { findings: [], actions: [], filed: [{ ...reported, faultClass: index === 0 || index > distinct ? 'loop' as FaultClass : (['merge', 'containment', 'decision', 'deployment'] as FaultClass[])[index % 4] }] };
      return { id: `soak-doctor-${index}`, events: [], onEvent: () => () => {}, cancel: () => {}, result: async () => ({ ok: true as const, tool: options.tool, payload, payloads: [payload] }) };
    } } as unknown as Runner }),
    file: create,
    recordRun: async () => {},
  };
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [structuredClone(control)], now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, persist: async () => {},
    observeDeployment: async () => ({ source: 'endpoint', sha: 'd'.repeat(40), at: iso(now), reason: null, deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    faultClassPolicy: policy, fileFaultClass: create, doctor,
  } as unknown as DaemonEffects;
  const violations: string[] = [];
  for (let cycle = 0; doctorRuns < distinct + 3 && cycle < 100_000; cycle++, now += 10 * minute) {
    await runCycle(config(), state, effects, () => now);
    await doctorRunsSettled();
    for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle}: ${check.invariant} — ${check.reading}`);
  }
  assert.ok(doctorRuns >= distinct + 3, `the doctor ran past the old bound: ${doctorRuns}`);
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.equal(submitted.filter(title => title === 'Master loop cannot restart or self-upgrade').length, 1, 'the first refused content reached create exactly once, however many refusals came after it');
  assert.deepEqual(submitted.filter((title, i) => submitted.indexOf(title) !== i).slice(0, 5), [], 'no content reached create twice');
  assert.deepEqual(state.doctor.pendingFiles, [], 'nothing stays pending');
  clearDoctorRuns();
});

test('unit:soak-refused-filing-outlives-any-gap — a refusal create gave once is never repeated, however many months pass unreported while other filings are refused', async () => {
  clearDoctorRuns();
  let now = start;
  const state = emptyDaemonState(config());
  const control = item('GY-50', start - 2 * hour, { title: 'Refresh stale merge observations', type: 'feature' });
  const submitted: string[] = [];
  let next = 100;
  const create = async (input: any): Promise<Work> => {
    // The loop's own recurring-fault items are accepted; only the doctor's filings are refused.
    if (/^Recurring /.test(input.title)) return item(`GY-${next++}`, now, { title: input.title, description: input.description });
    submitted.push(input.title);
    throw new RefusedResponse(`Graphyard refused work (409): Register E2E scenario ${unregistered.loop} before creating work that requires it`, 409, { error: `Register E2E scenario ${unregistered.loop} before creating work that requires it` });
  };
  const distinct = 3;
  let doctorRuns = 0;
  const doctor: DoctorEffects = {
    settings: { ...doctorSettingsSchema.parse({}), command: 'pi' }, cwd: '/soak/checkout', env: {},
    runner: async () => ({ runtime: 'pi', model: 'soak/doctor', release: async () => {}, runner: { name: 'pi', start: (_prompt: string, options: { tool: string }) => {
      const index = doctorRuns++;
      // The first filing, then distinct refused filings across more than 90 days, then the first one reported again, twice.
      const reported = index === 0 || index > distinct ? filing('loop', 'Master loop cannot restart or self-upgrade', [`e2e:${unregistered.loop}`]) : filing('merge', `Malformed filing ${index}`, [`e2e:${unregistered.loop}`]);
      const payload = { findings: [], actions: [], filed: [{ ...reported, faultClass: index === 0 || index > distinct ? 'loop' as FaultClass : (['merge', 'containment', 'decision', 'deployment'] as FaultClass[])[index % 4] }] };
      return { id: `soak-doctor-${index}`, events: [], onEvent: () => () => {}, cancel: () => {}, result: async () => ({ ok: true as const, tool: options.tool, payload, payloads: [payload] }) };
    } } as unknown as Runner }),
    file: create,
    recordRun: async () => {},
  };
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [structuredClone(control)], now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, persist: async () => {},
    observeDeployment: async () => ({ source: 'endpoint', sha: 'd'.repeat(40), at: iso(now), reason: null, deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    faultClassPolicy: policy, fileFaultClass: create, doctor,
  } as unknown as DaemonEffects;
  const violations: string[] = [];
  for (let cycle = 0; doctorRuns < distinct + 3 && cycle < 100_000; cycle++, now += 50 * 24 * hour) {
    await runCycle(config(), state, effects, () => now);
    await doctorRunsSettled();
    for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle}: ${check.invariant} — ${check.reading}`);
  }
  assert.ok(doctorRuns >= distinct + 3, `the doctor ran past the gap: ${doctorRuns}`);
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.equal(submitted.filter(title => title === 'Master loop cannot restart or self-upgrade').length, 1, 'the first refused content reached create exactly once, however long it went unreported');
  assert.deepEqual(submitted.filter((title, i) => submitted.indexOf(title) !== i).slice(0, 5), [], 'no content reached create twice');
  assert.deepEqual(state.doctor.pendingFiles, [], 'nothing stays pending');
  clearDoctorRuns();
});
