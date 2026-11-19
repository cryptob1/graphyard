// Concern: host verification slots — the per-host bound on concurrent full suites and type checks, and the PATH wrapper sessions run them through.
import { closeSync, fstatSync, openSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { ChildProcessError, inheritedVariables, runChild } from '../child-runner.js';
import { dataDirectory } from '../install/worktree-root.js';
import { randomUUID } from 'node:crypto';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpuCelsius, heatReading, heatWindowMs, trialHotCelsius } from '../merge-writer/trial-load.js';

/**
 * The host heavy-job budget (GY-612, GY-3290).
 *
 * On 26 September 2026 a 62 GB host ran fourteen full suites and five `tsc --noEmit` runs at once;
 * on 13 November a 24-core host shared by several Graphyard projects sat at load 50–86 and local
 * verification timed out, because each project bounded only its own runs. Every Graphyard project
 * of one user on one host now shares one budget: a heavy job — a merge, gate or diagnostic trial, a
 * session's whole suite, a preview build, a deploy build — takes one slot first, and at most `limit`
 * (two unless the host says otherwise) ordinary jobs run at once, plus one reserved
 * gate/deploy job shared across all installs. GY-3447: a session's own build, type check and
 * selected tests, and the host-run verification and checks of its head, take no slot — they ran
 * behind trials holding both slots for most of an hour — and stay bounded by the session's share of
 * the host's test parallelism (VITEST_MAX_WORKERS) and the trial load cap.
 *
 * A slot is a directory `slot-N` renamed (atomically) into the host's lock directory
 * (`hostHeavyJobsDirectory`, outside every repository), holding its owner's kernel-locked file. A
 * job that finds the budget spent queues (GY-3460), naming the holders and their projects, and starts when one
 * frees and every older waiter has started. A slot whose owner died is taken back by the next waiter; nothing is ever killed. The
 * limit is the whole number in the directory's `limit` file, read at every attempt: lowering it
 * leaves running jobs alone and admits no new one until fewer than the new limit run.
 *
 * The loop and the deploy watch join the budget at start (`joinHostHeavyBudget`); the session
 * harness puts the lock directory on every session's tab with a wrapper directory first on its
 * PATH (`npm`, `pnpm`); this repository's own runner (tests/helpers/run-tests.ts) takes the slot
 * for a whole suite. A run with no lock directory in its environment —
 * CI, a person's shell, a test inside the suite or a trial, which never see GRAPHYARD_* — is not
 * bounded. Work inside a job that holds a slot (`GRAPHYARD_VERIFICATION_SLOT_HELD` in a child,
 * the async context in this process) reuses it and takes none.
 */

export const slotsDirectoryVariable = 'GRAPHYARD_VERIFICATION_SLOTS_DIR', projectVariable = 'GRAPHYARD_HEAVY_JOB_PROJECT', heldVariable = 'GRAPHYARD_VERIFICATION_SLOT_HELD';
/** How many heavy jobs a host runs at once unless its `limit` file says otherwise. */
export const defaultHeavyJobs = 2;
/** The one lock directory every Graphyard project of this user shares: under the data directory, outside every repository. */
export const hostHeavyJobsDirectory = (environment: NodeJS.ProcessEnv = process.env) => resolve(dataDirectory(environment), 'heavy-jobs');
/** The lock directory this process uses: the one it joined (`joinHostHeavyBudget`), else the host's. */
export const heavyJobsDirectory = (environment: NodeJS.ProcessEnv = process.env) => environment[slotsDirectoryVariable] ?? hostHeavyJobsDirectory(environment);
/** The host's limit: the whole number in `<directory>/limit`, else two; a strict cap standing now lowers it (GY-3446). */
export const heavyJobLimit = (directory: string) => Math.min(ordinaryLimit(directory), readStrictCap(directory)?.limit ?? Infinity);
function ordinaryLimit(directory: string) {
  try { const limit = Number(readFileSync(join(directory, 'limit'), 'utf8').trim()); return Number.isInteger(limit) && limit >= 1 ? limit : defaultHeavyJobs; }
  catch { return defaultHeavyJobs; }
}
/** Slot numbers from here up are declarations (a trial's shard files), never part of the limit. */
export const declarationSlot = 1000;
/**
 * GY-3450: the deploy path's reserved slot, beside the limit. The batch gate's check and the deploy
 * build and restart of the commit it verified take it first and start at once however many item
 * trials and worker verifications fill the limit; no item job takes it.
 */
