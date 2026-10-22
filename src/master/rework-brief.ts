// Concern: GY-1569 — what a rework attempt's worker is told about why its head came back.
//
// A rework's reason names the findings the head must answer: the reviewer's blocking finding, the
// pinned text a cut removed, the exact edits a coordinator verified. The worker launched for the
// round never read it, so it resubmitted the same head. The rework command records its reason on
// the item (`lastRework`), and the launcher puts it in the request.
import type { Work } from '../model.js';

/** The longest reason the request carries; the full text stays in the item's history. */
export const reworkBriefMax = 4000;

/** The applied rework whose round this attempt is. */
export interface AppliedRework { reason: string; at: string }

type BriefWork = Partial<Pick<Work, 'submission' | 'candidate' | 'pipeline' | 'lastRework'>>;

/**
 * The last applied rework, when it sent back the item's last hand-in: applied after that hand-in
 * (`pipeline.resubmittedAt`, else `submittedAt`). A rework of an earlier round, already answered by a
 * later hand-in, is not this round's grounds; an item never submitted has none.
 */
export function appliedReworkBrief(work: BriefWork): AppliedRework | null {
  const latest = work.lastRework, reason = latest?.reason.trim();
  if (!work.submission || !latest || !reason) return null;
  const handedIn = work.pipeline?.resubmittedAt ?? work.pipeline?.submittedAt ?? null;
  if (handedIn && Date.parse(latest.at) < Date.parse(handedIn)) return null;
  return { reason, at: latest.at };
}

/** The worker request's section for a rework round: the rework's reason, and that the same head answers nothing. */
export function reworkBriefSection(work: BriefWork, rework: AppliedRework | null | undefined): string {
  if (!rework || !work.submission) return '';
  const reason = rework.reason.length > reworkBriefMax ? `${rework.reason.slice(0, reworkBriefMax)}… (truncated; read the whole reason in the item's history)` : rework.reason;
  const head = work.candidate?.sha ? ` at head ${work.candidate.sha.slice(0, 12)}` : '';
  return `This attempt is a rework round of change #${work.submission.pr}${head}. The rework applied at ${rework.at} sent it back for this reason, which is this round's brief: ${reason} `
    + 'Answer every point it names with a new commit on the assigned branch, submitted with complete --head; resubmitting the same head answers nothing, because what sent it back still stands on it. ';
}
