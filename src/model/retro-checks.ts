import { documentationGlobMatches } from './documentation-glob.js';
import { itemDocumentationPaths, type ItemDocumentation } from './scope.js';
import type { Observation, Work } from './work.js';
import type { RetroArtefact, RetroCheckRule } from './retro-synthesis.js';
import { classifyScope, inPlannedScope } from '../regression-guard.js';

// The rules an applied retro `mechanical-check` runs against a submission (GY-970, GY-1048).

/**
 * The changed paths a `planned-files` check names: what the build gate's own scope judgement
 * refuses (regression-guard.ts `classifyScope`, over the candidate's `scopeFiles` — so a new file,
 * a generated file or one identical to the base passes, as `graphyard sync` accepts it), less the
 * item's documentation paths matched as the documentation globs they are. An observation without
 * `scopeFiles` falls back to its changed paths matched with the same planned-scope and
 * documentation matchers.
 */
function outsidePlannedScope(work: RetroCheckWork, observation: RetroCheckObservation) {
  const documentation = itemDocumentationPaths(work);
  const documented = (path: string) => documentation.some(pattern => documentationGlobMatches(pattern, path));
  const plannedFiles = [...work.plannedFiles];
  const paths = observation.scopeFiles?.length
    ? classifyScope(plannedFiles, observation.scopeFiles).filter(finding => finding.refused).map(finding => finding.path)
    : observation.files.filter(path => !inPlannedScope(plannedFiles, path));
  return [...new Set(paths)].filter(path => !documented(path));
}

type RetroCheckWork = Pick<Work, 'plannedFiles'> & { documentation?: ItemDocumentation | null; policy?: { checks?: readonly string[] } | null };
type RetroCheckObservation = Pick<Observation, 'files' | 'conflicting' | 'checks' | 'scopeFiles'>;

/**
 * One applied check run against a submission's observed candidate: null when it passes, else why it
 * refuses. Each rule judges only the submitting item's own candidate: its scope, GitHub's computed
 * conflict for its pull request, and the checks its policy requires that reported a failure on its
 * head — a check still running, or one the item does not require, never refuses it.
 */
export function runRetroCheck(rule: RetroCheckRule, work: RetroCheckWork, observation: RetroCheckObservation): string | null {
  if (rule === 'planned-files') {
    const outside = outsidePlannedScope(work, observation);
    return outside.length ? `changes ${outside.length} file(s) outside plannedFiles: ${outside.slice(0, 10).join(', ')}${outside.length > 10 ? ', …' : ''}` : null;
  }
  if (rule === 'merges-onto-base') return observation.conflicting ? 'does not merge onto the current base without a conflict; run graphyard sync first' : null;
  const required = work.policy?.checks ? new Set(work.policy.checks) : null;
  const failed = observation.checks.filter(check => check.result === 'failure' && (!required || required.has(check.name)));
  return failed.length ? `has failed required checks on its head: ${[...new Set(failed.map(check => check.name))].join(', ')}` : null;
}

/**
 * The applied retro checks a submission fails. Every check registered by an approved
 * `mechanical-check` artefact runs against the candidate the control plane observed for the
 * submission; the submit command refuses one that fails any of them, so the refusal the check was
 * drafted to prevent is met by the worker at submission rather than by a gate later.
 */
export function retroCheckRefusals(work: RetroCheckWork, observation: RetroCheckObservation, artefacts: readonly RetroArtefact[]) {
  const refusals: string[] = [];
  for (const artefact of artefacts) {
    if (artefact.state !== 'applied' || artefact.kind !== 'mechanical-check' || !artefact.check?.rule) continue;
    const refusal = runRetroCheck(artefact.check.rule, work, observation);
    if (refusal) refusals.push(`retro check ${artefact.check.id} (closing ${artefact.pattern.label}): the candidate ${refusal}`);
  }
  return refusals;
}
