import { randomUUID } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { goalSubmission, setupAddress, setupChecklist, type SetupItem, type SetupItemId } from './model/setup-checklist.js';
import { actionsDirectory, agentBrowserPage, browserProfileMode, offeredSudoMethods, passSudo, recordingPage, submitSudoCode, sudoInstruction, sudoProtectedPage, sudoStateSchema, takeSudoCode, type BrowserPage, type BrowserProfileMode, type RecordedStep, type SudoOptions, type SudoState } from './master-browser.js';
import { appImportRoute } from './github-setup.js';
import { masterCredential, planeRequest } from './setup-from-zero.js';
import { fileOnboardingWork, onboardingChecks } from './onboarding.js';
import { findOnboardingWork, onboardingBranch, onboardingWait, waitedFor, type OnboardingWait } from './model/onboarding-work.js';
import { coordinatorCheckoutRefusal, coordinatorCheckoutRoot, dirtyCheckoutPaths, readCoordinatorCheckout } from './master/profiles.js';
import { redactString } from './evidence-replay.js';
import { recordSupervision } from './master/config.js';
import { unitCheckout, userUnitDirectory } from './install/units.js';
import { installIdFor } from './install/types.js';
import { installDirectory, readInstallRecord } from './install/secrets.js';
import { ensureDeployKey } from './install/deploy-key.js';
import type { GitHubCli } from './install/github.js';
import { herdrAttachCommand, installHerdrInstance, type HerdrInstance } from './master/herdr.js';
import { ensureHerdrBinary, ensureHerdrServer, ensureHerdrWorkspace, HerdrSetupFailure, herdrSync, hostHerdrDeps, prepareHerdrInstance, withLocalBin, type HerdrHostDeps } from './herdr-host.js';
import { herdrBoundElsewhere, herdrPluginBinding, herdrPluginEnabled } from './repository-setup.js';
import { recordHerdrInstance } from './master/config.js';
import { mergerModes, type MergerMode } from './merger-mode.js';

/**
 * `graphyard up` (GY-1419): every machine step of a first installation, in order — preflight,
 * control plane, host supervisor and Herdr, the master's agent identities (GY-1479), onboarding, agent accounts, harness, master loop — and
 * a wait on the first-run checklist (src/model/setup-checklist.ts) wherever a person must act.
 * Each step is an existing idempotent command run as a child of this CLI, and each completed step
 * is recorded in .graphyard/up.json, so a rerun after any interruption skips what is done and never
 * registers an identity, App or variable twice. Every run sets Herdr up (GY-1511): it installs herdr
 * when missing and keeps its server running as a user unit. It never repoints a Herdr plugin bound
 * to another server: the install gets its own Herdr instance instead (--herdr-instance).
 *
 * Interactive, a human step prints the dashboard's Setup page address once and waits for the step
 * to turn green. That address is a one-time sign-in link minted with the operator's own credential
 * (a host install's, from its redeemed claim) and ending `&setup`, so opening it signs the person in and lands on
 * the Setup page with no token to paste. With --agent, every step has a non-interactive path (the
 * App manifest is driven through the master's browser profile and recorded under
 * .graphyard/master-actions like every master browser flow, accounts come from login homes already
 * on the host, the goal from a file) and only a step that needs a person's own device or identity —
 * a GitHub Mobile or passkey approval, a subscription login's browser approval — is handed off, as
 * one sentence plus a link or code; the run resumes on its own once it completes. Agent mode with
 * no browser profile stops before anything runs: App creation is never handed to a person.
 *
 * `up --local` sets up supervised mode (GY-1501): no reviewer App, no master-autonomy identities, and
 * master.json records `supervision: supervised` with the operator's GitHub login, so the operator
 * reviews and merges each pull request on GitHub and nothing claims autonomy.
 *
 * `up --merger control-plane` (GY-1552): no GitHub Apps and no browser profile; `install --no-github-app`,
 * a deploy key from the operator's `gh` login, `POST /api/merger` as admin, then the same autonomy,
 * onboarding, accounts, harness, master-loop and goal steps. The github-mode step list is unchanged.
 */

/** `up --local` installs supervised (GY-1501): the operator reviews and merges on GitHub. */
export const upSupervised = (request: Pick<UpRequest, 'provider'>) => request.provider === 'local';
/** GY-1552: `up --merger control-plane` — the control plane is the merge writer, with no GitHub Apps. */
export const upMergerControlPlane = (request: Pick<UpRequest, 'merger'>) => request.merger === 'control-plane';
/** GitHub-mode step list (unchanged by GY-1552). */
export const upSteps = ['preflight', 'control-plane', 'host-supervisor', 'master-autonomy', 'onboarding', 'accounts', 'harness', 'master-loop', 'goal'] as const;
/** Control-plane merger step list: deploy-key and merger-setting between host-supervisor and master-autonomy. */
export const upControlPlaneSteps = ['preflight', 'control-plane', 'host-supervisor', 'deploy-key', 'merger-setting', 'master-autonomy', 'onboarding', 'accounts', 'harness', 'master-loop', 'goal'] as const;
export type UpStep = typeof upControlPlaneSteps[number];
/** The resumable steps for REQUEST: control-plane merger or the github-mode list. */
export const upStepsFor = (request: Pick<UpRequest, 'merger'>) => upMergerControlPlane(request) ? upControlPlaneSteps : upSteps;

export interface UpRequest {
  repository: string;
  provider: string;
  /** The non-interactive agent path (`graphyard up --agent`). */
  agent: boolean;
  reviewer: string;
  /** The agent runtime the master and harness are set up for. */
  master: string;
  /** A file holding the goal to submit once the checklist is green. */
  goalFile: string | null;
  /** The Chrome profile signed in to GitHub that drives the App manifest in agent mode; the master's recorded one when omitted. */
  browserProfile: string | null;
  /**
   * GY-1552: which writer lands heads — omit or `github` for the App-based path; `control-plane` for
   * `up --merger control-plane` (no Apps, deploy key + merger setting).
   */
  merger?: MergerMode;
  /**
   * Passed on to `graphyard install` unchanged: the operator's consent to a created server's monthly
   * price (`--confirm-price X` or `--max-monthly N`) and the SSH key or machine it is reached with.
   */
  install?: { confirmPrice?: string | null; maxMonthly?: string | null; sshKey?: string | null; sshHost?: string | null; sshUser?: string | null };
  /** GY-1442: Apps already installed on the account that install reuses instead of creating (`--reuse-app SLUG`). */
  reuseApps?: string[];
  /**
   * How a Confirm-access prompt is passed: the passkey or password the page offers first, or GitHub
   * Mobile first when the operator chose it (`--github-mobile`).
   */
  sudo?: SudoOptions['prefer'];
  /** GY-1457: how long each wait on a person lasts (`--wait MINUTES`), the browser's Confirm access included; upWaitMs when omitted. */
  waitMs?: number | null;
  /** GY-1457: at Confirm access, exit 3 with the App-import route instead of waiting (`--no-wait`). */
  noWait?: boolean;
  /** GY-1477: serve a local dashboard on this host's tailnet (`--share-tailnet`); otherwise the command is only printed. */
  shareTailnet?: boolean;
  /**
   * GY-1641: the control plane's address (`--url`), when it is not the one the install recorded. Every
   * child command after the install is pointed at the recorded address (this, else master.json, else
   * the install record), never at a default port.
   */
  url?: string | null;
}
/** Agent mode's default wait on a person: 20 minutes, the time the Confirm-access handoff asks for (GY-1457). */
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
  /** GY-1478: the onboarding pull request is the current setup step: its URL, what it waits for and how long it has waited. */
  | { kind: 'onboarding'; wait: OnboardingWait }
  | { kind: 'note'; text: string };

/** What a device step hands to a person, or that it completed. */
export type DriveOutcome = { state: 'done' } | { state: 'failed'; reason: string } | { state: 'waiting'; next: string }
  /** GY-1510: GitHub rejected the App (manifest or form), with GitHub's own error text. */
  | { state: 'rejected'; error: string };
export type Handoff = (sentence: string, link: { url?: string | null; code?: string | null }) => void;

export interface UpDependencies {
  root: string;
  /** Runs one graphyard command; stderr lines go to onLine as they arrive, and its tail comes back as stderr (GY-1509). */
  cli(args: string[], options?: { stdin?: string; env?: Record<string, string>; onLine?: (line: string) => void; signal?: AbortSignal }): Promise<{ code: number; stdout: string; stderr?: string }>;
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
   * .github/workflows) as a pull request against the base branch, reusing one already open; null when
   * the base branch already holds them. WORKFLOWS are the workflow files the apply reported writing:
   * a publish missing any of them, or AGENTS.md or graphyard.json, refuses naming the file (GY-1480).
   */
  publishOnboarding(workflows: string[]): Promise<{ pullRequest: string } | null>;
  /** Whether the onboarding pull request at URL has merged, so the base branch carries the delivery workflows. */
  onboardingMerged(url: string): Promise<boolean>;
  /**
   * File the onboarding pull request at URL as a work item the loop owns (GY-1478), with the
   * operator's admin credential in OPERATOR_TOKEN_FILE and request id REQUESTID (fixed across
   * reruns, so it is filed once): the loop's reviewer reviews it and the control plane merges it
   * under the normal gates. Null when no admin credential is on this machine.
   */
  fileOnboarding?(url: string, operatorTokenFile: string | null, requestId: string): Promise<{ key: string } | null>;
  /** The control plane's work items, as the master identity reads them; null while none answers. */
  work?(): Promise<any[] | null>;
  /**
   * GY-1480: the CLI checkout the master loop will run from, and the paths that make it dirty (empty
   * when clean). The loop refuses to start from a dirty one, so preflight refuses first.
   */
  cliCheckout?(): Promise<{ root: string; dirty: string[] }>;
  /** GY-1480: why the master loop refuses to run, as the loop itself words it, or null while nothing stops it. */
  loopRefusal?(): Promise<string | null>;
  /**
   * GY-1501: record supervised mode in master.json with the operator's GitHub login, read from gh's
   * own session as a name only: the gh credential is used for setup and never written anywhere.
   */
  supervise?(): Promise<{ operatorLogin: string | null }>;
  /** Agent mode: drive the App manifest page at URL in the master's browser profile, recorded as a master browser flow. */
  driveApp?(url: string, handoff: Handoff): Promise<DriveOutcome>;
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
  gh?(args: string[]): Promise<{ code: number; stdout: string; stderr?: string }>;
  /** GY-1552: the install directory that holds the deploy key; defaults to `~/.config/graphyard/<installId>`. */
  installDirectory?(): string;
  /** GY-1552: ensure the install's deploy key on REPOSITORY; defaults to ensureDeployKey. */
  ensureDeployKey?(installDir: string, repository: string): Promise<string>;
  /**
   * GY-1552: `POST /api/merger` as admin to set the control-plane writer. Defaults to
   * `master merger control-plane` with the admin credential.
   */
  setMerger?(adminToken: string, requestId: string): Promise<void>;
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
/**
 * The provider whose master loop runs on another machine: a self-contained host (`--provider host`,
 * install's --target host), set up there by `install --herdr-only` on every run. Every other
 * provider, hetzner and docker-host included, installs only the server elsewhere: its loop and
 * Herdr run here.
 */
