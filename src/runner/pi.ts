import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Run, RunEvent, RunFailure, RunOptions, RunResult, Runner } from './types.js';

/**
 * The Pi implementation of the runner (GY-169). It launches `pi --mode json` in the given
 * worktree through the given environment wrapper (`pi-a`, `pi-b`: each sets PI_CODING_AGENT_DIR
 * and reads its provider key at run time) and model, with the Graphyard extension
 * (integrations/pi) as its only extension, and reads Pi's JSONL event stream. There is no
 * terminal: stdin is closed, so nothing can wait on a person, and JSON mode exits once the prompt
 * is settled.
 *
 * A run is detached from the process that launched it (GY-453): it leads its own session (and,
 * from a systemd service, its own transient scope), writes its output and exit to its directory on
 * disk, and is watched from there. A restart of the loop or an executor leaves it running, and the
 * restarted process adopts it from the run registry (registry.ts adoptRuns).
 */

/** The Graphyard Pi extension this checkout ships. */
export const piExtensionPath = fileURLToPath(new URL('../../integrations/pi/index.ts', import.meta.url));
export const defaultPiModel = 'zai/glm-5.3-flash';

/**
 * Pi's non-interactive launch. JSON mode processes the prompt and exits; no session file is kept;
 * only the Graphyard extension loads (discovery is off), and the worktree's own project resources
 * — a candidate's `.pi/` extensions, skills, prompt templates, AGENTS.md — are ignored, so the code
 * under judgement cannot load code into its judge. The prompt follows `--` so it is never read as
 * an option.
 */
export function piArgs(prompt: string, options: { model: string; extension?: string; args?: string[] }) {
  return ['--mode', 'json', '--no-session', '--no-extensions', '--extension', options.extension ?? piExtensionPath,
    '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--model', options.model, ...(options.args ?? []), '--', prompt];
}

/** Inherited variables a run never sees: the loop's own Graphyard and Herdr identity. What a run may hold is passed in `env`. */
export function runEnvironment(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) if (value !== undefined && !/^(GRAPHYARD_|HERDR_)/.test(name)) env[name] = value;
  return { ...env, ...extra };
}

const text = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(part => part?.type === 'text' ? String(part.text ?? '') : '').filter(Boolean).join('\n') : '';
const bounded = (value: string, limit = 2000) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

/** One Pi JSONL record as a runner event; null for the streaming noise a record does not keep. */
export function piEvent(record: any, at: string): RunEvent | null {
  switch (record?.type) {
    case 'session': return { kind: 'session', at, id: String(record.id ?? '') };
    case 'message_end': return { kind: 'message', at, role: String(record.message?.role ?? 'unknown'), text: bounded(text(record.message?.content)), stopReason: record.message?.stopReason ?? null, error: record.message?.errorMessage ?? null };
    case 'tool_execution_start': return { kind: 'tool-start', at, tool: String(record.toolName ?? ''), call: String(record.toolCallId ?? '') };
    case 'tool_execution_end': return { kind: 'tool-end', at, tool: String(record.toolName ?? ''), call: String(record.toolCallId ?? ''), error: record.isError === true, text: bounded(text(record.result?.content)) };
    case 'auto_retry_start': return { kind: 'retry', at, attempt: Number(record.attempt ?? 0), error: bounded(String(record.errorMessage ?? '')) };
    case 'agent_settled': return { kind: 'settled', at };
    default: return null;
  }
}

