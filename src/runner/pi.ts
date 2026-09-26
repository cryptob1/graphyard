import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import type { Run, RunEvent, RunFailure, RunOptions, RunResult, Runner } from './types.js';

/**
 * The Pi implementation of the runner (GY-169). It launches `pi --mode json` in the given
 * worktree through the given environment wrapper (`pi-a`, `pi-b`: each sets PI_CODING_AGENT_DIR
 * and reads its provider key at run time) and model, with the Graphyard extension
 * (integrations/pi) as its only extension, and reads Pi's JSONL event stream. There is no
 * terminal: stdin is closed, so nothing can wait on a person, and JSON mode exits once the prompt
 * is settled.
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

/** One reported token count: a bare number, or `{ tokens }` — the shapes providers report. */
const tokenCount = (value: any): number | null => typeof value === 'number' && Number.isFinite(value) ? value
  : value && typeof value === 'object' && typeof value.tokens === 'number' && Number.isFinite(value.tokens) ? value.tokens : null;
/** The usage a message end reports, when it reports one: the call's input and output tokens (GY-401). */
export const usageOf = (value: unknown): { input: number; output: number } | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const input = tokenCount((value as any).input), output = tokenCount((value as any).output);
  return input === null && output === null ? undefined : { input: input ?? 0, output: output ?? 0 };
};

/** One Pi JSONL record as a runner event; null for the streaming noise a record does not keep. */
export function piEvent(record: any, at: string): RunEvent | null {
  switch (record?.type) {
    case 'session': return { kind: 'session', at, id: String(record.id ?? '') };
    case 'message_end': {
      const usage = usageOf(record.message?.usage);
      return { kind: 'message', at, role: String(record.message?.role ?? 'unknown'), text: bounded(text(record.message?.content)), stopReason: record.message?.stopReason ?? null, error: record.message?.errorMessage ?? null, ...(usage ? { usage } : {}) };
    }
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
}

export function piRunner(configured: PiRunnerOptions = {}): Runner {
  const command = configured.command ?? 'pi', model = configured.model ?? defaultPiModel, grace = configured.exitGraceMs ?? 10_000;
  return {
    name: 'pi',
    start<T>(prompt: string, options: RunOptions<T>): Run<T> {
      const id = randomUUID(), events: RunEvent[] = [], listeners = new Set<(event: RunEvent) => void>();
      const accepted: T[] = [];
      let invalid: string | null = null, lastError: string | null = null, cancelled: string | null = null, timedOut = false, settled = false;
      let child: ChildProcess | null = null, resolveResult!: (result: RunResult<T>) => void, done = false;
      const result = new Promise<RunResult<T>>(resolve => { resolveResult = resolve; });
      const now = () => new Date().toISOString();
      const emit = (event: RunEvent) => { events.push(event); for (const listener of listeners) try { listener(event); } catch { /* a listener never stops the run */ } };
      const stop = () => { if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); setTimeout(() => { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5_000).unref(); } };
      const finish = (outcome: RunResult<T>) => { if (done) return; done = true; clearTimeout(bound); resolveResult(outcome); };
      const fail = (failure: RunFailure) => finish({ ok: false, failure, payloads: [...accepted] });
      const bound = setTimeout(() => { if (done) return; timedOut = true; stop(); }, options.timeoutMs);
      bound.unref();

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
        if (record.type === 'agent_settled' && !settled) { settled = true; setTimeout(() => stop(), grace).unref(); }
      };

      try {
        child = (configured.spawn ?? spawn)(command, [...(configured.commandArgs ?? []), ...piArgs(prompt, { model, extension: configured.extension, args: configured.args })], {
          cwd: options.cwd, env: runEnvironment(process.env, { ...configured.environment, ...options.env }), stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        queueMicrotask(() => fail({ reason: 'spawn', detail: `${command} could not be started: ${error instanceof Error ? error.message : String(error)}` }));
      }
      if (child) {
        emit({ kind: 'start', at: now(), pid: child.pid ?? null, command });
        const decoder = new StringDecoder('utf8');
        let buffer = '';
        // Pi's framing is strict JSONL: records split on LF only (never readline, which also splits
        // on Unicode separators that are valid inside JSON strings), with an optional CR stripped.
        child.stdout!.on('data', (chunk: Buffer) => {
          buffer += decoder.write(chunk);
          let index: number;
          while ((index = buffer.indexOf('\n')) >= 0) { handle(buffer.slice(0, index).replace(/\r$/, '')); buffer = buffer.slice(index + 1); }
        });
        let stderr = '';
        child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
        child.on('error', error => fail({ reason: 'spawn', detail: `${command} could not be started: ${error.message}` }));
        child.on('close', (code, signal) => {
          buffer += decoder.end();
          if (buffer) handle(buffer.replace(/\r$/, ''));
          if (stderr.trim()) emit({ kind: 'stderr', at: now(), text: bounded(stderr.trim(), 1000) });
          emit({ kind: 'exit', at: now(), code, signal });
          if (cancelled !== null) return fail({ reason: 'cancelled', detail: cancelled });
          if (timedOut) return fail({ reason: 'timeout', detail: `no terminal event within ${Math.round(options.timeoutMs / 1000)}s; the run was stopped` });
          // A clean run is judged by what it submitted; the exit is only a failure when Pi did not
          // settle and exit on its own (a stop after settling is this runner's, not Pi's).
          if (!settled && (code !== 0 || signal)) return fail({ reason: 'exit', code, detail: `pi exited ${signal ? `on ${signal}` : `with code ${code}`}${stderr.trim() ? `: ${bounded(stderr.trim(), 400)}` : ''}` });
          if (!accepted.length) return fail(invalid ? { reason: 'invalid-payload', detail: invalid } : { reason: 'no-payload', detail: `the run ended without a ${options.tool} call${lastError ? ` (last error: ${bounded(lastError, 300)})` : ''}` });
          finish({ ok: true, tool: options.tool, payload: accepted[0], payloads: [...accepted] });
        });
      }
      return {
        id, events,
        onEvent(listener) { for (const event of [...events]) listener(event); listeners.add(listener); return () => { listeners.delete(listener); }; },
        cancel(reason = 'the run was cancelled') { if (done || cancelled !== null) return; cancelled = reason; if (child) stop(); else fail({ reason: 'cancelled', detail: reason }); },
        result: () => result,
      };
    },
  };
}
