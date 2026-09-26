import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

/** A unit the restart command may restart: a `graphyard-executor…` service and nothing else. */
const executorUnitPattern = new RegExp(`^${executorUnitPrefix}(?:[@-][A-Za-z0-9@._:-]*)?\\.service$`);
export const isExecutorUnit = (unit: string) => executorUnitPattern.test(unit);

/**
 * The supervisor unit this process runs under, when it is one the restart command may restart:
 * named by hand (`--unit`), named by the unit itself (`GRAPHYARD_EXECUTOR_UNIT`, which the packaged
 * template sets to `%n`), or read from the process's own cgroup. Only a `graphyard-executor…`
 * service counts, whichever source names it — an executor started inside some other unit's scope
 * (a terminal multiplexer, a session) is not restarted by restarting that unit, and doing so would
 * stop what the unit really runs. A named unit outside that rule is refused rather than ignored:
 * it is a mistake in the unit file or the command line, and the executor says so at startup.
 */
export function detectSupervisorUnit(options: { named?: string | null; env?: NodeJS.ProcessEnv; cgroup?: string | null } = {}): string | null {
  const env = options.env ?? process.env;
  const named = options.named?.trim() || env.GRAPHYARD_EXECUTOR_UNIT?.trim();
  if (named) {
    if (!isExecutorUnit(named)) throw new Error(`${named} is not a ${executorUnitPrefix} service, so master executors restart may not restart it; name the executor's own unit (${executorUnitPrefix}@NAME.service) with --unit or GRAPHYARD_EXECUTOR_UNIT, or leave both unset`);
    return named;
  }
  let cgroup = options.cgroup;
  if (cgroup === undefined) { try { cgroup = readFileSync('/proc/self/cgroup', 'utf8'); } catch { cgroup = null; } }
  const match = cgroup?.match(new RegExp(`/(${executorUnitPrefix}[^/\\s]*\\.service)(?:/|$)`, 'm'));
  return match && isExecutorUnit(match[1]) ? match[1] : null;
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
  /** Set from just before the executor looks for a restart fence until its claim is recorded or abandoned: the half of the restart exclusion the executor holds. */
  claiming: z.string().nullable().default(null),
}).strict();
export type ExecutorRegistration = z.infer<typeof executorRegistrationSchema>;

export type ExecutorFleetConfig = Pick<MasterConfig, 'credentialFile' | 'hostId'>;
/** Beside the coordinator credential and the loop's cursor: `<credential stem>.executors/<name>.json`. */
export type ExecutorRegistrationInput = z.input<typeof executorRegistrationSchema>;
export const executorsDirectory = (config: Pick<MasterConfig, 'credentialFile'>) =>
  resolve(dirname(config.credentialFile), `${basename(config.credentialFile).replace(/\.token$/, '')}.executors`);
const registrationFile = (config: Pick<MasterConfig, 'credentialFile'>, name: string) => join(executorsDirectory(config), `${name.replace(/[^A-Za-z0-9._@-]/g, '_')}.json`);

