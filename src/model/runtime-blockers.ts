// Concern: what a worker's blocked report says about its own session or GitHub, not about the item (GY-1567).
//
// Between 2026-10-02 and 2026-10-09 nine escalation interventions were needed at the build stage,
// each a worker's `blocked` report the master cleared by hand. Four of their causes lay outside the
// item and went away on their own, but `classifyBlocker` read them as `genuine`, so nothing
// re-checked them: a delivery push the worker's runtime refused at its permission prompt (a fresh
// session pushed normally), a runtime account that hit its usage limit (another profile resumed),
// GitHub answering a push with a server error during its own incident, and a scope blocker whose
// prose (`GET /compare/:range`, `req/min`, `e.g`, a bare `sync.ts`) was read as files no widening
// could ever cover. Browser-safe, like model/blocker-class.ts, which reads these first.

// The runtime's own refusal of a command at its permission prompt, in its words or the worker's.
const runtimeRefusal = /Permission to use \w+ with command[^\n]*?has been denied|denied by the runtime(?:'s)? permission prompt|runtime permission prompt[^.\n]*\bden(?:ied|ies)\b/i;
// The commands every worker launch is granted to deliver with: a push of its branch and the PR.
const deliveryCommand = /\bgit push\b|\bgh pr (?:create|edit|ready|view)\b/i;
// Rewriting a pushed branch is never granted: the next attempt fixes forward, so it is no runtime fault.
const branchRewrite = /--force\b|--force-with-lease\b|\bforce[- ]push|\bgit push\b[^\n'"`]*\s(?:-f|\+\S+)\b/i;
/** A delivery command the worker's runtime refused at its permission prompt: the session's, not the item's, so a fresh launch does not carry it. */
export const runtimeDenial = (text: string) => runtimeRefusal.test(text) && deliveryCommand.test(text) && !branchRewrite.test(text);

// A quota the host keeps (a disk, /tmp, a filesystem) is no runtime account: its remedy is the host's.
const hostQuota = /\b(?:disk|tmp|\/tmp|filesystem|file system|storage|inode)\s+quota\b|\bEDQUOT\b|\bDisk quota exceeded\b/i;
/**
 * The worker's runtime account ran out of usage, so the session stopped: another profile, or the same
 * one once it resets, resumes the kept work. A quota counts only as the session's or its account's.
 */
export const runtimeExhaustion = (text: string) => !hostQuota.test(text) &&
  /\busage limit (?:was |is |has been )?(?:reached|hit|exhausted)|\b(?:reached|hit) (?:its|the|my|their) usage limit|\b(?:session|account|runtime|provider|subscription|profile)(?:'s)? (?:usage |API )?(?:quota|credits?) (?:was |were |is |are |has been )?(?:exhausted|spent|used up|reached)\b|\b(?:session|account|runtime|provider|profile) (?:ran |is |was )?out of (?:usage|quota|credits)\b/i.test(text);

/**
 * GitHub's own server error on a git or gh operation the worker ran — a push the remote rejected
 * with `(Internal Server Error)`, an HTTP 5xx GitHub answered, an incident on githubstatus.com —
 * as against the Graphyard server's (control-plane-error): the plane's health cannot show it gone.
 */
export const githubOutage = (text: string) =>
  /\[remote rejected\][^\n]*\((?:Internal Server Error|Service Unavailable|Bad Gateway|Gateway Time-?out)\)|\bgithubstatus(?:\.com)?\b[^.\n]{0,80}(?<!\bno )(?<!\bnot )\b(?:incident|outage|degraded|investigating)|\b(?:GitHub|github\.com|api\.github\.com)(?:'s)? (?:returned|answered|responded|reports?|incident|outage)\b[^.\n]{0,60}\b(?:50[0234]|Internal Server Error|Service Unavailable|Bad Gateway|incident|outage|degraded)\b/i.test(text);

/** The GitHub status components a worker's delivery needs: pushing its branch and opening its PR. */
export const deliveryComponents = ['Git Operations', 'API Requests', 'Pull Requests'] as const;

/**
 * The blocker's named paths that can be repository files a widening covers (GY-1567). Prose is
 * not a path list: a token that continues an API route (`/compare/:range`), a rate (`req/min`), a
 * bare abbreviation (`e.g`) or a source basename written beside full paths (`sync.ts` for
 * `src/sync.ts`) names nothing in the tree. A bare name counts as a root file or dotfile
 * (`package.json`, `.gitignore`), and a bare source file (`index.ts`) when the blocker spells no
 * file with its directory; a nested one counts with a file extension or as a directory scope
 * (`docs/`, `tests/*`).
 */
export function blockerPaths(text: string, paths: readonly string[]) {
  const rootFile = /^(?:\.[A-Za-z_][\w.-]*|[\w-]+\.(?:md|json|ya?ml|toml|lock|txt))$/;
  const sourceFile = /^[\w-]{2,}\.[A-Za-z][A-Za-z0-9]{1,4}$/;
  const lastSegment = /^(?:|\*|[\w.-]*\.[A-Za-z0-9]{1,5})$/;
  const routed = (path: string) => new RegExp(String.raw`[/:]${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text);
  const nested = paths.filter(path => path.includes('/') && lastSegment.test(path.slice(path.lastIndexOf('/') + 1)) && !routed(path));
  return paths.filter(path => nested.includes(path) || (!path.includes('/') && (rootFile.test(path) || (!nested.length && sourceFile.test(path)))));
}
