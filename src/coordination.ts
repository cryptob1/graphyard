import type { Work } from './model.js';

export interface IntegrationJob { work_id: string; available_at: string; locked_until: string | null; error: string | null }
export interface Diagnostic { kind: string; message: string; next: string }
export function resourceConflicts(work: Work, all: Work[], now: number) {
  return all.filter(w => w.id !== work.id && w.stage !== 'done' && w.lease && Date.parse(w.lease.expiresAt) > now)
    .flatMap(w => (work.exclusiveResources ?? []).filter(r => w.exclusiveResources?.includes(r)).map(resource => ({ resource, key: w.key })));
}

// Deliberately bounded scope syntax: exact paths or directory prefixes ending /, /*, /**.
// Unsupported glob expressions are not interpreted as semantic dependency knowledge.
function scope(value: string) {
  const path = value.replace(/^\.\//, '');
  const prefix = path.endsWith('/') || /\/\*{1,2}$/.test(path);
  return { path: prefix ? path.replace(/\*+$/, '') : path, prefix };
}
function overlaps(a: string, b: string) {
  const left = scope(a), right = scope(b);
  return left.path === right.path || left.prefix && right.path.startsWith(left.path) || right.prefix && left.path.startsWith(right.path);
}
export function fileConflicts(work: Work, all: Work[]) {
  if (work.stage === 'done') return [];
  const paths = [...new Set([...work.plannedFiles, ...(work.observation?.files ?? [])])];
  return all.filter(w => w.id !== work.id && w.stage !== 'done' && (w.lease || w.submission || w.ready))
    .flatMap(w => {
      const theirs = [...new Set([...w.plannedFiles, ...(w.observation?.files ?? [])])];
      const matches = paths.filter(path => theirs.some(other => overlaps(path, other)));
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
  if (work.ready && !owns && (!work.submission || work.reworkRequested)) {
    add(work.lastAssignment ? 'unowned-after-assignment' : 'unclaimed', work.lastAssignment ? 'Previous assignment no longer has authority' : 'No worker has claimed this item', 'Check dependencies and resources, then claim a fresh epoch and workspace.');
  }
  if (owns && !work.workspaces.some(w => w.epoch === work.lease!.epoch)) add('workspace-missing', 'Owner has not registered this attempt’s workspace', 'Run worktree or register before starting implementation.');
  for (const r of resourceConflicts(work, all, now)) add('resource-busy', `${r.resource} is reserved by ${r.key}`, 'Wait for the owner to release its lease; do not use the resource concurrently.');
  const job = jobs.find(j => j.work_id === work.id);
  if (job?.error) add('integration-error', job.error, `Automatic retry is scheduled at ${job.available_at}; inspect integration configuration if failures persist.`);
  if (work.submission && !work.observation) add('unobserved', 'Submitted PR has not been observed for the current requirements', 'Check the GitHub connection and reconciliation job; missing observation is not success.');
  if (work.submission && work.observation && now - Date.parse(work.observation.at) >= 120000) add('stale-observation', 'GitHub observation is older than two minutes', 'Restore provider connectivity; the merge gate requires a fresh observation.');
  if (work.submission && job && !job.error && Date.parse(job.available_at) < now - 120000 && (!job.locked_until || Date.parse(job.locked_until) <= now)) add('reconciliation-stalled', 'Integration work is overdue and has no active processor', 'Check that the Graphyard server and its reconciliation loop are running.');
  for (const violation of work.violations) add('violation', violation, 'An operator must investigate; do not bypass the gate.');
  const first = work.gates.find(g => !g.passed);
  if (work.submission && first) for (const reason of first.reasons) add(`gate-${first.name}`, reason, `Satisfy the ${first.name} gate; new observations and evidence trigger reevaluation.`);
  return result;
}

export function proofPreview(work: Work) {
  return work.criteria.flatMap(ac => ac.proofs.map(proof => {
    const pin = work.scenarioRequirements.find(s => s.proof === proof);
    const matching = work.evidence.filter(e => e.proof === proof && e.trusted && e.sha === work.candidate?.sha && e.baseSha === work.candidate?.baseSha && e.policyRevision === work.policyRevision && (!pin || e.scenarioRevision === pin.revision && e.environment === pin.environment));
    const evidence = matching.at(-1);
    const status = !evidence ? 'unmeasured' : evidence.executed < 1 || evidence.skipped > 0 ? 'incomplete' : evidence.result === 'fail' ? 'failed' : 'passed';
    return { criterion: ac.id, proof, status, scenario: pin, producer: evidence?.producer, evidenceId: evidence?.id };
  }));
}
