// Scope a review finding asks for. A worker answering a reviewer's finding on its own change often
// needs the file the finding names — `src/merge-queue.ts:85-97` — and the item's criteria do not
// name it, so the control plane's autoscope refuses and the item waited on a master session to run
// `master scope` (twice on GY-163, 2026-09-24). The finding itself is the grounds: the loop reads
// the item's unresolved review threads and its reviewer's latest change request on the head, with
// its own GitHub access and outside every coordination transaction, and widens by exactly the
// files those texts name, as the master's own additive intent.
import type { ChildRun } from './child-runner.js';
import { pathScope } from './model/scope.js';
import { parseSuccessions, successorMinSimilarity, successorTrailer, type Succession } from './model/successors.js';

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

// A sentence or clause of a finding: split at a sentence end, a semicolon or a line break, never at a
// comma, so "Don't touch a.ts, b.ts or c.ts" stays one clause and every file in it reads as negated.
const clauses = (text: string) => text.split(/[;!?\n]|\.(?=\s|$)/);
// A path-like token — a slash, or a name with an extension — is masked before the negation words are
// read, so `src/no-op.ts` or `not.ts` is never itself read as a "no" or a "not".
const maskPaths = (clause: string) => clause.replace(/\S*\/\S*|[\w-]+\.[A-Za-z]\w*\b/g, ' ');
// "Update src/caller.ts instead" is affirmative; "instead of src/a.ts" and "rather than src/a.ts" are not.
const negation = /\b(?:not|no|never|nor|neither|none|cannot|dont|doesnt|isnt|shouldnt|mustnt|wont|cant|without|avoid|leave|keep|unchanged|untouched|alone|instead\s+of|rather\s+than|except|excluding|exclude|outside|forbid|forbidden|prohibit|prohibited|refrain|stop)\b|n['’]t\b/i;
/**
 * Whether `text` mentions `path` in a negated clause — "Do not change `src/security.ts`", "leave
 * src/a.ts alone", "fix src/b.ts rather than src/a.ts". The loop does not tell a prohibition from a
 * description that happens to say "not", so any negation word in the clause counts: a finding that
 * describes a file as "does not check X" is refused and escalated, never widened on a guess.
 */
// A review's verdict on a finding — "Not fixed: src/a.ts:12 …", "not yet addressed" — says the file still needs the change, so it is no negation of it.
const verdict = /\bnot\s+(?:yet\s+)?(?:fixed|addressed|resolved)\b/gi;
export const negatesPath = (text: string, path: string) => clauses(text).some(clause => namesPath(clause, path) && negation.test(maskPaths(clause).replace(verdict, ' ')));

/**
 * The finding each requested path rests on, or the reason the request is not a finding's to grant.
 * Only single files that exist on the base branch and that a finding names literally qualify: never a
 * directory, and never a file the base lacks. Whether a finding asks for a new file is free text the
 * loop does not judge, so a creation stays refused and escalated to the master. A file any trusted
 * finding names in a negated clause is refused too, however another finding names it: the mention
 * may be the reviewer ruling that very file out, and the loop grants only on an unqualified mention.
 */
export function findingScope(paths: readonly string[], findings: readonly ReviewFinding[], exists: (path: string) => boolean): { grounds: { path: string; ground: string }[] } | { refusal: string } {
  const grounds: { path: string; ground: string }[] = [];
  for (const path of paths) {
    if (pathScope(path).prefix || path.endsWith('*')) return { refusal: `${path} is a directory scope; a review finding grants only the files it names` };
    const naming = findings.find(entry => namesPath(entry.text, path));
    if (!naming) return { refusal: `no unresolved review finding on the head names ${path}` };
    const negated = findings.find(entry => negatesPath(entry.text, path));
    if (negated) return { refusal: `${negated.ground} names ${path} in a negated clause; the loop grants only a file a finding names without a negation, and leaves this to the master` };
    if (!exists(path)) return { refusal: `${path} does not exist on the base branch as a file; a review finding grants only existing files, never a directory, and a new file is the master's to decide` };
    grounds.push({ path, ground: naming.ground });
  }
  return { grounds };
}

/**
 * One file's text on the base branch as `basePaths` last fetched it (GY-199: the pinning-test rule
 * reads a test and the planned files it quotes), or null when the base holds no such file. Bounded
 * to a megabyte: a larger file is not read as text.
 */
export async function baseText(root: string, baseBranch: string, path: string, run: ChildRun): Promise<string | null> {
  try {
    const text = String(await run('git', ['-C', root, 'show', `origin/${baseBranch}:${path}`]));
    return text.length > 1_000_000 ? null : text;
  } catch { return null; }
}

/**
 * Which of `paths` exist as files on the base branch as the remote has it now; a directory is not a file. The base is fetched once per
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
  // `<mode> <type> <object>\t<path>`: a directory named as a pathspec is listed as its own tree entry, so
  // only blobs (files and symlinks) count as present; a tree or a submodule is never a file to grant.
  const entries = String(await run('git', ['-C', root, 'ls-tree', '-z', commit, '--', ...paths])).split('\0');
  const files = new Set(entries.flatMap(entry => { const tab = entry.indexOf('\t'); return tab > 0 && entry.slice(0, tab).split(' ')[1] === 'blob' ? [entry.slice(tab + 1)] : []; }));
  return new Set(paths.filter(path => files.has(path)));
}

/** The most commits one successor read walks: a bound base months behind reads only the newest of them. */
export const successionCommitLimit = 1000;
/** What one successor read found: the base tip it read, the successions since the bound base, and which successors are files at that tip. */
export interface SuccessionRead { tip: string; successions: Succession[]; files: Set<string> }
/**
 * The successions on the base branch since `since` (GY-394): every rename and copy git detects,
 * commit by commit, at `successorMinSimilarity` or more (`-M -C`), with the successor map any split
 * commit records in a `Graphyard-Successor:` trailer, oldest first. The bound base is the base
 * branch's tip as it stood at `since` (first parent, so a branch merged later still counts), and a
 * split spread over several commits is caught by one `--find-copies` diff between that bound base
 * and the current tip, attributed to the tip. Reads `origin/<baseBranch>` as the last fetch left
 * it; a failing git throws, so the caller retries rather than judging a successor absent.
 */
export async function baseSuccessions(root: string, baseBranch: string, since: string, run: ChildRun): Promise<SuccessionRead> {
  const ref = `origin/${baseBranch}`, similarity = `${successorMinSimilarity}%`;
  const tip = String(await run('git', ['-C', root, 'rev-parse', '--verify', `${ref}^{commit}`])).trim();
  const bound = String(await run('git', ['-C', root, 'rev-list', '-1', '--first-parent', `--before=${since}`, tip])).trim();
  const range = bound ? `${bound}..${tip}` : tip, walk = ['log', '--reverse', `--max-count=${successionCommitLimit}`];
  // The recorded maps come from every commit; the detected pairs from the commits git sees a rename
  // or copy in, since `--diff-filter` leaves a commit with neither out of its listing altogether.
  const recorded = parseSuccessions(String(await run('git', ['-C', root, ...walk, `--format=%x1e%H%x1f%(trailers:key=${successorTrailer},valueonly,separator=%x1d)`, range])));
  const detected = parseSuccessions(String(await run('git', ['-C', root, ...walk, `-M${similarity}`, `-C${similarity}`, '--name-status', '--diff-filter=RC', '--format=%x1e%H%x1f', range])));
  const order = [...new Set([...recorded, ...detected].map(entry => entry.commit))];
  const position = new Map(String(await run('git', ['-C', root, 'rev-list', '--reverse', `--max-count=${successionCommitLimit}`, range])).split('\n').filter(Boolean).map((commit, index) => [commit, index]));
  order.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
  const commits = order.flatMap(commit => [...recorded, ...detected].filter(entry => entry.commit === commit));
  const spanning = bound && bound !== tip
    ? parseSuccessions(`\x1e${tip}\n${String(await run('git', ['-C', root, 'diff', `-M${similarity}`, `-C${similarity}`, '--name-status', '--diff-filter=RC', bound, tip]))}`)
      .filter(entry => !commits.some(other => other.from === entry.from && other.to === entry.to))
    : [];
  const successions = [...commits, ...spanning];
  const targets = [...new Set(successions.map(entry => entry.to))];
  const files = new Set<string>();
  // Only a file at the tip is a successor to grant: a name renamed away again, or never created, is not.
  for (let at = 0; at < targets.length; at += 200) {
    const entries = String(await run('git', ['-C', root, 'ls-tree', '-z', tip, '--', ...targets.slice(at, at + 200)])).split('\0');
    for (const entry of entries) { const tab = entry.indexOf('\t'); if (tab > 0 && entry.slice(0, tab).split(' ')[1] === 'blob') files.add(entry.slice(tab + 1)); }
  }
  return { tip, successions, files };
}

/** How often the loop fetches the base for its successor reads: a split is re-planned within about this long of merging. */
export const successionFetchMs = 60_000;
/**
 * The loop's successor reader: fetches the base at most every `successionFetchMs`, and reads each
 * bound base's successions once per base tip, so re-checking every open item every cycle costs a
 * `rev-parse` and a `rev-list` per item while the base stands still.
 */
export function successionReader(root: string, baseBranch: string, run: ChildRun, clock: () => number = Date.now) {
  let fetchedAt = -Infinity;
  const read = new Map<string, SuccessionRead>();
  return async (since: string): Promise<SuccessionRead> => {
    if (clock() - fetchedAt >= successionFetchMs) {
      await run('git', ['-C', root, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`]);
      fetchedAt = clock();
    }
    const tip = String(await run('git', ['-C', root, 'rev-parse', '--verify', `origin/${baseBranch}^{commit}`])).trim();
    const bound = String(await run('git', ['-C', root, 'rev-list', '-1', '--first-parent', `--before=${since}`, tip])).trim();
    const key = `${tip}:${bound}`;
    const known = read.get(key);
    if (known) return known;
    const fresh = await baseSuccessions(root, baseBranch, since, run);
    if (read.size >= 200) read.clear();
    read.set(key, fresh);
    return fresh;
  };
}
