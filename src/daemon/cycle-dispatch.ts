// Concern: cycle step 4 — dispatch claimable work under capacity and report base refreshes.
import type { Work } from '../model.js';
import { pendingBaseRefresh } from '../merge-queue.js';
import { docsOnlyConflict } from '../model/docs-sync.js';
import { dispatchOrder } from '../coordination.js';
import { type CapacityRole, capacitySignature, standingCapacity, describeCapacity } from '../model/capacity.js';
import { parkedOnHuman, humanDecisionLabel, answerCommand } from '../model/human-request.js';
import { humanNeededActions } from '../model/next-action.js';
import { assertDispatchable, dispatchReserved, type ContainmentAssessment, type EscalationSession, type RoleCapacity, roleCapacity } from '../master.js';
import { standingEscalations } from '../model/escalation.js';
import { registeredLaunch } from '../model/session-state.js';
import { type DaemonAction, message } from './state.js';
import { decisionKey, dispatchKey } from './reconcile.js';
import { clearProfileFailure, profileHealth, recordProfileFailure } from './sessions.js';
import { detailChanged, routineDecision } from './decisions.js';
import { capacityKey, record, stoppedStates } from './effects.js';
import type { Cycle } from './cycle.js';
import { researchHold, researchRunner, researchSettings, researchStep } from '../research.js';

