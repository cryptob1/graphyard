import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionableSubjects, cycleDelay, daemonSummary, emptyDaemonState, latencyBudget, latencyTargets, loopAttention, loopLiveness, mergeableCandidate, routineDecision, runCycle, runDaemon, silenceBudgetMs, standingVerdict, watchdogPlan, writeDaemonState, type DaemonAction, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { decisionInput, masterConfigSchema, type ContainmentAssessment, type MasterConfig, type MasterRun, type WorkerProfile } from '../src/master.js';
import { containmentGraceMs } from '../src/quarantine.js';
import type { Work } from '../src/model.js';

/**
 * GY-84: the loop drives every routine decision unattended.
 *
 * These proofs run the real cycle against a simulated control plane and a simulated outside world:
 * the launcher claims, the worker pushes and submits, CI and the reviewer land verdicts on the exact
 * head, a producer publishes trusted evidence, and the approver session the loop launches judges the
 * decisions the loop requests. Nothing in the harness makes a decision for the loop, and no step
 * waits for a human: what the loop does not do itself does not happen.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clockStart = Date.parse('2031-03-01T09:00:00Z');
const hex = (seed: string) => createHash('sha1').update(seed).digest('hex');
const minute = 60_000;

function config(overrides: Partial<Omit<MasterConfig, 'run'>> & { run?: Partial<MasterRun> } = {}): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', operatorAgent: { id: 'graphyard-master-operator', credentialFile: '/outside/coordinator-operator.token' },
    approver: { id: 'graphyard-approver', credentialFile: '/outside/coordinator-approver.token' }, ...overrides,
    run: { proofWorkflow: 'acceptance.yml', ...overrides.run } });
}
const profile = (name: string, overrides: Partial<WorkerProfile> = {}): WorkerProfile =>
  ({ name, principal: `${name}-principal`, agentName: `agent-${name}`, mode: 'launch', kind: 'claude', credentialFile: `/outside/${name}.token`, agentArgs: [], environment: {}, ...overrides }) as WorkerProfile;

/** What the outside world does with one attempt: the session dies, the head is judged, or both. */
type Round = 'die' | 'changes' | 'conflict' | 'pass';
interface Script { key: string; rounds: Round[]; scopeOn?: number }

interface PlaneDecision { id: string; action: string; state: string; input: any; approvedBy: string | null; reason: string }

/**
 * The simulated control plane. It holds work documents, recomputes gates and stage from them
 * exactly as the engine's order does, and applies the mutations the loop's effects ask for —
 * a claim, a settled quarantine, an additive requirements revision, a decision, a merge. Between
 * cycles `advance` runs everyone else: the launched worker, CI, the reviewer, the producer, and
 * the approver session the loop launched for its own request.
 */
