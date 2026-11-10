// Concern: launching an agent session — request files, start observation, prompt delivery and acknowledgement.
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { slotsDirectoryVariable } from './verification-slots.js';
import { confinedRuntimeArgs } from '../worker-sandbox.js';
import { type ChildRun, childRunner, defaultChildRun } from '../child-runner.js';
import { assertSessionName, SessionNameRefusedError } from '../session-name.js';
import { requestPlaceholder, type RegisteredLaunch, assertLaunchable, LaunchRefusedError, launchRecipe } from '../harness.js';
import { runtimeAdapter } from './runtimes.js';
import { realRuntimeBinary } from '../runtime-binary.js';
import { withAutonomyContract } from '../autonomy.js';
import { underTestRunner } from '../runtime-environment.js';
import type { PartialWork } from '../model/capacity.js';
import { type ConsentPrompt, detectConsentPrompt, screenDialog, settingsWarning, type ConsentAnswer, sameConsentPrompt } from '../consent-prompt.js';
import { assertIsolatableHostControlEndpoints } from './confinement.js';
import { dataDirectory } from '../install/worktree-root.js';
import { bwrapOnPath, masterConfinementVariable, confinementRefusalText, coordinatorConfinement, coordinatorConfinementRefusal, mountNamespaceProbeResult, readOnlyMountWrapper, assertCredentialsMasked, type CoordinatorConfinement, type ConfinementInput, type CredentialMask, type MaskProbe } from './confinement.js';
import { runtimeLoginHomes, checkoutGitDirectory, checkoutGitProblem, checkoutWorktreeAdminDirectory, coordinatorCheckoutRoot } from './profiles.js';
import type { MasterRun } from './profiles.js';
import { createdHerdrTab, type HerdrAgent, herdrCall, herdrJson, herdrRun, stopCreatedHerdrTab } from './herdr.js';
import { herdrErrorText, nameRefusedByRuntime, sessionWords, type PromptDelivery } from './prompt-delivery.js';
import { keyringEndpointWarning, keyringProbeBackoff } from './launch-keyring.js';
import { masterRecords } from './conversation.js';
// Prompt delivery moved to prompt-delivery.ts (GY-1863) with the screen a stalled delivery is
// judged by; the names below are the one address every existing import has always had.
export { promptAttempts, promptAcceptMs, promptRetryPauseMs, noticeSettleMs, PromptNotAcceptedError, herdrErrorCode, herdrErrorText, nameRefusedByRuntime, deliverPrompt, readSessionScreen, sessionWords, type PromptDelivery } from './prompt-delivery.js';

/**
 * Keep what an interrupted attempt had not committed. The work is committed on the attempt's own
 * branch in its own worktree — never pushed, never stashed (the stash is shared by every
 * worktree) — so the next attempt can read or cherry-pick it and nothing of it is lost. Only when
 * it cannot be committed is the worktree reset, and the record says discarded: an attempt never
 * ends with changes that are neither kept nor gone.
 */
