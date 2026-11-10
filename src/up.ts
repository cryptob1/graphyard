import { readSecretFromStdin } from './cli/context.js';
import { archiveDaemonCursor, daemonStatePath } from './daemon/state.js';
import { loadStoredMasterConfig } from './master/config.js';
import { supervisingUnit } from './master/loop-restart.js';
import { loopStopTimeoutSeconds } from './install/loop-unit.js';
import { defaultChildRun } from './child-runner.js';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setupAddress, setupChecklist, type SetupItem, type SetupItemId } from './model/setup-checklist.js';
import { masterCredential, planeRequest } from './setup-from-zero.js';
import { sshOrigin } from './merger-mode.js';
import { fileOnboardingWork, onboardingChecks, onboardingFirstCase } from './onboarding.js';
import { findOnboardingWork, onboardingBranch, onboardingCasePath, onboardingWait, waitedFor, type OnboardingWait } from './model/onboarding-work.js';
import { coordinatorCheckoutRefusal, coordinatorCheckoutRoot, dirtyCheckoutPaths, readCoordinatorCheckout } from './master/profiles.js';
import { redactString } from './redaction.js';
import { landlockRefusal, readLandlockAbi } from './landlock.js';
import { recordSupervision } from './master/config.js';
import { installIdFor } from './install/types.js';
import { installDirectory, readInstallRecord } from './install/secrets.js';
import { settleWorkerCredentials } from './install/worker-credentials.js';
import { ensureDeployKey } from './install/deploy-key.js';
import type { GitHubCli } from './install/github.js';
import { herdrAttachCommand, installHerdrInstance, type HerdrInstance } from './master/herdr.js';
import { ensureHerdrBinary, ensureHerdrServer, ensureHerdrWorkspace, HerdrSetupFailure, herdrSync, hostHerdrDeps, prepareHerdrInstance, withLocalBin, type HerdrHostDeps } from './herdr-host.js';
import { herdrBoundElsewhere, herdrPluginBinding, herdrPluginEnabled, serverOrigin, readLoopCode, liftLoopPins, removeHeldCliPin, type LoopCodeReading } from './repository-setup.js';
import { loopCodeRoot } from './daemon/checkout-state.js';
import { recordHerdrInstance } from './master/config.js';
export { readInstallLoopCode } from './loop-code.js';

/**
 * `graphyard up` (GY-1419): every machine step of a first installation, in order — preflight,
 * control plane, host supervisor and Herdr, the merge writer's deploy key, the master's agent
 * identities (GY-1479), onboarding, agent accounts, harness, master loop — and a wait on the
 * first-run checklist (src/model/setup-checklist.ts) wherever a person must act.
 * Each step is an existing idempotent command run as a child of this CLI, and each completed step
 * is recorded in .graphyard/up.json, so a rerun after any interruption skips what is done and never
 * registers an identity or variable twice. Every run sets Herdr up (GY-1511): it installs herdr
 * when missing and keeps its server running as a user unit. It never repoints a Herdr plugin bound
 * to another server: the install gets its own Herdr instance instead (--herdr-instance).
 *
 * Interactive, a human step prints the dashboard's Setup page address once and waits for the step
 * to turn green. That address is a one-time sign-in link minted with the operator's own credential
 * (a host install's, from its redeemed claim) and ending `&setup`, so opening it signs the person in and lands on
 * the Setup page with no token to paste. With --agent, every step has a non-interactive path (accounts
 * come from login homes already on the host) and only a step that needs a person's own device or identity —
 * a subscription login's browser approval — is handed off, as one sentence plus a link; the run
 * resumes on its own once it completes.
 *
 * `up --local` sets up supervised mode (GY-1501): no master-autonomy identities, and master.json
 * records `supervision: supervised` with the operator's GitHub login, so the operator answers each
 * decision and nothing claims autonomy; its heads are reviewed and merged as below (GY-1978).
 *
 * Every `up` (GY-1552): the control plane is the merge writer — `install --no-github-app`, a deploy
 * key from the operator's `gh` login, then the autonomy, onboarding, accounts, harness and
 * master-loop steps. A run recorded before the control plane became the only merge writer resumes
 * with its deploy-key step still to run.
 */

/** `up --local` installs supervised (GY-1501): no operator-agent identity; the operator answers each decision. */
export const upSupervised = (request: Pick<UpRequest, 'provider'>) => request.provider === 'local';
/** The one step list: the control plane is the merge writer (GY-1552), with the deploy key between host-supervisor and master-autonomy. */
export const upSteps = ['preflight', 'control-plane', 'host-supervisor', 'deploy-key', 'master-autonomy', 'onboarding', 'accounts', 'harness', 'master-loop'] as const;
export type UpStep = typeof upSteps[number];

export interface UpRequest {
  repository: string;
  baseBranch?: string;
  provider: string;
  /** The non-interactive agent path (`graphyard up --agent`). */
  agent: boolean;
  /** The agent runtime the master and harness are set up for. */
  master: string;
  /** GY-1457: how long each wait on a person lasts (`--wait MINUTES`); upWaitMs when omitted. */
  waitMs?: number | null;
  /** GY-1477: serve a local dashboard on this host's tailnet (`--share-tailnet`); otherwise the command is only printed. */
  shareTailnet?: boolean;
  /**
   * GY-1641: the control plane's address (`--url`), an origin master init accepts, and only where
   * master.json records none or the same one (upUrlRefusal). Every child command after the install is
   * pointed at the recorded address (this, else master.json, else the install record), never a default port.
   */
  url?: string | null;
  /** GY-3220: the merge writer's fine-grained token read from stdin (`--merge-token-stdin`), forwarded to every install child; the deploy-key step is skipped. */
  mergeToken?: string;
}
/** Agent mode's default wait on a person: 20 minutes (GY-1457). */
export const upAgentWaitMs = 1_200_000;
/** How long each wait on a person lasts: --wait, else 20 minutes in agent mode, else no bound. */
export const upWaitMs = (request: Pick<UpRequest, 'agent' | 'waitMs'>) => request.waitMs ?? (request.agent ? upAgentWaitMs : Infinity);

export type UpEvent =
  | { kind: 'step'; step: UpStep; state: 'start' | 'done' | 'skipped' | 'waiting'; detail?: string }
  /**
   * GY-1641: a started step that did not finish: the outcome of every step-start that has no done.
   * ARGV is the failed child's graphyard arguments and STDERR its first stderr line (both redacted),
   * null when the step failed without a child; EXITCODE is up's own (upExitCodes).
   */
  | { kind: 'step-failed'; step: UpStep; exitCode: number; argv: string[] | null; stderr: string | null; detail: string }
  | { kind: 'waiting'; setupUrl: string; waitingFor: SetupItemId[]; sentence: string }
  | { kind: 'handoff'; step: UpStep; sentence: string; url: string | null; code: string | null }
  /** GY-1478: the onboarding change is the current setup step: what it waits for and how long it has waited. */
  | { kind: 'onboarding'; wait: OnboardingWait }
  | { kind: 'note'; text: string };

/** What a device step hands to a person, or that it completed. */
export type Handoff = (sentence: string, link: { url?: string | null; code?: string | null }) => void;

export interface UpDependencies {
  root: string;
  /**
   * Runs one graphyard command; stderr lines go to onLine as they arrive, and its tail comes back as stderr (GY-1509),
   * its first non-empty stderr line as firstStderr, kept even when the tail has scrolled past it (GY-1641).
   */
  cli(args: string[], options?: { stdin?: string; env?: Record<string, string>; onLine?: (line: string) => void; signal?: AbortSignal }): Promise<{ code: number; stdout: string; stderr?: string; firstStderr?: string }>;
  /** The control plane's /api/status as the recorded master identity, or null while none answers. */
  status(): Promise<any | null>;
  /** The control plane's address once the install recorded it. */
  serverUrl(): Promise<string | null>;
  /** The master credential the install recorded for that control plane (.graphyard/master.json). */
  masterToken(): Promise<string | null>;
  /**
   * A one-time dashboard sign-in address (`SERVER/#sign-in=CODE`) minted with the operator's admin
   * credential: TOKEN when given, else the one in OPERATOR_TOKEN_FILE; null when none can be minted
   * (no such file on this machine).
   */
  signIn?(operatorTokenFile: string | null, token?: string): Promise<string | null>;
  /**
   * GY-1477: spend a host install's one-time claim link (`SERVER/#claim=CODE`) for the operator's admin
   * credential, kept in memory only, so every link `up` prints (the wait's and the final one) is minted
   * fresh; null when the claim is refused.
   */
  redeemClaim?(claim: string): Promise<string | null>;
  /** The operator's admin credential read from OPERATOR_TOKEN_FILE, or null when this machine holds none (GY-1479). */
  operatorToken?(operatorTokenFile: string | null): Promise<string | null>;
  emit(event: UpEvent): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  /**
   * Publish the onboarding files `init --scan --apply` wrote (AGENTS.md, .gitignore, graphyard.json,
   * .github/workflows) as one commit on `graphyard/onboarding` above the base branch, and push that
   * branch; null when the base branch already holds them. WORKFLOWS are the workflow files the apply
   * reported writing: a publish missing any of them, or AGENTS.md or graphyard.json, refuses naming
   * the file (GY-1480). No pull request is opened; the commit is submitted by head sha (GY-2938).
   */
  publishOnboarding(workflows: string[]): Promise<{ commit: string } | null>;
  /**
   * File the onboarding commit as a work item the loop owns (GY-1478), with the operator's admin
   * credential in OPERATOR_TOKEN_FILE and request id REQUESTID (fixed across reruns, so it is filed
   * once): the loop's reviewer reviews the head and the control plane merges it under the normal
   * gates. Null when no admin credential is on this machine.
   */
  fileOnboarding?(commit: string, operatorTokenFile: string | null, requestId: string): Promise<{ key: string } | null>;
  /** The control plane's work items, as the master identity reads them; null while none answers. */
  work?(): Promise<any[] | null>;
  /**
   * GY-1480: the CLI checkout the master loop will run from, and the paths that make it dirty (empty
   * when clean). The loop refuses to start from a dirty one, so preflight refuses first.
   */
  cliCheckout?(): Promise<{ root: string; dirty: string[] }>;
  /** GY-3169: the host's Landlock ABI; preflight refuses below 9, since socket confinement then launches nothing. */
  landlockAbi?(): number;
  /** GY-1480: why the master loop refuses to run, as the loop itself words it, or null while nothing stops it. */
  loopRefusal?(): Promise<string | null>;
  /**
   * GY-1501: record supervised mode in master.json with the operator's GitHub login, read from gh's
   * own session as a name only: the gh credential is used for setup and never written anywhere.
   */
  supervise?(): Promise<{ operatorLogin: string | null }>;
  /**
   * GY-1859: what the install's loop unit runs against this CLI's code (repository-setup's
   * readLoopCode). A live master-loop checklist item says only that a loop runs; this says whose
   * code it runs. Absent — a dependency double from before it — the master-loop step does not
   * check the code and keeps its earlier behaviour.
   */
  loopCode?(): Promise<LoopCodeReading | null>;
  /**
   * GY-1859: lift the known-good pin that holds the install's loop and
   * slots on another commit (repository-setup's liftLoopPins), so a unit rewritten or restarted
   * next starts this CLI; answers what it lifted.
   */
  liftLoopPins?(): Promise<string[]>;
  /** Remove the retired held-cli pointer even when the master-loop step is already complete. */
  removeHeldCliPin?(): Promise<void>;
  /** GY-1477: this host's Tailscale node (its MagicDNS name and tailnet address), or null without a running Tailscale. */
  tailnet?(): Promise<Tailnet | null>;
  /** GY-1477: runs the tailnet-only serve command tailnetShare names; ok false (with what it said) when it fails or does not finish. */
  applyTailnet?(command: string[]): Promise<{ ok: boolean; detail?: string }>;
  /** GY-1511: Herdr on this host (master/herdr.ts); absent, up leaves Herdr to the install alone. */
  herdr?: UpHerdr;
  /**
   * GY-1552: run `gh` with ARGS (repository view/create and deploy-key registration). Absent under
   * the github-mode path, which never creates a repository or deploy key here.
   */
  gh?(args: string[], input?: string): Promise<{ code: number; stdout: string; stderr?: string }>;
  /** GY-2940: run git with ARGS in the checkout, so the origin `gh repo create` leaves at https is set to the SSH form. Present beside gh. */
  git?(args: string[]): Promise<{ code: number; stdout: string; stderr?: string }>;
  /** GY-1552: the install directory that holds the deploy key; defaults to `~/.config/graphyard/<installId>`. */
  installDirectory?(): string;
  /** GY-1552: ensure the install's deploy key on REPOSITORY; defaults to ensureDeployKey. */
  ensureDeployKey?(installDir: string, repository: string): Promise<string>;
  /**
   * GY-1851: the HTTP status the control plane gave each credential this install recorded (the
   * coordinator and operator-agent) at a status read; one that drew no answer is left out.
   * Absent, nothing is judged stale; the real dependencies read recordedCredentialAnswers here.
   */
  credentialAnswers?(adminToken: string | null): Promise<{ identity: string; status: number; listed?: boolean | null }[]>;
  /**
   * GY-1851: stop the master loop and wait until its process has exited, so nothing holds the old
   * cursor in memory to write it again; answers the systemd unit it stopped, or null for a loop run
   * outside one (or none running). Defaults to stopRecordedLoop.
   */
  stopLoop?(): Promise<{ unit: string | null }>;
  /** GY-1851: start the stopped unit again; defaults to `systemctl --user start UNIT`. */
  startUnit?(unit: string): Promise<void>;
  pollMs?: number;
  /** How long a step waits on a person before the run stops (resumable); Infinity interactively. */
  humanWaitMs?: number;
  /** How long a machine step (the loop starting, protection) may take to turn green. */
  machineWaitMs?: number;
}

