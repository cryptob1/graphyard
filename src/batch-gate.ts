// Concern: the batch gate on main (GY-3119). Merged work is verified together, one batch at a time,
// before anything serves it. The loop cuts a batch from the main tip whenever merges landed since
// the last verified commit and no gate is in flight, and gates the tip in the private trial
// container (never the served instance): the build, the bound E2E cases of every item in the batch,
// the core cases graphyard.json names in gate.core (Graphyard's: create-work-item and the deploy
// smoke, the `smoke` case: the built candidate serves and answers healthy), and the tests the
// affected selection picks for the changed files — the whole E2E catalog in place of the subset
// only when its measured gate-run time fits half the 45-minute limit (GY-3144). A passing gate records the tip as
// verified in .graphyard/main-gate.json; the deploy watch serves only that commit. A failing check
// is re-run once (a pass is a filed flake; a failure of a check with an open flaky-check item is
// recorded on that item and the batch kept, GY-3431), an affected test — or, when the whole catalog ran, a
// catalog case no batch item binds, gate.core does not name and smoke is not (GY-3147) — that also
// fails on the last verified commit is a filed known red, and a confirmed failure is bisected over the batch's prefixes in
// merge order (from the landing that added a failing case, GY-3409): the last item of the smallest
// failing prefix is reverted through the serve-revert path — the case's own landing when that revert
// does not apply — and the batch recut. A recut that fails again holds the last verified commit
// served and wakes the master until main moves, and any held gate is one master status attention
// line. A timeout is the host's, not the change's: it never holds, and the loop retries at once on
// main's newest tip (GY-3444); the bound counts the gate's own work, not its own checks' waits for a slot (GY-3474). The
// full suite and catalog run daily against the verified
// commit as diagnostics that file items and never block; the three preview cases run with them on
// the host, the verified commit in its own scratch install (GY-3193), and each one's last run and
// verdict stays on the record for master status.
//
// The batch it cut is the batch it gates (GY-3135): a loop restart adopts the batch in flight —
// the same candidate tip, files, checks and the steps already finished — and finishes it, so the
// restart a deploy causes never recuts a batch onto a newer tip; merges that land meanwhile ride
// the next batch, and only the gate's own failure or timeout recuts. Each settled run is the
// record's lastOutcome — tip, outcome, reason or failing check, end time — and the run in flight
// names its current step; master status shows both (GY-3141).
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { EnvironmentFault } from './app-environments.js';
import { formatAge } from './model/duration.js';
import type { Work } from './model.js';
import type { ServeLanding } from './merge-writer/serve-revert.js';
import type { PreviewCaseRun } from './merge-writer/served-previews.js';

/** How long one gate may run before it counts as failed (gate timeout). */
export const gateLimitMs = 45 * 60_000;
/** GY-3507: the hard ceiling on one gate run's bound, however slow its recent runs were. */
export const gateCeilingMs = 90 * 60_000;
/**
 * GY-3507: one gate run's bound — twice the median execution time of the recent verified runs,
 * never under the floor nor over the ceiling. Only verified runs are sampled, their waits left out,
 * so neither a timeout nor a wait inflates it. GY-3523: the floor is the 45-minute limit, or 1.5
 * times the recorded whole-catalog time when that is longer, so a catalog slower than 45 minutes
 * can verify once and earn samples; a catalog time above the ceiling is inflated and not trusted.
 */
export function gateBoundMs(record: Pick<GateRecord, 'verifiedRuns'> & Partial<Pick<GateRecord, 'catalogMs'>>): number {
  const runs = (record.verifiedRuns ?? []).map(run => run.ms).sort((a, b) => a - b), middle = runs.length >> 1;
  const catalog = record.catalogMs ?? 0, floor = catalog <= gateCeilingMs ? Math.max(gateLimitMs, Math.ceil(1.5 * catalog)) : gateLimitMs;
  const median = !runs.length ? 0 : runs.length % 2 ? runs[middle]! : (runs[middle - 1]! + runs[middle]!) / 2;
  return Math.min(gateCeilingMs, Math.max(floor, Math.ceil(2 * median)));
}
const minutes = (ms: number) => Math.round(ms / 60_000);
/** How often the full suite and the whole catalog run against the verified commit. */
export const diagnosticsIntervalMs = 24 * 60 * 60_000;
/** The gate runs the whole catalog only when its measured time fits this share of the limit. */
export const catalogBudgetMs = gateLimitMs / 2;
/** The whole-catalog gate runs the measure reads: the last few, within a week (older ones age out so the catalog is tried again). */
export const gateRunsWindow = 5, gateRunsMaxAgeMs = 7 * 24 * 60 * 60_000;
/** The merges the revert rate reads, and the rate above which the master is woken. */
export const revertRateWindow = 20, revertRateLimit = 1 / 5;

