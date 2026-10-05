// Concern: cycle step 4 — dispatch claimable work under capacity and report base refreshes.
import type { Work } from '../model.js';
import { pendingBaseRefresh } from '../merge-queue.js';
import { docsOnlyConflict } from '../model/docs-sync.js';
import { dispatchSort } from '../coordination.js';
import { type CapacityRole, capacitySignature, standingCapacity, describeCapacity } from '../model/capacity.js';
import { parkedOnHuman, humanDecisionLabel, answerCommand } from '../model/human-request.js';
import { humanNeededActions } from '../model/next-action.js';
import { assertDispatchable, dispatchReserved, type ContainmentAssessment, type EscalationSession, type RoleCapacity, roleCapacity } from '../master.js';
import { workspaceDispatchFailure } from '../master/dispatch.js';
import { standingEscalations } from '../model/escalation.js';
import { registeredLaunch } from '../model/session-state.js';
import { type DaemonAction, message } from './state.js';
import { decisionKey, dispatchKey } from './reconcile.js';
import { clearProfileFailure, profileHealth, readyToRetry, recordProfileFailure } from './sessions.js';
import { detailChanged, fitDecisionReason, routineDecision } from './decisions.js';
import { capacityKey, record, stoppedStates } from './effects.js';
import type { Cycle } from './cycle.js';
import { credentialBlockedMarker } from '../worker-credential.js';
import { attemptEndsNeedingRetry, attemptRetryHold, capBinding, capBindingPrefix, maxFailedAttempts, preferOtherRuntime, retryBackoffMs, runtimeToAvoid, type AttemptRetryHold } from './reblocked-attempts.js';
import { hotBeside, hotspots, type Hotspot } from './hotspots.js';
import { researchHold, researchRunner, researchSettings, researchStep } from '../research.js';
import { judgeHostMemory } from '../master-resources.js';
import { dispatchBlockRetryMs, dispatchFailureBlockAfter, dispatchFailureBlocker, noteDispatchFailure } from './dispatch-failures.js';

