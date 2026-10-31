import type { Work } from './work.js';
import type { ServeCheck } from '../serve-app.js';
import { noRelease, servedFor, type ReleaseView } from './release.js';

/**
 * Plain words for an item's derived stage (GY-2988). The control plane still derives
 * backlog/ready/build/review/test/acceptance/merge/done; only the words people read change.
 * One label per stage, never set by a client.
 */
export const plainStages = [
  'Building', 'Testing', 'In review', 'Merging',
  'Live and verified', 'Live and failing', 'Live', 'Done',
] as const;
export type PlainStage = typeof plainStages[number];

/** One line each in docs/glossary.md: the plain label and the derived stage it names. */
export const plainStageLines: Record<PlainStage, string> = {
  Building: 'Building (build) — a worker is writing the change, or it is waiting for one.',
  Testing: 'Testing (test) — automated checks or proofs are running on the handed-in change.',
  'In review': 'In review (review) — someone other than the builder is judging the change.',
  Merging: 'Merging (merge) — the merge writer is queuing or trying the change onto main.',
  'Live and verified': 'Live and verified — merged and served; the served commit\'s required cases passed (GY-2983).',
  'Live and failing': 'Live and failing — merged and served; a required case against the served URL is failing (GY-2983).',
  Live: 'Live — merged; the repository serves nothing, so there is no verification verdict.',
  Done: 'Done — merged (or closed) and not live on a served head.',
};

/** Whether the repository serves, and GY-2983's verdict on the served commit when it does. */
export interface ServeView { serves: boolean; check: ServeCheck | null }
export const noServe: ServeView = { serves: false, check: null };

/** The serve view from the status read every page already has (`serving.serve`). */
export function serveView(status: any): ServeView {
  const serve = status?.serving?.serve;
  if (!serve || typeof serve !== 'object') return noServe;
  const raw = serve.check;
  const check = raw && typeof raw === 'object' && typeof raw.verified === 'boolean'
    ? { verified: raw.verified, case: typeof raw.case === 'string' ? raw.case : null, step: typeof raw.step === 'string' ? raw.step : null, reason: typeof raw.reason === 'string' ? raw.reason : null }
    : null;
  return { serves: true, check };
}

/**
 * The plain label for an item's derived stage. Derivation is unchanged; `release` and `serve`
 * only refine a done item into Live / Live and verified / Live and failing / Done.
 */
export function plainStage(work: Work, release: ReleaseView = noRelease, serve: ServeView = noServe): PlainStage {
  if (work.stage === 'done') {
    if (work.closure || !work.delivery) return 'Done';
    // Repository serves nothing: every delivered item is Live (no verdict exists to refine it).
    if (!serve.serves) return 'Live';
    // Repository serves: Live* once the release is observed serving this item; else Done.
    if (servedFor(work, release) === null) return 'Done';
    if (serve.check?.verified === true) return 'Live and verified';
    if (serve.check?.verified === false) return 'Live and failing';
    return 'Live';
  }
  switch (work.stage) {
    case 'test':
    case 'acceptance':
      return 'Testing';
    case 'review':
      return 'In review';
    case 'merge':
      return 'Merging';
    default:
      // backlog, ready, build — not yet past the build gate
      return 'Building';
  }
}