/** One merge the gate judged: its landing commit, its item, and whether the gate reverted it. */
export interface GateMerge { sha: string; item: string; reverted: boolean }
/** What the last settled gate run came to (GY-3141): why the verified commit has not moved, at a glance. */
export interface GateLastOutcome {
  /** The tip the run gated; null when the run failed before it cut a batch. */
  tip: string | null;
  outcome: 'verified' | 'reverted' | 'timeout' | 'retry' | 'held' | 'error';
  /** The reason it came to that outcome — the failing check a revert names — or null on a plain pass. */
  reason: string | null;
  finishedAt: string;
  /** GY-3278: each E2E case the run gated, by case id, and whether it passed (its re-run, when it failed once); the Tests page's Main column. */
  cases?: Record<string, 'pass' | 'fail'>;
}
/** The gate's persisted state, beside the deploy record. */
export interface GateRecord {
  /** The repository whose main this gates (owner/name), so the deploy watch of another repository never reads it. */
  repository: string | null;
  /** The latest verified commit: the one the deploy watch serves. */
  verified: string | null;
  verifiedAt: string | null;
  /**
   * The gate running now, for status: the batch as it was cut — its candidate tip and start, the
   * files and checks it was cut with, and each finished step's result — so the next loop adopts and
   * finishes it after a restart instead of cutting a new batch (GY-3135). The `files`, `checks` and
   * `results` fields are optional only for records an older loop wrote.
   */
  inFlight: { tip: string; startedAt: string; files?: string[]; checks?: string[]; results?: Record<string, string[]>; whole?: boolean; /** The run's current step, named before each phase (GY-3141). */ step?: string; /** GY-3474: what its current check is doing now: its own wait for a slot, or its trial run's latest step. */ progress?: string; /** GY-3444: the time its own checks waited to start, or the loop was down, which its bound does not count. */ waitedMs?: number;
    /** GY-3444: when the loop last saw the run going, so the time a restart took is not the gate's own. */ seenAt?: string;
    /** GY-3444: the detached trial run of its current check, which the loop after a restart adopts. */ run?: { commit: string; /** A digest of the check's proofs and files. */ input: string; directory: string } } | null;
  /** The last settled run (GY-3141), so status names why nothing has verified instead of guessing. */
  lastOutcome: GateLastOutcome | null;
  /** The current batch's recuts after a revert and its timeouts; cleared when a gate passes. */
  attempt: { recuts: number; timeouts: number };
  /**
   * GY-3199: the commit last published at `refs/graphyard/verified` on Graphyard's own repository,
   * which every install's deploy watch reads. Optional only for records an older loop wrote; the
   * gate publishes each newly verified commit, and a loop that adopted a record whose publication
   * never landed catches it up.
   */
  published?: string | null;
  /** Last successfully deployed commit handed to the release workflow; retained across loop restarts. */
  releaseTagged?: string | null;
  /** A batch that failed again after its recut, or timed out twice: the master is woken; cleared once main moves — except a timeout hold, which expires after a cool-off and reruns its tip (GY-3383). */
  held: { tip: string; reason: string; at: string } | null;
  /** Per commit, whether a check fails there (the known-red cache: an affected test, or a catalog-only e2e case). */
  results: Record<string, Record<string, boolean>>;
  /** The last merges judged, oldest first. */
  merges: GateMerge[];
  /** GY-3399: the gate's reverts, oldest first, the last 50 kept: what the week's revert count reads. Optional only for records an older loop wrote. */
  reverts?: { item: string; at: string }[];
  /** How long the whole E2E catalog took when the diagnostics last ran it. */
  catalogMs: number | null;
  /**
   * The recent gate runs of the whole catalog, newest last: how long each batch run of the build,
   * the whole catalog and the batch's affected tests took under real load, a timeout counting its
   * elapsed time. Optional only for records an older loop wrote.
   */
  gateRuns?: { ms: number; at: string }[];
  /** GY-3507: the last few verified gate runs' own execution time (waits left out), newest last: what the bound reads. */
  verifiedRuns?: { ms: number; at: string }[];
  diagnosticsAt: string | null;
  /**
   * GY-3264: the latest diagnostic run's failures, per check: the exact commit it tested and the
   * trial's own bounded failing-step text (null when the trial supplied none), kept here because
   * the trial's scratch is gone once it settles. Optional only for records an older loop wrote.
   */
  diagnosticFailures?: Record<string, DiagnosticFailure>;
  /** Each preview case's last daily run and verdict, by case (GY-3193). Optional only for records an older loop wrote. */
  previewCases?: Record<string, PreviewCaseRun>;
  /**
   * The items the gate filed, per filing key — the case binding a later run reuses instead of
   * filing again (GY-3147). Optional only for records an older loop wrote.
   */
  filed?: Record<string, { item: string | null; at: string }>;
  /** Filing failures that never aborted a run (GY-3147), newest last; the last few are kept. */
  notes?: string[];
  /** GY-3431: the failures recorded on each open flaky-check item instead of a revert, by item key: the last few per item, the ten items failing most recently. Optional only for records an older loop wrote. */
  flaky?: Record<string, { check: string; tip: string; at: string }[]>;
  at: string;
}

export const gateRecordPath = (root: string) => join(root, '.graphyard', 'main-gate.json');
export function readGateRecord(file: string): GateRecord | null {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')) as GateRecord; } catch { return null; }
}
export async function writeGateRecord(file: string, record: GateRecord) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

