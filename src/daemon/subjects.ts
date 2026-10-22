// Concern: what the loop could act on — the subjects a cycle names and the master session wakes on.
import type { Work } from '../model.js';
import { pendingBaseRefresh } from '../model/base-refresh.js';
import { stalledItems } from '../model/action-account.js';
import { type MasterConfig, assertDispatchable } from '../master.js';
import type { DaemonActionKind } from './state.js';
import { neededRework } from './rework.js';
import { boundDetail } from './text.js';

// ---- What the loop could act on ------------------------------------------------------------
/*
 * A cycle that reports "0 actions" says nothing about whether it had anything to do. Every cycle
 * therefore records both halves: the subjects it could act on, and the actions it took. The
 * subjects feed the master session's wake (one wake per changed subject, by digest) and the
 * cycle's `actionable` count; whether the whole pipeline has gone still is the progress
 * watchdog's judgement (progressAttention in ./liveness.ts), not a per-subject wait.
 */
export interface ActionableSubject { key: string; kind: DaemonActionKind; work: string | null; detail: string }
export function actionableSubjects(config: Pick<MasterConfig, 'autoMerge' | 'run'>, work: Work[], now: number,
  context: { baseFailed?: Map<string, Set<string>>;
    /** GY-1890: the dispatch step stopped on a saturated fleet — no launch profile free by its own `saturatedFleet` decision — so a claimable item's wait is the fleet's slot capacity, not a dispatch wait. */ fleetHeld?: boolean;
    /** GY-1890: whether an item's own launch is in flight; its slot is allocated, so its wait is that launch, never the fleet's capacity. */ launching?: (item: Work) => boolean } = {}): ActionableSubject[] {
  const subjects: ActionableSubject[] = [];
  // A subject's detail is bounded to 500 characters: the master session wakes once per changed
  // detail (its digest), so a refusal or proof list quoted here is cut to fit.
  const add = (kind: DaemonActionKind, item: Work | null, detail: string) => subjects.push({ key: `${kind}:${item?.key ?? 'pipeline'}`, kind, work: item?.key ?? null, detail: boundDetail(detail, 500) });
  // An open item the control plane names no action for and nothing is moving. The loop cannot
  // clear it — that is what makes it a subject rather than an action: named here, it is absent
  // from no measure the loop keeps, which is how an item used to hold a failing gate for hours
  // with nobody told (GY-106). The master session is woken once per changed detail, and the
  // progress watchdog (./liveness.ts) judges whether the whole pipeline has gone still.
  const stalled = new Map(stalledItems(work, new Date(now), 0).map(entry => [entry.key, entry]));
  for (const item of work) {
    // A rework the loop owes is a subject until it is applied.
    const rework = neededRework(item);
    if (rework) add('judgement', item, `${item.key} returns to a worker: ${rework.reason}`);
    if (item.stage === 'done') continue;
    const stall = stalled.get(item.key);
    if (stall) add('attention', item, `${item.key} holds its ${stall.gate ?? 'unevaluated'} gate with no action, no dependency and no recorded human need: ${stall.refusal ?? stall.detail}`);
    // GY-1890: with no launch profile free the wait on a claimable item is the fleet's slot
    // capacity, so it is a capacity subject, not a dispatch one: the loop cannot end it by acting.
    // An item whose own launch is in flight already holds its slot: it waits on that launch, not the fleet.
    try { assertDispatchable(item, work, new Date(now).toISOString()); const fleetHeld = context.fleetHeld && !context.launching?.(item); add(fleetHeld ? 'capacity' : 'dispatch', item, fleetHeld ? `${item.key} is claimable but no worker profile is free; it starts when one frees` : `${item.key} is claimable and waiting for a worker`); } catch { /* not claimable: not actionable */ }
    if (pendingBaseRefresh(item)) add('refresh', item, `${item.key} conflicts with the moved base and is waiting for the control plane to try bringing its candidate onto it`);
    // No head is owed a proof the loop asks for: CI runs the unit tests, UAT the end-to-end ones,
    // and the control plane requests no producer (GY-1266, GY-1235). A mergeable candidate is not
    // the loop's either: GitHub merges it on its branch protection.
  }
  return subjects;
}
