// Concern: base-branch breakage — telling a failure the base caused from the candidate's own, and the refresh and waking that answer it.
import type { Observation, Work } from '../model.js';
import { currentRestore, latestCheck } from '../merge-queue.js';

// GY-793. A candidate whose required check failed only because the base branch was broken when it
// ran is not the worker's to fix, and not the approver's to send back: it is the control plane's
// to bring onto the base tip that fixed the breakage. On 2026-09-26 main was briefly broken; every
// PR whose CI ran in that window failed `test` on the one broken test, the approvers rightly
// refused the rework, and nothing then moved those candidates onto the fixed main — they sat in
// test for hours while the loop waited for a rework nobody would approve.
//
// The judgement is made from test names, never from a check's colour alone. CI publishes, on the
// `test` check run of every commit it tests (pull-request heads and base-branch pushes alike), one
// annotation naming every test that failed in the run (`failedTestsAnnotation`). The observation
// reads those annotations for the candidate's head, for the base commit it was built against and
// for the current base tip, and records a `BaseBreak` only when every failing test of every failed
// required check also fails on the built-against base and does not fail on the tip. The
// observation job then refreshes the candidate onto the tip exactly as the merge-queue refresh
// does (github.ts `refreshBase`, trigger `base breakage`), carrying what the carry rule carries,
// and the rework decision stands down for it (`baseBreakHold`).

/** What precedes the machine-readable record in the failed-tests annotation's message. */
export const failedTestsMarker = 'graphyard-failed-tests:';
export const failedTestsTitle = 'Failed tests';
/** At most this many names are published; a run with more is not judged a base breakage. */
export const failedTestsLimit = 200;

/**
 * Every test the node test runner's spec reporter listed under `✖ failing tests:`, as
 * `FILE › NAME` (no line or column, which move between commits), or null when the log has no such
 * section: a run that failed before reporting — an install step, a crash — names no test, and
 * nothing is judged from it.
 */
export function failedTestsFromLog(log: string): string[] | null {
  const lines = log.split(/\r?\n/);
  const start = lines.findIndex(line => /^✖ failing tests:\s*$/.test(line.replace(/^\S+Z\s/, '')));
  if (start < 0) return null;
  const failed: string[] = [];
  let file: string | null = null;
  for (const raw of lines.slice(start + 1)) {
    const line = raw.replace(/^\S+Z\s/, '');
    const at = /^test at (.+?):\d+:\d+\s*$/.exec(line);
    if (at) { file = at[1]; continue; }
    const name = /^✖ (.+?)(?: \([\d.]+m?s\))?\s*$/.exec(line);
    if (name && file !== null) { failed.push(`${file} › ${name[1]}`); file = null; }
  }
  return [...new Set(failed)].sort();
}

// Workflow-command data and property escaping, as the Actions toolkit applies it.
const escapeData = (text: string) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (text: string) => escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

/** The annotation command CI prints for a failed run: a sentence for the pull request, then the record the observation parses. */
export function failedTestsAnnotation(failed: string[]): string | null {
  if (!failed.length || failed.length > failedTestsLimit) return null;
  const message = `${failed.length} test${failed.length === 1 ? '' : 's'} failed: ${failed.slice(0, 5).join('; ')}${failed.length > 5 ? '; …' : ''}. ${failedTestsMarker}${JSON.stringify({ failed })}`;
  return `::error title=${escapeProperty(failedTestsTitle)}::${escapeData(message)}`;
}

/** The failed tests one check run published, or null when it published none (or a malformed record). */
export function parseFailedTests(annotations: { message?: string | null }[]): string[] | null {
  for (const annotation of annotations) {
    const at = annotation.message?.indexOf(failedTestsMarker) ?? -1;
    if (at < 0) continue;
    try {
      const record = JSON.parse(annotation.message!.slice(at + failedTestsMarker.length));
      if (Array.isArray(record?.failed) && record.failed.length && record.failed.every((name: unknown) => typeof name === 'string' && name.length > 0 && name.length <= 500)) return [...new Set<string>(record.failed)].sort();
    } catch { /* malformed: not a record */ }
  }
  return null;
}

/** One required check's run on one commit: its conclusion (null while it has not completed, or has not run) and the tests it named failed. */
export interface CheckTests { sha: string; conclusion: string | null; failed: string[] | null }
/** One failed required check read on the candidate's head, on the base it was built against, and on the base tip. */
export interface BaseBreakReading { check: string; head: CheckTests; built: CheckTests; tip: CheckTests }
/**
 * A candidate held only by a base-branch breakage (GY-793): every failing test of every failed
 * required check on `head` fails on `builtOn`, the base commit it was built against, and passes on
 * `fixedBy`, the base tip. Recorded on the observation that read it, for exactly that head and tip.
 */
