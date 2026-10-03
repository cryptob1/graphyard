import { humanRequestBlocker } from './human-request.js';
import { namedPaths, pathScopeContains, scopeRefusalBlocker } from './scope.js';
import { widenedPlannedFiles } from './scope-collapse.js';
// Types only from work.ts: work.ts reaches this module through its own field types.
import type { Work } from './work.js';

// ---------------------------------------------------------------------------
// Blocker classes (GY-1008).
//
// On 2026-09-30 the board showed 19 blocked items and the master cleared every one by hand: eight
// were a GitHub credential failure fixed hours earlier, four were environment faults, six needed
// one named file added to plannedFiles and one needed its already-requested approver launched.
// Nothing re-checked a blocker once it was recorded. Here each recorded blocker is read into one
// named class from its own text; the loop probes the cause of every environmental class each
// cycle and clears the blocker once the probe passes, turns a planned-file-scope blocker into a
// widening decision for the independent approver, launches a needs-decision blocker's approver,
// and only a genuine or human-only blocker counts as needing someone. Browser-safe: the board
// classifies with it too, and the control plane re-classifies before it lets a probe clear.
// ---------------------------------------------------------------------------

export const blockerClasses = ['github-credential', 'control-plane-error', 'sandbox-path', 'worktree-mismatch', 'outside-scope-test-failure',
  'planned-file-scope', 'needs-decision', 'human-only', 'genuine'] as const;
export type BlockerClass = typeof blockerClasses[number];

/** The classes whose cause lies outside the item: the loop probes each, every cycle, and clears the blocker once its probe passes. */
export const environmentalBlockerClasses: readonly BlockerClass[] = ['github-credential', 'control-plane-error', 'sandbox-path', 'worktree-mismatch', 'outside-scope-test-failure'];
/** Only these need a person (the master, or the human for a human-only decision); every other class is resolved by the loop. */
export const needsSomeone = (blockerClass: BlockerClass) => blockerClass === 'genuine' || blockerClass === 'human-only';
/** How many times in a row the loop clears an item's blocker before it stops and leaves it to the master: a cause that keeps coming back is not routine. */
export const maxAutomaticClears = 3;

/** What each class means and what resolves it, in the words master status and the docs use. */
export const blockerClassMeaning: Record<BlockerClass, string> = {
  'github-credential': 'git or gh could not authenticate to GitHub; cleared once `gh auth status` and `git ls-remote` pass inside the worker confinement',
  'control-plane-error': 'the Graphyard server failed a command (a 5xx, an internal error, a dropped connection); cleared once the server reports healthy',
  'sandbox-path': 'a path the worker must write was read-only or denied; cleared once the path is writable inside the worker confinement',
  'worktree-mismatch': "the session ran in another item's worktree or the wrong checkout; cleared once the attempt has ended, since the next one gets its own worktree",
  'outside-scope-test-failure': "a suite failed in files outside the item's plannedFiles; cleared once the base branch has moved past the tip it failed on",
  'planned-file-scope': 'the change needs named files outside plannedFiles; becomes an additive widening decision for the independent approver, cleared once plannedFiles cover them',
  'needs-decision': 'the item waits on a requested two-party decision; its approver is launched, and the blocker is cleared once the decision is judged',
  'human-only': 'one of the three decisions only a human may make',
  genuine: 'anything the classes above do not recognise: the master reads it and acts',
};

export interface BlockerClassification {
  class: BlockerClass;
  /** Planned-file scope: the files the blocker names. */
  paths: string[];
  /** Planned-file scope: the commit the blocker names, which the files are needed for. */
  commit: string | null;
  /** Needs-decision: the decision id the blocker names, when it names one. */
  decision: string | null;
  /** Sandbox path: the path the blocker says could not be written. */
  path: string | null;
}