export async function preservePartialWork(path: string, label: string, run: ChildRun = childRunner({ timeoutMs: 60_000 })): Promise<PartialWork> {
  const git = async (...args: string[]) => (await run('git', ['-C', path, ...args])).trim();
  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD').catch(() => undefined);
  const described = { path, ...(branch && branch !== 'HEAD' ? { branch } : {}) };
  if (!await git('status', '--porcelain')) return { state: 'clean', commit: await git('rev-parse', 'HEAD'), ...described, detail: 'the worktree held no uncommitted change; every commit of the attempt is on its branch' };
  try {
    await git('add', '-A');
    await git('-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@localhost', 'commit', '--no-verify', '-m', `WIP: ${label}`);
    return { state: 'committed', commit: await git('rev-parse', 'HEAD'), ...described, detail: 'uncommitted changes were committed on the attempt branch, unpushed' };
  } catch (error) {
    await git('reset', '--hard'); await git('clean', '-fd');
    return { state: 'discarded', commit: await git('rev-parse', 'HEAD'), ...described, detail: `uncommitted changes could not be committed and were discarded: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) };
  }
}

/**
 * The instruction a launched session starts on, as the session's own first request.
 *
 * `herdr agent prompt` types its text into the running session through bracketed paste, and a
 * coding agent treats pasted text as untrusted data rather than as a request from its operator —
 * correctly, against prompt injection — so a session launched that way often ends its first turn
 * having refused to act (GY-93). Every runtime Graphyard launches takes an initial prompt on its
 * own command line instead, where it is the user's own first message: Claude Code, Codex and
 * Cursor as a positional argument after their flags, OpenCode through `--prompt`. A runtime with
 * no such contract keeps the paste, and the record says so.
 *
 * What is typed into the pane is short and constant-size (GY-121). Herdr types a launch command
 * into an interactive shell keystroke by keystroke and the shell redraws the line as it grows, so
 * a multi-kilobyte request took the whole start bound to echo under host load and the runtime was
 * declared dead before it existed. The request and the role authorization are written to files
 * inside the session's own checkout directory instead (`.graphyard/launch/NAME.request` and
 * `NAME.role`, mode 0600, removed with the checkout), and the command line references them by
 * their shared stem, `GY=DIR/.graphyard/launch/NAME;`: the role file through the runtime's own
 * flag (`--append-system-prompt-file "$GY.role"`), the request through the shell's own
 * substitution (`"$(cat "$GY.request")"`), which the interactive POSIX shell expands before the
 * runtime starts, so the text is still the runtime's own first argument and never a paste. The
 * typed line holds only the runtime, its flags and one path, and is bounded by
 * `launchCommandLimit` whatever the request is.
 */
export type RequestDelivery = 'request' | 'paste';
export const launchDelivery = (kind: string | undefined, args: string[] = []): RequestDelivery => kind && (runtimeAdapter(kind)?.request || args.includes(requestPlaceholder)) ? 'request' : 'paste';
/**
 * A session's instruction is its own first request, on the runtime's command line, never a paste
 * (GY-93): a runtime without a way to take it there is refused before launch, naming the runtime
 * and the fix, rather than started and handed text it may rightly treat as untrusted (GY-184).
 */
export const requestContractRefusal = (kind: string) => `Graphyard refuses to launch the ${kind} runtime: it has no way to take the session's first request on its command line, and a launched session's instruction is never pasted into it. Register where ${kind} takes its first prompt with graphyard master registry runtime set NAME --kind ${kind} --arg=${requestPlaceholder} (or --arg=FLAG --arg=${requestPlaceholder}) --reason REASON.`;
/** The most bytes a launch command line may hold: the runtime, its flags and two file paths, never the request. */
export const launchCommandLimit = 512;
export const launchDirectory = (directory: string) => resolve(directory, '.graphyard/launch');
/** The session's launch files: `stem` is `DIR/.graphyard/launch/NAME`, and each file present is `STEM.role` or `STEM.request` (and `STEM.launch`, the runtime's words, for a line that would exceed the bound). */
export interface LaunchFiles { stem: string; role: string | null; request: string | null }
/** A word for the pane's shell: bare when it needs no quoting, single-quoted otherwise. */
export const shellWord = (value: string) => /^[A-Za-z0-9_./:=@%+,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
/** The shell variable the command line binds to the stem, so each file is referenced once and the line stays short. */
export const launchVariable = 'GY';
const roleReference = `"$${launchVariable}.role"`, requestReference = `"$(cat "$${launchVariable}.request")"`, launchScriptReference = `"$${launchVariable}.launch"`;
/**
 * Writes the session's request and role authorization where its command line reads them: private
 * files under the checkout's own `.graphyard/launch/`, holding the exact text, replaced on every
 * launch under the same name and removed with the checkout.
 */
export function writeLaunchFiles(directory: string, name: string, text: { role?: string | null; request?: string | null }): LaunchFiles {
  const folder = launchDirectory(directory);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const stem = resolve(folder, name);
  const write = (suffix: string, value: string | null | undefined) => {
    if (value === null || value === undefined) return null;
    writeFileSync(`${stem}.${suffix}`, value, { mode: 0o600 }); chmodSync(`${stem}.${suffix}`, 0o600);
    return `${stem}.${suffix}`;
  };
  return { stem, role: write('role', text.role), request: write('request', text.request) };
}

// ---- The confinement a session launch carries (GY-888) -------------------------------------------
//
// Every session the launcher starts — worker, reviewer, producer and approver, in a Herdr pane or
// headless — runs so that the coordinator checkout this launcher itself runs from is unwritable at
// the OS level: a codex workspace-write sandbox confines it by leaving it ungranted, every other
// runtime runs inside a bubblewrap mount namespace that bind-mounts the checkout read-only (see
// profiles.ts). A launch that can carry no confinement is refused with the reason named, never
// started unconfined. The master session is confined as well (GY-1658, `confinement: 'master'`):
// it runs from the coordinator root with the checkout read-only, only its managed `.graphyard` state
// and the shared Git areas writable, in its own PID namespace with the host's process-launch channels
// hidden like every other session's — so no command it runs can start a host process that writes the
// checkout. The wrapper marks it (GRAPHYARD_CONFINEMENT=master), and its `master restart` files a
// request the loop serves (cli/master-checkout-restore.ts). Unconfined sessions patched the serving
// checkout until the GY-857 guard refused every loop start on it.

/**
 * Whether `argv1` is one of the launcher's own entries: `bin/graphyard.mjs` or the `src/cli.ts`
 * child it spawns — in each the checkout is two levels up.
 */
const cliEntry = (argv1: string) => ['graphyard.mjs', 'cli.ts'].includes(basename(argv1));
/**
 * The coordinator checkout the launching process itself runs from, or null when this is not the
 * Graphyard CLI or the test runner is driving: nothing is confined there. Both entries count —
 * `bin/graphyard.mjs`, which operators and prompts invoke, and the `src/cli.ts` child it spawns,
 * which is what `process.argv[1]` holds inside the loop — so a launch is never confined against
 * the wrong tree, and never silently unconfined in production (GY-888).
 */
export const launcherCoordinatorRoot = (argv1: string | undefined = process.argv[1], testRunner: boolean = underTestRunner()): string | null => {
  if (!argv1 || testRunner || !cliEntry(argv1)) return null;
  // GY-1790: an entry the restart started from the held snapshot is handed the checkout it serves
  // in the environment; confinement guards that checkout, not the snapshot's own tree.
  const handed = process.env.GRAPHYARD_CHECKOUT_ROOT?.trim();
  const root = handed || coordinatorCheckoutRoot(resolve(argv1));
  return root && root !== '/' ? root : null;
};
/** Why the running process is the launcher yet its own coordinator checkout cannot be derived — the launch would start unconfined, so the caller refuses (GY-888); null when there is nothing to refuse on. */
export const launcherRootUndetermined = (argv1: string | undefined = process.argv[1], testRunner: boolean = underTestRunner()): string | null => {
  if (!argv1 || testRunner || !cliEntry(argv1)) return null;
  // GY-1790: a snapshot entry is handed its checkout in the environment, so its root is determined.
  if (process.env.GRAPHYARD_CHECKOUT_ROOT?.trim()) return null;
  const root = coordinatorCheckoutRoot(resolve(argv1));
  return root && root !== '/' ? null : `this launcher's coordinator checkout could not be derived from its entry ${argv1}`;
};
/**
 * The shared Git paths a confined session's linked worktree writes that may not exist yet — the
 * `graphyard/` branch namespace and its reflogs — plus an empty FETCH_HEAD for the fetches a
 * reviewer or producer runs from the coordinator root. Each is created before the confinement is
 * built, so coordinatorConfinement re-exposes it; the launcher itself is not confined. The paths
 * resolve through `checkoutGitDirectory`/`checkoutWorktreeAdminDirectory`: when the coordinator is
 * itself a linked worktree its `.git` is a pointer file, and creating them there would fail under a
 * file instead of preparing the real common Git directory and the checkout's own worktree admin
 * (GY-957, review finding).
 */
export function prepareConfinedGitPaths(root: string): void {
  const gitDir = checkoutGitDirectory(root);
  if (!existsSync(gitDir)) return;
  for (const path of [join(gitDir, 'refs', 'heads', 'graphyard'), join(gitDir, 'logs', 'refs', 'heads', 'graphyard'), join(gitDir, 'refs', 'remotes'), join(gitDir, 'logs', 'refs', 'remotes')]) mkdirSync(path, { recursive: true });
  const fetchHead = join(checkoutWorktreeAdminDirectory(root) ?? gitDir, 'FETCH_HEAD');
  if (!existsSync(fetchHead)) closeSync(openSync(fetchHead, 'a'));
}
export { masterConfinementVariable };
/** What a master-session confinement is judged against; tests name an absent bubblewrap or another platform. */
export interface MasterConfinementProbe { bwrap?: string | null; platform?: string; mountNamespaceWorks?: boolean }
/**
 * The master session's confinement (GY-1658): the coordinator checkout at `root` bind-mounted
 * read-only, with the checkout's managed `.graphyard` state and the shared Git areas a coordinator
 * session writes (objects, worktrees, `graphyard/` branches, remote-tracking refs, FETCH_HEAD)
 * re-exposed, in a PID namespace with the host's systemd and bus sockets hidden (the keyring-only
 * proxy stands in for the session bus), and GRAPHYARD_CONFINEMENT=master set. A host that cannot
 * build it refuses the launch with the named reason: the master is never started unconfined.
 */
export async function masterSessionConfinement(kind: string, root: string, probe: MasterConfinementProbe = {}, writable: readonly string[] = [], environment?: NodeJS.ProcessEnv, credentialMask?: CredentialMask, herdrPaths?: readonly string[]): Promise<CoordinatorConfinement> {
  const refusal = await coordinatorConfinementRefusal({ kind, args: [], coordinatorRoot: root, sessionDirectory: root, ...probe });
  if (refusal) throw new Error(`${refusal} The master session is refused rather than started with the checkout writable (GY-1658).`);
  prepareConfinedGitPaths(root);
  // The master's dispatches add worktrees: the shared worktrees area is re-exposed only where it exists.
  if (existsSync(checkoutGitDirectory(root))) mkdirSync(join(checkoutGitDirectory(root), 'worktrees'), { recursive: true });
  const managed = join(resolve(root), '.graphyard');
  mkdirSync(managed, { recursive: true, mode: 0o700 });
  // GY-3237: the Herdr socket and config the install records now — the main server after a
  // GY-3212 migration, a private instance while it drains — so `herdr agent list` and
  // `master review GY-N` reach it from inside the confinement.
  const [bwrap, ...words] = readOnlyMountWrapper({ coordinatorRoot: root, sessionDirectory: root, bwrap: probe.bwrap ?? undefined, writable: [managed, ...writable], environment, ...(credentialMask ? { credentialMask } : {}), ...(herdrPaths?.length ? { herdrPaths } : {}) });
  const records = masterRecords(root);
  mkdirSync(records, { recursive: true, mode: 0o700 });
  // Mount options precede the socket-confinement command inside bubblewrap.
  const command = words.indexOf('--');
  // GY-3237: the session's HOME is a scratch home, so the host's data directory is named outright:
  // the checkouts its `master review` allocates land in the host's managed worktree root, where
  // the Herdr pane the host starts for the reviewer finds them.
  const wrapper = [bwrap, '--setenv', masterConfinementVariable, 'master', '--setenv', 'GRAPHYARD_DATA_HOME', dataDirectory(), ...words.slice(0, command), '--ro-bind', records, records, ...words.slice(command)];
  await assertCredentialsMasked(wrapper, { coordinatorRoot: root, sessionDirectory: root, credentialMask });
  const reexposed = wrapper.filter((word, index) => index > 0 && wrapper[index - 1] === '--bind');
  return { mechanism: 'read-only-mount', wrapper, detail: `the coordinator checkout at ${resolve(root)} is bind-mounted read-only for the master session in a bubblewrap namespace whose /proc shows only its own processes and whose host systemd and bus sockets are hidden; only ${reexposed.join(', ')} are re-exposed writable, so no command it runs, nor any host process it could ask to start, can patch the checkout's tracked files` };
}
/** The master launch's confinement against the launcher's own checkout (or `coordinatorRoot`), derived as every other role's is: null only where nothing is confined (the test runner, a non-CLI launcher), the named refusal when the launcher's checkout cannot be derived. */
async function masterLaunchConfinement(kind: string, options: Pick<SessionStart, 'coordinatorRoot' | 'directory' | 'confinementProbe' | 'environment' | 'masterStateDirectory' | 'stateDirectories' | 'contract' | 'credentialMask' | 'herdrPaths'>): Promise<CoordinatorConfinement | null> {
  const root = options.coordinatorRoot !== undefined ? options.coordinatorRoot : launcherCoordinatorRoot();
  if (root) {
    return masterSessionConfinement(kind, root, options.confinementProbe, [
      ...runtimeLoginHomes(options.environment, options.contract?.homeVariable),
      ...(options.masterStateDirectory ? [options.masterStateDirectory] : []),
      ...(options.stateDirectories ?? []),
    ], options.environment, options.credentialMask, options.herdrPaths);
  }
  const undetermined = launcherRootUndetermined();
  if (undetermined) throw new Error(confinementRefusalText(kind, options.directory, { undetermined }));
  return null;
}
/** The confinement the launch of `kind` carries, or null when nothing needs confining; throws the named refusal when the kind can carry none, or when the launcher's own checkout cannot be derived while running as the launcher. `coordinatorRoot` overrides the derived one, for a launcher embedded outside the CLI. The sandbox-claim check models the runtime's workspace root as its working directory (`cwd` when the pane starts elsewhere, GY-888); the read-only mount re-exposes the allocated `directory` separately, so a terminal reviewer or producer that starts from the coordinator root still gets its own checkout writable while the root stays read-only (GY-888, review finding). The `credentialMask` hides the install's credential locations from the session (GY-1856). */
export async function sessionConfinement(kind: string, args: readonly string[], options: { cwd?: string; directory: string; environment?: Record<string, string>; writable?: readonly string[]; ownGitHubCredential?: boolean; secretsBus?: null; credentialMask?: CredentialMask; maskProbe?: MaskProbe | null }, coordinatorRoot: string | null | undefined = undefined): Promise<CoordinatorConfinement | null> {
  assertIsolatableHostControlEndpoints({ ...process.env, ...options.environment });
  const root = coordinatorRoot !== undefined ? coordinatorRoot : launcherCoordinatorRoot();
  if (!root) {
    const undetermined = launcherRootUndetermined();
    if (undetermined) throw new Error(confinementRefusalText(kind, options.directory, { undetermined }));
    return null;
  }
  const workspaceRoot = resolve(options.cwd ?? options.directory), allocated = resolve(options.directory);
  const input: ConfinementInput = { kind, args, environment: options.environment, coordinatorRoot: root, writable: [...(options.writable ?? []), ...(options.environment?.[slotsDirectoryVariable] ? [options.environment[slotsDirectoryVariable]] : [])], sessionDirectory: workspaceRoot, ...(allocated === workspaceRoot ? {} : { allocatedDirectory: allocated }), ...(options.ownGitHubCredential ? { ownGitHubCredential: true } : {}), ...(options.secretsBus === null ? { secretsBus: null } : {}), ...(options.credentialMask ? { credentialMask: options.credentialMask } : {}), ...(options.maskProbe !== undefined ? { maskProbe: options.maskProbe } : {}) };
  const refusal = await coordinatorConfinementRefusal(input);
  if (refusal) throw new Error(refusal);
  prepareConfinedGitPaths(root);
  return coordinatorConfinement(input);
}
/**
 * The confinement words for a headless run whose working directory is `cwd`, or the refusal that
 * keeps it from starting (GY-888). Synchronous: the headless runner spawns without awaiting, so a
 * host whose namespaces are known-refused refuses here, and one whose probe has not answered yet
 * lets bubblewrap itself fail the spawn — either way the run fails instead of starting unconfined.
 * The spawner that applies these words is src/runner/roles.ts confiningSpawn, which hands them to
 * the runner's own spawn.
 */
export function headlessConfinementWrapper(root: string, cwd: string | undefined, bwrap: string | null = bwrapOnPath(), credentialMask?: CredentialMask, environment?: NodeJS.ProcessEnv): readonly string[] {
  const head = `A headless session cannot be started with the coordinator checkout at ${root} unwritable at the OS level`;
  if (cwd === undefined) throw new Error(`${head}: the run has no working directory to confine around. Graphyard never starts a session unconfined.`);
  if (!bwrap) throw new Error(`${head}: bubblewrap (bwrap) is not installed. Graphyard never starts a session unconfined; install bubblewrap (e.g. apt install bubblewrap).`);
  if (mountNamespaceProbeResult(bwrap) === false) throw new Error(`${head}: this host refuses the unprivileged namespaces bubblewrap needs. Graphyard never starts a session unconfined; allow unprivileged user namespaces on this host.`);
  const gitProblem = checkoutGitProblem(root);
  if (gitProblem) throw new Error(`${head}: the Git directory it writes through cannot be resolved — ${gitProblem}. Graphyard never starts a session unconfined.`);
  prepareConfinedGitPaths(root);
  return readOnlyMountWrapper({ coordinatorRoot: root, sessionDirectory: resolve(cwd), bwrap, environment, ...(credentialMask ? { credentialMask } : {}) });
}
/** The command that starts a runtime of `kind`: its recipe's `program` (Cursor's `agent`, GY-976), otherwise the kind's own name. */
export const launchProgram = (kind: string) => launchRecipe(kind)?.program ?? kind;
/** The command line typed into the pane: the stem binding, then `prefix` (a supervisor), `wrap` (the coordinator confinement), the runtime (its real binary, never a mise shim: GY-3236), its arguments and the file references. */
export function launchCommand(kind: string, args: string[], files: LaunchFiles, prefix: string[] = [], wrap: readonly string[] = [], environment: Record<string, string> = {}) {
  if (wrap.length) args = confinedRuntimeArgs(kind, args);
  const role = files.role ? runtimeAdapter(kind)?.role?.(roleReference) : undefined;
  const own = runtimeAdapter(kind)?.request;
  const request = files.request && own ? own(requestReference) : undefined;
  // A registry runtime's request goes where its contract places `{request}`; a built-in one drops the marker.
  const placed = args.map(argument => argument !== requestPlaceholder ? shellWord(argument) : files.request && !own ? requestReference : null).filter((word): word is string => word !== null);
  const binding = role || request || placed.includes(requestReference) ? [`${launchVariable}=${shellWord(files.stem)};`] : [];
  // Reapply the selected environment after interactive shell startup (which can reset PATH).
  const selected = Object.entries(environment).map(([key, value]) => shellWord(`${key}=${value}`));
  const runtime = [...(selected.length ? ['/usr/bin/env', ...selected] : []), ...prefix.map(shellWord), ...wrap.map(shellWord), shellWord(realRuntimeBinary(launchProgram(kind), { ...process.env, ...environment })), ...placed, ...(role ? [role] : []), ...(request ? [request] : [])].join(' ');
  let command = [...binding, runtime].join(' ');
  // The runtime's flags can name long paths (a producer's checkout and the shared Git directory as
  // Codex writable roots), so a line over the bound moves them into `STEM.launch`, beside the other
  // launch files, and the typed line only binds the stem and sources it: the pane's own shell still
  // starts the runtime on the same words, and the request is still its first argument. Only a stem
  // too long to leave room for that is refused.
  if (Buffer.byteLength(command) > launchCommandLimit) {
    command = `${launchVariable}=${shellWord(files.stem)}; . ${launchScriptReference}`;
    if (Buffer.byteLength(command) <= launchCommandLimit) { writeFileSync(`${files.stem}.launch`, `${runtime}\n`, { mode: 0o600 }); chmodSync(`${files.stem}.launch`, 0o600); return command; }
  }
  const bytes = Buffer.byteLength(command);
  if (bytes > launchCommandLimit) throw new Error(`the launch command line is ${bytes} bytes, over the ${launchCommandLimit}-byte bound; it holds only the path of the session's launch files, so shorten the repository path or the managed worktree root: ${command.slice(0, 160)}…`);
  return command;
}

/**
 * The start bound reads the pane rather than guessing against a clock (GY-121). Herdr's `agent
 * get` names the runtime occupying the pane and whether it is ready; the pane's text shows the
 * runtime's own screen — its banner, its spinner over the request it is already working on —
 * before Herdr classifies it, or the launch command still echoing, or the runtime's own error.
 * The producers this item was filed for died exactly there: Claude Code was on screen with its
 * spinner while Herdr still reported it `unknown` at 30 s, and the launcher closed a live session.
 *
 * A runtime seen ready within `agentStartTimeoutMs` has started: Herdr reports it `idle` or
 * `done`, or `working` for a session already at work on its own request — or Herdr reports the
 * runtime under the pane, whatever it makes of its state, and the runtime's screen is showing:
 * that session is adopted, never closed. A runtime still to be prompted must be reported idle.
 * One that is *starting* at the bound — its process exists under the pane but nothing of it is on
 * screen yet, or its banner is on screen before Herdr sees a process — is given until
 * `agentStartCeilingMs`; one that is absent at the bound never started; one `blocked` before it
 * is ready sits at a dialog no launcher answers and is refused at once, as before. Every refusal
 * names which case it saw and the pane's last non-empty line, bounded, so the operator reads
 * `command still echoing`, the dialog, or the runtime's own words rather than Herdr's
 * `agent_not_found`.
 */
export const agentStartTimeoutMs = 60_000, agentStartCeilingMs = 120_000, startPollMs = 500, paneLineLimit = 200;
/**
 * The start bound scales with the host (GY-413): `run.launchStartSeconds` (10–600, default 60).
 * Under load the launch command was still echoing at 30 s — a slow start, not a failure — and the
 * launcher closed a session that would have come up. Every launch logs how long its start took.
 */
export const defaultLaunchStartSeconds = agentStartTimeoutMs / 1000;
export const launchStartMs = (config: { run: Pick<MasterRun, 'launchStartSeconds'> }) => (config.run.launchStartSeconds ?? defaultLaunchStartSeconds) * 1000;
export const startedStates = ['idle', 'done', 'working'], promptableStates = ['idle', 'done'];
export type StartState = 'ready' | 'starting' | 'absent' | 'blocked' | 'consent' | 'exited';
export interface StartObservation { state: StartState; agent: HerdrAgent | null; detail: string; line: string; prompt?: ConsentPrompt }
export interface StartBounds { timeoutMs?: number; ceilingMs?: number; pollMs?: number; clock?: () => number; /** The pause between polls; a test's advances a virtual clock, the process's awaits a timer. */ wait?: (ms: number) => void | Promise<void>; /** The states that count as ready; `startedStates` unless the runtime is still to be prompted. */ readyStates?: string[];
  /** Whether a session stopped on a consent prompt the launcher does not answer is held for a human (a worker, whose supervisor bounds the hold) rather than refused. */ holdConsent?: boolean;
  /** Where the start's duration is logged (GY-413); standard error unless a caller collects it. */ log?: (line: string) => void }
export class SessionStartError extends Error {
  constructor(readonly startCase: 'never started' | 'still starting' | 'blocked' | 'awaiting consent' | 'exited', readonly pane: string, readonly screen: string, readonly waitedMs: number, message: string) { super(message); }
}
/**
 * How many times the launcher answers one allow-listed prompt before it treats the prompt as one it
 * cannot answer, and how long an answered dialog is given to close before it is answered again — a
 * second keystroke into a dialog that was already closing would land in the runtime's input.
 */
export const consentAnswerAttempts = 2, consentSettleMs = 5_000;
/** The pane's terminal as text, unwrapped; null when Herdr cannot read it. */
export async function readPaneScreen(pane: string, run: ChildRun = defaultChildRun, lines = 40) {
  try { return String(await herdrCall(run, ['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', String(lines)])); } catch { return null; }
}
/** The pane's last non-empty line, bounded for a record. */
export function paneLastLine(text: string | null, limit = paneLineLimit) {
  const line = (text ?? '').split('\n').map(entry => entry.replace(/\s+/g, ' ').trim()).filter(Boolean).at(-1) ?? '';
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}
/** Whether the pane's last line is the launch command itself — typed, or still being typed — and not yet answered: it opens with the stem binding and names the runtime. */
export const commandEchoing = (line: string, command: string) => !!line && (line.includes(command.slice(0, 24)) || (line.includes(`${launchVariable}=`) && line.includes(` ${command.replace(/^GY=\S+; /, '').split(' ')[0]}`)));
/** How many of the runtime's last printed lines an exit at start quotes. */
export const exitedLineLimit = 5;
/**
 * What the runtime printed after the launch command, when the pane's screen shows that command
 * echoed with output below it (GY-976): the lines below its last echo, less the shell's new prompt
 * (the echo line's own text before the command), bounded to the last `exitedLineLimit`. Null when
 * the command is not on screen or nothing follows it yet. Output below the command proves the
 * runtime ran only together with the shell back in the pane's foreground (shellInForeground).
 */
export function outputAfterCommand(screen: string | null, command: string) {
  const lines = (screen ?? '').split('\n').map(entry => entry.replace(/\s+/g, ' ').trim());
  const echoed = lines.findLastIndex(line => commandEchoing(line, command));
  if (echoed < 0) return null;
  const echo = lines[echoed], start = [command.slice(0, 24), `${launchVariable}=`].map(marker => echo.indexOf(marker)).filter(index => index >= 0);
  const prompt = echo.slice(0, Math.min(...start)).trim();
  const after = lines.slice(echoed + 1).filter(Boolean);
  let prompted = false;
  while (prompt && after.length && after.at(-1) === prompt) { after.pop(); prompted = true; }
  // A two-line prompt draws its first line again above the new prompt line.
  if (prompted && echoed > 0 && lines[echoed - 1] && after.at(-1) === lines[echoed - 1]) after.pop();
  return after.length ? after.slice(-exitedLineLimit).map(line => line.length > paneLineLimit ? `${line.slice(0, paneLineLimit)}…` : line) : null;
}
/** Whether an argv word is the graphyard CLI: `graphyard`, or its `graphyard.mjs` script, by basename. */
const graphyardCli = (word: string) => (word.split('/').at(-1) ?? '').replace(/\.[cm]?js$/, '') === 'graphyard';
/** The words a shell wrapper's `-c` string (`-c`, `-lc`, …) runs, split on whitespace (GY-1225); only a shell's: `grep -c` is not a wrapper. */
const wrappedWords = (argv: string[]) => /^(sh|bash|zsh|dash)$/.test(argv[0]?.split('/').at(-1) ?? '') ? argv.flatMap((word, index) => index > 0 && /^-[a-z]*c$/.test(argv[index - 1]) ? word.split(/\s+/).filter(Boolean) : []) : [];
/**
 * Whether a foreground process's argv is a `graphyard watch` supervisor (GY-1213): `watch`, right
 * after the graphyard CLI that runs it (GY-1225: not any bare `watch`, such as `sudo watch`), then
 * its operands and any flags, then the `--` that opens the runtime's command — however many words
 * lie between — or a shell wrapper's single `-c` string spelling the same. Pinned against
 * `launchCommand` with the supervisor prefix dispatch builds.
 */
export function supervisorArgv(argv: string[]) {
  return [argv, wrappedWords(argv)].some(words => words.some((word, at) => word === 'watch' && at > 0 && graphyardCli(words[at - 1]) && words.indexOf('--', at + 2) > 0));
}
/**
 * Whether a foreground process's argv runs `program` (GY-1213): a word, or a word of a wrapper's
 * `-c` string (only that string is split, GY-1225: `grep "run claude"` is not the runtime), whose basename is the program or an interpreter script named for it (`codex.js`).
 * A runtime started as a script of another name (`node …/cli.js`) is not recognised
 * by argv alone; its known screen can still identify it.
 */
export function runsProgram(argv: string[], program: string) {
  program = program.split('/').at(-1) ?? program;
  return [...argv, ...wrappedWords(argv)].some(word => { const base = word.split('/').at(-1) ?? ''; return base === program || base.replace(/\.[cm]?js$/, '') === program; });
}
/**
 * Who holds the pane's terminal foreground, as `herdr pane process-info` reports it: `shell` when
 * the pane's own shell does (nothing the launch typed is still running), `command` when another
 * process group does (the typed launch command — its supervisor, then the runtime — is executing),
 * null when Herdr cannot say. Given the runtime's program, a group Herdr lists the processes of is
 * told apart (GY-1184): `runtime` when an executable or interpreter script runs that program,
 * `supervisor` when only its `graphyard watch` supervisor is identified, `command` for a wrapper
 * still preparing that runtime, and `other` (naming it) when none is — an unrelated job left in a reused pane,
 * not this launch. The real Herdr lists them; a group listed empty stays `command`.
 */
export async function paneForeground(pane: string, run?: ChildRun, program?: string): Promise<'shell' | 'command' | 'supervisor' | 'runtime' | { other: string } | null> {
  try {
    const raw = await herdrJson(['pane', 'process-info', '--pane', pane], run);
    const info = raw?.process_info ?? raw;
    if (!Number.isSafeInteger(info?.shell_pid) || info.shell_pid <= 0 || !Number.isSafeInteger(info?.foreground_process_group_id) || info.foreground_process_group_id <= 0) return null;
    if (info.foreground_process_group_id === info.shell_pid) return 'shell';
    const processes: { argv?: unknown; name?: unknown }[] = Array.isArray(info.foreground_processes) ? info.foreground_processes : [];
    const argvs = processes.map(entry => Array.isArray(entry?.argv) ? entry.argv.filter((word): word is string => typeof word === 'string') : []);
    if (!program || !argvs.some(argv => argv.length)) return 'command';
    // A real runtime alongside its watch supervisor counts as the runtime. A
    // supervisor or mount wrapper merely naming it in later arguments does not.
    const direct = (argv: string[]) => !supervisorArgv(argv) && (runsProgram(argv.slice(0, 1), program)
      || /^(?:node|nodejs|bun|deno|python\d*(?:\.\d+)?)$/.test(argv[0]?.split('/').at(-1) ?? '') && runsProgram(argv.slice(1, 2), program));
    if (argvs.some(direct)) return 'runtime';
    if (argvs.some(supervisorArgv)) return 'supervisor';
    if (argvs.some(argv => runsProgram(argv, program))) return 'command';
    // The refusal names the process that was inspected: the first one listed with an argv.
    const at = argvs.findIndex(argv => argv.length), inspected = processes[at];
    const named = typeof inspected?.name === 'string' && inspected.name ? inspected.name : argvs[at][0].split('/').at(-1);
    return { other: named || 'an unnamed process' };
  } catch { return null; }
}
/** Whether the pane's own shell holds its terminal's foreground (paneForeground). False when Herdr cannot say. */
export async function shellInForeground(pane: string, run?: ChildRun) {
  return await paneForeground(pane, run) === 'shell';
}
export async function observeStart(pane: string, kind: string, command: string, run?: ChildRun, readyStates = startedStates): Promise<StartObservation> {
  let agent: HerdrAgent | null = null;
  try { const raw = await herdrJson(['agent', 'get', pane], run); agent = raw?.agent ?? raw ?? null; } catch { agent = null; }
  // Herdr can assign an agent name to a shell or pre-runtime wrapper. Read its
  // screen and foreground before accepting even a reported working state.
  const screen = await readPaneScreen(pane, run), last = paneLastLine(screen, Infinity), line = paneLastLine(screen);
  const showing = screen !== null && !!runtimeAdapter(kind)?.screen?.test(screen);
  let foreground: Awaited<ReturnType<typeof paneForeground>> | undefined;
  const readForeground = async () => (foreground !== undefined ? foreground : (foreground = await paneForeground(pane, run, launchProgram(kind))));
  // A runtime that printed below its command and handed the terminal back to the shell has exited
  // before it was ready — Cursor's IDE launcher saying "No Cursor IDE installation found", a
  // command not found — and nothing will start in that pane however long the bound (GY-976).
  const printed = outputAfterCommand(screen, command);
  if (printed && await readForeground() === 'shell') return { state: 'exited', agent, detail: `the ${kind} runtime exited back to the shell before it was ready`, line: printed.join(' | ') };
  // Tool-manager trust happens before the agent exists. Never hold it as agent consent,
  // grant global trust, or let a name assigned to this shell consume a worker lease.
  if (/^\s*mise(?:\s+(?:ERROR|WARN))?[^\n]*\b(?:not trusted|trust config|config[^\n]*trust)/im.test(screen ?? '')) return {
    state: 'blocked', agent, line: (screen ?? '').trim().slice(-1000),
    detail: 'mise stopped the launch before the agent started; select the installed runtime PATH and MISE_NO_CONFIG=1 in the registry runtime environment',
  };
  const holder = await readForeground();
  if (agent?.agent === kind && (holder === 'shell' || !showing && holder && typeof holder === 'object')) return {
    state: 'absent', agent: null, line,
    detail: holder === 'shell' ? 'the pane shell is still in the foreground; no agent runtime began' : `the pane foreground is held by ${holder.other}, not the agent runtime`,
  };
  const prompt = detectConsentPrompt(screen);
  if (prompt) return { state: 'consent', agent, detail: `the ${kind} runtime is awaiting consent on a ${prompt.kind} prompt`, line, prompt };
  // A runtime stopped on its own settings warning has not started either, whatever Herdr reports,
  // and is refused at once with the rules it named rather than the dialog's key hint.
  const warning = settingsWarning(screen);
  if (warning) return { state: 'blocked', agent, detail: warning, line };
  // An unread pane rules nothing out: an idle runtime may be sitting on a consent prompt, so it is
  // polled again until a read shows its screen, never taken as ready without one.
  if (screen === null && agent?.agent === kind && readyStates.includes(agent.agent_status ?? '')) return { state: 'starting', agent, detail: `Herdr reports the ${kind} runtime ${agent.agent_status} but its pane could not be read, so a consent prompt is not ruled out`, line };
  // A wrapper/supervisor's argv can name the runtime before it executes it. For
  // known runtimes require their own screen as well; unknown runtimes have only
  // the foreground-process contract to judge by.
  if (agent?.agent === kind && readyStates.includes(agent.agent_status ?? '') && (showing || !runtimeAdapter(kind)?.screen && holder === 'runtime')) return { state: 'ready', agent, detail: `Herdr reports the ${kind} runtime ${agent.agent_status}`, line: '' };
  // Blocked on a dialog nothing above recognises: the refusal names what the dialog asked (GY-1561).
  const dialog = agent?.agent === kind && agent.agent_status === 'blocked' ? screenDialog(screen) : null;
  if (agent?.agent === kind && agent.agent_status === 'blocked') return { state: 'blocked', agent, detail: dialog ? `Herdr reports it blocked on a dialog the launcher does not recognise: "${dialog}"` : 'Herdr reports it blocked', line };
  // Herdr sees the runtime's process and its screen is showing: a session at work that Herdr has
  // not classified yet, adopted rather than closed — unless it is still to be prompted, when only
  // Herdr's idle counts.
  if (agent?.agent === kind && showing && readyStates.includes('working')) return { state: 'ready', agent, detail: `the ${kind} runtime is on screen while Herdr reports it ${agent.agent_status ?? 'unknown'}`, line };
  if (agent?.agent === kind) return { state: 'starting', agent, detail: `the ${kind} runtime process exists under the pane, Herdr reports it ${agent.agent_status ?? 'unknown'}${showing ? ', its screen showing' : ''}`, line };
  if (agent?.agent && agent.agent !== kind) return { state: 'absent', agent: null, detail: `the pane holds ${agent.agent}, not ${kind}`, line };
  if (showing) return { state: 'starting', agent: null, detail: `the ${kind} banner is on screen`, line };
  // The launch command is on screen and still holds the pane's foreground: its supervisor is
  // setting up — containment calls to a control plane that may be slow under load — before it
  // spawns the runtime. That launch is starting, given until the ceiling, never refused as absent
  // at the bound (GY-1033). Its detail quotes what the supervisor last printed, if anything. Only
  // a pane whose shell is back in the foreground with nothing printed, or one Herdr cannot
  // describe, is absent. A pane where Herdr reports a different agent is absent (GY-1053). So is
  // one whose foreground Herdr lists as neither the supervisor nor the runtime (GY-1184): an
  // unrelated job is refused at the bound, not waited on to the ceiling.
  const echoing = !agent?.agent && (printed || commandEchoing(last, command));
  const held = echoing ? await readForeground() : null;
  if (held === 'runtime') return { state: 'starting', agent: null, line, detail: `the ${kind} runtime holds the pane's foreground before Herdr reports it` };
  if (held === 'command' || held === 'supervisor') {
    const said = printed?.at(-1);
    return { state: 'starting', agent: null, line, detail: said ? `the launch command is running, its supervisor setting up: "${said}"` : 'the launch command is running, its supervisor still setting up' };
  }
  if (held && typeof held === 'object') return { state: 'absent', agent: null, line, detail: `the pane's foreground is held by ${held.other}, not the launch command` };
  return { state: 'absent', agent: null, line, detail: agent?.agent ? `the pane holds ${agent.agent}, not ${kind}` : commandEchoing(last, command) ? 'command still echoing' : 'no runtime under the pane' };
}
export async function awaitRuntimeStart(pane: string, kind: string, command: string, run?: ChildRun, bounds: StartBounds = {}) {
  const timeoutMs = bounds.timeoutMs ?? agentStartTimeoutMs, ceilingMs = Math.max(timeoutMs, bounds.ceilingMs ?? agentStartCeilingMs), pollMs = bounds.pollMs ?? startPollMs;
  // The poll pause is awaited on the event loop, never spun on Atomics.wait: a launch that takes
  // the whole ceiling holds up only the launcher (GY-125).
  const clock = bounds.clock ?? Date.now, wait = bounds.wait ?? ((ms: number) => sleep(ms));
  const startedAt = clock();
  const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;
  let extended: string | null = null;
  const consent: ConsentAnswer[] = [];
  for (;;) {
    const observed = await observeStart(pane, kind, command, run, bounds.readyStates), waitedMs = clock() - startedAt;
    if (observed.state === 'ready') return { ...observed, waitedMs, extended, consent, awaiting: null };
    if (observed.state === 'consent') {
      const prompt = observed.prompt!, rule = prompt.rule;
      // Answers are counted per dialog, not per rule: a second dialog the same rule matches (a
      // crash-report question after a usage-statistics one) gets its own bounded attempts.
      const answered = consent.filter(answer => answer.rule === rule?.id && sameConsentPrompt({ kind: answer.kind, prompt: answer.prompt }, prompt));
      const answeredAt = answered.at(-1)?.at;
      if (answeredAt && clock() - Date.parse(answeredAt) < consentSettleMs && waitedMs < ceilingMs) { await wait(pollMs); continue; }
      // An allow-listed prompt is answered with its least-privilege option, and the answer is
      // recorded; the start bound keeps running, so a prompt that returns is not answered forever.
      if (rule && prompt.keys && answered.length < consentAnswerAttempts && waitedMs < ceilingMs) {
        await herdrRun(['pane', 'send-keys', pane, ...prompt.keys], run);
        consent.push({ rule: rule.id, kind: prompt.kind, prompt: prompt.text, answer: rule.answer, keys: prompt.keys, at: new Date(clock()).toISOString() });
        await wait(pollMs);
        continue;
      }
      // A workspace-trust prompt means the recipe's trust step did not take (GY-1152): the launch
      // fails naming it, and is never held as a session keeping its lease while it waits.
      if (prompt.kind === 'folder') throw new SessionStartError('awaiting consent', pane, prompt.text, waitedMs, `the ${kind} runtime stopped at a workspace-trust prompt in pane ${pane} although its launch records the folder trusted, so the launch failed rather than holding the lease for a human: "${prompt.text}"`);
      const why = rule ? `the launcher answered it ${consentAnswerAttempts} times and it is still showing` : `it is outside the launcher's consent allow-list`;
      // A session held for a human is reported, not refused: it has not taken its request, and it
      // is never counted as started. Everything else refuses the launch with the prompt's own text.
      if (bounds.holdConsent) return { ...observed, waitedMs, extended, consent, awaiting: { prompt: prompt.text, kind: prompt.kind, why } };
      throw new SessionStartError('awaiting consent', pane, prompt.text, waitedMs, `the ${kind} runtime is awaiting consent in pane ${pane} on a ${prompt.kind} prompt, and ${why}: "${prompt.text}"`);
    }
    if (observed.state === 'exited') throw new SessionStartError('exited', pane, observed.line, waitedMs, `the ${kind} runtime exited back to the shell in pane ${pane} before it was ready; it last printed: "${observed.line}"`);
    const quoted = observed.line ? `; the pane last showed: "${observed.line}"` : '; the pane showed nothing';
    if (observed.state === 'blocked') throw new SessionStartError('blocked', pane, observed.line, waitedMs, `the ${kind} runtime is blocked before it is ready in pane ${pane} (${observed.detail})${quoted}`);
    if (waitedMs >= timeoutMs && observed.state !== 'starting') throw new SessionStartError('never started', pane, observed.line, waitedMs, `the ${kind} runtime never started within ${seconds(timeoutMs)} in pane ${pane} (${observed.detail})${quoted}`);
    if (waitedMs >= ceilingMs) throw new SessionStartError('still starting', pane, observed.line, waitedMs, `the ${kind} runtime was still starting after ${seconds(ceilingMs)} in pane ${pane} (${observed.detail})${quoted}`);
    if (waitedMs >= timeoutMs) extended ??= `${observed.detail} at ${seconds(timeoutMs)}; waiting up to ${seconds(ceilingMs)}`;
    await wait(pollMs);
  }
}

/**
 * Start a session on its request: its files are written, the short command line is typed into the
 * pane, and the pane is read until the runtime is ready (awaitRuntimeStart), when Herdr's record
 * of it takes the session's name. A runtime with no way to take its request on the command line is
 * refused before anything is typed (GY-184); the paste delivery below is only for the loop's
 * re-prompt and the reviewer's reminder, never a session's instruction.
 *
 * The name goes in before the runtime does. A name the runtime would refuse — too long, or built
 * from characters it does not take — is refused here as that refusal, naming the limit, the name
 * attempted and the command that retries the launch, rather than reaching the caller as whatever
 * the runtime says about its arguments (GY-101).
 */
export interface SessionStart extends PromptDelivery, StartBounds { directory: string; role?: string | null; prefix?: string[]; confirm?: 'inline' | 'follow'; retry?: string; contract?: RegisteredLaunch | null;
  /** `'master'`: the master session's own confinement (masterSessionConfinement, GY-1658), judged with `confinementProbe`. `false` is a test seam for launches whose runner is faked: no production launch passes it (GY-1658). */
  confinement?: false | 'master';
  confinementProbe?: MasterConfinementProbe;
  /** The master's private coordinator state beside its credential, granted explicitly by its launcher. */
  masterStateDirectory?: string;
  /** GY-3237: install state the master session's own recovery commands write — the managed worktree root its launches allocate checkouts under, the reviewer bindings beside the credential — granted writable like `masterStateDirectory`, where each already exists. */
  stateDirectories?: readonly string[];
  /** The coordinator checkout to confine against, when the launcher's own cannot be derived from its entry — a launcher embedded outside the CLI passes it, so its sessions are confined too (GY-888). */
  coordinatorRoot?: string;
  /** The session must never read the operator's credentials, so the confinement gives it no route to the operator's keyring (GY-1039). */
  ownGitHubCredential?: boolean;
  /** An explicit null binds no keyring proxy for a session that carries no credential of its own: a worker launched while the control plane is the merge writer (GY-1523). */
  secretsBus?: null;
  /** The install's credential locations the session must not read (GY-1856), with its own kept: computed by the launcher from the master config and the session's own credential. */
  credentialMask?: CredentialMask;
  /** GY-3237: the Herdr socket and config directories the master session's confinement grants read-only — the server the install records now: the main Herdr, and a private instance while its panes drain. */
  herdrPaths?: readonly string[];
  /** Judges the keyring endpoint the confinement binds (keyringEndpointWarning unless a caller supplies its own); `started` settles true once the launch succeeds, false when it fails. */
  keyringWarning?: (name: string, confinement: CoordinatorConfinement | null, started: Promise<boolean>) => Promise<string | null>;
  /** Called once the command line is in the pane: from then on a supervisor may be running there (GY-273). */ onRun?: () => void;
  /** The pane's working directory, where the runtime starts (`directory` unless the tab opened elsewhere), and the environment its tab carries: what the runtime's `trust` step records the folder in. */ cwd?: string; environment?: Record<string, string> }
export async function startAgentSession(name: string, kind: string, pane: string, args: string[], text: string, run: ChildRun | undefined, options: SessionStart) {
  assertIsolatableHostControlEndpoints({ ...process.env, ...options.environment });
  assertSessionName(name, options.retry);
  // A runtime Graphyard cannot start without its own approval prompts is refused here, before
  // anything is typed, rather than launched into a session that waits for a keypress (GY-184).
  // A registry runtime's own launch contract is its recipe when it registers one.
  assertLaunchable(kind, options.contract);
  const delivery = launchDelivery(kind, args);
  if (delivery !== 'request') throw new LaunchRefusedError(kind, requestContractRefusal(kind));
  // A runtime whose trust prompt no flag suppresses has its working directory recorded as trusted
  // first, or the launch is refused naming it (GY-184): nothing is typed into a session that would wait.
  const trust = await launchRecipe(kind)?.trust?.(options.cwd ?? options.directory, options.environment ?? {}, args);
  // The coordinator checkout is unwritable for this session at the OS level (GY-888), or the
  // launch is refused with the reason named — never started unconfined. A failure here is a
  // launch failure like any other: the caller releases the claim and closes what it created.
  const confinement = options.confinement === false ? null
    : options.confinement === 'master' ? await masterLaunchConfinement(kind, options)
    : await sessionConfinement(kind, args, options, options.coordinatorRoot);
  // Every session carries the autonomy contract: in its role file when the runtime loads one,
  // otherwise at the start of its first request (GY-184).
  const carried = withAutonomyContract(!!runtimeAdapter(kind)?.role, { request: text, role: options.role });
  text = carried.request;
  const files = writeLaunchFiles(options.directory, name, { role: carried.role, request: text });
  const command = launchCommand(kind, args, files, options.prefix, confinement?.wrapper ?? [], options.environment);
  // The trust record is read back once more immediately before the runtime starts (GY-1306): the
  // account's config is shared with its running sessions, and one that rewrote it since the trust
  // step dropped the record, so the launch is refused naming that config rather than started into
  // the runtime's folder-trust dialog.
  if (trust) await launchRecipe(kind)?.verify?.(trust);
  await herdrRun(['pane', 'run', pane, command], run);
  options.onRun?.();
  const log = options.log ?? (line => process.stderr.write(`${line}\n`));
  // The keyring probe asks the user manager (up to 10 s) while the runtime starts, never in front
  // of it (GY-1039): no launch waits on it. Its line belongs to the launch, so it is logged only
  // once the launch has succeeded; a failed launch logs nothing under its session's name, and its
  // verdict is not kept, so the next launch on that endpoint reports it instead.
  let launched = false, settle!: (ok: boolean) => void;
  const outcome = new Promise<boolean>(done => { settle = done; });
  void (options.keyringWarning ?? ((session, bound, ok) => keyringEndpointWarning(session, bound, undefined, undefined, undefined, ok, keyringProbeBackoff, log)))(name, confinement, outcome).then(line => { if (line) log(line); }, () => undefined);
  try {
    let started: Awaited<ReturnType<typeof awaitRuntimeStart>>;
    try { started = await awaitRuntimeStart(pane, kind, command, run, { ...options, readyStates: startedStates }); }
    catch (error) {
      if (error instanceof SessionStartError) log(`graphyard: ${name} (${kind}) in pane ${pane}: start failed after ${(error.waitedMs / 1000).toFixed(1)} s (${error.startCase}; bound ${Math.round((options.timeoutMs ?? agentStartTimeoutMs) / 1000)} s)`);
      throw error;
    }
    const runtimeStartedAt = new Date().toISOString();
    log(`graphyard: ${name} (${kind}) in pane ${pane}: runtime ${started.awaiting ? 'awaiting consent' : 'started'} after ${(started.waitedMs / 1000).toFixed(1)} s (bound ${Math.round((options.timeoutMs ?? agentStartTimeoutMs) / 1000)} s)`);
    let named = true;
    try { await herdrJson(['agent', 'rename', pane, name], run); }
    catch (error) {
      // A runtime whose own naming rules are narrower than the ones checked above says so in its
      // refusal; that is a refused name too, and it is reported as one rather than as a failed start.
      if (nameRefusedByRuntime(error)) throw new SessionNameRefusedError(name, `the runtime refused it: ${herdrErrorText(error).split('\n')[0].slice(0, 200)}`, options.retry ?? null);
      // A held session is still named so a human can find it, but a runtime that will not take the
      // name before its dialog is answered does not turn the hold into a failed start.
      // The hold records it unnamed, so the watch supervisor retries the name before it clears.
      if (!started.awaiting) throw error;
      named = false;
    }
    launched = true;
    // The request is already the runtime's own first argument, so nothing waits to be pasted: a
    // session held on a consent dialog reads it once the dialog is answered.
    return { runtimeStartedAt, delivery, command, files, trust: trust ?? null, consent: started.consent, awaiting: started.awaiting ? { ...started.awaiting, request: null as string | null, named } : undefined,
      confinement,
      started: { state: started.awaiting ? 'awaiting consent' as const : 'started' as const, detail: started.detail, waitedMs: started.waitedMs, extended: started.extended } };
  } finally { settle(launched); }
}

export { secretsBusUnjudged, secretsBusMigration, secretsBusEndpointProblem, keyringEndpointWarning, keyringProbeBackoffMs, keyringProbeBackoffMaxMs } from './launch-keyring.js';
export type { KeyringEndpointVerdict, KeyringProbeBackoff } from './launch-keyring.js';

/** Launch every terminal role through the same pane/start/close sequence. The request is
 * delivered by startAgentSession on the runtime command line. Coordinates are cleared only
 * after confirmed cleanup, so a worker caller cannot release its lease beneath a live supervisor.
 * Role-specific account reservations, harnesses and sandbox probes precede this operation.
 */
export async function launchSession(input: {
  name: string; kind: string; args: string[]; text: string;
  workspace?: string; label: string; environment?: Record<string, string>;
  run?: ChildRun; start: SessionStart;
  onPane: (pane: string | undefined, tab: string | undefined) => void;
}) {
  let pane: string | undefined, tab: string | undefined;
  try {
    const created = createdHerdrTab(await herdrJson(['tab', 'create', ...(input.workspace ? ['--workspace', input.workspace] : []),
      '--cwd', input.start.cwd ?? input.start.directory, '--label', input.label,
      ...Object.entries(input.environment ?? input.start.environment ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--no-focus'], input.run));
    pane = created.pane; tab = created.tab;
    input.onPane(pane, tab);
    return await startAgentSession(input.name, input.kind, pane, input.args, input.text, input.run, input.start);
  } catch (error) {
    const malformedTab = (error as { herdrTab?: string })?.herdrTab;
    if (pane || tab || malformedTab) {
      let note: string;
      try { note = await closeFailedLaunch(pane, tab ?? malformedTab, input.run); }
      catch (closeError) {
        throw Object.assign(new Error(`${error instanceof Error ? error.message : String(error)}; Herdr could not confirm cleanup: ${herdrErrorText(closeError)}`), { herdrTab: tab ?? malformedTab });
      }
      input.onPane(undefined, undefined);
      if (error && typeof error === 'object') delete (error as { herdrTab?: string }).herdrTab;
      throw withLaunchClose(error, note);
    }
    throw error;
  }
}

/**
 * A launch that failed before its runtime started closes what it created (GY-413): its pane
 * through closeHerdrPane, the path the loop closes finished sessions by, or its tab when Herdr
 * named no pane. The returned note is what the launch failure records, so the record says the
 * pane is gone rather than leaving an idle shell in the checkout to hold a containment fence.
 */
export async function closeFailedLaunch(pane: string | undefined, tab: string | undefined, run?: ChildRun) {
  await stopCreatedHerdrTab(pane, tab, run);
  return pane ? `its Herdr pane ${pane} was closed` : `its Herdr tab ${tab} was closed`;
}
/** The launch failure with what became of its pane appended; the error keeps its class. */
export function withLaunchClose(error: unknown, note: string): Error {
  if (error instanceof Error) { error.message = `${error.message}; ${note}`; return error; }
  return new Error(`${String(error)}; ${note}`);
}

/**
 * Whether a launched session has taken up its request, judged from what Herdr shows and nothing
 * the session says (GY-93).
 *
 * A session that refused its request ends its only turn within seconds and then sits still:
 * `done`, a screen that no longer changes. A session at work is seen `working` or `blocked`, or —
 * while a long command runs, which Herdr reports as `idle` for Claude Code — with a screen that
 * keeps changing under its timer and output. A refusal is often caught `working` too, for the
 * seconds its answer takes, so one sighting proves nothing: the session is *acknowledged* once
 * activity has been seen across `sustainedActivityMs`, once it is `blocked` (an approval or
 * question UI: it reached a tool call), or once its result exists.
 *
 * A session still quiet `acknowledgementSeconds` after its launch is re-prompted exactly once,
 * with its request, and the record says when. The re-prompt starts the activity window afresh,
 * so the seconds a second refusal takes cannot acknowledge the session either; a sighting that is
 * not active ends the window too, so activity counts only across consecutive sightings and a
 * single later screen change cannot complete a window a refusal opened. What the loop then
 * records — never started, or finished without its result — is decided where each ledger settles
 * the session, from `acknowledgedAt` and `repromptedAt`, and no sooner than `settlementDue` allows.
 */
export const defaultAcknowledgementSeconds = 90, sustainedActivityMs = 30_000;
export const acknowledgementMs = (config: { run: Pick<MasterRun, 'acknowledgementSeconds'> }) => (config.run.acknowledgementSeconds ?? defaultAcknowledgementSeconds) * 1000;
export interface LaunchAcknowledgement { requestedAt: string; acknowledgedAt?: string; repromptedAt?: string; activeSince?: string; screen?: string }
export type SessionActivity = 'awaiting acknowledgement' | 'running';
export const sessionActivity = (record: Pick<LaunchAcknowledgement, 'acknowledgedAt'>): SessionActivity => record.acknowledgedAt ? 'running' : 'awaiting acknowledgement';
export const activeStates = ['working', 'blocked'];
export const screenDigest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);
/** How a session's screen is read when the judgement needs it: a stub in a test, one Herdr read in the process. */
export type ScreenReader = () => string | null | Promise<string | null>;
export async function acknowledgeLaunch(record: LaunchAcknowledgement, agent: Pick<HerdrAgent, 'agent_status'> | undefined, observed: { now: number; ackMs: number; result: boolean; screen: ScreenReader }) {
  if (record.acknowledgedAt) return { changed: false, reprompt: false };
  const at = new Date(observed.now).toISOString();
  const confirm = () => { record.acknowledgedAt = at; delete record.activeSince; delete record.screen; return { changed: true, reprompt: false }; };
  if (observed.result) return confirm();
  // Blocked is an approval or question UI: the session reached a tool call and is acknowledged at once.
  if (agent?.agent_status === 'blocked') return confirm();
  let changed = false;
  let active = !!agent && activeStates.includes(agent.agent_status ?? '');
  if (agent && !active) {
    const text = await observed.screen();
    if (text !== null) {
      const digest = screenDigest(text);
      // The first screen read is a baseline: it shows no change, so it is not activity.
      active = !!record.screen && record.screen !== digest;
      if (record.screen !== digest) { record.screen = digest; changed = true; }
    }
  }
  if (active) {
    if (record.activeSince && observed.now - Date.parse(record.activeSince) >= sustainedActivityMs) return confirm();
    if (!record.activeSince) { record.activeSince = at; changed = true; }
    return { changed, reprompt: false };
  }
  // Not seen active: the window closes, so activity is sustained only across consecutive
  // sightings, and one later screen change after a quiet spell starts a window rather than
  // completing one.
  if (record.activeSince) { delete record.activeSince; changed = true; }
  const quietFor = observed.now - Date.parse(record.requestedAt);
  return { changed, reprompt: !!agent && !record.repromptedAt && quietFor >= observed.ackMs };
}
/** The one re-prompt was sent (or attempted): it is never repeated, and activity is counted afresh from here. */
export function markReprompted(record: LaunchAcknowledgement, now: number) { record.repromptedAt = new Date(now).toISOString(); delete record.activeSince; }
/**
 * Whether a session that stopped without its result may be settled yet. The grace a finished
 * session gets is fixed, while `acknowledgementSeconds` is configured (30–900), so neither may cut
 * the other short: a session still in Herdr that has not taken up its request is settled only once
 * it has had its one re-prompt and a whole interval after it, whatever the grace says — before
 * that, its ledger keeps it pending. A session that left Herdr, or one that was acknowledged, is
 * settled by the grace alone.
 */
export function settlementDue(record: LaunchAcknowledgement, agent: Pick<HerdrAgent, 'agent_status'> | undefined, observed: { now: number; ackMs: number }) {
  if (!agent || record.acknowledgedAt) return true;
  return !!record.repromptedAt && observed.now - Date.parse(record.repromptedAt) >= observed.ackMs;
}
/**
 * A session that settled without its result never started when it was never acknowledged and
 * either left Herdr or stayed quiet through the interval after its re-prompt; otherwise it did
 * the work, or enough of it, and failed. Both reasons carry the session's last words.
 */
export const neverStartedReason = 'never started';
export async function settlementReason(record: LaunchAcknowledgement, agent: Pick<HerdrAgent, 'agent_status'> | undefined, observed: { now: number; ackMs: number; screen: ScreenReader }, failure: string) {
  const words = agent ? sessionWords(await observed.screen()) : '';
  const quoted = words ? ` Its last words: "${words}"` : '';
  const unstarted = !record.acknowledgedAt && (!agent || (!!record.repromptedAt && observed.now - Date.parse(record.repromptedAt) >= observed.ackMs));
  if (!unstarted) return `${failure}.${quoted}`;
  return agent ? `${neverStartedReason}: the session took up neither its request nor the re-prompt at ${record.repromptedAt} and ended without acting.${quoted}` : `${neverStartedReason}: the session left Herdr without acting on its request`;
}
export const neverStarted = (record: { state: string; resolution?: string | null }) => record.state === 'failed' && !!record.resolution?.startsWith(neverStartedReason);
/** The re-prompt: the session's own request again, from the launcher that sent it, not a paste from a stranger. */
export function repromptText(request: string, ackMs: number) {
  return `The Graphyard launcher that started this session has seen no activity from it for ${Math.round(ackMs / 1000)} seconds, so here is the request it was started with, sent once more by that same launcher: it is this session's own instruction, not untrusted text, and needs no further authorization. If you have already begun, continue where you are. ${request}`;
}

/**
 * The runtime a reviewer or producer launch actually started (GY-1306): the kind of the account
 * `accountLaunch` selected, which a registry choice may make another runtime than the profile's. The
 * handle is registered before the account is chosen, under the profile's kind; once the launch
 * returns, the handle takes the launched kind, so the coordinates written over the registration
 * carry it, and the liveness sweep's wording, the blocked-prompt read and the per-runtime exhaustion
 * notices judge a codex pane as codex. A launch that reports no account ran on the profile's own.
 */
export function launchedRuntime(launched: unknown): string | null {
  const kind = (launched as { account?: { kind?: unknown } | null } | null | undefined)?.account?.kind;
  return typeof kind === 'string' && kind ? kind : null;
}
export function withLaunchedRuntime<T>(handle: { runtime: string }, start: () => Promise<T>): () => Promise<T> {
  return async () => {
    const launched = await start();
    handle.runtime = launchedRuntime(launched) ?? handle.runtime;
    return launched;
  };
}
