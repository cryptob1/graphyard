/**
 * GY-3267: the screenshots a merge trial kept of the browser cases it ran — each case's last
 * screenshot on the base tip (`before`) and on the candidate (`after`) — stored by the control
 * plane from the trial record (server/trial-screenshots.ts) and shown side by side on the item
 * page. Replaced by each fresh trial record; an item whose trial ran no browser case keeps none
 * and shows none.
 */
export interface TrialScreenshots {
  /** The merge commit the after screenshots served, and the tip the before ones served. */
  mergeSha: string; baseTip: string; at: string;
  /** Each browser case the trial ran, naming the sides kept for it. */
  cases: { case: string; before?: true; after?: true }[];
}

declare module './work.js' {
  interface Work {
    /** GY-3267: the merge trial's kept browser-case screenshots, replaced by each fresh trial record. */
    trialScreenshots?: TrialScreenshots | null;
  }
}
