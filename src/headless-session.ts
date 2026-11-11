// Concern: headless sessions — reviews, and since GY-3259 workers (at the end of this file). A reviewer no longer needs a Herdr pane,
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
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import { withAutonomyContract } from './autonomy.js';
import { assertLaunchable, launchRecipe, requestPlaceholder, type RegisteredLaunch } from './harness.js';
import { launchProgram, sessionConfinement } from './master/launch.js';
import { realRuntimeBinary } from './runtime-binary.js';
import { detectRuntimeExhaustion } from './master/runtime-prompt.js';
import { detectLoggedOut } from './master/logged-out.js';
import type { ExhaustionSignal } from './model/capacity.js';
import type { CredentialMask } from './master/confinement.js';
import { endRun, liveRun, registerRun, type AdoptedRun } from './runner/registry.js';
import { detachedLaunch, processIdentity, readRunMeta, runAlive, runContainment, runEnvironment, runFiles, signalRun, type RunMeta } from './runner/pi.js';
import { runRecord } from './runner/types.js';
import { underTestRunner } from './runtime-environment.js';
import { runtimeAdapter } from './master/runtimes.js';
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
 * last argument, or takes a registry contract's `{request}` place. A runtime without a built-in form requires a registry headless contract.
 */
export const headlessKind = (kind: string | undefined, contract?: RegisteredLaunch | null): kind is string => !!kind && (!!runtimeAdapter(kind)?.headless || !!contract?.headlessArgs);
export class HeadlessConfigurationError extends Error {}

/** Explicit argv replaces the interactive argv and built-in form. A leading subcommand precedes policy flags. */
export function headlessArgs(kind: string, args: readonly string[], prompt: string, contract?: RegisteredLaunch | null): string[] {
  if (contract?.headlessArgs) {
    const words = contract.headlessArgs;
    if (words.filter(word => word === requestPlaceholder).length !== 1) throw new HeadlessConfigurationError(`${kind}: launch.headlessArgs must contain exactly one {request}`);
    const subcommand = words[0] !== requestPlaceholder && !words[0]?.startsWith('-') ? 1 : 0;
    return [...words.slice(0, subcommand), ...args.filter(arg => arg !== requestPlaceholder), ...words.slice(subcommand).map(arg => arg === requestPlaceholder ? prompt : arg)];
  }
  const form = runtimeAdapter(kind)?.headless;
  if (!form) throw new HeadlessConfigurationError(`The ${kind} runtime has no one-task contract. Set launch.headlessArgs with exactly one {request} using graphyard master registry runtime set NAME --headless-arg=ARG --reason REASON; reviews never use Herdr.`);
  const drop = form.drop ?? [];
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
  const id = basename(options.run), containment = runContainment(), launch = detachedLaunch(options.run, id, command, args, containment);
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
export const defaultHeadlessExec = (): HeadlessExec => underTestRunner() ? async () => { throw new Error('A test must supply a headless model executable; the host runtime is never used by tests'); } : spawnHeadless;
/** A live child may return from dispatch after this startup observation; early failures move accounts first. */
export const headlessStartupMs = 1000;
/**
 * A worker run's startup observation (GY-3259): its supervisor checks its assignment with the
 * control plane before the runtime starts, so a run that stops at once on its provider's limit
 * notice has ended well inside this, and the dispatch moves to the next account before it returns.
 */
export const workerStartupMs = 10_000;

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
  /** Holds the run's account until the notice's reset, as a pane launch's limit-notice exit does (dispatch/effects.ts `holdAccount`), so the request's next launch takes the next account. */
  holdAccount?: (notice: ExhaustionSignal) => Promise<unknown>;
  /**
   * The run's agent exited saying its account is not logged in (GY-3218): holds that account under
   * the agent's message and answers with the launch on the role's next eligible account, where the
   * request runs again at once. A throw (no account left) ends the session with that reason.
   */
  moveAccount?: (reason: string, cause?: 'login' | 'limit' | 'configuration') => Promise<HeadlessAccountLaunch>;
  /** Persist the stable run and actual runtime beside the request's verdict. */
  onRun?: (run: { id: string; kind: string; reason?: string }) => Promise<void>;
}
/** What the account a headless run is on decides of its launch. */
export type HeadlessAccountLaunch = Pick<HeadlessSession<unknown>, 'kind' | 'args' | 'environment' | 'contract' | 'credentialMask' | 'role'>;

/**
 * The run's confined launch on one account: refused when its runtime has no one-task contract, its
 * folder cannot be trusted or it cannot be confined, exactly as a pane session is. `ownGitHubCredential`
 * is false for a worker, which reaches no keyring at all (GY-1523).
 */
