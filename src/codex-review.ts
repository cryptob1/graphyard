import type { AgentReview, ReviewRequest } from './model.js';

// Stable GitHub identities of OpenAI's hosted connector, not configurable display names.
export const CODEX_APP_ID = 1144995;
export const CODEX_USER_ID = 199175422;
const isCodex = (item: any) => item.user?.id === CODEX_USER_ID && item.user?.type === 'Bot';
interface Source { pages(path: string): Promise<any[]>; request(path: string): Promise<any> }
// Exact observed provider footer; arbitrary appended prose cannot be treated as approval.
const cleanFooter = "<details> <summary>ℹ️ About Codex in GitHub</summary> <br/> Codex has been enabled to automatically review pull requests in this repo. Reviews are triggered when you - Open a pull request for review - Mark a draft as ready - Comment \"@codex review\". If Codex has suggestions, it will comment; otherwise it will react with 👍. When you [sign up for Codex through ChatGPT](https://openai.com/codex), Codex can also answer questions or update the PR, like \"@codex address that feedback\". </details>";
const cleanCourtesies = new Set([
  '', ':+1:', ':tada:', 'what shall we delve into next?',
  'delightful', 'nice work', 'bravo', 'keep it up', 'well done', 'good job',
  'great work', 'great job', 'looks good', 'looking good', 'excellent', 'splendid',
  'wonderful', 'fantastic', 'awesome', 'nice', 'cheers', 'all good', 'all clear',
  'lgtm', 'onward', 'happy coding',
]);
function cleanCommit(body: unknown): string | null {
  if (typeof body !== 'string') return null;
  const match = /^Codex Review: Didn't find any major issues\.([^\r\n]*)\n\n\*\*Reviewed commit:\*\* `([a-f0-9]{7,40})`(?=\s|$)/.exec(body);
  if (!match || !cleanCourtesies.has(match[1].trim().replace(/[.!]+$/, '').toLowerCase())) return null;
  const tail = body.slice(match[0].length).trim().replace(/\s+/g, ' ');
  return !tail || tail === cleanFooter ? match[2] : null;
}
/** Conservative adapter for the observed hosted Codex review protocol. Unknown formats refuse. */
export async function observeCodex(source: Source, pr: number, head: string, reviews: any[], authorId: number, request: ReviewRequest | null | undefined, base: string, policyRevision: number, graphyardAppId: number): Promise<AgentReview> {
  const refuse = (reason: string): AgentReview => ({ provider: 'codex', sha: head, approved: false, reason });
  if (!request || request.sha !== head || request.baseSha !== base || request.policyRevision !== policyRevision) return refuse('Graphyard must dispatch a review bound to this candidate and policy');
  if (!Number.isSafeInteger(authorId) || authorId === CODEX_USER_ID) return refuse('Reviewer must be independent of the PR author');
  const comments = await source.pages(`/issues/${pr}/comments`);
  // Some hosted runs publish a signed clean-result comment while leaving the summary running.
  const results = comments.filter(c => isCodex(c) && c.performed_via_github_app?.id === CODEX_APP_ID && cleanCommit(c.body)
    && Date.parse(c.created_at) > Date.parse(request.createdAt)).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (results.length) {
    const result = results[0], completedAt = Date.parse(result.created_at);
    const trigger = comments.find(c => c.id === request.commentId);
    const authenticTrigger = (c: any) => c && c.user?.type === 'Bot' && c.performed_via_github_app?.id === graphyardAppId
      && c.body === request.body && c.created_at === request.createdAt && c.updated_at === c.created_at;
    if (!authenticTrigger(trigger) || !Number.isFinite(completedAt) || completedAt > Date.now() + 5000 || result.updated_at !== result.created_at)
      return refuse('Clean result or recorded request is edited, invalid, or missing');
    if ((await source.request(`/commits/${cleanCommit(result.body)!}`)).sha !== head) return refuse('Codex reviewed a different commit');
    const conflictingComments = (rows: any[]) => rows.some(c => isCodex(c) && c.id !== result.id
      && Date.parse(c.updated_at ?? c.created_at) >= completedAt);
    const findings = (rows: any[]) => rows.some(r => isCodex(r) && Date.parse(r.submitted_at) >= Date.parse(request.createdAt));
    const running = (rows: any[]) => rows.some(r => isCodex(r) && r.content === 'eyes');
    if (findings(reviews) || conflictingComments(comments)) return refuse('Codex has findings or newer review activity; request a fresh clean review');
    const [resultAgain, triggerAgain, commentsAgain, reviewsAgain, prReactions, requestReactions] = await Promise.all([
      source.request(`/issues/comments/${result.id}`), source.request(`/issues/comments/${trigger.id}`),
      source.pages(`/issues/${pr}/comments`), source.pages(`/pulls/${pr}/reviews`),
      source.pages(`/issues/${pr}/reactions`), source.pages(`/issues/comments/${trigger.id}/reactions`),
    ]);
    const unchangedResult = (c: any) => c && c.id === result.id && isCodex(c) && c.performed_via_github_app?.id === CODEX_APP_ID
      && c.body === result.body && c.created_at === result.created_at && c.updated_at === result.updated_at;
    if (!unchangedResult(resultAgain) || !authenticTrigger(triggerAgain)
      || !unchangedResult(commentsAgain.find(c => c.id === result.id)) || !authenticTrigger(commentsAgain.find(c => c.id === trigger.id))
      || conflictingComments(commentsAgain) || findings(reviewsAgain)
      || running(prReactions) || running(requestReactions)) return refuse('Codex review changed or is running; retry');
    return { provider: 'codex', sha: head, approved: true, reason: 'Authenticated Codex result reported no major issues', resultId: result.id, requestId: trigger.id, completedAt: new Date(completedAt).toISOString() };
  }
  const summaries = comments.filter(c => isCodex(c) && c.performed_via_github_app?.id === CODEX_APP_ID && c.body?.startsWith('<!-- codex-pull-request-review-summary -->'));
  if (summaries.length !== 1) return refuse('Exactly one authenticated Codex review summary is required');
  const summary = summaries[0];
  const rows = summary.body.split('\n').filter((line: string) => /^\| 📝 \*\*Code Review\*\* \|/.test(line));
  if (rows.length !== 1) return refuse('Codex summary format is unrecognized');
  const row = /^\| 📝 \*\*Code Review\*\* \| ✅ \*\*Completed\*\* <relative-time datetime="([^"]+)">[^<]+<\/relative-time> \| `([a-f0-9]{7,40})` \| (Manual request|New commits|PR opened) \|$/.exec(rows[0]);
  if (!row) return refuse('Codex has not completed a supported review of this candidate');
  const completedAt = Date.parse(row[1]);
  if (!Number.isFinite(completedAt) || completedAt > Date.now() + 5000) return refuse('Invalid Codex completion timestamp');
  const resolved = await source.request(`/commits/${row[2]}`);
  if (resolved.sha !== head) return refuse('Codex reviewed a different commit');
  const trigger = comments.find(c => c.id === request.commentId);
  if (!trigger || trigger.performed_via_github_app?.id !== graphyardAppId || trigger.user?.type !== 'Bot' || trigger.body !== request.body
    || trigger.created_at !== request.createdAt || trigger.created_at !== trigger.updated_at
    || !Number.isFinite(Date.parse(trigger.created_at)) || Date.parse(trigger.created_at) > completedAt) return refuse('The recorded Graphyard review request is missing, edited, or not yet completed');
  if (row[3] !== 'Manual request' && Math.floor(completedAt / 1000) <= Math.floor(Date.parse(trigger.created_at) / 1000))
    return refuse('Automatic review completion must be unambiguously later than the recorded request');
  // A new clean run supersedes earlier findings; resolving threads alone never does.
  if (reviews.some(r => isCodex(r) && Date.parse(r.submitted_at) >= Date.parse(trigger.created_at))) return refuse('Codex posted review findings/output for this request; fix them and request a fresh clean review');
  // Automatic reviews report their clean result on the PR, manual reviews on the request.
  const reactionPath = row[3] === 'Manual request' ? `/issues/comments/${trigger.id}/reactions` : `/issues/${pr}/reactions`;
  const reactions = await source.pages(reactionPath);
  const clean = reactions.filter(r => isCodex(r) && r.content === '+1' && Date.parse(r.created_at) > completedAt);
  if (clean.length !== 1 || reactions.some(r => isCodex(r) && r.content === 'eyes')) return refuse('A fresh Codex clean-review reaction is required; review may still be running or have findings');
  // Reread mutable summary/request/reaction state before accepting a snapshot.
  const [summaryAgain, triggerAgain, reactionsAgain, reviewsAgain] = await Promise.all([
    source.request(`/issues/comments/${summary.id}`), source.request(`/issues/comments/${trigger.id}`),
    source.pages(reactionPath), source.pages(`/pulls/${pr}/reviews`),
  ]);
  if (!isCodex(summaryAgain) || summaryAgain.performed_via_github_app?.id !== CODEX_APP_ID || summaryAgain.body !== summary.body || summaryAgain.updated_at !== summary.updated_at
    || triggerAgain.performed_via_github_app?.id !== graphyardAppId || triggerAgain.created_at !== trigger.created_at || triggerAgain.body !== trigger.body || triggerAgain.updated_at !== trigger.updated_at
    || !reactionsAgain.some(r => r.id === clean[0].id && isCodex(r) && r.content === '+1' && r.created_at === clean[0].created_at)
    || reactionsAgain.some(r => isCodex(r) && r.content === 'eyes')
    || reviewsAgain.some(r => isCodex(r) && Date.parse(r.submitted_at) >= Date.parse(trigger.created_at))) return refuse('Codex review changed while collecting approval; retry');
  return { provider: 'codex', sha: head, approved: true, reason: 'Authenticated Codex review completed without findings', summaryId: summary.id, requestId: trigger.id, reactionId: clean[0].id, completedAt: new Date(completedAt).toISOString() };
}
