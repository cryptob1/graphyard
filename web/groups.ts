import { deliveryState, isClosed, type Work } from '../src/model';
import { parkedOnHuman, type HumanRequestRow } from '../src/model/human-request';
import { shortShas } from './format';
import { phaseOf, plainReason, plainStatus } from './plain-status';
import { prSteps } from './pr-steps';
import { leftFlowAt, noRelease, servedFor, type ReleaseView } from './release';
import { stalledCards } from './pages/actionless';

/**
 * The one classification the dashboard uses (GY-161). Every open item is in exactly one group,
 * and every count, tile, list, badge and phone chip is drawn from `classify`, so a number on the
 * page is always the number of rows it filters. Delivered work is `shipped` (`leftFlowAt`): a
 * per-item deployment record is written only for policies that ask for a post-deployment check, so
 * its absence never holds work back. Merged work is moving at Deploy while its check is outstanding
 * or while the production watch observes that production does not serve it yet (web/release.ts),
 * and blocked when the check or the deployment failed. Within Shipped, an item is live only once
 * the release is observed serving it (`servedAt`, under the configured production environment);
 * until then it reads "Merged" and is not counted as shipped this week. Closed work is in none.
 *
 * - `needs-you`: waits on a decision only the human operator may make (a parked item, or an
 *   approval no agent identity can give). Listed here and nowhere else — never also as Blocked.
 * - `blocked`: will not move until an agent fixes or decides something (a recorded blocker, a
 *   failing step nobody is moving, a conflict).
 * - `moving`: somebody is on it, from building to deploying.
 * - `up-next`: released for work, waiting for a worker (or for the item it depends on).
 * - `backlog`: not released for work, so no clock runs.
 */
export const groups = ['needs-you', 'blocked', 'moving', 'up-next', 'backlog'] as const;
export type OpenGroup = typeof groups[number];
export type Group = OpenGroup | 'shipped';

export const groupLabel: Record<Group, string> = {
  'needs-you': 'Needs you', blocked: 'Blocked', moving: 'Moving', 'up-next': 'Up next', backlog: 'Backlog', shipped: 'Shipped',
};
/** What each group means, in the words a tile carries under its count. */
export const groupMeaning: Record<Group, string> = {
  'needs-you': 'Only you can decide', blocked: 'Agents fixing a fault', moving: 'Build to live',
  'up-next': 'Waiting for a worker', backlog: 'Not released yet', shipped: 'Live once the release serves it',
};

/** The work ids waiting on the human, from the server's human-only rows or, before they load, the items' own parked requests. */
export function humanOnlyIds(work: Work[], rows: HumanRequestRow[] | null | undefined): Set<string> {
  return new Set([...(rows ?? []).map(row => row.id), ...work.filter(item => item.stage !== 'done' && parkedOnHuman(item)).map(item => item.id)]);
}

/** When the release was observed serving a delivered item (`servedAt`); null while it has only merged. */
export function releasedAt(work: Work, release: ReleaseView = noRelease): number | null {
  const at = servedFor(work, release);
  return at === null || Number.isNaN(Date.parse(at)) ? null : Date.parse(at);
}

/**
 * Shipped this week: delivered items the release was seen serving in the last seven days, dated
 * from that observation. The Work page's footer and the Insights headline read this one count.
 */
export function shippedThisWeek(work: Work[], now: number, release: ReleaseView = noRelease): Work[] {
  return work.filter(w => groupOf(w, now, undefined, undefined, release) === 'shipped' && releasedAt(w, release) !== null && now - releasedAt(w, release)! <= 7 * 24 * 60 * 60 * 1000);
}

/** When a delivered item merged. */
export function mergedAt(work: Work): number {
  return Date.parse(work.delivery?.mergedAt ?? work.observation?.mergedAt ?? work.stageEnteredAt);
}

/** The group of one item. `humanOnly` is the set from `humanOnlyIds`; `stalled` the ids nothing is moving. */
export function groupOf(work: Work, now: number, humanOnly: ReadonlySet<string> = new Set(), stalled: ReadonlySet<string> = new Set(), release: ReleaseView = noRelease): Group | null {
  if (isClosed(work)) return null;
  if (work.stage === 'done') {
    // Shipped whether or not a per-item deployment record exists; only an outstanding
    // post-deployment check, or production observed not serving it yet, keeps it at Deploy.
    // Work merged before delivery records existed has nothing left to wait on.
    if (!work.delivery || leftFlowAt(work, release)) return 'shipped';
    return deliveryState(work) === 'delivered-with-failure' || release.failed.has(work.key) ? 'blocked' : 'moving';
  }
  if (humanOnly.has(work.id) || parkedOnHuman(work)) return 'needs-you';
  const phase = phaseOf(work, now);
  if (phase === 'not-started') return 'backlog';
  if (stalled.has(work.id) || plainStatus(work, now).tone === 'stuck') return 'blocked';
  return phase === 'needs-worker' ? 'up-next' : 'moving';
}

