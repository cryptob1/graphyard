import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionableSubjects, cycleDelay, daemonSummary, emptyDaemonState, loopAttention, loopLiveness, mergeableCandidate, neededRework, progressAttention, runCycle, runDaemon, standingVerdict, watchdogPlan, writeDaemonState, type DaemonAction, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema, type MasterConfig, type MasterRun, type WorkerProfile } from '../src/master.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { installUnitsFile, perInstallUnits } from '../src/install/units.js';
// Time-bomb allowance (GY-1694): the 2031-03-01 clockStart is the loop's injected now and every verdict/lease instant and loopLiveness call takes it explicitly; new Date() only stamps an empty snapshot for a lockless status.

/**
 * GY-84: the loop drives every routine step unattended.
 *
 * These proofs run the real cycle against a simulated control plane and a simulated outside world:
 * the launcher claims, the worker pushes and submits, CI and the reviewer land verdicts on the exact
 * head, and GitHub merges the candidate whose gates are green. A head nothing can carry forward goes
 * back to a worker through the loop's own rework, applied at once with the master's identity. Nothing
 * in the harness makes a decision for the loop, and no step waits for a human: what the loop does not
 * do itself does not happen.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clockStart = Date.parse('2031-03-01T09:00:00Z');
const hex = (seed: string) => createHash('sha1').update(seed).digest('hex');
/** An id shaped like the server's UUIDs. */
const uuid = (seed: string) => hex(seed).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5');
const minute = 60_000;

function config(overrides: Partial<Omit<MasterConfig, 'run'>> & { run?: Partial<MasterRun> } = {}): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', operatorAgent: { id: 'graphyard-master-operator', credentialFile: '/outside/coordinator-operator.token' }, ...overrides,
    run: { proofWorkflow: 'acceptance.yml', ...overrides.run } });
}
const profile = (name: string, overrides: Partial<WorkerProfile> = {}): WorkerProfile =>
  ({ name, principal: `${name}-principal`, agentName: `agent-${name}`, mode: 'launch', kind: 'claude', credentialFile: `/outside/${name}.token`, agentArgs: [], environment: {}, ...overrides }) as WorkerProfile;

/** What the outside world does with one attempt: the session dies, the head is judged, or both. */
type Round = 'die' | 'changes' | 'conflict' | 'pass';
interface Script { key: string; rounds: Round[] }

/**
 * The simulated control plane. It holds work documents, recomputes gates and stage from them
 * exactly as the engine's order does, and applies the mutations the loop's effects ask for —
 * a claim, a rework. Between cycles `advance` runs everyone else: the launched worker, CI, the
 * reviewer, and GitHub merging what is green (GY-1235: the loop never merges).
 */