export interface PiRunnerOptions {
  /** The environment wrapper or Pi binary: `pi-a`, `pi-b`, `pi`. */
  command?: string;
  /** Arguments before Pi's own (a test's fake Pi script). */
  commandArgs?: string[];
  model?: string;
  extension?: string;
  /** How long after `agent_settled` the process may take to exit before it is stopped. */
  exitGraceMs?: number;
  spawn?: typeof spawn;
  /** Arguments after Pi's own and before the prompt: a registry role's policy flags and tool allowlist (GY-170). */
  args?: string[];
  /** Variables every run of this runner starts with: a registry account's login home. */
  environment?: Record<string, string>;
  /** How a run is detached from this process (GY-453); `runContainment()` decides by default. */
  containment?: RunContainment;
  /** How often a run's output and exit are read from disk. */
  pollMs?: number;
  /**
   * The words that confine Pi for a run working in `cwd` (GY-888), or a throw when it cannot be
   * confined. They wrap Pi alone inside the run's shell: the shell itself stays outside, so it can
   * write the run's output and exit to its directory under the coordinator checkout, which the
   * confinement binds read-only.
   */
  confine?: (cwd: string | undefined) => readonly string[];
}

/**
 * How a headless run is detached from the process that launched it (GY-453), so a restart of the
 * loop or an executor never takes the run with it. Every run leads its own session and process
 * group (setsid), so no signal sent to the launcher's group reaches it. `systemd`: the run also gets
 * its own transient user scope, like a `watch` worker (supervisor.ts systemdContainment), because a
 * process started from a systemd service is in that service's cgroup, and stopping or restarting
 * the service kills every process in it, setsid or not.
 */
export type RunContainment = 'systemd' | 'setsid';
let systemdReachable: boolean | null = null, fallbackLogged = false;
/**
 * The service a cgroup line places the process in, or null. The user manager's own unit
 * (`user@UID.service`) is not one: a process directly under it is in no service a stop could take.
 */
export function cgroupService(line: string) {
  const unit = line.trim().replace(/\/$/, '').split('/').pop() ?? '';
  return unit.endsWith('.service') && !/^user@\d+\.service$/.test(unit) ? unit : null;
}
/**
 * `systemd` when this process runs in a systemd service's cgroup and the user manager answers;
 * `setsid` otherwise. A service whose launcher cannot reach a user manager (a system-level unit)
 * falls back to setsid inside that service's cgroup, where a stop of the service still kills the
 * run: that is logged, once a process.
 */
