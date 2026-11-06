// Concern: the master loop's own supervisor unit — unit text, installLoopSupervisor, alignLoopUnit,
// the durable-checkout preflight and test home guard — and, from inside the running loop, detecting
// that unit and telling a self-restart that succeeded from one that failed (GY-916).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { deployUnitOf, installUnitsFile, legacyLoopUnit, proposedInstallUnits, readInstallUnits, resolveInstallUnits } from './units.js';
import { knownGoodCli, knownGoodState } from '../master/known-good.js';
import { installDirectory } from './secrets.js';
import { installIdFor } from './types.js';
import { canonical, temporaryDirectories, underTestRunner } from '../runtime-environment.js';
export { temporaryDirectories, underTestRunner } from '../runtime-environment.js';
const detail = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 200);

// --- The master loop's own supervisor ----------------------------------------
//
// GY-84 made the loop report itself: an absent process or a stalled cycle becomes the top
// attention item, "and a supervised deployment restarts it automatically". That last clause was an
// assumption about the host, never a fact anybody established — an installation could follow the
// guide end to end and still run an unsupervised loop, learning it only after hours of silence.
// What follows installs that supervisor, verifies it, and — where no supervisor can be installed —
// says so instead of leaving the promise unkept.

/**
 * The loop's legacy unit name: what an install written before GY-1441 runs, kept as its recorded
 * alias. A new install names its loop for itself (`graphyard-master-OWNER-NAME.service`,
 * install/units.ts), and `loopUnitOf` reads the name a checkout recorded.
 */
export const loopUnitName = legacyLoopUnit;
/** The loop unit the install at ROOT owns: its recorded name, or the legacy alias. */
export const loopUnitOf = (root: string, unitDirectory?: string, home?: string) => readInstallUnits(root, unitDirectory, home).master;
/** Long enough for the cycle's own bounded external calls to return before SIGKILL. */
export const loopStopTimeoutSeconds = 120;
export const loopRestartSeconds = 10;
/**
 * The keep-alive window. A cycle that hangs leaves the process alive and the pipeline silent,
 * which no `Restart=` setting notices, so the loop pings systemd after every completed cycle. The
 * window must stay well past two cycle intervals or a healthy loop would be restarted mid-cycle —
 * the bound `watchdogPlan` refuses by name — and past the 90s bound on every call into the agent
 * runtime. It is shorter than the 600s a worker launch may take on a large repository: a launch
 * that slow outlasts the window and the loop is restarted mid-launch, which its persisted cursors
 * make a resumption rather than a repeat. That is the packaged unit's trade, kept here.
 */
export const loopWatchdogSeconds = (intervalSeconds: number) => Math.max(180, Math.ceil(intervalSeconds * 6));

export interface LoopUnitInput {
  /** The coordinator checkout the loop runs `master run` from. */
  root: string;
  cliPath: string;
  repository: string;
  intervalSeconds: number;
  execPath?: string;
  /** The unit name; the install's recorded one (install/units.ts) when omitted. */
  unit?: string;
  /** The install directory holding the known-good coordinator pin (GY-1529); this repository's own when omitted. */
  installDir?: string;
}
export interface LoopSupervisorHost {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Where `~/.config/systemd/user` is rooted; a test host points this at its own directory. */
  home?: string;
  /**
   * The directories this host treats as temporary: a unit whose WorkingDirectory is under one is
   * refused by name (`temporaryDirectories()` by default). A test host that redirects `home` names
   * its own, so the temp-rooted repository it sets up counts as durable for that host alone.
   */
  temporaryDirectories?: string[];
  /** Runs one supervisor command, throwing what it printed when it fails. */
  run?: (command: string, args: string[]) => string;
}
export interface LoopSupervisorInstallOptions {
  /**
   * Replace an installed unit that runs a different loop (another ExecStart or WorkingDirectory).
   * Never implied: without it such a unit is left as it is and the install is refused by name.
   */
  replace?: boolean;
  /**
   * Restart a running loop whose unit was rewritten (the default). The loop's own alignment
   * passes false: it re-executes itself through `systemctl --no-block restart` right after, and a
   * blocking restart issued from inside the unit would be ended by the very stop it requests.
   */
  restart?: boolean;
}
export interface LoopSupervision {
  supported: boolean;
  unit: string;
  unitPath: string | null;
  installed: boolean;
  /** Null when the state could not be read at all, never a guess. */
  enabled: boolean | null;
  active: boolean | null;
  linger: boolean | null;
  reason: string | null;
  /** What the operator must run to keep the loop alive where Graphyard cannot supervise it. */
  instruction: string | null;
  /** Unsupported only because this process's `systemctl --user` probe could not reach the user manager (GY-1400): a sandbox masks it. */
  unreachable?: boolean;
}