function plane(scripts: Script[], options: { hostId?: string; delivered?: number } = {}) {
  const hostId = options.hostId ?? 'machine-a';
  /** GitHub's side: whether it merges a green candidate on the next tick, or holds it (a queue that does not move). */
  const github = { merging: true };
  let now = clockStart;
  const iso = (at: number = now) => new Date(at).toISOString();
  const scripted = (item: Work) => scripts.some(entry => entry.key === item.key);
  const work: Work[] = scripts.map((script, index) => ({
    id: `id-${script.key}`, key: script.key, title: `Deliver ${script.key}`, description: '', type: 'feature', priority: 2,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Proven end to end', proofs: ['integration:loop'] }],
    policy: { checks: ['test'], review: true }, 
    stage: 'ready', revision: 1, policyRevision: 1, createdAt: iso(now - 30 * minute), updatedAt: iso(), stageEnteredAt: iso(now - minute),
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [],
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }],
    pr: 100 + index,
  } as unknown as Work));
  // The ledger an installation already holds: items delivered before this loop ever watched them,
  // reported the way the control plane reports a delivery — a submission, no rework requested,
  // every gate passing — which is exactly what an open, approved, mergeable candidate looks like.
  for (let index = 0; index < (options.delivered ?? 0); index++) {
    const key = `GY-${index + 1}`, sha = hex(`${key}-1`), baseSha = hex(`base-${key}`), mergedAt = iso(now - (index + 1) * 60 * minute);
    const candidate = { sha, baseSha, pr: index + 1, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker', createdAt: mergedAt };
    work.push({ ...work[0], id: `id-${key}`, key, title: `Deliver ${key}`, stage: 'done', stageEnteredAt: mergedAt, epoch: 1,
      candidate, submission: { epoch: 1, pr: index + 1 }, lastAssignment: { owner: 'graphyard-claude-0', epoch: 1, claimedAt: mergedAt },
      observation: { candidate, checks: [], reviews: [{ reviewer: 'graphyard-reviewer[bot]', sha, state: 'APPROVED', submittedAt: mergedAt }], merged: true, mergeSha: hex(`merge-${key}`), mergedAt,
        mergeable: true, protected: true, files: [], at: mergedAt, baseTip: baseSha, baseTipContained: true, prState: 'closed', draft: false },
      delivery: { mergedAt, mergedAtRepository: mergedAt, mergeSha: hex(`merge-${key}`), authorizationRevision: 1 }, pr: index + 1 } as unknown as Work);
  }
  /** Every rework the loop applied, per item, with the reason it gave. */
  const reworks = new Map<string, { reason: string; at: string }[]>();
  /** How many of the next rework requests the server refuses. */
  const refusals = { rework: 0 };
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
    const gates = [
      { name: 'ready', reasons: [...(item.ready ? [] : ['Not released from backlog']), ...(item.blocker ? [item.blocker] : [])] },
      { name: 'build', reasons: [...(submitted ? [] : ['Worker has not submitted implementation for this attempt']), ...(conflict ? [conflict] : [])] },
      { name: 'review', reasons: [...(approved ? [] : ['Independent approval of the current commit is required']), ...(changes ? ['Outstanding change requests must be resolved through a new review'] : [])] },
      { name: 'test', reasons: checks.map(name => `Required CI check ${name} has not passed on the current candidate`) },
      // No acceptance gate and no freshness bound (GY-1235): proofs gate nothing, and GitHub merges.
      { name: 'merge', reasons: [...(current ? [] : ['The merge writer has not observed the current candidate']), ...(observation?.mergeable === false ? ['Pull request is not mergeable against the current base'] : [])] },
    ].map(gate => ({ name: gate.name, passed: !gate.reasons.length, reasons: gate.reasons }));
    if (item.stage === 'done') { item.gates = gates.map(gate => ({ ...gate, passed: true, reasons: [] })); return; }
    const failing = gates.find(gate => !gate.passed);
    const stage = (failing?.name ?? 'merge') as Work['stage'];
    if (stage !== item.stage) { item.stage = stage; item.stageEnteredAt = iso(); }
    item.gates = gates;
  };
  /** GitHub merges a candidate on CI and review, and the engine records the delivery it observes. */
  const githubMerge = (item: Work) => {
    const mergedAt = iso(), mergeSha = hex(`merge-${item.key}-${item.epoch}`);
    item.observation = { ...item.observation!, merged: true, mergeSha, mergedAt, prState: 'closed', at: mergedAt } as Work['observation'];
    item.delivery = { mergedAt, mergedAtRepository: mergedAt, mergeSha, authorizationRevision: item.revision } as Work['delivery'];
    item.stage = 'done'; item.stageEnteredAt = mergedAt;
    recompute(item);
  };
  for (const item of work) recompute(item);

  const push = (item: Work) => {
    const sha = hex(`${item.key}-${item.epoch}`), baseSha = hex(`base-${item.key}`);
    const pr = (item as unknown as { pr: number }).pr;
    item.candidate = { sha, baseSha, pr, branch: `graphyard/${item.key.toLowerCase()}-${item.epoch}`, author: 'worker', createdAt: iso() };
    item.submission = { epoch: item.epoch, pr };
    item.reworkRequested = false;
    item.observation = { candidate: item.candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
      files: [`src/${item.key.toLowerCase()}.ts`], at: iso(), baseTip: baseSha, baseTipContained: true, prState: 'open', draft: false } as Work['observation'];
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
      // The reviewer approves and CI reports: every gate is green.
      verdict('APPROVED');
      item.observation!.checks = item.policy.checks.map(name => ({ name, result: 'success', appId: 1234 }));
    }
    recompute(item);
  };
  /** The control plane's side of a rework, exactly as the engine applies it. The engine's `rework` leaves `baseRefresh` alone: a conflict keeps matching the head it was found on until a worker pushes a new one. */
  const rework = (item: Work, reason: string) => {
    reworks.set(item.id, [...reworks.get(item.id) ?? [], { reason, at: iso() }]);
    item.reworkRequested = true; item.lease = null; judged.set(item.key, 0);
    recompute(item);
  };

  const advance = (ms: number) => {
    now += ms;
    // GitHub merges what was green when the loop last looked, so the loop sees each candidate mergeable once.
    if (github.merging) for (const item of work) if (item.stage === 'merge' && !item.observation?.merged && item.gates.every(gate => gate.passed) && !item.violations.length) githubMerge(item);
    for (const item of work) {
      if (item.stage === 'done') continue;
      const live = !!item.lease && Date.parse(item.lease.expiresAt) > now;
      const submitted = !!item.submission && !item.reworkRequested && item.submission.epoch === item.epoch;
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
      // A claim leaves `reworkRequested` standing, as the engine does: only the round's own
      // submission clears it, so a round whose worker dies before pushing is still a requested round.
      // A session that dies stops renewing: its lease lapses a minute later and the attempt is over.
      if (round(target) === 'die') target.lease = { ...target.lease, expiresAt: iso(now + minute) };
      recompute(target);
    },
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: iso(clockStart), reason: 'No deployment endpoint is configured in this exercise', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    // The master's operator-agent rework (POST work/:id/rework), applied by the server at once.
    rework: async (item, reason) => {
      if (refusals.rework > 0) { refusals.rework--; throw new Error(`Graphyard refused work/${item.id}/rework (503): the control plane is restarting`); }
      rework(find(item.id), reason);
      return {};
    },
    persist: async () => {},
    ...overrides,
  });

  return { work, reworks, refusals, effects, recompute, advance, find, github, now: () => now, iso, hostId,
    set: (at: number) => { now = at; } };
}

