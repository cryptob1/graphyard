import type { AgentReview, ReviewRequest, ReviewerApp, ReviewerProfile } from './model.js';

interface Source { pages(path: string): Promise<any[]>; request(path: string): Promise<any> }
export const verdictDecisions = ['approved', 'changes-requested', 'usage-limit'] as const;
export type VerdictDecision = typeof verdictDecisions[number];
// One machine-readable line is the whole accepted protocol: a runtime-independent
// contract every reviewer profile can emit, correlated to one dispatched request.
const verdictPattern = /<!--\s*graphyard-verdict:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+head:([a-f0-9]{40})\s+verdict:([a-z][a-z-]{0,39})\s*-->/g;
function parseVerdict(body: unknown): { marker: string; sha: string; decision: string } | null {
  if (typeof body !== 'string') return null;
  const matches = [...body.matchAll(verdictPattern)];
  // Two verdict lines in one comment make the decision ambiguous; unknown formats refuse.
  if (matches.length !== 1) return null;
  return { marker: matches[0][1], sha: matches[0][2], decision: matches[0][3] };
}

/**
 * Identity-bound adapter for any reviewer runtime. Approval requires a verdict that the
 * registered reviewer GitHub App posted for Graphyard's own recorded request, for this exact
 * head, after that request, with no newer findings or activity from the same identity.
 * The control-plane App and the pull request author can never supply it.
 */
