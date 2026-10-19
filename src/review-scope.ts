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

/** A review text the loop cites as grounds: a review follow-up finding recorded on the item. */
export interface ReviewFinding { ground: string; text: string }

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
 * How many files on the base branch mention `identifier` as a whole word, as `basePaths` last
 * fetched it: the base-tree search the criteria-implied rule (GY-438, model/criterion-scope.ts
 * criterionSymbolGround) weighs a phrase-spelled call by, and the files holding a proof name
 * (model/scope-companions.ts newProofTestGround). A failed search is Infinity, which
 * grounds nothing, never zero.
 */
export async function baseMentions(root: string, baseBranch: string, identifier: string, run: ChildRun): Promise<number> {
  // An identifier, or a proof name (`unit:fleet-panel-renders-registry`) the companion rule (GY-955) asks which base file holds.
  const proof = /^(?:unit|integration):[\w.-]+$/.test(identifier);
  if (!/^[A-Za-z_$][\w$]*$/.test(identifier) && !proof) return Infinity;
  try {
    return String(await run('git', ['-C', root, 'grep', '-l', '-w', '-F', '-e', identifier, `origin/${baseBranch}`, '--'])).split('\n').filter(Boolean).length;
  } catch (error) {
    // git grep exits 1, saying nothing, when no file matches: for a proof name that is the answer (none holds it).
    const failed = error as { status?: number | null; stderr?: string };
    return proof && failed.status === 1 && !failed.stderr?.trim() ? 0 : Infinity;
  }
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
  await fetchBase(root, baseBranch, run);
  const commit = String(await run('git', ['-C', root, 'rev-parse', '--verify', `${ref}^{commit}`])).trim();
  // `<mode> <type> <object>\t<path>`: a directory named as a pathspec is listed as its own tree entry, so
  // only blobs (files and symlinks) count as present; a tree or a submodule is never a file to grant.
  const entries = String(await run('git', ['-C', root, 'ls-tree', '-z', commit, '--', ...paths])).split('\0');
  const files = new Set(entries.flatMap(entry => { const tab = entry.indexOf('\t'); return tab > 0 && entry.slice(0, tab).split(' ')[1] === 'blob' ? [entry.slice(tab + 1)] : []; }));
  return new Set(paths.filter(path => files.has(path)));
}

/** The most commits one successor read walks: a bound base months behind reads only the newest of them. */
export const successionCommitLimit = 1000;
/** How many times the base fetch is tried when git reports the remote-tracking ref contended: two processes fetching one repository race the ref's update (GY-1893). */
export const baseFetchAttempts = 3;
/** How long a contended base fetch waits before its retry: the fetch that moved the ref finishes in milliseconds. */
export const baseFetchRetryMs = 250;
/** The failure the race answers with (GY-1893's action:scope|GY-1384): git saw the ref at one commit when it negotiated and at another when it updated it. */
export const refLockContention = /error: cannot lock ref .*: is at [0-9a-f]+ but expected [0-9a-f]+/;
/**
 * The loop's base fetch. A concurrent fetch — another attempt's, or the loop's own next step — can
 * move the remote-tracking ref between git's negotiation and its update, and git answers
 * "cannot lock ref 'refs/remotes/origin/main': is at X but expected Y" (GY-1893's
 * action:scope|GY-1384, 17 October 2026): the read judged nothing about the base, so it is retried
 * in place, a fresh negotiation reading the ref as the other fetch left it. Only a last attempt, or
 * a failure that is not that race, is thrown, for the caller's own bound to retry.
 */
export async function fetchBase(root: string, baseBranch: string, run: ChildRun): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await run('git', ['-C', root, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`]);
      return;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (attempt >= baseFetchAttempts || !refLockContention.test(text)) throw error;
      await new Promise<void>(resolve => setTimeout(resolve, baseFetchRetryMs));
    }
  }
}
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
      await fetchBase(root, baseBranch, run);
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
