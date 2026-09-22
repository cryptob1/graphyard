import { agentOwner, type AttentionItem } from '../master.js';
import type { Work } from '../model.js';
import { humanNeededActions, type HumanNeededRow } from '../model/next-action.js';

/**
 * What `master status` says about work that is waiting on a judgement rather than on capacity
 * (GY-104).
 *
 * `escalate` and `request-rework` are judgments made in the step itself, so no executor holds a
 * handler for either: their rows are never claimed, never fail, and never appear as a refused
 * launch. Counted with the queue they were indistinguishable from work an executor was about to
 * take, and noticed only if somebody read the idle list five minutes later. Here they are their
 * own population — named, owed, and counted apart.
 */

/** Long waits read in the unit the reader thinks in; a request measured in seconds is still young. */
export const elapsed = (ms: number) => ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}h${Math.floor(ms % 3_600_000 / 60_000)}m` : ms >= 60_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 1000)}s`;

/**
 * One attention item per action nobody in the executor loop may run, and per concern carried
 * beside an action that is running. Each names what is waiting, how long it has waited and the
 * command that answers it.
 */
export function humanNeededAttention(snapshot: { work: Work[]; now: string }): AttentionItem[] {
  return humanNeededActions(snapshot.work, new Date(snapshot.now)).map(row => ({
    subject: row.key,
    text: `${row.reason} — no executor may run it; ${row.decision} has been owed for ${elapsed(row.waitedMs)}`,
    ...agentOwner('master', row.resolve, 'approver'),
  }));
}

/**
 * The action report with the two populations separated: rows an executor will take, and rows only
 * a judgment settles. `waiting` and `idle` are what the queue offers executors, so a row nobody
 * may claim is taken out of both — it would otherwise age into the idle list as though an
 * executor were late to it.
 */
export function needsHumanActions<T extends { waiting: { id: string }[]; idle: { id: string }[] }>(report: T, owed: HumanNeededRow[]) {
  const rows = new Set(owed.map(entry => entry.action).filter((id): id is string => !!id));
  return { ...report, needsHuman: owed, waiting: report.waiting.filter(entry => !rows.has(entry.id)), idle: report.idle.filter(entry => !rows.has(entry.id)) };
}
