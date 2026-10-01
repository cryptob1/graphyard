// Concern: the master-session step (GY-898) — launch, adopt, supervise, rotate and wake the loop's own master session.
import { detectExhaustion } from '../model/capacity.js';
import { paneAlreadyGone } from '../request-settlement.js';
import { launchAppearanceMs, promptDigest, record, stoppedStates, type DaemonEffects } from './effects.js';
import { actionableSubjects } from './metrics.js';
import { detailChanged } from './decisions.js';
import { message } from './state.js';
import { emptyMasterSession, type MasterSessionState } from './state.js';
import { sessionCapMs } from '../model/registry-sessions.js';
import { masterHandover, masterSessionBudgetMs, masterHeartbeatIntervalMs, masterWakeText, masterProfile } from '../master/master-session.js';
import type { Cycle } from './cycle.js';

/** The launcher key the master launch records its started entry under: one in flight at a time. */
export const masterLaunchKey = 'master:launch';
/** The standing wait recorded while the registry decides no master role. */
export const masterSetupKey = 'master:setup';
/** The standing record of registry sessions the loop still owes the registry an end for. */
export const masterReleaseKey = 'master:release';
/** The rotation causes: the session exited, its account is spent, or it passed its budget. */
export type MasterRotationCause = 'exited' | 'exhausted' | 'budget';
/** How long past its budget a rotation waits for a guarded merge in flight: never longer than this. */
export const masterMergeDeferralMs = 30 * 60_000;

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
  // Owed releases first: a leaked row holds the role's single slot, so the launch below would be refused until it is gone.
  await isolate('failover', null, 'master-session', () => releaseOwedSessions(cycle));
  const master = state.master;
  let herdr = effects.herdr ? await Promise.resolve(effects.herdr()) : { agents: cycle.agents, available: true };
  const budgetMs = masterSessionBudgetMs(config), heartbeatMs = masterHeartbeatIntervalMs(config);
  const listed = (name: string | null | undefined) => !!name && herdr.agents.some(candidate => candidate.name === name);
  // A launch the previous process handed over and died inside is nothing this cycle can wait on:
  // the launcher is not flying it, so the slot is free again and the next body relaunches.
  if (master.launching && !cycle.launcher.busy(masterLaunchKey)) master.launching = false;
  const launching = master.launching || cycle.launcher.busy(masterLaunchKey);
  const handle = master.agentName ? herdr.agents.find(candidate => candidate.name === master.agentName) : undefined;
  // A merge row stays `waiting` after its item lands until the row is retired, so only one whose item
  // is still open counts as in flight; and the deferral is bounded, so a stuck merge never keeps a
  // session past its budget for good.
  const open = new Set(snapshot.work.filter(item => item.stage !== 'done').map(item => item.key));
  const mergeInFlight = () => Object.values(state.actions).some(action => action.kind === 'merge' && ['started', 'waiting'].includes(action.state) && !!action.work && open.has(action.work));

  // Supervision: rotate a session that exited, spent its account, or ran past its budget. A
  // rotation re-reads the inventory before anything below acts on it: the pane it closed is gone
  // from Herdr, and a stale list would read the dying session as one to adopt.
  let rotated = false;
  // An inventory Herdr could not answer (`available: false`) says nothing about the session: a
  // healthy master is never counted as a miss, rotated, adopted over or relaunched beside while
  // the runtime is unobservable — supervision resumes on the next reading that answers.
  if (herdr.available === false) return;
  if (master.agentName && master.startedAt && !launching) {
    const age = clock - Date.parse(master.startedAt);
    // A runtime that has left its pane (Herdr lists the pane with no agent in it: status unknown)
    // is the exit closeStep reads for workers (cycle-sessions.ts): the pane remains, the session
    // does not — a liveness miss, never a live reading that resets the exit count.
    const exitedInPane = !!handle && handle.pane_id === master.pane && !handle.agent && handle.agent_status === 'unknown';
    if (handle && handle.pane_id === master.pane && !exitedInPane) {
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
        // A guarded merge in flight on an open item defers the rotation, at most masterMergeDeferralMs: the merge is not cut short.
        if (age > budgetMs && (age > budgetMs + masterMergeDeferralMs || !mergeInFlight())) rotated = await rotateMasterSession(cycle, 'budget', `${master.agentName} ran ${Math.round(age / 60_000)} minutes, past its ${Math.round(budgetMs / 60_000)}-minute session budget`);
      });
    } else if ((exitedInPane || !handle) && age > launchAppearanceMs) {
      master.misses += 1;
      if (master.misses >= 2) await isolate('failover', null, 'master-session', async () => {
        rotated = await rotateMasterSession(cycle, 'exited', exitedInPane
          ? `${master.agentName}'s runtime has left pane ${master.pane} (status unknown) on two consecutive readings (the session started ${master.startedAt})`
          : `${master.agentName} is gone from Herdr on two consecutive readings (the session started ${master.startedAt})`);
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
        // A failed launch whose cleanup could not end its registry session hands that id back: it is owed, and ended again next cycle.
        const orphan = (error as { registrySession?: string }).registrySession;
        if (orphan) owe(state.master, orphan, clock, `the master launch failed: ${message(error)}`);
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
  // the fallback. Skipped while the pane is working (delivered next cycle), while a launch or
  // rotation is in flight, and for a runtime that has left its pane — a vanished session is woken
  // by its replacement's handover instead, and a paste into a dead pane would only sit there.
  const agent = live.agentName ? herdr.agents.find(candidate => candidate.name === live.agentName && candidate.pane_id === live.pane) : undefined;
  const runtimeGone = !!agent && !agent.agent && agent.agent_status === 'unknown';
  for (const key of Object.keys(live.subjects)) if (!agent || runtimeGone) delete live.subjects[key];
  if (agent && !runtimeGone && effects.promptSession && !launching) {
    const subjects = actionableSubjects(config, snapshot.work, clock, { approvals: state.approvals });
    const causes = subjects.filter(subject => live.subjects[subject.key] !== promptDigest(subject.detail)).map(subject => subject.key);
    const reference = live.lastWake?.at ?? live.startedAt;
    const quietMs = reference ? Math.max(0, clock - Date.parse(reference)) : 0;
    const heartbeat = !causes.length && quietMs >= heartbeatMs;
    // The digests track exactly the standing subjects — never cut to a count, so a large backlog never reads as changed.
    const standing = new Set(subjects.map(subject => subject.key));
    for (const key of Object.keys(live.subjects)) if (!standing.has(key)) delete live.subjects[key];
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
 * account is held until it resets, its pane is closed — an exit in place leaves the pane behind,
 * and a pane Herdr no longer lists was already gone — so the configured name frees for the
 * relaunch, and the record is cleared so the launch half of this step relaunches from the durable
 * handover. The subject digests are kept: the replacement inherits the same standing subjects,
 * which the handover names, so a rotation never reads as a wake.
 */
async function rotateMasterSession(cycle: Cycle, cause: MasterRotationCause, detail: string, resetsAt: string | null = null): Promise<boolean> {
  const { state, effects, now, clock, performed } = cycle;
  const master = state.master;
  const reason = `master session ${master.agentName} ended (${cause}): ${detail.slice(0, 300)}`;
  const released = master.session && effects.endRegistrySession ? await effects.endRegistrySession(master.session, reason).then(() => true, () => false) : true;
  if (cause === 'exhausted' && master.account) await effects.holdAccount?.(master.account, { at: new Date(clock).toISOString(), resetsAt, reason: detail.slice(0, 500), role: masterProfile, profile: masterProfile, work: null }).catch(() => {});
  if (master.pane) {
    try { await effects.closeSession(master.pane); }
    catch (error) { if (!paneAlreadyGone(error)) throw error; }
  }
  const ended = { cause, at: new Date(clock).toISOString(), detail: detail.slice(0, 500) };
  state.master = { ...emptyMasterSession(), rotations: master.rotations, lastEnd: ended, subjects: master.subjects, unreleased: master.unreleased };
  // A release the registry refused is kept, never forgotten: the next cycle ends it before relaunching.
  if (!released && master.session) owe(state.master, master.session, clock, reason);
  performed.push(await record(state, `master:rotate:${ended.at}`, { kind: 'failover', work: null, principal: null, state: 'done',
    detail: `Ended master session ${master.agentName ?? '(unknown)'} (${cause}): ${detail}. The role relaunches from the durable handover`
      + `${cause === 'exhausted' && master.account ? `; account ${master.account} is held until it resets` : ''}`,
    attempts: 1, cycle: state.cycle }, now(), effects.persist));
  return true;
}

/** Keep `session` on the cursor as owed to the registry (once), the newest 20 at most. */
function owe(master: MasterSessionState, session: string, clock: number, reason: string) {
  if (master.unreleased.some(entry => entry.session === session)) return;
  master.unreleased = [...master.unreleased, { session, since: new Date(clock).toISOString(), reason: reason.slice(0, 300) }].slice(-20);
}

/**
 * End every registry session a rotation or failed launch could not give back (GY-898). One the
 * registry takes back leaves the cursor; one older than the registry's own session cap is dropped,
 * since the registry has ended it by then; the rest stay owed and are tried again next cycle, and
 * the standing record names them until they clear.
 */
async function releaseOwedSessions(cycle: Cycle) {
  const { state, effects, now, clock, performed } = cycle;
  const master = state.master;
  if (!master.unreleased.length || !effects.endRegistrySession) return;
  const kept: MasterSessionState['unreleased'] = [], ended: string[] = [], failures: string[] = [];
  for (const entry of master.unreleased) {
    if (clock - Date.parse(entry.since) > sessionCapMs) { ended.push(entry.session); continue; }
    try { await effects.endRegistrySession(entry.session, entry.reason); ended.push(entry.session); }
    catch (error) { kept.push(entry); failures.push(`${entry.session} (${message(error).slice(0, 200)})`); }
  }
  state.master.unreleased = kept;
  const detail = kept.length
    ? `The registry has not taken back master session(s) ${failures.join('; ')}; each is ended again next cycle, and the master role relaunches once its slot is free`
    : `The registry took back master session(s) ${ended.join(', ')} that an earlier rotation or failed launch could not end; the role's slot is free for the relaunch`;
  if (kept.length ? detailChanged(state.actions[masterReleaseKey], detail) : true)
    performed.push(await record(state, masterReleaseKey, { kind: 'failover', work: null, principal: null, state: kept.length ? 'waiting' : 'done', detail, attempts: (state.actions[masterReleaseKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist, null));
}
