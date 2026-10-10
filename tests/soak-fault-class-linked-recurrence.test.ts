import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';
import { noteFault, retainedFaultInstances } from '../src/model/fault-classes.js';
import { checkInvariants, emptyInvariantRecord } from '../src/model/invariants.js';
import { clearTriageRuns, triageSettled, triageTool } from '../src/triage.js';
import { decisionPrecondition } from '../src/model/approval.js';
import type { TriageJudgement } from '../src/model/machine-backlog.js';
import type { Run, RunOptions, RunResult, Runner } from '../src/runner/types.js';

// GY-1632. A day of five-minute loop cycles around machine-filed GY-1628, whose origin instances all
// predate the landing of delivered GY-1618 (the same class), while a resources fault recurs after
// that landing and is linked to the open item. The loop records far more faults than its record
// retains, so the linked instances are pruned; every cycle the triage step judges whether the item is
// covered by the delivery, and it must never propose closing it: closing it would suppress the
// recurrence, which the loop never files again while the item stands.

const start = Date.parse('2030-01-10T00:00:00Z'), interval = 5 * 60_000, cycles = 24 * 60 / 5, hour = 3_600_000;
const iso = (at: number) => new Date(at).toISOString();
const landing = start - 2 * hour;
/** An item as the snapshot lists it. */
const item = (fields: Record<string, unknown>) => ({
  description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item'] }],
  policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: [], revision: 1, policyRevision: 1, createdAt: iso(start - 4 * hour), updatedAt: iso(start - 4 * hour),
  stageEnteredAt: iso(start - 4 * hour), ready: false, epoch: 0, lease: null, workspaces: [], submission: null, candidate: null, reworkRequested: false,
  scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], gates: [], ...fields,
}) as unknown as Work;
const origin = (at: number[]) => ({ faultClass: { class: 'resources', threshold: 3, windowHours: 24, count: at.length, detectedAt: iso(start - 4 * hour),
  instances: at.map((seen, n) => ({ id: `resource-bound|resource:tmp-inodes|${n}`, kind: 'resource-bound', subject: 'resource:tmp-inodes', at: iso(seen) })) } });

