import { bootstrapObligations, currentEvidence, grantsAuthorize, inheritedObligations, pathScopesOverlap, type BootstrapObligation, type ProofAuthority, type Work } from './model.js';

export interface IntegrationJob { work_id: string; available_at: string; locked_until: string | null; error: string | null; held_until?: string | null }
export interface Diagnostic { kind: string; message: string; next: string }
export function resourceConflicts(work: Work, all: Work[], now: number) {
  return all.filter(w => w.id !== work.id && (w.containmentQuarantine || w.lease && Date.parse(w.lease.expiresAt) > now))
    .flatMap(w => (work.exclusiveResources ?? []).filter(r => w.exclusiveResources?.includes(r)).map(resource => ({ resource, key: w.key })));
}

export function fileConflicts(work: Work, all: Work[]) {
  if (work.stage === 'done') return [];
  const paths = [...new Set([...work.plannedFiles, ...(work.observation?.files ?? [])])];
  return all.filter(w => w.id !== work.id && w.stage !== 'done' && (w.lease || w.submission || w.ready))
    .flatMap(w => {
      const theirs = [...new Set([...w.plannedFiles, ...(w.observation?.files ?? [])])];
      const matches = paths.filter(path => theirs.some(other => pathScopesOverlap(path, other)));
      return matches.length ? [{ key: w.key, paths: matches }] : [];
    });
}

export function diagnose(work: Work, all: Work[], now: number, jobs: IntegrationJob[] = []): Diagnostic[] {
  if (work.stage === 'done') return [];
  const result: Diagnostic[] = [];
  const add = (kind: string, message: string, next: string) => result.push({ kind, message, next });
  if (!work.ready) add('backlog', 'Not released for implementation', 'An operator can release this item when its requirements are ready.');
  if (work.blocker) add('blocked', work.blocker, 'Resolve the blocker; the current worker or an operator can clear it.');
  for (const dep of work.dependencies) {
    const parent = all.find(w => w.id === dep);
    if (parent?.stage !== 'done') add('dependency', `Waiting for ${parent?.key ?? dep}`, 'Complete the prerequisite before claiming this item.');
  }
  const owns = work.lease && Date.parse(work.lease.expiresAt) > now;
  if (work.containmentQuarantine) {
    add('containment-quarantine', `Worker containment from epoch ${work.containmentQuarantine.epoch} has not been verified stopped`, 'The supervising parent must verify shutdown and settle with its capability; if that capability is unavailable, an operator must independently confirm the worker stopped and use the stopped-worker recovery command.');
  } else if (work.ready && !owns && (!work.submission || work.reworkRequested)) {
    add(work.lastAssignment ? 'unowned-after-assignment' : 'unclaimed', work.lastAssignment ? 'Previous assignment no longer has authority' : 'No worker has claimed this item', 'Check dependencies and resources, then claim a fresh epoch and workspace.');
  }
  if (owns && !work.workspaces.some(w => w.epoch === work.lease!.epoch)) add('workspace-missing', 'Owner has not registered this attempt’s workspace', 'Run worktree or register before starting implementation.');
  for (const r of resourceConflicts(work, all, now)) add('resource-busy', `${r.resource} is reserved by ${r.key}`, 'Wait for the owner to release its lease; do not use the resource concurrently.');
  const job = jobs.find(j => j.work_id === work.id);
  const held = !!job?.held_until && Date.parse(job.held_until) > now;
  if (held) add('integration-held', job!.error ?? 'Integration work is held on a GitHub App permission', `Held rather than retried: accept the App permission and the preflight that sees the installation change releases it, or it re-checks once at ${job!.held_until}.`);
  else if (job?.error) add('integration-error', job.error, `Automatic retry is scheduled at ${job.available_at}; inspect integration configuration if failures persist.`);
  if (work.submission && !work.observation) add('unobserved', 'Submitted PR has not been observed for the current requirements', 'Check the GitHub connection and reconciliation job; missing observation is not success.');
  if (work.submission && work.observation && now - Date.parse(work.observation.at) >= 120000) add('stale-observation', 'GitHub observation is older than two minutes', 'Restore provider connectivity; the merge gate requires a fresh observation.');
  if (work.submission && job && !job.error && Date.parse(job.available_at) < now - 120000 && (!job.locked_until || Date.parse(job.locked_until) <= now)) add('reconciliation-stalled', 'Integration work is overdue and has no active processor', 'Check that the Graphyard server and its reconciliation loop are running.');
  for (const ac of work.criteria) if (ac.bootstrap) add('bootstrap-deferred', `${ac.id} runs in bootstrap mode: ${ac.proofs.join(' + ')} is deferred because this change introduces the harness (${ac.bootstrap.reason})`,
    `Declared by ${ac.bootstrap.declaredBy} at ${ac.bootstrap.declaredAt}. Review, CI and every other criterion still gate this item; the deferred proof stays owed on ${ac.bootstrap.contractPaths.join(', ')}.`);
  for (const obligation of inheritedObligations(work, all)) add('bootstrap-obligation', `${obligation.proof} is inherited from ${obligation.key} ${obligation.criterionId} because this item plans to touch ${obligation.contractPaths.join(', ')}`,
    'Produce trusted passing evidence for this proof; a bootstrap deferral cannot be renewed by the change that inherits it.');
  for (const proof of work.proofGaps ?? []) add('proof-authority-gap', `No principal is authorized to produce ${proof}`, 'Grant the proof name to a producer principal with `graphyard grants grant`; the acceptance gate cannot be satisfied until someone can produce it.');
  for (const violation of work.violations) add('violation', violation, 'An operator must investigate; do not bypass the gate.');
  const first = work.gates.find(g => !g.passed);
  if (work.submission && first) for (const reason of first.reasons) add(`gate-${first.name}`, reason, `Satisfy the ${first.name} gate; new observations and evidence trigger reevaluation.`);
  return result;
}