function plane(scripts: Script[], options: { hostId?: string; autoMerge?: boolean } = {}) {
  const hostId = options.hostId ?? 'machine-a';
  let now = clockStart;
  const iso = (at: number = now) => new Date(at).toISOString();
  const work: Work[] = scripts.map((script, index) => ({
    id: `id-${script.key}`, key: script.key, title: `Deliver ${script.key}`, description: '', type: 'feature', priority: 2,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Proven end to end', proofs: ['integration:loop'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [`src/${script.key.toLowerCase()}.ts`],
    stage: 'ready', revision: 1, policyRevision: 1, createdAt: iso(now - 30 * minute), updatedAt: iso(), stageEnteredAt: iso(now - minute),
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [],
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }],
    pr: 100 + index,
  } as unknown as Work));
  const decisions = new Map<string, PlaneDecision[]>();
  const approvers: string[] = [];
  const judged = new Map<string, number>();
  const find = (id: string) => work.find(item => item.id === id || item.key === id)!;
  const script = (item: Work) => scripts.find(entry => entry.key === item.key)!;
  const round = (item: Work): Round => { const rounds = script(item).rounds; return rounds[Math.min(rounds.length - 1, Math.max(0, item.epoch - 1))]; };

  /** The gates and stage the engine would compute, in its order, from this document alone. */
  const recompute = (item: Work) => {
    const candidate = item.candidate, observation = item.observation;
    const current = !!candidate && !!observation && observation.candidate.sha === candidate.sha;
    const submitted = !!item.submission && !item.reworkRequested && current && !!item.workspaces.length;
    const conflict = item.baseRefresh?.conflict && item.baseRefresh.from.sha === candidate?.sha ? item.baseRefresh.conflict : null;
    const reviews = current ? observation!.reviews : [];
    const approved = reviews.some(review => review.sha === candidate!.sha && review.state === 'APPROVED');
    const changes = reviews.some(review => review.sha === candidate!.sha && review.state === 'CHANGES_REQUESTED');
    const checks = item.policy.checks.filter(name => !(current ? observation!.checks : []).some(check => check.name === name && check.result === 'success'));
    const proofs = [...new Set(item.criteria.flatMap(criterion => criterion.proofs))];
    const unproven = proofs.filter(proof => !item.evidence.some(entry => entry.proof === proof && entry.trusted && !entry.revocation
      && entry.sha === candidate?.sha && entry.baseSha === candidate?.baseSha && entry.policyRevision === item.policyRevision && entry.result === 'pass' && entry.executed > 0 && entry.skipped === 0));
    const stale = !observation || now - Date.parse(observation.at) >= 120_000;
    const gates = [
      { name: 'ready', reasons: [...(item.ready ? [] : ['Not released from backlog']), ...(item.blocker ? [item.blocker] : [])] },
      { name: 'build', reasons: [...(submitted ? [] : ['Worker has not submitted implementation for this attempt']), ...(conflict ? [conflict] : [])] },
      { name: 'review', reasons: [...(approved ? [] : ['Independent approval of the current commit is required']), ...(changes ? ['Outstanding change requests must be resolved through a new review'] : [])] },
      { name: 'test', reasons: checks.map(name => `Required CI check ${name} has not passed on the current candidate`) },
      { name: 'acceptance', reasons: unproven.map(proof => `AC-1: ${proof} needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy`) },
      { name: 'merge', reasons: [...(stale ? ['GitHub observation missing or older than two minutes'] : []), ...(observation?.mergeable === false ? ['Pull request is not mergeable against the current base'] : [])] },
    ].map(gate => ({ name: gate.name, passed: !gate.reasons.length, reasons: gate.reasons }));
    if (item.stage === 'done') { item.gates = gates.map(gate => ({ ...gate, passed: true, reasons: [] })); return; }
    const failing = gates.find(gate => !gate.passed);
    const stage = (failing?.name ?? 'merge') as Work['stage'];
    if (stage !== item.stage) { item.stage = stage; item.stageEnteredAt = iso(); }
    item.gates = gates;
    item.mergeAuthorization = gates.every(gate => gate.passed) && candidate ? { sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: item.policyRevision, at: iso() } : null;
  };
  for (const item of work) recompute(item);

  const push = (item: Work) => {
    const sha = hex(`${item.key}-${item.epoch}`), baseSha = hex(`base-${item.key}`);
    const pr = (item as unknown as { pr: number }).pr;
    item.candidate = { sha, baseSha, pr, branch: `graphyard/${item.key.toLowerCase()}-${item.epoch}`, author: 'worker', createdAt: iso() };
    item.submission = { epoch: item.epoch, pr };
    item.observation = { candidate: item.candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
      files: item.plannedFiles, at: iso(), baseTip: baseSha, baseTipContained: true, prState: 'open', draft: false } as Work['observation'];
    item.baseRefresh = null;
    // `complete` reports the implementation and ends the lease in the same transaction.
    item.lease = null;
    recompute(item);
  };
  const judge = (item: Work) => {
    const candidate = item.candidate!, step = (judged.get(item.key) ?? 0) + 1;
    judged.set(item.key, step);
    item.observation = { ...item.observation!, at: iso() };
    const verdict = (state: string) => { item.observation!.reviews = [{ reviewer: 'graphyard-reviewer[bot]', sha: candidate.sha, state, submittedAt: iso() }]; };
    if (round(item) === 'changes') verdict('CHANGES_REQUESTED');
    else if (round(item) === 'conflict') {
      item.baseRefresh = { from: { sha: candidate.sha, baseSha: candidate.baseSha }, base: item.observation!.baseTip!, baseTree: hex(`tree-${item.key}`),
        policyRevision: item.policyRevision, at: iso(), head: null, conflict: `src/${item.key.toLowerCase()}.ts: merge conflict with the base branch`, carry: null } as Work['baseRefresh'];
    } else if (step === 1) {
      // The reviewer approves and CI reports first; the producer's trusted evidence lands after it.
      verdict('APPROVED');
      item.observation!.checks = item.policy.checks.map(name => ({ name, result: 'success', appId: 1234 }));
    } else {
      item.evidence = [...item.evidence, { id: `evidence-${item.key}-${item.epoch}`, proof: 'integration:loop', sha: candidate.sha, baseSha: candidate.baseSha,
        policyRevision: item.policyRevision, producer: 'ci-producer', trusted: true, result: 'pass', executed: 4, skipped: 0, at: iso() }];
    }
    recompute(item);
  };
  /** The approver session the loop launched: it judges the request and applies what it approves. */
  const applyDecisions = () => {
    for (const [id, entries] of decisions) {
      const item = find(id);
      for (const decision of entries.filter(entry => entry.state === 'requested' && approvers.includes(`${item.key}:${entry.id}`))) {
        decision.state = 'applied'; decision.approvedBy = 'graphyard-approver';
        if (decision.action === 'rework') { item.reworkRequested = true; item.lease = null; item.baseRefresh = null; judged.set(item.key, 0); }
        if (decision.action === 'recover') item.containmentQuarantine = null;
        recompute(item);
      }
    }
  };

  const advance = (ms: number) => {
    now += ms;
    applyDecisions();
    for (const item of work) {
      if (item.stage === 'done') continue;
      const live = !!item.lease && Date.parse(item.lease.expiresAt) > now;
      const submitted = !!item.submission && !item.reworkRequested && item.submission.epoch === item.epoch;
      // A worker waiting for its scope request keeps its lease and pushes nothing until it lands.
      if (live && item.scopeRequest) continue;
      if (live && round(item) !== 'die' && !submitted) { push(item); continue; }
      if (!submitted || !item.candidate) continue;
      judge(item);
    }
    for (const item of work) recompute(item);
  };

  const effects = (overrides: Partial<DaemonEffects> = {}): DaemonEffects => ({
    agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: work.map(item => ({ ...item })), now: iso() }),
    closeSession: () => {},
    dispatch: async (item, worker) => {
      const target = find(item.id);
      target.epoch += 1;
      target.lease = { owner: worker.principal, epoch: target.epoch, expiresAt: iso(now + 30 * minute) };
      target.lastAssignment = { owner: worker.principal, epoch: target.epoch, claimedAt: iso() };
      target.workspaces = [{ host: hostId, path: `/tmp/graphyard/${target.key.toLowerCase()}-${target.epoch}`, branch: `graphyard/${target.key.toLowerCase()}-${target.epoch}`, epoch: target.epoch, owner: worker.principal }];
      target.implementers = [...new Set([...(target.implementers ?? []), worker.principal])];
      target.reworkRequested = false;
      if (script(target).scopeOn === target.epoch) target.scopeRequest = { epoch: target.epoch, paths: ['docs/loop.md'], reason: 'The criteria ask for the loop guide to be updated', requestedBy: worker.principal, at: iso() };
      if (round(target) === 'die') {
        // A supervised launch fences its session in a scope unit; this one dies with the fence up.
        target.lease = { ...target.lease, expiresAt: iso(now + minute) };
        target.containmentQuarantine = { owner: worker.principal, epoch: target.epoch, at: iso(), settlementHash: 'f'.repeat(64),
          leaseExpiresAt: iso(now + minute), launchExpiresAt: iso(now + minute), scope: { unit: `graphyard-watch-${target.epoch}.scope`, pid: 4242 } };
      }
      recompute(target);
    },
    requestProof: () => {},
    merge: async item => {
      const target = find(item.id);
      const mergeSha = hex(`merge-${target.key}-${target.epoch}`);
      target.observation = { ...target.observation!, merged: true, mergeSha, mergedAt: iso(), at: iso() };
      target.stage = 'done'; target.stageEnteredAt = iso();
      target.delivery = { mergedAt: iso(), mergedAtRepository: iso(), mergeSha, authorizationRevision: target.revision };
      recompute(target);
      return { result: 'merged' };
    },
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: iso(clockStart), reason: 'No deployment endpoint is configured in this exercise', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    decide: async (item, action, reason) => {
      const target = find(item.id);
      const entries = decisions.get(target.id) ?? [];
      const id = `decision-${target.key}-${action}-${entries.length + 1}`;
      decisions.set(target.id, [...entries, { id, action, state: 'requested', input: decisionInput(action, target, {}), approvedBy: null, reason }]);
      return { id };
    },
    approver: async (item, decision) => { approvers.push(`${find(item.id).key}:${decision}`); },
    decisions: async item => ({ decisions: decisions.get(find(item.id).id) ?? [] }),
    widenScope: async item => {
      const target = find(item.id);
      const request = target.scopeRequest!;
      target.plannedFiles = [...new Set([...target.plannedFiles, ...request.paths])];
      target.policyRevision += 1; target.scopeRequest = null;
      recompute(target);
    },
    containment: items => Object.fromEntries(items.filter(item => item.containmentQuarantine).map(item => [item.id, {
      key: item.key, id: item.id, epoch: item.containmentQuarantine!.epoch, owner: item.containmentQuarantine!.owner, at: item.containmentQuarantine!.at,
      host: hostId, workspacePath: item.workspaces[0]?.path ?? null, scope: item.containmentQuarantine!.scope ?? null,
      settleable: true, refusals: [], attestation: '', verification: null,
    } as ContainmentAssessment])),
    settleContainment: async item => { find(item.id).containmentQuarantine = null; recompute(find(item.id)); },
    persist: async () => {},
    ...overrides,
  });

  return { work, decisions, approvers, effects, recompute, advance, find, now: () => now, iso, hostId,
    set: (at: number) => { now = at; } };
}

