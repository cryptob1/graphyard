// Concern: the Compose adapter of an item's local preview (GY-1903) — one isolated, bounded Compose project per preview, its pages published, and every container, volume and network removed after it.
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { previewSiteByteLimit, previewSiteFileLimit, previewSitePathSchema, type PreviewSiteFile } from './project-previews.js';
import { processPidNamespace, processStartTicks, tempOwnerGone, tempOwnerJudgeable, tmpReclaimMinAgeMs, type TempOwner } from './tmp-reclaim.js';

// ---------------------------------------------------------------------------
// A declared Compose application (project-applications.ts) is previewed as its own Compose project:
// `graphyard-preview-KEY-ID`, so its containers, network and named volumes — the application's
// state and database — are fresh and unique to the item and the preview, never shared with another
// preview or the host's own stack. The repository's file is resolved by `docker compose config` in
// the preview's credential-free environment (never the checkout's .env), its env files left unread until their paths are checked (`composeMountProblems`), and rewritten
// (`composePreviewConfig`): every host port removed and the HTTP service published on an ephemeral
// loopback port only, CPU, memory and process count bounded, the preview's identity given to every
// service, and each container and network labelled with this process as its owner. `close` removes
// the project with its volumes and networks; `sweepComposePreviews` removes any whose owner is gone.
// ---------------------------------------------------------------------------

/** Every preview's Compose project name starts so; nothing else on the host is ever removed. */
export const composeProjectPrefix = 'graphyard-preview-';
/** The label naming the process that owns a preview's containers and networks (a TempOwner, as JSON). */
export const composeOwnerLabel = 'graphyard.preview.owner';
/** A preview's Compose project: the item's key and the preview's id, lower-cased as Compose requires. */
export const composeProjectName = (key: string, id: string) => `${composeProjectPrefix}${key.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${id.slice(0, 8).toLowerCase()}`;

/** How far one Compose preview reaches: per container, and in count and lifetime across the host. */
export interface ComposeBounds { cpus: number; memoryMb: number; pids: number; lifetimeMs: number; concurrent: number }
const bounded = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  return value?.trim() && Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};
/**
 * The bounds the loop's environment configures, each clamped to a sane range: GRAPHYARD_PREVIEW_CPUS
 * (default 1), GRAPHYARD_PREVIEW_MEMORY_MB (512) and GRAPHYARD_PREVIEW_PIDS (256) per container,
 * GRAPHYARD_PREVIEW_LIFETIME_MINUTES (720) a running preview lasts, and GRAPHYARD_PREVIEW_COMPOSE_LIMIT
 * (4) Compose previews served at once.
 */
export const composeBounds = (env: NodeJS.ProcessEnv = process.env): ComposeBounds => ({
  cpus: bounded(env.GRAPHYARD_PREVIEW_CPUS, 1, 0.1, 16), memoryMb: Math.round(bounded(env.GRAPHYARD_PREVIEW_MEMORY_MB, 512, 32, 65536)),
  pids: Math.round(bounded(env.GRAPHYARD_PREVIEW_PIDS, 256, 16, 32768)), lifetimeMs: bounded(env.GRAPHYARD_PREVIEW_LIFETIME_MINUTES, 720, 1, 10080) * 60_000,
  concurrent: Math.round(bounded(env.GRAPHYARD_PREVIEW_COMPOSE_LIMIT, 4, 1, 32)),
});

/** Runs `docker ARGS`, answering stdout; rejects naming stderr. */
export type Docker = (args: string[], options: { env: Record<string, string>; cwd?: string; signal?: AbortSignal; timeoutMs: number }) => Promise<string>;
export const defaultDocker: Docker = (args, options) => new Promise((accept, refuse) => {
  execFile('docker', args, { env: options.env, cwd: options.cwd, signal: options.signal, timeout: options.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) refuse(new Error(`docker ${args.slice(0, 2).join(' ')} failed: ${(String(stderr).trim().split('\n').slice(-3).join(' ') || error.message).slice(0, 600)}`));
    else accept(String(stdout));
  });
});
/** What the docker client itself needs beyond the preview's environment: where the daemon is. */
export const dockerEnvironment = (environment: Record<string, string>, host: NodeJS.ProcessEnv = process.env): Record<string, string> =>
  ({ ...environment, ...(host.DOCKER_HOST ? { DOCKER_HOST: host.DOCKER_HOST } : {}) });

