// Concern: the master-session step (GY-898) — launch, adopt, supervise, rotate and wake the loop's own master session.
import { detectExhaustion } from '../model/capacity.js';
import { paneAlreadyGone } from '../request-settlement.js';
import { launchAppearanceMs, promptDigest, record, stoppedStates, type DaemonEffects } from './effects.js';
import { actionableSubjects } from './metrics.js';
import { detailChanged } from './decisions.js';
import { message } from './state.js';
import { emptyMasterSession } from './state.js';
import { masterHandover, masterSessionBudgetMs, masterHeartbeatIntervalMs, masterWakeText, masterProfile } from '../master/master-session.js';
import type { Cycle } from './cycle.js';

/** The launcher key the master launch records its started entry under: one in flight at a time. */
export const masterLaunchKey = 'master:launch';
/** The standing wait recorded while the registry decides no master role. */
export const masterSetupKey = 'master:setup';
/** The rotation causes: the session exited, its account is spent, or it passed its budget. */
export type MasterRotationCause = 'exited' | 'exhausted' | 'budget';

/**
 * The master session (GY-898), one step of the cycle between close and dispatch. At most one runs:
 * the loop launches it on the registry's `master` role (never another role's account), adopts one
 * a human started by name, rotates it when it exits (two consecutive liveness misses), spends its
 * account (the failover step's own notice detection) or passes `run.masterSessionMinutes` (deferred
 * while a guarded merge is in flight), and wakes the live session once per cycle with the changed
 * material subjects — the heartbeat only as the fallback. A loop wired without `effects.masterSession`
 * keeps cycling exactly as before.
 */