export const gateSlot = declarationSlot - 1;
/** The memory one running suite file is planned at: GY-1821 measured a full suite's swing on a 24-CPU host at about this much a file. */
export const bytesPerSuiteFile = 3 * 2 ** 28;

/** This process (the loop, the deploy watch) joins the host budget as `project`: everything heavy it runs from here on takes a slot. */
export function joinHostHeavyBudget(project: string, environment: NodeJS.ProcessEnv = process.env) {
  environment[slotsDirectoryVariable] ??= hostHeavyJobsDirectory(environment);
  environment[projectVariable] = project;
}

export interface SlotOwner { identity?: string; locked?: true; pid: number; label: string; project?: string; cwd: string; at: string; /** The in-flight suite files the holder declared (`declareSlotFiles`, GY-1821): what later runs deduct from the floor's budget. */ files?: number }
export interface HeldSlot { slot: number; path: string; release: () => void }
export interface AcquireOptions {
  directory: string; label: string; project?: string;
  /** The limit, for a caller that fixes it; absent, the host's `limit` file is read at every attempt. */
  slots?: number;
  /** Called once, when the budget is spent, with the line the run prints. */
  onWait?: (line: string) => void;
  /** Stops the wait: the job was cancelled before it started. */
  signal?: AbortSignal;
  pollMs?: number; firstSlot?: number; files?: number;
  /** GY-3304: wait while the host's heavy work is drained (`master drain`); a running trial's own declaration never waits. */
  drainable?: boolean;
  /** GY-3450: the deploy path (the batch gate's check, a deploy build or restart) — takes the reserved slot when it is free, else an ordinary one. */
  reserved?: boolean;
  /** GY-3446: the sensors a strict cap's heat wait reads. */
  hwmon?: string;
}

/**
 * GY-3304: the host's heavy-work drain — `master drain REASON` writes it beside the slots, `master resume`
 * removes it. GY-3445: it sits in its own `drain/` folder, which only the master session's confinement
 * leaves writable; every other session that takes slots reads it. While it stands no new heavy job starts on the host: merge trials, revert trials,
 * declared checks, host worker verification and sessions' whole suites wait;
 * jobs already running finish, and claims, heartbeats and status go on. GY-3450: the deploy path (batch gate, deploy build and restart) is never drained. A file, so a restart keeps it.
 */
export interface HeavyDrain { reason: string; requestedBy: string; at: string }
export const heavyDrainDirectory = (directory: string) => join(directory, 'drain');
export const heavyDrainFile = (directory: string) => join(heavyDrainDirectory(directory), 'drain.json');
export function readHeavyDrain(directory: string): HeavyDrain | null {
  try { const drain = JSON.parse(readFileSync(heavyDrainFile(directory), 'utf8')); return typeof drain?.reason === 'string' ? drain : null; } catch { return null; }
}
export function requestHeavyDrain(directory: string, reason: string, requestedBy: string, now = new Date()): HeavyDrain {
  const drain: HeavyDrain = { reason: reason.slice(0, 500), requestedBy, at: now.toISOString() }, pending = `${heavyDrainFile(directory)}.${randomUUID()}`;
  mkdirSync(heavyDrainDirectory(directory), { recursive: true });
  writeFileSync(pending, JSON.stringify(drain));
  renameSync(pending, heavyDrainFile(directory));
  return drain;
}
/** Remove the drain; answers the one it lifted, or null when none stood. */
export function resumeHeavyDrain(directory: string): HeavyDrain | null {
  const drain = readHeavyDrain(directory);
  rmSync(heavyDrainFile(directory), { force: true });
  return drain;
}
/**
 * GY-3446: a temporary host-wide strict cap, set with `master config hostHeavyJobs=N until=TIME` when
 * another project on the host asks every Graphyard install to back off. Until it expires the limit is
 * at most N for every install, the gate/deploy reservation counts inside it, a session's selected test
 * runs and host worker verification and checks take a slot too (GY-3447 exempts them otherwise), and
 * no new job starts while the CPU reads 85C or more. Running jobs are never stopped, and a job's own
 * nested work (a trial's serve and test containers) runs on its slot. Past `until` it is ignored.
 * It sits in the drain folder, which the master session may write.
 */
