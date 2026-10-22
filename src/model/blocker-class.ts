import { humanRequestBlocker } from './human-request.js';
import { userBusRefusal } from './user-bus.js';
import { RefusedResponse, planeUnavailable, planeUnavailableStatus } from './refusal.js';
import { githubOutage, runtimeDenial, runtimeExhaustion } from './runtime-blockers.js';
// Types only from work.ts: work.ts reaches this module through its own field types.
import type { Work } from './work.js';

// ---------------------------------------------------------------------------
// Blocker classes (GY-1008).
//
// On 2026-09-30 the board showed 19 blocked items and the master cleared every one by hand: eight
// were a GitHub credential failure fixed hours earlier, four were environment faults and one needed
// its already-requested approver launched. Nothing re-checked a blocker once it was recorded. Here
// each recorded blocker is read into one named class from its own text; the loop probes the cause
// of every environmental class each cycle and clears the blocker once the probe passes,
// and only a genuine or human-only blocker counts as needing someone. Browser-safe: the board
// classifies with it too, and the control plane re-classifies before it lets a probe clear.
// ---------------------------------------------------------------------------

export const blockerClasses = ['github-credential', 'control-plane-error', 'sandbox-path', 'worktree-mismatch', 'outside-scope-test-failure',
  'dispatch-failure', 'host-supervisor', 'runtime-denial', 'runtime-exhaustion', 'github-outage', 'master-role', 'human-only', 'genuine'] as const;
export type BlockerClass = typeof blockerClasses[number];

/** The classes whose cause lies outside the item: the loop probes each, every cycle, and clears the blocker once its probe passes. */
export const environmentalBlockerClasses: readonly BlockerClass[] = ['github-credential', 'control-plane-error', 'sandbox-path', 'worktree-mismatch', 'outside-scope-test-failure', 'dispatch-failure', 'host-supervisor',
  'runtime-denial', 'runtime-exhaustion', 'github-outage'];
/** Only these need someone else (the master, or the human for a human-only decision); every other class is resolved by the loop. A
 *  master-role blocker is the master identity's own step to take (GY-1761): no probe can grant a token a role, and retrying cannot either. */
export const needsSomeone = (blockerClass: BlockerClass) => blockerClass === 'genuine' || blockerClass === 'human-only' || blockerClass === 'master-role';
/** How many times in a row the loop clears an item's blocker before it stops and leaves it to the master: a cause that keeps coming back is not routine. */
export const maxAutomaticClears = 3;

/** What each class means and what resolves it, in the words master status and the docs use. */
export const blockerClassMeaning: Record<BlockerClass, string> = {
  'github-credential': 'git or gh could not authenticate to GitHub; cleared once `gh auth status` and `git ls-remote` pass inside the worker confinement',
  'control-plane-error': 'the Graphyard server failed a command (a 5xx, an internal error, a dropped connection); cleared once the server reports healthy',
  'sandbox-path': 'a path the worker must write was read-only or denied; cleared once the path is writable inside the worker confinement',
  'worktree-mismatch': "the session ran in another item's worktree or the wrong checkout; cleared once the attempt has ended, since the next one gets its own worktree",
  'outside-scope-test-failure': "a suite failed in files the item does not change; cleared once the base branch has moved past the tip it failed on",
  'dispatch-failure': "the master loop stopped redispatching the item after repeated launches no worker profile could take; cleared once a profile can take a launch again",
  'host-supervisor': "a host check failed only from the worker's sandbox, where the systemd user bus is masked; cleared once the loop, on the host, reaches the user manager and finds its own unit active",
  'runtime-denial': "the worker's runtime refused git push or gh pr at its permission prompt, which a fresh session does not carry; cleared once the attempt has ended, since the next launch is a fresh session",
  'runtime-exhaustion': "the worker's runtime account reached its usage limit; cleared once a worker profile can take a launch on an account dispatch would choose (configured, not held, under its provider quota, or the agent registry's pick), which resumes the kept work",
  'github-outage': 'GitHub answered a git or gh operation with its own server error; cleared once githubstatus.com reports Git Operations, API Requests and Pull Requests operational and git ls-remote and a dry-run push pass inside the worker confinement',
  'master-role': 'a step only the master role can take (a master command, or the doctor-issued checkout-restore) recorded from a worker token; a master-role identity — the master session or a doctor run, from the coordinator checkout — takes the step itself and unblocks the item (GY-1761)',
  'human-only': 'one of the three decisions only a human may make',
  genuine: 'anything the classes above do not recognise: the master reads it and acts',
};