/** Run one cycle of the real loop against the simulation, then let the outside world act. */
async function cycle(state: DaemonState, master: MasterConfig, simulation: ReturnType<typeof plane>, effects: DaemonEffects, advanceMs = minute) {
  const result = await runCycle(master, state, effects, simulation.now);
  simulation.advance(advanceMs);
  return result;
}
const steps = (actions: DaemonAction[]) => actions.filter(action => action.kind !== 'deployment').map(action => `${action.kind}:${action.work ?? '-'}:${action.state}`);

test('integration:unattended-full-cycle — with no master session and no human input the loop drives one item from ready to delivered: it dispatches, redispatches after a dead session, returns the head to a worker after a verdict and after a base conflict, and leaves the candidate whose gates are green to GitHub to merge', async () => {
  // Attempt 1's session dies and its lease lapses; attempt 2 is told to change the work; attempt 3
  // hits a base branch Graphyard cannot merge in; attempt 4 delivers. Every step between them is the loop's to take.
  const master = config({ workers: [profile('claude-a'), profile('claude-b')] });
  const simulation = plane([{ key: 'GY-84', rounds: ['die', 'changes', 'conflict', 'pass'] }]);
  const state = emptyDaemonState(master);
  const effects = simulation.effects();
  const performed: DaemonAction[] = [];
  const item = simulation.work[0];
  for (let pass = 0; pass < 40 && item.stage !== 'done'; pass++) performed.push(...(await cycle(state, master, simulation, effects)).actions);
  // One more cycle so the delivery is sampled from the snapshot that shows it delivered.
  performed.push(...(await cycle(state, master, simulation, effects)).actions);

  assert.equal(item.stage, 'done', 'the item reached delivery with no master session and no human input');
  assert.equal(item.epoch, 4, 'four attempts: the dead session, the rework round, the base conflict, and the delivered one');

  // Exactly the routine reworks the criteria name, each applied by the loop itself.
  const applied = simulation.reworks.get(item.id)!;
  assert.equal(applied.length, 2, 'one rework for the verdict, one for the base conflict');
  assert.match(applied[0].reason, /graphyard-reviewer\[bot\] requested changes on [0-9a-f]{12}/);
  assert.match(applied[1].reason, /merge conflict with the base branch/);

  const kinds = steps(performed);
  assert.equal(kinds.filter(entry => entry === 'dispatch:GY-84:done').length, 4, 'every attempt was dispatched by the loop');
  assert.equal(performed.filter(action => action.kind === 'judgement' && /^Returned GY-84 to a worker: /.test(action.detail)).length, 2, 'one rework per round');
  assert.deepEqual(kinds.filter(entry => entry.startsWith('merge:')), [], 'GitHub merged the green candidate; the loop merges nothing (GY-1235)');
  assert.equal(item.delivery?.mergeSha, hex('merge-GY-84-4'), 'the delivery is the fourth attempt\'s, after the rework rounds it needed');
  // Nothing in the drive was left to a person: every recorded action is the loop's own.
  const escalations = performed.filter(action => action.kind === 'attention');
  assert.deepEqual(escalations.map(action => action.detail), [], 'an unattended cycle escalates nothing it can do itself');

  // The rework behind each of those rounds, read from the item alone: a verdict standing against the exact head.
  const reviewed = { ...simulation.work[0], stage: 'review' as const, reworkRequested: false, submission: { epoch: 4, pr: 100 },
    observation: { ...item.observation!, merged: false, reviews: [{ reviewer: 'graphyard-reviewer[bot]', sha: item.candidate!.sha, state: 'CHANGES_REQUESTED', submittedAt: '2031-03-01T09:20:00Z' }] } } as Work;
  assert.deepEqual(standingVerdict(reviewed), { reviewer: 'graphyard-reviewer[bot]', at: '2031-03-01T09:20:00Z', reason: `graphyard-reviewer[bot] requested changes on ${item.candidate!.sha.slice(0, 12)}` });
  assert.equal(neededRework(reviewed)?.binding, `${item.candidate!.sha}:verdict:graphyard-reviewer[bot]`);
});

