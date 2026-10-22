// Concern: cycle steps 1–1b and 1g — close finished sessions, fail over exhausted ones, answer blocked prompts and close exited sessions; the resume waits they hand to live in cycle-resume.ts.
import type { Work } from '../model.js';
import { detectRetryingExhaustion, silentPaneExhaustion, type CapacityRole, type ExhaustionSignal } from '../model/capacity.js';
import { detectRuntimeExhaustion } from '../master/environments.js';
import { launchStartMs } from '../master/launch.js';
import { screenMotion, stallScreenLines } from '../master/screen-motion.js';
import { classifyRuntimePrompt, continueAfterDecline, type HerdrAgent, isProfileSession, ownLoginAccounts, profileAccount, type RuntimePrompt, type SessionIdentity, type WorkerProfile } from '../master.js';
import { message } from './state.js';
import { closeKey } from './reconcile.js';
import { clearProfileFailure, readyToRetry } from './sessions.js';
import { paneAlreadyGone } from '../request-settlement.js';
import { blockedPromptAnswers, blockedPromptFailMs, blockedPromptSettleMs, failoverKey, launchAppearanceMs, promptDigest, type LaunchedSession, preserveInterruptedAttempt, record, stoppedStates } from './effects.js';
import { checkPaneStillBelongs, endWorkerAttempt, resumeStep, workerHandle } from './cycle-resume.js';
import type { Cycle } from './cycle.js';
import { carriedCall, carriedRow, owedWrite, supersedeOwed, recordCarried, stepCallCarried, unboundedEffects, withinStepBudget } from './step-budget.js';

/** GY-1774: the continuation each session slot still owes after its decline keys were sent, kept while a carried prompt is retried (lost with the loop, when the session's own idle handling takes over). */
const owedContinuations = new WeakMap<object, Map<string, { key: string; text: string; outcome: string }>>();
export { idleLeaseMs, idleReclaimMs, idleRepromptGraceMs, resumeWaitKey, idleLeaseKey, resumePromptText, idlePromptText } from './cycle-resume.js';

/**
 * A listed session's limit notice: a stopped one by its runtime's own notices, one its host still
 * reports working only when its runtime is retrying on the notice (GY-973).
 */
export const sessionExhaustion = (output: string, stopped: boolean, runtime: string | null | undefined, now: number): ExhaustionSignal | null =>
  stopped ? detectRuntimeExhaustion(output, runtime, now) : detectRetryingExhaustion(output, now);

/**
 * How often the loop reads the screen of a session its host still reports working (GY-1223). A
 * stopped session is read every cycle — it waits for a person — but a working one is read only for
 * its runtime's retry banner (GY-973), and a fleet of them is one Herdr screen read each per cycle:
 * once a minute bounds that while a session retrying on a spent account is still found in a minute.
 */
export const workingOutputReadMs = 60_000;
/** When each working pane's screen was last read, per loop state: a relaunched session is a new pane, read at once. */
const workingReads = new WeakMap<object, Map<string, number>>();
/**
 * Whether `agent`'s screen is due a read this cycle: always when stopped, and once per
 * `workingOutputReadMs` while working. Panes no longer listed are forgotten.
 */
export function outputReadDue(state: object, agents: readonly HerdrAgent[], agent: HerdrAgent, stopped: boolean, clock: number) {
  if (stopped) return true;
  const reads = workingReads.get(state) ?? new Map<string, number>();
  workingReads.set(state, reads);
  const listed = new Set(agents.map(candidate => candidate.pane_id ?? candidate.name ?? ''));
  for (const pane of reads.keys()) if (!listed.has(pane)) reads.delete(pane);
  const pane = agent.pane_id ?? agent.name ?? '', last = reads.get(pane);
  if (last !== undefined && clock - last < workingOutputReadMs && clock >= last) return false;
  reads.set(pane, clock);
  return true;
}