/** What `graphyard up` asks of Herdr on this host (GY-1511); each step is idempotent and fails only with a HerdrSetupFailure. */
export interface UpHerdr {
  /** The herdr binary, installed with Herdr's own installer when missing. */
  binary(): Promise<{ binary: string; installed: boolean }>;
  /** The instance's server running (a user unit when it was not); for an own instance, its workspace for this repository too. */
  server(binary: string, instance: HerdrInstance | null, installId: string): Promise<{ started: boolean; unit: string | null; workspace: string | null }>;
  /** Records the own instance and its workspace in .graphyard/master.json. */
  record(instance: HerdrInstance, workspace: string | null): Promise<void>;
  /** The server the graphyard plugin in INSTANCE (null: the default) is bound to and whether Herdr reports it enabled; null when it is not configured. */
  plugin(instance: HerdrInstance | null): Promise<{ url: string; enabled: boolean } | null>;
  /** Enables the graphyard plugin in INSTANCE; a refusal is a HerdrSetupFailure of step plugin. */
  enable(instance: HerdrInstance | null): Promise<void>;
}

export interface UpResult {
  ok: boolean;
  exitCode: number;
  /** GY-1511: the command that opens this install's agents in Herdr on this host, or null while Herdr is not set up. */
  herdrAttach?: string | null;
  /** The Setup page's address (no sign-in code: the one printed while waiting was single use). */
  setupUrl: string | null;
  completed: UpStep[];
  /** How many times the run printed the Setup address and waited on a person. */
  prompts: number;
  handoffs: { step: UpStep; sentence: string; url: string | null; code: string | null }[];
  checklist: { id: SetupItemId; done: boolean; line: string }[];
  /** The onboarding pull request's work item as last read while up waited on it (GY-1478), or null. */
  onboarding: OnboardingWait | null;
  /**
   * GY-1477: one dashboard sign-in link for the reachable address (single use, within 10 minutes),
   * minted when the run ends green; null when none can be minted on this machine. Never a credential.
   */
  signIn: string | null;
  /** GY-1477: the dashboard's address from the operator's other devices (the tailnet URL), when it is served there. */
  reachableUrl: string | null;
  next: string;
}

/** Exit codes: 0 green, 1 a step failed, 2 a machine prerequisite needs a person, 3 still waiting on a person (rerun resumes). */
export const upExitCodes = { green: 0, failed: 1, prerequisite: 2, waiting: 3 } as const;

class UpStop extends Error { constructor(message: string, readonly exitCode: number) { super(message); } }
/** GY-1641: a step stopped by a failed child command, carrying what its step-failed event names. */
class ChildStop extends UpStop { constructor(message: string, exitCode: number, readonly argv: string[], readonly stderr: string | null) { super(message, exitCode); } }
interface UpState {
  version: 1; repository: string; provider: string; completed: UpStep[]; noHerdr: boolean;
  /** Where the install saved the operator's admin credential (a path, never the secret): what mints the sign-in link. */
  operatorTokenFile?: string | null;
  /** The work item the onboarding commit is filed as (GY-1478), and the request id that files it once. */
  onboardingWork?: string | null;
  onboardingRequest?: string | null;
  /** GY-1477: the tailnet address a local dashboard was served on, once `tailscale serve` applied it. */
  tailnetUrl?: string | null;
  /** GY-1511: the host's default Herdr serves another install, so this one has its own instance (--herdr-instance). */
  herdrInstance?: boolean;
  /** GY-1511: why Herdr is left out (noHerdr): the named failure of the step that could not set it up. */
  herdrFailure?: string | null;
  /**
   * GY-1851: the credentials the control plane refused (401), so it serves a fresh database: until the
   * master loop runs again, the install re-issues every credential and the loop starts a fresh cursor.
   */
  reissue?: string[] | null;
}
export const upStateFile = (root: string) => resolve(root, '.graphyard/up.json');
const knownUpSteps = upSteps as readonly string[];

