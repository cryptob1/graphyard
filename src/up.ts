import { randomUUID } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { goalSubmission, setupAddress, setupChecklist, type SetupItem, type SetupItemId } from './model/setup-checklist.js';
import { actionsDirectory, agentBrowserPage, browserProfileMode, passSudo, recordingPage, submitSudoCode, sudoInstruction, sudoProtectedPage, sudoStateSchema, takeSudoCode, type BrowserPage, type BrowserProfileMode, type RecordedStep, type SudoOptions, type SudoState } from './master-browser.js';
import { appImportRoute } from './github-setup.js';
import { masterCredential, planeRequest } from './setup-from-zero.js';
import { fileOnboardingWork, onboardingChecks } from './onboarding.js';
import { findOnboardingWork, onboardingBranch, onboardingWait, waitedFor, type OnboardingWait } from './model/onboarding-work.js';
import { coordinatorCheckoutRefusal, coordinatorCheckoutRoot, dirtyCheckoutPaths, readCoordinatorCheckout } from './master/profiles.js';

/**
 * `graphyard up` (GY-1419): every machine step of a first installation, in order — preflight,
 * control plane, host supervisor and Herdr, the master's agent identities (GY-1479), onboarding, agent accounts, harness, master loop — and
 * a wait on the first-run checklist (src/model/setup-checklist.ts) wherever a person must act.
 * Each step is an existing idempotent command run as a child of this CLI, and each completed step
 * is recorded in .graphyard/up.json, so a rerun after any interruption skips what is done and never
 * registers an identity, App or variable twice. It never repoints a Herdr plugin bound to another
 * server: that refusal is answered with --no-herdr.
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
 */

export const upSteps = ['preflight', 'control-plane', 'host-supervisor', 'master-autonomy', 'onboarding', 'accounts', 'harness', 'master-loop', 'goal'] as const;
export type UpStep = typeof upSteps[number];

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
}
/** Agent mode's default wait on a person: 20 minutes, the time the Confirm-access handoff asks for (GY-1457). */
export const upAgentWaitMs = 1_200_000;
/** How long each wait on a person lasts: --wait, else 20 minutes in agent mode, else no bound. */
export const upWaitMs = (request: Pick<UpRequest, 'agent' | 'waitMs'>) => request.waitMs ?? (request.agent ? upAgentWaitMs : Infinity);

export type UpEvent =
  | { kind: 'step'; step: UpStep; state: 'start' | 'done' | 'skipped'; detail?: string }
  | { kind: 'waiting'; setupUrl: string; waitingFor: SetupItemId[]; sentence: string }
  | { kind: 'handoff'; step: UpStep; sentence: string; url: string | null; code: string | null }
  /** GY-1478: the onboarding pull request is the current setup step: its URL, what it waits for and how long it has waited. */
  | { kind: 'onboarding'; wait: OnboardingWait }
  | { kind: 'note'; text: string };

/** What a device step hands to a person, or that it completed. */
export type DriveOutcome = { state: 'done' } | { state: 'failed'; reason: string } | { state: 'waiting'; next: string };
export type Handoff = (sentence: string, link: { url?: string | null; code?: string | null }) => void;

export interface UpDependencies {
  root: string;
  /** Runs one graphyard command; stderr lines go to onLine as they arrive. */
  cli(args: string[], options?: { stdin?: string; env?: Record<string, string>; onLine?: (line: string) => void; signal?: AbortSignal }): Promise<{ code: number; stdout: string }>;
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
  /** Agent mode: drive the App manifest page at URL in the master's browser profile, recorded as a master browser flow. */
  driveApp?(url: string, handoff: Handoff): Promise<DriveOutcome>;
  /** GY-1477: this host's Tailscale node (its MagicDNS name and tailnet address), or null without a running Tailscale. */
  tailnet?(): Promise<Tailnet | null>;
  /** GY-1477: runs the tailnet-only serve command tailnetShare names; ok false (with what it said) when it fails or does not finish. */
  applyTailnet?(command: string[]): Promise<{ ok: boolean; detail?: string }>;
  pollMs?: number;
  /** How long a step waits on a person before the run stops (resumable); Infinity interactively. */
  humanWaitMs?: number;
  /** How long a machine step (the loop starting, protection) may take to turn green. */
  machineWaitMs?: number;
}