type Json = Record<string, any>;
/** `path` with every symbolic link in it followed, as the daemon follows them; a part that does not exist yet is kept as written. */
const followed = (path: string): string => {
  const rest: string[] = [];
  for (let at = path; ; at = dirname(at)) {
    try { return join(realpathSync(at), ...rest); } catch { if (dirname(at) === at) return path; rest.unshift(basename(at)); }
  }
};
/**
 * Why the resolved Compose configuration cannot be previewed, one sentence each: a bind mount, build
 * context, env or secret file outside the change's checkout once its symbolic links are followed (a
 * host credential path such as ~/.ssh or the Docker socket), a privileged or host-namespace service,
 * added capabilities or devices, the engine's API socket, another container's volumes or links, an
 * external network or volume (shared with something outside the preview), or no `service` to serve.
 */
export function composeMountProblems(config: Json, checkout: string, service: string): string[] {
  const problems: string[] = [], root = followed(resolve(checkout));
  const inside = (path: unknown) => { if (typeof path !== 'string') return false; const real = followed(resolve(root, path)); return real === root || real.startsWith(`${root}${sep}`); };
  const services: Json = config.services ?? {};
  if (!services[service]) problems.push(`the Compose file declares no service "${service}" to serve`);
  for (const [name, entry] of Object.entries<Json>(services)) {
    for (const volume of entry.volumes ?? []) if (volume?.type === 'bind' && !inside(volume.source)) problems.push(`service ${name} mounts the host path ${volume.source}, outside the change's checkout`);
    for (const volume of entry.volumes ?? []) if (volume?.type !== 'bind' && volume?.type !== 'volume' && volume?.type !== 'tmpfs') problems.push(`service ${name} mounts a ${volume?.type} volume`);
    const context = typeof entry.build === 'string' ? entry.build : entry.build?.context;
    if (context !== undefined && !inside(context)) problems.push(`service ${name} builds from ${context}, outside the change's checkout`);
    for (const extra of Object.values<unknown>(entry.build?.additional_contexts ?? {})) if (typeof extra === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(extra) && !inside(resolve(root, context ?? '.', extra))) problems.push(`service ${name} builds with ${extra}, outside the change's checkout`);
    if (entry.build?.ssh) problems.push(`service ${name} builds with the host's SSH agent`);
    for (const file of [entry.env_file ?? []].flat()) if (!inside(typeof file === 'string' ? file : file?.path)) problems.push(`service ${name} reads the env file ${typeof file === 'string' ? file : file?.path}, outside the change's checkout`);
    if (entry.privileged) problems.push(`service ${name} is privileged`);
    for (const key of ['network_mode', 'pid', 'ipc', 'userns_mode', 'uts', 'cgroup']) if (typeof entry[key] === 'string' && /^(host|container:|service:)/.test(entry[key])) problems.push(`service ${name} shares the ${entry[key]} ${key}`);
    if (entry.cap_add?.length) problems.push(`service ${name} adds capabilities ${entry.cap_add.join(', ')}`);
    if (entry.devices?.length) problems.push(`service ${name} maps host devices`);
    if (entry.use_api_socket) problems.push(`service ${name} asks for the Docker engine's API socket`);
    for (const source of entry.volumes_from ?? []) if (typeof source === 'string' && source.startsWith('container:')) problems.push(`service ${name} takes the volumes of the container ${source.slice(10)}, outside the preview`);
    if (entry.external_links?.length) problems.push(`service ${name} links containers outside the preview`);
    for (const option of entry.security_opt ?? []) if (/unconfined|label[:=]disable/i.test(String(option))) problems.push(`service ${name} disables its confinement (${option})`);
  }
  for (const [kind, entries] of [['network', config.networks], ['volume', config.volumes]] as const) {
    for (const [name, entry] of Object.entries<Json>(entries ?? {})) {
      if (entry?.external) problems.push(`the ${kind} ${name} is external, shared with something outside the preview`);
      if (kind === 'volume' && entry?.driver_opts?.device && !inside(entry.driver_opts.device)) problems.push(`the volume ${name} binds the host path ${entry.driver_opts.device}`);
    }
  }
  for (const [kind, entries] of [['secret', config.secrets], ['config', config.configs]] as const) {
    for (const [name, entry] of Object.entries<Json>(entries ?? {})) {
      if (entry?.environment) problems.push(`the ${kind} ${name} is read from the environment`);
      if (entry?.file && !inside(entry.file)) problems.push(`the ${kind} ${name} reads ${entry.file}, outside the change's checkout`);
    }
  }
  return problems;
}

