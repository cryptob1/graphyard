// Concern: GY-3296 — app test environments: where the app under test runs, with one
// provider-neutral lifecycle (up, down, optional list) and a resource limit. `local` is the
// built-in environment, today's serve or application preview in the trial; every other name is a
// graphyard.json e2e.environments entry. The trusted loop alone runs a lifecycle command, from the
// gate's pinned trusted base commit, with the install's secrets; candidate code never does.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { z } from 'zod';
import { appEnvironmentsSchema, type appEnvironmentSchema } from './model-boundary/repository-policy.js';

export type AppEnvironment = z.infer<typeof appEnvironmentSchema>;
export const localEnvironment = 'local';
/** The install's lifecycle secrets, mode 0600 under `~/.config/graphyard/<install>/`, handed only to lifecycle commands. */
export const environmentSecretsFile = 'app-environments.env';
export const environmentStatePath = (root: string) => join(root, '.graphyard', 'app-environments.json');

/** An instance the loop provisioned and has not yet torn down: it counts against its environment's limit until `down` succeeds. */
export interface EnvironmentInstance { environment: string; runId: string; instance: string; commit: string; url: string; loop: string; at: string }
/** The last run of an environment, as the Tests view shows it. */
export interface EnvironmentRun {
  commit: string; runId: string | null; url: string | null; at: string; ms: number | null;
  /** passed/failed: the cases' own verdict; waiting: no capacity; fault: provisioning, teardown or the provider failed — never the candidate's. */
  outcome: 'passed' | 'failed' | 'waiting' | 'fault'; detail: string | null;
}
export interface EnvironmentState { instances: EnvironmentInstance[]; runs: Record<string, EnvironmentRun> }

/** A wait for capacity or an environment fault: the gate retries next cycle and blames, fails and reverts nothing. */
export class EnvironmentFault extends Error {
  constructor(readonly environment: string, readonly kind: 'wait' | 'fault', message: string) { super(message); }
}

/** The environments graphyard.json declares (`e2e.environments`); none for text that declares none or does not parse. */
export function declaredEnvironments(graphyardJson: string | null): Record<string, AppEnvironment> {
  try { return appEnvironmentsSchema.parse(JSON.parse(graphyardJson ?? '{}')?.e2e?.environments ?? {}); } catch { return {}; }
}

export function readEnvironmentState(file: string): EnvironmentState {
  try { const state = JSON.parse(readFileSync(file, 'utf8')); return { instances: state.instances ?? [], runs: state.runs ?? {} }; } catch { return { instances: [], runs: {} }; }
}

/** The install's lifecycle secrets: none without the file; a group- or world-readable file is refused, its values never named. */
export async function readEnvironmentSecrets(file: string): Promise<Record<string, string>> {
  let info;
  try { info = await lstat(file); } catch { return {}; }
  if (!info.isFile() || info.mode & 0o077) throw new Error(`${file} must be a regular file with mode 0600`);
  const secrets: Record<string, string> = {};
  for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) secrets[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return secrets;
}

/** `text` with every secret value replaced, so no log, record or artifact carries one. */
export const redactSecrets = (text: string, secrets: Record<string, string>) =>
  Object.values(secrets).filter(value => value.length >= 4).reduce((out, value) => out.split(value).join('[redacted]'), text);