export async function masterSessionStep(cycle: Cycle) {
  const { config, state, effects, now, clock, snapshot, performed, isolate } = cycle;
  const launcher = effects.masterSession;
  if (!launcher) return;
  const master = state.master;
  let herdr = effects.herdr ? await Promise.resolve(effects.herdr()) : { agents: cycle.agents, available: true };
  const budgetMs = masterSessionBudgetMs(config), heartbeatMs = masterHeartbeatIntervalMs(config);
  const listed = (name: string | null | undefined) => !!name && herdr.agents.some(candidate => candidate.name === name);
  // A launch the previous process handed over and died inside is nothing this cycle can wait on:
  // the launcher is not flying it, so the slot is free again and the next body relaunches.
  if (master.launching && !cycle.launcher.busy(masterLaunchKey)) master.launching = false;
  const launching = master.launching || cycle.launcher.busy(masterLaunchKey);
  const handle = master.agentName ? herdr.agents.find(candidate => candidate.name === master.agentName) : undefined;
  const mergeInFlight = () => Object.values(state.actions).some(action => action.kind === 'merge' && ['started', 'waiting'].includes(action.state));

  // Supervision: rotate a session that exited, spent its account, or ran past its budget. A
  // rotation re-reads the inventory before anything below acts on it: the pane it closed is gone
  // from Herdr, and a stale list would read the dying session as one to adopt.
  let rotated = false;
  if (master.agentName && master.startedAt && !launching) {
    const age = clock - Date.parse(master.startedAt);
    if (handle && handle.pane_id === master.pane) {
      master.misses = 0;
      await isolate('failover', null, 'master-session', async () => {
        // A stopped session's own output is read for the provider's limit notice — the failover
        // step's exact detection — before the budget is judged: an exhausted session is not a
        // budget one, even though both are stopped.
        const output = stoppedStates.includes(handle.agent_status ?? '') && effects.sessionOutput
          ? await Promise.resolve(effects.sessionOutput(handle)).catch(() => null) : null;
        const signal = output ? detectExhaustion(output, clock) : null;
        if (signal) {
          rotated = await rotateMasterSession(cycle, 'exhausted', `${master.agentName} stopped on its provider's limit notice: ${signal.reason}${signal.resetsAt ? `; resets ${signal.resetsAt}` : ''}`, signal.resetsAt);
          return;
        }
        // A guarded merge in flight defers the rotation one cycle: the merge is not cut short.
        if (age > budgetMs && !mergeInFlight()) rotated = await rotateMasterSession(cycle, 'budget', `${master.agentName} ran ${Math.round(age / 60_000)} minutes, past its ${Math.round(budgetMs / 60_000)}-minute session budget`);
      });
    } else if (!handle && age > launchAppearanceMs) {
      master.misses += 1;
      if (master.misses >= 2) await isolate('failover', null, 'master-session', async () => {
        rotated = await rotateMasterSession(cycle, 'exited', `${master.agentName} is gone from Herdr on two consecutive readings (first miss at ${new Date(clock - age).toISOString()})`);
      });
    }
  }

  if (rotated) herdr = await Promise.resolve(effects.herdr ? effects.herdr() : { agents: cycle.agents, available: true });

  // Adoption: a session the loop did not launch (a human `master start`) is supervised from here — never a second.
  // Everything below reads `state.master` afresh: a rotation above replaced the record, and the
  // relaunch it owes belongs to the new one.
  const live = state.master;
  if (!live.agentName && !launching && listed(config.masterAgentName)) {
    const found = herdr.agents.find(candidate => candidate.name === config.masterAgentName)!;
    // The launch record (if this host has one) says which account and registry session the adopted
    // session runs on, so its exhaustion holds the right account and its slot ends with it.
    const known = launcher.adopt ? await Promise.resolve(launcher.adopt(config.masterAgentName)).catch(() => null) : null;
    live.agentName = config.masterAgentName;
    live.pane = found.pane_id ?? null;
    live.runtime = found.agent ?? null;
    live.account = known?.account ?? null;
    live.session = known?.session ?? null;
    live.startedAt = new Date(clock).toISOString();
    live.adopted = true;
    live.misses = 0;
    performed.push(await record(state, `master:adopt:${live.startedAt}`, { kind: 'session', work: null, principal: null, state: 'done',
      detail: `Adopted master session ${live.agentName} in pane ${live.pane ?? 'unknown'}${known?.account ? ` on ${known.account}` : ''}: it was started outside the loop (master start), so the loop supervises, wakes and rotates it instead of launching a second`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
  }

  // Launch: nothing live holds the role, so the handover is composed from control-plane truth and one launch handed over.
  if (!live.agentName && !live.launching && !listed(config.masterAgentName)) {
    const subjects = actionableSubjects(config, snapshot.work, clock, { approvals: state.approvals });
    const handover = masterHandover({ cliPath: config.cliPath, work: snapshot.work, now: clock, approvals: Object.values(state.approvals), subjects });
    live.launching = true;
    await effects.persist(state);
    cycle.launch('session', null, masterLaunchKey, [], async sink => {
      try {
        const launched = await launcher.launch(handover);
        Object.assign(state.master, { agentName: launched.agentName, pane: launched.pane, runtime: launched.runtime, account: launched.account, session: launched.session,
          startedAt: new Date(clock).toISOString(), adopted: false, misses: 0, launching: false, rotations: state.master.rotations + 1 });
        // The replacement is not woken for what its handover already named: the digests start where the handover did.
        for (const subject of subjects) state.master.subjects[subject.key] = promptDigest(subject.detail);
        sink.push(await record(state, masterLaunchKey, { kind: 'session', work: null, principal: null, state: 'done',
          detail: `Launched master session ${launched.agentName} (${launched.runtime}${launched.account ? ` on account ${launched.account}` : ''}) in pane ${launched.pane}`
            + `${state.master.lastEnd ? `, rotation ${state.master.rotations} after ${state.master.lastEnd.cause}: ${state.master.lastEnd.detail}` : ''}; its handover names the judgement work to continue`,
          attempts: (state.actions[masterLaunchKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        state.master.launching = false;
        await effects.persist(state);
        if ((error as { masterRoleUnconfigured?: boolean }).masterRoleUnconfigured) {
          const detail = message(error);
          if (detailChanged(state.actions[masterSetupKey], detail)) sink.push(await record(state, masterSetupKey, { kind: 'config', work: null, principal: null, state: 'waiting', detail, attempts: 1, cycle: state.cycle }, now(), effects.persist, null));
          return;
        }
        sink.push(await record(state, masterLaunchKey, { kind: 'session', work: null, principal: null, state: 'failed',
          detail: `The master session could not be launched: ${message(error)}`, attempts: (state.actions[masterLaunchKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      }
    });
  }

  // Wakes (AC-2): one bundled wake per cycle, naming every changed subject key; the heartbeat is
  // the fallback. Skipped while the pane is working (delivered next cycle) and while a launch or
  // rotation is in flight — a vanished session is woken by its replacement's handover instead.
  const agent = live.agentName ? herdr.agents.find(candidate => candidate.name === live.agentName && candidate.pane_id === live.pane) : undefined;
  for (const key of Object.keys(live.subjects)) if (!agent) delete live.subjects[key];
  if (agent && effects.promptSession && !launching) {
    const subjects = actionableSubjects(config, snapshot.work, clock, { approvals: state.approvals });
    const causes = subjects.filter(subject => live.subjects[subject.key] !== promptDigest(subject.detail)).map(subject => subject.key);
    const reference = live.lastWake?.at ?? live.startedAt;
    const quietMs = reference ? Math.max(0, clock - Date.parse(reference)) : 0;
    const heartbeat = !causes.length && quietMs >= heartbeatMs;
    for (const key of Object.keys(live.subjects)) if (!subjects.some(subject => subject.key === key)) delete live.subjects[key];
    if ((causes.length || heartbeat) && agent.agent_status !== 'working') await isolate('wake', null, 'master-session', async () => {
      const keys = causes.slice(0, 20), at = new Date(clock).toISOString();
      await effects.promptSession!(agent, masterWakeText(config.cliPath, keys, heartbeat, Math.round(quietMs / 60_000)));
      live.lastWake = { at, causes: keys, heartbeat };
      for (const subject of subjects) live.subjects[subject.key] = promptDigest(subject.detail);
      performed.push(await record(state, `wake:master:${state.cycle}`, { kind: 'wake', work: null, principal: null, state: 'done',
        detail: heartbeat ? `Woke master session ${live.agentName}: no material event for ${Math.round(quietMs / 60_000)} minutes (the heartbeat fallback)`
          : `Woke master session ${live.agentName} for changed subjects: ${keys.join(', ')}`,
        attempts: 1, cycle: state.cycle }, now(), effects.persist));
    });
  }
}

/**
 * End the live master session for `cause`: its registry session is given back, an exhausted
 * account is held until it resets, its pane is closed (a session that already exited has none),
 * and the record is cleared so the launch half of this step relaunches from the durable handover.
 * The subject digests are kept: the replacement inherits the same standing subjects, which the
 * handover names, so a rotation never reads as a wake.
 */
async function rotateMasterSession(cycle: Cycle, cause: MasterRotationCause, detail: string, resetsAt: string | null = null): Promise<boolean> {
  const { state, effects, now, clock, performed } = cycle;
  const master = state.master;
  if (master.session && effects.endRegistrySession) await effects.endRegistrySession(master.session, `master session ${master.agentName} ended (${cause}): ${detail.slice(0, 300)}`).catch(() => {});
  if (cause === 'exhausted' && master.account) await effects.holdAccount?.(master.account, { at: new Date(clock).toISOString(), resetsAt, reason: detail.slice(0, 500), role: masterProfile, profile: masterProfile, work: null }).catch(() => {});
  if (master.pane && cause !== 'exited') {
    try { await effects.closeSession(master.pane); }
    catch (error) { if (!paneAlreadyGone(error)) throw error; }
  }
  const ended = { cause, at: new Date(clock).toISOString(), detail: detail.slice(0, 500) };
  state.master = { ...emptyMasterSession(), rotations: master.rotations, lastEnd: ended, subjects: master.subjects };
  performed.push(await record(state, `master:rotate:${ended.at}`, { kind: 'failover', work: null, principal: null, state: 'done',
    detail: `Ended master session ${master.agentName ?? '(unknown)'} (${cause}): ${detail}. The role relaunches from the durable handover`
      + `${cause === 'exhausted' && master.account ? `; account ${master.account} is held until it resets` : ''}`,
    attempts: 1, cycle: state.cycle }, now(), effects.persist));
  return true;
}
