import { z } from 'zod';

/**
 * The headless runner (GY-169). The approver and the proof producer only need a structured
 * result, so they do not need a terminal: a runner starts an agent on one prompt, streams its
 * structured events, can be cancelled, and resolves to what the agent submitted through a typed
 * Graphyard tool, or to a typed failure. It reports; it never judges. What the agent submitted is
 * applied by the loop through the same routes a terminal session uses, so the gates decide.
 */

/** One structured event of a run, as the runner saw it. Bounded text only: a record keeps these. */
export type RunEvent =
  | { kind: 'start'; at: string; pid: number | null; command: string }
  | { kind: 'session'; at: string; id: string }
  | { kind: 'message'; at: string; role: string; text: string; stopReason: string | null; error: string | null }
  | { kind: 'tool-start'; at: string; tool: string; call: string }
  | { kind: 'tool-end'; at: string; tool: string; call: string; error: boolean; text: string }
  | { kind: 'retry'; at: string; attempt: number; error: string }
  | { kind: 'settled'; at: string }
  | { kind: 'stderr'; at: string; text: string }
  | { kind: 'unparsed'; at: string; text: string }
  | { kind: 'exit'; at: string; code: number | null; signal: string | null };

/**
 * Why a run produced no payload. `timeout`: no terminal event within the bound; `exit`: the
 * process exited non-zero (or by a signal); `invalid-payload`: the agent's submission failed the
 * payload schema; `no-payload`: it ended cleanly without submitting; `cancelled`: `cancel()` was
 * called; `spawn`: the process could not be started; `lost`: the run's process is gone and left
 * no result on disk (GY-453) — killed from outside, or its host rebooted — so it judged nothing and
 * its caller retries it without spending an attempt.
 */
export const runFailureReasons = ['timeout', 'exit', 'invalid-payload', 'no-payload', 'cancelled', 'spawn', 'lost'] as const;
export type RunFailureReason = typeof runFailureReasons[number];
export interface RunFailure { reason: RunFailureReason; detail: string; code?: number | null }

/** `payload` is the first accepted submission; `payloads` every accepted one, in order. */
export type RunResult<T> =
  | { ok: true; tool: string; payload: T; payloads: T[] }
  | { ok: false; failure: RunFailure; payloads: T[] };

export interface RunOptions<T> {
  /** The directory the agent works in: the worktree it was given. */
  cwd: string;
  /** Added to the runner's environment; the environment wrapper reads its account from here. */
  env?: Record<string, string>;
  /** The Graphyard tool whose successful calls are this run's submission. */
  tool: string;
  /** Parses one submission into the payload type, throwing on a malformed one. */
  validate: (payload: unknown) => T;
  /** The bound on the run: no terminal event within it is a `timeout` failure. */
  timeoutMs: number;
  /**
   * The run registry on disk (GY-453, registry.ts runsDirectory): the run's own directory is made
   * under it and holds its output and result, so a restarted loop can adopt it. Absent, the run
   * gets a scratch directory that is removed when it ends.
   */
  runs?: string;
}

export interface Run<T> {
  readonly id: string;
  /** The run's directory on disk, when it has one: its output, its exit and its registry entry. */
  readonly directory?: string;
  /** Every event so far, oldest first. */
  readonly events: readonly RunEvent[];
  /** Streams every event: the ones already seen, then each as it arrives. Returns the unsubscribe. */
  onEvent(listener: (event: RunEvent) => void): () => void;
  /** Stops the run; its result resolves as a `cancelled` failure unless it had already settled. */
  cancel(reason?: string): void;
  /**
   * Stops watching the run without signalling it (GY-453): what this process's exit does. The run
   * keeps going, detached, and its result stays pending here; a restarted loop adopts it.
   */
  detach?(): void;
  result(): Promise<RunResult<T>>;
}

export interface Runner {
  readonly name: string;
  start<T>(prompt: string, options: RunOptions<T>): Run<T>;
  /** Watches a run another process started, from its directory: its output so far, then until it ends (GY-453). */
  adopt?<T>(directory: string, options: Omit<RunOptions<T>, 'cwd' | 'env' | 'runs'>): Run<T>;
}

/**
 * A run's record as a session keeps it: its last events, its outcome, and what the loop did with
 * each submission (`applied`: the route accepted it; `refused`: the server refused it and why).
 */
export const runRecordEventLimit = 40;
export const runRecordSchema = z.object({
  runtime: z.string().max(40), startedAt: z.string().max(40), endedAt: z.string().max(40).nullable(),
  events: z.array(z.object({ kind: z.string().max(20), at: z.string().max(40) }).passthrough()).max(runRecordEventLimit),
  result: z.union([z.object({ ok: z.literal(true), tool: z.string().max(80), submitted: z.number().int().min(0) }).strict(),
    z.object({ ok: z.literal(false), reason: z.enum(runFailureReasons), detail: z.string().max(500) }).strict()]).nullable(),
  applied: z.array(z.object({ subject: z.string().max(200), outcome: z.enum(['applied', 'refused']), detail: z.string().max(500) }).strict()).max(50).default([]),
}).strict();
export type RunRecord = z.infer<typeof runRecordSchema>;
const clip = (text: string, limit = 300) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
export function runRecord(runtime: string, run: Pick<Run<unknown>, 'events'>, result: RunResult<unknown> | null, startedAt: string, endedAt: string | null, applied: RunRecord['applied'] = []): RunRecord {
  const events = run.events.slice(-runRecordEventLimit).map(event => 'text' in event ? { ...event, text: clip(event.text) } : event);
  return { runtime, startedAt, endedAt, events, applied: applied.map(entry => ({ ...entry, detail: clip(entry.detail, 500) })),
    result: !result ? null : result.ok ? { ok: true, tool: result.tool, submitted: result.payloads.length } : { ok: false, reason: result.failure.reason, detail: clip(result.failure.detail, 500) } };
}