/**
 * What the daemon cursor records of the loop's own supervision (GY-1400): the supervisor unit the
 * loop runs under, read from its cgroup, and whether its last self-upgrade re-executed it through
 * that unit. Either is the host's supervisor answering, whatever this vantage can reach.
 */
export interface LoopSupervisorEvidence { unit: string | null; reexecuted: boolean }
export interface LoopSupervisorInstallation extends LoopSupervision {
  /** `refused`: nothing was written or enabled; `refused` below says why and `instruction` what to run. */
  wrote: 'created' | 'updated' | 'unchanged' | 'none' | 'refused';
  refused: string | null;
  /** Exactly what the install did, in order, so setup reports what it installed. */
  performed: string[];
}

const supervisorRun = (host: LoopSupervisorHost) => host.run
  ?? ((command: string, args: string[]) => String(execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })));

/**
 * An install that must not happen, with what the operator runs instead. The installer turns it
 * into a `refused` record rather than a failure: the unit under the real user home is written only
 * by the setup command an operator runs on the coordinator host, and every other reach — a call
 * whose caller omitted the option, the test suite, a worker, reviewer or producer checkout, a unit
 * that already runs another loop — is named and left alone (GY-114).
 */
export class LoopSupervisorRefusal extends Error {
  override readonly name = 'LoopSupervisorRefusal';
  constructor(message: string, readonly instruction: string) { super(message); }
}

const within = (path: string, parent: string) => path === parent || path.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
/**
 * Host preflight (GY-1457): the loop unit refuses a coordinator checkout under a temporary
 * directory (assertCoordinatorCheckout), so setup says so before it starts, naming the directory
 * and a durable place to clone the repository instead.
 */
export function durableCheckoutPreflight(root: string, temporary: string[] = temporaryDirectories(), home = homedir()) {
  const checkout = canonical(root);
  const under = temporary.map(canonical).find(directory => within(checkout, directory));
  if (!under) return { name: 'Durable checkout', ok: true, detail: `${root} is not under a temporary directory` };
  return { name: 'Durable checkout', ok: false, detail: `${root} is under the temporary directory ${under}, where the master loop's unit refuses to run`,
    fix: `Clone the repository on durable storage, such as ${join(home, 'code', basename(checkout))}, and run setup from there` };
}

/**
 * The one guard the test suite shares. Under the test runner the loop's unit directory must be
 * rooted in the system temporary directory, so a test that reaches `setupMaster` or
 * `installLoopSupervisor` runs against a temp-rooted home or is refused here, before anything is
 * written — enforced once, at the only place that writes the unit, rather than by each test
 * remembering to redirect its host's home. It takes only the directory: the test-runner mark comes
 * from this process, not from the host the caller built.
 */
export function testSuiteHomeGuard(unitDirectory: string) {
  if (!underTestRunner()) return;
  const temporary = canonical(tmpdir());
  if (within(canonical(unitDirectory), temporary)) return;
  throw new LoopSupervisorRefusal(`the test suite may not write ${unitDirectory}: under the test runner the loop's unit directory must be rooted in ${temporary}`,
    'give the test host a home under the system temporary directory (LoopSupervisorHost.home); the real user home is written only by graphyard master init run by an operator');
}

/**
 * The WorkingDirectory an installed unit may name: the configured coordinator checkout, on a
 * durable path. A temporary directory is refused by name, a managed assignment worktree is never
 * the coordinator, and a checkout without the master configuration is not one this setup wrote.
 */
function assertCoordinatorCheckout(root: string, host: LoopSupervisorHost) {
  const operator = 'run graphyard master init from the coordinator checkout on durable storage; that is the only command which installs the unit';
  if (!isAbsolute(root)) throw new LoopSupervisorRefusal(`the loop's WorkingDirectory must be an absolute path, not ${root}`, operator);
  const checkout = canonical(root);
  const temporary = (host.temporaryDirectories ?? temporaryDirectories()).map(canonical).find(directory => within(checkout, directory));
  if (temporary) throw new LoopSupervisorRefusal(`the loop's WorkingDirectory ${root} is under the temporary directory ${temporary}: a unit rooted there outlives its checkout and crash-loops once the directory is gone`, operator);
  if (checkout.split(sep).includes('.graphyard')) throw new LoopSupervisorRefusal(`the loop's WorkingDirectory ${root} is inside a managed .graphyard directory (an assignment worktree or session checkout), never the coordinator checkout`, operator);
  if (!existsSync(join(checkout, '.graphyard', 'master.json'))) throw new LoopSupervisorRefusal(`the loop's WorkingDirectory ${root} is not the configured coordinator checkout: it holds no .graphyard/master.json`, operator);
}
/**
 * One setting of a unit file, with systemd's `%h` (the user's home, as the packaged example spells
 * its checkout) expanded so a hand-installed unit for this same checkout reads as this loop.
 */