test('integration:no-actionable-silence — every cycle records what it could act on and what it did, an actionable item stays named while nothing can act on it', async () => {
  const simulation = plane([{ key: 'GY-400', rounds: ['pass'] }]);
  // A two-minute cycle, so cycling every two simulated minutes is a healthy loop rather than a
  // stalled one: this proof is about the work standing still, not about the loop's own liveness.
  // The loop runs from a fixture checkout that records its units, so the harness remedy validates it and, with no Claude settings installed, has nothing to journal (GY-1662).
  const recorded = await temporaryDirectory('silence-checkout');
  await mkdir(join(recorded, '.graphyard'), { recursive: true });
  await writeFile(join(recorded, installUnitsFile), JSON.stringify(perInstallUnits('owner/project')));
  const master = config({ cliPath: join(recorded, 'bin/graphyard.mjs'), workers: [profile('claude-a')], run: { intervalSeconds: 120 } });
  const state = emptyDaemonState(master);
  // The one worker profile has no usable credential, so nothing can claim the ready item: the
  // pipeline has something actionable and no way to act on it, which is exactly the silence GY-84
  // is about. The loop escalates once and then has nothing left to record.
  const effects = simulation.effects({ credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: false, reason: 'Worker credential is unreadable' }])) });
  state.lock = { id: 'lock', pid: process.pid, host: master.hostId, startedAt: simulation.iso(), heartbeatAt: simulation.iso() };

  const first = await cycle(state, master, simulation, effects, minute);
  assert.equal(first.metrics.actionable, 1, 'the cycle records what it could act on, not only what it did');
  // The subject the wake reads names the item and what holds it, for as long as nothing can act.
  assert.deepEqual(actionableSubjects(master, simulation.work, simulation.now()).map(subject => [subject.kind, subject.work]), [['dispatch', 'GY-400']]);
  assert.match(actionableSubjects(master, simulation.work, simulation.now())[0].detail, /GY-400 is claimable and waiting for a worker/);
  assert.deepEqual(steps(first.actions), ['attention:GY-400:done'], 'and what it did: the attention line naming the profile it cannot use');

  let last = first;
  // Over an hour of stillness: the progress watchdog's bound, not the responsive cadence's.
  for (let pass = 0; pass < 32; pass++) last = await cycle(state, master, simulation, effects, 2 * minute);
  assert.equal(last.metrics.actionable, 1, 'the item is still measured while nothing can act on it');
  const liveness = loopLiveness(state, simulation.now(), master.run.intervalSeconds * 1000, master.hostId);
  assert.equal(liveness.state, 'running', 'the loop is cycling: the stillness is in the work, not in the loop');
  // The progress watchdog (GY-1980) is the one bound over stillness now: one line naming the item.
  const attention = progressAttention(simulation.work, null, simulation.now());
  assert.equal(attention.length, 1);
  assert.equal(attention[0].subject, 'GY-400');
  assert.match(attention[0].text, /Nothing has progressed for \d+ minutes \(since \d{4}-.*\): GY-400 has been in build since/);
  assert.equal(attention[0].human, false);

  // The credential comes back: the same subject is acted on, and the watchdog's oldest-open-item
  // instant moves with it.
  const healthy = simulation.effects();
  const acted = await cycle(state, master, simulation, healthy, minute);
  assert.ok(acted.actions.some(action => action.kind === 'dispatch' && action.state === 'done'));

  // The inventory follows the work rather than a fixed list: a claimed, submitted attempt asks
  // nothing of the dispatcher, what it is still missing is named, and a delivery asks nothing.
  // Since GY-1235 no head owes the loop a proof and a green candidate is GitHub's to merge.
  const underway = actionableSubjects(master, simulation.work, simulation.now());
  assert.deepEqual(underway.map(subject => subject.kind), [], `${underway.map(subject => subject.detail).join('; ')}`);
  simulation.github.merging = false;
  simulation.advance(minute); // the reviewer approves and CI reports
  assert.ok(mergeableCandidate(simulation.work[0]));
  assert.deepEqual(actionableSubjects(master, simulation.work, simulation.now()), [], 'with every gate green the candidate is GitHub\'s to merge, not the loop\'s');
  simulation.github.merging = true;
  await cycle(state, master, simulation, healthy, minute);
  assert.equal(simulation.work[0].stage, 'done');
  assert.deepEqual(actionableSubjects(master, simulation.work, simulation.now()), [], 'a delivered item asks nothing of the loop');
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
  // Read from the host's PID namespace, where a pid it cannot see is gone (GY-1369).
  const hostReader = (pid: number) => pid === process.pid;
  assert.equal(loopLiveness(state, now, intervalMs, master.hostId, hostReader).state, 'absent');
  assert.match(loopLiveness(state, now, intervalMs, master.hostId, hostReader).detail, /names a process that is gone/);

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
  assert.match(log.join('\n'), /cycle 0 complete in \d+ms \(\d+ms waiting on child processes\); 1 open, 1 actionable, \d+ action\(s\)/, 'the cycle log carries both halves');
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
  assert.ok(Object.values(noted.actions).some(action => action.kind === 'attention' && /watchdog window/.test(action.detail)), 'the mismatch is recorded where master status reads it');

  // The report `master status` prints puts it first, ahead of every work item, and counts it.
  const directory = await temporaryDirectory('loop');
  const root = await temporaryDirectory('loop-root');
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