// What `credentialFailure` (src/worker-credential.ts) ends an attempt on, word for word: the messages
// git and `gh` print themselves alone, a generic authentication refusal only beside GitHub, git or
// `gh` (GY-1066). That module is not browser-safe, so its patterns are restated here and the test
// holds the two together: every blocker the engine ends as a credential failure is classed
// `github-credential`, so its credential probe runs.
const credentialFailures = /could not read (?:Username|Password) for '?https:\/\/github\.com|The token in \S+ is invalid|Authentication failed for '?https:\/\/github\.com|Invalid username or (?:password|token)|You are not logged into any GitHub hosts|To get started with GitHub CLI, please run:? +gh auth login|Permission to \S+ denied to \S+/i;
const genericAuthenticationFailures = /HTTP 401\b|\bBad credentials\b|Requires authentication|Permission denied \(publickey\)/i;
const githubContext = /github\.com|api\.github|\bgh (?:pr|api|auth|repo|run|release)\b|\bgit (?:push|fetch|pull|clone|ls-remote)\b/i;
// What a worker writes about its GitHub login in its own words.
const githubCredentialWords = /could not read (?:Username|Password) for '?https?:\/\/github\.com|Authentication failed for '?https?:\/\/github\.com|gh auth login|not logged in(?:to| to) (?:any )?(?:GitHub|github\.com)|terminal prompts disabled|invalid (?:GitHub )?token|GH_TOKEN|GITHUB_TOKEN|github credential/i;
const githubCredential = (text: string) => credentialFailures.test(text) || (genericAuthenticationFailures.test(text) && githubContext.test(text)) || githubCredentialWords.test(text);
// A memory failure is the control plane's only when it names the server: a worker's own build or
// test running out of memory (`JavaScript heap out of memory`) is about the item, not the plane.
const planeMemory = String.raw`\b(?:server|postgres(?:ql)?|database|control plane)\b[^.\n]*\b(?:out of memory|ENOMEM)\b|\b(?:out of memory|ENOMEM)\b[^.\n]*\b(?:on|in|from|at) (?:the )?(?:graphyard )?(?:server|postgres(?:ql)?|database|control plane)\b`;
const controlPlane = new RegExp(String.raw`\binternal (?:server )?error\b|\bHTTP 5\d\d\b|\(5\d\d\)|\b50[0234] (?:Internal|Bad Gateway|Service Unavailable|Gateway)|ECONNREFUSED|ECONNRESET|socket hang up|(?<!git )fetch failed|${planeMemory}|server (?:is )?(?:down|unavailable|unreachable)`, 'i');
// A read-only file system is a filesystem refusal on its own; a permission refusal (EACCES, EPERM,
// "Permission denied", a failed write) counts only when it names the path it refused, so an
// application's own permission error is not probed as a sandbox path.
const readOnlyFileSystem = /Read-only file system|\bEROFS\b/i;
const fileRefusal = /\bEACCES\b|\bEPERM\b|Operation not permitted|Permission denied|unable to (?:append|create|write|unlink)|cannot write/i;
const worktree = /\bworktree\b[^.]*\b(?:another|other|different|wrong|mismatch|belongs to|not (?:this|the) item|instead of)\b|\b(?:another|other|different|wrong) (?:item's )?(?:worktree|checkout)\b|attached to (?:the )?\S+ worktree|worktree mismatch/i;
const suiteFailure = /\b(?:tests?|suites?|specs?|checks?|typecheck)\b[^.]*\b(?:fail\w*|red|broken)\b|\b(?:fail\w*|red|broken)\b[^.]*\b(?:tests?|suites?|specs?)\b/i;
const outsideScope = /\boutside (?:(?:the|its|this item's|my) )?(?:plannedFiles|planned files|scope|item)|\bnot in (?:the |its )?(?:plannedFiles|planned files|scope)|\bunrelated\b|\bon (?:main|the base(?: branch)?)\b|\bpre-?existing\b/i;
const scopeWords = /SCOPE NEEDED|\bplannedFiles\b|\bplanned[- ]files?\b|\bneeds? (?:the )?(?:file|files|scope)\b|\bscope (?:widening|request)\b|\boutside (?:the |its )?scope\b/i;
const decisionWords = /\b(?:decision|approver|approval)\b/i;
const decisionWait = /\b(?:needs?|await\w*|waits?|waiting|requested|pending|launch\w*|judge\w*|unanswered)\b/i;
const commitToken = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g;
// After the word "commit" any abbreviation is one, all digits or all letters included.
const namedCommit = /\bcommit\s+([0-9a-f]{7,40})\b/gi;
const uuidToken = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** The first path the text says could not be written: an explicit environment blocker's path, a quoted path, or the first path-shaped token. */
function refusedPath(text: string): string | null {
  const recorded = /cannot write (\S+), so required command/.exec(text)?.[1];
  if (recorded) return recorded;
  const quoted = /['"`]((?:\/|\.{0,2}\/|\.git\/|[\w.-]+\/)[^'"`\s]+)['"`]/.exec(text)?.[1];
  if (quoted) return quoted;
  return /(?<![\w.~-])((?:\/|\.git\/)[\w.~-][^\s'"`:,;]*)/.exec(text)?.[1] ?? null;
}

/**
 * The class a recorded blocker belongs to, read from its text and whether the item waits on a
 * human. Unrecognised text is `genuine`; so is a scope ask that names no file or no commit, which
 * no widening can be derived from. A decision wait that names no decision id is still
 * `needs-decision`: the loop acts on whichever decision stands requested on the item.
 */
export function classifyBlocker(text: string | null | undefined, context: { humanRequest?: boolean } = {}): BlockerClassification {
  const blocker = (text ?? '').trim();
  const none = { paths: [], commit: null, decision: null, path: null };
  if (context.humanRequest || blocker.startsWith(humanRequestBlocker) || /^A human declined /.test(blocker)) return { class: 'human-only', ...none };
  if (!blocker) return { class: 'genuine', ...none };
  if (githubCredential(blocker)) return { class: 'github-credential', ...none };
  if (worktree.test(blocker)) return { class: 'worktree-mismatch', ...none };
  // A suite that fails outside the item is that, whatever its output says about servers or permissions.
  if (suiteFailure.test(blocker) && outsideScope.test(blocker)) return { class: 'outside-scope-test-failure', ...none };
  if (controlPlane.test(blocker)) return { class: 'control-plane-error', ...none };
  const path = refusedPath(blocker);
  if (readOnlyFileSystem.test(blocker) || (fileRefusal.test(blocker) && path)) return { class: 'sandbox-path', ...none, path };
  if (blocker.startsWith(scopeRefusalBlocker) || scopeWords.test(blocker)) {
    // A URL is a reference, not a file: its host and path never become planned paths or a commit.
    const unlinked = blocker.replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ');
    const paths = namedPaths(unlinked);
    const unclaimed = (token: string) => !paths.some(path => path.includes(token));
    const commit = [...unlinked.matchAll(namedCommit)].map(match => match[1].toLowerCase()).find(unclaimed) ?? unlinked.match(commitToken)?.find(unclaimed) ?? null;
    return paths.length && commit ? { class: 'planned-file-scope', ...none, paths, commit } : { class: 'genuine', ...none };
  }
  if (decisionWords.test(blocker) && decisionWait.test(blocker)) return { class: 'needs-decision', ...none, decision: uuidToken.exec(blocker)?.[0].toLowerCase() ?? null };
  return { class: 'genuine', ...none };
}

/** The class of an item's standing blocker, or null when it has none. */
export function itemBlockerClass(work: Pick<Work, 'blocker' | 'humanRequest'>): BlockerClassification | null {
  if (!work.blocker) return null;
  return classifyBlocker(work.blocker, { humanRequest: !!work.humanRequest && !work.humanRequest.answer });
}

/** The planned-file-scope blocker's files that plannedFiles do not yet cover. */
export const uncoveredBlockerPaths = (work: Partial<Pick<Work, 'plannedFiles'>>, classification: BlockerClassification) =>
  classification.paths.filter(path => !(work.plannedFiles ?? []).some(planned => pathScopeContains(planned, path)));

/** A planned-file-scope blocker whose files no fold represents under the plannedFiles cap: no widening decision can answer it, so it needs the master. */
export const unrepresentableScope = (work: Partial<Pick<Work, 'plannedFiles' | 'criteria'>>, classification: BlockerClassification) => {
  const missing = classification.class === 'planned-file-scope' ? uncoveredBlockerPaths(work, classification) : [];
  return missing.length > 0 && !widenedPlannedFiles(work, missing).representable;
};

/**
 * The last probe of an item's standing blocker, as the loop recorded it on the item: which class
 * it was probed as, what the probe ran, whether it passed, and when it runs next. `clears` counts
 * the blockers the loop cleared in a row since the item last submitted.
 */
export interface BlockerProbe {
  blocker: string;
  class: BlockerClass;
  probe: string;
  result: 'pass' | 'fail';
  detail: string;
  at: string;
  nextAt: string | null;
  clears: number;
}

/** How an item's standing blocker reads on the board and in master status: its class, whether it needs someone, and its last and next probe. */
export interface BlockerView {
  class: BlockerClass;
  needsSomeone: boolean;
  lastProbe: { at: string; result: 'pass' | 'fail'; probe: string; detail: string } | null;
  nextProbeAt: string | null;
}

/**
 * The view of an item's standing blocker, or null when it has none. A routine class stops counting
 * as routine once the loop has cleared this item's blocker `maxAutomaticClears` times in a row.
 */
export function blockerView(work: Pick<Work, 'blocker' | 'humanRequest' | 'blockerProbe'> & Partial<Pick<Work, 'plannedFiles' | 'criteria'>>): BlockerView | null {
  const classification = itemBlockerClass(work);
  if (!classification) return null;
  const probe = work.blockerProbe && work.blockerProbe.blocker === work.blocker ? work.blockerProbe : null;
  const spent = (work.blockerProbe?.clears ?? 0) >= maxAutomaticClears || unrepresentableScope(work, classification);
  return {
    class: classification.class,
    needsSomeone: needsSomeone(classification.class) || spent,
    lastProbe: probe ? { at: probe.at, result: probe.result, probe: probe.probe, detail: probe.detail } : null,
    nextProbeAt: needsSomeone(classification.class) || spent ? null : probe?.nextAt ?? null,
  };
}

/** Who acts next on an item blocked on a routine class: the loop, which re-checks the cause every cycle (GY-1008); null otherwise. */
export function routineBlocker(work: Pick<Work, 'blocker' | 'humanRequest' | 'blockerProbe'> & Partial<Pick<Work, 'plannedFiles' | 'criteria'>>): { who: string; does: string } | null {
  const view = blockerView(work);
  if (!view || view.needsSomeone) return null;
  const meaning = blockerClassMeaning[view.class];
  return { who: 'Graphyard (automatic)', does: `Re-checks the ${view.class} blocker every cycle and clears it once the cause is gone: ${meaning.split(';')[1]?.trim() ?? meaning}` };
}

/** How many rows carry a blocker, and how many of those need someone (GY-1008). */
export function blockerCounts(items: { blocker?: BlockerView | null }[]) {
  const blocked = items.filter(item => item.blocker);
  return { total: blocked.length, needingSomeone: blocked.filter(item => item.blocker!.needsSomeone).length };
}
