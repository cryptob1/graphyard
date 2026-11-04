// Concern: host verification slots — the per-host bound on concurrent full suites and type checks, and the PATH wrapper sessions run them through.
import { closeSync, fstatSync, openSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { totalmem } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Host verification slots (GY-612).
 *
 * On 26 September 2026 a 62 GB host ran fourteen full suites and five `tsc --noEmit` runs at once,
 * across worker worktrees and proof checkouts: each suite starts its own Postgres, each run holds up
 * to a gigabyte, and available memory fell to one or two gigabytes while agent runtimes were reaped.
 * Nothing bounded how many heavy verification runs a host executes at once.
 *
 * A heavy run — `npm test`, `npm run test:browser`, `npm run typecheck` and `tsc --noEmit`, directly
 * or through `npx` — started by a Graphyard session takes one slot of a host-wide semaphore first:
 * a directory `slot-N` renamed (atomically) into the lock directory, holding its owner's locked file. A run
 * that finds every slot held waits, saying so and naming the directory and the holders, and takes
 * the first slot that frees. A slot whose owner died is taken back by the next waiter.
 *
 * The session harness puts the lock directory and the bound on every session's tab
 * (`GRAPHYARD_VERIFICATION_SLOTS_DIR`, `GRAPHYARD_VERIFICATION_SLOTS`) with a wrapper directory first
 * on its PATH (`tsc`, `npx`); the suite's own runner (tests/helpers/run-tests.ts) takes the slot for
 * `npm test`, `npm run test:browser` and `npm run typecheck`. A run with no lock directory in its
 * environment — CI, a person's shell, a test inside the suite, which never sees GRAPHYARD_* — is not
 * bounded. A run inside one that holds a slot (`GRAPHYARD_VERIFICATION_SLOT_HELD`) takes none.
 */

export const slotsDirectoryVariable = 'GRAPHYARD_VERIFICATION_SLOTS_DIR', slotsVariable = 'GRAPHYARD_VERIFICATION_SLOTS', heldVariable = 'GRAPHYARD_VERIFICATION_SLOT_HELD';
/** One slot per this many gigabytes of memory, and never fewer than two. */
export const gigabytesPerSlot = 8, minimumSlots = 2;
/** The directory under the managed worktree root that holds the slots. */
export const verificationSlotsDirectory = (managedRoot: string) => resolve(managedRoot, '.verification-slots');
/** The memory one running suite file is planned at: GY-1821 measured a full suite's swing on a 24-CPU host at about this much a file. */
export const bytesPerSuiteFile = 3 * 2 ** 28;

/** max(2, floor(total memory GB / 8)); `GRAPHYARD_VERIFICATION_SLOTS` on the host overrides it. */
export function defaultVerificationSlots(totalBytes = totalmem()) {
  return Math.max(minimumSlots, Math.floor(totalBytes / 2 ** 30 / gigabytesPerSlot));
}
export function configuredVerificationSlots(environment: NodeJS.ProcessEnv = process.env, totalBytes = totalmem()) {
  const configured = Number(environment[slotsVariable]);
  return Number.isInteger(configured) && configured >= 1 ? configured : defaultVerificationSlots(totalBytes);
}

export interface SlotOwner { identity?: string; locked?: true; pid: number; label: string; cwd: string; at: string; /** The in-flight suite files the holder declared (`declareSlotFiles`, GY-1821): what later runs deduct from the floor's budget. */ files?: number }
export interface HeldSlot { slot: number; path: string; release: () => void }
export interface AcquireOptions {
  directory: string; slots: number; label: string;
  /** Called once, when every slot is held, with the line the run prints. */
  onWait?: (line: string) => void;
  pollMs?: number; firstSlot?: number; files?: number;
}

// flock locks the inherited open file description; this process retains its fd after
// the short-lived utility exits. The kernel releases it on death, across PID namespaces.
const identity = randomUUID();
function lock(fd: number): boolean {
  const result = spawnSync('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd] });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw result.error ?? new Error(`verification owner lock: ${result.stderr?.toString()}`);
}
const readOwner = (path: string): SlotOwner | null => { try { return JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')); } catch { return null; } };

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
 * a declaration that cannot be written leaves the slot as it was, and the next run plans on nothing.
 */
export function declareSlotFiles(held: HeldSlot, files: number, pid: number = process.pid): void {
  if (!(files >= 1)) return;
  try {
    const owner = readOwner(held.path);
    if (!owner || owner.identity !== identity || owner.pid !== pid) return;
    writeFileSync(join(held.path, 'owner.json'), JSON.stringify({ ...owner, files: Math.floor(files) }));
  } catch { /* the slot still holds the run; only the budget sharing is lost */ }
}

/** Reap dead reservations before budgeting, including trial declarations beyond the slot bound. */
export function othersDeclaredFiles(directory: string, pid: number = process.pid): number {
  for (const entry of heldSlots(directory)) reclaimStale(join(directory, `slot-${entry.slot}`));
  return heldSlots(directory).reduce((sum, entry) => entry.owner && !(entry.owner.identity === identity && entry.owner.pid === pid)
    ? sum + Math.max(0, entry.owner.files ?? 0) : sum, 0);
}

/** Take the owner's kernel lock before removing its reservation; another reaper cannot take it. */
function reclaimStale(path: string) {
  let fd: number;
  try { fd = openSync(join(path, 'owner.json'), 'r+'); }
  catch { return false; }
  try {
    if (!lock(fd)) return false;
    const opened = fstatSync(fd), current = statSync(join(path, 'owner.json'), { throwIfNoEntry: false });
    if (!current || opened.ino !== current.ino || opened.dev !== current.dev) return false;
    const owner = JSON.parse(readFileSync(fd, 'utf8')) as SlotOwner;
    // Old PID-only records cannot safely be judged from another namespace. Keep
    // them: there is no kernel ownership evidence to distinguish live from stale.
    if (!owner.locked) return false;
    const tomb = `${path}.stale-${randomUUID()}`;
    try { renameSync(path, tomb); } catch { return false; }
    rmSync(tomb, { recursive: true, force: true });
    return true;
  } finally { closeSync(fd); }
}

function tryTake(directory: string, slots: number, owner: SlotOwner, firstSlot = 0): HeldSlot | null {
  for (let slot = firstSlot; slot < firstSlot + slots; slot++) {
    const path = join(directory, `slot-${slot}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      // The slot appears with its owner already in it (renamed into place), so a waiter always names who holds it.
      const taking = join(directory, `.taking-${slot}-${randomUUID()}`);
      mkdirSync(taking);
      const fd = openSync(join(taking, 'owner.json'), 'wx+');
      try {
        if (!lock(fd)) throw new Error('new verification owner file is locked');
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
        if (!reclaimStale(path)) break;
      }
    }
  }
  return null;
}

/** The line a waiting run prints: what it waits for, on what, and who holds the slots. */
export function waitLine(options: Pick<AcquireOptions, 'directory' | 'slots' | 'label'>) {
  const holders = heldSlots(options.directory).map(entry => entry.owner ? `${entry.owner.label} (pid ${entry.owner.pid}, ${entry.owner.cwd})` : `slot-${entry.slot}`);
  return `graphyard: ${options.label} waits for a host verification slot: all ${options.slots} under ${options.directory} are held${holders.length ? ` by ${holders.join('; ')}` : ''}. It starts when one frees (${slotsVariable} sets the bound on this host).`;
}

/** Take a slot, waiting as long as every one is held. */
export async function acquireVerificationSlot(options: AcquireOptions): Promise<HeldSlot> {
  const pollMs = options.pollMs ?? 1000;
  mkdirSync(options.directory, { recursive: true });
  const owner: SlotOwner = { identity, locked: true, files: options.files, pid: process.pid, label: options.label, cwd: process.cwd(), at: new Date().toISOString() };
  let told = false;
  for (;;) {
    const held = tryTake(options.directory, options.slots, owner, options.firstSlot);
    if (held) {
      if (told) options.onWait?.(`graphyard: ${options.label} took host verification slot ${held.slot}`);
      return held;
    }
    if (!told) { told = true; options.onWait?.(waitLine(options)); }
    await new Promise(done => setTimeout(done, pollMs));
  }
}

/**
 * Take a slot for `label` when this process runs in a Graphyard session and holds none yet, or
 * null. The returned slot is released on exit too. A lock directory that cannot be written (a
 * sandbox that does not grant it) is reported and the run goes ahead unbounded rather than failing.
 */
export async function sessionVerificationSlot(label: string, environment: NodeJS.ProcessEnv = process.env, log: (line: string) => void = line => process.stderr.write(`${line}\n`)): Promise<HeldSlot | null> {
  const directory = environment[slotsDirectoryVariable];
  if (!directory || environment[heldVariable]) return null;
  let held: HeldSlot;
  try { held = await acquireVerificationSlot({ directory, slots: configuredVerificationSlots(environment), label, onWait: log }); }
  catch (error) { log(`graphyard: ${label} runs without a host verification slot: ${directory} cannot be used (${error instanceof Error ? error.message : String(error)})`); return null; }
  process.once('exit', held.release);
  return held;
}

/** Whether a command is a heavy verification run: a `tsc` type check, or one through `npx`. */
export function heavyCommand(command: string, args: string[]) {
  const typecheck = (words: string[]) => !words.some(word => ['--watch', '-w', '--version', '-v', '--help', '-h', '--init'].includes(word));
  if (command === 'tsc') return typecheck(args);
  if (command === 'npx') { const at = args.findIndex(word => !word.startsWith('-')); return at >= 0 && args[at] === 'tsc' && typecheck(args.slice(at + 1)); }
  return false;
}

/** PATH without the wrapper directory, so the wrapper runs the real command. */
export const pathWithout = (path: string | undefined, directory: string) => (path ?? '').split(delimiter).filter(entry => entry && resolve(entry) !== resolve(directory)).join(delimiter);
export function onPathOf(name: string, path: string) {
  for (const directory of path.split(delimiter)) if (directory && existsSync(join(directory, name))) return join(directory, name);
  return null;
}

/**
 * The wrapper directory a session's PATH starts with: `tsc` and `npx` scripts shipped in this
 * installation (bin/verification), each running bin/graphyard-verify.mjs with its command's name.
 * The lock directory is created at launch (sessionSlotsGrant) so a sandboxed runtime can be granted it.
 */
export const verificationBin = fileURLToPath(new URL('../../bin/verification', import.meta.url));

/** The variables a session's tab carries: the lock directory, the bound, and PATH with the wrappers first. */
export function verificationEnvironment(managedRoot: string, environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { [slotsDirectoryVariable]: verificationSlotsDirectory(managedRoot), [slotsVariable]: String(configuredVerificationSlots(environment)),
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
 * child runs with, and whether it is a heavy verification run that takes a slot. bin/graphyard-verify.mjs
 * spawns it; children go through src/child-runner.ts everywhere else.
 */
export function wrappedCommand(command: string, args: string[], environment: NodeJS.ProcessEnv = process.env) {
  const path = pathWithout(environment.PATH, verificationBin);
  return { real: onPathOf(command, path), path, heavy: heavyCommand(command, args) };
}
