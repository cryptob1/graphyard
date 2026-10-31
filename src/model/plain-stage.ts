import type { Work } from './work.js';
import type { ServeCheck } from '../serve-app.js';
import { noRelease, servedFor, type ReleaseView } from './release.js';

/**
 * Plain words for an item's derived stage (GY-2988). The control plane still derives
 * backlog/ready/build/review/test/acceptance/merge/done; only the words people read change.
 * One label per stage, never set by a client.
 */
export const plainStages = [
  'Not started', 'Building', 'Testing', 'In review', 'Merging',
  'Merged, not live yet', 'Live', 'Live and verified', 'Live and failing', 'Done',
] as const;
export type PlainStage = typeof plainStages[number];

/** One line each in docs/glossary.md: the plain label and the derived stage it names. */
export const plainStageLines: Record<PlainStage, string> = {
  'Not started': 'Not started (backlog, ready) — nobody holds it yet.',
  Building: 'Building (build) — a worker holds it and is writing the change.',
  Testing: 'Testing (test, acceptance) — automated checks or proofs are running on the handed-in change.',
  'In review': 'In review (review) — someone other than the builder is judging the change.',
  Merging: 'Merging (merge) — the merge writer is queuing or trying the change onto main.',
  'Merged, not live yet': 'Merged, not live yet (done) — merged; the app has not been seen serving it.',
  Live: 'Live (done) — the app serves it; no verdict names this item.',
  'Live and verified': 'Live and verified (done) — its own merge is served and the required cases passed (GY-2983).',
  'Live and failing': 'Live and failing (done) — served, and a failing required case is its own merge\'s or proves it (GY-2983).',
  Done: 'Done (done) — closed, or merged where the repository has no deployment.',
};

/** Whether the repository serves, the commit it serves, and GY-2983's verdict on that commit. */
export interface ServeView { serves: boolean; commit: string | null; check: ServeCheck | null }
export const noServe: ServeView = { serves: false, commit: null, check: null };

/** The serve view from the status read every page already has (`serving`). */
export function serveView(status: any): ServeView {
  const serving = status?.serving, serve = serving?.serve;
  if (!serve || typeof serve !== 'object') return noServe;
  const raw = serve.check;
  const check = raw && typeof raw === 'object' && typeof raw.verified === 'boolean'
    ? { verified: raw.verified, case: typeof raw.case === 'string' ? raw.case : null, step: typeof raw.step === 'string' ? raw.step : null, reason: typeof raw.reason === 'string' ? raw.reason : null }
    : null;
  return { serves: true, commit: typeof serving.commit === 'string' ? serving.commit : null, check };
}

/** The release-level line when the served commit fails a required case, shown once rather than on every row. */
export const liveFailingLine = (serve: ServeView) =>
  serve.check?.verified === false ? `The live app is failing ${serve.check.case ?? 'a required case'}` : null;

/**
 * The plain label for an item's derived stage. Derivation is unchanged; `release` and `serve`
 * only refine a delivered item. A verdict on the served commit names an item only when that
 * commit is the item's own merge, or the failing case is one of the item's proofs.
 */
export function plainStage(work: Work, release: ReleaseView = noRelease, serve: ServeView = noServe): PlainStage {
  switch (work.stage) {
    case 'backlog': case 'ready': return 'Not started';
    case 'build': return 'Building';
    case 'test': case 'acceptance': return 'Testing';
    case 'review': return 'In review';
    case 'merge': return 'Merging';
  }
  if (work.closure || !work.delivery) return 'Done';
  // A repository with no deployment (no serve, no watched release) has nothing further to reach.
  if (servedFor(work, release) === null) return serve.serves || release.observedAt !== null ? 'Merged, not live yet' : 'Done';
  const check = serve.check;
  if (!check) return 'Live';
  const own = !!serve.commit && serve.commit === work.delivery.mergeSha;
  if (check.verified) return own ? 'Live and verified' : 'Live';
  const proves = !!check.case && work.criteria.some(criterion => criterion.proofs.includes(`e2e:${check.case}`));
  return own || proves ? 'Live and failing' : 'Live';
}
