// Concern: the node application a managed repository declares first in graphyard.json's
// delivery.applications (GY-2976, GY-3201). The install's deploy unit
// checks the merged main out into its own serve checkout, runs the npm install at its root and the
// application's build in its directory, and restarts its start command there with PORT set — only
// when the build passed, so the previous build keeps serving through a failing one. The port is a
// free loopback port chosen on the first serve and kept in .graphyard/served.json, so the URL stays
// the same across deploys. The record holds the served commit, the URL and the last build failure,
// which master status, the dashboard and doctor read. A commit counts as served only when the answer on
// the port is the restarted serve's own: a port another process already holds is one the
// serve cannot bind, recorded as a failure whose reason names the port, and no required case runs
// against the foreign holder (GY-2993). Once a new commit serves, the pass runs that
// commit's own required E2E cases against the served URL (GY-2983) and records the verdict for
// that exact commit beside it: a failing case is the release health the master acts on, never a
// reason to stop serving or roll back. The previously served build keeps serving on a free port of
// its own as BASELINE_URL, so a compare case judges a new build against what was live (GY-2985).
// A repository that declares no node application is untouched.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { nodeApplicationSchema } from './model-boundary/project-applications.js';
import { installArgv, packageManager } from './package-manager.js';
import { pinnedNodePath } from './node-pin.js';
import type { Application } from './project-applications.js';

/** The application the serve pass serves: the first node application main's graphyard.json declares. */
export type ServeDeclaration = Extract<Application, { kind: 'node' }>;

/** The first node application a graphyard.json declares, or null when it declares none; a malformed one names why. */
export function servedApplication(source: string): ServeDeclaration | null {
  let raw: any;
  try { raw = JSON.parse(source); } catch (error) { throw new Error(`graphyard.json is not valid JSON: ${(error as Error).message}`); }
  const declared = (Array.isArray(raw?.delivery?.applications) ? raw.delivery.applications : []).find((application: any) => application?.kind === 'node');
  if (!declared) return null;
  const parsed = nodeApplicationSchema.safeParse(declared);
  if (!parsed.success) throw new Error(`graphyard.json delivery.applications ${JSON.stringify(declared.id ?? '')}: ${parsed.error.issues.map(issue => `${issue.path.join('.') || '(application)'} ${issue.message}`).join('; ')}`);
  return parsed.data;
}

/** A loopback port no process holds right now: what a node application is given as PORT (GY-3201). */
export const freePort = () => new Promise<number>((accept, reject) => {
  const server = createServer().once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => accept(port)); });
});
/** The repository's install at `root`, run once before a node application builds (GY-3200's package manager): npm ci with a lockfile, npm install without, pnpm's frozen install with a pnpm-lock.yaml; null when `root` holds no package.json. */
export function installCommand(root: string): string[] | null {
  if (!existsSync(join(root, 'package.json'))) return null;
  const manager = packageManager(root);
  return manager.name === 'pnpm' ? installArgv(manager) : ['npm', existsSync(join(root, 'package-lock.json')) ? 'ci' : 'install', '--no-audit', '--no-fund'];
}

