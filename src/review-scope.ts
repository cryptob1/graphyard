// Scope a review finding asks for. A worker answering a reviewer's finding on its own change often
// needs the file the finding names — `src/merge-queue.ts:85-97` — and the item's criteria do not
// name it, so the control plane's autoscope refuses and the item waited on a master session to run
// `master scope` (twice on GY-163, 2026-09-24). The finding itself is the grounds: the loop reads
// the item's unresolved review threads and its reviewer's latest change request on the head, with
// its own GitHub access and outside every coordination transaction, and widens by exactly the
// files those texts name, as the master's own additive intent.
import type { ChildRun } from './child-runner.js';
import { pathScope } from './model/scope.js';

/**
 * A review text the loop read, the grounds it is cited as, and when it was written: one trusted
 * comment of an unresolved thread, or the reviewer's change request. `at` orders instructions across
 * findings, so a later comment in another thread or a later review can take back an earlier one.
 */
export interface ReviewFinding { ground: string; text: string; at?: string }

const findingThreadsQuery = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id isResolved comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { body createdAt author { login } } } }
  } } }
}`;
// The rest of one thread's comments, for a thread longer than the page the thread listing carries.
const threadCommentsQuery = `query($id: ID!, $after: String) {
  node(id: $id) { ... on PullRequestReviewThread { comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { body createdAt author { login } } } } }
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
        findings.push({ ground: `review thread ${thread.id}`, text: comment.body, ...(typeof comment.createdAt === 'string' ? { at: comment.createdAt } : {}) });
      }
    }
    if (!connection.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }
  if (input.reviewer) {
    const reviews: any[] = JSON.parse(String(await run('gh', ['api', '--paginate', '--slurp', `repos/${input.repository}/pulls/${input.pr}/reviews?per_page=100`]))).flat();
    const latest = reviews.filter(review => String(review?.user?.login).toLowerCase() === input.reviewer!.toLowerCase() && review?.commit_id === input.sha && typeof review?.body === 'string').at(-1);
    if (latest?.state === 'CHANGES_REQUESTED') findings.push({ ground: `review ${latest.id}`, text: latest.body, ...(typeof latest.submitted_at === 'string' ? { at: latest.submitted_at } : {}) });
  }
  return findings;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether `text` names `path` itself — as a whole token, optionally with `:line` — not a longer path that contains it. */
const pathPattern = (path: string, flags = '') => new RegExp(`(^|[^A-Za-z0-9_./-])(${escape(path)})(?=$|[^A-Za-z0-9_./-]|\\.(?:$|\\s))`, flags);
export const namesPath = (text: string, path: string) => pathPattern(path).test(text);

