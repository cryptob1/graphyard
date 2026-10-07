import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checklistGreen, goalWorkItem, setupChecklist, type SetupItem, type SetupItemId } from './model/setup-checklist.js';
import { agentBrowserPage, detectSudo, type BrowserPage } from './master-browser.js';
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
 * to turn green. With --agent, every step has a non-interactive path (the App manifest is driven
 * through the master's browser profile, accounts come from login homes already on the host, the
 * goal from a file) and only a step that needs a person's own device or identity — a GitHub Mobile
 * or passkey approval, a subscription login's browser approval — is handed off, as one sentence
 * plus a link or code; the run resumes on its own once it completes.
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
  /** The Chrome profile signed in to GitHub that drives the App manifest in agent mode. */
  browserProfile: string | null;
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
  cli(args: string[], options?: { stdin?: string; onLine?: (line: string) => void }): Promise<{ code: number; stdout: string }>;
  /** The control plane's /api/status as the recorded master identity, or null while none answers. */
  status(): Promise<any | null>;
  /** The control plane's address once the install recorded it. */
  serverUrl(): Promise<string | null>;
  /** The master credential the install recorded for that control plane (.graphyard/master.json). */
  masterToken(): Promise<string | null>;
  emit(event: UpEvent): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Agent mode: drive the App manifest page at URL in the master's browser profile. */
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

interface UpState { version: 1; repository: string; provider: string; completed: UpStep[]; noHerdr: boolean; goal: string | null }
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

