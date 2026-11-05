// Concern: headless reviews and spec checks. A reviewer or spec checker no longer needs a Herdr pane,
// a TUI start wait or a CLI call to post: its runtime runs once, non-interactively, as one child
// process in the session's checkout, under the same coordinator confinement and credential mask a
// pane session gets, and answers with one JSON object on its output. The launcher posts that
// answer through the route the session's CLI used, with the launch's own one-time token, so the
// reviewer identity, independence and every gate are unchanged. The child never holds that token.
// GY-3113: the child is detached like a headless Pi run (its own transient scope under a systemd
// service), writes its output to a run directory on disk, and a loop restart leaves it running:
// the next loop adopts it from that directory and posts its answer.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { withAutonomyContract } from './autonomy.js';
import { assertLaunchable, nonInteractiveLaunch, requestPlaceholder, type RegisteredLaunch } from './harness.js';
import { launchProgram, sessionConfinement } from './master/launch.js';
import { detectRuntimeExhaustion } from './master/runtime-prompt.js';
import type { ExhaustionSignal } from './model/capacity.js';
import type { CredentialMask } from './master/confinement.js';
import { endRun, liveRun, registerRun, type AdoptedRun } from './runner/registry.js';
import { detachedLaunch, processIdentity, readRunMeta, runAlive, runContainment, runEnvironment, runFiles, signalRun, type RunMeta } from './runner/pi.js';
import { runRecord } from './runner/types.js';
import { underTestRunner } from './runtime-environment.js';
import { confinedRuntimeArgs } from './worker-sandbox.js';

/**
 * One child run: the confined command line, its directory and environment in; its standard output
 * out, or a throw naming why it failed. `run` is the run's directory on disk, where the host's exec
 * keeps its output and exit so a restarted loop can adopt it; `detached` stops the wait without
 * stopping the child.
 */
export type HeadlessExec = (command: string, args: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number; signal: AbortSignal; run: string; detached: AbortSignal }) => Promise<string>;

/**
 * How each runtime takes one request and exits: a subcommand before its own flags, the flags that
 * select print mode after them, and flags its one-shot form does not accept. The request is the
 * last argument, or takes a registry contract's `{request}` place. A runtime without a form here
 * keeps its pane session.
 */
const headlessForms: Record<string, { before: string[]; flags: string[]; drop?: string[] }> = {
  claude: { before: [], flags: ['-p'] },
  codex: { before: ['exec'], flags: ['--skip-git-repo-check'], drop: ['--ask-for-approval', '-a'] },
  cursor: { before: [], flags: ['-p'] },
  pi: { before: [], flags: ['-p'] },
  opencode: { before: ['run'], flags: [] },
};
export const headlessKind = (kind: string | undefined): kind is string => !!kind && Object.hasOwn(headlessForms, kind);

/** The runtime's one-shot arguments around the launch's own (`args`), with `prompt` as its request. */
export function headlessArgs(kind: string, args: readonly string[], prompt: string): string[] {
  const form = headlessForms[kind]!, drop = form.drop ?? [];
  const kept = args.filter((arg, index) => !drop.some(flag => arg === flag || arg.startsWith(`${flag}=`) || args[index - 1] === flag));
  const placed = kept.includes(requestPlaceholder);
  return [...form.before, ...kept.map(arg => arg === requestPlaceholder ? prompt : arg), ...form.flags, ...(placed ? [] : [prompt])];
}

/** The answer's text is bounded: what the run printed past this is ignored. */
const outputLimit = 1024 * 1024;
const readText = (file: string) => { try { return readFileSync(file, 'utf8'); } catch { return null; } };
/**
 * One child, detached (runner/pi.ts detachedLaunch): it leads its own session and, under a systemd
 * service, its own transient scope, so a stop of the loop's unit never takes it; stdin is closed,
 * and its output and exit go to its run directory. A non-zero exit or the bound is a failure naming
 * the last of its standard error, carrying what it printed as `output`.
 */