// A file-like token: a path with a directory or an extension, or a dotfile such as `.gitignore`, with
// any `:line` suffix and trailing sentence punctuation left off. The requested path itself is matched
// literally as well, so a name this pattern cannot see — `Dockerfile`, `.github/CODEOWNERS` — is
// still a file of its clause.
const fileToken = /[A-Za-z0-9_][A-Za-z0-9_./-]*(?:\/[A-Za-z0-9_./-]*|\.[A-Za-z][A-Za-z0-9]{0,7})|(?<![A-Za-z0-9_./-])\.[A-Za-z][A-Za-z0-9_.-]*/g;
const creationVerb = /\b(create[sd]?|creating|add(?:s|ed|ing)?|new file|introduce[sd]?|introducing)\b/gi;
// A negation governing a creation verb: "do not create", "src/a.ts should not be added", "no new
// file", "adding src/a.ts is not needed", "we cannot create src/a.ts". It reaches back to the nearest
// comma, colon or conjunction before the verb and on to the next one after it, so "don't change
// src/a.ts, but add src/b.ts" and "add src/b.ts, not src/a.ts" still ask for src/b.ts. File names
// are masked first: `src/not.ts` names a file, it negates nothing.
const negation = /\b(?:not|cannot|never|no|without|avoid(?:s|ing)?|instead of|rather than|unnecessary|unneeded)\b|n[’']t\b/i;
const boundary = /[,:]|\b(?:but|and|then|so)\b/i;
const negated = (clause: string, files: readonly { at: number; end: number }[], at: number, end: number) => {
  let masked = clause.replace(fileToken, name => ' '.repeat(name.length));
  for (const file of files) masked = masked.slice(0, file.at) + ' '.repeat(file.end - file.at) + masked.slice(file.end);
  return negation.test(masked.slice(0, at).split(boundary).at(-1)!) || negation.test(masked.slice(end).split(boundary)[0]);
};

// What may stand between a creation verb and the file it acts on. Before the file, in the active
// voice ("create src/a.ts", "add a new file at `src/a.ts`"), only articles and file nouns; after it,
// in the passive ("src/a.ts should not be added"), only auxiliaries and negations. Other files the
// verb is coordinated with ("create src/a.ts and src/b.ts") are masked to FILE and may stand there
// too. Anything else — "add a case to tests/b.ts for the branch src/a.ts takes" — means the verb acts
// on something other than the file.
const quoting = /[`'"*()[\]]/g;
const activeGap = /^(?:\s|,|\b(?:and|or|a|an|the|new|empty|missing|separate|dedicated|file|files|module|at|called|named|as|FILE)\b)*$/i;
const passiveGap = /^(?:\s|,|:|\b(?:and|or|FILE|should|must|shall|will|would|could|can|cannot|needs?|has|have|had|is|are|was|were|be|been|being|to|still|also|yet|now|not|never|then)\b|\b[a-z]+n[’']t\b)*$/i;
// A destination after the file: "add src/generated.ts to `.gitignore`", "add src/a.ts into the
// exports list" puts the file's name somewhere else, it does not create it. A preposition that
// introduces a quoted name, a path or dotfile, or a list-like noun is a destination; "create
// src/a.ts to hold the helper" is not.
const destination = /^\s*(?:to|into|onto|in|inside|within|under)\s+(?:FILE\b|[`'"]|\.?[A-Za-z0-9_-]+[./][A-Za-z0-9_./-]|\.[A-Za-z]|(?:(?:the|its|your|our|this|that|a|an)\s+)?(?:[\w.-]+\s+){0,2}(?:list|file|set|array|config|configuration|manifest|index|exports?|entries|section|table|allowlist|ignore|plannedfiles|scope|glob|patterns?)\b)/i;

/**
 * Whether `text` asks for `path` to be created: a creation verb in a clause naming the path acts on
 * the path itself — its direct object ("create src/a.ts", "add a new file at src/a.ts") or its
 * passive subject ("src/a.ts should be added") — and does not put the path somewhere else ("add
 * src/generated.ts to .gitignore"). A verb about another file — "create src/b.ts; src/a.ts is wrong",
 * "add a case to src/b.ts next to src/a.ts" — grants nothing for it. A negated verb — "do not create
 * src/a.ts", "adding src/a.ts is not needed" — forbids exactly the file it names, and the latest such
 * instruction stands: a trusted comment that later writes "do not create src/a.ts" takes back an
 * earlier "create src/a.ts", and a later request renews it.
 */
export const asksToCreate = (text: string, path: string) => creationInstruction(text, path) === true;

/** The last instruction `text` gives about creating `path`: true to create it, false not to, null when it says neither. */
function creationInstruction(text: string, path: string): boolean | null {
  let asked: boolean | null = null;
  for (const clause of text.split(/[;!?\n]|\.(?=\s|$)/)) {
    if (!namesPath(clause, path)) continue;
    const named = [...clause.matchAll(pathPattern(path, 'g'))].map(match => ({ at: match.index! + match[1].length, end: match.index! + match[0].length }));
    const files = [...[...clause.matchAll(fileToken)].map(match => ({ at: match.index!, end: match.index! + match[0].replace(/\.+$/, '').length }))
      .filter(token => !named.some(file => token.at < file.end && file.at < token.end)), ...named];
    // The clause with every file but the requested one masked to FILE, keeping offsets.
    const others = (from: number, to: number) => {
      let part = clause.slice(from, to);
      for (const file of files.filter(file => !named.includes(file) && file.at >= from && file.end <= to).sort((a, b) => b.at - a.at))
        part = `${part.slice(0, file.at - from)}FILE${part.slice(file.end - from)}`;
      return part.replace(quoting, ' ');
    };
    const placed = (end: number) => destination.test(others(end, clause.length).replace(/^(?:\s*(?:,|\band\b|\bor\b)\s*FILE\b)*/i, ''));
    const events: { at: number; create: boolean }[] = [];
    for (const verb of clause.matchAll(creationVerb)) {
      const at = verb.index!, end = at + verb[0].length;
      const governs = named.some(file => file.at >= end
        ? activeGap.test(others(end, file.at)) && !placed(file.end)
        : file.end <= at && passiveGap.test(others(file.end, at)) && !placed(end));
      if (governs) events.push({ at, create: !negated(clause, files, at, end) });
    }
    for (const event of events.sort((a, b) => a.at - b.at)) asked = event.create;
  }
  return asked;
}

/**
 * The finding each requested path rests on, or the reason the request is not a finding's to grant.
 * Only single files a finding names literally qualify, never a directory; a file must exist on the
 * base branch unless the latest instruction about it, across every finding, asks for it to be created.
 */
export function findingScope(paths: readonly string[], findings: readonly ReviewFinding[], exists: (path: string) => boolean): { grounds: { path: string; ground: string }[] } | { refusal: string } {
  const grounds: { path: string; ground: string }[] = [];
  for (const path of paths) {
    if (pathScope(path).prefix || path.endsWith('*')) return { refusal: `${path} is a directory scope; a review finding grants only the files it names` };
    const naming = findings.filter(entry => namesPath(entry.text, path));
    if (!naming.length) return { refusal: `no unresolved review finding on the head names ${path}` };
    if (exists(path)) { grounds.push({ path, ground: naming[0].ground }); continue; }
    // A file to be created rests on the latest instruction about it across every finding, in the
    // order they were written: "do not create src/a.ts" in a later thread or review takes back an
    // earlier thread's "create src/a.ts", however the findings were listed.
    const written = naming.map((entry, index) => ({ entry, index, at: entry.at ? Date.parse(entry.at) : NaN }))
      .sort((a, b) => (Number.isNaN(a.at) ? -Infinity : a.at) - (Number.isNaN(b.at) ? -Infinity : b.at) || a.index - b.index);
    let decided: { entry: ReviewFinding; create: boolean } | null = null;
    for (const { entry } of written) { const create = creationInstruction(entry.text, path); if (create !== null) decided = { entry, create }; }
    if (!decided?.create) return { refusal: `${path} does not exist on the base branch and ${(decided?.entry ?? naming[0]).ground} does not ask for it to be created` };
    grounds.push({ path, ground: decided.entry.ground });
  }
  return { grounds };
}

/**
 * Whether `path` exists on the base branch as the remote has it now. The base is fetched first: the
 * daemon's other base fetch is lazy, so a local `origin/<baseBranch>` can be stale by any amount and
 * would judge a file added since absent, and a file deleted since present. Only a genuine absence
 * answers false: a failed fetch, a missing base ref, a timed-out or failing git fails the call, so the
 * caller retries instead of judging an existing file absent and recording that as its decision.
 */
export async function baseHasPath(root: string, baseBranch: string, path: string, run: ChildRun): Promise<boolean> {
  const ref = `origin/${baseBranch}`;
  await run('git', ['-C', root, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${baseBranch}:refs/remotes/${ref}`]);
  await run('git', ['-C', root, 'rev-parse', '--verify', `${ref}^{commit}`]);
  return String(await run('git', ['-C', root, 'ls-tree', '-z', '--name-only', ref, '--', path])).split('\0').includes(path);
}