export async function runUp(request: UpRequest, deps: UpDependencies): Promise<UpResult> {
  const state = await readState(deps.root, request);
  const pollMs = deps.pollMs ?? 5_000;
  const humanWaitMs = deps.humanWaitMs ?? (request.agent ? 3_600_000 : Infinity);
  const machineWaitMs = deps.machineWaitMs ?? 600_000;
  let setupUrl: string | null = null, prompts = 0, last: SetupItem[] = setupChecklist(null);
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
  const resolveSetupUrl = async () => { const url = await deps.serverUrl(); if (url) setupUrl = `${url.replace(/\/$/, '')}/#setup`; return setupUrl; };
  const complete = async (step: UpStep, detail?: string) => {
    if (!state.completed.includes(step)) state.completed.push(step);
    await writeState(deps.root, state);
    deps.emit({ kind: 'step', step, state: 'done', ...(detail ? { detail } : {}) });
  };
  /** The interactive wait: the Setup address printed once for the whole run, then a poll until IDS are green. */
  const announce = async (ids: SetupItemId[]) => {
    if (prompts > 0 || request.agent) return;
    const url = await resolveSetupUrl();
    if (!url) return;
    prompts++;
    deps.emit({ kind: 'waiting', setupUrl: url, waitingFor: ids, sentence: `Open ${url} and follow the checklist; this command carries on as each step turns green.` });
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
  const run = async (step: UpStep, args: string[], options: { stdin?: string; onLine?: (line: string) => void } = {}) => {
    const result = await deps.cli(args, options);
    if (result.code !== 0) throw new UpStop(`${step}: graphyard ${args[0]}${args[1] && !args[1].startsWith('-') ? ` ${args[1]}` : ''} exited ${result.code}${result.stdout.trim() ? `: ${result.stdout.trim().split('\n').slice(-1)[0].slice(0, 400)}` : ''}`, upExitCodes.failed);
    return result.stdout;
  };
  const installArgs = (mode: '--plan' | '--apply') => ['install', '--provider', request.provider, '--repo', request.repository, '--reviewer', request.reviewer, mode, ...(state.noHerdr ? ['--no-herdr'] : [])];
  const step = async (name: UpStep, body: () => Promise<string | void>) => {
    if (state.completed.includes(name)) { deps.emit({ kind: 'step', step: name, state: 'skipped', detail: 'done by an earlier run' }); return; }
    deps.emit({ kind: 'step', step: name, state: 'start' });
    const detail = await body();
    await complete(name, detail || undefined);
  };

  try {
    await step('preflight', async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const plan = parseJson(await run('preflight', installArgs('--plan')));
        const failed: { name: string; detail?: string; fix?: string }[] = (plan?.preflight ?? []).filter((check: any) => check && check.ok === false);
        // A Herdr plugin bound to another server keeps that server (GY-1413): up never passes --herdr-rebind.
        if (failed.some(check => check.name === 'Herdr plugin') && !state.noHerdr) {
          state.noHerdr = true; await writeState(deps.root, state);
          deps.emit({ kind: 'note', text: 'Herdr\'s graphyard plugin is bound to another server; it is left as it is (--no-herdr). Workers start from the CLI.' });
          continue;
        }
        if (failed.length) throw new UpStop(`Preflight needs a person on this machine: ${failed.map(check => `${check.name}: ${check.detail ?? 'failed'}${check.fix ? ` (fix: ${check.fix})` : ''}`).join('; ')}. Fix it, then rerun graphyard up.`, upExitCodes.prerequisite);
        return `${(plan?.preflight ?? []).length} checks passed`;
      }
      throw new UpStop('Preflight did not settle after leaving Herdr untouched', upExitCodes.failed);
    });

    await step('control-plane', async () => {
      // The install waits on the App pages itself; it pauses (exit 1) after 900 s and a rerun resumes it.
      const deadline = deps.now() + humanWaitMs;
      for (;;) {
        let drive: Promise<DriveOutcome> | null = null;
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
          if (!url || !request.agent) return;
          if (!deps.driveApp) { handoff('control-plane')('Create the GitHub App in a browser signed in to GitHub, then install it on the repository only.', { url }); return; }
          drive = deps.driveApp(url, handoff('control-plane'));
        } }).finally(() => { running = false; });
        await watcher;
        const outcome = await (drive as Promise<DriveOutcome> | null);
        if (outcome?.state === 'failed') deps.emit({ kind: 'note', text: `The browser could not finish the App page (${outcome.reason}); finish it by hand` });
        if (result.code === 0) return 'control plane installed with its GitHub Apps';
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
      return 'delivery workflow proposed and applied';
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
    if (request.goalFile) {
      await step('goal', async () => {
        const item = goalWorkItem(await readFile(resolve(deps.root, request.goalFile!), 'utf8'));
        const file = resolve(deps.root, '.graphyard/up-goal.json');
        await writeFile(file, `${JSON.stringify(item, null, 2)}\n`, { mode: 0o600 });
        const created = parseJson(await run('goal', ['master', 'create', file, 'Goal submitted by graphyard up']));
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
  const { values } = parseArgs({ args, options: { repo: { type: 'string' }, provider: { type: 'string' }, agent: { type: 'boolean' }, json: { type: 'boolean' }, reviewer: { type: 'string' }, master: { type: 'string' }, goal: { type: 'string' }, 'browser-profile': { type: 'string' } }, allowPositionals: false });
  if (!values.repo || !/^[\w.-]+\/[\w.-]+$/.test(values.repo)) throw new Error('Use graphyard up --repo OWNER/NAME [--provider compose|railway|hetzner] [--agent]');
  return { repository: values.repo, provider: values.provider ?? 'compose', agent: !!values.agent, reviewer: values.reviewer ?? 'claude', master: values.master ?? 'claude',
    goalFile: values.goal ?? null, browserProfile: values['browser-profile'] ?? null };
}

/**
 * Agent mode's App step (AC-5): the installer's manifest page, driven in the master's browser
 * profile — register the App, then install it on the repository alone (GitHub preselects it from
 * `repository_ids[]`). A Confirm-access prompt is the one thing handed to a person: its GitHub
 * Mobile code, after which the drive carries on by itself.
 */
export function browserAppDriver(options: { page: BrowserPage; repository: string; ids: () => { owner: number; repository: number }; sleep: (ms: number) => Promise<void>; timeoutMs?: number }) {
  const { page } = options;
  const owner = options.repository.split('/')[0];
  const awaitSudo = async (handoff: Handoff) => {
    const deadline = Date.now() + (options.timeoutMs ?? 600_000);
    for (let sudo = detectSudo(page.url(), page.text()); sudo.sudo; sudo = detectSudo(page.url(), page.text())) {
      handoff(sudo.code ? `Approve the GitHub Mobile prompt on your phone and choose ${sudo.code}` : 'Confirm access to GitHub on your device (GitHub Mobile or your passkey)', { url: page.url(), code: sudo.code });
      if (Date.now() >= deadline) throw new Error('Confirm access was not approved in time');
      await options.sleep(3_000);
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
      return { state: 'done' };
    } catch (error: any) { return { state: 'failed', reason: String(error?.message ?? error).split('\n')[0] }; }
    finally { page.close(); }
  };
}

/** The real dependencies: this CLI's own commands as children, the master identity's status read. */
export function upDependencies(root: string, cliPath: string, request: UpRequest, emit: (event: UpEvent) => void): UpDependencies {
  const serverUrl = async () => { try { return String(JSON.parse(await readFile(resolve(root, '.graphyard/master.json'), 'utf8')).url ?? '') || null; } catch { return null; } };
  const masterToken = async () => { const url = await serverUrl(); return url ? (await masterCredential(root, url))?.token ?? null : null; };
  return {
    root, emit, serverUrl, masterToken,
    sleep: ms => new Promise(accept => setTimeout(accept, ms)), now: () => Date.now(),
    cli: (args, options = {}) => new Promise((accept, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
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
    ...(request.agent && request.browserProfile ? { driveApp: browserAppDriver({
      page: agentBrowserPage({ profile: request.browserProfile }, 'graphyard-up'), repository: request.repository, sleep: ms => new Promise(accept => setTimeout(accept, ms)),
      ids: () => {
        const repo = JSON.parse(execFileSync('gh', ['api', `repos/${request.repository}`], { encoding: 'utf8', timeout: 30_000 }));
        return { owner: Number(repo.owner?.id), repository: Number(repo.id) };
      },
    }) } : {}),
  };
}

/** One line a person reads for an event, as the interactive run prints it. */
export function describeUpEvent(event: UpEvent) {
  if (event.kind === 'step') return event.state === 'start' ? `→ ${event.step}` : `${event.state === 'done' ? '✓' : '·'} ${event.step}${event.detail ? `: ${event.detail}` : ''}`;
  if (event.kind === 'waiting') return `\n${event.sentence}\n`;
  if (event.kind === 'handoff') return `NEEDS YOU: ${event.sentence}${event.code ? ` (code ${event.code})` : ''}${event.url ? ` — ${event.url}` : ''}`;
  return event.text;
}