/** Run one cycle of the real loop against the simulation, then let the outside world act. */
async function cycle(state: DaemonState, master: MasterConfig, simulation: ReturnType<typeof plane>, effects: DaemonEffects, advanceMs = minute) {
  const result = await runCycle(master, state, effects, simulation.now);
  simulation.advance(advanceMs);
  return result;
}
const steps = (actions: DaemonAction[]) => actions.filter(action => action.kind !== 'deployment').map(action => `${action.kind}:${action.work ?? '-'}:${action.state}`);

test('integration:unattended-full-cycle — with no master session and no human input the loop drives one item from ready to delivered: it dispatches, reclaims a dead session, widens an additive scope request, requests and dispatches rework after a verdict and after a base conflict, and merges the candidate whose gates are green', async () => {
  // Attempt 1's session dies under its fence; attempt 2 is told to change the work; attempt 3
  // hits a base branch Graphyard cannot merge in; attempt 4 asks for one more planned file and
  // then delivers. Every step between them is the loop's to take.
  const simulation = plane([{ key: 'GY-84', rounds: ['die', 'changes', 'conflict', 'pass'], scopeOn: 4 }]);
  const master = config({ workers: [profile('claude-a'), profile('claude-b')] });
  const state = emptyDaemonState(master);
  const effects = simulation.effects();
  const performed: DaemonAction[] = [];
  const item = simulation.work[0];
  for (let pass = 0; pass < 24 && item.stage !== 'done'; pass++) {
    // Longer than the containment grace window, so the first attempt's fence becomes settleable.
    performed.push(...(await cycle(state, master, simulation, effects, containmentGraceMs / 2)).actions);
  }
  // One more cycle so the delivery is sampled from the snapshot that shows it delivered.
  performed.push(...(await cycle(state, master, simulation, effects)).actions);

  assert.equal(item.stage, 'done', 'the item reached delivery with no master session and no human input');
  assert.equal(item.epoch, 4, 'four attempts: the dead session, the rework round, the base conflict, and the delivered one');
  assert.deepEqual(item.plannedFiles, ['src/gy-84.ts', 'docs/loop.md'], 'the additive scope request was applied without ending the attempt');
  assert.equal(item.containmentQuarantine, null, 'the dead session\'s fence was settled by the loop');
  assert.equal(item.scopeRequest, null);

  // Exactly the routine decisions the criteria name, each requested by the loop and applied by the
  // independent approver session the loop launched for it — never by the requester.
  const requested = simulation.decisions.get(item.id)!;
  assert.deepEqual(requested.map(decision => [decision.action, decision.state, decision.approvedBy]),
    [['rework', 'applied', 'graphyard-approver'], ['rework', 'applied', 'graphyard-approver']]);
  assert.deepEqual(simulation.approvers, requested.map(decision => `GY-84:${decision.id}`), 'one approver session per requested decision');
  for (const decision of requested) assert.equal(decision.input.previousWorkerStopped, true, 'rework is requested only once the attempt has ended');

  const kinds = steps(performed);
  const order = (needle: string) => kinds.findIndex(entry => entry === needle);
  assert.ok(order('settle:GY-84:done') >= 0, `the dead session was reclaimed: ${kinds.join(', ')}`);
  assert.equal(kinds.filter(entry => entry === 'dispatch:GY-84:done').length, 4, 'every attempt was dispatched by the loop');
  assert.equal(kinds.filter(entry => entry === 'decision:GY-84:done').length, 2);
  assert.equal(kinds.filter(entry => entry === 'scope:GY-84:done').length, 1);
  assert.equal(kinds.filter(entry => entry === 'merge:GY-84:done').length, 1);
  assert.ok(order('settle:GY-84:done') < order('decision:GY-84:done'), 'the reclaim came before the rework rounds');
  assert.ok(order('decision:GY-84:done') < order('merge:GY-84:done'), 'the merge came after the rework rounds it needed');
  // Nothing in the drive was left to a person: every recorded action is the loop's own, and no
  // escalation was raised for a decision it is able to request.
  const escalations = performed.filter(action => action.kind === 'escalation');
  assert.deepEqual(escalations.map(action => action.detail), [], 'an unattended cycle escalates nothing it can decide itself');

  // The decision behind each of those rounds, read from the item alone: a verdict standing against
  // the exact head, and never a rework request while the previous attempt is still running.
  const reviewed = { ...simulation.work[0], stage: 'review' as const, reworkRequested: false, submission: { epoch: 4, pr: 100 },
    observation: { ...item.observation!, merged: false, reviews: [{ reviewer: 'graphyard-reviewer[bot]', sha: item.candidate!.sha, state: 'CHANGES_REQUESTED', submittedAt: '2031-03-01T09:20:00Z' }] } } as Work;
  assert.deepEqual(standingVerdict(reviewed), { reviewer: 'graphyard-reviewer[bot]', at: '2031-03-01T09:20:00Z', reason: `graphyard-reviewer[bot] requested changes on ${item.candidate!.sha.slice(0, 12)}` });
  assert.equal(routineDecision(reviewed, master, Date.parse('2031-03-01T09:21:00Z'))?.action, 'rework');
  const running = { ...reviewed, lease: { owner: 'claude-a-principal', epoch: 4, expiresAt: '2031-03-01T10:00:00Z' } } as Work;
  assert.equal(routineDecision(running, master, Date.parse('2031-03-01T09:21:00Z')), null, 'rework attests that the previous worker is stopped, so a live attempt is never reworked under it');

  // The passage it measured, from its own observations: one delivery, each figure inside its bound.
  const budget = latencyBudget(state.latency);
  assert.equal(budget.deliveries, 1);
  assert.ok(budget.readyToClaim.p90Ms <= latencyTargets.readyToClaimP90Ms, `ready→claim ${budget.readyToClaim.p90Ms}ms`);
  assert.equal(budget.reworkRequest.count, 1, 'the verdict round was measured from the verdict that stood; the base conflict had no verdict behind it');
  assert.deepEqual(budget.reworkRequest.breaches, [], 'each rework was requested inside the five-minute bound');
  assert.deepEqual(budget.mergeDwell.breaches, []);
});

