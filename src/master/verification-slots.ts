// Concern: host verification slots — the per-host bound on concurrent full suites and type checks, and the PATH wrapper sessions run them through.
import { closeSync, fstatSync, openSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { ChildProcessError, inheritedVariables, runChild } from '../child-runner.js';
import { dataDirectory } from '../install/worktree-root.js';
import { randomUUID } from 'node:crypto';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The host heavy-job budget (GY-612, GY-3290).
 *
 * On 26 September 2026 a 62 GB host ran fourteen full suites and five `tsc --noEmit` runs at once;
 * on 13 November a 24-core host shared by several Graphyard projects sat at load 50–86 and local
 * verification timed out, because each project bounded only its own runs. Every Graphyard project
 * of one user on one host now shares one budget: a heavy job — a session's test, type-check or
 * build command, a host-run worker verification, a merge, gate or diagnostic trial, a preview build,
 * a deploy build — takes one slot first, and at most `limit` (two unless the host says otherwise)
 * run at once.
 *
 * A slot is a directory `slot-N` renamed (atomically) into the host's lock directory
 * (`hostHeavyJobsDirectory`, outside every repository), holding its owner's kernel-locked file. A
 * job that finds the budget spent waits, naming the holders and their projects, and starts when one
 * frees. A slot whose owner died is taken back by the next waiter; nothing is ever killed. The
 * limit is the whole number in the directory's `limit` file, read at every attempt: lowering it
 * leaves running jobs alone and admits no new one until fewer than the new limit run.
 *
 * The loop and the deploy watch join the budget at start (`joinHostHeavyBudget`); the session
 * harness puts the lock directory on every session's tab with a wrapper directory first on its
 * PATH (`tsc`, `npx`, `npm`, `pnpm`); this repository's own runner (tests/helpers/run-tests.ts)
 * takes the slot for its suite and type check. A run with no lock directory in its environment —
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
/** The host's limit: the whole number in `<directory>/limit`, else two. */
export function heavyJobLimit(directory: string) {
  try { const limit = Number(readFileSync(join(directory, 'limit'), 'utf8').trim()); return Number.isInteger(limit) && limit >= 1 ? limit : defaultHeavyJobs; }
  catch { return defaultHeavyJobs; }
}
/** Slot numbers from here up are declarations (a trial's shard files), never part of the limit. */
export const declarationSlot = 1000;
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
}

/**
 * GY-3304: the host's heavy-work drain — `master drain REASON` writes it beside the slots, `master resume`
 * removes it. While it stands no new heavy job starts on the host: merge trials, revert trials, the
 * batch gate, declared checks, host worker verification and sessions' own suites and type checks wait;
 * jobs already running finish, and claims, heartbeats and status go on. A file, so a restart keeps it.
 */