export interface BaseBreak { head: string; builtOn: string; fixedBy: string; checks: { check: string; tests: string[] }[]; at: string }
declare module '../model/work.js' { interface Observation { baseBreak?: BaseBreak | null } }

const failedConclusions = ['failure', 'timed_out', 'cancelled', 'action_required'];

/** The required checks that failed on the observed head, by their latest run. */
export function failedRequiredChecks(required: string[], checks: Observation['checks']): string[] {
  return required.filter(name => {
    const latest = latestCheck(checks.filter(check => check.name === name));
    return !!latest && failedConclusions.includes(latest.result);
  }).sort();
}

/**
 * Whether these readings show a base-branch breakage and nothing else, or null. Every failed
 * required check must name its failing tests on the head; each of those tests must be named
 * failed on the built-against base; and the tip's run of the same check must have completed with
 * none of them failed — a success, or a failure that names its own tests and not these. A check
 * that published no test names (a typecheck, a run that crashed) is never a base breakage.
 */
export function judgeBaseBreak(failed: string[], readings: BaseBreakReading[], at: string): BaseBreak | null {
  if (!failed.length) return null;
  const checks: BaseBreak['checks'] = [];
  let head: string | null = null, builtOn: string | null = null, fixedBy: string | null = null;
  for (const name of failed) {
    const reading = readings.find(entry => entry.check === name);
    if (!reading || !reading.head.failed?.length) return null;
    if (reading.built.sha === reading.tip.sha || reading.head.sha === reading.built.sha) return null;
    const built = reading.built.failed ?? [];
    if (!reading.head.failed.every(test => built.includes(test))) return null;
    const tip = reading.tip;
    if (tip.conclusion !== 'success' && !(tip.conclusion && failedConclusions.includes(tip.conclusion) && tip.failed)) return null;
    if (tip.failed && reading.head.failed.some(test => tip.failed!.includes(test))) return null;
    if ((head ?? reading.head.sha) !== reading.head.sha || (builtOn ?? reading.built.sha) !== reading.built.sha || (fixedBy ?? tip.sha) !== tip.sha) return null;
    head = reading.head.sha; builtOn = reading.built.sha; fixedBy = tip.sha;
    checks.push({ check: name, tests: [...reading.head.failed] });
  }
  return { head: head!, builtOn: builtOn!, fixedBy: fixedBy!, checks, at };
}

/** How the observation reads one commit's run of a check and one run's annotations; the GitHub adapter supplies both. */
export interface CheckTestsReader {
  checkRun: (sha: string, name: string) => Promise<{ id: number; conclusion: string | null } | null>;
  annotations: (id: number) => Promise<{ message?: string | null }[]>;
}
/**
 * The base breakage this observation shows, or null. Read only for an open head that does not
 * contain the base tip, built against a base other than that tip, with a failed required check:
 * anything else is not a base breakage and costs no request. A read that fails judges nothing.
 */
export async function readBaseBreak(input: { required: string[]; checks: Observation['checks']; head: string; built: string | null; tip: string; at: string }, reader: CheckTestsReader): Promise<BaseBreak | null> {
  const { required, checks, head, built, tip, at } = input;
  if (!built || built === tip) return null;
  const failed = failedRequiredChecks(required, checks);
  if (!failed.length) return null;
  const tests = async (sha: string, name: string, known?: { id?: number; result: string }): Promise<CheckTests> => {
    const run = known?.id !== undefined ? { id: known.id, conclusion: known.result } : await reader.checkRun(sha, name);
    if (!run) return { sha, conclusion: null, failed: null };
    const failing = run.conclusion && failedConclusions.includes(run.conclusion) ? parseFailedTests(await reader.annotations(run.id)) : null;
    return { sha, conclusion: run.conclusion, failed: failing };
  };
  try {
    const readings: BaseBreakReading[] = [];
    for (const name of failed) {
      const own = latestCheck(checks.filter(check => check.name === name));
      const reading = { check: name, head: await tests(head, name, own), built: { sha: built, conclusion: null, failed: null } as CheckTests, tip: { sha: tip, conclusion: null, failed: null } as CheckTests };
      if (!reading.head.failed?.length) return null;
      reading.built = await tests(built, name);
      if (!reading.built.failed?.length) return null;
      reading.tip = await tests(tip, name);
      readings.push(reading);
    }
    return judgeBaseBreak(failed, readings, at);
  } catch { return null; }
}

/** The base breakage recorded on the item's current observation, for exactly its current head and observed base tip. */
export function currentBaseBreak(work: Pick<Work, 'candidate' | 'observation'>): BaseBreak | null {
  const observation = work.observation, candidate = work.candidate, found = observation?.baseBreak;
  if (!found || !candidate || !observation) return null;
  return found.head === candidate.sha && observation.candidate.sha === candidate.sha && found.fixedBy === observation.baseTip ? found : null;
}