export const spawnHeadless: HeadlessExec = async (command, args, options) => {
  mkdirSync(options.run, { recursive: true, mode: 0o700 });
  rmSync(runFiles(options.run).exit, { force: true });
  const id = randomUUID(), containment = runContainment(), launch = detachedLaunch(options.run, id, command, args, containment);
  let failure: string | null = null;
  const child = spawn(launch.file, launch.args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'ignore', 'ignore'], detached: true });
  child.on('error', error => { failure = `${command} could not be started: ${error.message}`; });
  child.unref();
  const meta: RunMeta = { version: 1, id, command: command.slice(0, 4000), pid: child.pid ?? null, identity: child.pid ? processIdentity(child.pid) : null, containment, unit: launch.unit,
    startedAt: new Date().toISOString(), timeoutMs: options.timeoutMs, exitGraceMs: 0 };
  writeFileSync(runFiles(options.run).meta, JSON.stringify(meta), { mode: 0o600 });
  return awaitHeadlessRun(options.run, { signal: options.signal, detached: options.detached, failure: () => failure });
};

/**
 * Wait on a detached child from its run directory, whoever started it: its standard output once it
 * exits 0; a throw on any other exit, on its bound (it is killed), on `signal` (it is stopped), or
 * when its process is gone without an exit. `detached` stops the wait and leaves the child running.
 */
export function awaitHeadlessRun(directory: string, options: { signal?: AbortSignal; detached?: AbortSignal; failure?: () => string | null; pollMs?: number } = {}): Promise<string> {
  const files = runFiles(directory);
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (options.detached?.aborted) return;
      const meta = readRunMeta(directory), exit = readText(files.exit)?.trim() ?? null, command = meta?.command ?? 'the headless run';
      if (exit !== null) {
        const stdout = (readText(files.stdout) ?? '').slice(-outputLimit), stderr = (readText(files.stderr) ?? '').slice(-4000);
        if (exit === '0') return resolve(stdout);
        return reject(Object.assign(new Error(`${command} ${exit === 'spawn' ? 'could not be started' : `exited with code ${exit}`}${stderr.trim() ? `: ${stderr.trim().slice(-400)}` : ''}`), { output: `${stdout.slice(-4000)}\n${stderr}` }));
      }
      const failed = options.failure?.();
      if (failed) return reject(new Error(failed));
      if (!meta || !runAlive(meta)) return readText(files.exit) === null ? reject(new Error(`${command} is gone without recording an exit`)) : tick();
      if (options.signal?.aborted) { signalRun(meta, 'SIGTERM'); return reject(new Error(`${command} was stopped: ${String(options.signal.reason ?? 'cancelled')}`)); }
      if (Date.now() - Date.parse(meta.startedAt) > meta.timeoutMs) { signalRun(meta, 'SIGKILL'); return reject(new Error(`${command} ran past its ${Math.round(meta.timeoutMs / 60_000)}-minute bound and was killed`)); }
      setTimeout(tick, options.pollMs ?? 250);
    };
    tick();
  });
}
/** The launcher's exec: the host's, except under the test runner, where only a test's fake runs and launches keep their pane path. */
export const defaultHeadlessExec = (): HeadlessExec | null => underTestRunner() ? null : spawnHeadless;

/**
 * The last JSON object the run printed that `schema` accepts. Runtimes print prose or a code fence
 * around it, so every `{` before the final `}` is tried, nearest first; a run whose answer does
 * not parse or does not match is refused naming why, which the retry hands back to the runtime.
 */