test('unit:soak-fault-class-linked-recurrence — over a day of loop cycles a post-landing recurrence linked to an open recurring-fault item keeps it from closing as covered after the record prunes it, no recurrence is lost and every invariant holds', { timeout: 300_000 }, async t => {
  t.after(clearTriageRuns);
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { research: { command: 'pi' } } });
  const state = emptyDaemonState(config);
  const fix = item({ id: 'fix', key: 'GY-1618', title: 'Stop the /tmp inode leak', stage: 'done', origin: origin([start - 30 * hour]), delivery: { mergedAt: iso(landing), mergeSha: 'a'.repeat(40), authorizationRevision: 1 } });
  const filed = item({ id: 'filed', key: 'GY-1628', title: 'Recurring resources faults: 3 in 24 hours', stage: 'backlog', origin: origin([start - 9 * hour, start - 7 * hour, start - 4 * hour]) });
  const work: Work[] = [fix, filed], recorded: { key: string; judgement: TriageJudgement }[] = [], fileds: string[] = [];
  let now = start;
  const starts: { key: string; at: number }[] = [];
  // The triage sessions fail for the first half of the day, so GY-1628 stays untriaged while the record prunes its
  // linked recurrences and is judged again after each retry delay; from then on they release what they judge.
  const runner: Runner = { name: 'pi', start<T>(prompt: string, options: RunOptions<T>): Run<T> {
    const key = /The master loop filed (GY-\d+)/.exec(prompt)![1]!;
    starts.push({ key, at: now });
    const result: RunResult<T> = now < start + 12 * hour ? { ok: false, failure: { reason: 'timeout', detail: 'no answer' }, payloads: [] }
      : { ok: true, tool: triageTool, payload: options.validate({ outcome: 'release', priority: 1, reason: 'the recurrence after the landing is real work' }), payloads: [] };
    return { id: `triage-${starts.length}`, events: [], onEvent: () => () => {}, cancel: () => {}, result: () => Promise.resolve(result) };
  } };
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work, now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async () => { throw new Error('the soak decides nothing'); }, decisions: async () => ({ decisions: [] }),
    persist: async () => {},
    research: { cwd: process.cwd(), runner },
    recordTriage: async (entry: Work, body: { judgement: TriageJudgement }) => {
      recorded.push({ key: entry.key, judgement: body.judgement });
      Object.assign(work.find(other => other.key === entry.key)!, { triage: { judgement: body.judgement, state: body.judgement.outcome === 'release' ? 'applied' : 'proposed', by: 'master', at: iso(now) },
        ...(body.judgement.outcome === 'release' ? { stage: 'ready', ready: true } : {}) });
    },
    fileFaultClass: async (input: { title: string; origin: unknown }) => {
      fileds.push(input.title);
      // A filed item stays open for the rest of the day, as an undelivered fix would.
      const next = item({ id: `filed-${fileds.length}`, key: `GY-${2000 + fileds.length}`, title: input.title, stage: 'backlog', origin: input.origin });
      work.push(next);
      return next;
    },
  } as unknown as DaemonEffects;

  const recurrences: string[] = [];
  let pruned = -1;
  for (let n = 0; n < cycles; n++) {
    now = start + n * interval;
    // The resources fault recurs after GY-1618 landed: at the start of the day, and again late in it.
    if (n === 0 || n === 230) recurrences.push(noteFault(state.faults, { kind: 'resource-bound', faultClass: 'resources', subject: 'resource:tmp-inodes', text: 'tmp inodes at the bound' }, iso(now)).id);
    // Many more faults of another class than the record retains, so the linked recurrences are pruned.
    for (let k = 0; k < 12; k++) noteFault(state.faults, { kind: 'loop-failures', faultClass: 'loop', subject: `loop:${k}`, text: 'a cycle failed' }, iso(now));
    await runCycle(config, state, effects, () => now);
    await triageSettled();
    if (pruned < 0 && !state.faults.instances.some(entry => entry.id === recurrences[0])) pruned = n;
    const violated = checkInvariants(emptyInvariantRecord(), { work, now }).filter(check => !check.holds);
    assert.deepEqual(violated.map(check => `${check.invariant}: ${check.reading}`), [], `cycle ${n}: every system invariant holds`);
    assert.ok(state.faults.instances.length <= retainedFaultInstances, `cycle ${n}: the record stays within its bound`);
  }

  assert.ok(pruned > 0, 'the first post-landing recurrence was pruned from the record during the day');
  assert.equal(state.faults.linked?.['GY-1628'], iso(start + 230 * interval), 'the record keeps the newest recurrence linked to the item past its retention');
  const judged = starts.filter(entry => entry.key === 'GY-1628');
  assert.ok(judged.filter(entry => entry.at > start + pruned * interval).length >= 2, `GY-1628 was judged again after its first linked recurrence was pruned: ${judged.length} sessions`);
  assert.deepEqual(recorded.filter(entry => entry.key === 'GY-1628' && entry.judgement.outcome === 'close'), [], 'GY-1628 is never proposed closed as covered by GY-1618');
  assert.equal(recorded.find(entry => entry.key === 'GY-1628')?.judgement.outcome, 'release', 'a session judged it and released it');
  assert.deepEqual(fileds.filter(title => /resources/.test(title)), [], 'no second resources item is filed: every recurrence stays linked to the open item');
  const linked = state.faults.instances.filter(entry => entry.faultClass === 'resources');
  assert.ok(linked.length > 0 && linked.every(entry => entry.linkedTo === 'GY-1628'), 'every retained recurrence is linked to GY-1628, none lost');
});

