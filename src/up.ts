import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { goalWorkItem, setupAddress, setupChecklist, type SetupItem, type SetupItemId } from './model/setup-checklist.js';
import { actionsDirectory, agentBrowserPage, passSudo, recordingPage, type BrowserPage, type RecordedStep } from './master-browser.js';
import { masterCredential, planeRequest } from './setup-from-zero.js';

/**
 * `graphyard up` (GY-1419): every machine step of a first installation, in order — preflight,
 * control plane, host supervisor and Herdr, onboarding, agent accounts, harness, master loop — and
 * a wait on the first-run checklist (src/model/setup-checklist.ts) wherever a person must act.
 * Each step is an existing idempotent command run as a child of this CLI, and each completed step
 * is recorded in .graphyard/up.json, so a rerun after any interruption skips what is done and never
 * registers an identity, App or variable twice. It never repoints a Herdr plugin bound to another
 * server: that refusal is answered with --no-herdr.
 *
 * Interactive, a human step prints the dashboard's Setup page address once and waits for the step
 * to turn green. That address is a one-time sign-in link minted with the operator's own credential
 * (or the host install's claim) and ending `&setup`, so opening it signs the person in and lands on
 * the Setup page with no token to paste. With --agent, every step has a non-interactive path (the
 * App manifest is driven through the master's browser profile and recorded under
 * .graphyard/master-actions like every master browser flow, accounts come from login homes already
 * on the host, the goal from a file) and only a step that needs a person's own device or identity —
 * a GitHub Mobile or passkey approval, a subscription login's browser approval — is handed off, as
 * one sentence plus a link or code; the run resumes on its own once it completes. Agent mode with
 * no browser profile stops before anything runs: App creation is never handed to a person.
 */

export const upSteps = ['preflight', 'control-plane', 'host-supervisor', 'onboarding', 'accounts', 'harness', 'master-loop', 'goal'] as const;
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
}

export type UpEvent =
  | { kind: 'step'; step: UpStep; state: 'start' | 'done' | 'skipped'; detail?: string }
  | { kind: 'waiting'; setupUrl: string; waitingFor: SetupItemId[]; sentence: string }
  | { kind: 'handoff'; step: UpStep; sentence: string; url: string | null; code: string | null }
  | { kind: 'note'; text: string };

/** What a device step hands to a person, or that it completed. */
export type DriveOutcome = { state: 'done' } | { state: 'failed'; reason: string };
export type Handoff = (sentence: string, link: { url?: string | null; code?: string | null }) => void;

export interface UpDependencies {
  root: string;
  /** Runs one graphyard command; stderr lines go to onLine as they arrive. */
  cli(args: string[], options?: { stdin?: string; env?: Record<string, string>; onLine?: (line: string) => void }): Promise<{ code: number; stdout: string }>;
  /** The control plane's /api/status as the recorded master identity, or null while none answers. */
  status(): Promise<any | null>;
  /** The control plane's address once the install recorded it. */
  serverUrl(): Promise<string | null>;
  /** The master credential the install recorded for that control plane (.graphyard/master.json). */
  masterToken(): Promise<string | null>;
  /**
   * A one-time dashboard sign-in address (`SERVER/#sign-in=CODE`) minted with the operator's admin
   * credential in OPERATOR_TOKEN_FILE, or null when none can be minted (no such file on this machine).
   */
  signIn?(operatorTokenFile: string | null): Promise<string | null>;
  emit(event: UpEvent): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  /**
   * Publish the onboarding files `init --scan --apply` wrote (AGENTS.md, .gitignore, graphyard.json,
   * .github/workflows) as a pull request against the base branch, reusing one already open; null when
   * the base branch already holds them.
   */
  publishOnboarding(): Promise<{ pullRequest: string } | null>;
  /** Whether the onboarding pull request at URL has merged, so the base branch carries the delivery workflows. */
  onboardingMerged(url: string): Promise<boolean>;
  /** Agent mode: drive the App manifest page at URL in the master's browser profile, recorded as a master browser flow. */
  driveApp?(url: string, handoff: Handoff): Promise<DriveOutcome>;
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
  goal: string | null;
  next: string;
}

/** Exit codes: 0 green, 1 a step failed, 2 a machine prerequisite needs a person, 3 still waiting on a person (rerun resumes). */
export const upExitCodes = { green: 0, failed: 1, prerequisite: 2, waiting: 3 } as const;

