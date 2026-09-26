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
 * rewriting shipped work. Deleting one is still a deletion.
 */
export type ScopeKind = 'in-scope' | 'new' | 'generated' | 'matches-base' | 'already-absent' | 'reverted' | 'rewritten' | 'deleted' | 'renamed' | 'binary' | 'unverified';
export interface ScopeFinding { path: string; kind: ScopeKind; refused: boolean; detail: string }

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
    } else if (file.baseSha === file.sha) add(file.path, 'matches-base', 'identical to the base branch tip');
    else if (file.binary) add(file.path, 'binary', 'binary or oversized content differs from the base branch tip');
    else if (file.additions === 0 && file.deletions > 0) add(file.path, 'reverted', `removes ${file.deletions} line${file.deletions === 1 ? '' : 's'} that the base branch holds and adds nothing`);
    else add(file.path, 'rewritten', `differs from the base branch tip (+${file.additions} −${file.deletions})`);
  }
  return findings;
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
export type CarriedSubject = { id?: string; candidate?: Work['candidate']; queueHistory?: Work['queueHistory'] };
export function carriedItems(work: CarriedSubject, observation: Pick<Observation, 'landing'>, all: Work[]): Work[] {
  const candidate = work.candidate;
  const predicted = candidate ? [...(work.queueHistory ?? [])].reverse().find(entry => entry.event === 'predicted' && entry.tip === candidate.sha) : undefined;
  const departed = (predicted?.predecessors ?? []).filter(key => {
    const item = all.find(entry => entry.key === key);
    return !item?.queue || item.queue.sequence > predicted!.sequence;
  });
  const keys = new Set([...departed, ...(observation.landing?.foreign ?? []).map(entry => entry.key)]);
  return all.filter(item => keys.has(item.key) && item.id !== work.id && item.stage !== 'done' && !item.observation?.merged);
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
  const planned = work.plannedFiles ?? [], found: LandingRegression[] = [], carried = carriedItems(work, observation, all);
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
    const shipped = shippedBy(finding.path, all);
    const ahead = shipped.length ? [] : all.filter(item => item.id !== work.id && item.stage !== 'done' && !!item.candidate
      && (inPlannedScope(item.plannedFiles ?? [], finding.path) || (item.observation?.files ?? []).includes(finding.path))).map(item => item.key);
    found.push({ base: landing.base, path: finding.path, owners: [...shipped, ...ahead], adverse: finding.kind !== 'unverified',
      text: `${finding.path}: ${finding.detail.replaceAll('the base branch tip', 'that commit').replaceAll('the base branch', 'that commit')} (${shipped.length ? `shipped by ${shipped.join(', ')}` : ahead.length ? `owned by ${ahead.join(', ')}, ahead of it and not yet landed` : 'no delivered work item claims this path'})` });
  }
  for (const carried of landing.carried ?? []) {
    const owner = `${carried.key}, unlanded pull request #${carried.pr} at ${carried.head.slice(0, 12)}`;
    for (const file of carried.dropped) found.push({ base: landing.base, path: file.path, owners: [carried.key], adverse: true,
      text: `${file.path}: this head carries ${carried.key}'s commits but not this change — ${file.detail}; merging it would record ${carried.key} merged without it (owned by ${owner})` });
    if (carried.unverified) found.push({ base: landing.base, path: '*', owners: [carried.key], adverse: false,
      text: `this head carries ${carried.key}'s commits and not every file of theirs could be compared (owned by ${owner})` });
  }
  return found;
}

/**
 * Every reported regression of a queued tip, against its bound base and where it would land, as
 * the merge queue's ejection names them. A file the observation could not compare is not a
 * reported conclusion: it holds the build gate and ejects nothing.
 */
export function queuedRegressions(work: Pick<Work, 'id' | 'plannedFiles'>, observation: Pick<Observation, 'scopeFiles' | 'landing' | 'candidate'>, all: Work[], generated: readonly string[] = generatedFiles): { base: string; text: string }[] {
  const bound = classifyScope(work.plannedFiles ?? [], observation.scopeFiles ?? [], generated).filter(finding => finding.refused && finding.kind !== 'unverified')
    .map(finding => ({ base: observation.candidate.baseSha, text: describeRefusal(finding, all) }));
  return [...bound, ...landingRegressions(work, observation, all, generated).filter(entry => entry.adverse).map(entry => ({ base: entry.base, text: entry.text }))];
}

/**
 * Build-gate reasons for the observed candidate. An observation that never compared the diff
 * against the base branch tip proves nothing about scope and is refused until a fresh one does.
 */
export function regressionRefusals(work: Pick<Work, 'key' | 'plannedFiles'> & CarriedSubject, observation: Pick<Observation, 'scopeFiles' | 'landing'>, all: Work[], generated: readonly string[] = generatedFiles): string[] {
  if (!observation.scopeFiles) return ['Candidate diff has not been compared against the base branch tip; a fresh GitHub observation is required'];
  const carried = carriedItems(work, observation, all);
  const findings = classifyScope(work.plannedFiles ?? [], observation.scopeFiles, generated).filter(finding => finding.refused);
  const refused = findings.filter(finding => !carriedBy(finding.path, carried, all).length);
  // The same judgement where the candidate would land: the base it is bound to is held while its
  // head is unchanged, so what the base gained since is only visible against the landing commit.
  const landings = landingRegressions({ id: work.id ?? '', plannedFiles: work.plannedFiles, candidate: work.candidate, queueHistory: work.queueHistory }, observation, all, generated);
  const landing = landings.filter(entry => !entry.carried?.length);
  // Files another item's unlanded commits put on this head (GY-568) are named with that item and
  // sent to no worker: one refusal, which waits for the control plane's restore of the branch.
  const foreign = [...findings.filter(finding => carriedBy(finding.path, carried, all).length).map(finding => ({ owners: carriedBy(finding.path, carried, all), text: `${finding.path}: ${finding.detail} (carried from ${carriedBy(finding.path, carried, all).join(', ')})` })),
    ...landings.filter(entry => entry.carried?.length).map(entry => ({ owners: entry.carried!, text: entry.text }))];
  const owners = [...new Set(foreign.flatMap(entry => entry.owners))];
  return [...(foreign.length ? [`Carried from another item's tip: ${foreign.length} file${foreign.length === 1 ? '' : 's'} the candidate would change belong${foreign.length === 1 ? 's' : ''} to ${owners.join(', ')}, whose unlanded commits this head carries (${foreign.slice(0, carriedNamed).map(entry => entry.text).join('; ')}${foreign.length > carriedNamed ? `; and ${foreign.length - carriedNamed} more` : ''}); they are not this change's, so no worker is asked to revert them: the control plane restores the branch to the item's own reviewed head`] : []),
  ...(refused.length ? [`Candidate changes ${refused.length} file${refused.length === 1 ? '' : 's'} outside its planned files that must match the base branch byte-for-byte; run graphyard sync ${work.key}, restore each file from origin/<base>, and push again`,
    ...refused.map(finding => `Out-of-scope regression: ${describeRefusal(finding, all)}`)] : []),
  ...(landing.length ? [`Landing the candidate on ${landing[0].base.slice(0, 12)}, the commit it would merge onto, would revert ${landing.length} file${landing.length === 1 ? '' : 's'} outside its planned files; run graphyard sync ${work.key}, restore each file as its owner shipped it, and push again`,
    ...landing.map(entry => `Landing regression: ${entry.text}`)] : [])];
}