export const closeStep = (cycle: Cycle) => withinStepBudget(cycle, 'sessions', ['closeSession', 'endSession', 'relaunch', 'answerSession', 'promptSession', 'launchedSessions', 'sessionOutput', 'herdr', 'recordSession', 'reportCapacity', 'holdAccount', 'selectedAccount', 'preserveWork'], closeStepWithin); // GY-1774: every call the step makes — each session call, screen read, inventory, record, hold and capacity report — is bounded
async function closeStepWithin(cycle: Cycle) {
  const { config, state, effects, now, snapshot, clock, performed, isolate, agents, open, owns, heldBy } = cycle;
  // Whether a live lease of `principal` is worked in the worktree `cwd` names (…/worktrees/GY-N-EPOCH).
  const workedHere = (principal: string, cwd: string | undefined) => open.some(item => !!item.lease && item.lease.owner === principal
    && Date.parse(item.lease.expiresAt) > clock && !!cwd && cwd.replace(/ \(deleted\)$/, '').endsWith(`/${item.key}-${item.lease.epoch}`));
  // 1. Close finished worker sessions. Authority stops at the lease, so a launched agent with no
  //    active assignment has nothing left to do and its pane must not linger holding a provider seat.
  //    The pane a live attempt's own handle records is that attempt's session (GY-852) and is never
  //    closed as finished: profiles reuse agent names across sessions, so the name of a profile with
  //    no active assignment can be held by another item's live session, and closing it by name would
  //    end that item's worker.
  const heldPanes = new Set(open.flatMap(item => !!item.lease && Date.parse(item.lease.expiresAt) > clock
    ? (item.sessions ?? []).filter(s => s.kind === 'implementation' && s.pane).map(s => s.pane!) : []));
  // The sightings that still stand this cycle; any other on a launch profile's panes is dropped below.
  const sighted = new Set<string>();
  for (const profile of config.workers.filter(worker => worker.mode === 'launch')) await isolate('close', null, profile.name, async () => {
    const matchingAgents = agents.filter(candidate => candidate.name && isProfileSession(profile, candidate.name));
    for (const agent of matchingAgents) {
      if (!agent.pane_id || heldPanes.has(agent.pane_id)) continue;
      // A runtime that left its pane (Herdr detects no agent in it: a bare shell, status unknown) never
      // reports idle, yet its agent name keeps the profile from every dispatch (2026-09-26: six of ten
      // profiles held for hours). Such a pane is closed unless a live lease of its principal is worked
      // in the worktree it stands in, and only once it has stood so for launchAppearanceMs, so a launch
      // whose runtime has not yet started is never taken for one that exited.
      // A holder Herdr reports 'unknown' or with no status, runtime present or not, is not running
      // either (GY-1166): it holds the name at its bound until closed, so it takes the same
      // launchAppearanceMs confirmation. Only a status Herdr reports as working is never closed here.
      const unrecognized = !['idle', 'done', 'blocked', 'working'].includes(agent.agent_status ?? '');
      const seenKey = `exited:${profile.name}:${agent.pane_id}`;
      // A sighting stands only while the pane keeps reading so: one that reports a status since starts the wait over.
      if (!unrecognized) delete state.actions[seenKey];
      if (agent.agent_status === 'working') continue;
      const exited = !agent.agent && unrecognized;
      if (exited && agent.cwd ? workedHere(profile.principal, agent.cwd) : owns(profile.principal)) continue;
      const key = closeKey(profile, agent.pane_id);
      if (state.actions[key]?.state === 'done') continue;
      if (unrecognized) {
        sighted.add(seenKey);
        // The sighting is a wait, not an action in flight: a `started` row would be resumed as an
        // interrupted close (indeterminate, a standing action:close fault, its clock reset each cycle).
        const seen = state.actions[seenKey];
        if (seen?.state !== 'waiting') { await record(state, seenKey, { kind: 'close', work: null, principal: profile.principal, state: 'waiting', detail: `${exited ? `${agent.name}'s runtime has left pane ${agent.pane_id}` : `${agent.name} in pane ${agent.pane_id} reports ${agent.agent_status ?? 'no status'}`}, which holds no live assignment; it is closed if that still stands in ${launchAppearanceMs / 1000}s`, attempts: 1, cycle: state.cycle }, now(), effects.persist); continue; }
        if (now() - Date.parse(seen.at) < launchAppearanceMs) continue;
      }
      await record(state, key, { kind: 'close', work: null, principal: profile.principal, state: 'started', detail: `Closing ${agent.name}: no active Graphyard assignment`, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
      try {
        await effects.closeSession(agent.pane_id);
        // Its sighting goes with the pane, in this step's sweep.
        sighted.delete(seenKey);
        performed.push(await record(state, key, { kind: 'close', work: null, principal: profile.principal, state: 'done', detail: `Closed finished session ${agent.name} (${exited ? 'its runtime exited' : agent.agent_status ?? 'no status'}) with no active assignment`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        if (stepCallCarried(error)) { await recordCarried(cycle, key, { kind: 'close', work: null, principal: profile.principal }, error, `Closing finished session ${agent.name}`); continue; }
        performed.push(await record(state, key, { kind: 'close', work: null, principal: profile.principal, state: 'failed', detail: `Could not close ${agent.name}: ${message(error)}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
      }
    }
  });
  // A sighting whose pane was closed, is no longer listed, or reads a recognised status is dropped,
  // so no row outlives its pane.
  const launchProfiles = config.workers.filter(worker => worker.mode === 'launch').map(profile => `exited:${profile.name}:`);
  const stale = Object.keys(state.actions).filter(key => launchProfiles.some(prefix => key.startsWith(prefix)) && !key.startsWith('exited:implementation:') && !sighted.has(key));
  for (const key of stale) delete state.actions[key];
  if (stale.length) await effects.persist(state);

  // 1a. Mid-session exhaustion. A session that ran out of provider quota does not fail: it stops
  //     on its runtime's limit notice and waits for a person. The loop reads that notice from the
  //     session's own output, keeps what the attempt had not committed, holds the account until
  //     it resets, records the exhaustion — account, notice, reset time, partial work — on the
  //     item, and gets the action onto another account: a worker's lease ends in that same
  //     record, so the dispatch step re-queues the item on the next cycle, and a reviewer or
  //     producer request is launched again at once. Nobody repoints a profile by hand.
  const failedOver = new Set<string>();
  if (effects.sessionOutput && effects.reportCapacity) {
    const listed = (name: string) => agents.find(candidate => candidate.name === name) ?? null;
    const stopped = (name: string) => { const agent = listed(name); return agent && stoppedStates.includes(agent.agent_status ?? '') ? agent : null; };
    // The notice is judged against the session's own runtime's provider messages, never generic
    // quota wording: a worker's prose about a quota (a disk's) is not its provider's notice (GY-421).
    // A session Herdr still reports working counts only when its runtime prints its retry marker
    // beside the notice (GY-973): OpenCode retries a spent account forever and never stops.
    // A working session's screen is read at most once per workingOutputReadMs (GY-1223).
    // A worker is also judged by the runtime its selected account launched (GY-2871: a claude profile's registry Pi session).
    const notice = async (agent: HerdrAgent, ...runtimes: (string | null | undefined)[]) => {
      const isStopped = stoppedStates.includes(agent.agent_status ?? '');
      if (!outputReadDue(state, agents, agent, isStopped, clock)) return null;
      try { const output = await effects.sessionOutput!(agent); return output ? runtimes.reduce<ExhaustionSignal | null>((found, runtime) => found ?? sessionExhaustion(output, isStopped, runtime, clock), null) : null; } catch (error) { if (stepCallCarried(error)) throw error; return null; } // GY-1774: a carried read is the session's carried handling
    };
    const onNotice = (agent: HerdrAgent) => stoppedStates.includes(agent.agent_status ?? '') ? 'stopped on' : 'is retrying on';
    /** The runtime a launched role's profile names, for the notice the loop reads off its pane. */
    const profileRuntime = (role: string, profile: string) =>
      (role === 'reviewer' ? config.reviewers : role === 'producer' ? config.producers : []).find(entry => entry.name === profile)?.kind;
    // A session is charged to the account it launched on, read by its own identity, not the profile's latest (GY-1582).
    const held = async (role: CapacityRole, profile: string, item: Work, signal: { reason: string; resetsAt: string | null }, session: SessionIdentity) => {
      const selected = await effects.selectedAccount?.(role, profile, session) ?? null;
      const account = selected?.environment ?? null;
      // A session on no named account spent its runtime's own login, which other roles launch on too.
      const own = (role === 'worker' ? config.workers : role === 'reviewer' ? config.reviewers : role === 'producer' ? config.producers : []).find(entry => entry.name === profile) ?? { name: profile };
      for (const name of account ? [account] : ownLoginAccounts(own)) await effects.holdAccount?.(name, { at: new Date(clock).toISOString(), resetsAt: signal.resetsAt, reason: signal.reason, role, profile, work: item.key });
      return { account, runtime: selected?.kind ?? null };
    };
    for (const profile of config.workers.filter(worker => worker.mode === 'launch')) await isolate('failover', heldBy(profile), profile.name, async () => {
      const agent = listed(profile.agentName);
      const item = open.find(candidate => !!candidate.lease && candidate.lease.owner === profile.principal && Date.parse(candidate.lease.expiresAt) > clock);
      if (!agent || !item || item.submission?.epoch === item.lease!.epoch) return;
      const key = failoverKey('worker', item, item.lease!.epoch), previous = state.actions[key];
      if (previous?.state === 'done' || !readyToRetry(previous, state.cycle)) { if (previous) failedOver.add(item.id); return; }
      const signal = await notice(agent, profile.kind, (await effects.selectedAccount?.('worker', profile.name, { work: item.key, epoch: item.lease!.epoch }))?.kind);
      if (!signal) return;
      failedOver.add(item.id);
      const epoch = item.lease!.epoch, attempts = (previous?.attempts ?? 0) + 1;
      const resets = signal.resetsAt ? `resets ${signal.resetsAt}` : 'reset time unknown';
      await record(state, key, { kind: 'failover', work: item.key, principal: profile.principal, epoch, state: 'started', detail: `${profile.agentName} on ${item.key} (epoch ${epoch}) ${onNotice(agent)} its provider's limit notice: ${signal.reason}`, attempts, cycle: state.cycle }, now(), effects.persist);
      try {
        const partialWork = await effects.preserveWork?.(item, epoch) ?? { state: 'not-applicable' as const, detail: 'this loop has no access to the attempt worktree' };
        const { account, runtime } = await held('worker', profile.name, item, signal, { work: item.key, epoch });
        await effects.reportCapacity!(item, { event: 'exhausted', role: 'worker', epoch, profile: profile.name, account, runtime: runtime ?? profile.kind ?? null, reason: signal.reason, resetsAt: signal.resetsAt, partialWork });
        // The lease is over on the record, so the item is claimable again and its supervisor stops on the ended lease.
        clearProfileFailure(state, profile);
        performed.push(await record(state, key, { kind: 'failover', work: item.key, principal: profile.principal, epoch, state: 'done',
          detail: `${item.key} epoch ${epoch} exhausted ${account ?? `${profile.name}'s own account`} mid-session (${signal.reason}; ${resets}). Partial work ${partialWork.state}${partialWork.commit ? ` at ${partialWork.commit.slice(0, 12)}` : ''}; the attempt ended as released, its supervisor stops on the ended lease, and ${item.key} is re-queued for another account`,
          attempts, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        if (stepCallCarried(error)) return recordCarried(cycle, key, { kind: 'failover', work: item.key, principal: profile.principal, epoch }, error, `Failing over ${profile.agentName} on ${item.key} epoch ${epoch}`); // GY-1774
        performed.push(await record(state, key, { kind: 'failover', work: item.key, principal: profile.principal, epoch, state: 'failed', detail: `${item.key} epoch ${epoch} exhausted its account (${signal.reason}) but could not be failed over: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist));
      }
    });
    // GY-1705: `done` reviewer/producer screens past the start bound share one pause (cycle-p90).
    // Marker is the work key (in every launch prompt), never the request id.
    const launched = effects.launchedSessions ? await carriedCall(cycle, 'sessions', 'failover', 'launchedSessions', () => effects.launchedSessions!(), () => [] as LaunchedSession[]).catch(() => [] as LaunchedSession[]) : [];
    const doneMotions = new Map<string, Promise<'still' | 'started' | 'moving' | 'unreadable'>>();
    if (effects.sessionOutput) {
      for (const session of launched) {
        const agent = listed(session.agentName), item = open.find(candidate => candidate.key === session.work);
        if (!agent || !item) continue;
        const key = failoverKey(session.role, item, session.record), previous = state.actions[key];
        if (cycle.launcher.busy(key) || previous?.state === 'done' || !readyToRetry(previous, state.cycle)) continue;
        const running = item.sessions?.filter(entry => entry.state === 'running' && (entry.kind === 'review' || entry.kind === 'proof')) ?? [];
        const handle = session.requestId ? running.find(entry => entry.id === session.requestId)
          : running.find(entry => entry.agentName === session.agentName || (!!session.pane && entry.pane === session.pane));
        const startedAt = handle?.startedAt ? Date.parse(handle.startedAt) : Number.NaN;
        const pastStart = Number.isFinite(startedAt) && clock - startedAt >= launchStartMs(config);
        if ((agent.agent_status ?? '') === 'done' && pastStart && !doneMotions.has(session.record)) {
          doneMotions.set(session.record, screenMotion(() => effects.sessionOutput!(agent, stallScreenLines), session.work));
        }
      }
    }
    for (const session of launched) await isolate('failover', open.find(candidate => candidate.key === session.work) ?? null, session.agentName, async () => {
      const agent = listed(session.agentName), item = open.find(candidate => candidate.key === session.work);
      if (!agent || !item) return;
      const key = failoverKey(session.role, item, session.record), previous = state.actions[key];
      // Its relaunch is still on the launcher: the failover is in flight, not due again.
      if (cycle.launcher.busy(key) || previous?.state === 'done' || !readyToRetry(previous, state.cycle)) return;
      const noticeSignal = await notice(agent, profileRuntime(session.role, session.profile));
      const running = item.sessions?.filter(entry => entry.state === 'running' && (entry.kind === 'review' || entry.kind === 'proof')) ?? [];
      const handle = session.requestId ? running.find(entry => entry.id === session.requestId)
        : running.find(entry => entry.agentName === session.agentName || (!!session.pane && entry.pane === session.pane));
      const startedAt = handle?.startedAt ? Date.parse(handle.startedAt) : Number.NaN;
      const pastStart = Number.isFinite(startedAt) && clock - startedAt >= launchStartMs(config);
      const status = agent.agent_status ?? '';
      // Silent spend is Herdr `done` past the start bound with a still untouched screen (GY-1705).
      // Idle stays on the stall path — Herdr reports long commands as idle. A finished-between-ticks
      // session may never have been observed working; its screen still shows the work-key marker.
      let ended = false;
      if (!noticeSignal && pastStart && status === 'done') {
        ended = effects.sessionOutput
          ? (await (doneMotions.get(session.record) ?? screenMotion(() => effects.sessionOutput!(agent, stallScreenLines), session.work))) === 'still'
          : true;
      }
      const signal = noticeSignal ?? silentPaneExhaustion({
        listed: true,
        everWorking: status === 'working' || handle?.observed === 'working',
        hasOutcome: !!handle?.outcome,
        notice: null,
        pastStartBound: pastStart,
        ended,
      });
      if (!signal) return;
      const attempts = (previous?.attempts ?? 0) + 1, resets = signal.resetsAt ? `resets ${signal.resetsAt}` : 'reset time unknown';
      await record(state, key, { kind: 'failover', work: item.key, principal: null, state: 'started', detail: `${session.role} session ${session.agentName} for ${item.key} ${noticeSignal ? `${onNotice(agent)} its provider's limit notice` : 'ended without working'}: ${signal.reason}`, attempts, cycle: state.cycle }, now(), effects.persist);
      try {
        const { account, runtime } = await held(session.role, session.profile, item, signal, { work: item.key, group: session.group });
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
          try { next = `relaunched on profile ${(await (cycle.detached ? unboundedEffects(effects) : effects).relaunch!(session, item, snapshot)).profile}`; }
          catch (error) {
            next = (error as { capacityExhausted?: boolean })?.capacityExhausted ? `no other account is left for the role (${message(error)}), so it waits for capacity`
              : `it could not be launched again at once (${message(error)}), so the dispatcher launches it on its retry schedule`;
          }
          sink.push(await done(next));
        });
      } catch (error) {
        if (stepCallCarried(error)) return recordCarried(cycle, key, { kind: 'failover', work: item.key }, error, `Failing over ${session.role} session ${session.agentName} for ${item.key}`);
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
  //     A screen that could not be read is a signal not collected, not a prompt (GY-1304): it may
  //     already be answered, so nothing is recorded or timed until a read shows what is there.
  //     A runtime's folder-trust dialog is never answered by the loop (consent-prompt.ts): the
  //     session is closed at once and launched again, and its launch records the folder's trust
  //     before the runtime starts; only a dialog that comes back after that relaunch is waited out.
  const readScreen = async (agent: HerdrAgent) => {
    try { return await effects.sessionOutput!(agent); } catch (error) { if (stepCallCarried(error)) throw error; return null; } // GY-1774: a carried read is the session's carried handling
  };
  const readPrompt = async (agent: HerdrAgent): Promise<RuntimePrompt | null> => {
    // A loop that reads no screens fails a blocked session on its blocked state alone.
    if (!effects.sessionOutput) return { kind: 'unknown', text: 'this loop reads no session screens', keys: null, answer: null };
    // The agent's name is its usual address; its pane is tried when the name reads nothing.
    const screen = await readScreen(agent);
    return classifyRuntimePrompt(screen) ?? (agent.name && agent.pane_id ? classifyRuntimePrompt(await readScreen({ ...agent, name: undefined })) : null);
  };
  const unblock = async (who: string, slot: string, agent: HerdrAgent, item: Work, principal: string | null, epoch: number | null, directory: string | null,
    handle: (outcome: string, finished: boolean) => Promise<unknown>, fail: (reason: string) => Promise<string>) => {
    const prompt = await readPrompt(agent);
    if (!prompt) {
      // GY-1774: the dialog closed after its decline keys were sent, but the continuation carried past the bound is still owed to the session: it is told now, never dropped with the dialog.
      const owing = owedContinuations.get(state)?.get(slot);
      if (!owing) return;
      const row = state.actions[owing.key];
      if (!carriedRow(row)) { owedContinuations.get(state)!.delete(slot); return; }
      try {
        await effects.promptSession?.(agent, owing.text);
        owedContinuations.get(state)!.delete(slot);
        performed.push(await record(state, owing.key, { kind: 'session', work: item.key, principal, epoch, state: 'done', detail: `${who} on ${item.key}: the loop ${owing.outcome}`, attempts: row.attempts, cycle: state.cycle }, now(), effects.persist));
        await handle(`The loop ${owing.outcome}`, false);
      } catch (error) {
        if (stepCallCarried(error)) return recordCarried(cycle, owing.key, { kind: 'session', work: item.key, principal, epoch }, error, `Declining the destructive-command prompt of ${who} on ${item.key}`);
        owedContinuations.get(state)!.delete(slot);
        performed.push(await record(state, owing.key, { kind: 'session', work: item.key, principal, epoch, state: 'failed', detail: `${who} on ${item.key} declined its runtime's destructive-command prompt, but telling it to continue failed: ${message(error)}`, attempts: row.attempts, cycle: state.cycle }, now(), effects.persist));
      }
      return;
    }
    const digest = promptDigest(prompt.text);
    const trustKey = `session:trust:${slot}`, relaunched = state.actions[trustKey];
    if (prompt.kind === 'folder-trust' && relaunched?.state !== 'done') {
      if (relaunched && !readyToRetry(relaunched, state.cycle)) return;
      const reason = `stopped at its runtime's folder-trust dialog "${prompt.text}", which the loop never answers; closed at once so that its launch records the folder's trust before the runtime starts again`;
      const attempts = (relaunched?.attempts ?? 0) + 1;
      await record(state, trustKey, { kind: 'session', work: item.key, principal, epoch, state: 'started', detail: `${who} on ${item.key} ${reason}`, attempts, cycle: state.cycle }, now(), effects.persist);
      try {
        const next = await fail(reason);
        performed.push(await record(state, trustKey, { kind: 'session', work: item.key, principal, epoch, state: 'done', detail: `${who} on ${item.key} ${reason}; ${next}`, attempts, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        if (stepCallCarried(error)) return recordCarried(cycle, trustKey, { kind: 'session', work: item.key, principal, epoch }, error, `Closing ${who} on ${item.key} at its folder-trust dialog`);
        performed.push(await record(state, trustKey, { kind: 'session', work: item.key, principal, epoch, state: 'failed', detail: `${who} on ${item.key} ${reason}, but it could not be closed: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist));
      }
      return;
    }
    const answeredKey = `session:answered:${slot}:${agent.pane_id}:${digest}`, answered = state.actions[answeredKey];
    if (prompt.kind === 'destructive-command' && prompt.keys && effects.answerSession && (answered?.attempts ?? 0) < blockedPromptAnswers) {
      // The decline keys are sent once: a retry of a carried continuation resumes at the prompt, never at the keys.
      const declinedKey = `${answeredKey}:declined`, resume = answered?.state === 'waiting' && state.actions[declinedKey]?.state === 'done';
      // An answered dialog is given time to close before it is answered again; a carried continuation owes only its paste, so it is not held.
      if (answered && !resume && now() - Date.parse(answered.at) < blockedPromptSettleMs) return;
      const attempts = (answered?.attempts ?? 0) + 1;
      await record(state, answeredKey, { kind: 'session', work: item.key, principal, epoch, state: 'started', detail: `${who} on ${item.key} is blocked on its runtime's destructive-command prompt "${prompt.text}"; declining it with "${prompt.answer}"`, attempts, cycle: state.cycle }, now(), effects.persist);
      try {
        if (!resume) {
          await record(state, declinedKey, { kind: 'session', work: item.key, principal, epoch, state: 'started', detail: `${who} on ${item.key}: declining its runtime's destructive-command prompt "${prompt.text}" with "${prompt.answer}"`, attempts, cycle: state.cycle }, now(), effects.persist);
          await effects.answerSession(agent, prompt.keys);
          await record(state, declinedKey, { kind: 'session', work: item.key, principal, epoch, state: 'done', detail: `${who} on ${item.key}: declined its runtime's destructive-command prompt "${prompt.text}" with "${prompt.answer}"`, attempts, cycle: state.cycle }, now(), effects.persist);
        }
        const outcome = `answered its runtime's destructive-command prompt "${prompt.text}" with "${prompt.answer}" and told it to continue with a safe alternative (explicit paths or a mktemp -d directory)`;
        const text = continueAfterDecline(item.key, prompt, directory);
        (owedContinuations.get(state) ?? owedContinuations.set(state, new Map()).get(state)!).set(slot, { key: answeredKey, text, outcome });
        await effects.promptSession?.(agent, text);
        owedContinuations.get(state)!.delete(slot);
        performed.push(await record(state, answeredKey, { kind: 'session', work: item.key, principal, epoch, state: 'done', detail: `${who} on ${item.key}: the loop ${outcome}`, attempts, cycle: state.cycle }, now(), effects.persist));
        await handle(`The loop ${outcome}`, false);
      } catch (error) {
        if (stepCallCarried(error)) return recordCarried(cycle, answeredKey, { kind: 'session', work: item.key, principal, epoch }, error, `Declining the destructive-command prompt of ${who} on ${item.key}`);
        performed.push(await record(state, answeredKey, { kind: 'session', work: item.key, principal, epoch, state: 'failed', detail: `${who} on ${item.key} is blocked on its runtime's destructive-command prompt "${prompt.text}", and declining it failed: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist));
      }
      return;
    }
    const why = prompt.kind === 'destructive-command' ? effects.answerSession ? `the loop declined it ${blockedPromptAnswers} times and it is still showing` : 'this loop cannot send it keys'
      : prompt.kind === 'folder-trust' ? 'the folder-trust dialog came back after the session was launched again' : 'the loop cannot classify it';
    const seenKey = `session:blocked:${slot}:${agent.pane_id}:${digest}`, seen = state.actions[seenKey];
    const minutes = Math.round(blockedPromptFailMs / 60_000);
    if (!seen) {
      performed.push(await record(state, seenKey, { kind: 'session', work: item.key, principal, epoch, state: 'failed', detail: `${who} on ${item.key}${epoch !== null ? ` (epoch ${epoch})` : ''} is waiting on input (Herdr reports it blocked) instead of deciding on its own, at a runtime prompt (${why}): "${prompt.text}". Unless it moves on, the loop closes it as failed with that prompt as the reason in ${minutes} minutes and dispatches ${item.key} again. A session that needs something records a typed request and exits — POST /api/work/${item.key}/request with a type of blocker or note — which names its decider and frees the item, rather than holding its slot at a prompt`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
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
      if (stepCallCarried(error)) return recordCarried(cycle, failKey, { kind: 'session', work: item.key, principal, epoch }, error, `Closing ${who} on ${item.key} as failed at its prompt`);
      performed.push(await record(state, failKey, { kind: 'session', work: item.key, principal, epoch, state: 'failed', detail: `${who} on ${item.key} was ${reason}, but it could not be closed as failed: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist));
    }
  };
  for (const profile of config.workers.filter(worker => worker.mode === 'launch')) await isolate('session', heldBy(profile), profile.name, async () => {
    const item = open.find(candidate => !!candidate.lease && candidate.lease.owner === profile.principal && Date.parse(candidate.lease.expiresAt) > clock);
    if (!item || failedOver.has(item.id)) return;
    const epoch = item.lease!.epoch;
    // The blocked session is the one this attempt's own handle names (GY-852): the keys and the
    // paste reach that attempt's pane, never whichever session holds the profile's agent name now.
    // Before the runtime's coordinates are recorded, the name listing is the only address there is,
    // and what it resolves to is validated against the record before anything is sent.
    const own = item.sessions?.find(s => s.kind === 'implementation' && s.id === `${profile.principal}:${epoch}` && s.pane);
    const agent = own ? agents.find(candidate => candidate.pane_id === own.pane)
      : agents.find(candidate => candidate.name === profile.agentName);
    if (!agent?.pane_id || agent.agent_status !== 'blocked' || checkPaneStillBelongs(item, `${profile.principal}:${epoch}`, agent.pane_id)) return;
    const pane = agent.pane_id;
    const handle = (outcome: string, finished: boolean) => workerHandle(cycle, item, profile, epoch, pane, outcome, finished);
    await unblock(`Worker session ${profile.agentName}`, `${profile.name}:${epoch}`, agent, item, profile.principal, epoch, item.workspaces.find(entry => entry.epoch === epoch)?.path ?? null, handle,
      reason => endWorkerAttempt(cycle, item, profile, epoch, pane, reason, `ended without submitting: its session ${profile.agentName} was ${reason}`));
  });
  for (const session of effects.launchedSessions ? await carriedCall(cycle, 'sessions', 'session', 'launchedSessions', () => effects.launchedSessions!(), () => [] as LaunchedSession[]).catch(() => [] as LaunchedSession[]) : []) await isolate('session', open.find(candidate => candidate.key === session.work) ?? null, session.agentName, async () => {
    const item = open.find(candidate => candidate.key === session.work);
    // The session is found by the pane its launcher recorded for it (GY-852); the name is the
    // fallback only for a launch that recorded no pane at all. A recorded pane the runtime no
    // longer lists is the original session being gone: the name is reusable and may now hold
    // another blocked session, which must never receive this request's continuation (GY-940).
    const agent = session.pane
      ? agents.find(candidate => candidate.pane_id === session.pane)
      : agents.find(candidate => candidate.name === session.agentName);
    if (!agent?.pane_id || !item || agent.agent_status !== 'blocked' || state.actions[failoverKey(session.role, item, session.record)]?.state === 'done') return;
    // The session's own handle on the item — the one its launcher registered — carries the prompt
    // and the loop's answer, as a worker's does (GY-223). One the launcher never registered has
    // only the loop's ledger entry: the loop does not mint a handle under an id it would have to guess.
    // The handle's id is the launch's request id, so that binding is exact and is tried first (GY-472);
    // the agent name or pane is the fallback for a launch that carries no request id.
    const running = item.sessions?.filter(entry => entry.state === 'running' && (entry.kind === 'review' || entry.kind === 'proof')) ?? [];
    const registered = session.requestId ? running.find(entry => entry.id === session.requestId)
      : running.find(entry => entry.agentName === session.agentName || (!!session.pane && entry.pane === session.pane));
    const handle = async (outcome: string, finished: boolean) => {
      if (!registered || !effects.recordSession) return;
      // GY-1774: a best-effort record, owed to the next cycle when carried, never re-sent with the answer it follows.
      if (finished) await supersedeOwed(cycle, `handle:${item.id}:${registered.id}:running`, `the finished record of ${session.agentName}'s handle`);
      await owedWrite(cycle, `handle:${item.id}:${registered.id}:${finished ? 'finished' : 'running'}`, { kind: 'session', work: item.key }, `Recording ${session.role} session ${session.agentName}'s handle on ${item.key}`, 'recordSession', fx => fx.recordSession!(item, { id: registered.id, kind: registered.kind, runtime: registered.runtime, host: registered.host, subject: registered.subject,
        state: finished ? 'finished' : 'running', outcome: outcome.slice(0, 500) }));
    };
    await unblock(`${session.role} session ${session.agentName}`, `${session.role}:${session.record}`, agent, item, null, null, null, handle, async reason => {
      // The handle ends before any relaunch: a relaunch reopens the same handle for its new session.
      // The handle update follows the close, as endWorkerAttempt orders it: if the close throws the
      // pane is still open, so the handle stays running while the ledger records the failed close,
      // and a retry writes it once the close succeeds (GY-472); writing it finished first would
      // describe a session the loop never ended.
      if (!effects.endSession) { await effects.closeSession(agent.pane_id!); await handle(`closed as failed: ${reason}`, true); return 'its pane was closed and its request launches again on the next dispatch tick'; }
      await effects.endSession(session, `closed as failed: ${reason}`.slice(0, 500));
      await handle(`closed as failed: ${reason}`, true);
      if (!session.requestId || !effects.relaunch) return 'its request launches again on the next dispatch tick';
      // Launched again on the launcher beside the cycle (GY-616); the profile it lands on is reported when it settles.
      const key = `relaunch:${session.role}:${session.record}`;
      cycle.launch('session', item, key, [], async sink => {
        let detail: string;
        try { detail = `${session.role} session ${session.agentName} for ${item.key} relaunched on profile ${(await (cycle.detached ? unboundedEffects(effects) : effects).relaunch!(session, item, snapshot)).profile}`; }
        catch (error) { detail = `${session.role} session ${session.agentName} for ${item.key} could not be launched again at once (${message(error)}), so the dispatcher launches it on its retry schedule`; }
        sink.push(await record(state, key, { kind: 'session', work: item.key, principal: null, state: 'done', detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      });
      return 'its request is handed to the launcher to launch again on another profile';
    });
  });

  const runtime = effects.herdr ? await carriedCall(cycle, 'sessions', 'attention', 'herdr', () => effects.herdr!(), () => null) : null; // GY-1774: a carried inventory is recorded, and read again next cycle

  await resumeStep(cycle, failedOver, runtime?.available !== false);
  await closeExitedWorkerSessions(cycle, runtime ?? null);
}

/**
 * Whether the handle's own attempt still stands (GY-1801): no end of it — lapse, reclaim or
 * submission — is on the record yet. While it stands, the lease it held is either live (a stall
 * grace can keep an expired one so, once) or still to be classed by the plane's next pass, and the
 * pane it ran in is the resume step's and the engine's to end with the attempt — never a closer's
 * to take first. An item whose record carries no attempts at all stands nobody's pane back.
 */
export function attemptStanding(item: Pick<Work, 'pipeline'>, handleId: string): boolean {
  const attempts = item.pipeline?.attempts;
  if (!attempts?.length) return false;
  const epoch = Number(handleId.slice(handleId.lastIndexOf(':') + 1));
  const attempt = Number.isInteger(epoch) ? attempts.find(entry => entry.epoch === epoch) : undefined;
  return !!attempt && attempt.endedAt == null;
}

/**
 * 1g. An implementation session over while its handle still says running (GY-524): its item has
 * left build, the stage it was launched for, or Herdr detects no agent in its pane — the runtime is
 * no longer the pane's foreground process. The pane is matched on its own coordinate, never on the
 * profile's agent name, which the profile's next session reuses in another pane. The handle is
 * closed with the reason, so no reader counts it running, and its pane is closed in the same step —
 * the runtime already left, so the pane is a bare shell holding a pty — and the close is recorded
 * with the end (GY-842). A pane that is already gone is recorded as such, not as a failure.
 *
 * Herdr's foreground detection misreads a live agent at times, and a pane can drop out of one
 * listing (GY-544), so an exited runtime is acted on as step 1 acts on one: only when Herdr read
 * the handle's workspace at all, and only once the same sight stands on a later cycle and
 * launchAppearanceMs after it was first seen. Never while the handle's attempt still stands
 * (GY-1801): a lease the plane's stall grace kept live, or one the plane's next pass has yet to
 * class, is the attempt's own hold on its pane, and the sighting bound cannot tell a pane whose
 * runtime left from one a misread hides — so the close waits for the attempt's end, which the
 * engine's lapse or the resume step's reclaim records first.
 */
export async function closeExitedWorkerSessions(cycle: Cycle, runtime: { agents: HerdrAgent[]; available: boolean } | null) {
  const { config, state, effects, snapshot, clock, now, performed, isolate } = cycle;
  if (!effects.recordSession) return;
  const sighted = new Set<string>();
  for (const item of snapshot.work) for (const handle of item.sessions ?? []) {
    if (handle.kind !== 'implementation' || handle.state !== 'running' || handle.host !== config.hostId) continue;
    const leased = !!item.lease && item.lease.owner === handle.principal && Date.parse(item.lease.expiresAt) > clock;
    const seenKey = `exited:implementation:${item.id}:${handle.id}:${handle.startedAt}`;
    let reason: string | null = null;
    if (item.stage !== 'build' && !leased) reason = `${item.key} has left build, the stage this implementation session was launched for, and is now in ${item.stage}`;
    else if (runtime?.available && handle.pane && !attemptStanding(item, handle.id) && !(clock - Date.parse(handle.startedAt) < launchAppearanceMs)) {
      const listed = runtime.agents.find(agent => agent.pane_id === handle.pane);
      if (!leased && listed && ['idle', 'done', 'blocked'].includes(listed.agent_status ?? '')) {
        reason = `${handle.runtime} session in pane ${handle.pane} is ${listed.agent_status} and ${item.key} has no live lease`;
      } else {
        // A pane absent from a listing that holds nothing of its workspace says nothing about the pane.
        const workspace = handle.workspace ?? (handle.pane.includes(':') ? handle.pane.split(':')[0] : null);
        const read = !!listed || !workspace || runtime.agents.some(agent => agent.pane_id?.startsWith(`${workspace}:`));
        const exited = read && (!listed || listed.agent === null || listed.agent === '')
          ? `the ${handle.runtime} runtime is no longer the foreground process of pane ${handle.pane}: Herdr ${listed ? 'detects no agent in it' : 'lists no agent in it'}, so the agent has exited` : null;
        const seen = state.actions[seenKey];
        if (exited) {
          sighted.add(seenKey);
          if (!seen) { await record(state, seenKey, { kind: 'close', work: item.key, principal: handle.principal, state: 'waiting', detail: `${exited}; implementation session ${handle.id} is closed if that still stands on a later cycle, ${launchAppearanceMs / 1000}s from now`, attempts: 1, cycle: state.cycle }, now(), effects.persist); continue; }
          if (seen.cycle === state.cycle || now() - Date.parse(seen.at) < launchAppearanceMs) continue;
          reason = `${exited} (first seen at ${seen.at})`;
        }
      }
    }
    if (!reason) continue;
    const key = `close:implementation:${item.id}:${handle.id}:${handle.startedAt}`, previous = state.actions[key];
    if (previous?.state === 'done' || !readyToRetry(previous, state.cycle)) continue;
    const found = reason, attempts = (previous?.attempts ?? 0) + 1;
    await isolate('close', item, handle.id, async () => {
      const entry = (outcome: 'done' | 'failed', detail: string) => record(state, key, { kind: 'close', work: item.key, principal: handle.principal, state: outcome, detail, attempts, cycle: state.cycle }, now(), effects.persist);
      try {
        // The pane goes first, so the record never says finished beside a pane still standing. A
        // close that fails leaves the handle running: the step is retried whole on a later cycle.
        let closed = '';
        if (handle.pane) {
          try { await effects.closeSession(handle.pane); closed += `; pane ${handle.pane} closed`; }
          catch (error) { if (!paneAlreadyGone(error)) throw error; closed += `; pane ${handle.pane} was already gone`; }
        }
        const outcome = `closed by the loop: ${found}${closed}`.slice(0, 500);
        await effects.recordSession!(item, { id: handle.id, kind: 'implementation', runtime: handle.runtime, host: handle.host, subject: handle.subject, state: 'finished', outcome });
        performed.push(await entry('done', `Closed implementation session ${handle.id} of ${item.key}${handle.pane ? ` (pane ${handle.pane})` : ''}: ${found}${closed}`));
        // Its sighting goes with it, in this cycle's sweep.
        sighted.delete(seenKey);
      } catch (error) {
        if (stepCallCarried(error)) return recordCarried(cycle, key, { kind: 'close', work: item.key, principal: handle.principal }, error, `Closing implementation session ${handle.id} of ${item.key}`);
        performed.push(await entry('failed', `Could not close implementation session ${handle.id} of ${item.key}: ${message(error)}`));
      }
    });
  }
  // A sighting that did not stand this cycle — the agent reappeared, or its handle was closed — starts over.
  const lapsed = Object.keys(state.actions).filter(key => key.startsWith('exited:implementation:') && state.actions[key].state === 'waiting' && !sighted.has(key));
  for (const key of lapsed) delete state.actions[key];
  if (lapsed.length) await effects.persist(state);
}