/**
 * The refresh a base breakage calls for, or null (GY-793). Once per head, base tip and policy
 * revision, like every base refresh: a refresh already recorded for the three — published,
 * conflicted, or found stale — is never repeated, so a conflict goes back to the worker as any
 * base conflict does. Never for a queued entry (the queue builds its own tip), a head being
 * reworked, a closed, draft or merged pull request, or a branch found carrying foreign commits.
 */
export function baseBreakRefreshNeeded(work: Work): BaseBreak | null {
  const found = currentBaseBreak(work), observation = work.observation, candidate = work.candidate;
  if (!found || !observation || !candidate) return null;
  if (!work.submission || work.reworkRequested || work.stage === 'done' || work.queue || work.blocker) return null;
  if (observation.merged || observation.prState === 'closed' || observation.draft || observation.baseTipContained !== false) return null;
  const refresh = work.baseRefresh;
  if (refresh && refresh.from.sha === candidate.sha && refresh.base === found.fixedBy && refresh.policyRevision === work.policyRevision) return null;
  const restore = currentRestore(work)?.restore;
  if (restore && restore.contaminated === candidate.sha) return null;
  return found;
}

/** Whether a base breakage, and only that, holds this candidate: the control plane is bringing it onto the tip, so nobody asks for a new head. */
export const baseBreakHold = (work: Work): BaseBreak | null => baseBreakRefreshNeeded(work);

/**
 * What the next action says of a failed required check a base breakage alone holds (GY-793): the
 * control plane's observation job is refreshing the candidate, so the item waits on it rather than
 * on a new head nobody should be asked for. Null for any other gate or state.
 */
export function baseBreakWait(work: Work, gate: string | null): { kind: 'session'; on: string; detail: string } | null {
  const found = gate === 'test' ? baseBreakHold(work) : null;
  return found ? { kind: 'session', on: 'graphyard', detail: describeBaseBreak(work.key, found) } : null;
}

const short = (sha: string) => sha.slice(0, 12);
const quoted = (tests: string[]) => tests.slice(0, 3).map(test => `"${test}"`).join(', ') + (tests.length > 3 ? ` and ${tests.length - 3} more` : '');

/** The one line `master status` and the next action say about a candidate held only by a base breakage. */
export function describeBaseBreak(key: string, found: BaseBreak): string {
  const checks = found.checks.map(entry => `${entry.check} failed only on ${quoted(entry.tests)}`).join('; ');
  const one = found.checks.every(entry => entry.tests.length === 1) && found.checks.length === 1;
  return `${key} is held only by a base-branch breakage, not by its own change: required check ${checks} on ${short(found.head)}, which ${one ? 'also fails' : 'all also fail'} on base commit ${short(found.builtOn)} that broke ${one ? 'it' : 'them'} and ${one ? 'passes' : 'pass'} on base tip ${short(found.fixedBy)} that fixed ${one ? 'it' : 'them'}; the control plane refreshes the candidate onto ${short(found.fixedBy)} instead of asking for a new head`;
}

/**
 * How long one decision step waits, in all, for the observations it woke, and how often it reads
 * again (GY-793 AC-2). The budget keeps the cycle inside its p90 bound: an item woken once the
 * budget is spent is still woken, and its reading is decided on the next cycle, well inside the
 * two-minute freshness bound. An item is woken again only after `decisionRewakeMs`.
 */
export const decisionObservationWaitMs = 15_000, decisionObservationPollMs = 2_000, decisionRewakeMs = 60_000;
/** The answer of the control plane's `resync` (Engine.resyncWork) this reads: the item, and whether a reading newer than `since` was saved. */
export interface ResyncAnswer { work?: Work; observed?: boolean }
/**
 * Wake one item's observation job and wait for the reading it produces (GY-793 AC-2). A decision
 * gated on a fresh GitHub observation used to wait for somebody else to observe the item — and
 * the loop, reading the item every ten minutes, found each reading past its two-minute bound, so
 * the bound was missed on every cycle and the rework never asked. The step wakes the job itself
 * (the same `resync` the executor runs) and returns the item as soon as an observation newer than
 * the wake is saved, so the caller re-decides from it in the same step; null when none arrived
 * within the wait, or the control plane cannot say (the caller then waits as it did before).
 */
export async function wakeOwnObservation(resync: (body: { since: string; wake?: false }) => Promise<ResyncAnswer | null | undefined>, pause: (ms: number) => Promise<void>,
  { waitMs = decisionObservationWaitMs, pollMs = decisionObservationPollMs, now = () => new Date() }: { waitMs?: number; pollMs?: number; now?: () => Date } = {}): Promise<Work | null> {
  const since = now().toISOString();
  let answer = await resync({ since });
  for (let polls = Math.floor(waitMs / pollMs); answer?.observed === false && polls > 0; polls--) {
    await pause(pollMs);
    answer = await resync({ since, wake: false });
  }
  return answer?.observed === true && answer.work ? answer.work : null;
}
