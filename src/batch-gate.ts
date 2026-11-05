// Concern: the batch gate on main (GY-3119). Merged work is verified together, one batch at a time,
// before anything serves it. The loop cuts a batch from the main tip whenever merges landed since
// the last verified commit and no gate is in flight, and gates the tip in the private trial
// container (never the served instance): the build, the bound E2E cases of every item in the batch,
// the core cases graphyard.json names in gate.core (Graphyard's: create-work-item and the deploy
// smoke, the `smoke` case: the built candidate serves and answers healthy), and the tests the
// affected selection picks for the changed files — the whole E2E catalog in place of the subset
// when the diagnostics measured it to fit the 45-minute limit. A passing gate records the tip as
// verified in .graphyard/main-gate.json; the deploy watch serves only that commit. A failing check
// is re-run once (a pass is a filed flake), an affected test that also fails on the last verified
// commit is a filed known red, and a confirmed failure is bisected over the batch's prefixes in
// merge order: the last item of the smallest failing prefix is reverted through the serve-revert
// path and the batch recut. A recut that fails again, or a second timeout, holds the last verified
// commit served and wakes the master. The full suite and catalog run daily against the verified
// commit as diagnostics that file items and never block.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Work } from './model.js';
import type { ServeLanding } from './merge-writer/serve-revert.js';

/** How long one gate may run before it counts as failed (gate timeout). */
export const gateLimitMs = 45 * 60_000;
/** How often the full suite and the whole catalog run against the verified commit. */
export const diagnosticsIntervalMs = 24 * 60 * 60_000;
/** The merges the revert rate reads, and the rate above which the master is woken. */
export const revertRateWindow = 20, revertRateLimit = 1 / 5;