export async function writeExecutorRegistration(config: Pick<MasterConfig, 'credentialFile'>, registration: ExecutorRegistrationInput) {
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
  if (input.supervisor && !isExecutorUnit(input.supervisor)) throw new Error(`${input.supervisor} is not a ${executorUnitPrefix} service; an executor registers only a unit master executors restart may restart`);
  const at = () => new Date(now()).toISOString();
  const registration: ExecutorRegistration = {
    version: 1, name: input.name, host: input.host, pid: input.pid, principal: input.principal, kinds: input.kinds, intervalSeconds: input.intervalSeconds,
    root: input.root, release: input.release, supervisor: input.supervisor ? { unit: input.supervisor, restart: unitRestart(input.supervisor) } : null,
    state: 'running', standDown: null, startedAt: at(), updatedAt: at(), stoppedAt: null, claims: 0, lastClaim: null, inFlight: null, claiming: null,
  };
  const write = async () => { registration.updatedAt = at(); return writeExecutorRegistration(config, registration); };
  return {
    registration,
    file: registrationFile(config, input.name),
    started: () => write(),
    /** Written before the fence is read: from here until `claimed` or `abandoned`, a restart waits. */
    claiming: () => { registration.claiming = at(); return write(); },
    abandoned: () => { registration.claiming = null; return write(); },
    claimed: (action: Pick<ActionRow, 'id' | 'key' | 'kind'>) => {
      registration.claims += 1;
      registration.lastClaim = { id: action.id, key: action.key, kind: action.kind, at: at(), release: registration.release };
      registration.inFlight = { id: action.id, key: action.key, kind: action.kind, since: at() };
      registration.claiming = null;
      return write();
    },
    settled: () => { registration.inFlight = null; return write(); },
    standDown: (detail: { current: string | null; reason: string }) => {
      registration.state = 'standing-down';
      registration.standDown = { at: at(), reason: detail.reason, current: detail.current, restart: executorRestartCommand };
      return write();
    },
    resumed: () => { registration.state = 'running'; registration.standDown = null; return write(); },
    stopped: () => { registration.state = 'stopped'; registration.stoppedAt = at(); registration.inFlight = null; registration.claiming = null; return write(); },
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

/**
 * The unserved-kind lines (describeUnserved) whose kind an executor waiting on a restart serves: nothing
 * runs that kind because the executors that would are split or standing down, which the fleet's own
 * attention line already names (GY-374). Each is marked as restating it, so the loop counts one fault,
 * not one more per item that reaches that kind while the executors wait for their restart.
 */
export function attributeUnserved(items: AttentionItem[], unserved: { kind: string; text: string }[], report: Pick<ExecutorFleetReport, 'executors' | 'attention'>): AttentionItem[] {
  if (!report.attention.length) return items;
  const held = new Set(report.executors.filter(row => row.needsRestart).flatMap(row => row.kinds));
  const symptoms = new Set(unserved.filter(entry => held.has(entry.kind)).map(entry => entry.text));
  return items.map(item => symptoms.has(item.text) ? { ...item, restates: report.attention[0].subject } : item);
}

// ---------------------------------------------------------------------------
// The one restart.
// ---------------------------------------------------------------------------

/**
 * The restart exclusion. Reading the queue once and then restarting leaves a window: an executor
 * that passed its release check claims a row after the read and before its unit is stopped, and
 * the restart kills the handler that row is owed. The two sides therefore each announce, then
 * look. The restart writes a **fence** — `restart.fence` beside the records, created exclusively
 * and naming its pid and an expiry — and only then reads the records; an executor marks its record
 * `claiming` and only then reads the fence, claiming nothing while one stands. Whichever order the
 * two interleave in, either the executor sees the fence and does not claim, or the restart sees the
 * `claiming` mark and waits until the claim is recorded as in flight (and refuses) or abandoned.
 * A fence whose restart has exited, or which outlived its expiry, stands for nothing.
 */
const restartFenceSchema = z.object({ id: z.string(), pid: z.number().int().positive(), host: z.string(), at: z.string(), expiresAt: z.string() }).strict();
export type RestartFence = z.infer<typeof restartFenceSchema>;
export const restartFenceFile = (config: Pick<MasterConfig, 'credentialFile'>) => join(executorsDirectory(config), 'restart.fence');
/** The fence standing on this host now, or null: an unreadable, expired or orphaned fence is none. */
export async function readRestartFence(config: Pick<MasterConfig, 'credentialFile'>, options: { now?: number; alive?: (pid: number) => boolean } = {}): Promise<RestartFence | null> {
  let fence: RestartFence;
  try { fence = restartFenceSchema.parse(JSON.parse(await readFile(restartFenceFile(config), 'utf8'))); } catch { return null; }
  if (Date.parse(fence.expiresAt) <= (options.now ?? Date.now())) return null;
  return (options.alive ?? processAlive)(fence.pid) ? fence : null;
}
async function raiseRestartFence(config: ExecutorFleetConfig, options: { now: number; expiresInMs: number; alive: (pid: number) => boolean }): Promise<{ fence: RestartFence } | { standing: RestartFence }> {
  const file = restartFenceFile(config);
  const fence: RestartFence = { id: randomUUID(), pid: process.pid, host: config.hostId, at: new Date(options.now).toISOString(), expiresAt: new Date(options.now + options.expiresInMs).toISOString() };
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    // Written whole, then linked into place: link refuses an existing fence, so two restarts never both hold one.
    const temporary = `${file}.${fence.id}.tmp`;
    await writeFile(temporary, JSON.stringify(fence), { mode: 0o600, flag: 'wx' });
    try { await link(temporary, file); return { fence }; }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      const standing = await readRestartFence(config, { now: options.now, alive: options.alive });
      if (standing) return { standing };
      await rm(file, { force: true });
    } finally { await rm(temporary, { force: true }); }
  }
  throw new Error(`Could not raise the restart fence at ${file}`);
}
async function lowerRestartFence(config: ExecutorFleetConfig, fence: RestartFence) {
  const standing = await readRestartFence(config, { alive: () => true, now: 0 });
  if (standing?.id === fence.id) await rm(restartFenceFile(config), { force: true });
}

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
  /** How long a claim already announced may take to be recorded or abandoned before the restart refuses. */
  claimWaitMs?: number;
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
export const executorClaimWaitMs = 30_000;