const unitSetting = (text: string, key: string, home: string) =>
  text.split(/\r?\n/).find(line => line.startsWith(`${key}=`))?.slice(key.length + 1).replace(/%%|%h/g, specifier => specifier === '%%' ? '%' : home) ?? null;
/**
 * `systemctl is-enabled` and `is-active` answer on stdout and exit non-zero for every state but
 * the good one, so a state is read from what the command printed; only a command that printed
 * nothing at all is a failure to observe.
 */
function supervisorState(run: (command: string, args: string[]) => string, args: string[]) {
  try { return run('systemctl', args).trim().split(/\r?\n/)[0]?.trim() ?? ''; }
  catch (error) {
    const printed = String((error as { stdout?: unknown }).stdout ?? '').trim().split(/\r?\n/)[0]?.trim();
    if (printed) return printed;
    return null;
  }
}

export function loopUnitDirectory(host: LoopSupervisorHost = {}) {
  const env = host.env ?? process.env;
  const configHome = host.home ? join(host.home, '.config') : env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.config');
  return join(configHome, 'systemd', 'user');
}

/** A unit setting that cannot smuggle a second directive or a broken quotation into the file. */
function unitValue(value: string, field: string) {
  if (/[\r\n\0"\\]/.test(value)) throw new Error(`The loop's ${field} cannot be written as a systemd setting because it contains a newline, quote, or backslash: ${value}`);
  return /\s/.test(value) ? `"${value}"` : value;
}
/** `WorkingDirectory=` is taken literally by systemd, quotes included, so a path with whitespace has no spelling. */
function unitDirectoryValue(value: string, field: string) {
  if (/\s/.test(value)) throw new Error(`The loop's ${field} cannot be written as a systemd WorkingDirectory because it contains whitespace: ${value}`);
  return unitValue(value, field);
}

/**
 * The unit, derived from this installation rather than copied from the packaged example: its own
 * checkout, CLI launcher and cycle interval. `Restart=always` with no start limit brings the loop
 * back after a crash however often it crashes, and `WantedBy=default.target` with user lingering
 * brings it back after a reboot; `NotifyAccess=all` admits the keep-alive the loop sends through a
 * short-lived `systemd-notify` child, which is what turns a hung cycle into a restart.
 */
export function loopUnitText(input: LoopUnitInput) {
  const execPath = input.execPath ?? process.execPath;
  // GY-1529: with a pin the loop runs the last promoted release, never the checkout under change.
  const installDir = input.installDir ?? (() => { try { return installDirectory(installIdFor(input.repository)); } catch { return null; } })();
  const cliPath = installDir && knownGoodState(installDir) ? knownGoodCli(installDir) : input.cliPath;
  return `# Generated by graphyard master init, run by an operator from the coordinator checkout below; nothing
# else writes it. Re-running master init from that checkout rewrites this file and edits are replaced;
# a unit that runs another checkout or launcher is replaced only with master init --replace-supervisor.
#
# The loop authenticates with the coordinator credential stored outside the repository. Never add a
# worker, producer, or operator credential here: the coordinator must not be able to claim work,
# publish evidence, or revise requirements.
[Unit]
Description=Graphyard master coordination loop (${input.repository.replace(/[\r\n\0]/g, ' ')})
After=network-online.target
Wants=network-online.target
# Never give up restarting it. Under the default start limit a loop that crashed five times inside
# ten seconds would be left dead, and a dead coordinator makes no decision at all until a person
# notices - exactly what this unit exists to prevent.
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${unitDirectoryValue(input.root, 'checkout')}
ExecStart=${unitValue(execPath, 'Node executable')} ${unitValue(cliPath, 'CLI path')} master run
# The loop persists its cursor before and after every action, so a restart resumes rather than
# repeating. Give it time to finish the action in flight before SIGKILL.
Restart=always
RestartSec=${loopRestartSeconds}
# A hung cycle leaves the process alive and the pipeline silent, which no Restart= setting notices.
# The loop sends a keep-alive after every completed cycle, so systemd restarts it when the cycles
# stop rather than when the process does.
WatchdogSec=${loopWatchdogSeconds(input.intervalSeconds)}
NotifyAccess=all
TimeoutStopSec=${loopStopTimeoutSeconds}
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal
NoNewPrivileges=yes
# No PrivateTmp: producer sessions run in Herdr, outside this unit, and create their detached proof
# worktrees under the shared /tmp. A private /tmp would hide every one of them from the loop.
PrivateTmp=no

[Install]
WantedBy=default.target
`;
}

/** The checkout an install's deploy unit builds and deploys from (GY-2942): its own, under the install directory, never one another install or a person moves. */
export const deployCheckoutOf = (installDir: string) => join(installDir, 'deploy', 'src');

/** The deploy unit beside the loop's (GY-2877): `upgrade --watch` from the same launcher, in the install's own checkout, restarted whenever it stops. */
export function deployUnitText(input: Pick<LoopUnitInput, 'root' | 'cliPath' | 'repository' | 'execPath' | 'installDir'>) {
  const installDir = input.installDir ?? installDirectory(installIdFor(input.repository));
  return `# Generated by graphyard master init beside the master loop's unit; edits are replaced.
# Deploy implementation: immutable CLI releases (GY-3057).
[Unit]
Description=Graphyard continuous deploy (${input.repository.replace(/[\r\n\0]/g, ' ')})
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${unitDirectoryValue(input.root, 'checkout')}
ExecStart=${unitValue(input.execPath ?? process.execPath, 'Node executable')} ${unitValue(input.cliPath, 'CLI path')} upgrade --watch --checkout ${unitValue(deployCheckoutOf(installDir), 'deploy checkout')}
Restart=always
RestartSec=${loopRestartSeconds}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

/** Whether this host can be given a supervisor at all, and why not when it cannot. */
/** `unreachable`: the platform has systemd, but this process's `systemctl --user` probe could not reach the user manager (GY-1400). */
export function supervisorSupport(host: LoopSupervisorHost = {}): { supported: boolean; reason: string | null; unreachable?: boolean } {
  const platform = host.platform ?? process.platform;
  if (platform !== 'linux') return { supported: false, reason: `Graphyard supervises the loop with a systemd user unit, and this host reports ${platform}` };
  try { supervisorRun(host)('systemctl', ['--user', 'show-environment']); return { supported: true, reason: null }; }
  catch (error) { return { supported: false, unreachable: true, reason: `This host has no reachable systemd user manager, so no unit can be installed or enabled: ${detail(error)}` }; }
}

/**
 * What the operator must run where Graphyard cannot install a supervisor. It states the
 * consequence first: the self-healing the loop's own attention item promises does not happen here.
 */
export function unsupervisedInstruction(input: Pick<LoopUnitInput, 'root' | 'cliPath'> & { execPath?: string }) {
  const command = `${input.execPath ?? process.execPath} ${input.cliPath} master run`;
  return `Graphyard cannot install a supervisor for the loop on this host, so its self-healing does not apply here: a crashed, killed, or rebooted loop stays down until a person starts it, and no restart follows the attention item that reports it. Keep it alive yourself - run "${command}" from ${input.root} under this platform's own always-restart supervisor (launchd on macOS, an init service or a container restart policy elsewhere), configure that supervisor to start at boot, and read the loop line in graphyard master status to confirm it is cycling.`;
}

/** The user whose manager runs the unit, as `loginctl` must be told it: by uid, or by name where there is none. */
const supervisedUser = () => String(process.getuid?.() ?? userInfo().username);

/** Read back what the supervisor reports about the unit, without changing anything. */
function observeUnit(run: (command: string, args: string[]) => string, unit: string) {
  const enabled = supervisorState(run, ['--user', 'is-enabled', unit]);
  const active = supervisorState(run, ['--user', 'is-active', unit]);
  return {
    enabledState: enabled, activeState: active,
    enabled: enabled === null ? null : ['enabled', 'enabled-runtime', 'static', 'indirect', 'alias'].includes(enabled),
    // A unit stopping is in a transition (GY-1086): a restart — the loop's own self-upgrade hand-off,
    // an operator's restart — passes through it and the cycle in flight reads it, so it is not read
    // as down; a stop that holds is `inactive` on the next reading.
    active: active === null ? null : ['active', 'activating', 'reloading', 'deactivating'].includes(active),
  };
}

/**
 * Install and enable the loop's supervisor, idempotently. A unit whose content already matches is
 * left alone and nothing is reloaded; enabling and starting are idempotent by construction, so a
 * second setup run changes nothing and reports the same state.
 *
 * It is reached only by `setupMaster` given `installSupervisor: true`, which only `master init`
 * passes. Before it writes anything it refuses, by name, the test suite (`testSuiteHomeGuard`), a
 * WorkingDirectory that is not the configured coordinator checkout on a durable path, and an
 * installed unit that runs a different loop unless `replace` was passed explicitly.
 */
export async function installLoopSupervisor(input: LoopUnitInput, host: LoopSupervisorHost = {}, options: LoopSupervisorInstallOptions = {}): Promise<LoopSupervisorInstallation> {
  const support = supervisorSupport(host);
  const unitDirectory = loopUnitDirectory(host);
  const home = host.home ?? ((host.env ?? process.env).HOME?.trim() || homedir());
  // Before the record is written, an unrecorded install beside another checkout's legacy unit names
  // the units it is about to record, never that install's (GY-1452).
  let loopUnit = input.unit ?? (existsSync(resolve(input.root, installUnitsFile)) ? loopUnitOf(input.root, unitDirectory, home) : proposedInstallUnits(input.root, input.repository, unitDirectory, home).master);
  let unitPath = join(unitDirectory, loopUnit);
  if (!support.supported) return { supported: false, unit: loopUnit, unitPath: null, installed: false, enabled: null, active: null, linger: null,
    wrote: 'none', refused: null, performed: [], reason: support.reason, instruction: unsupervisedInstruction(input) };
  const run = supervisorRun(host);
  const text = loopUnitText(input);
  const performed: string[] = [];
  let existing: string | null = null;
  const refused = (refusal: LoopSupervisorRefusal): LoopSupervisorInstallation => {
    // Nothing was written; what is there is reported as observed, so setup never claims a state. A
    // refusal raised before the unit was read still reports the unit that exists, not `installed: false`.
    const present = existing !== null || existsSync(unitPath);
    const observed = observeUnit(run, loopUnit);
    return { supported: true, unit: loopUnit, unitPath, installed: present, enabled: present ? observed.enabled : false, active: present ? observed.active : false,
      linger: null, wrote: 'refused', refused: refusal.message, performed: [], reason: `Installing the loop's supervisor was refused: ${refusal.message}`, instruction: refusal.instruction };
  };
  try {
    testSuiteHomeGuard(unitDirectory);
    assertCoordinatorCheckout(input.root, host);
  } catch (error) { if (error instanceof LoopSupervisorRefusal) return refused(error); throw error; }
  // The install's own name, decided once and recorded beside its configuration (GY-1441): a second
  // install on this host writes its own unit and never this one's.
  if (!input.unit) { loopUnit = (await resolveInstallUnits(input.root, input.repository, unitDirectory, home)).master; unitPath = join(unitDirectory, loopUnit); }
  try { existing = await readFile(unitPath, 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  // A unit that runs another loop — a different checkout or launcher — is somebody's installation,
  // and a re-run of setup from elsewhere must not take it over silently. A unit for this loop whose
  // other settings changed (the watchdog window follows the interval) is rewritten as before.
  if (existing !== null && !options.replace) {
    // A move between the checkout and the known-good pin (GY-1529) is this module's own doing, not another loop's.
    const pinMove = [existing, text].some(unit => unitSetting(unit, 'ExecStart', home)?.includes('/coordinator/current/dist/cli.js'));
    const differs = (['WorkingDirectory', 'ExecStart'] as const).filter(key => !(key === 'ExecStart' && pinMove) && unitSetting(existing!, key, home) !== unitSetting(text, key, home));
    if (differs.length) return refused(new LoopSupervisorRefusal(
      `${unitPath} already runs a different loop (${differs.map(key => `${key}=${unitSetting(existing!, key, home) ?? '(missing)'}`).join(', ')}), not this checkout's (${differs.map(key => `${key}=${unitSetting(text, key, home)}`).join(', ')})`,
      `graphyard master init --token-stdin --replace-supervisor from this checkout, only if that unit is the coordinator you mean to replace`));
  }
  let wrote: LoopSupervisorInstallation['wrote'] = 'unchanged';
  if (existing !== text) {
    await mkdir(unitDirectory, { recursive: true });
    const temporary = `${unitPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, text, { mode: 0o644, flag: 'wx' });
    await rename(temporary, unitPath);
    wrote = existing === null ? 'created' : 'updated';
    performed.push(`${wrote} ${unitPath}`);
    run('systemctl', ['--user', 'daemon-reload']);
    performed.push('systemctl --user daemon-reload');
  }
  // `enable --now` is the whole restart policy: enabled for every boot, started for this one.
  run('systemctl', ['--user', 'enable', '--now', loopUnit]);
  performed.push(`systemctl --user enable --now ${loopUnit}`);
  // The continuous deploy runs in its own unit beside the loop's (GY-2877).
  const deployUnit = deployUnitOf({ master: loopUnit }), deployPath = join(unitDirectory, deployUnit), deployText = deployUnitText(input);
  const deployExisting = await readFile(deployPath, 'utf8').catch(() => null);
  if (deployExisting !== deployText) {
    await writeFile(deployPath, deployText, { mode: 0o644 });
    run('systemctl', ['--user', 'daemon-reload']);
    performed.push(`wrote ${deployPath}`);
  }
  run('systemctl', ['--user', 'enable', '--now', deployUnit]);
  performed.push(`systemctl --user enable --now ${deployUnit}`);
  // A rewritten deploy unit (GY-2942: its own checkout) runs only once the watch restarts from it.
  if (deployExisting !== null && deployExisting !== deployText) { run('systemctl', ['--user', 'restart', deployUnit]); performed.push(`systemctl --user restart ${deployUnit}`); }
  // A rewritten unit takes effect only when the service starts from it: `enable --now` leaves a
  // running loop on the old ExecStart and watchdog window, so it is restarted, and resumes from
  // the cursors it persists before and after every action.
  if (wrote === 'updated' && options.restart !== false) { run('systemctl', ['--user', 'restart', loopUnit]); performed.push(`systemctl --user restart ${loopUnit}`); }
  // An enabled unit still never runs if this user's manager stops at logout and does not start at
  // boot, so lingering is part of "comes back after a reboot". A host that refuses it is reported
  // rather than left looking supervised.
  let linger: boolean | null = null, lingerReason: string | null = null;
  try { run('loginctl', ['enable-linger']); linger = true; performed.push('loginctl enable-linger'); }
  catch (error) { linger = false; lingerReason = `the unit is enabled, but user lingering could not be turned on, so this user's systemd manager may not start at boot: ${detail(error)}`; }
  const observed = observeUnit(run, loopUnit);
  const unreadable = [observed.enabled === null ? 'enabled' : null, observed.active === null ? 'active' : null].filter(Boolean).join(' and ');
  return { supported: true, unit: loopUnit, unitPath, installed: true, enabled: observed.enabled, active: observed.active, linger,
    wrote, refused: null, performed, instruction: null,
    reason: [unreadable ? `systemd did not report whether the unit is ${unreadable}` : null, lingerReason].filter(Boolean).join('; ') || null };
}

/**
 * The loop's own re-application of its unit (GY-916). Only `master init` used to write the unit,
 * so a hand-copied packaged example (WatchdogSec written for the 20s default) stayed installed
 * under a 300s interval and its window was refused as a configuration fault at every process
 * start, forever. The alignment step calls this before it re-executes the loop: an installed unit
 * whose text no longer matches `loopUnitText` for the running configuration is rewritten through
 * `installLoopSupervisor`'s idempotent path — with all of its refusals, and without its blocking
 * restart — so the next process starts under the window `loopWatchdogSeconds` computes. A unit
 * that is not installed is left to `master init`; one that already matches is not touched unless
 * the deploy unit beside it is missing (GY-2936) or stale (GY-2942), which the same path writes and enables.
 */
export async function alignLoopUnit(input: LoopUnitInput, host: LoopSupervisorHost = {}): Promise<{ wrote: LoopSupervisorInstallation['wrote']; reason: string | null; unitPath: string; launcherStale?: boolean }> {
  const unitPath = join(loopUnitDirectory(host), input.unit ?? loopUnitOf(input.root, loopUnitDirectory(host), host.home));
  let existing: string | null = null;
  try { existing = await readFile(unitPath, 'utf8'); } catch { existing = null; }
  if (existing === null) return { wrote: 'none', reason: `${unitPath} is not installed; graphyard master init installs it`, unitPath };
  const wanted = loopUnitText(input);
  // An install upgraded past GY-2877 has a matching loop unit and no deploy unit, or (GY-2942) one
  // that deploys from a shared checkout: install or rewrite it too.
  const deployPath = join(loopUnitDirectory(host), deployUnitOf({ master: basename(unitPath) }));
  const deployStale = await readFile(deployPath, 'utf8').catch(() => null) !== deployUnitText(input);
  if (existing === wanted && !deployStale) return { wrote: 'unchanged', reason: null, unitPath };
  const installed = await installLoopSupervisor(input, host, { restart: false });
  if (deployStale && installed.wrote === 'unchanged') return { wrote: 'created', reason: `wrote ${deployPath}`, unitPath };
  // GY-1790: a refused rewrite says whether the installed unit still starts a launcher other than
  // the one it must — the checkout's under a snapshot's pin, a snapshot's once the pin is lifted —
  // which withholds the restart that would go through it; a refusal over any other setting does not.
  const home = host.home ?? ((host.env ?? process.env).HOME?.trim() || homedir());
  return { wrote: installed.wrote, reason: installed.refused ?? installed.reason, unitPath,
    ...(installed.wrote === 'refused' ? { launcherStale: unitSetting(existing, 'ExecStart', home) !== unitSetting(wanted, 'ExecStart', home) } : {}) };
}

/** The same facts, observed rather than installed: what `master status` reports about supervision. */
export async function loopSupervision(input: Pick<LoopUnitInput, 'root' | 'cliPath'>, host: LoopSupervisorHost = {}): Promise<LoopSupervision> {
  const support = supervisorSupport(host);
  const loopUnit = loopUnitOf(input.root, loopUnitDirectory(host), host.home);
  const unitPath = join(loopUnitDirectory(host), loopUnit);
  if (!support.supported) return { supported: false, unit: loopUnit, unitPath: null, installed: false, enabled: null, active: null, linger: null,
    reason: support.reason, instruction: unsupervisedInstruction(input), ...(support.unreachable ? { unreachable: true } : {}) };
  const run = supervisorRun(host);
  // Reading supervision must never be able to fail a report: an unreadable unit file is one signal
  // missing, and systemd's own answer below still decides whether a unit is installed.
  let installed = false;
  try { await readFile(unitPath, 'utf8'); installed = true; } catch { installed = false; }
  const observed = observeUnit(run, loopUnit);
  // A unit systemd knows by another path (a packaged or hand-placed one) is installed too.
  installed ||= observed.enabledState !== null && observed.enabledState !== 'not-found';
  const unreadable = [observed.enabled === null ? 'enabled' : null, observed.active === null ? 'active' : null].filter(Boolean).join(' and ');
  // Lingering is read, never assumed: a host that cannot answer leaves it unknown rather than false.
  // `show-user` needs the user named: without one it shows the login manager, which has no Linger
  // property and answers nothing, and the reboot half of the restart policy went unverified.
  let linger: boolean | null = null;
  try { const answer = run('loginctl', ['show-user', supervisedUser(), '--property=Linger', '--value']).trim().toLowerCase(); linger = answer === 'yes' ? true : answer === 'no' ? false : null; } catch { linger = null; }
  return { supported: true, unit: loopUnit, unitPath, installed, enabled: installed ? observed.enabled : false, active: installed ? observed.active : false, linger,
    instruction: null, reason: unreadable ? `systemd did not report whether the unit is ${unreadable}` : null };
}

/**
 * Supervision that is missing, disabled, or stopped, each with the command that fixes it.
 * Verified rather than assumed: a loop nobody restarts is named here while the pipeline still
 * looks busy, which is the whole gap between GY-84's promise and what it delivered.
 */
export function loopSupervisionAttention(supervision: LoopSupervision, evidence?: LoopSupervisorEvidence | null): { text: string; next: string }[] {
  const reinstall = 'graphyard master init --token-stdin on this host reinstalls and enables the loop unit; repository setup is what installs it';
  // A probe that cannot reach the user manager — inside a worker's or the doctor's sandbox, where
  // the user bus is masked — says nothing about the host while the cursor records the loop running
  // under its unit (GY-1400): it is a vantage that could not verify, never a host-supervision fault.
  if (!supervision.supported && supervision.unreachable && (evidence?.unit || evidence?.reexecuted))
    return [{ text: `Whether the master loop is supervised could not be verified from this vantage: ${supervision.reason}. The daemon cursor records the loop running under ${evidence.unit ?? supervision.unit}${evidence.reexecuted ? ' (its last self-upgrade re-executed it through that unit)' : ''}, so this is the reading process's sandbox, not the host`,
      next: `systemctl --user status ${evidence.unit ?? supervision.unit} from a host shell outside any sandbox` }];
  if (!supervision.supported) return [{ text: `The master loop is not supervised on this host: ${supervision.reason}. A crash or a reboot leaves it down until somebody starts it`, next: supervision.instruction! }];
  if (!supervision.installed) return [{ text: `The master loop has no supervisor installed on this host (${supervision.unit} is not present), so nothing restarts it after a crash or a reboot and its own restart attention item has nobody to act on it`, next: reinstall }];
  const items: { text: string; next: string }[] = [];
  if (supervision.enabled === false) items.push({ text: `The master loop's supervisor ${supervision.unit} is installed but disabled, so it does not start at boot`, next: `systemctl --user enable --now ${supervision.unit}` });
  if (supervision.active === false) items.push({ text: `The master loop's supervisor ${supervision.unit} is installed but not running, so the loop is not being kept alive`, next: `systemctl --user start ${supervision.unit}` });
  if (supervision.enabled === null || supervision.active === null) items.push({ text: `Whether the master loop is supervised could not be verified: ${supervision.reason ?? 'systemd did not answer'}`, next: `systemctl --user status ${supervision.unit}` });
  if (supervision.linger === false) items.push({ text: `The master loop's supervisor is enabled, but this user's systemd manager may not start at boot, so a reboot can leave the loop down`, next: 'loginctl enable-linger (or, as root, loginctl enable-linger USER)' });
  return items;
}

/** The supervisor unit the loop itself runs under, when systemd supervises it: read from the process's own cgroup, like an executor's. */
export const loopUnitPattern = /^graphyard-master(?:[@.-][A-Za-z0-9@._:-]*)?\.service$/;
export function detectLoopSupervisorUnit(options: { cgroup?: string | null } = {}): string | null {
  let cgroup = options.cgroup;
  if (cgroup === undefined) { try { cgroup = readFileSync('/proc/self/cgroup', 'utf8'); } catch { cgroup = null; } }
  const match = cgroup?.match(/\/(graphyard-master[^/\s]*\.service)(?:\/|$)/m);
  return match && loopUnitPattern.test(match[1]) ? match[1] : null;
}

/**
 * Whether the awaited `systemctl --no-block restart` ended because the restart it queued began
 * (GY-916). The loop asks systemd to restart the very unit it runs in, so the queued stop signals
 * the unit's whole cgroup — the systemctl child and the loop alike — while the loop still awaits
 * that child. The child then dies on the stop's signal instead of exiting: that is the hand-off
 * succeeding, observable in the journal as Stopping → Stopped → Started in the same second. Both
 * halves are required: the child ended by a stop signal with no exit status and no timeout of its
 * own, and the loop itself received the stop during the wait (`awaitSupervisorRestart` marks it).
 * A child signalled by anything else, a systemctl that exited non-zero (no such unit, no user
 * bus, access denied), or one cut off by its own timeout is a genuine failure and is recorded.
 */
export function restartEndedBySupervisorStop(error: unknown): boolean {
  const ended = error as { signal?: unknown; status?: unknown; timedOut?: unknown; supervisorStop?: unknown } | null;
  return !!ended && typeof ended === 'object' && ended.supervisorStop === true && typeof ended.signal === 'string' && supervisorStopSignals.includes(ended.signal)
    && (ended.status === null || ended.status === undefined) && ended.timedOut !== true;
}
/** The signals a unit's stop delivers to its cgroup: KillSignal, then SIGKILL past TimeoutStopSec. */
const supervisorStopSignals = ['SIGTERM', 'SIGKILL'];
/** How long a signalled child waits for the loop's own stop signal to arrive beside it; both come from one stop. */
export const supervisorStopGraceMs = 2_000;
type SignalHost = Pick<NodeJS.EventEmitter, 'on' | 'removeListener'>;

/**
 * Runs the self-restart while watching for the supervisor's stop to reach this process (GY-916).
 * When the restart child fails on a signal, the stop that killed it reaches the loop in the same
 * instant, so it is awaited for at most `graceMs`; the failure is rethrown marked with whether it
 * came — the mark `restartEndedBySupervisorStop` requires.
 */
export async function awaitSupervisorRestart(restart: () => unknown, host: SignalHost = process, graceMs = supervisorStopGraceMs): Promise<void> {
  let stopped = false, wake: (() => void) | null = null;
  const onStop = () => { stopped = true; wake?.(); };
  host.on('SIGTERM', onStop);
  try { await restart(); }
  catch (error) {
    const signalled = !!error && typeof error === 'object' && typeof (error as { signal?: unknown }).signal === 'string';
    if (signalled && !stopped) await new Promise<void>(resolve => { const timer = setTimeout(resolve, graceMs); wake = () => { clearTimeout(timer); resolve(); }; });
    throw error && typeof error === 'object' ? Object.assign(error, { supervisorStop: stopped }) : error;
  } finally { host.removeListener('SIGTERM', onStop); }
}