const remoteLoopProviders = ['host'];

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
  goal: string | null;
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
/** The drive met Confirm access under --no-wait: it stops there, naming the next step (GY-1457). */
class SudoNoWait extends Error {}

interface UpState {
  version: 1; repository: string; provider: string; completed: UpStep[]; noHerdr: boolean; goal: string | null;
  /** GY-1552: which merger path this run recorded; omitted means github (the default before the field existed). */
  merger?: MergerMode;
  /** Where the install saved the operator's admin credential (a path, never the secret): what mints the sign-in link. */
  operatorTokenFile?: string | null;
  /** The goal's request id, fixed before the first try so a rerun after an interruption never creates it twice. */
  goalRequest?: string | null;
  /** GY-1552: idempotency key for `POST /api/merger`, fixed across reruns so the setting is written once. */
  mergerRequest?: string | null;
  /** The pull request that publishes the onboarding files, until it merges. */
  onboardingPullRequest?: string | null;
  /** The work item that pull request is filed as (GY-1478), and the request id that files it once. */
  onboardingWork?: string | null;
  onboardingRequest?: string | null;
  /** GY-1477: the tailnet address a local dashboard was served on, once `tailscale serve` applied it. */
  tailnetUrl?: string | null;
  /** The host that provisioned the master's agent identities itself (GY-1479), where its loop runs. */
  identitiesHost?: string | null;
  /** GY-1511: the host's default Herdr serves another install, so this one has its own instance (--herdr-instance). */
  herdrInstance?: boolean;
  /** GY-1511: why Herdr is left out (noHerdr): the named failure of the step that could not set it up. */
  herdrFailure?: string | null;
}
export const upStateFile = (root: string) => resolve(root, '.graphyard/up.json');
const knownUpSteps = upControlPlaneSteps as readonly string[];