export interface StrictCap { limit: number; until: string; requestedBy: string; at: string }
export const strictCapFile = (directory: string) => join(heavyDrainDirectory(directory), 'strict-cap.json');
export function readStrictCap(directory: string, now = Date.now()): StrictCap | null {
  try {
    const cap = JSON.parse(readFileSync(strictCapFile(directory), 'utf8'));
    return Number.isInteger(cap?.limit) && cap.limit >= 1 && Date.parse(cap.until) > now ? cap : null;
  } catch { return null; }
}
/** Set (limit) or lift (null) the strict cap; refuses a limit above the host's ordinary one or an expiry already past. */
export function setStrictCap(directory: string, set: { value: number; until: string } | null, requestedBy: string, now = new Date()): StrictCap | null {
  if (set === null) { rmSync(strictCapFile(directory), { force: true }); return null; }
  const ordinary = ordinaryLimit(directory);
  if (!Number.isInteger(set.value) || set.value < 1 || set.value > ordinary) throw new Error(`hostHeavyJobs only tightens the host's heavy-job limit: give a whole number from 1 to ${ordinary}`);
  if (!(Date.parse(set.until) > now.getTime())) throw new Error('hostHeavyJobs is temporary: give until=TIME, a future ISO time such as 2026-11-18T16:00:00Z');
  const cap: StrictCap = { limit: set.value, until: new Date(Date.parse(set.until)).toISOString(), requestedBy, at: now.toISOString() }, pending = `${strictCapFile(directory)}.${randomUUID()}`;
  mkdirSync(heavyDrainDirectory(directory), { recursive: true });
  writeFileSync(pending, JSON.stringify(cap));
  renameSync(pending, strictCapFile(directory));
  return cap;
}

export const heavyDrainLine = (drain: HeavyDrain) => `Heavy work is drained since ${drain.at} by ${drain.requestedBy}: ${drain.reason}. Running jobs finish and batch gates and deploys go on; new merge trials, declared checks, worker verification and session suites wait until graphyard master resume.`;