export interface UpResult {
  ok: boolean;
  exitCode: number;
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
/** The drive met Confirm access under --no-wait: it stops there, naming the next step (GY-1457). */
class SudoNoWait extends Error {}

interface UpState {
  version: 1; repository: string; provider: string; completed: UpStep[]; noHerdr: boolean; goal: string | null;
  /** Where the install saved the operator's admin credential (a path, never the secret): what mints the sign-in link. */
  operatorTokenFile?: string | null;
  /** The goal's request id, fixed before the first try so a rerun after an interruption never creates it twice. */
  goalRequest?: string | null;
  /** The pull request that publishes the onboarding files, until it merges. */
  onboardingPullRequest?: string | null;
  /** The work item that pull request is filed as (GY-1478), and the request id that files it once. */
  onboardingWork?: string | null;
  onboardingRequest?: string | null;
  /** GY-1477: the tailnet address a local dashboard was served on, once `tailscale serve` applied it. */
  tailnetUrl?: string | null;
  /** The host that provisioned the master's agent identities itself (GY-1479), where its loop runs. */
  identitiesHost?: string | null;
}
export const upStateFile = (root: string) => resolve(root, '.graphyard/up.json');

async function readState(root: string, request: UpRequest): Promise<UpState> {
  try {
    const state = JSON.parse(await readFile(upStateFile(root), 'utf8'));
    // A run for another repository or provider starts over: its steps say nothing about this one.
    if (state?.version === 1 && state.repository === request.repository && state.provider === request.provider) return { ...state, completed: (state.completed ?? []).filter((step: string) => (upSteps as readonly string[]).includes(step)) };
  } catch (error: any) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  return { version: 1, repository: request.repository, provider: request.provider, completed: [], noHerdr: false, goal: null };
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
  const checklist = async () => (last = setupChecklist(await deps.status().catch(() => null)));
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
  const run = async (step: UpStep, args: string[], options: { stdin?: string; env?: Record<string, string>; onLine?: (line: string) => void } = {}) => {
    const result = await deps.cli(args, options);
    if (result.code !== 0) throw new UpStop(`${step}: graphyard ${args[0]}${args[1] && !args[1].startsWith('-') ? ` ${args[1]}` : ''} exited ${result.code}${result.stdout.trim() ? `: ${result.stdout.trim().split('\n').slice(-1)[0].slice(0, 400)}` : ''}`, upExitCodes.failed);
    return result.stdout;
  };
  const passed = request.install ?? {};
  const installArgs = (mode: '--plan' | '--apply') => ['install', '--provider', request.provider, '--repo', request.repository, '--reviewer', request.reviewer, mode, ...(state.noHerdr ? ['--no-herdr'] : []),
    ...([['--confirm-price', passed.confirmPrice], ['--max-monthly', passed.maxMonthly], ['--ssh-key', passed.sshKey], ['--ssh-host', passed.sshHost], ['--ssh-user', passed.sshUser]] as const).flatMap(([flag, value]) => value ? [flag, value] : []),
    ...(request.reuseApps ?? []).flatMap(slug => ['--reuse-app', slug])];
  const rerun = () => `graphyard up --repo ${request.repository} --provider ${request.provider}${request.agent ? ' --agent' : ''}`;
  const step = async (name: UpStep, body: () => Promise<string | void>) => {
    if (state.completed.includes(name)) { deps.emit({ kind: 'step', step: name, state: 'skipped', detail: 'done by an earlier run' }); return; }
    deps.emit({ kind: 'step', step: name, state: 'start' });
    const detail = await body();
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

    // Agent mode creates the Apps in a browser; without a profile it would hand the whole App
    // creation to a person, which only a device approval may be. It stops before anything runs.
    // A reused App (GY-1442) or one saved on this machine (GY-1476) needs no browser, so agent mode
    // starts without one only when the install's read-only plan says no App is left to create in a
    // browser: install reuses a saved App before any App page is driven.
    const noProfile = 'Agent mode creates the GitHub Apps in a Chrome profile signed in to GitHub, and none is given or recorded: pass --browser-profile PROFILE and rerun graphyard up --agent.';
    if (request.agent && !state.completed.includes('control-plane') && !deps.driveApp) {
      const browserApps: unknown = parseJson(await run('preflight', installArgs('--plan')))?.browserApps;
      const left = Array.isArray(browserApps) ? browserApps.map(String) : ['control-plane', 'reviewer'];
      const apps = left.map(role => role === 'reviewer' ? `reviewer App "${request.reviewer}"` : 'control-plane App').join(' and ');
      if (left.length) throw new UpStop(request.reuseApps?.length ? `${noProfile} --reuse-app covers no ${apps}, which would otherwise be created in that browser; reuse one for it too, or pass the profile.` : `${noProfile} No App saved on this machine covers the ${apps}.`, upExitCodes.prerequisite);
    }

    await step('preflight', async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const planned = await run('preflight', installArgs('--plan'));
        const plan = parseJson(planned);
        await rememberSignIn(deps.root, state, planned);
        const failed: { name: string; detail?: string; fix?: string }[] = (plan?.preflight ?? []).filter((check: any) => check && check.ok === false);
        // A Herdr plugin bound to another server keeps that server (GY-1413): up never passes --herdr-rebind.
        if (failed.some(check => check.name === 'Herdr plugin') && !state.noHerdr) {
          state.noHerdr = true; await writeState(deps.root, state);
          deps.emit({ kind: 'note', text: 'Herdr\'s graphyard plugin is bound to another server; it is left as it is (--no-herdr). Workers start from the CLI.' });
          continue;
        }
        // Spending money is the operator's decision: an unconfirmed price waits on that consent (exit 3), it is not a failure.
        const price = failed.find(check => check.name === 'Monthly price');
        if (price && failed.length === 1) throw new UpStop(`Creating the server needs the operator's consent to its price: ${price.detail ?? 'not confirmed'}. Once they approve it, rerun ${rerun()} --confirm-price PRICE (or --max-monthly N); nothing has been created.`, upExitCodes.waiting);
        if (failed.length) throw new UpStop(`Preflight needs a person on this machine: ${failed.map(check => `${check.name}: ${check.detail ?? 'failed'}${check.fix ? ` (fix: ${check.fix})` : ''}`).join('; ')}. Fix it, then rerun graphyard up.`, upExitCodes.prerequisite);
        return `${(plan?.preflight ?? []).length} checks passed`;
      }
      throw new UpStop('Preflight did not settle after leaving Herdr untouched', upExitCodes.failed);
    });