async function prepareHeadlessRun(on: HeadlessAccountLaunch, prompt: string, directory: string, coordinatorRoot: string | undefined, ownGitHubCredential: boolean) {
  headlessArgs(on.kind, on.args, prompt, on.contract);
  assertLaunchable(on.kind, on.contract ? { ...on.contract, args: on.contract.headlessArgs ?? on.contract.args } : null);
  const trust = await launchRecipe(on.kind)?.trust?.(directory, on.environment, on.args);
  const confinement = await sessionConfinement(on.kind, on.args, { directory, cwd: directory, environment: on.environment, ...(ownGitHubCredential ? { ownGitHubCredential: true } : { secretsBus: null }), credentialMask: on.credentialMask }, coordinatorRoot);
  if (trust) await launchRecipe(on.kind)?.verify?.(trust);
  const wrapper = confinement?.wrapper ?? [], args = wrapper.length ? confinedRuntimeArgs(on.kind, on.args) : on.args;
  // Every session carries the autonomy contract (GY-184), as a pane session's first request does.
  const carried = withAutonomyContract(false, { request: prompt, role: on.role });
  return { kind: on.kind, contract: on.contract, environment: on.environment, wrapper, args, request: carried.role ? `${carried.role} ${carried.request}` : carried.request };
}

/**
 * Start a headless session: refused before anything runs when the runtime has no launch contract,
 * its folder cannot be trusted, or it cannot be confined — exactly as a pane session is. The run is
 * then listed under its session name while it lasts, so slots and supervision see it as a working
 * session; `settled` is its posted answer, or the reason no answer was accepted.
 */
export async function startHeadlessSession<T>(input: HeadlessSession<T>): Promise<{ settled: Promise<T> }> {
  const prepare = (on: HeadlessAccountLaunch) => prepareHeadlessRun(on, input.prompt, input.directory, input.coordinatorRoot, true);
  const prepareAccount = async (initial: HeadlessAccountLaunch) => {
    let on = initial;
    for (;;) {
      try { return await prepare(on); }
      catch (error) {
        if (!(error instanceof HeadlessConfigurationError) || !input.moveAccount) throw error;
        on = await input.moveAccount(error.message, 'configuration');
      }
    }
  };
  let launch = await prepareAccount(input);
  const controller = new AbortController(), detached = new AbortController(), startedAt = new Date().toISOString();
  const id = randomUUID(), runDirectory = resolve(headlessRunsDirectory(input.root), id);
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  const persist = () => writeFileSync(join(runDirectory, sessionFile), JSON.stringify({ id, name: input.name, work: input.work, subject: input.subject, kind: launch.kind, route: input.route, context: input.context, startedAt } satisfies HeadlessSessionRecord), { mode: 0o600 });
  persist();
  let settled!: Promise<T>;
  registerRun({ name: input.name, role: 'reviewer', work: input.work, subject: input.subject, agent: input.kind, run: {
    id, directory: runDirectory, events: [], onEvent: () => () => {}, cancel: reason => controller.abort(reason), detach: () => detached.abort(),
    result: () => settled.then(payload => ({ ok: true as const, tool: 'answer', payload, payloads: [payload] }), error => ({ ok: false as const, failure: { reason: 'no-payload' as const, detail: String(error?.message ?? error) }, payloads: [] })),
  } }, true);
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  settled = (async () => {
    let refused = '';
    for (let attempt = 1; ; attempt++) {
      const prompt = attempt === 1 ? launch.request : `${launch.request}\n\nYour previous answer was not accepted: ${refused}. Answer again with the one JSON object asked for.`;
      const env = runEnvironment(process.env, launch.environment);
      const argv = [...launch.wrapper, realRuntimeBinary(runtimeAdapter(launch.kind)?.headless?.program ?? launchProgram(launch.kind), env), ...headlessArgs(launch.kind, launch.args, prompt, launch.contract)];
      const active = liveRun(input.name);
      if (active) active.agent = launch.kind;
      await input.onRun?.({ id, kind: launch.kind, ...(refused ? { reason: refused } : {}) });
      persist();
      let output: string | null = null;
      let startup: NodeJS.Timeout | undefined;
      try {
        const running = input.exec(argv[0]!, argv.slice(1), { cwd: input.directory, env, timeoutMs: headlessRunMs, signal: controller.signal, run: runDirectory, detached: detached.signal });
        startup = setTimeout(ready, headlessStartupMs);
        output = await running.finally(() => clearTimeout(startup));
        return await input.answer(output);
      } catch (error) {
        clearTimeout(startup);
        refused = (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 400);
        // The provider's limit notice, read as a pane's is: the account is spent, so it is held and not run again.
        const printed = output ?? (error as { output?: string })?.output ?? String((error as Error)?.message ?? error);
        const notice = detectRuntimeExhaustion(printed, launch.kind, Date.now());
        if (notice) {
          await input.holdAccount?.(notice);
          if (input.moveAccount && !controller.signal.aborted) { launch = await prepareAccount(await input.moveAccount(`the headless run stopped on its provider's limit notice: ${notice.reason}`, 'limit')); attempt = 0; continue; }
          throw new Error(`the headless run stopped on its provider's limit notice: ${notice.reason}; its account is held until ${notice.resetsAt ?? 'its reset'}`);
        }
        // A failed run whose agent said it is not logged in (GY-3218): its account is held and the request runs on the next.
        const loggedOut = output === null && input.moveAccount && !controller.signal.aborted ? detectLoggedOut(printed) : null;
        if (loggedOut) { launch = await prepareAccount(await input.moveAccount!(loggedOut, 'login')); attempt = 0; continue; }
        if (controller.signal.aborted || attempt >= headlessAttempts) throw new Error(`no answer accepted after ${attempt} run${attempt === 1 ? '' : 's'}: ${refused}`);
      }
    }
  })().finally(ready);
  void settled.catch(() => {}).finally(() => { endRun(input.name, runRecord(launch.kind, { events: [] }, null, startedAt, new Date().toISOString())); rmSync(runDirectory, { recursive: true, force: true }); });
  await started;
  return { settled };
}