class UpStop extends Error { constructor(message: string, readonly exitCode: number) { super(message); } }

interface UpState {
  version: 1; repository: string; provider: string; completed: UpStep[]; noHerdr: boolean; goal: string | null;
  /** Where the install saved the operator's admin credential (a path, never the secret): what mints the sign-in link. */
  operatorTokenFile?: string | null;
  /** The goal's request id, fixed before the first try so a rerun after an interruption never creates it twice. */
  goalRequest?: string | null;
  /** The pull request that publishes the onboarding files, until it merges. */
  onboardingPullRequest?: string | null;
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
  if (!output || typeof output !== 'object') return { claim: null, operatorTokenFile: null };
  const admin = Array.isArray(output.principals) ? output.principals.find((principal: any) => principal?.role === 'admin') : null;
  const operatorTokenFile = typeof admin?.tokenFile === 'string' ? admin.tokenFile as string
    : !output.host && typeof output.installDirectory === 'string' && typeof admin?.id === 'string' ? resolve(output.installDirectory, 'tokens', `${admin.id}.token`) : null;
  return { claim: typeof output.signIn === 'string' && /#claim=[A-Za-z0-9_-]{16,200}$/.test(output.signIn) ? output.signIn as string : null, operatorTokenFile };
}
/** Keep where the operator's credential is saved (the path, never the secret), for the sign-in link. */
async function rememberSignIn(root: string, state: UpState, stdout: string) {
  const { claim, operatorTokenFile } = installSignIn(stdout);
  if (operatorTokenFile && operatorTokenFile !== state.operatorTokenFile) { state.operatorTokenFile = operatorTokenFile; await writeState(root, state); }
  return claim;
}

export async function runUp(request: UpRequest, deps: UpDependencies): Promise<UpResult> {
  const state = await readState(deps.root, request);
  const pollMs = deps.pollMs ?? 5_000;
  const humanWaitMs = deps.humanWaitMs ?? (request.agent ? 3_600_000 : Infinity);
  const machineWaitMs = deps.machineWaitMs ?? 600_000;
  let setupUrl: string | null = null, prompts = 0, last: SetupItem[] = setupChecklist(null), claim: string | null = null;
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
  const resolveSetupUrl = async () => { const url = await deps.serverUrl(); if (url) setupUrl = setupAddress(url); return setupUrl; };
  const complete = async (step: UpStep, detail?: string) => {
    if (!state.completed.includes(step)) state.completed.push(step);
    await writeState(deps.root, state);
    deps.emit({ kind: 'step', step, state: 'done', ...(detail ? { detail } : {}) });
  };
  /**
   * The interactive wait: the Setup address printed once for the whole run, then a poll until IDS
   * are green. It signs the person in: the host install's claim, else a link the operator's own
   * credential mints; only when neither exists does it fall back to the bare address.
   */
  const announce = async (ids: SetupItemId[]) => {
    if (prompts > 0 || request.agent) return;
    const server = await deps.serverUrl();
    if (!server) return;
    await resolveSetupUrl();
    const signIn = claim ?? await deps.signIn?.(state.operatorTokenFile ?? null).catch(() => null) ?? null;
    claim = null;
    const url = setupAddress(server, signIn);
    prompts++;
    deps.emit({ kind: 'waiting', setupUrl: url, waitingFor: ids, sentence: signIn
      ? `Open ${url} to sign in to the Setup page and follow the checklist (the link works once, within 10 minutes); this command carries on as each step turns green.`
      : `Open ${url}, sign in with the link graphyard login prints, and follow the checklist; this command carries on as each step turns green.` });
  };
  const waitGreen = async (ids: SetupItemId[], human: boolean, whilePending?: (pending: SetupItemId[], polls: number) => Promise<void>) => {
    const deadline = deps.now() + (human ? humanWaitMs : machineWaitMs);
    for (let polls = 0; ; polls++) {
      const items = await checklist();
      const pending = ids.filter(id => !items.find(item => item.id === id)?.done);
      if (!pending.length) return;
      if (human) await announce(pending);
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
    ...([['--confirm-price', passed.confirmPrice], ['--max-monthly', passed.maxMonthly], ['--ssh-key', passed.sshKey], ['--ssh-host', passed.sshHost], ['--ssh-user', passed.sshUser]] as const).flatMap(([flag, value]) => value ? [flag, value] : [])];
  const rerun = () => `graphyard up --repo ${request.repository} --provider ${request.provider}${request.agent ? ' --agent' : ''}`;
  const step = async (name: UpStep, body: () => Promise<string | void>) => {
    if (state.completed.includes(name)) { deps.emit({ kind: 'step', step: name, state: 'skipped', detail: 'done by an earlier run' }); return; }
    deps.emit({ kind: 'step', step: name, state: 'start' });
    const detail = await body();
    await complete(name, detail || undefined);
  };

  try {
    // Agent mode creates the Apps in a browser; without a profile it would hand the whole App
    // creation to a person, which only a device approval may be. It stops before anything runs.
    if (request.agent && !state.completed.includes('control-plane') && !deps.driveApp) throw new UpStop('Agent mode creates the GitHub Apps in a Chrome profile signed in to GitHub, and none is given or recorded: pass --browser-profile PROFILE and rerun graphyard up --agent.', upExitCodes.prerequisite);

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
      // The install waits on the App pages itself; it pauses (exit 1) after 900 s and a rerun resumes it.
      const deadline = deps.now() + humanWaitMs;
      for (;;) {
        // One browser drive at a time, in the order the installer serves its App pages; every outcome is reported.
        let drives: Promise<DriveOutcome[]> = Promise.resolve([]);
        let running = true;
        const watcher = (async () => {
          while (running) {
            const items = await checklist();
            const pending = (['github-app', 'reviewer-app'] as SetupItemId[]).filter(id => !items.find(item => item.id === id)?.done);
            if (pending.length && await deps.serverUrl()) await announce(pending);
            await deps.sleep(pollMs);
          }
        })();
        const result = await deps.cli(installArgs('--apply'), { onLine: line => {
          const url = manifestUrl(line);
          if (!url || !request.agent || !deps.driveApp) return;
          drives = drives.then(async outcomes => [...outcomes, await deps.driveApp!(url, handoff('control-plane'))]);
        } }).finally(() => { running = false; });
        await watcher;
        const failed = (await drives).filter((outcome): outcome is Extract<DriveOutcome, { state: 'failed' }> => outcome.state === 'failed');
        claim = await rememberSignIn(deps.root, state, result.stdout) ?? claim;
        if (result.code === 0) return 'control plane installed with its GitHub Apps';
        if (failed.length) throw new UpStop(`control-plane: the browser could not finish the App page (${failed.map(outcome => outcome.reason).join('; ')}); its record is under .graphyard/master-actions, and rerunning graphyard up --agent resumes`, upExitCodes.failed);
        const paused = parseJson(result.stdout);
        if (!paused?.resume || deps.now() >= deadline) throw new UpStop(`control-plane: graphyard install exited ${result.code}${paused?.resume ? '; the App page is still unconfirmed, rerun graphyard up to resume' : ''}`, paused?.resume ? upExitCodes.waiting : upExitCodes.failed);
        deps.emit({ kind: 'note', text: 'The App page is still waiting for a person; serving it again' });
      }
    });
    await resolveSetupUrl();

    await step('host-supervisor', async () => {
      const token = await deps.masterToken();
      if (!token) throw new UpStop('host-supervisor: no master credential is recorded for the installed control plane', upExitCodes.failed);
      await run('host-supervisor', ['master', 'init', '--token-stdin', ...(request.browserProfile ? ['--browser-profile', request.browserProfile] : [])], { stdin: token });
    });

    await step('onboarding', async () => {
      await run('onboarding', ['init', '--scan']);
      const url = await deps.serverUrl();
      await run('onboarding', ['init', '--scan', '--apply', ...(url ? ['--url', url] : [])]);
      // The files are written to this checkout only; the base branch needs them before any work is
      // delivered, so they are published as a pull request (the base is protected, never pushed to).
      const published = await deps.publishOnboarding().catch((error: any) => { throw new UpStop(`onboarding: publishing the onboarding files failed: ${String(error?.message ?? error).split('\n')[0].slice(0, 400)}; rerun graphyard up to retry`, upExitCodes.failed); });
      state.onboardingPullRequest = published?.pullRequest ?? null;
      return published ? `delivery workflow applied and published in ${published.pullRequest}` : 'delivery workflow applied; the base branch already holds it';
    });

    await step('accounts', async () => {
      const accounts: SetupItemId[] = ['account:worker', 'account:reviewer'];
      if (request.agent) {
        // Login homes and keys already on this host become the fleet; nothing is signed in here.
        await run('accounts', ['master', 'registry', 'propose', '--apply']);
        // The registry's first fold may lag the apply by a poll; only a role still empty after it is handed off.
        await waitGreen(accounts, true, async (pending, polls) => {
          if (polls > 0) handoff('accounts')(`Sign in to an AI coding account for ${pending.map(id => id.slice('account:'.length)).join(' and ')}: approve its browser login on your device`, { url: setupUrl });
        });
      } else await waitGreen(accounts, true);
    });

    await step('harness', async () => { await run('harness', ['master', 'harness', request.master, '--apply']); });

    await step('master-loop', async () => {
      if (!(await checklist()).find(item => item.id === 'master-loop')?.done) await run('master-loop', ['master', 'restart']);
      await waitGreen(['master-loop'], false);
    });

    await waitGreen(last.map(item => item.id), true);
    // No goal is submitted until the onboarding pull request has merged and the base carries the workflows.
    if (state.onboardingPullRequest) {
      const pullRequest = state.onboardingPullRequest;
      const deadline = deps.now() + humanWaitMs;
      for (let polls = 0; !(await deps.onboardingMerged(pullRequest)); polls++) {
        if (polls === 0) deps.emit({ kind: 'note', text: `Waiting for the onboarding pull request ${pullRequest} to merge: it adds Graphyard's delivery workflows to the base branch.` });
        if (deps.now() >= deadline) throw new UpStop(`Still waiting for the onboarding pull request ${pullRequest} to merge; rerun ${rerun()} to resume`, upExitCodes.waiting);
        await deps.sleep(pollMs);
      }
      state.onboardingPullRequest = null; await writeState(deps.root, state);
    }
    if (request.goalFile) {
      await step('goal', async () => {
        const item = goalWorkItem(await readFile(resolve(deps.root, request.goalFile!), 'utf8'));
        const file = resolve(deps.root, '.graphyard/up-goal.json');
        await writeFile(file, `${JSON.stringify(item, null, 2)}\n`, { mode: 0o600 });
        // The request id is saved before the first try: a rerun replays the same create, which the control plane answers once.
        if (!state.goalRequest) { state.goalRequest = randomUUID(); await writeState(deps.root, state); }
        const created = parseJson(await run('goal', ['master', 'create', file, 'Goal submitted by graphyard up'], { env: { GRAPHYARD_REQUEST_ID: state.goalRequest } }));
        state.goal = created?.key ?? created?.id ?? 'created';
        return `submitted as ${state.goal}`;
      });
    }
    return result(true, upExitCodes.green, state.goal ? `Graphyard is building ${state.goal}; follow it on the dashboard` : `Everything is green. Open ${setupUrl ?? 'the dashboard'} and describe what you want built${request.agent ? ', or rerun with --goal FILE' : ''}.`);
  } catch (error) {
    if (!(error instanceof UpStop)) throw error;
    return result(false, error.exitCode, error.message);
  }

