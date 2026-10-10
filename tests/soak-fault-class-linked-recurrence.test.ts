import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';
import { noteFault, retainedFaultInstances } from '../src/model/fault-classes.js';
import { checkInvariants, emptyInvariantRecord } from '../src/model/invariants.js';
import { clearTriageRuns, triageSettled, triageTool } from '../src/triage.js';
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