    await step('control-plane', async () => {
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
        const waiting: string[] = [];
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
            if (outcome.state === 'failed') { gaveUp.push(outcome.reason); manual(url); }
          });
        } }).catch(error => { if (stopped.signal.aborted) return { code: 1, stdout: '' }; throw error; }).finally(() => { running = false; });
        await watcher;
        await drives;
        if (waiting.length) throw new UpStop(waiting[0], upExitCodes.waiting);
        claim = await rememberSignIn(deps.root, state, result.stdout) ?? claim;
        if (result.code === 0) return 'control plane installed with its GitHub Apps';
        const paused = parseJson(result.stdout);
        const drove = gaveUp.length ? `; the browser could not finish the App page (${gaveUp.join('; ')}), its record is under .graphyard/master-actions` : '';
        if (!paused?.resume || deps.now() >= deadline) throw new UpStop(`control-plane: graphyard install exited ${result.code}${drove}${paused?.resume ? '; the App page is still unconfirmed, rerun graphyard up to resume' : ''}`, paused?.resume ? upExitCodes.waiting : upExitCodes.failed);
        deps.emit({ kind: 'note', text: 'The App page is still waiting for a person; serving it again' });
      }
    });
    await resolveSetupUrl();
    await reach();

    await step('host-supervisor', async () => {
      const token = await deps.masterToken();
      if (!token) throw new UpStop('host-supervisor: no master credential is recorded for the installed control plane', upExitCodes.failed);
      await run('host-supervisor', ['master', 'init', '--token-stdin', ...(request.browserProfile ? ['--browser-profile', request.browserProfile] : [])], { stdin: token });
    });

    // GY-1479: the master's operator-agent and approver identities (`master autonomy --apply`), provisioned
    // with the admin credential the install saved, so the new master creates, releases and unblocks work
    // with no further command. That credential is never something an agent session may read.
    await step('master-autonomy', async () => {
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
      const accounts: SetupItemId[] = ['account:worker', 'account:reviewer'];
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
        if (polls === 0) deps.emit({ kind: 'note', text: `Waiting for the onboarding pull request ${pullRequest} to merge: it adds Graphyard's delivery workflows to the base branch.${state.onboardingWork ? ` The loop reviews and merges it as ${state.onboardingWork}.` : ''}` });
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
    return { ok, exitCode, setupUrl, completed: [...state.completed], prompts, handoffs, checklist: last.map(({ id, done, line }) => ({ id, done, line })), onboarding, goal: state.goal, signIn, reachableUrl: state.tailnetUrl ?? null, next };
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
  if (request.reviewer !== 'claude') option('--reviewer', request.reviewer);
  if (request.master !== 'claude') option('--master', request.master);
  option('--goal', request.goalFile);
  option('--browser-profile', request.browserProfile);
  option('--confirm-price', request.install?.confirmPrice);
  option('--max-monthly', request.install?.maxMonthly);
  option('--ssh-key', request.install?.sshKey);
  option('--ssh-host', request.install?.sshHost);
  option('--ssh-user', request.install?.sshUser);
  if (request.sudo === 'mobile') flags.push('--github-mobile');
  if (request.waitMs) option('--wait', String(request.waitMs / 60_000));
  if (request.shareTailnet) flags.push('--share-tailnet');
  return flags.map(shellWord).map(word => ` ${word}`).join('');
}

/**
 * The repository and provider an earlier run recorded in .graphyard/up.json (GY-1466), so a resumed
 * `up` needs neither flag again; null when no run is recorded here.
 */
export function recordedUp(root: string): { repository: string; provider: string } | null {
  try {
    const state = JSON.parse(readFileSync(upStateFile(root), 'utf8'));
    return state?.version === 1 && typeof state.repository === 'string' && typeof state.provider === 'string' ? { repository: state.repository, provider: state.provider } : null;
  } catch (error: any) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

/**
 * `graphyard up`'s flags. With a run RECORDED in this checkout, an omitted --repo or --provider is
 * the recorded one, and one that differs is refused, naming both: its steps say nothing about it.
 */
export function upRequestFromArgs(args: string[], recorded: { repository: string; provider: string } | null = null): UpRequest {
  const { values } = parseArgs({ args, options: { repo: { type: 'string' }, provider: { type: 'string' }, agent: { type: 'boolean' }, json: { type: 'boolean' }, reviewer: { type: 'string' }, master: { type: 'string' }, goal: { type: 'string' }, 'browser-profile': { type: 'string' },
    'confirm-price': { type: 'string' }, 'max-monthly': { type: 'string' }, 'ssh-key': { type: 'string' }, 'ssh-host': { type: 'string' }, 'ssh-user': { type: 'string' },
    'reuse-app': { type: 'string', multiple: true }, 'github-mobile': { type: 'boolean' }, wait: { type: 'string' }, 'no-wait': { type: 'boolean' }, 'share-tailnet': { type: 'boolean' }, local: { type: 'boolean' } }, allowPositionals: false });
  // --local is --provider local (GY-1500): the control plane on embedded Postgres on this machine, no Docker.
  if (values.local && values.provider !== undefined && values.provider !== 'local') throw new Error(`graphyard up --local means --provider local; it cannot be combined with --provider ${values.provider}`);
  const provider = values.local ? 'local' : values.provider;
  for (const [flag, given, kept] of [['--repo', values.repo, recorded?.repository], ['--provider', provider, recorded?.provider]] as const) {
    if (given !== undefined && kept !== undefined && given !== kept) throw new Error(`graphyard up ${flag} ${given} conflicts with ${kept}, which the run recorded in .graphyard/up.json resumes; omit ${flag} (or pass ${kept}) to resume it, or remove .graphyard/up.json to start over for ${given}`);
  }
  const repository = values.repo ?? recorded?.repository;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Use graphyard up --repo OWNER/NAME [--provider compose|railway|hetzner|local | --local] [--agent]');
  const minutes = values.wait === undefined ? null : Number(values.wait);
  if (minutes !== null && (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1_440)) throw new Error('Use --wait with whole minutes from 1 to 1440');
  return { repository, provider: provider ?? recorded?.provider ?? 'compose', agent: !!values.agent, reviewer: values.reviewer ?? 'claude', master: values.master ?? 'claude',
    goalFile: values.goal ?? null, browserProfile: values['browser-profile'] ?? null,
    install: { confirmPrice: values['confirm-price'] ?? null, maxMonthly: values['max-monthly'] ?? null, sshKey: values['ssh-key'] ?? null, sshHost: values['ssh-host'] ?? null, sshUser: values['ssh-user'] ?? null },
    ...(values['reuse-app']?.length ? { reuseApps: values['reuse-app'] } : {}), ...(values['github-mobile'] ? { sudo: 'mobile' as const } : {}),
    ...(minutes !== null ? { waitMs: minutes * 60_000 } : {}), ...(values['no-wait'] ? { noWait: true } : {}), ...(values['share-tailnet'] ? { shareTailnet: true } : {}) };
}

/**
 * Agent mode's App step (AC-5): the installer's manifest page, driven in the master's browser
 * profile — register the App, then install it on the repository alone (GitHub preselects it from
 * `repository_ids[]`). A Confirm-access prompt is passed with passSudo, the page's own confirmation
 * first (GY-1442): the handoff names a sudo-protected page to confirm access on once in the
 * operator's own Chrome, which the shared GitHub session then carries, and every method the page
 * offers; the drive re-checks every 10 s and types in an authenticator or email code handed over
 * on the manifest page or with `graphyard up --sudo-code` (GY-1450). GitHub Mobile is triggered only
 * when the page offers nothing else or the operator chose it (`--github-mobile`, `sudo: 'mobile'`);
 * a Mobile code unapproved for a minute is handed off again with the passkey or password link.
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
      else handoff([sudoInstruction(state, 'your phone', { ...(options.readCode ? { page: setupPage, command: 'graphyard up --sudo-code' } : {}), profile: options.profile ?? null }), importRoute].join('\n'),
        { url: state.fallback?.url ?? state.url ?? page.url(), code: state.code });
      if (options.noWait) throw new SudoNoWait(`GitHub asks to confirm access before it creates the App, and --no-wait does not wait for it. ${importRoute}; or rerun ${rerun} without --no-wait to wait for the confirmation.`);
    };
    // passSudo's flow names the closest master browser flow; its rerun advice is this command's.
    try {
      const passed = await passSudo(page, { flow: 'installation-accept', record: options.record ?? 'graphyard up', sleep: options.sleep, now: options.now, timeoutMs: options.timeoutMs ?? upAgentWaitMs, prefer: options.sudo ?? 'passkey-or-password', readCode: options.readCode,
        onCode, onSettled: state => options.remember?.(state.state === 'approved' ? null : state) });
      return passed.passed;
    } catch (error: any) {
      if (error instanceof SudoNoWait) throw error;
      const reason = String(error?.message ?? error).replace(/rerun master browser installation-accept/g, `rerun ${rerun}`);
      // A copied profile never sees a confirmation in the operator's own Chrome, so the timeout does not offer it.
      throw new Error(options.profile?.mode === 'copy' ? reason.replace(`, or once in your own Chrome at ${sudoProtectedPage}`, '') : reason);
    }
  };
  const press = async (kind: 'button' | 'link', text: string, handoff: Handoff) => {
    await awaitSudo(handoff);
    const control = page.locate(kind, text);
    if (!control) throw new Error(`the page offers no "${text}" ${kind}`);
    page.click(control.selector); page.wait(2_000);
    await awaitSudo(handoff);
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
        await press('button', `Create GitHub App for ${owner}`, handoff);
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
    } catch (error: any) { outcome = error instanceof SudoNoWait ? { state: 'waiting', next: error.message } : { state: 'failed', reason: String(error?.message ?? error).split('\n')[0] }; }
    try { page.close(); } catch { /* recorded on the step */ }
    await options.onClose?.(outcome);
    return outcome;
  };
}