export function runContainment(input: { cgroup?: string | null; systemd?: () => boolean; log?: (line: string) => void } = {}): RunContainment {
  let cgroup = input.cgroup;
  if (cgroup === undefined) { try { cgroup = readFileSync('/proc/self/cgroup', 'utf8'); } catch { cgroup = null; } }
  const service = cgroup?.split(/\r?\n/).map(cgroupService).find(Boolean) ?? null;
  if (!service) return 'setsid';
  const reachable = input.systemd ?? (() => {
    if (systemdReachable === null) { try { execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore', timeout: 5_000 }); systemdReachable = true; } catch { systemdReachable = false; } }
    return systemdReachable;
  });
  if (reachable()) return 'systemd';
  const log = input.log ?? (line => { if (!fallbackLogged) { fallbackLogged = true; process.stderr.write(`${line}\n`); } });
  log(`graphyard: headless runs started from ${service} get no transient scope (no systemd user manager answers), so a stop or restart of ${service} still ends them`);
  return 'setsid';
}

/** The files of a run's directory: its registry entry, Pi's output, and the exit its shell records. */
export const runFiles = (directory: string) => ({
  meta: join(directory, 'run.json'), stdout: join(directory, 'stdout.jsonl'), stderr: join(directory, 'stderr.log'),
  exit: join(directory, 'exit'), stopped: join(directory, 'stopped.json'),
});
export const runMetaSchema = z.object({
  version: z.literal(1), id: z.string().min(1).max(80), command: z.string().max(4000), pid: z.number().int().positive().nullable(),
  /** The process's start time (/proc/PID/stat), so a reused pid is never taken for the run. */
  identity: z.string().max(40).nullable(), containment: z.enum(['systemd', 'setsid']), unit: z.string().max(200).nullable(),
  startedAt: z.string().max(40), timeoutMs: z.number().int().positive(), exitGraceMs: z.number().int().nonnegative(),
  /** The process that started a scratch run (one outside the run registry), which the run must not outlive. */
  launcher: z.object({ pid: z.number().int().positive(), identity: z.string().max(40).nullable() }).strict().nullable().optional(),
}).strict();
export type RunMeta = z.infer<typeof runMetaSchema>;

const quoted = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/**
 * The detached launch: a shell that leads the run's session, runs Pi with its output in the run's
 * directory, and records Pi's exit there — `spawn` when the command cannot be found. The shell
 * handles TERM, INT and HUP so that a stop sent to the run's group still records Pi's exit. The
 * `confinement` words wrap Pi alone, never the shell: the run's directory lies under the
 * coordinator checkout the confinement makes read-only, so only the shell outside it can write there.
 */
export function detachedLaunch(directory: string, id: string, command: string, args: string[], containment: RunContainment, confinement: readonly string[] = [], boundSeconds?: number) {
  const files = runFiles(directory), pending = `${files.exit}.tmp`;
  const confined = confinement.map(word => `${quoted(word)} `).join('');
  // A bound the run enforces on itself: a scratch run has no watcher once the process that
  // started it is gone, so nothing else would stop it. A watchdog beside Pi stops the run's whole
  // group (the shell leads it) at the bound, as a watcher would, and is stopped once Pi has exited.
  // Nothing in it is immune to TERM (GY-1432): a scratch run lies in the launching unit's cgroup,
  // and an ignored TERM is inherited across exec, so a `sleep` started under `trap '' TERM` outlived
  // every stop of graphyard-master.service until TimeoutStopSec SIGKILLed it. The watchdog waits on
  // its own sleep and, on TERM — the unit's stop, or the shell's once Pi has exited — ends that
  // sleep and itself. It ignores TERM only for the instant it signals its own group, then gives
  // the run five seconds, a second at a time, and stops as soon as the shell has gone: a TERM the
  // shell sent inside that instant is lost, so the watchdog never relies on receiving it.
  const watchdog = boundSeconds ? `( trap 'kill "$nap" 2>/dev/null; exit 0' TERM; sleep ${Math.ceil(boundSeconds)} & nap=$!; wait "$nap"; trap '' TERM; kill -TERM -$$; trap 'exit 0' TERM; `
    + `for grace in 1 2 3 4 5; do kill -0 $$ 2>/dev/null || exit 0; sleep 1; done; kill -KILL -$$ ) & watchdog=$!; ` : '';
  const script = `trap : TERM INT HUP; ${watchdog}if command -v "$0" >/dev/null 2>&1; then ${confined}"$0" "$@" <${'/dev/null'} >${quoted(files.stdout)} 2>${quoted(files.stderr)}; code=$?; `
    + `else printf '%s: command not found\\n' "$0" >${quoted(files.stderr)}; code=spawn; fi; ${watchdog ? 'kill -TERM "$watchdog" 2>/dev/null; ' : ''}printf '%s\\n' "$code" >${quoted(pending)} && mv -f ${quoted(pending)} ${quoted(files.exit)}`;
  const shell = ['/bin/sh', '-c', script, command, ...args];
  const unit = containment === 'systemd' ? `graphyard-run-${id}.scope` : null;
  return unit ? { file: 'systemd-run', args: ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, '--', ...shell], unit } : { file: shell[0], args: shell.slice(1), unit };
}

/** A process's start time (/proc/PID/stat), which tells it from a later process given the same pid. */
export function processIdentity(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), end = stat.lastIndexOf(') ');
    return end < 0 ? null : stat.slice(end + 2).trim().split(/\s+/)[19] ?? null;
  } catch { return null; }
}
/** Whether the run's process is still the one it started as. */
export function runAlive(meta: Pick<RunMeta, 'pid' | 'identity'>) {
  if (!meta.pid) return false;
  try { process.kill(meta.pid, 0); } catch (error: any) { if (error?.code !== 'EPERM') return false; }
  if (!meta.identity) return true;
  const now = processIdentity(meta.pid);
  return now === null ? process.platform !== 'linux' : now === meta.identity;
}
/** Signals the run's whole process group (it leads its own session). Never the launcher's. */
export function signalRun(meta: Pick<RunMeta, 'pid' | 'identity'>, signal: NodeJS.Signals) {
  if (!meta.pid || !runAlive(meta)) return;
  try { process.kill(-meta.pid, signal); } catch { try { process.kill(meta.pid, signal); } catch { /* already gone */ } }
}
export function readRunMeta(directory: string): RunMeta | null {
  try { return runMetaSchema.parse(JSON.parse(readFileSync(runFiles(directory).meta, 'utf8'))); } catch { return null; }
}
const readText = (file: string) => { try { return readFileSync(file, 'utf8'); } catch { return null; } };

