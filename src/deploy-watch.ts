// The continuous deploy builds, restarts and checks health before publishing the ready CLI.
// Failed builds leave the healthy pairing alone; failed restarts use schema-aware rollback.
// The master loop restarts onto the serving tip recorded here (daemon/run.ts restartCause).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { GitRunner } from './merge-writer/local-observation.js';
import { serveRecordPath, readServeRecord, type ServeCheck } from './serve-app.js';
import { servedVerified } from './batch-gate.js';
import { graphyardRepository } from './scenarios.js';

/**
 * What the deploy last served, the tip that failed and is skipped until the base moves past it, and,
 * while a rollback has not yet succeeded, the tip still to restore (tip is then null: nothing is served).
 * `repository` names the repository the watch serves — its origin's owner/name — so a record for one
 * repository cannot pass for another's release health; records written before it was kept (or by a
 * checkout whose origin names no repository) name none (GY-2955).
 */
export interface DeployRecord { tip: string | null; failed: string | null; reason: string | null; at: string; restore?: string | null; attempts?: number; repository?: string | null; /** This successful deploy selected a batch-gate verified tip. */ verified?: boolean }
export const deployRecordPath = (root: string) => join(root, '.graphyard', 'deploy.json');
export function readDeployRecord(file: string): DeployRecord | null {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')) as DeployRecord; } catch { return null; }
}
async function writeDeployRecord(file: string, record: Omit<DeployRecord, 'at'>) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify({ ...record, reason: record.reason?.slice(0, 2000) ?? null, at: new Date().toISOString() }, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

/**
 * The control plane's own update record (GY-3199), beside the deploy record but never standing in
 * for it: the Graphyard commit this install's server, loop and CLI run, when the watch last
 * checked for a verified commit, when it last moved the control plane, and the step of the last
 * failed upgrade. The deploy record stays the managed repository's serving and rollback state;
 * this is the control plane's update clock, which master status and the daily diagnostics read.
 */
export interface ControlPlaneRecord {
  /** The Graphyard commit the control plane runs; null before the first pass learned one. */
  commit: string | null;
  /** When the watch last completed a check for a verified commit. */
  checkedAt: string | null;
  /** When the control plane last moved to a new Graphyard commit. */
  updatedAt: string | null;
  /** The latest verified commit the check has seen, and when this install first saw it: the ref carries no publication time, so the first sighting is the staleness clock. */
  verified: string | null;
  verifiedSeenAt: string | null;
  /** The step of the last failed control-plane upgrade, why it failed, and when; null after a passing one. */
  failedStep: string | null;
  failedReason: string | null;
  failedAt: string | null;
  at: string;
}
export const controlPlaneRecordPath = (root: string) => join(root, '.graphyard', 'control-plane.json');
export function readControlPlaneRecord(file: string): ControlPlaneRecord | null {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')) as ControlPlaneRecord; } catch { return null; }
}
export async function writeControlPlaneRecord(file: string, record: Omit<Partial<ControlPlaneRecord>, 'at'>) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

/** A control-plane upgrade that failed retries once its failure is this old: the pass cadence keeps a day the ceiling (GY-3199). */
export const controlPlaneRetryMs = 60 * 60_000;
/** How old a check, or a first sighting of an unrun verified commit, may be before the daily diagnostics reports it (GY-3199). */
export const controlPlaneStaleAfterMs = 24 * 60 * 60_000;

/** The control plane's staleness, as the daily diagnostics reports it: a check over a day old, or a verified commit first seen over a day ago that the install still does not run. */
export function controlPlaneStaleLines(record: ControlPlaneRecord | null, now: number): string[] {
  if (!record) return [];
  const age = (at: string) => {
    const ms = now - Date.parse(at);
    return Number.isFinite(ms) ? ms : null;
  };
  const checked = record.checkedAt ? age(record.checkedAt) : null;
  const seen = record.verifiedSeenAt ? age(record.verifiedSeenAt) : null;
  return [
    ...(checked !== null && checked > controlPlaneStaleAfterMs ? [`the last check for a verified Graphyard commit is ${Math.round(checked / 3_600_000)} hours old (over 24 hours)`] : []),
    ...(record.verified && record.commit !== record.verified && seen !== null && seen > controlPlaneStaleAfterMs
      ? [`the control plane still runs ${record.commit?.slice(0, 12) ?? 'no recorded commit'} while the verified commit ${record.verified.slice(0, 12)} was first seen ${Math.round(seen / 3_600_000)} hours ago (over 24 hours)`]
      : []),
  ];
}

/** What master status shows of the control plane's own update record (GY-3199), with the staleness the daily diagnostics reports. */
export function controlPlaneSummary(record: ControlPlaneRecord | null, now: number) {
  if (!record) return null;
  const short = (sha: string | null) => sha ? sha.slice(0, 12) : null;
  return { commit: short(record.commit), checkedAt: record.checkedAt, updatedAt: record.updatedAt,
    verified: short(record.verified), verifiedSeenAt: record.verifiedSeenAt,
    failedStep: record.failedStep, failedReason: record.failedReason,
    stale: controlPlaneStaleLines(record, now) };
}

/** What one deploy runs a commit through, each throwing its failure's reason. */
export interface DeployWatchPorts {
  /** Fetches origin and answers the base branch's tip. */
  fetch(): Promise<string>;
  /**
   * GY-3199: the latest batch-gate-verified Graphyard commit as `refs/graphyard/verified` on
   * Graphyard's canonical upstream names it — a constant in the code, fetched with the host's
   * existing git access; null when the ref resolves to nothing. An install that does not gate
   * Graphyard itself serves only this commit, never the fetched main tip. Absent, the watch
   * deploys the fetched tip as before.
   */
  verifiedUpstream?(): Promise<string | null>;
  /** The commit the checkout holds now: the tip served before the watch recorded one. */
  head(): Promise<string>;
  /** Publishes the ready CLI after health; production ports move a pointer, preserving loaded trees. */
  checkout(commit: string): Promise<void>;
  /** Builds the commit in the deploy's own build checkout; the watched checkout does not move for this. */
  build(commit: string): Promise<void>;
  /** Restarts the container or unit the control plane runs in. */
  restart(commit: string): Promise<void>;
  /** /healthz answers healthy at the commit. */
  health(commit: string): Promise<void>;
  /** The first commit is an ancestor of, or equal to, the second: the second contains it. */
  contains?(ancestor: string, commit: string): Promise<boolean>;
  /** Advances the known-good coordinator pin the loop's unit loads, so the loop's restart loads the commit. */
  pin(commit: string): Promise<void>;
  /** After a verified deploy, removes the per-commit images of every commit but these (the serving tip and the previous one). */
  prune(keep: string[]): Promise<void>;
  /** The schema generation a commit's code migrates to, read from its source; null when it names none. */
  schema(commit: string): Promise<number | null>;
  /** The database's schema generation, or null when it cannot be read. */
  database(): Promise<number | null>;
}
// Publication follows strict server health; production ports atomically select a retained artifact.
const steps = ['build', 'restart', 'health', 'checkout', 'pin'] as const;
/** Rollback attempts before the watch stops retrying one and waits for the base to move. */
export const rollbackAttempts = 5;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * One pass: fetch, and when the base tip (the batch gate's latest verified commit, once the gate
 * names this repository) is new, deploy it. A failure at any step rolls back to the
 * previous tip through the same steps and records the failed tip, which waits for the next one —
 * unless the failed deploy may have migrated the database, which the previous tip would refuse: a
 * failure from the restart on whose tip's code migrates past the previous tip's is kept and recorded
 * as served, unless the database reads at a generation the previous tip supports. A rollback that
 * fails is retried on later passes, up to rollbackAttempts, and is recorded as served only once it
 * succeeds; a new base tip is deployed in its place.
 *
 * GY-3199: an install that does not gate this checkout's repository — every install for another
 * repository — serves only the commit Graphyard's own gate publishes at refs/graphyard/verified on
 * its canonical upstream, never a fetched main tip the gate has not verified; a failed upgrade
 * retries once its failure is an hour old. Every pass writes the control plane's own record
 * (.graphyard/control-plane.json: the commit it runs, last check, last update, last failed step),
 * separate from the deploy record.
 */
export async function deployOnce(file: string, ports: DeployWatchPorts, log: (line: string) => void = line => console.error(line), owner: string | null = null): Promise<'unchanged' | 'deployed' | 'rolled-back' | 'kept' | 'restoring'> {
  // GY-3119: once the loop's batch gate names this repository, only its latest verified commit serves, never the fetched main tip.
  const fetched = await ports.fetch();
  const verified = servedVerified(join(dirname(file), 'main-gate.json'), owner);
  const followsUpstream = !verified && !!ports.verifiedUpstream && owner?.toLowerCase() === graphyardRepository;
  const upstream = followsUpstream ? await ports.verifiedUpstream!() : null;
  const gated = verified ?? upstream;
  const tip = verified ?? (followsUpstream ? upstream : fetched) as string | null;
  const controlFile = controlPlaneRecordPath(dirname(dirname(file)));
  let stored = readDeployRecord(file);
  // A failed control-plane upgrade retries once its failure is an hour old: the verified ref it failed
  // on may not move for days, and a stuck install must not wait for it to.
  if (followsUpstream && stored?.failed === tip && !stored.restore) {
    const control = readControlPlaneRecord(controlFile);
    if (control?.failedAt && Date.now() - Date.parse(control.failedAt) >= controlPlaneRetryMs) stored = { ...stored, failed: null };
  }
  const record = stored ?? { tip: await ports.head(), failed: null, reason: null, at: '' };
  const previous = record.restore ?? record.tip;
  const write = (entry: Omit<DeployRecord, 'at' | 'repository'>) => writeDeployRecord(file, { ...entry, repository: owner });
  const noteControl = async (entry: Partial<Omit<ControlPlaneRecord, 'at'>>) => {
    const current = readControlPlaneRecord(controlFile) ?? { commit: previous, checkedAt: null, updatedAt: null, verified: null, verifiedSeenAt: null, failedStep: null, failedReason: null, failedAt: null };
    await writeControlPlaneRecord(controlFile, { ...current, commit: current.commit ?? previous, ...entry });
  };
  const run = async (commit: string) => { for (const step of steps) { log(`[graphyard-deploy] ${step} ${commit.slice(0, 12)}`); try { await ports[step](commit); } catch (error) { throw Object.assign(new Error(`${step} failed: ${message(error)}`), { step }); } } };
  const restore = async (previous: string, failed: string, reason: string, attempts: number) => {
    try { await run(previous); } catch (error) {
      log(`[graphyard-deploy] the rollback to ${previous.slice(0, 12)} failed (attempt ${attempts}): ${message(error)}`);
      await write({ tip: null, failed, restore: previous, attempts, reason: `${reason}; the rollback to ${previous.slice(0, 12)} failed (attempt ${attempts} of ${rollbackAttempts}): ${message(error)}` });
      return 'restoring' as const;
    }
    await write({ tip: previous, failed, reason });
    return 'rolled-back' as const;
  };
  // The check itself is a fact of the record: when it ran and which verified commit it saw (the
  // first sighting of a new one starts the staleness clock, GY-3199).
  {
    const current = readControlPlaneRecord(controlFile);
    const firstSeen = current?.verified !== gated && gated ? new Date().toISOString() : current?.verifiedSeenAt ?? null;
    await noteControl({ checkedAt: new Date().toISOString(), verified: gated, verifiedSeenAt: firstSeen });
  }
  // Nothing verified to adopt upstream: never fall back to a main tip the gate has not verified.
  if (tip === null) return 'unchanged';
  if (record.restore && tip === record.failed) {
    const attempts = (record.attempts ?? 0) + 1;
    if (attempts > rollbackAttempts) return 'unchanged';
    return restore(record.restore, tip, record.reason ?? '', attempts);
  }
  // GY-3137: serving only moves forward: a verified commit the served one already contains (or that diverges from it) never deploys.
  const behind = gated && previous && tip !== previous && ports.contains ? !(await ports.contains(previous, tip).catch(() => false)) : false;
  if (behind) return 'unchanged';
  if (tip === previous || tip === record.failed) {
    // The base tip is what the checkout already serves: nothing to deploy, but a record an older
    // watcher left without the repository it serves gains the name on this first pass, so master
    // status reads the serving commit before the next merge rewrites the record (GY-2957).
    if (stored && stored.tip === tip && (stored.repository ?? null) !== owner) await write({ tip, failed: stored.failed, reason: stored.reason, restore: stored.restore, attempts: stored.attempts });
    return 'unchanged';
  }
  const before = await ports.database().catch(() => null);
  try {
    await run(tip);
    await write({ tip, failed: null, reason: null, verified: gated === tip });
    await noteControl({ commit: tip, updatedAt: new Date().toISOString(), failedStep: null, failedReason: null, failedAt: null });
    log(`[graphyard-deploy] serving ${tip.slice(0, 12)}`);
    await ports.prune(previous ? [tip, previous] : [tip]);
    return 'deployed';
  } catch (error) {
    const reason = message(error), step = (error as { step?: string }).step;
    const failedControl = () => noteControl({ failedStep: step ?? null, failedReason: reason.slice(0, 2000), failedAt: new Date().toISOString() });
    if (!previous) { await write({ tip: null, failed: tip, reason }); await failedControl(); return 'rolled-back'; }
    if (step === 'build') {
      // No server or published CLI changed: leave the healthy pairing running.
      await write({ tip: previous, failed: tip, reason });
      await failedControl();
      return 'rolled-back';
    }
    // From the restart on — health and, since GY-2978, the checkout move too — the server has started on the tip's
    // code, which may have migrated the database; the previous tip runs only on a generation it supports.
    {
      const [after, supported, migrates] = await Promise.all([ports.database().catch(() => null), ports.schema(previous).catch(() => null), ports.schema(tip).catch(() => null)]);
      const ceiling = supported ?? before, reached = after ?? migrates;
      if (ceiling === null || reached === null || reached > ceiling) {
        const why = after !== null && before !== null && after > before ? `it migrated the database from generation ${before} to ${after}` : `the database may be at generation ${reached ?? 'unknown'}, past the ${ceiling ?? 'unknown'} the previous tip supports`;
        log(`[graphyard-deploy] ${tip.slice(0, 12)} ${reason}; kept: ${why}, which the previous tip would refuse`);
        await ports.pin(tip).catch(failed => log(`[graphyard-deploy] the pin of ${tip.slice(0, 12)} failed: ${message(failed)}`));
        // The server serves the kept tip, so the CLI checkout follows it too, best-effort like the pin.
        await ports.checkout(tip).catch(failed => log(`[graphyard-deploy] the checkout of ${tip.slice(0, 12)} failed: ${message(failed)}`));
        await write({ tip, failed: null, reason: `${reason}; kept because ${why}` });
        await noteControl({ commit: tip, updatedAt: new Date().toISOString(), failedStep: null, failedReason: null, failedAt: null });
        return 'kept';
      }
    }
    log(`[graphyard-deploy] ${tip.slice(0, 12)} ${reason}; rolling back to ${previous.slice(0, 12)}`);
    const outcome = await restore(previous, tip, reason, 1);
    await failedControl();
    return outcome;
  }
}

/**
 * `upgrade --watch`: a pass every interval until stopped; a pass that throws (a fetch that failed) is logged and retried.
 * `repository` is the record's owner: the repository the watch serves. `handover` runs after a pass
 * served a new tip; it may stop the watch by throwing, so the process that restarts it loads the
 * code the checkout published — the watch runs the code it deploys (GY-3123).
 */
export async function watchMain(file: string, ports: DeployWatchPorts, options: { intervalMs: number; once?: boolean; signal?: AbortSignal; log?: (line: string) => void; repository?: string | null; handover?: (tip: string) => Promise<void> }) {
  const log = options.log ?? (line => console.error(line));
  for (;;) {
    let served: Awaited<ReturnType<typeof deployOnce>> | undefined;
    try { served = await deployOnce(file, ports, log, options.repository ?? null); } catch (error) { log(`[graphyard-deploy] the pass failed and runs again: ${error instanceof Error ? error.message : String(error)}`); }
    if ((served === 'deployed' || served === 'kept') && options.handover) await options.handover(readDeployRecord(file)?.tip ?? '');
    if (options.once || options.signal?.aborted) return;
    try { await delay(options.intervalMs, undefined, { signal: options.signal }); } catch { return; }
  }
}

/**
 * The watch's release handover (GY-3123): after a pass served `tip`, a process not running that
 * commit's code calls `stop` and throws the release handover, so the launcher restarts the watch on
 * the code it serves. `running` names the commit this process's code comes from.
 */
export const releaseHandover = (running: () => string | null, stop: () => void) => async (tip: string) => {
  if (!tip || running() === tip) return;
  stop();
  throw Object.assign(new Error(`[graphyard-deploy] the watch hands itself over to ${tip.slice(0, 12)}: it serves code this process is not running, and the restart loads it`), { releaseHandover: true });
};

/** The managed repository's serving, as the dashboard header reads it (GY-2964). */
export interface ManagedDeploy {
  /** The managed repository this answers for. */
  repository: string;
  /** A deploy record names this repository as the one it serves and holds a serving tip. */
  configured: boolean;
  /** The commit that deploy serves; null when no deploy of this repository is configured. */
  tip: string | null;
  /** When that deploy was recorded. */
  at: string | null;
  /** The base branch's tip as the shared checkout holds it; null when it cannot be read. */
  main: string | null;
  /** Merged changes on the base branch since the configured deploy's commit; null when unreadable. */
  pending: number | null;
}

/**
 * What the managed repository's own deployment serves, read like master status reads it (GY-2955):
 * only a deploy record naming this repository as the one it serves counts, and the base tip comes
 * from the shared checkout's ref. The control plane's own build revision and its deployment are
 * never a stand-in for another repository's release health, so a managed install without such a
 * record reads unconfigured — "No deploy configured · main <tip>" — never a serving claim.
 */
export async function managedDeploy(repository: string, baseBranch: string, root: string | null | undefined, git?: GitRunner | null): Promise<ManagedDeploy> {
  const record = root ? readDeployRecord(deployRecordPath(root)) : null;
  const configured = !!(record && record.tip && record.repository?.toLowerCase() === repository.toLowerCase());
  let main: string | null = null, pending: number | null = null;
  if (root && git) {
    for (const ref of [`refs/remotes/origin/${baseBranch}`, `refs/heads/${baseBranch}`]) {
      const tip = await git(['rev-parse', '--verify', '--quiet', ref]);
      const sha = tip.stdout.trim();
      if (tip.status === 0 && /^[0-9a-f]{40}$/.test(sha)) { main = sha; break; }
    }
    if (configured && main) {
      const since = await git(['rev-list', '--count', `${record!.tip}..${main}`]);
      pending = since.status === 0 && /^\d+$/.test(since.stdout.trim()) ? Number(since.stdout.trim()) : null;
    }
  }
  return { repository, configured, tip: configured ? record!.tip : null, at: configured ? record!.at : null, main, pending };
}

/** The git toplevel of a directory, or null when it is not in a checkout — the server's fallback serving root (its own working directory). */
export const repositoryToplevel = (directory: string): string | null => {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
};

/** A git read that answers its stdout and throws when the read fails, so a missing ref is a caught throw, never a silent answer. */
export type GitRead = (args: readonly string[]) => Promise<string>;

/**
 * What serves the managed repository now (GY-2976): the deploy record naming it as the one it
 * serves, or — when main declares a node application in graphyard.json and the deploy unit's serve pass has run
 * — what that pass serves: the served commit, whether it is main, how far main is ahead, the last
 * build failure, and the declared serve's URL (null while nothing is declared). The serve record
 * is the repository's own serving truth, so it stands even beside an unconfigured deploy record;
 * the URL and the failure are the declared serve's alone.
 */
export interface ServingReport {
  /** Nothing serves this repository: no deploy record names it and no serve pass has served or failed. */
  unconfigured: boolean;
  /** The served commit (the declared serve's when one is recorded, else the deploy record's); null when nothing serves. */
  commit: string | null;
  /** The base branch's tip as the shared checkout holds it; null when it cannot be read. */
  main: string | null;
  /** Whether the served commit is main; null when either is unreadable. */
  atMain: boolean | null;
  /** The last failure: the declared serve's build failure, else a configured deploy's failed tip. */
  failedDeploy: { tip: string | null; reason: string | null; restoring: string | null } | null;
  /** Merged changes the base branch holds since the served commit; null when unreadable. */
  pending: number | null;
  /** The declared serve's URL, its last build failure, and the served commit's required cases' verdict (null while they have not run against it); null when the repository declares no serve. */
  serve: { url: string | null; failure: { commit: string; reason: string | null } | null; check: ServeCheck | null } | null;
}

export async function servingReport(root: string | null | undefined, repository: string, baseBranch: string, git?: GitRead | null): Promise<ServingReport> {
  const record = root ? readDeployRecord(deployRecordPath(root)) : null;
  const serve = root ? readServeRecord(serveRecordPath(root)) : null;
  const configured = !!(record && record.tip && record.repository?.toLowerCase() === repository.toLowerCase());
  const commit = serve?.commit ?? (configured ? record!.tip : null);
  const failed = serve?.failed ? { tip: serve.failed, reason: serve.reason }
    : !serve && configured && record!.failed ? { tip: record!.failed, reason: record!.reason } : null;
  let main: string | null = null, pending: number | null = null;
  if (root && git) {
    for (const ref of [`refs/remotes/origin/${baseBranch}`, `refs/heads/${baseBranch}`]) {
      try { const sha = (await git(['rev-parse', '--verify', ref])).trim(); if (/^[0-9a-f]{40}$/.test(sha)) { main = sha; break; } } catch { /* the ref is absent here */ }
    }
    if (commit && main) {
      try { const count = (await git(['rev-list', '--count', `${commit}..${main}`])).trim(); pending = /^\d+$/.test(count) ? Number(count) : null; } catch { /* unreadable */ }
    }
  }
  return {
    unconfigured: !commit,
    commit, main,
    atMain: commit && main ? commit === main : null,
    failedDeploy: failed ? { tip: failed.tip, reason: failed.reason, restoring: !serve && configured ? record!.restore ?? null : null } : null,
    pending,
    serve: serve ? { url: serve.url ?? null, failure: serve.failed ? { commit: serve.failed, reason: serve.reason } : null, check: serve.check ?? null } : null,
  };
}
