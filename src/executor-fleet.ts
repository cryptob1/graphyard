import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { ActionRow } from './model/actions.js';
import { cliCommit } from './protocol-version.js';
import { agentOwner, type AttentionItem, type MasterConfig } from './master.js';

/**
 * The release each executor runs, and the fleet's one restart (GY-126).
 *
 * A stateless executor is a thin entry point over TypeScript modules it imports once, at startup.
 * The checkout it loaded them from moves on — a fix is merged and pulled — and the process keeps
 * running the code it had when it booted, claiming actions with behaviour the repository no longer
 * has. Nothing said so: a claim names an executor and a host, never a release, and `master
 * status` reported the fleet as one thing.
 *
 * Three facts close that. Every executor **registers on its host** the release it loaded (the
 * repository commit and whether the checkout was dirty), refreshes that record on every claim, and
 * marks itself stopped on the way out. Before every claim it re-reads the commit its checkout
 * holds now and, when that differs from what it loaded, **stands down**: it finishes what it was
 * running, claims nothing more, and records why with the command that restarts it. And **one
 * command** restarts the fleet through each executor's supervisor and waits for every one to
 * register again on the current release.
 *
 * The record is host-local, beside the coordinator credential and the loop's own cursor, for the
 * same reason the cursor is: it describes processes on this host, it is read by the commands that
 * run on this host, and it must not need the control plane to answer. The coordinator's release is
 * the checkout the CLI runs from — the commit `master status` and a freshly started `master run`
 * would load — so an executor is split from the coordinator exactly when a restart would change
 * what it runs.
 */

export interface ExecutorRelease { commit: string | null; dirty: boolean | null }
export const executorRestartCommand = 'graphyard master executors restart';
/** The unit name prefix the restart command recognises: a supervisor it may restart without stopping anything else. */
export const executorUnitPrefix = 'graphyard-executor';

const defaultRun = (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
/** The commit the checkout at `root` holds now; null where there is no readable checkout. */
export const readCommit = (root: string, run: (command: string, args: string[]) => string = defaultRun) => cliCommit(root, run);
/**
 * The release a process loads from `root`: the commit, and whether tracked files differ from it
 * (a dirty checkout runs code no commit names). Read once at startup; the dirty check walks the
 * tree, which is not something to do before every claim.
 */
export function readRelease(root: string, run: (command: string, args: string[]) => string = defaultRun): ExecutorRelease {
  const commit = readCommit(root, run);
  if (!commit) return { commit: null, dirty: null };
  let dirty: boolean | null;
  try { dirty = run('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no']).trim().length > 0; } catch { dirty = null; }
  return { commit, dirty };
}
export const shortCommit = (commit: string | null) => commit ? commit.slice(0, 12) : 'an unknown commit';
const describeRelease = (release: ExecutorRelease) => `${shortCommit(release.commit)}${release.dirty ? ' (dirty)' : ''}`;

/**
 * The supervisor unit this process runs under, when it is one the restart command may restart:
 * named by the unit itself (`GRAPHYARD_EXECUTOR_UNIT`, which the packaged template sets to `%n`)
 * or read from the process's own cgroup. Only a `graphyard-executor…` service counts — an
 * executor started inside some other unit's scope (a terminal multiplexer, a session) is not
 * restarted by restarting that unit, and doing so would stop what the unit really runs.
 */
export function detectSupervisorUnit(options: { env?: NodeJS.ProcessEnv; cgroup?: string | null } = {}): string | null {
  const env = options.env ?? process.env;
  const named = env.GRAPHYARD_EXECUTOR_UNIT?.trim();
  if (named) return named;
  let cgroup = options.cgroup;
  if (cgroup === undefined) { try { cgroup = readFileSync('/proc/self/cgroup', 'utf8'); } catch { cgroup = null; } }
  const match = cgroup?.match(new RegExp(`/(${executorUnitPrefix}[^/\\s]*\\.service)(?:/|$)`, 'm'));
  return match?.[1] ?? null;
}
const unitRestart = (unit: string) => `systemctl --user restart ${unit}`;

// ---------------------------------------------------------------------------
// The registration: one file per executor, beside the coordinator credential.
// ---------------------------------------------------------------------------

