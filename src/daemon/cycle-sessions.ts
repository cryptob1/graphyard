// Concern: cycle steps 1–1g — close finished sessions, fail over exhausted ones, answer blocked prompts, recover dead workers, resume waiting ones.
import type { Work } from '../model.js';
import type { WorkerProfile } from '../master.js';
import type { DaemonAction } from './state.js';
import { detectExhaustion, type CapacityRole } from '../model/capacity.js';
import { classifyRuntimePrompt, continueAfterDecline, type EscalationSession, escalationProfile, type HerdrAgent, ownLoginAccounts, profileAccount, type RuntimePrompt } from '../master.js';
import { standingEscalations } from '../model/escalation.js';
import { capacityRecheckMs } from '../auto-dispatch.js';
import { message, orphanObservationSchema } from './state.js';
import { closeKey } from './reconcile.js';
import { boundDetail } from './decisions.js';
import { clearProfileFailure, orphanedSupervisors, readyToRetry } from './sessions.js';
import { blockedPromptAnswers, blockedPromptFailMs, blockedPromptSettleMs, failoverKey, handlerSettleMs, launchAppearanceMs, launcherRetry, promptDigest, type LaunchedSession, preserveInterruptedAttempt, record, stoppedStates } from './effects.js';
import type { Cycle } from './cycle.js';