export interface Classification {
  /** Each open group's items, in the order people should look at them. */
  byGroup: Record<OpenGroup, Work[]>;
  /** Open items in all groups; the sum of the group sizes. */
  open: number;
}

/**
 * Every open item into its one group. The counts a page draws are `byGroup[g].length` of this
 * same result, so a tile can never disagree with the list it filters.
 */
export function classify(work: Work[], now: number, humanRows?: HumanRequestRow[] | null, release: ReleaseView = noRelease): Classification {
  const humanOnly = humanOnlyIds(work, humanRows);
  const open = work.filter(item => !isClosed(item) && (item.stage !== 'done' || groupOf(item, now, undefined, undefined, release) !== 'shipped'));
  const stalled = new Set(stalledCards(open, now).map(card => card.item.id));
  const byGroup = Object.fromEntries(groups.map(group => [group, [] as Work[]])) as Record<OpenGroup, Work[]>;
  for (const item of open) {
    const group = groupOf(item, now, humanOnly, stalled, release);
    if (group && group !== 'shipped') byGroup[group].push(item);
  }
  // The longest wait first within a group; priority breaks ties.
  for (const group of groups) byGroup[group].sort((a, b) => a.stageEnteredAt.localeCompare(b.stageEnteredAt) || a.priority - b.priority);
  return { byGroup, open: open.length };
}

/**
 * The group of one item as the Work page classifies it among all of `work`, so the item page
 * shows the badge of the tile that led to it (the stalled reading needs the whole board).
 */
export function groupWithin(item: Work, work: Work[], now: number, humanRows?: HumanRequestRow[] | null, release: ReleaseView = noRelease): Group | null {
  const { byGroup } = classify(work.some(entry => entry.id === item.id) ? work : [...work, item], now, humanRows, release);
  return groups.find(group => byGroup[group].some(entry => entry.id === item.id)) ?? groupOf(item, now, humanOnlyIds(work, humanRows), undefined, release);
}

/** "1 item needs you. 2 are moving. Nothing is blocked." — the page's one summary sentence, from the same counts. */
export function summarySentence(counts: Record<OpenGroup, number>): string {
  const parts: string[] = [];
  if (counts['needs-you']) parts.push(`${counts['needs-you']} ${counts['needs-you'] === 1 ? 'item needs' : 'items need'} you.`);
  if (counts.moving) parts.push(`${counts.moving} ${counts.moving === 1 ? 'is' : 'are'} moving.`);
  parts.push(counts.blocked ? `${counts.blocked} ${counts.blocked === 1 ? 'is' : 'are'} blocked.` : 'Nothing is blocked.');
  return parts.join(' ');
}

/**
 * Groups whose rows carry a running clock: only work that is moving (or held up while moving)
 * has a step to be late in. Needs you shows how long it has waited, never "overdue"; Up next,
 * Backlog and Shipped show no timer at all.
 */
export const timedGroups: ReadonlySet<Group> = new Set(['moving', 'blocked']);

/**
 * Who acts next on an item, as a role a newcomer recognises (never a worker's code name), and
 * what they do, in plain words.
 */
export function nextActor(work: Work, group: Group | null, now: number, release: ReleaseView = noRelease): { who: string; does: string } {
  if (group === 'needs-you') return { who: 'You', does: work.humanRequest ? shortShas(work.humanRequest.needed) : 'Answer the decision it is waiting on' };
  if (group === 'backlog') {
    const dependency = work.gates.find(gate => gate.name === 'ready')?.reasons.find(reason => reason.startsWith('Dependency '));
    return dependency && work.ready ? { who: 'Nobody yet', does: plainReason(dependency, 'ready').text } : { who: 'Master agent', does: 'Release it for work when it is a priority' };
  }
  // Blocked means the step's own actor cannot clear it (a recorded blocker, a stall, a violation,
  // a refusal no retry fixes, a failed check after deploying): the master agent acts next.
  if (group === 'blocked') return { who: 'Master agent', does: release.failed.has(work.key) && work.stage === 'done' ? 'Find out why production has not deployed it, and record the cause' : 'Clear what blocks it, or hand the decision to an approver agent' };
  if (group === 'up-next') {
    const dependency = work.gates.find(gate => gate.name === 'ready')?.reasons.find(reason => reason.startsWith('Dependency '));
    return dependency ? { who: 'Nobody yet', does: plainReason(dependency, 'ready').text } : { who: 'Graphyard (assigns a builder)', does: 'Hands it to the next free builder agent' };
  }
  const steps = prSteps(work, now, release);
  return { who: steps.who, does: steps.label };
}
