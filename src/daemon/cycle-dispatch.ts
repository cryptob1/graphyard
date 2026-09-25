// Concern: cycle step 4 — dispatch claimable work under capacity and report base refreshes.
import type { Work } from '../model.js';
import { pendingBaseRefresh } from '../merge-queue.js';
import { dispatchOrder } from '../coordination.js';
import { type CapacityRole, capacitySignature, standingCapacity, describeCapacity } from '../model/capacity.js';
import { parkedOnHuman, humanDecisionLabel, answerCommand } from '../model/human-request.js';
import { humanNeededActions } from '../model/next-action.js';
import { assertDispatchable, type RoleCapacity, roleCapacity } from '../master.js';
import { message } from './state.js';
import { dispatchKey } from './reconcile.js';
import { clearProfileFailure, profileHealth, recordProfileFailure } from './sessions.js';
import { detailChanged } from './decisions.js';
import { capacityKey, record } from './effects.js';
import type { Cycle } from './cycle.js';

/** Step 4: dispatch claimable work under capacity, and report base refreshes of in-flight candidates. */
export async function dispatchStep(cycle: Cycle, health: ReturnType<typeof profileHealth>) {
  const { config, state, effects, now, snapshot, clock, performed, isolate, agents, credentials, open } = cycle;
  // 4. Dispatch claimable work to a healthy profile. The launcher claims under the worker's own
  //    identity; the daemon never holds a lease. An unhealthy profile is skipped, not waited on.
  //    Planned-file overlap never holds an item (dispatch is optimistic: the merge queue and a
  //    sync round integrate whichever lands second); only exclusive resources do. The smallest
  //    planned scope within a priority is offered first.
  const claimable = open.filter(item => {
    try { assertDispatchable(item, snapshot.work, snapshot.now); return true; } catch { return false; }
  }).sort(dispatchOrder);

  // 4a. Capacity. A role whose every configured account is spent is not a launch to keep
  //     retrying and not a failure to keep reporting: each item that needs the role records one
  //     capacity escalation naming every account and its reset time, the loop stops launching
  //     that role until the first of them resets, and the cycle says so in one line. Everything
  //     that needs a different role — a review, a proof, a merge, a deployment — runs below
  //     exactly as it would have, and the escalation is withdrawn the cycle an account returns.
  const capacities: RoleCapacity[] = [roleCapacity('worker', config.workers.filter(worker => worker.mode === 'launch'), credentials)];
  if (effects.reportCapacity) {
    const others = await effects.roleHealth?.().catch(() => null) ?? {};
    for (const role of ['reviewer', 'producer'] as const) if (others[role]) capacities.push(roleCapacity(role, others[role]!.profiles, others[role]!.health));
    const needs: Record<CapacityRole, Work[]> = {
      worker: claimable,
      reviewer: open.filter(item => item.autoDispatch?.review?.state === 'requested'),
      producer: open.filter(item => item.autoDispatch?.producers.some(request => request.state === 'requested')),
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
  const taken = new Set<string>();
  for (const item of workersSpent || unrecordable ? [] : claimable) if (await isolate('dispatch', item, item.key, async () => {
    const key = dispatchKey(item);
    if (state.actions[key] && state.actions[key].state !== 'failed') return;
    const free = await effects.agents();
    const choice = health.find(entry => entry.healthy && !taken.has(entry.profile.name) && !free.some(agent => agent.name === entry.profile.agentName));
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
    await record(state, key, { kind: 'dispatch', work: item.key, principal: choice.profile.principal, epoch: item.epoch, state: 'started', detail: `Dispatching ${item.key} to ${choice.profile.name}`, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
    try {
      const dispatched = await effects.dispatch(item, choice.profile, free, snapshot) as { pane?: string | null; agentName?: string; principal?: string } | undefined;
      clearProfileFailure(state, choice.profile);
      // The session is now running somewhere. Put the handle where every Graphyard reader looks,
      // so watching this specific agent never means asking this loop to relay its pane id.
      await effects.recordSession?.(item, {
        id: `${choice.profile.principal}:${item.epoch + 1}`, kind: 'implementation', principal: choice.profile.principal, runtime: choice.profile.kind ?? choice.profile.mode, host: config.hostId,
        ...(config.herdrWorkspace ? { workspace: config.herdrWorkspace } : {}),
        ...(dispatched?.pane ? { pane: dispatched.pane, attach: `herdr pane attach ${dispatched.pane}${config.herdrWorkspace ? ` --workspace ${config.herdrWorkspace}` : ''}` } : {}),
        subject: `${item.key}: ${item.title}`.slice(0, 300), state: 'running',
      }).catch(() => { /* the dispatch landed; a handle that could not be written is not a failed dispatch */ });
      performed.push(await record(state, key, { kind: 'dispatch', work: item.key, principal: choice.profile.principal, epoch: item.epoch, state: 'done', detail: `Dispatched ${item.key} to ${choice.profile.name}; the worker launcher claimed under ${choice.profile.principal}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      recordProfileFailure(state, choice.profile, message(error), now());
      performed.push(await record(state, key, { kind: 'dispatch', work: item.key, principal: choice.profile.principal, epoch: item.epoch, state: 'failed', detail: `Dispatch of ${item.key} to ${choice.profile.name} failed: ${message(error)}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    }
  }) === 'stop') break;

  // 4b. A base branch that moved under an in-flight candidate. Nobody is asked to do anything
  //     about it: the control plane merges the new base into the candidate's own branch and
  //     decides what the review and each proof carry (see merge-queue.ts). The cycle reports
  //     what that refresh did — or the conflict that stopped it — so a pass that brought six
  //     stalled items forward is an action rather than a "0 actions" line.
  for (const item of open.filter(candidate => candidate.submission && candidate.candidate && !candidate.reworkRequested)) await isolate('refresh', item, item.key, async () => {
    const refresh = item.baseRefresh, pending = pendingBaseRefresh(item);
    // One action per head, base tip and policy revision: opened when the branch moves under the
    // candidate, resolved when the control plane reports what its merge did.
    const target = pending ? { head: item.candidate!.sha, base: pending.baseTip } : refresh ? { head: refresh.from.sha, base: refresh.base } : null;
    if (!target) return;
    const key = `refresh:${item.id}:${target.head}:${target.base}:${item.policyRevision}`;
    if (pending) {
      if (state.actions[key]) return;
      performed.push(await record(state, key, { kind: 'refresh', work: item.key, principal: null, state: 'started',
        detail: `${item.key}: base branch moved from ${pending.boundBase.slice(0, 12)} to ${pending.baseTip.slice(0, 12)}; the control plane is bringing ${item.candidate!.sha.slice(0, 12)} onto it. No rework round, no review round and no proof round is requested for the move.`,
        attempts: 1, cycle: state.cycle }, now(), effects.persist));
      return;
    }
    if (state.actions[key]?.state === 'done' || state.actions[key]?.state === 'failed') return;
    const carry = refresh!.carry;
    const kept = carry ? [...(carry.approval.carried ? ['the approval'] : []), ...carry.evidence.filter(entry => entry.carried).map(entry => entry.proof)] : [];
    const again = carry ? [...(carry.approval.carried ? [] : ['the approval']), ...carry.evidence.filter(entry => !entry.carried).map(entry => entry.proof)] : [];
    const detail = refresh!.conflict
      ? `${item.key}: ${refresh!.from.sha.slice(0, 12)} cannot be brought onto base branch tip ${refresh!.base.slice(0, 12)} by Graphyard; it returns to the worker with the conflict named: ${refresh!.conflict}`
      : `${item.key}: brought ${refresh!.from.sha.slice(0, 12)} onto base branch tip ${refresh!.base.slice(0, 12)} as ${(refresh!.head ?? '').slice(0, 12)} with no rework round; kept ${kept.join(', ') || 'nothing'}${again.length ? `; required afresh: ${again.join(', ')}` : ''}`;
    performed.push(await record(state, key, { kind: 'refresh', work: item.key, principal: null, state: refresh!.conflict ? 'failed' : 'done', detail,
      attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
  });
}
