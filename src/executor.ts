import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Work } from './model.js';
import type { ActionRow } from './model/actions.js';
import type { DispatchRequest } from './model/dispatch.js';
import { actionJudgment, type NextActionKind } from './model/next-action.js';
import type { SessionHandleInput } from './model/sessions.js';
import { registeredLaunch } from './model/session-state.js';
import { independentProducerProfiles } from './producer.js';
import { daemonSummary, profileHealth, readDaemonState, type DaemonState, type DeploymentObservation } from './master-daemon.js';
import { launchedSessionHandle, selectReviewerProfile, type ExecutorEffects, type ExecutorHandler } from './auto-dispatch.js';
import type { ExecutorRelease } from './executor-fleet.js';
import type { HerdrAgent, MasterConfig, MergeExecutor, ProducerProfile, WorkerProfile } from './master.js';
import { agentNameReadings, assertNameAvailable, attributeRefusal } from './master-resources.js';
import { agentOwner, loadMasterConfig, type AttentionItem } from './master.js';
import { loopUnitName } from './supervisor.js';
import { executorUnitDirectory } from './repository-setup.js';

/**
 * What a stateless executor actually does when it claims a row.
 *
 * `model/next-action.ts` names what an item needs; `model/actions.ts` keeps the leased row that
 * says whether anybody is doing it; `auto-dispatch.ts` runs the claim-run-settle loop. This is the
 * missing third of the inversion: the handlers that make those rows move real work. Each one takes
 * the action's typed inputs and the item it names, performs exactly the one operation the kind
 * means, and returns what it did. None of them reads a status report, decides a gate, or knows
 * that another executor exists.
 *
 * Which kinds an executor can run is decided here and nowhere else, and that is what keeps
 * AGENTS.md's rule mechanical: there is no handler for `escalate` or `request-rework`, because
 * running either *is* the judgment (`actionJudgment`), so an executor never claims one. A full
 * ready-to-delivered cycle runs with nothing but the handlers below.
 */

export interface ControlPlaneEffects {
  /** The work snapshot as the control plane reports it, with its own clock. */
  snapshot: () => Promise<{ work: Work[]; now: string }>;
  /** A coordinator-authenticated mutation against the control plane. */
  mutate: (path: string, body: unknown, requestId?: string) => Promise<any>;
  /** Herdr's agent inventory, or null when it could not be read; read asynchronously. */
  agents: () => HerdrAgent[] | null | Promise<HerdrAgent[] | null>;
  workerCredentials: (profiles: WorkerProfile[]) => Promise<Record<string, { available: boolean; reason: string | null }>>;
  producerCredentials: (profiles: ProducerProfile[]) => Promise<Record<string, { available: boolean; reason: string | null }>>;
  dispatchWorker: (work: Work, profile: WorkerProfile, agents: HerdrAgent[], snapshot: { work: Work[]; now: string }) => Promise<any>;
  launchReview: (work: Work, request: DispatchRequest, agents: HerdrAgent[], observedAt: string) => Promise<any>;
  launchProducer: (work: Work, request: DispatchRequest, profile: ProducerProfile, agents: HerdrAgent[], observedAt: string) => Promise<any>;
  /** The merge step `master run` uses: requests that GitHub merge the authorized head (GY-258); never a provider merge call. */
  merge: (work: Work) => Promise<unknown>;
  observeDeployment: (delivered: Work[]) => Promise<DeploymentObservation>;
  /** Records a launched session's durable handle on the item (AC-8). */
  recordSession?: (work: Work, handle: SessionHandleInput) => Promise<unknown>;
}

/**
 * The executor instance one executor process names on its merge requests.
 *
 * GitHub executes merges (GY-258), so the merge action only records the request that GitHub merge
 * the authorized head; the instance is the requester the ledger names. An executor mints it once per
 * process, exactly as the daemon does. A merge execution recorded before GY-258 stays owned by the
 * instance that acquired it (GY-92) and no other instance resumes it.
 */
