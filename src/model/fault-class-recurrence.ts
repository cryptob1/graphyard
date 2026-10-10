import { isDelivered } from './closure.js';
import { closesFaultClass, faultClasses, faultClassMeaning, openFaultClassItem } from './fault-classes.js';
import type { FaultClass, FaultClassOrigin, FaultClassPolicy, FaultInstance } from './fault-classes.js';
import type { Work } from './work.js';

// Recurrence filing for the fault classes (split from fault-classes.ts, which re-exports it): which
// classes recur past the threshold, which item stands for each, and the backlog item a class files.
// Instances count against a class item from its landing, not its opening (GY-1632).
// This module is browser-safe: the dashboard classifies with it too.

/** When a delivered item landed: GitHub's merge time, null when none was recorded. */
export function landedAt(work: Pick<Work, 'delivery' | 'observation'>): number | null {
  const at = Date.parse(work.delivery?.mergedAt ?? work.observation?.mergedAt ?? '');
  return Number.isFinite(at) ? at : null;
}
/**
 * The newest delivered item naming `faultClass`, with its landing (GY-1632): a delivered item filed
 * for the class, or the delivered item a recurring item of the class was closed as a duplicate of
 * (the diagnosis's answer). Null when no such item has a recorded merge.
 */
export function deliveredFaultClassCover(work: readonly Work[], faultClass: FaultClass): { item: Work; landedAt: number } | null {
  const answers = new Set(work.filter(item => closesFaultClass(item) === faultClass && item.closure?.kind === 'duplicate' && item.closure.ref).map(item => item.closure!.ref!));
  let cover: { item: Work; landedAt: number } | null = null;
  for (const item of work) {
    if (!isDelivered(item) || !(closesFaultClass(item) === faultClass || answers.has(item.key))) continue;
    const at = landedAt(item);
    if (at !== null && (!cover || at > cover.landedAt)) cover = { item, landedAt: at };
  }
  return cover;
}
/** Whether every instance listed was first seen before `landing`: none of them postdates the delivered fix. */
export const predateLanding = (instances: readonly { at: string }[], landing: number) => instances.every(entry => Date.parse(entry.at) < landing);

export interface ClassRecurrence { faultClass: FaultClass; count: number; recent: FaultInstance[]; unlinked: FaultInstance[]; item: Work | null; file: boolean }
/**
 * Every class with an instance inside the window. A class files an item when the instances in the
 * window no item accounts for reach the threshold and no item stands for the class (`standing`,
 * GY-439); with one, every unlinked instance links to it. A delivered item naming the class stands
 * too while every unlinked instance in the window was first seen before it landed (GY-1632): an
 * instance after the landing files afresh.
 * Instances linked to an item that has since closed stay counted by it, never by a second one.
 */
export function recurringClasses(instances: readonly FaultInstance[], work: readonly Work[], policy: FaultClassPolicy, now: number, standing = openFaultClassItem): ClassRecurrence[] {
  const from = now - policy.windowHours * 3_600_000;
  return faultClasses.flatMap(faultClass => {
    const all = instances.filter(entry => entry.faultClass === faultClass);
    const recent = all.filter(entry => Date.parse(entry.at) >= from && Date.parse(entry.at) <= now && !entry.linkedTo);
    // GY-1632: with no item standing, a delivered item naming the class stands while every instance in the window predates its landing.
    const open = standing(work, faultClass), cover = open || !recent.length ? null : deliveredFaultClassCover(work, faultClass);
    const item = open ?? (cover && predateLanding(recent, cover.landedAt) ? cover.item : null);
    const unlinked = item ? all.filter(entry => !entry.linkedTo) : recent;
    if (!unlinked.length) return [];
    return [{ faultClass, count: recent.length, recent, unlinked, item, file: !item && recent.length >= policy.threshold }];
  });
}

/** The backlog item one recurring class files: the class, its frequency and every instance as evidence. */
export function faultClassItem(recurrence: Pick<ClassRecurrence, 'faultClass' | 'recent'>, policy: FaultClassPolicy, now: number) {
  const { faultClass, recent } = recurrence, at = new Date(now).toISOString();
  const subjects = [...new Set(recent.map(entry => entry.subject))];
  const origin: FaultClassOrigin = { class: faultClass, threshold: policy.threshold, windowHours: policy.windowHours, count: recent.length, detectedAt: at,
    instances: recent.slice(0, 100).map(({ id, kind, subject, at: seen }) => ({ id, kind, subject, at: seen })) };
  // Goals, spending and credentials stay a human's however often asked: this class removes only the avoidable waits.
  const human = faultClass === 'human-decision';
  const description = [
    `The master loop filed this item itself: ${recent.length} ${faultClass} faults in ${policy.windowHours} hours (threshold ${policy.threshold}). The class means ${faultClassMeaning[faultClass]}.`,
    human ? `These waits are on decisions only a human may make (goals and priorities, money or accounts, credentials for people), and this item does not move any of them to an agent or weaken that boundary. What it replaces is handling each wait by hand: find the waits that were avoidable — asked again for something already decided, asked for a decision the item did not need, or left unanswered because nobody was told — and remove those, so each human decision is asked for once, when it is needed, with what the human needs to make it. Later instances of the class are linked to this item rather than filed again.` : `Fixing these one instance at a time is what this item replaces: find the cause the instances share and remove it, so the product handles the case itself. Later instances of the class are linked to this item rather than filed again. Whether the class stays quiet after this ships is not evidence this item can carry: the loop keeps counting it, and a recurrence past the threshold after delivery files a new item.`,
    `Subjects affected: ${subjects.join(', ')}.`,
    'Instances (the evidence):',
    ...recent.slice(0, 100).map(entry => `- ${entry.at} ${entry.kind} on ${entry.subject}: ${entry.text}`),
  ].join('\n\n');
  return {
    title: `Recurring ${faultClass} faults: ${recent.length} in ${policy.windowHours} hours`.slice(0, 200), description: description.slice(0, 20000), type: 'bug' as const, priority: human ? 2 : 1,
    criteria: [{ id: 'AC-1', text: human ? 'Each instance listed on this item is judged necessary (a goals, money or credentials decision the item needed) or avoidable, with the reason; every avoidable wait is reproduced against the base and shown not to recur against the candidate, by a test the change adds; and a test shows every necessary decision is still refused to every agent and answered only in the human\'s own session' : `The shared cause of the recurring ${faultClass} faults is found and removed at the candidate: each instance listed on this item is reproduced against the base and shown not to recur against the candidate, by a test the change adds`, proofs: [`manual:fault-class-${faultClass}`] }],
    origin: { faultClass: origin },
    reason: `The ${faultClass} fault class recurred past its threshold (${recent.length} ≥ ${policy.threshold} in ${policy.windowHours} hours) and no open item names it`,
  };
}