// ---- Adoption after a loop restart (GY-3113) -------------------------------------------------------

export const headlessRunsDirectory = (root: string) => resolve(root, '.graphyard', 'headless-runs');
const sessionFile = 'session.json';
export type HeadlessRoute = 'review';
const sessionRecordSchema = z.object({ id: z.string().optional(), name: z.string().min(1).max(200), work: z.string().min(1).max(200), subject: z.string().min(1).max(200), kind: z.string().min(1).max(40),
  route: z.enum(['review']), context: z.record(z.string(), z.string()), startedAt: z.string().max(40) });
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
      id: session.id ?? name, directory, events: [], onEvent: () => () => {}, cancel: reason => controller.abort(reason), detach: () => detached.abort(),
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

// ---- Workers (GY-3259) -----------------------------------------------------------------------------

/**
 * Where a worker's runs live: in the loop's own installation state, never in the worktree the
 * worker writes, and kept after the run ends so its log stays readable through every handoff.
 */
export const workerRunsDirectory = (root: string) => resolve(root, '.graphyard', 'worker-runs');
const runLogName = 'log.jsonl';
const workerRecordSchema = z.object({ id: z.string().uuid(), name: z.string().min(1).max(200), work: z.string().min(1).max(200), epoch: z.number().int().positive(),
  principal: z.string().min(1).max(200), account: z.string().max(200).nullable(), kind: z.string().min(1).max(40), subject: z.string().min(1).max(300), startedAt: z.string().max(40) });
export type HeadlessWorkerRecord = z.infer<typeof workerRecordSchema>;

export interface HeadlessWorker extends HeadlessAccountLaunch {
  /** The profile's agent name the run is listed under while it lasts, beside the role's other sessions. */
  name: string; work: string; subject: string; epoch: number; principal: string; account: string | null;
  /** The worktree the attempt was assigned; `supervisor` the `graphyard watch KEY EPOCH --` words that hold its lease. */
  directory: string; supervisor: string[]; coordinatorRoot?: string; prompt: string;
  root: string; exec: HeadlessExec;
  /** The run's hard bound, the configured attempt ceiling; the loop's attempt bound stops a run without progress first. */
  timeoutMs: number;
  /** How long the start is watched; `workerStartupMs` by default. */
  startupMs?: number;
  /** Hears a run that outlived its startup observation end, with what it printed, once its process has ended. */
  settle?: (ended: { output: string; ok: boolean }) => Promise<unknown>;
}

/**
 * Start one worker run: its runtime's one-task form under `graphyard watch`, which claims nothing
 * itself but heartbeats the lease the launcher claimed under the worker's own identity, stops the
 * runtime the moment that lease is lost and releases it when the runtime exits without `complete`.
 * The run is watched for `workerStartupMs`; one that ended in that time is returned with what it
 * printed and whether it exited 0, so the launcher can move a spent account on before it returns. Otherwise it is listed as
 * a live session until it ends, and its log and record stay on disk after.
 */