export function piRunner(configured: PiRunnerOptions = {}): Runner {
  const command = configured.command ?? 'pi', model = configured.model ?? defaultPiModel, grace = configured.exitGraceMs ?? 10_000;
  return {
    name: 'pi',
    start<T>(prompt: string, options: RunOptions<T>): Run<T> {
      // A run without a run registry directory (triage, diagnosis) has no owner on disk, so nothing
      // could adopt it after a restart: it gets no scope of its own, ends with this process, bounds
      // itself, and is swept by the next scratch run should this process die without ending it.
      const id = randomUUID(), scratch = !options.runs;
      const directory = scratch ? scratchDirectory(options.cwd, id) : resolve(options.runs!, id);
      const startedAt = new Date().toISOString();
      const meta: RunMeta = { version: 1, id, command, pid: null, identity: null, containment: 'setsid', unit: null, startedAt, timeoutMs: options.timeoutMs, exitGraceMs: grace,
        ...(scratch ? { launcher: { pid: process.pid, identity: processIdentity(process.pid) } } : {}) };
      let failure: string | null = null, child: ChildProcess | null = null;
      try {
        if (scratch) sweepScratchRuns(dirname(directory));
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const containment = scratch ? 'setsid' : configured.containment ?? runContainment();
        const confinement = configured.confine?.(options.cwd) ?? [];
        const launch = detachedLaunch(directory, id, command, [...(configured.commandArgs ?? []), ...piArgs(prompt, { model, extension: configured.extension, args: configured.args })], containment, confinement,
          scratch ? (options.timeoutMs + grace) / 1000 + scratchBoundMarginSeconds : undefined);
        // Detached: the run leads its own session and process group, holds no pipe to this process
        // (stdin is closed, so nothing can wait on a person), and is not waited on by it.
        child = (configured.spawn ?? spawn)(launch.file, launch.args, { cwd: options.cwd, env: runEnvironment(process.env, { ...configured.environment, ...options.env }), stdio: ['ignore', 'ignore', 'ignore'], detached: true });
        child.on('error', error => { failure = `${command} could not be started: ${error.message}`; });
        child.unref();
        Object.assign(meta, { pid: child.pid ?? null, identity: child.pid ? processIdentity(child.pid) : null, containment, unit: launch.unit });
        writeFileSync(runFiles(directory).meta, JSON.stringify(meta), { mode: 0o600 });
      } catch (error) {
        failure = `${command} could not be started: ${error instanceof Error ? error.message : String(error)}`;
      }
      return watchRun<T>(directory, meta, options, { pollMs: configured.pollMs, scratch, failure: () => failure, child });
    },
    adopt<T>(directory: string, options: Omit<RunOptions<T>, 'cwd' | 'env' | 'runs'>): Run<T> {
      const meta = readRunMeta(directory);
      if (!meta) {
        const now = new Date().toISOString();
        return watchRun<T>(directory, { version: 1, id: basename(directory), command, pid: null, identity: null, containment: 'setsid', unit: null, startedAt: now, timeoutMs: options.timeoutMs, exitGraceMs: grace },
          options, { pollMs: configured.pollMs, scratch: false, failure: () => null, child: null });
      }
      return watchRun<T>(directory, meta, options, { pollMs: configured.pollMs, scratch: false, failure: () => null, child: null });
    },
  };
}