export interface HeavyDrain { reason: string; requestedBy: string; at: string }
export const heavyDrainFile = (directory: string) => join(directory, 'drain.json');
export function readHeavyDrain(directory: string): HeavyDrain | null {
  try { const drain = JSON.parse(readFileSync(heavyDrainFile(directory), 'utf8')); return typeof drain?.reason === 'string' ? drain : null; } catch { return null; }
}
export function requestHeavyDrain(directory: string, reason: string, requestedBy: string, now = new Date()): HeavyDrain {
  const drain: HeavyDrain = { reason: reason.slice(0, 500), requestedBy, at: now.toISOString() }, pending = `${heavyDrainFile(directory)}.${randomUUID()}`;
  mkdirSync(directory, { recursive: true });
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
export const heavyDrainLine = (drain: HeavyDrain) => `Heavy work is drained since ${drain.at} by ${drain.requestedBy}: ${drain.reason}. Running jobs finish; new merge trials, batch gates, declared checks, worker verification and session suites wait until graphyard master resume.`;

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

/** The heavy jobs running now: every live slot below the declarations, dead owners' reclaimed first. */
async function running(directory: string) {
  for (const entry of heldSlots(directory)) await reclaimStale(join(directory, `slot-${entry.slot}`));
  return heldSlots(directory).filter(entry => entry.slot < declarationSlot);
}

async function tryTake(directory: string, slots: number, owner: SlotOwner, firstSlot = 0): Promise<HeldSlot | null> {
  // The limit counts jobs, not slot numbers: a job admitted under a higher limit keeps running on its
  // number, and nothing new starts until fewer than the limit run.
  if (firstSlot < declarationSlot && (await running(directory)).length >= slots) return null;
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
/** The same wait as a merge trial's step, which the control plane bounds at 100 characters. */
export const waitStep = (directory: string) =>
  `waiting for a host heavy-job slot, held by ${heldSlots(directory).filter(entry => entry.slot < declarationSlot).map(holderText).join(', ')}`.slice(0, 100);

/** Take a slot, waiting as long as the budget is spent. */
export async function acquireVerificationSlot(options: AcquireOptions): Promise<HeldSlot> {
  const pollMs = options.pollMs ?? 1000;
  mkdirSync(options.directory, { recursive: true });
  const owner: SlotOwner = { identity, locked: true, files: options.files, pid: process.pid, label: options.label, ...(options.project ? { project: options.project } : {}), cwd: process.cwd(), at: new Date().toISOString() };
  let told = false, drained = false;
  for (;;) {
    if (options.signal?.aborted) throw options.signal.reason;
    const drain = options.drainable ? readHeavyDrain(options.directory) : null;
    if (drain) {
      if (!drained) { drained = true; options.onWait?.(`graphyard: ${options.label} waits: ${heavyDrainLine(drain)}`); }
      await new Promise(done => setTimeout(done, pollMs));
      continue;
    }
    const held = await tryTake(options.directory, options.slots ?? heavyJobLimit(options.directory), owner, options.firstSlot);
    if (held) {
      // Jobs that passed the count together and took different numbers are too many: each steps back and tries again.
      if (options.firstSlot !== undefined || (await running(options.directory)).length <= (options.slots ?? heavyJobLimit(options.directory))) return held;
      held.release();
    }
    if (!told) { told = true; options.onWait?.(waitLine(options)); }
    await new Promise(done => setTimeout(done, pollMs * (0.5 + Math.random())));
  }
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
export async function withHeavyJob<T>(label: string, job: () => Promise<T>, options: { onWait?: (line: string) => void; signal?: AbortSignal } = {}): Promise<T> {
  const directory = process.env[slotsDirectoryVariable];
  if (!directory || process.env[heldVariable] || inheritedVariables.getStore()?.[heldVariable]) return job();
  let held: HeldSlot;
  try { held = await acquireVerificationSlot({ directory, label, project: process.env[projectVariable], onWait: options.onWait ?? (line => process.stderr.write(`${line}\n`)), signal: options.signal, drainable: true }); }
  catch (error) { if (options.signal?.aborted) throw error; reportUnusable(label, directory, error); return job(); }
  try { return await inheritedVariables.run({ [heldVariable]: '1' }, job); } finally { held.release(); }
}

const heavyScript = /^(test|build|typecheck)\b/;
/**
 * Whether a command is a heavy job: a `tsc` type check (or one through `npx`), or a package
 * manager's test, build or type-check script. A checkout that carries Graphyard's own runner
 * (tests/helpers/run-tests.ts) is left to it: the runner takes the slot and sizes its breadth by it.
 */
export function heavyCommand(command: string, args: string[], cwd = process.cwd()) {
  const typecheck = (words: string[]) => !words.some(word => ['--watch', '-w', '--version', '-v', '--help', '-h', '--init'].includes(word));
  const at = args.findIndex(word => !word.startsWith('-'));
  if (command === 'tsc') return typecheck(args);
  if (command === 'npx') return at >= 0 && args[at] === 'tsc' && typecheck(args.slice(at + 1));
  if (command !== 'npm' && command !== 'pnpm' || at < 0) return false;
  const script = ['run', 'run-script'].includes(args[at]!) ? args.slice(at + 1).find(word => !word.startsWith('-')) : args[at] === 't' ? 'test' : args[at]!;
  if (!script || !heavyScript.test(script)) return false;
  return !existsSync(join(cwd, 'tests/helpers/run-tests.ts'));
}

/** PATH without the wrapper directory, so the wrapper runs the real command. */
export const pathWithout = (path: string | undefined, directory: string) => (path ?? '').split(delimiter).filter(entry => entry && resolve(entry) !== resolve(directory)).join(delimiter);
export function onPathOf(name: string, path: string) {
  for (const directory of path.split(delimiter)) if (directory && existsSync(join(directory, name))) return join(directory, name);
  return null;
}

/**
 * The wrapper directory a session's PATH starts with: `tsc`, `npx`, `npm` and `pnpm` scripts shipped
 * in this installation (bin/verification), each running bin/graphyard-verify.mjs with its command's name.
 * The lock directory is created at launch (sessionSlotsGrant) so a sandboxed runtime can be granted it.
 */
export const verificationBin = fileURLToPath(new URL('../../bin/verification', import.meta.url));

/** The variables a session's tab carries: the host's lock directory, its project, and PATH with the wrappers first. */
export function verificationEnvironment(project: string, environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { [slotsDirectoryVariable]: environment[slotsDirectoryVariable] ?? hostHeavyJobsDirectory(environment), [projectVariable]: project,
    PATH: [verificationBin, pathWithout(environment.PATH, verificationBin)].filter(Boolean).join(delimiter) };
}

/**
 * A session's tab environment: the harness's variables with the launch's own laid over them, except
 * that a launch which sets its own PATH keeps the wrappers first on it, so an account environment
 * never takes a session's `tsc` and `npx tsc` out of the bound.
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
  return { real: onPathOf(command, path), path, heavy: heavyCommand(command, args) };
}
