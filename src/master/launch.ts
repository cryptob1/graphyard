// Concern: launching an agent session — request files, start observation, prompt delivery and acknowledgement.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type ChildRun, childRunner, defaultChildRun } from '../child-runner.js';
import { assertSessionName, SessionNameRefusedError } from '../session-name.js';
import { requestPlaceholder, type RegisteredLaunch, assertLaunchable, LaunchRefusedError, nonInteractiveLaunch } from '../harness.js';
import { withAutonomyContract } from '../autonomy.js';
import type { PartialWork } from '../model/capacity.js';
import { type ConsentPrompt, detectConsentPrompt, settingsWarning, type ConsentAnswer, sameConsentPrompt } from '../consent-prompt.js';
import type { MasterRun } from './profiles.js';
import { type HerdrAgent, herdrJson, herdrRun, stopCreatedHerdrTab } from './herdr.js';

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
export const launchRequestContracts: Record<string, (reference: string) => string> = {
  claude: reference => reference, codex: reference => reference, cursor: reference => reference, opencode: reference => `--prompt ${reference}`,
  pi: reference => reference, muse: reference => reference, gemini: reference => `--prompt-interactive ${reference}`, qwen: reference => `--prompt-interactive ${reference}`, copilot: reference => `--interactive ${reference}`,
};
/** How a runtime loads the launch authorization from a file; only Claude Code, which leaves AGENTS.md out under a role file, needs one. */
export const launchRoleContracts: Record<string, (reference: string) => string> = { claude: reference => `--append-system-prompt-file ${reference}` };
export type RequestDelivery = 'request' | 'paste';
export const launchDelivery = (kind: string | undefined, args: string[] = []): RequestDelivery => kind && (launchRequestContracts[kind] || args.includes(requestPlaceholder)) ? 'request' : 'paste';
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
/** The command line typed into the pane: the stem binding, then `prefix` (a supervisor), the runtime, its arguments and the file references. */
export function launchCommand(kind: string, args: string[], files: LaunchFiles, prefix: string[] = []) {
  const role = files.role ? launchRoleContracts[kind]?.(roleReference) : undefined;
  const own = launchRequestContracts[kind];
  const request = files.request && own ? own(requestReference) : undefined;
  // A registry runtime's request goes where its contract places `{request}`; a built-in one drops the marker.
  const placed = args.map(argument => argument !== requestPlaceholder ? shellWord(argument) : files.request && !own ? requestReference : null).filter((word): word is string => word !== null);
  const binding = role || request || placed.includes(requestReference) ? [`${launchVariable}=${shellWord(files.stem)};`] : [];
  const runtime = [...prefix.map(shellWord), kind, ...placed, ...(role ? [role] : []), ...(request ? [request] : [])].join(' ');
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
/**
 * The runtime's own screen, per kind: its banner, its status line, or its spinner at the start of a
 * line (Claude Code's `∙ ✻ ✶ ✳ ✢` over the request it is working on). Nothing here matches the
 * echoed launch command — lowercase runtime names, no spaces inside `bypassPermissions` — or a
 * shell prompt, whose `❯` some shells draw at the start of a line too.
 */
export const runtimeScreens: Record<string, RegExp> = {
  claude: /Claude Code|Welcome to Claude|esc to interrupt|bypass permissions on|shift\+tab to cycle|for shortcuts|^\s*[∙✻✶✳✢]/m,
  codex: /\bCodex\b|esc to interrupt/, cursor: /\bCursor\b/, opencode: /\bOpenCode\b/, gemini: /\bGemini\b/,
};
export type StartState = 'ready' | 'starting' | 'absent' | 'blocked' | 'consent';
export interface StartObservation { state: StartState; agent: HerdrAgent | null; detail: string; line: string; prompt?: ConsentPrompt }
export interface StartBounds { timeoutMs?: number; ceilingMs?: number; pollMs?: number; clock?: () => number; /** The pause between polls; a test's advances a virtual clock, the process's awaits a timer. */ wait?: (ms: number) => void | Promise<void>; /** The states that count as ready; `startedStates` unless the runtime is still to be prompted. */ readyStates?: string[];
  /** Whether a session stopped on a consent prompt the launcher does not answer is held for a human (a worker, whose supervisor bounds the hold) rather than refused. */ holdConsent?: boolean;
  /** Where the start's duration is logged (GY-413); standard error unless a caller collects it. */ log?: (line: string) => void }
export class SessionStartError extends Error {
  constructor(readonly startCase: 'never started' | 'still starting' | 'blocked' | 'awaiting consent', readonly pane: string, readonly screen: string, readonly waitedMs: number, message: string) { super(message); }
}
/**
 * How many times the launcher answers one allow-listed prompt before it treats the prompt as one it
 * cannot answer, and how long an answered dialog is given to close before it is answered again — a
 * second keystroke into a dialog that was already closing would land in the runtime's input.
 */
export const consentAnswerAttempts = 2, consentSettleMs = 5_000;
/** The pane's terminal as text, unwrapped; null when Herdr cannot read it. */
export async function readPaneScreen(pane: string, run: ChildRun = defaultChildRun, lines = 40) {
  try { return String(await run('herdr', ['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', String(lines)])); } catch { return null; }
}
/** The pane's last non-empty line, bounded for a record. */
export function paneLastLine(text: string | null, limit = paneLineLimit) {
  const line = (text ?? '').split('\n').map(entry => entry.replace(/\s+/g, ' ').trim()).filter(Boolean).at(-1) ?? '';
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}
/** Whether the pane's last line is the launch command itself — typed, or still being typed — and not yet answered: it opens with the stem binding and names the runtime. */
export const commandEchoing = (line: string, command: string) => !!line && (line.includes(command.slice(0, 24)) || (line.includes(`${launchVariable}=`) && line.includes(` ${command.replace(/^GY=\S+; /, '').split(' ')[0]}`)));
export async function observeStart(pane: string, kind: string, command: string, run?: ChildRun, readyStates = startedStates): Promise<StartObservation> {
  let agent: HerdrAgent | null = null;
  try { const raw = await herdrJson(['agent', 'get', pane], run); agent = raw?.agent ?? raw ?? null; } catch { agent = null; }
  // A runtime Herdr sees `working` is at work on its request. Any other state is read off the
  // screen too: a runtime stopped on a first-run consent prompt is `idle` to Herdr, just as a
  // started one is, and has not read its request (GY-130).
  if (agent?.agent === kind && agent.agent_status === 'working' && readyStates.includes('working')) return { state: 'ready', agent, detail: `Herdr reports the ${kind} runtime working`, line: '' };
  const screen = await readPaneScreen(pane, run), last = paneLastLine(screen, Infinity), line = paneLastLine(screen);
  const prompt = detectConsentPrompt(screen);
  if (prompt) return { state: 'consent', agent, detail: `the ${kind} runtime is awaiting consent on a ${prompt.kind} prompt`, line, prompt };
  // A runtime stopped on its own settings warning has not started either, whatever Herdr reports,
  // and is refused at once with the rules it named rather than the dialog's key hint.
  const warning = settingsWarning(screen);
  if (warning) return { state: 'blocked', agent, detail: warning, line };
  // An unread pane rules nothing out: an idle runtime may be sitting on a consent prompt, so it is
  // polled again until a read shows its screen, never taken as ready without one.
  if (screen === null && agent?.agent === kind && readyStates.includes(agent.agent_status ?? '')) return { state: 'starting', agent, detail: `Herdr reports the ${kind} runtime ${agent.agent_status} but its pane could not be read, so a consent prompt is not ruled out`, line };
  if (agent?.agent === kind && readyStates.includes(agent.agent_status ?? '')) return { state: 'ready', agent, detail: `Herdr reports the ${kind} runtime ${agent.agent_status}`, line: '' };
  const showing = screen !== null && !!runtimeScreens[kind]?.test(screen);
  if (agent?.agent === kind && agent.agent_status === 'blocked') return { state: 'blocked', agent, detail: 'Herdr reports it blocked', line };
  // Herdr sees the runtime's process and its screen is showing: a session at work that Herdr has
  // not classified yet, adopted rather than closed — unless it is still to be prompted, when only
  // Herdr's idle counts.
  if (agent?.agent === kind && showing && readyStates.includes('working')) return { state: 'ready', agent, detail: `the ${kind} runtime is on screen while Herdr reports it ${agent.agent_status ?? 'unknown'}`, line };
  if (agent?.agent === kind) return { state: 'starting', agent, detail: `the ${kind} runtime process exists under the pane, Herdr reports it ${agent.agent_status ?? 'unknown'}${showing ? ', its screen showing' : ''}`, line };
  if (showing) return { state: 'starting', agent: null, detail: `the ${kind} banner is on screen`, line };
  return { state: 'absent', agent: null, line, detail: commandEchoing(last, command) ? 'command still echoing' : agent?.agent ? `the pane holds ${agent.agent}, not ${kind}` : 'no runtime under the pane' };
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
      const why = rule ? `the launcher answered it ${consentAnswerAttempts} times and it is still showing` : `it is outside the launcher's consent allow-list`;
      // A session held for a human is reported, not refused: it has not taken its request, and it
      // is never counted as started. Everything else refuses the launch with the prompt's own text.
      if (bounds.holdConsent) return { ...observed, waitedMs, extended, consent, awaiting: { prompt: prompt.text, kind: prompt.kind, why } };
      throw new SessionStartError('awaiting consent', pane, prompt.text, waitedMs, `the ${kind} runtime is awaiting consent in pane ${pane} on a ${prompt.kind} prompt, and ${why}: "${prompt.text}"`);
    }
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
  /** Called once the command line is in the pane: from then on a supervisor may be running there (GY-273). */ onRun?: () => void;
  /** The pane's working directory, where the runtime starts (`directory` unless the tab opened elsewhere), and the environment its tab carries: what the runtime's `trust` step records the folder in. */ cwd?: string; environment?: Record<string, string> }