/** How far past its watcher's bound a scratch run's own bound lies, so a live watcher always stops it first. */
export const scratchBoundMarginSeconds = 30;
/** How old a scratch directory with no readable run.json is before a sweep takes it for abandoned. */
const scratchOrphanAgeMs = 10 * 60_000;
/**
 * Where scratch runs write their output: `.graphyard/scratch-runs/` in the checkout they read (the
 * loop's own), which a full or over-quota /tmp does not reach, else the OS temp directory.
 */
export function scratchRunsDirectory(cwd: string | undefined) {
  if (cwd) {
    // Each level made on its own, never recursively: a recursive mkdir can spin forever on a
    // pseudo-filesystem such as /proc, where a plain one fails at once.
    const local = resolve(cwd, '.graphyard', 'scratch-runs');
    const made = (directory: string) => { try { mkdirSync(directory, { mode: 0o700 }); } catch (error: any) { if (error?.code !== 'EEXIST') throw error; } };
    try { made(dirname(local)); made(local); return local; } catch { /* a checkout it cannot write to: the temp directory */ }
  }
  return join(tmpdir(), 'graphyard-runs');
}
const scratchDirectory = (cwd: string | undefined, id: string) => join(scratchRunsDirectory(cwd), id);
/**
 * Ends and removes every scratch run under `root` whose launcher is gone: one a loop left when it
 * was killed outright (SIGKILL, OOM), before its exit hook could. A run whose launcher still lives
 * is that process's to end. Returns how many it removed.
 */
export function sweepScratchRuns(root: string, now = Date.now()) {
  let names: string[];
  try { names = readdirSync(root); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (scratchRuns.has(name)) continue;
    const directory = join(root, name);
    try {
      const meta = readRunMeta(directory);
      if (meta ? meta.launcher && runAlive(meta.launcher) : now - statSync(directory).mtimeMs < scratchOrphanAgeMs) continue;
      if (meta) signalRun(meta, 'SIGKILL');
      rmSync(directory, { recursive: true, force: true });
      removed++;
    } catch { /* one unreadable directory never stops the rest */ }
  }
  return removed;
}

/**
 * The live runs this process started without a run registry directory (GY-453). Nothing can adopt
 * them after a restart — no owner names what their result is for — so they end with this process:
 * a shutdown cancels them (`cancelScratchRuns`), and an exit that comes first kills them, so a
 * restarted loop never finds an unwatched, unbounded run beside the one it starts afresh.
 */
const scratchRuns = new Map<string, { meta: RunMeta; directory: string; cancel: (reason: string) => void }>();
let scratchExitHook = false;
const hookScratchExit = () => {
  if (scratchExitHook) return;
  scratchExitHook = true;
  process.on('exit', () => {
    for (const { meta, directory } of scratchRuns.values()) { signalRun(meta, 'SIGKILL'); rmSync(directory, { recursive: true, force: true }); }
    scratchRuns.clear();
  });
};
/** Cancels every live run of this process that is outside the run registry; how many there were. */
export function cancelScratchRuns(reason = 'the process that started it is stopping, and a run outside the run registry cannot be adopted after a restart') {
  const live = [...scratchRuns.values()];
  for (const entry of live) entry.cancel(reason);
  return live.length;
}

/**
 * Watches a detached run from its directory: its JSONL output as it grows, its exit when its shell
 * records one, its bound, and its process. The run started here or in a process that has since
 * restarted — the directory holds everything either needs, so both watch it the same way.
 */
