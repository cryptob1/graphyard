// Read-only enforcement inspection supporting the manual:github-enforcement proof.
// It observes GitHub and Graphyard; it never submits evidence, merges or changes protection.
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CHECK_NAME = 'Graphyard / merge';

export function evaluateEnforcement({ repository, baseBranch, appId, protection, rulesets = [], pull, checkRuns, work, now, recheck = { work, pull } }) {
  const requireNativeReview = !!work.policy?.review && (work.policy?.reviewProvider ?? 'github') !== 'codex';
  const required = protection?.required_status_checks?.checks ?? [];
  const bound = required.find(c => c.context === CHECK_NAME) ?? null;
  const review = protection?.required_pull_request_reviews ?? null;
  const protectionFindings = [];
  if (!protection) protectionFindings.push('Branch protection is unreadable; the verifier refuses without it');
  else {
    if (!bound) protectionFindings.push(`Required status checks do not include ${CHECK_NAME}`);
    else if (bound.app_id !== appId) protectionFindings.push(`${CHECK_NAME} is bound to App ${bound.app_id ?? 'any producer'} rather than the dedicated App ${appId}`);
    if (!protection.required_status_checks?.strict) protectionFindings.push('Branches are not required to be up to date before merging (strict)');
    if (!protection.enforce_admins?.enabled) protectionFindings.push('Protection is not enforced for administrators');
    if (protection.allow_force_pushes?.enabled) protectionFindings.push('Force pushes are allowed on the managed base branch');
    if (protection.allow_deletions?.enabled) protectionFindings.push('Deletion of the managed base branch is allowed');
    if (requireNativeReview && !(review?.required_approving_review_count >= 1 && review?.dismiss_stale_reviews && review?.require_last_push_approval))
      protectionFindings.push('This work still selects native GitHub review, which requires a nonzero approval count, stale-review dismissal and last-push approval');
  }
  const namedRuns = checkRuns.filter(run => run.name === CHECK_NAME).sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')));
  const published = namedRuns.find(run => run.app?.id === appId) ?? namedRuns[0] ?? null;
  const linked = published?.pull_requests?.map(p => p.number) ?? [];
  const gates = (work.gates ?? []).map(gate => ({ name: gate.name, passed: !!gate.passed, reasons: gate.reasons ?? [] }));
  const candidate = work.candidate ?? null;
  const observationAge = Date.parse(now ?? '') - Date.parse(work.observation?.at ?? '');
  const candidateFindings = [
    ...(!candidate ? ['work has no current candidate'] : []),
    ...(candidate && work.submission?.pr !== candidate.pr ? [`submitted PR ${work.submission?.pr ?? 'missing'} does not match candidate PR ${candidate.pr}`] : []),
    ...(candidate && pull.number !== candidate.pr ? [`inspected PR ${pull.number} does not match candidate PR ${candidate.pr}`] : []),
    ...(candidate && pull.head?.sha !== candidate.sha ? [`pull request head ${pull.head?.sha ?? 'missing'} does not match candidate head ${candidate.sha}`] : []),
    ...(candidate && pull.base?.sha !== candidate.baseSha ? [`pull request base ${pull.base?.sha ?? 'missing'} does not match candidate base ${candidate.baseSha}`] : []),
    ...(pull.base?.ref !== baseBranch ? [`pull request targets ${pull.base?.ref ?? 'missing'}, not the managed base branch ${baseBranch}`] : []),
  ];
  const recheckFindings = [
    ...(recheck.work?.revision !== work.revision ? [`work revision changed from ${work.revision ?? 'missing'} to ${recheck.work?.revision ?? 'missing'} during inspection`] : []),
    ...(recheck.work?.candidate?.sha !== candidate?.sha ? [`candidate head changed from ${candidate?.sha ?? 'missing'} to ${recheck.work?.candidate?.sha ?? 'missing'} during inspection`] : []),
    ...(recheck.work?.candidate?.baseSha !== candidate?.baseSha ? [`candidate base changed from ${candidate?.baseSha ?? 'missing'} to ${recheck.work?.candidate?.baseSha ?? 'missing'} during inspection`] : []),
    ...(recheck.pull?.head?.sha !== pull.head?.sha ? [`pull request head changed from ${pull.head?.sha ?? 'missing'} to ${recheck.pull?.head?.sha ?? 'missing'} during inspection`] : []),
    ...(recheck.pull?.base?.sha !== pull.base?.sha ? [`pull request base changed from ${pull.base?.sha ?? 'missing'} to ${recheck.pull?.base?.sha ?? 'missing'} during inspection`] : []),
  ];
  const observationFinding = !Number.isFinite(observationAge) || observationAge < 0 || observationAge >= 120_000
    ? 'Graphyard observation is missing, future-dated, or older than two minutes' : null;
  const blockingMergeStates = new Set(['blocked', 'behind', 'dirty', 'draft', 'unknown']);
  const refusals = [
    ...gates.filter(gate => !gate.passed).flatMap(gate => gate.reasons.map(reason => `${gate.name} gate: ${reason}`)),
    ...protectionFindings.map(finding => `branch protection: ${finding}`),
    ...candidateFindings.map(finding => `candidate: ${finding}`),
    ...recheckFindings.map(finding => `recheck: ${finding}`),
    ...(observationFinding ? [`observation: ${observationFinding}`] : []),
    ...(!published ? [`${CHECK_NAME} has not been published on head ${pull.head?.sha ?? 'unknown'}`]
      : published.conclusion !== 'success' ? [`${CHECK_NAME} reports ${published.status === 'completed' ? published.conclusion : published.status}`]
      : published.app?.id !== appId ? [`${CHECK_NAME} on this head was published by App ${published.app?.id ?? 'unknown'}, not the dedicated App ${appId}`] : []),
    ...(pull.merged ? ['pull request is already merged'] : []),
    ...(pull.state !== 'open' ? [`pull request state is ${pull.state}`] : pull.draft ? ['pull request is a draft'] : pull.mergeable !== true ? [`GitHub reports mergeable=${pull.mergeable} (${pull.mergeable_state ?? 'unknown'})`]
      : blockingMergeStates.has(pull.mergeable_state ?? 'unknown') ? [`GitHub reports blocking merge state ${pull.mergeable_state ?? 'unknown'}`] : []),
  ];
  const notes = [
    ...(!rulesets ? ['Repository rulesets could not be read; inspect them manually for alternate merge paths']
      : rulesets.length ? [`Active rulesets are not read by the merge verifier; inspect ${rulesets.map(r => r.name).join(', ')} for alternate merge paths`] : []),
    ...(published?.conclusion === 'success' && linked.length && !linked.includes(pull.number) ? [`The successful check on this head is linked to PR ${linked.join(', ')}; check runs are commit-scoped and can be inherited`] : []),
  ];
  return {
    repository, baseBranch, work: { key: work.key, stage: work.stage, policyRevision: work.policyRevision, reviewProvider: work.policy?.reviewProvider ?? 'github' },
    pull: { number: pull.number, head: pull.head?.sha ?? null, base: pull.base?.sha ?? null, state: pull.state, draft: !!pull.draft, merged: !!pull.merged, mergeable: pull.mergeable, mergeableState: pull.mergeable_state ?? null },
    app: { dedicated: appId, publishedCheck: published ? { appId: published.app?.id ?? null, appSlug: published.app?.slug ?? null, status: published.status, conclusion: published.conclusion, linkedPullRequests: linked } : null },
    protection: { strict: !!protection?.required_status_checks?.strict, enforceAdmins: !!protection?.enforce_admins?.enabled, forcePushesAllowed: !!protection?.allow_force_pushes?.enabled, deletionsAllowed: !!protection?.allow_deletions?.enabled,
      checkBinding: bound ? { context: bound.context, appId: bound.app_id ?? null } : null, nativeReviewRequired: requireNativeReview, nativeReview: review ? { approvals: review.required_approving_review_count, dismissStale: !!review.dismiss_stale_reviews, lastPushApproval: !!review.require_last_push_approval } : null, findings: protectionFindings },
    gates, observation: { at: work.observation?.at ?? null, serverNow: now ?? null, fresh: !observationFinding }, revalidated: !recheckFindings.length, notes, verdict: refusals.length ? 'refused' : 'permitted', refusals,
    limits: ['This is an inspection report, not evidence. Only an operator may attest manual:github-enforcement.',
      'A permitted verdict describes this observation; Graphyard re-verifies the exact candidate immediately before any merge.'],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [key, prArgument] = process.argv.slice(2);
  try {
    if (!/^[A-Z][A-Z0-9]*-\d+$/.test(key ?? '')) throw new Error('Usage: node scripts/verify-enforcement.mjs GY-N [PR_NUMBER]');
    const cli = process.env.GRAPHYARD_CLI ?? fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
    const work = JSON.parse(execFileSync(process.execPath, [cli, 'status', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const pr = Number(prArgument ?? work.submission?.pr ?? work.candidate?.pr);
    if (!Number.isSafeInteger(pr) || pr <= 0) throw new Error(`${key} has no submitted pull request; pass one explicitly to inspect it`);
    const status = JSON.parse(execFileSync(process.execPath, [cli, 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const repository = status.repository, baseBranch = status.baseBranch ?? 'main', appId = status.githubAppId;
    if (!repository || !Number.isSafeInteger(appId)) throw new Error('The live server does not report a managed repository and dedicated App; connect the App first');
    const gh = path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const ghPages = (path, field) => JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
      .flatMap(page => page?.[field] ?? []);
    const pull = gh(`repos/${repository}/pulls/${pr}`);
    const optional = path => { try { return gh(path); } catch { return null; } };
    const protection = optional(`repos/${repository}/branches/${encodeURIComponent(baseBranch)}/protection`);
    const rulesets = optional(`repos/${repository}/rulesets`);
    const checkRuns = ghPages(`repos/${repository}/commits/${pull.head.sha}/check-runs?filter=latest&per_page=100`, 'check_runs');
    // Re-read both mutable snapshots last. A report may only say permitted when the
    // revision and exact commits observed above still describe live state.
    const currentWork = JSON.parse(execFileSync(process.execPath, [cli, 'status', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const currentPull = gh(`repos/${repository}/pulls/${pr}`);
    console.log(JSON.stringify(evaluateEnforcement({ repository, baseBranch, appId, protection, rulesets,
      pull, checkRuns, work, now: status.now, recheck: { work: currentWork, pull: currentPull } }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
