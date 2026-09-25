// Concern: where the loop's and master status's time goes (GY-377) — per-step durations, every
// external call slower than a second, and the bounded concurrency that keeps per-item reads off the
// critical path.
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import type { ChildRun } from '../child-runner.js';

/**
 * The external calls a cycle or a status build makes, by who answers them: the Graphyard server's
 * API, GitHub (through gh), Herdr, git, a provider's account-quota probe, and any other child.
 */
export const externalCallKinds = ['server', 'github', 'herdr', 'git', 'account', 'process'] as const;
export type ExternalCallKind = typeof externalCallKinds[number];
/** A call is recorded once it takes at least this long; faster ones are not where the time goes. */
export const slowCallMs = 1_000;
/** The slowest calls kept per cycle or status build, and the steps a record carries at most. */
export const recordedCallLimit = 10, recordedStepLimit = 40;

export const stepTimingSchema = z.object({ step: z.string().min(1).max(80), ms: z.number().int().min(0) }).strict();
export const callTimingSchema = z.object({ kind: z.enum(externalCallKinds), name: z.string().min(1).max(200), ms: z.number().int().min(0), step: z.string().max(80).nullable() }).strict();
/**
 * One cycle's or one status build's timings: every step it ran, in the order it first ran it, with
 * its wall time, and the slowest external calls of a second or more, slowest first, each with the
 * step it was made in. `calls` counts every recorded slow call, including those past the limit.
 */
export const timingsSchema = z.object({
  totalMs: z.number().int().min(0),
  steps: z.array(stepTimingSchema).max(recordedStepLimit),
  calls: z.array(callTimingSchema).max(recordedCallLimit),
  slowCalls: z.number().int().min(0),
}).strict();
export type StepTiming = z.infer<typeof stepTimingSchema>;
export type CallTiming = z.infer<typeof callTimingSchema>;
export type TimingReport = z.infer<typeof timingsSchema>;

/**
 * The recorder one cycle, one dispatch tick or one status build carries. Steps are timed by
 * `step`; external calls anywhere beneath it — however deep in an effect — find it through the
 * async context `withTimings` opened, so the cycle and the dispatcher beside it in the same process
 * each keep their own calls.
 */
export class Timings {
  private readonly started: number;
  private readonly steps = new Map<string, number>();
  private readonly calls: CallTiming[] = [];
  private slow = 0;
  private active: string | null = null;
  constructor(private readonly now: () => number = Date.now) { this.started = now(); }
  /** Adds `ms` to a step, creating it in first-run order. */
  add(step: string, ms: number) { this.steps.set(step, (this.steps.get(step) ?? 0) + Math.max(0, Math.round(ms))); }
  /** Times `body` as `name`; calls made inside it are attributed to it. Steps may nest: the inner one names the calls. */
  async step<T>(name: string, body: () => Promise<T> | T): Promise<T> {
    const at = this.now(), outer = this.active;
    this.active = name;
    try { return await body(); }
    finally { this.add(name, this.now() - at); this.active = outer; }
  }
  /** Records one external call; only one of `slowCallMs` or more is kept. */
  call(kind: ExternalCallKind, name: string, ms: number, step: string | null = this.active) {
    if (!(ms >= slowCallMs)) return;
    this.slow += 1;
    this.calls.push({ kind, name: name.slice(0, 200), ms: Math.round(ms), step });
    this.calls.sort((a, b) => b.ms - a.ms);
    if (this.calls.length > recordedCallLimit) this.calls.length = recordedCallLimit;
  }
  report(): TimingReport {
    return { totalMs: Math.max(0, Math.round(this.now() - this.started)), steps: [...this.steps].slice(0, recordedStepLimit).map(([step, ms]) => ({ step, ms })), calls: this.calls.map(call => ({ ...call })), slowCalls: this.slow };
  }
}

const context = new AsyncLocalStorage<Timings>();
/** Runs `body` with `timings` as the recorder every call beneath it reports to. */
export const withTimings = <T>(timings: Timings, body: () => T): T => context.run(timings, body);
/** Runs `body` outside every recorder: a detached refresh must not land in a cycle that already ended. */
export const withoutTimings = <T>(body: () => T): T => context.exit(body);
export const currentTimings = () => context.getStore();

/** Times one external call and reports it to the recorder in force, when there is one. */
export async function timedCall<T>(kind: ExternalCallKind, name: string, body: () => Promise<T> | T, now: () => number = Date.now): Promise<T> {
  const timings = currentTimings();
  if (!timings) return body();
  const at = now();
  try { return await body(); }
  finally { timings.call(kind, name, now() - at); }
}

/**
 * A server path as a call name: the method and the route with every identifier (a UUID, a work
 * key, a long hex digest) replaced, so 170 per-item reads read as one route, and the query's keys
 * without their values.
 */