/**
 * The configuration the preview runs: the resolved one under `project`, with no container name or
 * host port of its own (so two previews never collide), only `service`'s `port` published on an
 * ephemeral loopback port, each service one container (no `scale` or replicas) bounded (`bounds`), unable to gain privileges, not
 * restarted, given the preview's `variables`, and each container and network labelled with `owner`.
 */
export function composePreviewConfig(config: Json, options: { project: string; service: string; port: number; bounds: ComposeBounds; variables: Record<string, string>; owner: TempOwner }): Json {
  const labels = { [composeOwnerLabel]: JSON.stringify(options.owner) };
  const services = Object.fromEntries(Object.entries<Json>(config.services ?? {}).map(([name, entry]) => {
    const { container_name: _name, ports: _ports, cpus: _cpus, mem_limit: _memory, memswap_limit: _swap, pids_limit: _pids, restart: _restart, scale: _scale, deploy, ...rest } = entry;
    const { resources: _resources, restart_policy: _policy, replicas: _replicas, ...placement } = deploy ?? {};
    return [name, {
      ...rest, ...(Object.keys(placement).length ? { deploy: placement } : {}),
      cpus: options.bounds.cpus, mem_limit: `${options.bounds.memoryMb}m`, memswap_limit: `${options.bounds.memoryMb}m`, pids_limit: options.bounds.pids, restart: 'no',
      security_opt: [...new Set([...(entry.security_opt ?? []), 'no-new-privileges:true'])],
      environment: { ...(Array.isArray(entry.environment) ? Object.fromEntries(entry.environment.map((pair: string) => [pair.split('=')[0], pair.split('=').slice(1).join('=')])) : entry.environment ?? {}), ...options.variables },
      labels: { ...(Array.isArray(entry.labels) ? {} : entry.labels ?? {}), ...labels },
      ...(name === options.service ? { ports: [{ target: options.port, host_ip: '127.0.0.1', protocol: 'tcp' }] } : {}),
    }];
  }));
  const networks = Object.fromEntries(Object.entries<Json>(config.networks ?? { default: {} }).map(([name, entry]) => [name, { ...entry, name: `${options.project}_${name}`, labels: { ...(entry?.labels ?? {}), ...labels } }]));
  const volumes = Object.fromEntries(Object.entries<Json>(config.volumes ?? {}).map(([name, entry]) => [name, { ...entry, name: `${options.project}_${name}` }]));
  return { ...config, name: options.project, services, networks, volumes };
}

/** This process, as the owner label records it. */
export const currentOwner = (now = Date.now()): TempOwner => ({ pid: process.pid, startedAt: processStartTicks(process.pid), pidNamespace: processPidNamespace(), at: new Date(now).toISOString() });