export function proofPreview(work: Work, all: Work[] = []) {
  const measure = (criterion: string, proof: string, deferred?: BootstrapObligation, inherited?: BootstrapObligation) => {
    const pin = work.scenarioRequirements.find(s => s.proof === proof);
    const evidence = currentEvidence(work, proof);
    const status = deferred ? 'deferred'
      : !evidence ? 'unmeasured' : evidence.executed < 1 || evidence.skipped > 0 ? 'incomplete' : evidence.result === 'fail' ? 'failed' : 'passed';
    return { criterion, proof, status, scenario: pin, producer: evidence?.producer, evidenceId: evidence?.id, bootstrap: deferred ?? inherited };
  };
  const own = work.criteria.flatMap(ac => ac.proofs.map(proof => measure(ac.id, proof,
    ac.bootstrap ? { key: work.key, workId: work.id, criterionId: ac.id, proof, ...ac.bootstrap } : undefined)));
  return [...own, ...inheritedObligations(work, all).map(obligation => measure(`${obligation.key} ${obligation.criterionId}`, obligation.proof, undefined, obligation))];
}

/** Every deferred proof still owed across the repository, for operator review. */
export function obligationLedger(all: Work[]) {
  return bootstrapObligations(all).map(obligation => ({ ...obligation,
    inheritedBy: all.filter(item => inheritedObligations(item, all).some(other => other.proof === obligation.proof && other.workId === obligation.workId)).map(item => item.key) }));
}

/**
 * Which principal, if any, is currently authorized to produce each required proof.
 * A proof with no authorized producer is a dispatch gap: nobody can ever satisfy it.
 */
export function proofAuthorization(work: Work, authorities: readonly ProofAuthority[], all: Work[] = []) {
  const required = [...new Set([...work.criteria.flatMap(ac => ac.proofs), ...inheritedObligations(work, all).map(obligation => obligation.proof)])];
  return required.map(proof => ({ proof, producers: authorities.filter(a => grantsAuthorize(a.patterns, proof)).map(a => a.principalId) }));
}
export const proofGaps = (work: Work, authorities: readonly ProofAuthority[]) =>
  proofAuthorization(work, authorities).filter(entry => !entry.producers.length).map(entry => entry.proof);