export async function observeAgentReview(source: Source, pr: number, head: string, reviews: any[], authorId: number,
  request: ReviewRequest | null | undefined, base: string, policyRevision: number, graphyardAppId: number,
  profile: ReviewerProfile, app: ReviewerApp, now = Date.now()): Promise<AgentReview> {
  const refuse = (reason: string, extra: Partial<AgentReview> = {}): AgentReview =>
    ({ provider: 'agent', sha: head, approved: false, reason, profile: profile.name, reviewerApp: app.id, ...extra });
  const exhaust = (exhaustion: 'usage-limit' | 'timeout', reason: string) => refuse(reason, { exhausted: true, exhaustion });
  if (app.id !== profile.reviewerApp || app.runtime !== profile.runtime) return refuse(`Reviewer profile ${profile.name} does not match its registered App identity`);
  if (app.appId === graphyardAppId) return refuse('The Graphyard control-plane App cannot review its own candidates');
  if (!Number.isSafeInteger(authorId) || authorId === app.botUserId) return refuse('Reviewer identity must be independent of the pull request author');
  if (!request || request.provider !== 'agent' || request.profile !== profile.name || request.reviewerApp !== app.id || !request.marker
    || request.sha !== head || request.baseSha !== base || request.policyRevision !== policyRevision)
    return refuse('Graphyard must dispatch a review to this profile bound to this candidate and policy');
  const requestedAt = Date.parse(request.createdAt);
  if (!Number.isFinite(requestedAt)) return refuse('The recorded Graphyard review request has an invalid timestamp');
  const comments = await source.pages(`/issues/${pr}/comments`);
  const trigger = comments.find(c => c.id === request.commentId);
  const authenticTrigger = (row: any) => !!row && row.user?.type === 'Bot' && row.performed_via_github_app?.id === graphyardAppId
    && row.body === request.body && row.created_at === request.createdAt && row.updated_at === row.created_at;
  if (!authenticTrigger(trigger)) return refuse('The recorded Graphyard review request is missing or edited');
  const fromReviewer = (row: any) => row?.user?.id === app.botUserId && row.user?.type === 'Bot' && row.performed_via_github_app?.id === app.appId;
  // Reviews filed by the reviewer identity are findings/output, never the approval channel.
  const findings = (rows: any[]) => rows.some(row => fromReviewer(row) && Date.parse(row.submitted_at) >= requestedAt);
  const after = comments.filter(row => fromReviewer(row) && Date.parse(row.created_at) > requestedAt);
  if (after.some(row => typeof row.body === 'string' && row.body.includes('graphyard-verdict:') && !parseVerdict(row.body)))
    return refuse(`Reviewer profile ${profile.name} posted an unsupported verdict format; inspect the provider output and request a fresh review`);
  const mine = after.filter(row => parseVerdict(row.body)?.marker === request.marker)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const decisionOf = (row: any) => parseVerdict(row.body)!.decision;
  if (mine.some(row => !(verdictDecisions as readonly string[]).includes(decisionOf(row))))
    return refuse(`Reviewer profile ${profile.name} posted an unsupported verdict decision; inspect the provider output and request a fresh review`);
  // Quota exhaustion is a provider capacity fact, so repeated usage-limit replies still fail over.
  if (mine.length && mine.every(row => decisionOf(row) === 'usage-limit'))
    return exhaust('usage-limit', `Reviewer profile ${profile.name} reported exhausted usage limits for this candidate`);
  if (!mine.length) return now - requestedAt > profile.timeoutSeconds * 1000
    ? exhaust('timeout', `Reviewer profile ${profile.name} posted no verdict within ${profile.timeoutSeconds} seconds of the dispatched request`)
    : refuse(`Waiting for reviewer profile ${profile.name} to post a verdict through its registered App`);
  if (mine.length !== 1) return refuse(`Reviewer profile ${profile.name} posted conflicting verdicts for this request; request a fresh review`);
  const verdict = mine[0], decision = decisionOf(verdict) as VerdictDecision;
  const verdictAt = Date.parse(verdict.created_at);
  // The one refusal that is a verdict: the registered identity answered this request and asked for
  // changes. It is marked as one only when the verdict names this exact head; every other refusal
  // here — not dispatched, waiting, conflicting, edited — leaves `verdict` unset.
  if (decision === 'changes-requested') return refuse(`Reviewer profile ${profile.name} requested changes; address the findings and request a fresh review`,
    parseVerdict(verdict.body)!.sha === head
      ? { verdict: 'changes-requested', verdictId: verdict.id, requestId: trigger.id, ...(Number.isFinite(verdictAt) ? { completedAt: new Date(verdictAt).toISOString() } : {}) } : {});
  if (parseVerdict(verdict.body)!.sha !== head) return refuse(`Reviewer profile ${profile.name} reviewed a different commit`);
  if (!Number.isFinite(verdictAt) || verdictAt > now + 5000 || verdict.updated_at !== verdict.created_at)
    return refuse(`Reviewer profile ${profile.name} posted an edited verdict or an invalid completion time`);
  const newerActivity = (rows: any[]) => rows.some(row => fromReviewer(row) && row.id !== verdict.id && Date.parse(row.updated_at ?? row.created_at) >= verdictAt);
  if (findings(reviews) || newerActivity(comments))
    return refuse(`Reviewer profile ${profile.name} has findings or newer review activity; request a fresh review`);
  const [verdictAgain, triggerAgain, commentsAgain, reviewsAgain] = await Promise.all([
    source.request(`/issues/comments/${verdict.id}`), source.request(`/issues/comments/${trigger.id}`),
    source.pages(`/issues/${pr}/comments`), source.pages(`/pulls/${pr}/reviews`),
  ]);
  const unchangedVerdict = (row: any) => !!row && row.id === verdict.id && fromReviewer(row) && row.body === verdict.body
    && row.created_at === verdict.created_at && row.updated_at === verdict.updated_at;
  // Added, removed or edited reviewer comments all invalidate the snapshot.
  const snapshot = (rows: any[]) => JSON.stringify(rows.filter(fromReviewer)
    .map(row => [row.id, row.user?.id, row.performed_via_github_app?.id, row.body, row.created_at, row.updated_at])
    .sort((a, b) => Number(a[0]) - Number(b[0])));
  if (!unchangedVerdict(verdictAgain) || !authenticTrigger(triggerAgain)
    || !unchangedVerdict(commentsAgain.find(row => row.id === verdict.id)) || !authenticTrigger(commentsAgain.find(row => row.id === trigger.id))
    || snapshot(commentsAgain) !== snapshot(comments) || findings(reviewsAgain))
    return refuse(`Reviewer profile ${profile.name} verdict changed while collecting approval; retry`);
  return { provider: 'agent', sha: head, approved: true, profile: profile.name, reviewerApp: app.id,
    reason: `Registered reviewer App ${app.id} (runtime ${app.runtime}) approved this commit for profile ${profile.name}`,
    verdictId: verdict.id, requestId: trigger.id, completedAt: new Date(verdictAt).toISOString() };
}