// The same day with the proposal already made: GY-1628 is proposed closed as covered by GY-1618 and its
// close decision waits ten hours for the approver. A recurrence after the landing is linked to the item
// meanwhile, and the control plane does not answer the loop's withdrawal until the record has pruned that
// recurrence. The approver then judges the decision against the item as it stands, as the control plane's
// decisionPrecondition does: the withdrawn proposal applies nothing, the item is judged again and released.
test('unit:soak-fault-class-linked-recurrence — a covered-by-delivery closure awaiting its approver is withdrawn when a post-landing recurrence is linked, even after the record prunes it, so the approval closes nothing and every invariant holds', { timeout: 300_000 }, async t => {
  t.after(clearTriageRuns);
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { research: { command: 'pi' } } });
  const state = emptyDaemonState(config);
  const fix = item({ id: 'fix', key: 'GY-1618', title: 'Stop the /tmp inode leak', stage: 'done', origin: origin([start - 30 * hour]), delivery: { mergedAt: iso(landing), mergeSha: 'a'.repeat(40), authorizationRevision: 1 } });
  const covered: TriageJudgement = { outcome: 'close', ref: 'GY-1618', reason: 'Covered by GY-1618: every instance predates that landing' };
  const filed = item({ id: 'filed', key: 'GY-1628', title: 'Recurring resources faults: 3 in 24 hours', stage: 'backlog', origin: origin([start - 9 * hour, start - 7 * hour, start - 4 * hour]),
    triage: { judgement: covered, state: 'proposed', by: 'master', at: iso(start - hour) } });
  const work: Work[] = [fix, filed], recorded: { key: string; judgement: TriageJudgement }[] = [], fileds: string[] = [];
  const decisions: { id: string; action: string; state: string; input: any; requestedAt: number; approvedBy: string | null; refusal: null }[] = [];
  const withdrawals: { at: number; answered: boolean }[] = [], launched: string[] = [];
  let now = start, recurrence = '';
  const runner: Runner = { name: 'pi', start<T>(_prompt: string, options: RunOptions<T>): Run<T> {
    const result: RunResult<T> = { ok: true, tool: triageTool, payload: options.validate({ outcome: 'release', priority: 1, reason: 'the recurrence after the landing is real work' }), payloads: [] };
    return { id: `triage-${now}`, events: [], onEvent: () => () => {}, cancel: () => {}, result: () => Promise.resolve(result) };
  } };
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work, now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (entry: Work, action: string, _reason: string, input?: Record<string, unknown>) => {
      assert.equal(action, 'close', `only the triage closure is decided, not ${action}`);
      const id = `close-${decisions.length + 1}`;
      decisions.push({ id, action, state: 'requested', input: { ...input }, requestedAt: now, approvedBy: null, refusal: null });
      return { id };
    },
    decisions: async (entry: Work) => ({ decisions: entry.key === 'GY-1628' ? decisions : [] }),
    // The approver session the loop launches judges after ten hours, below.
    approver: async (_entry: Work, decision: string) => { launched.push(decision); return { agentName: `gy-approver-${decision}`, pane: null }; },
    persist: async () => {},
    research: { cwd: process.cwd(), runner },
    recordTriage: async (entry: Work, body: { judgement: TriageJudgement }) => {
      recorded.push({ key: entry.key, judgement: body.judgement });
      Object.assign(work.find(other => other.key === entry.key)!, { triage: { judgement: body.judgement, state: body.judgement.outcome === 'release' ? 'applied' : 'proposed', by: 'master', at: iso(now) },
        ...(body.judgement.outcome === 'release' ? { stage: 'ready', ready: true } : {}) });
    },
    // The control plane does not answer until the record has pruned the recurrence, so only the record's linked time can still name it.
    withdrawTriage: async (entry: Work, body: { triageAt: string; reason: string }) => {
      const answered = !state.faults.instances.some(instance => instance.id === recurrence);
      withdrawals.push({ at: now, answered });
      if (!answered) throw new Error('502 Bad Gateway');
      const target = work.find(other => other.key === entry.key)!;
      if (target.triage?.state === 'proposed' && target.triage.at === body.triageAt) Object.assign(target, { triage: { ...target.triage, state: 'refused', refusal: body.reason, at: iso(now) }, updatedAt: iso(now) });
    },
    fileFaultClass: async (input: { title: string; origin: unknown }) => {
      fileds.push(input.title);
      const next = item({ id: `filed-${fileds.length}`, key: `GY-${2000 + fileds.length}`, title: input.title, stage: 'backlog', origin: input.origin });
      work.push(next);
      return next;
    },
  } as unknown as DaemonEffects;

  const approvals: (string | null)[] = [];
  for (let n = 0; n < cycles; n++) {
    now = start + n * interval;
    if (n === 3) recurrence = noteFault(state.faults, { kind: 'resource-bound', faultClass: 'resources', subject: 'resource:tmp-inodes', text: 'tmp inodes at the bound' }, iso(now)).id;
    for (let k = 0; k < 12; k++) noteFault(state.faults, { kind: 'loop-failures', faultClass: 'loop', subject: `loop:${k}`, text: 'a cycle failed' }, iso(now));
    await runCycle(config, state, effects, () => now);
    await triageSettled();
    // Ten hours after a close decision was requested its approver judges it against the item as it stands.
    for (const decision of decisions.filter(entry => entry.state === 'requested' && now - entry.requestedAt >= 10 * hour)) {
      const target = work.find(other => other.key === 'GY-1628')!, refusal = decisionPrecondition('close', decision.input, target);
      approvals.push(refusal);
      if (refusal) { decision.state = 'stale'; continue; }
      Object.assign(decision, { state: 'applied', approvedBy: 'approver' });
      Object.assign(target, { stage: 'done', closure: { kind: 'superseded', ref: decision.input.ref, reason: decision.input.reason, by: 'approver', at: iso(now), from: 'backlog' }, triage: { ...target.triage, state: 'applied' } });
    }
    const violated = checkInvariants(emptyInvariantRecord(), { work, now }).filter(check => !check.holds);
    assert.deepEqual(violated.map(check => `${check.invariant}: ${check.reading}`), [], `cycle ${n}: every system invariant holds`);
    assert.ok(state.faults.instances.length <= retainedFaultInstances, `cycle ${n}: the record stays within its bound`);
  }

  const answered = withdrawals.filter(entry => entry.answered);
  assert.ok(withdrawals.length > answered.length, 'the withdrawal was retried while the control plane did not answer');
  assert.equal(answered.length, 1, 'once withdrawn, it is withdrawn no more');
  assert.ok(answered[0]!.at < start + 10 * hour, 'the withdrawal landed before the approver judged the decision');
  assert.ok(decisions.length >= 1 && decisions.every(entry => entry.state !== 'applied'), `no close decision applied: ${decisions.map(entry => entry.state).join(', ')}`);
  assert.ok(approvals.length >= 1 && approvals.every(refusal => /no proposed triage closure/.test(refusal ?? '')), `the approver's judgement applied nothing: ${approvals.join(' | ')}`);
  const gy1628 = work.find(other => other.key === 'GY-1628')!;
  assert.notEqual(gy1628.stage, 'done', 'GY-1628 is never closed as covered by GY-1618');
  assert.deepEqual(recorded.filter(entry => entry.key === 'GY-1628').map(entry => entry.judgement.outcome), ['release'], 'GY-1628 was judged again and released, never re-proposed closed');
  assert.deepEqual(fileds.filter(title => /resources/.test(title)), [], 'no second resources item is filed: the recurrence stays linked to the open item');
  assert.equal(state.faults.linked?.['GY-1628'], iso(start + 3 * interval), 'the record keeps the recurrence linked to GY-1628 past its retention');
});