/** At rollout, the currently served commit is the first verified commit. */
export const bootstrapGate = (repository: string | null, served: string): GateRecord => ({
  repository, verified: served, verifiedAt: new Date().toISOString(), inFlight: null, attempt: { recuts: 0, timeouts: 0 }, held: null, lastOutcome: null,
  results: {}, merges: [], catalogMs: null, diagnosticsAt: null, filed: {}, notes: [], at: new Date().toISOString(),
});

/** The reads and runs one gate goes through. */
export interface GatePorts {
  now(): number;
  /** Fetches main and answers its tip. */
  fetch(): Promise<string>;
  /** The landings from `from` (exclusive) to `to` (inclusive), oldest first, each naming its item. */
  landings(from: string, to: string): Promise<ServeLanding[]>;
  /** The files that changed from `from` to `to`. */
  files(from: string, to: string): Promise<string[]>;
  /** Every case id the commit's E2E catalog holds. */
  catalog(commit: string): Promise<string[]>;
  /** graphyard.json gate.core at the commit. */
  core(commit: string): Promise<string[]>;
  /**
   * Runs checks on the commit in the private trial container — `build`, `e2e:<case>`, `affected`
   * (the selection over `files`) or `test:<file>` — and answers the failing ones, a failing
   * affected test as `test:<file>`. The run is bounded by `timeoutMs`, what is left of the gate's own limit.
   */
  run(commit: string, checks: readonly string[], files: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<string[]>;
  /** GY-3444, GY-3474: whether the gate's own check waits to start now — for a host slot or its container's start: time the gate's bound does not count. */
  waiting?(): boolean;
  /** Reverts the landing from main through the serve-revert path (trial, leased push, re-land filed); answers the revert, why it is held, or a retry (main moved under the push). */
  revert(landing: ServeLanding & { item: Work }, tip: string, check: string): Promise<{ revertSha: string } | { held: string } | { retry: string }>;
  /** Files an item owning a failure, once per `key`; answers the item it filed, when it names one. */
  file(input: { title: string; description: string; key: string }): Promise<{ item: string | null } | void>;
  /** GY-3431: the key of the open "Flaky check on main" item for `check`, or null when none is open. */
  flaky?(check: string): string | null;
  /**
   * GY-3199: publishes `commit` at `refs/graphyard/verified` on Graphyard's own repository through
   * the merge writer's deploy key, where every install's deploy watch reads it. Absent on an
   * install that does not gate Graphyard itself; a publish that fails never undoes the
   * verification — it is one gate note, caught up on a later cycle.
   */
  publish?(commit: string): Promise<void>;
  /**
   * Called whenever the record changed mid-flight — the cut, and each step a run finished — so a
   * loop restart adopts the batch as it stood, its finished steps with it.
   */
  checkpoint?(): Promise<void>;
}

/** How many filing notes the record keeps. */
export const filingNotesWindow = 5;

/** Whether a filing was refused because its key was filed before with different wording (GY-3147). */
const reusedFilingKey = (error: unknown) => /Idempotency key reused with different input/.test(error instanceof Error ? error.message : String(error));

/**
 * Files the item owning one gate failure, once per case (GY-3147): a binding the record keeps says
 * the case has its item and is reused, never re-filed — a later run's filing text differs, as the
 * tip it names moves — a key the control plane already holds is already filed, and any other filing
 * failure is a gate note. A refused or failed filing never aborts the run's verdict.
 */
async function fileFailure(ports: Pick<GatePorts, 'file'>, record: Pick<GateRecord, 'filed' | 'notes'>, at: string, input: { title: string; description: string; key: string }) {
  if (input.key in (record.filed ?? {})) return; // the case has its item: reuse it
  try {
    const filed = await ports.file(input);
    (record.filed ??= {})[input.key] = { item: typeof filed === 'object' && filed !== null ? filed.item : null, at };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (reusedFilingKey(error)) (record.filed ??= {})[input.key] = { item: null, at };
    else record.notes = [...record.notes ?? [], `${input.key}: ${text}`.slice(0, 200)].slice(-filingNotesWindow);
  }
}

/** The filings of two concurrent writers — the gate beside the diagnostics — merged: the newest binding per case wins, notes stay deduplicated and bounded. */
export function mergeFilings(latest: Pick<GateRecord, 'filed' | 'notes'> | null, mine: Pick<GateRecord, 'filed' | 'notes'>): Pick<GateRecord, 'filed' | 'notes'> {
  return { filed: { ...latest?.filed, ...mine.filed }, notes: [...new Set([...latest?.notes ?? [], ...mine.notes ?? []])].slice(-filingNotesWindow) };
}

/** What one gate came to. */
export type GateOutcome =
  | { outcome: 'idle' }
  | { outcome: 'verified'; tip: string; checks: string[]; flakes: string[]; knownRed: string[]; knownFlaky?: { check: string; item: string }[] }
  | { outcome: 'reverted'; tip: string; check: string; culprit: string; revertSha: string; fallback?: string }
  | { outcome: 'timeout'; tip: string; boundMs: number }
  | { outcome: 'retry'; tip: string; reason: string }
  | { outcome: 'held'; tip: string; reason: string };

class GateTimeout extends Error {}

/**
 * The measured time of a gate run of the whole catalog: the slowest recent gate run of it (the
 * build, the catalog and the batch's affected tests, under load); with none recent, the
 * diagnostics' catalog time; null when nothing was measured.
 */
export function measuredCatalogMs(record: Pick<GateRecord, 'catalogMs' | 'gateRuns'>, now: number): number | null {
  const recent = (record.gateRuns ?? []).filter(run => now - Date.parse(run.at) < gateRunsMaxAgeMs).map(run => run.ms);
  return recent.length ? Math.max(...recent) : record.catalogMs;
}

/** Whether the gate runs the whole catalog: only when its measured time fits half the gate's limit. */
export function catalogFits(record: Pick<GateRecord, 'catalogMs' | 'gateRuns'>, now: number) {
  const measured = measuredCatalogMs(record, now);
  return measured !== null && measured <= catalogBudgetMs;
}

/** The E2E cases the batch's items bind, with the item that bound each; a reverted item's own cases left main with it. */
function boundCases(record: Pick<GateRecord, 'merges'>, landings: readonly ServeLanding[]): { id: string; item: string }[] {
  const reverted = new Set(record.merges.filter(merge => merge.reverted).map(merge => merge.sha));
  return landings.filter(landing => !reverted.has(landing.sha)).flatMap(landing => landing.item?.criteria.flatMap(criterion => criterion.proofs.filter(proof => proof.startsWith('e2e:')).map(proof => ({ id: proof.slice(4), item: landing.item!.key }))) ?? []);
}
const boundCaseIds = (record: Pick<GateRecord, 'merges'>, landings: readonly ServeLanding[]) => boundCases(record, landings).map(bound => bound.id);

/** The checks one batch runs: the build, the E2E cases (the whole catalog when it fits, else the bound and core ones) and the affected selection. GY-3547: a bound case a later item deleted from the tip's catalog is dropped, with one note. */
export async function gateChecks(ports: Pick<GatePorts, 'catalog' | 'core'>, record: Pick<GateRecord, 'merges' | 'notes'>, tip: string, landings: readonly ServeLanding[], whole: boolean): Promise<string[]> {
  const catalog = await ports.catalog(tip);
  const bound: string[] = [];
  for (const { id, item } of boundCases(record, landings)) {
    if (catalog.includes(id)) bound.push(id);
    else {
      const note = `${id}: ${item} bound this case; it is gone from the catalog, so the gate skips it`.slice(0, 200);
      record.notes = [...new Set([...record.notes ?? [], note])].slice(-filingNotesWindow);
    }
  }
  const cases = [...new Set([...(whole ? catalog : bound), ...await ports.core(tip)])];
  return ['build', ...cases.map(id => `e2e:${id}`), 'affected'];
}

/** The reason an outcome carries: the failing check a revert names, its own reason, or null on a plain pass. */
export function gateOutcomeReason(outcome: GateOutcome): string | null {
  if (outcome.outcome === 'reverted') return `reverted ${outcome.culprit} for failing ${outcome.check}${outcome.fallback ? ` (${outcome.fallback})` : ''}`;
  if (outcome.outcome === 'timeout') return `past ${minutes(outcome.boundMs)} minutes`;
  if (outcome.outcome === 'verified' && outcome.knownFlaky?.length) return `kept the batch: ${outcome.knownFlaky.map(flaky => `${flaky.check} failed and has the open flaky item ${flaky.item}`).join('; ')}`;
  return 'reason' in outcome ? outcome.reason : null;
}

/** The settled batch's E2E cases from its finished steps: a case failing its first run fails only if its re-run failed too. */
function gatedCases(flight: GateRecord['inFlight']): Record<string, 'pass' | 'fail'> | null {
  const key = (checks: readonly string[]) => `${flight?.tip} ${[...checks].sort().join(' ')}`;
  const first = flight?.checks && flight.results?.[key(flight.checks)];
  if (!first) return null;
  const failed = first.length ? flight!.results![key(first)] ?? first : [];
  return Object.fromEntries(flight!.checks!.filter(check => check.startsWith('e2e:')).map(check => [check.slice(4), failed.includes(check) ? 'fail' : 'pass']));
}

/**
 * One gate of the batch from the last verified commit to the main tip, updating `record` in place.
 * Nothing to gate (main is the verified commit, or a held tip has not moved and, for a timeout
 * hold, its cool-off has not passed) answers idle. A batch a
 * previous gate cut and never settled is adopted as it was cut — the same candidate tip, files and
 * checks, its finished steps' results with it — so a loop restart never recuts a batch onto a newer
 * tip: merges that landed meanwhile ride the next batch.
 */
export function runGate(ports: GatePorts, record: GateRecord): Promise<GateOutcome> {
  // A settled gate frees its batch; one that threw leaves it standing for the next loop to adopt.
  // Either way the run's outcome is the record's last (GY-3141), so status names why it ended.
  const finishedAt = () => new Date(ports.now()).toISOString();
  return gateFlight(ports, record).then(
    outcome => {
      const cases = gatedCases(record.inFlight);
      record.inFlight = null;
      if (outcome.outcome !== 'idle') record.lastOutcome = { tip: outcome.tip, outcome: outcome.outcome, reason: gateOutcomeReason(outcome), finishedAt: finishedAt(), ...(cases ? { cases } : {}) };
      return outcome;
    },
    error => {
      record.lastOutcome = { tip: record.inFlight?.tip ?? null, outcome: 'error', reason: error instanceof Error ? error.message : String(error), finishedAt: finishedAt() };
      throw error;
    });
}

async function gateFlight(ports: GatePorts, record: GateRecord): Promise<GateOutcome> {
  const verified = record.verified;
  if (!verified) return { outcome: 'idle' };
  // An adopted batch keeps its candidate tip: the main tip is not fetched, so merges that landed
  // since the cut stay outside the batch and wait for the next one.
  const adopted = record.inFlight && record.inFlight.tip !== verified ? record.inFlight : null;
  const tip = adopted?.tip ?? (await ports.fetch()).toLowerCase();
  if (tip === verified) return { outcome: 'idle' };
  // GY-3383: a hold for a failing case waits for main to move. GY-3444: a timeout hold an older loop
  // wrote clears at once, and the gate runs on main's newest tip.
  const held = record.held;
  if (held && held.tip === tip && !timeoutHold(held)) return { outcome: 'idle' };
  if (held) { record.held = null; record.attempt = { recuts: 0, timeouts: 0 }; }
  const at = () => new Date(ports.now()).toISOString();
  const landings = await ports.landings(verified, tip);
  // The cut is the cut: an adopted batch keeps the files and checks it was cut with, re-derived only
  // when an older loop recorded a batch without them.
  const files = adopted?.files?.length ? adopted.files : await ports.files(verified, tip);
  const whole = adopted?.checks?.length ? adopted.whole ?? false : catalogFits(record, ports.now());
  const checks = adopted?.checks?.length ? adopted.checks : await gateChecks(ports, record, tip, landings, whole);
  const results: Record<string, string[]> = adopted?.results ?? {};
  record.inFlight = adopted ? { ...adopted, files, checks, results, whole } : { tip, startedAt: at(), files, checks, results, whole };
  // GY-3444: the time the loop was down — between its last sight of the run and this adoption — is not the gate's own.
  // GY-3474: the adoption is a sight of the run, so a batch adopted again before its next sight never counts the same gap twice.
  if (adopted?.seenAt) record.inFlight = { ...record.inFlight, seenAt: at(), waitedMs: (adopted.waitedMs ?? 0) + Math.max(0, ports.now() - Date.parse(adopted.seenAt)) };
  await ports.checkpoint?.();
  // The run's current step, named before each phase and kept in the record, so a reader mid-flight sees where the gate is (GY-3141).
  const step = async (label: string) => { record.inFlight = { ...record.inFlight!, step: label.slice(0, 200) }; await ports.checkpoint?.(); };
  // The clock is the batch's own, so a restart between steps never lengthens the gate. GY-3444: it
  // counts the gate's own work — the time its own checks waited to start is added back, and kept
  // on the record so a restart keeps it too.
  const bound = gateBoundMs(record), deadline = () => Date.parse(record.inFlight!.startedAt) + bound + (record.inFlight!.waitedMs ?? 0);
  const finished = results;
  const stepKey = (commit: string, runChecks: readonly string[]) => `${commit} ${[...runChecks].sort().join(' ')}`;
  // A whole-catalog batch run measures the catalog's gate-run time, a timeout its elapsed time.
  const mainKey = stepKey(tip, checks), mainCached = mainKey in finished, mainStarted = ports.now();
  const measure = (ms: number) => { if (whole) record.gateRuns = [...record.gateRuns ?? [], { ms, at: at() }].slice(-gateRunsWindow); };
  const run = (commit: string, runChecks: readonly string[], runFiles: readonly string[]) => {
    const key = stepKey(commit, runChecks);
    if (key in finished) return Promise.resolve(finished[key]!); // a step the last loop finished
    const left = deadline() - ports.now();
    if (left <= 0) return Promise.reject(new GateTimeout());
    let last = ports.now(), saved = last, timer: NodeJS.Timeout | undefined;
    const tick = () => {
      const now = ports.now();
      record.inFlight = { ...record.inFlight!, seenAt: new Date(now).toISOString(), ...(ports.waiting?.() ? { waitedMs: (record.inFlight!.waitedMs ?? 0) + now - last } : {}) };
      last = now;
      if (now - saved >= 30_000) { saved = now; void ports.checkpoint?.(); }
    };
    // The check's budget is the gate's own remaining time (AC-7): the gate's clock stops it, through
    // `stop`, however long its waits run. GY-3509: the trial's own clock is that same remaining time,
    // never a multiple of it, so no runner outlives the 90-minute ceiling.
    const stop = new AbortController();
    return Promise.race([ports.run(commit, runChecks, runFiles, left, stop.signal), new Promise<never>((_, reject) => { timer = setInterval(() => { tick(); if (ports.now() > deadline()) { reject(new GateTimeout()); stop.abort(new GateTimeout()); } }, 1000); })])
      .then(async failed => {
        tick();
        if (ports.now() > deadline()) throw new GateTimeout();
        finished[key] = failed; // the finished step survives a restart
        await ports.checkpoint?.();
        return failed;
      })
      .finally(() => clearInterval(timer));
  };
  const hold = (reason: string): GateOutcome => { record.held = { tip, reason, at: at() }; return { outcome: 'held', tip, reason }; };
  try {
    await step(`running ${checks.length} check(s) on ${tip.slice(0, 12)}`);
    const failed = await run(tip, checks, files);
    if (!mainCached) measure(ports.now() - mainStarted);
    let confirmed: string[] = [], flakes: string[] = [];
    const knownRed: string[] = [], knownFlaky: { check: string; item: string }[] = [];
    if (failed.length) {
      // A failing check runs once more before anything is blamed: a pass is a flake, filed for an owner.
      await step(`re-running ${failed.join(', ')}`);
      const again = await run(tip, failed, files);
      flakes = failed.filter(check => !again.includes(check));
      for (const check of flakes) await fileFailure(ports, record, at(), { key: `flake:${check}`, title: `Flaky check on main: ${check}`, description: `The batch gate's check ${check} failed on ${tip.slice(0, 12)} and passed on its re-run. Make it deterministic.` });
      // The e2e cases that must pass outright (GY-3147): smoke, whatever gate.core names, and every
      // case a batch item binds. A whole-catalog case outside them was red before the batch whenever
      // it is red on the verified commit too, so it is a filed known red, never a revert.
      let outright: Set<string> | null = null;
      const mustPass = async () => outright ??= new Set(['e2e:smoke', ...(await ports.core(tip)).map(id => `e2e:${id}`), ...boundCaseIds(record, landings).map(id => `e2e:${id}`)]);
      for (const check of again) {
        // GY-3431: a check with an open flaky-check item is that item's to fix: the failure is recorded on it and the batch is kept.
        const flakyItem = ports.flaky?.(check);
        if (flakyItem) {
          knownFlaky.push({ check, item: flakyItem });
          const { [flakyItem]: earlier = [], ...others } = record.flaky ?? {};
          record.flaky = Object.fromEntries([...Object.entries(others), [flakyItem, [...earlier, { check, tip, at: at() }].slice(-filingNotesWindow)]].slice(-10));
          continue;
        }
        // A known red is a check that also fails on the last verified commit: an affected test, or a
        // catalog-only e2e case — one no batch item binds, gate.core does not name and smoke is not.
        const catalogOnly = check.startsWith('e2e:') && !(await mustPass()).has(check);
        const featureMap = check === 'e2e:graphyard-feature-map';
        if (featureMap || check.startsWith('test:') || catalogOnly) {
          let failsThere = record.results[verified]?.[check];
          if (failsThere === undefined) { await step(`probing ${check} on the verified commit`); failsThere = (await run(verified, [check], files)).includes(check); }
          (record.results[verified] ??= {})[check] = failsThere;
          await ports.checkpoint?.(); // the probe's verdict is saved to the record before anything is filed (GY-3147)
          if (failsThere) {
            if (featureMap) return hold(`Master fault: ${record.repository}'s real application feature check already fails on the verified commit; repair its serve and feature map before verifying this batch.`);
            knownRed.push(check);
            await fileFailure(ports, record, at(), { key: `known-red:${check}`, title: `Known red on main: ${check}`, description: `${check.startsWith('test:') ? `The test ${check.slice(5)}` : `The E2E case ${check.slice(4)}`} fails on the verified commit ${verified.slice(0, 12)} and on ${tip.slice(0, 12)}. The batch gate exempts it until it is fixed.` });
            continue;
          }
        }
        confirmed.push(check);
      }
    }
    if (!confirmed.length) {
      const reverted = new Set(record.merges.filter(merge => merge.reverted).map(merge => merge.sha));
      record.merges = [...record.merges, ...landings.filter(landing => landing.item && !reverted.has(landing.sha) && !record.merges.some(merge => merge.sha === landing.sha))
        .map(landing => ({ sha: landing.sha, item: landing.item!.key, reverted: false }))].slice(-revertRateWindow);
      record.verifiedRuns = [...record.verifiedRuns ?? [], { ms: ports.now() - Date.parse(record.inFlight!.startedAt) - (record.inFlight!.waitedMs ?? 0), at: at() }].slice(-gateRunsWindow);
      record.verified = tip; record.verifiedAt = at(); record.attempt = { recuts: 0, timeouts: 0 };
      record.results = Object.fromEntries(Object.entries(record.results).filter(([commit]) => commit === tip));
      // GY-3199: the verified commit is published where every install's deploy watch reads it. A
      // failed publish never undoes the verification — it is one gate note, and the loop's catch-up
      // publish retries it.
      try { await ports.publish?.(tip); record.published = tip; } catch (error) {
        record.notes = [...record.notes ?? [], `verified-ref: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200)].slice(-filingNotesWindow);
      }
      return { outcome: 'verified', tip, checks, flakes, knownRed, ...(knownFlaky.length ? { knownFlaky } : {}) };
    }
    const check = confirmed[0]!;
    if (record.attempt.recuts >= 1) return hold(`the recut batch ${tip.slice(0, 12)} still fails ${check}; ${verified.slice(0, 12)} stays served`);
    // The smallest failing prefix in merge order names the culprit: its last item. Only the whole batch failing names the batch's last item.
    const owned = landings.filter((landing): landing is ServeLanding & { item: Work } => !!landing.item && !record.merges.some(merge => merge.sha === landing.sha && merge.reverted));
    if (!owned.length) return hold(`${tip.slice(0, 12)} fails ${check} and no merged item in the batch is left to revert`);
    // GY-3409: a case a batch landing added fails, as missing, on every prefix before it, so the
    // search starts at the landing that added it — and that landing is the fallback when the
    // culprit's revert does not apply.
    const id = check.startsWith('e2e:') ? check.slice(4) : null;
    let introduced: (typeof owned)[number] | undefined;
    if (id && !(await ports.catalog(verified)).includes(id))
      for (const landing of owned) if ((await ports.catalog(landing.sha)).includes(id)) { introduced = landing; break; }
    const searched = introduced ? owned.slice(owned.indexOf(introduced)) : owned;
    let culprit = searched[searched.length - 1]!;
    await step(`bisecting ${check} over the batch's prefixes`);
    for (const landing of searched.slice(0, -1)) if ((await run(landing.sha, [check], files)).includes(check)) { culprit = landing; break; }
    await step(`reverting ${culprit.item.key} for ${check}`);
    let reverted = await ports.revert(culprit, tip, check), fallback: string | undefined;
    if ('held' in reverted && introduced && introduced !== culprit) {
      fallback = `${reverted.held}; reverted ${introduced.item.key}, which added ${check}, instead`;
      culprit = introduced;
      await step(`reverting ${culprit.item.key}, which added ${check}`);
      reverted = await ports.revert(culprit, tip, check);
    }
    if ('held' in reverted) return hold(reverted.held);
    // A push the moving main rejected blames nothing new: the next cycle gates again.
    if ('retry' in reverted) return { outcome: 'retry', tip, reason: reverted.retry };
    record.merges = [...record.merges.filter(merge => merge.sha !== culprit.sha), { sha: culprit.sha, item: culprit.item.key, reverted: true }].slice(-revertRateWindow);
    record.reverts = [...record.reverts ?? [], { item: culprit.item.key, at: at() }].slice(-50);
    record.attempt = { ...record.attempt, recuts: record.attempt.recuts + 1 };
    return { outcome: 'reverted', tip, check, culprit: culprit.item.key, revertSha: reverted.revertSha, ...(fallback ? { fallback } : {}) };
  } catch (error) {
    // GY-3296: a wait for environment capacity or an environment fault blames, fails and reverts nothing: the next cycle gates again.
    if (error instanceof EnvironmentFault) return { outcome: 'retry', tip, reason: error.message };
    if (!(error instanceof GateTimeout)) throw error;
    if (!(mainKey in finished)) measure(ports.now() - Date.parse(record.inFlight.startedAt));
    // A timeout blames nobody and never holds: the loop recuts the batch from main's newest tip at once (GY-3444).
    record.attempt = { ...record.attempt, timeouts: record.attempt.timeouts + 1 };
    return { outcome: 'timeout', tip, boundMs: bound };
  }
}

/** One diagnostic failure as the record keeps it (GY-3264). */
export interface DiagnosticFailure { commit: string; detail: string | null; at: string }

/**
 * The diagnostics' run: the full suite and the whole catalog on the commit, their failures, the
 * catalog's duration, the preview cases' runs and, per failing check, the trial's failing-step text
 * and the last lines of its output (GY-3265), which only the filing carries.
 */
export type DiagnosePort = (commit: string) => Promise<{ failed: string[]; catalogMs: number; previewCases?: PreviewCaseRun[]; details?: Record<string, string>; outputs?: Record<string, string[]> }>;

/** The scheduled diagnostics, when due: each failure files an item; nothing here touches the gate. */
export async function runDiagnostics(ports: Pick<GatePorts, 'now' | 'file'> & { diagnose: DiagnosePort }, record: GateRecord): Promise<string[] | null> {
  const verified = record.verified;
  if (!verified || (record.diagnosticsAt && ports.now() - Date.parse(record.diagnosticsAt) < diagnosticsIntervalMs)) return null;
  const { failed: checks, catalogMs, previewCases = [], details = {}, outputs = {} } = await ports.diagnose(verified);
  const at = new Date(ports.now()).toISOString();
  // A preview case that failed or was not covered reaches an owner like any failing check.
  const failed = [...new Set([...checks, ...previewCases.filter(run => run.verdict !== 'passed').map(run => `e2e:${run.case}`)])];
  // GY-3264: each failure's commit and failing step are recorded before filing, so a check filed
  // before — whose item is reused, never re-filed — still has its newest detail readable in status.
  record.diagnosticFailures = Object.fromEntries(failed.map(check => [check, { commit: verified, detail: details[check]?.slice(0, 1000) ?? null, at }]));
  for (const check of failed) {
    const detail = record.diagnosticFailures[check]!.detail, output = outputs[check]?.length ? `\n\nThe last lines of its output:\n\n\`\`\`\n${outputs[check]!.join('\n').slice(-12_000)}\n\`\`\`` : '';
    await fileFailure(ports, record, at, { key: `diagnostic:${check}`, title: `Diagnostic failure on main: ${check}`,
      description: `The scheduled full run against the verified commit ${verified} failed ${check}${detail ? `: ${detail}` : ''}. It never blocks a gate or a merge; fix it at its cause.${output}` });
  }
  record.catalogMs = catalogMs;
  record.diagnosticsAt = at;
  if (previewCases.length) record.previewCases = Object.fromEntries(previewCases.map(run => [run.case, run]));
  return failed;
}

/** Reverted items over merged items in the last 20 merges. */
export function revertRate(record: Pick<GateRecord, 'merges'> | null) {
  const merges = (record?.merges ?? []).slice(-revertRateWindow), reverted = merges.filter(merge => merge.reverted).length;
  return { reverted, merges: merges.length, rate: merges.length ? reverted / merges.length : 0 };
}

/** What master status shows of the gate. */
export function gateSummary(record: GateRecord | null) {
  if (!record) return null;
  const rate = revertRate(record);
  return { verified: record.verified?.slice(0, 12) ?? null, verifiedAt: record.verifiedAt,
    // GY-3444: a run in flight holds first claim on trial slots and pauses implementation launches until it settles.
    inFlight: record.inFlight ? { tip: record.inFlight.tip.slice(0, 12), startedAt: record.inFlight.startedAt, step: record.inFlight.step ?? null,
      // GY-3474: what its current check is doing — waiting or its run's step — the detached run's own directory name, and the wait its bound leaves out.
      progress: record.inFlight.progress ?? null, run: record.inFlight.run ? basename(record.inFlight.run.directory) : null, waitedMs: record.inFlight.waitedMs ?? 0,
      holds: 'first claim on trial slots; implementation launches paused until the gate settles' } : null,
    // GY-3141: the last settled run's outcome with its reason or failing check, beside the run in flight's current step.
    lastOutcome: record.lastOutcome ? { ...record.lastOutcome, tip: record.lastOutcome.tip ? record.lastOutcome.tip.slice(0, 12) : null } : null,
    held: record.held, revertRate: `${rate.reverted}/${rate.merges}`, diagnosticsAt: record.diagnosticsAt, catalogMs: measuredCatalogMs(record, Date.now()),
    // GY-3193: each preview case's last daily run and verdict; `not covered` when it did not run.
    previewCases: Object.values(record.previewCases ?? {}).map(run => ({ ...run, commit: run.commit.slice(0, 12) })),
    // GY-3264: the latest diagnostic failures with the exact commit, failing step and the item that owns each.
    diagnosticFailures: Object.entries(record.diagnosticFailures ?? {}).map(([check, failure]) => ({ check, ...failure, item: record.filed?.[`diagnostic:${check}`]?.item ?? null })),
    // GY-3147: the filing failures that never aborted a run, newest last.
    notes: record.notes ?? [],
    // GY-3431: the failures the gate recorded on open flaky-check items instead of reverting.
    knownFlaky: Object.entries(record.flaky ?? {}).map(([item, failures]) => ({ item, check: failures.at(-1)!.check, failures: failures.length, lastTip: failures.at(-1)!.tip.slice(0, 12) })) };
}

/** The causes that wake the master: a held batch, and a revert rate above 1 in 5. */
export function gateCauses(record: GateRecord | null): { key: string; detail: string }[] {
  if (!record) return [];
  const rate = revertRate(record);
  return [
    ...(record.held ? [{ key: 'batch-gate', detail: `Batch gate held: ${record.held.reason}` }] : []),
    ...(rate.rate > revertRateLimit ? [{ key: 'revert-rate', detail: `Revert rate ${rate.reverted}/${rate.merges} over the last ${revertRateWindow} merges is above 1 in 5` }] : []),
  ];
}

/** A timeout hold an older loop wrote (GY-3383), read from its words: GY-3444 clears it on the next gate run. */
export const timeoutHold = (held: GateRecord['held']): boolean => !!held && /timed out twice/.test(held.reason);

/** GY-3383: any held gate is one master status attention line naming the hold and its reason, with what clears it. */
export function gateHoldAttention(record: Pick<GateRecord, 'held'> | null, now: number): { subject: string; text: string; next: string }[] {
  const held = record?.held;
  if (!held) return [];
  return [{
    subject: 'the batch gate',
    text: `The batch gate is held on ${held.tip.slice(0, 12)} (for ${formatAge(held.at, now)}): ${held.reason}`,
    next: timeoutHold(held)
      ? 'A timeout is the host, not the change: the gate retries on the newest main within one cycle'
      : 'The hold clears when a merge moves main off the held tip: repair what the reason names',
  }];
}

/** The commit the deploy watch serves for `owner`: the verified one; null while no gate record names that repository (the loop writes it at rollout). */
export function servedVerified(file: string, owner: string | null): string | null {
  const record = readGateRecord(file);
  return record && owner && record.repository?.toLowerCase() === owner.toLowerCase() ? record.verified : null;
}
