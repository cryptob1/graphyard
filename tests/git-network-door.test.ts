import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// GY-1931: one door to the remote. Every process that reaches the git remote itself — the host
// shell, the loop, the server container, the worker sandbox, CI — needs its own credential and
// fails its own way (GY-1922: the server's `git fetch origin` with no credential stalled a release
// 56 minutes; GY-1925: every worker's `complete --head` pushed from a sandbox where SSH cannot read
// /etc/ssh). The direction is that only the merge writer reaches the remote, and moving the ~30
// call sites at once would be one huge item, so this item only stops the set growing: this test
// freezes which source files under src/ and scripts/ spawn `git fetch`, `push`, `pull`, `clone` or
// `ls-remote`, in every spawn form the codebase uses — argv arrays (`run('git', ['fetch', …])`,
// including the `-C ROOT` prefix and a bare `['push', …]` array passed to a runner), variadic git
// helpers (`git('fetch', …)`, `gitAsync('fetch', …)`), `/bin/sh -c` scripts that run them (the
// blocker probes, the installer's host checkout), a replay wrapper's subcommand guard
// (`args[0] !== 'push'`) and a shared argument helper executed at its call site
// (`run('git', ['-C', root, ...pushArgs(…)])`, charged to the caller, not the defining file) — and fails, naming the file and line, on any spawner the allowlist does
// not list. A file that stops spawning them fails the other way: a stale entry is removed, so the
// list only shrinks. Each entry names the subcommands it runs (the test checks them against the
// scan), the process that runs them and the credential they use. unit:git-network-door-baseline
// pins the allowlist to the exact set that spawned at this item's base: no file added to make the
// door pass, none silently dropped. The description's grep named four files that never spawn a
// network subcommand — src/github.ts and src/protection.ts (webhook event names and `gh api`
// calls), src/github-permissions.ts (prose) and src/install/index.ts (local `rev-parse` only) —
// and missed one that does: src/install/host.ts, which clones and fetches the checkouts on the
// host over ssh. They are absent here, it is present.

const root = fileURLToPath(new URL('..', import.meta.url));

/** The subcommands that reach the remote; the door freezes which files may spawn each of them. */
export const networkSubcommands = ['clone', 'fetch', 'ls-remote', 'pull', 'push'] as const;
const networkGroup = '(fetch|push|pull|clone|ls-remote)';

/** Where a spawn was seen: the 1-based line, the form the codebase used, the subcommands it reaches the remote with. */
export interface SpawnFinding { line: number; form: 'argv-array' | 'variadic-helper' | 'shell-script' | 'subcommand-guard' | 'argument-helper'; subcommands: string[] }

/** Comments dropped (prose names commands), strings kept (a `-c` script is a string, and it spawns). */
export function stripComments(source: string): string {
  let out = '', comment: 'line' | 'block' | null = null, quote: string | null = null, escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index], next = source[index + 1];
    if (comment === 'line') { if (char === '\n') { comment = null; out += char; } continue; }
    if (comment === 'block') { if (char === '*' && next === '/') { comment = null; index++; out += '  '; } else out += char === '\n' ? '\n' : ' '; continue; }
    if (quote) {
      out += char;
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') { comment = 'line'; index++; out += '  '; continue; }
    if (char === '/' && next === '*') { comment = 'block'; index++; out += '  '; continue; }
    if (char === '\'' || char === '"' || char === '`') quote = char;
    out += char;
  }
  return out;
}

const lineOf = (text: string, offset: number) => text.slice(0, offset).split('\n').length;
/** The text of the `[`-literal that opens at `open`, read past strings so a `]` inside one never closes it. */
function arrayText(text: string, open: number): string {
  let depth = 0, quote: string | null = null, escaped = false;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (quote) { if (escaped) { escaped = false; continue; } if (char === '\\') { escaped = true; continue; } if (char === quote) quote = null; continue; }
    if (char === '\'' || char === '"' || char === '`') { quote = char; continue; }
    if (char === '[') depth++;
    else if (char === ']' && --depth === 0) return text.slice(open, index + 1);
  }
  return text.slice(open, open + 2000);
}

/** The `-c` script argument: the string after `'-c',`, or the string a named const in the same file holds. */
function scriptAfterDashC(text: string, offset: number): string | null {
  const rest = text.slice(offset, offset + 400);
  const literal = rest.match(/^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`]*)`)/);
  if (literal) return literal[1] ?? literal[2] ?? literal[3] ?? '';
  const name = rest.match(/^\s*([A-Za-z_$][\w$]*)/)?.[1];
  if (!name) return null;
  const safe = name.replace(/\$/g, '\\$&');
  return text.match(new RegExp(`(?:const|let|var)\\s+${safe}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)'|\`([^\`]*)\`)`))?.slice(1).find(kept => kept !== undefined) ?? null;
}

