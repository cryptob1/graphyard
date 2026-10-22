import type { Work } from './model.js';

/**
 * GY-863. The landing check's per-file record may carry the blob the three-way merge of the head
 * onto the landing commit holds at the path, computed by the control plane from the three blobs'
 * contents (github.ts `decideLandingMerges`); where it is present the guard compares it, not the
 * head's blob, with the landing commit's version.
 */
declare module './model/work.js' {
  interface ScopeFile {
    /** The merged result's blob when the three-way merge was computed and was clean; absent otherwise. */
    mergeSha?: string | null;
  }
}

/**
 * GY-863. The line-level three-way merge git's own merge performs: each side's changes since the
 * merge base are applied to the other, a region both sides changed identically is taken once, and
 * a region they changed differently is a conflict. Pure and shared, so the landing check and its
 * tests run the identical judgement. Lines are whole bytes (a trailing newline-less piece is a
 * line), so a clean merge of byte-identical inputs reproduces git's blob exactly.
 */
export interface ThreeWayMerge { clean: boolean; content: Buffer | null }

interface DiffHunk { aStart: number; aLen: number; bStart: number; bLen: number }
/** One side's changed region: base[aStart, aStart + aLen) replaced by side[bStart, bStart + bLen). */

/** Beyond these the merge is left undone and the conservative blob-identity judgement stands: a heavily rewritten out-of-scope file is a refusal either way. */
const maxMergeCore = 5_000;
const maxMergeDistance = 1_000;

const splitLines = (content: Buffer): Buffer[] => {
  const lines: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index++) if (content[index] === 0x0a) { lines.push(content.subarray(start, index + 1)); start = index + 1; }
  if (start < content.length) lines.push(content.subarray(start));
  return lines;
};