/** Steps 1–1d: close finished sessions, fail over exhausted ones, and settle what dead workers and orphaned supervisors left. */
export async function closeStep(cycle: Cycle) {
  const { config, state, effects, now, snapshot, clock, performed, isolate, agents, open, owns, heldBy } = cycle;
  // Whether a live lease of `principal` is worked in the worktree `cwd` names (…/worktrees/GY-N-EPOCH).
  const workedHere = (principal: string, cwd: string | undefined) => open.some(item => !!item.lease && item.lease.owner === principal
    && Date.parse(item.lease.expiresAt) > clock && !!cwd && cwd.replace(/ \(deleted\)$/, '').endsWith(`/${item.key}-${item.lease.epoch}`));
  // 1. Close finished worker sessions. Authority stops at the lease, so a launched agent with no
  //    active assignment has nothing left to do and its pane must not linger holding a provider seat.
  for (const profile of config.workers.filter(worker => worker.mode === 'launch')) await isolate('close', null, profile.name, async () => {
    const agent = agents.find(candidate => candidate.name === profile.agentName);
    if (!agent?.pane_id) return;
    // A runtime that left its pane (Herdr detects no agent in it: a bare shell, status unknown) never
    // reports idle, yet its agent name keeps the profile from every dispatch (2026-09-26: six of ten
    // profiles held for hours). Such a pane is closed unless a live lease of its principal is worked
    // in the worktree it stands in, and only once it has stood so for launchAppearanceMs, so a launch
    // whose runtime has not yet started is never taken for one that exited.
    const exited = !agent.agent && agent.agent_status === 'unknown';
    if (exited && agent.cwd ? workedHere(profile.principal, agent.cwd) : owns(profile.principal)) return;
    if (!exited && !['idle', 'done', 'blocked'].includes(agent.agent_status ?? '')) return;
    const key = closeKey(profile, agent.pane_id);
    if (state.actions[key]?.state === 'done') return;
    if (exited) {
      const seenKey = `exited:${profile.name}:${agent.pane_id}`, seen = state.actions[seenKey];
      if (!seen) { await record(state, seenKey, { kind: 'close', work: null, principal: profile.principal, state: 'started', detail: `${profile.agentName}'s runtime has left pane ${agent.pane_id}, which holds no live assignment; it is closed if that still stands in ${launchAppearanceMs / 1000}s`, attempts: 1, cycle: state.cycle }, now(), effects.persist); return; }
      if (now() - Date.parse(seen.at) < launchAppearanceMs) return;
    }
    await record(state, key, { kind: 'close', work: null, principal: profile.principal, state: 'started', detail: `Closing ${profile.agentName}: no active Graphyard assignment`, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
    try {
      await effects.closeSession(agent.pane_id);
      performed.push(await record(state, key, { kind: 'close', work: null, principal: profile.principal, state: 'done', detail: `Closed finished session ${profile.agentName} (${exited ? 'its runtime exited' : agent.agent_status ?? 'unknown'}) with no active assignment`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
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
      // A session on no named account spent its runtime's own login, which other roles launch on too.
      const own = (role === 'worker' ? config.workers : role === 'reviewer' ? config.reviewers : role === 'producer' ? config.producers : []).find(entry => entry.name === profile) ?? { name: profile };
      for (const name of account ? [account] : ownLoginAccounts(own)) await effects.holdAccount?.(name, { at: new Date(clock).toISOString(), resetsAt: signal.resetsAt, reason: signal.reason, role, profile, work: item.key });
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
      // Its relaunch is still on the launcher: the failover is in flight, not due again.
      if (cycle.launcher.busy(key) || previous?.state === 'done' || !readyToRetry(previous, state.cycle)) return;
      const signal = await notice(agent);
      if (!signal) return;
      const attempts = (previous?.attempts ?? 0) + 1, resets = signal.resetsAt ? `resets ${signal.resetsAt}` : 'reset time unknown';
      await record(state, key, { kind: 'failover', work: item.key, principal: null, state: 'started', detail: `${session.role} session ${session.agentName} for ${item.key} stopped on its provider's limit notice: ${signal.reason}`, attempts, cycle: state.cycle }, now(), effects.persist);
      try {
        const { account, runtime } = await held(session.role, session.profile, item, signal);
        await effects.reportCapacity!(item, { event: 'exhausted', role: session.role, ...(session.requestId ? { requestId: session.requestId } : {}), profile: session.profile, account, runtime, reason: signal.reason, resetsAt: signal.resetsAt,
          partialWork: { state: 'not-applicable', detail: `a ${session.role} session edits nothing: it reads the exact head and leaves no work to keep` } });
        await effects.endSession?.(session, `provider quota exhausted on ${account ?? `${session.profile}'s own account`} mid-session (${signal.reason}; ${resets}); launched again on another account`);
        const done = (next: string) => record(state, key, { kind: 'failover', work: item.key, principal: null, state: 'done',
          detail: `${session.role} session ${session.agentName} for ${item.key} exhausted ${account ?? `${session.profile}'s own account`} mid-session (${signal.reason}; ${resets}); ${next}`, attempts, cycle: state.cycle }, now(), effects.persist);
        if (!session.requestId || !effects.relaunch) { performed.push(await done('its request launches again on the next dispatch tick')); return; }
        // The relaunch is a session launch: the launcher runs it beside the cycle (GY-616), and the
        // failover is recorded done, with the profile it landed on, when it settles.
        cycle.launch('failover', item, key, [], async sink => {
          let next: string;
          try { next = `relaunched on profile ${(await effects.relaunch!(session, item, snapshot)).profile}`; }
          catch (error) {
            next = (error as { capacityExhausted?: boolean })?.capacityExhausted ? `no other account is left for the role (${message(error)}), so it waits for capacity`
              : `it could not be launched again at once (${message(error)}), so the dispatcher launches it on its retry schedule`;
          }
          sink.push(await done(next));
        });
      } catch (error) {
        performed.push(await record(state, key, { kind: 'failover', work: item.key, principal: null, state: 'failed', detail: `${session.role} session ${session.agentName} for ${item.key} exhausted its account (${signal.reason}) but could not be failed over: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist));
      }
    });
    /**
     * A handler that finished — stopped with no limit notice for `handlerSettleMs`, or no longer
     * listed by Herdr — is ended like a spent one, less the relaunch: its registry session ends, so
     * the role's slot is free for the next escalation, its pane closes and its record is dropped.
     * Herdr reports a session idle while a command runs, so one stopped sighting is not an end.
     */
    let listing: { agents: HerdrAgent[]; available: boolean } | null = null;
    const handlerFinished = async (session: EscalationSession, isStopped: boolean) => {
      listing ??= await Promise.resolve(effects.herdr ? effects.herdr() : { agents, available: true }).catch(() => ({ agents: [], available: false }));
      if (!listing.available) return;
      const listed = listing.agents.some(candidate => candidate.name === session.agentName);
      const gone = !listed && clock - Date.parse(session.launchedAt) > launchAppearanceMs;
      if (!gone && !isStopped) { if (session.idleSince) await effects.markEscalation?.({ ...session, idleSince: undefined }).catch(() => {}); return; }
      if (!gone) {
        if (!session.idleSince) { await effects.markEscalation?.({ ...session, idleSince: new Date(clock).toISOString() }).catch(() => {}); return; }
        if (clock - Date.parse(session.idleSince) < handlerSettleMs) return;
      }
      const key = `close:escalation:${session.work}:${session.trigger}:${session.launchedAt}`, previous = state.actions[key];
      if (!effects.endEscalation || previous?.state === 'done' || !readyToRetry(previous, state.cycle)) return;
      const why = gone ? 'Herdr no longer lists it' : `it has been stopped with no limit notice since ${session.idleSince}`;
      try {
        await effects.endEscalation(session, `escalation handler for ${session.work} (${session.trigger}) finished: ${why}`, null);
        performed.push(await record(state, key, { kind: 'close', work: session.work, principal: null, state: 'done', detail: `Ended escalation handler ${session.agentName} for ${session.work} (${session.trigger}): ${why}; its pane${session.session ? ', registry session' : ''} and record are closed, so the role takes the next escalation`, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        performed.push(await record(state, key, { kind: 'close', work: session.work, principal: null, state: 'failed', detail: `Could not end finished escalation handler ${session.agentName} for ${session.work}: ${message(error)}`, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      }
    };
    // An escalation handler is a capacity role too (GY-182): one stopped on its provider's notice
    // is ended, its account held, and the same escalation launched again on another account; with
    // none left it waits for the first reset and is launched again then, by the loop alone.
    for (const session of await effects.escalationSessions?.().catch(() => [] as EscalationSession[]) ?? []) await isolate('failover', open.find(candidate => candidate.key === session.work) ?? null, session.agentName, async () => {
      const item = open.find(candidate => candidate.key === session.work);
      // A wait with nothing left to launch — its item closed, or its escalation resolved another way
      // while the item stays open — is dropped: its record, and any registry session a failed launch
      // left on it, are ended, so it is neither relaunched, reported as a wait, nor holding a slot.
      const dropWait = async (waiting: NonNullable<EscalationSession['waiting']>, why: string) => {
        const dropKey = `close:escalation:${session.work}:${session.trigger}:${waiting.since}`, dropped = state.actions[dropKey];
        if (!effects.endEscalation || dropped?.state === 'done' || !readyToRetry(dropped, state.cycle)) return;
        try {
          await effects.endEscalation(session, `${why}, so no handler is launched for it`, null);
          performed.push(await record(state, dropKey, { kind: 'close', work: session.work, principal: null, state: 'done', detail: `Dropped the waiting escalation handler record for ${session.work} (${session.trigger}): ${why}, so nothing is left to launch${session.session ? '; its registry session is ended' : ''}`, attempts: (dropped?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
        } catch (error) {
          performed.push(await record(state, dropKey, { kind: 'close', work: session.work, principal: null, state: 'failed', detail: `Could not drop the waiting escalation handler record for ${session.work} (${session.trigger}) (${why}): ${message(error)}`, attempts: (dropped?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
        }
      };
      // A handler whose item has closed has nothing left to judge: it is ended once it finishes.
      if (!item) { if (session.waiting) await dropWait(session.waiting, `${session.work} is no longer open`); else await handlerFinished(session, !!stopped(session.agentName)); return; }
      const key = failoverKey('escalation-handler', item, `${session.trigger}:${session.waiting ? `${session.waiting.since}:relaunch` : session.launchedAt}`), previous = state.actions[key];
      if (session.waiting && !standingEscalations(item).some(entry => entry.trigger === session.trigger)) { await dropWait(session.waiting, `the ${session.trigger} escalation on ${item.key} no longer stands`); return; }
      if (session.waiting) {
        if (Date.parse(session.waiting.retryAt) > clock || !effects.relaunchEscalation || !readyToRetry(previous, state.cycle)) return;
        try {
          const launched = await effects.relaunchEscalation(session);
          performed.push(await record(state, key, { kind: 'failover', work: item.key, principal: null, state: 'done', detail: `escalation handler for ${item.key} (${session.trigger}) waited since ${session.waiting.since} (${session.waiting.reason}); relaunched as ${launched.agentName} on ${launched.account ?? 'its runtime\'s own account'}`, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
        } catch (error) {
          if ((error as { capacityExhausted?: boolean })?.capacityExhausted) { await effects.endEscalation?.(session, session.waiting.reason, { ...session.waiting, retryAt: launcherRetry(error) ?? new Date(clock + capacityRecheckMs).toISOString() }).catch(() => {}); return; }
          performed.push(await record(state, key, { kind: 'failover', work: item.key, principal: null, state: 'failed', detail: `escalation handler for ${item.key} (${session.trigger}) could not be launched again: ${message(error)}`, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
        }
        return;
      }
      const agent = stopped(session.agentName);
      if (previous?.state === 'done' || !readyToRetry(previous, state.cycle)) return;
      const signal = agent ? await notice(agent) : null;
      if (!signal) { await handlerFinished(session, !!agent); return; }
      const attempts = (previous?.attempts ?? 0) + 1, resets = signal.resetsAt ? `resets ${signal.resetsAt}` : 'reset time unknown';
      try {
        // A handler on no named account spent its runtime's own login, which an approver launches on too.
        let hold: { until?: string } | undefined;
        for (const account of session.account ? [session.account] : ownLoginAccounts({ name: escalationProfile, kind: session.runtime ?? session.kind })) {
          const recorded = await effects.holdAccount?.(account, { at: new Date(clock).toISOString(), resetsAt: signal.resetsAt, reason: signal.reason, role: 'escalation-handler', profile: escalationProfile, work: item.key }) as { until?: string } | undefined;
          hold ??= recorded;
        }
        await effects.reportCapacity!(item, { event: 'exhausted', role: 'escalation-handler', requestId: session.trigger.slice(0, 64), profile: escalationProfile, account: session.account, runtime: session.runtime, reason: signal.reason, resetsAt: signal.resetsAt,
          partialWork: { state: 'not-applicable', detail: 'an escalation handler edits nothing: it requests a decision and leaves no work to keep' } });
        const ended = `provider quota exhausted on ${session.account ?? 'its runtime\'s own account'} mid-session (${signal.reason}; ${resets})`;
        let next: string;
        try {
          if (!effects.relaunchEscalation) throw new Error('this loop cannot launch an escalation handler');
          // The handler is ended but its record stays, due now: a relaunch that fails for any reason
          // is retried by later cycles from it, and a successful one replaces it.
          await effects.endEscalation?.(session, ended, { since: new Date(clock).toISOString(), retryAt: new Date(clock).toISOString(), reason: `${ended}; to be launched again`.slice(0, 500) });
          const launched = await effects.relaunchEscalation(session);
          next = `relaunched as ${launched.agentName} on ${launched.account ?? 'its runtime\'s own account'}`;
        } catch (error) {
          if (!(error as { capacityExhausted?: boolean })?.capacityExhausted) throw error;
          // The launcher already chose the wait: the earliest reset among every account it skipped.
          const retryAt = launcherRetry(error) ?? signal.resetsAt ?? hold?.until ?? new Date(clock + capacityRecheckMs).toISOString();
          await effects.endEscalation?.({ ...session, pane: null, session: null }, ended, { since: new Date(clock).toISOString(), retryAt, reason: message(error).slice(0, 500) });
          next = `no other account is left for the role (${message(error)}), so it is launched again at ${retryAt}`;
        }
        performed.push(await record(state, key, { kind: 'failover', work: item.key, principal: null, state: 'done', detail: `escalation handler ${session.agentName} for ${item.key} (${session.trigger}) ${ended}; ${next}`, attempts, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        performed.push(await record(state, key, { kind: 'failover', work: item.key, principal: null, state: 'failed', detail: `escalation handler ${session.agentName} for ${item.key} exhausted its account (${signal.reason}) but could not be failed over: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist));
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
    const handle = (outcome: string, finished: boolean) => workerHandle(cycle, item, profile, epoch, pane, outcome, finished);
    await unblock(`Worker session ${profile.agentName}`, `${profile.name}:${epoch}`, agent, item, profile.principal, epoch, item.workspaces.find(entry => entry.epoch === epoch)?.path ?? null, handle,
      reason => endWorkerAttempt(cycle, item, profile, epoch, pane, reason, `ended without submitting: its session ${profile.agentName} was ${reason}`));
  });
  for (const session of await effects.launchedSessions?.().catch(() => [] as LaunchedSession[]) ?? []) await isolate('session', open.find(candidate => candidate.key === session.work) ?? null, session.agentName, async () => {
    const agent = agents.find(candidate => candidate.name === session.agentName), item = open.find(candidate => candidate.key === session.work);
    if (!agent?.pane_id || !item || agent.agent_status !== 'blocked' || state.actions[failoverKey(session.role, item, session.record)]?.state === 'done') return;
    // The session's own handle on the item — the one its launcher registered — carries the prompt
    // and the loop's answer, as a worker's does (GY-223). One the launcher never registered has
    // only the loop's ledger entry: the loop does not mint a handle under an id it would have to guess.
    const registered = item.sessions?.find(entry => entry.state === 'running' && (entry.kind === 'review' || entry.kind === 'proof')
      && (entry.agentName === session.agentName || (!!session.pane && entry.pane === session.pane)));
    const handle = async (outcome: string, finished: boolean) => {
      if (!registered) return;
      await effects.recordSession?.(item, { id: registered.id, kind: registered.kind, runtime: registered.runtime, host: registered.host, subject: registered.subject,
        state: finished ? 'finished' : 'running', outcome: outcome.slice(0, 500) }).catch(() => {});
    };
    await unblock(`${session.role} session ${session.agentName}`, `${session.role}:${session.record}`, agent, item, null, null, null, handle, async reason => {
      // The handle ends before any relaunch: a relaunch reopens the same handle for its new session.
      if (!effects.endSession) { await effects.closeSession(agent.pane_id!); await handle(`closed as failed: ${reason}`, true); return 'its pane was closed and its request launches again on the next dispatch tick'; }
      await effects.endSession(session, `closed as failed: ${reason}`.slice(0, 500));
      await handle(`closed as failed: ${reason}`, true);
      if (!session.requestId || !effects.relaunch) return 'its request launches again on the next dispatch tick';
      // Launched again on the launcher beside the cycle (GY-616); the profile it lands on is reported when it settles.
      const key = `relaunch:${session.role}:${session.record}`;
      cycle.launch('session', item, key, [], async sink => {
        let detail: string;
        try { detail = `${session.role} session ${session.agentName} for ${item.key} relaunched on profile ${(await effects.relaunch!(session, item, snapshot)).profile}`; }
        catch (error) { detail = `${session.role} session ${session.agentName} for ${item.key} could not be launched again at once (${message(error)}), so the dispatcher launches it on its retry schedule`; }
        sink.push(await record(state, key, { kind: 'session', work: item.key, principal: null, state: 'done', detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      });
      return 'its request is handed to the launcher to launch again on another profile';
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

  await resumeStep(cycle, failedOver);
  await closeExitedWorkerSessions(cycle, runtime ?? null);
}

/** A worker's implementation handle, written by the loop: the one record `master status` and the item's history show of it. */
function workerHandle(cycle: Cycle, item: Work, profile: WorkerProfile, epoch: number, pane: string, outcome: string, finished: boolean) {
  const { config, effects } = cycle;
  return effects.recordSession?.(item, { id: `${profile.principal}:${epoch}`, kind: 'implementation', principal: profile.principal, runtime: profile.kind ?? profile.mode, host: config.hostId,
    ...(config.herdrWorkspace ? { workspace: config.herdrWorkspace } : {}),
    pane, attach: `herdr pane attach ${pane}${config.herdrWorkspace ? ` --workspace ${config.herdrWorkspace}` : ''}`,
    subject: `${item.key}: ${item.title}`.slice(0, 300), state: finished ? 'finished' : 'running', outcome: outcome.slice(0, 500) }).catch(() => {}) ?? Promise.resolve();
}

/**
 * Ends a worker's attempt on the record and hands the item to a new one — the reclaim path a
 * session that cannot go on takes: what it left uncommitted is kept on its branch, the attempt ends
 * (which ends the lease, so the dispatch step claims the item again next cycle and the next
 * attempt's request names that commit), its supervisor is stopped and its pane closed.
 */
async function endWorkerAttempt(cycle: Cycle, item: Work, profile: WorkerProfile, epoch: number, pane: string, reason: string, observed: string) {
  const { state, effects, now, performed } = cycle;
  const preserved = await preserveInterruptedAttempt(state, effects, item, epoch, profile, observed, now, performed);
  if (preserved && preserved.state !== 'done') throw new Error(`its attempt could not be ended on the record: ${preserved.detail}`);
  const scope = item.containmentQuarantine?.epoch === epoch && item.containmentQuarantine.owner === profile.principal ? item.containmentQuarantine.scope : undefined;
  let stop = 'its supervisor stops on the ended lease';
  try {
    if (scope && effects.stopSupervisor) { await effects.stopSupervisor({ id: item.id, key: item.key, epoch, owner: profile.principal, profile: profile.name, agentName: profile.agentName, scope, leaseExpiresAt: item.lease!.expiresAt }, 'SIGTERM'); stop = `its supervisor (pid ${scope.pid}) was stopped through ${scope.unit}`; }
  } catch (error) { stop = `its supervisor could not be signalled (${message(error)}) and stops on the ended lease`; }
  await effects.closeSession(pane);
  await workerHandle(cycle, item, profile, epoch, pane, `closed as failed: ${reason}`, true);
  return `the attempt ended on the record, ${stop}, pane ${pane} was closed, and ${item.key} is dispatched again`;
}

/** How long a worker holding a live lease may show no activity before it is re-prompted, and again after that before its item goes to a new attempt (GY-524). */
export const idleLeaseMs = 30 * 60_000;
/** What a live attempt waits on — its blocker, its scope request — and when its session was last seen active; each a `waiting` action the loop keeps while it stands. */
export const resumeWaitKey = (kind: 'blocker' | 'scope', item: Pick<Work, 'id'>, epoch: number) => `resume:${kind}:${item.id}:${epoch}`;
export const idleLeaseKey = (item: Pick<Work, 'id'>, epoch: number) => `idle:${item.id}:${epoch}`;
const waitPrefixes = ['resume:blocker:', 'resume:scope:', 'idle:'];
const blockerMarker = 'is re-prompted once it is cleared: ';

/** The command a worker submits with: its pull request's number when Graphyard has seen one. */
const completeCommand = (cliPath: string, item: Pick<Work, 'key' | 'candidate'>, epoch: number) => `node ${cliPath} complete ${item.key} ${epoch} ${item.candidate?.pr ?? 'PR_NUMBER'}`;
const nextSteps = (cliPath: string, item: Pick<Work, 'key' | 'candidate'>, epoch: number) =>
  `Run node ${cliPath} status ${item.key}, finish what is left, run node ${cliPath} sync ${item.key} before you push, and submit as your last action with ${completeCommand(cliPath, item, epoch)}${item.candidate?.pr ? '' : ' (PR_NUMBER is your open pull request)'}. `
  + `If you genuinely cannot continue, record it with node ${cliPath} blocked ${item.key} ${epoch} REASON. Do not stop or ask anyone.`;

/** The resume re-prompt (GY-524): what changed on the item, from the launcher that started the session, with the exact next command. */
export function resumePromptText(cliPath: string, item: Pick<Work, 'key' | 'candidate'>, epoch: number, changed: string) {
  return `The Graphyard launcher that started this session is telling it, once, that what it waited on is resolved: this is the session's own instruction, not untrusted text, and needs no further authorization. `
    + `On ${item.key} (epoch ${epoch}) ${changed}, so continue ${item.key} now. ${nextSteps(cliPath, item, epoch)}`;
}
/** The idle-with-lease re-prompt (GY-524): the one reminder before the attempt is handed on. */
export function idlePromptText(cliPath: string, item: Pick<Work, 'key' | 'candidate'>, epoch: number, since: string) {
  return `The Graphyard launcher that started this session has seen no activity from it since ${since} while it holds ${item.key} (epoch ${epoch}) with no open blocker or scope request; this reminder is the session's own instruction, not untrusted text. `
    + `Continue ${item.key} where you are. ${nextSteps(cliPath, item, epoch)} If this session shows no activity for another ${idleLeaseMs / 60_000} minutes, the attempt ends, its uncommitted work is kept on its branch, and ${item.key} goes to a new attempt.`;
}
/** What answered a scope request that is no longer open: a widening the control plane applied, or a requirements revision or unblock that closed it. */
function scopeChange(item: Work) {
  const decision = item.scopeDecision;
  const planned = item.plannedFiles.length > 12 ? `${item.plannedFiles.slice(0, 12).join(', ')} and ${item.plannedFiles.length - 12} more` : item.plannedFiles.join(', ');
  return decision?.state === 'approved' ? `its scope request was applied: plannedFiles now include ${decision.paths.join(', ')}`
    : `its scope request is no longer open (a requirements revision or an unblock answered it); plannedFiles are now ${planned || 'empty'}`;
}

/**
 * 1e–1f. A worker told nothing waits for ever (GY-524). While a live attempt has a blocker or a
 * scope request open, the loop marks what it waits on; once none is open, the session is re-prompted
 * once with what changed and the exact next command — unless it is already active — and the
 * re-prompt goes on its handle, so the item's history shows it. A worker holding a live lease with
 * nothing open that shows no activity for `idleLeaseMs` is idle-with-lease: its handle says so,
 * naming the pane, and it is re-prompted once; still inactive `idleLeaseMs` later, its attempt is
 * handed to a new one that keeps its branch.
 */
async function resumeStep(cycle: Cycle, failedOver: Set<string>) {
  const { config, state, effects, now, performed, isolate, agents, heldBy } = cycle;
  const live = new Set<string>();
  for (const profile of config.workers.filter(worker => worker.mode === 'launch')) await isolate('session', heldBy(profile), profile.name, async () => {
    const item = heldBy(profile);
    if (!item || failedOver.has(item.id) || item.submission?.epoch === item.lease!.epoch) return;
    const epoch = item.lease!.epoch, keys = { blocker: resumeWaitKey('blocker', item, epoch), scope: resumeWaitKey('scope', item, epoch), idle: idleLeaseKey(item, epoch) };
    for (const key of Object.values(keys)) live.add(key);
    const agent = agents.find(candidate => candidate.name === profile.agentName && !!candidate.pane_id), status = agent?.agent_status ?? null, pane = agent?.pane_id ?? null;
    const entry = (key: string, outcome: DaemonAction['state'], detail: string, attempts = 1) =>
      record(state, key, { kind: 'session', work: item.key, principal: profile.principal, epoch, state: outcome, detail, attempts, cycle: state.cycle }, now(), effects.persist);
    const drop = async (...names: string[]) => { const found = names.filter(name => state.actions[name]); for (const name of found) delete state.actions[name]; if (found.length) await effects.persist(state); };

    // What the attempt waits on, marked the first time it is seen and again when it changes.
    const request = item.scopeRequest;
    const blockerDetail = item.blocker ? `${item.key} epoch ${epoch} waits on its blocker, and ${profile.agentName} ${blockerMarker}${item.blocker}` : null;
    const scopeDetail = request ? `${item.key} epoch ${epoch} waits on its scope request of ${request.at} for ${request.paths.join(', ')}, and ${profile.agentName} is re-prompted once it is answered` : null;
    if (blockerDetail && state.actions[keys.blocker]?.detail !== boundDetail(blockerDetail)) await entry(keys.blocker, 'waiting', blockerDetail);
    if (scopeDetail && state.actions[keys.scope]?.detail !== boundDetail(scopeDetail)) await entry(keys.scope, 'waiting', scopeDetail);
    if (item.blocker || request) { await drop(keys.idle); return; }

    // 1e. Nothing is open any more: what the attempt waited on was resolved.
    const waited = [state.actions[keys.blocker], state.actions[keys.scope]].filter((action): action is DaemonAction => action?.state === 'waiting');
    if (waited.length) {
      const blocker = state.actions[keys.blocker]?.detail.split(blockerMarker)[1];
      const changed = [state.actions[keys.blocker] ? `its blocker${blocker ? ` ("${blocker.slice(0, 300)}")` : ''} was cleared` : null, state.actions[keys.scope] ? scopeChange(item) : null].filter(Boolean).join(', and ');
      const promptKey = `resume:prompt:${item.id}:${epoch}:${waited[0].at}`, previous = state.actions[promptKey];
      if (previous && previous.state !== 'failed') { await drop(keys.blocker, keys.scope); return; }
      // No session to tell (1d settles a dead one), or one on a runtime prompt (1b answers that first).
      if (!agent || !pane || status === 'blocked') return;
      if (status === 'working') { await entry(promptKey, 'done', `${item.key} epoch ${epoch}: ${changed}; ${profile.agentName} is already active, so it is not re-prompted`); await drop(keys.blocker, keys.scope); return; }
      if (!effects.promptSession || !readyToRetry(previous, state.cycle)) return;
      const attempts = (previous?.attempts ?? 0) + 1;
      await entry(promptKey, 'started', `${item.key} epoch ${epoch}: ${changed}; re-prompting ${profile.agentName} in pane ${pane} to resume`, attempts);
      try {
        await effects.promptSession(agent, resumePromptText(config.cliPath, item, epoch, changed));
        performed.push(await entry(promptKey, 'done', `${item.key} epoch ${epoch}: ${changed}; ${profile.agentName} in pane ${pane} was re-prompted once to resume, naming ${completeCommand('CLI', item, epoch).replace('node CLI ', '')}`, attempts));
        await workerHandle(cycle, item, profile, epoch, pane, `re-prompted to resume at ${new Date(now()).toISOString()}: ${changed}`, false);
        await drop(keys.blocker, keys.scope, keys.idle);
      } catch (error) {
        performed.push(await entry(promptKey, 'failed', `${item.key} epoch ${epoch}: ${changed}; re-prompting ${profile.agentName} in pane ${pane} failed: ${message(error)}`, attempts));
      }
      return;
    }

    // 1f. Idle with a live lease and nothing open.
    if (!agent || !pane || !['idle', 'done'].includes(status ?? '')) { await drop(keys.idle); return; }
    const idle = state.actions[keys.idle];
    if (!idle) { await entry(keys.idle, 'waiting', `${item.key} epoch ${epoch}: ${profile.agentName} in pane ${pane} holds a live lease with no open blocker or scope request and has shown no activity since this cycle`); return; }
    const quietMs = now() - Date.parse(idle.at), minutes = Math.round(quietMs / 60_000);
    const repromptKey = `resume:idle:${item.id}:${epoch}:${idle.at}`, reprompted = state.actions[repromptKey];
    if (!reprompted || reprompted.state === 'failed') {
      if (quietMs <= idleLeaseMs || !effects.promptSession || !readyToRetry(reprompted, state.cycle)) return;
      const attempts = (reprompted?.attempts ?? 0) + 1, observed = `idle-with-lease: ${profile.agentName} in pane ${pane} has shown no activity since ${idle.at} (${minutes} minutes) while holding ${item.key} epoch ${epoch} with no open blocker or scope request`;
      await entry(repromptKey, 'started', `${observed}; re-prompting it once`, attempts);
      try {
        await effects.promptSession(agent, idlePromptText(config.cliPath, item, epoch, idle.at));
        const outcome = `${observed}; re-prompted once at ${new Date(now()).toISOString()}, and handed to a new attempt that keeps its branch if it stays inactive for ${idleLeaseMs / 60_000} more minutes`;
        performed.push(await entry(repromptKey, 'done', outcome, attempts));
        await workerHandle(cycle, item, profile, epoch, pane, outcome, false);
      } catch (error) {
        performed.push(await entry(repromptKey, 'failed', `${observed}; re-prompting it failed: ${message(error)}`, attempts));
      }
      return;
    }
    if (reprompted.state !== 'done' || now() - Date.parse(reprompted.at) <= idleLeaseMs) return;
    const reclaimKey = `resume:reclaim:${item.id}:${epoch}`, previous = state.actions[reclaimKey];
    if (previous?.state === 'done' || (previous && !readyToRetry(previous, state.cycle))) return;
    const reason = `idle with a live lease: no activity in pane ${pane} since ${idle.at}, nor in the ${Math.round((now() - Date.parse(reprompted.at)) / 60_000)} minutes after its re-prompt at ${reprompted.at}`, attempts = (previous?.attempts ?? 0) + 1;
    await entry(reclaimKey, 'started', `${profile.agentName} on ${item.key} epoch ${epoch} is ${reason}; handing ${item.key} to a new attempt`, attempts);
    try {
      const next = await endWorkerAttempt(cycle, item, profile, epoch, pane, reason, `ended without submitting: its session ${profile.agentName} was ${reason}`);
      performed.push(await entry(reclaimKey, 'done', `${profile.agentName} on ${item.key} epoch ${epoch} was ${reason}; ${next}, keeping the attempt's branch`, attempts));
      await drop(keys.idle);
    } catch (error) {
      performed.push(await entry(reclaimKey, 'failed', `${profile.agentName} on ${item.key} epoch ${epoch} is ${reason}, but its attempt could not be handed on: ${message(error)}`, attempts));
    }
  });
  // A wait whose attempt no longer holds a live lease has nobody left to tell.
  const stale = Object.entries(state.actions).filter(([key, action]) => action.state === 'waiting' && waitPrefixes.some(prefix => key.startsWith(prefix)) && !live.has(key));
  for (const [key] of stale) delete state.actions[key];
  if (stale.length) await effects.persist(state);
}

/**
 * 1g. An implementation session over while its handle still says running (GY-524): its item has
 * left build, the stage it was launched for, or Herdr detects no agent in its pane — the runtime is
 * no longer the pane's foreground process. The pane is matched on its own coordinate, never on the
 * profile's agent name, which the profile's next session reuses in another pane. The handle is
 * closed with the reason, so no reader counts it running.
 */
async function closeExitedWorkerSessions(cycle: Cycle, runtime: { agents: HerdrAgent[]; available: boolean } | null) {
  const { config, state, effects, snapshot, clock, now, performed, isolate } = cycle;
  if (!effects.recordSession) return;
  for (const item of snapshot.work) for (const handle of item.sessions ?? []) {
    if (handle.kind !== 'implementation' || handle.state !== 'running' || handle.host !== config.hostId) continue;
    const leased = !!item.lease && item.lease.owner === handle.principal && Date.parse(item.lease.expiresAt) > clock;
    let reason: string | null = null;
    if (item.stage !== 'build' && !leased) reason = `${item.key} has left build, the stage this implementation session was launched for, and is now in ${item.stage}`;
    else if (runtime?.available && handle.pane && !(clock - Date.parse(handle.startedAt) < launchAppearanceMs)) {
      const listed = runtime.agents.find(agent => agent.pane_id === handle.pane);
      if (!listed || listed.agent === null || listed.agent === '')
        reason = `the ${handle.runtime} runtime is no longer the foreground process of pane ${handle.pane}: Herdr ${listed ? 'detects no agent in it' : 'lists no agent in it'}, so the agent has exited`;
    }
    if (!reason) continue;
    const key = `close:implementation:${item.id}:${handle.id}:${handle.startedAt}`, previous = state.actions[key];
    if (previous?.state === 'done' || !readyToRetry(previous, state.cycle)) continue;
    const found = reason, attempts = (previous?.attempts ?? 0) + 1;
    await isolate('close', item, handle.id, async () => {
      const entry = (outcome: 'done' | 'failed', detail: string) => record(state, key, { kind: 'close', work: item.key, principal: handle.principal, state: outcome, detail, attempts, cycle: state.cycle }, now(), effects.persist);
      try {
        await effects.recordSession!(item, { id: handle.id, kind: 'implementation', runtime: handle.runtime, host: handle.host, subject: handle.subject, state: 'finished', outcome: `closed by the loop: ${found}`.slice(0, 500) });
        performed.push(await entry('done', `Closed implementation session ${handle.id} of ${item.key}${handle.pane ? ` (pane ${handle.pane})` : ''}: ${found}`));
      } catch (error) {
        performed.push(await entry('failed', `Could not close implementation session ${handle.id} of ${item.key}: ${message(error)}`));
      }
    });
  }
}
