import type { AgentReview, ReviewRequest } from './model.js';

// Stable GitHub identities of OpenAI's hosted connector, not configurable display names.
export const CODEX_APP_ID = 1144995;
export const CODEX_USER_ID = 199175422;
const isCodex = (item: any) => item.user?.id === CODEX_USER_ID && item.user?.type === 'Bot';
interface Source { pages(path: string): Promise<any[]>; request(path: string): Promise<any> }
/** Conservative adapter for the observed hosted Codex review protocol. Unknown formats refuse. */
export async function observeCodex(source: Source, pr: number, head: string, reviews: any[], author: string, request: ReviewRequest | null | undefined, base: string, policyRevision: number, graphyardAppId: number): Promise<AgentReview> {
  const refuse = (reason: string): AgentReview => ({ provider: 'codex', sha: head, approved: false, reason });
  if (!request || request.sha !== head || request.baseSha !== base || request.policyRevision !== policyRevision) return refuse('Graphyard must dispatch a review bound to this candidate and policy');
  if (author === 'chatgpt-codex-connector[bot]') return refuse('Reviewer must be independent of the PR author');
  const comments = await source.pages(`/issues/${pr}/comments`);
  const summaries = comments.filter(c => isCodex(c) && c.performed_via_github_app?.id === CODEX_APP_ID && c.body?.startsWith('<!-- codex-pull-request-review-summary -->'));
  if (summaries.length !== 1) return refuse('Exactly one authenticated Codex review summary is required');
  const summary = summaries[0];
  const rows = summary.body.split('\n').filter((line: string) => /^\| 📝 \*\*Code Review\*\* \|/.test(line));
  if (rows.length !== 1) return refuse('Codex summary format is unrecognized');
  const row = /^\| 📝 \*\*Code Review\*\* \| ✅ \*\*Completed\*\* <relative-time datetime="([^"]+)">[^<]+<\/relative-time> \| `([a-f0-9]{7,40})` \| Manual request \|$/.exec(rows[0]);
  if (!row) return refuse('Codex has not completed a supported manual review; request @codex review');
  const completedAt = Date.parse(row[1]);
  if (!Number.isFinite(completedAt) || completedAt > Date.now() + 5000) return refuse('Invalid Codex completion timestamp');
  const resolved = await source.request(`/commits/${row[2]}`);
  if (resolved.sha !== head) return refuse('Codex reviewed a different commit');
  const trigger = comments.find(c => c.id === request.commentId);
  if (!trigger || trigger.performed_via_github_app?.id !== graphyardAppId || trigger.user?.type !== 'Bot' || trigger.body !== request.body
    || trigger.created_at !== request.createdAt || trigger.created_at !== trigger.updated_at
    || !Number.isFinite(Date.parse(trigger.created_at)) || Date.parse(trigger.created_at) > completedAt) return refuse('The recorded Graphyard review request is missing, edited, or not yet completed');
  // A new clean run supersedes earlier findings; resolving threads alone never does.
  if (reviews.some(r => isCodex(r) && Date.parse(r.submitted_at) >= Date.parse(trigger.created_at))) return refuse('Codex posted review findings/output for this request; fix them and request a fresh clean review');
  const reactions = await source.pages(`/issues/comments/${trigger.id}/reactions`);
  const clean = reactions.filter(r => isCodex(r) && r.content === '+1' && Date.parse(r.created_at) >= Math.floor(completedAt / 1000) * 1000);
  if (clean.length !== 1 || reactions.some(r => isCodex(r) && r.content === 'eyes')) return refuse('A fresh Codex clean-review reaction is required; review may still be running or have findings');
  // Reread mutable summary/request/reaction state before accepting a snapshot.
  const [summaryAgain, triggerAgain, reactionsAgain, reviewsAgain] = await Promise.all([
    source.request(`/issues/comments/${summary.id}`), source.request(`/issues/comments/${trigger.id}`),
    source.pages(`/issues/comments/${trigger.id}/reactions`), source.pages(`/pulls/${pr}/reviews`),
  ]);
  if (!isCodex(summaryAgain) || summaryAgain.performed_via_github_app?.id !== CODEX_APP_ID || summaryAgain.body !== summary.body || summaryAgain.updated_at !== summary.updated_at
    || triggerAgain.performed_via_github_app?.id !== graphyardAppId || triggerAgain.created_at !== trigger.created_at || triggerAgain.body !== trigger.body || triggerAgain.updated_at !== trigger.updated_at
    || !reactionsAgain.some(r => r.id === clean[0].id && isCodex(r) && r.content === '+1' && r.created_at === clean[0].created_at)
    || reactionsAgain.some(r => isCodex(r) && r.content === 'eyes')
    || reviewsAgain.some(r => isCodex(r) && Date.parse(r.submitted_at) >= Date.parse(trigger.created_at))) return refuse('Codex review changed while collecting approval; retry');
  return { provider: 'codex', sha: head, approved: true, reason: 'Authenticated Codex review completed without findings', summaryId: summary.id, requestId: trigger.id, reactionId: clean[0].id, completedAt: new Date(completedAt).toISOString() };
}