  function result(ok: boolean, exitCode: number, next: string): UpResult {
    return { ok, exitCode, setupUrl, completed: [...state.completed], prompts, handoffs, checklist: last.map(({ id, done, line }) => ({ id, done, line })), goal: state.goal, next };
  }
}

/** `graphyard up`'s flags. */
export function upRequestFromArgs(args: string[]): UpRequest {
  const { values } = parseArgs({ args, options: { repo: { type: 'string' }, provider: { type: 'string' }, agent: { type: 'boolean' }, json: { type: 'boolean' }, reviewer: { type: 'string' }, master: { type: 'string' }, goal: { type: 'string' }, 'browser-profile': { type: 'string' },
    'confirm-price': { type: 'string' }, 'max-monthly': { type: 'string' }, 'ssh-key': { type: 'string' }, 'ssh-host': { type: 'string' }, 'ssh-user': { type: 'string' } }, allowPositionals: false });
  if (!values.repo || !/^[\w.-]+\/[\w.-]+$/.test(values.repo)) throw new Error('Use graphyard up --repo OWNER/NAME [--provider compose|railway|hetzner] [--agent]');
  return { repository: values.repo, provider: values.provider ?? 'compose', agent: !!values.agent, reviewer: values.reviewer ?? 'claude', master: values.master ?? 'claude',
    goalFile: values.goal ?? null, browserProfile: values['browser-profile'] ?? null,
    install: { confirmPrice: values['confirm-price'] ?? null, maxMonthly: values['max-monthly'] ?? null, sshKey: values['ssh-key'] ?? null, sshHost: values['ssh-host'] ?? null, sshUser: values['ssh-user'] ?? null } };
}