// flock locks the inherited open file description; this process retains its fd after
// the short-lived utility exits. The kernel releases it on death, across PID namespaces.
const identity = randomUUID();
async function lock(fd: number): Promise<boolean> {
  try {
    await runChild('flock', ['--exclusive', '--nonblock', '3'], { extraFds: [fd] });
    return true;
  } catch (error) {
    if (error instanceof ChildProcessError && error.status === 1 && !error.timedOut) return false;
    throw error;
  }
}
const readOwner = (path: string): SlotOwner | null => {
  let owner: SlotOwner;
  try { owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')); } catch { return null; }
  try {
    const files = JSON.parse(readFileSync(join(path, 'files.json'), 'utf8'));
    if (Number.isInteger(files) && files >= 1) return { ...owner, files };
  } catch { /* an absent or interrupted declaration leaves the initial budget intact */ }
  return owner;
};

/** The slots held now, with their owners. */
export function heldSlots(directory: string): { slot: number; owner: SlotOwner | null }[] {
  let names: string[] = [];
  try { names = readdirSync(directory); } catch { return []; }
  return names.map(name => /^slot-(\d+)$/.exec(name)).filter((match): match is RegExpExecArray => !!match)
    .map(match => ({ slot: Number(match[1]), owner: readOwner(join(directory, match[0])) })).sort((a, b) => a.slot - b.slot);
}

/**
 * Record on the holder's own slot how many suite files it runs at once (GY-1821): a run that starts
 * later takes only what the host's memory floor affords beyond what these runs declared. Best-effort —
 * a declaration that cannot be written leaves the previous declaration or initial budget intact.
 */
export function declareSlotFiles(held: HeldSlot, files: number, pid: number = process.pid): void {
  if (!(files >= 1)) return;
  try {
    const owner = readOwner(held.path);
    if (!owner || owner.identity !== identity || owner.pid !== pid) return;
    // Never replace or truncate the locked inode or its ownership evidence.
    const pending = join(held.path, 'files.json.next');
    writeFileSync(pending, JSON.stringify(Math.floor(files)));
    renameSync(pending, join(held.path, 'files.json'));
  } catch { /* the slot still holds the run; only the budget sharing is lost */ }
}

/** Reap dead reservations before budgeting, including trial declarations beyond the slot bound. */
export async function othersDeclaredFiles(directory: string, pid: number = process.pid): Promise<number> {
  for (const entry of heldSlots(directory)) await reclaimStale(join(directory, `slot-${entry.slot}`));
  return heldSlots(directory).reduce((sum, entry) => entry.owner && !(entry.owner.identity === identity && entry.owner.pid === pid)
    ? sum + Math.max(0, entry.owner.files ?? 0) : sum, 0);
}

/** Take the owner's kernel lock before removing its reservation; another reaper cannot take it. */
async function reclaimStale(path: string) {
  let fd: number;
  try { fd = openSync(join(path, 'owner.json'), 'r+'); }
  catch { return false; }
  try {
    if (!await lock(fd)) return false;
    const opened = fstatSync(fd), current = statSync(join(path, 'owner.json'), { throwIfNoEntry: false });
    if (!current || opened.ino !== current.ino || opened.dev !== current.dev) return false;
    let owner: SlotOwner | null;
    try { owner = JSON.parse(readFileSync(fd, 'utf8')); } catch { return false; }
    // Old PID-only records cannot safely be judged from another namespace. Keep
    // them: there is no kernel ownership evidence to distinguish live from stale.
    if (!owner?.locked) return false;
    const tomb = `${path}.stale-${randomUUID()}`;
    try { renameSync(path, tomb); } catch { return false; }
    rmSync(tomb, { recursive: true, force: true });
    return true;
  } finally { closeSync(fd); }
}

/** The heavy jobs the limit counts now: every live slot below the gate's and the declarations, dead owners' reclaimed first. */
async function running(directory: string) {
  for (const entry of heldSlots(directory)) await reclaimStale(join(directory, `slot-${entry.slot}`));
  // GY-3446: under a strict cap the gate/deploy reservation counts inside the limit.
  return heldSlots(directory).filter(entry => entry.slot < (readStrictCap(directory) ? declarationSlot : gateSlot));
}

async function tryTake(directory: string, slots: number, owner: SlotOwner, firstSlot = 0): Promise<HeldSlot | null> {
  // The limit counts jobs, not slot numbers: a job admitted under a higher limit keeps running on its
  // number, and nothing new starts until fewer than the limit run.
  if (firstSlot < gateSlot && (await running(directory)).length >= slots) return null;
  for (let slot = firstSlot; slot < firstSlot + slots; slot++) {
    const path = join(directory, `slot-${slot}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      // The slot appears with its owner already in it (renamed into place), so a waiter always names who holds it.
      const taking = join(directory, `.taking-${slot}-${randomUUID()}`);
      mkdirSync(taking);
      const fd = openSync(join(taking, 'owner.json'), 'wx+');
      try {
        if (!await lock(fd)) throw new Error('new verification owner file is locked');
        writeFileSync(fd, JSON.stringify(owner));
        renameSync(taking, path);
        let released = false;
        // Renamed away before it is removed: removing in place empties the slot first, and a waiter's
        // rename onto that empty directory would take it while the remove then fails or deletes its owner.
        return { slot, path, release: () => {
          if (released) return;
          released = true;
          const freed = `${path}.freed-${owner.pid}-${Date.now()}`;
          try {
            renameSync(path, freed);
            rmSync(freed, { recursive: true, force: true });
          } catch { /* already removed */ } finally { closeSync(fd); }
        } };
      } catch (error) {
        closeSync(fd);
        rmSync(taking, { recursive: true, force: true });
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        if (!await reclaimStale(path)) break;
      }
    }
  }
  return null;
}

const holderText = (entry: { slot: number; owner: SlotOwner | null }) => entry.owner ? `${entry.owner.label}${entry.owner.project ? ` (${entry.owner.project})` : ''}` : `slot-${entry.slot}`;
/** The line a waiting job prints: the shared capacity it waits for, and the jobs and projects that hold it. */
export function waitLine(options: Pick<AcquireOptions, 'directory' | 'slots' | 'label'>) {
  const holders = heldSlots(options.directory).filter(entry => entry.slot < declarationSlot)
    .map(entry => `${holderText(entry)}${entry.owner ? ` [pid ${entry.owner.pid}, ${entry.owner.cwd}]` : ''}`);
  return `graphyard: ${options.label} waits for a host heavy-job slot: every Graphyard project on this host shares ${options.slots ?? heavyJobLimit(options.directory)} at once`
    + `${holders.length ? `, held by ${holders.join('; ')}` : ''}. It starts when one frees (${join(options.directory, 'limit')} sets the limit).`;
}
/** GY-3396: a test merge's heavy job, by its item key (or the batch gate's), in the words the Work page shows. */
export const testMergeLabel = (key: string) => `test merge ${key}`;
/** The same wait as a test merge's step, which the control plane bounds at 100 characters. */
export const waitStep = (directory: string) =>
  `waiting for a host heavy-job slot, held by ${heldSlots(directory).filter(entry => entry.slot < declarationSlot).map(holderText).join(', ')}`.slice(0, 100);

/**
 * GY-3460: the host's queue of jobs waiting for an ordinary slot, shared by every install. Each waiter
 * holds a kernel-locked ticket in `queue/`, named so that the deploy path sorts first and then the
 * oldest request; each ticket holds its project. A freed slot goes to the oldest waiter whose project
 * holds none (GY-3487), else to the oldest: a job that arrives later never overtakes an older one of
 * the same standing, so one install's stream of new trials cannot starve another's. A ticket whose
 * owner died is unlocked and removed by the next waiter that reads it.
 */
const queueDirectory = (directory: string) => join(directory, 'queue');
async function enqueue(directory: string, options: AcquireOptions) {
  const name = `${options.reserved ? 0 : 1}-${String(Date.now()).padStart(15, '0')}-${randomUUID()}${options.drainable ? '-drainable' : ''}`;
  const pending = join(directory, `.ticket-${name}`), path = join(queueDirectory(directory), name);
  mkdirSync(queueDirectory(directory), { recursive: true });
  const fd = openSync(pending, 'wx');
  try {
    if (!await lock(fd)) throw new Error('new heavy-job ticket is locked');
    writeFileSync(fd, options.project ?? '');
    renameSync(pending, path);
  } catch (error) { closeSync(fd); rmSync(pending, { force: true }); throw error; }
  return { name, leave: () => { rmSync(path, { force: true }); closeSync(fd); } };
}
/** The live waiters in queue order, with their projects; a drained job does not hold up others while the drain stands. */
async function liveWaiters(directory: string, drained: boolean) {
  const waiters: { name: string; project: string }[] = [];
  for (const name of readdirSync(queueDirectory(directory)).sort()) {
    if (drained && name.endsWith('-drainable')) continue;
    const path = join(queueDirectory(directory), name);
    let fd: number;
    try { fd = openSync(path, 'r'); } catch { continue; }
    try { if (await lock(fd)) rmSync(path, { force: true }); else waiters.push({ name, project: readFileSync(fd, 'utf8') }); } finally { closeSync(fd); }
  }
  return waiters;
}
/** The projects queued now, oldest first, read without locking: only for the line a waiting job prints. */
function queuedProjects(directory: string) {
  return readdirSync(queueDirectory(directory)).sort().flatMap(name => { try { return [readFileSync(join(queueDirectory(directory), name), 'utf8')]; } catch { return []; } });
}
/**
 * GY-3487: who the `free` slots go to. Each goes to the oldest waiter whose project holds none, else to
 * the oldest waiter: a project that holds a slot never takes another while a project holding none
 * waits. With one project waiting this is plain arrival order.
 */
function admitted(waiters: { name: string; project: string }[], holders: string[], free: number) {
  const holding = new Map<string, number>();
  for (const project of holders) holding.set(project, (holding.get(project) ?? 0) + 1);
  const queue = [...waiters], chosen: string[] = [];
  for (let slot = 0; slot < free && queue.length; slot++) {
    const index = Math.max(0, queue.findIndex(waiter => !holding.get(waiter.project)));
    const [next] = queue.splice(index, 1);
    chosen.push(next.name);
    holding.set(next.project, (holding.get(next.project) ?? 0) + 1);
  }
  return chosen;
}

/** Take a slot, waiting as long as the budget is spent and behind every older waiter. */
export async function acquireVerificationSlot(options: AcquireOptions): Promise<HeldSlot> {
  const pollMs = options.pollMs ?? 1000;
  mkdirSync(options.directory, { recursive: true });
  const owner: SlotOwner = { identity, locked: true, files: options.files, pid: process.pid, label: options.label, ...(options.project ? { project: options.project } : {}), cwd: process.cwd(), at: new Date().toISOString() };
  // A declaration beyond the bound (a running trial's shard files) or a caller fixing its own numbers does not queue.
  const ticket = options.firstSlot === undefined ? await enqueue(options.directory, options) : null;
  let told = false, drained = false, heated = false, blocked = false;
  const samples: [number, number][] = [];
  try {
    for (;;) {
      if (options.signal?.aborted) throw options.signal.reason;
      const drain = options.drainable ? readHeavyDrain(options.directory) : null;
      if (drain) {
        if (!drained) { drained = true; options.onWait?.(`graphyard: ${options.label} waits: ${heavyDrainLine(drain)}`); }
        await new Promise(done => setTimeout(done, pollMs));
        continue;
      }
      // GY-3446: under a strict cap no new job starts at the launch heat limit, and the reservation is not beside the limit.
      // GY-3532: it compares the 120 s mean of this wait's own samples, the latest until it holds 4.
      const strict = readStrictCap(options.directory), sample = strict ? await cpuCelsius(options.hwmon) : null, at = Date.now();
      if (sample !== null) { while (samples.length && at - samples[0]![0] >= heatWindowMs) samples.shift(); samples.push([at, sample]); }
      const heat = sample === null ? null : heatReading(samples);
      if (heat && heat.celsius >= trialHotCelsius) {
        if (!heated) { heated = true; options.onWait?.(`graphyard: ${options.label} waits: the host's strict heavy-job cap (until ${strict!.until}) starts nothing while the CPU ${heat.mean === null ? 'reads' : 'averages'} ${heat.celsius}C, ${trialHotCelsius}C or more`); }
        await new Promise(done => setTimeout(done, pollMs));
        continue;
      }
      const reserved = options.reserved && !strict ? await tryTake(options.directory, 1, owner, gateSlot) : null;
      if (reserved) return reserved;
      const limit = options.slots ?? heavyJobLimit(options.directory);
      const holders = await running(options.directory), free = limit - holders.length;
      const waiters = free > 0 && ticket ? await liveWaiters(options.directory, !!readHeavyDrain(options.directory)) : [];
      const project = options.project ?? '', holderProjects = holders.map(entry => entry.owner?.project ?? '');
      if (ticket && !blocked && holderProjects.includes(project)) {
        const next = queuedProjects(options.directory).find(other => other !== project && !holderProjects.includes(other));
        if (next !== undefined) { blocked = true; options.onWait?.(`graphyard: ${options.label} waiting: ${next} holds none and is next`); }
      }
      if (free > 0 && (!ticket || admitted(waiters, holderProjects, free).includes(ticket.name))) {
        const held = await tryTake(options.directory, limit, owner, options.firstSlot);
        if (held) {
          // Jobs that passed the count together and took different numbers are too many: each steps back and tries again.
          if (options.firstSlot !== undefined || (await running(options.directory)).length <= limit) return held;
          held.release();
        }
      }
      if (!told) { told = true; options.onWait?.(waitLine(options)); }
      await new Promise(done => setTimeout(done, pollMs * (0.5 + Math.random())));
    }
  } finally { ticket?.leave(); }
}

