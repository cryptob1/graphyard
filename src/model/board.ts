import type { Work } from './work.js';
import { isClosed } from './closure.js';
import { deliveryState } from './delivery.js';
import { answerCommand, parkedOnHuman, type HumanRequestRow } from './human-request.js';
import { scopeRefusalBlocker } from './scope.js';
import { shortShas } from '../../web/format.js';
import { OVERDUE_MINUTES, statusDuration } from '../../web/duration.js';
import { phaseOf, plainReason, plainStatus, statusSince } from '../../web/plain-status.js';
import { prSteps, researchStepState, stepSince } from '../../web/pr-steps.js';
import { leftFlowAt, noRelease, releaseView, servedFor, type ReleaseView } from '../../web/release.js';
import { stalledCards } from '../../web/pages/actionless.js';
import { resourceConflicts } from '../coordination.js';

/**
 * The board (GY-200): every open item in its one group, with who acts next, the command that
 * acts when one exists, since when it has been there and whether that is overdue. It is the one
 * classification: the server serves it at `GET /api/board`, the Work page renders what that
 * returns, and `master status` lists from it what the master owes, so the operator's view and an
 * agent's cannot disagree. Pure over the work, the clock, the human-only rows and the release
 * view — no I/O and nothing the browser bundle cannot load. Delivered work is `shipped`
 * (`leftFlowAt`): a per-item deployment record is written only for policies that ask for a
 * post-deployment check, so its absence never holds work back. Merged work is moving at Deploy
 * while its check is outstanding or while the production watch observes that production does not
 * serve it yet (web/release.ts), and blocked when the check or the deployment failed. Within
 * Shipped, an item is live only once the release is observed serving it (`servedAt`, under the
 * configured production environment); until then it reads "Merged" and is not counted as shipped
 * this week. Closed work is in none.
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
  // A research run live or awaited is somebody working on the item, before any builder starts
  // (GY-434): the item is moving, at its Research step, and not waiting for a worker.
  if (researchStepState(work, now) === 'current') return 'moving';
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
export function nextActor(work: Work, group: Group | null, now: number, release: ReleaseView = noRelease, all: Work[] = []): { who: string; does: string } {
  if (group === 'needs-you') return { who: 'You', does: work.humanRequest ? shortShas(work.humanRequest.needed) : 'Answer the decision it is waiting on' };
  if (group === 'backlog') {
    const dependency = work.gates.find(gate => gate.name === 'ready')?.reasons.find(reason => reason.startsWith('Dependency '));
    return dependency && work.ready ? { who: 'Nobody yet', does: plainReason(dependency, 'ready').text } : { who: 'Master agent', does: 'Release it for work when it is a priority' };
  }
  // Blocked means the step's own actor cannot clear it (a recorded blocker, a stall, a violation,
  // a refusal no retry fixes, a failed check after deploying): the master agent acts next.
  if (group === 'blocked') return { who: 'Master agent', does: release.failed.has(work.key) && work.stage === 'done' ? 'Find out why production has not deployed it, and record the cause' : 'Clear what blocks it, or hand the decision to an approver agent' };
  if (group === 'up-next') {
    const held = upNextHold(work, all, now);
    return held ? { who: 'Nobody yet', does: held.text } : { who: 'Graphyard (assigns a builder)', does: 'Hands it to the next free builder agent' };
  }
  const steps = prSteps(work, now, release);
  return { who: steps.who, does: steps.label };
}

/**
 * Why an item in Up next is not waiting for a worker at all (GY-172): it is held by a dependency
 * that has not shipped — "Waiting for GY-N to ship first" — or by an exclusive resource another
 * claimed item holds, which names that item and the resource. Null for an item a free builder takes
 * next. The resource hold is the dispatcher's own (`resourceConflicts`, as `dispatchHold` applies
 * it), so the page says what the loop does; planned-file overlap holds nothing (dispatch is
 * optimistic), so an overlapping item is described as waiting for a worker, which it is.
 */
