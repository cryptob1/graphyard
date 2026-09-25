// Concern: cycle steps 1–1d — close finished sessions, fail over exhausted ones, answer blocked prompts, recover dead workers.
import type { Work } from '../model.js';
import { detectExhaustion, type CapacityRole } from '../model/capacity.js';
import { classifyRuntimePrompt, continueAfterDecline, type HerdrAgent, profileAccount, type RuntimePrompt } from '../master.js';
import { message, orphanObservationSchema } from './state.js';
import { closeKey } from './reconcile.js';
import { clearProfileFailure, orphanedSupervisors, readyToRetry } from './sessions.js';
import { blockedPromptAnswers, blockedPromptFailMs, blockedPromptSettleMs, failoverKey, launchAppearanceMs, promptDigest, type LaunchedSession, preserveInterruptedAttempt, record, stoppedStates } from './effects.js';
import type { Cycle } from './cycle.js';

/** Steps 1–1d: close finished sessions, fail over exhausted ones, and settle what dead workers and orphaned supervisors left. */
export async function closeStep(cycle: Cycle) {
  const { config, state, effects, now, snapshot, clock, performed, isolate, agents, open, owns, heldBy } = cycle;
  // 1. Close finished worker sessions. Authority stops at the lease, so a launched agent with no
  //    active assignment has nothing left to do and its pane must not linger holding a provider seat.
  for (const profile of config.workers.filter(worker => worker.mode === 'launch')) await isolate('close', null, profile.name, async () => {
    const agent = agents.find(candidate => candidate.name === profile.agentName);
    if (!agent?.pane_id || owns(profile.principal)) return;
    if (!['idle', 'done', 'blocked'].includes(agent.agent_status ?? '')) return;
    const key = closeKey(profile, agent.pane_id);
    if (state.actions[key]?.state === 'done') return;
    await record(state, key, { kind: 'close', work: null, principal: profile.principal, state: 'started', detail: `Closing ${profile.agentName}: no active Graphyard assignment`, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
    try {
      await effects.closeSession(agent.pane_id);
      performed.push(await record(state, key, { kind: 'close', work: null, principal: profile.principal, state: 'done', detail: `Closed finished session ${profile.agentName} (${agent.agent_status ?? 'unknown'}) with no active assignment`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      performed.push(await record(state, key, { kind: 'close', work: null, principal: profile.principal, state: 'failed', detail: `Could not close ${profile.agentName}: ${message(error)}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    }
  });

  // 1a. Mid-session exhaustion. A session that ran out of provider quota does not fail: it stops
  //     on its runtime's limit notice and waits for a person. The loop reads that notice from the
  //     session's own output, keeps what the attempt had not committed, holds the account until
  //     it resets, records the exhaustion — account, notice, reset time, partial work — on the
  //     item, and gets the action onto another account: a worker's lease ends in that same
  //     record, so the dispatch step re-queues the item on the next cycle, and a reviewer or
  //     producer request is launched again at once. Nobody repoints a profile by hand.
  const failedOver = new Set<string>();
  if (effects.sessionOutput && effects.reportCapacity) {
    const stopped = (name: string) => { const agent = agents.find(candidate => candidate.name === name); return agent && stoppedStates.includes(agent.agent_status ?? '') ? agent : null; };
    const notice = async (agent: HerdrAgent) => { try { const output = await effects.sessionOutput!(agent); return output ? detectExhaustion(output, clock) : null; } catch { return null; } };
    const held = async (role: CapacityRole, profile: string, item: Work, signal: { reason: string; resetsAt: string | null }) => {
      const selected = await effects.selectedAccount?.(role, profile) ?? null;
      const account = selected?.environment ?? null;
      await effects.holdAccount?.(account ?? profileAccount(profile), { at: new Date(clock).toISOString(), resetsAt: signal.resetsAt, reason: signal.reason, role, profile, work: item.key });
      return { account, runtime: selected?.kind ?? null };
    };
    for (const profile of config.workers.filter(worker => worker.mode === 'launch')) await isolate('failover', heldBy(profile), profile.name, async () => {
      const agent = stopped(profile.agentName);
      const item = open.find(candidate => !!candidate.lease && candidate.lease.owner === profile.principal && Date.parse(candidate.lease.expiresAt) > clock);
      if (!agent || !item || item.submission?.epoch === item.lease!.epoch) return;
      const key = failoverKey('worker', item, item.lease!.epoch), previous = state.actions[key];
      if (previous?.state === 'done' || !readyToRetry(previous, state.cycle)) { if (previous) failedOver.add(item.id); return; }
      const signal = await notice(agent);
      if (!signal) return;
      failedOver.add(item.id);
      const epoch = item.lease!.epoch, attempts = (previous?.attempts ?? 0) + 1;
      const resets = signal.resetsAt ? `resets ${signal.resetsAt}` : 'reset time unknown';
      await record(state, key, { kind: 'failover', work: item.key, principal: profile.principal, epoch, state: 'started', detail: `${profile.agentName} on ${item.key} (epoch ${epoch}) stopped on its provider's limit notice: ${signal.reason}`, attempts, cycle: state.cycle }, now(), effects.persist);
      try {
        const partialWork = await effects.preserveWork?.(item, epoch) ?? { state: 'not-applicable' as const, detail: 'this loop has no access to the attempt worktree' };
        const { account, runtime } = await held('worker', profile.name, item, signal);
        await effects.reportCapacity!(item, { event: 'exhausted', role: 'worker', epoch, profile: profile.name, account, runtime: runtime ?? profile.kind ?? null, reason: signal.reason, resetsAt: signal.resetsAt, partialWork });
        // The lease is over on the record; the supervisor is stopped through the containment scope
        // it recorded, which is the path that settles its quarantine, so the item is claimable again.
        const scope = item.containmentQuarantine?.epoch === epoch && item.containmentQuarantine.owner === profile.principal ? item.containmentQuarantine.scope : undefined;
        let stop = 'its supervisor stops on the ended lease';
        try {
          if (scope && effects.stopSupervisor) { await effects.stopSupervisor({ id: item.id, key: item.key, epoch, owner: profile.principal, profile: profile.name, agentName: profile.agentName, scope, leaseExpiresAt: item.lease!.expiresAt }, 'SIGTERM'); stop = `its supervisor (pid ${scope.pid}) was stopped through ${scope.unit}`; }
        } catch (error) { stop = `its supervisor could not be signalled (${message(error)}) and stops on the ended lease`; }
        clearProfileFailure(state, profile);
        performed.push(await record(state, key, { kind: 'failover', work: item.key, principal: profile.principal, epoch, state: 'done',
          detail: `${item.key} epoch ${epoch} exhausted ${account ?? `${profile.name}'s own account`} mid-session (${signal.reason}; ${resets}). Partial work ${partialWork.state}${partialWork.commit ? ` at ${partialWork.commit.slice(0, 12)}` : ''}; the attempt ended as released, ${stop}, and ${item.key} is re-queued for another account`,
          attempts, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        performed.push(await record(state, key, { kind: 'failover', work: item.key, principal: profile.principal, epoch, state: 'failed', detail: `${item.key} epoch ${epoch} exhausted its account (${signal.reason}) but could not be failed over: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist));
      }
    });
    for (const session of await effects.launchedSessions?.().catch(() => [] as LaunchedSession[]) ?? []) await isolate('failover', open.find(candidate => candidate.key === session.work) ?? null, session.agentName, async () => {
      const agent = stopped(session.agentName), item = open.find(candidate => candidate.key === session.work);
      if (!agent || !item) return;
      const key = failoverKey(session.role, item, session.record), previous = state.actions[key];
      if (previous?.state === 'done' || !readyToRetry(previous, state.cycle)) return;
      const signal = await notice(agent);
      if (!signal) return;
      const attempts = (previous?.attempts ?? 0) + 1, resets = signal.resetsAt ? `resets ${signal.resetsAt}` : 'reset time unknown';
      await record(state, key, { kind: 'failover', work: item.key, principal: null, state: 'started', detail: `${session.role} session ${session.agentName} for ${item.key} stopped on its provider's limit notice: ${signal.reason}`, attempts, cycle: state.cycle }, now(), effects.persist);
      try {
        const { account, runtime } = await held(session.role, session.profile, item, signal);
        await effects.reportCapacity!(item, { event: 'exhausted', role: session.role, ...(session.requestId ? { requestId: session.requestId } : {}), profile: session.profile, account, runtime, reason: signal.reason, resetsAt: signal.resetsAt,
          partialWork: { state: 'not-applicable', detail: `a ${session.role} session edits nothing: it reads the exact head and leaves no work to keep` } });
        await effects.endSession?.(session, `provider quota exhausted on ${account ?? `${session.profile}'s own account`} mid-session (${signal.reason}; ${resets}); launched again on another account`);
        let next = 'its request launches again on the next dispatch tick';
        if (session.requestId && effects.relaunch) {
          try { next = `relaunched on profile ${(await effects.relaunch(session, item, snapshot)).profile}`; }
          catch (error) {
            next = (error as { capacityExhausted?: boolean })?.capacityExhausted ? `no other account is left for the role (${message(error)}), so it waits for capacity`
              : `it could not be launched again at once (${message(error)}), so the dispatcher launches it on its retry schedule`;
          }
        }
        performed.push(await record(state, key, { kind: 'failover', work: item.key, principal: null, state: 'done',
          detail: `${session.role} session ${session.agentName} for ${item.key} exhausted ${account ?? `${session.profile}'s own account`} mid-session (${signal.reason}; ${resets}); ${next}`, attempts, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        performed.push(await record(state, key, { kind: 'failover', work: item.key, principal: null, state: 'failed', detail: `${session.role} session ${session.agentName} for ${item.key} exhausted its account (${signal.reason}) but could not be failed over: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist));
      }
    });
  }

  // 1b. A session that stops on a prompt is waiting on input no one will give (GY-197). The loop
  //     reads the prompt off its screen: a known one — a Yes/No or proceed/cancel menu whose "yes"
  //     runs a destructive command — is declined, and the session is told once to carry on with a
  //     safe alternative; the prompt and the answer go on the record and on the session's handle.
  //     A prompt the loop cannot classify is a failed attempt, not a wait: once it has stood for
  //     `blockedPromptFailMs` the session is closed as failed with the prompt's text as the reason,
  //     and the item is dispatched again (a reviewer's or producer's request is launched again).
  const readPrompt = async (agent: HerdrAgent): Promise<RuntimePrompt> => {
    let screen: string | null = null;
    try { screen = effects.sessionOutput ? await effects.sessionOutput(agent) : null; } catch { screen = null; }
    return classifyRuntimePrompt(screen) ?? { kind: 'unknown', text: 'its screen could not be read', keys: null, answer: null };
  };
  const unblock = async (who: string, slot: string, agent: HerdrAgent, item: Work, principal: string | null, epoch: number | null, directory: string | null,
    handle: (outcome: string, finished: boolean) => Promise<unknown>, fail: (reason: string) => Promise<string>) => {
    const prompt = await readPrompt(agent), digest = promptDigest(prompt.text);
    const answeredKey = `session:answered:${slot}:${agent.pane_id}:${digest}`, answered = state.actions[answeredKey];
    if (prompt.kind === 'destructive-command' && prompt.keys && effects.answerSession && (answered?.attempts ?? 0) < blockedPromptAnswers) {
      // An answered dialog is given time to close before it is answered again.
      if (answered && now() - Date.parse(answered.at) < blockedPromptSettleMs) return;
      const attempts = (answered?.attempts ?? 0) + 1;
      await record(state, answeredKey, { kind: 'session', work: item.key, principal, epoch, state: 'started', detail: `${who} on ${item.key} is blocked on its runtime's destructive-command prompt "${prompt.text}"; declining it with "${prompt.answer}"`, attempts, cycle: state.cycle }, now(), effects.persist);
      try {
        await effects.answerSession(agent, prompt.keys);
        await effects.promptSession?.(agent, continueAfterDecline(item.key, prompt, directory));
        const outcome = `answered its runtime's destructive-command prompt "${prompt.text}" with "${prompt.answer}" and told it to continue with a safe alternative (explicit paths or a mktemp -d directory)`;
        performed.push(await record(state, answeredKey, { kind: 'session', work: item.key, principal, epoch, state: 'done', detail: `${who} on ${item.key}: the loop ${outcome}`, attempts, cycle: state.cycle }, now(), effects.persist));
        await handle(`The loop ${outcome}`, false);
      } catch (error) {
        performed.push(await record(state, answeredKey, { kind: 'session', work: item.key, principal, epoch, state: 'failed', detail: `${who} on ${item.key} is blocked on its runtime's destructive-command prompt "${prompt.text}", and declining it failed: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist));
      }
      return;
    }
    const why = prompt.kind === 'destructive-command' ? effects.answerSession ? `the loop declined it ${blockedPromptAnswers} times and it is still showing` : 'this loop cannot send it keys' : 'the loop cannot classify it';
    const seenKey = `session:blocked:${slot}:${agent.pane_id}:${digest}`, seen = state.actions[seenKey];
    const minutes = Math.round(blockedPromptFailMs / 60_000);
    if (!seen) {
      performed.push(await record(state, seenKey, { kind: 'session', work: item.key, principal, epoch, state: 'failed', detail: `${who} on ${item.key}${epoch !== null ? ` (epoch ${epoch})` : ''} is waiting on input (Herdr reports it blocked) instead of deciding on its own, at a runtime prompt (${why}): "${prompt.text}". Unless it moves on, the loop closes it as failed with that prompt as the reason in ${minutes} minutes and dispatches ${item.key} again. A session that needs something records a typed request and exits — POST /api/work/${item.key}/request with a type of scope-request, decision, blocker, note or escalation — which names its decider and frees the item, rather than holding its slot at a prompt`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
      // The session is blocked, not gone: it still holds its pane, and the one moment somebody
      // needs the attach command is this one. The handle stays running, carrying why it stalled.
      await handle(`waiting on input instead of recording a typed request, at a runtime prompt (${why}): "${prompt.text}"; closed as failed after ${minutes} minutes unless it moves on`, false);
      return;
    }
    if (now() - Date.parse(seen.at) < blockedPromptFailMs) return;
    const failKey = `session:unanswered:${slot}:${agent.pane_id}:${digest}`, previous = state.actions[failKey];
    if (previous?.state === 'done' || (previous && !readyToRetry(previous, state.cycle))) return;
    const reason = `blocked for ${minutes} minutes on a runtime prompt (${why}): "${prompt.text}"`, attempts = (previous?.attempts ?? 0) + 1;
    await record(state, failKey, { kind: 'session', work: item.key, principal, epoch, state: 'started', detail: `${who} on ${item.key} was ${reason}; closing it as a failed attempt`, attempts, cycle: state.cycle }, now(), effects.persist);
    try {
      const next = await fail(reason);
      performed.push(await record(state, failKey, { kind: 'session', work: item.key, principal, epoch, state: 'done', detail: `${who} on ${item.key} was closed as failed: ${reason}; ${next}`, attempts, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      performed.push(await record(state, failKey, { kind: 'session', work: item.key, principal, epoch, state: 'failed', detail: `${who} on ${item.key} was ${reason}, but it could not be closed as failed: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist));
    }
  };
  for (const profile of config.workers.filter(worker => worker.mode === 'launch')) await isolate('session', heldBy(profile), profile.name, async () => {
    const agent = agents.find(candidate => candidate.name === profile.agentName);
    const item = open.find(candidate => !!candidate.lease && candidate.lease.owner === profile.principal && Date.parse(candidate.lease.expiresAt) > clock);
    if (!agent?.pane_id || !item || agent.agent_status !== 'blocked' || failedOver.has(item.id)) return;
    const epoch = item.lease!.epoch, pane = agent.pane_id;
    const handle = (outcome: string, finished: boolean) => effects.recordSession?.(item, { id: `${profile.principal}:${epoch}`, kind: 'implementation', principal: profile.principal, runtime: profile.kind ?? profile.mode, host: config.hostId,
      ...(config.herdrWorkspace ? { workspace: config.herdrWorkspace } : {}),
      pane, attach: `herdr pane attach ${pane}${config.herdrWorkspace ? ` --workspace ${config.herdrWorkspace}` : ''}`,
      subject: `${item.key}: ${item.title}`.slice(0, 300), state: finished ? 'finished' : 'running', outcome: outcome.slice(0, 500) }).catch(() => {}) ?? Promise.resolve();
    await unblock(`Worker session ${profile.agentName}`, `${profile.name}:${epoch}`, agent, item, profile.principal, epoch, item.workspaces.find(entry => entry.epoch === epoch)?.path ?? null, handle, async reason => {
      // The attempt ends on the record — what it left uncommitted kept, the prompt as the reason —
      // which ends the lease, so the dispatch step claims the item again on the next cycle.
      const preserved = await preserveInterruptedAttempt(state, effects, item, epoch, profile, `ended without submitting: its session ${profile.agentName} was ${reason}`, now, performed);
      if (preserved && preserved.state !== 'done') throw new Error(`its attempt could not be ended on the record: ${preserved.detail}`);
      const scope = item.containmentQuarantine?.epoch === epoch && item.containmentQuarantine.owner === profile.principal ? item.containmentQuarantine.scope : undefined;
      let stop = 'its supervisor stops on the ended lease';
      try {
        if (scope && effects.stopSupervisor) { await effects.stopSupervisor({ id: item.id, key: item.key, epoch, owner: profile.principal, profile: profile.name, agentName: profile.agentName, scope, leaseExpiresAt: item.lease!.expiresAt }, 'SIGTERM'); stop = `its supervisor (pid ${scope.pid}) was stopped through ${scope.unit}`; }
      } catch (error) { stop = `its supervisor could not be signalled (${message(error)}) and stops on the ended lease`; }
      await effects.closeSession(pane);
      await handle(`closed as failed: ${reason}`, true);
      return `the attempt ended on the record, ${stop}, pane ${pane} was closed, and ${item.key} is dispatched again`;
    });
  });
  for (const session of await effects.launchedSessions?.().catch(() => [] as LaunchedSession[]) ?? []) await isolate('session', open.find(candidate => candidate.key === session.work) ?? null, session.agentName, async () => {
    const agent = agents.find(candidate => candidate.name === session.agentName), item = open.find(candidate => candidate.key === session.work);
    if (!agent?.pane_id || !item || agent.agent_status !== 'blocked' || state.actions[failoverKey(session.role, item, session.record)]?.state === 'done') return;
    await unblock(`${session.role} session ${session.agentName}`, `${session.role}:${session.record}`, agent, item, null, null, null, async () => {}, async reason => {
      if (!effects.endSession) { await effects.closeSession(agent.pane_id!); return 'its pane was closed and its request launches again on the next dispatch tick'; }
      await effects.endSession(session, `closed as failed: ${reason}`.slice(0, 500));
      if (!session.requestId || !effects.relaunch) return 'its request launches again on the next dispatch tick';
      try { return `relaunched on profile ${(await effects.relaunch(session, item, snapshot)).profile}`; }
      catch (error) { return `it could not be launched again at once (${message(error)}), so the dispatcher launches it on its retry schedule`; }
    });
  });

  // 1c. A lease that keeps advancing while Herdr no longer reports the session renewing it is an
  //     orphaned watch supervisor: the agent is gone, the item stays owned by a worker that cannot
  //     act, nothing lapses, and no replacement can be dispatched. Two observations establish it —
  //     one lease expiry later than the one first seen with the session already gone — and the
  //     supervisor is then stopped through the containment scope it recorded at launch, rather
  //     than left for a master to find with `pgrep` and kill by hand.
  const runtime = await effects.herdr?.();
  if (runtime?.available && effects.stopSupervisor) {
    const orphans = orphanedSupervisors(open, config.workers, runtime.agents, clock);
    for (const id of Object.keys(state.orphans)) if (!orphans.some(orphan => orphan.id === id)) delete state.orphans[id];
    for (const orphan of orphans) await isolate('escalation', open.find(candidate => candidate.id === orphan.id) ?? null, orphan.key, async () => {
      const previous = state.orphans[orphan.id];
      const tracked = previous && previous.epoch === orphan.epoch && previous.owner === orphan.owner && previous.pid === orphan.scope.pid ? previous : null;
      if (!tracked) {
        state.orphans[orphan.id] = orphanObservationSchema.parse({ epoch: orphan.epoch, owner: orphan.owner, pid: orphan.scope.pid, unit: orphan.scope.unit, firstSeenAt: new Date(clock).toISOString(), leaseExpiresAt: orphan.leaseExpiresAt });
        await effects.persist(state); return;
      }
      // A supervisor already stopped is judged against the expiry it was stopped at: a lease that
      // advances past it proves the stop did not take, and the next signal is not negotiable.
      const baseline = Date.parse(tracked.stoppedLeaseExpiresAt ?? tracked.leaseExpiresAt);
      state.orphans[orphan.id] = { ...tracked, leaseExpiresAt: orphan.leaseExpiresAt };
      if (!(Date.parse(orphan.leaseExpiresAt) > baseline)) { await effects.persist(state); return; }
      const stops = tracked.stops + 1, signal: NodeJS.Signals = stops === 1 ? 'SIGTERM' : 'SIGKILL';
      const key = `incident:orphan-supervisor:${orphan.id}:${orphan.epoch}:${orphan.scope.pid}`;
      const incident = `${orphan.key} epoch ${orphan.epoch} renewed its lease to ${orphan.leaseExpiresAt} while Herdr no longer reports session ${orphan.agentName}: its watch supervisor (pid ${orphan.scope.pid}, containment scope ${orphan.scope.unit}) has outlived the agent`;
      await record(state, key, { kind: 'escalation', work: orphan.key, principal: orphan.owner, epoch: orphan.epoch, state: 'started', detail: `${incident}; stopping it with ${signal} through that scope`, attempts: stops, cycle: state.cycle }, now(), effects.persist);
      // The agent is gone, so its worktree is quiescent: what it left uncommitted is kept and put
      // on the record — which ends the attempt — before the supervisor holding it is stopped.
      const held = open.find(item => item.id === orphan.id);
      if (held) await preserveInterruptedAttempt(state, effects, held, orphan.epoch, config.workers.find(profile => profile.principal === orphan.owner), `ended without submitting: its agent session ${orphan.agentName} is gone from Herdr while its supervisor (pid ${orphan.scope.pid}) still renewed the lease`, now, performed);
      try {
        await effects.stopSupervisor!(orphan, signal);
        state.orphans[orphan.id] = { ...state.orphans[orphan.id], stops, stoppedLeaseExpiresAt: orphan.leaseExpiresAt };
        performed.push(await record(state, key, { kind: 'escalation', work: orphan.key, principal: orphan.owner, epoch: orphan.epoch, state: 'done', detail: `${incident}; stopped with ${signal} through that scope, so the lease lapses instead of renewing`, attempts: stops, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        performed.push(await record(state, key, { kind: 'escalation', work: orphan.key, principal: orphan.owner, epoch: orphan.epoch, state: 'failed', detail: `${incident}; it could not be stopped through that scope: ${message(error)}`, attempts: stops, cycle: state.cycle }, now(), effects.persist));
      }
    });
  }

  // 1d. A worker whose supervisor has already exited. When the agent dies under a supervisor that
  //     is still healthy, the supervisor stops, settles its own quarantine and exits — but it
  //     releases nothing, so the lease stays live until it lapses, and the item would then be
  //     dispatched again with the attempt's uncommitted work still sitting in the old worktree.
  //     Herdr no longer reporting the session while no fence stands for a lease that is still
  //     live is that state exactly (a live launch holds its fence until the agent has appeared,
  //     and a stopped agent still in Herdr is 1a's case). The partial work is kept and recorded,
  //     which ends the attempt, so the re-dispatch that follows is told where it is (GY-105).
  //     Two observations establish it, as for an orphaned supervisor: a session Herdr failed to
  //     list once is not a dead worker, and ending a live attempt on one reading would stop it.
  if (runtime?.available) {
    const gone = new Set<string>();
    for (const profile of config.workers.filter(worker => worker.mode === 'launch')) await isolate('preserve', heldBy(profile), profile.name, async () => {
      const item = open.find(candidate => !!candidate.lease && candidate.lease.owner === profile.principal && Date.parse(candidate.lease.expiresAt) > clock);
      if (!item || failedOver.has(item.id) || item.containmentQuarantine || runtime.agents.some(agent => agent.name === profile.agentName)) return;
      const epoch = item.lease!.epoch;
      if (item.submission?.epoch === epoch || item.lastAssignment?.epoch !== epoch || !(clock - Date.parse(item.lastAssignment.claimedAt ?? item.stageEnteredAt) > launchAppearanceMs)) return;
      gone.add(item.id);
      const seen = state.absences[item.id];
      if (!seen || seen.epoch !== epoch || seen.owner !== profile.principal) { state.absences[item.id] = { epoch, owner: profile.principal, firstSeenAt: new Date(clock).toISOString(), cycle: state.cycle }; await effects.persist(state); return; }
      if (seen.cycle === state.cycle) return;
      await preserveInterruptedAttempt(state, effects, item, epoch, profile, `ended without submitting: its agent session ${profile.agentName} is gone from Herdr (first seen gone at ${seen.firstSeenAt}) and its supervisor has exited without releasing the lease`, now, performed);
    });
    for (const id of Object.keys(state.absences)) if (!gone.has(id)) delete state.absences[id];
  }
}