const reportUnusable = (label: string, directory: string, error: unknown) =>
  process.stderr.write(`graphyard: ${label} runs outside the host heavy-job budget: ${directory} cannot be used (${error instanceof Error ? error.message : String(error)})\n`);

/**
 * Take a slot for `label` when this process runs in a Graphyard session and holds none yet, or
 * null. The returned slot is released on exit too. A lock directory that cannot be written (a
 * sandbox that does not grant it) is reported and the run goes ahead unbounded rather than failing.
 */
export async function sessionVerificationSlot(label: string, environment: NodeJS.ProcessEnv = process.env, log: (line: string) => void = line => process.stderr.write(`${line}\n`)): Promise<HeldSlot | null> {
  const directory = environment[slotsDirectoryVariable];
  if (!directory || environment[heldVariable]) return null;
  let held: HeldSlot;
  try { held = await acquireVerificationSlot({ directory, label, project: environment[projectVariable], onWait: log, drainable: true }); }
  catch (error) { reportUnusable(label, directory, error); return null; }
  process.once('exit', held.release);
  return held;
}

/** What a detached child of a job that holds a slot carries: the lock directory (its declarations go there) and the mark that it takes no slot of its own. */
export const heldJobEnvironment = (): Record<string, string> =>
  process.env[slotsDirectoryVariable] ? { [slotsDirectoryVariable]: process.env[slotsDirectoryVariable]!, [heldVariable]: '1' } : {};

