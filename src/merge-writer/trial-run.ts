// Concern: GY-3159 — a merge trial's verification run, detached from the loop's process so the
// restart onto a newly served release (GY-3148) never kills a trial in progress. The run leads its
// own session (and, under systemd, its own transient scope, like a headless run), writes its steps
// and its verdict to a directory under the coordinator checkout, and whichever loop watches it —
// the one that started it, or its successor after the restart — reads the same files and settles
// the head on the trial's own verdict (merged, or refused for its own failure), never on the fact
// that the loop restarted.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detachedLaunch, processIdentity, readRunMeta, runAlive, runContainment, runEnvironment, runFiles, signalRun, type RunMeta } from '../runner/pi.js';
import { setTrialAttempts, TrialCancelledError, TrialTimeoutError, TrialRunnerError, type TrialNoVerdict } from './trial.js';
import { harnessModules } from './trial-container.js';
import type { MergeTrialRun } from './executor.js';

/** Where a loop's detached trial runs live: `<coordinator root>/.graphyard/trial-runs`, beside the deploy record it already keeps there. */
export const trialRunsDirectory = (root: string) => join(root, '.graphyard', 'trial-runs');

/** What one merge flight asks a detached trial run to do: everything `runMergeTrial` reads that is not a function; the launch fills where it runs. */
export interface TrialRunRequest { key: string; head: string; mergeSha: string; baseTip: string | null; changedFiles: string[]; proofs: string[]; e2eProofs: string[]; timeoutMs: number; bug: boolean; cores: number | null }
/** The run's persisted input (GY-3159): the request plus where the trial checks out, what it must not read, and when it started. */
export interface TrialRunSpec extends TrialRunRequest { version: 1; root: string; base: string; hidden: string[]; startedAt: string }

/** The run's verdict or its own failure, as the run records it for whichever loop reads it. */
export type TrialRunOutcome = { ok: true; run: MergeTrialRun } | { ok: false; error: SerializedTrialError };
/** A run's failure as it crosses the process boundary: the error's class, message and fields, with every attempt the run made (GY-1832). */
export interface SerializedTrialError { name: string; message: string; attempts: TrialNoVerdict[];
  phase?: TrialPhaseText; durationMs?: number; logTail?: string; status?: number | null; signal?: string | null; files?: string[]; finished?: number; outputTail?: string; mergeSha?: string; reason?: string }
type TrialPhaseText = TrialTimeoutError['phase'];

/** A detached trial run, watched from its directory (GY-3159): the same files answer the loop that started it and the loop that adopts it after a restart. */
export interface TrialRunHandle {
  /** The run's directory: its spec, steps, verdict and its process's meta. */
  directory: string;
  mergeSha: string;
  /**
   * Watches the run to its verdict, reporting each step as it is recorded. Rejects with the run's
   * own error — a `TrialTimeoutError`, `TrialRunnerError`, `TrialCancelledError` or a host failure —
   * when it reached none. Aborting `signal` stops the run and rejects at once.
   */
  trial(onStep?: (step: string) => void, onTiming?: (step: string, durationMs: number) => void, signal?: AbortSignal): Promise<MergeTrialRun>;
  /** Stops watching (a restart): the run keeps running and this process's promise stays pending. */
  detach(): void;
  /** Stops the run itself (a trial nobody will read): it is signalled, and its watcher rejects cancelled. */
  cancel(reason: string): void;
}

/** The files of a run's directory: its input and its verdict, beside the detached launch's own (runner/pi.ts `runFiles`). */
export const trialRunFiles = (directory: string) => ({ spec: join(directory, 'spec.json'), steps: join(directory, 'steps.jsonl'), result: join(directory, 'result.json') });

/** A run's error as it crosses the process boundary, with every attempt the run made. */
export function serializeTrialError(error: unknown, attempts: readonly TrialNoVerdict[]): SerializedTrialError {
  const base = { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error), attempts: [...attempts] };
  if (error instanceof TrialTimeoutError) return { ...base, name: 'TrialTimeoutError', phase: error.phase, durationMs: error.durationMs, logTail: error.logTail };
  if (error instanceof TrialRunnerError) return { ...base, name: 'TrialRunnerError', phase: error.phase, status: error.status, signal: error.signal, files: [...error.files], finished: error.finished, outputTail: error.outputTail, mergeSha: error.mergeSha, durationMs: error.durationMs };
  if (error instanceof TrialCancelledError) return { ...base, name: 'TrialCancelledError', reason: error.reason };
  return base;
}

