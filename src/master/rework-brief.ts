// Concern: GY-1569 — what a rework attempt's worker is told about why its head came back.
//
// A rework decision's reason names the findings the head must answer: the reviewer's blocking
// finding, the pinned text a cut removed, the exact edits a coordinator verified. The worker
// launched for the round never read it: its request named the item and its criteria only, so it
// resubmitted the same head, and the master restated the reason as a new criterion with the files
// it names added to plannedFiles. Five such widenings at the review stage in seven days (GY-1519,
// GY-1543 twice) were that restatement. The launcher now reads the applied decision and puts its
// reason in the request, so the round's grounds reach the worker without a requirements change.
// A read of the decisions that fails refuses the launch before anything is claimed, so no rework
// round ever starts without the reason it was sent back for.
import type { Work } from '../model.js';
import { readCredentialFile } from './config.js';

/** The longest reason the request carries; the full text stays on the decision. */
export const reworkBriefMax = 4000;

/** A decision as `/api/work/:id/decisions` returns it, as far as the brief reads it. */
export interface ReworkDecisionRow { id?: string; action: string; state: string; reason?: string | null; approvedAt?: string | null; input?: any }
/** The applied rework decision whose round this attempt is. */
export interface AppliedRework { id: string | null; reason: string; approvedAt: string }

/**
 * The decisions of a rework round's item could not be read: the launch is refused before anything is
 * claimed, as an unread merger is (GY-1523), and the item is dispatched again once the read succeeds.
 */
export class ReworkDecisionsUnreadError extends Error {
  constructor(readonly key: string, readonly url: string, readonly cause: string) {
    super(`the rework decisions of ${key} could not be read from ${url} (${cause}), so the launch is refused before anything is claimed rather than starting a rework round without the reason it was sent back for; it is dispatched again once the read succeeds`);
    this.name = 'ReworkDecisionsUnreadError';
  }
}

/** The item's decisions, read with the master's credential; a read that fails, times out, is refused or is malformed throws ReworkDecisionsUnreadError. */
export async function readReworkDecisions(config: { url: string; credentialFile: string }, work: Pick<Work, 'id' | 'key'>, fetcher: typeof fetch = fetch): Promise<ReworkDecisionRow[]> {
  const url = `${config.url}/api/work/${encodeURIComponent(work.id)}/decisions`;
  let decisions: unknown;
  try {
    const response = await fetcher(url, { headers: { Authorization: `Bearer ${await readCredentialFile(config.credentialFile)}` }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new ReworkDecisionsUnreadError(work.key, url, `HTTP ${response.status}`);
    decisions = ((await response.json()) as { decisions?: unknown }).decisions;
  } catch (error) { throw error instanceof ReworkDecisionsUnreadError ? error : new ReworkDecisionsUnreadError(work.key, url, error instanceof Error ? error.message : String(error)); }
  if (!Array.isArray(decisions)) throw new ReworkDecisionsUnreadError(work.key, url, 'the response carries no decisions list');
  return decisions as ReworkDecisionRow[];
}

type BriefWork = Partial<Pick<Work, 'submission' | 'candidate' | 'pipeline'>>;

/**
 * The most recently applied rework decision, when it sent back the item's last hand-in: applied
 * after that hand-in (`pipeline.resubmittedAt`, else `submittedAt`). A decision of an earlier round,
 * already answered by a later hand-in, is not this round's grounds; an item never submitted has none.
 */
export function appliedReworkBrief(work: BriefWork, decisions: readonly ReworkDecisionRow[]): AppliedRework | null {
  if (!work.submission) return null;
  const latest = decisions.filter(decision => decision.action === 'rework' && decision.state === 'applied' && typeof decision.approvedAt === 'string' && Number.isFinite(Date.parse(decision.approvedAt)))
    .sort((a, b) => Date.parse(a.approvedAt!) - Date.parse(b.approvedAt!)).at(-1);
  const reason = latest?.reason?.trim();
  if (!latest || !reason) return null;
  const handedIn = work.pipeline?.resubmittedAt ?? work.pipeline?.submittedAt ?? null;
  if (handedIn && Date.parse(latest.approvedAt!) < Date.parse(handedIn)) return null;
  return { id: latest.id ?? null, reason, approvedAt: latest.approvedAt! };
}

/** The worker request's section for a rework round: the decision's reason, and that the same head answers nothing. */
export function reworkBriefSection(work: BriefWork, rework: AppliedRework | null | undefined): string {
  if (!rework || !work.submission) return '';
  const reason = rework.reason.length > reworkBriefMax ? `${rework.reason.slice(0, reworkBriefMax)}… (truncated; read the whole reason on the decision${rework.id ? ` ${rework.id}` : ''})` : rework.reason;
  const head = work.candidate?.sha ? ` at head ${work.candidate.sha.slice(0, 12)}` : '';
  return `This attempt is a rework round of PR #${work.submission.pr}${head}. The rework decision applied at ${rework.approvedAt} sent it back for this reason, which is this round's brief: ${reason} `
    + 'Answer every point it names with a new commit pushed to the pull request\'s branch, and read the unresolved review threads on the pull request; resubmitting the same head answers nothing, because what sent it back still stands on it. '
    + 'If answering a point needs a file outside plannedFiles, ask for it with scope-request, naming the point. ';
}