export function upNextHold(work: Work, all: Work[], now: number): { kind: 'dependency' | 'resource'; text: string } | null {
  const dependency = work.gates.find(gate => gate.name === 'ready')?.reasons.find(reason => reason.startsWith('Dependency '));
  if (dependency) return { kind: 'dependency', text: plainReason(dependency, 'ready').text };
  const held = resourceConflicts(work, all, now);
  if (!held.length) return null;
  return { kind: 'resource', text: `Waiting for ${[...new Set(held.map(entry => entry.key))].join(', ')} to release ${[...new Set(held.map(entry => entry.resource))].join(', ')}: an exclusive resource it needs` };
}
/** What the Up next tile says under its count: waiting for a worker only when that is true of what it counts. */
export function upNextMeaning(items: Work[], all: Work[], now: number): string {
  return heldMeaning(items.length, items.flatMap(item => upNextHold(item, all, now)?.text ?? []));
}
/** The same tile words from the board's Up next rows: a held row is the one nobody acts on yet (`nextActor`). */
export const upNextTile = (items: Pick<BoardItem, 'who' | 'does'>[]) => heldMeaning(items.length, items.flatMap(item => item.who === 'Nobody yet' ? [item.does] : []));
function heldMeaning(total: number, held: string[]): string {
  if (!held.length) return groupMeaning['up-next'];
  if (held.length === total) return held.length === 1 ? held[0]! : 'Held behind other work';
  return `${total - held.length} waiting for a worker · ${held.length} held`;
}

/** The role whose step is next, in the vocabulary an agent reads (`actor` on a board item). */
export const actorRoles = ['worker', 'reviewer', 'producer', 'approver', 'master', 'executor', 'human-only'] as const;
export type ActorRole = typeof actorRoles[number];
const roleOf: Record<string, ActorRole> = {
  You: 'human-only', 'Master agent': 'master', 'Builder agent': 'worker', 'Research agent': 'worker', 'Reviewer agent': 'reviewer', 'Prover agent': 'producer',
  // The control plane's own steps: the dispatcher, the CI run, the merge queue, the production watch.
  'Graphyard (automatic)': 'executor', 'Graphyard (assigns a builder)': 'executor', 'Automated checks': 'executor', 'Nobody yet': 'executor',
};

/**
 * The role acting next. A worker's open scope request that the widening rule has not refused is
 * the approver's to judge, whatever step the item shows; everything else is the role `nextActor`
 * names on the card.
 */
export function actorRole(work: Work, group: Group | null, who: string): ActorRole {
  if (group === 'needs-you') return 'human-only';
  const request = work.scopeRequest;
  if (group === 'moving' && request && request.decision?.state !== 'refused' && work.lease?.epoch === request.epoch) return 'approver';
  return roleOf[who] ?? 'executor';
}

const escalation = /^Unresolved \S+ escalation requires operator resolution/;
const refusalsOf = (work: Work, gate: string) => work.gates.find(entry => entry.name === gate && !entry.passed)?.reasons ?? [];

/**
 * The exact command that takes the next step, when there is one to run: a scope refusal is
 * `master scope`, a recorded blocker `master unblock`, an escalation `master decide … resolve`, a
 * merged item production does not serve `master verify-deployment`, a candidate every other gate
 * passed (merging, or stranded there) `master merge`, a review `master review`, backlog
 * `master release`, and a human-only decision the answer its row names. Null where the next step
 * is a session already running or a turn nobody can take early.
 */
export function nextCommand(work: Work, group: Group | null, actor: ActorRole, humanRow?: HumanRequestRow): string | null {
  const key = work.key;
  if (actor === 'human-only') return humanRow?.answer.cli ?? (work.humanRequest ? answerCommand(key, work.humanRequest) : null);
  if (actor === 'approver') return `graphyard master decisions ${key}`;
  if (actor === 'reviewer') return `graphyard master review ${key}`;
  if (group === 'backlog') return actor === 'master' ? `graphyard master release ${key}` : null;
  if (work.scopeRequest && work.blocker?.startsWith(scopeRefusalBlocker)) return `graphyard master scope ${key}`;
  if (work.blocker) return `graphyard master unblock ${key} REASON`;
  if (work.stage === 'done') return actor === 'master' ? `graphyard master verify-deployment ${key}` : null;
  if (refusalsOf(work, 'merge').some(reason => escalation.test(reason))) return `graphyard master decide ${key} resolve REASON`;
  const mergeable = !!work.submission && work.gates.every(gate => gate.passed || gate.name === 'merge');
  if (mergeable && (actor === 'master' || actor === 'executor') && (work.nextAction?.kind ?? 'merge') === 'merge') return `graphyard master merge ${key}`;
  return null;
}

