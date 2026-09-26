// Concern: host verification slots — the per-host bound on concurrent full suites and type checks, and the PATH wrapper sessions run them through.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
 * a directory `slot-N` created (atomically) under the lock directory, holding its owner's pid. A run
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

/** max(2, floor(total memory GB / 8)); `GRAPHYARD_VERIFICATION_SLOTS` on the host overrides it. */
export function defaultVerificationSlots(totalBytes = totalmem()) {
  return Math.max(minimumSlots, Math.floor(totalBytes / 2 ** 30 / gigabytesPerSlot));
}
export function configuredVerificationSlots(environment: NodeJS.ProcessEnv = process.env, totalBytes = totalmem()) {
  const configured = Number(environment[slotsVariable]);
  return Number.isInteger(configured) && configured >= 1 ? configured : defaultVerificationSlots(totalBytes);
}

export interface SlotOwner { pid: number; label: string; cwd: string; at: string }
export interface HeldSlot { slot: number; path: string; release: () => void }
export interface AcquireOptions {
  directory: string; slots: number; label: string;
  /** Called once, when every slot is held, with the line the run prints. */
  onWait?: (line: string) => void;
  pollMs?: number; pid?: number;
  /** Whether a pid still runs; a slot whose owner does not is taken back. */
  alive?: (pid: number) => boolean;
}

const processAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};
const readOwner = (path: string): SlotOwner | null => { try { return JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')); } catch { return null; } };
/** A slot directory that has had no owner file for this long was abandoned between its mkdir and its write. */
const ownerlessGraceMs = 30_000;

/** The slots held now, with their owners. */
export function heldSlots(directory: string): { slot: number; owner: SlotOwner | null }[] {
  let names: string[] = [];
  try { names = readdirSync(directory); } catch { return []; }
  return names.map(name => /^slot-(\d+)$/.exec(name)).filter((match): match is RegExpExecArray => !!match)
    .map(match => ({ slot: Number(match[1]), owner: readOwner(join(directory, match[0])) })).sort((a, b) => a.slot - b.slot);
}

/** Take a slot back from an owner that no longer runs. Renamed first, so two waiters never both reclaim it. */
function reclaimStale(path: string, alive: (pid: number) => boolean) {
  const owner = readOwner(path);
  if (owner ? alive(owner.pid) : (() => { try { return Date.now() - statSync(path).mtimeMs < ownerlessGraceMs; } catch { return true; } })()) return false;
  const tomb = `${path}.stale-${process.pid}-${Date.now()}`;
  try { renameSync(path, tomb); } catch { return false; }
  // Another waiter may have reclaimed and retaken it between the read and the rename: give a live owner's slot back.
  const moved = readOwner(tomb);
  if (moved && alive(moved.pid) && moved.pid !== owner?.pid) { try { renameSync(tomb, path); return false; } catch { /* its slot is gone; it holds none */ } }
  rmSync(tomb, { recursive: true, force: true });
  return true;
}

function tryTake(directory: string, slots: number, owner: SlotOwner, alive: (pid: number) => boolean): HeldSlot | null {
  for (let slot = 0; slot < slots; slot++) {
    const path = join(directory, `slot-${slot}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        mkdirSync(path);
        writeFileSync(join(path, 'owner.json'), JSON.stringify(owner));
        let released = false;
        return { slot, path, release: () => { if (!released) { released = true; rmSync(path, { recursive: true, force: true }); } } };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (!reclaimStale(path, alive)) break;
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
  const alive = options.alive ?? processAlive, pollMs = options.pollMs ?? 1000;
  mkdirSync(options.directory, { recursive: true });
  const owner: SlotOwner = { pid: options.pid ?? process.pid, label: options.label, cwd: process.cwd(), at: new Date().toISOString() };
  let told = false;
  for (;;) {
    const held = tryTake(options.directory, options.slots, owner, alive);
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

export const wrappedCommands = ['tsc', 'npx'] as const;
/**
 * The wrapper directory a session's PATH starts with: one script per wrapped command, which runs
 * this module's entry point with the command's name. Written under the lock directory, once per
 * content; the scripts carry this installation's node, tsx and module paths.
 */
export function writeVerificationWrappers(directory: string, node = process.execPath) {
  const bin = join(directory, 'bin'), module = fileURLToPath(import.meta.url), tsx = import.meta.resolve('tsx');
  mkdirSync(bin, { recursive: true });
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  for (const command of wrappedCommands) {
    const file = join(bin, command), text = `#!/bin/sh\nexec ${quote(node)} --import ${quote(tsx)} ${quote(module)} ${command} "$@"\n`;
    let current: string | null = null;
    try { current = readFileSync(file, 'utf8'); } catch { /* not written yet */ }
    if (current !== text) { writeFileSync(`${file}.${process.pid}`, text, { mode: 0o755 }); renameSync(`${file}.${process.pid}`, file); }
  }
  return bin;
}

/** The variables a session's tab carries: the lock directory, the bound, and PATH with the wrappers first. */
export function verificationEnvironment(managedRoot: string, environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const directory = verificationSlotsDirectory(managedRoot);
  const bin = writeVerificationWrappers(directory);
  return { [slotsDirectoryVariable]: directory, [slotsVariable]: String(configuredVerificationSlots(environment)), PATH: [bin, pathWithout(environment.PATH, bin)].filter(Boolean).join(delimiter) };
}

/** The wrapper: run the real command, under a slot when it is a heavy verification run. */
export async function runWrapped(command: string, args: string[], environment: NodeJS.ProcessEnv = process.env) {
  const bin = environment[slotsDirectoryVariable] ? join(environment[slotsDirectoryVariable]!, 'bin') : null;
  const path = bin ? pathWithout(environment.PATH, bin) : environment.PATH ?? '';
  const real = onPathOf(command, path);
  if (!real) { process.stderr.write(`graphyard: ${command} is not on PATH\n`); return 127; }
  const held = heavyCommand(command, args) ? await sessionVerificationSlot(`${command} ${args.join(' ')}`.trim(), environment) : null;
  const child = spawn(real, args, { stdio: 'inherit', env: { ...environment, PATH: path, ...(held || environment[heldVariable] ? { [heldVariable]: '1' } : {}) } });
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.on('SIGINT', forward); process.on('SIGTERM', forward);
  try { return await new Promise<number>(done => { child.on('error', () => done(127)); child.on('close', (status, signal) => done(status ?? (signal ? 1 : 0))); }); }
  finally { held?.release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runWrapped(process.argv[2], process.argv.slice(3));
}
