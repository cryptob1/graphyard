// Concern: cycle steps 1e–1f — what a live attempt waits on, the re-prompt when its wait clears, the one idle-lease reminder and the reclaim that hands a stalled attempt to a new one (GY-524), with the pane-binding check every paste through these paths must pass (GY-852, GY-940) and the stable-absence bound a cleared wait's reclaim stands on (GY-953).
import type { Work } from '../model.js';
import type { WorkerProfile } from '../master.js';
import { message, type DaemonAction } from './state.js';
import { boundDetail } from './decisions.js';
import { readyToRetry } from './sessions.js';
import { clearedBefore, clearedBlockerKey, failedAttemptCount, overlongKey, overlongReason, reblockedKey, reblockedMarker, reblockedReason } from './reblocked-attempts.js';
import { launchAppearanceMs, preserveInterruptedAttempt, record } from './effects.js';
import { roleSessionMaximumMs } from '../model/sessions.js';
import { credentialBlockedKey, credentialBlockedReason, credentialFailure } from '../worker-credential.js';
import type { Cycle } from './cycle.js';
import { containmentClock, type ContainmentAssessment, type ContainmentObservation } from '../master/containment.js';
import { isTransientSettlementRefusal } from '../quarantine.js';

/** A worker's implementation handle, written by the loop: the one record `master status` and the item's history show of it. */
export function workerHandle(cycle: Cycle, item: Work, profile: WorkerProfile, epoch: number, pane: string | null, outcome: string, finished: boolean) {
  const { config, effects } = cycle;
  return effects.recordSession?.(item, { id: `${profile.principal}:${epoch}`, epoch, kind: 'implementation', principal: profile.principal, runtime: profile.kind ?? profile.mode, host: config.hostId,
    ...(config.herdrWorkspace ? { workspace: config.herdrWorkspace } : {}),
    ...(pane ? { pane, attach: `herdr pane attach ${pane}${config.herdrWorkspace ? ` --workspace ${config.herdrWorkspace}` : ''}` } : {}),
    subject: `${item.key}: ${item.title}`.slice(0, 300), state: finished ? 'finished' : 'running', outcome: outcome.slice(0, 500) }).catch(() => {}) ?? Promise.resolve();
}

/** Settles an attempt's containment quarantine in the same action that ended it, once supervisor death is confirmed on the host. */
export async function settleEndedAttemptFence(cycle: Cycle, item: Work, epoch: number): Promise<boolean> {
  const { state, effects, now, performed, clockOffset, snapshot } = cycle;
  if (!item.containmentQuarantine || item.containmentQuarantine.epoch !== epoch) return false;
  if (!effects.containment || !effects.settleContainment) return false;
  const key = `settle:${item.id}:${epoch}`;
  const previous = state.actions[key];
  const transient = previous?.state === 'failed' && isTransientSettlementRefusal(previous.detail);
  if (previous && (previous.state === 'done' || (!transient && !readyToRetry(previous, state.cycle)) || (transient && !(cycle.state.cycle > previous.cycle)))) return false;
  const measured = await containmentClock(clockOffset, effects.controlPlaneClock);
  const observed: ContainmentObservation = measured
    ? { now: snapshot.now, clockOffset: measured.clockOffset, clockRoundTripMs: measured.roundTripMs, clockSource: measured.source }
    : { now: snapshot.now, clockOffset };
  let assessments: Record<string, ContainmentAssessment> = {};
  try { assessments = await effects.containment([item], observed); } catch {}
  const assessment = assessments[item.id];
  if (!assessment?.settleable) return false;
  const attempts = (previous?.attempts ?? 0) + 1;
  await record(state, key, { kind: 'settle', work: item.key, principal: null, state: 'started', detail: `Settling the verified-dead containment quarantine of ${item.key} epoch ${epoch}`, attempts, epoch, cycle: state.cycle }, now(), effects.persist);
  try {
    await effects.settleContainment(item, assessment);
    item.containmentQuarantine = null;
    performed.push(await record(state, key, { kind: 'settle', work: item.key, principal: null, state: 'done', detail: `Settled the containment quarantine of ${item.key} epoch ${epoch}: its supervisor is verified gone on ${assessment.host ?? 'this host'}, so the item can be claimed again`, attempts: state.actions[key].attempts, epoch, cycle: state.cycle }, now(), effects.persist));
    return true;
  } catch (error) {
    performed.push(await record(state, key, { kind: 'settle', work: item.key, principal: null, state: 'failed', detail: `Containment settlement refused for ${item.key} epoch ${epoch}: ${message(error)}`, attempts: state.actions[key].attempts, epoch, cycle: state.cycle }, now(), effects.persist));
    return false;
  }
}

