// Concern: review by risk in control-plane mode (GY-1525) — what the review gate owes a normal
// delta after its merge, and the one reviewer launch the control plane registers per item.
import type { Work } from './work.js';
import type { RiskClass } from './risk-class.js';

/**
 * In control-plane mode the review gate reads the risk class of the merge delta (risk-class.ts)
 * where github mode reads the path lane: a `sensitive` delta needs an exact-head approval before
 * it merges, and a `normal` one merges on its trial and is reviewed afterwards. `work.postMergeReview`
 * is that debt: `owed` once the gate passed the head without an approval, `reviewed` once the
 * post-merge verdict is recorded. It is cleared when an approval of the head arrives before the
 * merge after all, and never changes once the item is delivered or reviewed.
 */
export const postMergeReviewStates = ['owed', 'reviewed'] as const;
export type PostMergeReviewState = typeof postMergeReviewStates[number];

/** The verdict a control-plane reviewer session posted, as the launch and the observation record it. */
export interface ControlPlaneVerdict {
  reviewer: string; sha: string; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'; body: string; submittedAt: string; source: 'control-plane';
  /** The ledger sequence of the `review.verdict` event: the verdict's id wherever a review id is read. */
  reviewId: number;
}

/**
 * The reviewer launch the control plane registered for the item (server/review-verdict.ts): the
 * reviewer principal, the launch's requester, the head and base the session judges and the sha256
 * of the one-time verdict token. One launch stands per item; a relaunch replaces it. `postMerge`
 * names a review of the delivered merge commit rather than of the candidate.
 */
export interface ControlPlaneReviewLaunch {
  id: string; reviewer: string; requester: string; head: string; baseTip: string; tokenHash: string;
  at: string; expiresAt: string; postMerge: boolean;
  verdict: ControlPlaneVerdict | null;
  /** The independence refusal that ended this launch, when one did. */
  refused?: { at: string; reason: string };
}

declare module './work.js' {
  interface Work {
    /** GY-1525: the post-merge review a normal control-plane delta owes, set by the review gate; `reviewed` once its verdict is recorded. */
    postMergeReview?: PostMergeReviewState | null;
    /** GY-1525: the reviewer launch registered for this item in control-plane mode. */
    reviewLaunch?: ControlPlaneReviewLaunch | null;
  }
}

/**
 * The review gate's refusal for a sensitive control-plane delta without an exact approval, naming
 * what made it sensitive so the reader sees why the merge waits.
 */
export const sensitiveReviewRefusal = (reasons: readonly string[]) =>
  `Independent approval of the current commit is required: the merge delta is sensitive (${reasons.join('; ') || 'unknown change'})`;

/**
 * What the evaluation writes to `postMergeReview` for a control-plane head, or nothing. A delivered
 * or reviewed item keeps its state; a normal delta the gate passes without an approval is `owed`; an
 * approval of the head, or a delta that reads sensitive now, clears a standing debt.
 */
export function postMergeReviewMark(work: Pick<Work, 'stage' | 'postMergeReview'>, risk: RiskClass, reviewPassed: boolean): { postMergeReview?: PostMergeReviewState | null } {
  if (work.stage === 'done' || work.postMergeReview === 'reviewed') return {};
  const owed = risk === 'normal' && !reviewPassed;
  if (owed) return work.postMergeReview === 'owed' ? {} : { postMergeReview: 'owed' };
  return work.postMergeReview === 'owed' ? { postMergeReview: null } : {};
}

/** Whether the merge writer delivered this item (its ledger reconciled, or its observation the control plane's own). */
export const deliveredByMergeWriter = (work: Pick<Work, 'stage' | 'delivery' | 'mergeLedger' | 'observation'>) =>
  work.stage === 'done' && !!work.delivery?.mergeSha && (work.mergeLedger?.state === 'reconciled' || work.observation?.source === 'control-plane');

/** The delivered items whose post-merge review is still owed: delivered by the merge writer, `postMergeReview === 'owed'`, no verdict recorded for the merge commit. */
export function owedPostMergeReviews(work: readonly Work[]): Work[] {
  return work.filter(item => deliveredByMergeWriter(item) && item.postMergeReview === 'owed'
    && !(item.reviewLaunch?.postMerge && item.reviewLaunch.head === item.delivery!.mergeSha && item.reviewLaunch.verdict));
}

/** The dispatch request id a post-merge review is launched under: one per delivered merge commit, so the ledger keeps one session per attempt. */
export const postMergeRequestId = (key: string, mergeSha: string) => `post-merge:${key}:${mergeSha.slice(0, 12)}`;