/** The served commit's required cases, as the pass ran them against the URL it serves; `case`, `step` and `reason` name the first required case that failed, and are null when verified. */
export interface ServeCheck { verified: boolean; case: string | null; step: string | null; reason: string | null }
/** The previously served build kept serving beside the current one (GY-2985): what was live, and what a compare case judges the new build against. */
export interface ServeBaseline { commit: string; url: string; pid: number | null; started: string | null }
/** What the serve pass last did: the commit whose build serves, the URL it answers, the commit whose build last failed and why, the serve process it tracks (pid and kernel start time, so a pid reused after a reboot is never mistaken for it), the required cases' verdict on the served commit (null while they have not run against it), and what was live serving on the baseline URL (GY-2985). */
export interface ServeRecord { commit: string | null; url: string | null; failed: string | null; reason: string | null; pid?: number | null; started?: string | null; check?: ServeCheck | null; baseline?: ServeBaseline | null; at: string }
/** The serve process a restart left running. */
export interface ServeProcess { pid: number | null; started: string | null }
export const serveRecordPath = (root: string) => join(root, '.graphyard', 'served.json');
export function readServeRecord(file: string): ServeRecord | null {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')) as ServeRecord; } catch { return null; }
}
async function writeServeRecord(file: string, record: Omit<ServeRecord, 'at'>) {
  const cut = (reason: string | null | undefined) => reason?.slice(0, 2000) ?? null;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify({ ...record, reason: cut(record.reason), check: record.check ? { ...record.check, reason: cut(record.check.reason) } : null, baseline: record.baseline ?? null, at: new Date().toISOString() }, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

/** Whether an HTTP URL answers at all (any status counts: an app may 404 its root and still be served). */
export const answering = (url: string) => fetch(url, { signal: AbortSignal.timeout(5_000) }).then(() => true, () => false);

/** How long a restarted serve has to answer before the pass records the commit as unserved (a serve that cannot bind, a command that fails). */
export const serveAnswerTimeoutMs = 30_000;

/** The answer the pass waited for must be the restarted serve's own (GY-2993): when the ports can tell who holds the port, an answer from a process the pass did not start means the serve left without binding the port another process already holds — a failure whose reason names the port, never a served commit. Ports that cannot tell (no /proc, off Linux) leave the answer standing. */
const servedByRestart = (ports: ServePorts, port: number, url: string, served: ServeProcess) => {
  if (ports.answersFromRestart && served.pid && ports.answersFromRestart(port, served) === false) {
    throw new Error(`a process the serve pass did not start answers ${url}: the restarted serve exited without binding port ${port}`);
  }
};

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
  /** The node application the fetched tip declares first, or null when it declares none; a malformed one throws. */
  declaration(): Promise<ServeDeclaration | null>;
  checkout(commit: string): Promise<void>;
  install(): Promise<void>;
  build(declaration: ServeDeclaration): Promise<void>;
  /** Stops the recorded serve process and starts the application's start command with PORT set to `port`; answers the new process's identity (pid and kernel start time). */
  restart(declaration: ServeDeclaration, port: number): Promise<ServeProcess>;
  /** Once a new commit serves (GY-2985): keeps `commit`'s build serving on `port`, a free port of its own, so a compare case judges the new build against what was live. Answers the started process's identity. */
  baseline?(commit: string, declaration: ServeDeclaration, port: number): Promise<ServeProcess>;
  /** Once a new commit serves: runs that commit's own required E2E cases against the served URL and answers their verdict; the pass records it for that exact commit. A case that fails here neither stops serving nor rolls back. `baselineUrl` is what was live's URL, or null when none serves (GY-2985). */
  check?(url: string, baselineUrl?: string | null): Promise<ServeCheck>;
  /** Whether the served port is still held by the process `restart` started — its process group — so the answer the pass waited for is that serve's own and not a foreign holder's (GY-2993); null when the ports cannot tell (no /proc, off Linux). */
  answersFromRestart?(port: number, process: ServeProcess): boolean | null;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * One pass: fetch main, read its declaration, and when it moved past the served commit, check it
 * out, install and build it, and restart the serve — recording the served commit and URL only
 * once the new serve answers and the answer is that serve's own, so one that never answers (a
 * port it cannot bind — one another process already holds — a command that fails) is recorded as
 * the failure it is, with the process it spawned still tracked for the next restart to stop. A failure at checkout, install or build records the failed commit and its
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
  const record = readServeRecord(file);
  // The port is chosen once, free, and kept in the record, so the URL stays the same across deploys and reboots.
  const port = Number(record?.url ? new URL(record.url).port : 0) || await freePort();
  const url = `http://127.0.0.1:${port}`;
  if (record?.commit === tip) {
    if (await answering(url)) return 'unchanged';
    let served: ServeProcess | null = null;
    try {
      served = await ports.restart(declaration, port);
      if (!(await waitAnswer(url, answerTimeoutMs))) throw new Error(`the restarted serve did not answer ${url} within ${Math.round(answerTimeoutMs / 1000)}s`);
      servedByRestart(ports, port, url, served);
      // The same commit serves again, so the verdict its cases earned still stands, and the baseline it was judged against keeps serving.
      await writeServeRecord(file, { commit: tip, url, failed: null, reason: null, pid: served.pid, started: served.started, check: record?.check ?? null, baseline: record?.baseline ?? null });
      log(`[graphyard-serve] ${tip.slice(0, 12)} serves again at ${url}`);
      return 'restarted';
    } catch (error) {
      const reason = message(error);
      log(`[graphyard-serve] serving ${tip.slice(0, 12)} again failed: ${reason}`);
      await writeServeRecord(file, { commit: null, url, failed: tip, reason, pid: served?.pid ?? null, started: served?.started ?? null, check: null, baseline: record?.baseline ?? null });
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
    await writeServeRecord(file, { commit: record?.commit ?? null, url: record?.url ?? url, failed: tip, reason, pid: record?.pid ?? null, started: record?.started ?? null, check: record?.check ?? null, baseline: record?.baseline ?? null });
    return 'failed';
  }
  // The restart stopped the previous serve, so the new one must answer before the commit is recorded as served.
  let served: ServeProcess | null = null;
  // GY-2985: what was live before keeps serving beside the new build — the previously served
  // commit, on a free port of its own, as BASELINE_URL — so a compare case judges the
  // new build against what users had. Nothing served before (the first serve), no baseline; the
  // record keeps the baseline it tracked until a new one answers, and the baseline start stops
  // the tracked process only once its own build can replace it.
  let baseline: ServeBaseline | null = record?.baseline ?? null;
  try {
    served = await ports.restart(declaration, port);
    if (!(await waitAnswer(url, answerTimeoutMs))) throw new Error(`the serve did not answer ${url} within ${Math.round(answerTimeoutMs / 1000)}s`);
    servedByRestart(ports, port, url, served);
    const candidate = record?.commit ?? record?.baseline?.commit ?? null;
    if (candidate && ports.baseline) {
      const baselinePort = await freePort(), baselineUrl = `http://127.0.0.1:${baselinePort}`;
      try {
        const started = await ports.baseline(candidate, declaration, baselinePort);
        if (!(await waitAnswer(baselineUrl, answerTimeoutMs))) throw new Error(`the baseline serve did not answer ${baselineUrl} within ${Math.round(answerTimeoutMs / 1000)}s`);
        baseline = { commit: candidate, url: baselineUrl, pid: started.pid, started: started.started };
      } catch (error) { log(`[graphyard-serve] the baseline serve of ${candidate.slice(0, 12)} failed: ${message(error)}`); }
    }
    await writeServeRecord(file, { commit: tip, url, failed: null, reason: null, pid: served.pid, started: served.started, check: null, baseline });
    log(`[graphyard-serve] serving ${tip.slice(0, 12)} at ${url}`);
    // A served commit is live-verified (GY-2983): its own required cases run against the URL it
    // serves, and the verdict is recorded for that exact commit. A case that fails is the release
    // health the master acts on — the commit keeps serving, and the next pass waits for the next tip.
    if (ports.check) {
      try {
        const check = await ports.check(url, baseline?.url ?? null);
        await writeServeRecord(file, { commit: tip, url, failed: null, reason: null, pid: served.pid, started: served.started, check, baseline });
        log(`[graphyard-serve] ${tip.slice(0, 12)} ${check.verified ? 'is verified: every required case passed' : `fails its required case ${check.case}: ${check.step}`}`);
      } catch (error) {
        log(`[graphyard-serve] the required cases of ${tip.slice(0, 12)} could not run against ${url}: ${message(error)}`);
      }
    }
    return 'served';
  } catch (error) {
    const reason = message(error);
    log(`[graphyard-serve] ${reason}, so nothing serves`);
    await writeServeRecord(file, { commit: null, url, failed: tip, reason, pid: served?.pid ?? null, started: served?.started ?? null, check: null, baseline });
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
/** The baseline checkout (GY-2985): a second detached worktree holding the previously served build, which keeps serving on the port beside the served one. */
export const serveBaselineCheckoutPath = (root: string) => join(root, '.graphyard', 'serve-checkout-baseline');

/**
 * GY-3207: the environment the serve checkout's install, build and serve commands run under: the host's, with the Node major the checkout declares first on PATH.
 * GY-3229: turbo's cache is the install's own, beside the serve checkouts, never the served repository's root.
 */
export const serveEnvironment = async (checkout: string, run: (command: string, args: string[]) => Promise<string>, host: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> =>
  ({ TURBO_CACHE_DIR: join(dirname(checkout), 'turbo-cache'), ...host, PATH: await pinnedNodePath(checkout, host.PATH, run) });