/**
 * The argument helpers a source defines: a function whose result is a network argument array
 * (`export const pushArgs = (…) => ['push', …]`, `function fetchArgs(…) { return ['fetch', …]; }`),
 * by name, with the subcommand it builds. A file that executes one spawns that subcommand itself.
 */
export function argumentHelpers(source: string): Map<string, string[]> {
  const text = stripComments(source), helpers = new Map<string, string[]>();
  const definitions = [
    new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*(?::[^=]*)?=>\\s*\\[\\s*['"\`]${networkGroup}['"\`]`, 'g'),
    new RegExp(`\\bfunction\\s+([A-Za-z_$][\\w$]*)\\s*\\([^)]*\\)[^{]*\\{\\s*return\\s*\\[\\s*['"\`]${networkGroup}['"\`]`, 'g'),
  ];
  for (const definition of definitions) for (const match of text.matchAll(definition)) helpers.set(match[1], [...new Set([...(helpers.get(match[1]) ?? []), match[2]])]);
  return helpers;
}

/** Every git network subcommand the source spawns, with the line and the form of each spawn site. */
export function findNetworkSpawns(source: string, helpers: ReadonlyMap<string, string[]> = new Map()): SpawnFinding[] {
  const text = stripComments(source);
  const findings: SpawnFinding[] = [], seen = new Map<string, SpawnFinding>();
  const record = (offset: number, form: SpawnFinding['form'], found: string[]) => {
    const line = lineOf(text, offset), held = seen.get(`${line}:${form}`);
    if (held) { for (const subcommand of found) if (!held.subcommands.includes(subcommand)) held.subcommands.push(subcommand); return; }
    const finding: SpawnFinding = { line, form, subcommands: [...found] };
    seen.set(`${line}:${form}`, finding);
    findings.push(finding);
  };
  // argv-array: a call whose first argument is the literal 'git' and whose second is an argument
  // array, directly (`run('git', ['fetch', …])`) or behind the `-C ROOT` prefix
  // (`run('git', ['-C', root, 'push', …])`).
  for (const match of text.matchAll(/\(\s*'git'\s*,\s*\[/g)) {
    const array = arrayText(text, match.index + match[0].lastIndexOf('['));
    const found = [...array.matchAll(new RegExp(`['"\`]${networkGroup}['"\`]`, 'g'))].map(spawn => spawn[1]);
    if (found.length) record(match.index, 'argv-array', found);
  }
  // argv-array continued: a bare argument array whose first element is the subcommand, passed to a
  // runner that prepends git (`run(['fetch', …])`, `git(['push', …])`) or held for one
  // (`pushArgs = () => ['push', …]`).
  for (const match of text.matchAll(new RegExp(`\\[\\s*['"\`]${networkGroup}['"\`]\\s*,`, 'g'))) record(match.index, 'argv-array', [match[1]]);
  // variadic-helper: an identifier beginning with `git` called with the subcommand as its first
  // literal argument (`git('fetch', …)`, `gitAsync('fetch', …)`).
  for (const match of text.matchAll(new RegExp(`\\bgit[A-Za-z0-9_$]*\\s*\\(\\s*['"\`]${networkGroup}['"\`]`, 'g'))) record(match.index, 'variadic-helper', [match[1]]);
  // shell-script: a string in the script position of a `sh -c` invocation (its own literal, or a
  // const of this file) that names git and a network subcommand — prose never sits there.
  for (const match of text.matchAll(/['"]-c['"]\s*,/g)) {
    const script = scriptAfterDashC(text, match.index + match[0].length);
    if (!script || !/\bgit\b/.test(script)) continue;
    const found = [...script.matchAll(new RegExp(`\\b${networkGroup}\\b`, 'g'))].map(spawn => spawn[1]);
    if (found.length) record(match.index, 'shell-script', found);
  }
  // subcommand-guard: a replay wrapper naming the one network subcommand its git runner may be
  // asked to execute (`if (!args.includes('tag') && args[0] !== 'push') throw …`).
  for (const match of text.matchAll(new RegExp(`\\[0\\]\\s*!==\\s*['"\`]${networkGroup}['"\`]`, 'g'))) record(match.index, 'subcommand-guard', [match[1]]);
  // argument-helper: a network argument helper — defined in any scanned file, imported under its
  // own name or an alias — executed here: spread into an argv (`run('git', ['-C', root,
  // ...pushArgs(…)])`) or passed whole to git or a runner (`run('git', pushArgs(…))`, `git(fetchArgs(…))`).
  // The helper's own file is caught by its literal; this catches every file that runs it.
  const called = new Map(helpers);
  for (const [name, subcommands] of helpers) for (const alias of text.matchAll(new RegExp(`\\b${name.replace(/\$/g, '\\$&')}\\s+as\\s+([A-Za-z_$][\\w$]*)`, 'g'))) called.set(alias[1], subcommands);
  for (const [name, subcommands] of called) {
    const safe = name.replace(/\$/g, '\\$&');
    for (const match of text.matchAll(new RegExp(`(?:\\.\\.\\.\\s*|\\(\\s*'git'\\s*,\\s*|\\b(?:git|run)[A-Za-z0-9_$]*\\s*\\(\\s*)${safe}\\s*\\(`, 'g'))) record(match.index, 'argument-helper', subcommands);
  }
  return findings.sort((a, b) => a.line - b.line);
}

/** src/ and scripts/ source files under `directory`, as sorted POSIX paths relative to the checkout. */
export async function sourceFiles(directory: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await sourceFiles(join(directory, entry.name), path));
    else if (/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}

export interface AllowlistEntry {
  /** The subcommands the file spawns; the test checks the scan against this list. */
  subcommands: string[];
  /** The process that runs them. */
  runs: string;
  /** The credential they reach the remote with. */
  credential: string;
  /** GY-1941 onward: why the file's calls cannot go through the merge writer; a follow-up that keeps an entry must record it. */
  door?: string;
}

/**
 * The door's allowlist: every file that spawns a git network subcommand, and nobody else. An entry
 * whose file stops spawning is refused (remove it); a spawner without an entry is refused (move the
 * calls behind the merge writer); unit:git-network-door-baseline keeps the set from growing.
 */
export const allowlist: Record<string, AllowlistEntry> = {
  'scripts/ci-tests.mjs': { subcommands: ['ls-remote'], runs: 'the CI runner reading the merge queue refs while selecting this run\'s tests', credential: 'the Actions checkout token the runner already holds', door: 'it runs on a GitHub Actions runner, a different machine from the loop that hosts the merge writer, and reads the queue refs with the token Actions hands that runner; the writer has no port a CI job can call' },
  'scripts/onboarding-delivery-fixture.mjs': { subcommands: ['fetch', 'push'], runs: 'the onboarding preview fixture standing up its scratch origin', credential: 'none: it pushes and fetches a local bare repository in scratch', door: 'its origin is a bare repository it created in scratch, not the install\'s remote: no install, loop or merge writer exists for the fixture it stands up, and nothing it moves leaves the machine' },
  'scripts/prepare-acceptance.mjs': { subcommands: ['fetch'], runs: 'the trusted acceptance job preparing the exact candidate head and base', credential: 'none stored: an anonymous https fetch of a public repository inside the candidate build context', door: 'it runs inside the trusted acceptance job on a CI runner, which must build from the exact head and base it reads itself; the merge writer lives in the loop on another machine and no port reaches it from CI' },
  'src/cli/checkout-restore-release.ts': { subcommands: ['clone', 'fetch'], runs: 'the serving release\'s own CLI answering `master checkout-restore --serve` (the base-tip read and the local snapshot clone)', credential: 'the loop checkout\'s own git credential for the fetch; the --shared clone is local and needs none', door: 'the clone is a --shared local copy of the checkout\'s own object store and never reaches the remote; the base-tip fetch serves a restore that runs when the loop, and so its merge writer, may be down or wedged, so it cannot wait on the merge writer\'s queue' },
  'src/cli/complete.ts': { subcommands: ['push'], runs: 'the worker CLI publishing its head (`complete`)', credential: 'the worker sandbox\'s own git credential (GY-1925: it fails wherever SSH cannot read /etc/ssh)', door: 'the push exists only in the PR form, which the engine accepts only while GitHub is the merger (GY-1523) — exactly when the control plane is not the merge writer, so there is no writer queue to hand the push to; the writer\'s one push door (sync-push) carries only a pure base sync of the worker\'s own assigned branch, and the answer to a sandbox that cannot push is `complete --head`, which pushes nothing (GY-1925)' },
  'src/cli/planned-files-intent.ts': { subcommands: ['fetch'], runs: 'the worker CLI reading the planned-files intent (`sync`)', credential: 'the worker checkout\'s own git credential', door: 'the best-effort fetch refreshes origin/BASE in the coordinator checkout before plannedFiles is derived against its tree — on `master create`, `master requirements` and the loop\'s scope and diagnosis reads; the merge writer runs as a serial queue step and publishes no base read other processes can await, and a failed fetch falls back to the last fetched base' },
  'src/cli/workspace-worktree.ts': { subcommands: ['fetch'], runs: 'the worker launcher\'s workspace tools (`handoff`, `restore-branch`)', credential: 'the workspace checkout\'s own git credential', door: 'the fetch refreshes the workspace checkout\'s own remote-tracking refs for `restore-branch`\'s lease push and for an adopted pull request\'s branch, which the merge writer neither holds nor pushes; a rework workspace reads the registered local head and fetches nothing (GY-2017), and `restore-branch`\'s lease push replaces a worker branch the merge writer has no lease on' },
  'src/conflicts.ts': { subcommands: ['fetch'], runs: 'the master status pipeline probing candidate conflicts', credential: 'the coordinator checkout\'s own git credential', door: 'it reads the open candidates\' worker branches, which the merge writer never fetches (its one read is the base tip), synchronously inside the status probe\'s time budget; the writer has no port for branch reads and is not wired under the github merger' },
  'src/daemon/acceptance.ts': { subcommands: ['fetch', 'push'], runs: 'the loop\'s acceptance step opening a goal\'s acceptance pull request under the github merger (base read, acceptance-branch push); under control-plane its base read is the merge writer\'s fetch', credential: 'the coordinator checkout\'s own git credential',
    door: 'under the github merger GitHub merges the acceptance pull request, so its branch must be on the remote before one opens, and no merge writer runs; the writer pushes only a leased merge onto the base tip, never a review branch' },
  'src/daemon/blocker-probes.ts': { subcommands: ['ls-remote', 'push'], runs: 'the loop\'s blocker probes: the confined credential script (`/bin/sh -c`) and the base-tip read', credential: 'whatever credential the confined worker holds — the probe exists to test it; the base-tip read uses the coordinator checkout\'s own', door: 'the confined credential and outage probes exist to test whatever credential the confined worker itself holds against the remote — run through the merge writer they would test the writer\'s credential and pass exactly where the next attempt fails; the base-tip read answers the outside-scope-test-failure probe at diagnosis time, when the plane, the writer or GitHub is itself the fault under test, so it cannot wait on a merge-writer queue' },
  'src/daemon/cycle-merge-writer.ts': { subcommands: ['fetch', 'push'], runs: 'the loop\'s merge-writer cycle (the base read, and the leased push it executes from pushArgs)', credential: 'the merge writer\'s deploy key alone (pushEnvironment, GIT_SSH_COMMAND)', door: 'it is the merge writer: its base fetch and leased push are the door itself' },
  'src/daemon/cycle-shadow.ts': { subcommands: ['fetch'], runs: 'the loop\'s shadow-gate reads', credential: 'the coordinator checkout\'s own git credential', door: 'the shadow gate trials a submitted head before it is queued, so it fetches the worker\'s branch, which the merge writer never reads, and runs while the writer is busy with another merge' },
  'src/daemon/deployment.ts': { subcommands: ['fetch'], runs: 'the loop\'s deployment observation and promotion reads (base tip and rc tags)', credential: 'the coordinator checkout\'s own git credential', door: 'deployment observation must read the base tip and rc/* records fresh every cycle, including while the merge writer is stalled or disabled (github delivery mode runs none), and it writes nothing' },
  'src/daemon/held-cli.ts': { subcommands: ['clone'], runs: 'the loop pinning a held CLI snapshot', credential: 'none: a --shared clone of the checkout\'s own object store', door: 'a --shared clone of the checkout\'s own object store: it never reaches the remote, so there is no network call to move' },
  'src/daemon/release-ports.ts': { subcommands: ['fetch', 'push'], runs: 'the loop\'s async release and promotion ports (ledger sync, leased push, the replay\'s guard)', credential: 'the merge writer\'s deploy key alone (deployKeySshCommand, pushEnvironment)', door: 'the release, promotion and revert steps run outside the merge queue (one candidate per release, not one merge per item), so they reach the remote beside the writer with its deploy key alone rather than through its queue' },
  'src/daemon/step-stalls.ts': { subcommands: ['ls-remote'], runs: 'the loop diagnosing a stalled merge step', credential: 'the merge writer\'s deploy key alone (pushEnvironment)', door: 'the probe diagnoses whether the merge writer\'s deploy key still reaches the remote while the writer is stalled; routing it through the stalled writer would make the diagnosis wait on the fault it diagnoses' },
  'src/daemon/upgrade.ts': { subcommands: ['fetch'], runs: 'the loop\'s self-upgrade reading the base tip', credential: 'the coordinator checkout\'s own git credential', door: 'the self-upgrade decides whether to restart the loop that runs the merge writer, so it must read the base tip without it, from a writer that may be the one owed the restart' },
  'src/docs-sync.ts': { subcommands: ['fetch'], runs: 'the loop\'s docs-sync (branch and base reads)', credential: 'the coordinator checkout\'s own git credential', door: 'the fetches put a reviewed worker branch and its base into the coordinator\'s object store for an in-memory merge-tree and a detached worktree; the merge writer exposes no read of a branch it is not merging, and a failed fetch falls back to commits already held' },
  'src/executor.ts': { subcommands: ['fetch'], runs: 'the loop\'s scope reads (currentBaseTree, autoscope and dispatch)', credential: 'the coordinator checkout\'s own git credential', door: 'a terminal scope refusal needs a base read fresh at the moment it is judged (GY-1764) under either merger; the writer\'s base fetch runs only in its control-plane cycle, and this read already runs in the same loop process with the same credential' },
  'src/install/host.ts': { subcommands: ['clone', 'fetch'], runs: 'the installer driving the host shell over ssh (`sh -c`): the managed checkout and the Graphyard source checkout', credential: 'the merge writer deploy key the installer registered and copied to the host, over SSH (GY-2009); the source checkout\'s remote is public and needs none', door: 'the installer creates the host checkouts the loop and its merge writer will later run from, so no merge writer exists yet; the managed clone uses the writer\'s own deploy key' },
  'src/master/autonomy.ts': { subcommands: ['clone', 'fetch'], runs: 'the master cloning the approver\'s own copy (approverClone) and fetching its bound sha', credential: 'the coordinator checkout\'s own git credential for the bound-sha fetch; the clone itself is local', door: 'the clone is local (the approver\'s own unshared copy of the coordinator checkout) and never reaches the remote; the fetch reads a worker\'s bound sha into that copy, a branch the merge writer never handles, and a miss is tolerated' },
  'src/master/worktrees.ts': { subcommands: ['fetch'], runs: 'the worker launcher\'s cycle preparation (cycleBaseTip, one fetch per cycle)', credential: 'the coordinator checkout\'s own git credential', door: 'the worker launcher prepares worktrees from the base tip in the coordinator\'s own object store, once per cycle; the merge writer runs as a serial queue step and publishes no base read other processes can await, so routing it there would serialize every launch behind merges' },
  'src/merge-writer/executor.ts': { subcommands: ['push'], runs: 'the merge writer itself — the one process meant to reach the remote; its leased push args run in cycle-merge-writer.ts and release-ports.ts', credential: 'the leased deploy key (deployKeySshCommand), forced only onto the tip it was tested on', door: 'it is the merge writer: pushArgs is the door\'s own leased push, defined here and executed only by the writer\'s ports' },
  'src/release-candidate.ts': { subcommands: ['fetch', 'ls-remote', 'push'], runs: 'the release candidate cut, ledger sync and remote-tip reads (`graphyard release`, the loop\'s ports)', credential: 'the caller\'s own git credential: the operator\'s for the CLI, the coordinator\'s or the deploy key in the loop', door: 'the release ledger library also serves `graphyard release` on the operator\'s machine and the release workflow in CI, where no merge writer runs; its pushes write rc/* tags and leased release/* branches, never the base branch the writer leases, and it spawns only through the git runner its caller hands it' },
  'src/release-project.ts': { subcommands: ['push'], runs: 'the loop\'s async promotion replaying the hold records\' tag writes', credential: 'the merge writer\'s deploy key, through the AsyncGit the release ports hand it', door: 'it spawns nothing itself: the guard only admits a hold record\'s tag push into the replay, which the release ports then run through their deploy-key git' },
  'src/review-scope.ts': { subcommands: ['fetch'], runs: 'the loop\'s review-scope reads', credential: 'the coordinator checkout\'s own git credential', door: 'the review-scope, cycle-scope and deployment reads need the base tip under either merger, and under the github merger no merge writer cycle runs; it is the same loop process and credential as the writer\'s own base fetch, with the contended-ref retry the writer lacks (GY-1893)' },
  'src/server/routes/goals.ts': { subcommands: ['fetch'], runs: 'the server\'s land route judging a merge-writer landing', credential: 'none of its own: a compose container holds no SSH credential (GY-1922), so a failed fetch answers retryable 503 and records nothing', door: 'it runs in the server process, which cannot call the loop\'s merge writer; the fetch is best-effort and a failure falls back to the origin ref the writer\'s own post-push fetch leaves, so dropping it is a change to the land route\'s judgement, not a move' },
  'src/up.ts': { subcommands: ['fetch', 'push'], runs: '`graphyard up` publishing onboarding and moving the host checkout to the installed ref', credential: 'the operator\'s own git credential on the installing machine', door: '`graphyard up` runs on the operator\'s machine while onboarding a repository, before any loop or merge writer serves it, and pushes only its own onboarding branch, never the base the merge writer owns' },
};

/**
 * The files that spawned git network subcommands at GY-1931's base (1acb121053), frozen: the
 * allowlist must equal it on this item's merge — no file added to make the door pass, none
 * silently dropped. A follow-up that moves its cluster's calls behind the merge writer removes its
 * entries here and in the allowlist in the same commit; the set never grows.
 * The four follow-ups own these files by cluster: GY-1941 release and promotion, GY-1942
 * docs-sync and workspace tooling, GY-1943 acceptance and planner, GY-1944 worker CLI — GY-1944
 * moved the worker CLI's trailing fetch behind the control plane's own push (the route validates
 * the fast-forward onto the commit the worker built, so the remote-tracking ref follows locally)
 * and removed that entry here and above in the same commit; its other three entries record in
 * `door` why their calls cannot go through the merge writer.
 */
/**
 * GY-1943: the acceptance and planner cluster. Each file either leaves both lists, its calls moved
 * behind the merge writer, or keeps an entry stating why its call cannot go through it.
 */
export const acceptanceAndPlannerCluster = ['src/daemon/acceptance.ts', 'src/review-scope.ts', 'src/executor.ts', 'src/conflicts.ts', 'src/server/routes/goals.ts', 'scripts/prepare-acceptance.mjs', 'scripts/ci-tests.mjs', 'scripts/onboarding-delivery-fixture.mjs'];

export const baseline = [
  'scripts/ci-tests.mjs',
  'scripts/onboarding-delivery-fixture.mjs',
  'scripts/prepare-acceptance.mjs',
  'src/cli/checkout-restore-release.ts',
  'src/cli/complete.ts',
  'src/cli/planned-files-intent.ts',
  'src/cli/workspace-worktree.ts',
  'src/conflicts.ts',
  'src/daemon/acceptance.ts',
  'src/daemon/blocker-probes.ts',
  'src/daemon/cycle-merge-writer.ts',
  'src/daemon/cycle-shadow.ts',
  'src/daemon/deployment.ts',
  'src/daemon/held-cli.ts',
  'src/daemon/release-ports.ts',
  'src/daemon/step-stalls.ts',
  'src/daemon/upgrade.ts',
  'src/docs-sync.ts',
  'src/executor.ts',
  'src/install/host.ts',
  'src/master/autonomy.ts',
  'src/master/worktrees.ts',
  'src/merge-writer/executor.ts',
  'src/release-candidate.ts',
  'src/release-project.ts',
  'src/review-scope.ts',
  'src/server/routes/goals.ts',
  'src/up.ts',
];

/**
 * GY-1941: the release and promotion cluster. Each file either left the allowlist and the baseline
 * (its calls moved behind the merge writer) or keeps its entry with `door`, the reason it cannot.
 * GY-2035: src/master/branch-release.ts left both lists — its rework-workspace fetch and its
 * GY-1753 recovery push stay deleted (GY-2017's registered-head start keeps them out), so no
 * process but the merge writer touches a worker branch.
 */
export const releaseCluster = [
  'src/release-candidate.ts', 'src/release-project.ts', 'src/daemon/release-ports.ts', 'src/daemon/deployment.ts', 'src/daemon/step-stalls.ts',
  'src/daemon/upgrade.ts', 'src/master/branch-release.ts', 'src/daemon/cycle-merge-writer.ts', 'src/daemon/cycle-shadow.ts', 'src/merge-writer/executor.ts',
];

const spoken = (subcommands: string[]) => subcommands.length <= 1 ? subcommands.join('') : `${subcommands.slice(0, -1).join(', ')} and ${subcommands[subcommands.length - 1]}`;
/** The subcommands a file's findings reach the remote with, sorted, deduplicated. */
export const subcommandsOf = (findings: SpawnFinding[]) => [...new Set(findings.flatMap(finding => finding.subcommands))].sort();

/** The door over one checkout's sources: every refusal names the file, and a spawn names its line. */
export function audit(files: ReadonlyMap<string, string>, listed: Readonly<Record<string, AllowlistEntry>> = allowlist): { refusals: string[]; detected: Map<string, SpawnFinding[]> } {
  const detected = new Map<string, SpawnFinding[]>(), helpers = new Map<string, string[]>();
  for (const source of files.values()) for (const [name, subcommands] of argumentHelpers(source)) helpers.set(name, [...new Set([...(helpers.get(name) ?? []), ...subcommands])]);
  for (const [path, source] of files) {
    const findings = findNetworkSpawns(source, helpers);
    if (findings.length) detected.set(path, findings);
  }
  const refusals: string[] = [];
  for (const [path, findings] of [...detected].sort(([a], [b]) => a.localeCompare(b))) {
    if (!Object.hasOwn(listed, path)) {
      const first = findings[0];
      refusals.push(`git-network-door: ${path}:${first.line} spawns git ${spoken(subcommandsOf(findings))} (${first.form}) and is not on the allowlist: move the calls behind the merge writer, or widen the item's requirements naming the file, the process and the credential — never add an entry to make this pass`);
    }
  }
  for (const path of Object.keys(listed).sort()) {
    if (!detected.has(path)) refusals.push(`git-network-door: ${path} is allowlisted but no longer spawns a git network subcommand; remove the entry (the list only shrinks) in the commit that moved the calls behind the merge writer`);
  }
  return { refusals, detected };
}

const scanCheckout = async () => {
  const files = new Map<string, string>();
  for (const directory of ['src', 'scripts']) for (const path of await sourceFiles(join(root, directory), directory)) files.set(path, await readFile(join(root, path), 'utf8'));
  return files;
};

test('unit:git-network-door — every file that spawns a git network subcommand is allowlisted, and every allowlist entry still spawns one', async () => {
  const { refusals, detected } = audit(await scanCheckout());
  assert.deepEqual(refusals, []);
  for (const [path, entry] of Object.entries(allowlist)) {
    assert.deepEqual(subcommandsOf(detected.get(path) ?? []), [...entry.subcommands].sort(), `${path}'s entry must name exactly the subcommands it spawns`);
    assert.ok(entry.runs.trim().length >= 15, `${path}'s entry names the process that runs its git network subcommands`);
    assert.ok(entry.credential.trim().length >= 10, `${path}'s entry names the credential its git network subcommands use`);
  }
  for (const path of acceptanceAndPlannerCluster) {
    if (!Object.hasOwn(allowlist, path)) { assert.ok(!baseline.includes(path), `${path} left the allowlist, so it leaves the baseline in the same commit`); continue; }
    assert.ok((allowlist[path].door ?? '').trim().length >= 60, `${path} still spawns, so its entry states why its call cannot go through the merge writer (GY-1943)`);
  }
});

/**
 * GY-1944: the worker CLI cluster. `sync --push-via-control-plane`'s trailing fetch moved behind
 * that push — the worker already holds the exact commit the route lands (it validates the
 * fast-forward and patches the branch with force:false), so its remote-tracking ref follows
 * locally and the entry left the allowlist and the baseline in the same commit. The other three
 * could not move, and each keeps its entry with `door`, the reason it cannot; a later move leaves
 * both lists too.
 */
export const workerCliCluster = [
  'src/cli/complete.ts',
  'src/cli/planned-files-intent.ts',
  'src/cli/sync-push.ts',
  'src/daemon/blocker-probes.ts',
];

test('unit:git-network-door — every worker CLI file left on the allowlist states why its call cannot go through the merge writer', () => {
  for (const path of workerCliCluster) {
    if (!Object.hasOwn(allowlist, path)) { assert.ok(!baseline.includes(path), `${path} left the allowlist, so it leaves the baseline in the same commit`); continue; }
    assert.ok((allowlist[path].door ?? '').trim().length >= 40, `${path} keeps its allowlist entry, so the entry states why its call cannot go through the merge writer`);
  }
});

test('unit:git-network-door — every release and promotion cluster file is off the door or its entry states why its call cannot go through the merge writer', () => {
  for (const path of releaseCluster) {
    if (!Object.hasOwn(allowlist, path)) { assert.ok(!baseline.includes(path), `${path} left the allowlist, so it leaves the baseline in the same commit`); continue; }
    assert.ok((allowlist[path].door ?? '').trim().length >= 40, `${path} keeps its allowlist entry, so the entry states why its call cannot go through the merge writer`);
  }
});

/**
 * GY-1942: the docs-sync and workspace tooling cluster. None of these calls could move behind the
 * merge writer — it is a serial queue that writes the base and serves no reads to other processes —
 * so each entry keeps its place and states why; a file that does move leaves this list too.
 */
export const docsSyncWorkspaceCluster = [
  'src/cli/checkout-restore-release.ts',
  'src/cli/workspace-worktree.ts',
  'src/daemon/held-cli.ts',
  'src/docs-sync.ts',
  'src/install/host.ts',
  'src/master/autonomy.ts',
  'src/master/worktrees.ts',
  'src/up.ts',
];

test('unit:git-network-door — every docs-sync and workspace tooling file left on the allowlist states why its call cannot go through the merge writer', () => {
  for (const path of docsSyncWorkspaceCluster) {
    if (!Object.hasOwn(allowlist, path)) { assert.ok(!baseline.includes(path), `${path} left the allowlist, so it leaves the baseline in the same commit`); continue; }
    assert.ok((allowlist[path].door ?? '').trim().length >= 40, `${path}'s entry states why its call cannot go through the merge writer`);
  }
});

test('unit:git-network-door — each spawn form the codebase uses is caught and named with its file and line', () => {
  const fixtures: Array<[string, string, string[]]> = [
    ['argv-array', `await run('git', ['fetch', '--quiet', 'origin', base]);`, ['fetch']],
    ['-C ROOT prefix', `await git('git', ['-C', root, 'push', '--quiet', '-u', 'origin', branch], { encoding: 'utf8' });`, ['push']],
    ['pull', `run('git', ['-C', root, 'pull', '--ff-only', 'origin', base]);`, ['pull']],
    ['clone', `await run('git', ['clone', '-q', '--shared', '--no-checkout', root, target]);`, ['clone']],
    ['bare args array', `const refs = git(['ls-remote', 'origin', 'refs/graphyard/queue/*'], root);`, ['ls-remote']],
    ['variadic helper', `const tip = await gitAsync('ls-remote', 'origin', ref);`, ['ls-remote']],
    ['shell script literal', `export const credentialScript = ['/bin/sh', '-c', 'GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code origin HEAD && git push --dry-run --quiet origin HEAD'];`, ['ls-remote', 'push']],
    ['shell script through a named const', `const clone = \`[ -d "$1/.git" ] || git -c credential.helper= clone --quiet "$2" "$1"\`; asUser(remote, home, 'sh', ['-c', clone, 'sh', target]);`, ['clone']],
    ['subcommand guard', `if (!args.includes('tag') && args[0] !== 'push') throw new Error('the replay ran git outside a hold record\\'s write');`, ['push']],
  ];
  for (const [form, source, subcommands] of fixtures) {
    const findings = findNetworkSpawns(source);
    assert.ok(findings.length >= 1, `a ${form} spawn is detected`);
    assert.deepEqual(subcommandsOf(findings), [...subcommands].sort(), `a ${form} spawn names its subcommands`);
    assert.equal(findings[0].line, 1, `a ${form} spawn is named with its line`);
    const { refusals } = audit(new Map([['src/example.ts', source]]), {});
    assert.equal(refusals.length, 1, `a ${form} spawn off the allowlist is refused`);
    assert.match(refusals[0], /^git-network-door: src\/example\.ts:1 /, `a ${form} refusal names the file and the line`);
  }
  // Prose never is: comments are dropped, and a message, a permission rule or a webhook event name
  // that merely says "git push" spawns nothing.
  for (const quiet of [
    `// later: await run('git', ['push', 'origin', branch]);`,
    `throw new Error(\`complete refused: git push failed: \${push.failure}\`);`,
    `const rules = ['Bash(git push:*)', 'Bash(git fetch origin)'];`,
    `const events = ['pull_request', 'push', 'check_run'];`,
    `run('git', ['rev-parse', 'HEAD']);`,
  ]) assert.deepEqual(findNetworkSpawns(quiet), [], `prose and reads spawn nothing: ${quiet.slice(0, 48)}`);
});

test('unit:git-network-door — a file executing a shared argument helper spawns its subcommand, and off the allowlist it is refused at the call', () => {
  const helper = `export const pushArgs = (base: string, tip: string, sha: string) => ['push', 'origin', \`--force-with-lease=refs/heads/\${base}:\${tip}\`, \`\${sha}:refs/heads/\${base}\`];\nexport function fetchArgs(ref: string) { return ['fetch', '--quiet', 'origin', ref]; }`;
  assert.deepEqual([...argumentHelpers(helper)], [['pushArgs', ['push']], ['fetchArgs', ['fetch']]]);
  const listed = { 'src/merge-writer/executor.ts': { subcommands: ['fetch', 'push'], runs: 'the merge writer defining its leased argument helpers', credential: 'the leased deploy key' } };
  for (const [shape, caller, subcommands] of [
    ['spread into an argv', `import { pushArgs } from './merge-writer/executor.js';\nawait run('git', ['-C', root, ...pushArgs(base, baseTip, mergeSha)], { env });`, ['push']],
    ['passed whole to git', `import { fetchArgs } from './merge-writer/executor.js';\nawait run('git', fetchArgs(base));`, ['fetch']],
    ['passed to a git runner', `import { fetchArgs } from './merge-writer/executor.js';\nconst out = git(fetchArgs(base), root);`, ['fetch']],
    ['imported under an alias', `import { pushArgs as leasedPush } from './merge-writer/executor.js';\nawait run('git', [...leasedPush(base, tip, sha)]);`, ['push']],
  ] as const) {
    const { refusals, detected } = audit(new Map([['src/merge-writer/executor.ts', helper], ['src/example.ts', caller]]), listed);
    assert.deepEqual(subcommandsOf(detected.get('src/example.ts') ?? []), [...subcommands], `a helper ${shape} spawns its subcommand from the caller`);
    assert.equal(refusals.length, 1, `an unallowlisted caller with a helper ${shape} is refused`);
    assert.match(refusals[0], /^git-network-door: src\/example\.ts:2 spawns git (push|fetch) \(argument-helper\)/, `the refusal of a helper ${shape} names the caller's file and the line that executes it`);
  }
  // Naming the helper is not executing it: a re-export, a reference or a test of its shape spawns nothing.
  assert.deepEqual(findNetworkSpawns(`export { pushArgs } from './executor.js';\nassert.deepEqual(pushArgs('main', 'a', 'b')[0], 'push');`, argumentHelpers(helper)), []);
});

test('unit:git-network-door — an allowlist entry whose file no longer spawns a network subcommand is refused as stale', () => {
  const { refusals } = audit(new Map([['src/example.ts', `const head = run('git', ['rev-parse', 'HEAD']);`]]), {
    'src/example.ts': { subcommands: ['fetch'], runs: 'the example process that used to read the base tip', credential: 'its own git credential' },
  });
  assert.deepEqual(refusals, ['git-network-door: src/example.ts is allowlisted but no longer spawns a git network subcommand; remove the entry (the list only shrinks) in the commit that moved the calls behind the merge writer']);
});

test('unit:git-network-door-baseline — the allowlist is exactly the set that spawned git network subcommands at GY-1931\'s base: none added to pass, none silently dropped', async () => {
  assert.deepEqual(Object.keys(allowlist).sort(), [...baseline].sort(), 'the allowlist and the baseline are the same files: an entry the base did not spawn from must not join the door (move the calls behind the merge writer instead), and a file whose calls moved leaves both lists in the same commit');
  const { detected } = audit(await scanCheckout());
  assert.deepEqual([...detected.keys()].sort(), [...baseline].sort(), 'the checkout spawns from exactly the baseline files; a new spawner is a door opening, not an entry to add');
});
