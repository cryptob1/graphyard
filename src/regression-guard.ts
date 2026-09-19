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

/** Delivered work items whose planned scope or observed diff covers the path. */
export function shippedBy(path: string, all: Work[]): string[] {
  return all.filter(item => item.stage === 'done' && (inPlannedScope(item.plannedFiles ?? [], path) || (item.observation?.files ?? []).includes(path))).map(item => item.key);
}

export function describeRefusal(finding: ScopeFinding, all: Work[]) {
  const shipped = shippedBy(finding.path, all);
  return `${finding.path}: ${finding.detail} (${shipped.length ? `shipped by ${shipped.join(', ')}` : 'no delivered work item claims this path'})`;
}

/**
 * Build-gate reasons for the observed candidate. An observation that never compared the diff
 * against the base branch tip proves nothing about scope and is refused until a fresh one does.
 */
export function regressionRefusals(work: Pick<Work, 'key' | 'plannedFiles'>, observation: Pick<Observation, 'scopeFiles'>, all: Work[], generated: readonly string[] = generatedFiles): string[] {
  if (!observation.scopeFiles) return ['Candidate diff has not been compared against the base branch tip; a fresh GitHub observation is required'];
  const refused = classifyScope(work.plannedFiles ?? [], observation.scopeFiles, generated).filter(finding => finding.refused);
  if (!refused.length) return [];
  return [`Candidate changes ${refused.length} file${refused.length === 1 ? '' : 's'} outside its planned files that must match the base branch byte-for-byte; run graphyard sync ${work.key}, restore each file from origin/<base>, and push again`,
    ...refused.map(finding => `Out-of-scope regression: ${describeRefusal(finding, all)}`)];
}