/**
 * One blocking finding of a post-merge verdict, with the first repository file it names and that
 * file's line, and every file it names (`paths`, in order, the first one first): a token with an extension (`src/a.ts:12`, `.gitignore`), one followed
 * by a line (`Dockerfile:12`, `Makefile:3-9`), or a well-known extensionless file named alone.
 */
export interface PostMergeFinding { text: string; path: string | null; line: number | null; paths: string[] }
const extensionlessFiles = new Set(['Dockerfile', 'Containerfile', 'Makefile', 'GNUmakefile', 'Procfile', 'Gemfile', 'Rakefile', 'Jenkinsfile', 'Vagrantfile', 'Brewfile', 'Justfile', 'LICENSE', 'CODEOWNERS', 'VERSION']);
const notFiles = new Set(['e.g', 'i.e', 'etc', 'vs']);
function findingFile(token: string): { path: string; line: number | null } | null {
  const match = /^([A-Za-z0-9_./@+-]+?)(?::(\d+)(?:[-–]\d+)?)?$/.exec(token);
  if (!match || token.includes('://')) return null;
  const path = match[1]!.replace(/[.,;]+$/, ''), line = match[2] ? Number(match[2]) : null;
  if (!path || notFiles.has(path.toLowerCase()) || /^AC-\d+$/i.test(path) || /^\.+$/.test(path) || /^[\d.]+$/.test(path)) return null;
  // A camelCase suffix (`work.postMergeReview`) is a property, not a file's extension.
  const named = /\.(?:[a-z][a-z0-9]*|[A-Z][A-Z0-9]*)$/.test(path) || extensionlessFiles.has(path.split('/').pop()!) || (line !== null && /[A-Za-z]/.test(path));
  return named ? { path: path.replace(/^\.\//, ''), line } : null;
}
export function parseFinding(text: string): PostMergeFinding {
  const trimmed = text.trim();
  const files = trimmed.split(/[\s`'"()[\]{},]+/).flatMap(token => findingFile(token.replace(/[.;:—–]+$/, '')) ?? []);
  const paths = [...new Set(files.map(file => file.path))];
  return files[0] ? { text: trimmed, ...files[0], paths } : { text: trimmed, path: null, line: null, paths };
}

/**
 * The non-blocking findings of a post-merge verdict, every one and each whole: `read` is what
 * review-cap.ts `followUpFindingsOf` found in `rest` (the body without its BLOCKING lines), which
 * cuts each finding at 2,000 characters; a cut one is read again to the end of its line (a named
 * `Follow-up finding:` line) or of its block. The API bounds the verdict body, so nothing is lost.
 */
export function wholeFindings(rest: string, read: readonly string[], cut = 2000): string[] {
  const named = /^\s*(?:[-*]\s*)?\**FOLLOW-?UP/im.test(rest);
  let from = 0;
  return read.map(text => {
    const at = rest.indexOf(text, from);
    if (at < 0) return text;
    from = at + text.length;
    if (text.length < cut) return text;
    const tail = rest.slice(at), end = tail.search(named ? /\n/ : /\n\s*\n|\n(?=\s*(?:[-*]|\d+\.)\s)/);
    const whole = (end < 0 ? tail : tail.slice(0, end)).trim();
    from = at + whole.length;
    return whole;
  });
}

/**
 * The follow-up item one BLOCKING finding of a post-merge review files (AC-4): a bug at priority 1,
 * its origin naming the delivered item and its merge commit, planned on every file the finding
 * names, reviewed like any item. The delivered item itself is never reopened.
 */
export function postMergeFollowUp(delivered: Pick<Work, 'key' | 'title' | 'policy'>, mergeSha: string, finding: PostMergeFinding, index: number) {
  const others = finding.paths.filter(path => path !== finding.path);
  const where = finding.path ? ` in ${finding.path}${finding.line ? `:${finding.line}` : ''}${others.length ? ` (also ${others.join(', ')})` : ''}` : '';
  return {
    title: `Post-merge review of ${delivered.key} (${mergeSha.slice(0, 12)}): ${finding.text.slice(0, 120)}`.slice(0, 200),
    description: `The post-merge review of ${delivered.key} ("${delivered.title}"), delivered as merge commit ${mergeSha}, found this BLOCKING${where}:\n\n${finding.text}\n\nFix it on its own head; the delivered item is not reopened.`,
    type: 'bug' as const, priority: 1,
    criteria: [{ id: 'AC-1', text: `The finding is fixed: ${finding.text.slice(0, 1500)}`, proofs: [`unit:post-merge-follow-up-${index + 1}`] }],
    policy: { checks: delivered.policy?.checks ?? ['test', 'typecheck'], review: true },
    plannedFiles: finding.paths,
    origin: { reviewFollowUps: { parent: delivered.key, findings: [{ path: finding.path, text: finding.text.slice(0, 2000), ref: mergeSha }] } },
  };
}