/**
 * Run one heavy job of this process (a trial, a host-run verification, a preview or deploy build)
 * inside the host budget: wait for a slot, run, and free it however the job ends. Its children
 * carry the slot (`heldVariable`), and a heavy job started inside it runs at once on the same
 * slot. A process that never joined the budget runs the job as it always did.
 */
export async function withHeavyJob<T>(label: string, job: () => Promise<T>, options: { onWait?: (line: string) => void; signal?: AbortSignal; until?: AbortSignal; reserved?: boolean; /** GY-3446: a job that takes a slot only under a strict cap. */ strictOnly?: boolean } = {}): Promise<T> {
  const directory = process.env[slotsDirectoryVariable];
  if (!directory || process.env[heldVariable] || inheritedVariables.getStore()?.[heldVariable] || options.strictOnly && !readStrictCap(directory)) return job();
  let held: HeldSlot;
  try { held = await acquireVerificationSlot({ directory, label, project: process.env[projectVariable], onWait: options.onWait ?? (line => process.stderr.write(`${line}\n`)), signal: options.signal, drainable: !options.reserved, reserved: options.reserved }); }
  catch (error) { if (options.signal?.aborted) throw error; reportUnusable(label, directory, error); return job(); }
  // GY-3449: a cancelled job (`signal`), or one whose owner's run ended (`until`: a gate run that
  // verified, timed out, held or stopped for a restart), gives its slot back at once, even while a
  // step that cannot be cancelled — an image build, an adoption — is still settling.
  const ended = AbortSignal.any([options.signal, options.until].filter((signal): signal is AbortSignal => !!signal));
  if (ended.aborted) held.release(); else ended.addEventListener('abort', held.release, { once: true });
  try { return await inheritedVariables.run({ [heldVariable]: '1' }, job); } finally { ended.removeEventListener('abort', held.release); held.release(); }
}