async function readState(root: string, request: UpRequest): Promise<UpState> {
  try {
    const state = JSON.parse(await readFile(upStateFile(root), 'utf8'));
    // A run for another repository or provider starts over: its steps say nothing about this one.
    if (state?.version === 1 && state.repository === request.repository && state.provider === request.provider) {
      const { merger: _merger, mergerRequest: _request, mergerRequestFor: _for, ...kept } = state;
      return { ...kept, completed: (state.completed ?? []).filter((step: string) => knownUpSteps.includes(step)) };
    }
  } catch (error: any) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  return { version: 1, repository: request.repository, provider: request.provider, completed: [], noHerdr: false };
}
async function writeState(root: string, state: UpState) {
  const file = upStateFile(root);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

const parseJson = (text: string) => { try { return JSON.parse(text); } catch { return null; } };
/**
 * What an install's JSON output (its plan, or its summary, complete or paused) says about signing
 * in: a one-time claim link, printed once and kept only in memory, and where the operator's admin
 * credential is saved on this machine.
 */
function installSignIn(stdout: string) {
  const output = parseJson(stdout);
  if (!output || typeof output !== 'object') return { claim: null, operatorTokenFile: null };
  const admin = Array.isArray(output.principals) ? output.principals.find((principal: any) => principal?.role === 'admin') : null;
  const operatorTokenFile = typeof admin?.tokenFile === 'string' ? admin.tokenFile as string
    : typeof output.installDirectory === 'string' && typeof admin?.id === 'string' ? resolve(output.installDirectory, 'tokens', `${admin.id}.token`) : null;
  return { claim: typeof output.signIn === 'string' && /#claim=[A-Za-z0-9_-]{16,200}$/.test(output.signIn) ? output.signIn as string : null, operatorTokenFile };
}
/** Keep where the operator's credential is saved (the path, never the secret), for the sign-in link. */
async function rememberSignIn(root: string, state: UpState, stdout: string) {
  const { claim, operatorTokenFile } = installSignIn(stdout);
  if (operatorTokenFile && operatorTokenFile !== state.operatorTokenFile) {
    state.operatorTokenFile = operatorTokenFile;
    await writeState(root, state);
  }
  return claim;
}

/** A host's Tailscale node: its MagicDNS name (trailing dot allowed) and its tailnet IPv4 address. */
export interface Tailnet { dnsName: string | null; ip: string | null }
const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]'];
/**
 * GY-1477: how a dashboard bound to this host's loopback is reached from the operator's other
 * devices: `tailscale serve` on the same port over plain HTTP, which listens on the tailnet address
 * alone (WireGuard carries it encrypted, and it needs no tailnet HTTPS certificate, whose approval is
 * what left a bare `tailscale serve` waiting). Never `tailscale funnel`: nothing is made public. Null
 * for a server not on loopback (already reachable at its own address) or a host without Tailscale.
 */
export function tailnetShare(server: string, tailnet: Tailnet | null): { command: string[]; url: string } | null {
  let url: URL;
  try { url = new URL(server); } catch { return null; }
  if (url.protocol !== 'http:' || !loopbackHosts.includes(url.hostname)) return null;
  const host = tailnet?.dnsName?.replace(/\.$/, '') || tailnet?.ip;
  if (!host) return null;
  const port = url.port || '80';
  return { command: ['tailscale', 'serve', '--bg', `--http=${port}`, `http://127.0.0.1:${port}`], url: `http://${host}${port === '80' ? '' : `:${port}`}` };
}
/** A sign-in link (`SERVER/#sign-in=CODE`) moved onto BASE: the code is the server's, whichever address opens it. */
/** GY-1509: how many of a failed child's last output lines up's `next` carries. */
export const childTailLines = 20;
/**
 * GY-1509: the last lines a failed child printed, its stdout then its stderr (where install writes
 * its error), each passed through the evidence redaction rule plus the one-time sign-in and claim
 * codes, so a credential install would mask stays masked here; empty when it printed nothing.
 */
export function childTail(result: { stdout: string; stderr?: string }, lines = childTailLines) {
  const text = [result.stdout, result.stderr ?? ''].map(part => part.trim()).filter(Boolean).join('\n');
  return text ? text.split('\n').slice(-lines).map(line => redactLine(line)).join('\n') : '';
}
/** A failed step's message: the command that exited, then its own last output lines. */
const childFailure = (step: string, args: string[], result: { code: number; stdout: string; stderr?: string }, more = '') => {
  const tail = childTail(result);
  return `${step}: graphyard ${args[0]}${args[1] && !args[1].startsWith('-') ? ` ${args[1]}` : ''} exited ${result.code}${more}${tail ? `; its last output:\n${tail}` : ''}`;
};
const redactLine = (line: string) => redactString(line).replace(/#(sign-in|claim)=[^\s"']+/g, '#$1=[redacted]');
/** GY-1641: the first non-empty line a failed child wrote to stderr, redacted as childTail redacts; null when it wrote none. */
export const childFirstStderr = (result: { stderr?: string; firstStderr?: string }) => {
  // The child's own first line, kept apart from the bounded tail, which a verbose child scrolls past.
  const line = (result.firstStderr ?? result.stderr ?? '').split('\n').map(text => text.trim()).find(Boolean);
  return line ? redactLine(line).slice(0, 500) : null;
};
/** GY-1641: the stop a failed child ends its step with: childFailure's message, its argv and first stderr line. */
const childStop = (step: string, args: string[], result: { code: number; stdout: string; stderr?: string; firstStderr?: string }, more = '', exitCode: number = upExitCodes.failed) =>
  new ChildStop(childFailure(step, args, result, more), exitCode, args.map(redactLine), childFirstStderr(result));

export const signInAt = (link: string, base: string) => { const at = link.indexOf('#'); return at < 0 ? link : `${base.replace(/\/+$/, '')}/${link.slice(at)}`; };
/** The steps a reinstall onto a fresh database runs again (GY-1851): the install, master init, the agent identities, the onboarding item, the accounts and the loop. */
const reissueSteps: readonly UpStep[] = ['control-plane', 'host-supervisor', 'master-autonomy', 'onboarding', 'accounts', 'master-loop'];
const masterJson = (root: string) => readFile(resolve(root, '.graphyard/master.json'), 'utf8').then(parseJson, () => null);
/**
 * GY-1851: GET /api/status at SERVER with each credential master.json records (the coordinator's,
 * the operator-agent's), answering the HTTP status of each. A credential with no
 * readable file, or a request that drew no answer, is left out: only the plane's answer judges it.
 * A refused agent identity carries `listed`: true when the plane's operator-agent listing (read with
 * ADMIN) still holds it (revoked, say: its database row stands, so the database is not fresh), false
 * when the listing confirms it absent, and null when no listing was read (no ADMIN, or the request
 * failed): its absence is then unknown. CONFIG is master.json and READ reads a file it names.
 */
async function credentialAnswersFrom(config: any, read: (file: string) => Promise<string>, server: string, fetcher: typeof fetch, admin: string | null) {
  const recorded = [['coordinator', null, config?.credentialFile], ['operator-agent', config?.operatorAgent?.id, config?.operatorAgent?.credentialFile]] as const;
  const call = (path: string, token: string) => fetcher(`${server.replace(/\/+$/, '')}/api/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  const answers: { identity: string; status: number; listed?: boolean | null }[] = [];
  let listing: unknown[] | null | undefined;
  for (const [identity, id, file] of recorded) {
    if (typeof file !== 'string') continue;
    const token = (await read(file).catch(() => '')).trim();
    if (token.length < 32) continue;
    const status = await call('status', token).then(response => response.status, () => null);
    if (status === null) continue;
    if (status === 401 && typeof id === 'string') {
      if (admin) listing ??= await call('operator-agents', admin).then(async response => response.ok ? await response.json().catch(() => null) as unknown[] | null : null, () => null);
      answers.push({ identity, status, listed: Array.isArray(listing) ? listing.some((entry: any) => entry?.id === id) : null });
      continue;
    }
    answers.push({ identity, status });
  }
  return answers;
}
/** GY-1851: credentialAnswersFrom over this checkout's master.json and the credential files it names here. */
export async function recordedCredentialAnswers(root: string, server: string, fetcher: typeof fetch = fetch, admin: string | null = null) {
  return credentialAnswersFrom(await masterJson(root), file => readFile(resolve(file), 'utf8'), server, fetcher, admin);
}
/** GY-1851: the master loop's cursor file, found from the coordinator credential master.json records. */
const recordedCursor = async (root: string) => { const file = (await masterJson(root))?.credentialFile; return typeof file === 'string' ? { credentialFile: resolve(file) } : null; };
export async function archiveRecordedCursor(root: string) {
  const config = await recordedCursor(root);
  return config ? archiveDaemonCursor(config) : null;
}
const recordedCursorExists = async (root: string) => { const config = await recordedCursor(root); return !!config && existsSync(daemonStatePath(config as any)); };
const processAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === 'EPERM'; } };
/**
 * GY-1851: stop this install's master loop and wait for its process to exit: its systemd unit is
 * stopped (systemd waits out the loop's shutdown write), and a loop the cursor's lock names on this
 * host outside the unit is sent SIGTERM and waited on (SIGKILL past the unit's stop bound). Answers
 * the unit stopped, to start again once the cursor is archived.
 */
export async function stopRecordedLoop(root: string): Promise<{ unit: string | null }> {
  const config = await loadStoredMasterConfig(root);
  const unit = (await supervisingUnit(root, config))?.unit ?? null;
  if (unit) await defaultChildRun('systemctl', ['--user', 'stop', unit], { timeoutMs: (loopStopTimeoutSeconds + 60) * 1000 });
  const cursor = await recordedCursor(root);
  const lock = cursor ? parseJson(await readFile(daemonStatePath(cursor as any), 'utf8').catch(() => ''))?.lock : null;
  if (lock && lock.host !== config.hostId && Date.now() - Date.parse(lock.heartbeatAt) < 3 * config.run.intervalSeconds * 1000) throw new Error(`the master loop runs on ${lock.host} (pid ${lock.pid}); stop it there before its cursor is archived`);
  if (lock && lock.host === config.hostId && Number.isInteger(lock.pid) && lock.pid !== process.pid && processAlive(lock.pid)) {
    process.kill(lock.pid, 'SIGTERM');
    const deadline = Date.now() + loopStopTimeoutSeconds * 1000;
    while (processAlive(lock.pid)) {
      if (Date.now() > deadline) { try { process.kill(lock.pid, 'SIGKILL'); } catch { /* gone */ } }
      await new Promise(done => setTimeout(done, 200));
    }
  }
  return { unit };
}

/** The master's agent identity is recorded in master.json and its credential file is readable. */
async function provisioned(root: string) {
  const config = await readFile(resolve(root, '.graphyard/master.json'), 'utf8').then(parseJson, () => null);
  const identities = [config?.operatorAgent];
  if (identities.some(identity => typeof identity?.credentialFile !== 'string')) return false;
  return (await Promise.all(identities.map(identity => readFile(identity.credentialFile, 'utf8').then(text => text.trim().length >= 32, () => false)))).every(Boolean);
}

export async function runUp(request: UpRequest, deps: UpDependencies): Promise<UpResult> {
  const state = await readState(deps.root, request);
  const pollMs = deps.pollMs ?? 5_000;
  const humanWaitMs = deps.humanWaitMs ?? upWaitMs(request);
  const machineWaitMs = deps.machineWaitMs ?? 600_000;
  let herdrAttach: string | null = null;
  const supervised = upSupervised(request);
  let setupUrl: string | null = null, prompts = 0, last: SetupItem[] = setupChecklist(null), claim: string | null = null, operator: string | null = null, onboarding: OnboardingWait | null = null, signIn: string | null = null;
  const handoffs: UpResult['handoffs'] = [];
  const handedOff = new Set<string>();
  const handoff = (step: UpStep): Handoff => (sentence, link) => {
    const key = `${step}:${sentence}`;
    if (handedOff.has(key)) return;
    handedOff.add(key);
    const entry = { step, sentence, url: link.url ?? null, code: link.code ?? null };
    handoffs.push(entry); deps.emit({ kind: 'handoff', ...entry });
  };
  /** GY-1850: what the accounts step's `master environments --apply` wrote, as its own report counts it; null until it has run this pass. */
  let writtenProfiles: { workers: number; reviewers: number } | null = null;
  /** GY-1850: the accounts lines answer for the profiles master.json holds, not only for the fleet's accounts: a fleet whose accounts are all connected still cannot launch a review when the write found no profile to make, so a green line is held back while either count is zero. A report that names no counts (an older CLI, or the write not run yet) leaves the line judging as before. */
  const profileMissing = () => !!writtenProfiles && (writtenProfiles.workers === 0 || writtenProfiles.reviewers === 0);
  const withWrittenProfiles = async (items: SetupItem[]) => {
    if (!profileMissing()) return items;
    return items.map(item => (item.id === 'account:worker' || item.id === 'account:reviewer') && item.done ? { ...item, done: false, action: null,
      line: 'The account is connected, but the coordinator has no agent profile for it yet; setup writes one once the account is signed in where the coordinator runs.' } : item);
  };
  const checklist = async () => (last = await withWrittenProfiles(setupChecklist(await deps.status().catch(() => null))));
  let reached = false;
  /**
   * GY-1477: the dashboard's address from the operator's other devices, worked out once a server is
   * recorded: a tailnet URL served earlier is kept; else, on a host with Tailscale, the tailnet-only
   * serve command is applied under --share-tailnet, or printed with its URL for the operator to run.
   */
  const reach = async () => {
    if (reached || state.tailnetUrl) return state.tailnetUrl ?? null;
    const server = await deps.serverUrl();
    if (!server) return null;
    reached = true;
    const share = tailnetShare(server, await deps.tailnet?.().catch(() => null) ?? null);
    if (!share) return null;
    const shell = share.command.join(' ');
    if (!request.shareTailnet || !deps.applyTailnet) {
      deps.emit({ kind: 'note', text: `The dashboard listens on this machine only. To open it from your phone or other devices on your tailnet (never publicly), run ${shell} and open ${share.url}, or rerun with --share-tailnet.` });
      return null;
    }
    const applied = await deps.applyTailnet(share.command).catch((error: any) => ({ ok: false, detail: String(error?.message ?? error) }));
    if (!applied.ok) {
      deps.emit({ kind: 'note', text: `${shell} did not finish${applied.detail ? ` (${applied.detail.split('\n')[0].slice(0, 300)})` : ''}; the dashboard stays on this machine only. Run it yourself once Tailscale allows serve, then open ${share.url}.` });
      return null;
    }
    state.tailnetUrl = share.url; await writeState(deps.root, state);
    deps.emit({ kind: 'note', text: `The dashboard is served on your tailnet only (${shell}): open ${share.url} from your other devices.` });
    return share.url;
  };
  /**
   * A fresh one-time sign-in link. A host install keeps the operator credential on the host, so its
   * claim is redeemed here once and the credential held in memory for every later link; without that,
   * the claim itself is printed (once), else the operator's local credential mints one.
   */
  const mint = async () => {
    if (claim && !operator && deps.redeemClaim) { operator = await deps.redeemClaim(claim).catch(() => null); if (operator) claim = null; }
    if (operator) return await deps.signIn?.(null, operator).catch(() => null) ?? null;
    const minted = claim ?? await deps.signIn?.(state.operatorTokenFile ?? null).catch(() => null) ?? null;
    claim = null;
    return minted;
  };
  /** The base links are printed for: the tailnet URL when the dashboard is served there, else the server's own. */
  const linkBase = async () => await reach() ?? await deps.serverUrl();
  const resolveSetupUrl = async () => { const url = await linkBase(); if (url) setupUrl = setupAddress(url); return setupUrl; };
  const complete = async (step: UpStep, detail?: string) => {
    if (!state.completed.includes(step)) state.completed.push(step);
    await writeState(deps.root, state);
    deps.emit({ kind: 'step', step, state: 'done', ...(detail ? { detail } : {}) });
  };
  /**
   * The interactive wait: the Setup address printed once for the whole run, then a poll until IDS
   * are green. It signs the person in with a link `mint` gives; only when none can be had does it
   * fall back to the bare address.
   */
  const announce = async (ids: SetupItemId[]) => {
    if (prompts > 0 || request.agent) return;
    const server = await linkBase();
    if (!server) return;
    await resolveSetupUrl();
    const minted = await mint();
    const signIn = minted && signInAt(minted, server);
    const url = setupAddress(server, signIn);
    prompts++;
    deps.emit({ kind: 'waiting', setupUrl: url, waitingFor: ids, sentence: signIn
      ? `Open ${url} to sign in to the Setup page and follow the checklist (the link works once, within 10 minutes); this command carries on as each step turns green.`
      : `Open ${url}, sign in with the link graphyard login prints, and follow the checklist; this command carries on as each step turns green.` });
  };
  /** QUIETPOLLS: polls a machine step may still be settling, before a person is asked. */
  const waitGreen = async (ids: SetupItemId[], human: boolean, whilePending?: (pending: SetupItemId[], polls: number) => Promise<void>, quietPolls = 0) => {
    const deadline = deps.now() + (human ? humanWaitMs : machineWaitMs);
    for (let polls = 0; ; polls++) {
      const items = await checklist();
      const pending = ids.filter(id => !items.find(entry => entry.id === id)?.done);
      if (!pending.length) return;
      if (human && polls >= quietPolls) await announce(pending);
      if (whilePending) await whilePending(pending, polls);
      if (deps.now() >= deadline) throw new UpStop(`Still waiting on ${pending.map(id => items.find(item => item.id === id)!.title).join(', ')}; rerun graphyard up${request.agent ? ' --agent' : ''} to resume`, human ? upExitCodes.waiting : upExitCodes.failed);
      await deps.sleep(pollMs);
    }
  };
  /**
   * GY-1641: one child command. Every child but the install is pointed at the recorded server
   * (GRAPHYARD_URL), so none falls back to the default port when the install bound another one.
   */
  const child = async (args: string[], options: { stdin?: string; env?: Record<string, string>; onLine?: (line: string) => void; signal?: AbortSignal } = {}) => {
    const server = args[0] === 'install' ? null : await deps.serverUrl();
    return deps.cli(args, server ? { ...options, env: { GRAPHYARD_URL: server, ...options.env } } : options);
  };
  const run = async (step: UpStep, args: string[], options: { stdin?: string; env?: Record<string, string>; onLine?: (line: string) => void } = {}) => {
    const result = await child(args, options);
    if (result.code !== 0) throw childStop(step, args, result);
    return result.stdout;
  };
  // install registers no GitHub App (GY-2010): it registers the merge writer's deploy key instead.
  const installArgs = (mode: '--plan' | '--apply') => ['install', '--provider', request.provider, '--repo', request.repository, ...(request.baseBranch ? ['--base-branch', request.baseBranch] : []), mode, ...(state.noHerdr ? ['--no-herdr'] : state.herdrInstance ? ['--herdr-instance'] : []), ...(request.mergeToken ? ['--merge-token-stdin'] : [])];
  const installInput = request.mergeToken ? { stdin: request.mergeToken } : {};
  const rerun = () => `graphyard up --repo ${request.repository} --provider ${request.provider}${request.baseBranch ? ` --base-branch '${request.baseBranch}'` : ''}${request.agent ? ' --agent' : ''}`;
  /** GY-1552: create OWNER/NAME with the operator's gh login when it does not exist yet. */
  const ensureRepository = async () => {
    if (!deps.gh || !deps.git) throw new UpStop('preflight: control-plane merger needs gh and git on this machine to create the repository when it is missing', upExitCodes.prerequisite);
    const view = await deps.gh(['repo', 'view', request.repository, '--json', 'name']);
    if (view.code === 0) return;
    const created = await deps.gh(['repo', 'create', request.repository, '--private', '--source', '.', '--push']);
    if (created.code !== 0) throw new UpStop(`preflight: gh repo create ${request.repository} --source . --push exited ${created.code}${created.stderr ? `: ${created.stderr.split('\n')[0].slice(0, 300)}` : ''}; create it under the operator's gh login, then rerun ${rerun()}`, upExitCodes.prerequisite);
    // GY-2940: gh leaves origin at its https url, which the merge writer's SSH deploy key cannot push with; origin is the SSH form.
    const ssh = sshOrigin(request.repository);
    const set = await deps.git(['remote', 'set-url', 'origin', ssh]);
    if (set.code !== 0) throw new UpStop(`preflight: setting origin to ${ssh} failed: ${(set.stderr || set.stdout || 'no output').split('\n')[0].slice(0, 300)}; run git remote set-url origin ${ssh} in ${deps.root}, then rerun ${rerun()}`, upExitCodes.failed);
    deps.emit({ kind: 'note', text: `Created private repository ${request.repository} with gh repo create (operator's gh login); origin is ${ssh} for the merge writer's deploy key.` });
  };
  const step = async (name: UpStep, body: () => Promise<string | void>) => {
    if (state.completed.includes(name)) { deps.emit({ kind: 'step', step: name, state: 'skipped', detail: 'done by an earlier run' }); return; }
    deps.emit({ kind: 'step', step: name, state: 'start' });
    // GY-1641: recording the step done is part of its outcome, so a failed write fails the step.
    try { await complete(name, (await body()) || undefined); }
    catch (error) {
      // GY-1641: a started step always ends with an outcome event: a person's wait is a step event,
      // anything else a step-failed naming the child that failed; an unexpected error fails the step (exit 1).
      const stop = error instanceof UpStop ? error : new UpStop(`${name}: ${String((error as any)?.message ?? error).split('\n')[0].slice(0, 500)}`, upExitCodes.failed);
      if (stop.exitCode === upExitCodes.waiting) deps.emit({ kind: 'step', step: name, state: 'waiting', detail: stop.message.split('\n')[0] });
      else deps.emit({ kind: 'step-failed', step: name, exitCode: stop.exitCode, argv: stop instanceof ChildStop ? stop.argv : null, stderr: stop instanceof ChildStop ? stop.stderr : null, detail: stop.message.split('\n')[0] });
      throw stop;
    }
  };

  try {
    // GY-1480: the loop refuses to start from a CLI checkout holding uncommitted work, so that is
    // found here, before anything is installed, rather than as a loop that never cycles.
    const cleanCli = async (name: UpStep) => {
      const checkout = await deps.cliCheckout?.();
      if (checkout?.dirty.length) throw new UpStop(`${name}: the Graphyard CLI checkout the master loop runs from (${checkout.root}) holds uncommitted work, and the loop refuses to start from it: ${checkout.dirty.slice(0, 20).join(', ')}${checkout.dirty.length > 20 ? ` and ${checkout.dirty.length - 20} more` : ''}. Commit or discard these paths, then rerun ${rerun()}; nothing further was installed.`, upExitCodes.prerequisite);
    };

    // Checked on every run, outside the resumable step: a checkout dirtied since an earlier run's
    // preflight passed is refused here too, before a resumed run installs anything from it.
    await cleanCli('preflight');

    // GY-1511: Herdr is set up on every run, the first install on a host included, with no flag. It is
    // checked outside the resumable steps, so a herdr removed or a server stopped since is set up again.
    const herdrHost = deps.herdr ?? null;
    let herdrBinary: string | null = null;
    const leaveHerdrOut = async (error: unknown) => {
      if (!(error instanceof HerdrSetupFailure)) throw error;
      state.noHerdr = true; state.herdrFailure = error.message; await writeState(deps.root, state);
      deps.emit({ kind: 'note', text: `Herdr is left out of this install: ${error.message}. Workers start from the CLI; fix it and rerun ${rerun()} to set Herdr up.` });
    };
    if (herdrHost) {
      try {
        const found = await herdrHost.binary();
        herdrBinary = found.binary;
        if (found.installed) deps.emit({ kind: 'note', text: `herdr was not installed; Herdr's own installer put it at ${found.binary}` });
      } catch (error) { await leaveHerdrOut(error); }
      // A run that left Herdr out (a recorded failure, or a plugin bound elsewhere before GY-1511) is
      // set up now: preflight and the install run again, and the install is idempotent.
      if (herdrBinary && state.noHerdr) {
        state.noHerdr = false; state.herdrFailure = null;
        state.completed = state.completed.filter(name => name !== 'preflight' && name !== 'control-plane');
        await writeState(deps.root, state);
      }
    }

    await step('preflight', async () => {
      const landlock = deps.landlockAbi ? landlockRefusal(deps.landlockAbi) : null;
      if (landlock) throw new UpStop(`preflight: ${landlock}. Boot a newer kernel, then rerun ${rerun()}; nothing was installed.`, upExitCodes.prerequisite);
      // The repository must exist for deploy-key registration; create it under the operator's gh login when missing.
      await ensureRepository();
      for (let attempt = 0; attempt < 2; attempt++) {
        const planned = await run('preflight', installArgs('--plan'), installInput);
        const plan = parseJson(planned);
        await rememberSignIn(deps.root, state, planned);
        const failed: { name: string; detail?: string; fix?: string }[] = (plan?.preflight ?? []).filter((check: any) => check && check.ok === false);
        // A Herdr plugin bound to another server keeps that server (GY-1413): up never passes --herdr-rebind.
        // This install gets its own Herdr instance instead (GY-1511), and the default one is not touched.
        if (failed.some(check => check.name === 'Herdr plugin') && !state.noHerdr && !state.herdrInstance) {
          state.herdrInstance = true; await writeState(deps.root, state);
          deps.emit({ kind: 'note', text: `Herdr's graphyard plugin on this host's default Herdr is bound to another server, which keeps it; this install gets its own Herdr instance (session ${installHerdrInstance(installIdFor(request.repository)).session}).` });
          continue;
        }
        if (failed.length) throw new UpStop(`Preflight needs a person on this machine: ${failed.map(check => `${check.name}: ${check.detail ?? 'failed'}${check.fix ? ` (fix: ${check.fix})` : ''}`).join('; ')}. Fix it, then rerun graphyard up.`, upExitCodes.prerequisite);
        return `${(plan?.preflight ?? []).length} checks passed`;
      }
      throw new UpStop('Preflight did not settle after giving this install its own Herdr instance', upExitCodes.failed);
    });

    // The server is started before the install links the plugin into it, and checked on every run.
    const ownHerdr = state.herdrInstance ? installHerdrInstance(installIdFor(request.repository)) : null;
    let herdrWorkspace: string | null = null;
    if (herdrHost && herdrBinary && !state.noHerdr) {
      try {
        const server = await herdrHost.server(herdrBinary, ownHerdr, installIdFor(request.repository));
        herdrWorkspace = server.workspace;
        if (ownHerdr && herdrWorkspace) await herdrHost.record(ownHerdr, herdrWorkspace).catch(() => {});
        if (server.started) deps.emit({ kind: 'note', text: `The Herdr server${ownHerdr ? ` for session ${ownHerdr.session}` : ''} was not running; it now runs as the user unit ${server.unit}, which restarts it after a failure or a reboot.` });
      } catch (error) { await leaveHerdrOut(error); }
    }

    const controlPlane = () => step('control-plane', async () => {
      // The control plane is the merge writer (GY-1552): the install registers no App, no App page
      // is served or driven, and the merge writer's deploy key is its only GitHub access.
      const result = await deps.cli(installArgs('--apply'), installInput);
      claim = await rememberSignIn(deps.root, state, result.stdout) ?? claim;
      if (result.code !== 0) throw childStop('control-plane', installArgs('--apply'), result);
      return 'control plane installed without a GitHub App';
    });
    // GY-1851: an install whose recorded credentials the control plane refuses (401) is a fresh
    // database behind a kept install directory: a new installation. Its credentials are re-issued
    // through the install, master init and master autonomy, and the loop starts a fresh cursor.
    // An identity the plane still lists (revoked, say) is no fresh database, and is left to master autonomy's own refusal;
    // a refused identity whose absence no listing confirmed leaves the state untouched, so a later run judges it again.
    if (state.completed.includes('control-plane') && !state.reissue?.length && deps.credentialAnswers) {
      const admin = await deps.operatorToken?.(state.operatorTokenFile ?? null).catch(() => null) ?? null;
      const answers = await deps.credentialAnswers(admin).catch((error: any) => {
        deps.emit({ kind: 'note', text: `The recorded credentials could not be checked against the control plane (${String(error?.message ?? error).split('\n')[0].slice(0, 300)}), so nothing is judged stale on this run.` });
        return [];
      });
      const refused = answers.filter(answer => answer.status === 401).map(answer => answer.identity);
      const listed = answers.filter(answer => answer.status === 401 && answer.listed === true).map(answer => answer.identity);
      const unknown = answers.filter(answer => answer.status === 401 && answer.listed === null).map(answer => answer.identity);
      if (listed.length) deps.emit({ kind: 'note', text: `The control plane refused the recorded ${listed.join(', ')} credential${listed.length > 1 ? 's' : ''} (401) but still lists the identit${listed.length > 1 ? 'ies' : 'y'}: its database is not fresh (a revoked or rotated identity), so nothing is re-issued; restore it through the operator-agent API or choose another identity in .graphyard/master.json.` });
      else if (unknown.length) deps.emit({ kind: 'note', text: `The control plane refused the recorded ${unknown.join(', ')} credential${unknown.length > 1 ? 's' : ''} (401), but its operator-agent listing could not be read (${admin ? 'GET /api/operator-agents failed' : "the operator's admin credential is not on this machine"}), so nothing confirms a fresh database and nothing is re-issued; rerun graphyard up once the listing answers.` });
      else if (refused.length) {
        state.reissue = refused;
        state.completed = state.completed.filter(name => !reissueSteps.includes(name));
        // The onboarding item lived in the old database: it is filed again on the fresh one.
        state.onboardingWork = null; state.onboardingRequest = null;
        await writeState(deps.root, state);
        deps.emit({ kind: 'note', text: `The control plane refused the recorded ${refused.join(', ')} credential${refused.length > 1 ? 's' : ''} (401): it serves a fresh database, so this run re-issues the coordinator and operator-agent credentials and starts the master loop on a fresh cursor, archiving the old one beside itself.` });
      }
    }
    const installedBefore = state.completed.includes('control-plane');
    await controlPlane();
    await resolveSetupUrl();
    await reach();
    // GY-1511: the plugin the install linked is checked on every run, its binding and its enabled state
    // as Herdr reports them, so a link or enable that failed inside the install, or a plugin changed or
    // disabled since, is never reported set up. A plugin bound elsewhere or missing on a run whose install
    // was done earlier runs it again once; one bound here but disabled is enabled; a plugin still not
    // bound and enabled for this server leaves Herdr out, named, and the next run sets it up again.
    if (herdrHost && herdrBinary && !state.noHerdr) {
      const server = await deps.serverUrl();
      const where = ownHerdr ? ` in this install's own instance (session ${ownHerdr.session})` : " in the host's default Herdr";
      const disabled = 'bound to this install\'s server but not enabled';
      const unbound = async () => {
        const plugin = await herdrHost.plugin(ownHerdr).catch(() => null);
        if (!plugin) return 'not configured';
        if (!server || herdrBoundElsewhere({ url: plugin.url }, server)) return `bound to ${plugin.url}`;
        return plugin.enabled ? null : disabled;
      };
      let wrong = await unbound();
      if (wrong && wrong !== disabled && installedBefore) {
        deps.emit({ kind: 'note', text: `Herdr's graphyard plugin${ownHerdr ? ` in session ${ownHerdr.session}` : ''} is ${wrong}, not this install's server; running the install again to link it` });
        state.completed = state.completed.filter(name => name !== 'control-plane'); await writeState(deps.root, state);
        await controlPlane();
        wrong = await unbound();
      }
      let refused: HerdrSetupFailure | null = null;
      if (wrong === disabled) {
        deps.emit({ kind: 'note', text: `Herdr's graphyard plugin${ownHerdr ? ` in session ${ownHerdr.session}` : ''} is ${disabled}; enabling it` });
        try { await herdrHost.enable(ownHerdr); wrong = await unbound(); } catch (error) { if (!(error instanceof HerdrSetupFailure)) throw error; refused = error; }
      }
      if (refused) await leaveHerdrOut(refused);
      else if (wrong === disabled) await leaveHerdrOut(new HerdrSetupFailure('plugin', `the graphyard plugin${where} is bound to ${server} but Herdr still reports it disabled after enabling it`));
      else if (wrong) await leaveHerdrOut(new HerdrSetupFailure('plugin', `the graphyard plugin${where} is ${wrong} after the install linked it, not to ${server ?? 'this install\'s server'}`));
    }
    // GY-1511: the install's own instance is recorded beside the master configuration the install wrote,
    // so the loop, the dispatcher and every supervisor reach it; then the operator is told how to watch.
    if (herdrHost && ownHerdr && !state.noHerdr) await herdrHost.record(ownHerdr, herdrWorkspace);
    if (herdrHost && !state.noHerdr) herdrAttach = herdrAttachCommand(ownHerdr);
    if (herdrAttach) deps.emit({ kind: 'note', text: `Watch this install's agents in Herdr: ${herdrAttach}` });

    await step('host-supervisor', async () => {
      const token = await deps.masterToken();
      if (!token) throw new UpStop('host-supervisor: no master credential is recorded for the installed control plane', upExitCodes.failed);
      // GY-1641: master init accepts the control plane on the recorded address, never its default port.
      const server = await deps.serverUrl();
      await run('host-supervisor', ['master', 'init', '--token-stdin', ...(server ? ['--url', server] : [])], { stdin: token });
    });
    // Recorded on every run (idempotent), so a resumed run that skipped master init still installs supervised.
    if (supervised && deps.supervise) {
      const { operatorLogin } = await deps.supervise();
      deps.emit({ kind: 'note', text: `Supervised mode: an agent reviewer reviews each head and the control plane merges it; no operator-agent runs, so you${operatorLogin ? ` (${operatorLogin})` : ''} answer each decision.` });
    }

    // GY-1552: the merge writer's deploy key under the install directory. No GitHub protection is set.
    {
      const directory = deps.installDirectory?.() ?? installDirectory(installIdFor(request.repository));
      const gh: GitHubCli | null = deps.gh ? async (args, options) => {
        const result = await deps.gh!(args, options?.input);
        if (result.code !== 0 && !options?.allowFailure) throw new Error(`gh ${args.join(' ')} exited ${result.code}${result.stderr ? `: ${result.stderr.split('\n')[0].slice(0, 200)}` : ''}`);
        return { stdout: result.stdout, stderr: result.stderr ?? '', code: result.code };
      } : null;
      if (request.mergeToken) deps.emit({ kind: 'step', step: 'deploy-key', state: 'skipped', detail: 'the merge writer uses the fine-grained token the install stored' });
      else await step('deploy-key', async () => {
        const ensure = deps.ensureDeployKey ?? (async (installDir, repository) => {
          if (!gh) throw new UpStop('deploy-key: the merge writer needs gh on this machine to register the deploy key', upExitCodes.prerequisite);
          return ensureDeployKey(installDir, repository, gh);
        });
        await ensure(directory, request.repository);
        return 'deploy key registered read-write for the merge writer';
      });
    }

    // GY-1479: the master's operator-agent identity (`master autonomy --apply`), provisioned
    // with the admin credential the install saved, so the new master creates, releases and unblocks work
    // with no further command. That credential is never something an agent session may read.
    if (supervised) deps.emit({ kind: 'step', step: 'master-autonomy', state: 'skipped', detail: 'supervised: no operator-agent identity is provisioned; the operator answers each decision' });
    else await step('master-autonomy', async () => {
      const admin = await deps.operatorToken?.(state.operatorTokenFile ?? null).catch(() => null) ?? null;
      // An install whose operator already ran the command keeps those identities; the admin credential only refreshes them.
      // A re-issue (GY-1851) never keeps the files the fresh database refused.
      if (!admin && !state.reissue?.length && await provisioned(deps.root)) return 'the master\'s operator-agent identity was already provisioned';
      if (!admin) throw new UpStop(`master-autonomy: the operator's admin credential is not on this machine${state.operatorTokenFile ? ` (${state.operatorTokenFile} is unreadable)` : ''}, so the master's agent identities cannot be provisioned; pipe it to graphyard master autonomy --admin-token-stdin --apply here, then rerun ${rerun()}`, upExitCodes.prerequisite);
      await run('master-autonomy', ['master', 'autonomy', '--admin-token-stdin', '--apply', '--harness', request.master], { stdin: admin });
      return 'the master creates, releases and unblocks work with its own operator-agent identity';
    });

    await step('onboarding', async () => {
      await run('onboarding', ['init', '--scan']);
      const url = await deps.serverUrl();
      const applied = parseJson(await run('onboarding', ['init', '--scan', '--apply', ...(url ? ['--url', url] : [])]));
      // GY-1480: only the workflows the apply reports writing are claimed, and the publish refuses
      // when any of them is not on disk, so a change never says it carries a workflow it lacks.
      const workflows: string[] = Array.isArray(applied?.delivery?.workflows) ? applied.delivery.workflows.filter((path: unknown) => typeof path === 'string') : [];
      // GY-3037: the first case the apply wrote for the e2e rule is onboarding output like the rest,
      // published in the same commit; and the serve declaration it writes when no application serves
      // a head is the deployed control plane's policy, which an install reads from graphyard.json —
      // so the install runs again once, this run, before the item that carries it is filed.
      const firstCase: string[] = typeof applied?.delivery?.firstCase === 'string' ? [applied.delivery.firstCase] : [];
      if (applied?.delivery?.serve === true || firstCase.length) {
        const result = await deps.cli(installArgs('--apply'), installInput);
        claim = await rememberSignIn(deps.root, state, result.stdout) ?? claim;
        if (result.code !== 0) throw childStop('control-plane', installArgs('--apply'), result);
      }
      // The files are written to this checkout only; the base branch needs them before any work is
      // delivered, so they are published as one commit on `graphyard/onboarding` (the base is
      // protected, never pushed to) and the commit is submitted as a work item by head sha, exactly
      // as a worker's `complete --head` submits (GY-2938): no pull request is opened.
      const published = await deps.publishOnboarding([...workflows, ...firstCase]).catch((error: any) => { throw new UpStop(`onboarding: publishing the onboarding files failed: ${String(error?.message ?? error).split('\n')[0].slice(0, 400)}; rerun graphyard up to retry`, upExitCodes.failed); });
      const carried = [...workflows, ...firstCase].length ? `onboarding files with ${[...workflows, ...firstCase].join(', ')}` : 'onboarding files (no delivery workflow was written)';
      if (!published) return `${carried}: the base branch already holds them`;
      // GY-1478: the commit is filed as a work item the loop owns, so its reviewer reviews it,
      // the checks run and it merges under the normal gates; nothing waits on a person.
      if (!state.onboardingWork) {
        if (!state.onboardingRequest) { state.onboardingRequest = randomUUID(); await writeState(deps.root, state); }
        const filed = await (deps.fileOnboarding?.(published.commit, state.operatorTokenFile ?? null, state.onboardingRequest) ?? Promise.resolve(null)).catch((error: any) => { throw new UpStop(`onboarding: filing ${published.commit.slice(0, 12)} as a work item failed: ${String(error?.message ?? error).split('\n')[0].slice(0, 400)}; rerun graphyard up to retry`, upExitCodes.failed); });
        state.onboardingWork = filed?.key ?? null;
      }
      // Without the item there is no head to observe and no loop to merge the change, so setup
      // names what is missing instead of waiting on a merge nothing performs (GY-2938).
      if (!state.onboardingWork) throw new UpStop(`onboarding: the onboarding change was published on ${onboardingBranch} (${published.commit.slice(0, 12)}) but no operator admin credential is on this machine to file it as a work item, so the loop cannot merge it; put the credential in place and rerun ${rerun()}`, upExitCodes.failed);
      await writeState(deps.root, state);
      return `${carried} published on ${onboardingBranch} at ${published.commit.slice(0, 12)}, filed as ${state.onboardingWork} for the loop to review and merge`;
    });

    // GY-1850: the profile write `master environments --apply` runs on this machine's configured
    // checkout, where the loop runs. Its report, not a file, is what the account checklist lines
    // judge. A failed write stops the run, resumed or fresh; a pass with no configured checkout yet
    // writes nothing and judges as before.
    /**
     * GY-1885: the report the write answered. Every write's refusals stop the run, whatever profiles
     * it did write: usable profiles beside a refused credential would otherwise turn the checklist
     * green with that identity missing. On a local install with an account logged in, every write
     * then settles each of the install's configured workers on its own (src/install/worker-credentials.ts),
     * never by the aggregate profile count: one worker profile must not stand in for the rest, on
     * this run or a rerun after a partial issue. A worker the install holds no token for fails the
     * run naming it; one issued now is written into a profile by one more write. With no account
     * logged in the write scans no credential, so issuing waits for a login.
     */
    const writeProfiles = async (): Promise<any> => {
      let report: any;
      if (existsSync(resolve(deps.root, '.graphyard/master.json'))) report = parseJson(await run('accounts', ['master', 'environments', '--apply']));
      const counts = report?.counts;
      if (counts) writtenProfiles = { workers: counts.workers ?? 0, reviewers: counts.reviewers ?? 0 };
      const refused = refusedCredentials(report);
      if (refused.length) throw new UpStop(`accounts: the control plane at ${await deps.serverUrl().catch(() => null) ?? 'its recorded address'} refuses ${refused.map(entry => entry.file).join(', ')} (${refused.map(entry => String(entry.reason ?? 'refused').split('\n')[0]).join('; ')}), so no worker profile can be written from it; a sign-in cannot fix this. Reissue this install's worker credentials, then rerun ${rerun()}`, upExitCodes.failed);
      if (!(counts?.loggedIn > 0)) return report ?? null;
      const directory = deps.installDirectory?.() ?? installDirectory(installIdFor(request.repository));
      // Only an absent record means no install here; one that cannot be read or validated stops the run naming it.
      const settled = await settleWorkerCredentials(directory).catch((error: any) => { throw new UpStop(`accounts: this install's record in ${directory} cannot be read: ${String(error?.message ?? error).split('\n')[0].slice(0, 400)}; rerun graphyard install --repo ${request.repository} --apply to rewrite it, then ${rerun()}`, upExitCodes.failed); });
      if (settled.missing.length) throw new UpStop(`accounts: ${settled.issued.length ? `issued ${settled.issued.join(', ')}, but ` : ''}this install's worker credentials are missing (${settled.missing.join(', ')}), and none can be regenerated here: the plane accepts only the tokens it was deployed with. Rerun graphyard install --repo ${request.repository} --apply to reissue them, then ${rerun()}`, upExitCodes.failed);
      if (!settled.issued.length) return report ?? null;
      deps.emit({ kind: 'note', text: `accounts: issued this install's worker credentials (${settled.issued.join(', ')}), so the profiles write makes a worker profile from each.` });
      // The settle just made every configured worker present, so this write issues nothing more.
      return writeProfiles();
    };
    /** Files the write refused (a credential the plane would not take); a duplicate of a principal already profiled is not a refusal. */
    function refusedCredentials(report: any) {
      return (Array.isArray(report?.skipped) ? report.skipped as unknown[] : [])
        .filter((entry): entry is { file: string; reason?: string } => !!entry && typeof entry === 'object' && typeof (entry as any).file === 'string' && !/a profile already uses/.test(String((entry as any).reason)));
    }
    // The registry's first fold may lag the apply by a poll; only a role still empty after it is asked for:
    // handed off in agent mode, on the Setup page interactively. A profile still missing is written
    // again on each wait (each write settling the install's workers), and a wait that polled at all is
    // followed by one more write. The handoff asks for a sign-in only while the last write found no
    // logged-in account; a registry lag alone never asks for one the fleet already has.
    const awaitAccounts = async () => {
      for (;;) {
        let waited = false;
        await waitGreen(accountIds, true, async (pending, polls) => {
          waited = true;
          let report: any = null;
          if (profileMissing()) report = await writeProfiles();
          if (request.agent && polls > 0 && report?.counts?.loggedIn === 0) handoff('accounts')(`Sign in to an AI coding account for ${pending.map(id => id.slice('account:'.length)).join(' and ')}: approve its browser login on your device`, { url: setupUrl });
        }, 1);
        if (!waited) return;
        await writeProfiles();
        if (!profileMissing()) return;
      }
    };
    const accountIds: SetupItemId[] = ['account:worker', 'account:reviewer'];
    // A run resuming over an earlier pass's completed accounts step still writes the profiles it may
    // lack, and waits for them here with the same rewrite, never in a later wait that writes nothing.
    if (state.completed.includes('accounts')) { await writeProfiles(); await awaitAccounts(); }
    await step('accounts', async () => {
      // In either mode (GY-1477), login homes and keys already on this host become the fleet; nothing is signed in here.
      await run('accounts', ['master', 'registry', 'propose', '--apply']);
      // GY-1850: and the profiles, so master.json holds a reviewer and a worker profile for every
      // logged-in environment before the loop starts; without one, the loop's first review launch is
      // refused for an unknown reviewer profile. The lines are green only once both exist.
      await writeProfiles();
      await awaitAccounts();
    });

    await step('harness', async () => { await run('harness', ['master', 'harness', request.master, '--apply']); });

    // GY-1859: a recorded master-loop step says an earlier run finished setup, not that the loop
    // still runs this CLI's code — the install this check exists for is one whose earlier run
    // recorded the step while its loop served an earlier checkout. So the recorded step is re-opened
    // whenever the units read as other code, and the step below runs again instead of printing the
    // same false green. A reading that failed proves nothing either way, so it re-opens the step too,
    // which then fails naming why rather than standing green on code it never read.
    // A reading that was rejected, or came back empty, is a failed reading too: it judged nothing.
    // Only a run with no reader at all keeps the step as recorded.
    const readLoopCode = async () => {
      if (!deps.loopCode) return null;
      const read = await deps.loopCode().then(answer => answer ?? 'no reading came back', (error: any) => String(error?.message ?? error).split('\n')[0].slice(0, 400) || 'the reading was rejected');
      return typeof read === 'string' ? { error: read, reading: null } : { error: read.error, reading: read };
    };
    await deps.removeHeldCliPin?.();
    if (state.completed.includes('master-loop') && deps.loopCode) {
      const recorded = await readLoopCode();
      if (recorded?.error || recorded?.reading?.loopStale) {
        state.completed = state.completed.filter(name => name !== 'master-loop');
        await writeState(deps.root, state);
      }
    }

    await step('master-loop', async () => {
      await cleanCli('master-loop');
      // GY-1859: a live checklist item says only that a loop runs, not whose code it runs. The loop
      // serving the repository may be a process an earlier checkout left: every fix since merged is
      // invisible to it, and setup kept saying nothing was needed. Read the units against this CLI
      // first; a loop on other code is rewritten to this CLI and restarted.
      const read = await readLoopCode();
      // A reading that failed, was rejected or came back empty judged nothing: the step is never green on code it could not read.
      if (read?.error) throw new UpStop(`master-loop: what the install's loop unit runs could not be read: ${read.error}; fix that, then rerun ${rerun()}`, upExitCodes.failed);
      const reading = read?.reading ?? null;
      const loopStale = reading?.loopStale ?? null;
      // A unit that starts another checkout is rewritten; one on this checkout whose process loaded other code is restarted.
      const rewriteLoop = !!loopStale && reading?.loopReplace !== 'restart';
      let rewrote: string | null = null;
      // A known-good pin would bring a rewritten unit — and the loop's own alignment a restarted
      // one — back onto the pinned commit, so it is lifted first and the step still waits for the
      // exact commit below.
      if (loopStale && deps.liftLoopPins) {
        const lifted = await deps.liftLoopPins().catch(error => { throw new UpStop(`master-loop: ${loopStale}, and lifting the pin that holds it there failed: ${String(error?.message ?? error).split('\n')[0]}; rerun ${rerun()}`, upExitCodes.failed); });
        if (lifted.length) deps.emit({ kind: 'note', text: `master-loop: lifted ${lifted.join(' and ')}, so the unit starts this CLI instead; graphyard master recover --to SHA pins a release again.` });
      }
      if (loopStale && rewriteLoop) {
        const token = await deps.masterToken();
        if (!token) throw new UpStop(`master-loop: ${loopStale}, and no master credential is recorded here to rewrite the unit; run graphyard master init --token-stdin --replace-supervisor from this checkout, then rerun ${rerun()}`, upExitCodes.prerequisite);
        const init = parseJson(await run('master-loop', ['master', 'init', '--token-stdin', '--replace-supervisor'], { stdin: token }));
        rewrote = typeof init?.supervisor?.state === 'string' ? init.supervisor.state : null;
        if (rewrote === 'refused') throw new UpStop(`master-loop: the loop unit was not rewritten: ${String(init?.supervisor?.refused ?? 'the install refused it')}; rerun ${rerun()} once that is fixed`, upExitCodes.failed);
      }
      let fresh: string | undefined;
      if (state.reissue?.length) {
        // GY-1851: stop, archive, start, in that order: a running loop holds the old cursor in memory
        // and writes it again as it stops, so the cursor is set aside (never deleted) only once the
        // loop has exited, and the loop starts again reading no cursor at all.
        const stopped = await (deps.stopLoop ?? (() => stopRecordedLoop(deps.root)))().catch((error: any) => { throw new UpStop(`master-loop: stopping the master loop before archiving its cursor failed: ${String(error?.message ?? error).split('\n')[0].slice(0, 400)}; rerun ${rerun()}`, upExitCodes.failed); });
        const archived = await archiveRecordedCursor(deps.root);
        if (await recordedCursorExists(deps.root)) throw new UpStop(`master-loop: the master loop's cursor was written again after the loop stopped, so a loop still runs on the old database's cursor; stop it, then rerun ${rerun()}`, upExitCodes.failed);
        if (stopped.unit) await (deps.startUnit ?? (async (unit: string) => { await defaultChildRun('systemctl', ['--user', 'start', unit], { timeoutMs: 120_000 }); }))(stopped.unit);
        else await run('master-loop', ['master', 'restart']);
        fresh = archived ? `the loop started a fresh cursor; the old one (cycle ${archived.cycle}) is archived at ${archived.file}` : 'the loop started a fresh cursor';
        deps.emit({ kind: 'note', text: `Re-issued the coordinator and operator-agent credentials for the fresh database; ${fresh}.` });
      } else if (!(await checklist()).find(item => item.id === 'master-loop')?.done || (loopStale && rewrote !== 'updated' && rewrote !== 'created')) await run('master-loop', ['master', 'restart']);
      // A loop that refuses to run is a failed setup step naming its cause, never a wait that stalls.
      const refused = async () => {
        const reason = await deps.loopRefusal?.();
        if (reason) throw new UpStop(`master-loop: the master loop refuses to run: ${reason}`, upExitCodes.failed);
      };
      await waitGreen(['master-loop'], false, refused);
      // GY-1859: green is the restarted loop itself reporting one of this install's commits, within
      // one cycle. A reading that failed, a cursor with no commit yet, or a loop still naming the old code is none
      // of those, so the wait keeps polling — a silent success here would leave the install stuck on
      // fixes it cannot see, the same silence the restart meant to end.
      if (loopStale) {
        const deadline = deps.now() + machineWaitMs;
        for (let polls = 0; ; polls++) {
          const now = deps.loopCode ? await deps.loopCode().catch(() => null) : null;
          const read = now && !now.error ? now : null;
          const reported = read && !read.loopStale ? read.loopCommit : null;
          if (reported) {
            deps.emit({ kind: 'note', text: `master-loop: replaced ${loopStale}; the loop now runs ${read!.cli.root} at ${reported.slice(0, 12)}.` });
            break;
          }
          if (deps.now() >= deadline) {
            const detail = !now ? 'the loop\'s code could not be read again'
              : now.error ? `the loop\'s code read failed again: ${now.error}`
              : now.loopStale && (!now.loopCommit || now.loopCommit === now.cli.commit) ? `the loop still runs other code: ${now.loopStale}` : now.loopCommit ? `it still reports ${now.loopCommit.slice(0, 12)} instead of this checkout's ${now.cli.commit ? now.cli.commit.slice(0, 12) : 'commit'}` : 'its cursor records no commit';
            throw new UpStop(`master-loop: ${loopStale}; the units were rewritten and restarted, but ${detail}; rerun ${rerun()}`, upExitCodes.failed);
          }
          await deps.sleep(pollMs);
        }
      }
      await refused();
      if (state.reissue?.length) { state.reissue = null; return fresh; }
      return loopStale ? `replaced: ${loopStale}` : undefined;
    });

    await waitGreen(last.map(item => item.id), true);
    // Setup is green only once the onboarding item is done and the base branch carries the change (GY-2938).
    if (state.onboardingWork) {
      const deadline = deps.now() + humanWaitMs;
      let shown = '';
      for (let polls = 0; ; polls++) {
        const work = findOnboardingWork(await deps.work?.().catch(() => null), state.onboardingWork);
        if (work) {
          onboarding = onboardingWait(work, deps.now());
          if (onboarding.waitingFor.join() !== shown) { shown = onboarding.waitingFor.join(); deps.emit({ kind: 'onboarding', wait: onboarding }); }
          if (onboarding.closed) throw new UpStop(`onboarding: ${onboarding.key} was closed without merging, so the base branch lacks Graphyard's delivery workflows; publish them again, then rerun ${rerun()}`, upExitCodes.failed);
          if (onboarding.merged) break;
        }
        if (deps.now() >= deadline) {
          // The gate reason names itself: the failing gates' own words, so a wait that times out
          // says what the item is stuck on, not only that it is stuck (GY-2938 AC-2).
          const stuck = work ? (work.gates ?? []).filter((gate: any) => gate?.passed !== true)
            .map((gate: any) => `${gate.name}: ${(gate.reasons ?? []).join('; ')}`).join(', ') : 'the control plane has not answered';
          throw new UpStop(`Still waiting for ${state.onboardingWork}${onboarding ? ` (it waits for ${onboarding.waitingFor.join(' and ')}, ${waitedFor(onboarding.waitedMs)} so far; ${stuck})` : ` (${stuck})`}; rerun ${rerun()} to resume`, upExitCodes.waiting);
        }
        await deps.sleep(pollMs);
      }
      if (onboarding) onboarding = { ...onboarding, waitingFor: [], merged: true };
    }
    // GY-1477: setup ends with the one sign-in link itself (minted with the operator's credential, a host
    // install's from its redeemed claim), on the reachable address, so nobody runs graphyard login afterwards.
    const base = await linkBase();
    const minted = base ? await mint() : null;
    signIn = minted && base ? setupAddress(base, signInAt(minted, base)) : null;
    const open = signIn ? `${signIn} (signs you in; works once, within 10 minutes)` : setupUrl ?? 'the dashboard';
    return result(true, upExitCodes.green, `Everything is green. Open ${open} and file what you want built.`);
  } catch (error) {
    if (!(error instanceof UpStop)) throw error;
    return result(false, error.exitCode, error.message);
  }

  function result(ok: boolean, exitCode: number, next: string): UpResult {
    return { ok, exitCode, herdrAttach, setupUrl, completed: [...state.completed], prompts, handoffs, checklist: last.map(({ id, done, line }) => ({ id, done, line })), onboarding, signIn, reachableUrl: state.tailnetUrl ?? null, next };
  }
}

/**
 * The `graphyard up` command: a run whose omitted --repo and --provider come from .graphyard/up.json,
 * and whose children a SIGINT or SIGTERM reaches (GY-1466).
 */
export async function upCommand(root: string, cliPath: () => Promise<string>, args: string[]): Promise<UpResult> {
  const request = upRequestFromArgs(args, recordedUp(root));
  if (request.mergeToken !== undefined) {
    request.mergeToken = await readSecretFromStdin(10000);
    if (!request.mergeToken) throw new Error('--merge-token-stdin requires a nonempty token on stdin');
  }
  const refusal = await upUrlRefusal(root, request.url);
  if (refusal) throw new Error(refusal);
  const emit = (event: UpEvent) => console.error(request.agent ? JSON.stringify(event) : describeUpEvent(event));
  const dependencies = upDependencies(root, await cliPath(), request, emit);
  // Ctrl-C or SIGTERM stops the install child too, so nothing outlives the command on purpose.
  const release = forwardSignals(dependencies.children);
  return runUp(request, dependencies).finally(release);
}

/**
 * GY-1641: why --url cannot drive this checkout, or null when it can. master init accepts only the
 * server .graphyard/master.json records (setupMaster), so a --url naming another one is refused here,
 * before any step runs, rather than at host-supervisor after the earlier steps have changed things.
 */
export async function upUrlRefusal(root: string, url: string | null | undefined) {
  if (!url) return null;
  let recorded = '';
  try { recorded = String(JSON.parse(await readFile(resolve(root, '.graphyard/master.json'), 'utf8')).url ?? ''); } catch { return null; }
  let origin = recorded;
  try { origin = new URL(recorded).origin; } catch { /* compared as written */ }
  return !recorded || origin === url ? null
    : `--url ${url} is not the control plane this checkout's master is set up with (${recorded} in .graphyard/master.json), and master init accepts no other; omit --url to use ${recorded}`;
}

/**
 * The repository and provider an earlier run recorded in .graphyard/up.json (GY-1466), so a
 * resumed `up` needs those flags again only when they differ; null when no run is recorded here.
 */
export function recordedUp(root: string): { repository: string; provider: string } | null {
  try {
    const state = JSON.parse(readFileSync(upStateFile(root), 'utf8'));
    if (state?.version !== 1 || typeof state.repository !== 'string' || typeof state.provider !== 'string') return null;
    return { repository: state.repository, provider: state.provider };
  } catch (error: any) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

/** The options `graphyard up` parses (GY-1510). */
export const upOptions = { 'merge-token-stdin': { type: 'boolean' }, 'base-branch': { type: 'string' }, repo: { type: 'string' }, provider: { type: 'string' }, agent: { type: 'boolean' }, json: { type: 'boolean' }, master: { type: 'string' }, wait: { type: 'string' }, 'share-tailnet': { type: 'boolean' }, local: { type: 'boolean' }, url: { type: 'string' } } as const;

/**
 * `graphyard up`'s flags. With a run RECORDED in this checkout, an omitted --repo or --provider is
 * the recorded one, and one that differs is refused, naming both: its steps say nothing about it.
 */
export function upRequestFromArgs(args: string[], recorded: { repository: string; provider: string } | null = null): UpRequest {
  const { values } = parseArgs({ args, options: upOptions, allowPositionals: false });
  // --local is --provider local (GY-1500): the control plane on embedded Postgres on this machine, no Docker.
  if (values.local && values.provider !== undefined && values.provider !== 'local') throw new Error(`graphyard up --local means --provider local; it cannot be combined with --provider ${values.provider}`);
  const provider = values.local ? 'local' : values.provider;
  for (const [flag, given, kept] of [['--repo', values.repo, recorded?.repository], ['--provider', provider, recorded?.provider]] as const) {
    if (given !== undefined && kept !== undefined && given !== kept) throw new Error(`graphyard up ${flag} ${given} conflicts with ${kept}, which the run recorded in .graphyard/up.json resumes; omit ${flag} (or pass ${kept}) to resume it, or remove .graphyard/up.json to start over for ${given}`);
  }
  const repository = values.repo ?? recorded?.repository;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Use graphyard up --repo OWNER/NAME [--provider compose|local | --local] [--agent]');
  const minutes = values.wait === undefined ? null : Number(values.wait);
  if (minutes !== null && (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1_440)) throw new Error('Use --wait with whole minutes from 1 to 1440');
  let url: string | null = null;
  // The origin rule master init applies (serverOrigin): HTTPS, or HTTP only on loopback.
  if (values.url !== undefined) { try { url = serverOrigin(values.url); } catch { throw new Error('Use --url with the control plane\'s origin: HTTPS, or HTTP on loopback (such as http://127.0.0.1:4311); no credentials, query or path'); } }
  return { repository, provider: provider ?? recorded?.provider ?? 'compose', agent: !!values.agent, master: values.master ?? 'claude',
    ...(values['base-branch'] ? { baseBranch: values['base-branch'] } : {}), ...(minutes !== null ? { waitMs: minutes * 60_000 } : {}), ...(values['share-tailnet'] ? { shareTailnet: true } : {}), ...(url ? { url } : {}), ...(values['merge-token-stdin'] ? { mergeToken: '' } : {}) };
}

/** A one-time dashboard sign-in address minted with the operator's admin credential, TOKEN or the one in FILE (as `graphyard login` mints it). */
export async function mintSignIn(server: string, file: string | null, fetcher: typeof fetch = fetch, token = ''): Promise<string | null> {
  if (!token && file) { try { token = (await readFile(file, 'utf8')).trim(); } catch { return null; } }
  if (token.length < 32) return null;
  const response = await fetcher(`${server.replace(/\/+$/, '')}/api/sign-in-links`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: '{}', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) return null;
  const link = await response.json() as { code?: string };
  return typeof link.code === 'string' ? `${server.replace(/\/+$/, '')}/#sign-in=${link.code}` : null;
}

/**
 * GY-1477: spend a host install's one-time claim (`SERVER/#claim=CODE`) for the admin credential it
 * yields (POST /api/signin/claim, as the dashboard would), so `up` can mint fresh sign-in links on a
 * machine that holds no operator token file. The credential is returned, never stored or printed.
 */
export async function redeemSignInClaim(link: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  const match = link.match(/^(https?:\/\/[^#]+?)\/*#claim=([A-Za-z0-9_-]{16,200})$/);
  if (!match) return null;
  const response = await fetcher(`${match[1]}/api/signin/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: match[2] }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) return null;
  const { token } = await response.json() as { token?: string };
  return typeof token === 'string' && token.length >= 32 ? token : null;
}

/** What `init --scan --apply` writes and the manual flow commits. */
export const onboardingFiles = ['AGENTS.md', '.gitignore', 'graphyard.json', onboardingCasePath] as const;
export { onboardingBranch };
/** The onboarding files every apply writes; a publish without one refuses (GY-1480). */
export const onboardingRequiredFiles = ['AGENTS.md', 'graphyard.json'] as const;

/**
 * Publish the onboarding files as one commit on the base branch's tip, on `graphyard/onboarding`.
 * The commit is built in a scratch index, so the operator's checkout, branch and staged changes are
 * untouched, and the branch is pushed so the change is visible; no pull request is opened — the
 * commit is submitted by head sha (GY-2938) and the control plane reads it from this checkout's own
 * object store. The commit is dated from the base tip, so a rerun over the same files publishes the
 * identical commit and pushes nothing new; when the base branch already holds them, nothing is
 * published.
 */
export async function publishOnboarding(root: string, repository: string, run: (program: string, args: string[], env?: Record<string, string>) => string, workflows: readonly string[] = []): Promise<{ commit: string } | null> {
  // GY-1480: every file the publish means to carry must be on disk; one that is not is refused by
  // name, never skipped, so the change never claims a file it does not hold.
  const missing = [...onboardingRequiredFiles, ...workflows].filter(file => !existsSync(resolve(root, file)));
  if (missing.length) throw new Error(`publishOnboarding refuses: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing from ${root}; rerun graphyard init --scan --apply, then graphyard up`);
  const record = await readInstallRecord(installDirectory(installIdFor(repository))).catch(() => null);
  const base = record?.baseBranch ?? run('gh', ['repo', 'view', repository, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']).trim();
  run('git', ['fetch', '--quiet', 'origin', base]);
  const baseCommit = run('git', ['rev-parse', 'FETCH_HEAD']).trim();
  const index = resolve(root, '.graphyard', `onboarding-index.${process.pid}`);
  await mkdir(dirname(index), { recursive: true });
  try {
    const env = { GIT_INDEX_FILE: index };
    run('git', ['read-tree', baseCommit], env);
    const present = [...new Set([...onboardingFiles, ...workflows])].filter(file => existsSync(resolve(root, file)));
    if (present.length) run('git', ['add', '--', ...present], env);
    const tree = run('git', ['write-tree'], env).trim();
    if (tree === run('git', ['rev-parse', `${baseCommit}^{tree}`]).trim()) return null;
    // Dated from the base tip, so the same files above the same tip always yield this one commit.
    const dated = { ...env, GIT_AUTHOR_DATE: run('git', ['show', '-s', '--format=%cI', baseCommit]), GIT_COMMITTER_DATE: run('git', ['show', '-s', '--format=%cI', baseCommit]) };
    const commit = run('git', ['commit-tree', tree, '-p', baseCommit, '-m', 'Add Graphyard onboarding: coordination instructions, configuration and delivery workflows'], dated).trim();
    // The branch is this command's own: an earlier, interrupted publish is replaced, never merged into.
    run('git', ['push', '--force', 'origin', `${commit}:refs/heads/${onboardingBranch}`]);
    return { commit };
  } finally { await rm(index, { force: true }); }
}

/**
 * GY-1466: SIGINT or SIGTERM to `up` is passed to every child it runs (the install above all),
 * and `up` exits once they have, 128 + the signal's number; a child still running after GRACE_MS,
 * or at a second signal, is killed. Returns what removes the handlers.
 */
export function forwardSignals(children: Set<ChildProcess>, options: { exit?: (code: number) => void; graceMs?: number } = {}) {
  const exit = options.exit ?? (code => process.exit(code));
  let stopping = false;
  const handler = (signal: NodeJS.Signals) => {
    const code = 128 + (signal === 'SIGINT' ? 2 : 15);
    const live = [...children].filter(child => child.exitCode === null && child.signalCode === null);
    if (stopping) { for (const child of live) child.kill('SIGKILL'); return; }
    stopping = true;
    if (!live.length) return exit(code);
    let left = live.length;
    const force = setTimeout(() => { for (const child of live) child.kill('SIGKILL'); }, options.graceMs ?? 10_000);
    for (const child of live) {
      child.once('exit', () => { if (--left === 0) { clearTimeout(force); exit(code); } });
      child.kill(signal);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, handler);
  return () => { for (const signal of ['SIGINT', 'SIGTERM'] as const) process.off(signal, handler); };
}

/** gh's own record of the login it is signed in as, read from its configuration: no GitHub API request. */
export const ghLoginArgs = ['config', 'get', 'user', '-h', 'github.com'];
/** The GitHub login this host's gh is authenticated as, or null when gh is not signed in. */
export function hostGithubLogin(): string | null {
  try { return execFileSync('gh', ghLoginArgs, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

/** The real dependencies: this CLI's own commands as children, the master identity's status read. */
export function upDependencies(root: string, cliPath: string, request: UpRequest, emit: (event: UpEvent) => void): UpDependencies & { children: Set<ChildProcess> } {
  // The children still running, for forwardSignals.
  const children = new Set<ChildProcess>();
  // GY-1641: --url, else the address master.json records, else the one this machine's install record (install.json) holds.
  const serverUrl = async () => {
    if (request.url) return request.url;
    try { const url = String(JSON.parse(await readFile(resolve(root, '.graphyard/master.json'), 'utf8')).url ?? ''); if (url) return url; } catch { /* not recorded yet */ }
    return (await readInstallRecord(installDirectory(installIdFor(request.repository))).catch(() => null))?.url ?? null;
  };
  // upUrlRefusal keeps --url to the server master.json records, so its credential is the one for serverUrl.
  const masterToken = async () => { const url = await serverUrl(); return url ? (await masterCredential(root, url))?.token ?? null : null; };
  // GY-1552: the children run in the checkout itself: gh (repository view/create, deploy key) and git (origin set to the SSH form, GY-2940).
  const childIn = (command: string, args: string[], input?: string) => new Promise<{ code: number; stdout: string; stderr?: string }>(accept => {
    const child = spawn(command, args, { cwd: root, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (input !== undefined) child.stdin!.end(input);
    let stdout = '', stderr = '';
    child.stdout!.on('data', chunk => { stdout += chunk; });
    child.stderr!.on('data', chunk => { stderr += chunk; });
    child.on('error', error => accept({ code: 1, stdout, stderr: String(error.message ?? error) }));
    child.on('close', code => accept({ code: code ?? 1, stdout, stderr }));
  });
  const childCommands = {
    gh: (args: string[], input?: string) => childIn('gh', args, input),
    git: (args: string[]) => childIn('git', args),
    installDirectory: () => installDirectory(installIdFor(request.repository)),
  };
  // The loop runs from the checkout of the CLI master init recorded, which is this CLI until it has.
  const loopCheckout = async () => {
    let recorded: unknown = null;
    try { recorded = JSON.parse(await readFile(resolve(root, '.graphyard/master.json'), 'utf8')).cliPath; } catch { /* not initialised yet */ }
    return readCoordinatorCheckout(coordinatorCheckoutRoot(typeof recorded === 'string' && recorded ? recorded : cliPath));
  };
  return {
    root, emit, serverUrl, masterToken, children,
    publishOnboarding: workflows => publishOnboarding(root, request.repository, (program, args, env) => execFileSync(program, args, { cwd: root, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env: { ...process.env, ...env } } : {}) }), workflows),
    // GY-1859: the checkout judged clean is the one this run installs — this CLI's, the same cliPath
    // the loop's code is judged against — never the one master.json still records: a migration from
    // checkout A to this CLI rewrites the loop onto this CLI, so uncommitted work in the obsolete A
    // stops nothing, and work in this CLI's own checkout stops the run before anything is installed.
    cliCheckout: async () => { const checkout = await readCoordinatorCheckout(coordinatorCheckoutRoot(cliPath)); return { root: checkout.root, dirty: dirtyCheckoutPaths(checkout) }; },
    landlockAbi: readLandlockAbi,
    loopRefusal: async () => coordinatorCheckoutRefusal(await loopCheckout(), 'the master loop'),
    // GY-1859: the loop unit is judged against the CLI running up, whose launcher and checkout are this run's.
    loopCode: async () => readLoopCode(root, { cliPath }),
    removeHeldCliPin: async () => removeHeldCliPin(loopCodeRoot(cliPath, root)),
    liftLoopPins: async () => liftLoopPins(root, { repository: request.repository }),
    fileOnboarding: async (commit, operatorTokenFile, requestId) => {
      const server = await serverUrl();
      let token = '';
      try { token = operatorTokenFile ? (await readFile(operatorTokenFile, 'utf8')).trim() : ''; } catch { /* no credential on this machine */ }
      if (!server || token.length < 32) return null;
      return fileOnboardingWork({ server, token, commit, checks: await onboardingChecks(root), caseId: await onboardingFirstCase(root), host: hostname(), path: resolve(root, '.graphyard', 'onboarding'), requestId });
    },
    work: async () => {
      const url = await serverUrl(), token = await masterToken();
      return url && token ? (await planeRequest(url, token)('work-snapshot'))?.work ?? null : null;
    },
    signIn: async (file, token) => { const url = await serverUrl(); return url ? mintSignIn(url, file, fetch, token) : null; },
    redeemClaim: claim => redeemSignInClaim(claim),
    tailnet: async () => {
      // No Tailscale, or one not running, is no tailnet: the offer is simply not made.
      try {
        const self = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }))?.Self;
        if (!self || self.Online === false) return null;
        const ip = Array.isArray(self?.TailscaleIPs) ? self.TailscaleIPs.find((address: unknown) => typeof address === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(address)) ?? null : null;
        return typeof self?.DNSName === 'string' || ip ? { dnsName: typeof self?.DNSName === 'string' && self.DNSName ? self.DNSName : null, ip } : null;
      } catch { return null; }
    },
    // Bounded: a serve waiting on a tailnet permission is reported, never waited on (GY-1477).
    applyTailnet: async command => {
      try { execFileSync(command[0], command.slice(1), { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }); return { ok: true }; }
      catch (error: any) { return { ok: false, detail: String(error?.stderr || error?.stdout || error?.message || error).trim() }; }
    },
    herdr: upHerdr(root, request.repository),
    operatorToken: async file => { if (!file) return null; try { const token = (await readFile(file, 'utf8')).trim(); return token.length >= 32 ? token : null; } catch { return null; } },
    sleep: ms => new Promise(accept => setTimeout(accept, ms)), now: () => Date.now(),
    cli: (args, options = {}) => new Promise((accept, reject) => {
      // ~/.local/bin is on the child's PATH, so a herdr Herdr's installer just put there is found (GY-1511).
      const child = spawn(process.execPath, [cliPath, ...args], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], ...(options.signal ? { signal: options.signal } : {}), env: { ...process.env, ...options.env, PATH: withLocalBin(process.env.PATH) } });
      children.add(child);
      child.on('exit', () => children.delete(child));
      let stdout = '', pending = '', stderr = '', firstStderr: string | undefined;
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => {
        pending += chunk;
        // Bounded: only the tail is ever shown (childTail).
        stderr = (stderr + chunk).slice(-64_000);
        const lines = pending.split('\n'); pending = lines.pop() ?? '';
        for (const line of lines) { if (firstStderr === undefined && line.trim()) firstStderr = line.slice(0, 4_000); if (!request.agent) process.stderr.write(`${line}\n`); options.onLine?.(line); }
      });
      child.on('error', reject);
      child.on('close', code => {
        if (pending) options.onLine?.(pending);
        if (firstStderr === undefined && pending.trim()) firstStderr = pending.slice(0, 4_000);
        accept({ code: code ?? 1, stdout, stderr, ...(firstStderr === undefined ? {} : { firstStderr }) });
      });
      child.stdin.end(options.stdin ?? '');
    }),
    credentialAnswers: async admin => {
      const url = await serverUrl();
      return url ? recordedCredentialAnswers(root, url, fetch, admin) : [];
    },
    status: async () => {
      const url = await serverUrl(), token = await masterToken();
      return url && token ? planeRequest(url, token)('status') : null;
    },
    supervise: async () => {
      // Only the login's name is read; gh's token stays in gh, used for setup alone (GY-1501).
      let login: string | null = null;
      try { login = hostGithubLogin(); } catch { /* recorded without it */ }
      const recorded = await recordSupervision(root, 'supervised', login);
      return { operatorLogin: recorded.operatorLogin };
    },
    // The merge writer's repository creation and deploy key run through gh, in the checkout itself.
    ...childCommands,
  };
}

/** Herdr on this host for `graphyard up` (GY-1511), through master/herdr.ts. */
export function upHerdr(root: string, repository: string, deps: HerdrHostDeps = hostHerdrDeps()): UpHerdr {
  return {
    binary: () => ensureHerdrBinary(deps),
    server: async (binary, instance, installId) => {
      if (instance) await prepareHerdrInstance(deps, instance);
      const server = await ensureHerdrServer(deps, binary, instance, installId);
      return { ...server, workspace: instance ? await ensureHerdrWorkspace(deps, binary, instance, root, repository.split('/').pop() || repository) : null };
    },
    record: async (instance, workspace) => { await recordHerdrInstance(root, instance, workspace); },
    plugin: async instance => {
      const run = (args: string[]) => herdrSync(args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }, instance);
      const url = (await herdrPluginBinding(run))?.url;
      return url ? { url, enabled: await herdrPluginEnabled(run) === true } : null;
    },
    enable: async instance => {
      try { herdrSync(['plugin', 'enable', 'graphyard'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }, instance); }
      catch (error: any) { throw new HerdrSetupFailure('plugin', `herdr plugin enable graphyard${instance ? ` in session ${instance.session}` : ''} exited ${error?.status ?? 'abnormally'}: ${`${error?.stderr ?? ''}`.trim().split('\n').slice(-3).join(' ').slice(0, 300) || error?.message || 'no output'}`); }
    },
  };
}

/** One line a person reads for an event, as the interactive run prints it. */
export function describeUpEvent(event: UpEvent) {
  if (event.kind === 'step') return event.state === 'start' ? `→ ${event.step}` : `${event.state === 'done' ? '✓' : '·'} ${event.step}${event.detail ? `: ${event.detail}` : ''}`;
  if (event.kind === 'step-failed') return `✗ ${event.step}: ${event.detail}`;
  if (event.kind === 'waiting') return `\n${event.sentence}\n`;
  if (event.kind === 'onboarding') return !event.wait.waitingFor.length ? `· onboarding: ${event.wait.key}: ${event.wait.line}` : `· onboarding: ${event.wait.key} waits for ${event.wait.waitingFor.join(' and ')}, ${waitedFor(event.wait.waitedMs)} so far; the loop reviews and merges it`;
  if (event.kind === 'handoff') return `NEEDS YOU: ${event.sentence}${event.code ? ` (code ${event.code})` : ''}${event.url ? ` — ${event.url}` : ''}`;
  return event.text;
}
