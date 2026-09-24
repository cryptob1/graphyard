// Scope a review finding asks for. A worker answering a reviewer's finding on its own change often
// needs the file the finding names — `src/merge-queue.ts:85-97` — and the item's criteria do not
// name it, so the control plane's autoscope refuses and the item waited on a master session to run
// `master scope` (twice on GY-163, 2026-09-24). The finding itself is the grounds: the loop reads
// the item's unresolved review threads and its reviewer's latest change request on the head, with
// its own GitHub access and outside every coordination transaction, and widens by exactly the
// files those texts name, as the master's own additive intent.
import type { ChildRun } from './child-runner.js';
import { pathScope } from './model/scope.js';

/** A review text the loop read and the grounds it is cited as: one trusted comment of an unresolved thread, or the reviewer's change request. */
export interface ReviewFinding { ground: string; text: string }

const findingThreadsQuery = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id isResolved comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { body author { login } } } }
  } } }
}`;
// The rest of one thread's comments, for a thread longer than the page the thread listing carries.
const threadCommentsQuery = `query($id: ID!, $after: String) {
  node(id: $id) { ... on PullRequestReviewThread { comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { body author { login } } } } }
}`;

/** A GitHub login as both APIs spell it: GraphQL drops the `[bot]` suffix REST keeps. */
const login = (value: unknown) => String(value ?? '').toLowerCase().replace(/\[bot\]$/, '');

/**
 * The findings standing against the item's head: each unresolved thread's comments by a trusted
 * author, and the latest change request the configured reviewer posted on `sha`. Trusted is the
 * configured reviewer and the automatic bot reviewers the review launch waits for: anyone else who
 * can comment on the pull request — the item's own worker included — could otherwise open a thread
 * naming a file and have the loop widen scope for it. A failed read throws; the caller then leaves
 * the refusal standing rather than widening on nothing.
 */
export async function readReviewFindings(input: { repository: string; pr: number; sha: string; reviewer: string | null; trusted: readonly string[] }, run: ChildRun): Promise<ReviewFinding[]> {
  const trusted = new Set([...input.trusted, ...(input.reviewer ? [input.reviewer] : [])].map(login));
  const [owner, name] = input.repository.split('/');
  const findings: ReviewFinding[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const parsed: any = JSON.parse(String(await run('gh', ['api', 'graphql', '-f', `query=${findingThreadsQuery}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${input.pr}`, ...(after ? ['-f', `after=${after}`] : [])])));
    const connection: any = parsed?.data?.repository?.pullRequest?.reviewThreads;
    if (!Array.isArray(connection?.nodes)) throw new Error(`GitHub did not list the review threads of pull request #${input.pr}`);
    for (const thread of connection.nodes) {
      if (thread?.isResolved !== false || typeof thread.id !== 'string') continue;
      const comments: any[] = [...(thread.comments?.nodes ?? [])];
      // Every comment of the thread, not the first page: a trusted author naming the file late in a
      // long thread is as much a finding as one naming it first.
      for (let more = thread.comments?.pageInfo, pages = 0; more?.hasNextPage; pages++) {
        if (pages >= 20) throw new Error(`review thread ${thread.id} on pull request #${input.pr} has more comments than the loop reads`);
        const next: any = JSON.parse(String(await run('gh', ['api', 'graphql', '-f', `query=${threadCommentsQuery}`, '-f', `id=${thread.id}`, '-f', `after=${more.endCursor}`])))?.data?.node?.comments;
        if (!Array.isArray(next?.nodes)) throw new Error(`GitHub did not list the comments of review thread ${thread.id}`);
        comments.push(...next.nodes);
        more = next.pageInfo;
      }
      for (const comment of comments) {
        if (!trusted.has(login(comment?.author?.login)) || typeof comment?.body !== 'string' || !comment.body) continue;
        findings.push({ ground: `review thread ${thread.id}`, text: comment.body });
      }
    }
    if (!connection.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }
  if (input.reviewer) {
    const reviews: any[] = JSON.parse(String(await run('gh', ['api', '--paginate', '--slurp', `repos/${input.repository}/pulls/${input.pr}/reviews?per_page=100`]))).flat();
    // The reviewer's standing verdict, as the observer reads it (src/github.ts): a COMMENTED review
    // — a thread reply, a blocked note — withdraws nothing, so it never hides a change request.
    const latest = reviews.filter(review => String(review?.user?.login).toLowerCase() === input.reviewer!.toLowerCase() && review?.commit_id === input.sha && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review?.state)).at(-1);
    if (latest?.state === 'CHANGES_REQUESTED' && typeof latest.body === 'string' && latest.body) findings.push({ ground: `review ${latest.id}`, text: latest.body });
  }
  return findings;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether `text` names `path` itself — as a whole token, optionally with `:line` — not a longer path that contains it. */
export const namesPath = (text: string, path: string) => new RegExp(`(^|[^A-Za-z0-9_./-])${escape(path)}(?=$|[^A-Za-z0-9_./-]|\\.(?:$|\\s))`).test(text);

/**
 * The finding each requested path rests on, or the reason the request is not a finding's to grant.
 * Only single files that exist on the base branch and that a finding names literally qualify: never a
 * directory, and never a file the base lacks. Whether a finding asks for a new file is free text the
 * loop does not judge, so a creation stays refused and escalated to the master.
 */
export function findingScope(paths: readonly string[], findings: readonly ReviewFinding[], exists: (path: string) => boolean): { grounds: { path: string; ground: string }[] } | { refusal: string } {
  const grounds: { path: string; ground: string }[] = [];
  for (const path of paths) {
    if (pathScope(path).prefix || path.endsWith('*')) return { refusal: `${path} is a directory scope; a review finding grants only the files it names` };
    const naming = findings.find(entry => namesPath(entry.text, path));
    if (!naming) return { refusal: `no unresolved review finding on the head names ${path}` };
    if (!exists(path)) return { refusal: `${path} does not exist on the base branch; a review finding grants only existing files, and a new file is the master's to decide` };
    grounds.push({ path, ground: naming.ground });
  }
  return { grounds };
}

/**
 * Which of `paths` exist on the base branch as the remote has it now. The base is fetched once per
 * decision and its commit pinned, so every path is judged against one tree and a request of many
 * paths costs one network fetch: the daemon's other base fetch is lazy, so a local
 * `origin/<baseBranch>` can be stale by any amount and would judge a file added since absent, and a
 * file deleted since present. Only a genuine absence leaves a path out: a failed fetch, a missing
 * base ref, a timed-out or failing git fails the call, so the caller retries instead of judging an
 * existing file absent and recording that as its decision.
 */
export async function basePaths(root: string, baseBranch: string, paths: readonly string[], run: ChildRun): Promise<Set<string>> {
  if (!paths.length) return new Set();
  const ref = `origin/${baseBranch}`;
  await run('git', ['-C', root, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${baseBranch}:refs/remotes/${ref}`]);
  const commit = String(await run('git', ['-C', root, 'rev-parse', '--verify', `${ref}^{commit}`])).trim();
  const listed = new Set(String(await run('git', ['-C', root, 'ls-tree', '-z', '--name-only', commit, '--', ...paths])).split('\0'));
  return new Set(paths.filter(path => listed.has(path)));
}
