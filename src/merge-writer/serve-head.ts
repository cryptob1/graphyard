// Concern: GY-3032 — one way to serve a head: a declared application (delivery.applications, or a
// graphyard.json e2e.serve read as its migration source) built and served from a checkout, for the
// merge trial's E2E cases and for item previews alike.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { buildStaticSite, groupBuildShell, type StaticBuildShell } from '../release-project.js';
import { composeBounds, composeProjectName, composeStack, dockerEnvironment, type ComposeBounds, type Docker } from '../compose-preview.js';
import type { Application } from '../project-applications.js';
import { freePort, npmInstallArguments } from '../serve-app.js';
import { trialContainerWaiting } from './trial-load.js';
import type { E2eServe } from '../model/repository-policy.js';

/** A head served by a command until a URL answers: what a graphyard.json `e2e.serve` declares, read as an application. */
export type CommandApplication = { id: string; kind: 'command' } & E2eServe;
/** Every application a head can be served as. */
export type ServedApplication = Application | CommandApplication;
/** graphyard.json's `e2e.serve`, migrated to the application it declares. */
export const commandApplication = (serve: E2eServe): CommandApplication => ({ id: 'serve', kind: 'command', ...serve });

/** How long a started node application has to answer on its PORT. */
export const nodeReadySeconds = 120;

/** How long a stopped serve command has to end before its group is killed. */
const closeGraceMs = 20_000;

/** What the loopback static site serves each extension as; anything else is application/octet-stream. */
const staticTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
};
export interface StaticUat { url: string; close(): Promise<void> }

/**
 * GY-1535: a static site's build output `directory` served on loopback, so its cases drive it in a
 * browser like any deployment. `/healthz` answers `sha` as `commit`; a directory serves its
 * `index.html`; nothing outside `directory` is ever read, and a missing build output answers 404
 * rather than failing the server. Only GET and HEAD are answered.
 */
export async function serveStaticSite(directory: string, sha: string): Promise<StaticUat> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`static UAT must be a full 40-character commit SHA, got ${JSON.stringify(sha)}`);
  const root = resolve(directory);
  const inside = (path: string) => path === root || path.startsWith(`${root}${sep}`);
  const server = createServer(async (request, response) => {
    const send = (status: number, type: string, body: string | Buffer) => { response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); response.end(request.method === 'HEAD' ? undefined : body); };
    if (request.method !== 'GET' && request.method !== 'HEAD') return send(405, 'text/plain; charset=utf-8', 'Method not allowed\n');
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://uat.invalid').pathname); } catch { return send(400, 'text/plain; charset=utf-8', 'Bad path\n'); }
    if (pathname === '/healthz') return send(200, 'application/json', JSON.stringify({ ok: true, commit: sha }));
    let path = resolve(root, `.${pathname}`);
    if (!inside(path)) return send(404, 'text/plain; charset=utf-8', 'Not found\n');
    try {
      if ((await stat(path)).isDirectory()) path = resolve(path, 'index.html');
      // A symbolic link out of the build output is not served.
      const real = await realpath(path), realRoot = await realpath(root);
      if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) return send(404, 'text/plain; charset=utf-8', 'Not found\n');
      return send(200, staticTypes[extname(path).toLowerCase()] ?? 'application/octet-stream', await readFile(path));
    } catch { return send(404, 'text/plain; charset=utf-8', 'Not found\n'); }
  });
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => accept()); });
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(accept => { server.closeAllConnections?.(); server.close(() => accept()); }) };
}


/** A head being served: `ready` answers its origin once it serves (rejecting naming why it cannot); `close` stops whatever started, at any point. */
export interface ServingHead { ready: Promise<string>; close(): Promise<void>; ended(): string | null }
export interface ServeHeadOptions {
  /** The commit served: a static site answers it on /healthz. */
  sha: string;
  /** The preview environment (a fresh HOME, no coordinator credential) the build, the serve command and Compose interpolation read. */
  env: Record<string, string>;
  budgetMs: number; signal?: AbortSignal;
  shell?: StaticBuildShell; wrapper?: readonly string[]; log?: (line: string) => void;
  /** Where a Compose application's generated configuration goes, outside the checkout. */
  scratch: string;
  project?: string; bounds?: ComposeBounds; docker?: Docker; fetcher?: typeof fetch; variables?: Record<string, string>; hostEnvironment?: NodeJS.ProcessEnv;
}

/**
 * The one way a head is served from `checkout`: a static application built (its `build` in the
 * preview environment) and served on loopback, a Compose application brought up as its own bounded
 * project, a command application's command run until its URL answers, or a node application (GY-3201)
 * installed at the repository root, built in its directory and started there as a command application
 * on a free port it is given as PORT.
 */