test('integration:mergeable-dwell-budget — a candidate whose gates are green merges within five minutes of becoming mergeable and a standing verdict reaches a rework request in the same window, with p90 approval→merge inside ten minutes over more than ten deliveries; a loop that leaves one green reports the breach', async () => {
  const scripts = Array.from({ length: 11 }, (_, index) => ({ key: `GY-${200 + index}`, rounds: ['pass' as const] }));
  const simulation = plane(scripts);
  const master = config({ workers: scripts.map((_, index) => profile(`claude-${index}`)) });
  const state = emptyDaemonState(master);
  const effects = simulation.effects();
  for (let pass = 0; pass < 10 && simulation.work.some(item => item.stage !== 'done'); pass++) await cycle(state, master, simulation, effects, 2 * minute);
  await cycle(state, master, simulation, effects);

  assert.equal(simulation.work.filter(item => item.stage === 'done').length, 11, 'every item was delivered by the loop alone');
  const budget = latencyBudget(state.latency);
  assert.ok(budget.deliveries >= latencyTargets.minimumDeliveries, `${budget.deliveries} deliveries measured`);
  assert.deepEqual(budget.mergeDwell.breaches, [], 'no candidate stayed mergeable past the five-minute bound');
  assert.ok(budget.mergeDwell.count >= latencyTargets.minimumDeliveries, 'every delivery measured its mergeable dwell');
  assert.ok(budget.approvalToMerge.p90Ms <= latencyTargets.approvalToMergeP90Ms, `approval→merge p90 ${budget.approvalToMerge.p90Ms}ms exceeds the ten-minute target`);
  assert.ok(budget.approvalToMerge.p90Ms > 0, 'the measurement is of a real passage, not of a zero');
  assert.equal(budget.met, true, `budget reasons: ${budget.reasons.join('; ')}`);
  assert.deepEqual(loopAttention({ liveness: loopLiveness(state, simulation.now(), 20_000, master.hostId), budget }).filter(attention => /budget/.test(attention.text)), []);

  // The same measurement over a loop that cannot merge what is green: the dwell is the breach, it
  // names the candidate, and it reaches the attention list rather than a chart nobody reads.
  const stalled = plane([{ key: 'GY-300', rounds: ['pass'] }]);
  const stalledState = emptyDaemonState(master);
  let refuse = true;
  const stalledEffects = stalled.effects();
  const merge = stalledEffects.merge;
  stalledEffects.merge = async item => {
    if (refuse) throw new Error('Guarded merge refused: the base branch moved under the candidate');
    return merge(item);
  };
  for (let pass = 0; pass < 4; pass++) await cycle(stalledState, master, stalled, stalledEffects, 2 * minute);
  assert.ok(mergeableCandidate(stalled.work[0]), 'the candidate is green and the loop is the only thing not merging it');
  stalled.advance(30 * minute);
  refuse = false;
  await cycle(stalledState, master, stalled, stalledEffects);
  await cycle(stalledState, master, stalled, stalledEffects);
  const stalledBudget = latencyBudget(stalledState.latency);
  assert.equal(stalledBudget.met, false);
  assert.match(stalledBudget.reasons.join('; '), /GY-300 stayed mergeable for 3\d(\.\d)? min, past the 5 min bound/);
  const attention = loopAttention({ liveness: loopLiveness(stalledState, stalled.now(), 20_000, master.hostId), budget: stalledBudget });
  assert.match(attention.at(-1)!.text, /unattended delivery budget is not met/);
  assert.equal(attention.at(-1)!.role, 'master');
  assert.equal(attention.at(-1)!.human, false);
});

