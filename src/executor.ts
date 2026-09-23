import { randomUUID } from 'node:crypto';
import type { Work } from './model.js';
import type { ActionRow } from './model/actions.js';
import type { DispatchRequest } from './model/dispatch.js';
import { actionJudgment, type NextActionKind } from './model/next-action.js';
import type { SessionHandleInput } from './model/sessions.js';
import { independentProducerProfiles } from './producer.js';
import { profileHealth, type DaemonState, type DeploymentObservation } from './master-daemon.js';
import { launchedSessionHandle, selectReviewerProfile, type ExecutorEffects, type ExecutorHandler } from './auto-dispatch.js';
import type { HerdrAgent, MasterConfig, MergeExecutor, ProducerProfile, WorkerProfile } from './master.js';

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
  /** The guarded merge: the same broker `master run` uses, never a direct provider merge. */
  merge: (work: Work) => Promise<unknown>;
  observeDeployment: (delivered: Work[]) => Promise<DeploymentObservation>;
  /** Records a launched session's durable handle on the item (AC-8). */
  recordSession?: (work: Work, handle: SessionHandleInput) => Promise<unknown>;
}

/**
 * The merge execution instance one executor process owns.
 *
 * A merge execution is owned by the executor instance that acquired it, never by the coordinator
 * principal alone (GY-92): an execution another instance holds is refused rather than resumed, so
 * a `master run` loop, an interactive `master merge` and any number of executors sharing one
 * credential never drive the same merge between them. An executor mints its instance once per
 * process, exactly as the daemon does, so nothing it starts can be resumed by anything else —
 * including a later executor on the same host, which stands down until the execution lapses.
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
  const record = (work: Work, handle: SessionHandleInput) =>
    // The launch landed; a handle that could not be written is not a failed action.
    effects.recordSession?.(work, handle).catch(() => {});

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
    const launched = await effects.launchProducer(work, request, usable[0], agents, observedAt);
    await record(work, launchedSessionHandle('proof', request, `${work.key}: ${group} proofs on ${request.sha.slice(0, 12)} (${proofs.join(', ')})`, config().hostId, launched, usable[0].kind, config().herdrWorkspace, usable[0].principal));
    return `launched producer ${usable[0].name} for ${proofs.join(', ')} on ${request.sha.slice(0, 12)}`;
  };

  const launchWorker = async (action: ActionRow, work: Work, all: Work[], observedAt: string) => {
    const agents = await herdr();
    const workers = config().workers;
    const health = profileHealth(workers, await effects.workerCredentials(workers), agents, statelessProfiles, Date.parse(observedAt) || Date.now());
    const choice = health.find(entry => entry.healthy);
    if (!choice) throw new Error(`no worker profile can take ${work.key}: ${health.map(entry => `${entry.profile.name} (${entry.reason})`).join('; ') || 'no launch profile is configured'}`);
    const launched = await effects.dispatchWorker(work, choice.profile, agents, { work: all, now: observedAt });
    const workspace = config().herdrWorkspace;
    await record(work, {
      // The worker session's own handle: it fills in the tab and transcript only it has, so the
      // launcher names it as the principal the handle belongs to.
      id: `${choice.profile.principal}:${work.epoch + 1}`, kind: 'implementation', principal: choice.profile.principal,
      runtime: choice.profile.kind ?? choice.profile.mode, host: config().hostId,
      ...(workspace ? { workspace } : {}),
      ...(launched?.pane ? { pane: launched.pane, attach: `herdr pane attach ${launched.pane}${workspace ? ` --workspace ${workspace}` : ''}` } : {}),
      subject: `${work.key}: ${work.title}`.slice(0, 300), state: 'running',
    });
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
      if (agents.some(agent => agent.name === profile.agentName)) throw new Error(`reviewer agent ${profile.agentName} is busy in Herdr`);
      const launched = await effects.launchReview(work, request, agents, observedAt);
      await record(work, launchedSessionHandle('review', request, `${work.key}: review ${request.sha.slice(0, 12)} (PR #${request.pr})`, config().hostId, launched, profile.kind, config().herdrWorkspace));
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
      // The broker throws when it does not hand the merge to the provider, so reaching here means
      // it did. What it returns is its own account of what happened — a merge requested and not
      // yet observed, or an execution it retained until GitHub reconciles — and the row records
      // that verbatim rather than a word of the executor's own: only the observation says merged.
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

export { message as executorFailureMessage };