export async function startAgentSession(name: string, kind: string, pane: string, args: string[], text: string, run: ChildRun | undefined, options: SessionStart) {
  assertSessionName(name, options.retry);
  // A runtime Graphyard cannot start without its own approval prompts is refused here, before
  // anything is typed, rather than launched into a session that waits for a keypress (GY-184).
  // A registry runtime's own launch contract is its recipe when it registers one.
  assertLaunchable(kind, options.contract);
  const delivery = launchDelivery(kind, args);
  if (delivery !== 'request') throw new LaunchRefusedError(kind, requestContractRefusal(kind));
  // A runtime whose trust prompt no flag suppresses has its working directory recorded as trusted
  // first, or the launch is refused naming it (GY-184): nothing is typed into a session that would wait.
  const trust = await nonInteractiveLaunch[kind]?.trust?.(options.cwd ?? options.directory, options.environment ?? {}, args);
  // Every session carries the autonomy contract: in its role file when the runtime loads one,
  // otherwise at the start of its first request (GY-184).
  const carried = withAutonomyContract(!!launchRoleContracts[kind], { request: text, role: options.role });
  text = carried.request;
  const files = writeLaunchFiles(options.directory, name, { role: carried.role, request: text });
  const command = launchCommand(kind, args, files, options.prefix);
  await herdrRun(['pane', 'run', pane, command], run);
  options.onRun?.();
  const log = options.log ?? (line => process.stderr.write(`${line}\n`));
  let started: Awaited<ReturnType<typeof awaitRuntimeStart>>;
  try { started = await awaitRuntimeStart(pane, kind, command, run, { ...options, readyStates: startedStates }); }
  catch (error) {
    if (error instanceof SessionStartError) log(`graphyard: ${name} (${kind}) in pane ${pane}: start failed after ${(error.waitedMs / 1000).toFixed(1)} s (${error.startCase}; bound ${Math.round((options.timeoutMs ?? agentStartTimeoutMs) / 1000)} s)`);
    throw error;
  }
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
  // The request is already the runtime's own first argument, so nothing waits to be pasted: a
  // session held on a consent dialog reads it once the dialog is answered.
  return { delivery, command, files, trust: trust ?? null, consent: started.consent, awaiting: started.awaiting ? { ...started.awaiting, request: null as string | null, named } : undefined,
    started: { state: started.awaiting ? 'awaiting consent' as const : 'started' as const, detail: started.detail, waitedMs: started.waitedMs, extended: started.extended } };
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
 * Prompt delivery the runtime visibly accepted. Herdr submits the prompt and reports whether the
 * agent left its idle state for it; a runtime that reported ready before its input was (OpenCode
 * does, while its UI loads) drops the text and stays idle, which Herdr answers as a stalled prompt.
 * A stalled prompt is delivered again after a pause; one still refused after every attempt fails
 * the launch, whose caller closes the session and launches afresh. Anything else Herdr refuses
 * fails at once. Since GY-93 this is the path for a runtime without a request contract, for the
 * loop's one re-prompt of a session that has not taken up its request, and for the reviewer's
 * retry to post a verdict it already judged.
 */
export const promptAttempts = 3, promptAcceptMs = 20_000, promptRetryPauseMs = 3_000;
export class PromptNotAcceptedError extends Error { readonly promptDropped = true; }
export function herdrErrorCode(error: unknown) {
  const text = [(error as any)?.herdrCode, (error as any)?.stdout, (error as any)?.stderr, (error as any)?.message].filter(value => value !== undefined && value !== null).map(String).join('\n');
  return (error as any)?.herdrCode ?? /"code"\s*:\s*"([a-z_]+)"/.exec(text)?.[1] ?? null;
}
/** Everything a Herdr failure said, whichever stream it said it on. */
export function herdrErrorText(error: unknown) {
  return [(error as any)?.stdout, (error as any)?.stderr, error instanceof Error ? error.message : error].filter(value => value !== undefined && value !== null && value !== '').map(String).join('\n');
}
/** A runtime refusing the name it was given, rather than failing to start the session it names. */
export function nameRefusedByRuntime(error: unknown) {
  return /\b(?:agent|session) name\b|\binvalid (?:agent |session )?name\b/i.test(herdrErrorText(error));
}
export interface PromptDelivery { attempts?: number; acceptMs?: number; pauseMs?: number }
export async function deliverPrompt(target: string, text: string, run?: ChildRun, options: PromptDelivery & { confirm?: 'inline' | 'follow' } = {}) {
  const attempts = options.attempts ?? promptAttempts, acceptMs = options.acceptMs ?? promptAcceptMs, pauseMs = options.pauseMs ?? promptRetryPauseMs;
  const accepted = ['--until', 'working', '--until', 'blocked', '--timeout', String(acceptMs)];
  const stalls: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // Herdr takes options only after the prompt text; 'follow' submits it and then waits for the
      // agent to leave idle, which is the same confirmation for a caller whose text must come last.
      if (options.confirm === 'follow') { await herdrJson(['agent', 'prompt', target, text], run); await herdrJson(['agent', 'wait', target, ...accepted], run); }
      else await herdrJson(['agent', 'prompt', target, text, '--wait', ...accepted], run);
      return { attempts: attempt, accepted: true as const };
    } catch (error) {
      const code = herdrErrorCode(error);
      if (code !== 'agent_prompt_stalled' && code !== 'timeout') throw error;
      stalls.push(code);
      // The pause is awaited on the event loop: nothing else in the process waits with it.
      if (attempt < attempts) await sleep(pauseMs);
    }
  }
  throw new PromptNotAcceptedError(`${target} did not visibly accept its prompt after ${attempts} deliveries (${stalls.join(', ')}); the session is closed and relaunched rather than left idle`);
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
/** The session's terminal, as text; null when Herdr cannot read it. */
export async function readSessionScreen(target: string, run: ChildRun = defaultChildRun, lines = 80): Promise<string | null> {
  try { return String(await run('herdr', ['agent', 'read', target, '--source', 'recent-unwrapped', '--lines', String(lines)])); } catch { return null; }
}
/** How a session's screen is read when the judgement needs it: a stub in a test, one Herdr read in the process. */
export type ScreenReader = () => string | null | Promise<string | null>;
const screenDecoration = /^[\s─━═╌┄┈│┃╭╮╰╯┌┐└┘├┤=_*·•-]*$|^[❯⏵✻✶✳✢·]|bypass permissions on|shift\+tab to cycle|for shortcuts|esc to interrupt|\? for help/;
/** The session's own last words: the tail of its screen without the runtime's frame, bounded for a ledger record. */
export function sessionWords(text: string | null, limit = 400) {
  const lines = (text ?? '').split('\n').map(line => line.trim()).filter(line => line && !screenDecoration.test(line));
  const words = lines.slice(-8).join(' ').replace(/\s+/g, ' ').trim();
  return words.length > limit ? `…${words.slice(-limit)}` : words;
}
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
