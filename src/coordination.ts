import { bootstrapObligations, currentEvidence, describeQueueBinding, evidenceBindsCandidate, grantsAuthorize, inheritedObligations, pathScope, pathScopeContains, pathScopesOverlap, type BootstrapObligation, type ProofAuthority, type Stage, type Work } from './model.js';
import { namedPaths } from './model/scope.js';
import { behindBaseHold } from './model/behind-base.js';
import { baseRefreshConflict, currentBaseRefreshCarry, pendingBaseRefresh } from './merge-queue.js';

export interface IntegrationJob { work_id: string; available_at: string; locked_until: string | null; error: string | null; held_until?: string | null; deferred_reason?: string | null; unobserved?: number }
export interface Diagnostic { kind: string; message: string; next: string }
export function resourceConflicts(work: Work, all: Work[], now: number) {
  return all.filter(w => w.id !== work.id && (w.containmentQuarantine || w.lease && Date.parse(w.lease.expiresAt) > now))
    .flatMap(w => (work.exclusiveResources ?? []).filter(r => w.exclusiveResources?.includes(r)).map(resource => ({ resource, key: w.key })));
}

/** The paths an item is known to touch: its planned scope plus the files its PR was observed to change. */
const touchedPaths = (work: Work) => [...new Set([...work.plannedFiles, ...(work.observation?.files ?? [])])];

export function fileConflicts(work: Work, all: Work[]) {
  if (work.stage === 'done') return [];
  const paths = touchedPaths(work);
  return all.filter(w => w.id !== work.id && w.stage !== 'done' && (w.lease || w.submission || w.ready))
    .flatMap(w => {
      const theirs = touchedPaths(w);
      const matches = paths.filter(path => theirs.some(other => pathScopesOverlap(path, other)));
      return matches.length ? [{ key: w.key, paths: matches }] : [];
    });
}

export interface OverlapAhead { key: string; stage: Stage; state: 'claimed' | 'submitted'; paths: string[]; theirs: string[] }
/** Claimed for dispatch purposes: a live lease, or a containment quarantine still holding the assignment. */
const claimedNow = (work: Work, now: number) => !!work.containmentQuarantine || !!work.lease && Date.parse(work.lease.expiresAt) > now;
/**
 * In flight: claimed, or submitted with its candidate standing — not sent back for rework. A
 * submitted item whose rework was requested and that nobody has claimed is a peer waiting for a
 * worker, ordered by `dispatchOrder`, like a ready item.
 */
export const inFlight = (work: Work, now: number) => work.stage !== 'done' && (claimedNow(work, now) || !!work.submission && !work.reworkRequested);
/**
 * The paths an item is judged on for overlap reporting. Once the item has a candidate, they are the
 * files that candidate actually changes — its observed diff — and not the scope it declared: a
 * declared scope says where a worker may write, a candidate says where it did. The declared scope
 * stands in only until a candidate is observed. `fileConflicts` deliberately differs: it is an
 * advisory "might touch the same area" warning and reads both.
 */
export function exclusionPaths(work: Work): string[] {
  const observed = work.observation?.files ?? [];
  return work.candidate && observed.length ? [...new Set(observed)] : [...new Set(work.plannedFiles)];
}
/**
 * The in-flight items `work` runs beside on the same files, for the record only: dispatch is
 * optimistic and planned-file overlap holds nothing. Serialising on overlap idled most of the
 * fleet (2026-09-24/25: ten workers idle behind items changing the same large files) to avoid a
 * conflict the merge queue and a sync round resolve anyway: whichever of two overlapping items
 * lands second is re-integrated by base refresh, or sent back for a sync on a real conflict.
 * `plannedFiles` stays the submission-time change-scope contract; only exclusive resources hold
 * dispatch (`resourceConflicts`).
 */
export function concurrentOverlap(work: Work, all: Work[], now: number): OverlapAhead[] {
  if (work.stage === 'done') return [];
  const mine = exclusionPaths(work);
  return all.filter(w => w.id !== work.id && inFlight(w, now)).flatMap(w => {
    const theirs = exclusionPaths(w);
    const paths = mine.filter(path => theirs.some(entry => pathScopesOverlap(path, entry)));
    if (!paths.length) return [];
    return [{ key: w.key, stage: w.stage, state: claimedNow(w, now) ? 'claimed' as const : 'submitted' as const, paths, theirs: theirs.filter(entry => mine.some(path => pathScopesOverlap(path, entry))) }];
  });
}

/** Ready to be offered a worker: released, unblocked, unclaimed, and not submitted unless rework was requested. */
export const dispatchable = (work: Work, now: number) => work.stage !== 'done' && work.ready && !work.blocker && !claimedNow(work, now) && (!work.submission || !!work.reworkRequested);