function watchRun<T>(directory: string, meta: RunMeta, options: Pick<RunOptions<T>, 'tool' | 'validate' | 'timeoutMs'>, watch: { pollMs?: number; scratch: boolean; failure: () => string | null; child: ChildProcess | null }): Run<T> {
  const files = runFiles(directory), events: RunEvent[] = [], listeners = new Set<(event: RunEvent) => void>();
  const accepted: T[] = [];
  let invalid: string | null = null, lastError: string | null = null, cancelled: string | null = null, timedOut = false, settledAt: number | null = null, stopSent = false;
  let resolveResult!: (result: RunResult<T>) => void, done = false, detached = false, offset = 0, buffer = '', gone = 0, launcherExit: number | null = null;
  const decoder = new StringDecoder('utf8');
  const result = new Promise<RunResult<T>>(resolve => { resolveResult = resolve; });
  const now = () => new Date().toISOString();
  const emit = (event: RunEvent) => { events.push(event); for (const listener of listeners) try { listener(event); } catch { /* a listener never stops the run */ } };
  // A stop is recorded on disk first, so whoever sees the run end — this process or the one that
  // adopts it after a restart — knows it was stopped and why, not lost.
  const stop = (reason: { reason: 'cancelled' | 'timeout' | 'settled'; detail: string }) => {
    if (reason.reason !== 'settled') { try { writeFileSync(files.stopped, JSON.stringify(reason), { mode: 0o600 }); } catch { /* the in-memory flag still classifies it here */ } }
    if (stopSent) return;
    stopSent = true;
    signalRun(meta, 'SIGTERM');
    setTimeout(() => signalRun(meta, 'SIGKILL'), 5_000).unref();
  };
  const stopped = (): { reason: string; detail: string } | null => { try { return JSON.parse(readFileSync(files.stopped, 'utf8')); } catch { return null; } };
  const finish = (outcome: RunResult<T>) => {
    if (done) return;
    done = true; clearInterval(timer);
    if (watch.scratch) { scratchRuns.delete(meta.id); rmSync(directory, { recursive: true, force: true }); }
    resolveResult(outcome);
  };
  const fail = (failure: RunFailure) => finish({ ok: false, failure, payloads: [...accepted] });

  const handle = (line: string) => {
    if (!line.trim()) return;
    let record: any;
    try { record = JSON.parse(line); } catch { emit({ kind: 'unparsed', at: now(), text: bounded(line, 500) }); return; }
    const event = piEvent(record, now());
    if (event) emit(event);
    if (record.type === 'message_end' && record.message?.errorMessage) lastError = String(record.message.errorMessage);
    if (record.type === 'auto_retry_end' && record.success === false && record.finalError) lastError = String(record.finalError);
    if (record.type === 'tool_execution_end' && record.toolName === options.tool) {
      if (record.isError === true) { invalid = `the ${options.tool} call was rejected: ${text(record.result?.content) || 'no reason given'}`; return; }
      try { accepted.push(options.validate(record.result?.details)); }
      catch (error) { invalid = `the ${options.tool} payload failed validation: ${error instanceof Error ? error.message : String(error)}`; }
    }
    if (record.type === 'agent_settled' && settledAt === null) settledAt = Date.now();
  };
  // Pi's framing is strict JSONL: records split on LF only (never readline, which also splits on
  // Unicode separators that are valid inside JSON strings), with an optional CR stripped.
  const pump = (final = false) => {
    let fd: number;
    try { fd = openSync(files.stdout, 'r'); } catch { return; }
    try {
      const chunk = Buffer.alloc(64 * 1024);
      for (let read: number; (read = readSync(fd, chunk, 0, chunk.length, offset)) > 0;) { offset += read; buffer += decoder.write(chunk.subarray(0, read)); }
    } finally { closeSync(fd); }
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) { handle(buffer.slice(0, index).replace(/\r$/, '')); buffer = buffer.slice(index + 1); }
    if (final) { buffer += decoder.end(); if (buffer) handle(buffer.replace(/\r$/, '')); buffer = ''; }
  };
  const ended = (exit: string) => {
    pump(true);
    const stderr = (readText(files.stderr) ?? '').slice(-4000).trim();
    if (stderr) emit({ kind: 'stderr', at: now(), text: bounded(stderr, 1000) });
    const code = /^\d+$/.test(exit) ? Number(exit) : null;
    emit({ kind: 'exit', at: now(), code, signal: null });
    if (exit === 'spawn') return fail({ reason: 'spawn', detail: `${meta.command} could not be started: ${bounded(stderr || 'command not found', 400)}` });
    const recorded = stopped();
    if (cancelled !== null || recorded?.reason === 'cancelled') return fail({ reason: 'cancelled', detail: cancelled ?? recorded!.detail });
    if (timedOut || recorded?.reason === 'timeout') return fail({ reason: 'timeout', detail: `no terminal event within ${Math.round(meta.timeoutMs / 1000)}s; the run was stopped` });
    // A clean run is judged by what it submitted; the exit is only a failure when Pi did not settle
    // and exit on its own (a stop after settling is this runner's, not Pi's).
    if (settledAt === null && code !== 0) return fail({ reason: 'exit', code, detail: `pi exited with code ${code}${stderr ? `: ${bounded(stderr, 400)}` : ''}` });
    if (!accepted.length) return fail(invalid ? { reason: 'invalid-payload', detail: invalid } : { reason: 'no-payload', detail: `the run ended without a ${options.tool} call${lastError ? ` (last error: ${bounded(lastError, 300)})` : ''}` });
    finish({ ok: true, tool: options.tool, payload: accepted[0], payloads: [...accepted] });
  };
  const exitRecorded = () => { const exit = readText(files.exit); return exit === null ? null : exit.trim(); };
  const tick = () => {
    if (done || detached) return;
    const failure = watch.failure();
    if (failure) return fail({ reason: 'spawn', detail: failure });
    pump();
    let exit = exitRecorded();
    if (exit !== null) return ended(exit);
    // The process is gone and its shell recorded no exit: it was killed from outside the run (its
    // shell with it) or its host went down. Read twice, a poll apart, so an exit being written is
    // never mistaken for one that never will be.
    if (!runAlive(meta)) {
      if (++gone < 2) return;
      pump(true);
      exit = exitRecorded();
      if (exit !== null) return ended(exit);
      emit({ kind: 'exit', at: now(), code: launcherExit, signal: null });
      const recorded = stopped();
      if (cancelled !== null || recorded?.reason === 'cancelled') return fail({ reason: 'cancelled', detail: cancelled ?? recorded!.detail });
      // A launcher (systemd-run) that exited on a failure before its shell wrote anything never started the run.
      if (launcherExit !== null && launcherExit !== 0 && offset === 0) return fail({ reason: 'spawn', detail: `${meta.command} could not be started: ${meta.unit ? `systemd-run could not start scope ${meta.unit}` : 'its shell'} exited with code ${launcherExit}` });
      if (timedOut || recorded?.reason === 'timeout') return fail({ reason: 'timeout', detail: `no terminal event within ${Math.round(meta.timeoutMs / 1000)}s; the run was stopped` });
      return fail({ reason: 'lost', detail: `the run's process${meta.pid ? ` (pid ${meta.pid})` : ''} is gone and recorded no exit, so it judged nothing: it was stopped from outside the run or its host went down` });
    }
    gone = 0;
    const clock = Date.now();
    if (!timedOut && clock >= Date.parse(meta.startedAt) + meta.timeoutMs) { timedOut = true; stop({ reason: 'timeout', detail: 'no terminal event within the bound' }); }
    if (settledAt !== null && clock >= settledAt + meta.exitGraceMs) stop({ reason: 'settled', detail: 'settled' });
  };
  emit({ kind: 'start', at: meta.startedAt, pid: meta.pid, command: meta.command });
  // Polled while the run is watched; the timer holds this process open for the run as its pipes did.
  const timer = setInterval(tick, watch.pollMs ?? 200);
  watch.child?.on('exit', code => { launcherExit = code; setImmediate(tick); });
  queueMicrotask(tick);
  const cancel = (reason = 'the run was cancelled') => {
    if (done || cancelled !== null) return;
    cancelled = reason;
    if (meta.pid && !watch.failure()) stop({ reason: 'cancelled', detail: reason }); else fail({ reason: 'cancelled', detail: reason });
  };
  if (watch.scratch) { hookScratchExit(); scratchRuns.set(meta.id, { meta, directory, cancel }); }
  return {
    id: meta.id, directory: watch.scratch ? undefined : directory, events,
    onEvent(listener) { for (const event of [...events]) listener(event); listeners.add(listener); return () => { listeners.delete(listener); }; },
    cancel,
    detach() { if (done) return; detached = true; clearInterval(timer); listeners.clear(); },
    result: () => result,
  };
}

