// Read-only enforcement inspection supporting the manual:github-enforcement proof.
// It observes GitHub and Graphyard; it never submits evidence, merges or changes protection.
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CHECK_NAME = 'Graphyard / merge';

// `now` must be server time read after every re-read below, so a report cannot call an
// observation fresh that Graphyard would already refuse as stale by the time it prints.
export function evaluateEnforcement({ repository, baseBranch, appId, protection, rulesets = [], pull, checkRuns, work, now,
  recheck = { work, pull, protection, checkRuns } }) {
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
  // Newest run first; a run published by the App the context is bound to wins over a foreign same-name run.
  const latestRun = (runs, context, preferredAppId) => {
    const named = (runs ?? []).filter(run => run.name === context)
      .sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')));
    return named.find(run => run.app?.id === preferredAppId) ?? named[0] ?? null;
  };
  const published = latestRun(checkRuns, CHECK_NAME, appId);
  const currentPublished = latestRun(recheck.checkRuns, CHECK_NAME, appId);
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
  // Every context branch protection requires — not only the Graphyard check — must still be
  // passing at re-read time, and must still match the run set observed during collection.
  const requiredContexts = [...new Set([CHECK_NAME,
    ...required.map(entry => entry.context).filter(Boolean),
    ...(recheck.protection?.required_status_checks?.checks ?? []).map(entry => entry.context).filter(Boolean)])];
  const contextRuns = (runs, context) => (runs ?? []).filter(run => run.name === context)
    .map(run => ({ id: run.id ?? null, appId: run.app?.id ?? null, status: run.status ?? null, conclusion: run.conclusion ?? null, startedAt: run.started_at ?? null }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const changedContexts = requiredContexts.filter(context =>
    JSON.stringify(contextRuns(checkRuns, context)) !== JSON.stringify(contextRuns(recheck.checkRuns, context)));
  const requiredCheckFindings = required.filter(entry => entry.context && entry.context !== CHECK_NAME).flatMap(entry => {
    const run = latestRun(recheck.checkRuns ?? checkRuns, entry.context, entry.app_id ?? undefined);
    if (!run) return [`required check ${entry.context} has not been published on head ${pull.head?.sha ?? 'unknown'}`];
    if (run.status !== 'completed' || run.conclusion !== 'success') return [`required check ${entry.context} reports ${run.status === 'completed' ? run.conclusion : run.status}`];
    if (entry.app_id != null && run.app?.id !== entry.app_id) return [`required check ${entry.context} was published by App ${run.app?.id ?? 'unknown'} rather than the required App ${entry.app_id}`];
    return [];
  });
  const recheckFindings = [
    ...(recheck.work?.revision !== work.revision ? [`work revision changed from ${work.revision ?? 'missing'} to ${recheck.work?.revision ?? 'missing'} during inspection`] : []),
    ...(recheck.work?.candidate?.sha !== candidate?.sha ? [`candidate head changed from ${candidate?.sha ?? 'missing'} to ${recheck.work?.candidate?.sha ?? 'missing'} during inspection`] : []),
    ...(recheck.work?.candidate?.baseSha !== candidate?.baseSha ? [`candidate base changed from ${candidate?.baseSha ?? 'missing'} to ${recheck.work?.candidate?.baseSha ?? 'missing'} during inspection`] : []),
    ...(recheck.pull?.head?.sha !== pull.head?.sha ? [`pull request head changed from ${pull.head?.sha ?? 'missing'} to ${recheck.pull?.head?.sha ?? 'missing'} during inspection`] : []),
    ...(recheck.pull?.base?.sha !== pull.base?.sha ? [`pull request base changed from ${pull.base?.sha ?? 'missing'} to ${recheck.pull?.base?.sha ?? 'missing'} during inspection`] : []),
    ...(recheck.pull?.base?.ref !== pull.base?.ref ? [`pull request base ref changed from ${pull.base?.ref ?? 'missing'} to ${recheck.pull?.base?.ref ?? 'missing'} during inspection`] : []),
    ...(recheck.pull?.state !== pull.state ? [`pull request state changed from ${pull.state ?? 'missing'} to ${recheck.pull?.state ?? 'missing'} during inspection`] : []),
    ...(recheck.pull?.draft !== pull.draft ? [`pull request draft changed from ${pull.draft ?? 'missing'} to ${recheck.pull?.draft ?? 'missing'} during inspection`] : []),
    ...(recheck.pull?.merged !== pull.merged ? [`pull request merged changed from ${pull.merged ?? 'missing'} to ${recheck.pull?.merged ?? 'missing'} during inspection`] : []),
    ...(recheck.pull?.mergeable !== pull.mergeable ? [`pull request mergeable changed from ${pull.mergeable ?? 'missing'} to ${recheck.pull?.mergeable ?? 'missing'} during inspection`] : []),
    ...(recheck.pull?.mergeable_state !== pull.mergeable_state ? [`pull request mergeable state changed from ${pull.mergeable_state ?? 'missing'} to ${recheck.pull?.mergeable_state ?? 'missing'} during inspection`] : []),
    ...(JSON.stringify(protection) !== JSON.stringify(recheck.protection) ? ['managed branch protection changed during inspection'] : []),
    ...changedContexts.map(context => `${context} check state changed during inspection`),
    ...(!changedContexts.includes(CHECK_NAME) && JSON.stringify(published) !== JSON.stringify(currentPublished) ? [`${CHECK_NAME} check state changed during inspection`] : []),
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
    ...requiredCheckFindings,
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
    requiredChecks: { contexts: requiredContexts, findings: requiredCheckFindings },
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
    const serverStatus = () => JSON.parse(execFileSync(process.execPath, [cli, 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const work = JSON.parse(execFileSync(process.execPath, [cli, 'status', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const pr = Number(prArgument ?? work.submission?.pr ?? work.candidate?.pr);
    if (!Number.isSafeInteger(pr) || pr <= 0) throw new Error(`${key} has no submitted pull request; pass one explicitly to inspect it`);
    const status = serverStatus();
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
    // revision, exact commits and merge-controlling PR state observed above still
    // describe live state.
    const currentWork = JSON.parse(execFileSync(process.execPath, [cli, 'status', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const currentPull = gh(`repos/${repository}/pulls/${pr}`);
    const currentProtection = optional(`repos/${repository}/branches/${encodeURIComponent(baseBranch)}/protection`);
    const currentCheckRuns = ghPages(`repos/${repository}/commits/${currentPull.head.sha}/check-runs?filter=latest&per_page=100`, 'check_runs');
    // Freshness is judged against server time read after every collection and re-read above,
    // so collection time counts against the observation exactly as it does for Graphyard.
    const now = serverStatus().now;
    console.log(JSON.stringify(evaluateEnforcement({ repository, baseBranch, appId, protection, rulesets,
      pull, checkRuns, work, now,
      recheck: { work: currentWork, pull: currentPull, protection: currentProtection, checkRuns: currentCheckRuns } }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
