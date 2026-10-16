// Concern: the flake ledger (GY-1498) — the pure half. A required check that failed and passed on
// its one rerun on the same sha is a flake: a PR rerun that ended `passed` (GY-516), a main
// guard flake (GY-1497) or a merge trial whose failing test files passed on their rerun of the
// same merge commit (GY-1834). Each such failed job is read once for the tests it failed, every
// test is an entry, and a test gets one fix item: on its first flake when it is no criterion proof
// of the item it flaked on (GY-1834), after it flakes repeatedly when it is. The ledger only
// remembers: the PR gate's single rerun and the main guard's revert decision read none of it, and
// a flaky test is never skipped, quarantined or exempted from a required check. The loop's step is
// daemon/cycle-flakes.ts and the file is flake-ledger.ts.
import { z } from 'zod';
import type { Work } from './work.js';
import type {} from '../merge-queue.js';
import type {} from '../main-guard.js';
import { proofTestFile } from './scope-companions.js';

/** At most this many entries are kept, the newest. */
export const flakeLedgerLimit = 500;
/** Entries, and the failed jobs read, are kept this long. */
export const flakeRetentionMs = 30 * 24 * 3_600_000;
/** A test flaky this often within `flakyWindowMs`, on this many distinct shas, gets a fix item. */
export const flakyThreshold = { flakes: 3, shas: 2 };
export const flakyWindowMs = 7 * 24 * 3_600_000;
/** After a fix item closes, nothing more is filed for its test for this long. */
export const flakyQuietMs = 7 * 24 * 3_600_000;
export const flakyTitle = 'Flaky test';

const entrySchema = z.object({
  /** The failed test, as the job's log names it; null when the log names none: then the flake is the check's. */
  test: z.string().nullable(), check: z.string(), sha: z.string(), pr: z.number().int().nullable(),
  /** A merge trial's flake (GY-1834) has no CI job: its failed run id is 0 and it is read under `trialReadKey`. */
  source: z.enum(['pr-rerun', 'main-rerun', 'trial-rerun']), failedRunId: z.number().int(), at: z.string(),
  /**
   * GY-1834: whether the test is one of the criterion proofs of the item it flaked on; null when that
   * item's criteria were not read (an entry an older release wrote). Only a test known to be no
   * proof of its item files its fix item on the first flake; any other waits for `flakyThreshold`.
   */
  ownProof: z.boolean().nullable().default(null),
});
export type FlakeEntry = z.infer<typeof entrySchema>;
export const flakeLedgerSchema = z.object({
  version: z.literal(1).default(1),
  entries: z.array(entrySchema).default([]),
  /** Every failed job already read, by its check run id, with when its flake happened: each is read once. */
  read: z.record(z.string(), z.string()).default({}),
  /** Per test, the fix item filed for it and, once seen closed, when. */
  filed: z.record(z.string(), z.object({ key: z.string(), at: z.string(), closedAt: z.string().nullable().default(null) })).default({}),
});
export type FlakeLedger = z.infer<typeof flakeLedgerSchema>;
export const emptyFlakeLedger = (): FlakeLedger => flakeLedgerSchema.parse({});

/** A failed job that passed on its rerun on the same sha, before its log is read. */
export interface FlakeSource {
  check: string; sha: string; pr: number | null; source: FlakeEntry['source']; failedRunId: number; at: string;
  /** The criterion proofs of the item it flaked on (GY-1834); absent or null when its criteria were not read. */
  proofs?: readonly string[] | null;
}
/** The criterion proofs of an item, or null when it was read without its criteria. */
const itemProofs = (item: Work) => Array.isArray(item.criteria) ? item.criteria.flatMap(criterion => criterion.proofs) : null;
/** Whether `test` is one of `proofs` by the proof id its name leads with; null when the proofs are unknown. */
export const isOwnProof = (test: string | null, proofs: readonly string[] | null | undefined) => {
  if (!proofs) return null;
  const proof = test === null ? null : leadingProof(test);
  return !!proof && proofs.includes(proof);
};

/**
 * Every flake the items record: a PR check rerun in state `passed` and every main guard flake.
 * A failure whose rerun failed too, is still owed or running, or was refused is not a flake and
 * is never a source; a main flake GitHub gave no failed run for has no job to read.
 */
export function flakeSources(work: readonly Work[]): FlakeSource[] {
  const sources: FlakeSource[] = [];
  for (const item of work) {
    const pr = item.submission?.pr ?? null, proofs = itemProofs(item);
    for (const rerun of item.checkReruns ?? []) if (rerun.state === 'passed')
      sources.push({ check: rerun.check, sha: rerun.sha, pr, source: 'pr-rerun', failedRunId: rerun.failedRunId, at: rerun.resolvedAt ?? rerun.at, proofs });
    for (const flake of item.mainGuardFlakes ?? []) if (flake.failedRunId !== null)
      sources.push({ check: flake.check, sha: flake.mergeSha, pr, source: 'main-rerun', failedRunId: flake.failedRunId, at: flake.at, proofs });
  }
  return sources;
}