export const executorMergeExecutor = (principal: string, instance = `executor-${randomUUID()}`): MergeExecutor => ({ principal, instance });

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** An executor holds no cool-off state of its own: a failed attempt backs off on its own action row. */
const statelessProfiles = { profiles: {} } as unknown as DaemonState;

/**
 * The handlers a control-plane executor runs: one per mechanical kind, plus the two that launch a
 * session and walk away. Every kind whose judgment happens in the step itself is absent by
 * construction, and `judgmentInExecutorLoop` below is what keeps that true as kinds are added.
 */
export function controlPlaneHandlers(config: () => MasterConfig, effects: ControlPlaneEffects): Partial<Record<NextActionKind, ExecutorHandler>> {
  const find = async (action: ActionRow) => {
    const snapshot = await effects.snapshot();
    const work = snapshot.work.find(item => item.id === action.work);
    if (!work) throw new Error(`${action.key} is not in the work snapshot this executor can read`);
    return { work, all: snapshot.work, observedAt: snapshot.now };
  };
  const herdr = async () => {
    const agents = await effects.agents();
    if (!agents) throw new Error('Herdr session inventory is unavailable; a launch needs it to keep one session per profile');
    return agents;
  };
  // Every launch below registers its session before the runtime starts and writes the coordinates
  // the launcher returns once it has (GY-172 AC-2): the session report then observes and closes it
  // like any other. A registration the control plane refuses refuses the launch.
  const record = (work: Work) => effects.recordSession ? (handle: SessionHandleInput) => effects.recordSession!(work, handle) : undefined;
  const attachTo = (pane: string) => `herdr pane attach ${pane}${config().herdrWorkspace ? ` --workspace ${config().herdrWorkspace}` : ''}`;

  const launchProof = async (action: ActionRow, work: Work, observedAt: string) => {
    if (action.inputs.kind !== 'dispatch' || action.inputs.target !== 'proof') throw new Error('unreachable');
    const { group, proofs, requestId } = action.inputs;
    const request = (work.autoDispatch?.producers ?? []).find(entry => entry.id === requestId)
      ?? (work.autoDispatch?.producers ?? []).find(entry => entry.group === group && entry.state === 'requested');
    if (!request) throw new Error(`${work.key} has no open producer request for the ${group} proof group; the control plane raises one when the candidate passes the build gate`);
    const agents = await herdr();
    const independent = independentProducerProfiles(work, config().producers);
    if (!independent.length) throw new Error(`no producer principal is independent of ${work.key}; its evidence would not be trusted`);
    const credentials = await effects.producerCredentials(independent);
    const usable = independent.filter(profile => credentials[profile.name]?.available !== false && !agents.some(agent => agent.name === profile.agentName));
    if (!usable.length) throw new Error(`every independent producer profile is busy or unavailable (${independent.map(profile => `${profile.name}: ${credentials[profile.name]?.available === false ? credentials[profile.name].reason : 'busy'}`).join('; ')})`);
    await registeredLaunch(record(work), launchedSessionHandle('proof', request, `${work.key}: ${group} proofs on ${request.sha.slice(0, 12)} (${proofs.join(', ')})`, config().hostId, undefined, usable[0].kind, config().herdrWorkspace, usable[0].principal),
      () => effects.launchProducer(work, request, usable[0], agents, observedAt).catch(error => { throw attributeRefusal(error, agentNameReadings({ producers: [usable[0]] }, agents)); }), launched => launched, attachTo);
    return `launched producer ${usable[0].name} for ${proofs.join(', ')} on ${request.sha.slice(0, 12)}`;
  };

  const launchWorker = async (action: ActionRow, work: Work, all: Work[], observedAt: string) => {
    const agents = await herdr();
    const workers = config().workers;
    const health = profileHealth(workers, await effects.workerCredentials(workers), agents, statelessProfiles, Date.parse(observedAt) || Date.now());
    const choice = health.find(entry => entry.healthy);
    if (!choice) throw new Error(`no worker profile can take ${work.key}: ${health.map(entry => `${entry.profile.name} (${entry.reason})`).join('; ') || 'no launch profile is configured'}`);
    const workspace = config().herdrWorkspace;
    await registeredLaunch(record(work), {
      // The worker session's own handle: it fills in the tab and transcript only it has, so the
      // launcher names it as the principal the handle belongs to.
      id: `${choice.profile.principal}:${work.epoch + 1}`, kind: 'implementation', principal: choice.profile.principal,
      runtime: choice.profile.kind ?? choice.profile.mode, host: config().hostId,
      ...(workspace ? { workspace } : {}),
      subject: `${work.key}: ${work.title}`.slice(0, 300), state: 'running',
    }, () => effects.dispatchWorker(work, choice.profile, agents, { work: all, now: observedAt }), launched => launched, attachTo);
    return `dispatched ${work.key} to ${choice.profile.name}; the worker launcher claimed under ${choice.profile.principal}`;
  };

  return {
    dispatch: async action => {
      const { work, all, observedAt } = await find(action);
      if (action.inputs.kind !== 'dispatch') throw new Error('unreachable');
      return action.inputs.target === 'proof' ? launchProof(action, work, observedAt) : launchWorker(action, work, all, observedAt);
    },
    'request-review': async action => {
      const { work, observedAt } = await find(action);
      if (action.inputs.kind !== 'request-review') throw new Error('unreachable');
      const request = work.autoDispatch?.review;
      if (!request || request.state !== 'requested') throw new Error(`${work.key} has no open review request; the control plane raises one for each observed head`);
      const { profile, reason } = selectReviewerProfile(config());
      if (!profile) throw new Error(reason!);
      const agents = await herdr();
      // A name every session of the profile could take is held: the namespace is at its bound,
      // and the refusal names it rather than reading as a busy reviewer (GY-132).
      assertNameAvailable('reviewer', profile, agents);
      if (agents.some(agent => agent.name === profile.agentName)) throw new Error(`reviewer agent ${profile.agentName} is busy in Herdr`);
      // A launch refused by a resource at its bound — the review ledger's cap — records that resource.
      await registeredLaunch(record(work), launchedSessionHandle('review', request, `${work.key}: review ${request.sha.slice(0, 12)} (PR #${request.pr})`, config().hostId, undefined, profile.kind, config().herdrWorkspace),
        () => effects.launchReview(work, request, agents, observedAt).catch(error => { throw attributeRefusal(error, agentNameReadings({ reviewers: [profile] }, agents)); }), launched => launched, attachTo);
      return `launched reviewer ${profile.name} on ${request.sha.slice(0, 12)}`;
    },
    'approve-scope': async action => {
      const { work } = await find(action);
      if (action.inputs.kind !== 'approve-scope') throw new Error('unreachable');
      // The control plane decides it from the item's own criteria; the executor carries no verdict.
      const decided: Work = await effects.mutate(`work/${work.id}/autoscope`, { epoch: action.inputs.epoch }, randomUUID());
      const decision = decided.scopeDecision;
      return `the widening rule decided ${work.key}'s scope request: ${decision?.state ?? 'no decision recorded'} — ${decision?.reason ?? ''}`.slice(0, 2000);
    },
    resync: async action => {
      const { work } = await find(action);
      const result = await effects.mutate(`work/${work.id}/resync`, {}, randomUUID());
      return `re-read ${work.key} from the provider and reconciled it${result?.changed ? '' : ' (nothing moved)'}`;
    },
    reclaim: async action => {
      const { work } = await find(action);
      // A lapsed lease is cleared by the control plane's own reconciliation, which explains the
      // lapse from the ledger; the executor only asks for it.
      const result = await effects.mutate(`work/${work.id}/resync`, {}, randomUUID());
      const after: Work | undefined = result?.work;
      // Reconciliation never lowers a containment fence, so an item quarantined since this row was
      // computed is still unassignable. Reporting it free would be a success about an item nothing
      // may be assigned to; the row fails with what the item actually owes, and the control plane
      // names that as an escalation rather than handing back a reclaim nothing can complete.
      if (after?.containmentQuarantine) throw new Error(`${work.key} is still fenced by unverified containment from epoch ${after.containmentQuarantine.epoch}; a quarantine is lowered by settlement or stopped-worker recovery, never by a re-read`);
      return after?.lease ? `${work.key} is still held by ${after.lease.owner} under epoch ${after.lease.epoch}` : `${work.key} is no longer held by a lapsed assignment`;
    },
    merge: async action => {
      const { work } = await find(action);
      // The step throws when it does not record the merge request, so reaching here means GitHub
      // now holds the authorized head (GY-258). What it returns is its own account — requested and
      // not yet observed, or already merged — and the row records that verbatim rather than a word
      // of the executor's own: only the observation says merged.
      const result = await effects.merge(work) as { result?: string } | undefined;
      return `${work.key}: ${result?.result ?? 'the guarded merge returned without a result of its own'}`;
    },
    'verify-deployment': async action => {
      const { work } = await find(action);
      if (action.inputs.kind !== 'verify-deployment') throw new Error('unreachable');
      const observation = await effects.observeDeployment([work]);
      if (observation.source === 'unavailable' || !observation.sha) throw new Error(observation.reason ?? `no deployment could be read for ${work.key}`);
      if (!observation.deployed.includes(work.key)) throw new Error(observation.reason ?? `the running release ${observation.sha.slice(0, 12)} does not carry ${work.key}'s merge ${action.inputs.mergeSha.slice(0, 12)} yet`);
      await effects.mutate(`work/${work.id}/deployment`, { sha: observation.sha, mergeSha: action.inputs.mergeSha, source: observation.source, observedAt: observation.at }, randomUUID());
      return `observed the release serving ${observation.sha.slice(0, 12)} for ${work.key}`;
    },
  };
}