export function jsonAnswer<T>(output: string, schema: z.ZodType<T>): T {
  const text = output.slice(-64 * 1024), end = text.lastIndexOf('}');
  let reason = 'it printed no JSON object';
  for (let start = text.lastIndexOf('{', end), tries = 0; start >= 0 && tries < 2000; start = start > 0 ? text.lastIndexOf('{', start - 1) : -1, tries++) {
    let value: unknown;
    try { value = JSON.parse(text.slice(start, end + 1)); } catch { continue; }
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    reason = `its JSON answer does not match: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'answer'}: ${issue.message}`).join('; ')}`;
  }
  throw new Error(reason);
}

/** Runs one request answers in: a malformed, refused or failed answer is run once more with the reason, then given up as an unanswered session is. */
export const headlessAttempts = 2;
/** Each run's bound: two fit inside the launch's one-hour token. */
export const headlessRunMs = 25 * 60_000;

export interface HeadlessSession<T> {
  /** The session name the run is listed under, beside Herdr's panes, while it runs. */
  name: string; work: string; subject: string;
  kind: string; args: string[]; environment: Record<string, string>; directory: string;
  contract?: RegisteredLaunch | null; credentialMask?: CredentialMask; coordinatorRoot?: string;
  /** The session's role text (prepareSessionHarness), which a pane session reads from its role file: here it opens the request. */
  role?: string | null;
  prompt: string;
  /** Posts what the run printed; a throw refuses the answer and names why. */
  answer: (output: string) => Promise<T>;
  /** The loop root whose run directory holds the run, and how a restarted loop posts its answer: the route's adopter and what it needs, never a credential (GY-3113). */
  root: string; route: HeadlessRoute; context: Record<string, string>;
  exec: HeadlessExec;
  /** Holds the run's account until the notice's reset, as a pane launch's limit-notice exit does (auto-dispatch.ts `holdAccount`), so the request's next launch takes the next account. */
  holdAccount?: (notice: ExhaustionSignal) => Promise<unknown>;
}

/**
 * Start a headless session: refused before anything runs when the runtime has no launch contract,
 * its folder cannot be trusted, or it cannot be confined — exactly as a pane session is. The run is
 * then listed under its session name while it lasts, so slots and supervision see it as a working
 * session; `settled` is its posted answer, or the reason no answer was accepted.
 */
export async function startHeadlessSession<T>(input: HeadlessSession<T>): Promise<{ settled: Promise<T> }> {
  assertLaunchable(input.kind, input.contract);
  const trust = await nonInteractiveLaunch[input.kind]?.trust?.(input.directory, input.environment, input.args);
  const confinement = await sessionConfinement(input.kind, input.args, { directory: input.directory, cwd: input.directory, environment: input.environment, ownGitHubCredential: true, credentialMask: input.credentialMask }, input.coordinatorRoot);
  if (trust) await nonInteractiveLaunch[input.kind]?.verify?.(trust);
  const wrapper = confinement?.wrapper ?? [], args = wrapper.length ? confinedRuntimeArgs(input.kind, input.args) : input.args;
  const controller = new AbortController(), detached = new AbortController(), startedAt = new Date().toISOString();
  const runDirectory = resolve(headlessRunsDirectory(input.root), randomUUID());
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(runDirectory, sessionFile), JSON.stringify({ name: input.name, work: input.work, subject: input.subject, kind: input.kind, route: input.route, context: input.context, startedAt } satisfies HeadlessSessionRecord), { mode: 0o600 });
  // Every session carries the autonomy contract (GY-184), as a pane session's first request does.
  const carried = withAutonomyContract(false, { request: input.prompt, role: input.role });
  const request = carried.role ? `${carried.role} ${carried.request}` : carried.request;
  let settled!: Promise<T>;
  registerRun({ name: input.name, role: 'reviewer', work: input.work, subject: input.subject, agent: input.kind, run: {
    id: randomUUID(), directory: runDirectory, events: [], onEvent: () => () => {}, cancel: reason => controller.abort(reason), detach: () => detached.abort(),
    result: () => settled.then(payload => ({ ok: true as const, tool: 'answer', payload, payloads: [payload] }), error => ({ ok: false as const, failure: { reason: 'no-payload' as const, detail: String(error?.message ?? error) }, payloads: [] })),
  } }, true);
  settled = (async () => {
    let refused = '';
    for (let attempt = 1; ; attempt++) {
      const prompt = attempt === 1 ? request : `${request}\n\nYour previous answer was not accepted: ${refused}. Answer again with the one JSON object asked for.`;
      const argv = [...wrapper, launchProgram(input.kind), ...headlessArgs(input.kind, args, prompt)];
      let output: string | null = null;
      try {
        output = await input.exec(argv[0]!, argv.slice(1), { cwd: input.directory, env: runEnvironment(process.env, input.environment), timeoutMs: headlessRunMs, signal: controller.signal, run: runDirectory, detached: detached.signal });
        return await input.answer(output);
      } catch (error) {
        refused = (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 400);
        // The provider's limit notice, read as a pane's is: the account is spent, so it is held and not run again.
        const notice = detectRuntimeExhaustion(output ?? (error as { output?: string })?.output ?? String((error as Error)?.message ?? error), input.kind, Date.now());
        if (notice) {
          await input.holdAccount?.(notice);
          throw new Error(`the headless run stopped on its provider's limit notice: ${notice.reason}; its account is held until ${notice.resetsAt ?? 'its reset'}`);
        }
        if (controller.signal.aborted || attempt >= headlessAttempts) throw new Error(`no answer accepted after ${attempt} run${attempt === 1 ? '' : 's'}: ${refused}`);
      }
    }
  })();
  void settled.catch(() => {}).finally(() => { endRun(input.name, runRecord(input.kind, { events: [] }, null, startedAt, new Date().toISOString())); rmSync(runDirectory, { recursive: true, force: true }); });
  return { settled };
}

