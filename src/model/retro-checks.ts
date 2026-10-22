import type { Observation } from './work.js';
import type { RetroArtefact, RetroCheckRule } from './retro-synthesis.js';

// The rules an applied retro `mechanical-check` runs against a submission (GY-970, GY-1048).

type RetroCheckWork = { policy?: { checks?: readonly string[] } | null };
type RetroCheckObservation = Pick<Observation, 'conflicting' | 'checks'>;

/**
 * One applied check run against a submission's observed candidate: null when it passes, else why it
 * refuses. Each rule judges only the submitting item's own candidate: GitHub's computed
 * conflict for its pull request, and the checks its policy requires that reported a failure on its
 * head — a check still running, or one the item does not require, never refuses it. An item with
 * no required-check list (absent or empty) requires none, so `checks-passed` never refuses it.
 */
export function runRetroCheck(rule: RetroCheckRule, work: RetroCheckWork, observation: RetroCheckObservation): string | null {
  if (rule === 'planned-files') return null;
  if (rule === 'merges-onto-base') return observation.conflicting ? 'does not merge onto the current base without a conflict; run graphyard sync first' : null;
  const required = new Set(work.policy?.checks ?? []);
  const failed = observation.checks.filter(check => check.result === 'failure' && required.has(check.name));
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