/**
 * Ends a worker's attempt on the record and hands the item to a new one — the reclaim path a
 * session that cannot go on takes: what it left uncommitted is kept on its branch, the attempt ends
 * (which ends the lease, so the dispatch step claims the item again next cycle and the next
 * attempt's request names that commit), its supervisor is stopped and its pane closed.
 */
export async function endWorkerAttempt(cycle: Cycle, item: Work, profile: WorkerProfile, epoch: number, pane: string | null, reason: string, observed: string, options: { endsBlocker?: true } = {}) {
  const { state, effects, now, performed } = cycle;
  const preserved = await preserveInterruptedAttempt(state, effects, item, epoch, profile, observed, now, performed, options);
  if (preserved && preserved.state !== 'done') throw new Error(`its attempt could not be ended on the record: ${preserved.detail}`);
  const scope = item.containmentQuarantine?.epoch === epoch && item.containmentQuarantine.owner === profile.principal ? item.containmentQuarantine.scope : undefined;
  let stop = 'its supervisor stops on the ended lease';
  try {
    if (scope && effects.stopSupervisor) { await effects.stopSupervisor({ id: item.id, key: item.key, epoch, owner: profile.principal, profile: profile.name, agentName: profile.agentName, scope, leaseExpiresAt: item.lease!.expiresAt }, 'SIGTERM'); stop = `its supervisor (pid ${scope.pid}) was stopped through ${scope.unit}`; }
  } catch (error) { stop = `its supervisor could not be signalled (${message(error)}) and stops on the ended lease`; }
  // A session already gone from Herdr has no pane left to close (GY-867 ends such attempts too).
  if (pane) await effects.closeSession(pane);
  await workerHandle(cycle, item, profile, epoch, pane ?? 'none', `closed as failed: ${reason}`, true);
  item.lease = null;
  if (item.containmentQuarantine?.epoch === epoch) {
    await settleEndedAttemptFence(cycle, item, epoch);
  }
  return `the attempt ended on the record, ${stop}, ${pane ? `pane ${pane} was closed` : 'no pane was left to close'}, and ${item.key} is dispatched again`;
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
 * Why a pane the loop resolved for a paste is not the one this attempt's session is recorded in,
 * or null when it may be pasted into (GY-852).
 *
 * The loop's own handle for a live attempt is the one its id names — the stable `principal:epoch`
 * the dispatch registered — and once the runtime has started it carries the pane the session
 * occupies. That pane is the only address a paste may go to. A launch write cannot record the
 * epoch itself (only the lease holder's writes may, `engine.ts`), so the attempt a handle belongs
 * to is read from its id, not from an epoch field. Before the runtime's coordinates are recorded —
 * and while no handle of this attempt exists at all — the agent-name listing is all the address
 * there is; then the pane the name resolved to is refused when this item's record ties it to
 * another attempt's session, and (GY-940) when this attempt's own handle exists but records no
 * pane yet: its coordinate write failed or has not completed, so the pane the name resolves to
 * cannot be verified as this attempt's, and one no session of this item holds may be another
 * item's. Anything pasted after such a refusal would land on whichever session holds the name
 * now, which is how one item's re-prompt reached another item's pane (2026-09-26).
 */
export function checkPaneStillBelongs(item: Work, handleId: string, pane: string | undefined): string | null {
  if (!pane) return 'no pane recorded';
  const sessions = (item.sessions ?? []).filter(s => s.kind === 'implementation');
  const own = sessions.find(s => s.id === handleId);
  if (own?.pane) return own.pane === pane ? null : `pane ${pane} is not where ${item.key}'s session ${handleId} is recorded (pane ${own.pane}); the profile's agent name has been reassigned`;
  const other = sessions.find(s => s.pane === pane);
  if (other) return `pane ${pane} is recorded for ${item.key}'s session ${other.id}, not for the attempt this paste concerns`;
  if (own) return `pane ${pane} cannot be verified as ${item.key}'s session ${handleId}: its handle records no pane yet (its coordinate write has not completed), so the profile's agent name is no address`;
  return null;
}

/**
 * 1e–1f. A worker told nothing waits for ever (GY-524). While a live attempt has a blocker or a
 * scope request open, the loop marks what it waits on; once none is open, the session is re-prompted
 * once with what changed and the exact next command — unless it is already active — and the
 * re-prompt goes on its handle, so the item's history shows it. A worker holding a live lease with
 * nothing open that shows no activity for `idleLeaseMs` is idle-with-lease: its handle says so,
 * naming the pane, and it is re-prompted once; still inactive `idleLeaseMs` later, its attempt is
 * handed to a new one that keeps its branch. A cleared wait its session cannot verifiably receive
 * — its recorded pane gone from the runtime, or its handle recording no pane — ends the attempt
 * only once that has stood past `launchAppearanceMs` on a later cycle, and a reappearance cancels
 * it: one listing miss ends nothing, and an unverifiable handle is reclaimed on a bound instead of
 * refusing every resolution for ever (GY-953).
 */
export async function resumeStep(cycle: Cycle, failedOver: Set<string>, listingLive: boolean) {
  const { config, state, effects, now, clock, performed, isolate, agents, heldBy } = cycle;
  const live = new Set<string>();
  for (const profile of config.workers.filter(worker => worker.mode === 'launch')) await isolate('session', heldBy(profile), profile.name, async () => {
    const item = heldBy(profile);
    if (!item || failedOver.has(item.id) || item.submission?.epoch === item.lease!.epoch) return;
    const epoch = item.lease!.epoch, keys = { blocker: resumeWaitKey('blocker', item, epoch), scope: resumeWaitKey('scope', item, epoch), idle: idleLeaseKey(item, epoch) };
    for (const key of Object.values(keys)) live.add(key);
    // The session this attempt is told anything in is the one its own handle names — the stable
    // `principal:epoch` id, whose pane the launcher recorded once the runtime started (GY-852).
    // The profile's agent name is reused across sessions, so it is only the fallback for a session
    // whose coordinates are not recorded yet, and what it resolves to is validated against the
    // record before anything is pasted into it.
    const handleId = `${profile.principal}:${epoch}`;
    const handle = item.sessions?.find(s => s.kind === 'implementation' && s.id === handleId);
    const own = handle?.pane ? handle : undefined;
    const agent = own ? agents.find(candidate => candidate.pane_id === own.pane)
      : agents.find(candidate => candidate.name === profile.agentName && !!candidate.pane_id);
    const status = agent?.agent_status ?? null, pane = agent?.pane_id ?? null;
    const entry = (key: string, outcome: DaemonAction['state'], detail: string, attempts = 1) =>
      record(state, key, { kind: 'session', work: item.key, principal: profile.principal, epoch, state: outcome, detail, attempts, cycle: state.cycle }, now(), effects.persist);
    const drop = async (...names: string[]) => { const found = names.filter(name => state.actions[name]); for (const name of found) delete state.actions[name]; if (found.length) await effects.persist(state); };
    /** Ends the idle attempt on the record and hands the item to a new one, closing only a pane that is still this attempt's. */
    const reclaimIdle = async (reason: string, closePane: string | null) => {
      const reclaimKey = `resume:reclaim:${item.id}:${epoch}`, previous = state.actions[reclaimKey];
      if (previous?.state === 'done' || (previous && !readyToRetry(previous, state.cycle))) return;
      const attempts = (previous?.attempts ?? 0) + 1;
      await entry(reclaimKey, 'started', `${profile.agentName} on ${item.key} epoch ${epoch} is ${reason}; handing ${item.key} to a new attempt`, attempts);
      try {
        const next = await endWorkerAttempt(cycle, item, profile, epoch, closePane, reason, `ended without submitting: its session ${profile.agentName} was ${reason}`);
        performed.push(await entry(reclaimKey, 'done', `${profile.agentName} on ${item.key} epoch ${epoch} was ${reason}; ${next}, keeping the attempt's branch`, attempts));
        await drop(keys.idle);
      } catch (error) {
        performed.push(await entry(reclaimKey, 'failed', `${profile.agentName} on ${item.key} epoch ${epoch} is ${reason}, but its attempt could not be handed on: ${message(error)}`, attempts));
      }
    };

    // What the attempt waits on, marked the first time it is seen and again when it changes.
    const request = item.scopeRequest;
    const blockerDetail = item.blocker ? `${item.key} epoch ${epoch} waits on its blocker, and ${profile.agentName} ${blockerMarker}${item.blocker}` : null;
    const scopeDetail = request ? `${item.key} epoch ${epoch} waits on its scope request of ${request.at} for ${request.paths.join(', ')}, and ${profile.agentName} is re-prompted once it is answered` : null;
    if (blockerDetail && state.actions[keys.blocker]?.detail !== boundDetail(blockerDetail)) await entry(keys.blocker, 'waiting', blockerDetail);
    if (scopeDetail && state.actions[keys.scope]?.detail !== boundDetail(scopeDetail)) await entry(keys.scope, 'waiting', scopeDetail);
    // GY-999: a blocker that is a GitHub credential failure is the session's credential, not the
    // item. Waiting on it only holds the lease and the profile's slot, and the same session would
    // fail the same way once unblocked, so the attempt is ended at once with its work kept on its
    // branch, and the next launch mints a fresh credential — or is refused until one can be minted.
    // The end counts on the GY-885 retry ladder, so a failure no fresh mint cures is relaunched
    // after a backoff and held at the cap for an approver instead of ending and relaunching for ever.
    if (item.blocker && !request && credentialFailure(item.blocker)) {
      const key = credentialBlockedKey(item, epoch), previous = state.actions[key];
      if (previous?.state === 'done' || (previous && !readyToRetry(previous, state.cycle))) return;
      const reason = credentialBlockedReason(item, epoch, item.blocker), attempts = (previous?.attempts ?? 0) + 1;
      await entry(key, 'started', `${profile.agentName} on ${item.key} ${reason}; ending the attempt`, attempts);
      try {
        const next = await endWorkerAttempt(cycle, item, profile, epoch, pane, reason, reason, { endsBlocker: true });
        performed.push(await entry(key, 'done', `${profile.agentName} on ${item.key} ${reason}; ${next}, keeping the attempt's branch and ending the blocker it recorded`, attempts));
        await drop(keys.blocker, keys.idle);
      } catch (error) {
        performed.push(await entry(key, 'failed', `${profile.agentName} on ${item.key} ${reason}, but its attempt could not be ended: ${message(error)}`, attempts));
      }
      return;
    }
    // GY-867: blocked again on an epoch whose blocker was already cleared once. Re-prompting the
    // same session again would only repeat the cycle, so the attempt ends and the item goes on.
    const cleared = item.blocker && !request ? clearedBefore(state, item, epoch) : null;
    if (cleared) {
      const key = reblockedKey(item, epoch), previous = state.actions[key];
      if (previous?.state === 'done' || (previous && !readyToRetry(previous, state.cycle))) return;
      const reason = reblockedReason(item, epoch, cleared, item.blocker!), attempts = (previous?.attempts ?? 0) + 1;
      await entry(key, 'started', `${profile.agentName} on ${item.key} ${reason}; ending the attempt`, attempts);
      try {
        const next = await endWorkerAttempt(cycle, item, profile, epoch, pane, reason, reason, { endsBlocker: true });
        performed.push(await entry(key, 'done', `${profile.agentName} on ${item.key} ${reason}; ${next}, keeping the attempt's branch and ending the blocker it recorded`, attempts));
        await drop(keys.blocker, keys.idle);
      } catch (error) {
        performed.push(await entry(key, 'failed', `${profile.agentName} on ${item.key} ${reason}, but its attempt could not be ended: ${message(error)}`, attempts));
      }
      return;
    }

    // GY-885: an attempt that runs past its role's time box is ended and retried fresh with backoff.
    const sessionHandle = item.sessions?.find(h => h.kind === 'implementation' && h.state === 'running' && h.epoch === epoch);
    if (sessionHandle) {
      const startedAt = Date.parse(sessionHandle.startedAt);
      if (Number.isFinite(startedAt)) {
        const ageMs = Math.max(0, clock - startedAt);
        const maximumMs = roleSessionMaximumMs['implementation'];
        if (ageMs > maximumMs) {
          const key = overlongKey(item, epoch), previous = state.actions[key];
          if (!previous || previous.state === 'failed' || readyToRetry(previous, state.cycle)) {
            const failedCount = failedAttemptCount(item);
            const reason = overlongReason(item, epoch, ageMs, maximumMs, failedCount);
            const attempts = (previous?.attempts ?? 0) + 1;
            await entry(key, 'started', `${profile.agentName} on ${item.key} ${reason}; ending the attempt`, attempts);
            try {
              // The reason itself is what the capacity record keeps: it carries the overlong marker
              // the retry ladder reads back, and names the runtime and run the item's history shows.
              const next = await endWorkerAttempt(cycle, item, profile, epoch, pane, reason, reason);
              performed.push(await entry(key, 'done', `${profile.agentName} on ${item.key} ${reason}; ${next}`, attempts));
              await drop(keys.blocker, keys.idle);
            } catch (error) {
              performed.push(await entry(key, 'failed', `${profile.agentName} on ${item.key} ${reason}, but its attempt could not be ended: ${message(error)}`, attempts));
            }
            return;
          }
        }
      }
    }

    if (item.blocker || request) { await drop(keys.idle); return; }

    // 1e. Nothing is open any more: what the attempt waited on was resolved. A scope request asked
    //     and answered between two cycles was never marked, but its decision stays on the item with
    //     the attempt's epoch (GY-544), so a recent one nobody was told of since counts as waited on.
    //     A blocker cleared between two cycles leaves no such record on the item, so it is left
    //     to the idle-with-lease re-prompt below.
    const waited = [state.actions[keys.blocker], state.actions[keys.scope]].filter((action): action is DaemonAction => action?.state === 'waiting');
    const decision = item.scopeDecision, decidedAt = decision?.epoch === epoch ? Date.parse(decision.at) : NaN;
    const unmarked = !state.actions[keys.scope] && Number.isFinite(decidedAt) && now() - decidedAt <= idleLeaseMs
      && !Object.entries(state.actions).some(([key, action]) => key.startsWith(`resume:prompt:${item.id}:${epoch}:`) && action.state !== 'failed' && Date.parse(action.at) >= decidedAt);
    if (waited.length || unmarked) {
      // The recorded pane is listed again: an absence a reclaim bound was started on no longer
      // stands, and a later one starts the bound afresh (GY-953). The name's holder listing while
      // the attempt's own handle still records no pane is not a reappearance.
      if (own && agent && state.actions[keys.idle]) await drop(keys.idle);
      const blocker = state.actions[keys.blocker]?.detail.split(blockerMarker)[1];
      // Remembered for the epoch: a second block after this clearance ends the attempt (GY-867).
      if (state.actions[keys.blocker]?.state === 'waiting' && !state.actions[clearedBlockerKey(item, epoch)])
        await entry(clearedBlockerKey(item, epoch), 'done', blocker ? `"${blocker.slice(0, 300)}"` : 'its earlier blocker');
      const changed = [state.actions[keys.blocker] ? `its blocker${blocker ? ` ("${blocker.slice(0, 300)}")` : ''} was cleared` : null, state.actions[keys.scope] || unmarked ? scopeChange(item) : null].filter(Boolean).join(', and ');
      const promptKey = `resume:prompt:${item.id}:${epoch}:${waited[0]?.at ?? decision!.at}`, previous = state.actions[promptKey];
      if (previous && previous.state !== 'failed') { await drop(keys.blocker, keys.scope); return; }
      // No session to tell (1d settles a dead one), or one on a runtime prompt (1b answers that first).
      if (!agent || !pane || status === 'blocked') {
        // A recorded pane a live runtime no longer lists cannot be told (GY-940): 1d reads the
        // profile's agent name, which another session may now hold, so it would believe this
        // attempt alive for ever and the cleared wait would hold the item indefinitely. The
        // attempt is ended here; the next one the item is dispatched to carries on from its branch.
        // One listing miss is not ownership truth, though — Herdr listings transiently drop panes,
        // and the inventory and its availability check are separate reads — so the absence must
        // stand past `launchAppearanceMs` on a later cycle first, as 1g requires of an exited
        // session; the first miss only starts the reclaim bound (GY-953).
        if (own && !agent && listingLive) {
          const seen = state.actions[keys.idle];
          if (!seen) { await entry(keys.idle, 'waiting', `${item.key} epoch ${epoch}: its pane ${own.pane} has been gone from the runtime since this cycle while its cleared wait stood undelivered, and its agent name is no address; the reclaim bound starts here`); return; }
          if (seen.cycle === state.cycle || now() - Date.parse(seen.at) < launchAppearanceMs) return;
          await reclaimIdle(`its pane ${own.pane} has been gone from the runtime since ${seen.at}, so the cleared wait cannot be delivered to it, and its agent name is no address`, null);
        }
        return;
      }
      // The pane the name resolved — only before this attempt's own pane was recorded — must still
      // be the one the item's record ties to this attempt's session (GY-852): otherwise the
      // resolution is refused with the reason on the record. The waits stand, so the resolution is
      // delivered on a later cycle once the attempt's own pane verifies, instead of being consumed.
      const paneReason = checkPaneStillBelongs(item, handleId, pane);
      if (paneReason) {
        performed.push(await entry(promptKey, 'failed', `${item.key} epoch ${epoch}: ${changed}; the recorded pane cannot be re-prompted: ${paneReason}`, (previous?.attempts ?? 0) + 1));
        // A handle that records no pane (its coordinate write failed or never completed) refuses
        // every resolution for ever: the name-based absence checks see the name's still-listed
        // holder, and the idle recovery below stays unreachable while the waits stand. The unsafe
        // paste stays refused, but the first unverifiable observation starts the same reclaim bound
        // a gone pane starts above, and past it the attempt is handed to a new one that keeps its
        // branch (GY-953). Nothing is closed: no pane is verifiably this attempt's.
        if (!own && handle) {
          const seen = state.actions[keys.idle];
          if (!seen) { await entry(keys.idle, 'waiting', `${item.key} epoch ${epoch}: its handle ${handleId} records no pane yet (its coordinate write has not completed), so the cleared wait cannot be delivered and its agent name is no address; the reclaim bound starts here`); return; }
          if (seen.cycle === state.cycle || now() - Date.parse(seen.at) < launchAppearanceMs) return;
          await reclaimIdle(`its handle ${handleId} has recorded no pane since ${seen.at} (its coordinate write has not completed), so the cleared wait cannot be verified deliverable to it, and its agent name is no address`, null);
        }
        return;
      }
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
    if (!agent || !pane || !['idle', 'done'].includes(status ?? '')) {
      // The attempt's own pane is gone from the runtime — or the runtime lists no agent in it any
      // more, which is the same exit — while it holds the lease (GY-852, AC-2): it cannot be
      // re-prompted, and the profile's agent name — which another item's session may now hold —
      // is no address. Past the idle bound the attempt ends and is redispatched, and nothing is
      // closed: a pane the name resolves to, if any, is not this attempt's. Only a runtime that
      // answered the listing may say the pane is gone; an unreadable one is believed by nobody here.
      if (own && (!agent || !agent.agent) && listingLive) {
        const idle = state.actions[keys.idle];
        if (!idle) {
          // The pane vanished while the session was still active (GY-940): no idle marker was ever
          // created, so this first gone-pane observation starts the same reclaim bound — otherwise
          // the name-based absence checks, reading the name's new holder, end nothing.
          await entry(keys.idle, 'waiting', `${item.key} epoch ${epoch}: its pane ${own.pane} has been gone from the runtime since this cycle while its session held the lease, and its agent name is no address; the reclaim bound starts here`);
          return;
        }
        const reprompted = state.actions[`resume:idle:${item.id}:${epoch}:${idle.at}`];
        if ((reprompted?.state === 'done' ? now() - Date.parse(reprompted.at) : now() - Date.parse(idle.at)) <= idleLeaseMs) return;
        await reclaimIdle(`idle with a live lease: its pane ${own.pane} has been gone from the runtime since ${idle.at}, so it cannot be re-prompted, and its agent name is no address`, null);
      } else await drop(keys.idle);
      return;
    }
    const idle = state.actions[keys.idle];
    if (!idle) { await entry(keys.idle, 'waiting', `${item.key} epoch ${epoch}: ${profile.agentName} in pane ${pane} holds a live lease with no open blocker or scope request and has shown no activity since this cycle`); return; }
    const quietMs = now() - Date.parse(idle.at), minutes = Math.round(quietMs / 60_000);
    const repromptKey = `resume:idle:${item.id}:${epoch}:${idle.at}`, reprompted = state.actions[repromptKey];
    if (!reprompted || reprompted.state === 'failed') {
      if (quietMs <= idleLeaseMs || !effects.promptSession || !readyToRetry(reprompted, state.cycle)) return;
      // The pane the name resolved — only before this attempt's own pane was recorded — must still
      // be the one the item's record ties to this attempt's session before the idle re-prompt
      // (GY-852, AC-2); otherwise the attempt ends as idle and is redispatched, closing nothing.
      const paneReason = checkPaneStillBelongs(item, handleId, pane);
      if (paneReason) {
        await reclaimIdle(`idle with a live lease: pane ${pane} is gone since ${idle.at}; cannot re-prompt (${paneReason})`, null);
        return;
      }
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
    // The pane is re-verified against the record before it is closed, so the final reclaim never
    // closes a pane this attempt no longer holds (GY-852).
    const paneReason = checkPaneStillBelongs(item, handleId, pane);
    await reclaimIdle(`idle with a live lease: no activity in pane ${pane} since ${idle.at}, nor in the ${Math.round((now() - Date.parse(reprompted.at)) / 60_000)} minutes after its re-prompt at ${reprompted.at}${paneReason ? `; its pane no longer verifies (${paneReason})` : ''}`, paneReason ? null : pane);
  });
  // A wait whose attempt no longer holds a live lease has nobody left to tell.
  const stale = Object.entries(state.actions).filter(([key, action]) => action.state === 'waiting' && waitPrefixes.some(prefix => key.startsWith(prefix)) && !live.has(key));
  for (const [key] of stale) delete state.actions[key];
  if (stale.length) await effects.persist(state);
}