/** Runs one lifecycle command (`sh -c`) in the trusted base checkout, with only the variables given: never the loop's own environment. */
export type LifecycleExec = (command: string, options: { cwd: string; env: Record<string, string>; timeoutMs: number }) => Promise<string>;
export const shellExec: LifecycleExec = (command, { cwd, env, timeoutMs }) => new Promise((resolve, reject) => {
  const child = spawn('sh', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  child.on('error', reject);
  child.on('close', (code, signal) => code === 0 ? resolve(out) : reject(new Error(`exited ${signal ?? code}: ${(err || out).trim().split('\n').slice(-5).join(' ').slice(-500)}`)));
});

const lastLine = (out: string) => out.trim().split('\n').at(-1) ?? '';
const timeouts = { up: 15 * 60_000, down: 5 * 60_000, list: 60_000 };

/**
 * One loop's lifecycle over the state file: `use` provisions an instance of a named environment
 * for one commit, hands its URL to the run and tears it down whatever the run did. Instances count
 * against `maxConcurrent` until `down` succeeds, across every run sharing the state file; before
 * provisioning, instances this lifecycle is not running — a crashed loop's, or a failed teardown's —
 * are torn down, with `list` naming owned instances the state file never recorded.
 */
export function environmentLifecycle(options: { stateFile: string; secretsFile: () => string; exec?: LifecycleExec; now?: () => number; log?: (line: string) => void }) {
  const exec = options.exec ?? shellExec, now = options.now ?? Date.now, log = options.log ?? (() => {});
  const loop = randomUUID(), active = new Set<string>();
  let chain: Promise<unknown> = Promise.resolve();
  /** One read-modify-write of the state file at a time. */
  const update = <T>(change: (state: EnvironmentState) => T | Promise<T>): Promise<T> => {
    const next = chain.then(async () => {
      const state = readEnvironmentState(options.stateFile);
      const result = await change(state);
      await mkdir(dirname(options.stateFile), { recursive: true });
      const temporary = `${options.stateFile}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
      await rename(temporary, options.stateFile);
      return result;
    });
    chain = next.catch(() => undefined);
    return next;
  };
  const at = () => new Date(now()).toISOString();
  const variables = (secrets: Record<string, string>, extra: Record<string, string>) =>
    ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/', LANG: 'C.UTF-8', ...secrets, ...extra });
  const recordRun = (environment: string, run: EnvironmentRun) => update(state => { state.runs[environment] = run; });

  async function down(name: string, definition: AppEnvironment, cwd: string, secrets: Record<string, string>, instance: Pick<EnvironmentInstance, 'runId' | 'instance' | 'commit'>) {
    await exec(definition.down, { cwd, timeoutMs: timeouts.down, env: variables(secrets, { GRAPHYARD_ENVIRONMENT: name, GRAPHYARD_COMMIT: instance.commit, GRAPHYARD_RUN_ID: instance.runId, GRAPHYARD_INSTANCE: instance.instance }) });
    await update(state => { state.instances = state.instances.filter(entry => !(entry.environment === name && entry.runId === instance.runId)); });
  }

  /** Tears down every instance of `name` no run of this lifecycle holds: recorded leftovers, and owned instances `list` names. Answers the run IDs reaped. */
  async function reconcile(name: string, definition: AppEnvironment, cwd: string, secrets: Record<string, string>): Promise<string[]> {
    const recorded = readEnvironmentState(options.stateFile).instances.filter(entry => entry.environment === name && !active.has(entry.runId));
    const leftovers = new Map(recorded.map(entry => [entry.runId, entry as Pick<EnvironmentInstance, 'runId' | 'instance' | 'commit'>]));
    if (definition.list) {
      const listed = JSON.parse(lastLine(await exec(definition.list, { cwd, timeoutMs: timeouts.list, env: variables(secrets, { GRAPHYARD_ENVIRONMENT: name }) })) || '[]') as { instance: string; runId: string }[];
      for (const entry of listed) if (!active.has(entry.runId) && !leftovers.has(entry.runId)) leftovers.set(entry.runId, { runId: entry.runId, instance: entry.instance, commit: '' });
    }
    const reaped: string[] = [];
    for (const entry of leftovers.values()) {
      try { await down(name, definition, cwd, secrets, entry); reaped.push(entry.runId); log(`reaped ${name} instance ${entry.instance} of run ${entry.runId}`); }
      catch (error) { log(`could not reap ${name} instance ${entry.instance}: ${redactSecrets(error instanceof Error ? error.message : String(error), secrets)}`); }
    }
    return reaped;
  }

  /**
   * Provisions `name` for `commit` from the trusted checkout `cwd`, runs `body` against its URL and
   * tears it down. A missing capacity, provider outage or failed `up` throws EnvironmentFault and
   * runs nothing; a failed `down` is recorded as a fault, leaves the instance counted and keeps
   * `body`'s verdict. `passed` judges `body`'s result for the Tests view.
   */
  async function use<T>(name: string, definition: AppEnvironment, commit: string, cwd: string, body: (url: string) => Promise<T>, passed: (result: T) => boolean): Promise<T> {
    const started = now(), fail = async (kind: 'wait' | 'fault', detail: string, runId: string | null = null): Promise<never> => {
      await recordRun(name, { commit, runId, url: null, at: at(), ms: now() - started, outcome: kind === 'wait' ? 'waiting' : 'fault', detail });
      throw new EnvironmentFault(name, kind, `environment ${name}: ${detail}`);
    };
    let secrets: Record<string, string>;
    try { secrets = await readEnvironmentSecrets(options.secretsFile()); } catch (error) { return fail('fault', error instanceof Error ? error.message : String(error)); }
    const scrub = (error: unknown) => redactSecrets(error instanceof Error ? error.message : String(error), secrets);
    try { await reconcile(name, definition, cwd, secrets); } catch (error) { log(`could not list ${name} instances: ${scrub(error)}`); }
    const runId = `gy-${randomUUID()}`;
    const claimed = await update(state => {
      const outstanding = state.instances.filter(entry => entry.environment === name).length;
      if (outstanding >= definition.maxConcurrent) return outstanding;
      state.instances.push({ environment: name, runId, instance: runId, commit, url: '', loop, at: at() });
      active.add(runId);
      return null;
    });
    if (claimed !== null) return fail('wait', `waiting for capacity: ${claimed} of ${definition.maxConcurrent} instance(s) in use`);
    let instance = runId, url: string;
    try {
      const out = await exec(definition.up, { cwd, timeoutMs: timeouts.up, env: variables(secrets, { GRAPHYARD_ENVIRONMENT: name, GRAPHYARD_COMMIT: commit, GRAPHYARD_RUN_ID: runId }) });
      const result = JSON.parse(lastLine(out)) as { url?: unknown; instance?: unknown };
      if (typeof result.url !== 'string' || !/^https?:\/\//.test(result.url)) throw new Error('up printed no {"url":"http…"} as its last line');
      url = result.url;
      if (typeof result.instance === 'string' && result.instance) instance = result.instance;
      await update(state => { const entry = state.instances.find(item => item.runId === runId); if (entry) Object.assign(entry, { instance, url: redactSecrets(url, secrets) }); });
    } catch (error) {
      const detail = `provisioning failed: ${scrub(error)}`;
      // Whatever up started is torn down; an instance down cannot remove stays counted and is reaped later.
      await down(name, definition, cwd, secrets, { runId, instance, commit }).catch(() => undefined);
      active.delete(runId);
      return fail('fault', detail, runId);
    }
    let result: T, verdict = false;
    try { result = await body(url); verdict = passed(result); }
    finally {
      let teardown: string | null = null;
      try { await down(name, definition, cwd, secrets, { runId, instance, commit }); } catch (error) { teardown = `teardown failed: ${scrub(error)}`; log(`environment ${name}: ${teardown}`); }
      active.delete(runId);
      await recordRun(name, { commit, runId, url: redactSecrets(url, secrets), at: at(), ms: now() - started, outcome: teardown ? 'fault' : verdict ? 'passed' : 'failed', detail: teardown });
    }
    return result;
  }
  return { use, reconcile, loop };
}

const lifecycles = new Map<string, ReturnType<typeof environmentLifecycle>>();
/** The loop's one lifecycle per state file: the gate and the diagnostics beside it share its count. */
export const loopLifecycle = (stateFile: string, secretsFile: () => string, log?: (line: string) => void) => {
  if (!lifecycles.has(stateFile)) lifecycles.set(stateFile, environmentLifecycle({ stateFile, secretsFile, log }));
  return lifecycles.get(stateFile)!;
};

/**
 * The trusted base's tree, checked out once per commit beside the state file through a private
 * index, so lifecycle commands run its scripts and never a candidate's.
 */
const checkouts = new Map<string, Promise<string>>();
export function trustedCheckout(git: (args: string[], env?: Record<string, string>) => Promise<string>, root: string, base: string): Promise<string> {
  // The gate and the diagnostics beside it share one checkout of a base: never two writers.
  const key = join(root, base);
  if (!checkouts.has(key)) checkouts.set(key, checkOut(git, root, base).finally(() => checkouts.delete(key)));
  return checkouts.get(key)!;
}
async function checkOut(git: (args: string[], env?: Record<string, string>) => Promise<string>, root: string, base: string): Promise<string> {
  const parent = join(root, '.graphyard', 'app-environment-bases'), directory = join(parent, base);
  if (existsSync(join(directory, '.graphyard-ready'))) return directory;
  await rm(parent, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const env = { GIT_INDEX_FILE: join(parent, `${base}.index`) };
  await git(['read-tree', base], env);
  await git(['--work-tree', directory, 'checkout-index', '-a', '-f'], env);
  await writeFile(join(directory, '.graphyard-ready'), base);
  return directory;
}

/** One line of the Tests view's Where tests run block. */
export interface EnvironmentRow {
  name: string; where: string; when: string;
  /** Instances allowed at once, and outstanding now; null for local. */
  limit: number | null; inUse: number;
  last: { at: string; outcome: string; commit: string | null; ms: number | null; detail: string | null; runId: string | null; url: string | null } | null;
  lifecycle: { up: string; down: string; list: string | null } | null;
}

/**
 * GY-3296: where the app under test runs, for the Tests view: local first — its last run the batch
 * gate's — then each declared environment with its limit, instances in use and last run.
 */
export function environmentRows(root: string, gate: { outcome: string; tip: string | null; finishedAt: string; reason: string | null } | null): EnvironmentRow[] {
  let text: string | null = null;
  try { text = readFileSync(join(root, 'graphyard.json'), 'utf8'); } catch { /* none declared */ }
  const state = readEnvironmentState(environmentStatePath(root));
  const local: EnvironmentRow = { name: localEnvironment, where: 'On this host, inside the trial: the app is served from e2e.serve or the declared application', when: 'Every merge trial and batch gate',
    limit: null, inUse: 0, lifecycle: null,
    last: gate ? { at: gate.finishedAt, outcome: gate.outcome === 'verified' ? 'passed' : gate.outcome === 'reverted' ? 'failed' : gate.outcome, commit: gate.tip, ms: null, detail: gate.reason, runId: null, url: null } : null };
  return [local, ...Object.entries(declaredEnvironments(text)).map(([name, definition]) => ({
    name, where: 'Wherever its up command provisions it', when: 'Once per batch gate on main, for the cases that name it',
    limit: definition.maxConcurrent, inUse: state.instances.filter(entry => entry.environment === name).length,
    last: state.runs[name] ?? null, lifecycle: { up: definition.up, down: definition.down, list: definition.list ?? null },
  }))];
}