/** The error a run recorded, rebuilt as the class the merge writer reads (its attempts re-attached, GY-1832). */
export function reconstructTrialError(serialized: SerializedTrialError): Error {
  const error: Error = serialized.name === 'TrialTimeoutError' && serialized.phase !== undefined && typeof serialized.durationMs === 'number'
    ? new TrialTimeoutError(serialized.phase, serialized.durationMs, serialized.logTail ?? '')
    : serialized.name === 'TrialRunnerError' && serialized.phase !== undefined
      ? new TrialRunnerError(serialized.phase, serialized.status ?? null, serialized.signal ?? null, serialized.files ?? [], serialized.finished ?? 0, serialized.outputTail ?? '', serialized.mergeSha ?? '', serialized.durationMs ?? 0)
      : serialized.name === 'TrialCancelledError' ? new TrialCancelledError(serialized.reason ?? serialized.message) : new Error(serialized.message);
  setTrialAttempts(error, serialized.attempts ?? []);
  return error;
}

/** The trial phase a step label belongs to, so a watcher's own timeout names where the run was. */
const phaseOfStep = (step: string): TrialPhaseText => /^(checkout|scan|install)/.test(step) ? 'install' : step.startsWith('build') ? 'build' : step.startsWith('selection') ? 'selection' : 'tests';

/** How long a run directory nobody read is kept before a later launch prunes it. */
export const trialRunRetentionMs = 24 * 60 * 60_000;

/** Reads a run's spec, or null when its directory holds none. */
export async function readTrialRunSpec(directory: string): Promise<TrialRunSpec | null> {
  try { return JSON.parse(await readFile(trialRunFiles(directory).spec, 'utf8')) as TrialRunSpec; } catch { return null; }
}

/** How the detached run is invoked: `node --import <the running code's own tsx> <trial-main> <directory>`. */
export const trialMainInvocation = (directory: string): [string, string[]] =>
  [process.execPath, ['--import', join(harnessModules, 'tsx', 'dist', 'loader.mjs'), fileURLToPath(new URL('./trial-main.ts', import.meta.url)), directory]];

/** The launch's own bound, past which the run's watchdog ends it even with no watcher alive: its deadline plus a margin. */
const selfBoundSeconds = (timeoutMs: number) => Math.ceil((timeoutMs + 60_000) / 1000);

/**
 * Launches one merge trial as a detached run (GY-3159): a `node` child of the code this loop runs,
 * leading its own session and — under a systemd service — its own transient scope, so the restart
 * onto a newly served release never takes it. The loop watches the run from its directory; a
 * restart leaves it running for the next loop to adopt (`adoptTrialRun`). Directories a later
 * launch finds older than a day are pruned, so an unread verdict cannot pile up.
 */