export function serverCallName(method: string, path: string) {
  const [route, query] = path.replace(/^\/?(api\/)?/, '').split('?');
  const shape = route.split('/').map(segment => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decodeURIComponent(segment)) || /^[A-Z][A-Z0-9]*-\d+$/.test(decodeURIComponent(segment)) || /^[0-9a-f]{16,}$/i.test(segment) ? ':id' : segment).join('/');
  return `${method.toUpperCase()} ${shape}${query ? `?${query.replace(/=[^&]*/g, '')}` : ''}`;
}

/** What a child call is, by who answers it: gh's request kind, Herdr's command, git's subcommand. */
export function childCall(command: string, args: string[]): { kind: ExternalCallKind; name: string } {
  const words = args.filter(arg => !arg.startsWith('-'));
  if (command === 'gh') {
    if (words[0] === 'api') {
      if (words[1] === 'graphql') return { kind: 'github', name: 'gh api graphql' };
      const route = (words[1] ?? '').split('?')[0].replace(/^repos\/[^/]+\/[^/]+/, 'repos/:repo').split('/').map(segment => /^\d+$/.test(segment) || /^[0-9a-f]{40}$/i.test(segment) ? ':id' : segment).join('/');
      return { kind: 'github', name: `gh api ${route}` };
    }
    return { kind: 'github', name: ['gh', ...words.slice(0, 2)].join(' ') };
  }
  if (command === 'herdr') return { kind: 'herdr', name: ['herdr', ...words.slice(0, 2)].join(' ') };
  if (command === 'git') {
    // `git -C PATH sub …`: the subcommand is the first word after the options and their values.
    const index = args.findIndex((arg, at) => !arg.startsWith('-') && !(at > 0 && ['-C', '-c', '--git-dir', '--work-tree'].includes(args[at - 1])));
    return { kind: 'git', name: `git ${index >= 0 ? args[index] : ''}`.trim() };
  }
  return { kind: 'process', name: [command, ...words.slice(0, 1)].join(' ') };
}

/** A child runner whose calls are timed against the recorder in force. */
export function timedRun<R extends ChildRun>(run: R, now: () => number = Date.now): R {
  return ((command: string, args: string[], options?: Parameters<ChildRun>[2]) => {
    if (!currentTimings()) return run(command, args, options);
    const { kind, name } = childCall(command, args);
    return timedCall(kind, name, () => run(command, args, options), now);
  }) as R;
}

/** A fetch whose calls are timed against the recorder in force: the server's routes by path, any other host as an account probe or by host. */
export function timedFetch(fetcher: typeof fetch, server?: () => string | undefined, now: () => number = Date.now): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!currentTimings()) return fetcher(input, init);
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const base = server?.();
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    const call = base && url.href.startsWith(base) ? { kind: 'server' as const, name: serverCallName(method, url.pathname.slice(new URL(base).pathname.replace(/\/$/, '').length) + url.search) }
      : { kind: /usage|quota|rate/i.test(url.pathname) ? 'account' as const : 'process' as const, name: `${method.toUpperCase()} ${url.host}${url.pathname}` };
    return timedCall(call.kind, call.name, () => fetcher(input, init), now);
  }) as typeof fetch;
}

/** A server API reader (`masterApi`-shaped) whose reads are timed as server calls. */
export function timedApi<A extends unknown[], T>(read: (path: string, ...rest: A) => Promise<T>, method = 'GET'): (path: string, ...rest: A) => Promise<T> {
  return (path, ...rest) => timedCall('server', serverCallName(method, path), () => read(path, ...rest));
}

/**
 * How many independent reads of one kind run at once. Per-item server reads were serial: 170 open
 * items at ~0.4 s each held every cycle and every status build for more than a minute (GY-377).
 */
export const readConcurrency = 12;
/** Maps `items` through `body` with at most `limit` in flight, keeping the input order. */
export async function mapBounded<T, R>(items: readonly T[], limit: number, body: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const index = next++; results[index] = await body(items[index], index); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

const seconds = (ms: number) => `${Math.round(ms / 100) / 10}s`;
/** The `n` slowest steps, slowest first. */
export const slowestSteps = (report: Pick<TimingReport, 'steps'>, n = 3) => [...report.steps].sort((a, b) => b.ms - a.ms).slice(0, n);
/**
 * The timings as one line: the three slowest steps and the slowest call, each with its duration —
 * what a cycle's completion line and a status report name so a slow one says where it went.
 */
export function describeTimings(report: TimingReport, n = 3) {
  const steps = slowestSteps(report, n).map(step => `${step.step} ${seconds(step.ms)}`).join(', ');
  const call = report.calls[0];
  return `slowest steps: ${steps || 'none'}${call ? `; slowest call: ${call.kind} ${call.name} ${seconds(call.ms)}${call.step ? ` in ${call.step}` : ''}${report.slowCalls > 1 ? ` (${report.slowCalls} calls of ${seconds(slowCallMs)} or more)` : ''}` : ''}`;
}

/** Times `body` as a step of the recorder in force, or just runs it when there is none. */
export function timedStep<T>(name: string, body: () => Promise<T> | T): Promise<T> {
  const timings = currentTimings();
  return timings ? timings.step(name, body) : Promise.resolve().then(body);
}
