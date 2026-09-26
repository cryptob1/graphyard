import { closeSync, existsSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { piRunner, readRunMeta, runAlive } from './pi.js';
import { runRecord, runRecordSchema, type Run, type RunOptions, type RunRecord, type RunResult, type Runner } from './types.js';

/**
 * The runs this process started (GY-169). A headless run has no pane, so Herdr cannot list it;
 * the loop reads this registry beside its Herdr inventory instead (master.ts listHerdrAgents). A
 * live run reads as a working session under its session name; an ended one, and a run this process
 * never started, is absent: the same "gone" a closed pane is, judged by the same supervision. An
 * ended run's record stays readable here for a while after.
 *
 * The registry is also on disk (GY-453): a run started with a loop root gets a directory under
 * `.graphyard/runs/` holding its output, its exit, who owns it (`owner.json`: its name, role,
 * work, subject and what its role needs to apply its result) and, once applied, its record. A run is
 * detached from the process that started it, so a restart leaves it running; the restarted process
 * adopts every run still live there (`adoptRuns`), keeps waiting on it, and applies its result once.
 */
export type RunRole = 'approver' | 'producer' | 'research';
export interface RegisteredRun {
  name: string;
  role: RunRole;
  work: string;
  /** The producer ledger record id, or the decision id, the run answers. */
  subject: string;
  run: Run<unknown>;
  /** Filled in when the run ends and its payload was applied. */
  record: RunRecord | null;
  endedAt: number | null;
}

const retentionMs = 30 * 60_000;
const runs = new Map<string, RegisteredRun>();
/** Every run this process watches until it ends, research runs included. */
const watched = new Set<Run<unknown>>();

const prune = (now = Date.now()) => { for (const [name, entry] of runs) if (entry.endedAt !== null && now - entry.endedAt > retentionMs) runs.delete(name); };

export function registerRun(entry: Omit<RegisteredRun, 'record' | 'endedAt'>) {
  prune();
  const live = runs.get(entry.name);
  if (live && live.endedAt === null) throw new Error(`A ${live.role} run named ${entry.name} is already running for ${live.work}`);
  const registered: RegisteredRun = { ...entry, record: null, endedAt: null };
  runs.set(entry.name, registered);
  return registered;
}
export function endRun(name: string, record: RunRecord) {
  const entry = runs.get(name);
  if (entry) Object.assign(entry, { record, endedAt: Date.now() });
}
export const registeredRun = (name: string) => { prune(); return runs.get(name) ?? null; };
export const registeredRunFor = (subject: string) => { prune(); return [...runs.values()].find(entry => entry.subject === subject) ?? null; };
export const liveRun = (name: string) => { const entry = registeredRun(name); return entry && entry.endedAt === null ? entry : null; };
/** Every registered run this process is watching that has not ended. */
export const liveRuns = () => { prune(); return [...runs.values()].filter(entry => entry.endedAt === null); };
/** How many runs this process watches, research runs included. */
export const watchedRuns = () => watched.size;

/** The live runs as Herdr-shaped sessions: no pane, and a working status. A research run is no session. */
export function runnerAgents(): { name: string; agent: string; agent_status: string }[] {
  return liveRuns().filter(entry => entry.role !== 'research').map(entry => ({ name: entry.name, agent: 'pi', agent_status: 'working' }));
}
/** The Herdr inventory with this process's runs beside it; a name Herdr lists wins. */
export function withRunnerAgents<A extends { name?: string }>(agents: A[]): (A | ReturnType<typeof runnerAgents>[number])[] {
  const named = new Set(agents.map(agent => agent.name));
  return [...agents, ...runnerAgents().filter(agent => !named.has(agent.name))];
}

/** Test seam: forget every run. */
export function clearRuns() { for (const entry of runs.values()) if (entry.endedAt === null) entry.run.cancel('the registry was cleared'); runs.clear(); watched.clear(); }
/**
 * What this process's exit does to its runs, and a test's simulated restart: stop watching every
 * run and forget it, without a signal to any of them. They keep running, and `adoptRuns` finds them.
 */
export function detachRuns() {
  const left = [...watched];
  for (const run of left) run.detach?.();
  watched.clear(); runs.clear();
  return left.length;
}

// ---- The registry on disk -------------------------------------------------------------------------

export const runsDirectory = (root: string) => resolve(root, '.graphyard', 'runs');
export const runOwnerSchema = z.object({
  version: z.literal(1), name: z.string().min(1).max(200), role: z.enum(['approver', 'producer', 'research']), work: z.string().min(1).max(200), subject: z.string().min(1).max(200),
  /** What the role needs to apply the run's result after a restart: never a credential, only where to read one. */
  context: z.record(z.string(), z.unknown()).default({}),
  startedAt: z.string().max(40),
}).strict();
export type RunOwner = z.infer<typeof runOwnerSchema>;
const ownerFile = (directory: string) => join(directory, 'owner.json');
const recordFile = (directory: string) => join(directory, 'record.json');
const claimFile = (directory: string) => join(directory, 'apply.claim');

export function writeRunOwner(directory: string, owner: Omit<RunOwner, 'version'>) {
  writeFileSync(ownerFile(directory), JSON.stringify(runOwnerSchema.parse({ version: 1, ...owner })), { mode: 0o600 });
}
export function readRunOwner(directory: string): RunOwner | null {
  try { return runOwnerSchema.parse(JSON.parse(readFileSync(ownerFile(directory), 'utf8'))); } catch { return null; }
}
export function readEndedRecord(directory: string): RunRecord | null {
  try { return runRecordSchema.parse(JSON.parse(readFileSync(recordFile(directory), 'utf8'))); } catch { return null; }
}

/** One watcher of a run in this process: a claim names the process and the watcher, so neither a restart nor a second watcher applies twice. */
const claimant = () => `${process.pid}:${randomUUID()}`;
/**
 * Apply a run's result at most once, whoever watches it (GY-453). The first watcher to claim the
 * run applies it and records it; any other — a second watcher, or a loop that adopted the run while
 * the first was still applying — applies nothing. A claim whose process is gone without a record
 * (it died mid-apply) is taken over, since nothing was recorded as applied.
 */
export async function applyOnce(directory: string | undefined, apply: () => Promise<RunRecord>): Promise<RunRecord | null> {
  if (!directory) return apply();
  const claim = claimFile(directory), mine = claimant();
  const take = () => { const fd = openSync(claim, 'wx', 0o600); try { writeSync(fd, mine); } finally { closeSync(fd); } };
  try { take(); }
  catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    if (existsSync(recordFile(directory))) return null;
    const holder = Number((readFileSync(claim, 'utf8').split(':')[0]));
    if (Number.isInteger(holder) && holder > 0 && holderAlive(holder)) return null;
    rmSync(claim, { force: true });
    try { take(); } catch { return null; }
  }
  const record = await apply();
  writeFileSync(recordFile(directory), JSON.stringify(record), { mode: 0o600 });
  return record;
}
const holderAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === 'EPERM'; } };