const releaseSchema = z.object({ commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(), dirty: z.boolean().nullable() }).strict();
const actionRef = z.object({ id: z.string(), key: z.string(), kind: z.string() });
export const executorRegistrationSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(200),
  host: z.string().min(1).max(200),
  pid: z.number().int().positive(),
  principal: z.string().min(1).max(200),
  kinds: z.array(z.string()),
  intervalSeconds: z.number().int().positive(),
  /** The checkout the modules were loaded from. */
  root: z.string(),
  /** The release loaded at startup: what every claim this process makes runs. */
  release: releaseSchema,
  supervisor: z.object({ unit: z.string().min(1), restart: z.string().min(1) }).strict().nullable(),
  state: z.enum(['running', 'standing-down', 'stopped']),
  standDown: z.object({ at: z.string(), reason: z.string(), current: z.string().nullable(), restart: z.string() }).strict().nullable(),
  startedAt: z.string(), updatedAt: z.string(), stoppedAt: z.string().nullable(),
  claims: z.number().int().nonnegative(),
  lastClaim: actionRef.extend({ at: z.string(), release: releaseSchema }).strict().nullable(),
  inFlight: actionRef.extend({ since: z.string() }).strict().nullable(),
}).strict();
export type ExecutorRegistration = z.infer<typeof executorRegistrationSchema>;

export type ExecutorFleetConfig = Pick<MasterConfig, 'credentialFile' | 'hostId'>;
/** Beside the coordinator credential and the loop's cursor: `<credential stem>.executors/<name>.json`. */
export const executorsDirectory = (config: Pick<MasterConfig, 'credentialFile'>) =>
  resolve(dirname(config.credentialFile), `${basename(config.credentialFile).replace(/\.token$/, '')}.executors`);
const registrationFile = (config: Pick<MasterConfig, 'credentialFile'>, name: string) => join(executorsDirectory(config), `${name.replace(/[^A-Za-z0-9._@-]/g, '_')}.json`);

export async function writeExecutorRegistration(config: Pick<MasterConfig, 'credentialFile'>, registration: ExecutorRegistration) {
  const file = registrationFile(config, registration.name), temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(temporary, JSON.stringify(executorRegistrationSchema.parse(registration), null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
  return file;
}
export const removeExecutorRegistration = (config: Pick<MasterConfig, 'credentialFile'>, name: string) => rm(registrationFile(config, name), { force: true });
/** Every registration on the host, unreadable files skipped: a report never fails on one broken record. */
export async function readExecutorRegistrations(config: Pick<MasterConfig, 'credentialFile'>): Promise<ExecutorRegistration[]> {
  const directory = executorsDirectory(config);
  let names: string[];
  try { names = (await readdir(directory)).filter(name => name.endsWith('.json')); } catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
  const registrations: ExecutorRegistration[] = [];
  for (const name of names.sort()) {
    try { registrations.push(executorRegistrationSchema.parse(JSON.parse(await readFile(join(directory, name), 'utf8')))); } catch { /* a partial write or an older record */ }
  }
  return registrations;
}

export interface ExecutorRegistrarInput { name: string; host: string; pid: number; principal: string; kinds: string[]; intervalSeconds: number; root: string; release: ExecutorRelease; supervisor: string | null }
/**
 * The executor's own bookkeeping: one record, rewritten at every transition. `started` writes it
 * as running; `claimed` and `settled` record each claim with the loaded release, so the record
 * says what release the last action ran on; `standDown` says the executor claims nothing more and
 * why; `stopped` is the last write on the way out, so a restart's wait can tell the old process
 * from the new one.
 */
export function executorRegistrar(config: Pick<MasterConfig, 'credentialFile'>, input: ExecutorRegistrarInput, now: () => number = Date.now) {
  const at = () => new Date(now()).toISOString();
  const registration: ExecutorRegistration = {
    version: 1, name: input.name, host: input.host, pid: input.pid, principal: input.principal, kinds: input.kinds, intervalSeconds: input.intervalSeconds,
    root: input.root, release: input.release, supervisor: input.supervisor ? { unit: input.supervisor, restart: unitRestart(input.supervisor) } : null,
    state: 'running', standDown: null, startedAt: at(), updatedAt: at(), stoppedAt: null, claims: 0, lastClaim: null, inFlight: null,
  };
  const write = async () => { registration.updatedAt = at(); return writeExecutorRegistration(config, registration); };
  return {
    registration,
    file: registrationFile(config, input.name),
    started: () => write(),
    claimed: (action: Pick<ActionRow, 'id' | 'key' | 'kind'>) => {
      registration.claims += 1;
      registration.lastClaim = { id: action.id, key: action.key, kind: action.kind, at: at(), release: registration.release };
      registration.inFlight = { id: action.id, key: action.key, kind: action.kind, since: at() };
      return write();
    },
    settled: () => { registration.inFlight = null; return write(); },
    standDown: (detail: { current: string | null; reason: string }) => {
      registration.state = 'standing-down';
      registration.standDown = { at: at(), reason: detail.reason, current: detail.current, restart: executorRestartCommand };
      return write();
    },
    resumed: () => { registration.state = 'running'; registration.standDown = null; return write(); },
    stopped: () => { registration.state = 'stopped'; registration.stoppedAt = at(); registration.inFlight = null; return write(); },
  };
}

// ---------------------------------------------------------------------------
// What master status says about the fleet.
// ---------------------------------------------------------------------------

export const processAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string }).code === 'EPERM'; } };