export async function startHeadlessWorker(input: HeadlessWorker): Promise<{ id: string; ended: { output: string; ok: boolean } | null }> {
  const launch = await prepareHeadlessRun(input, input.prompt, input.directory, input.coordinatorRoot, false);
  const id = randomUUID(), directory = resolve(workerRunsDirectory(input.root), id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const record: HeadlessWorkerRecord = { id, name: input.name, work: input.work, epoch: input.epoch, principal: input.principal, account: input.account, kind: launch.kind, subject: input.subject.slice(0, 300), startedAt: new Date().toISOString() };
  writeFileSync(join(directory, sessionFile), JSON.stringify(record), { mode: 0o600 });
  const env = runEnvironment(process.env, { ...launch.environment, GRAPHYARD_RUN_LOG: join(directory, runLogName) });
  const argv = [...input.supervisor, ...launch.wrapper, realRuntimeBinary(runtimeAdapter(launch.kind)?.headless?.program ?? launchProgram(launch.kind), env), ...headlessArgs(launch.kind, launch.args, launch.request, launch.contract)];
  const stop = new AbortController(), detached = new AbortController();
  const running = input.exec(argv[0]!, argv.slice(1), { cwd: input.directory, env, timeoutMs: input.timeoutMs, signal: stop.signal, run: directory, detached: detached.signal });
  const ended = await Promise.race([running.then(() => ({ ok: true }), () => ({ ok: false })), new Promise<null>(done => setTimeout(() => done(null), input.startupMs ?? workerStartupMs).unref())]);
  const printed = () => readRunLog(input.root, id)?.lines.map(line => line.text).join('\n') ?? '';
  if (ended) return { id, ended: { ...ended, output: printed() } };
  void watchWorker(record, directory, running, stop, detached).then(async () => detached.signal.aborted ? undefined : input.settle?.({ output: printed(), ok: await running.then(() => true, () => false) })).catch(() => {});
  return { id, ended: null };
}

/** Lists the run as a live worker session until it ends; stopping the loop detaches it, and the next loop adopts it. */
function watchWorker(record: HeadlessWorkerRecord, directory: string, running: Promise<unknown>, stop: AbortController, detached: AbortController) {
  registerRun({ name: record.name, role: 'worker', work: record.work, subject: record.subject, agent: record.kind, run: {
    id: record.id, directory, events: [], onEvent: () => () => {}, cancel: reason => stop.abort(reason), detach: () => detached.abort(),
    result: () => running.then(payload => ({ ok: true as const, tool: 'complete', payload, payloads: [payload] }), error => ({ ok: false as const, failure: { reason: 'no-payload' as const, detail: String(error?.message ?? error) }, payloads: [] })),
  } }, true);
  return running.catch(() => {}).then(() => {
    const ended = runRecord(record.kind, { events: [] }, null, record.startedAt, new Date().toISOString());
    if (!detached.signal.aborted) endRun(record.name, ended);
    return ended;
  });
}

/** Every worker run a stopped loop left running, adopted and listed again until it ends (GY-3113's restart adoption). */
export function adoptHeadlessWorkers(root: string): AdoptedRun[] {
  let names: string[];
  try { names = readdirSync(workerRunsDirectory(root)); } catch { return []; }
  return names.flatMap(name => {
    const directory = join(workerRunsDirectory(root), name), record = readWorkerRecord(directory), meta = readRunMeta(directory);
    if (!record || !meta || readText(runFiles(directory).exit) !== null || !runAlive(meta) || liveRun(record.name)) return [];
    const stop = new AbortController(), detached = new AbortController();
    const settled = watchWorker(record, directory, awaitHeadlessRun(directory, { signal: stop.signal, detached: detached.signal }), stop, detached);
    return [{ name: record.name, role: 'worker' as const, work: record.work, subject: record.subject, directory, live: true, settled }];
  });
}
const readWorkerRecord = (directory: string) => { try { return workerRecordSchema.parse(JSON.parse(readFileSync(join(directory, sessionFile), 'utf8'))); } catch { return null; } };

/** The most a log read returns at once. */
export const runLogChunkBytes = 64 * 1024;
export interface RunLogLine { at: string; stream: 'stdout' | 'stderr'; text: string }
/**
 * One bounded chunk of a worker run's log from byte `cursor`, whole lines only, with the run's
 * record and whether it has ended; null for a run this installation does not hold. The lines were
 * redacted as they were written.
 */
export function readRunLog(root: string, id: string, cursor = 0): { run: HeadlessWorkerRecord; lines: RunLogLine[]; cursor: number; ended: boolean } | null {
  if (!z.string().uuid().safeParse(id).success) return null;
  const directory = join(workerRunsDirectory(root), id), run = readWorkerRecord(directory);
  if (!run) return null;
  const ended = readText(runFiles(directory).exit) !== null;
  let bytes: Buffer;
  try { bytes = readFileSync(join(directory, runLogName)); } catch { return { run, lines: [], cursor: 0, ended }; }
  const from = Math.max(0, Math.min(cursor, bytes.length)), chunk = bytes.subarray(from, from + runLogChunkBytes);
  const whole = chunk.length < runLogChunkBytes && from + chunk.length === bytes.length ? chunk.length : chunk.lastIndexOf(10) + 1 || chunk.length;
  const lines = chunk.subarray(0, whole).toString('utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as RunLogLine]; } catch { return []; } });
  return { run, lines, cursor: from + whole, ended: ended && from + whole >= bytes.length };
}