/** Step 4: dispatch claimable work under capacity, and report base refreshes of in-flight candidates. */
export async function dispatchStep(cycle: Cycle, health: ReturnType<typeof profileHealth>, assessments: Record<string, ContainmentAssessment>) {
  const { config, state, effects, now, snapshot, clock, performed, isolate, agents, credentials, open } = cycle;
  // 4. Dispatch claimable work to a healthy profile. The launcher claims under the worker's own
  //    identity; the daemon never holds a lease. An unhealthy profile is skipped, not waited on.
  //    Planned-file overlap never holds an item (dispatch is optimistic: the merge queue and a
  //    sync round integrate whichever lands second); only exclusive resources do. The smallest
  //    planned scope within a priority is offered first, and within a priority an item that
  //    touches no file two or more live attempts are already changing is offered before one that
  //    does (GY-882): the hot set is computed once from this cycle's snapshot and passed into the
  //    comparator — never derived inside it — and the reorder still holds nothing. Both
  //    preferences yield to starvation (GY-1036): within a priority, an item that has waited
  //    `dispatchStarvationMs` or longer in its stage is offered before every item that has not,
  //    whatever its scope or heat. `master status` reports this same order (dispatchSchedule).
  const hot = hotspots(open, clock), hotFiles = new Set(hot.map(entry => entry.file));
  const offered = dispatchSort(open.filter(item => {
    try { assertDispatchable(item, snapshot.work, snapshot.now); return true; } catch { return false; }
  }), hotFiles, clock);

  // GY-1082: a failure run counts this loop's own consecutive failed launches, so it is retired
  // whenever the snapshot shows the item somewhere a run cannot follow: gone or delivered, carrying
  // a blocker (the one the run recorded, even when the loop stopped before forgetting it, or anyone
  // else's), held under a lease no launch of this loop is running, or past an epoch this loop's
  // last failure did not spend — another dispatcher claimed it in between, so the failures were
  // not consecutive. A later failure then starts a new run.
  for (const [id, run] of Object.entries(state.dispatchFailures)) {
    if (cycle.launcher.keys().some(key => key.startsWith(`dispatch:${id}:`))) continue;
    const item = snapshot.work.find(entry => entry.id === id);
    const claimed = !!item?.lease && Date.parse(item.lease.expiresAt) > clock;
    if (!item || item.stage === 'done' || item.blocker || claimed || item.epoch > run.epoch + 1) delete state.dispatchFailures[id];
  }

  // GY-885: an attempt past its role's time box is ended and retried fresh (cycle-sessions 1f'),
  // as is one blocked on a GitHub credential failure (GY-999, 1e). The retry ladder is computed from the item's own exhaustion record, so it survives this
  // cursor and reads the same from any host: each retry waits 5, then 15 minutes; an item whose
  // attempts end without submitting three times in a row is held with every cause named instead
  // of being redispatched again, and only the decision an independent approver judges resumes it.
  // The loop requests that decision with its operator-agent identity and launches the approver;
  // it never judges its own request, and a refusal ends the requesting.
  const held885 = new Set<string>();
  for (const item of offered) {
    if (!attemptEndsNeedingRetry(item).length) continue;
    await isolate('dispatch', item, item.key, async () => {
      const hold = attemptRetryHold(item, clock, await capResumeApprovedAt(cycle, item));
      if (!hold) return;
      held885.add(item.id);
      if (hold.kind === 'backoff') await recordRetryBackoff(cycle, item, hold);
      else await holdAtCap(cycle, item, hold);
    });
  }

  // 4-research. Research before build (GY-259): an item about to be offered whose requirements
  //     were never researched gets one cheap Pi session first, and waits only while that run is
  //     within its time limit. A run that fails or times out is recorded and the item is built
  //     without a brief; research never holds an item past its bound. It runs only once
  //     `run.research` names the research account: an unconfigured loop dispatches as before.
  const held = new Set([...held885, ...new Set(offered.filter(item => researchHold(item, clock)).map(item => item.id))]);
  if (effects.recordResearch && effects.research && config.run?.research) await isolate('dispatch', null, 'research', async () => {
    const settings = researchSettings(config.run);
    const step = await researchStep({ items: offered.filter(item => !held.has(item.id)), clock, settings, config, cwd: effects.research!.cwd,
      runner: effects.research!.runner ?? researchRunner(settings), record: effects.recordResearch! });
    for (const id of step.held) held.add(id);
    for (const action of step.actions) {
      const item = offered.find(entry => entry.key === action.work)!, key = `research:${item.id}:${action.state}`;
      if (!detailChanged(state.actions[key], action.detail)) continue;
      // A notice, never a failed action: research that fails is recorded on the item and holds nothing.
      performed.push(await record(state, key, { kind: 'dispatch', work: item.key, principal: null, epoch: item.epoch, state: 'done', detail: action.detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
    }
  });
  const claimable = offered.filter(item => !held.has(item.id));

  // 4a. Capacity. A role whose every configured account is spent is not a launch to keep
  //     retrying and not a failure to keep reporting: each item that needs the role records one
  //     capacity escalation naming every account and its reset time, the loop stops launching
  //     that role until the first of them resets, and the cycle says so in one line. Everything
  //     that needs a different role — a review, a proof, a merge, a deployment — runs below
  //     exactly as it would have, and the escalation is withdrawn the cycle an account returns.
  const capacities: RoleCapacity[] = [roleCapacity('worker', config.workers.filter(worker => worker.mode === 'launch'), credentials)];
  if (effects.reportCapacity) {
    const others = await effects.roleHealth?.().catch(() => null) ?? {};
    for (const role of ['reviewer', 'producer', 'approver', 'escalation-handler'] as const) if (others[role]) capacities.push(roleCapacity(role, others[role]!.profiles, others[role]!.health));
    // A waiting record whose escalation no longer stands waits on nothing: step 1 drops it.
    const waitingEscalations = new Set((await effects.escalationSessions?.().catch(() => [] as EscalationSession[]) ?? [])
      .filter(session => session.waiting && open.some(item => item.key === session.work && standingEscalations(item).some(entry => entry.trigger === session.trigger))).map(session => session.work));
    // An item waits on the approver role while it needs a decision no approver session is judging.
    const unjudged = new Set(open.filter(item => {
      const decision = effects.approver ? routineDecision(item, config, clock, assessments[item.id], cycle.baseFailed.get(item.id)) : null, watch = decision ? state.approvals[decisionKey(item, decision)] : undefined;
      return !!decision && !watch?.settledAt && !watch?.exhaustedAt && !agents.some(agent => agent.name === watch?.agentName && !stoppedStates.includes(agent.agent_status ?? ''));
    }).map(item => item.key));
    const needs: Record<CapacityRole, Work[]> = {
      worker: claimable,
      reviewer: open.filter(item => item.autoDispatch?.review?.state === 'requested'),
      producer: open.filter(item => item.autoDispatch?.producers.some(request => request.state === 'requested')),
      approver: open.filter(item => unjudged.has(item.key)),
      // An item waits on the escalation-handler role while a handler for it ended on spent quota with no account left.
      'escalation-handler': open.filter(item => waitingEscalations.has(item.key)),
      // No item waits on the master role: its capacity is the loop's own wait, not an item's (GY-898).
      master: [],
    };
    for (const capacity of capacities) {
      const key = capacityKey(capacity.role), previous = state.actions[key];
      if (capacity.exhausted) {
        const waiting = needs[capacity.role];
        const signature = capacitySignature(capacity.role, capacity.accounts);
        for (const item of waiting) {
          const standing = standingCapacity(item, capacity.role)[0];
          if (standing && capacitySignature(standing.role, standing.accounts) === signature) continue;
          try { await effects.reportCapacity(item, { event: 'escalated', role: capacity.role, accounts: capacity.accounts }); }
          catch (error) { performed.push(await record(state, `${key}:${item.id}`, { kind: 'capacity', work: item.key, principal: null, state: 'failed', detail: `Could not record the ${capacity.role} capacity escalation on ${item.key}: ${message(error)}`, attempts: (state.actions[`${key}:${item.id}`]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist)); }
        }
        const detail = `${describeCapacity(capacity.role, capacity.accounts)}${waiting.length ? `; waiting: ${waiting.map(item => item.key).join(', ')}` : ''}`;
        if (detailChanged(previous, detail)) performed.push(await record(state, key, { kind: 'capacity', work: null, principal: null, state: 'done', detail, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
        continue;
      }
      const restored = open.filter(item => standingCapacity(item, capacity.role).length);
      for (const item of restored) await effects.reportCapacity(item, { event: 'restored', role: capacity.role, reason: `An account for the ${capacity.role} role reports quota again` }).catch(() => {});
      if (restored.length || previous && !previous.detail.startsWith('Restored')) {
        performed.push(await record(state, key, { kind: 'capacity', work: null, principal: null, state: 'done', detail: `Restored: a ${capacity.role} account reports quota again; ${capacity.role} launches resume${restored.length ? ` for ${restored.map(item => item.key).join(', ')}` : ''}`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
      }
    }
  }
  const workersSpent = !!effects.reportCapacity && capacities[0].exhausted;
  // With every approver account spent no approver is launched before the first reset (GY-182).
  const approversSpent = !!effects.reportCapacity && !!capacities.find(capacity => capacity.role === 'approver')?.exhausted;

  // 4b-human. An item parked on a decision only a human may make holds no lease and is not
  //     claimable, so there is nothing to dispatch and nothing to escalate to an agent: the loop
  //     names it once, with how to answer. The answer itself makes the item claimable, and the
  //     dispatch below picks it up on the next cycle — no master session is part of that.
  for (const item of open.filter(parkedOnHuman)) await isolate('human', item, item.key, async () => {
    const request = item.humanRequest!, key = `human:${item.id}:${request.id}`;
    if (state.actions[key]) return;
    performed.push(await record(state, key, { kind: 'human', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'done',
      detail: `${item.key} is parked on a human-only decision (${humanDecisionLabel[request.kind]}): ${request.needed} — ${request.reason}. Its attempt ended without a lease and nothing else waits on it; the human answers with ${answerCommand(item.key, request)} and the loop dispatches it again`,
      attempts: 1, cycle: state.cycle }, now(), effects.persist));
  });

  // 4b-owed. An action no executor may claim is a judgment the loop cannot make: `escalate` and
  //     `request-rework` are decided in the step itself (`actionJudgment`), so the executor holds
  //     no handler for either and the row is never claimed, never fails, and never shows up as a
  //     refused launch. The loop names each one once — what is waiting, what decides it, and the
  //     command that answers it — so an item whose only action is a judgment is visible as owing
  //     one from the cycle that computed it, instead of surfacing five minutes later as an idle
  //     queue row nobody was ever coming for. A concern carried beside an action that is running
  //     is named here too: the work is not frozen by it, and it is not lost behind the work. An
  //     item parked on a human-only decision is named by the step above with the exact answer
  //     command, so it is not named twice.
  for (const owed of humanNeededActions(open.filter(item => !parkedOnHuman(item)), new Date(clock))) {
    const key = `owed:${owed.work}:${owed.kind}:${owed.trigger ?? 'refusal'}:${owed.since}`;
    if (state.actions[key]) continue;
    performed.push(await record(state, key, { kind: 'human', work: owed.key, principal: null, state: 'done',
      detail: `${owed.reason} — no executor may run a ${owed.kind}: it waits on ${owed.decision}, since ${owed.since}. ${owed.resolve}`,
      attempts: 1, cycle: state.cycle }, now(), effects.persist));
  }

  // A plane that cannot record what a launch produces is not dispatched into (GY-132): the worker
  // could not claim, and its work would be recorded nowhere. One escalation names the cause.
  const unrecordable = claimable.length && !workersSpent && effects.planeHealth ? await effects.planeHealth() : null;
  if (unrecordable && detailChanged(state.actions['escalation:dispatch:plane'], `Dispatch held: ${unrecordable}`))
    performed.push(await record(state, 'escalation:dispatch:plane', { kind: 'escalation', work: null, principal: null, state: 'done', detail: `Dispatch held: ${unrecordable}`, attempts: (state.actions['escalation:dispatch:plane']?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
  // A host below its memory floor launches no worker (GY-612): the crossing is recorded once each
  // way — deferred with its reason and top consumers, resumed once memory recovers — and master
  // status raises one `resources` attention item while it stands. Running sessions are left alone.
  const memoryLow = await hostMemoryStep(cycle);
  // Each item's profile is chosen in dispatch order, one after another, and taken before the next
  // item chooses; the launches themselves do not depend on each other and are handed to the
  // launcher beside the cycle (GY-616), which runs them a few at a time while the cycle goes on to
  // its decisions, merges and closes. Each launch holds a distinct healthy profile from hand-off
  // until it settles, across cycles: a profile an earlier cycle's launch still holds is taken.
  const taken = cycle.launcher.held();
  // The `launches` step is the hand-off: choosing each item's profile and handing its launch over.
  await cycle.timings.step('launches', async () => { for (const item of workersSpent || unrecordable || memoryLow ? [] : claimable) if (await isolate('dispatch', item, item.key, async () => {
    const key = dispatchKey(item);
    if (cycle.launcher.busy(key) || (state.actions[key] && state.actions[key].state !== 'failed')) return;
    // GY-860: a workspace failure hands the epoch back, so the next dispatch reuses this key; it
    // waits out the usual doubling backoff instead of retrying the same host git state every cycle.
    const failed = state.actions[key];
    if (failed && workspaceDispatchFailure(failed.detail) && state.cycle - failed.cycle < Math.min(2 ** failed.attempts, 30)) return;
    // GY-1078: an item whose dispatches keep failing for one cause is not dispatched again; the
    // cause is recorded as its blocker, and a block the control plane refused is asked for again.
    const failing = state.dispatchFailures[item.id];
    if (failing && failing.count >= dispatchFailureBlockAfter) { performed.push(...await blockRepeatedFailure(item)); return; }
    const free = await effects.agents();
    // After an attempt ended as reblocked (GY-867), a profile on another runtime is tried first.
    const order = preferOtherRuntime(health, runtimeToAvoid(item));
    const pick = () => order.find(entry => entry.healthy && !taken.has(entry.profile.name) && !free.some(agent => agent.name === entry.profile.agentName));
    let choice = pick();
    if (!choice) {
      // Every launch profile working is capacity, not a decision for anyone. Escalate only when no
      // profile could take work even if it were free.
      const launchable = health.filter(entry => entry.profile.mode === 'launch');
      if (!launchable.some(entry => entry.healthy || entry.busy)) {
        const detail = `No worker profile can take ${item.key}: ${launchable.map(entry => `${entry.profile.name} (${entry.reason})`).join('; ') || 'no launch profile is configured'}`;
        const escalationKey = `escalation:dispatch:${item.id}`;
        if (detailChanged(state.actions[escalationKey], detail)) performed.push(await record(state, escalationKey, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail, attempts: (state.actions[escalationKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      }
      return 'stop';
    }
    taken.add(choice.profile.name);
    const holds = [choice.profile.name];
    // Captured at decision time: the launch runs on the launcher after this cycle may have ended,
    // and the record it writes must name the contention this ordering acted on (GY-882).
    const beside = hotBeside(item, hot);
    cycle.launch('dispatch', item, key, holds, sink => launch(item, key, choice!, free, pick, holds, sink, beside));
  }) === 'stop') break; });

  /**
   * GY-1078: the item's dispatches failed `dispatchFailureBlockAfter` times in a row for one cause.
   * The cause becomes the item's blocker, so neither this loop nor an executor dispatches it again
   * until an operator clears it; the run is then forgotten, and a later failure starts a new one.
   * Without the effect, or when the control plane refuses, the run stands and holds the item here;
   * a refused block is asked for again only after `dispatchBlockRetryMs`, never every cycle. The
   * run keeps one escalation record, whose attempts count the refusals.
   */
  async function blockRepeatedFailure(item: Work): Promise<DaemonAction[]> {
    const run = state.dispatchFailures[item.id]!, reason = dispatchFailureBlocker(run), key = `escalation:dispatch-failures:${item.id}:${run.firstAt}`;
    const previous = state.actions[key];
    const note = async (outcome: 'done' | 'failed' | 'waiting', detail: string, always = false) => always || detailChanged(previous, detail)
      ? [await record(state, key, { kind: 'escalation', work: item.key, principal: null, epoch: item.epoch, state: outcome, detail, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist)] : [];
    if (!effects.blockDispatch) return note('waiting', `${reason}. This loop cannot record a blocker, so it holds ${item.key} itself until it restarts`);
    if (previous?.state === 'failed' && now() - Date.parse(previous.at) < dispatchBlockRetryMs(previous.attempts)) return [];
    try { await effects.blockDispatch(item, reason); }
    catch (error) { return note('failed', `Could not record the blocker on ${item.key}, so the loop holds it and asks again after ${dispatchBlockRetryMs((previous?.attempts ?? 0) + 1) / 60_000} minutes: ${message(error)}. ${reason}`, true); }
    delete state.dispatchFailures[item.id];
    return note('done', `Recorded the blocker on ${item.key}: ${reason}. It is dispatched again once the blocker is cleared (graphyard unblock ${item.key} REASON)`);
  }

  /** What a dispatch that starts on a hot file adds to its record, so master status can show the contention (GY-882). */
  function hotspotNote(beside: Pick<Hotspot, 'file'> & { beside: string[] } | null) {
    if (!beside) return '';
    const who = beside.beside.join(' and ');
    return `; it starts on ${beside.file}, which ${who} ${beside.beside.length === 1 ? 'is' : 'are'} already changing (GY-882 hot spot)`;
  }

  /**
   * One item's launch on the profile chosen for it, passing a profile another dispatcher holds over
   * for the next free one. It runs on the launcher, after the cycle that chose it may have ended, so
   * what it records goes to `performed` — the launcher's sink the next cycle reports.
   */
  async function launch(item: Work, key: string, chosen: NonNullable<ReturnType<typeof health.find>>, free: Awaited<ReturnType<typeof effects.agents>>, pick: () => ReturnType<typeof health.find>, holds: string[], performed: DaemonAction[], beside: { file: string; beside: string[] } | null) {
    let choice = chosen;
    const previous = state.actions[key];
    for (;;) {
      const current = choice;
      taken.add(current.profile.name);
      if (!holds.includes(current.profile.name)) holds.push(current.profile.name);
      await record(state, key, { kind: 'dispatch', work: item.key, principal: current.profile.principal, epoch: item.epoch, state: 'started', detail: `Dispatching ${item.key} to ${current.profile.name}`, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
      try {
        // The session is registered before its runtime starts (GY-172), where every Graphyard reader
        // looks, and its pane written once it has: watching this specific agent never means asking
        // this loop to relay its pane id, and the session report observes it from its first tick.
        const launched = await registeredLaunch(effects.recordSession ? handle => effects.recordSession!(item, handle) : undefined, {
          id: `${current.profile.principal}:${item.epoch + 1}`, kind: 'implementation', principal: current.profile.principal, runtime: current.profile.kind ?? current.profile.mode, host: config.hostId,
          ...(config.herdrWorkspace ? { workspace: config.herdrWorkspace } : {}),
          subject: `${item.key}: ${item.title}`.slice(0, 300), state: 'running',
        }, async () => await effects.dispatch(item, current.profile, free, snapshot) as { pane?: string | null; agentName?: string; principal?: string; reclaimed?: string[] } | undefined,
        launched => launched, pane => `herdr pane attach ${pane}${config.herdrWorkspace ? ` --workspace ${config.herdrWorkspace}` : ''}`);
        clearProfileFailure(state, current.profile);
        delete state.dispatchFailures[item.id];
        // The file comes before the claimant keys, so the 2000-character detail bound trims a long
        // key list and never the file it contends on; a cold dispatch records nothing new here.
        performed.push(await record(state, key, { kind: 'dispatch', work: item.key, principal: current.profile.principal, epoch: item.epoch, state: 'done', detail: `Dispatched ${item.key} to ${current.profile.name}; the worker launcher claimed under ${current.profile.principal}${hotspotNote(beside)}${launched?.reclaimed?.length ? `; freed its branch by reclaiming ${launched.reclaimed.join('; ')}` : ''}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
        return;
      } catch (error) {
        // Another dispatcher — an executor, or a hand dispatch — holds the profile or the item
        // (GY-273). Nothing was claimed and nothing is wrong with the profile: a held profile is
        // passed over for the next free one, and a held item is left to the launch holding it.
        if (dispatchReserved(error)) {
          const next = error.resource === 'profile' ? pick() : undefined;
          if (next) { choice = next; continue; }
          // The profile this item did not use is still free for the next item.
          if (error.resource === 'work') taken.delete(current.profile.name);
          if (previous) state.actions[key] = previous; else delete state.actions[key];
          await effects.persist(state);
          return;
        }
        // GY-860 AC-2: a failure about the item's own workspace is the host's git state, not the
        // profile's — it puts no profile into its failure cool-off. The worktree command has
        // already released the claim with its git message, which hands the epoch back, and the
        // item's record here keeps that message.
        const workspace = workspaceDispatchFailure(message(error));
        if (!workspace) recordProfileFailure(state, current.profile, message(error), now());
        const run = noteDispatchFailure(state, item, message(error), new Date(now()).toISOString());
        performed.push(await record(state, key, { kind: 'dispatch', work: item.key, principal: current.profile.principal, epoch: item.epoch, state: 'failed', detail: `Dispatch of ${item.key} to ${current.profile.name} failed: ${message(error)}${workspace ? " (the item's workspace could not be prepared on this host; the profile is not cooled off and the item's next dispatch waits out a doubling backoff)" : ''} (failure ${run.count} of ${dispatchFailureBlockAfter} with this cause)`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
        if (run.count >= dispatchFailureBlockAfter) performed.push(...await blockRepeatedFailure(item));
        return;
      }
    }
  }

  // 4b. A base branch that moved under an in-flight candidate GitHub reports conflicting with it
  //     (GY-292: a clean one keeps its head, CI, review and proofs, and only the queue head is
  //     brought onto the base, by its speculative tip). Nobody is asked to do anything first: the
  //     control plane tries the merge into the candidate's own branch and decides what the review
  //     and each proof carry (see merge-queue.ts `baseRefreshNeeded`). The cycle reports what
  //     that refresh did — or the conflict that stopped it — so the pass is an action rather
  //     than a "0 actions" line.
  for (const item of open.filter(candidate => candidate.submission && candidate.candidate && !candidate.reworkRequested)) await isolate('refresh', item, item.key, async () => {
    const refresh = item.baseRefresh, pending = pendingBaseRefresh(item);
    // One action per head, base tip and policy revision: opened when the branch moves under the
    // candidate, resolved when the control plane reports what its merge did.
    const target = pending ? { head: item.candidate!.sha, base: pending.baseTip } : refresh ? { head: refresh.from.sha, base: refresh.base } : null;
    if (!target) return;
    // A docs-sync head (GY-566) is the same head and tip's second outcome, reported under its own key.
    // A restore's retry reads the same head and base tip as the attempt before it, so the attempt
    // is part of the key: the escalated attempt is reported, not folded into the first (GY-854).
    const attempt = !pending && refresh?.restore?.attempts && refresh.restore.attempts > 1 ? `:attempt-${refresh.restore.attempts}` : '';
    const key = `refresh:${item.id}:${target.head}:${target.base}:${item.policyRevision}${!pending && refresh?.docsSync ? ':docs-sync' : ''}${attempt}`;
    if (pending) {
      if (state.actions[key]) return;
      performed.push(await record(state, key, { kind: 'refresh', work: item.key, principal: null, state: 'started',
        detail: `${item.key}: base branch moved from ${pending.boundBase.slice(0, 12)} to ${pending.baseTip.slice(0, 12)} and GitHub reports ${item.candidate!.sha.slice(0, 12)} conflicting with it; the control plane is confirming the conflict with a test merge. No rework round, no review round and no proof round is requested unless that merge conflicts.`,
        attempts: 1, cycle: state.cycle }, now(), effects.persist));
      return;
    }
    if (state.actions[key]?.state === 'done' || state.actions[key]?.state === 'failed') return;
    const carry = refresh!.carry;
    const kept = carry ? [...(carry.approval.carried ? ['the approval'] : []), ...carry.evidence.filter(entry => entry.carried).map(entry => entry.proof)] : [];
    const again = carry ? [...(carry.approval.carried ? [] : ['the approval']), ...carry.evidence.filter(entry => !entry.carried).map(entry => entry.proof)] : [];
    const trigger = refresh!.trigger ? ` [trigger: ${refresh!.trigger}]` : '';
    const restore = refresh!.restore;
    const detail = refresh!.stale
      ? `${item.key}: ${refresh!.stale.reading}; it keeps its head, review and proofs (GY-375)`
      : refresh!.conflict
      ? `${item.key}${trigger}: ${refresh!.from.sha.slice(0, 12)} cannot be brought onto base branch tip ${refresh!.base.slice(0, 12)} by Graphyard; ${docsOnlyConflict(refresh!.conflictPaths) ? `both sides changed only docs pages (${refresh!.conflictPaths!.join(', ')}), so a docs-sync session resolves it unless the loop's own merge finds code conflicting, when it returns to the worker` : 'it returns to the worker'} with the conflict named: ${refresh!.conflict}`
      : refresh!.docsSync
      ? `${item.key}${trigger}: a docs-sync session brought ${refresh!.from.sha.slice(0, 12)} onto base branch tip ${refresh!.base.slice(0, 12)} as ${(refresh!.head ?? '').slice(0, 12)} with no rework round; kept ${kept.join(', ') || 'nothing'}${again.length ? `; required afresh: ${again.join(', ')}` : ''}${carry && !carry.approval.carried ? ` (${carry.approval.reason})` : ''}`
      // A restore whose result GitHub does not show is a failure with its reason, never a success
      // re-logged (GY-854): the escalation on the record names why it stops repeating.
      : restore?.outcome === 'unpublished'
      ? `${item.key}${trigger}: the branch restore is not on GitHub (attempt ${restore.attempts ?? 1} onto base branch tip ${refresh!.base.slice(0, 12)}): ${restore.failure}${restore.escalated ? ' — escalated, it stops repeating' : ' — one retry follows'}`
      : `${item.key}${trigger}: brought ${refresh!.from.sha.slice(0, 12)} onto base branch tip ${refresh!.base.slice(0, 12)} as ${(refresh!.head ?? '').slice(0, 12)} with no rework round; kept ${kept.join(', ') || 'nothing'}${again.length ? `; required afresh: ${again.join(', ')}` : ''}`;
    performed.push(await record(state, key, { kind: 'refresh', work: item.key, principal: null, state: refresh!.conflict || restore?.outcome === 'unpublished' ? 'failed' : 'done', detail,
      attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
  });
  return { capacities, approversSpent };
}

/** The key of the loop's host-memory record: one deferral and one resumption per crossing. */
export const memoryActionKey = 'escalation:dispatch:memory';
/** Read the host's memory, keep it on the loop's state, and record a crossing of its floor. Whether launches are deferred. */
export async function hostMemoryStep(cycle: Pick<Cycle, 'state' | 'effects' | 'now' | 'config' | 'performed'>) {
  const { state, effects, now, config, performed } = cycle;
  if (!effects.hostMemory) return false;
  const reading = await effects.hostMemory().catch(() => null);
  // An unreadable host keeps the last judgment: a deferral is not lifted by a failed read.
  if (!reading) return !!state.memory?.low;
  const judged = judgeHostMemory(state.memory, reading, now(), config.hostId ?? null);
  state.memory = judged.state;
  if (judged.event) performed.push(await record(state, memoryActionKey, { kind: 'escalation', work: null, principal: null, state: 'done', detail: judged.detail.slice(0, 1000),
    attempts: (state.actions[memoryActionKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
  return judged.state.low;
}

/**
 * GY-885. When an applied decision last approved a fresh round past the item's attempt cap, as
 * epoch time, or 0. Only the loop's own cap bindings count — any other applied decision answers
 * something else — and the read failing holds nothing: the ladder then simply counts every end.
 */
async function capResumeApprovedAt(cycle: Cycle, item: Work): Promise<number> {
  if (!cycle.effects.decisions) return 0;
  const history = await cycle.effects.decisions(item).then(result => result.decisions, () => []);
  let resume = 0;
  for (const entry of history) {
    if (entry.state !== 'applied' || (entry.action !== 'rework' && entry.action !== 'unblock')) continue;
    if (typeof entry.input?.binding !== 'string' || !entry.input.binding.startsWith(capBindingPrefix)) continue;
    const at = Date.parse(entry.approvedAt ?? '');
    if (Number.isFinite(at) && at > resume) resume = at;
  }
  return resume;
}

/** Name one backoff window the item's retry ladder is waiting out (GY-885): a record, so `master status` shows why nothing dispatches. */
async function recordRetryBackoff(cycle: Cycle, item: Work, hold: AttemptRetryHold) {
  const { state, now, performed, effects } = cycle;
  const last = hold.ends.at(-1), since = last ? Date.parse(last.at) : hold.resumeAt! - retryBackoffMs[retryBackoffMs.length - 1];
  const detail = last
    ? `${item.key}: attempt ${last.epoch} ended ${last.reason.startsWith(credentialBlockedMarker) ? 'on a GitHub credential failure' : "past its role's time box"} at ${last.at}; retry ${hold.count + 1} of ${maxFailedAttempts} waits ${Math.round((hold.resumeAt! - since) / 60_000)} minutes, until ${new Date(hold.resumeAt!).toISOString()}`
    : `${item.key}: the cap decision an independent approver approved was applied, and the fresh round it starts waits ${retryBackoffMs[retryBackoffMs.length - 1] / 60_000} minutes, until ${new Date(hold.resumeAt!).toISOString()}`;
  const key = `retry:backoff:${item.id}:${since}`;
  if (detailChanged(state.actions[key], detail)) performed.push(await record(state, key, { kind: 'dispatch', work: item.key, principal: null, epoch: last?.epoch ?? null, state: 'waiting', detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
}

/**
 * GY-885 at the cap: the item is not redispatched again. The loop requests the rework decision —
 * whether the item gets one more round is the independent approver's judgment, never the loop's
 * own — with its operator-agent identity and launches the approver session for it, and records
 * the hold naming every cause. The requester attests only what it verified: it ended the attempt
 * on the record itself, so the previous worker is stopped while no lease is live and no
 * containment fence stands; a fence nobody settled is named, never attested away. A refusal is
 * the approver's considered judgement: the loop stops requesting and names the recovery. The
 * one rework request the control plane holds per item is honoured: a round another finding
 * already asked for is this cap's answer too, and the hold waits for it.
 */
async function holdAtCap(cycle: Cycle, item: Work, hold: AttemptRetryHold) {
  const { state, now, clock, performed, effects } = cycle;
  const key = `retry:held:${item.id}`, binding = capBinding(item, hold.boundAt!);
  const held = `held: ${hold.count} attempts in a row ended without submitting, each past its role's time box or on a GitHub credential failure — ${hold.causes.join('; ')}`;
  const note = async (outcome: 'done' | 'failed', detail: string) => {
    if (detailChanged(state.actions[key], detail)) performed.push(await record(state, key, { kind: 'escalation', work: item.key, principal: null, state: outcome, detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
  };
  const history = effects.decisions ? await effects.decisions(item).then(result => result.decisions, () => undefined) : undefined;
  const standing = history?.filter(entry => entry.action === 'rework' && ['requested', 'approved'].includes(entry.state));
  const mine = standing?.find(entry => entry.input?.binding === binding);
  const refused = history?.find(entry => entry.action === 'rework' && entry.state === 'refused' && entry.input?.binding === binding);
  const liveLease = item.lease && Date.parse(item.lease.expiresAt) > clock;
  const blocked = mine ? `${item.key} is ${held}. Its cap decision ${mine.id} stands ${mine.state} and waits on the independent approver judging it.`
    : refused ? `${item.key} is ${held}. The independent approver refused the round the loop asked for: ${refused.refusal?.reason ?? 'no reason recorded'}. The loop does not request it again; read it with graphyard master decisions ${item.key}, then request what the item needs with a reason that cites ${refused.id}, or file the follow-up that decides its fate.`
    : standing?.length ? `${item.key} is ${held}. A rework decision ${standing[0].id} already stands ${standing[0].state} on the item, and the control plane holds one rework request at a time, so the cap waits for it before asking for its own.`
    : liveLease || item.containmentQuarantine ? `${item.key} is ${held}, but the loop will not attest the previous worker stopped while ${liveLease ? 'a lease is still live' : 'its containment fence stands'}: settle the fence on its registered host (graphyard master settle-containment ${item.key}) and the cap decision is requested.`
    : !effects.decide || !effects.approver ? `${item.key} is ${held}. This loop runs without the decision effects, so it cannot request the round: graphyard master decide ${item.key} rework '{"previousWorkerStopped":true,"binding":"${binding}"}' REASON, then graphyard master approver ${item.key} DECISION.`
    : null;
  if (blocked) { await note('done', blocked); return; }
  const { decide, approver } = effects;
  await note('done', `${item.key} is ${held}. The loop requests the rework decision that alone resumes it, and puts it to the independent approver: whether the item gets one more round is the approver's judgment, not the loop's.`);
  const startedKey = `retry:cap-request:${item.id}`;
  if (state.actions[startedKey]?.state === 'failed' && !readyToRetry(state.actions[startedKey], state.cycle)) return;
  const attempts = (state.actions[startedKey]?.attempts ?? 0) + 1;
  await record(state, startedKey, { kind: 'decision', work: item.key, principal: null, state: 'started', detail: `Requesting the rework decision that alone resumes ${item.key} past its attempt cap`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist);
  try {
    const reason = fitDecisionReason(`${item.key}: `, `${held}. Only a fresh attempt can move it, and whether it gets one is the approver's judgment, not the loop's. `, 'The previous worker is stopped: the loop ended the attempt on the record itself.');
    const requested = await decide!(item, 'rework', reason, { binding });
    // A low- or medium-lane rework is applied as it is requested (GY-883): no approver to launch.
    const settledState = (requested as { state?: string }).state;
    if (settledState === 'applied' || settledState === 'failed') {
      performed.push(await record(state, startedKey, { kind: 'decision', work: item.key, principal: null, state: settledState === 'applied' ? 'done' : 'failed', detail: `Requested decision ${requested.id} (rework) for ${item.key}; its risk lane needs no approver, and the control plane ${settledState === 'applied' ? 'applied it' : 'could not apply it'} at once: ${reason}`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
      return;
    }
    // The request alone changes nothing; the independent approver session is what applies it.
    // The launch runs on the launcher beside the cycle (GY-616) and is reported next cycle.
    const launchKey = `attempt-cap:approver:${item.id}`;
    const handed = cycle.launch('decision', item, launchKey, [], async sink => {
      const launched = await approver!(item, requested.id);
      sink.push(await record(state, launchKey, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: `${item.key}'s cap decision ${requested.id}: launched independent approver session ${launched.agentName}`, attempts: (state.actions[launchKey]?.attempts ?? 0) + 1, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
    });
    performed.push(await record(state, startedKey, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: `Requested decision ${requested.id} (rework) for ${item.key} and ${handed ? 'handed the approver session to the launcher' : 'launched the independent approver session'}: ${reason}`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
  } catch (error) {
    performed.push(await record(state, startedKey, { kind: 'decision', work: item.key, principal: null, state: 'failed', detail: `Could not put ${item.key}'s cap decision to an approver: ${message(error)}`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
  }
}