/**
 * Why this handler set would put a judgment inside the executor loop, or null when it cannot.
 *
 * A kind whose judgment happens in the step itself (`actionJudgment`) must never have a handler:
 * configuring one would mean the loop deciding what the project reserves for an agent. Checked
 * where handlers are configured, so adding a kind cannot silently widen what an executor runs —
 * AC-5 as a rule the code enforces rather than a claim the prose makes.
 */
export function judgmentInExecutorLoop(handlers: ExecutorEffects['handlers']): string | null {
  const judgments = (Object.keys(handlers) as NextActionKind[]).filter(kind => handlers[kind] && actionJudgment[kind] === 'in-step');
  return judgments.length ? `${judgments.join(', ')} ${judgments.length === 1 ? 'is a judgment made in the step itself' : 'are judgments made in the step itself'}; an executor may start the session that makes one, never make it` : null;
}

/**
 * What an executor knows about the release it runs (GY-126).
 *
 * The modules a stateless executor imports are read once, at startup; the checkout they came from
 * keeps moving. `loaded` is the release read then, `current` re-reads the checkout's commit before
 * every claim, and the two disagreeing is the one condition under which an executor stops
 * claiming: it would otherwise run behaviour the repository no longer has, on rows the queue
 * offers it as if it were current.
 */
