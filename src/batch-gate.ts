// Concern: the batch gate on main (GY-3119). Merged work is verified together, one batch at a time,
// before anything serves it. The loop cuts a batch from the main tip whenever merges landed since
// the last verified commit and no gate is in flight, and gates the tip in the private trial
// container (never the served instance): the build, the bound E2E cases of every item in the batch,
// the core cases graphyard.json names in gate.core (Graphyard's: create-work-item and the deploy
// smoke, the `smoke` case: the built candidate serves and answers healthy), and the tests the
// affected selection picks for the changed files — the whole E2E catalog in place of the subset
// only when its measured gate-run time fits half the 45-minute limit (GY-3144). A passing gate records the tip as
// verified in .graphyard/main-gate.json; the deploy watch serves only that commit. A failing check
// is re-run once (a pass is a filed flake), an affected test — or, when the whole catalog ran, a
// catalog case no batch item binds, gate.core does not name and smoke is not (GY-3147) — that also
// fails on the last verified commit is a filed known red, and a confirmed failure is bisected over the batch's prefixes in
// merge order: the last item of the smallest failing prefix is reverted through the serve-revert
// path and the batch recut. A recut that fails again, or a second timeout, holds the last verified
// commit served and wakes the master. The full suite and catalog run daily against the verified
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
import { dirname, join } from 'node:path';
import type { Work } from './model.js';
import type { ServeLanding } from './merge-writer/serve-revert.js';
import type { PreviewCaseRun } from './merge-writer/served-previews.js';

/** How long one gate may run before it counts as failed (gate timeout). */
export const gateLimitMs = 45 * 60_000;
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
  inFlight: { tip: string; startedAt: string; files?: string[]; checks?: string[]; results?: Record<string, string[]>; whole?: boolean; /** The run's current step, named before each phase (GY-3141). */ step?: string } | null;
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
  /** A batch that failed again after its recut, or timed out twice: the master is woken; cleared once main moves. */
  held: { tip: string; reason: string; at: string } | null;
  /** Per commit, whether a check fails there (the known-red cache: an affected test, or a catalog-only e2e case). */
  results: Record<string, Record<string, boolean>>;
  /** The last merges judged, oldest first. */
  merges: GateMerge[];
  /** How long the whole E2E catalog took when the diagnostics last ran it. */
  catalogMs: number | null;
  /**
   * The recent gate runs of the whole catalog, newest last: how long each batch run of the build,
   * the whole catalog and the batch's affected tests took under real load, a timeout counting its
   * elapsed time. Optional only for records an older loop wrote.
   */
  gateRuns?: { ms: number; at: string }[];
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
  run(commit: string, checks: readonly string[], files: readonly string[], timeoutMs: number): Promise<string[]>;
  /** Reverts the landing from main through the serve-revert path (trial, leased push, re-land filed); answers the revert, why it is held, or a retry (main moved under the push). */
  revert(landing: ServeLanding & { item: Work }, tip: string, check: string): Promise<{ revertSha: string } | { held: string } | { retry: string }>;
  /** Files an item owning a failure, once per `key`; answers the item it filed, when it names one. */
  file(input: { title: string; description: string; key: string }): Promise<{ item: string | null } | void>;
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
  | { outcome: 'verified'; tip: string; checks: string[]; flakes: string[]; knownRed: string[] }
  | { outcome: 'reverted'; tip: string; check: string; culprit: string; revertSha: string }
  | { outcome: 'timeout'; tip: string }
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

/** The E2E cases the batch's items bind; a reverted item's own cases left main with it. */
function boundCaseIds(record: Pick<GateRecord, 'merges'>, landings: readonly ServeLanding[]): string[] {
  const reverted = new Set(record.merges.filter(merge => merge.reverted).map(merge => merge.sha));
  return landings.filter(landing => !reverted.has(landing.sha)).flatMap(landing => landing.item?.criteria.flatMap(criterion => criterion.proofs.filter(proof => proof.startsWith('e2e:')).map(proof => proof.slice(4))) ?? []);
}

/** The checks one batch runs: the build, the E2E cases (the whole catalog when it fits, else the bound and core ones) and the affected selection. */
export async function gateChecks(ports: Pick<GatePorts, 'catalog' | 'core'>, record: Pick<GateRecord, 'merges'>, tip: string, landings: readonly ServeLanding[], whole: boolean): Promise<string[]> {
  const cases = whole ? await ports.catalog(tip) : [...new Set([...boundCaseIds(record, landings), ...await ports.core(tip)])];
  return ['build', ...[...new Set(cases)].map(id => `e2e:${id}`), 'affected'];
}