/** Step 4: dispatch claimable work under capacity, and report base refreshes of in-flight candidates. */
export async function dispatchStep(cycle: Cycle, health: ReturnType<typeof profileHealth>, assessments: Record<string, ContainmentAssessment>) {
  const { config, state, effects, now, snapshot, clock, performed, isolate, agents, credentials, open } = cycle;
  // 4. Dispatch claimable work to a healthy profile. The launcher claims under the worker's own
  //    identity; the daemon never holds a lease. An unhealthy profile is skipped, not waited on.
  //    Planned-file overlap never holds an item (dispatch is optimistic: the merge queue and a
  //    sync round integrate whichever lands second); only exclusive resources do. The smallest
  //    planned scope within a priority is offered first.
  const offered = open.filter(item => {
    try { assertDispatchable(item, snapshot.work, snapshot.now); return true; } catch { return false; }
  }).sort(dispatchOrder);
  // 4-research. Research before build (GY-259): an item about to be offered whose requirements
  //     were never researched gets one cheap Pi session first, and waits only while that run is
  //     within its time limit. A run that fails or times out is recorded and the item is built
  //     without a brief; research never holds an item past its bound. It runs only once
  //     `run.research` names the research account: an unconfigured loop dispatches as before.
  const held = new Set(offered.filter(item => researchHold(item, clock)).map(item => item.id));
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
      const decision = effects.approver ? routineDecision(item, config, clock, assessments[item.id]) : null, watch = decision ? state.approvals[decisionKey(item, decision)] : undefined;
      return !!decision && !watch?.settledAt && !watch?.exhaustedAt && !agents.some(agent => agent.name === watch?.agentName && !stoppedStates.includes(agent.agent_status ?? ''));
    }).map(item => item.key));
    const needs: Record<CapacityRole, Work[]> = {
      worker: claimable,
      reviewer: open.filter(item => item.autoDispatch?.review?.state === 'requested'),
      producer: open.filter(item => item.autoDispatch?.producers.some(request => request.state === 'requested')),
      approver: open.filter(item => unjudged.has(item.key)),
      // An item waits on the escalation-handler role while a handler for it ended on spent quota with no account left.
      'escalation-handler': open.filter(item => waitingEscalations.has(item.key)),
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
  // Each item's profile is chosen in dispatch order, one after another, and taken before the next
  // item chooses; the launches themselves do not depend on each other and are handed to the
  // launcher beside the cycle (GY-616), which runs them a few at a time while the cycle goes on to
  // its decisions, merges and closes. Each launch holds a distinct healthy profile from hand-off
  // until it settles, across cycles: a profile an earlier cycle's launch still holds is taken.
  const taken = cycle.launcher.held();
  // The `launches` step is the hand-off: choosing each item's profile and handing its launch over.
  await cycle.timings.step('launches', async () => { for (const item of workersSpent || unrecordable ? [] : claimable) if (await isolate('dispatch', item, item.key, async () => {
    const key = dispatchKey(item);
    if (cycle.launcher.busy(key) || (state.actions[key] && state.actions[key].state !== 'failed')) return;
    const free = await effects.agents();
    const pick = () => health.find(entry => entry.healthy && !taken.has(entry.profile.name) && !free.some(agent => agent.name === entry.profile.agentName));
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
    cycle.launch('dispatch', item, key, holds, sink => launch(item, key, choice!, free, pick, holds, sink));
  }) === 'stop') break; });

  /**
   * One item's launch on the profile chosen for it, passing a profile another dispatcher holds over
   * for the next free one. It runs on the launcher, after the cycle that chose it may have ended, so
   * what it records goes to `performed` — the launcher's sink the next cycle reports.
   */
  async function launch(item: Work, key: string, chosen: NonNullable<ReturnType<typeof health.find>>, free: Awaited<ReturnType<typeof effects.agents>>, pick: () => ReturnType<typeof health.find>, holds: string[], performed: DaemonAction[]) {
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
        await registeredLaunch(effects.recordSession ? handle => effects.recordSession!(item, handle) : undefined, {
          id: `${current.profile.principal}:${item.epoch + 1}`, kind: 'implementation', principal: current.profile.principal, runtime: current.profile.kind ?? current.profile.mode, host: config.hostId,
          ...(config.herdrWorkspace ? { workspace: config.herdrWorkspace } : {}),
          subject: `${item.key}: ${item.title}`.slice(0, 300), state: 'running',
        }, async () => await effects.dispatch(item, current.profile, free, snapshot) as { pane?: string | null; agentName?: string; principal?: string } | undefined,
        launched => launched, pane => `herdr pane attach ${pane}${config.herdrWorkspace ? ` --workspace ${config.herdrWorkspace}` : ''}`);
        clearProfileFailure(state, current.profile);
        performed.push(await record(state, key, { kind: 'dispatch', work: item.key, principal: current.profile.principal, epoch: item.epoch, state: 'done', detail: `Dispatched ${item.key} to ${current.profile.name}; the worker launcher claimed under ${current.profile.principal}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
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
        recordProfileFailure(state, current.profile, message(error), now());
        performed.push(await record(state, key, { kind: 'dispatch', work: item.key, principal: current.profile.principal, epoch: item.epoch, state: 'failed', detail: `Dispatch of ${item.key} to ${current.profile.name} failed: ${message(error)}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
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
    const key = `refresh:${item.id}:${target.head}:${target.base}:${item.policyRevision}${!pending && refresh?.docsSync ? ':docs-sync' : ''}`;
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
    const detail = refresh!.stale
      ? `${item.key}: ${refresh!.stale.reading}; it keeps its head, review and proofs (GY-375)`
      : refresh!.conflict
      ? `${item.key}${trigger}: ${refresh!.from.sha.slice(0, 12)} cannot be brought onto base branch tip ${refresh!.base.slice(0, 12)} by Graphyard; ${docsOnlyConflict(refresh!.conflictPaths) ? `both sides changed only docs pages (${refresh!.conflictPaths!.join(', ')}), so a docs-sync session resolves it unless the loop's own merge finds code conflicting, when it returns to the worker` : 'it returns to the worker'} with the conflict named: ${refresh!.conflict}`
      : refresh!.docsSync
      ? `${item.key}${trigger}: a docs-sync session brought ${refresh!.from.sha.slice(0, 12)} onto base branch tip ${refresh!.base.slice(0, 12)} as ${(refresh!.head ?? '').slice(0, 12)} with no rework round; kept ${kept.join(', ') || 'nothing'}${again.length ? `; required afresh: ${again.join(', ')}` : ''}${carry && !carry.approval.carried ? ` (${carry.approval.reason})` : ''}`
      : `${item.key}${trigger}: brought ${refresh!.from.sha.slice(0, 12)} onto base branch tip ${refresh!.base.slice(0, 12)} as ${(refresh!.head ?? '').slice(0, 12)} with no rework round; kept ${kept.join(', ') || 'nothing'}${again.length ? `; required afresh: ${again.join(', ')}` : ''}`;
    performed.push(await record(state, key, { kind: 'refresh', work: item.key, principal: null, state: refresh!.conflict ? 'failed' : 'done', detail,
      attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
  });
  return { capacities, approversSpent };
}