export interface ReleaseGuard {
  loaded: ExecutorRelease;
  /** The commit the checkout holds now, or null when it cannot be read (which is not a change). */
  current: () => string | null;
  /** Called once when the checkout has moved on: the executor records why it claims nothing more. */
  standDown: (detail: { loaded: ExecutorRelease; current: string | null; reason: string }) => Promise<unknown> | unknown;
  /** Called once if the checkout returns to the loaded commit; claiming resumes. */
  resumed?: () => Promise<unknown> | unknown;
  /** Every claim this executor makes, so the record beside it says what release each ran on. */
  claimed?: (action: ActionRow) => Promise<unknown> | unknown;
  settled?: (action: ActionRow, result: 'done' | 'failed', reason: string) => Promise<unknown> | unknown;
  /**
   * The executor's half of the restart exclusion: `claiming` announces a claim before `fenced`
   * looks for a restart under way (returning what stands, or null); a claim that finds a fence, or
   * asks the queue and gets nothing, is `abandoned`, and one that gets a row is `claimed`.
   */
  claiming?: () => Promise<unknown> | unknown;
  fenced?: () => Promise<unknown> | unknown;
  abandoned?: () => Promise<unknown> | unknown;
}
export const staleReleaseReason = (loaded: ExecutorRelease, current: string | null) =>
  `this executor loaded ${loaded.commit ? loaded.commit.slice(0, 12) : 'an unknown commit'}${loaded.dirty ? ' (dirty)' : ''} at startup and its checkout now holds ${current ? current.slice(0, 12) : 'an unknown commit'}; it claims nothing more, so no row runs behaviour the repository no longer has`;