test('integration:no-actionable-silence — every cycle records what it could act on and what it did, the longest actionable-but-idle wait is reported, and a subject nothing has acted on for more than twenty minutes reaches the top of the attention list', async () => {
  const simulation = plane([{ key: 'GY-400', rounds: ['pass'] }]);
  // A two-minute cycle, so cycling every two simulated minutes is a healthy loop rather than a
  // stalled one: this proof is about silence in the work, not about the loop's own liveness.
  const master = config({ workers: [profile('claude-a')], run: { intervalSeconds: 120 } });
  const state = emptyDaemonState(master);
  // The one worker profile has no usable credential, so nothing can claim the ready item: the
  // pipeline has something actionable and no way to act on it, which is exactly the silence GY-84
  // is about. The loop escalates once and then has nothing left to record.
  const effects = simulation.effects({ credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: false, reason: 'Worker credential is unreadable' }])) });
  state.lock = { id: 'lock', pid: process.pid, host: master.hostId, startedAt: simulation.iso(), heartbeatAt: simulation.iso() };

  const first = await cycle(state, master, simulation, effects, minute);
  assert.equal(first.metrics.actionable, 1, 'the cycle records what it could act on, not only what it did');
  assert.deepEqual(first.silence.longest && [first.silence.longest.kind, first.silence.longest.work], ['dispatch', 'GY-400']);
  assert.match(first.silence.longest!.detail, /GY-400 is claimable and waiting for a worker/);
  assert.deepEqual(steps(first.actions), ['escalation:GY-400:done'], 'and what it did: the escalation naming the profile it cannot use');
  assert.equal(first.silence.longestIdleMs, 0, 'a subject it acted on this cycle starts its wait again');

  let last = first;
  for (let pass = 0; pass < 12; pass++) last = await cycle(state, master, simulation, effects, 2 * minute);
  assert.ok(last.silence.longestIdleMs > silenceBudgetMs, `${last.silence.longestIdleMs}ms of silence on an actionable item`);
  assert.equal(last.silence.breached, true);
  assert.equal(last.metrics.idleMs, last.silence.longestIdleMs, 'every cycle records the wait, whether or not it acted');
  const liveness = loopLiveness(state, simulation.now(), master.run.intervalSeconds * 1000, master.hostId);
  assert.equal(liveness.state, 'running', 'the loop is cycling: the silence is about the work, not about the loop');
  const attention = loopAttention({ liveness, silence: last.silence, budget: latencyBudget(state.latency) });
  assert.equal(attention[0].subject, 'GY-400');
  assert.match(attention[0].text, /Nothing has acted on GY-400 is claimable and waiting for a worker for 2\d minutes, past the 20-minute bound/);
  assert.equal(attention[0].human, false);

  // The credential comes back: the same subject is acted on, and the wait resets to zero.
  const healthy = simulation.effects();
  const acted = await cycle(state, master, simulation, healthy, minute);
  assert.ok(acted.actions.some(action => action.kind === 'dispatch' && action.state === 'done'));
  assert.equal(acted.silence.longestIdleMs, 0);
  assert.equal(acted.silence.breached, false);

  // The inventory follows the work rather than a fixed list: a claimed, submitted attempt asks
  // nothing of the dispatcher, what it is still missing is named, and a delivery asks nothing.
  const underway = actionableSubjects(master, simulation.work, simulation.now());
  assert.deepEqual(underway.map(subject => subject.kind), ['proof'], `${underway.map(subject => subject.detail).join('; ')}`);
  simulation.advance(minute); // the reviewer approves and CI reports
  simulation.advance(minute); // the producer publishes its trusted evidence
  assert.deepEqual(actionableSubjects(master, simulation.work, simulation.now()).map(subject => subject.kind), ['merge'], 'with every gate green the candidate is the loop\'s to merge');
  await cycle(state, master, simulation, healthy, minute);
  assert.equal(simulation.work[0].stage, 'done');
  assert.deepEqual(actionableSubjects(master, simulation.work, simulation.now()), [], 'a delivered item asks nothing of the loop');
});