/**
 * GY-3526: one heavy job made of parts that run now and then, several at once — a worker check's
 * shards on this machine. One slot covers every part running: the first to start takes it, the
 * last to end gives it back, and while no part runs on this machine the job holds none.
 */
export function sharedHeavyJob(label: string, options: Parameters<typeof withHeavyJob>[2] = {}) {
  type Held = { release: () => void; inherited?: Record<string, string> };
  let parts = 0, slot: Promise<Held> | null = null;
  return async <T>(part: () => Promise<T>): Promise<T> => {
    parts++;
    try {
      // A part's children carry the slot's mark as a whole held job's do, so a suite inside takes no second slot.
      const { inherited } = await (slot ??= new Promise<Held>((taken, failed) => { withHeavyJob(label, () => new Promise<void>(release => taken({ release, inherited: inheritedVariables.getStore() })), options).catch(failed); }));
      return await (inherited ? inheritedVariables.run(inherited, part) : part());
    } finally {
      if (--parts === 0 && slot) { const held = slot; slot = null; (await held.catch(() => null))?.release(); }
    }
  };
}

/**
 * Whether a command is a heavy job: a package manager's whole `test` script, no files or arguments
 * selecting part of it (GY-3447: builds, type checks and selected tests run at once; any test script under a strict cap). A checkout that
 * carries Graphyard's own runner (tests/helpers/run-tests.ts) is left to it: the runner takes the slot.
 */
