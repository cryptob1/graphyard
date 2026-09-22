import { agentOwner, type AttentionItem, type HerdrAgent } from '../master.js';
import type { Work } from '../model.js';
import { overlongSessionLines, type SessionKind } from '../model/sessions.js';
import { runtimeEndedStates } from '../harness.js';

/**
 * What `master status` says about a session that has outlived its role's maximum (GY-113).
 *
 * The liveness sweep closes a session the runtime no longer reports and one whose head, decision
 * or item has moved on; neither rule reaches a session that is still live and still bound but
 * making no progress. That session holds its role slot, its provider seat and its item while
 * reporting nothing wrong, and before this line only a reader who attached to it could tell.
 *
 * Reporting only: nothing here ends a session, and the line for a session that is not live points
 * at the sweep that closes it rather than at a hand closure.
 */

/**
 * One attention item per running session past its role's maximum (`model/sessions.ts`), whether or
 * not it is still live: a session that died is closed by the liveness sweep and needs nobody, while
 * one that is running and making no progress holds its role slot, its provider seat and its item
 * while reporting nothing wrong. Nothing is closed from this line — only a reader can tell.
 */
export function overlongSessionAttention(snapshot: { work: Work[]; now: string }, runtime: { agents: HerdrAgent[]; available: boolean; hostId?: string | null }, maximums?: Partial<Record<SessionKind, number>>): AttentionItem[] {
  return overlongSessionLines(snapshot.work, runtime.available ? runtime.agents : null, new Date(snapshot.now),
    { states: runtimeEndedStates, hostId: runtime.hostId ?? null, ...(maximums ? { maximums } : {}) })
    .map(line => ({ subject: line.subject, text: line.text, ...agentOwner('master', line.next) }));
}
