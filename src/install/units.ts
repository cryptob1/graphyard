// Concern: the systemd unit names one installation owns on a host (GY-1441).
//
// A host may run several installations side by side — a production coordinator and a pilot from a
// fresh clone. A fixed unit name (`graphyard-master.service`, `graphyard-executor@.service`) made
// the second install's setup rewrite and restart the first's loop and executors. Every unit an
// install writes is therefore named for that install (its repository slug), and the names it chose
// are recorded beside its master configuration, so every reader — the loop's self-upgrade, the
// host-supervision step, status, the master's harness — names the same units. A host whose single
// install predates this keeps its legacy names through a recorded alias: the record says the
// install owns `graphyard-master.service`, so nothing about a working host changes.
import { readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const legacyLoopUnit = 'graphyard-master.service';
export const legacyExecutorTemplate = 'graphyard-executor@.service';
/** Where an install records the units it owns; local and ignored, like every file under `.graphyard/`. */
export const installUnitsFile = '.graphyard/units.json';

const recordSchema = z.object({
  version: z.literal(1),
  /** The install slug the names derive from; null for the legacy alias. */
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(80).nullable(),
  master: z.string().regex(/^graphyard-master[A-Za-z0-9@._-]*\.service$/),
  executorTemplate: z.string().regex(/^graphyard-executor[A-Za-z0-9._-]*@\.service$/),
  /** True when the install kept the pre-GY-1441 names because its units already ran this checkout. */
  alias: z.boolean(),
}).strict();
export type InstallUnits = z.infer<typeof recordSchema>;

/**
 * `OWNER/NAME` as a unit-name fragment: lower case, every other character a single dash. When that
 * loses information — a `.` or `_` in the name, a run of separators, or truncation — a short hash of
 * the repository is appended, so `owner/foo.bar` and `owner/foo-bar` never share units.
 */
export function installSlug(repository: string) {
  const plain = repository.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!plain) throw new Error(`The repository ${JSON.stringify(repository)} gives no unit-name slug`);
  const [owner, name, ...rest] = repository.toLowerCase().split('/');
  const lossless = !rest.length && name !== undefined && plain.length <= 80 && `${owner}-${name}` === plain && /^[a-z0-9-]+$/.test(`${owner}${name}`) && !/--/.test(plain);
  if (lossless) return plain;
  const hash = createHash('sha256').update(repository.toLowerCase()).digest('hex').slice(0, 8);
  return `${plain.slice(0, 71).replace(/-+$/, '')}-${hash}`;
}
/** The names a new install of REPOSITORY writes: `graphyard-master-OWNER-NAME.service` and its executor template. */
export function perInstallUnits(repository: string): InstallUnits {
  const slug = installSlug(repository);
  return { version: 1, slug, master: `graphyard-master-${slug}.service`, executorTemplate: `graphyard-executor-${slug}@.service`, alias: false };
}
export const legacyInstallUnits: InstallUnits = { version: 1, slug: null, master: legacyLoopUnit, executorTemplate: legacyExecutorTemplate, alias: true };

/** One executor slot's instance of the install's template. */
export const executorInstance = (units: Pick<InstallUnits, 'executorTemplate'>, slot: number | string) => units.executorTemplate.replace('@.service', `@${slot}.service`);
/** The glob `systemctl list-units` takes for every instance of the install's template, and nobody else's. */
export const executorGlob = (units: Pick<InstallUnits, 'executorTemplate'>) => units.executorTemplate.replace('@.service', '@*.service');
/** The instance-name pattern of the install's template, for reading what `list-units` printed. */
export const executorInstancePattern = (units: Pick<InstallUnits, 'executorTemplate'>) =>
  new RegExp(`(?<![A-Za-z0-9._-])${units.executorTemplate.replace('@.service', '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@(\\d+)\\.service`, 'g');
/** Every unit an install owns, by exact name or template: what its harness may restart. */
export const ownedUnits = (units: InstallUnits) => [units.master, units.executorTemplate];