// The same day with the approval landing in the cycle a recurrence first appears: the decision step applies
// GY-1628's covered-by-delivery closure on the control plane, and the fault step of that cycle, reading the
// snapshot taken before it, links the post-landing recurrence to the item it still shows open. The next cycle
// sees the item closed over that recurrence and releases the link, so with two later recurrences the class
// files afresh, listing it; nothing is filed twice, and every invariant holds.
test('unit:soak-fault-class-linked-recurrence — a covered-by-delivery closure approved in the decision step of the cycle a post-landing recurrence appears does not swallow it: the link is released and the class files afresh once, and every invariant holds', { timeout: 300_000 }, async t => {
  t.after(clearTriageRuns);
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { research: { command: 'pi' } } });
  const state = emptyDaemonState(config);
  const fix = item({ id: 'fix', key: 'GY-1618', title: 'Stop the /tmp inode leak', stage: 'done', origin: origin([start - 30 * hour]), delivery: { mergedAt: iso(landing), mergeSha: 'a'.repeat(40), authorizationRevision: 1 } });
  const covered: TriageJudgement = { outcome: 'close', ref: 'GY-1618', reason: 'Covered by GY-1618: every instance predates that landing' };
  const filed = item({ id: 'filed', key: 'GY-1628', title: 'Recurring resources faults: 3 in 24 hours', stage: 'backlog', origin: origin([start - 9 * hour, start - 7 * hour, start - 4 * hour]),
    triage: { judgement: covered, state: 'proposed', by: 'master', at: iso(start - hour) } });
  // `work` is the control plane's; each cycle reads a snapshot of it taken at the cycle's start.
  const work: Work[] = [fix, filed], fileds: { title: string; origin: any }[] = [];
  const decisions: { id: string; action: string; state: string; input: any; requestedAt: number; approvedBy: string | null; refusal: null }[] = [];
  const race = 6, recurrences: string[] = [];
  let now = start, n = 0;
  const runner: Runner = { name: 'pi', start<T>(_prompt: string, options: RunOptions<T>): Run<T> {
    const result: RunResult<T> = { ok: true, tool: triageTool, payload: options.validate({ outcome: 'release', priority: 1, reason: 'the recurrence after the landing is real work' }), payloads: [] };
    return { id: `triage-${now}`, events: [], onEvent: () => () => {}, cancel: () => {}, result: () => Promise.resolve(result) };
  } };
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: structuredClone(work), now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (_entry: Work, action: string, _reason: string, input?: Record<string, unknown>) => {
      assert.equal(action, 'close', `only the triage closure is decided, not ${action}`);
      const id = `close-${decisions.length + 1}`;
      decisions.push({ id, action, state: 'requested', input: { ...input }, requestedAt: now, approvedBy: null, refusal: null });
      return { id };
    },
    // The approver's judgement lands while the decision step of the race cycle reads the item's decisions.
    decisions: async (entry: Work) => {
      if (entry.key !== 'GY-1628') return { decisions: [] };
      const target = work.find(other => other.key === 'GY-1628')!;
      for (const decision of decisions.filter(other => other.state === 'requested' && n === race)) {
        assert.equal(decisionPrecondition('close', decision.input, target), null, 'the proposal still stands when the approver judges it');
        Object.assign(decision, { state: 'applied', approvedBy: 'approver' });
        Object.assign(target, { stage: 'done', closure: { kind: 'superseded', ref: decision.input.ref, reason: decision.input.reason, by: 'approver', at: iso(now), from: 'backlog' }, triage: { ...target.triage, state: 'applied' }, updatedAt: iso(now) });
      }
      return { decisions: structuredClone(decisions) };
    },
    approver: async (_entry: Work, decision: string) => ({ agentName: `gy-approver-${decision}`, pane: null }),
    persist: async () => {},
    research: { cwd: process.cwd(), runner },
    recordTriage: async (entry: Work, body: { judgement: TriageJudgement }) => {
      Object.assign(work.find(other => other.key === entry.key)!, { triage: { judgement: body.judgement, state: body.judgement.outcome === 'release' ? 'applied' : 'proposed', by: 'master', at: iso(now) },
        ...(body.judgement.outcome === 'release' ? { stage: 'ready', ready: true } : {}) });
    },
    // A withdrawal of a proposal the approver already applied changes nothing, as on the control plane.
    withdrawTriage: async (entry: Work, body: { triageAt: string; reason: string }) => {
      const target = work.find(other => other.key === entry.key)!;
      if (target.triage?.state === 'proposed' && target.triage.at === body.triageAt) Object.assign(target, { triage: { ...target.triage, state: 'refused', refusal: body.reason, at: iso(now) }, updatedAt: iso(now) });
    },
    fileFaultClass: async (input: { title: string; origin: any }) => {
      fileds.push(input);
      const next = item({ id: `filed-${fileds.length}`, key: `GY-${2000 + fileds.length}`, title: input.title, stage: 'backlog', origin: input.origin });
      work.push(next);
      return structuredClone(next);
    },
  } as unknown as DaemonEffects;

  for (n = 0; n < cycles; n++) {
    now = start + n * interval;
    // The resources fault recurs after GY-1618 landed: first in the race cycle, then twice more.
    if (n === race || n === race + 12 || n === race + 24) recurrences.push(noteFault(state.faults, { kind: 'resource-bound', faultClass: 'resources', subject: 'resource:tmp-inodes', text: 'tmp inodes at the bound' }, iso(now)).id);
    await runCycle(config, state, effects, () => now);
    await triageSettled();
    if (n === race) assert.equal(state.faults.instances.find(entry => entry.id === recurrences[0])?.linkedTo, 'GY-1628', 'the race cycle links the recurrence to the item its snapshot shows open');
    if (n === race + 1) assert.equal(state.faults.instances.find(entry => entry.id === recurrences[0])?.linkedTo, null, 'the next cycle releases the link the closure overtook');
    const violated = checkInvariants(emptyInvariantRecord(), { work, now }).filter(check => !check.holds);
    assert.deepEqual(violated.map(check => `${check.invariant}: ${check.reading}`), [], `cycle ${n}: every system invariant holds`);
    assert.ok(state.faults.instances.length <= retainedFaultInstances, `cycle ${n}: the record stays within its bound`);
  }

  assert.equal(work.find(other => other.key === 'GY-1628')!.stage, 'done', 'the approval closed GY-1628 in the race cycle');
  assert.equal(fileds.length, 1, `the class files afresh exactly once: ${fileds.map(entry => entry.title).join(' | ')}`);
  assert.deepEqual(fileds[0]!.origin.faultClass.instances.map((entry: { id: string }) => entry.id).sort(), [...recurrences].sort(), 'the filed item lists the recurrence the race linked to the closed item');
  const resources = state.faults.instances.filter(entry => entry.faultClass === 'resources');
  assert.ok(resources.length === 3 && resources.every(entry => entry.linkedTo === 'GY-2001'), `every post-landing recurrence is linked to the item filed for them: ${resources.map(entry => entry.linkedTo).join(', ')}`);
});
