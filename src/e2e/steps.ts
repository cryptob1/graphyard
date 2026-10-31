import { execFileSync, spawn } from 'node:child_process';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configHome, installDirectory } from '../install/secrets.js';
import { installIdFor } from '../install/types.js';
import { repositoryFromRemote } from '../onboarding.js';
import { parseEnvValue } from '../producer.js';
import type { E2eStep } from './case.js';

/**
 * The general E2E steps (GY-1536), run by src/e2e/runner.ts beside its http and browser steps:
 *
 * - `command` runs the project's own test command (Playwright or anything) through the shell in
 *   the candidate checkout, with `TARGET_URL` set to the case's target; exit 0 passes and the last
 *   50 lines of output are kept either way.
 * - `agent` hands the agent-browser CLI a goal at the target URL plus `path` and the case's success
 *   criteria, and reads the one `VERDICT: PASS` or `VERDICT: FAIL - reason` line it is told to end
 *   with; the screenshot it takes afterwards is recorded by path.
 *
 * A step's process holds `TARGET_URL`, the case's declared secrets and the host basics a process
 * needs (PATH, HOME, locale, temp), and nothing else Graphyard holds: no worker, reviewer, GitHub
 * or deploy credential. Every secret value is redacted from what is recorded.
 */
export const keptOutputLines = 50;
/** Host variables a step's process keeps: what a command needs to run at all, never a credential. */
export const hostPassthrough = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ', 'DISPLAY', 'XDG_RUNTIME_DIR', 'PLAYWRIGHT_BROWSERS_PATH', 'CI'] as const;

/** The environment a step's process gets: the host basics, the target, what was live when one serves (GY-2985), and the case's secrets — none of the three overridable by a secret. */
export function stepEnvironment(url: string, secrets: Record<string, string>, host: NodeJS.ProcessEnv = process.env, baselineUrl?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of hostPassthrough) if (host[name] !== undefined) env[name] = host[name]!;
  return { ...env, ...secrets, ...(baselineUrl ? { BASELINE_URL: baselineUrl } : {}), TARGET_URL: url };
}

export interface ProcessResult { code: number | null; output: string; timedOut: boolean }
/** `signal` cancels the process (GY-1718: a merge preview past its budget), killing it as its timeout does. */
export type ProcessRunner = (command: string, args: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number; shell: boolean; signal?: AbortSignal }) => Promise<ProcessResult>;

/** Run one process, both streams interleaved, its process group killed outright at its timeout or on `signal`; only the last ~4 MB of output is kept. */
export const runProcess: ProcessRunner = (command, args, options) => new Promise(resolve => {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: options.shell, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const chunks: Buffer[] = [];
  let timedOut = false, size = 0;
  const keep = (chunk: Buffer) => { chunks.push(chunk); size += chunk.length; while (size - chunks[0].length >= 4_000_000) size -= chunks.shift()!.length; };
  child.stdout.on('data', keep); child.stderr.on('data', keep);
  const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
  const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs);
  const settle = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', kill); };
  if (options.signal?.aborted) kill(); else options.signal?.addEventListener('abort', kill, { once: true });
  child.on('error', error => { settle(); resolve({ code: null, output: `${Buffer.concat(chunks).toString('utf8')}${error.message}`, timedOut }); });
  child.on('close', code => { settle(); resolve({ code, output: Buffer.concat(chunks).toString('utf8'), timedOut }); });
});

/** The last `keptOutputLines` lines of a process's output. */
export function lastLines(output: string, count = keptOutputLines) {
  const lines = output.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  return lines.length === 1 && !lines[0] ? [] : lines.slice(-count);
}

/** Every secret value replaced by its name, longest first so one value inside another never leaks a part. */
export function redact(text: string, secrets: Record<string, string>): string {
  let result = text;
  for (const [name, value] of Object.entries(secrets).sort((a, b) => b[1].length - a[1].length)) if (value) result = result.split(value).join(`[secret:${name}]`);
  return result;
}
/** Every string in a value redacted, before anything truncates it: a cut through a value must never leave its prefix. */
export function redactValues<T>(value: T, secrets: Record<string, string>): T {
  if (typeof value === 'string') return redact(value, secrets) as T;
  if (Array.isArray(value)) return value.map(entry => redactValues(entry, secrets)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValues(entry, secrets)])) as T;
  return value;
}