// ---- Adoption after a loop restart (GY-3113) -------------------------------------------------------

export const headlessRunsDirectory = (root: string) => resolve(root, '.graphyard', 'headless-runs');
const sessionFile = 'session.json';
export type HeadlessRoute = 'review' | 'spec-check';
const sessionRecordSchema = z.object({ name: z.string().min(1).max(200), work: z.string().min(1).max(200), subject: z.string().min(1).max(200), kind: z.string().min(1).max(40),
  route: z.enum(['review', 'spec-check']), context: z.record(z.string(), z.string()), startedAt: z.string().max(40) });
export type HeadlessSessionRecord = z.infer<typeof sessionRecordSchema>;
/**
 * How a restarted loop finishes a route's run: posts what it printed (a throw refuses it) and then
 * settles the session either way, as the launch would have. Only one run: an adopted answer that
 * is refused settles the session unanswered, and its request relaunches.
 */
export type HeadlessAdopter = (session: HeadlessSessionRecord) => { answer: (output: string) => Promise<unknown>; settle: (failure: string | null) => Promise<unknown> };

/**
 * Adopt every headless run a stopped loop left in its run directory that no run of this process
 * holds: watch it until it ends (at once when it already has), post its answer through its route,
 * settle its session, and remove its directory. A run whose process is gone without an exit
 * settles unanswered.
 */
export function adoptHeadlessSessions(root: string, adopters: Record<HeadlessRoute, HeadlessAdopter>): AdoptedRun[] {
  const runsRoot = headlessRunsDirectory(root);
  let names: string[];
  try { names = readdirSync(runsRoot); } catch { return []; }
  return names.flatMap(name => {
    const directory = join(runsRoot, name);
    let session: HeadlessSessionRecord;
    try { session = sessionRecordSchema.parse(JSON.parse(readFileSync(join(directory, sessionFile), 'utf8'))); }
    catch { rmSync(directory, { recursive: true, force: true }); return []; }
    if (liveRun(session.name)) return [];
    const route = adopters[session.route](session), controller = new AbortController(), detached = new AbortController();
    const meta = readRunMeta(directory);
    let answered!: Promise<unknown>;
    registerRun({ name: session.name, role: 'reviewer', work: session.work, subject: session.subject, agent: session.kind, run: {
      id: randomUUID(), directory, events: [], onEvent: () => () => {}, cancel: reason => controller.abort(reason), detach: () => detached.abort(),
      result: () => answered.then(payload => ({ ok: true as const, tool: 'answer', payload, payloads: [payload] }), error => ({ ok: false as const, failure: { reason: 'no-payload' as const, detail: String(error?.message ?? error) }, payloads: [] })),
    } }, true);
    answered = awaitHeadlessRun(directory, { signal: controller.signal, detached: detached.signal }).then(route.answer);
    const settled = answered.then(() => null, (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 400))
      .then(failure => route.settle(failure)).catch(() => {}).then(() => {
        const record = runRecord(session.kind, { events: [] }, null, session.startedAt, new Date().toISOString());
        endRun(session.name, record);
        rmSync(directory, { recursive: true, force: true });
        return record;
      });
    return [{ name: session.name, role: 'reviewer' as const, work: session.work, subject: session.subject, directory, live: !!meta && runAlive(meta), settled }];
  });
}