export interface ExecutorFleetRow {
  name: string; host: string; pid: number; principal: string; kinds: string[];
  /** Whether the process is running, verified on this host; unknown for another host's record. */
  alive: boolean | null;
  /** The recorded state, or `gone` for a running record whose process this host cannot find. */
  state: 'running' | 'standing-down' | 'stopped' | 'gone';
  release: ExecutorRelease; coordinator: string | null;
  /** The executor runs a commit other than the coordinator's. */
  split: boolean;
  /** Split and still up: what the restart command is for. */
  needsRestart: boolean;
  supervisor: ExecutorRegistration['supervisor']; restart: string;
  standDown: ExecutorRegistration['standDown'];
  claims: number; lastClaim: ExecutorRegistration['lastClaim']; inFlight: ExecutorRegistration['inFlight'];
  startedAt: string; updatedAt: string; stoppedAt: string | null;
  /** The one line: this executor's commit beside the coordinator's. */
  line: string;
}
export interface ExecutorFleetReport { coordinator: { commit: string | null }; executors: ExecutorFleetRow[]; split: boolean; needingRestart: string[]; attention: AttentionItem[] }

/**
 * Each executor's release beside the coordinator's, and one attention item for every executor
 * that has to be restarted to run what the coordinator runs. A split fleet reads in one line per
 * executor: `exec-1 on host-a runs 0ea7ab5c0ea7 beside the coordinator's fdd31388fdd3 — split, standing down`.
 */
export function executorFleetReport(registrations: ExecutorRegistration[], coordinator: { commit: string | null }, options: { hostId: string; now?: number; alive?: (pid: number) => boolean }): ExecutorFleetReport {
  const alive = options.alive ?? processAlive;
  const executors = registrations.map((registration): ExecutorFleetRow => {
    const local = registration.host === options.hostId;
    const running = local && registration.state !== 'stopped' ? alive(registration.pid) : null;
    const state = registration.state === 'running' && running === false ? 'gone' : registration.state;
    const split = !!registration.release.commit && !!coordinator.commit && registration.release.commit !== coordinator.commit;
    const up = state === 'running' || state === 'standing-down';
    const needsRestart = up && (split || state === 'standing-down');
    const standing = state === 'standing-down' ? ', standing down' : state === 'gone' ? ', process gone' : state === 'stopped' ? ', stopped' : '';
    const line = `${registration.name} on ${registration.host} runs ${describeRelease(registration.release)} beside the coordinator's ${shortCommit(coordinator.commit)}${split ? ` — split${standing || ', claims until its next check'}` : standing ? ` —${standing.slice(1)}` : ''}`;
    return { name: registration.name, host: registration.host, pid: registration.pid, principal: registration.principal, kinds: registration.kinds, alive: running, state,
      release: registration.release, coordinator: coordinator.commit, split, needsRestart, supervisor: registration.supervisor, restart: registration.supervisor?.restart ?? executorRestartCommand,
      standDown: registration.standDown, claims: registration.claims, lastClaim: registration.lastClaim, inFlight: registration.inFlight,
      startedAt: registration.startedAt, updatedAt: registration.updatedAt, stoppedAt: registration.stoppedAt, line };
  });
  const needing = executors.filter(row => row.needsRestart);
  const attention: AttentionItem[] = [];
  if (needing.length) {
    const named = needing.map(row => `${row.name} on ${row.host} (loaded ${describeRelease(row.release)}${row.state === 'standing-down' ? `, standing down since ${row.standDown?.at ?? 'its last check'}` : ', stands down at its next check'}${row.supervisor ? '' : '; no supervisor unit, so it must be stopped and started by hand'})`).join('; ');
    attention.push({ subject: 'executors', text: `${needing.length} executor${needing.length === 1 ? '' : 's'} run${needing.length === 1 ? 's' : ''} a release other than the coordinator's ${shortCommit(coordinator.commit)} and claim${needing.length === 1 ? 's' : ''} nothing until restarted: ${named}`,
      ...agentOwner('master', executorRestartCommand) });
  }
  return { coordinator: { commit: coordinator.commit }, executors, split: executors.some(row => row.split), needingRestart: needing.map(row => row.name), attention };
}