/** The reason an outcome carries: the failing check a revert names, its own reason, or null on a plain pass. */
export function gateOutcomeReason(outcome: GateOutcome): string | null {
  if (outcome.outcome === 'reverted') return `reverted ${outcome.culprit} for failing ${outcome.check}`;
  if (outcome.outcome === 'timeout') return `past ${gateLimitMs / 60_000} minutes`;
  return 'reason' in outcome ? outcome.reason : null;
}

/**
 * One gate of the batch from the last verified commit to the main tip, updating `record` in place.
 * Nothing to gate (main is the verified commit, or a held tip has not moved) answers idle. A batch a
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
      record.inFlight = null;
      if (outcome.outcome !== 'idle') record.lastOutcome = { tip: outcome.tip, outcome: outcome.outcome, reason: gateOutcomeReason(outcome), finishedAt: finishedAt() };
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
  if (tip === verified || record.held?.tip === tip) return { outcome: 'idle' };
  if (record.held) { record.held = null; record.attempt = { recuts: 0, timeouts: 0 }; }
  const at = () => new Date(ports.now()).toISOString();
  const landings = await ports.landings(verified, tip);
  // The cut is the cut: an adopted batch keeps the files and checks it was cut with, re-derived only
  // when an older loop recorded a batch without them.
  const files = adopted?.files?.length ? adopted.files : await ports.files(verified, tip);
  const whole = adopted?.checks?.length ? adopted.whole ?? false : catalogFits(record, ports.now());
  const checks = adopted?.checks?.length ? adopted.checks : await gateChecks(ports, record, tip, landings, whole);
  const results: Record<string, string[]> = adopted?.results ?? {};
  record.inFlight = adopted ? { ...adopted, files, checks, results, whole } : { tip, startedAt: at(), files, checks, results, whole };
  if (!adopted) await ports.checkpoint?.();
  // The run's current step, named before each phase and kept in the record, so a reader mid-flight sees where the gate is (GY-3141).
  const step = async (label: string) => { record.inFlight = { ...record.inFlight!, step: label.slice(0, 200) }; await ports.checkpoint?.(); };
  // The clock is the batch's own, so a restart between steps never lengthens the gate.
  const deadline = Date.parse(record.inFlight.startedAt) + gateLimitMs;
  const finished = results;
  const stepKey = (commit: string, runChecks: readonly string[]) => `${commit} ${[...runChecks].sort().join(' ')}`;
  // A whole-catalog batch run measures the catalog's gate-run time, a timeout its elapsed time.
  const mainKey = stepKey(tip, checks), mainCached = mainKey in finished, mainStarted = ports.now();
  const measure = (ms: number) => { if (whole) record.gateRuns = [...record.gateRuns ?? [], { ms, at: at() }].slice(-gateRunsWindow); };
  const run = (commit: string, runChecks: readonly string[], runFiles: readonly string[]) => {
    const key = stepKey(commit, runChecks);
    if (key in finished) return Promise.resolve(finished[key]!); // a step the last loop finished
    const left = deadline - ports.now();
    if (left <= 0) return Promise.reject(new GateTimeout());
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([ports.run(commit, runChecks, runFiles, left), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new GateTimeout()), left); })])
      .then(async failed => {
        if (ports.now() > deadline) throw new GateTimeout();
        finished[key] = failed; // the finished step survives a restart
        await ports.checkpoint?.();
        return failed;
      })
      .finally(() => clearTimeout(timer));
  };
  const hold = (reason: string): GateOutcome => { record.held = { tip, reason, at: at() }; return { outcome: 'held', tip, reason }; };
  try {
    await step(`running ${checks.length} check(s) on ${tip.slice(0, 12)}`);
    const failed = await run(tip, checks, files);
    if (!mainCached) measure(ports.now() - mainStarted);
    let confirmed: string[] = [], flakes: string[] = [];
    const knownRed: string[] = [];
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
        // A known red is a check that also fails on the last verified commit: an affected test, or a
        // catalog-only e2e case — one no batch item binds, gate.core does not name and smoke is not.
        const catalogOnly = check.startsWith('e2e:') && !(await mustPass()).has(check);
        if (check.startsWith('test:') || catalogOnly) {
          let failsThere = record.results[verified]?.[check];
          if (failsThere === undefined) { await step(`probing ${check} on the verified commit`); failsThere = (await run(verified, [check], files)).includes(check); }
          (record.results[verified] ??= {})[check] = failsThere;
          await ports.checkpoint?.(); // the probe's verdict is saved to the record before anything is filed (GY-3147)
          if (failsThere) {
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
      record.verified = tip; record.verifiedAt = at(); record.attempt = { recuts: 0, timeouts: 0 };
      record.results = Object.fromEntries(Object.entries(record.results).filter(([commit]) => commit === tip));
      // GY-3199: the verified commit is published where every install's deploy watch reads it. A
      // failed publish never undoes the verification — it is one gate note, and the loop's catch-up
      // publish retries it.
      try { await ports.publish?.(tip); record.published = tip; } catch (error) {
        record.notes = [...record.notes ?? [], `verified-ref: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200)].slice(-filingNotesWindow);
      }
      return { outcome: 'verified', tip, checks, flakes, knownRed };
    }
    const check = confirmed[0]!;
    if (record.attempt.recuts >= 1) return hold(`the recut batch ${tip.slice(0, 12)} still fails ${check}; ${verified.slice(0, 12)} stays served`);
    // The smallest failing prefix in merge order names the culprit: its last item. Only the whole batch failing names the batch's last item.
    const owned = landings.filter((landing): landing is ServeLanding & { item: Work } => !!landing.item && !record.merges.some(merge => merge.sha === landing.sha && merge.reverted));
    if (!owned.length) return hold(`${tip.slice(0, 12)} fails ${check} and no merged item in the batch is left to revert`);
    let culprit = owned[owned.length - 1]!;
    await step(`bisecting ${check} over the batch's prefixes`);
    for (const landing of owned.slice(0, -1)) if ((await run(landing.sha, [check], files)).includes(check)) { culprit = landing; break; }
    await step(`reverting ${culprit.item.key} for ${check}`);
    const reverted = await ports.revert(culprit, tip, check);
    if ('held' in reverted) return hold(reverted.held);
    // A push the moving main rejected blames nothing new: the next cycle gates again.
    if ('retry' in reverted) return { outcome: 'retry', tip, reason: reverted.retry };
    record.merges = [...record.merges.filter(merge => merge.sha !== culprit.sha), { sha: culprit.sha, item: culprit.item.key, reverted: true }].slice(-revertRateWindow);
    record.attempt = { ...record.attempt, recuts: record.attempt.recuts + 1 };
    return { outcome: 'reverted', tip, check, culprit: culprit.item.key, revertSha: reverted.revertSha };
  } catch (error) {
    if (!(error instanceof GateTimeout)) throw error;
    if (!(mainKey in finished)) measure(ports.now() - Date.parse(record.inFlight.startedAt));
    // A timeout blames nobody: the batch is recut once, and a second timeout holds.
    record.attempt = { ...record.attempt, timeouts: record.attempt.timeouts + 1 };
    if (record.attempt.timeouts >= 2) return hold(`the batch gate timed out twice (past ${gateLimitMs / 60_000} minutes) on ${tip.slice(0, 12)}; ${verified.slice(0, 12)} stays served`);
    return { outcome: 'timeout', tip };
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
    inFlight: record.inFlight ? { tip: record.inFlight.tip.slice(0, 12), startedAt: record.inFlight.startedAt, step: record.inFlight.step ?? null } : null,
    // GY-3141: the last settled run's outcome with its reason or failing check, beside the run in flight's current step.
    lastOutcome: record.lastOutcome ? { ...record.lastOutcome, tip: record.lastOutcome.tip ? record.lastOutcome.tip.slice(0, 12) : null } : null,
    held: record.held, revertRate: `${rate.reverted}/${rate.merges}`, diagnosticsAt: record.diagnosticsAt, catalogMs: measuredCatalogMs(record, Date.now()),
    // GY-3193: each preview case's last daily run and verdict; `not covered` when it did not run.
    previewCases: Object.values(record.previewCases ?? {}).map(run => ({ ...run, commit: run.commit.slice(0, 12) })),
    // GY-3264: the latest diagnostic failures with the exact commit, failing step and the item that owns each.
    diagnosticFailures: Object.entries(record.diagnosticFailures ?? {}).map(([check, failure]) => ({ check, ...failure, item: record.filed?.[`diagnostic:${check}`]?.item ?? null })),
    // GY-3147: the filing failures that never aborted a run, newest last.
    notes: record.notes ?? [] };
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

/** The commit the deploy watch serves for `owner`: the verified one; null while no gate record names that repository (the loop writes it at rollout). */
export function servedVerified(file: string, owner: string | null): string | null {
  const record = readGateRecord(file);
  return record && owner && record.repository?.toLowerCase() === owner.toLowerCase() ? record.verified : null;
}
