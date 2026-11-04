// Concern: headless reviews and spec checks. A reviewer or spec checker no longer needs a Herdr pane,
// a TUI start wait or a CLI call to post: its runtime runs once, non-interactively, as one child
// process in the session's checkout, under the same coordinator confinement and credential mask a
// pane session gets, and answers with one JSON object on its output. The launcher posts that
// answer through the route the session's CLI used, with the launch's own one-time token, so the
// reviewer identity, independence and every gate are unchanged. The child never holds that token.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { withAutonomyContract } from './autonomy.js';
import { assertLaunchable, nonInteractiveLaunch, requestPlaceholder, type RegisteredLaunch } from './harness.js';
import { launchProgram, sessionConfinement } from './master/launch.js';
import type { CredentialMask } from './master/confinement.js';
import { endRun, registerRun } from './runner/registry.js';
import { runEnvironment } from './runner/pi.js';
import { runRecord } from './runner/types.js';
import { underTestRunner } from './runtime-environment.js';
import { confinedRuntimeArgs } from './worker-sandbox.js';

/** One child run: the confined command line, its directory and environment in; its standard output out, or a throw naming why it failed. */
export type HeadlessExec = (command: string, args: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number; signal: AbortSignal }) => Promise<string>;

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
/** One child, stdin closed, its output collected; a non-zero exit, a signal or the bound is a failure naming the last of its standard error. */
export const spawnHeadless: HeadlessExec = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], signal: options.signal, timeout: options.timeoutMs, killSignal: 'SIGKILL' });
  let stdout = '', stderr = '';
  child.stdout!.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString('utf8')).slice(-outputLimit); });
  child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
  child.on('error', reject);
  child.on('close', (code, signal) => code === 0 ? resolve(stdout)
    : reject(new Error(`${command} exited ${signal ? `on ${signal}` : `with code ${code}`}${stderr.trim() ? `: ${stderr.trim().slice(-400)}` : ''}`)));
});
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
  contract?: RegisteredLaunch | null; credentialMask?: CredentialMask;
  /** The session's role text (prepareSessionHarness), which a pane session reads from its role file: here it opens the request. */
  role?: string | null;
  prompt: string;
  /** Posts what the run printed; a throw refuses the answer and names why. */
  answer: (output: string) => Promise<T>;
  exec: HeadlessExec;
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
  const confinement = await sessionConfinement(input.kind, input.args, { directory: input.directory, cwd: input.directory, environment: input.environment, ownGitHubCredential: true, credentialMask: input.credentialMask });
  if (trust) await nonInteractiveLaunch[input.kind]?.verify?.(trust);
  const wrapper = confinement?.wrapper ?? [], args = wrapper.length ? confinedRuntimeArgs(input.kind, input.args) : input.args;
  const controller = new AbortController(), startedAt = new Date().toISOString();
  // Every session carries the autonomy contract (GY-184), as a pane session's first request does.
  const carried = withAutonomyContract(false, { request: input.prompt, role: input.role });
  const request = carried.role ? `${carried.role} ${carried.request}` : carried.request;
  let settled!: Promise<T>;
  registerRun({ name: input.name, role: 'reviewer', work: input.work, subject: input.subject, agent: input.kind, run: {
    id: randomUUID(), events: [], onEvent: () => () => {}, cancel: reason => controller.abort(reason),
    result: () => settled.then(payload => ({ ok: true as const, tool: 'answer', payload, payloads: [payload] }), error => ({ ok: false as const, failure: { reason: 'no-payload' as const, detail: String(error?.message ?? error) }, payloads: [] })),
  } });
  settled = (async () => {
    let refused = '';
    for (let attempt = 1; ; attempt++) {
      const prompt = attempt === 1 ? request : `${request}\n\nYour previous answer was not accepted: ${refused}. Answer again with the one JSON object asked for.`;
      const argv = [...wrapper, launchProgram(input.kind), ...headlessArgs(input.kind, args, prompt)];
      try { return await input.answer(await input.exec(argv[0]!, argv.slice(1), { cwd: input.directory, env: runEnvironment(process.env, input.environment), timeoutMs: headlessRunMs, signal: controller.signal })); }
      catch (error) {
        refused = (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 400);
        if (controller.signal.aborted || attempt >= headlessAttempts) throw new Error(`no answer accepted after ${attempt} run${attempt === 1 ? '' : 's'}: ${refused}`);
      }
    }
  })();
  void settled.catch(() => {}).finally(() => endRun(input.name, runRecord(input.kind, { events: [] }, null, startedAt, new Date().toISOString())));
  return { settled };
}