/** A directory scope at the repository root (`src/`, `docs/`, `tests/`, `/`): it overlaps almost everything. */
export const broadScope = (scope: string) => { const { path, prefix } = pathScope(scope); return prefix && path.split('/').filter(Boolean).length <= 1; };
export interface ScopeBreadth { files: number; directories: number; broad: string[]; highConflict: boolean }
/**
 * How much of the repository a planned scope can reach, without a tree to count files in: exact
 * files, directory scopes, and the root-level directories that touch nearly every other item.
 */
export function scopeBreadth(plannedFiles: string[]): ScopeBreadth {
  const broad = plannedFiles.filter(broadScope);
  const directories = plannedFiles.filter(scope => pathScope(scope).prefix).length;
  return { files: plannedFiles.length - directories, directories, broad, highConflict: broad.length > 0 };
}
export interface BroadScopeRefusal { scope: string; narrower: string[]; reason: string }
/**
 * Why a planned scope is refused where planned files are set, one entry per root-level directory
 * claim, with the narrower paths it should name: the paths under that directory the item's own
 * text (title, description, criteria) names. `plannedFiles` is the change-scope contract a
 * submission is checked against: a root-level directory claim lets the item rewrite almost anything
 * under that root unchecked, and dispatch it ahead of smaller items less often. An exception is
 * recorded explicitly, never introduced unnoticed.
 */
export function broadScopeRefusals(plannedFiles: string[], text: string[] = []): BroadScopeRefusal[] {
  const named = [...new Set(text.flatMap(namedPaths))];
  return scopeBreadth(plannedFiles).broad.map(scope => {
    const narrower = named.filter(path => path !== scope && !broadScope(path) && pathScopeContains(scope, path) && !plannedFiles.includes(path));
    const instead = narrower.length ? `name ${narrower.join(', ')} instead` : `name the files under ${scope} this item changes instead`;
    return { scope, narrower, reason: `${scope} is a root-level directory scope: the change-scope check then admits any file under ${scope}, so a submission is held to almost nothing there — ${instead}` };
  });
}
/**
 * Smallest scope first among ready items of the same operator priority: fewest root-level
 * directories, then fewest directories, then fewest files, then the older item. A small item that
 * lands early is one fewer re-integration for everything it would otherwise have waited behind.
 */