export interface StepRecord { index: number; name: string; kind: 'command' | 'agent'; outcome: 'pass' | 'fail'; output: string[]; verdict?: string; screenshots?: string[] }

/** The verdict line agent-browser is told to end with: the last one wins, so its own reasoning never counts. */
export function parseVerdict(output: string): { outcome: 'pass' | 'fail'; verdict: string | null; reason: string | null } {
  const lines = [...output.matchAll(/^\s*VERDICT:\s*(PASS|FAIL)\b\s*(?:-\s*(.*))?$/gim)];
  const last = lines.at(-1);
  if (!last) return { outcome: 'fail', verdict: null, reason: 'agent-browser ended without a VERDICT line' };
  const verdict = last[1].toUpperCase() === 'PASS' ? 'PASS' : 'FAIL';
  const reason = last[2]?.trim() || null;
  return { outcome: verdict === 'PASS' ? 'pass' : 'fail', verdict: verdict === 'PASS' ? 'VERDICT: PASS' : `VERDICT: FAIL - ${reason ?? 'no reason given'}`, reason: verdict === 'PASS' ? null : reason ?? 'agent-browser gave no reason' };
}

/** What agent-browser is asked: the goal, the success criteria, and the one line it ends with. */
export function agentPrompt(step: Extract<E2eStep, { kind: 'agent' }>, url: string) {
  return [`You are testing the web application at ${url}; the page is already open.`, `Goal: ${step.goal}`, 'The goal is achieved only when every one of these holds:', ...step.success.map((criterion, index) => `${index + 1}. ${criterion}`),
    'Work in the browser until the goal is achieved or you are sure it cannot be. Then end your answer with exactly one final line, either `VERDICT: PASS` or `VERDICT: FAIL - <reason>`, and nothing after it.'].join('\n');
}

/** What the judge of a compare step is given for each of the two runs (GY-2985): where it ran, what the agent answered, and the screenshots kept. */
export interface CompareRun { url: string; transcript: readonly string[]; screenshots: readonly string[] }
/** What a compare step hands its judge (GY-2985): the goal and criteria, and both runs — the candidate build's and the baseline's. */
export interface CompareInput { goal: string; success: readonly string[]; target: CompareRun; baseline: CompareRun }
/** How a compare step's judge answers (GY-2985): the candidate is the same, better, or worse than what was live. */
export interface CompareVerdict { verdict: 'SAME' | 'BETTER' | 'WORSE'; reason: string | null }
/** The one judge call a compare step makes (GY-2985). */
export type CompareJudge = (input: CompareInput) => Promise<CompareVerdict>;

export interface GeneralStepContext { url: string; root: string; env: Record<string, string>; secrets: Record<string, string>; run: ProcessRunner; artifacts: string; session: string; signal?: AbortSignal;
  /** GY-2985: how a compare step's one judge call answers; the agent-browser judge when unnamed. */
  judge?: CompareJudge }

/** A command step: pass on exit 0, fail otherwise, with the last lines of output kept. */
export async function runCommandStep(step: Extract<E2eStep, { kind: 'command' }>, context: GeneralStepContext): Promise<{ record: Omit<StepRecord, 'index' | 'name'>; reason: string | null }> {
  const result = await context.run(step.run, [], { cwd: context.root, env: context.env, timeoutMs: step.timeoutSeconds * 1000, shell: true, signal: context.signal });
  const output = lastLines(redact(result.output, context.secrets));
  const reason = result.timedOut ? `the command did not finish within ${step.timeoutSeconds} s` : result.code === 0 ? null : `the command exited ${result.code ?? 'by signal'}${output.length ? `: ${output.at(-1)!.slice(0, 500)}` : ''}`;
  return { record: { kind: 'command', outcome: reason ? 'fail' : 'pass', output }, reason };
}

/** The judge's verdict line (GY-2985): the last `VERDICT: SAME|BETTER|WORSE` wins, so its own reasoning never counts; none is no verdict. */
export function parseCompareVerdict(output: string): CompareVerdict | null {
  const last = [...output.matchAll(/^\s*VERDICT:\s*(SAME|BETTER|WORSE)\b\s*(?:-\s*(.*))?$/gim)].at(-1);
  return last ? { verdict: last[1].toUpperCase() as CompareVerdict['verdict'], reason: last[2]?.trim() || null } : null;
}