test('a rework the server refuses is applied again on a later cycle, and automatic merging off asks for no merge', async () => {
  const master = config({ workers: [profile('claude-a')], autoMerge: false });
  const simulation = plane([{ key: 'GY-701', rounds: ['changes', 'pass'] }]);
  const state = emptyDaemonState(master), effects = simulation.effects(), item = simulation.work[0];
  while (!standingVerdict(item)) await cycle(state, master, simulation, effects);
  // The server refuses the first rework: a failed action, retried on the widening interval of any failed action.
  simulation.refusals.rework = 1;
  const performed: DaemonAction[] = [];
  for (let pass = 0; pass < 12 && !item.reworkRequested && item.epoch === 1; pass++) performed.push(...(await cycle(state, master, simulation, effects)).actions);
  assert.ok(performed.some(action => action.kind === 'judgement' && action.state === 'failed' && /Could not return GY-701 to a worker: .*503/.test(action.detail)), performed.map(action => action.detail).join('\n'));
  assert.equal(simulation.reworks.get(item.id)!.length, 1, 'applied once the server accepts it');
  assert.match(simulation.reworks.get(item.id)![0].reason, /graphyard-reviewer\[bot\] requested changes/);

  // Automatic merging off asks for no merge since GY-1235: GitHub merges the green candidate of the
  // second attempt on its own branch protection.
  const merging: DaemonAction[] = [];
  for (let pass = 0; pass < 8 && item.stage !== 'done'; pass++) merging.push(...(await cycle(state, master, simulation, effects)).actions);
  assert.equal(item.stage, 'done', steps(merging).join(', '));
  assert.deepEqual(merging.filter(action => action.kind === 'merge'), []);

});