/**
 * `graphyard master executors restart`: stop and start every executor registered on this host
 * through its supervisor, and wait for each to register again on the coordinator's release.
 *
 * It refuses, naming the executor and the action, while any executor on this host holds a claimed
 * action — the control plane's live claims decide that, with each record's own in-flight note as
 * a second reading — because a restart would leave that row to expire and be run again by
 * somebody else. Those readings are taken behind the restart fence, after every claim already
 * announced has been recorded or abandoned, and the fence stands until the wait ends, so no
 * executor on this host claims between the reading and its restart. It restarts through the
 * supervisor alone, and only a `graphyard-executor…` unit: an executor started by hand, or one
 * whose record names another unit, is named with the instruction rather than signalled, and the
 * result is incomplete. The wait ends when every restarted unit has a running registration written
 * after the restart on the coordinator's commit, or at the timeout, which names what never came back.
 */
export async function restartExecutors(config: ExecutorFleetConfig, deps: RestartExecutorsDeps): Promise<ExecutorRestartResult> {
  const run = deps.run ?? ((command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }));
  const alive = deps.alive ?? processAlive, now = deps.now ?? Date.now, sleep = deps.sleep ?? (ms => delay(ms).then(() => {}));
  const coordinator = { commit: deps.coordinatorCommit };
  const empty = (result: ExecutorRestartResult['result'], reason: string | null): ExecutorRestartResult => ({ result, reason, coordinator, held: [], restarted: [], unsupervised: [], forgotten: [] });
  const timeoutMs = deps.timeoutMs ?? executorRestartTimeoutMs, claimWaitMs = Math.min(deps.claimWaitMs ?? executorClaimWaitMs, timeoutMs);

  // The fence first: from here no executor on this host starts a claim, and one already announced is waited for.
  const raised = await raiseRestartFence(config, { now: now(), expiresInMs: claimWaitMs + timeoutMs + 60_000, alive });
  if ('standing' in raised) return empty('refused', `Restart refused: another restart on ${config.hostId} (pid ${raised.standing.pid}, since ${raised.standing.at}) holds the fence at ${restartFenceFile(config)}; wait for it to finish`);
  try {
    let local: ExecutorRegistration[];
    const claimDeadline = now() + claimWaitMs;
    for (;;) {
      local = (await readExecutorRegistrations(config)).filter(registration => registration.host === config.hostId);
      const claiming = local.filter(registration => registration.claiming && registration.state !== 'stopped' && alive(registration.pid));
      if (!claiming.length) break;
      if (now() >= claimDeadline) {
        return empty('refused', `Restart refused while an executor on ${config.hostId} is claiming an action: ${claiming.map(registration => `${registration.name} since ${registration.claiming}`).join('; ')}. Wait for the claim to settle, then run ${executorRestartCommand} again`);
      }
      await sleep(deps.pollMs ?? 250);
    }

    // The refusal reads the control plane: a claim is a lease the queue holds, and this host's
    // records only say what each executor believed when it last wrote.
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
      // A record is a file on this host: a unit it names is restarted only when it is an executor unit.
      if (registration.supervisor && isExecutorUnit(registration.supervisor.unit)) { if (!units.has(registration.supervisor.unit)) units.set(registration.supervisor.unit, registration); continue; }
      if (up) unsupervised.push({ name: registration.name, pid: registration.pid, root: registration.root,
        instruction: `${registration.name} runs ${registration.supervisor ? `under ${registration.supervisor.unit}, which is not a ${executorUnitPrefix} service this command may restart,` : 'unsupervised'} as pid ${registration.pid}; stop it (kill -TERM ${registration.pid}; it finishes the action in flight and records itself stopped) and start it again from ${registration.root} with node scripts/graphyard-executor.mjs --name ${registration.name}, or run it under the packaged unit (examples/master/graphyard-executor@.service) so this command can restart it` });
      else { await removeExecutorRegistration(config, registration.name); forgotten.push(registration.name); }
    }
    if (!units.size && !unsupervised.length) return { ...empty('restarted', `No executor is registered on ${config.hostId}`), forgotten };

    for (const [unit] of units) run('systemctl', ['--user', 'restart', unit]);

    // Wait for each unit's executor to register again: a running record from a new process, written
    // after the restart was asked for, on the coordinator's commit. A record written on another commit is a process
    // that came back on the wrong code — the checkout moved under it, or the unit runs elsewhere —
    // and it is not counted as back. The fence stands meanwhile, so the new processes claim once it
    // is lowered.
    const deadline = restartAt + timeoutMs;
    const pending = new Map(units);
    const back = new Map<string, ExecutorRegistration>();
    for (;;) {
      const current = await readExecutorRegistrations(config);
      for (const [unit, before] of pending) {
        const again = current.find(registration => registration.host === config.hostId && registration.supervisor?.unit === unit && registration.state === 'running'
          && registration.pid !== before.pid && Date.parse(registration.startedAt) >= restartAt - 1000 && (!coordinator.commit || registration.release.commit === coordinator.commit));
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
  } finally { await lowerRestartFence(config, raised.fence); }
}
