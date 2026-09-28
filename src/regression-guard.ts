import { configuredGeneratedFiles, isGeneratedFile } from './generated-files.js';
import { unrepairableRestore } from './merge-queue.js';
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
 * rewriting shipped work. Deleting one is still a deletion.
 */
export type ScopeKind = 'in-scope' | 'new' | 'generated' | 'matches-base' | 'already-absent' | 'reverted' | 'rewritten' | 'deleted' | 'renamed' | 'binary' | 'unverified';
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
  const add = (path: string, kind: ScopeKind, detail: string) => findings.push({ path, kind, refused: !['in-scope', 'new', 'generated', 'matches-base', 'already-absent'].includes(kind), detail });
  for (const file of files) {
    const movedFrom = file.previousPath && file.previousPath !== file.path ? file.previousPath : undefined;
    // A rename is judged at both ends: the old path leaves the head, the new path appears on it.
    if (movedFrom && file.status === 'renamed' && !inPlannedScope(plannedFiles, movedFrom)) {
      if (file.previousBaseSha === undefined) add(movedFrom, 'unverified', 'not compared against the base branch tip');
      else if (file.previousBaseSha !== null) add(movedFrom, 'renamed', `renamed to ${file.path}; the base branch still holds it at this path`);
    }
    if (inPlannedScope(plannedFiles, file.path)) { add(file.path, 'in-scope', 'inside the planned files'); continue; }
    if (file.status !== 'removed' && isGeneratedFile(generated, file.path)) { add(file.path, 'generated', 'generated file; regenerated from its sources and verified by CI, owned by no work item'); continue; }
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
    else add(file.path, 'rewritten', `differs from the base branch tip (+${file.additions} −${file.deletions})`);
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
 * GY-568. The unlanded items whose commits this head carries outside the queue's intent: the
 * entries a speculative tip equal to the candidate was published behind that have since left the
 * queue without landing (one still queued ahead is the queue's construction, reported as ahead of
 * it), and the open candidates the landing check found in the head's history. A file such an item covers (its planned scope or its observed diff) and no
 * delivery claims came from that item, not from this change, so it is attributed to it by name
 * and never read as the candidate reverting it: the control plane restores such a branch.
 */
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
export type CarriedSubject = { id?: string; candidate?: Work['candidate']; queueHistory?: Work['queueHistory']; baseRefresh?: Work['baseRefresh']; policyRevision?: number };
export function carriedItems(work: CarriedSubject, observation: Pick<Observation, 'landing'>, all: Work[]): Work[] {
  const candidate = work.candidate;
  const predicted = candidate ? [...(work.queueHistory ?? [])].reverse().find(entry => entry.event === 'predicted' && entry.tip === candidate.sha) : undefined;
  const departed = (predicted?.predecessors ?? []).filter(key => {
    const item = all.find(entry => entry.key === key);
    return !item?.queue || item.queue.sequence > predicted!.sequence;
  });
  const keys = new Set([...departed, ...(observation.landing?.foreign ?? []).map(entry => entry.key)]);
  const landed = landedKeys(observation);
  return all.filter(item => keys.has(item.key) && !landed.has(item.key) && item.id !== work.id && item.stage !== 'done' && !item.observation?.merged);
}
/** How many carried files a refusal names; the count covers every one. */
const carriedNamed = 10;
const carriedBy = (path: string, carried: Work[], all: Work[]) => !carried.length || shippedBy(path, all).length ? []
  : carried.filter(item => inPlannedScope(item.plannedFiles ?? [], path) || (item.observation?.files ?? []).includes(path)).map(item => item.key);

/**
 * The landing re-check (GY-97; see merge-queue.ts LandingCheck): what the candidate would revert
 * on the commit it would actually land on, as opposed to the base it is bound to. One entry per
 * file, naming the item that owns it. `adverse` is false for a file the observation could not
 * compare: that refuses the build gate like any uncompared file, and ejects nothing.
 */
export interface LandingRegression { base: string; path: string; owners: string[]; adverse: boolean; text: string; carried?: string[] }
export function landingRegressions(work: Pick<Work, 'id' | 'plannedFiles'> & CarriedSubject, observation: Pick<Observation, 'scopeFiles' | 'landing'>, all: Work[], generated: readonly string[] = generatedFiles): LandingRegression[] {
  const landing = observation.landing;
  if (!landing) return [];
  const planned = work.plannedFiles ?? [], found: LandingRegression[] = [], carried = carriedItems(work, observation, all), landed = landedKeys(observation);
  // A file the bound-base comparison already refuses is reported there, once.
  const reported = new Set(classifyScope(planned, observation.scopeFiles ?? [], generated).filter(finding => finding.refused).map(finding => finding.path));
  for (const finding of classifyScope(planned, landing.files ?? [], generated)) {
    if (!finding.refused || reported.has(finding.path)) continue;
    const from = carriedBy(finding.path, carried, all);
    if (from.length) {
      found.push({ base: landing.base, path: finding.path, owners: from, adverse: finding.kind !== 'unverified', carried: from,
        text: `${finding.path}: ${finding.detail.replaceAll('the base branch tip', 'that commit').replaceAll('the base branch', 'that commit')} (carried from ${from.join(', ')}, whose unlanded commits this head holds)` });
      continue;
    }
    // A predicted base holds entries that have not landed: the file belongs to the unlanded
    // candidate whose planned scope or observed diff covers it, when no delivery does.
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
 * Every refused conclusion a queued tip's tree shows, against its bound base and where it would
 * land, before any carried-items excusal. A file the observation could not compare is not a
 * reported conclusion and appears here never; this is what tells the queue a stale tip (GY-568)
 * holds unlanded work at all, so it leaves for its branch restore instead of being rebuilt over
 * files it still carries.
 */
export function staleTipRegressions(work: Pick<Work, 'id' | 'plannedFiles'> & CarriedSubject, observation: Pick<Observation, 'scopeFiles' | 'landing' | 'candidate'>, all: Work[], generated: readonly string[] = generatedFiles): { base: string; text: string }[] {
  return regressionsOf(work, observation, all, generated, () => false, () => false);
}

/**
 * Every reported regression of a queued tip, against its bound base and where it would land, as
 * the merge queue's ejection names them. A file the observation could not compare is not a
 * reported conclusion: it holds the build gate and ejects nothing. A file carried from another
 * item's unlanded commits on this head (GY-871) is excused by the same carried-items exclusion
 * `regressionRefusals` applies, so an entry that passed the build gate is never ejected over the
 * files it excused: the two checks agree on every out-of-plan file.
 */
export function queuedRegressions(work: Pick<Work, 'id' | 'plannedFiles'> & CarriedSubject, observation: Pick<Observation, 'scopeFiles' | 'landing' | 'candidate'>, all: Work[], generated: readonly string[] = generatedFiles): { base: string; text: string }[] {
  const carried = carriedItems(work, observation, all);
  return regressionsOf(work, observation, all, generated, path => !!carriedBy(path, carried, all).length, entry => !!entry.carried?.length);
}

function regressionsOf(work: Pick<Work, 'id' | 'plannedFiles'> & CarriedSubject, observation: Pick<Observation, 'scopeFiles' | 'landing' | 'candidate'>, all: Work[], generated: readonly string[], pathExcused: (path: string) => boolean, entryCarried: (entry: LandingRegression) => boolean): { base: string; text: string }[] {
  const bound = classifyScope(work.plannedFiles ?? [], observation.scopeFiles ?? [], generated).filter(finding => finding.refused && finding.kind !== 'unverified' && !pathExcused(finding.path))
    .map(finding => ({ base: observation.candidate.baseSha, text: describeRefusal(finding, all) }));
  return [...bound, ...landingRegressions(work, observation, all, generated).filter(entry => entry.adverse && !entryCarried(entry)).map(entry => ({ base: entry.base, text: entry.text }))];
}

/**
 * Build-gate reasons for the observed candidate. An observation that never compared the diff
 * against the base branch tip proves nothing about scope and is refused until a fresh one does.
 *
 * Files another item's unlanded commits put on this head are named with that item and answered by
 * the control plane's restore of the branch (GY-568). A restore that already ran and found no own
 * reviewed head under the foreign commits (`unrepairableRestore`, GY-638) leaves no restore to
 * promise, so the carried files are judged as any out-of-scope change instead: the refusals route
 * the item to rework rather than to the resync whose fresh observation would repeat them forever.
 */
export function regressionRefusals(work: Pick<Work, 'key' | 'plannedFiles'> & CarriedSubject, observation: Pick<Observation, 'scopeFiles' | 'landing'>, all: Work[], generated: readonly string[] = generatedFiles): string[] {
  if (!observation.scopeFiles) return ['Candidate diff has not been compared against the base branch tip; a fresh GitHub observation is required'];
  const unrepairable = unrepairableRestore(work);
  const carried = unrepairable ? [] : carriedItems(work, observation, all);
  const findings = classifyScope(work.plannedFiles ?? [], observation.scopeFiles, generated).filter(finding => finding.refused);
  // `carriedBy` scans every delivered item per call, so each finding's attribution is computed
  // once here and shared by the refused filter and the carried naming (GY-638).
  const attributed = new Map<string, string[]>();
  const carriedByPath = (path: string) => {
    let owners = attributed.get(path);
    if (!owners) attributed.set(path, owners = carriedBy(path, carried, all));
    return owners;
  };
  const refused = findings.filter(finding => !carriedByPath(finding.path).length);
  // The same judgement where the candidate would land: the base it is bound to is held while its
  // head is unchanged, so what the base gained since is only visible against the landing commit.
  const landings = landingRegressions({ id: work.id ?? '', plannedFiles: work.plannedFiles, candidate: work.candidate, queueHistory: work.queueHistory }, observation, all, generated);
  const landing = landings.filter(entry => unrepairable || !entry.carried?.length);
  // Files another item's unlanded commits put on this head (GY-568) are named with that item and
  // sent to no worker: one refusal, which waits for the control plane's restore of the branch.
  const foreign = unrepairable ? [] : [...findings.filter(finding => carriedByPath(finding.path).length).map(finding => {
    const from = carriedByPath(finding.path);
    return { owners: from, text: `${finding.path}: ${finding.detail} (carried from ${from.join(', ')})` };
  }),
    ...landings.filter(entry => entry.carried?.length).map(entry => ({ owners: entry.carried!, text: entry.text }))];
  const owners = [...new Set(foreign.flatMap(entry => entry.owners))];
  return [...(foreign.length ? [`Carried from another item's tip: ${foreign.length} file${foreign.length === 1 ? '' : 's'} the candidate would change belong${foreign.length === 1 ? 's' : ''} to ${owners.join(', ')}, whose unlanded commits this head carries (${foreign.slice(0, carriedNamed).map(entry => entry.text).join('; ')}${foreign.length > carriedNamed ? `; and ${foreign.length - carriedNamed} more` : ''}); they are not this change's, so no worker is asked to revert them: the control plane restores the branch to the item's own reviewed head`] : []),
  ...(refused.length ? [`Candidate changes ${refused.length} file${refused.length === 1 ? '' : 's'} outside its planned files that must match the base branch byte-for-byte; run graphyard sync ${work.key}, restore each file from origin/<base>, and push again`,
    ...refused.map(finding => `Out-of-scope regression: ${describeRefusal(finding, all)}`)] : []),
  ...(landing.length ? [`Landing the candidate on ${landing[0].base.slice(0, 12)}, the commit it would merge onto, would revert ${landing.length} file${landing.length === 1 ? '' : 's'} outside its planned files; run graphyard sync ${work.key}, restore each file as its owner shipped it, and push again`,
    ...landing.map(entry => `Landing regression: ${entry.text}`)] : [])];
}