export interface SmokeResult { ok: boolean; error: string | null }
/**
 * One prompt on a Pi account before it is trusted with a session (GY-446): Pi in JSON mode, no
 * session, no extension and no tools, asked for one word. It passes when Pi answers — an assistant
 * message without an error — and exits cleanly; otherwise `error` is Pi's own error (the provider's
 * message, else its stderr, else its exit), with every `redact` value removed.
 */
export function piSmoke(configured: { command: string; model: string; args?: string[]; environment?: Record<string, string>; commandArgs?: string[]; spawn?: typeof spawn }, options: { cwd?: string; timeoutMs?: number; redact?: string[] } = {}): Promise<SmokeResult> {
  const clean = (value: string) => bounded((options.redact ?? []).filter(Boolean).reduce((text, secret) => text.split(secret).join('[redacted]'), value).trim(), 480);
  return new Promise(resolveResult => {
    let answered = false, lastError: string | null = null, stderr = '', plain = '', buffer = '', done = false;
    const finish = (result: SmokeResult) => { if (done) return; done = true; clearTimeout(bound); resolveResult(result.error ? { ...result, error: clean(result.error) } : result); };
    const handle = (line: string) => {
      let record: any; try { record = JSON.parse(line); } catch { plain = `${plain}\n${line}`.slice(-2000); return; }
      if (record?.type === 'message_end' && record.message?.role === 'assistant') { if (record.message.errorMessage) lastError = String(record.message.errorMessage); else answered = true; }
      if (record?.type === 'auto_retry_end' && record.success === false && record.finalError) lastError = String(record.finalError);
    };
    let child: ChildProcess;
    try {
      child = (configured.spawn ?? spawn)(configured.command, [...(configured.commandArgs ?? []), '--mode', 'json', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve',
        '--no-tools', '--model', configured.model, ...(configured.args ?? []), '--', 'Reply with the single word OK.'], { cwd: options.cwd, env: runEnvironment(process.env, configured.environment), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { finish({ ok: false, error: `${configured.command} could not be started: ${error instanceof Error ? error.message : String(error)}` }); return; }
    const bound = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, error: `${configured.command} gave no answer within ${Math.round((options.timeoutMs ?? 120_000) / 1000)}s` }); }, options.timeoutMs ?? 120_000);
    bound.unref();
    const decoder = new StringDecoder('utf8');
    child.stdout!.on('data', (chunk: Buffer) => { buffer += decoder.write(chunk); let index: number; while ((index = buffer.indexOf('\n')) >= 0) { handle(buffer.slice(0, index).replace(/\r$/, '')); buffer = buffer.slice(index + 1); } });
    child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
    child.on('error', error => finish({ ok: false, error: `${configured.command} could not be started: ${error.message}` }));
    child.on('close', (code, signal) => {
      buffer += decoder.end(); if (buffer.trim()) handle(buffer.replace(/\r$/, ''));
      if (answered && !lastError && code === 0) return finish({ ok: true, error: null });
      finish({ ok: false, error: lastError ?? (stderr.trim() || plain.trim() || `${configured.command} exited ${signal ? `on ${signal}` : `with code ${code}`} without answering`) });
    });
  });
}
