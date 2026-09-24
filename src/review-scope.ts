// Scope a review finding asks for. A worker answering a reviewer's finding on its own change often
// needs the file the finding names — `src/merge-queue.ts:85-97` — and the item's criteria do not
// name it, so the control plane's autoscope refuses and the item waited on a master session to run
// `master scope` (twice on GY-163, 2026-09-24). The finding itself is the grounds: the loop reads
// the item's unresolved review threads and its reviewer's latest change request on the head, with
// its own GitHub access and outside every coordination transaction, and widens by exactly the
// files those texts name, as the master's own additive intent.
import type { ChildRun } from './child-runner.js';
import { pathScope } from './model/scope.js';

/** A review text the loop read, and the grounds it is cited as. */
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
      const text = comments.filter((comment: any) => trusted.has(login(comment?.author?.login)))
        .map((comment: any) => typeof comment?.body === 'string' ? comment.body : '').join('\n');
      if (text) findings.push({ ground: `review thread ${thread.id}`, text });
    }
    if (!connection.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }
  if (input.reviewer) {
    const reviews: any[] = JSON.parse(String(await run('gh', ['api', '--paginate', '--slurp', `repos/${input.repository}/pulls/${input.pr}/reviews?per_page=100`]))).flat();
    const latest = reviews.filter(review => String(review?.user?.login).toLowerCase() === input.reviewer!.toLowerCase() && review?.commit_id === input.sha && typeof review?.body === 'string').at(-1);
    if (latest?.state === 'CHANGES_REQUESTED') findings.push({ ground: `review ${latest.id}`, text: latest.body });
  }
  return findings;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether `text` names `path` itself — as a whole token, optionally with `:line` — not a longer path that contains it. */
export const namesPath = (text: string, path: string) => new RegExp(`(^|[^A-Za-z0-9_./-])${escape(path)}(?=$|[^A-Za-z0-9_./-]|\\.(?:$|\\s))`).test(text);

// A file-like token: a path with a directory or an extension, with any `:line` suffix and trailing
// sentence punctuation left off.
const fileToken = /[A-Za-z0-9_][A-Za-z0-9_./-]*(?:\/[A-Za-z0-9_./-]*|\.[A-Za-z][A-Za-z0-9]{0,7})/g;
const creationVerb = /\b(create[sd]?|creating|add(?:s|ed|ing)?|new file|introduce[sd]?|introducing)\b/gi;
// A negation governing a creation verb: "do not create", "src/a.ts should not be added", "no new
// file", "adding src/a.ts is not needed". It reaches back to the nearest comma, colon or conjunction
// before the verb and on to the next one after it, so "don't change src/a.ts, but add src/b.ts" and
// "add src/b.ts, not src/a.ts" still ask for src/b.ts. File names are masked first: `src/not.ts`
// names a file, it negates nothing.
const negation = /\b(?:not|never|no|without|avoid(?:s|ing)?|instead of|rather than|unnecessary|unneeded)\b|n[’']t\b/i;
const boundary = /[,:]|\b(?:but|and|then|so)\b/i;
const negated = (clause: string, at: number, end: number) => {
  const masked = clause.replace(fileToken, name => ' '.repeat(name.length));
  return negation.test(masked.slice(0, at).split(boundary).at(-1)!) || negation.test(masked.slice(end).split(boundary)[0]);
};

/**
 * Whether `text` asks for `path` to be created: some clause naming the path has a creation verb
 * whose nearest file named in that clause is `path` itself, so a verb about another file — "create
 * src/b.ts; src/a.ts is wrong", "add a case to src/b.ts next to src/a.ts" — grants nothing for it,
 * and neither does a negated one: "do not create src/a.ts" and "adding src/a.ts is not needed"
 * forbid exactly the file they name.
 */
export function asksToCreate(text: string, path: string): boolean {
  for (const clause of text.split(/[;!?\n]|\.(?=\s|$)/)) {
    if (!namesPath(clause, path)) continue;
    const files = [...clause.matchAll(fileToken)].map(match => ({ at: match.index!, end: match.index! + match[0].length, name: match[0].replace(/\.+$/, '') }));
    for (const verb of clause.matchAll(creationVerb)) {
      if (negated(clause, verb.index!, verb.index! + verb[0].length)) continue;
      const at = verb.index!, distance = (file: { at: number; end: number }) => file.at >= at ? file.at - at : at - file.end;
      const nearest = files.reduce<(typeof files)[number] | null>((best, file) => !best || distance(file) < distance(best) ? file : best, null);
      if (nearest?.name === path) return true;
    }
  }
  return false;
}

/**
 * The finding each requested path rests on, or the reason the request is not a finding's to grant.
 * Only single files a finding names literally qualify, never a directory; a file must exist on the
 * base branch unless the finding naming it asks for it to be created.
 */
export function findingScope(paths: readonly string[], findings: readonly ReviewFinding[], exists: (path: string) => boolean): { grounds: { path: string; ground: string }[] } | { refusal: string } {
  const grounds: { path: string; ground: string }[] = [];
  for (const path of paths) {
    if (pathScope(path).prefix || path.endsWith('*')) return { refusal: `${path} is a directory scope; a review finding grants only the files it names` };
    const naming = findings.filter(entry => namesPath(entry.text, path));
    if (!naming.length) return { refusal: `no unresolved review finding on the head names ${path}` };
    const finding = exists(path) ? naming[0] : naming.find(entry => asksToCreate(entry.text, path)) ?? naming[0];
    if (!exists(path) && !asksToCreate(finding.text, path)) return { refusal: `${path} does not exist on the base branch and ${finding.ground} does not ask for it to be created` };
    grounds.push({ path, ground: finding.ground });
  }
  return { grounds };
}

/**
 * Whether `path` exists on `origin/<baseBranch>`. Only a genuine absence answers false: a missing
 * base ref, a timed-out or failing git fails the call, so the caller retries instead of judging an
 * existing file absent and recording that as its decision.
 */
export async function baseHasPath(root: string, baseBranch: string, path: string, run: ChildRun): Promise<boolean> {
  const ref = `origin/${baseBranch}`;
  await run('git', ['-C', root, 'rev-parse', '--verify', `${ref}^{commit}`]);
  return String(await run('git', ['-C', root, 'ls-tree', '-z', '--name-only', ref, '--', path])).split('\0').includes(path);
}