/** What the compare judge is asked (GY-2985): both runs of one goal, and the one line it ends with. */
export function compareJudgePrompt(input: CompareInput) {
  return ['You are judging two builds of one web application by the same goal, run on each.',
    `Goal: ${input.goal}`, 'The goal is achieved only when every one of these holds:', ...input.success.map((criterion, index) => `${index + 1}. ${criterion}`),
    `The candidate build answered at ${input.target.url}:`, ...input.target.transcript, `Its screenshot: ${input.target.screenshots.join(', ') || 'none'}`,
    `The baseline build, what was live before the candidate, answered at ${input.baseline.url}:`, ...input.baseline.transcript, `Its screenshot: ${input.baseline.screenshots.join(', ') || 'none'}`,
    'Look at both answers and screenshots and judge whether the candidate build is worse for a user pursuing this goal. Then end your answer with exactly one final line, either `VERDICT: SAME`, `VERDICT: BETTER` or `VERDICT: WORSE - <reason>`, and nothing after it.'].join('\n');
}

/** The default compare judge (GY-2985): one agent-browser call in its own session within the step's remaining time. */
export function agentBrowserJudge(context: GeneralStepContext, session: string, deadline: number): CompareJudge {
  return async input => {
    const result = await context.run('agent-browser', ['--session', session, 'chat', compareJudgePrompt(input)], { cwd: context.root, env: context.env, timeoutMs: Math.max(1, deadline - Date.now()), shell: false, signal: context.signal });
    const judged = parseCompareVerdict(result.output);
    if (!judged) throw new Error(result.timedOut ? 'the judge did not finish in the step\'s time' : 'the judge ended without a VERDICT line');
    return judged;
  };
}

/** The first line of an error, for a step's failure reason. */
const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0];

/** One agent-browser session's run of the goal at `base` (GY-2985): open the page, hand agent-browser the goal, read its verdict, keep a screenshot, close the session. */
async function agentLeg(step: Extract<E2eStep, { kind: 'agent' }>, base: string, context: GeneralStepContext, session: string, deadline: number): Promise<{ transcript: string[]; screenshots: string[]; reason: string | null; verdict?: string }> {
  const target = new URL(step.path ?? '/', base).toString();
  const prefix = ['--session', session];
  // A cancelled run kills the step's invocations; only the session's own close still runs, bounded by its timeout.
  const invoke = (args: string[], timeoutMs: number, cancellable = true) => context.run('agent-browser', [...prefix, ...args], { cwd: context.root, env: context.env, timeoutMs, shell: false, signal: cancellable ? context.signal : undefined });
  const remaining = () => Math.max(1, deadline - Date.now());
  const transcript: string[] = [];
  let reason: string | null = null, verdict: string | undefined;
  const screenshots: string[] = [];
  try {
    const opened = await invoke(['open', target], Math.min(remaining(), 120_000));
    transcript.push(opened.output);
    if (opened.timedOut || opened.code !== 0) reason = `agent-browser could not open ${target}${opened.output.trim() ? `: ${lastLines(redact(opened.output, context.secrets), 1)[0].slice(0, 500)}` : ''}`;
    else {
      const chat = await invoke(['chat', agentPrompt(step, base)], remaining());
      transcript.push(chat.output);
      if (chat.timedOut) reason = `agent-browser did not finish within ${step.timeoutSeconds} s`;
      else {
        const judged = parseVerdict(chat.output);
        verdict = judged.verdict ?? undefined; reason = judged.reason;
        if (chat.code !== 0 && (!judged.verdict || !reason)) reason = `agent-browser exited ${chat.code ?? 'by signal'}${judged.verdict ? ` after ${judged.verdict}` : ' without a VERDICT line'}`;
      }
      await mkdir(context.artifacts, { recursive: true });
      const file = join(context.artifacts, `${session}.png`);
      const shot = await invoke(['screenshot', file], Math.min(remaining(), 60_000));
      if (!shot.timedOut && shot.code === 0) screenshots.push(file); else transcript.push(shot.output);
    }
  } finally { await invoke(['close'], 30_000, false).catch(() => {}); }
  return { transcript, screenshots, reason, verdict };
}