export function launchTrialRun(input: { runsRoot: string; spec: TrialRunSpec; spawn?: typeof spawn; pollMs?: number; log?: (line: string) => void }): TrialRunHandle {
  const id = randomUUID(), directory = join(input.runsRoot, id), spec = input.spec;
  let failure: string | null = null;
  let meta: RunMeta;
  const containment = runContainment({ log: input.log });
  const [command, args] = trialMainInvocation(directory);
  try {
    // The directory and its input exist before the launch: the shell the run runs in redirects its
    // output into them the instant it starts (runner/pi.ts does the same for a headless run).
    mkdirSync(input.runsRoot, { recursive: true });
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(trialRunFiles(directory).spec, `${JSON.stringify(spec)}\n`, { mode: 0o600 });
    meta = { version: 1, id, command, pid: null, identity: null, containment, unit: null, startedAt: spec.startedAt, timeoutMs: spec.timeoutMs, exitGraceMs: 0 };
    writeFileSync(runFiles(directory).meta, JSON.stringify(meta), { mode: 0o600 });
  } catch (error) {
    failure = `the detached trial run directory ${directory} could not be written: ${error instanceof Error ? error.message : String(error)}`;
    meta = { version: 1, id, command, pid: null, identity: null, containment: 'setsid', unit: null, startedAt: spec.startedAt, timeoutMs: spec.timeoutMs, exitGraceMs: 0 };
  }
  const launch = detachedLaunch(directory, id, command, args, containment, [], selfBoundSeconds(spec.timeoutMs));
  if (!failure) {
    try {
      const child = (input.spawn ?? spawn)(launch.file, launch.args, { env: runEnvironment(process.env), stdio: ['ignore', 'ignore', 'ignore'], detached: true });
      child.on('error', error => { failure = `${command} could not be started: ${error.message}`; });
      child.unref();
      meta = { ...meta, pid: child.pid ?? null, identity: child.pid ? processIdentity(child.pid) : null };
      writeFileSync(runFiles(directory).meta, JSON.stringify(meta), { mode: 0o600 });
    } catch (error) {
      failure = `${command} could not be started: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  // A verdict nobody read stays adoptable for a day; anything older goes with the launch that would never read it.
  void (async () => {
    for (const entry of await readdir(input.runsRoot).catch(() => [] as string[])) {
      const other = join(input.runsRoot, entry);
      if (other === directory) continue;
      try { if (Date.now() - (await stat(other)).mtimeMs > trialRunRetentionMs) await rm(other, { recursive: true, force: true }); } catch { /* kept */ }
    }
  })();
  return { directory, mergeSha: spec.mergeSha, ...watchTrialRun(directory, meta, spec, { pollMs: input.pollMs, fromStart: true, failure: () => failure }) };
}

/**
 * The trial run a restart left (GY-3159): watched again when its process is still alive, and
 * answered at once from its recorded verdict when it is not — the run reached that verdict, so the
 * head settles on it. A run whose process is gone without a verdict (the host went down under it,
 * or it was stopped) answers null, and the caller falls back to refusing the open intent.
 */
export async function adoptTrialRun(ref: { key: string; head: string; mergeSha: string; directory: string }, options: { pollMs?: number } = {}): Promise<TrialRunHandle | null> {
  const spec = await readTrialRunSpec(ref.directory);
  if (!spec || spec.key !== ref.key || spec.head !== ref.head || spec.mergeSha !== ref.mergeSha) return null;
  const outcome = await readOutcome(ref.directory);
  if (outcome) return { directory: ref.directory, mergeSha: ref.mergeSha,
    trial: () => outcome.ok ? Promise.resolve(outcome.run) : Promise.reject(reconstructTrialError(outcome.error)),
    detach: () => {}, cancel: (reason: string) => { void writeStopped(ref.directory, reason); } };
  const meta = readRunMeta(ref.directory);
  if (!meta || !runAlive(meta)) return null;
  return { directory: ref.directory, mergeSha: ref.mergeSha, ...watchTrialRun(ref.directory, meta, spec, { pollMs: options.pollMs, fromStart: false }) };
}

/** Stops a detached run nobody will read (a head returned, replaced or delivered): signalled, and its reason recorded beside it. */
export async function stopTrialRun(ref: { directory: string }): Promise<void> {
  const meta = readRunMeta(ref.directory);
  await writeStopped(ref.directory, 'the head it trials no longer awaits its merge');
  if (meta) signalRun(meta, 'SIGTERM');
}

const writeStopped = async (directory: string, reason: string) => {
  try { await writeFile(runFiles(directory).stopped, `${JSON.stringify({ reason: 'cancelled', detail: reason })}\n`, { mode: 0o600 }); } catch { /* the signal still goes */ }
};

/** The verdict a run recorded, or null while it has none. */
async function readOutcome(directory: string): Promise<TrialRunOutcome | null> {
  try { return JSON.parse(await readFile(trialRunFiles(directory).result, 'utf8')) as TrialRunOutcome; } catch { return null; }
}

const readStopped = (directory: string): { reason: string; detail: string } | null => {
  try { return JSON.parse(readFileSync(runFiles(directory).stopped, 'utf8')) as { reason: string; detail: string }; } catch { return null; }
};
const readExit = (directory: string): string | null => {
  try { return readFileSync(runFiles(directory).exit, 'utf8').trim(); } catch { return null; }
};

/** Reads a run to its verdict from its directory: its steps as they are recorded, its verdict when it is, its process and its deadline. */
function watchTrialRun(directory: string, meta: RunMeta, spec: Pick<TrialRunSpec, 'mergeSha'>, options: { pollMs?: number; fromStart: boolean; failure?: () => string | null }) {
  const files = trialRunFiles(directory);
  let timer: NodeJS.Timeout | null = null, settled = false, detached = false, replayed = options.fromStart, consumed = 0, lastStep = 'checkout';
  let watched: { onStep?: (step: string) => void; onTiming?: (step: string, durationMs: number) => void } | null = null;
  let resolveResult!: (run: MergeTrialRun) => void, rejectResult!: (error: Error) => void;
  const result = new Promise<MergeTrialRun>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  result.catch(() => {}); // a watcher that outlives its awaiter (a detach) never warns
  const finish = () => { settled = true; if (timer) clearInterval(timer); timer = null; };
  const settle = (set: () => void) => { if (settled || detached) return true; finish(); set(); return true; };
  const stopRun = (reason: string) => {
    void writeStopped(directory, reason);
    signalRun(meta, 'SIGTERM');
    setTimeout(() => signalRun(meta, 'SIGKILL'), 5_000).unref();
  };
  const readSteps = async () => {
    let text: string;
    try { text = await readFile(files.steps, 'utf8'); } catch { return; }
    const lines = text.split('\n').filter(line => line.trim());
    if (lines.length <= consumed) return;
    // A watcher that adopts a run mid-flight reports where it is now — its last recorded step — not every step already past.
    const fresh = lines.slice(consumed);
    consumed = lines.length;
    let dispatch = fresh;
    if (!replayed) {
      replayed = true;
      const current = fresh.findLast(line => { try { return 'step' in JSON.parse(line); } catch { return false; } });
      dispatch = current ? [current] : [];
    }
    for (const line of dispatch) {
      try {
        const record = JSON.parse(line) as { step?: string; timing?: string; durationMs?: number };
        if (record.step) { lastStep = record.step; watched?.onStep?.(record.step); }
        else if (record.timing !== undefined && typeof record.durationMs === 'number') watched?.onTiming?.(record.timing, record.durationMs);
      } catch { /* a line being written is read whole next poll */ }
    }
  };
  const tick = async () => {
    if (settled || detached) return;
    const failure = options.failure?.();
    if (failure) return settle(() => rejectResult(new Error(failure)));
    await readSteps();
    const outcome = await readOutcome(directory);
    if (outcome) return settle(() => outcome.ok ? resolveResult(outcome.run) : rejectResult(reconstructTrialError(outcome.error)));
    const stopped = readStopped(directory);
    if (stopped?.reason === 'cancelled') return settle(() => rejectResult(new TrialCancelledError(stopped.detail)));
    const exit = readExit(directory);
    if (exit !== null || !runAlive(meta)) {
      const stderr = (await readFile(runFiles(directory).stderr, 'utf8').catch(() => '')).trim().slice(-1200);
      return settle(() => rejectResult(new Error(`the detached trial run of ${spec.mergeSha.slice(0, 12)} reached no verdict${exit !== null ? ` (its process exited ${exit})` : ''}: ${stderr || 'it left no output'}`)));
    }
    if (Date.now() >= Date.parse(meta.startedAt) + meta.timeoutMs) {
      stopRun('the trial outran its deadline');
      return settle(() => rejectResult(new TrialTimeoutError(phaseOfStep(lastStep), Math.max(0, Date.now() - Date.parse(meta.startedAt)), '')));
    }
  };
  return {
    trial(onStep?: (step: string) => void, onTiming?: (step: string, durationMs: number) => void, signal?: AbortSignal): Promise<MergeTrialRun> {
      if (timer) return result; // one watcher per process
      watched = { onStep, onTiming };
      const abort = () => { if (settled || detached) return; const reason = signal!.reason instanceof Error ? signal!.reason.message : String(signal!.reason); stopRun(reason); settle(() => rejectResult(new TrialCancelledError(reason))); };
      if (signal) { if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }
      timer = setInterval(() => void tick(), options.pollMs ?? 500);
      void tick();
      return result;
    },
    detach() { detached = true; finish(); },
    cancel(reason: string) { if (settled) return; stopRun(reason); settle(() => rejectResult(new TrialCancelledError(reason))); },
  };
}