/**
 * Agent mode's App step (AC-5): the installer's manifest page, driven in the master's browser
 * profile — register the App, then install it on the repository alone (GitHub preselects it from
 * `repository_ids[]`). A Confirm-access prompt is passed the way every master browser flow passes
 * it (passSudo: GitHub Mobile is triggered, on the passkey-first page too) and its two-digit code
 * is the one thing handed to a person, after which the drive carries on by itself.
 */
export function browserAppDriver(options: { page: BrowserPage; repository: string; ids: () => { owner: number; repository: number }; sleep: (ms: number) => Promise<void>; timeoutMs?: number; record?: string; onClose?: (outcome: DriveOutcome) => Promise<void> | void }) {
  const { page } = options;
  const owner = options.repository.split('/')[0];
  const awaitSudo = async (handoff: Handoff) => {
    // passSudo's flow names the closest master browser flow; its rerun advice is this command's.
    try {
      await passSudo(page, { flow: 'installation-accept', record: options.record ?? 'graphyard up', sleep: options.sleep, timeoutMs: options.timeoutMs ?? 600_000,
        onCode: state => handoff(state.code ? `Approve the GitHub Mobile prompt on your phone and choose ${state.code}` : 'Confirm access to GitHub on your device (GitHub Mobile or your passkey)', { url: page.url(), code: state.code }) });
    } catch (error: any) { throw new Error(String(error?.message ?? error).replace(/rerun master browser installation-accept/g, 'rerun graphyard up --agent')); }
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
    try {
      page.open(url);
      const register = page.locate('button', 'Register Graphyard App →') ?? page.locate('button', 'Register reviewer App →');
      if (register) { page.click(register.selector); page.wait(2_000); await press('button', `Create GitHub App for ${owner}`, handoff); }
      page.open(url);
      const install = page.locate('link', 'Install GitHub App');
      if (install?.href) {
        const ids = options.ids();
        page.open(`${install.href}/permissions?suggested_target_id=${ids.owner}&repository_ids[]=${ids.repository}`);
        await press('button', 'Install', handoff);
      }
      outcome = { state: 'done' };
    } catch (error: any) { outcome = { state: 'failed', reason: String(error?.message ?? error).split('\n')[0] }; }
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
export function recordedAppDriver(root: string, request: UpRequest, browser: { profile: string; executable?: string }, page: (session: string) => BrowserPage = session => agentBrowserPage(browser, session)) {
  const startedAt = new Date(), id = randomUUID();
  const directory = resolve(actionsDirectory(root), `${startedAt.toISOString().replace(/[:.]/g, '-')}-app-create-${id.slice(0, 8)}`);
  const steps: RecordedStep[] = [];
  const session = `graphyard-up-${request.repository.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`;
  let created = false;
  const recorded = recordingPage(page(session), { directory, steps, now: () => new Date() });
  const drive = browserAppDriver({
    page: { ...recorded, open: url => { if (!created) { created = true; mkdirSync(directory, { recursive: true, mode: 0o700 }); } return recorded.open(url); } },
    repository: request.repository, record: relative(root, directory), sleep: ms => new Promise(accept => setTimeout(accept, ms)),
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

/** A one-time dashboard sign-in address minted with the operator's admin credential in FILE (as `graphyard login` mints it). */
export async function mintSignIn(server: string, file: string | null, fetcher: typeof fetch = fetch): Promise<string | null> {
  if (!file) return null;
  let token: string;
  try { token = (await readFile(file, 'utf8')).trim(); } catch { return null; }
  if (token.length < 32) return null;
  const response = await fetcher(`${server.replace(/\/+$/, '')}/api/sign-in-links`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: '{}', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) return null;
  const link = await response.json() as { code?: string };
  return typeof link.code === 'string' ? `${server.replace(/\/+$/, '')}/#sign-in=${link.code}` : null;
}

/** What `init --scan --apply` writes and the manual flow commits (docs/setup-from-zero.md, step 6). */
export const onboardingFiles = ['AGENTS.md', '.gitignore', 'graphyard.json', '.github/workflows'] as const;
export const onboardingBranch = 'graphyard/onboarding';

/**
 * Publish the onboarding files as one commit on the base branch's tip, on `graphyard/onboarding`,
 * and a pull request for it. The commit is built in a scratch index, so the operator's checkout,
 * branch and staged changes are untouched. Rerun, it reuses the open pull request; when the base
 * branch already holds exactly these files, nothing is published.
 */
export async function publishOnboarding(root: string, repository: string, run: (program: string, args: string[], env?: Record<string, string>) => string): Promise<{ pullRequest: string } | null> {
  const open = run('gh', ['pr', 'list', '--repo', repository, '--head', onboardingBranch, '--state', 'open', '--json', 'url', '--jq', '.[0].url // ""']).trim();
  if (open) return { pullRequest: open };
  const base = run('gh', ['repo', 'view', repository, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']).trim();
  run('git', ['fetch', '--quiet', 'origin', base]);
  const baseCommit = run('git', ['rev-parse', 'FETCH_HEAD']).trim();
  const index = resolve(root, '.graphyard', `onboarding-index.${process.pid}`);
  await mkdir(dirname(index), { recursive: true });
  try {
    const env = { GIT_INDEX_FILE: index };
    run('git', ['read-tree', baseCommit], env);
    const present = onboardingFiles.filter(file => existsSync(resolve(root, file)));
    if (present.length) run('git', ['add', '--', ...present], env);
    const tree = run('git', ['write-tree'], env).trim();
    if (tree === run('git', ['rev-parse', `${baseCommit}^{tree}`]).trim()) return null;
    const commit = run('git', ['commit-tree', tree, '-p', baseCommit, '-m', 'Add Graphyard onboarding: coordination instructions, configuration and delivery workflows'], env).trim();
    // The branch is this command's own: an earlier, interrupted publish is replaced, never merged into.
    run('git', ['push', '--force', 'origin', `${commit}:refs/heads/${onboardingBranch}`]);
  } finally { await rm(index, { force: true }); }
  const created = run('gh', ['pr', 'create', '--repo', repository, '--base', base, '--head', onboardingBranch, '--title', 'Add Graphyard onboarding',
    '--body', `The files graphyard up wrote while onboarding this repository: ${onboardingFiles.join(', ')}. Merging it puts Graphyard's delivery workflows on ${base}.`]).trim();
  return { pullRequest: created.split('\n').filter(Boolean).pop()! };
}

/** The real dependencies: this CLI's own commands as children, the master identity's status read. */
export function upDependencies(root: string, cliPath: string, request: UpRequest, emit: (event: UpEvent) => void): UpDependencies {
  const serverUrl = async () => { try { return String(JSON.parse(await readFile(resolve(root, '.graphyard/master.json'), 'utf8')).url ?? '') || null; } catch { return null; } };
  const masterToken = async () => { const url = await serverUrl(); return url ? (await masterCredential(root, url))?.token ?? null : null; };
  const browser = request.agent ? upBrowserProfile(root, request) : null;
  return {
    root, emit, serverUrl, masterToken,
    publishOnboarding: () => publishOnboarding(root, request.repository, (program, args, env) => execFileSync(program, args, { cwd: root, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env: { ...process.env, ...env } } : {}) })),
    onboardingMerged: async url => execFileSync('gh', ['pr', 'view', url, '--json', 'state', '--jq', '.state'], { encoding: 'utf8', timeout: 60_000 }).trim() === 'MERGED',
    signIn: async file => { const url = await serverUrl(); return url ? mintSignIn(url, file) : null; },
    sleep: ms => new Promise(accept => setTimeout(accept, ms)), now: () => Date.now(),
    cli: (args, options = {}) => new Promise((accept, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], ...(options.env ? { env: { ...process.env, ...options.env } } : {}) });
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
    ...(browser ? { driveApp: (url: string, handoff: Handoff) => recordedAppDriver(root, request, browser).drive(url, handoff) } : {}),
  };
}

/** One line a person reads for an event, as the interactive run prints it. */
export function describeUpEvent(event: UpEvent) {
  if (event.kind === 'step') return event.state === 'start' ? `→ ${event.step}` : `${event.state === 'done' ? '✓' : '·'} ${event.step}${event.detail ? `: ${event.detail}` : ''}`;
  if (event.kind === 'waiting') return `\n${event.sentence}\n`;
  if (event.kind === 'handoff') return `NEEDS YOU: ${event.sentence}${event.code ? ` (code ${event.code})` : ''}${event.url ? ` — ${event.url}` : ''}`;
  return event.text;
}