/**
 * The same effects, with the release check in front of every claim and the record behind every
 * claim and settlement. The check sits on the claim rather than in the loop because that is the
 * one place a stale executor must not go: an action already in flight finishes and settles under
 * the code it started with — the settlement is what the queue is owed — and only the next claim
 * is refused. An executor whose check reports no commit at all (no readable checkout) is not
 * stale; it simply cannot say, and its record shows that. The claim is also where a fleet restart
 * is kept out: no claim starts while the restart fence stands.
 */
export function releaseGuardedEffects(effects: ExecutorEffects, guard: ReleaseGuard): ExecutorEffects & { standingDown: () => boolean } {
  let standing = false;
  return {
    ...effects,
    standingDown: () => standing,
    claim: async request => {
      const current = guard.current();
      const stale = !!guard.loaded.commit && !!current && current !== guard.loaded.commit;
      if (stale) {
        if (!standing) { standing = true; await guard.standDown({ loaded: guard.loaded, current, reason: staleReleaseReason(guard.loaded, current) }); }
        return { action: null, open: 0 };
      }
      if (standing) { standing = false; await guard.resumed?.(); }
      // Announce, then look: a restart that raised its fence first is seen here, and one that
      // raises it after this announcement waits for the claim to be recorded before it reads.
      await guard.claiming?.();
      let claimed: Awaited<ReturnType<ExecutorEffects['claim']>>;
      try {
        if (await guard.fenced?.()) { await guard.abandoned?.(); return { action: null, open: 0 }; }
        claimed = await effects.claim(request);
      } catch (error) { await guard.abandoned?.(); throw error; }
      if (claimed.action) await guard.claimed?.(claimed.action); else await guard.abandoned?.();
      return claimed;
    },
    settle: async (action, result, reason) => {
      try { return await effects.settle(action, result, reason); }
      finally { await guard.settled?.(action, result, reason); }
    },
  };
}

/**
 * Exactly one component merges (GY-245). The master loop runs the guarded merge on every cycle —
 * routinely with automatic merging on, and for an approved decision with it off — and an executor
 * holding `merge` attempts the same candidate. Each claim writes the item, so the two defeat each
 * other's revision check and the merge is refused as "changed before GitHub verification" on every
 * try while every gate passes. Where a loop runs, the executors therefore never claim `merge`:
 * they are installed without it, and one that still has it refuses the row while the loop lives.
 */
export interface LoopMerger {
  /** The loop is cycling now (its cursor holds a live lock), not merely installed. */
  live: boolean;
  /** The loop's systemd unit is installed on this host. */
  unit: string | null;
  host: string | null;
  pid: number | null;
  autoMerge: boolean;
  /** The loop as a sentence subject, naming what was observed. */
  name: string;
}

/**
 * The master loop that merges on this installation, or null when there is none. A loop is there
 * when its unit is installed (`master init` installs it) or its cursor holds a live lock (a loop
 * run by hand). No master.json means no loop could run here at all.
 */