test('a requested round is requested once: a base conflict whose round\'s worker dies before pushing is reworked once and delivered', async () => {
  const master = config({ workers: [profile('claude-a')] });
  // A base conflict returns the head to a worker; the round's worker dies before pushing. The
  // conflict still matches that head — the engine's `rework` never clears it — but the round is
  // already requested: the loop redispatches once the dead attempt's lease lapses, and asks for nothing more.
  const simulation = plane([{ key: 'GY-720', rounds: ['conflict', 'die', 'pass'] }]);
  const state = emptyDaemonState(master), effects = simulation.effects(), item = simulation.work[0];
  const performed: DaemonAction[] = [];
  for (let pass = 0; pass < 40 && item.stage !== 'done'; pass++) performed.push(...(await cycle(state, master, simulation, effects)).actions);
  assert.equal(item.stage, 'done', steps(performed).join(', '));
  assert.equal(item.epoch, 3, 'the conflicted head, the round whose worker died, and the round that delivered');
  assert.equal(simulation.reworks.get(item.id)!.length, 1, 'one conflict, one rework');
});

test('an agent or Codex review that has not approved is not a verdict: a head not yet dispatched, one a reviewer is still working on, and one whose profiles are exhausted are asked for nothing, and only a changes-requested verdict for the exact head and request sends it back', async () => {
  const master = config({ workers: [profile('claude-a')] });

  // A worker submits. Everything the loop does next rests on what the review observation says.
  const simulation = plane([{ key: 'GY-730', rounds: ['pass'] }]);
  const item = simulation.work[0];
  await cycle(emptyDaemonState(master), master, simulation, simulation.effects());
  assert.ok(item.submission && item.candidate && !item.lease, 'the head is submitted and its worker is gone');
  const head = item.candidate!.sha, reviewer = { name: 'claude-review', runtime: 'claude', reviewerApp: 'claude-app', timeoutSeconds: 1800 };
  item.policy = { ...item.policy, reviewProvider: 'agent', reviewerProfiles: [reviewer] } as Work['policy'];
  const request = { commentId: 501, sha: head, baseSha: item.candidate!.baseSha, policyRevision: item.policyRevision, body: '@claude review', createdAt: simulation.iso(),
    provider: 'agent' as const, profile: reviewer.name, reviewerApp: reviewer.reviewerApp, marker: uuid('GY-730-request') };
  const refusal = (reason: string, extra: Record<string, unknown> = {}) => ({ provider: 'agent' as const, sha: head, approved: false, reason, profile: reviewer.name, reviewerApp: reviewer.reviewerApp, ...extra });
  const observe = (agentReview: NonNullable<Work['observation']>['agentReview'], changes: Partial<Work> = {}) => {
    Object.assign(item, { reviewRequest: null, reviewFailovers: [], ...changes });
    item.observation = { ...item.observation!, at: simulation.iso(), agentReview };
    simulation.recompute(item);
  };
  /** One cycle of the real loop from a loop that has seen nothing. */
  const run = async () => ({ actions: (await runCycle(master, emptyDaemonState(master), simulation.effects(), simulation.now)).actions });

  // Every state the observers report short of approval, as they report it (src/agent-review.ts,
  // `observeAgent` in src/github.ts). None is a verdict, and each would have read as one.
  const unreviewed: [string, () => void][] = [
    ['not dispatched', () => observe(refusal('Graphyard must dispatch a review to this profile bound to this candidate and policy'))],
    ['waiting', () => observe(refusal(`Waiting for reviewer profile ${reviewer.name} to post a verdict through its registered App`), { reviewRequest: request })],
    ['exhausted profiles', () => observe({ provider: 'agent', sha: head, approved: false, reason: 'Every configured reviewer profile is exhausted for this candidate; add reviewer capacity or select another review provider' },
      { reviewFailovers: [{ profile: reviewer.name, reviewerApp: reviewer.reviewerApp, runtime: reviewer.runtime, exhaustion: 'timeout', reason: 'no verdict', at: simulation.iso(), sha: head, baseSha: item.candidate!.baseSha, policyRevision: item.policyRevision, requestCommentId: request.commentId, nextProfile: null }] })],
  ];
  for (const [name, arrange] of unreviewed) {
    arrange();
    assert.equal(standingVerdict(item), null, `${name}: no verdict stands`);
    assert.equal(neededRework(item), null, `${name}: no rework is needed`);
    const { actions } = await run();
    assert.deepEqual(actions.filter(action => action.kind === 'judgement').map(action => action.detail), [], `${name}: the loop asks for no rework`);
    assert.equal((simulation.reworks.get(item.id) ?? []).length, 0, `${name}: and none reached the control plane`);
  }

  // The reviewer answered the recorded request and asked for changes on this exact head.
  const verdict = refusal(`Reviewer profile ${reviewer.name} requested changes; address the findings and request a fresh review`,
    { verdict: 'changes-requested', verdictId: 902, requestId: request.commentId, completedAt: '2031-03-01T09:20:00.000Z' });
  observe(verdict, { reviewRequest: request });
  assert.deepEqual(standingVerdict(item), { reviewer: reviewer.name, at: '2031-03-01T09:20:00.000Z', reason: `${reviewer.name} requested changes on ${head.slice(0, 12)}: ${verdict.reason}` });
  assert.ok(neededRework(item), 'a rework is needed');
  // It is the head's verdict only while it answers the head's request, on the head, unapproved,
  // under the provider the policy names: the same binding an approval must carry.
  observe(verdict, { reviewRequest: { ...request, commentId: 777 } });
  assert.equal(standingVerdict(item), null, 'a verdict for another request is not this head\'s');
  observe(verdict);
  assert.equal(standingVerdict(item), null, 'nor is one with no recorded request behind it');
  observe({ ...verdict, sha: hex('an-earlier-head') }, { reviewRequest: request });
  assert.equal(standingVerdict(item), null, 'nor one on another commit');
  observe({ ...verdict, provider: 'codex' }, { reviewRequest: request });
  assert.equal(standingVerdict(item), null, 'nor one from a provider the policy does not name');
  observe({ ...verdict, reason: 'did not approve: requested changes', verdict: undefined }, { reviewRequest: request });
  assert.equal(standingVerdict(item), null, 'and reason text is never read as a verdict');

  observe(verdict, { reviewRequest: request });
  const reworked = await run();
  assert.equal((simulation.reworks.get(item.id) ?? []).length, 1, steps(reworked.actions).join(', '));
  assert.match(simulation.reworks.get(item.id)![0].reason, new RegExp(`${reviewer.name} requested changes on ${head.slice(0, 12)}`));

  // Codex has the same shape (on the head before its rework): running and not dispatched are no verdict; findings on the head are.
  const codex = { ...item, reworkRequested: false, policy: { ...item.policy, reviewProvider: 'codex', reviewerProfiles: undefined }, reviewRequest: { commentId: 601, sha: head, baseSha: item.candidate!.baseSha, policyRevision: item.policyRevision, body: '@codex review', createdAt: simulation.iso() } } as Work;
  const codexReview = (reason: string, extra: Record<string, unknown> = {}) => ({ ...codex, observation: { ...codex.observation!, agentReview: { provider: 'codex' as const, sha: head, approved: false, reason, ...extra } } }) as Work;
  for (const reason of ['Graphyard must dispatch a review bound to this candidate and policy', 'Codex review changed or is running; retry', 'Codex has not completed a supported review of this candidate'])
    assert.equal(standingVerdict(codexReview(reason)), null, reason);
  assert.equal(standingVerdict(codexReview('Codex posted review findings/output for this request; fix them and request a fresh clean review', { verdict: 'changes-requested', requestId: 601, completedAt: '2031-03-01T09:25:00.000Z' }))?.reviewer, 'codex');
});