// ---------------------------------------------------------------------------
// The one restart.
// ---------------------------------------------------------------------------

export interface RestartExecutorsDeps {
  /** The control plane's action queue (`GET /api/actions`): its live claims decide whether anything may be restarted. */
  actions: () => Promise<{ now?: string; queue?: { executors?: { executor: string; host: string; actions: number }[] }; actions?: ActionRow[] }>;
  /** The release the coordinator runs: what every executor must register again on. */
  coordinatorCommit: string | null;
  /** The host's supervisor commands, throwing what they printed when they fail. */
  run?: (command: string, args: string[]) => string;
  alive?: (pid: number) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for every restarted executor to register again, and how often to look. */
  timeoutMs?: number; pollMs?: number;
}
export interface RestartedExecutor { name: string; unit: string; pid: { before: number; after: number | null }; release: { before: ExecutorRelease; after: ExecutorRelease | null }; registered: boolean; waitedMs: number }
export interface ExecutorRestartResult {
  result: 'restarted' | 'refused' | 'incomplete';
  reason: string | null;
  coordinator: { commit: string | null };
  /** Executors holding a claimed action, each with the action: nothing was restarted while one existed. */
  held: { name: string; host: string; key: string | null; kind: string | null; id: string | null; since: string | null }[];
  restarted: RestartedExecutor[];
  /** Running executors with no supervisor unit: named with what stops and starts them, never signalled. */
  unsupervised: { name: string; pid: number; root: string; instruction: string }[];
  /** Records whose process is gone and which no supervisor brings back; removed. */
  forgotten: string[];
}
export const executorRestartTimeoutMs = 120_000;

/**
 * `graphyard master executors restart`: stop and start every executor registered on this host
 * through its supervisor, and wait for each to register again on the coordinator's release.
 *
 * It refuses, naming the executor and the action, while any executor on this host holds a claimed
 * action — the control plane's live claims decide that, with each record's own in-flight note as
 * a second reading — because a restart would leave that row to expire and be run again by
 * somebody else. It restarts through the supervisor alone: an executor started by hand has no
 * unit to restart, so it is named with the instruction rather than signalled, and the result is
 * incomplete. The wait ends when every restarted unit has a running registration written after
 * the restart on the coordinator's commit, or at the timeout, which names what never came back.
 */