/** An agent step: open the page, hand agent-browser the goal, read its verdict, keep a screenshot, close the session. A compare step (GY-2985) with a baseline serving runs the same goal there too, then one judge call given both transcripts and screenshots answers `VERDICT: SAME|BETTER|WORSE - reason`; WORSE fails the case and names the reason. Without a baseline (the first serve) the step runs as today. */
export async function runAgentStep(step: Extract<E2eStep, { kind: 'agent' }>, context: GeneralStepContext): Promise<{ record: Omit<StepRecord, 'index' | 'name'>; reason: string | null }> {
  const deadline = Date.now() + step.timeoutSeconds * 1000;
  const ran = await agentLeg(step, context.url, context, context.session, deadline);
  let reason = ran.reason, verdict = ran.verdict;
  const screenshots = ran.screenshots;
  if (!reason && step.compare && context.env.BASELINE_URL) {
    const baselineLeg = await agentLeg(step, context.env.BASELINE_URL, context, `${context.session}-baseline`, deadline);
    if (baselineLeg.reason) reason = baselineLeg.reason;
    else {
      const input: CompareInput = {
        goal: step.goal, success: step.success,
        target: { url: new URL(step.path ?? '/', context.url).toString(), transcript: lastLines(redact(ran.transcript.join('\n'), context.secrets)), screenshots },
        baseline: { url: new URL(step.path ?? '/', context.env.BASELINE_URL).toString(), transcript: lastLines(redact(baselineLeg.transcript.join('\n'), context.secrets)), screenshots: baselineLeg.screenshots },
      };
      try {
        const judged = await (context.judge ?? agentBrowserJudge(context, `${context.session}-judge`, deadline))(input);
        verdict = `VERDICT: ${judged.verdict}${judged.reason ? ` - ${judged.reason}` : ''}`;
        if (judged.verdict === 'WORSE') reason = judged.reason ?? 'the judge judged the new build worse than what was live';
      } catch (error) { reason = firstLine(error); }
    }
  }
  const output = lastLines(redact(ran.transcript.join('\n'), context.secrets));
  return { record: { kind: 'agent', outcome: reason ? 'fail' : 'pass', output, ...(verdict ? { verdict: redact(verdict, context.secrets) } : {}), screenshots }, reason: reason && redact(reason, context.secrets) };
}

/** `e2e-secrets.<target>.env` under the install directory: written by the operator, mode 0600, never committed. */
export const secretsFileName = (target: string) => `e2e-secrets.${target}.env`;

/**
 * Where a checkout's install keeps its E2E secrets: `~/.config/graphyard/<install>/`, the install
 * named after the checkout's GitHub origin, as every credential of that install is.
 */
export function installSecretsDirectory(root: string, home = configHome()) {
  let remote: string;
  try { remote = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { throw new Error(`${root} has no git origin, so no install directory holds its E2E secrets`); }
  const repository = repositoryFromRemote(remote);
  if (!repository) throw new Error(`the origin of ${root} is not a GitHub repository, so no install directory holds its E2E secrets`);
  return installDirectory(installIdFor(repository), home);
}

/**
 * The values of a case's declared secrets, from `<directory>/e2e-secrets.<target>.env`: a missing
 * or unreadable file, a group- or world-readable one, or a declared name the file does not set,
 * fails the case before it runs, naming the file and the variable. Values are never named.
 */
export async function loadSecrets(names: readonly string[], target: string, directory: () => string): Promise<Record<string, string>> {
  if (!names.length) return {};
  const file = join(directory(), secretsFileName(target));
  let content: string;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.mode & 0o077) throw new Error(`${file} must be a regular file with mode 0600`);
    content = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`declared secret ${names[0]} is not set: ${file} does not exist`);
    throw error;
  }
  const values: Record<string, string> = {};
  for (const [number, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trim().replace(/^export\s+/, '');
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = parseEnvValue(trimmed.slice(separator + 1));
    if (value === null) throw new Error(`${file} line ${number + 1}: the value of ${key} has unpaired quotes or text after its closing quote`);
    values[key] = value;
  }
  const secrets: Record<string, string> = {};
  for (const name of names) {
    if (!values[name]) throw new Error(`declared secret ${name} is not set in ${file}`);
    secrets[name] = values[name];
  }
  return secrets;
}