/** A preview's running Compose project: `start` brings it up and answers its loopback origin; `close` removes it, volumes and networks with it. */
export interface ComposeStack { project: string; url: string | null; start(signal: AbortSignal, timeoutMs: number): Promise<string>; close(): Promise<void> }
export interface ComposeStackOptions {
  checkout: string; file: string; service: string; port: number; project: string;
  /** The preview's environment (merge-writer/preview.ts `previewEnvironment` and its variables): what the file's interpolation reads. */
  environment: Record<string, string>; variables: Record<string, string>; bounds: ComposeBounds;
  /** Where the generated configuration is written: the preview's own directory, outside the checkout. */
  scratch: string;
  docker?: Docker; fetcher?: typeof fetch;
}
export function composeStack(options: ComposeStackOptions): ComposeStack {
  const docker = options.docker ?? defaultDocker, env = options.environment;
  let started = false, closed: Promise<void> | null = null;
  const stack: ComposeStack = {
    project: options.project, url: null,
    async start(signal, timeoutMs) {
      const deadline = Date.now() + timeoutMs, left = () => Math.max(1_000, deadline - Date.now());
      // Interpolation reads only the preview's environment and this empty file, never the checkout's
      // own .env (which may link to a host file); env files stay declared, unread, until composeMountProblems has checked where they are.
      await mkdir(options.scratch, { recursive: true });
      const dotenv = join(options.scratch, 'preview.env');
      await writeFile(dotenv, '');
      const compose = (file: string) => ['compose', '--env-file', dotenv, '-f', file, '-p', options.project];
      const resolved = JSON.parse(await docker([...compose(options.file), 'config', '--no-env-resolution', '--format', 'json'], { env, cwd: options.checkout, signal, timeoutMs: left() })) as Json;
      const problems = composeMountProblems(resolved, options.checkout, options.service);
      if (problems.length) throw new Error(`the Compose application cannot be previewed in isolation: ${problems.join('; ')}`);
      const generated = join(options.scratch, 'compose.preview.json');
      await writeFile(generated, JSON.stringify(composePreviewConfig(resolved, { ...options, owner: currentOwner() })));
      started = true;
      await docker([...compose(generated), '--project-directory', options.checkout, 'up', '--detach', '--build', '--wait', '--wait-timeout', String(Math.ceil(left() / 1000))], { env, cwd: options.checkout, signal, timeoutMs: left() });
      const published = (await docker([...compose(generated), 'port', options.service, String(options.port)], { env, signal, timeoutMs: left() })).trim().split('\n')[0] ?? '';
      const port = /^127\.0\.0\.1:(\d{1,5})$/.exec(published)?.[1];
      if (!port) throw new Error(`service ${options.service} published no loopback port for ${options.port} (${published || 'none'})`);
      const url = `http://127.0.0.1:${port}`;
      // Up is not answering: the service's first HTTP answer, within the budget, is.
      for (let answered = false; !answered;) {
        signal.throwIfAborted();
        try { await (options.fetcher ?? fetch)(`${url}/`, { signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]) }); answered = true; }
        catch (error) { if (signal.aborted) throw error; if (Date.now() > deadline) throw new Error(`service ${options.service} did not answer HTTP on ${url} within the budget`); await new Promise(accept => setTimeout(accept, 250)); }
      }
      return stack.url = url;
    },
    // A failed removal rejects, and the next close tries again.
    close: () => closed ??= (async () => {
      stack.url = null;
      if (!started) return;
      await removeComposeProject(options.project, { docker, env });
    })().catch(error => { closed = null; throw error; }),
  };
  return stack;
}

/**
 * Removes `project`: its containers, its volumes and networks, and the images it built; then anything
 * carrying its label that `down` missed. Rejects, naming what is left, unless the daemon then holds nothing of it.
 */