test('integration:dispatch-latency-budget — ready work reaches a free worker inside two minutes and its first push inside fifteen, measured over ten items, and a long configured interval cannot push a claim past that bound', async () => {
  const scripts = Array.from({ length: 10 }, (_, index) => ({ key: `GY-${500 + index}`, rounds: ['pass' as const] }));
  const simulation = plane(scripts);
  const master = config({ workers: scripts.map((_, index) => profile(`claude-${index}`)) });
  const state = emptyDaemonState(master);
  const effects = simulation.effects();
  // The loop's first cycle sees ten released items and ten free profiles; each subsequent pass is
  // the worker's own work, which the push budget — not the dispatch budget — is judged on.
  for (let pass = 0; pass < 8 && simulation.work.some(item => item.stage !== 'done'); pass++) await cycle(state, master, simulation, effects, 3 * minute);
  await cycle(state, master, simulation, effects);

  assert.equal(simulation.work.filter(item => item.stage === 'done').length, 10);
  const budget = latencyBudget(state.latency);
  assert.equal(budget.readyToClaim.count, 10, 'every item measured ready→claim');
  assert.ok(budget.readyToClaim.p90Ms <= latencyTargets.readyToClaimP90Ms, `ready→claim p90 ${budget.readyToClaim.p90Ms}ms exceeds two minutes`);
  assert.equal(budget.readyToFirstPush.count, 10);
  assert.ok(budget.readyToFirstPush.p90Ms > 0 && budget.readyToFirstPush.p90Ms <= latencyTargets.readyToFirstPushP90Ms, `ready→first push p90 ${budget.readyToFirstPush.p90Ms}ms exceeds fifteen minutes`);
  assert.equal(budget.met, true, budget.reasons.join('; '));

  // A fifteen-minute interval is an idle cadence, never a bound on how long ready work may sit:
  // with anything actionable the loop comes back inside the responsive window.
  assert.equal(cycleDelay(900_000, { actionable: 1 }), 30_000);
  assert.equal(cycleDelay(10_000, { actionable: 3 }), 10_000, 'a shorter configured interval still wins');
  assert.equal(cycleDelay(900_000, { actionable: 0 }), 900_000);
  assert.equal(cycleDelay(900_000, null), 900_000);
});

