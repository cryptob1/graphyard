// Concern: the application a managed repository declares in .graphyard/serve.json (GY-2976).
// The install's deploy unit checks the merged main out into its own serve checkout, runs npm ci
// and the declared build, and restarts the declared serve command on the declared loopback port —
// only when the build passed, so the previous build keeps serving through a failing one. It
// records the served commit, the URL and the last build failure in .graphyard/served.json, which
// master status, the dashboard and doctor read. A repository that declares nothing is untouched.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

/** What a repository declares in .graphyard/serve.json: how to build the app and how to serve it. */
export interface ServeDeclaration { build: string[]; serve: string[]; port: number }

const declarationSchema = z.object({
  build: z.array(z.string().min(1)).min(1).max(20),
  serve: z.array(z.string().min(1)).min(1).max(20),
  port: z.number().int().min(1).max(65_535),
}).strict();

/** The declaration a main tip carries, or null when it declares none; a malformed one names why. */
export function parseServeDeclaration(source: string, file = '.graphyard/serve.json'): ServeDeclaration | null {
  if (!source.trim()) return null;
  let raw: unknown;
  try { raw = JSON.parse(source); } catch (error) { throw new Error(`${file} is not valid JSON: ${(error as Error).message}`); }
  const parsed = declarationSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map(issue => `${issue.path.join('.') || '(declaration)'} ${issue.message}`).join('; ')}`);
  return parsed.data;
}

/** What the serve pass last did: the commit whose build serves, the URL it answers, the commit whose build last failed and why, and the serve process it tracks (pid and kernel start time, so a pid reused after a reboot is never mistaken for it). */
export interface ServeRecord { commit: string | null; url: string | null; failed: string | null; reason: string | null; pid?: number | null; started?: string | null; at: string }
/** The serve process a restart left running. */
export interface ServeProcess { pid: number | null; started: string | null }
export const serveRecordPath = (root: string) => join(root, '.graphyard', 'served.json');
export function readServeRecord(file: string): ServeRecord | null {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')) as ServeRecord; } catch { return null; }
}
async function writeServeRecord(file: string, record: Omit<ServeRecord, 'at'>) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify({ ...record, reason: record.reason?.slice(0, 2000) ?? null, at: new Date().toISOString() }, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

/** Whether an HTTP URL answers at all (any status counts: an app may 404 its root and still be served). */
export const answering = (url: string) => fetch(url, { signal: AbortSignal.timeout(5_000) }).then(() => true, () => false);

/** How long a restarted serve has to answer before the pass records the commit as unserved (a serve that cannot bind, a command that fails). */
export const serveAnswerTimeoutMs = 30_000;

/** Waits for a restarted serve to answer; false once `timeoutMs` passes without an answer. */
async function waitAnswer(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await answering(url)) return true;
    if (Date.now() >= deadline) return false;
    await delay(250);
  }
}

/** What one serve pass runs a main tip through. */
export interface ServePorts {
  /** Fetches the base branch and answers its tip. */
  fetch(): Promise<string>;
  /** The declaration the fetched tip carries, or null when it declares none; a malformed one throws. */
  declaration(): Promise<ServeDeclaration | null>;
  checkout(commit: string): Promise<void>;
  install(): Promise<void>;
  build(declaration: ServeDeclaration): Promise<void>;
  /** Stops the recorded serve process and starts the declared serve command; answers the new process's identity (pid and kernel start time). */
  restart(serve: readonly string[]): Promise<ServeProcess>;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * One pass: fetch main, read its declaration, and when it moved past the served commit, check it
 * out, install and build it, and restart the serve — recording the served commit and URL only
 * once the new serve answers, so one that never answers (a port it cannot bind, a command that
 * fails) is recorded as the failure it is, with the process it spawned still tracked for the next
 * restart to stop. A failure at checkout, install or build records the failed commit and its
 * reason and leaves the previous build serving. A failed tip waits for the next one, like the
 * deploy watch. When the served commit is still main but nothing answers it (a reboot, a crashed
 * serve), the build the checkout already holds is served again and the record is written with the
 * new process's pid, so the next restart stops the process that actually holds the port. No
 * declaration, no action.
 */
export async function serveOnce(file: string, ports: ServePorts, log: (line: string) => void = line => console.error(line), options: { answerTimeoutMs?: number } = {}): Promise<'absent' | 'unchanged' | 'served' | 'failed' | 'restarted'> {
  const answerTimeoutMs = options.answerTimeoutMs ?? serveAnswerTimeoutMs;
  const tip = await ports.fetch();
  let declaration: ServeDeclaration | null = null;
  try { declaration = await ports.declaration(); } catch (error) { log(`[graphyard-serve] ${message(error)}`); }
  if (!declaration) return 'absent';
  const url = `http://127.0.0.1:${declaration.port}`;
  const record = readServeRecord(file);
  if (record?.commit === tip && (record.url ?? url) === url) {
    if (await answering(url)) return 'unchanged';
    let served: ServeProcess | null = null;
    try {
      served = await ports.restart(declaration.serve);
      if (!(await waitAnswer(url, answerTimeoutMs))) throw new Error(`the restarted serve did not answer ${url} within ${Math.round(answerTimeoutMs / 1000)}s`);
      await writeServeRecord(file, { commit: tip, url, failed: null, reason: null, pid: served.pid, started: served.started });
      log(`[graphyard-serve] ${tip.slice(0, 12)} serves again at ${url}`);
      return 'restarted';
    } catch (error) {
      const reason = message(error);
      log(`[graphyard-serve] serving ${tip.slice(0, 12)} again failed: ${reason}`);
      await writeServeRecord(file, { commit: null, url, failed: tip, reason, pid: served?.pid ?? null, started: served?.started ?? null });
      return 'failed';
    }
  }
  if (record?.failed === tip) return 'unchanged';
  try {
    await ports.checkout(tip);
    await ports.install();
    await ports.build(declaration);
  } catch (error) {
    const reason = message(error);
    log(`[graphyard-serve] the build of ${tip.slice(0, 12)} failed, so ${(record?.commit ?? 'nothing').slice(0, 12)} keeps serving: ${reason}`);
    await writeServeRecord(file, { commit: record?.commit ?? null, url: record?.url ?? url, failed: tip, reason, pid: record?.pid ?? null, started: record?.started ?? null });
    return 'failed';
  }
  // The restart stopped the previous serve, so the new one must answer before the commit is recorded as served.
  let served: ServeProcess | null = null;
  try {
    served = await ports.restart(declaration.serve);
    if (!(await waitAnswer(url, answerTimeoutMs))) throw new Error(`the serve did not answer ${url} within ${Math.round(answerTimeoutMs / 1000)}s`);
    await writeServeRecord(file, { commit: tip, url, failed: null, reason: null, pid: served.pid, started: served.started });
    log(`[graphyard-serve] serving ${tip.slice(0, 12)} at ${url}`);
    return 'served';
  } catch (error) {
    const reason = message(error);
    log(`[graphyard-serve] ${reason}, so nothing serves`);
    await writeServeRecord(file, { commit: null, url, failed: tip, reason, pid: served?.pid ?? null, started: served?.started ?? null });
    return 'failed';
  }
}

/** `--watch`'s serve half: a pass every interval until stopped; a pass that throws (a fetch that failed) is logged and retried. */
export async function watchServe(file: string, ports: ServePorts, options: { intervalMs: number; once?: boolean; signal?: AbortSignal; log?: (line: string) => void }) {
  const log = options.log ?? (line => console.error(line));
  for (;;) {
    try { await serveOnce(file, ports, log); } catch (error) { log(`[graphyard-serve] the pass failed and runs again: ${message(error)}`); }
    if (options.once || options.signal?.aborted) return;
    try { await delay(options.intervalMs, undefined, { signal: options.signal }); } catch { return; }
  }
}

/** The install's own serve checkout: a detached worktree of the managed root under its local .graphyard — never the coordinator's or a worker's checkout. Its ports live beside the deploy watch's own (src/cli/upgrade.ts), the one file allowed to reach the remote. */
export const serveCheckoutPath = (root: string) => join(root, '.graphyard', 'serve-checkout');
