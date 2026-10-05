import { configuredGeneratedFiles, isGeneratedFile } from './generated-files.js';
import { pathScopeContains, type Observation, type ScopeFile, type Work } from './model.js';

/**
 * Submit-time integration regression guard.
 *
 * A candidate may change what its work item planned, and it may add files nobody has shipped.
 * Every other file it touches must match the base branch tip byte for byte: a merge of the base
 * branch that re-resolves a file the worker does not own in favour of its branch silently
 * deletes code and tests that already merged, and only the file list tells the worker what to
 * restore. The classification is pure and shared by the control plane (provider-observed diff)
 * and by `graphyard sync` (local diff against `origin/<base>`). The one exception is the
 * enumerated set of generated files (see generated-files.ts): regenerated from their sources and
 * verified current by CI, they are owned by nobody, so a candidate that regenerates one is not
 * rewriting shipped work. Deleting one is still a deletion. The timing baseline is the other: a
 * change that writes only its own test files' lines there carries the implied companion verdict
 * (model/timing-companion.ts), read from both versions' contents by whoever compared the file.
 */
export type ScopeKind = 'in-scope' | 'new' | 'generated' | 'companion' | 'matches-base' | 'already-absent' | 'reverted' | 'rewritten' | 'deleted' | 'renamed' | 'binary' | 'unverified';
export interface ScopeFinding { path: string; kind: ScopeKind; refused: boolean; detail: string }

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

export const inPlannedScope = (plannedFiles: string[], path: string) => plannedFiles.some(scope => pathScopeContains(scope, path));