test('integration:loop-liveness — an absent or stalled loop is the top attention item with the command that restarts it, the loop keeps its supervisor\'s watchdog fed per cycle, and the packaged unit restarts it without a person', async () => {
  const master = config({ workers: [] });
  const intervalMs = master.run.intervalSeconds * 1000;
  const now = clockStart + 10 * minute;
  const state = emptyDaemonState(master);

  // Nothing has ever cycled: no other attention item on the list would say why.
  const absent = loopLiveness(state, now, intervalMs, master.hostId);
  assert.equal(absent.state, 'absent');
  assert.match(absent.detail, /No master loop holds this repository and none has ever cycled/);
  assert.match(absent.restart, /^graphyard master restart/);
  const absentItems = loopAttention({ liveness: absent });
  assert.equal(absentItems[0].subject, 'loop');
  assert.equal(absentItems[0].role, 'master');
  assert.equal(absentItems[0].human, false);
  assert.match(absentItems[0].next, /graphyard master restart/);
  assert.match(absentItems[0].next, /systemctl --user restart graphyard-master/);

  // A lock whose process is gone on this host is an absence, not a stall.
  state.lock = { id: 'lock', pid: 2 ** 22 - 1, host: master.hostId, startedAt: new Date(clockStart).toISOString(), heartbeatAt: new Date(now - minute).toISOString() };
  state.lastCycleAt = new Date(now - minute).toISOString();
  state.cycle = 12;
  assert.equal(loopLiveness(state, now, intervalMs, master.hostId).state, 'absent');
  assert.match(loopLiveness(state, now, intervalMs, master.hostId).detail, /names a process that is gone/);

  // A live process that has not completed a cycle for more than two intervals is stalled.
  state.lock = { ...state.lock, pid: process.pid };
  assert.equal(loopLiveness(state, now, intervalMs, master.hostId).state, 'stalled');
  const stalled = loopAttention({ liveness: loopLiveness(state, now, intervalMs, master.hostId) });
  assert.match(stalled[0].text, /has not completed a cycle for 60s, past the two-interval bound of 40s/);
  assert.match(stalled[0].next, /graphyard master restart/);
  // Inside two intervals it is simply running, and raises nothing.
  state.lastCycleAt = new Date(now - 30_000).toISOString();
  assert.equal(loopLiveness(state, now, intervalMs, master.hostId).state, 'running');
  assert.deepEqual(loopAttention({ liveness: loopLiveness(state, now, intervalMs, master.hostId) }), []);
  // The same judgement reaches `master status` through the daemon summary it reads.
  const summary = daemonSummary(state, now, intervalMs, master.hostId);
  assert.equal(summary.liveness.state, 'running');
  assert.equal(summary.silence.actionable, 0);
  assert.equal(summary.budget.met, null, 'no delivery measured yet');

  // Self-healing: under a supervisor that watches for keep-alives, the loop reports ready once and
  // alive after every completed cycle, so a cycle that hangs becomes a restart.
  const simulation = plane([{ key: 'GY-600', rounds: ['pass'] }]);
  const notified: string[] = [];
  const log: string[] = [];
  const supervised = emptyDaemonState(master);
  await runDaemon(master, supervised, simulation.effects({ notify: signal => { notified.push(signal); } }), {
    once: true, intervalMs, identity: { pid: process.pid, host: master.hostId }, now: simulation.now, log: line => log.push(line), signals: [],
    environment: { NOTIFY_SOCKET: '/run/user/1000/systemd/notify', WATCHDOG_USEC: String(180 * 1_000_000) },
  });
  assert.deepEqual(notified, ['ready', 'alive']);
  assert.match(log.join('\n'), /cycle 0 complete in \d+ms; 1 open, 1 actionable, \d+ action\(s\)/, 'the cycle log carries both halves');
  const unsupervised: string[] = [];
  await runDaemon(master, emptyDaemonState(master), simulation.effects({ notify: signal => { unsupervised.push(signal); } }), {
    once: true, intervalMs, identity: { pid: process.pid, host: master.hostId }, now: simulation.now, log: () => {}, signals: [], environment: {},
  });
  assert.deepEqual(unsupervised, [], 'a loop nobody supervises talks to no supervisor');

  // A watchdog window that would restart a healthy loop mid-cycle is named, not obeyed silently.
  assert.deepEqual(watchdogPlan({}, intervalMs), { supervised: false, windowMs: null, refusal: null });
  assert.equal(watchdogPlan({ NOTIFY_SOCKET: '/run/notify', WATCHDOG_USEC: String(180 * 1_000_000) }, intervalMs).refusal, null);
  const tight = watchdogPlan({ NOTIFY_SOCKET: '/run/notify', WATCHDOG_USEC: String(30 * 1_000_000) }, intervalMs);
  assert.match(tight.refusal!, /watchdog window \(30s\) is not longer than two cycle intervals \(40s\)/);
  const noted = emptyDaemonState(master);
  await runDaemon(master, noted, simulation.effects(), { once: true, intervalMs, identity: { pid: process.pid, host: master.hostId }, now: simulation.now, log: () => {}, signals: [],
    environment: { NOTIFY_SOCKET: '/run/notify', WATCHDOG_USEC: String(30 * 1_000_000) } });
  assert.ok(Object.values(noted.actions).some(action => action.kind === 'escalation' && /watchdog window/.test(action.detail)), 'the mismatch is recorded where master status reads it');

  // The report `master status` prints puts it first, ahead of every work item, and counts it.
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-loop-'));
  const root = await mkdtemp(join(tmpdir(), 'graphyard-loop-root-'));
  try {
    const credential = join(directory, 'coordinator.token');
    await writeFile(credential, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    execFileSync('git', ['init', '-q', root]);
    const reported = config({ credentialFile: credential, workers: [] });
    await writeDaemonState(reported, emptyDaemonState(reported));
    const masterApi = async (path: string) => path === 'work-snapshot' ? { work: [], now: new Date().toISOString() } : { decisions: [] };
    const report = await masterStatusReport(root, reported, masterApi, { actor: { id: 'coordinator-1' } }, { commit: null });
    assert.equal(report.attentionItems[0].subject, 'loop', `the top attention item: ${JSON.stringify(report.attentionItems[0])}`);
    assert.match(report.attentionItems[0].text, /No master loop holds this repository/);
    assert.match(report.attentionItems[0].next, /graphyard master restart/);
    assert.equal(report.counts.attention, 1, 'and it is counted, so a quiet installation is not reported as all clear');
    assert.equal((report.daemon as { liveness: { state: string } }).liveness.state, 'absent');
  } finally { await rm(directory, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }

  // And the packaged deployment restarts the loop on its own, however it stopped.
  const unit = await readFile(new URL('../examples/master/graphyard-master.service', import.meta.url), 'utf8');
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^RestartSec=\d+$/m);
  // In [Unit]: in [Service] systemd ignores it, and a crash loop would be left dead.
  const sections = Object.fromEntries(unit.split(/^\[(\w+)\]$/m).slice(1).reduce<[string, string][]>((pairs, part, index, parts) => index % 2 ? [...pairs, [parts[index - 1], part]] : pairs, []));
  assert.match(sections.Unit, /^StartLimitIntervalSec=0$/m);
  assert.match(sections.Service, /^NotifyAccess=all$/m);
  const window = Number(/^WatchdogSec=(\d+)$/m.exec(sections.Service)![1]) * 1000;
  assert.ok(window > 2 * intervalMs, `the packaged watchdog window ${window}ms must exceed two default intervals`);
  assert.equal(watchdogPlan({ NOTIFY_SOCKET: '/run/notify', WATCHDOG_USEC: String(window * 1000) }, intervalMs).refusal, null, 'the packaged unit and the default interval agree');
});