export function serveHead(checkout: string, application: ServedApplication, options: ServeHeadOptions): ServingHead {
  let close: () => Promise<void> = async () => {}, ended: () => string | null = () => null;
  const ready = (async () => {
    if (application.kind === 'command') {
      const served = await serveByCommand(application, checkout, options.env, options.budgetMs, options.log ?? (() => {}), options.wrapper);
      close = served.close; ended = served.ended;
      return served.origin;
    }
    if (application.kind === 'node') {
      const shell = options.shell ?? groupBuildShell(options.budgetMs, options.wrapper);
      const install = npmInstallArguments(checkout), directory = join(checkout, application.directory);
      for (const [command, cwd] of [[install && `npm ${install.join(' ')}`, checkout], [application.build, directory]] as const) {
        if (!command) continue;
        const built = await shell(command, cwd, options.signal, options.env);
        if (!built.ok) throw new Error(`the node application's \`${command}\` failed: ${built.output.trim().split('\n').slice(-5).join(' | ').slice(0, 900)}`);
        options.signal?.throwIfAborted();
      }
      const port = await freePort();
      const served = await serveByCommand({ id: application.id, kind: 'command', command: application.start, url: `http://127.0.0.1:${port}`, readySeconds: nodeReadySeconds },
        directory, { ...options.env, PORT: String(port) }, options.budgetMs, options.log ?? (() => {}), options.wrapper);
      close = served.close; ended = served.ended;
      return served.origin;
    }
    if (application.kind === 'static') {
      const failed = application.build ? await buildStaticSite(application.build, checkout, options.budgetMs, options.shell ?? groupBuildShell(options.budgetMs, options.wrapper), options.signal, options.env) : null;
      if (failed) throw new Error(failed);
      options.signal?.throwIfAborted();
      const site = await serveStaticSite(join(checkout, application.directory), options.sha);
      close = site.close;
      return site.url;
    }
    const stack = composeStack({ checkout, file: application.file, service: application.service, port: application.port, project: options.project ?? composeProjectName(`serve-${application.id}`, options.sha),
      bounds: options.bounds ?? composeBounds(), docker: options.docker, fetcher: options.fetcher, environment: dockerEnvironment(options.env, options.hostEnvironment ?? process.env), variables: options.variables ?? {}, scratch: options.scratch });
    // The project is closed whatever happens while it comes up.
    close = () => stack.close();
    try { return await stack.start(options.signal ?? AbortSignal.timeout(options.budgetMs), options.budgetMs); }
    catch (error) { throw new Error(`the Compose application did not start: ${error instanceof Error ? error.message : String(error)}`); }
  })();
  ready.catch(() => {});
  return { ready, close: () => close(), ended: () => ended() };
}

/**
 * A head served by its own `e2e.serve` declaration: `command` run in the trial checkout (the trial
 * environment, no credential) until `url` answers, waited for at most `readySeconds` and the
 * budget's remainder; never past it. The group is killed on close.
 */
async function serveByCommand(serve: CommandApplication, worktree: string, env: Record<string, string>, budgetMs: number, log: (line: string) => void, wrapper: readonly string[] = []): Promise<{ origin: string; close(): Promise<void>; ended(): string | null }> {
  const startedAt = Date.now(), budgetEnd = startedAt + budgetMs, readyMs = serve.readySeconds * 1000;
  let deadline = Math.min(startedAt + readyMs, budgetEnd);
  // An endpoint that answers before the command starts is another application's: its answers would not be the head's.
  const occupied = await fetch(serve.url, { signal: AbortSignal.timeout(2_000) }).then(() => true, () => false);
  if (occupied) throw new Error(`${serve.url} already answers before the serve command starts; another application holds it, so the head cannot be served there`);
  const [file, ...argv] = [...wrapper, 'sh', '-c', serve.command];
  const child = spawn(file!, argv, { cwd: worktree, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => { if (chunks.length < 200) chunks.push(chunk); });
  child.stderr.on('data', (chunk: Buffer) => { if (chunks.length < 200) chunks.push(chunk); });
  let exited: string | null = null;
  child.on('error', error => { exited = error.message; });
  child.on('close', (code, signal) => { exited = `the serve command ended (${signal ? `signal ${signal}` : `status ${code}`})`; });
  // stdout/stderr stay open while any descendant that inherited them still runs (the shell may exit first under dash).
  const whenClosed = (stream: NodeJS.ReadableStream | null) =>
    !stream || (stream as NodeJS.ReadableStream & { closed?: boolean }).closed
      ? Promise.resolve()
      : new Promise<void>(accept => stream.once('close', () => accept()));
  const descendantsGone = Promise.all([whenClosed(child.stdout), whenClosed(child.stderr)]);
  // SIGTERM the group so the serve command can stop what it started and remove its files; wait for
  // descendants (not the shell alone) to finish that cleanup before SIGKILL past the grace.
  const close = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      process.kill(-child.pid!, 'SIGTERM');
      await Promise.race([descendantsGone, new Promise(accept => { timer = setTimeout(accept, closeGraceMs); })]);
    } catch { /* already gone */ }
    finally { clearTimeout(timer); }
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
  };
  for (;;) {
    if (exited) { await close(); throw new Error(`${exited}: ${Buffer.concat(chunks).toString('utf8').trim().split('\n').slice(-5).join(' | ').slice(0, 500)}`); }
    // Only a success answers: a server still starting up (503) is not yet the head served.
    const answered = await fetch(serve.url, { signal: AbortSignal.timeout(2_000) }).then(response => response.ok, () => false);
    if (answered) return { origin: new URL(serve.url).origin, close, ended: () => exited };
    // GY-3189: the command's time to answer starts when its container does, however long the start waited.
    if (trialContainerWaiting(Buffer.concat(chunks).toString('utf8'))) deadline = Math.min(Date.now() + readyMs, budgetEnd);
    if (Date.now() >= deadline) {
      await close();
      const tail = Buffer.concat(chunks).toString('utf8').trim().split('\n').slice(-5).join(' | ').slice(0, 500);
      log(`the serve command did not answer ${serve.url} within ${serve.readySeconds}s${tail ? `: ${tail}` : ''}`);
      throw new Error(`the serve command did not answer ${serve.url} within ${serve.readySeconds}s`);
    }
    await new Promise(accept => setTimeout(accept, 500));
  }
}