/** One merge the gate judged: its landing commit, its item, and whether the gate reverted it. */
export interface GateMerge { sha: string; item: string; reverted: boolean }
/** The gate's persisted state, beside the deploy record. */
export interface GateRecord {
  /** The repository whose main this gates (owner/name), so the deploy watch of another repository never reads it. */
  repository: string | null;
  /** The latest verified commit: the one the deploy watch serves. */
  verified: string | null;
  verifiedAt: string | null;
  /** The gate running now, for status. */
  inFlight: { tip: string; startedAt: string } | null;
  /** The current batch's recuts after a revert and its timeouts; cleared when a gate passes. */
  attempt: { recuts: number; timeouts: number };
  /** A batch that failed again after its recut, or timed out twice: the master is woken; cleared once main moves. */
  held: { tip: string; reason: string; at: string } | null;
  /** Per commit, whether a check fails there (the known-red cache). */
  results: Record<string, Record<string, boolean>>;
  /** The last merges judged, oldest first. */
  merges: GateMerge[];
  /** How long the whole E2E catalog took when the diagnostics last ran it. */
  catalogMs: number | null;
  diagnosticsAt: string | null;
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
  repository, verified: served, verifiedAt: new Date().toISOString(), inFlight: null, attempt: { recuts: 0, timeouts: 0 }, held: null,
  results: {}, merges: [], catalogMs: null, diagnosticsAt: null, at: new Date().toISOString(),
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
   * affected test as `test:<file>`.
   */
  run(commit: string, checks: readonly string[], files: readonly string[]): Promise<string[]>;
  /** Reverts the landing from main through the serve-revert path (trial, leased push, re-land filed); answers the revert, why it is held, or a retry (main moved under the push). */
  revert(landing: ServeLanding & { item: Work }, tip: string, check: string): Promise<{ revertSha: string } | { held: string } | { retry: string }>;
  /** Files an item owning a failure, once per `key`. */
  file(input: { title: string; description: string; key: string }): Promise<void>;
  /** Called once the gate is in flight, so the record can say so. */
  started?(): Promise<void>;
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

/** The checks one batch runs: the build, the E2E cases (the whole catalog when it fits, else the bound and core ones) and the affected selection. */
export async function gateChecks(ports: Pick<GatePorts, 'catalog' | 'core'>, record: Pick<GateRecord, 'catalogMs' | 'merges'>, tip: string, landings: readonly ServeLanding[]): Promise<string[]> {
  // A reverted item's own cases left main with it.
  const reverted = new Set(record.merges.filter(merge => merge.reverted).map(merge => merge.sha));
  const bound = landings.filter(landing => !reverted.has(landing.sha)).flatMap(landing => landing.item?.criteria.flatMap(criterion => criterion.proofs.filter(proof => proof.startsWith('e2e:')).map(proof => proof.slice(4))) ?? []);
  const cases = record.catalogMs !== null && record.catalogMs <= gateLimitMs ? await ports.catalog(tip) : [...bound, ...await ports.core(tip)];
  return ['build', ...[...new Set(cases)].map(id => `e2e:${id}`), 'affected'];
}

/**
 * One gate of the batch from the last verified commit to the main tip, updating `record` in place.
 * Nothing to gate (main is the verified commit, or a held tip has not moved) answers idle.
 */
export async function runGate(ports: GatePorts, record: GateRecord): Promise<GateOutcome> {
  const tip = (await ports.fetch()).toLowerCase(), verified = record.verified;
  if (!verified || tip === verified || record.held?.tip === tip) return { outcome: 'idle' };
  if (record.held) { record.held = null; record.attempt = { recuts: 0, timeouts: 0 }; }
  const at = () => new Date(ports.now()).toISOString();
  const deadline = ports.now() + gateLimitMs;
  const run = (commit: string, checks: readonly string[], files: readonly string[]) => {
    const left = deadline - ports.now();
    if (left <= 0) return Promise.reject(new GateTimeout());
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([ports.run(commit, checks, files), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new GateTimeout()), left); })])
      .then(failed => { if (ports.now() > deadline) throw new GateTimeout(); return failed; }).finally(() => clearTimeout(timer));
  };
  const hold = (reason: string): GateOutcome => { record.held = { tip, reason, at: at() }; return { outcome: 'held', tip, reason }; };
  const landings = await ports.landings(verified, tip);
  const files = await ports.files(verified, tip);
  const checks = await gateChecks(ports, record, tip, landings);
  record.inFlight = { tip, startedAt: at() };
  try {
    await ports.started?.();
    const failed = await run(tip, checks, files);
    let confirmed: string[] = [], flakes: string[] = [];
    const knownRed: string[] = [];
    if (failed.length) {
      // A failing check runs once more before anything is blamed: a pass is a flake, filed for an owner.
      const again = await run(tip, failed, files);
      flakes = failed.filter(check => !again.includes(check));
      for (const check of flakes) await ports.file({ key: `flake:${check}`, title: `Flaky check on main: ${check}`, description: `The batch gate's check ${check} failed on ${tip.slice(0, 12)} and passed on its re-run. Make it deterministic.` });
      for (const check of again) {
        // Only an affected test may be a known red: one that also fails on the last verified commit.
        if (check.startsWith('test:')) {
          const cached = record.results[verified]?.[check];
          const failsThere = cached ?? (await run(verified, [check], files)).includes(check);
          (record.results[verified] ??= {})[check] = failsThere;
          if (failsThere) {
            knownRed.push(check);
            await ports.file({ key: `known-red:${check}`, title: `Known red on main: ${check}`, description: `The test ${check.slice(5)} fails on the verified commit ${verified.slice(0, 12)} and on ${tip.slice(0, 12)}. The batch gate exempts it until it is fixed.` });
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
      return { outcome: 'verified', tip, checks, flakes, knownRed };
    }
    const check = confirmed[0]!;
    if (record.attempt.recuts >= 1) return hold(`the recut batch ${tip.slice(0, 12)} still fails ${check}; ${verified.slice(0, 12)} stays served`);
    // The smallest failing prefix in merge order names the culprit: its last item. Only the whole batch failing names the batch's last item.
    const owned = landings.filter((landing): landing is ServeLanding & { item: Work } => !!landing.item && !record.merges.some(merge => merge.sha === landing.sha && merge.reverted));
    if (!owned.length) return hold(`${tip.slice(0, 12)} fails ${check} and no merged item in the batch is left to revert`);
    let culprit = owned[owned.length - 1]!;
    for (const landing of owned.slice(0, -1)) if ((await run(landing.sha, [check], files)).includes(check)) { culprit = landing; break; }
    const reverted = await ports.revert(culprit, tip, check);
    if ('held' in reverted) return hold(reverted.held);
    // A push the moving main rejected blames nothing new: the next cycle gates again.
    if ('retry' in reverted) return { outcome: 'retry', tip, reason: reverted.retry };
    record.merges = [...record.merges.filter(merge => merge.sha !== culprit.sha), { sha: culprit.sha, item: culprit.item.key, reverted: true }].slice(-revertRateWindow);
    record.attempt = { ...record.attempt, recuts: record.attempt.recuts + 1 };
    return { outcome: 'reverted', tip, check, culprit: culprit.item.key, revertSha: reverted.revertSha };
  } catch (error) {
    if (!(error instanceof GateTimeout)) throw error;
    // A timeout blames nobody: the batch is recut once, and a second timeout holds.
    record.attempt = { ...record.attempt, timeouts: record.attempt.timeouts + 1 };
    if (record.attempt.timeouts >= 2) return hold(`the batch gate timed out twice (past ${gateLimitMs / 60_000} minutes) on ${tip.slice(0, 12)}; ${verified.slice(0, 12)} stays served`);
    return { outcome: 'timeout', tip };
  } finally {
    record.inFlight = null;
  }
}

/** The diagnostics' run: the full suite and the whole catalog on the commit, their failures and the catalog's duration. */
export type DiagnosePort = (commit: string) => Promise<{ failed: string[]; catalogMs: number }>;

/** The scheduled diagnostics, when due: each failure files an item; nothing here touches the gate. */
export async function runDiagnostics(ports: Pick<GatePorts, 'now' | 'file'> & { diagnose: DiagnosePort }, record: GateRecord): Promise<string[] | null> {
  const verified = record.verified;
  if (!verified || (record.diagnosticsAt && ports.now() - Date.parse(record.diagnosticsAt) < diagnosticsIntervalMs)) return null;
  const { failed, catalogMs } = await ports.diagnose(verified);
  for (const check of failed) await ports.file({ key: `diagnostic:${check}`, title: `Diagnostic failure on main: ${check}`, description: `The scheduled full run against the verified commit ${verified.slice(0, 12)} failed ${check}. It never blocks a gate or a merge; fix it at its cause.` });
  record.catalogMs = catalogMs;
  record.diagnosticsAt = new Date(ports.now()).toISOString();
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
  return { verified: record.verified?.slice(0, 12) ?? null, verifiedAt: record.verifiedAt, inFlight: record.inFlight ? { tip: record.inFlight.tip.slice(0, 12), startedAt: record.inFlight.startedAt } : null,
    held: record.held, revertRate: `${rate.reverted}/${rate.merges}`, diagnosticsAt: record.diagnosticsAt };
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