export async function removeComposeProject(project: string, options: { docker?: Docker; env?: Record<string, string> } = {}) {
  if (!project.startsWith(composeProjectPrefix)) throw new Error(`${project} is not a preview's Compose project`);
  const docker = options.docker ?? defaultDocker, env = options.env ?? dockerEnvironment({ PATH: process.env.PATH ?? '' });
  // Run from `/`: by its project name alone, never reading a Compose file or .env where this process happens to be.
  const failures: string[] = [], note = (error: unknown) => { failures.push(error instanceof Error ? error.message : String(error)); return ''; };
  await docker(['compose', '-p', project, 'down', '--volumes', '--remove-orphans', '--rmi', 'local', '--timeout', '5'], { env, cwd: '/', timeoutMs: 120_000 }).catch(note);
  // What `down` left is removed by id; a network still detaching from a removed container is tried again.
  for (let pass = 0; ; pass++) {
    const left = await composeLeftovers(project, { docker, env });
    const named = [...left.containers.map(id => `container ${id}`), ...left.volumes.map(id => `volume ${id}`), ...left.networks.map(id => `network ${id}`)];
    if (!named.length) return;
    if (pass === 3) throw new Error(`${project} was not removed: ${named.join(', ')} remain (${failures.slice(-3).join('; ').slice(0, 600)})`);
    if (left.containers.length) await docker(['rm', '--force', '--volumes', ...left.containers], { env, timeoutMs: 60_000 }).catch(note);
    if (left.volumes.length) await docker(['volume', 'rm', '--force', ...left.volumes], { env, timeoutMs: 60_000 }).catch(note);
    if (left.networks.length) await docker(['network', 'rm', ...left.networks], { env, timeoutMs: 60_000 }).catch(note);
    if (pass) await new Promise(accept => setTimeout(accept, 500 * pass));
  }
}

const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean);
/** What of `project` the daemon still holds: container ids, volume and network names. */
export async function composeLeftovers(project: string, options: { docker?: Docker; env?: Record<string, string> } = {}) {
  const docker = options.docker ?? defaultDocker, env = options.env ?? dockerEnvironment({ PATH: process.env.PATH ?? '' });
  const filter = `label=com.docker.compose.project=${project}`;
  const [containers, volumes, networks] = await Promise.all([
    docker(['ps', '--all', '--quiet', '--filter', filter], { env, timeoutMs: 30_000 }),
    docker(['volume', 'ls', '--quiet', '--filter', filter], { env, timeoutMs: 30_000 }),
    docker(['network', 'ls', '--format', '{{.Name}}', '--filter', filter], { env, timeoutMs: 30_000 }),
  ]);
  return { containers: lines(containers), volumes: lines(volumes), networks: lines(networks) };
}

/**
 * The restart recovery (GY-1903): every preview Compose project on the daemon whose owner process is
 * gone — or that names no owner, or one this reader cannot judge and older than
 * `tmpReclaimMinAgeMs` — removed with its volumes and networks. A project whose owner still runs is
 * left serving. Answers the removed projects.
 */
export async function sweepComposePreviews(options: { docker?: Docker; env?: Record<string, string>; procRoot?: string; now?: () => number } = {}): Promise<string[]> {
  const docker = options.docker ?? defaultDocker, env = options.env ?? dockerEnvironment({ PATH: process.env.PATH ?? '' }), procRoot = options.procRoot ?? '/proc';
  const format = `{{.Label "com.docker.compose.project"}}\t{{.Label "${composeOwnerLabel}"}}`;
  const [containers, networks, volumes] = await Promise.all([
    docker(['ps', '--all', '--filter', 'label=com.docker.compose.project', '--format', format], { env, timeoutMs: 30_000 }),
    docker(['network', 'ls', '--filter', 'label=com.docker.compose.project', '--format', format], { env, timeoutMs: 30_000 }),
    docker(['volume', 'ls', '--filter', 'label=com.docker.compose.project', '--format', `{{.Label "com.docker.compose.project"}}\t`], { env, timeoutMs: 30_000 }),
  ]);
  const owners = new Map<string, TempOwner[]>();
  for (const line of lines(`${containers}\n${networks}\n${volumes}`)) {
    const [project, label] = line.split('\t');
    if (!project?.startsWith(composeProjectPrefix)) continue;
    const list = owners.get(project) ?? [];
    try { const owner = JSON.parse(label ?? ''); if (typeof owner?.pid === 'number') list.push(owner); } catch { /* names no owner */ }
    owners.set(project, list);
  }
  const removed: string[] = [], failed: string[] = [], now = (options.now ?? Date.now)();
  for (const [project, list] of [...owners].sort(([a], [b]) => a < b ? -1 : 1)) {
    const live = list.some(owner => !tempOwnerGone(owner, procRoot) && (tempOwnerJudgeable(owner, procRoot) || now - Date.parse(owner.at) < tmpReclaimMinAgeMs));
    if (live) continue;
    try { await removeComposeProject(project, { docker, env }); removed.push(project); } catch (error) { failed.push(error instanceof Error ? error.message : String(error)); }
  }
  if (failed.length) throw new Error(`removed ${removed.join(', ') || 'none'}, but ${failed.join('; ')}`);
  return removed;
}