/** The sources not read yet and still inside the retention, oldest first. */
export function unreadSources(ledger: FlakeLedger, sources: readonly FlakeSource[], now: number): FlakeSource[] {
  const seen = new Set<number>();
  return sources.filter(source => {
    if (seen.has(source.failedRunId) || ledger.read[source.failedRunId] !== undefined) return false;
    seen.add(source.failedRunId);
    return now - Date.parse(source.at) < flakeRetentionMs;
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Records one read failed job: one entry per test it failed, or one under its check when it names none. Mutates `ledger`. */
export function recordFlake(ledger: FlakeLedger, source: FlakeSource, tests: readonly string[] | null, now: number) {
  ledger.read[source.failedRunId] = source.at;
  const names = tests?.length ? [...new Set(tests)] : [null];
  ledger.entries.push(...names.map(test => ({ test, check: source.check, sha: source.sha, pr: source.pr, source: source.source, failedRunId: source.failedRunId, at: source.at, ownProof: isOwnProof(test, source.proofs) })));
  pruneFlakeLedger(ledger, now);
}

/**
 * GY-1834: a merge trial's flake — the test files of `key`'s trial on `mergeSha` that failed and
 * passed on their immediate rerun of the same commit, the head judged on that rerun. `tests` are the
 * failing test names the first run reported, or the files when it named none; `proofs` the item's
 * criterion proofs, none of which a trial ever sets aside as a flake.
 */
export interface TrialFlake { key: string; mergeSha: string; tests: string[]; proofs: string[]; at: string }
/** The read key of a trial flake: one merge commit is read once. */
export const trialReadKey = (mergeSha: string) => `trial:${mergeSha.toLowerCase()}`;
/** Records one trial flake, read once by its merge commit. Mutates `ledger`; false when it was read already. */
export function recordTrialFlake(ledger: FlakeLedger, flake: TrialFlake, now: number) {
  const key = trialReadKey(flake.mergeSha);
  if (ledger.read[key] !== undefined || now - Date.parse(flake.at) >= flakeRetentionMs) return false;
  ledger.read[key] = flake.at;
  const names = flake.tests.length ? [...new Set(flake.tests)] : [null];
  ledger.entries.push(...names.map(test => ({ test, check: 'trial', sha: flake.mergeSha.toLowerCase(), pr: null, source: 'trial-rerun' as const, failedRunId: 0, at: flake.at, ownProof: isOwnProof(test, flake.proofs) })));
  pruneFlakeLedger(ledger, now);
  return true;
}
/**
 * The trial flakes the merge writer judged in this process and the flake step has not taken yet:
 * the writer and the step run in the same loop, and the writer's trial has no CI job to read back.
 * Bounded; the oldest are dropped first.
 */
const pendingTrialFlakes: TrialFlake[] = [];
export const trialFlakeLimit = 100;
export function noteTrialFlake(flake: TrialFlake) { pendingTrialFlakes.push(flake); pendingTrialFlakes.splice(0, Math.max(0, pendingTrialFlakes.length - trialFlakeLimit)); }
/** Takes every pending trial flake, oldest first. */
export const takeTrialFlakes = () => pendingTrialFlakes.splice(0, pendingTrialFlakes.length);

/** Keeps the newest `flakeLedgerLimit` entries of the last `flakeRetentionMs`, and the reads of that window. Mutates `ledger`. */
export function pruneFlakeLedger(ledger: FlakeLedger, now: number) {
  const fresh = (at: string) => now - Date.parse(at) < flakeRetentionMs;
  ledger.entries = ledger.entries.filter(entry => fresh(entry.at)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-flakeLedgerLimit);
  for (const [id, at] of Object.entries(ledger.read)) if (!fresh(at)) delete ledger.read[id];
  for (const [test, filed] of Object.entries(ledger.filed)) if (filed.closedAt && now - Date.parse(filed.closedAt) >= flakyQuietMs) delete ledger.filed[test];
}

/** The proof id a test's name leads with (`unit:base-failure-no-rework — …`), or null. A `FILE › NAME` name is read from its NAME. */
export function leadingProof(test: string) {
  const name = test.includes(' › ') ? test.slice(test.lastIndexOf(' › ') + 3) : test;
  return /^((?:unit|integration):[\w.-]+)/.exec(name.trim())?.[1] ?? null;
}

/** A test that flaked often enough to fix: its flakes and shas in the window, and the proof it names. */
export interface FlakyTest { test: string; proof: string; flakes: FlakeEntry[]; shas: string[] }

/**
 * Tests with at least `flakyThreshold.flakes` flakes on at least `flakyThreshold.shas` distinct shas
 * within `flakyWindowMs`, each naming a proof, and (GY-1834) every test whose flake in the window
 * was of a test known to be no criterion proof of the item it flaked on: that one is flaky on its
 * first flake. A flake under its check alone, or of a test carrying no proof id, is recorded but
 * never makes a test flaky.
 */
export function flakyTests(ledger: FlakeLedger, now: number): FlakyTest[] {
  const byTest = new Map<string, FlakeEntry[]>();
  for (const entry of ledger.entries) if (entry.test !== null && now - Date.parse(entry.at) < flakyWindowMs) byTest.set(entry.test, [...byTest.get(entry.test) ?? [], entry]);
  return [...byTest].flatMap(([test, flakes]) => {
    const proof = leadingProof(test), shas = [...new Set(flakes.map(entry => entry.sha))];
    const first = flakes.some(entry => entry.ownProof === false);
    return proof && (first || (flakes.length >= flakyThreshold.flakes && shas.length >= flakyThreshold.shas)) ? [{ test, proof, flakes, shas }] : [];
  }).sort((a, b) => a.test.localeCompare(b.test));
}

/** Done, or closed without delivery. */
const settled = (item: Work) => item.stage === 'done' || !!(item as { closed?: unknown }).closed;
export const flakyItemTitle = (test: string) => `${flakyTitle}: ${test}`.slice(0, 200);
/** The open fix item standing for a test, by its title. */
export const openFlakyItem = (work: readonly Work[], test: string) =>
  work.find(item => item.title === flakyItemTitle(test) && !settled(item)) ?? null;

/** The fix item filed once for a flaky test: planned on the file its proof resolves to, naming that proof. */
export function flakyItem(flaky: FlakyTest) {
  const file = proofTestFile([flaky.proof])!;
  const runs = flaky.flakes.map(entry => `- ${entry.at} ${entry.check} on ${entry.sha.slice(0, 12)}${entry.pr !== null ? ` (PR #${entry.pr})` : ''}, ${entry.source === 'pr-rerun' ? 'PR check rerun' : entry.source === 'main-rerun' ? 'main guard rerun' : 'merge trial rerun'}${entry.source !== 'trial-rerun' ? `, failed job ${entry.failedRunId}` : ''}`);
  const first = flaky.flakes.some(entry => entry.ownProof === false);
  const why = first ? `the test "${flaky.test}" failed and passed on its rerun of the same commit, and it is no criterion proof of the item it flaked on, so its first flake files this item (GY-1834)`
    : `the test "${flaky.test}" failed and passed on its rerun of the same commit ${flaky.flakes.length} times on ${flaky.shas.length} commits in ${flakyWindowMs / 86_400_000} days (threshold ${flakyThreshold.flakes} on ${flakyThreshold.shas})`;
  return {
    title: flakyItemTitle(flaky.test), type: 'bug' as const, priority: 1,
    description: [
      `The master loop filed this item itself: ${why}.`,
      `Find why it passes only on rerun and remove the cause, in the test or the code it exercises. A flaky test is never skipped, quarantined or exempted from a required check, and the PR gate and main guard keep their single rerun.`,
      'Flakes (the evidence):', ...runs,
    ].join('\n\n').slice(0, 20000),
    criteria: [{ id: 'AC-1', text: `The cause that makes "${flaky.test}" pass only on rerun is found and removed: the proof ${flaky.proof} passes on every run without a rerun, and it is not skipped, quarantined or weakened`.slice(0, 2000), proofs: [flaky.proof] }],
    plannedFiles: [file],
    reason: first ? `The test "${flaky.test}" flaked on a head it is no criterion proof of and no open item fixes it` : `The test "${flaky.test}" flaked ${flaky.flakes.length} times on ${flaky.shas.length} commits within ${flakyWindowMs / 86_400_000} days and no open item fixes it`,
  };
}

/** Whether a test may be filed now: no fix item stands for it, and none closed within `flakyQuietMs`. */
export function mayFile(ledger: FlakeLedger, work: readonly Work[], test: string, now: number) {
  if (openFlakyItem(work, test)) return false;
  const filed = ledger.filed[test];
  return !filed || (!!filed.closedAt && now - Date.parse(filed.closedAt) >= flakyQuietMs);
}

/** Marks every filed item the snapshot shows closed, or no longer lists, as closed now. Mutates `ledger`; true when it changed. */
export function noteClosedFlakyItems(ledger: FlakeLedger, work: readonly Work[], now: number) {
  let changed = false;
  for (const filed of Object.values(ledger.filed)) {
    if (filed.closedAt) continue;
    const item = work.find(entry => entry.key === filed.key);
    if (!item || settled(item)) { filed.closedAt = new Date(now).toISOString(); changed = true; }
  }
  return changed;
}