/**
 * The browser profile agent mode drives the App pages in: the one passed, else the one the master
 * recorded (`master init --browser-profile`), else none, and agent mode stops before it starts.
 */
export function upBrowserProfile(root: string, request: UpRequest): { profile: string; executable?: string } | null {
  if (request.browserProfile) return { profile: request.browserProfile };
  try { const browser = JSON.parse(readFileSync(resolve(root, '.graphyard/master.json'), 'utf8')).browser; return typeof browser?.profile === 'string' && browser.profile ? browser : null; }
  catch { return null; }
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
      await writeFile(resolve(directory, 'record.json'), `${JSON.stringify({ id, flow: 'app-create', startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(), actor: { profile: browser.profile }, target: { repository: request.repository }, outcome: outcome.state === 'done' ? 'applied' : 'refused', ...(outcome.state === 'failed' ? { reason: outcome.reason } : {}), screenshots: steps.filter(step => step.screenshot).length, steps }, null, 2)}\n`, { mode: 0o600 });
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
export function upDependencies(root: string, cliPath: string, request: UpRequest, emit: (event: UpEvent) => void): UpDependencies & { children: Set<ChildProcess> } {
  // The children still running, for forwardSignals.
  const children = new Set<ChildProcess>();
  const serverUrl = async () => { try { return String(JSON.parse(await readFile(resolve(root, '.graphyard/master.json'), 'utf8')).url ?? '') || null; } catch { return null; } };
  const masterToken = async () => { const url = await serverUrl(); return url ? (await masterCredential(root, url))?.token ?? null : null; };
  const browser = request.agent ? upBrowserProfile(root, request) : null;
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
    operatorToken: async file => { if (!file) return null; try { const token = (await readFile(file, 'utf8')).trim(); return token.length >= 32 ? token : null; } catch { return null; } },
    sleep: ms => new Promise(accept => setTimeout(accept, ms)), now: () => Date.now(),
    cli: (args, options = {}) => new Promise((accept, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], ...(options.signal ? { signal: options.signal } : {}), ...(options.env ? { env: { ...process.env, ...options.env } } : {}) });
      children.add(child);
      child.on('exit', () => children.delete(child));
      let stdout = '', pending = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => {
        pending += chunk;
        const lines = pending.split('\n'); pending = lines.pop() ?? '';
        for (const line of lines) { if (!request.agent) process.stderr.write(`${line}\n`); options.onLine?.(line); }
      });
      child.on('error', reject);
      child.on('close', code => { if (pending) options.onLine?.(pending); accept({ code: code ?? 1, stdout }); });
      child.stdin.end(options.stdin ?? '');
    }),
    status: async () => {
      const url = await serverUrl(), token = await masterToken();
      return url && token ? planeRequest(url, token)('status') : null;
    },
    // Each App page gets its own recorded drive, so each has its own record directory.
    ...(browser ? { driveApp: (url: string, handoff: Handoff) => recordedAppDriver(root, request, browser, undefined, { emit }).drive(url, handoff) } : {}),
  };
}

/** One line a person reads for an event, as the interactive run prints it. */
export function describeUpEvent(event: UpEvent) {
  if (event.kind === 'step') return event.state === 'start' ? `→ ${event.step}` : `${event.state === 'done' ? '✓' : '·'} ${event.step}${event.detail ? `: ${event.detail}` : ''}`;
  if (event.kind === 'waiting') return `\n${event.sentence}\n`;
  if (event.kind === 'onboarding') return !event.wait.waitingFor.length ? `· onboarding: ${event.wait.key}: ${event.wait.line}` : `· onboarding: ${event.wait.key} (${event.wait.url ?? 'its pull request'}) waits for ${event.wait.waitingFor.join(' and ')}, ${waitedFor(event.wait.waitedMs)} so far; the loop reviews and merges it`;
  if (event.kind === 'handoff') return `NEEDS YOU: ${event.sentence}${event.code ? ` (code ${event.code})` : ''}${event.url ? ` — ${event.url}` : ''}`;
  return event.text;
}