export function dispatchOrder(a: Work, b: Work) {
  const left = scopeBreadth(a.plannedFiles), right = scopeBreadth(b.plannedFiles);
  return a.priority - b.priority || left.broad.length - right.broad.length || left.directories - right.directories || left.files - right.files || Date.parse(a.createdAt) - Date.parse(b.createdAt);
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
  // A job rescheduled three times in a row without saving an observation is the GY-506 deadlock
  // shape: the record says what each reschedule answered and where the queue is stuck because of it.
  const unobserved = job?.unobserved ?? 0;
  if (work.submission && unobserved >= 3) add('observation-starved', `${work.key}'s observation job has finished ${unobserved} times in a row without saving an observation${job!.error ? `; last refusal: ${job!.error}` : ''}${job!.deferred_reason ? `; last reschedule: ${job!.deferred_reason}` : ''}`,
    'The merge queue cannot advance behind an item nothing observes. Read the recorded reasons: a task-changed retry names what keeps rewriting the item, a budget deferral names its reset; if no reason is recorded the job loop is failing before the observation.');
  else if (held) add('integration-held', job!.error ?? 'Integration work is held on a GitHub App permission', `Held rather than retried: accept the App permission and the preflight that sees the installation change releases it, or it re-checks once at ${job!.held_until}.`);
  else if (job?.error) add('integration-error', job.error, `Automatic retry is scheduled at ${job.available_at}; inspect integration configuration if failures persist.`);
  if (work.submission && !work.observation) add('unobserved', 'Submitted PR has not been observed for the current requirements', 'Check the GitHub connection and reconciliation job; missing observation is not success.');
  if (work.submission && work.observation && now - Date.parse(work.observation.at) >= 120000) add('stale-observation', 'GitHub observation is older than two minutes', 'Restore provider connectivity; the merge gate requires a fresh observation.');
  if (work.submission && job && !job.error && Date.parse(job.available_at) < now - 120000 && (!job.locked_until || Date.parse(job.locked_until) <= now)) add('reconciliation-stalled', 'Integration work is overdue and has no active processor', 'Check that the Graphyard server and its reconciliation loop are running.');
  for (const ac of work.criteria) if (ac.bootstrap) add('bootstrap-deferred', `${ac.id} runs in bootstrap mode: ${ac.proofs.join(' + ')} is deferred because this change introduces the harness (${ac.bootstrap.reason})`,
    `Declared by ${ac.bootstrap.declaredBy} at ${ac.bootstrap.declaredAt}. Review, CI and every other criterion still gate this item; the deferred proof stays owed on ${ac.bootstrap.contractPaths.join(', ')}.`);
  for (const obligation of inheritedObligations(work, all)) add('bootstrap-obligation', `${obligation.proof} is inherited from ${obligation.key} ${obligation.criterionId} because this item plans to touch ${obligation.contractPaths.join(', ')}`,
    'Produce trusted passing evidence for this proof; a bootstrap deferral cannot be renewed by the change that inherits it.');
  for (const proof of work.proofGaps ?? []) add('proof-authority-gap', `No principal is authorized to produce ${proof}`, 'Grant the proof name to a producer principal with `graphyard grants grant`; the acceptance gate cannot be satisfied until someone can produce it.');
  const refreshing = pendingBaseRefresh(work), baseConflict = baseRefreshConflict(work);
  if (baseConflict) add('base-conflict', baseConflict, `Graphyard cannot bring this head onto the base branch itself. Resolve the conflict on the pull-request branch and push; nothing carries across the resolution, so the item takes a fresh review and fresh proofs.`);
  else if (refreshing) add('base-behind', `Candidate ${work.candidate?.sha.slice(0, 12)} does not contain the base branch tip ${refreshing.baseTip.slice(0, 12)}; it stays bound to ${refreshing.boundBase.slice(0, 12)} while the control plane brings it onto the new tip`,
    'Nothing to run: the reconciliation job merges the base into this branch and decides what the review and each proof carry. No sync, no rework round, and no review or proof round is requested for the move.');
  // Behind but mergeable is not a wait: review and proofs are requested for the head as it stands
  // and the merge queue integrates it with the base before merging (GY-191). Only a head that does
  // not merge cleanly is withheld, and that one needs a sync.
  else if (work.submission && behindBaseHold(work)) add('base-behind', `Candidate ${work.candidate?.sha.slice(0, 12)} does not contain the base branch tip ${work.observation?.baseTip?.slice(0, 12) ?? ''} and GitHub does not report it mergeable`,
    `No review is requested for it until it merges cleanly: the loop requests a sync rework for ${work.key}, or run graphyard sync ${work.key} and push.`);
  // What the control plane's last base refresh kept and what it re-required, each with its reason.
  const refreshCarry = currentBaseRefreshCarry(work);
  if (refreshCarry) {
    const head = refreshCarry.to.sha.slice(0, 12);
    for (const entry of [{ what: 'Approval', carried: refreshCarry.approval.carried, reason: refreshCarry.approval.reason }, ...refreshCarry.evidence.map(entry => ({ what: `Proof ${entry.proof}`, carried: entry.carried, reason: entry.reason }))]) {
      if (entry.carried) add('base-refresh-carried', `${entry.what} carried onto refreshed head ${head}: ${entry.reason}`, 'No fresh review or proof round is required for it.');
      else add('base-refresh-required', `${entry.what} is required afresh for refreshed head ${head}: ${entry.reason}`, entry.what === 'Approval' ? `Request an independent review of ${head}.` : `Produce trusted evidence for ${head}.`);
    }
  }
  // Per queued item: which bindings were carried across the Graphyard-authored tip or a
  // tree-identical base advance, and which must be produced afresh, each with its reason.
  const binding = describeQueueBinding(work, all, new Date(now));
  if (binding) {
    const tip = binding.tip.slice(0, 12);
    if (binding.base.carriedTo) add('queue-base-carried', `Bound base ${binding.base.sha.slice(0, 12)} carried to tree-identical base branch tip ${binding.base.carriedTo.sha.slice(0, 12)} (tree ${binding.base.tree.slice(0, 12)})`, 'Nothing is republished; the published tip lands its tested tree.');
    for (const entry of [{ what: 'Approval', ...binding.approval }, ...binding.evidence.map(entry => ({ what: `Proof ${entry.proof}`, ...entry }))]) {
      if (entry.state === 'carried') add('queue-binding-carried', `${entry.what} carried to tip ${tip}: ${entry.reason}`, 'No fresh review or proof round is required for it.');
      else if (entry.state === 'required') add('queue-binding-required', `${entry.what} is required afresh for tip ${tip}: ${entry.reason}`, entry.what === 'Approval' ? `Request an independent review of ${tip}.` : `Produce trusted evidence for ${tip}.`);
    }
  }
  for (const violation of work.violations) add('violation', violation, 'An operator must investigate; do not bypass the gate.');
  const first = work.gates.find(g => !g.passed);
  if (work.submission && first) for (const reason of first.reasons) add(`gate-${first.name}`, reason, `Satisfy the ${first.name} gate; new observations and evidence trigger reevaluation.`);
  return result;
}

export function proofPreview(work: Work, all: Work[] = []) {
  const measure = (criterion: string, proof: string, deferred?: BootstrapObligation, inherited?: BootstrapObligation) => {
    const pin = work.scenarioRequirements.find(s => s.proof === proof);
    const evidence = currentEvidence(work, proof);
    const revoked = !evidence && work.evidence.some(e => e.proof === proof && e.trusted && !!e.revocation && evidenceBindsCandidate(work, e) && e.policyRevision === work.policyRevision);
    const status = deferred ? 'deferred' : revoked ? 'revoked'
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
