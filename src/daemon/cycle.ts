// Concern: one coordination cycle — the snapshot it reads, the order of its steps, and its measures.
import type { Work } from '../model.js';
import type { MasterConfig, WorkerProfile, HerdrAgent } from '../master.js';
import { cycleMetricsSchema, type CycleStepName, type DaemonAction, type DaemonActionKind, type DaemonState, emptyCycleSteps, message, pruneDaemonState } from './state.js';
import { reconcilePendingActions } from './reconcile.js';
import { setAsideFollowUpThreads } from './decisions.js';
import { actionableSubjects, latencyBudget, observeItemClock, stageMetrics, trackSilence } from './metrics.js';
import { profileHealth } from './sessions.js';
import { boundedPersist } from './liveness.js';
import { type DaemonEffects, record } from './effects.js';
import { closeStep } from './cycle-sessions.js';
import { scopeStep, successorStep } from './cycle-scope.js';
import { reclaimStep } from './cycle-reclaim.js';
import { dispatchStep } from './cycle-dispatch.js';
import { decisionStep } from './cycle-decisions.js';
import { deploymentStep, mergeStep, shepherdStep } from './cycle-delivery.js';
import { faultStep } from './faults.js';

/**
 * One coordination cycle: close finished sessions, reclaim the disk finished assignments hold,
 * dispatch claimable work to a healthy profile, shepherd reviews and proofs, invoke only the
 * guarded merge, verify the deployed SHA, and measure the stages. The cursor is persisted before and after every external action, so a kill between
 * them leaves an entry the next start reconciles against Graphyard instead of repeating.
 */