export function heavyCommand(command: string, args: string[], cwd = process.cwd(), strict = false) {
  if (command !== 'npm' && command !== 'pnpm') return false;
  const words = args.filter(word => !word.startsWith('-')), script = ['run', 'run-script'].includes(words[0]!) ? words.slice(1) : words;
  // GY-3446: under a strict cap every test script, selected files included, is a heavy job.
  if (strict ? !/^(t|test)(:|$)/.test(script[0] ?? '') : !['test', 't'].includes(script[0]!) || script.length > 1) return false;
  return !existsSync(join(cwd, 'tests/helpers/run-tests.ts'));
}

/** PATH without the wrapper directory, so the wrapper runs the real command. */
export const pathWithout = (path: string | undefined, directory: string) => (path ?? '').split(delimiter).filter(entry => entry && resolve(entry) !== resolve(directory)).join(delimiter);
export function onPathOf(name: string, path: string) {
  for (const directory of path.split(delimiter)) if (directory && existsSync(join(directory, name))) return join(directory, name);
  return null;
}

/**
 * The wrapper directory a session's PATH starts with: `npm` and `pnpm` scripts shipped
 * in this installation (bin/verification), each running bin/graphyard-verify.mjs with its command's name.
 * The lock directory is created at launch (sessionSlotsGrant) so a sandboxed runtime can be granted it.
 */
export const verificationBin = fileURLToPath(new URL('../../bin/verification', import.meta.url));

/** The heavy jobs holding the host's slots now, for master status: what runs, for which project, since when. */
export const slotHolders = (directory: string) => heldSlots(directory).filter(entry => entry.slot < declarationSlot)
  .map(entry => entry.owner ? { label: entry.owner.label, project: entry.owner.project ?? null, pid: entry.owner.pid, since: entry.owner.at } : { label: `slot-${entry.slot}`, project: null, pid: null, since: null });

/** The variables a session's tab carries: the host's lock directory, its project, and PATH with the wrappers first. */
export function verificationEnvironment(project: string, environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { [slotsDirectoryVariable]: environment[slotsDirectoryVariable] ?? hostHeavyJobsDirectory(environment), [projectVariable]: project,
    PATH: [verificationBin, pathWithout(environment.PATH, verificationBin)].filter(Boolean).join(delimiter) };
}

/**
 * A session's tab environment: the harness's variables with the launch's own laid over them, except
 * that a launch which sets its own PATH keeps the wrappers first on it, so an account environment
 * never takes a session's whole suite out of the bound.
 */
export function withVerificationPath(harness: Record<string, string>, launch: Record<string, string>): Record<string, string> {
  const merged = { ...harness, ...launch };
  if (harness[slotsDirectoryVariable] && launch.PATH !== undefined) merged.PATH = [verificationBin, pathWithout(launch.PATH, verificationBin)].filter(Boolean).join(delimiter);
  return merged;
}

/**
 * The wrapper's plan for one command: the real executable (PATH without the wrappers), the PATH its
 * child runs with, and whether it is a heavy job that takes a slot. bin/graphyard-verify.mjs
 * spawns it; children go through src/child-runner.ts everywhere else.
 */
export function wrappedCommand(command: string, args: string[], environment: NodeJS.ProcessEnv = process.env) {
  const path = pathWithout(environment.PATH, verificationBin);
  const directory = environment[slotsDirectoryVariable];
  return { real: onPathOf(command, path), path, heavy: heavyCommand(command, args, process.cwd(), !!directory && !!readStrictCap(directory)) };
}