/** The command that records an install's own units in its checkout: `master init` resolves and writes them. */
export const initialiseUnitsCommand = 'graphyard master init';
/** A legacy-named unit file beside the install: where it is, and its text (null when it is not installed). */
export interface LegacyUnitFile { path: string; text: string | null }
/** The host's user unit directory: where every install's user units, legacy-named ones included, live. */
export const userUnitDirectory = (env: NodeJS.ProcessEnv = process.env) =>
  join(env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.config'), 'systemd', 'user');
/**
 * The legacy-named loop and executor units in UNIT_DIRECTORY, read synchronously. Under the test
 * runner only a directory under the system temporary directory is read, as `testSuiteHomeGuard`
 * (supervisor.ts) only writes one: the operator's real units belong to no checkout a test made.
 */
export function legacyUnitFiles(unitDirectory = userUnitDirectory()): LegacyUnitFile[] {
  const underTestRunner = !!process.env.NODE_TEST_CONTEXT || process.execArgv.includes('--test') || process.env.npm_lifecycle_event === 'test';
  const temporary = canonical(tmpdir());
  if (underTestRunner && !`${canonical(unitDirectory)}${sep}`.startsWith(`${temporary}${sep}`)) return [];
  return [legacyLoopUnit, legacyExecutorTemplate].map(name => {
    const path = join(unitDirectory, name);
    try { return { path, text: readFileSync(path, 'utf8') }; } catch (error) { if (!absent(error)) throw error; return { path, text: null }; }
  });
}

/** Thrown when ROOT records no units and a legacy-named unit runs another checkout: its names are that install's, never ROOT's (GY-1452). */
export class LegacyUnitRefusal extends Error {
  override readonly name = 'LegacyUnitRefusal';
  constructor(readonly unitPath: string, readonly checkout: string, readonly root: string) {
    super(`${root} records no units (${installUnitsFile} is absent), and the legacy unit ${unitPath} runs another checkout (${checkout}), not this one; run ${initialiseUnitsCommand} in ${root} to record this install's own units, rather than act on that install's loop and executors`);
  }
}

/**
 * The units ROOT owns when it records none: an install written before GY-1441 used the legacy names,
 * so they are its alias only while every legacy-named unit installed beside it runs ROOT itself. A
 * legacy unit that runs another checkout is that install's: this fails closed by naming it.
 */
export function unrecordedInstallUnits(root: string, legacy: LegacyUnitFile[], home = homedir()): InstallUnits {
  for (const { path, text } of legacy) {
    const checkout = text === null ? null : foreignUnitText(text, root, home);
    if (checkout) throw new LegacyUnitRefusal(path, checkout, root);
  }
  return legacyInstallUnits;
}

/**
 * The units a record names. No record (null) is an install written before GY-1441, which keeps the
 * legacy names only when ABSENT (`unrecordedInstallUnits`) finds no legacy unit running another
 * checkout. A record that exists but cannot be read fails closed: guessing the legacy names could
 * act on another install's loop and executors.
 */
export function parseInstallUnits(text: string | null, where: string, absent: () => InstallUnits): InstallUnits {
  if (text === null) return absent();
  try { return recordSchema.parse(JSON.parse(text)); }
  catch (error) { throw new Error(`${where} does not record this install's units (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); fix or remove it and rerun master init, rather than guess which units are this install's`); }
}
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
/** The units an install recorded, read synchronously by every reader; with no record, the legacy alias only when it is ROOT's own. */
export function readInstallUnits(root: string, unitDirectory = userUnitDirectory(), home = homedir()): InstallUnits {
  const file = resolve(root, installUnitsFile);
  let text: string | null;
  try { text = readFileSync(file, 'utf8'); } catch (error) { if (!absent(error)) throw error; text = null; }
  return parseInstallUnits(text, file, () => unrecordedInstallUnits(root, legacyUnitFiles(unitDirectory), home));
}

const canonical = (path: string) => { const absolute = resolve(path); try { return realpathSync(absolute); } catch { return absolute; } };
const setting = (text: string, key: string, home: string) =>
  text.split(/\r?\n/).find(line => line.startsWith(`${key}=`))?.slice(key.length + 1).replace(/%%|%h/g, specifier => specifier === '%%' ? '%' : home) ?? null;

/** The checkout a unit file runs: its WorkingDirectory, or the directory its ExecStart script lives under. */
export function unitCheckout(text: string, home = homedir()) {
  const working = setting(text, 'WorkingDirectory', home)?.replace(/^"|"$/g, '') ?? null;
  const start = setting(text, 'ExecStart', home);
  return { workingDirectory: working, execStart: start };
}

/**
 * Whether the unit at PATH belongs to the checkout ROOT: its WorkingDirectory is ROOT, and its
 * ExecStart names no script outside ROOT's own `scripts/` or `bin/` (a coordinator launcher in a
 * private CLI path is allowed: it is the loop's, recorded in its master configuration). Returns the
 * other checkout it names when it does not, null when it is ROOT's or absent.
 */
export function foreignUnitCheckout(path: string, root: string, home = homedir()): string | null {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  return foreignUnitText(text, root, home);
}
/** `foreignUnitCheckout` of a unit's TEXT, read from wherever it lives (this machine or a host). */
export function foreignUnitText(text: string, root: string, home = homedir()): string | null {
  const { workingDirectory, execStart } = unitCheckout(text, home);
  const own = canonical(root);
  if (workingDirectory && canonical(workingDirectory) !== own) return workingDirectory;
  const script = execStart?.split(/\s+/).find(part => /\/scripts\/graphyard-executor\.mjs$/.test(part));
  if (script && canonical(dirname(dirname(script))) !== own) return dirname(dirname(script));
  return null;
}

/** Thrown when an install would overwrite or restart a unit another checkout runs; it names that checkout. */
export class ForeignUnitRefusal extends Error {
  override readonly name = 'ForeignUnitRefusal';
  constructor(readonly unitPath: string, readonly checkout: string, root: string) {
    super(`${unitPath} runs another installation (${checkout}), not this checkout (${root}); Graphyard never overwrites or restarts another install's unit`);
  }
}
export function assertUnitOwned(path: string, root: string, home = homedir()) {
  const checkout = foreignUnitCheckout(path, root, home);
  if (checkout) throw new ForeignUnitRefusal(path, checkout, root);
}

/** The names an install of REPOSITORY at ROOT takes when it records none yet: what `resolveInstallUnits` writes. */
export function proposedInstallUnits(root: string, repository: string, unitDirectory: string, home = homedir()): InstallUnits {
  const legacy = legacyUnitFiles(unitDirectory).filter(unit => unit.text !== null);
  return legacy.length && legacy.every(unit => foreignUnitText(unit.text!, root, home) === null) ? legacyInstallUnits : perInstallUnits(repository);
}
/**
 * The names this install writes, decided once and recorded: an existing record stands; a host
 * whose legacy loop unit already runs this checkout keeps the legacy names (the recorded alias);
 * every other install takes its own per-repository names, so a second install on the host can
 * never collide with the first.
 */
export async function resolveInstallUnits(root: string, repository: string, unitDirectory: string, home = homedir()): Promise<InstallUnits> {
  const file = resolve(root, installUnitsFile);
  let text: string | null;
  try { text = await readFile(file, 'utf8'); } catch (error) { if (!absent(error)) throw error; text = null; }
  if (text !== null) return parseInstallUnits(text, file, () => legacyInstallUnits);
  const units = proposedInstallUnits(root, repository, unitDirectory, home);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(units, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
  return units;
}