export async function runCycle(config: MasterConfig, state: DaemonState, unbounded: DaemonEffects, now: () => number = Date.now) {
  const effects = boundedPersist(unbounded);
  const startedAt = now();
  const read = await effects.snapshot();
  const readAt = now();
  // Filing runs in the dispatcher, beside this cycle: an approval it has not yet reconciled still
  // sets its threads aside, so the cycle never sends a head back over what that review filed.
  const snapshot = setAsideFollowUpThreads(read, await effects.followUpThreads?.(read.work, Number.isFinite(Date.parse(read.now)) ? Date.parse(read.now) : readAt).catch(() => undefined));
  const observedAt = Date.parse(snapshot.now), clock = Number.isFinite(observedAt) ? observedAt : startedAt;
  // The same bound `master status` uses, from the read that produced this snapshot: containment
  // settlement may only be proposed while the local clock can be compared with the control plane.
  const clockOffset = { min: Math.round(startedAt - clock), max: Math.round(readAt - clock) };
  const performed: DaemonAction[] = [];
  const resumed = reconcilePendingActions(state, snapshot.work, clock);
  if (resumed.length) { performed.push(...resumed); await effects.persist(state); }
  // One item's failure is that item's failed action, never the cycle's (GY-187). Each step handles
  // its items one at a time inside this: a throw — a malformed field, an effect that failed outside
  // its own try, a value no step anticipated — is recorded against the item it was handling, and
  // the step goes on to the next item. Only the cycle-wide reads (the snapshot, Herdr, credentials)
  // and a cursor that cannot be written fail the cycle. A body's result is passed back.
  const isolate = async <T>(kind: DaemonActionKind, item: Work | null, name: string, body: () => Promise<T>): Promise<T | undefined> => {
    try { return await body(); }
    catch (error) {
      const key = `isolated:${kind}:${item?.id ?? name}`;
      performed.push(await record(state, key, { kind, work: item?.key ?? null, principal: null, state: 'failed', epoch: item?.epoch ?? null,
        detail: `Handling ${name} in the ${kind} step threw, so only its own action failed and the cycle went on with every other item: ${message(error)}`,
        attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      return undefined;
    }
  };
  // Where this cycle's time goes. Each `spent` closes the step that just ran with its wall time
  // and, of that, the time at least one child process was in flight (the runner's ledger, drained
  // at the boundary), so the cycle can say which step outgrew the interval and whether that step
  // was computing or waiting on Herdr, gh or git.
  const steps = emptyCycleSteps();
  let stepStartedAt = startedAt;
  const spent = (step: CycleStepName) => {
    const at = now(), ms = Math.max(0, at - stepStartedAt);
    steps[step].ms += ms; steps[step].childWaitMs += Math.min(ms, Math.max(0, Math.round(effects.childWaits?.() ?? 0)));
    stepStartedAt = at;
  };
  spent('observe');

  const agents = await effects.agents();
  const credentials = await effects.credentials(config.workers);
  const open = snapshot.work.filter(item => item.stage !== 'done');
  const owns = (principal: string) => open.some(item => !!item.lease && item.lease.owner === principal && Date.parse(item.lease.expiresAt) > clock);
  /** The item a worker profile holds a live lease on, which a failure while handling that profile is recorded against. */
  const heldBy = (profile: WorkerProfile) => open.find(item => !!item.lease && item.lease.owner === profile.principal && Date.parse(item.lease.expiresAt) > clock) ?? null;

  const cycle: Cycle = { config, state, effects, now, snapshot, clock, clockOffset, performed, isolate, agents, credentials, open, owns, heldBy };
  await closeStep(cycle);

  // A pane this cycle just closed frees its profile, so health is read after the closures.
  const health = profileHealth(config.workers, credentials, await effects.agents(), state, clock);

  spent('close');

  const { settled, budget } = await scopeStep(cycle);
  // 2c. Open items planning a file the base split or renamed are re-planned onto its successors.
  await successorStep(cycle);
  spent('decisions');

  const assessments = await reclaimStep(cycle);
  spent('close');

  const capacity = await dispatchStep(cycle, health, assessments);
  spent('dispatch');

  await decisionStep(cycle, settled, assessments, capacity);
  spent('decisions');

  await shepherdStep(cycle);
  spent('dispatch');

  await mergeStep(cycle);
  spent('merge');

  await deploymentStep(cycle);
  // 7b. Classify what is wrong and file one item per recurring class (GY-173). It shares the
  //     deployment step's clock: it reads the same snapshot and makes at most one call per class.
  await faultStep(cycle, assessments);
  spent('deployment');

  // 8. Measure. Every cycle records stage p50/p90 whether or not it acted, what it could have
  //    acted on and how long the longest of those has waited, and the passage of every item it
  //    watches: ready→claim, ready→first push, approval→merge and how long a mergeable candidate
  //    stayed mergeable. All of it from the snapshot this cycle acted on, so no figure can
  //    disagree with the state that produced it.
  for (const item of snapshot.work) {
    const sample = observeItemClock(state, item, clock);
    if (sample) state.latency.push(sample);
  }
  const actionable = actionableSubjects(config, snapshot.work, clock, { assessments, approvals: state.approvals });
  const silence = trackSilence(state, actionable, performed, clock);
  const { stages, lead, production, postDeploy, postDeployFailures } = stageMetrics(snapshot.work, clock);
  // The cycle's duration, and of it the time at least one child was in flight: the difference is
  // the loop's own work, which is what the liveness bound is judged on (cycleCost).
  const durationMs = Math.max(0, Math.round(now() - startedAt));
  const childWaitMs = Math.min(durationMs, Object.values(steps).reduce((total, step) => total + step.childWaitMs, 0));
  const metrics = cycleMetricsSchema.parse({ cycle: state.cycle, at: new Date(clock).toISOString(), durationMs, childWaitMs, workMs: durationMs - childWaitMs, steps, open: open.length, actions: performed.length,
    actionable: silence.actionable, idleMs: silence.longestIdleMs, stages, lead, production, postDeploy, postDeployFailures,
    scope: { count: budget.count, p50Ms: budget.p50Ms, p90Ms: budget.p90Ms }, scopeOpenMs: budget.longestOpenMs });
  state.metrics.push(metrics);
  state.cycle += 1;
  state.lastCycleAt = new Date(now()).toISOString();
  if (state.lock) state.lock = { ...state.lock, heartbeatAt: state.lastCycleAt };
  pruneDaemonState(state);
  await effects.persist(state);
  return { actions: performed, metrics, deployment: state.deployment, health, silence, budget: latencyBudget(state.latency), scope: budget };
}

/** What every step of one cycle reads: the snapshot it acts on, the cursor, and the cycle's own bookkeeping. */
export interface Cycle {
  config: MasterConfig; state: DaemonState; effects: DaemonEffects; now: () => number;
  snapshot: Awaited<ReturnType<DaemonEffects['snapshot']>>; clock: number; clockOffset: { min: number; max: number };
  performed: DaemonAction[];
  isolate: <T>(kind: DaemonActionKind, item: Work | null, name: string, body: () => Promise<T>) => Promise<T | undefined>;
  agents: HerdrAgent[]; credentials: Awaited<ReturnType<DaemonEffects['credentials']>>; open: Work[];
  owns: (principal: string) => boolean; heldBy: (profile: WorkerProfile) => Work | null;
}