/** One open item as the board serves it. */
export interface BoardItem {
  id: string; key: string; title: string; priority: number;
  group: OpenGroup; stage: Work['stage'];
  /** The identity holding (or last holding) the item's lease; null when nobody has claimed it. */
  owner: string | null;
  /** The role that takes the next step, and that step in plain words, as the Work page shows them. */
  actor: ActorRole; who: string; does: string;
  /** The exact command that takes it, when one exists. */
  command: string | null;
  /** When the item entered the state its group reports: the step for timed groups, the request for Needs you. */
  since: string;
  /** Past the fault bound (`overdueAfterMs`) in a group that carries a clock. */
  overdue: boolean;
}
export interface Board {
  now: string;
  /** The bound past which a moving or blocked item is overdue. */
  overdueAfterMs: number;
  groups: Record<OpenGroup, BoardItem[]>;
  counts: Record<OpenGroup, number>;
  open: number;
}

/** Every open item into its group with its next actor, command, since and overdue. */
export function buildBoard(work: Work[], now: number, humanRows?: HumanRequestRow[] | null, release: ReleaseView = noRelease): Board {
  const { byGroup, open } = classify(work, now, humanRows, release);
  const stalls = new Map(stalledCards(work.filter(item => item.stage !== 'done' && !isClosed(item)), now).map(card => [card.item.id, card]));
  const rows = new Map((humanRows ?? []).map(row => [row.id, row]));
  const item = (entry: Work, group: OpenGroup): BoardItem => {
    const { who, does } = nextActor(entry, group, now, release, work);
    const actor = actorRole(entry, group, who);
    const timed = timedGroups.has(group);
    const since = group === 'needs-you' ? entry.humanRequest?.at ?? rows.get(entry.id)?.request.at ?? statusSince(entry, now)
      : group === 'blocked' && stalls.has(entry.id) ? stalls.get(entry.id)!.heldSince
        : timed ? stepSince(entry, now, null, release) : statusSince(entry, now);
    return { id: entry.id, key: entry.key, title: entry.title, priority: entry.priority, group, stage: entry.stage, owner: entry.lease?.owner ?? entry.lastAssignment?.owner ?? null,
      actor, who, does, command: nextCommand(entry, group, actor, rows.get(entry.id)), since, overdue: timed && statusDuration(since, now).overdue };
  };
  const board = Object.fromEntries(groups.map(group => [group, byGroup[group].map(entry => item(entry, group))])) as Record<OpenGroup, BoardItem[]>;
  return { now: new Date(now).toISOString(), overdueAfterMs: OVERDUE_MINUTES * 60_000, groups: board,
    counts: Object.fromEntries(groups.map(group => [group, board[group].length])) as Record<OpenGroup, number>, open };
}

/**
 * The board from the status read every client has (`humanOnly`, `productionEnvironment`,
 * `production`, `ciAppIds`): what `GET /api/board` serves, and what `master status` builds for
 * itself when the server it talks to predates the route.
 */
export const boardFromStatus = (work: Work[], now: number, status: any) => buildBoard(work, now, status?.humanOnly, releaseView(status));

/** True for a response shaped as a board. */
export const isBoard = (value: any): value is Board => !!value && typeof value === 'object' && !!value.groups && groups.every(group => Array.isArray(value.groups[group]));

/**
 * The `board` section of `master status`: every item whose next step is the master's, first and
 * with its command — blocked on scope, a decision no approver answered, a stranded merge — then
 * every other open item, with the group counts. Read from `GET /api/board`; built from the same
 * module over the snapshot and status already in hand when that read is unavailable.
 */
export async function masterBoard(api: (path: string) => Promise<any>, snapshot: { work: Work[]; now: string }, status: any, unanswered: { work: string; id: string }[] = []) {
  const served = await api('board').catch(() => null);
  const board = isBoard(served) ? served : boardFromStatus(snapshot.work, Date.parse(snapshot.now), status);
  const items = groups.flatMap(group => board.groups[group]).map(entry => {
    const decision = unanswered.find(row => row.work === entry.key);
    return decision ? { ...entry, actor: 'master' as const, command: `graphyard master approver ${entry.key} ${decision.id}` } : entry;
  });
  return { counts: board.counts, open: board.open, overdueAfterMs: board.overdueAfterMs,
    owed: items.filter(entry => entry.actor === 'master'), others: items.filter(entry => entry.actor !== 'master') };
}
