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
 * GY-1713. Create-400 refusals and standing-close adoption over a simulated day of the real loop:
 * a cycle a minute for six hours, the doctor every five minutes. The doctor retries one pending
 * filing the create route refuses with 400 Invalid input; the diagnostician files a fix the same
 * way for one recurring item, and for another asks a close that already stands with a matching
 * duplicate-of covering (GY-1710's shape). A third recurring item meets a standing obsolete close
 * that does not match: the diagnosis holds that decision (one decide POST) until its ledger state
 * changes, then asks its own closure once. While that hold stands, a stretch of transient ledger
 * read failures must not clear it or re-POST. After every cycle and at the end: each refused content
 * reaches create once, the matching standing close is adopted once and its approver launched once,
 * the mismatched close is never adopted while it stands and is not re-POSTed every cycle, nothing
 * reaches an isolation record or an unclassified fault, and every system invariant holds.
 */
const minute = 60_000, hour = 60 * minute, start = Date.parse('2026-10-11T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const policy = { threshold: 3, windowHours: 24 };
const settings = diagnosticianSettings({ diagnostician: { invariantBoundMinutes: 30, timeoutMinutes: 20 } });
const invalidBody = {
  error: 'Invalid input',
  issues: [{ code: 'invalid_type', path: ['origin', 'faultClass', 'windowHours'], message: 'Expected number, received string' }],
};
const invalidRefusal = () => new RefusedResponse(
  'Graphyard refused work (400): Invalid input: origin.faultClass.windowHours: Expected number, received string',
  400, invalidBody);

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
function recurring(state: DaemonState, key: string, faultClass: FaultClass, kind: string, text: string): Work {
  const instances: FaultInstance[] = [1, 2, 3].map(n => ({ id: `${kind}|GY-${n}|${iso(start - hour - n * minute)}`, kind, faultClass, subject: `GY-${n}`, text: `${text} (GY-${n})`,
    at: iso(start - hour - n * minute), lastSeenAt: iso(start - hour), linkedTo: key }));
  state.faults.instances.push(...instances);
  const input = faultClassItem({ faultClass, recent: instances }, policy, start - hour);
  return item(key, start - hour, { title: input.title, description: input.description, origin: input.origin, priority: 1 } as Partial<Work>);
}
const filing = (faultClass: FaultClass, title: string): DoctorFile => ({
  faultClass, priority: 1, title, description: 'The doctor\'s evidence for a capacity hold', plannedFiles: ['src/daemon/capacity.ts'],
  criteria: [{ id: 'AC-1', text: 'A spent account is held until its reset', proofs: ['unit:capacity-hold'] }],
});

test('unit:soak-invariants-hold — over a simulated day create-400 refusals settle once, a matching standing close is adopted once, a mismatched standing close is held until its ledger changes, and every system invariant holds', { timeout: 300_000 }, async () => {
  clearDoctorRuns(); clearDiagnoses();
  let now = start;
  const state = emptyDaemonState(config());
  const refusedFix = recurring(state, 'GY-1700', 'capacity', 'capacity', 'approver sessions exhaust their model-account limit');
  const matchingClose = recurring(state, 'GY-1710', 'stalled-gate', 'blocker', 'the merge of PR #77 stalls');
  const mismatchedClose = recurring(state, 'GY-1711', 'decision', 'decision-unanswered', 'a release decision stood unanswered');
  const covering = item('GY-50', start - 2 * hour, { title: 'Refresh stale merge observations', type: 'feature', stage: 'build' });
  const work: Work[] = [covering, refusedFix, matchingClose, mismatchedClose];
  // Not `capacity`: GY-1700 already stands for that class, and dedupDoctorFiles would skip the filing.
  const filings = { doctor400: filing('merge', 'Merge queue never drains after the base moves under a schema-skew filing') };
  const fixTitle = 'Hold every named account whose own attempt reported a limit until its own reset';

  const creates: { key: string; title: string; at: number; outcome: string }[] = [];
  const created = new Map<string, Work>();
  let next = 200;
  const create = async (input: any, key: string): Promise<Work> => {
    // Doctor capacity filing and the diagnostician's fix for GY-1700 are schema-refused; other creates pass.
    const refuse = input.title === filings.doctor400.title || input.title === fixTitle;
    creates.push({ key, title: input.title, at: now, outcome: refuse ? '400' : 'created' });
    if (refuse) throw invalidRefusal();
    if (created.has(key)) return created.get(key)!;
    const filed = item(`GY-${next++}`, now, { title: input.title, description: input.description, priority: input.priority, criteria: input.criteria, plannedFiles: input.plannedFiles, type: input.type ?? 'bug', ...(input.origin ? { origin: input.origin } : {}) } as Partial<Work>);
    work.push(filed); created.set(key, filed);
    return filed;
  };

  let doctorRuns = 0;
  const doctor: DoctorEffects = {
    settings: { ...doctorSettingsSchema.parse({}), command: 'pi' }, cwd: '/soak/checkout', env: {},
    runner: async () => ({ runtime: 'pi', model: 'soak/doctor', release: async () => {}, runner: { name: 'pi', start: (_prompt: string, options: { tool: string }) => {
      const index = doctorRuns++;
      // First run queues the 400 filing; later runs re-report it so a digest miss would re-file.
      const payload = { findings: [], actions: [], filed: index === 0 || index === 3 || index === 12 ? [filings.doctor400] : [] };
      return { id: `soak-doctor-${index}`, events: [], onEvent: () => () => {}, cancel: () => {}, result: async () => ({ ok: true as const, tool: options.tool, payload, payloads: [payload] }) };
    } } as unknown as Runner }),
    file: create,
    recordRun: async () => {},
  };

  const matchingStandingId = '65bf0fef-d9c1-4cd2-8467-9f1866b0fd41';
  const mismatchedStandingId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const ledger: { id: string; work: string; action: string; state: string; input: Record<string, unknown>; approvedBy: string | null; refusal: null; outcome: string | null }[] = [
    { id: matchingStandingId, work: matchingClose.key, action: 'close', state: 'requested', input: { kind: 'duplicate', ref: covering.key }, approvedBy: null, refusal: null, outcome: null },
    { id: mismatchedStandingId, work: mismatchedClose.key, action: 'close', state: 'requested', input: { kind: 'obsolete', ref: null }, approvedBy: null, refusal: null, outcome: null },
  ];
  const approvers: { work: string; decision: string; at: number }[] = [];
  const decides: { work: string; action: string; at: number; outcome: string }[] = [];
  const launched: { subject: string; at: number }[] = [];
  const soakTree = { ref: 'main', files: new Set(['src/daemon/capacity.ts', 'tests/helpers/timing-baseline.json', 'tests/docs-budget.test.ts']) };

  const diagnosisRunner = (): Runner => ({
    name: 'soak-diagnostician',
    start<T>(prompt: string, options: RunOptions<T>) {
      const given = JSON.parse(prompt.slice(prompt.indexOf('{'))) as { subject: string; faultClass: FaultClass };
      launched.push({ subject: given.subject, at: now });
      const payload: DiagnosisPayload = { subject: given.subject, cause: `root cause of ${given.subject}`,
        evidence: { logLines: [`${iso(now)} graphyard-master: ${given.subject}`], commands: ['graphyard master status'] }, faultClass: given.faultClass, covering: null, fix: null };
      if (given.subject === refusedFix.key) {
        payload.fix = { title: fixTitle, description: 'Preserve and hold every named account that reported a limit.', type: 'bug', priority: 1,
          criteria: [{ id: 'AC-1', text: 'A spent account is held until its reset', proofs: ['unit:capacity-hold'] }], plannedFiles: ['src/daemon/capacity.ts'] };
      } else {
        payload.covering = covering.key;
      }
      let result: RunResult<T>;
      try { const parsed = options.validate(payload); result = { ok: true, tool: options.tool, payload: parsed, payloads: [parsed] }; }
      catch (error) { result = { ok: false, failure: { reason: 'invalid-payload', detail: String(error) }, payloads: [] }; }
      return { id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {}, result: async () => result };
    },
  });

  const diagnostician: DiagnosticianEffects = {
    settings, cwd: '/soak/checkout',
    tree: async () => ({ ref: soakTree.ref, files: new Set(soakTree.files) }),
    runner: async () => ({ runner: diagnosisRunner(), runtime: 'pi', model: settings.model }),
    context: async () => ({ journal: [`${iso(now)} graphyard-master: soak`], serverLog: [`${iso(now)} POST /api/status 200`], pullRequests: [] }),
    file: create,
    decide: async (target, action, _reason, input = {}) => {
      decides.push({ work: target.key, action, at: now, outcome: 'asked' });
      if (action === 'close' && target.key === matchingClose.key) {
        decides[decides.length - 1]!.outcome = '409-matching';
        throw new RefusedResponse(
          `Graphyard refused work/${target.id}/decide (409): Decision ${matchingStandingId} (close) is already requested on ${target.key}; wait for it`,
          409, { error: `Decision ${matchingStandingId} (close) is already requested on ${target.key}; wait for it` });
      }
      if (action === 'close' && target.key === mismatchedClose.key) {
        const standing = ledger.find(row => row.id === mismatchedStandingId);
        if (standing?.state === 'requested') {
          decides[decides.length - 1]!.outcome = '409-mismatched';
          throw new RefusedResponse(
            `Graphyard refused work/${target.id}/decide (409): Decision ${mismatchedStandingId} (close) is already requested on ${target.key}; wait for it`,
            409, { error: `Decision ${mismatchedStandingId} (close) is already requested on ${target.key}; wait for it` });
        }
      }
      const id = `decision-${ledger.length + 1}`;
      ledger.push({ id, work: target.key, action, state: 'requested', input, approvedBy: null, refusal: null, outcome: null });
      decides[decides.length - 1]!.outcome = 'created';
      return { id };
    },
  };

  let withdrawnMismatched = false;
  let failMismatchedLedger = false;
  let mismatchedLedgerFailures = 0;
  let mismatchedHoldSeen = false;
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: work.map(entry => structuredClone(entry)), now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, persist: async () => {},
    observeDeployment: async () => ({ source: 'endpoint', sha: 'd'.repeat(40), at: iso(now), reason: null, deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    faultClassPolicy: policy, fileFaultClass: create, doctor, diagnostician,
    approver: async (target: Work, decision: string) => {
      approvers.push({ work: target.key, decision, at: now });
      const entry = ledger.find(row => row.id === decision)!;
      Object.assign(entry, { state: 'applied', approvedBy: 'graphyard-approver' });
      if (entry.action === 'close') {
        const closed = work.find(candidate => candidate.key === target.key)!;
        Object.assign(closed, { stage: 'done', closure: { kind: entry.input.kind, ref: entry.input.ref ?? null, reason: 'soak', by: 'graphyard-approver', at: iso(now), from: closed.stage }, revision: closed.revision + 1, updatedAt: iso(now) });
      }
      return { agentName: `gy-approver-${decision.slice(0, 8)}`, pane: null };
    },
    decisions: async (target: Work) => {
      // After the mismatched hold is established, refuse ledger reads for a stretch so a transient
      // unread cannot be mistaken for "gone" and clear the hold (review of 0505f846840d).
      if (failMismatchedLedger && target.key === mismatchedClose.key) {
        mismatchedLedgerFailures += 1;
        throw new Error(`transient ledger unread for ${target.key}`);
      }
      return { decisions: ledger.filter(row => row.work === target.key).map(row => structuredClone(row)) };
    },
  } as unknown as DaemonEffects;

  const violations: string[] = [];
  const isolated = () => Object.keys(state.actions).filter(key => key.startsWith('isolated:'));
  const dayInstances = () => state.faults.instances.filter(entry => Date.parse(entry.at) >= start);
  for (let cycle = 0; now < start + 6 * hour; cycle++, now += minute) {
    // Once the first 409 established the hold, fail ledger reads until shortly before withdraw.
    if (mismatchedHoldSeen && !withdrawnMismatched && now < start + 3 * hour - 5 * minute) failMismatchedLedger = true;
    else failMismatchedLedger = false;
    // Mid-soak: the mismatched obsolete standing close settles; the diagnosis may then ask its own closure once.
    if (!withdrawnMismatched && now >= start + 3 * hour) {
      const row = ledger.find(entry => entry.id === mismatchedStandingId)!;
      Object.assign(row, { state: 'withdrawn', outcome: 'taken back' });
      withdrawnMismatched = true;
      failMismatchedLedger = false;
    }
    const result = await runCycle(config(), state, effects, () => now);
    await doctorRunsSettled(); await diagnosesSettled();
    if (decides.some(entry => entry.work === mismatchedClose.key && entry.outcome === '409-mismatched')) mismatchedHoldSeen = true;
    for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle} (+${(now - start) / minute} min): ${check.invariant} — ${check.reading}`);
    assert.deepEqual(isolated(), [], `cycle ${cycle}: a failure was thrown on to the step's isolation record`);
    assert.deepEqual(dayInstances().filter(entry => entry.faultClass === 'unclassified'), [], `cycle ${cycle}: an unclassified instance opened`);
    // Matching close: adopted at most once; mismatched standing id is never claimed as the diagnosis decision.
    const matching = state.diagnoses[matchingClose.key];
    if (matching?.decision) assert.equal(matching.decision.id, matchingStandingId, `cycle ${cycle}: only the matching standing close is adopted`);
    const mismatched = state.diagnoses[mismatchedClose.key];
    if (mismatched?.decision) assert.notEqual(mismatched.decision.id, mismatchedStandingId, `cycle ${cycle}: mismatched standing close must not be the diagnosis decision`);
    // While the mismatched close still stands, decide is posted at most once for that item.
    if (!withdrawnMismatched) {
      assert.ok(decides.filter(entry => entry.work === mismatchedClose.key).length <= 1, `cycle ${cycle}: mismatched close must not be re-POSTed while held`);
    }
  }
  assert.ok(mismatchedLedgerFailures >= 10, `ledger was unread while held (${mismatchedLedgerFailures} failures)`);
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');

  // (a) Each refused content reaches create exactly once; re-reports of the doctor filing do not re-send.
  const of = (title: string) => creates.filter(entry => entry.title === title);
  assert.deepEqual(of(filings.doctor400.title).map(entry => entry.outcome), ['400'], 'doctor 400 filing reaches create once');
  assert.deepEqual(of(fixTitle).map(entry => entry.outcome), ['400'], 'diagnosis fix 400 reaches create once');
  assert.deepEqual(state.doctor.pendingFiles, [], 'nothing stays pending');
  assert.equal(state.diagnoses[refusedFix.key].state, 'failed');
  assert.match(state.diagnoses[refusedFix.key].detail, /Invalid input: origin\.faultClass\.windowHours/);
  assert.equal(dayInstances().filter(entry => entry.kind === 'fix-item').length, 2, 'one fix-item per refused content');

  // (b) Matching standing close: asked once, adopted once, approver launched once; later cycles follow the recorded decision.
  assert.deepEqual(decides.filter(entry => entry.work === matchingClose.key).map(entry => entry.outcome), ['409-matching']);
  assert.equal(state.diagnoses[matchingClose.key].state, 'answered');
  assert.equal(state.diagnoses[matchingClose.key].decision?.id, matchingStandingId);
  assert.equal(matchingClose.stage, 'done');
  assert.equal(matchingClose.closure?.kind, 'duplicate');
  assert.equal(matchingClose.closure?.ref, covering.key);
  assert.equal(approvers.filter(entry => entry.decision === matchingStandingId).length, 1, 'approver launched once for the adopted close');
  assert.equal(approvers.filter(entry => entry.work === matchingClose.key).length, 1);

  // (c) Mismatched standing close: one decide while it stands (held, not re-POSTed), never adopted; after withdraw, one fresh diagnosis close.
  assert.deepEqual(decides.filter(entry => entry.work === mismatchedClose.key && entry.outcome === '409-mismatched').map(entry => entry.outcome), ['409-mismatched'], 'exactly one refuse while mismatched close stands');
  assert.equal(decides.filter(entry => entry.work === mismatchedClose.key && entry.outcome === 'created').length, 1, 'one fresh close after the standing decision settles');
  assert.equal(state.diagnoses[mismatchedClose.key].state, 'answered');
  assert.ok(state.diagnoses[mismatchedClose.key].decision);
  assert.notEqual(state.diagnoses[mismatchedClose.key].decision!.id, mismatchedStandingId);
  assert.equal(mismatchedClose.stage, 'done');
  assert.equal(mismatchedClose.closure?.kind, 'duplicate');
  assert.equal(mismatchedClose.closure?.ref, covering.key);
  assert.equal(approvers.filter(entry => entry.work === mismatchedClose.key).length, 1, 'approver for the diagnosis close after the hold lifts');
  assert.deepEqual(approvers.filter(entry => entry.decision === mismatchedStandingId), [], 'the mismatched standing close is never put to an approver');

  // (d) Sessions bounded: one diagnostician run per subject that needed one; doctor once per interval.
  assert.deepEqual([...new Set(launched.map(entry => entry.subject))].sort(), [mismatchedClose.key, matchingClose.key, refusedFix.key].sort());
  assert.ok(launched.every(entry => launched.filter(other => other.subject === entry.subject).length === 1), 'each subject diagnosed once');
  assert.ok(doctorRuns >= 71 && doctorRuns <= 73, `one doctor run per five minutes over six hours: ${doctorRuns}`);
  clearDoctorRuns(); clearDiagnoses();
});