/** Ended runs are kept this long on disk, for the record, then removed. */
export const runDirectoryRetentionMs = 24 * 60 * 60_000;
/** Every run directory under the registry with its owner and, when it has ended, its record. */
export function listRunDirectories(runsRoot: string) {
  let names: string[];
  try { names = readdirSync(runsRoot); } catch { return []; }
  return names.map(name => join(runsRoot, name)).flatMap(directory => {
    const owner = readRunOwner(directory);
    return owner ? [{ directory, owner, record: readEndedRecord(directory) }] : [];
  });
}
/** Removes ended runs past their retention, and directories no owner was ever written to. */
export function pruneRunDirectories(runsRoot: string, now = Date.now()) {
  let names: string[];
  try { names = readdirSync(runsRoot); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    const directory = join(runsRoot, name);
    try {
      const age = now - statSync(directory).mtimeMs, record = readEndedRecord(directory), owner = readRunOwner(directory), meta = readRunMeta(directory);
      const stale = record ? now - Date.parse(record.endedAt ?? record.startedAt) > runDirectoryRetentionMs
        : !owner && age > runDirectoryRetentionMs && !(meta && runAlive(meta));
      if (stale) { rmSync(directory, { recursive: true, force: true }); removed++; }
    } catch { /* one unreadable directory never stops the rest */ }
  }
  return removed;
}