export async function restartExecutors(config: ExecutorFleetConfig, deps: RestartExecutorsDeps): Promise<ExecutorRestartResult> {
  const run = deps.run ?? ((command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }));
  const alive = deps.alive ?? processAlive, now = deps.now ?? Date.now, sleep = deps.sleep ?? (ms => delay(ms).then(() => {}));
  const coordinator = { commit: deps.coordinatorCommit };
  const local = (await readExecutorRegistrations(config)).filter(registration => registration.host === config.hostId);
  const empty = (result: ExecutorRestartResult['result'], reason: string | null): ExecutorRestartResult => ({ result, reason, coordinator, held: [], restarted: [], unsupervised: [], forgotten: [] });

  // The refusal comes first and reads the control plane: a claim is a lease the queue holds, and
  // this host's records only say what each executor believed when it last wrote.
  const queue = await deps.actions();
  const liveClaims = (queue.queue?.executors ?? []).filter(entry => entry.host === config.hostId);
  const rows = queue.actions ?? [];
  const held: ExecutorRestartResult['held'] = liveClaims.map(entry => {
    const row = rows.find(candidate => candidate.state === 'claimed' && candidate.claim?.executor === entry.executor && candidate.claim.host === entry.host);
    return { name: entry.executor, host: entry.host, key: row?.key ?? null, kind: row?.kind ?? null, id: row?.id ?? null, since: row?.claim?.claimedAt ?? null };
  });
  for (const registration of local) {
    if (registration.inFlight && registration.state !== 'stopped' && !held.some(entry => entry.name === registration.name) && (alive(registration.pid)))
      held.push({ name: registration.name, host: registration.host, key: registration.inFlight.key, kind: registration.inFlight.kind, id: registration.inFlight.id, since: registration.inFlight.since });
  }
  if (held.length) {
    const named = held.map(entry => `${entry.name} holds ${entry.kind ?? 'an action'}${entry.key ? ` for ${entry.key}` : ''}${entry.since ? ` since ${entry.since}` : ''}`).join('; ');
    return { ...empty('refused', `Restart refused while an executor on ${config.hostId} holds a claimed action: ${named}. Wait for it to settle, then run ${executorRestartCommand} again`), held };
  }

  const restarted: RestartedExecutor[] = [], unsupervised: ExecutorRestartResult['unsupervised'] = [], forgotten: string[] = [];
  const restartAt = now();
  const units = new Map<string, ExecutorRegistration>();
  for (const registration of local) {
    if (registration.state === 'stopped') continue;
    const up = alive(registration.pid);
    if (registration.supervisor) { if (!units.has(registration.supervisor.unit)) units.set(registration.supervisor.unit, registration); continue; }
    if (up) unsupervised.push({ name: registration.name, pid: registration.pid, root: registration.root,
      instruction: `${registration.name} runs unsupervised as pid ${registration.pid}; stop it (kill -TERM ${registration.pid}; it finishes the action in flight and records itself stopped) and start it again from ${registration.root} with node scripts/graphyard-executor.mjs --name ${registration.name}, or run it under the packaged unit (examples/master/graphyard-executor@.service) so this command can restart it` });
    else { await removeExecutorRegistration(config, registration.name); forgotten.push(registration.name); }
  }
  if (!units.size && !unsupervised.length) return { ...empty('restarted', `No executor is registered on ${config.hostId}`), forgotten };

  for (const [unit] of units) run('systemctl', ['--user', 'restart', unit]);

  // Wait for each unit's executor to register again: a running record, written after the restart
  // was asked for, on the coordinator's commit. A record written on another commit is a process
  // that came back on the wrong code — the checkout moved under it, or the unit runs elsewhere —
  // and it is not counted as back.
  const deadline = restartAt + (deps.timeoutMs ?? executorRestartTimeoutMs);
  const pending = new Map(units);
  const back = new Map<string, ExecutorRegistration>();
  for (;;) {
    const current = await readExecutorRegistrations(config);
    for (const [unit] of pending) {
      const again = current.find(registration => registration.host === config.hostId && registration.supervisor?.unit === unit && registration.state === 'running'
        && Date.parse(registration.startedAt) >= restartAt - 1000 && (!coordinator.commit || registration.release.commit === coordinator.commit));
      if (again) { back.set(unit, again); pending.delete(unit); }
    }
    if (!pending.size || now() >= deadline) break;
    await sleep(deps.pollMs ?? 1000);
  }
  const waitedMs = now() - restartAt;
  for (const [unit, before] of units) {
    const after = back.get(unit) ?? null;
    restarted.push({ name: after?.name ?? before.name, unit, pid: { before: before.pid, after: after?.pid ?? null }, release: { before: before.release, after: after?.release ?? null }, registered: !!after, waitedMs });
  }
  const missing = [...pending.keys()].map(unit => `${units.get(unit)!.name} (${unit})`);
  const reasons = [
    missing.length ? `${missing.join(', ')} did not register again on ${shortCommit(coordinator.commit)} within ${Math.round(waitedMs / 1000)}s; read journalctl --user -u UNIT and the record under ${executorsDirectory(config)}` : null,
    unsupervised.length ? `${unsupervised.map(entry => entry.name).join(', ')} ${unsupervised.length === 1 ? 'has' : 'have'} no supervisor unit and ${unsupervised.length === 1 ? 'was' : 'were'} not restarted` : null,
  ].filter((reason): reason is string => !!reason);
  return { result: reasons.length ? 'incomplete' : 'restarted', reason: reasons.join('; ') || null, coordinator, held: [], restarted, unsupervised, forgotten };
}