async function readState(root: string, request: UpRequest): Promise<UpState> {
  const merger = request.merger ?? 'github';
  try {
    const state = JSON.parse(await readFile(upStateFile(root), 'utf8'));
    // A run for another repository, provider or merger starts over: its steps say nothing about this one.
    if (state?.version === 1 && state.repository === request.repository && state.provider === request.provider
      && (state.merger ?? 'github') === merger) {
      return { ...state, merger, completed: (state.completed ?? []).filter((step: string) => knownUpSteps.includes(step)) };
    }
  } catch (error: any) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  return { version: 1, repository: request.repository, provider: request.provider, merger, completed: [], noHerdr: false, goal: null };
}
async function writeState(root: string, state: UpState) {
  const file = upStateFile(root);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

const parseJson = (text: string) => { try { return JSON.parse(text); } catch { return null; } };
/** The manifest page the installer announces while it waits for an App. */
const manifestUrl = (line: string) => line.match(/\bOpen (http:\/\/127\.0\.0\.1:\d+)\S*/)?.[1] ?? null;
/**
 * What an install's JSON output (its plan, or its summary, complete or paused) says about signing
 * in: a host install's one-time claim link, printed once and kept only in memory, and where the
 * operator's admin credential is saved when it is saved on this machine (a host install keeps it on
 * the host, so its plan names none).
 */
function installSignIn(stdout: string) {
  const output = parseJson(stdout);
  if (!output || typeof output !== 'object') return { claim: null, operatorTokenFile: null, identitiesHost: null };
  const admin = Array.isArray(output.principals) ? output.principals.find((principal: any) => principal?.role === 'admin') : null;
  const operatorTokenFile = typeof admin?.tokenFile === 'string' ? admin.tokenFile as string
    : !output.host && typeof output.installDirectory === 'string' && typeof admin?.id === 'string' ? resolve(output.installDirectory, 'tokens', `${admin.id}.token`) : null;
  const identitiesHost = output.host?.masterIdentities === true ? String(output.host.host ?? 'the host') : null;
  return { claim: typeof output.signIn === 'string' && /#claim=[A-Za-z0-9_-]{16,200}$/.test(output.signIn) ? output.signIn as string : null, operatorTokenFile, identitiesHost };
}
/**
 * Keep where the operator's credential is saved (the path, never the secret), for the sign-in link,
 * and the host that provisioned the master's identities when a host install did.
 */
async function rememberSignIn(root: string, state: UpState, stdout: string) {
  const { claim, operatorTokenFile, identitiesHost } = installSignIn(stdout);
  if ((operatorTokenFile && operatorTokenFile !== state.operatorTokenFile) || (identitiesHost && identitiesHost !== state.identitiesHost)) {
    if (operatorTokenFile) state.operatorTokenFile = operatorTokenFile;
    if (identitiesHost) state.identitiesHost = identitiesHost;
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
export const childFirstStderr = (result: { stderr?: string }) => {
  const line = (result.stderr ?? '').split('\n').map(text => text.trim()).find(Boolean);
  return line ? redactLine(line).slice(0, 500) : null;
};
/** GY-1641: the stop a failed child ends its step with: childFailure's message, its argv and first stderr line. */
const childStop = (step: string, args: string[], result: { code: number; stdout: string; stderr?: string }, more = '', exitCode: number = upExitCodes.failed) =>
  new ChildStop(childFailure(step, args, result, more), exitCode, args.map(redactLine), childFirstStderr(result));

export const signInAt = (link: string, base: string) => { const at = link.indexOf('#'); return at < 0 ? link : `${base.replace(/\/+$/, '')}/${link.slice(at)}`; };
/** Both of the master's agent identities are recorded in master.json and their credential files are readable. */
async function provisioned(root: string) {
  const config = await readFile(resolve(root, '.graphyard/master.json'), 'utf8').then(parseJson, () => null);
  const identities = [config?.operatorAgent, config?.approver];
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
  const controlPlaneMerger = upMergerControlPlane(request);
  let setupUrl: string | null = null, prompts = 0, last: SetupItem[] = setupChecklist(null, { supervised, ...(controlPlaneMerger ? { merger: 'control-plane' as const } : {}) }), claim: string | null = null, operator: string | null = null, onboarding: OnboardingWait | null = null, signIn: string | null = null;
  const handoffs: UpResult['handoffs'] = [];
  const handedOff = new Set<string>();
  const handoff = (step: UpStep): Handoff => (sentence, link) => {
    const key = `${step}:${sentence}`;
    if (handedOff.has(key)) return;
    handedOff.add(key);
    const entry = { step, sentence, url: link.url ?? null, code: link.code ?? null };
    handoffs.push(entry); deps.emit({ kind: 'handoff', ...entry });
  };
  const checklist = async () => (last = setupChecklist(await deps.status().catch(() => null), { supervised, ...(controlPlaneMerger ? { merger: 'control-plane' as const } : {}) }));
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
      const pending = ids.filter(id => !items.find(item => item.id === id)?.done);
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
  const passed = request.install ?? {};
  // Supervised installs register no reviewer App (GY-1501): the operator is the reviewer.
  // Control-plane merger (GY-1552) registers no App at all: install --no-github-app, no --reviewer.
  const installArgs = (mode: '--plan' | '--apply') => ['install', '--provider', request.provider, '--repo', request.repository, ...(controlPlaneMerger ? ['--no-github-app'] : supervised ? [] : ['--reviewer', request.reviewer]), mode, ...(state.noHerdr ? ['--no-herdr'] : state.herdrInstance ? ['--herdr-instance'] : []),
    ...([['--confirm-price', passed.confirmPrice], ['--max-monthly', passed.maxMonthly], ['--ssh-key', passed.sshKey], ['--ssh-host', passed.sshHost], ['--ssh-user', passed.sshUser]] as const).flatMap(([flag, value]) => value ? [flag, value] : []),
    ...(controlPlaneMerger ? [] : (request.reuseApps ?? []).flatMap(slug => ['--reuse-app', slug]))];
  const rerun = () => `graphyard up --repo ${request.repository} --provider ${request.provider}${controlPlaneMerger ? ' --merger control-plane' : ''}${request.agent ? ' --agent' : ''}`;
  /** GY-1552: create OWNER/NAME with the operator's gh login when it does not exist yet. */
  const ensureRepository = async () => {
    if (!deps.gh) throw new UpStop('preflight: control-plane merger needs gh on this machine to create the repository when it is missing', upExitCodes.prerequisite);
    const view = await deps.gh(['repo', 'view', request.repository, '--json', 'name']);
    if (view.code === 0) return;
    const created = await deps.gh(['repo', 'create', request.repository, '--private', '--source', '.', '--push']);
    if (created.code !== 0) throw new UpStop(`preflight: gh repo create ${request.repository} --source . --push exited ${created.code}${created.stderr ? `: ${created.stderr.split('\n')[0].slice(0, 300)}` : ''}; create it under the operator's gh login, then rerun ${rerun()}`, upExitCodes.prerequisite);
    deps.emit({ kind: 'note', text: `Created private repository ${request.repository} with gh repo create (operator's gh login).` });
  };
  const step = async (name: UpStep, body: () => Promise<string | void>) => {
    if (state.completed.includes(name)) { deps.emit({ kind: 'step', step: name, state: 'skipped', detail: 'done by an earlier run' }); return; }
    deps.emit({ kind: 'step', step: name, state: 'start' });
    let detail: string | void;
    try { detail = await body(); }
    catch (error) {
      // GY-1641: a started step always ends with an outcome event: a person's wait is a step event,
      // anything else a step-failed naming the child that failed; an unexpected error fails the step (exit 1).
      const stop = error instanceof UpStop ? error : new UpStop(`${name}: ${String((error as any)?.message ?? error).split('\n')[0].slice(0, 500)}`, upExitCodes.failed);
      if (stop.exitCode === upExitCodes.waiting) deps.emit({ kind: 'step', step: name, state: 'waiting', detail: stop.message.split('\n')[0] });
      else deps.emit({ kind: 'step-failed', step: name, exitCode: stop.exitCode, argv: stop instanceof ChildStop ? stop.argv : null, stderr: stop instanceof ChildStop ? stop.stderr : null, detail: stop.message.split('\n')[0] });
      throw stop;
    }
    await complete(name, detail || undefined);
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
    const remoteLoop = remoteLoopProviders.includes(request.provider);
    const herdrHost = deps.herdr && !remoteLoop ? deps.herdr : null;
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

    // Agent mode creates the Apps in a browser; without a profile it would hand the whole App
    // creation to a person, which only a device approval may be. It stops before anything runs.
    // A reused App (GY-1442) or one saved on this machine (GY-1476) needs no browser, so agent mode
    // starts without one only when the install's read-only plan says no App is left to create in a
    // browser: install reuses a saved App before any App page is driven.
    // Control-plane merger (GY-1552) registers no App, so agent mode needs no browser profile.
    const noProfile = 'Agent mode creates the GitHub Apps in a Chrome profile signed in to GitHub, and none is given or recorded, here or by another Graphyard install on this host for the same GitHub login: pass --browser-profile PROFILE and rerun graphyard up --agent.';
    if (request.agent && !controlPlaneMerger && !state.completed.includes('control-plane') && !deps.driveApp) {
      const browserApps: unknown = parseJson(await run('preflight', installArgs('--plan')))?.browserApps;
      const left = Array.isArray(browserApps) ? browserApps.map(String) : ['control-plane', 'reviewer'];
      const apps = left.map(role => role === 'reviewer' ? `reviewer App "${request.reviewer}"` : 'control-plane App').join(' and ');
      if (left.length) throw new UpStop(request.reuseApps?.length ? `${noProfile} --reuse-app covers no ${apps}, which would otherwise be created in that browser; reuse one for it too, or pass the profile.` : `${noProfile} No App saved on this machine covers the ${apps}.`, upExitCodes.prerequisite);
    }

    await step('preflight', async () => {
      // GY-1552: the repository must exist for deploy-key registration; create it under the operator's gh login when missing.
      if (controlPlaneMerger) await ensureRepository();
      for (let attempt = 0; attempt < 2; attempt++) {
        const planned = await run('preflight', installArgs('--plan'));
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
        // Spending money is the operator's decision: an unconfirmed price waits on that consent (exit 3), it is not a failure.
        const price = failed.find(check => check.name === 'Monthly price');
        if (price && failed.length === 1) throw new UpStop(`Creating the server needs the operator's consent to its price: ${price.detail ?? 'not confirmed'}. Once they approve it, rerun ${rerun()} --confirm-price PRICE (or --max-monthly N); nothing has been created.`, upExitCodes.waiting);
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
        if (server.started) deps.emit({ kind: 'note', text: `The Herdr server${ownHerdr ? ` for session ${ownHerdr.session}` : ''} was not running; it now runs as the user unit ${server.unit}, which restarts it after a failure or a reboot.` });
      } catch (error) { await leaveHerdrOut(error); }
    }

    const controlPlane = () => step('control-plane', async () => {
      // GY-1552: control-plane merger installs with --no-github-app; no App page is served or driven.
      if (controlPlaneMerger) {
        const result = await deps.cli(installArgs('--apply'));
        claim = await rememberSignIn(deps.root, state, result.stdout) ?? claim;
        if (result.code !== 0) throw childStop('control-plane', installArgs('--apply'), result);
        return 'control plane installed without a GitHub App (--no-github-app)';
      }
      // The install waits on the App pages itself, as long as this run waits on a person (900 s
      // without a bound); it then pauses (exit 1) and a rerun resumes it. The page's clock starts
      // before the drive reaches Confirm access, so it gets a minute more than the drive waits.
      const deadline = deps.now() + humanWaitMs;
      const appWait = Number.isFinite(humanWaitMs) ? { GRAPHYARD_APP_WAIT_MS: String(humanWaitMs + 60_000) } : null;
      // GY-1466: a drive that gives up (Confirm access unanswered) leaves the page to the operator. The
      // page stays served and up keeps waiting, to its overall wait, on the manual route; nothing drives
      // again in this run, so the operator's browser and the agent's never both register an App.
      const gaveUp: string[] = [];
      const manual = (url: string) => handoff('control-plane')(`The agent's browser could not finish the App page (${gaveUp.join('; ')}). Open ${url} in your own browser${/^http:\/\/127\.0\.0\.1:/.test(url) ? ` (on SSH, forward port ${new URL(url).port} to this machine first)` : ''} and finish it there: graphyard up keeps serving it and carries on once the App is confirmed.`, { url });
      for (;;) {
        // A drive that stops at Confirm access under --no-wait ends the install it drives too.
        const stopped = new AbortController();
        const waiting: string[] = [], refused: string[] = [];
        // One browser drive at a time, in the order the installer serves its App pages.
        let drives: Promise<void> = Promise.resolve();
        let running = true;
        const watcher = (async () => {
          while (running) {
            const items = await checklist();
            const pending = (['github-app', 'reviewer-app'] as SetupItemId[]).filter(id => !items.find(item => item.id === id)?.done);
            if (pending.length && await deps.serverUrl()) await announce(pending);
            await deps.sleep(pollMs);
          }
        })();
        const result = await deps.cli(installArgs('--apply'), { ...(appWait ? { env: appWait } : {}), signal: stopped.signal, onLine: line => {
          const url = manifestUrl(line);
          if (!url || !request.agent || !deps.driveApp) return;
          drives = drives.then(async () => {
            if (stopped.signal.aborted) return;
            if (gaveUp.length) return manual(url);
            const outcome = await deps.driveApp!(url, handoff('control-plane'));
            if (outcome.state === 'waiting') { waiting.push(outcome.next); stopped.abort(); }
            // GY-1510: a rejection is no wait on a person; the install it drives stops, and up fails quoting GitHub.
            if (outcome.state === 'rejected') { refused.push(outcome.error); stopped.abort(); }
            if (outcome.state === 'failed') { gaveUp.push(outcome.reason); manual(url); }
          });
        } }).catch(error => { if (stopped.signal.aborted) return { code: 1, stdout: '' }; throw error; }).finally(() => { running = false; });
        await watcher;
        await drives;
        if (refused.length) throw new UpStop(`GitHub rejected the App: "${refused[0]}". control-plane failed: GitHub refused the App page the install served, so the install was stopped; this is GitHub's answer, not a wait on a person.`, upExitCodes.failed);
        if (waiting.length) throw new UpStop(waiting[0], upExitCodes.waiting);
        claim = await rememberSignIn(deps.root, state, result.stdout) ?? claim;
        if (result.code === 0) return 'control plane installed with its GitHub Apps';
        const paused = parseJson(result.stdout);
        const drove = gaveUp.length ? `; the browser could not finish the App page (${gaveUp.join('; ')}), its record is under .graphyard/master-actions` : '';
        if (!paused?.resume || deps.now() >= deadline) throw paused?.resume ? new UpStop(`control-plane: graphyard install exited ${result.code}${drove}; the App page is still unconfirmed, rerun graphyard up to resume`, upExitCodes.waiting) : childStop('control-plane', installArgs('--apply'), result, drove);
        deps.emit({ kind: 'note', text: 'The App page is still waiting for a person; serving it again' });
      }
    });
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
    // A self-contained host's loop and Herdr run there: its install's control-plane step, once done,
    // never runs again, so `install --herdr-only` sets Herdr up there on every run, its own instance too.
    if (remoteLoop) {
      const args = [...installArgs('--apply'), '--herdr-only'].filter(arg => arg !== '--no-herdr' && arg !== '--herdr-instance');
      const result = await deps.cli(args);
      const output = parseJson(result.stdout);
      if (typeof output?.herdr?.attach === 'string') {
        herdrAttach = output.herdr.attach;
        if (state.noHerdr || state.herdrFailure) { state.noHerdr = false; state.herdrFailure = null; await writeState(deps.root, state); }
      } else await leaveHerdrOut(new HerdrSetupFailure(['install', 'server', 'workspace', 'plugin'].includes(output?.herdrFailure?.step) ? output.herdrFailure.step : 'server',
        typeof output?.herdrFailure?.message === 'string' ? output.herdrFailure.message.replace(/^Herdr \w+ failed: /, '') : `graphyard install --herdr-only exited ${result.code}: ${childTail(result, 3) || 'no output'}`));
    }
    if (herdrAttach) deps.emit({ kind: 'note', text: `Watch this install's agents in Herdr: ${herdrAttach}` });

    await step('host-supervisor', async () => {
      const token = await deps.masterToken();
      if (!token) throw new UpStop('host-supervisor: no master credential is recorded for the installed control plane', upExitCodes.failed);
      // GY-1641: master init accepts the control plane on the recorded address, never its default port.
      const server = await deps.serverUrl();
      await run('host-supervisor', ['master', 'init', '--token-stdin', ...(server ? ['--url', server] : []), ...(request.browserProfile ? ['--browser-profile', request.browserProfile] : [])], { stdin: token });
    });
    // Recorded on every run (idempotent), so a resumed run that skipped master init still installs supervised.
    if (supervised && deps.supervise) {
      const { operatorLogin } = await deps.supervise();
      deps.emit({ kind: 'note', text: `Supervised mode: you review and merge each pull request on GitHub${operatorLogin ? ` (as ${operatorLogin}; a pull request your own login opens needs another person's approval)` : ''}; no agent reviewer or approver runs.` });
    }

    // GY-1552: deploy key under the install directory, then POST /api/merger as admin so the checklist
    // treats App and protection items as not required. Github mode never runs these steps.
    if (controlPlaneMerger) {
      await step('deploy-key', async () => {
        const directory = deps.installDirectory?.() ?? installDirectory(installIdFor(request.repository));
        const ensure = deps.ensureDeployKey ?? (async (installDir, repository) => {
          if (!deps.gh) throw new UpStop('deploy-key: control-plane merger needs gh on this machine to register the deploy key', upExitCodes.prerequisite);
          const gh: GitHubCli = async (args, options) => {
            const result = await deps.gh!(args);
            if (result.code !== 0 && !options?.allowFailure) throw new Error(`gh ${args.join(' ')} exited ${result.code}${result.stderr ? `: ${result.stderr.split('\n')[0].slice(0, 200)}` : ''}`);
            return { stdout: result.stdout, stderr: result.stderr ?? '', code: result.code };
          };
          return ensureDeployKey(installDir, repository, gh);
        });
        await ensure(directory, request.repository);
        return 'deploy key registered read-write for the merge writer';
      });
      await step('merger-setting', async () => {
        const current = await deps.status().catch(() => null);
        if (current?.mergeWriter?.merger === 'control-plane') return 'merger already control-plane';
        const admin = await deps.operatorToken?.(state.operatorTokenFile ?? null).catch(() => null) ?? null;
        if (!admin) throw new UpStop(`merger-setting: the operator's admin credential is not on this machine${state.operatorTokenFile ? ` (${state.operatorTokenFile} is unreadable)` : ''}, so POST /api/merger cannot set the control-plane writer; place it and rerun ${rerun()}`, upExitCodes.prerequisite);
        if (!state.mergerRequest) { state.mergerRequest = randomUUID(); await writeState(deps.root, state); }
        if (deps.setMerger) await deps.setMerger(admin, state.mergerRequest);
        else {
          const args = ['master', 'merger', 'control-plane', '--reason', 'graphyard up --merger control-plane'];
          const result = await child(args, { env: { GRAPHYARD_TOKEN: admin, GRAPHYARD_REQUEST_ID: state.mergerRequest } });
          if (result.code !== 0) throw childStop('merger-setting', args, result);
        }
        return 'POST /api/merger set the control-plane writer';
      });
    }

    // GY-1479: the master's operator-agent and approver identities (`master autonomy --apply`), provisioned
    // with the admin credential the install saved, so the new master creates, releases and unblocks work
    // with no further command. That credential is never something an agent session may read.
    // Control-plane merger (GY-1552) still provisions them: no reviewer App, but the master decides with its own identities.
    if (supervised) deps.emit({ kind: 'step', step: 'master-autonomy', state: 'skipped', detail: 'supervised: the operator reviews and merges, so no operator-agent or approver identity is provisioned' });
    else await step('master-autonomy', async () => {
      // A host install provisions them on the host, where its loop runs and the admin credential stays.
      if (state.identitiesHost) return `the master's agent identities were provisioned on ${state.identitiesHost}, where its loop runs`;
      const admin = await deps.operatorToken?.(state.operatorTokenFile ?? null).catch(() => null) ?? null;
      // An install whose operator already ran the command keeps those identities; the admin credential only refreshes them.
      if (!admin && await provisioned(deps.root)) return 'the master\'s operator-agent and approver identities were already provisioned';
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
      // The files are written to this checkout only; the base branch needs them before any work is
      // delivered, so they are published as a pull request (the base is protected, never pushed to).
      const published = await deps.publishOnboarding(workflows).catch((error: any) => { throw new UpStop(`onboarding: publishing the onboarding files failed: ${String(error?.message ?? error).split('\n')[0].slice(0, 400)}; rerun graphyard up to retry`, upExitCodes.failed); });
      state.onboardingPullRequest = published?.pullRequest ?? null;
      const carried = workflows.length ? `onboarding files with ${workflows.join(', ')}` : 'onboarding files (no delivery workflow was written)';
      if (!published) return `${carried}: the base branch already holds them`;
      // GY-1478: the pull request is filed as a work item the loop owns, so its reviewer reviews it,
      // the checks run and it merges under the normal gates; branch protection never waits on a person.
      if (!state.onboardingWork) {
        if (!state.onboardingRequest) { state.onboardingRequest = randomUUID(); await writeState(deps.root, state); }
        const filed = await (deps.fileOnboarding?.(published.pullRequest, state.operatorTokenFile ?? null, state.onboardingRequest) ?? Promise.resolve(null)).catch((error: any) => { throw new UpStop(`onboarding: filing ${published.pullRequest} as a work item failed: ${String(error?.message ?? error).split('\n')[0].slice(0, 400)}; rerun graphyard up to retry`, upExitCodes.failed); });
        state.onboardingWork = filed?.key ?? null;
      }
      return `${carried} published in ${published.pullRequest}${state.onboardingWork ? `, filed as ${state.onboardingWork} for the loop to review and merge` : ''}`;
    });

    await step('accounts', async () => {
      const accounts: SetupItemId[] = supervised ? ['account:worker'] : ['account:worker', 'account:reviewer'];
      // In either mode (GY-1477), login homes and keys already on this host become the fleet; nothing is signed in here.
      await run('accounts', ['master', 'registry', 'propose', '--apply']);
      // The registry's first fold may lag the apply by a poll; only a role still empty after it is asked for:
      // handed off in agent mode, on the Setup page interactively.
      await waitGreen(accounts, true, request.agent ? async (pending, polls) => {
        if (polls > 0) handoff('accounts')(`Sign in to an AI coding account for ${pending.map(id => id.slice('account:'.length)).join(' and ')}: approve its browser login on your device`, { url: setupUrl });
      } : undefined, 1);
    });

    await step('harness', async () => { await run('harness', ['master', 'harness', request.master, '--apply']); });

    await step('master-loop', async () => {
      await cleanCli('master-loop');
      if (!(await checklist()).find(item => item.id === 'master-loop')?.done) await run('master-loop', ['master', 'restart']);
      // A loop that refuses to run is a failed setup step naming its cause, never a wait that stalls.
      const refused = async () => {
        const reason = await deps.loopRefusal?.();
        if (reason) throw new UpStop(`master-loop: the master loop refuses to run: ${reason}`, upExitCodes.failed);
      };
      await waitGreen(['master-loop'], false, refused);
      await refused();
    });

    await waitGreen(last.map(item => item.id), true);
    // No goal is submitted until the onboarding pull request has merged and the base carries the workflows.
    if (state.onboardingPullRequest) {
      const pullRequest = state.onboardingPullRequest;
      const deadline = deps.now() + humanWaitMs;
      let shown = '';
      for (let polls = 0; !(await deps.onboardingMerged(pullRequest)); polls++) {
        if (polls === 0) deps.emit({ kind: 'note', text: `Waiting for the onboarding pull request ${pullRequest} to merge: it adds Graphyard's delivery workflows to the base branch.${supervised ? ' Your own gh login opened it, so your approval does not count: merge it on GitHub as a repository admin, or have someone else approve it.' : state.onboardingWork ? ` The loop reviews and merges it as ${state.onboardingWork}.` : ''}` });
        // The current setup step (GY-1478 AC-2): the item's URL, what it waits for, how long; shown again whenever what it waits for changes.
        const work = state.onboardingWork ? findOnboardingWork(await deps.work?.().catch(() => null), state.onboardingWork) : null;
        if (work) {
          onboarding = onboardingWait(work, deps.now(), request.repository);
          if (onboarding.waitingFor.join() !== shown) { shown = onboarding.waitingFor.join(); deps.emit({ kind: 'onboarding', wait: onboarding }); }
          if (onboarding.closed) throw new UpStop(`onboarding: ${onboarding.key} (${pullRequest}) was closed without merging, so the base branch lacks Graphyard's delivery workflows; reopen and merge it, or publish them again, then rerun ${rerun()}`, upExitCodes.failed);
        }
        if (deps.now() >= deadline) throw new UpStop(`Still waiting for the onboarding pull request ${pullRequest} to merge${onboarding ? ` (${onboarding.key} waits for ${onboarding.waitingFor.join(' and ')}, ${waitedFor(onboarding.waitedMs)} so far)` : ''}; rerun ${rerun()} to resume`, upExitCodes.waiting);
        await deps.sleep(pollMs);
      }
      if (onboarding) onboarding = { ...onboarding, waitingFor: [], merged: true };
      state.onboardingPullRequest = null; await writeState(deps.root, state);
    }
    if (request.goalFile) {
      await step('goal', async () => {
        // A goal record, as `graphyard goal FILE` submits it, so the acceptance and planner roles run (GY-1443).
        const goal = goalSubmission(await readFile(resolve(deps.root, request.goalFile!), 'utf8'));
        const file = resolve(deps.root, '.graphyard/up-goal.json');
        await writeFile(file, `${JSON.stringify(goal, null, 2)}\n`, { mode: 0o600 });
        // The request id is saved before the first try: a rerun replays the same create, which the control plane answers once.
        if (!state.goalRequest) { state.goalRequest = randomUUID(); await writeState(deps.root, state); }
        const created = parseJson(await run('goal', ['goal', file], { env: { GRAPHYARD_REQUEST_ID: state.goalRequest } }));
        state.goal = created?.key ?? 'created';
        return `submitted as ${state.goal}`;
      });
    }
    // GY-1477: setup ends with the one sign-in link itself (minted with the operator's credential, a host
    // install's from its redeemed claim), on the reachable address, so nobody runs graphyard login afterwards.
    const base = await linkBase();
    const minted = base ? await mint() : null;
    signIn = minted && base ? (state.goal ? signInAt(minted, base) : setupAddress(base, signInAt(minted, base))) : null;
    const open = signIn ? `${signIn} (signs you in; works once, within 10 minutes)` : setupUrl ?? 'the dashboard';
    return result(true, upExitCodes.green, state.goal ? `Graphyard is building ${state.goal}; follow it on the dashboard: open ${open}` : `Everything is green. Open ${open} and describe what you want built${request.agent ? ', or rerun with --goal FILE' : ''}.`);
  } catch (error) {
    if (!(error instanceof UpStop)) throw error;
    return result(false, error.exitCode, error.message);
  }

  function result(ok: boolean, exitCode: number, next: string): UpResult {
    return { ok, exitCode, herdrAttach, setupUrl, completed: [...state.completed], prompts, handoffs, checklist: last.map(({ id, done, line }) => ({ id, done, line })), onboarding, goal: state.goal, signIn, reachableUrl: state.tailnetUrl ?? null, next };
  }
}

/**
 * The `graphyard up` command: a code handed with --sudo-code, else a run whose omitted --repo and
 * --provider come from .graphyard/up.json, and whose children a SIGINT or SIGTERM reaches (GY-1466).
 */
export async function upCommand(root: string, cliPath: () => Promise<string>, args: string[]): Promise<UpResult | NonNullable<Awaited<ReturnType<typeof upSudoCode>>>> {
  const handed = await upSudoCode(root, args);
  if (handed) return handed;
  const request = upRequestFromArgs(args, recordedUp(root));
  const emit = (event: UpEvent) => console.error(request.agent ? JSON.stringify(event) : describeUpEvent(event));
  const dependencies = upDependencies(root, await cliPath(), request, emit);
  // Ctrl-C or SIGTERM stops the install child too, so nothing keeps serving its App page on 4311.
  const release = forwardSignals(dependencies.children);
  return runUp(request, dependencies).finally(release);
}

/** `graphyard up --help` (GY-1510): up's usage, one line for each option. */
export const upUsage = [
  'Usage: graphyard up --repo OWNER/NAME [options]',
  '       graphyard up --sudo-code CODE|email',
  '',
  'First-run setup in one command, resumable: a rerun skips what is done (.graphyard/up.json).',
  '',
  'Options:',
  '  --repo OWNER/NAME          the repository to set up; a rerun reuses the recorded one',
  '  --provider NAME            compose (default), railway, hetzner or local',
  '  --local                    --provider local: embedded Postgres on this machine, no Docker',
  '  --agent                    run every step non-interactively, JSON events on stderr; hand off only device approvals',
  '  --merger github|control-plane  who merges heads: github Apps (default) or the control plane (no Apps, deploy key)',
  '  --reviewer NAME            the reviewer App and agent runtime (default claude); unused with --merger control-plane',
  '  --master NAME              the master agent runtime, claude or codex (default claude)',
  '  --goal FILE                submit the goal in FILE once the checklist is green',
  "  --browser-profile PROFILE  the Chrome profile signed in to GitHub (default: the master's, else another install's for the same login); unused with --merger control-plane",
  '  --github-mobile            approve Confirm access with GitHub Mobile (the default whenever the page offers it)',
  '  --sudo-code CODE|email     hand the waiting run a 6-digit Confirm-access code, or ask GitHub to email one',
  '  --confirm-price X          consent to a created server\'s monthly price (passed to install)',
  '  --max-monthly N            consent to any monthly price up to N (passed to install)',
  '  --ssh-key NAME             the SSH key a created server is reached with (passed to install)',
  '  --ssh-host HOST            the machine to install on over SSH (passed to install)',
  '  --ssh-user USER            the SSH user on that machine (passed to install)',
  '  --reuse-app SLUG           reuse an App already installed on the account (repeatable)',
  '  --wait MINUTES             how long each wait on a person lasts (agent default 20)',
  '  --no-wait                  at Confirm access, exit 3 with the App-import route instead of waiting',
  "  --share-tailnet            serve the dashboard on this host's tailnet (never publicly)",
  '  --url URL                  the control plane\'s address when not the one the install recorded; every later step uses it',
  '  --json                     print the result as JSON',
  '  -h, --help                 print this help and exit',
  '',
  'Exit codes: 0 green, 1 a step failed, 2 a machine prerequisite needs a person, 3 still waiting on a person.',
].join('\n');
/** Whether ARGS ask for up's usage. */
export const upHelpRequested = (args: readonly (string | undefined)[]) => args.includes('--help') || args.includes('-h');

/** `graphyard up --sudo-code CODE|email` (GY-1450): hands the run waiting at Confirm access a code, never echoing it; null without the flag. */
export async function upSudoCode(root: string, args: string[]) {
  const at = args.findIndex(arg => arg === '--sudo-code' || arg.startsWith('--sudo-code='));
  if (at < 0) return null;
  const kind = await submitSudoCode(root, args[at].includes('=') ? args[at].slice('--sudo-code='.length) : args[at + 1] ?? '');
  return { ok: true, handed: kind === 'email' ? 'a request for an emailed code' : 'a 6-digit code', next: 'The waiting graphyard up types it into GitHub\'s Confirm-access page within its next check.' };
}

/** A shell word: plain when it needs no quoting, otherwise single-quoted. */
const shellWord = (value: string) => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
/**
 * The operator's up command past its repository (GY-1457): the provider and --agent, then every
 * other option that shapes the setup (reviewer, master, goal, browser profile, install consent and
 * SSH inputs, Mobile preference, wait), so a printed rerun or App-import route sets up the same thing.
 * --reuse-app and --no-wait are left to the command that prints it.
 */
export function upCommandFlags(request: UpRequest) {
  const flags: string[] = ['--provider', request.provider, ...(request.agent ? ['--agent'] : [])];
  const option = (name: string, value: string | null | undefined) => { if (value) flags.push(name, value); };
  if (request.merger && request.merger !== 'github') option('--merger', request.merger);
  if (request.reviewer !== 'claude' && !upMergerControlPlane(request)) option('--reviewer', request.reviewer);
  if (request.master !== 'claude') option('--master', request.master);
  option('--goal', request.goalFile);
  if (!upMergerControlPlane(request)) option('--browser-profile', request.browserProfile);
  option('--confirm-price', request.install?.confirmPrice);
  option('--max-monthly', request.install?.maxMonthly);
  option('--ssh-key', request.install?.sshKey);
  option('--ssh-host', request.install?.sshHost);
  option('--ssh-user', request.install?.sshUser);
  if (request.sudo === 'mobile') flags.push('--github-mobile');
  if (request.waitMs) option('--wait', String(request.waitMs / 60_000));
  if (request.shareTailnet) flags.push('--share-tailnet');
  option('--url', request.url);
  return flags.map(shellWord).map(word => ` ${word}`).join('');
}

/**
 * The repository, provider and merger an earlier run recorded in .graphyard/up.json (GY-1466), so a
 * resumed `up` needs those flags again only when they differ; null when no run is recorded here.
 */
export function recordedUp(root: string): { repository: string; provider: string; merger?: MergerMode } | null {
  try {
    const state = JSON.parse(readFileSync(upStateFile(root), 'utf8'));
    if (state?.version !== 1 || typeof state.repository !== 'string' || typeof state.provider !== 'string') return null;
    const merger = state.merger === 'control-plane' || state.merger === 'github' ? state.merger as MergerMode : undefined;
    return { repository: state.repository, provider: state.provider, ...(merger ? { merger } : {}) };
  } catch (error: any) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

/** The options `graphyard up` parses; upUsage gives each one line (GY-1510), and --sudo-code is read before them. */
export const upOptions = { repo: { type: 'string' }, provider: { type: 'string' }, agent: { type: 'boolean' }, json: { type: 'boolean' }, merger: { type: 'string' }, reviewer: { type: 'string' }, master: { type: 'string' }, goal: { type: 'string' }, 'browser-profile': { type: 'string' },
  'confirm-price': { type: 'string' }, 'max-monthly': { type: 'string' }, 'ssh-key': { type: 'string' }, 'ssh-host': { type: 'string' }, 'ssh-user': { type: 'string' },
  'reuse-app': { type: 'string', multiple: true }, 'github-mobile': { type: 'boolean' }, wait: { type: 'string' }, 'no-wait': { type: 'boolean' }, 'share-tailnet': { type: 'boolean' }, local: { type: 'boolean' }, url: { type: 'string' } } as const;

/**
 * `graphyard up`'s flags. With a run RECORDED in this checkout, an omitted --repo or --provider is
 * the recorded one, and one that differs is refused, naming both: its steps say nothing about it.
 */
export function upRequestFromArgs(args: string[], recorded: { repository: string; provider: string; merger?: MergerMode } | null = null): UpRequest {
  const { values } = parseArgs({ args, options: upOptions, allowPositionals: false });
  // --local is --provider local (GY-1500): the control plane on embedded Postgres on this machine, no Docker.
  if (values.local && values.provider !== undefined && values.provider !== 'local') throw new Error(`graphyard up --local means --provider local; it cannot be combined with --provider ${values.provider}`);
  const provider = values.local ? 'local' : values.provider;
  const mergerFlag = values.merger;
  if (mergerFlag !== undefined && !(mergerModes as readonly string[]).includes(mergerFlag)) throw new Error(`Use --merger ${mergerModes.join('|')}`);
  const merger = (mergerFlag ?? recorded?.merger) as MergerMode | undefined;
  if (merger === 'control-plane' && (provider ?? recorded?.provider) === 'local') throw new Error('graphyard up --merger control-plane cannot be combined with --local: supervised mode provisions no operator-agent or approver identity');
  for (const [flag, given, kept] of [['--repo', values.repo, recorded?.repository], ['--provider', provider, recorded?.provider], ['--merger', mergerFlag, recorded?.merger]] as const) {
    if (given !== undefined && kept !== undefined && given !== kept) throw new Error(`graphyard up ${flag} ${given} conflicts with ${kept}, which the run recorded in .graphyard/up.json resumes; omit ${flag} (or pass ${kept}) to resume it, or remove .graphyard/up.json to start over for ${given}`);
  }
  const repository = values.repo ?? recorded?.repository;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Use graphyard up --repo OWNER/NAME [--provider compose|railway|hetzner|local | --local] [--merger github|control-plane] [--agent]');
  const minutes = values.wait === undefined ? null : Number(values.wait);
  if (minutes !== null && (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1_440)) throw new Error('Use --wait with whole minutes from 1 to 1440');
  let url: string | null = null;
  if (values.url !== undefined) { try { const parsed = new URL(values.url); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); url = parsed.origin; } catch { throw new Error('Use --url with the control plane\'s http(s) address, such as http://127.0.0.1:4311'); } }
  return { repository, provider: provider ?? recorded?.provider ?? 'compose', agent: !!values.agent, reviewer: values.reviewer ?? 'claude', master: values.master ?? 'claude',
    goalFile: values.goal ?? null, browserProfile: values['browser-profile'] ?? null, ...(merger ? { merger } : {}),
    install: { confirmPrice: values['confirm-price'] ?? null, maxMonthly: values['max-monthly'] ?? null, sshKey: values['ssh-key'] ?? null, sshHost: values['ssh-host'] ?? null, sshUser: values['ssh-user'] ?? null },
    ...(values['reuse-app']?.length ? { reuseApps: values['reuse-app'] } : {}), ...(values['github-mobile'] ? { sudo: 'mobile' as const } : {}),
    ...(minutes !== null ? { waitMs: minutes * 60_000 } : {}), ...(values['no-wait'] ? { noWait: true } : {}), ...(values['share-tailnet'] ? { shareTailnet: true } : {}), ...(url ? { url } : {}) };
}

/** How many fresh GitHub Mobile prompts a drive requests after one expires unapproved (GY-1510). */
export const upMobileReprompts = 3;

/**
 * GitHub's own error text on an App page (GY-1510): the validation lines a rejected manifest or App
 * form shows ("Hook url cannot be blank"), joined; null when the page shows none.
 */
export function githubAppError(text: string): string | null {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && line.length <= 300 && (
    /\b(?:can(?:no|')t be blank|is invalid|is not (?:a )?valid|has already been taken|is too (?:long|short)|is reserved|is not included in the list)\b/i.test(line)
    || /^(?:invalid (?:github app )?(?:manifest|configuration)|there (?:was|were) (?:an )?errors?\b|error:|something went wrong)/i.test(line)));
  return lines.length ? [...new Set(lines)].join('; ') : null;
}
/** The drive met GitHub's rejection of the App: its message is GitHub's own text. */
class AppRejected extends Error {}

/**
 * Agent mode's App step (AC-5): the installer's manifest page, driven in the master's browser
 * profile — register the App, then install it on the repository alone (GitHub preselects it from
 * `repository_ids[]`). A Confirm-access prompt is passed with passSudo, the page's own confirmation
 * first (GY-1442): the handoff names a sudo-protected page to confirm access on once in the
 * operator's own Chrome, which the shared GitHub session then carries, and every method the page
 * offers; the drive re-checks every 10 s and types in an authenticator or email code handed over
 * on the manifest page or with `graphyard up --sudo-code` (GY-1450). GY-1510: GitHub Mobile is
 * triggered whenever the page offers it (a passkey or code only when it does not, or when the
 * operator chose `sudo: 'passkey-or-password'`), handed off as one sentence naming its number; a
 * prompt that expires unapproved is requested afresh up to upMobileReprompts times, each new number
 * handed off; a Mobile code unapproved for a minute is handed off again with the passkey or password link.
 * When GitHub rejects the manifest or shows an error on the App page, the drive ends `rejected`
 * quoting GitHub's own error text (githubAppError).
 * A re-check that reloads the App creation page drops the manifest, so once access is confirmed
 * the manifest is submitted again from the setup page.
 *
 * GY-1457: the Confirm-access wait is up's own wait (TIMEOUTMS, upWaitMs), not a shorter one of its
 * own. The handoff says whether the drive shares the operator's live Chrome session (PROFILE) and
 * always ends with the App-import route that needs no live moment. A pending confirmation is kept
 * (REMEMBER) so a rerun meeting the same page resumes it (PENDING, ONRESUME) instead of handing it
 * off again; NOWAIT ends the drive at the handoff with that route as the next step.
 */
export function browserAppDriver(options: { page: BrowserPage; repository: string; ids: () => { owner: number; repository: number }; sleep: (ms: number) => Promise<void>; now?: () => Date; timeoutMs?: number; record?: string; sudo?: SudoOptions['prefer']; readCode?: SudoOptions['readCode']; onClose?: (outcome: DriveOutcome) => Promise<void> | void;
  profile?: { mode: BrowserProfileMode; name: string } | null; noWait?: boolean; upFlags?: string; reuseFlags?: string;
  pending?: () => Promise<SudoState | null> | SudoState | null; remember?: (state: SudoState | null) => Promise<void> | void; onResume?: (state: SudoState) => void }) {
  const { page } = options;
  const owner = options.repository.split('/')[0];
  // The operator's up command past its repository (upCommandFlags), for the rerun and the App-import route; the rerun keeps its --reuse-app too.
  const upFlags = options.upFlags ?? ' --agent';
  const rerun = `graphyard up --repo ${options.repository}${options.reuseFlags ?? ''}${upFlags}`, importRoute = appImportRoute(options.repository, upFlags);
  let setupPage: string | null = null, resumeChecked = false;
  const awaitSudo = async (handoff: Handoff) => {
    const onCode = async (state: SudoState) => {
      // The first confirmation a rerun meets resumes the one handed off before (within a day), when it is the same page method.
      const before = resumeChecked ? null : await options.pending?.() ?? null;
      resumeChecked = true;
      const now = (options.now ?? (() => new Date()))().getTime();
      const resumed = before && before.method && before.method !== 'mobile' && before.method === state.method && now - Date.parse(before.issuedAt) < 86_400_000 ? before : null;
      await options.remember?.(resumed ? { ...state, issuedAt: resumed.issuedAt } : state);
      if (resumed) options.onResume?.(resumed);
      // GY-1510: a GitHub Mobile prompt is handed off as one plain sentence naming its number.
      else handoff(state.method === 'mobile' ? sudoInstruction(state, 'your phone') : [sudoInstruction(state, 'your phone', { ...(options.readCode ? { page: setupPage, command: 'graphyard up --sudo-code' } : {}), profile: options.profile ?? null }), importRoute].join('\n'),
        { url: state.fallback?.url ?? state.url ?? page.url(), code: state.code });
      if (options.noWait) throw new SudoNoWait(`GitHub asks to confirm access before it creates the App, and --no-wait does not wait for it. ${importRoute}; or rerun ${rerun} without --no-wait to wait for the confirmation.`);
    };
    // passSudo's flow names the closest master browser flow; its rerun advice is this command's.
    try {
      // GY-1510: GitHub Mobile whenever the page offers it (named, with a control to request it), unless
      // the operator chose otherwise; the page's own confirmation or a code only when it offers none.
      const mobile = () => offeredSudoMethods(page.text()).mobile && !!(page.locate('button', 'Use GitHub Mobile') ?? page.locate('link', 'Use GitHub Mobile'));
      const prefer = options.sudo ?? (mobile() ? 'mobile' : 'passkey-or-password');
      const passed = await passSudo(page, { flow: 'installation-accept', record: options.record ?? 'graphyard up', sleep: options.sleep, now: options.now, timeoutMs: options.timeoutMs ?? upAgentWaitMs, prefer, readCode: options.readCode,
        maxAttempts: 1 + upMobileReprompts,
        onCode, onSettled: state => options.remember?.(state.state === 'approved' ? null : state) });
      return passed.passed;
    } catch (error: any) {
      if (error instanceof SudoNoWait) throw error;
      const reason = String(error?.message ?? error).replace(/rerun master browser installation-accept/g, `rerun ${rerun}`);
      // A copied profile never sees a confirmation in the operator's own Chrome, so the timeout does not offer it.
      throw new Error(options.profile?.mode === 'copy' ? reason.replace(`, or once in your own Chrome at ${sudoProtectedPage}`, '') : reason);
    }
  };
  // GitHub's rejection of the manifest or App form, when the page shows one (GY-1510).
  const rejected = () => { if (!/^https:\/\/github\.com\//.test(page.url())) return; const error = githubAppError(page.text()); if (error) throw new AppRejected(error); };
  const press = async (kind: 'button' | 'link', text: string, handoff: Handoff, after = false) => {
    await awaitSudo(handoff);
    const control = page.locate(kind, text);
    if (!control) { rejected(); throw new Error(`the page offers no "${text}" ${kind}`); }
    page.click(control.selector); page.wait(2_000);
    await awaitSudo(handoff);
    if (after) rejected();
  };
  return async (url: string, handoff: Handoff): Promise<DriveOutcome> => {
    let outcome: DriveOutcome;
    setupPage = url;
    try {
      for (let submissions = 0; ; submissions += 1) {
        page.open(url);
        const register = page.locate('button', 'Register Graphyard App →') ?? page.locate('button', 'Register reviewer App →');
        if (!register) break;
        page.click(register.selector); page.wait(2_000);
        const confirmed = await awaitSudo(handoff);
        // Confirmed on a reloaded page: GitHub shows the plain new-App form, so submit the manifest again.
        if (confirmed && submissions === 0 && !page.locate('button', `Create GitHub App for ${owner}`)) continue;
        await press('button', `Create GitHub App for ${owner}`, handoff, true);
        break;
      }
      page.open(url);
      const install = page.locate('link', 'Install GitHub App');
      if (install?.href) {
        const ids = options.ids();
        page.open(`${install.href}/permissions?suggested_target_id=${ids.owner}&repository_ids[]=${ids.repository}`);
        await press('button', 'Install', handoff);
      }
      outcome = { state: 'done' };
    } catch (error: any) {
      outcome = error instanceof SudoNoWait ? { state: 'waiting', next: error.message } : error instanceof AppRejected ? { state: 'rejected', error: error.message } : { state: 'failed', reason: String(error?.message ?? error).split('\n')[0] };
    }
    try { page.close(); } catch { /* recorded on the step */ }
    await options.onClose?.(outcome);
    return outcome;
  };
}

/**
 * The browser profile agent mode drives the App pages in: the one passed, else the one the master
 * recorded (`master init --browser-profile`), else (GY-1510) the one another Graphyard install on this
 * host recorded in its .graphyard/master.json, when that profile's GitHub login is LOGIN, the login
 * this host's gh is authenticated as; FROM names that install. A profile's login is the browser login
 * its install's administration ledger (.graphyard/master-actions/ledger.json) last observed signed in
 * to it; an entry that never read the browser's login (a no-op or dry run, which records only the gh
 * login) says nothing about the profile. A profile no entry observed is asked: DISCOVER opens GitHub
 * in it and reads the signed-in login. A profile with no login found, or no login here, is never
 * borrowed, and agent mode stops before it starts.
 * INSTALLS are the other installs' checkouts, hostInstallRoots by default.
 */
export function upBrowserProfile(root: string, request: UpRequest, installs: string[] = hostInstallRoots(), login: () => string | null = hostGithubLogin,
  discover: (browser: { profile: string; executable?: string }) => string | null = hostProfileLogin): { profile: string; executable?: string; from?: string; login?: string } | null {
  if (request.browserProfile) return { profile: request.browserProfile };
  const recorded = (checkout: string) => {
    try { const config = JSON.parse(readFileSync(resolve(checkout, '.graphyard/master.json'), 'utf8')); return typeof config?.browser?.profile === 'string' && config.browser.profile ? config : null; }
    catch { return null; }
  };
  const own = recorded(root);
  if (own) return own.browser;
  const self = canonicalPath(root);
  let mine: string | null | undefined;
  for (const checkout of installs) {
    if (canonicalPath(checkout) === self) continue;
    const config = recorded(checkout);
    if (!config) continue;
    if (mine === undefined) mine = login()?.toLowerCase() ?? null;
    if (!mine) return null;
    const { profile, executable } = config.browser;
    const browser = { profile, ...(typeof executable === 'string' && executable ? { executable } : {}) };
    let theirs = observedProfileLogin(checkout, profile);
    if (!theirs) { try { theirs = discover(browser); } catch { theirs = null; } }
    if (theirs && theirs.toLowerCase() === mine) return { ...browser, from: checkout, login: theirs };
  }
  return null;
}
/** The GitHub login CHECKOUT's administration ledger last observed signed in to PROFILE's browser; entries that never read it (actor.browser null) are skipped. */
function observedProfileLogin(checkout: string, profile: string): string | null {
  let entries: unknown[];
  try { entries = JSON.parse(readFileSync(resolve(actionsDirectory(checkout), 'ledger.json'), 'utf8'))?.entries; } catch { return null; }
  if (!Array.isArray(entries)) return null;
  for (const entry of [...entries].reverse()) {
    const actor = (entry as any)?.actor;
    if (actor?.profile === profile && typeof actor.browser === 'string' && actor.browser) return actor.browser;
  }
  return null;
}
/**
 * The GitHub login signed in to BROWSER's profile, read as the master's browser flows read it: GitHub's
 * user-login meta tag on github.com, in a session of its own. Null when it is signed out or cannot be opened.
 */
export function browserProfileLogin(browser: { profile: string; executable?: string }, page: (session: string) => BrowserPage = session => agentBrowserPage(browser, session)): string | null {
  let opened: BrowserPage | null = null;
  try {
    opened = page(`graphyard-up-login-${browser.profile.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`);
    opened.open('https://github.com/');
    return opened.meta('user-login');
  } catch { return null; }
  finally { try { opened?.close(); } catch { /* the session may already be gone */ } }
}
const underTestRunner = () => !!process.env.NODE_TEST_CONTEXT || process.execArgv.includes('--test') || process.env.npm_lifecycle_event === 'test';
/** browserProfileLogin, except that under the test runner no real browser is opened. */
const hostProfileLogin = (browser: { profile: string; executable?: string }) => underTestRunner() ? null : browserProfileLogin(browser);
/** The GitHub login this host's gh is authenticated as, or null when gh is not signed in. */
export function hostGithubLogin(): string | null {
  try { return execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}
const canonicalPath = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
/**
 * The checkouts the Graphyard master loops installed on this host run from: each graphyard-master*.service
 * unit's WorkingDirectory. Under the test runner only a directory under the system temporary directory
 * is read, as legacyUnitFiles reads one: the operator's real installs belong to no test.
 */
export function hostInstallRoots(unitDirectory = userUnitDirectory()): string[] {
  if (underTestRunner() && !`${canonicalPath(unitDirectory)}/`.startsWith(`${canonicalPath(tmpdir())}/`)) return [];
  let names: string[];
  try { names = readdirSync(unitDirectory).filter(name => /^graphyard-master.*\.service$/.test(name)).sort(); } catch { return []; }
  const roots = names.flatMap(name => { try { const working = unitCheckout(readFileSync(resolve(unitDirectory, name), 'utf8')).workingDirectory; return working ? [working] : []; } catch { return []; } });
  return [...new Set(roots)];
}

/**
 * A recorded drive (AC-5): the App pages run through the master's recording page, so every step and
 * a screenshot after each mutation land in .graphyard/master-actions/<stamp>-app-create-<id>/,
 * with record.json written when the drive ends, as every master browser flow records its run.
 */
export function recordedAppDriver(root: string, request: UpRequest, browser: { profile: string; executable?: string }, page: (session: string) => BrowserPage = session => agentBrowserPage(browser, session),
  clock: { sleep?: (ms: number) => Promise<void>; now?: () => Date; emit?: (event: UpEvent) => void } = {}) {
  const startedAt = new Date(), id = randomUUID();
  const directory = resolve(actionsDirectory(root), `${startedAt.toISOString().replace(/[:.]/g, '-')}-app-create-${id.slice(0, 8)}`);
  const steps: RecordedStep[] = [];
  const scope = { repository: request.repository, provider: request.provider, browserProfile: browser.profile };
  const session = `graphyard-up-${request.repository.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`;
  let created = false;
  const recorded = recordingPage(page(session), { directory, steps, now: () => new Date() });
  const drive = browserAppDriver({
    page: { ...recorded, open: url => { if (!created) { created = true; mkdirSync(directory, { recursive: true, mode: 0o700 }); } return recorded.open(url); } },
    repository: request.repository, record: relative(root, directory), sleep: clock.sleep ?? (ms => new Promise(accept => setTimeout(accept, ms))), now: clock.now, sudo: request.sudo,
    readCode: () => takeSudoCode(root),
    // GY-1457: up's own wait, the profile's sharing said in the handoff, and the pending confirmation kept for a rerun.
    timeoutMs: Number.isFinite(upWaitMs(request)) ? upWaitMs(request) : upAgentWaitMs, noWait: request.noWait,
    profile: { mode: browserProfileMode(browser.profile), name: browser.profile },
    upFlags: upCommandFlags(request), reuseFlags: (request.reuseApps ?? []).map(slug => ` --reuse-app ${shellWord(slug)}`).join(''),
    pending: () => readPendingSudo(root, scope), remember: state => rememberPendingSudo(root, state, scope),
    onResume: state => clock.emit?.({ kind: 'note', text: `Resuming the Confirm access handed off at ${state.issuedAt}; no new handoff: confirm it as asked then, or pass a code with graphyard up --sudo-code` }),
    ids: () => {
      const repo = JSON.parse(execFileSync('gh', ['api', `repos/${request.repository}`], { encoding: 'utf8', timeout: 30_000 }));
      return { owner: Number(repo.owner?.id), repository: Number(repo.id) };
    },
    onClose: async outcome => {
      if (!created) return;
      await writeFile(resolve(directory, 'record.json'), `${JSON.stringify({ id, flow: 'app-create', startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(), actor: { profile: browser.profile }, target: { repository: request.repository }, outcome: outcome.state === 'done' ? 'applied' : 'refused', ...(outcome.state === 'failed' ? { reason: outcome.reason } : outcome.state === 'rejected' ? { reason: outcome.error } : {}), screenshots: steps.filter(step => step.screenshot).length, steps }, null, 2)}\n`, { mode: 0o600 });
    },
  });
  return { directory, drive };
}

/**
 * The Confirm access an App drive handed off and is waiting on (GY-1457), so a rerun resumes it.
 * It is kept with the repository and provider it was handed off for, as up.json is, and the browser
 * profile the drive ran in: a run for another one, or one that drives another profile (whose
 * handoff offers other routes), never resumes it, so its own handoff is issued.
 */
const pendingSudoFile = (root: string) => resolve(actionsDirectory(root), 'up-sudo.json');
export interface PendingSudoScope { repository: string; provider: string; browserProfile?: string }
export async function readPendingSudo(root: string, scope?: PendingSudoScope): Promise<SudoState | null> {
  try {
    const { repository, provider, browserProfile, ...state } = JSON.parse(await readFile(pendingSudoFile(root), 'utf8'));
    if (scope && (repository !== scope.repository || provider !== scope.provider || (browserProfile ?? undefined) !== scope.browserProfile)) return null;
    return sudoStateSchema.parse(state);
  } catch { return null; }
}
export async function rememberPendingSudo(root: string, state: SudoState | null, scope?: PendingSudoScope) {
  const file = pendingSudoFile(root);
  if (!state) { await rm(file, { force: true }); return; }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(`${file}.${process.pid}.tmp`, `${JSON.stringify({ ...state, ...scope })}\n`, { mode: 0o600 });
  await rename(`${file}.${process.pid}.tmp`, file);
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

/** What `init --scan --apply` writes and the manual flow commits (docs/setup-from-zero.md, step 6). */
export const onboardingFiles = ['AGENTS.md', '.gitignore', 'graphyard.json', '.github/workflows'] as const;
export { onboardingBranch };
/** The onboarding files every apply writes; a publish without one refuses (GY-1480). */
export const onboardingRequiredFiles = ['AGENTS.md', 'graphyard.json'] as const;

/**
 * Publish the onboarding files as one commit on the base branch's tip, on `graphyard/onboarding`,
 * and a pull request for it. The commit is built in a scratch index, so the operator's checkout,
 * branch and staged changes are untouched. Rerun, it reuses the open pull request, first
 * force-pushing its branch when it does not carry exactly these files; when the base branch already
 * holds them, nothing is published.
 */
export async function publishOnboarding(root: string, repository: string, run: (program: string, args: string[], env?: Record<string, string>) => string, workflows: readonly string[] = []): Promise<{ pullRequest: string } | null> {
  // GY-1480: every file the publish means to carry must be on disk; one that is not is refused by
  // name, never skipped, so the pull request never claims a file it does not hold.
  const missing = [...onboardingRequiredFiles, ...workflows].filter(file => !existsSync(resolve(root, file)));
  if (missing.length) throw new Error(`publishOnboarding refuses: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing from ${root}; rerun graphyard init --scan --apply, then graphyard up`);
  const open = run('gh', ['pr', 'list', '--repo', repository, '--head', onboardingBranch, '--state', 'open', '--json', 'url', '--jq', '.[0].url // ""']).trim();
  const base = run('gh', ['repo', 'view', repository, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']).trim();
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
    // GY-1480: an open pull request is reused only when its branch carries exactly these files; one an
    // earlier run or an older CLI opened without them (the delivery workflow above all) is replaced.
    if (open) {
      let branchTree: string | null = null;
      try { run('git', ['fetch', '--quiet', 'origin', onboardingBranch]); branchTree = run('git', ['rev-parse', 'FETCH_HEAD^{tree}']).trim(); } catch { /* the branch is gone: push it again */ }
      if (branchTree === tree) return { pullRequest: open };
    }
    const commit = run('git', ['commit-tree', tree, '-p', baseCommit, '-m', 'Add Graphyard onboarding: coordination instructions, configuration and delivery workflows'], env).trim();
    // The branch is this command's own: an earlier, interrupted publish is replaced, never merged into.
    run('git', ['push', '--force', 'origin', `${commit}:refs/heads/${onboardingBranch}`]);
  } finally { await rm(index, { force: true }); }
  if (open) return { pullRequest: open };
  const carried = onboardingFiles.filter(file => existsSync(resolve(root, file)));
  const created = run('gh', ['pr', 'create', '--repo', repository, '--base', base, '--head', onboardingBranch, '--title', 'Add Graphyard onboarding',
    '--body', `The files graphyard up wrote while onboarding this repository: ${carried.join(', ')}.${workflows.length ? ` Merging it puts Graphyard's delivery workflows (${workflows.join(', ')}) on ${base}.` : ''}`]).trim();
  return { pullRequest: created.split('\n').filter(Boolean).pop()! };
}

/**
 * GY-1466: SIGINT or SIGTERM to `up` is passed to every child it runs (the install serving the App
 * page on 4311 above all), and `up` exits once they have, 128 + the signal's number; a child still
 * running after GRACE_MS, or at a second signal, is killed. Returns what removes the handlers.
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

/** The real dependencies: this CLI's own commands as children, the master identity's status read. */
export function upDependencies(root: string, cliPath: string, request: UpRequest, emit: (event: UpEvent) => void, githubLogin: () => string | null = hostGithubLogin,
  discoverLogin: (browser: { profile: string; executable?: string }) => string | null = hostProfileLogin): UpDependencies & { children: Set<ChildProcess> } {
  // The children still running, for forwardSignals.
  const children = new Set<ChildProcess>();
  // GY-1641: --url, else the address master.json records, else the one this machine's install record (install.json) holds.
  const serverUrl = async () => {
    if (request.url) return request.url;
    try { const url = String(JSON.parse(await readFile(resolve(root, '.graphyard/master.json'), 'utf8')).url ?? ''); if (url) return url; } catch { /* not recorded yet */ }
    // A self-contained host's record names its server before that install completes, so only master.json counts there.
    if (remoteLoopProviders.includes(request.provider)) return null;
    return (await readInstallRecord(installDirectory(installIdFor(request.repository))).catch(() => null))?.url ?? null;
  };
  const masterToken = async () => { const url = await serverUrl(); return url ? (await masterCredential(root, url))?.token ?? null : null; };
  const browser = request.agent ? upBrowserProfile(root, request, hostInstallRoots(), githubLogin, discoverLogin) : null;
  if (browser?.from) emit({ kind: 'note', text: `No --browser-profile given: the App pages are driven in Chrome profile ${browser.profile}, which the Graphyard install at ${browser.from} uses, signed in to GitHub as ${browser.login}, the login gh uses here; pass --browser-profile to use another.` });
  // The loop runs from the checkout of the CLI master init recorded, which is this CLI until it has.
  const loopCheckout = async () => {
    let recorded: unknown = null;
    try { recorded = JSON.parse(await readFile(resolve(root, '.graphyard/master.json'), 'utf8')).cliPath; } catch { /* not initialised yet */ }
    return readCoordinatorCheckout(coordinatorCheckoutRoot(typeof recorded === 'string' && recorded ? recorded : cliPath));
  };
  return {
    root, emit, serverUrl, masterToken, children,
    publishOnboarding: workflows => publishOnboarding(root, request.repository, (program, args, env) => execFileSync(program, args, { cwd: root, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env: { ...process.env, ...env } } : {}) }), workflows),
    cliCheckout: async () => { const checkout = await loopCheckout(); return { root: checkout.root, dirty: dirtyCheckoutPaths(checkout) }; },
    loopRefusal: async () => coordinatorCheckoutRefusal(await loopCheckout(), 'the master loop'),
    onboardingMerged: async url => execFileSync('gh', ['pr', 'view', url, '--json', 'state', '--jq', '.state'], { encoding: 'utf8', timeout: 60_000 }).trim() === 'MERGED',
    fileOnboarding: async (url, operatorTokenFile, requestId) => {
      const server = await serverUrl();
      let token = '';
      try { token = operatorTokenFile ? (await readFile(operatorTokenFile, 'utf8')).trim() : ''; } catch { /* no credential on this machine */ }
      if (!server || token.length < 32) return null;
      return fileOnboardingWork({ server, token, url, checks: await onboardingChecks(root), host: hostname(), path: resolve(root, '.graphyard', 'onboarding'), requestId });
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
      let stdout = '', pending = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => {
        pending += chunk;
        // Bounded: only the tail is ever shown (childTail).
        stderr = (stderr + chunk).slice(-64_000);
        const lines = pending.split('\n'); pending = lines.pop() ?? '';
        for (const line of lines) { if (!request.agent) process.stderr.write(`${line}\n`); options.onLine?.(line); }
      });
      child.on('error', reject);
      child.on('close', code => { if (pending) options.onLine?.(pending); accept({ code: code ?? 1, stdout, stderr }); });
      child.stdin.end(options.stdin ?? '');
    }),
    status: async () => {
      const url = await serverUrl(), token = await masterToken();
      return url && token ? planeRequest(url, token)('status') : null;
    },
    supervise: async () => {
      // Only the login's name is read; gh's token stays in gh, used for setup alone (GY-1501).
      let login: string | null = null;
      try { login = execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { /* recorded without it */ }
      const recorded = await recordSupervision(root, 'supervised', login);
      return { operatorLogin: recorded.operatorLogin };
    },
    // GY-1552: control-plane merger creates the repository and registers the deploy key through gh.
    ...(upMergerControlPlane(request) ? {
      gh: (args: string[]) => new Promise<{ code: number; stdout: string; stderr?: string }>(accept => {
        const child = spawn('gh', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', error => accept({ code: 1, stdout, stderr: String(error.message ?? error) }));
        child.on('close', code => accept({ code: code ?? 1, stdout, stderr }));
      }),
      installDirectory: () => installDirectory(installIdFor(request.repository)),
    } : {}),
    // Each App page gets its own recorded drive, so each has its own record directory.
    // Control-plane merger needs no App browser drive.
    ...(!upMergerControlPlane(request) && browser ? { driveApp: (url: string, handoff: Handoff) => recordedAppDriver(root, request, { profile: browser.profile, ...(browser.executable ? { executable: browser.executable } : {}) }, undefined, { emit }).drive(url, handoff) } : {}),
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
  if (event.kind === 'onboarding') return !event.wait.waitingFor.length ? `· onboarding: ${event.wait.key}: ${event.wait.line}` : `· onboarding: ${event.wait.key} (${event.wait.url ?? 'its pull request'}) waits for ${event.wait.waitingFor.join(' and ')}, ${waitedFor(event.wait.waitedMs)} so far; the loop reviews and merges it`;
  if (event.kind === 'handoff') return `NEEDS YOU: ${event.sentence}${event.code ? ` (code ${event.code})` : ''}${event.url ? ` — ${event.url}` : ''}`;
  return event.text;
}