export type Applied = RunRecord['applied'][number];
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Watch a run registered under its session name and apply its result once when it ends. Shared by
 * a run's start and its adoption after a restart: the same registration, the same single apply.
 */
export function superviseRun<T>(input: { runner: Pick<Runner, 'name'>; run: Run<T>; name: string; role: RunRole; work: string; subject: string; startedAt: string;
  apply: (result: RunResult<T>) => Promise<Applied[]> }) {
  const { run } = input;
  if (input.role !== 'research') registerRun({ name: input.name, role: input.role, work: input.work, subject: input.subject, run: run as Run<unknown> });
  watched.add(run as Run<unknown>);
  const settled = run.result().then(async result => {
    watched.delete(run as Run<unknown>);
    const applied = await applyOnce(run.directory, async () => {
      let entries: Applied[];
      try { entries = await input.apply(result); }
      catch (error) { entries = [{ subject: input.subject, outcome: 'refused', detail: failure(error) }]; }
      return runRecord(input.runner.name, run, result, input.startedAt, new Date().toISOString(), entries);
    });
    // Another watcher applied it: its record is the one kept.
    const record = applied ?? (run.directory ? readEndedRecord(run.directory) : null) ?? runRecord(input.runner.name, run, result, input.startedAt, new Date().toISOString(), []);
    endRun(input.name, record);
    return record;
  });
  return settled;
}

/**
 * How a role takes back a run after a restart: the options its output is judged by (the tool and
 * validation it was started with), how its result is applied, and what its owner does once it has
 * been. Null when the role no longer wants it (its subject settled some other way).
 */
export type RunAdopter = (owner: RunOwner) => Promise<{
  options: Pick<RunOptions<any>, 'tool' | 'validate' | 'timeoutMs'>;
  apply: (result: RunResult<any>) => Promise<Applied[]>;
  settled?: (record: RunRecord) => Promise<unknown> | unknown;
  /** The role's subject settled while the run was unwatched: the run is stopped with this reason, and applies nothing. */
  cancel?: string;
} | null>;
export interface AdoptedRun { name: string; role: RunRole; work: string; subject: string; directory: string; live: boolean; settled: Promise<RunRecord> }

/**
 * Adopt every run the registry on disk holds that has not been applied and that no watcher in this
 * process holds (GY-453): a restarted loop or executor keeps waiting on each live one and applies
 * its result when it ends. A run whose process is gone without a result resolves as `lost`, which
 * its role records and retries without spending an attempt. A role with no adopter is left alone.
 */
export async function adoptRuns(root: string, adopters: Partial<Record<RunRole, RunAdopter>>, options: { runner?: Runner; now?: number } = {}): Promise<AdoptedRun[]> {
  const runsRoot = runsDirectory(root), runner = options.runner ?? piRunner();
  if (!existsSync(runsRoot)) return [];
  pruneRunDirectories(runsRoot, options.now);
  const adopted: AdoptedRun[] = [];
  for (const { directory, owner, record } of listRunDirectories(runsRoot)) {
    if (record || !adopters[owner.role] || !runner.adopt) continue;
    if (owner.role !== 'research' && liveRun(owner.name)) continue;
    let plan: Awaited<ReturnType<RunAdopter>>;
    try { plan = await adopters[owner.role]!(owner); } catch { continue; }
    if (!plan) continue;
    const meta = readRunMeta(directory);
    const run = runner.adopt(directory, plan.options);
    const settled = superviseRun({ runner, run, name: owner.name, role: owner.role, work: owner.work, subject: owner.subject, startedAt: owner.startedAt, apply: plan.apply })
      .then(async ended => { await plan!.settled?.(ended); return ended; });
    if (plan.cancel) run.cancel(plan.cancel);
    adopted.push({ name: owner.name, role: owner.role, work: owner.work, subject: owner.subject, directory, live: !!meta && runAlive(meta), settled });
  }
  return adopted;
}