/** The most pages and assets a Compose preview publishes. */
export const composeSnapshotPages = 200;
/**
 * The served application's pages as its link publishes them: `/` and every same-origin page and
 * asset its HTML and CSS name by relative path (`href`, `src`, `url(...)`), fetched from the running
 * application, at most `composeSnapshotPages` and the site's byte bound, read no further than it. A
 * path ending in `/`, and an HTML answer to an extensionless path, is published as that directory's
 * index.html; a root-relative link (`/x`) in it is rewritten relative, so it resolves under the link.
 */
export async function snapshotComposeSite(origin: string, fetcher: typeof fetch = fetch): Promise<PreviewSiteFile[]> {
  const files = new Map<string, PreviewSiteFile>(), queue = ['/'], seen = new Set(queue);
  let bytes = 0;
  while (queue.length && files.size < Math.min(composeSnapshotPages, previewSiteFileLimit)) {
    const pathname = queue.shift()!;
    const response = await fetcher(new URL(pathname, origin), { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
    if (!response.ok) { if (pathname === '/') throw new Error(`the application answered ${response.status} for /`); continue; }
    const mediaType = (response.headers.get('content-type') ?? 'application/octet-stream').slice(0, 100), chunks: Uint8Array[] = [];
    // Read as it streams: an answer past the bound is cut off there, never held whole.
    for await (const chunk of response.body ?? []) {
      if ((bytes += chunk.byteLength) > previewSiteByteLimit) { await response.body?.cancel().catch(() => {}); throw new Error(`the application's pages are larger than the ${previewSiteByteLimit} bytes a preview publishes`); }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks), html = /^text\/html/i.test(mediaType), css = /^text\/css/i.test(mediaType), name = pathname.slice(1);
    const path = !name || name.endsWith('/') ? `${name}index.html` : html && !/\.[a-z0-9]+$/i.test(name) ? `${name}/index.html` : name;
    if (!previewSitePathSchema.safeParse(path).success) continue;
    const text = html || css ? body.toString('utf8') : '', up = '../'.repeat(path.split('/').length - 1) || './';
    const published = html || css ? Buffer.from(text.replace(/(\b(?:href|src)\s*=\s*["']|url\(\s*["']?)\/(?!\/)/gi, `$1${up}`)) : body;
    files.set(path, { path, mediaType, content: published.toString('base64') });
    if (!html && !css) continue;
    for (const match of text.matchAll(/(?:href|src)\s*=\s*["']([^"'#?]+)|url\(\s*["']?([^"')#?]+)/gi)) {
      const link = (match[1] ?? match[2] ?? '').trim();
      if (!link || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(link)) continue;
      const target = new URL(link, new URL(pathname, origin));
      if (target.origin !== new URL(origin).origin || seen.has(target.pathname)) continue;
      seen.add(target.pathname); queue.push(target.pathname);
    }
  }
  return [...files.values()].sort((a, b) => a.path < b.path ? -1 : 1);
}