export interface BlockerClassification {
  class: BlockerClass;
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
// A server error on one request (HTTP 500) can stand while the server reports healthy; the plane
// being down, unreachable or overloaded (502-504, refused or reset connections) is the whole plane's.
const requestServerError = /\bHTTP 500\b|\(500\)|\b500 Internal\b|"status":\s*500\b|\binternal (?:server )?error\b/i;
const planeWideError = /\bHTTP 50[234]\b|\(50[234]\)|\b50[234] (?:Bad Gateway|Service Unavailable|Gateway)|"(?:status|code)":\s*50[234]\b|ECONNREFUSED|ECONNRESET|socket hang up|(?<!git )fetch failed|Application failed to respond|server (?:is )?(?:down|unavailable|unreachable)|\b(?:out of memory|ENOMEM)\b/i;
// A server call the loop or the dispatcher made that ran into its own timeout (AbortSignal.timeout's
// TimeoutError): while the plane is slow, every call does, whichever item it was for.
const serverCallTimeout = /\bThe operation was aborted due to timeout\b/;
// GY-1375: the server's own answer while it is restarting (src/server/main.ts refuses every call with
// this 503 until startup validation completes, GY-1127): the whole plane is not ready yet, whichever call met it.
const startupReadiness = /\bStartup validation has not completed\b/;
// planeWideError's shapes without its bare memory alternative: a host's own ENOMEM is the host's, and
// the plane's memory counts only when the text names the server (planeMemory), as for blockers.
const planeWideShape = new RegExp(planeWideError.source.replace(String.raw`|\b(?:out of memory|ENOMEM)\b`, '') + `|${planeMemory}`, 'i');
/**
 * Whether a failure is the control plane's as a whole (GY-1345): down, unreachable or overloaded —
 * Railway's "Application failed to respond", an HTTP or body 502-504, a refused or reset
 * connection, a socket hang up, the server out of memory, the server's startup-readiness 503 (GY-1375) — or a server call that ran into its own timeout. One plane-wide
 * window fails every step that writes or reads, so the loop rides it out and retries; it is no
 * failure of the step that met it. An item-specific HTTP 500 is not one (itemSpecificPlaneError).
 */
export const planeWideFailure = (text: string | null | undefined) => !!text && (planeWideShape.test(text) || serverCallTimeout.test(text) || startupReadiness.test(text));
/**
 * Whether a thrown failure is plane-wide. A response the server refused carries its status and body,
 * so it is read structurally (GY-1344's planeUnavailable): a 502 the server judged itself, with its own
 * `error` field, is the item's; any other failure is read from its text.
 */
export const planeWideRefusal = (error: unknown) => {
  if (error instanceof RefusedResponse) return planeUnavailable(error) || startupReadiness.test(error.message);
  // GY-1895: a client error that keeps the refusal's status and body — the agent registry's
  // FleetUnreachableError among them — is read the same structural way: a registry 502 the proxy
  // answered in the plane's place (Railway's body carries `message`, not `error`) is the plane not
  // answering, not the session's fault; its bare wording (`answered 502`) matches no plane-wide
  // pattern. Anything else reads as text, as before.
  const structural = error as { status?: unknown; body?: unknown } | null;
  if (structural && typeof structural.status === 'number' && structural.body !== undefined && planeUnavailableStatus(structural.status, structural.body)) return true;
  return planeWideFailure(error instanceof Error ? error.message : typeof error === 'string' ? error : null);
};
/** Whether a control-plane blocker is a server error the item's own request met (GY-1055): the server's health cannot show it fixed. */
export function itemSpecificPlaneError(text: string | null | undefined) {
  return !!text && requestServerError.test(text) && !planeWideError.test(text);
}
// A read-only file system is a filesystem refusal on its own; a permission refusal (EACCES, EPERM,
// "Permission denied", a failed write) counts only when it names the path it refused, so an
// application's own permission error is not probed as a sandbox path.
const readOnlyFileSystem = /Read-only file system|\bEROFS\b/i;
const fileRefusal = /\bEACCES\b|\bEPERM\b|Operation not permitted|Permission denied|unable to (?:append|create|write|unlink)|cannot write/i;
const worktree = /\bworktree\b[^.]*\b(?:another|other|different|wrong|mismatch|belongs to|not (?:this|the) item|instead of)\b|\b(?:another|other|different|wrong) (?:item's )?(?:worktree|checkout)\b|attached to (?:the )?\S+ worktree|worktree mismatch/i;
const suiteFailure = /\b(?:tests?|suites?|specs?|checks?|typecheck)\b[^.]*\b(?:fail\w*|red|broken)\b|\b(?:fail\w*|red|broken)\b[^.]*\b(?:tests?|suites?|specs?)\b/i;
const outsideScope = /\boutside (?:(?:the|its|this item's|my) )?(?:plannedFiles|planned files|scope|item)|\bnot in (?:the |its )?(?:plannedFiles|planned files|scope)|\bunrelated\b|\bon (?:main|the base(?: branch)?)\b|\bpre-?existing\b/i;
/**
 * The recorded refusal of a step the master role gates (GY-1761): the master connection file only the coordinator checkout holds
 * (`graphyard master status` refuses without it), the master role a worker's token is narrowed away from by design, and the
 * master-role session a criterion names as its only route. The worker that met it cannot retry past it and no probe can grant
 * the role, so the class is a hand-off: a master-role identity takes the step itself, then unblocks the item.
 */
export const masterRoleBlocker = /\.graphyard\/master\.json does not exist|\bno master role\b|\bmaster-role session\b/i;

/** How every blocker the loop recorded for repeated dispatch failures opens (GY-1078; the loop records none since GY-2873, one still standing reads here). */
const dispatchFailureBlocker = /^Dispatch failed \d+ consecutive times with the same cause since \S+, so the master loop stopped redispatching /;
/**
 * Whether a dispatch failure's cause is the fleet's, not the item's (GY-1322): no worker profile
 * could take it, or a profile's name was held by a runtime session that was idle, done or still
 * launching. It clears as sessions finish or are closed: it never counts toward the dispatch-failure
 * bound, and a blocker recorded on it before is cleared once a profile can launch. An item's own
 * cause (a worktree that holds its branch) is not one, and its blocker stands for the operator.
 */
export const fleetIdleCause = (failure: string) =>
  /\bno worker profile can take\b|\bagent name \S+ is already visible in \w+\b|\b\w+ agent \S+ is (?:idle|done)\b|\bis reserved by another dispatch\b/i.test(failure);

/**
 * Whether a failure is the deploy's own release-skew window (GY-2177): the fixed refusal a CLI behind
 * the served release throws before any request is sent (src/cli/context.ts `versionSkewMessage` builds
 * it, so neither drifts) — between a control-plane deploy and the loop's realignment to the served
 * commit (upgrade.ts GY-2169), every claim the stale held CLI runs refuses with it, whatever the item.
 * Like a plane-wide failure it names the window, not the item or the profile that met it: the loop
 * rides it out and the next cycle's claim lands once the held CLI is aligned.
 */
export const deploySkewFailure = (failure: string | null | undefined) =>
  !!failure && /\bCLI [^\n]* and server [^\n]* differ: run graphyard upgrade/.test(failure);

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
 * human. Unrecognised text is `genuine`.
 */
export function classifyBlocker(text: string | null | undefined, context: { humanRequest?: boolean } = {}): BlockerClassification {
  const blocker = (text ?? '').trim();
  const none = { path: null };
  if (context.humanRequest || blocker.startsWith(humanRequestBlocker) || /^A human declined /.test(blocker)) return { class: 'human-only', ...none };
  if (!blocker) return { class: 'genuine', ...none };
  // The loop's own record of repeated launch failures on a fleet-idle cause (GY-1322), whatever else its cause quotes.
  if (dispatchFailureBlocker.test(blocker) && fleetIdleCause(blocker)) return { class: 'dispatch-failure', ...none };
  // GY-1761: a step the master role gates, read before any other class — the refusal is precise, and
  // no environmental probe answers it; the master identity takes the step itself.
  if (masterRoleBlocker.test(blocker)) return { class: 'master-role', ...none };
  if (githubCredential(blocker)) return { class: 'github-credential', ...none };
  // GY-1567: the worker's session or GitHub, not the item: each clears without anyone.
  if (runtimeDenial(blocker)) return { class: 'runtime-denial', ...none };
  if (runtimeExhaustion(blocker)) return { class: 'runtime-exhaustion', ...none };
  if (githubOutage(blocker)) return { class: 'github-outage', ...none };
  if (worktree.test(blocker)) return { class: 'worktree-mismatch', ...none };
  if (userBusRefusal.test(blocker)) return { class: 'host-supervisor', ...none };
  // A suite that fails outside the item is that, whatever its output says about servers or permissions.
  if (suiteFailure.test(blocker) && outsideScope.test(blocker)) return { class: 'outside-scope-test-failure', ...none };
  if (controlPlane.test(blocker)) return { class: 'control-plane-error', ...none };
  const path = refusedPath(blocker);
  if (readOnlyFileSystem.test(blocker) || (fileRefusal.test(blocker) && path)) return { class: 'sandbox-path', ...none, path };
  return { class: 'genuine', ...none };
}

/** The class of an item's standing blocker, or null when it has none. */
export function itemBlockerClass(work: Pick<Work, 'blocker' | 'humanRequest'>): BlockerClassification | null {
  return work.blocker ? classifyBlocker(work.blocker, { humanRequest: !!work.humanRequest && !work.humanRequest.answer }) : null;
}

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
export function blockerView(work: Pick<Work, 'blocker' | 'humanRequest' | 'blockerProbe'>): BlockerView | null {
  const classification = itemBlockerClass(work);
  if (!classification) return null;
  const probe = work.blockerProbe && work.blockerProbe.blocker === work.blocker ? work.blockerProbe : null;
  const spent = (work.blockerProbe?.clears ?? 0) >= maxAutomaticClears;
  return {
    class: classification.class,
    needsSomeone: needsSomeone(classification.class) || spent,
    lastProbe: probe ? { at: probe.at, result: probe.result, probe: probe.probe, detail: probe.detail } : null,
    nextProbeAt: needsSomeone(classification.class) || spent ? null : probe?.nextAt ?? null,
  };
}

/** Who acts next on an item blocked on a routine class: the loop, which re-checks the cause every cycle (GY-1008); null otherwise. */
export function routineBlocker(work: Pick<Work, 'blocker' | 'humanRequest' | 'blockerProbe'>): { who: string; does: string } | null {
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