const myersHunks = (a: number[], b: number[], offset: number): DiffHunk[] | null => {
  // Common ends never take an edit step: trim them so the caps measure the genuinely divergent core.
  let from = 0;
  while (from < a.length && from < b.length && a[from] === b[from]) from++;
  let endA = a.length, endB = b.length;
  while (endA > from && endB > from && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const coreA = a.slice(from, endA), coreB = b.slice(from, endB), max = coreA.length + coreB.length;
  if (max === 0) return [];
  if (max > maxMergeCore) return null;
  const center = max, trace: Int32Array[] = [];
  let v = new Int32Array(2 * max + 1), d = 0;
  outer: for (d = 0; d <= max; d++) {
    if (d > maxMergeDistance) return null;
    trace.push(Int32Array.from(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[center + k - 1] < v[center + k + 1]) ? v[center + k + 1] : v[center + k - 1] + 1;
      let y = x - k;
      while (x < coreA.length && y < coreB.length && coreA[x] === coreB[y]) { x++; y++; }
      v[center + k] = x;
      if (x >= coreA.length && y >= coreB.length) break outer;
    }
  }
  const edits: DiffHunk[] = [];
  let x = coreA.length, y = coreB.length;
  for (let step = d; step >= 1; step--) {
    const previous = trace[step], k = x - y;
    const previousK = k === -step || (k !== step && previous[center + k - 1] < previous[center + k + 1]) ? k + 1 : k - 1;
    const previousX = previous[center + previousK], previousY = previousX - previousK;
    while (x > previousX && y > previousY) { x--; y--; }
    edits.push(previousK === k + 1
      ? { aStart: offset + from + previousX, aLen: 0, bStart: offset + from + previousY, bLen: 1 }
      : { aStart: offset + from + previousX, aLen: 1, bStart: offset + from + previousY, bLen: 0 });
    x = previousX; y = previousY;
  }
  const hunks: DiffHunk[] = [];
  for (const edit of edits.reverse()) {
    const last = hunks[hunks.length - 1];
    if (last && last.aStart + last.aLen === edit.aStart && last.bStart + last.bLen === edit.bStart) { last.aLen += edit.aLen; last.bLen += edit.bLen; }
    else hunks.push(edit);
  }
  return hunks;
};

const sameLines = (a: number[], b: number[]) => a.length === b.length && a.every((line, index) => line === b[index]);

export function threeWayMerge(base: Buffer, ours: Buffer, theirs: Buffer): ThreeWayMerge {
  const lines = new Map<string, number>(), byId: Buffer[] = [];
  const ids = (content: Buffer) => splitLines(content).map(line => {
    const key = line.toString('latin1');
    let id = lines.get(key);
    if (id === undefined) { id = byId.push(line); lines.set(key, id); }
    return id;
  });
  const baseLines = ids(base), oursLines = ids(ours), theirsLines = ids(theirs);
  const oursHunks = myersHunks(baseLines, oursLines, 0), theirsHunks = myersHunks(baseLines, theirsLines, 0);
  if (!oursHunks || !theirsHunks) return { clean: false, content: null };
  const tagged = [...oursHunks.map(hunk => ({ ...hunk, side: 0 as const })), ...theirsHunks.map(hunk => ({ ...hunk, side: 1 as const }))].sort((x, y) => x.aStart - y.aStart || x.aLen - y.aLen);
  const out: number[] = [];
  let baseAt = 0, conflict = false;
  for (let index = 0; index < tagged.length && !conflict;) {
    const first = tagged[index];
    let regionEnd = first.aStart + first.aLen, next = index + 1;
    const region = [first];
    while (next < tagged.length && tagged[next].aStart <= regionEnd) { regionEnd = Math.max(regionEnd, tagged[next].aStart + tagged[next].aLen); region.push(tagged[next]); next++; }
    while (baseAt < first.aStart) out.push(baseLines[baseAt++]);
    const spans = (side: 0 | 1, lines: number[]) => {
      const own = region.filter(hunk => hunk.side === side), from = own[0], to = own[own.length - 1];
      return lines.slice(from.bStart - (from.aStart - first.aStart), to.bStart + to.bLen + (regionEnd - (to.aStart + to.aLen)));
    };
    const only = (side: 0 | 1, lines: number[]) => { for (const hunk of region) out.push(...lines.slice(hunk.bStart, hunk.bStart + hunk.bLen)); };
    if (region.every(hunk => hunk.side === 0)) only(0, oursLines);
    else if (region.every(hunk => hunk.side === 1)) only(1, theirsLines);
    else {
      const baseRegion = baseLines.slice(first.aStart, regionEnd), oursRegion = spans(0, oursLines), theirsRegion = spans(1, theirsLines);
      if (sameLines(oursRegion, theirsRegion) || sameLines(baseRegion, theirsRegion)) out.push(...oursRegion);
      else if (sameLines(baseRegion, oursRegion)) out.push(...theirsRegion);
      else conflict = true;
    }
    baseAt = regionEnd;
    index = next;
  }
  if (conflict) return { clean: false, content: null };
  while (baseAt < baseLines.length) out.push(baseLines[baseAt++]);
  return { clean: true, content: Buffer.concat(out.map(id => byId[id - 1])) };
}

/**
 * Delivered work items whose observed diff covers the path. A pull request the provider reports
 * merged shipped its files whether or not its delivery is recorded yet.
 */
export function shippedBy(path: string, all: Work[]): string[] {
  return all.filter(item => ((item.stage === 'done' && !item.closure) || !!item.observation?.merged) && (item.observation?.files ?? []).includes(path)).map(item => item.key);
}

/**
 * GY-744. An open candidate in the head's history that git shows already landed: its head, or its
 * pull request's merge commit, is an ancestor of the base branch tip. The owning item's recorded
 * state lags a merge made outside the queue, so the landing check (model/landing-check.ts)
 * asks git before naming any candidate unlanded; such a peer is neither `foreign` nor `carried`,
 * none of its files is read as a revert, and its merge is reconciled at once (engine.ts).
 */
export interface LandedCandidate { key: string; pr: number; head: string; mergeSha: string | null }
declare module './model/landing-check.js' {
  interface LandingCheck {
    /** The open candidates in this head's history that git shows already on the base branch tip (GY-744). */
    landed?: LandedCandidate[];
  }
}