const generatedFiles = configuredGeneratedFiles();
export function classifyScope(plannedFiles: string[], files: ScopeFile[], generated: readonly string[] = generatedFiles): ScopeFinding[] {
  const findings: ScopeFinding[] = [];
  const add = (path: string, kind: ScopeKind, detail: string) => findings.push({ path, kind, refused: !['in-scope', 'new', 'generated', 'companion', 'matches-base', 'already-absent'].includes(kind), detail });
  for (const file of files) {
    const movedFrom = file.previousPath && file.previousPath !== file.path ? file.previousPath : undefined;
    // A rename is judged at both ends: the old path leaves the head, the new path appears on it.
    if (movedFrom && file.status === 'renamed' && !inPlannedScope(plannedFiles, movedFrom)) {
      if (file.previousBaseSha === undefined) add(movedFrom, 'unverified', 'not compared against the base branch tip');
      else if (file.previousBaseSha !== null) add(movedFrom, 'renamed', `renamed to ${file.path}; the base branch still holds it at this path`);
    }
    if (inPlannedScope(plannedFiles, file.path)) { add(file.path, 'in-scope', 'inside the planned files'); continue; }
    if (file.status !== 'removed' && isGeneratedFile(generated, file.path)) { add(file.path, 'generated', 'generated file; regenerated from its sources and verified by CI, owned by no work item'); continue; }
    // The timing baseline written only for this change's own test files is implied by them (GY-1023).
    if (file.status !== 'removed' && file.companion?.allowed && file.baseSha) { add(file.path, 'companion', file.companion.detail); continue; }
    if (file.status === 'removed') {
      if (file.baseSha === undefined) add(file.path, 'unverified', 'not compared against the base branch tip');
      else if (file.baseSha === null) add(file.path, 'already-absent', 'the base branch does not hold this file either');
      else add(file.path, 'deleted', 'deleted; the base branch still holds it');
      continue;
    }
    if (file.baseSha === undefined) add(file.path, 'unverified', 'not compared against the base branch tip');
    else if (file.baseSha === null) {
      if (['added', 'copied', 'renamed'].includes(file.status)) add(file.path, 'new', 'new file; the base branch has no file at this path');
      else add(file.path, 'reverted', 'restores a file the base branch removed');
    } else if (file.baseSha === (file.mergeSha ?? file.sha)) add(file.path, 'matches-base', file.mergeSha ? 'the three-way merge result is identical to the base branch tip' : 'identical to the base branch tip');
    else if (file.binary) add(file.path, 'binary', 'binary or oversized content differs from the base branch tip');
    else if (file.additions === 0 && file.deletions > 0) add(file.path, 'reverted', `removes ${file.deletions} line${file.deletions === 1 ? '' : 's'} that the base branch holds and adds nothing`);
    else add(file.path, 'rewritten', `differs from the base branch tip (+${file.additions} −${file.deletions})${file.companion ? `; ${file.companion.detail}` : ''}`);
  }
  return findings;
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
 * Delivered work items whose planned scope or observed diff covers the path. A pull request the
 * provider reports merged shipped its files whether or not its delivery is recorded yet.
 */
export function shippedBy(path: string, all: Work[]): string[] {
  return all.filter(item => ((item.stage === 'done' && !item.closure) || !!item.observation?.merged) && (inPlannedScope(item.plannedFiles ?? [], path) || (item.observation?.files ?? []).includes(path))).map(item => item.key);
}

export function describeRefusal(finding: ScopeFinding, all: Work[]) {
  const shipped = shippedBy(finding.path, all);
  return `${finding.path}: ${finding.detail} (${shipped.length ? `shipped by ${shipped.join(', ')}` : 'no delivered work item claims this path'})`;
}

/**
 * GY-744. An open candidate in the head's history that git shows already landed: its head, or its
 * pull request's merge commit, is an ancestor of the base branch tip. The owning item's recorded
 * state lags a merge made outside the queue, so the landing check (merge-queue.ts LandingCheck)
 * asks git before naming any candidate unlanded; such a peer is neither `foreign` nor `carried`,
 * none of its files is read as a revert, and its merge is reconciled at once (engine.ts).
 */
export interface LandedCandidate { key: string; pr: number; head: string; mergeSha: string | null }
declare module './merge-queue.js' {
  interface LandingCheck {
    /** The open candidates in this head's history that git shows already on the base branch tip (GY-744). */
    landed?: LandedCandidate[];
  }
}
/** Items git showed already on the base branch tip (GY-744), whatever their records say: never unlanded. */
const landedKeys = (observation: Pick<Observation, 'landing'>) => new Set((observation.landing?.landed ?? []).map(entry => entry.key));

/**
 * The landing re-check (GY-97; see merge-queue.ts LandingCheck): what the candidate would revert
 * on the commit it would actually land on, as opposed to the base it is bound to. One entry per
 * file, naming the item that owns it. `adverse` is false for a file the observation could not
 * compare: that refuses the build gate like any uncompared file.
 */
export interface LandingRegression { base: string; path: string; owners: string[]; adverse: boolean; text: string }
export function landingRegressions(work: Pick<Work, 'plannedFiles'> & { id?: string }, observation: Pick<Observation, 'scopeFiles' | 'landing'>, all: Work[], generated: readonly string[] = generatedFiles): LandingRegression[] {
  const landing = observation.landing;
  if (!landing) return [];
  const planned = work.plannedFiles ?? [], found: LandingRegression[] = [], landed = landedKeys(observation);
  // A file the bound-base comparison already refuses is reported there, once.
  const reported = new Set(classifyScope(planned, observation.scopeFiles ?? [], generated).filter(finding => finding.refused).map(finding => finding.path));
  for (const finding of classifyScope(planned, landing.files ?? [], generated)) {
    if (!finding.refused || reported.has(finding.path)) continue;
    // The file belongs to an unlanded candidate whose planned scope or observed diff covers it,
    // when no delivery does.
    const shipped = shippedBy(finding.path, all.map(item => landed.has(item.key) && item.observation ? { ...item, observation: { ...item.observation, merged: true } } : item));
    const ahead = shipped.length ? [] : all.filter(item => item.id !== work.id && item.stage !== 'done' && !landed.has(item.key) && !!item.candidate
      && (inPlannedScope(item.plannedFiles ?? [], finding.path) || (item.observation?.files ?? []).includes(finding.path))).map(item => item.key);
    found.push({ base: landing.base, path: finding.path, owners: [...shipped, ...ahead], adverse: finding.kind !== 'unverified',
      text: `${finding.path}: ${finding.detail.replaceAll('the base branch tip', 'that commit').replaceAll('the base branch', 'that commit')} (${shipped.length ? `shipped by ${shipped.join(', ')}` : ahead.length ? `owned by ${ahead.join(', ')}, ahead of it and not yet landed` : 'no delivered work item claims this path'})` });
  }
  for (const carried of landing.carried ?? []) {
    if (landed.has(carried.key)) continue;
    const owner = `${carried.key}, unlanded pull request #${carried.pr} at ${carried.head.slice(0, 12)}`;
    for (const file of carried.dropped) found.push({ base: landing.base, path: file.path, owners: [carried.key], adverse: true,
      text: `${file.path}: this head carries ${carried.key}'s commits but not this change — ${file.detail}; merging it would record ${carried.key} merged without it (owned by ${owner})` });
    if (carried.unverified) found.push({ base: landing.base, path: '*', owners: [carried.key], adverse: false,
      text: `this head carries ${carried.key}'s commits and not every file of theirs could be compared (owned by ${owner})` });
  }
  return found;
}

/**
 * Build-gate reasons for the observed candidate. An observation that never compared the diff
 * against the base branch tip proves nothing about scope and is refused until a fresh one does.
 */
export function regressionRefusals(work: Pick<Work, 'key' | 'plannedFiles'> & { id?: string }, observation: Pick<Observation, 'scopeFiles' | 'landing'>, all: Work[], generated: readonly string[] = generatedFiles): string[] {
  if (!observation.scopeFiles) return ['Candidate diff has not been compared against the base branch tip; a fresh GitHub observation is required'];
  const refused = classifyScope(work.plannedFiles ?? [], observation.scopeFiles, generated).filter(finding => finding.refused);
  // The same judgement where the candidate would land: the base it is bound to is held while its
  // head is unchanged, so what the base gained since is only visible against the landing commit.
  const landing = landingRegressions({ id: work.id ?? '', plannedFiles: work.plannedFiles }, observation, all, generated);
  return [...(refused.length ? [`Candidate changes ${refused.length} file${refused.length === 1 ? '' : 's'} outside its planned files that must match the base branch byte-for-byte; run graphyard sync ${work.key}, restore each file from origin/<base>, and push again`,
    ...refused.map(finding => `Out-of-scope regression: ${describeRefusal(finding, all)}`)] : []),
  ...(landing.length ? [`Landing the candidate on ${landing[0].base.slice(0, 12)}, the commit it would merge onto, would revert ${landing.length} file${landing.length === 1 ? '' : 's'} outside its planned files; run graphyard sync ${work.key}, restore each file as its owner shipped it, and push again`,
    ...landing.map(entry => `Landing regression: ${entry.text}`)] : [])];
}