export async function detectLoopMerger(root: string, options: { config?: MasterConfig; unitDirectory?: string; now?: number } = {}): Promise<LoopMerger | null> {
  let config = options.config ?? null;
  if (!config) { try { config = await loadMasterConfig(root); } catch { return null; } }
  const unitPath = resolve(options.unitDirectory ?? executorUnitDirectory(), loopUnitName);
  const installed = await access(unitPath).then(() => true, () => false);
  let lock: DaemonState['lock'] = null, live = false;
  try {
    const state = await readDaemonState(root, config);
    live = daemonSummary(state, options.now ?? Date.now(), config.run.intervalSeconds * 1000, config.hostId).running;
    lock = live ? state.lock : null;
  } catch { /* an unreadable cursor is no evidence of a running loop */ }
  if (!installed && !live) return null;
  const name = `the master loop (${[installed ? loopUnitName : null, lock ? `pid ${lock.pid} on ${lock.host}` : null].filter(Boolean).join(', ')}${config.autoMerge ? ', automatic merging on' : ', merging approved decisions'})`;
  return { live, unit: installed ? loopUnitName : null, host: lock?.host ?? null, pid: lock?.pid ?? null, autoMerge: config.autoMerge, name };
}

/** Why an executor declines a merge row the loop runs. */
export const loopMergeRefusal = (loop: Pick<LoopMerger, 'name'>) =>
  `${loop.name} merges on this installation, so this executor refuses merge rows: two mergers defeat each other's revision check (GY-245); remove merge from the executors' kinds with node scripts/graphyard-executor.mjs --install`;

/**
 * The same effects, refusing `merge` at the claim while a live loop merges. The refusal is made
 * before the claim, never after it: a claim writes the item, and that write is what makes the
 * loop's merge fail its revision check. Said once each time the loop appears.
 */
export function loopMergeGuardedEffects<E extends ExecutorEffects>(effects: E, loop: () => Promise<LoopMerger | null>, log: (line: string) => void = () => {}): E {
  let refusing: string | null = null;
  return {
    ...effects,
    claim: async request => {
      if (!request.kinds.includes('merge')) return effects.claim(request);
      const merger = await loop().catch(() => null);
      if (!merger?.live) { refusing = null; return effects.claim(request); }
      const refusal = loopMergeRefusal(merger);
      if (refusal !== refusing) { refusing = refusal; log(`[graphyard-executor] ${request.executor}: ${refusal}`); }
      const kinds = request.kinds.filter(kind => kind !== 'merge');
      return kinds.length ? effects.claim({ ...request, kinds }) : { action: null, open: 0 };
    },
  };
}

/**
 * Which component merges on this installation, as `master status` names it, and an attention item
 * when both the loop and the executors are configured to. `executors` merge when this host
 * declares a slot serving `merge` (a null kind list serves every kind) or a live executor anywhere
 * serves it.
 */
export function installationMerger(input: { loop: { configured: boolean; running: boolean; autoMerge: boolean }; declaration: { count: number; kinds: NextActionKind[] | null } | null; served: NextActionKind[] }) {
  const loop = input.loop.configured || input.loop.running;
  const declared = !!input.declaration && input.declaration.count > 0 && (input.declaration.kinds === null || input.declaration.kinds.includes('merge'));
  const executors = declared || input.served.includes('merge');
  const merger: 'loop' | 'executors' | 'both' | 'none' = loop && executors ? 'both' : loop ? 'loop' : executors ? 'executors' : 'none';
  const detail = merger === 'both' ? 'the master loop and the executors both run the guarded merge'
    : merger === 'loop' ? `the master loop runs the guarded merge${input.loop.autoMerge ? '' : ' for approved decisions'}; the executors do not`
    : merger === 'executors' ? 'the executors run the guarded merge; no master loop is configured on this host'
    : 'nothing runs the guarded merge: no master loop is configured and no executor serves merge';
  const attention: AttentionItem[] = merger === 'both' ? [{ subject: 'installation',
    text: `Two components merge: the master loop${input.loop.running ? ' is running' : ' is installed'} and the executors serve merge${declared ? ` (this host declares ${input.declaration!.kinds ? input.declaration!.kinds.join(', ') : 'every kind'})` : ' (a live executor serves it)'}. Each one's claim writes the item and defeats the other's revision check, so merges are refused while every gate passes`,
    ...agentOwner('master', 'node scripts/graphyard-executor.mjs --install (writes the executor kinds without merge while the loop merges), then systemctl --user restart graphyard-executor@*.service') }] : [];
  return { merger, detail, attention };
}

export { message as executorFailureMessage };
