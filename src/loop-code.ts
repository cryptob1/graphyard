import { realpathSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { underTestRunner } from './runtime-environment.js';
import { connectionRoots } from './git-checkout-roots.js';
import { readInstallUnits, systemdCommandLineWords, unitCheckout, userUnitDirectory, type InstallUnits } from './install/units.js';
import { coordinatorCheckoutRoot } from './master/profiles.js';
import { installDirectory } from './install/secrets.js';
import { installIdFor } from './install/types.js';
import { knownGoodDirectory } from './master/known-good.js';

export interface UnitCode {
  unit: string; path: string;
  /** The checkout the unit loads its code from: the directory above the launcher its ExecStart starts, else its WorkingDirectory. */
  checkout: string | null;
  /** The checkout above the Graphyard launcher its ExecStart starts; null when it names none and `checkout` fell back to the WorkingDirectory. */
  launcher?: string | null;
}
/** GY-1859: the loop code this install's units run, against the CLI running the command. */
export interface LoopCodeReading {
  /** The master loop's unit; null while none is installed for the units this checkout records. */
  loop: UnitCode | null;
  /** The commit the running loop recorded loading (its cursor's release); null when none is recorded. */
  loopCommit: string | null;
  /** The CLI running this command: the checkout it runs from and that checkout's commit. */
  cli: { root: string; commit: string | null };
  /** The managed repository, as master.json records it: whose units these are, and what a rerun names. */
  repository: string | null;
  /** Why the loop is not known to run this CLI's commit — another checkout, another or no recorded commit, a dirty load — or null. */
  loopStale: string | null;
  /** What replaces a stale loop: `unit` when its unit starts another checkout (the unit is rewritten), `restart` when it names this checkout but the process runs other code. */
  loopReplace?: 'unit' | 'restart' | null;
  /** The host the units were read on, for a host install; absent or null on this machine. */
  host?: string | null;
  /** Why the reading could not be taken at all; null when it was. */
  error: string | null;
}
const canonicalPath = (path: string) => { const absolute = resolve(path); try { return realpathSync(absolute); } catch { return absolute; } };
const shortSha = (commit: string | null | undefined) => commit ? String(commit).slice(0, 12) : 'no commit';
/** The checkout a unit runs its code from: the directory above the launcher its ExecStart names — `bin/graphyard.mjs` or a pin's `dist/cli.js` — else its WorkingDirectory (GY-1859). A unit naming neither reads as its WorkingDirectory, so a unit this install wrote never reads as foreign. */
function unitCodeCheckout(text: string, home: string): string | null {
  return unitLauncherCheckout(text, home) ?? unitCheckout(text, home).workingDirectory;
}
/** The one ExecStart wording both readers share, defined beside `unitCheckout` in `src/install/units.ts` (GY-1880). */
export { systemdCommandLineWords };
/** The checkout whose Graphyard launcher a unit's ExecStart starts, null when it names none: the executable alone, never the rest of the unit (GY-1859). The line is worded by systemd's own quoting rules (GY-1880), so a launcher `loopUnitText` spelled quoted for a path holding whitespace reads back as exactly that checkout. */
export function unitLauncherCheckout(text: string, home: string): string | null {
  const start = unitCheckout(text, home).execStart;
  const launcher = start ? systemdCommandLineWords(start).find(part => /(?:bin\/graphyard\.mjs|dist\/cli\.js)$/.test(part)) : undefined;
  return launcher ? dirname(dirname(launcher)) : null;
}
/** Under the test runner only a unit directory under the system temporary directory is read, as legacyUnitFiles guards: the operator's real units belong to no checkout a test made. */
const readableUnitsDirectory = (unitDirectory: string) => {
  if (!underTestRunner()) return true;
  const temporary = canonicalPath(tmpdir());
  return `${canonicalPath(unitDirectory)}${sep}`.startsWith(`${temporary}${sep}`);
};
/** The loop's cursor, beside its credential as daemonStatePath keeps it: what reports the commit the running loop loaded. */
const loopCursorPath = (credentialFile: string) => `${dirname(credentialFile)}/${basename(credentialFile).replace(/\.token$/, '')}.daemon.json`;
const failureText = (failure: unknown) => failure instanceof Error ? failure.message.split('\n')[0] : String(failure);

/**
 * Where a reading's files live (GY-1859): this machine's file system, or a host install's through its
 * transport. `read` answers null only for a file that does not exist and throws on any other failure,
 * and `list` answers [] only for a directory that does not exist, so a reading never mistakes a
 * refused read for an absent unit or cursor.
 */
export interface LoopCodeFiles { read(path: string): Promise<string | null>; list(directory: string): Promise<string[]> }
export const localLoopCodeFiles: LoopCodeFiles = {
  read: async path => { try { return await readFile(path, 'utf8'); } catch (error: any) { if (error?.code === 'ENOENT') return null; throw new Error(`${path} could not be read: ${error?.code ?? error?.message ?? error}`); } },
  list: async directory => { try { return await readdir(directory); } catch (error: any) { if (error?.code === 'ENOENT') return []; throw new Error(`${directory} could not be read: ${error?.code ?? error?.message ?? error}`); } },
};
/** What the judgement reads (GY-1859): the loop's unit and cursor, beside the code it must run. */
export interface LoopCodeFacts {
  /** The CLI whose code the units must run: its checkout and that checkout's commit. */
  cli: { root: string; commit: string | null };
  /** The managed repository's checkout. */
  primary: string;
  repository: string | null;
  loop: UnitCode | null;
  /** The loop cursor's text; null when none is written. */
  cursor: string | null;
  host?: string | null;
  /** The install's pinned coordinator snapshots (GY-2937): the `coordinator/current` links a loop unit starts by design. */
  snapshots?: string[];
  /** How a path is compared: realpath on this machine, the path itself on a host. */
  canonical?: (path: string) => string;
}
/**
 * The judgement itself (GY-1859): a loop runs this CLI's code only when its unit starts this CLI's
 * checkout (or the repository's, a unit naming no launcher, or — GY-2937 — the install's pinned
 * coordinator snapshot, which the deploy unit pins and the loop restarts onto by design) and its
 * cursor records loading exactly this CLI's commit from a clean tree. A cursor naming no commit is
 * not proof, and neither is a known-good pin on another commit: that is this
 * install's machinery, but the command asked for this CLI's code.
 */
export function judgeLoopCode(facts: LoopCodeFacts): LoopCodeReading {
  const canonical = facts.canonical ?? canonicalPath;
  const { cli, loop } = facts;
  const base: LoopCodeReading = { loop, loopCommit: null, cli, repository: facts.repository, loopStale: null, loopReplace: null, host: facts.host ?? null, error: null };
  if (!loop) return base;
  if (!cli.commit) return { ...base, error: `the commit of this CLI's checkout (${cli.root}) could not be read, so no unit is judged against it` };
  const own = new Set([cli.root, facts.primary].map(canonical));
  let release: { commit: string | null; dirty: boolean | null } = { commit: null, dirty: null };
  try { const recorded = facts.cursor === null ? null : JSON.parse(facts.cursor)?.release; release = { commit: typeof recorded?.commit === 'string' ? recorded.commit : null, dirty: typeof recorded?.dirty === 'boolean' ? recorded.dirty : null }; } catch { /* an unreadable cursor records nothing */ }
  const same = (commit: string | null | undefined, expected: string | null) => !!commit && !!expected && commit.toLowerCase() === expected.toLowerCase();
  let loopStale: string | null = null, loopReplace: LoopCodeReading['loopReplace'] = null;
  // GY-2937: the install's pinned coordinator snapshot is the loop's own checkout (the deploy unit
  // pins it and the loop restarts onto it), so a unit starting it is judged by its commit alone,
  // below — and any staleness still replaces the unit, since no restart moves an ExecStart off the
  // snapshot; only a rewrite, after up lifts the pins, starts this CLI.
  const pinned = !!loop.launcher && new Set(facts.snapshots?.map(canonical) ?? []).has(canonical(loop.launcher));
  {
    // The loop always starts a CLI, never the repository's own entry, so a launcher its ExecStart
    // names must be this CLI's (or the install's pinned snapshot, GY-2937): one in the managed
    // checkout (Graphyard managing itself from a second checkout) loads that checkout's code on
    // every restart, so only a rewrite moves it. The repository checkout is accepted only as the
    // WorkingDirectory of a unit naming no launcher.
    const foreign = !pinned && (loop.launcher ? canonical(loop.launcher) !== canonical(cli.root) : !!loop.checkout && !own.has(canonical(loop.checkout)));
    if (foreign) { loopStale = `${loop.path} starts the CLI in ${loop.checkout}${release.commit ? ` at ${shortSha(release.commit)}` : ''}, not this checkout (${cli.root}) at ${shortSha(cli.commit)}`; loopReplace = 'unit'; }
    else if (!release.commit) { loopStale = `${loop.path} runs a loop whose cursor records no commit it loaded, so it is not known to run this checkout's ${shortSha(cli.commit)}`; loopReplace = 'restart'; }
    else if (!same(release.commit, cli.commit)) { loopStale = `${loop.path} runs ${shortSha(release.commit)}, not this checkout's ${shortSha(cli.commit)}`; loopReplace = 'restart'; }
    else if (release.dirty === true) { loopStale = `${loop.path} runs ${shortSha(release.commit)} with uncommitted changes it loaded, not this checkout's clean ${shortSha(cli.commit)}`; loopReplace = 'restart'; }
  }
  if (loopStale && pinned) loopReplace = 'unit';
  return { ...base, loopCommit: release.commit, loopStale, loopReplace };
}

/**
 * What the install at ROOT runs, against the CLI running this command (GY-1859): the units ROOT
 * records and the cursor beside the master credential, judged by judgeLoopCode.
 * Every host reach is injectable, so tests judge the judgement itself, never this machine.
 */
export async function readLoopCode(root: string, options: {
  /** The launcher of the CLI running this command; default this process's own checkout's. */
  cliPath?: string;
  /** Runs git for the CLI checkout's commit. */
  run?: (command: string, args: string[]) => string;
  /** The units ROOT records; default readInstallUnits; null forces none. */
  units?: InstallUnits | null;
  unitDirectory?: string;
  home?: string;
  /** The master configuration; default .graphyard/master.json in ROOT. */
  master?: { cliPath?: string | null; credentialFile?: string | null; repository?: string | null } | null;
  /** The loop cursor's text; default read beside the master credential. */
  cursor?: string | null;
  files?: LoopCodeFiles;
} = {}): Promise<LoopCodeReading> {
  const run = options.run ?? ((command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }));
  const files = options.files ?? localLoopCodeFiles;
  const unitDirectory = options.unitDirectory ?? userUnitDirectory(), home = options.home ?? homedir();
  const cliPath = options.cliPath ?? fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
  const cliRoot = coordinatorCheckoutRoot(cliPath);
  const head = (checkout: string) => { try { return run('git', ['-C', checkout, 'rev-parse', 'HEAD']).trim() || null; } catch { return null; } };
  const cliCommit = head(cliRoot);
  const primary = await (async () => { try { return connectionRoots(root)[0]; } catch { return root; } })();
  let master = options.master !== undefined ? options.master : null;
  if (options.master === undefined) { try { master = JSON.parse(await readFile(resolve(root, '.graphyard', 'master.json'), 'utf8')); } catch { master = null; } }
  const repository = typeof master?.repository === 'string' ? master.repository : null;
  const failed = (failure: unknown): LoopCodeReading => ({ loop: null, loopCommit: null, cli: { root: cliRoot, commit: cliCommit }, repository, loopStale: null, loopReplace: null, host: null, error: failureText(failure) });
  let units: InstallUnits | null;
  if (options.units !== undefined) units = options.units;
  else if (!readableUnitsDirectory(unitDirectory)) units = null;
  else { try { units = readInstallUnits(root, unitDirectory, home); } catch (failure) { return failed(failure); } }
  try {
    const unit = async (name: string): Promise<UnitCode | null> => { const path = resolve(unitDirectory, name), text = units ? await files.read(path) : null; return text === null ? null : { unit: name, path, checkout: unitCodeCheckout(text, home), launcher: unitLauncherCheckout(text, home) }; };
    const loop = units ? await unit(units.master) : null;
    const credentialFile = typeof master?.credentialFile === 'string' ? resolve(master.credentialFile) : null;
    const cursor = !loop ? null : options.cursor !== undefined ? options.cursor : credentialFile ? await files.read(loopCursorPath(credentialFile)) : null;
    // GY-2937: the install's pinned coordinator snapshot, whose launcher the loop's unit names by design.
    const snapshots = await (async () => {
      if (!repository) return [];
      try {
        return [join(knownGoodDirectory(installDirectory(installIdFor(repository))), 'current')];
      } catch { return []; }
    })();
    return judgeLoopCode({ cli: { root: cliRoot, commit: cliCommit }, primary, repository, loop, cursor, snapshots });
  } catch (failure) { return failed(failure); }
}

/**
 * GY-1859: what this install's loop runs against the CLI at CLIPATH — `doctor`'s reading, the
 * same as `up`'s.
 */
export async function readInstallLoopCode(root: string, options: {
  cliPath?: string;
  /** Reads this machine's units; default readLoopCode. */
  local?: (root: string, cliPath: string) => Promise<LoopCodeReading>;
} = {}): Promise<LoopCodeReading> {
  const cliPath = options.cliPath ?? fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
  return (options.local ?? ((at: string, path: string) => readLoopCode(at, { cliPath: path })))(root, cliPath);
}
