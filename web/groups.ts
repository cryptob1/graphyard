/**
 * The dashboard's groups (GY-161) are the board's (GY-200): the classification lives in
 * src/model/board.ts, which the server serves at `GET /api/board` and the Work page renders, so a
 * page and the server cannot disagree. This module re-exports it for the pages that read one item's
 * group (the item page, a card) and keeps the page's own summary sentence.
 */
export { actorRoles, boardFromStatus, buildBoard, classify, groupLabel, groupMeaning, groupOf, groupWithin, groups, humanOnlyIds, isBoard, mergedAt, nextActor, releasedAt, shippedThisWeek, timedGroups, upNextHold, upNextMeaning, upNextTile } from '../src/model/board';
export type { ActorRole, Board, BoardItem, Classification, Group, OpenGroup } from '../src/model/board';
import type { OpenGroup } from '../src/model/board';

/** "1 item needs you. 2 are moving. Nothing is blocked." — the page's one summary sentence, from the same counts. */
export function summarySentence(counts: Record<OpenGroup, number>): string {
  const parts: string[] = [];
  if (counts['needs-you']) parts.push(`${counts['needs-you']} ${counts['needs-you'] === 1 ? 'item needs' : 'items need'} you.`);
  if (counts.moving) parts.push(`${counts.moving} ${counts.moving === 1 ? 'is' : 'are'} moving.`);
  parts.push(counts.blocked ? `${counts.blocked} ${counts.blocked === 1 ? 'is' : 'are'} blocked.` : 'Nothing is blocked.');
  return parts.join(' ');
}
