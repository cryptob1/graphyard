// Concern: `graphyard watch`'s worker supervision — the systemd scope a session runs in, process-tree
// signalling, lease renewal through control-plane restarts, consent-prompt probing and surrender.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { clearConsentHold, consentHoldSuffix, consentHoldVerdict, detectConsentPrompt, readConsentHolds, reclassifyConsentHold, writeConsentHold, type ConsentAnswer } from './consent-prompt.js';
import { unknownWorkCode } from './model/refusal.js';
import { herdrCall } from './master/herdr.js';

interface Renewal { lease: { epoch: number; expiresAt: string } | null; updatedAt: string }

export interface Containment {
  command: string;
  args: string[];
  /** The systemd scope unit the session runs in, named in a failure to verify it empty. */
  unit?: string;
  signal: (signal: NodeJS.Signals) => void;
  empty: () => boolean;
}

export function systemdContainment(command: string, args: string[], run: typeof execFileSync = execFileSync): Containment {
  run('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
  const unit = `graphyard-watch-${process.pid}-${randomUUID()}.scope`;
  return {
    command: 'systemd-run', unit,
    args: ['--user', '--scope', '--quiet', `--unit=${unit}`, '--', command, ...args],
    signal: signal => { run('systemctl', ['--user', 'kill', '--kill-whom=all', `--signal=${signal}`, unit], { stdio: 'ignore' }); },
    empty: () => {
      const query = ['--user', 'show', '--property=LoadState', '--property=ActiveState', unit];
      const unloaded = (output: unknown) => String(output ?? '').split(/\r?\n/).some(line => line.trim() === 'LoadState=not-found');
      try {
        const properties = String(run('systemctl', query, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
        if (unloaded(properties)) return true;
        const state = properties.split(/\r?\n/).find(line => line.startsWith('ActiveState='))?.slice('ActiveState='.length);
        return state === 'inactive' || state === 'failed';
      } catch (error) {
        // A transient scope may be unloaded between process exit and verification.
        // Only systemd's structured LoadState can turn a failed query into success;
        // transport, manager and all other query failures remain unverifiable.
        if (unloaded((error as { stdout?: unknown }).stdout)) return true;
        throw error;
      }
    },
  };
}

export type ProcessRecord = { ppid: number; identity: string };

export function captureTrackedRoot(rootPid: number, supervisedPids: Map<number, string>, root: ProcessRecord | null) {
  if (root) supervisedPids.set(rootPid, root.identity);
}

export function linuxProcessRecord(stat: string): ProcessRecord | null {
  const end = stat.lastIndexOf(') ');
  if (end < 0) return null;
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  const ppid = Number(fields[1]), starttime = fields[19];
  return Number.isSafeInteger(ppid) && ppid >= 0 && /^\d+$/.test(starttime ?? '') ? { ppid, identity: starttime } : null;
}

function processTable(): Map<number, ProcessRecord> {
  const records = new Map<number, ProcessRecord>();
  if (process.platform !== 'linux') return records;
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const record = linuxProcessRecord(readFileSync(`/proc/${name}/stat`, 'utf8'));
        if (record) records.set(Number(name), record);
      } catch {}
    }
  } catch {}
  return records;
}

function processRecord(pid: number): ProcessRecord | null {
  try { return linuxProcessRecord(readFileSync(`/proc/${pid}/stat`, 'utf8')); }
  catch { return null; }
}

export function signalTrackedProcesses(rootPid: number, supervisedPids: Map<number, string>, rows: Map<number, ProcessRecord>, signal: NodeJS.Signals, kill: (pid: number, signal: NodeJS.Signals) => void = process.kill) {
  const pending = [...supervisedPids.keys()];
  while (pending.length) {
    const parent = pending.shift()!;
    if (rows.get(parent)?.identity !== supervisedPids.get(parent)) {
      supervisedPids.delete(parent);
      continue;
    }
    for (const [pid, record] of rows) if (record.ppid === parent && !supervisedPids.has(pid)) {
      supervisedPids.set(pid, record.identity); pending.push(pid);
    }
  }
  for (const [pid, identity] of [...supervisedPids].reverse()) {
    if (rows.get(pid)?.identity !== identity) { supervisedPids.delete(pid); continue; }
    try { kill(pid, signal); } catch {}
  }
}

/**
 * What a supervisor watches besides its lease: the session it was launched in.
 *
 * A supervisor exists to run one agent under one lease. When the agent is gone the supervisor has
 * nothing left to supervise, and a heartbeat it keeps sending is worse than no heartbeat at all —
 * it keeps the item owned by a worker that cannot act, so nothing lapses and no replacement is
 * dispatched. `visible` reports Herdr's view of this session and `surrender` ends the attempt on
 * the record before the supervisor exits.
 */
export interface SupervisedSession {
  /** Herdr's view of this session: `true` still reported, `false` gone, `null` not observable. */
  visible?: () => boolean | null;
  /** Records the cause on the assignment and releases the lease. */
  surrender?: (cause: string) => Promise<void>;
  /** Why the session's slot must be given back because it never took its request, or null (GY-130, consentHoldProbe). */
  unconsented?: () => string | null;
}

/** How long a delivered request may take to be visibly accepted, inside the probe's own 10-second command bound. */
export const consentRequestAcceptMs = 8_000;
/**
 * The launcher's consent hold on this supervisor's session (GY-130): the record it leaves beside
 * the launch files in the worktree when the runtime stopped on a first-run prompt outside its
 * allow-list. While the prompt is on the pane's screen the session has not read its request; a
 * prompt a human answered clears the hold, and one still showing past the hold's `releaseAt`
 * answers the cause the supervisor surrenders the assignment for instead of renewing it again. A
 * runtime without a request contract, whose request is pasted after it starts, is sent it here
 * once its prompt clears (the hold's `request`). A different dialog that replaces the held one is
 * a new prompt: the hold is rewritten for it with a fresh bound, and one on the launcher's
 * allow-list is answered once with its least-privilege option, as the launcher would have. A
 * session Herdr has not taken the name of (the hold's `named: false`) is renamed on every check
 * until Herdr reports it under that name, and its hold is never cleared before: the master finds a
 * worker only by its profile's agent name, and would otherwise count the profile free and the held
 * worker's supervisor orphaned.
 */
export function consentHoldProbe(checkout: string = process.cwd(), env: NodeJS.ProcessEnv = process.env, run: (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => string = (command, args, options) => String(execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, ...(options?.env ? { env: options.env } : {}) })), now: () => number = Date.now): () => string | null {
  return () => {
    const hold = readConsentHolds(checkout)[0];
    if (!hold) return null;
    const pane = env.HERDR_PANE_ID ?? hold.pane;
    let named = hold.named !== false;
    if (!named) {
      try {
        herdrCall(run, ['agent', 'rename', pane, hold.agentName]);
        const parsed = JSON.parse(herdrCall(run, ['agent', 'get', pane])), agent = (parsed?.result ?? parsed)?.agent ?? (parsed?.result ?? parsed);
        named = agent?.name === hold.agentName;
      } catch { named = false; }
      if (named) {
        const { path: _path, named: _named, ...kept } = hold;
        writeConsentHold(hold.path.slice(0, -consentHoldSuffix.length), kept);
      }
    }
    let screen: string | null = null;
    try { screen = herdrCall(run, ['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', '40']); } catch { screen = null; }
    const verdict = consentHoldVerdict(hold, screen, now());
    if (verdict === 'changed') {
      const prompt = detectConsentPrompt(screen)!, stem = hold.path.slice(0, -consentHoldSuffix.length);
      let answer: ConsentAnswer | undefined;
      if (prompt.rule && prompt.keys) {
        try {
          herdrCall(run, ['pane', 'send-keys', pane, ...prompt.keys]);
          answer = { rule: prompt.rule.id, kind: prompt.kind, prompt: prompt.text, answer: prompt.rule.answer, keys: prompt.keys, at: new Date(now()).toISOString() };
        } catch { /* unanswered, it stays held for a human */ }
      }
      writeConsentHold(stem, { ...reclassifyConsentHold(hold, prompt, now(), answer), ...(named ? { named: undefined } : {}) });
      return null;
    }
    if (verdict === 'cleared') {
      // Unnamed, the session stays held — the request undelivered — until a rename takes, and past
      // the bound gives the slot back rather than run where the master cannot see it.
      if (!named) return now() >= Date.parse(hold.releaseAt) ? `its session never took its request: the ${hold.kind} consent prompt was answered, but Herdr did not take the session's name ${hold.agentName} by the hold bound (${hold.releaseAt})` : null;
      // A runtime prompted after it starts was never sent its request while the dialog was up: it
      // is delivered now, and the hold stays until the runtime visibly accepts it, so a failed
      // delivery is tried again on the next check and, past the bound, gives the slot back.
      if (hold.request) {
        try {
          herdrCall(run, ['agent', 'prompt', pane, readFileSync(hold.request, 'utf8'), '--wait', '--until', 'working', '--until', 'blocked', '--timeout', String(consentRequestAcceptMs)]);
        } catch (error) {
          return now() >= Date.parse(hold.releaseAt) ? `its session never took its request: the ${hold.kind} consent prompt was answered, but the request could not be delivered by the hold bound (${hold.releaseAt}): ${error instanceof Error ? error.message.split('\n')[0].slice(0, 200) : String(error)}` : null;
        }
      }
      clearConsentHold(hold.path);
    }
    return verdict === 'release' ? `its session never took its request: it waited on a ${hold.kind} consent prompt outside the launcher's allow-list from ${hold.since} past the hold bound (${hold.releaseAt}) — "${hold.prompt}"` : null;
  };
}

const processAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string }).code === 'EPERM'; } };

/**
 * Whether Herdr still reports the pane this supervisor was launched in.
 *
 * Herdr puts the pane id in the session's own environment, so the identity is exact rather than
 * inferred from a working directory an agent may leave. A query that fails answers `null`: an
 * unreachable Herdr is a signal that could not be collected, never an absence.
 */
export function herdrSessionProbe(env: NodeJS.ProcessEnv = process.env, run: (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => string = (command, args, options) => String(execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, ...(options?.env ? { env: options.env } : {}) }))): () => boolean | null {
  const pane = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== '1' || !pane) return () => null;
  return () => {
    try {
      const parsed = JSON.parse(herdrCall(run, ['agent', 'list']));
      const agents = (parsed?.result ?? parsed)?.agents;
      return Array.isArray(agents) ? agents.some((agent: { pane_id?: string }) => agent?.pane_id === pane) : null;
    } catch { return null; }
  };
}

async function postAssignment(url: string, token: string, path: string, body: unknown) {
  const response = await fetch(`${url.replace(/\/+$/, '')}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  // The status rides on the error, so a refusal (a 409 after `complete`) is final and a deploy's 5xx is retried (GY-1506).
  if (!response.ok) throw Object.assign(new Error(`${path} refused: ${text.slice(0, 200)}`), { status: response.status, confirmedRefusal: response.status < 500 && ![408, 429].includes(response.status) });
}

/**
 * The worker protocol a supervisor follows when its session is gone: release the lease with the
 * cause, in one lease-authorised mutation.
 *
 * The cause rides on the release and is kept on its event, so the ledger still says why the
 * attempt ended early, and the attempt ends as released rather than as a silent lapse. It is not
 * a blocked report: a blocked report ends the attempt and stands on the item (GY-1008), which
 * would leave the freed item waiting for somebody to clear a condition that is already over.
 *
 * The assignment comes from this supervisor's own `watch KEY EPOCH --` command line and its
 * credential from its own environment, so no caller has to supply either; a supervisor that can
 * read neither surrenders nothing and simply stops.
 */
export function assignmentSurrender(epoch: number, argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env, post = postAssignment) {
  const assignment = watchAssignment(argv);
  const url = env.GRAPHYARD_URL, token = env.GRAPHYARD_TOKEN;
  if (!assignment || Number(assignment.epoch) !== epoch || !url || !token) return undefined;
  return async (cause: string) => {
    const body = { epoch, cause: `Watch supervisor ended attempt ${epoch}: ${cause}`.slice(0, 2000) };
    await throughRestart(() => post(url, token, `work/${assignment.key}/release`, body), performance.now() + controlPlaneRestartWindowMs);
  };
}

/** How long before the lease's own expiry a supervisor stops retrying a failed renewal (GY-274). */
export const renewalSafetyMarginMs = 15_000;
/**
 * Whether a failed renewal is the server's definite answer rather than a transient failure: a
 * renewal that came back for another epoch, or the 409 Conflict every epoch, lease and ownership
 * refusal carries. A network error, a timeout, a 5xx, a 408 or 429, or a proxy's page during a
 * deploy is transient, and the lease that is still running is what decides whether the worker
 * stops. So is any other 4xx (GY-392): a 401 or 403 from an expired or rotated token, or a 404
 * from a mis-routed proxy, says nothing about the lease, so the worker keeps it until it lapses.
 * The one 404 that is definite is the server's own refusal of an item it does not have (GY-448),
 * which carries `unknownWorkCode` in its body: that item has no lease left to keep.
 * An error that carries no status falls back to the client's own classification of the refusal.
 */
export function definiteRenewalRefusal(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const { confirmedRefusal, status, definite } = error as { confirmedRefusal?: unknown; status?: unknown; definite?: unknown };
  if (definite === true) return true;
  if (status === 404) return confirmedRefusal === true && refusalCode(error) === unknownWorkCode;
  if (typeof status === 'number') return status === 409;
  return confirmedRefusal === true;
}

/** The `code` a refused response carried, read from the error the client threw with the body as its message. */
function refusalCode(error: object) {
  const body = (error as { body?: unknown }).body;
  if (body && typeof body === 'object') return (body as { code?: unknown }).code;
  if (!(error instanceof Error)) return undefined;
  try { return JSON.parse(error.message)?.code; } catch { return undefined; }
}

/**
 * How long the server keeps a lease after a renewal it failed server-side (GY-558): it recorded the
 * failure and answered 503 with `renewalFault` (`graceUntil`, and its own `now`), so the lease stays
 * valid for that remainder and the supervisor keeps retrying through it. Null for any other failure.
 */
export function renewalGraceMs(error: unknown): number | null {
  let grace = (error as { renewalFault?: { graceUntil?: string; now?: string } } | null)?.renewalFault;
  if (!grace && error instanceof Error) { try { grace = JSON.parse(error.message)?.renewalFault; } catch { return null; } }
  const ms = Date.parse(grace?.graceUntil ?? '') - Date.parse(grace?.now ?? '');
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * How long a supervisor keeps retrying a control-plane call it cannot do without — the item
 * lookup and the first renewal — through a
 * transient failure (GY-1506). A deploy restarts the server for about a minute, answering 502s,
 * dropped connections and "Startup validation has not completed; retry shortly"; three tries
 * 100 ms apart gave up inside it, the worker never launched and its lease lapsed as a loss.
 */
export const controlPlaneRestartWindowMs = 90_000;
/**
 * Whether a failed control-plane call is the restart a retry outlasts (GY-1506): a 5xx, 408 or 429,
 * a 4xx without the server's own error body (a proxy's page), or a call that never got an answer —
 * fetch's TypeError for a refused or dropped connection ("fetch failed", "terminated"), a timeout,
 * or a body that was not the server's JSON. The server's own refusal, the 409 every lease refusal
 * carries, a definite failure, or any other error is final.
 */
export function transientControlPlaneFailure(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const { confirmedRefusal, definite, status } = error as { confirmedRefusal?: unknown; definite?: unknown; status?: unknown };
  if (definite === true || confirmedRefusal === true) return false;
  if (typeof status === 'number') return status !== 409 && status >= 400;
  return error instanceof TypeError || error instanceof SyntaxError || ['TimeoutError', 'AbortError'].includes((error as Error).name);
}
/**
 * Run one control-plane call, retrying a transient failure with backoff until `until` (a
 * `performance.now()` deadline) passes (GY-1506). Any other failure is thrown at once; the last
 * transient one is thrown once the window closes.
 */
export async function throughRestart<T>(call: () => Promise<T>, until: number, options: { retryMs?: number; retryMaxMs?: number } = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await call(); }
    catch (error) {
      const wait = Math.min((options.retryMs ?? 1000) * 2 ** attempt, options.retryMaxMs ?? 10_000, until - performance.now());
      if (!transientControlPlaneFailure(error) || wait <= 0) throw error;
      console.error(`Graphyard control plane is unavailable (${(error instanceof Error ? error.message : String(error)).slice(0, 300)}); retrying in ${Math.round(wait)} ms.`);
      await delay(wait);
    }
  }
}
type ControlPlaneApi = (path: string, data?: unknown, requestId?: string) => Promise<any>;
/**
 * The CLI's `api` with each call retried through a control-plane restart until `until()` (GY-1506).
 * A call keeps one idempotency key across its retries, so a mutation the server applied before the
 * connection dropped is answered from its receipt rather than applied twice.
 */
export function restartTolerantApi(api: ControlPlaneApi, until: () => number, options: { retryMs?: number; retryMaxMs?: number } = {}): ControlPlaneApi {
  return (path, data, requestId = process.env.GRAPHYARD_REQUEST_ID ?? randomUUID()) => throughRestart(() => api(path, data, requestId), until(), options);
}

/**
 * The one line `watch` (src/cli/workspace.ts) prints before its first control-plane call, naming the
 * item and epoch from its argv; the launcher quotes it as the starting detail of a supervisor still
 * setting up (GY-1033). \`supervise\` itself never prints it: it lives here, beside the supervisor the
 * line announces, only so tests can import it without loading the CLI command table.
 */
export const setupLine = (subject: string, epoch: number) => `graphyard: starting supervision of ${subject} epoch ${epoch}`;
// The deadline uses elapsed local time and server-reported duration, not synchronized clocks.
export async function supervise(command: string, args: string[], epoch: number, renew: () => Promise<Renewal>, options: { intervalMs?: number; graceMs?: number; safetyMarginMs?: number; retryMs?: number; retryMaxMs?: number; startupWindowMs?: number; attemptBoundMs?: number; detached?: boolean; containment?: Containment; platform?: NodeJS.Platform; session?: SupervisedSession;
  /** GY-2971: an agent that exits within this many ms of its spawn leaves the lease to its launcher, which relaunches the same attempt fresh. */ earlyExitKeepsLeaseMs?: number } = {}) {
  let deadline = 0, granted = 0, attempts = 0;
  /** One renewal attempt, sequenced: a beat the supervisor already gave up on never moves the deadline. */
  const heartbeatAttempt = () => {
    const seq = ++attempts;
    return (async () => {
      const started = performance.now();
      const result = await renew();
      if (seq !== attempts) throw Object.assign(new Error('Superseded lease renewal'), { superseded: true });
      const duration = Date.parse(result.lease?.expiresAt ?? '') - Date.parse(result.updatedAt);
      if (result.lease?.epoch !== epoch || !Number.isFinite(duration) || duration <= 0) throw Object.assign(new Error('Invalid lease renewal'), { definite: true });
      deadline = started + duration; granted = duration;
      if (deadline <= performance.now()) throw Object.assign(new Error('Lease expired during renewal'), { definite: true });
    })();
  };
  // The margin never exceeds a quarter of the lease the server granted, so a short lease still
  // gets its renewals; at the production 120 s lease it is the full 15 s.
  const margin = () => Math.min(options.safetyMarginMs ?? renewalSafetyMarginMs, granted / 4);
  const retryMs = options.retryMs ?? 1000, retryMaxMs = options.retryMaxMs ?? 10_000;
  /** A renewal the plane did not answer within the attempt's bound (GY-1791): retried afresh, never an answer. */
  const unanswered = () => Object.assign(new Error('Lease renewal went unanswered past its attempt bound'), { name: 'TimeoutError', unanswered: true });
  /**
   * One renewal, retried with backoff while the lease still has more than the safety margin left
   * (GY-274). A deploy restarts the server for about a minute and its first reconcile used to hold
   * the pool; the lease is 120 s precisely so that a worker survives that. Returns 'renewed', or
   * 'refused' on the server's definite answer, or 'lapsing' when the retry window closed; a
   * lapsing lease is left to the expiry timer, which stops the worker only once it has expired.
   * Between retries the session is checked for orphaning as the interval tick would (GY-392), so
   * a supervisor whose worker is gone during an outage surrenders at once rather than after the
   * whole backoff.
   *
   * Each attempt is bounded (GY-1791): a request the plane never answers — a black-holed deploy, a
   * stalled plane — used to hold this loop for the whole client timeout (two minutes, the lease
   * itself), so one hung request consumed every chance the lease had left and a plane that came
   * back with a minute of lease to spare still lost it. Now an attempt the plane has not answered
   * within `attemptBoundMs` (the safety margin by default: 15 s at the production lease) is given
   * up on — a response landing later is superseded and cannot move the deadline of an attempt that
   * was abandoned — and the retry sends a fresh request, which a recovered plane answers. What never
   * moves is the deadline: an unanswered request authorises nothing, so the worker still stops at
   * the expiry the server last issued, and only a renewal the server actually answered extends it
   * (a worker whose own network path alone is down must not outlive the lease the server expired).
   */
  async function renewWithRetry(stopped: () => boolean, orphaned: () => string | null = () => null, extended: () => void = () => {}): Promise<'renewed' | 'refused' | 'lapsing' | 'stopped' | { orphaned: string }> {
    for (let attempt = 0; ; attempt++) {
      // Inside the safety margin nothing more is attempted: the lease is left to expire on its own.
      if (attempt === 0 && deadline - margin() <= performance.now()) return 'lapsing';
      const started = performance.now();
      // The attempt waits no longer than its bound, and never past the window; the losing timer is
      // cleared whichever side settles the race, so a renewed lease retains no timer until its expiry.
      // An infinite bound awaits the request however long it hangs (the base's wiring, for its reproduction).
      const attemptBound = options.attemptBoundMs ?? margin();
      const bound = Math.max(1, Math.min(attemptBound, deadline - margin() - started));
      let unansweredTimer: ReturnType<typeof setTimeout> | undefined;
      const beat = heartbeatAttempt(); beat.catch(() => { /* the race below answers this attempt; an abandoned one is superseded */ });
      try {
        await (Number.isFinite(attemptBound) ? Promise.race([beat, new Promise<never>((_, reject) => { unansweredTimer = setTimeout(() => reject(unanswered()), bound); })]) : beat);
        return 'renewed';
      }
      catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 300) : String(error);
        if (definiteRenewalRefusal(error)) { console.error(`Graphyard refused the lease renewal: ${reason}`); return 'refused'; }
        // The bound closed on a request that never answered: the in-flight beat is superseded, so a
        // response landing now cannot move the deadline of an attempt that was given up on.
        if ((error as { unanswered?: boolean }).unanswered === true) attempts++;
        // A server-side failure the server recorded keeps the lease for its grace (GY-558): the
        // deadline moves out to it, measured from when this attempt was sent, and retries go on.
        const grace = renewalGraceMs(error);
        if (grace !== null && started + grace > deadline) {
          deadline = started + grace; extended();
          console.error(`Graphyard recorded the failed renewal server-side; the lease is kept for ${Math.round(grace / 1000)}s more while renewal is retried.`);
        }
        const window = deadline - margin() - performance.now();
        const wait = Math.min(retryMs * 2 ** attempt, retryMaxMs, window);
        if (wait <= 0) {
          console.error(`Graphyard lease renewal is still failing (${reason}); retries stop ${Math.round(margin())} ms before the lease expires and the worker stops only if the lease actually expires.`);
          return 'lapsing';
        }
        console.error(`Graphyard lease renewal failed transiently (${reason}); retrying in ${Math.round(wait)} ms with ${Math.round((deadline - performance.now()) / 1000)}s of lease left.`);
        await delay(wait);
        if (stopped()) return 'stopped';
        const cause = orphaned();
        if (cause) return { orphaned: cause };
      } finally { clearTimeout(unansweredTimer); }
    }
  }
  // The first renewal has no lease of its own to measure a retry window by, so it rides out a
  // control-plane restart for the restart window instead (GY-1506); a definite refusal still stops it.
  await throughRestart(heartbeatAttempt, performance.now() + (options.startupWindowMs ?? controlPlaneRestartWindowMs), { retryMs, retryMaxMs });
  const env = { ...process.env };
  for (const key of ['GRAPHYARD_PRINCIPALS', 'DATABASE_URL', 'GITHUB_PRIVATE_KEY', 'GITHUB_PRIVATE_KEY_FILE', 'GITHUB_WEBHOOK_SECRET']) delete env[key];
  const platform = options.platform ?? process.platform;
  const detached = options.detached ?? platform !== 'win32';
  if (!detached && platform !== 'linux' && !options.containment) throw new Error(`Foreground worker supervision requires durable containment and is not supported on ${platform}`);
  const containment = options.containment ?? (!detached && platform === 'linux' ? systemdContainment(command, args) : undefined);
  const sessionVisible = options.session?.visible ?? herdrSessionProbe();
  const surrender = options.session?.surrender ?? assignmentSurrender(epoch);
  const unconsented = options.session?.unconsented ?? consentHoldProbe();
  return new Promise<number>((resolve, reject) => {
    let child: ReturnType<typeof spawn> | undefined;
    let stopping = false, pending = false, prelaunchInterrupted = false, finished = false;
    let sessionSeen = false, scopeSeen = false;
    const supervisedPids = new Map<number, string>();
    let expiry: ReturnType<typeof setTimeout>;
    let timer: ReturnType<typeof setInterval>;
    // The release of an attempt whose agent ended on its own, which the supervisor finishes before it exits.
    let ending: Promise<void> | undefined;
    const finish = (error: unknown, code?: number) => {
      if (finished) return;
      finished = true;
      process.off('SIGTERM', interrupted); process.off('SIGINT', interrupted); process.off('SIGHUP', interrupted);
      void Promise.resolve(ending).then(() => { if (error) reject(error); else resolve(code!); });
    };
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child?.pid) return;
      if (containment) {
        try { containment.signal(signal); return; }
        catch { /* fall back to the process group */ }
      }
      if (detached && platform !== 'win32') { try { process.kill(-child.pid, signal); } catch {} return; }
      if (platform === 'win32') { try { child.kill(signal); } catch {} return; }
      const rows = processTable();
      signalTrackedProcesses(child.pid, supervisedPids, rows, signal);
    };
    const interrupted = (signal: NodeJS.Signals) => {
      if (!child) { prelaunchInterrupted = true; return; }
      endedOnItsOwn(`the supervisor received ${signal}`);
      stop(1);
    };
    function stop(code: number) {
      if (stopping) return;
      stopping = true; clearInterval(timer); clearTimeout(expiry);
      signalGroup('SIGTERM');
      // Keep this timer referenced even if the group leader exits first.
      setTimeout(async () => {
        signalGroup('SIGKILL');
        finish(null, code);
      }, options.graceMs ?? 5000);
    }
    const armDeadline = () => { clearTimeout(expiry); expiry = setTimeout(() => stop(1), Math.max(0, deadline - performance.now())); };
    /**
     * Why there is nothing left to supervise, or null while the agent is still there.
     *
     * The child's own exit event is the ordinary path; this is the check that does not depend on
     * it, because a supervisor that never receives it is exactly the failure this answers. An
     * absence counts only once presence was observed: a scope that has not activated yet, or a
     * session Herdr has not registered yet, must never read as a session that has ended.
     */
    const orphaned = (): string | null => {
      if (!child?.pid) return null;
      if (!processAlive(child.pid)) return `the agent process (pid ${child.pid}) has exited`;
      if (containment) {
        let empty: boolean | null = null;
        try { empty = containment.empty(); } catch { empty = null; }
        if (empty === false) scopeSeen = true;
        else if (empty === true && scopeSeen) return 'the worker containment scope holds no process, so the agent has exited';
      }
      const visible = sessionVisible();
      if (visible === true) sessionSeen = true;
      else if (visible === false && sessionSeen) return 'Herdr no longer reports this agent session';
      // A session still held on a consent prompt past its bound holds a slot it never used: the
      // lease is not renewed for it again, the assignment is released, and the item is dispatchable.
      return unconsented();
    };
    // The lease outlives several of these checks, so an orphaned supervisor is found, surrenders
    // its assignment and stops well inside one lease period.
    const surrenderAssignment = async (cause: string) => {
      if (!surrender) return;
      try { await surrender(cause); }
      catch (error) { console.error(`Graphyard could not release the lease after the worker session ended: ${error instanceof Error ? error.message : String(error)}`); }
    };
    /**
     * An agent that exited, or a supervisor told to stop, before the lease said so (GY-1506): the
     * attempt is over, so its lease is released with the cause rather than left to lapse into a
     * lease loss two minutes later. A supervisor already stopping — on a refused or lapsed lease,
     * or an orphaned session it surrendered — has nothing left to release. After `complete` the
     * release is refused, harmlessly: the lease it would end is already gone.
     */
    function endedOnItsOwn(cause: string) {
      if (stopping || ending) return;
      ending = surrenderAssignment(cause);
    }
    process.on('SIGTERM', interrupted); process.on('SIGINT', interrupted); process.on('SIGHUP', interrupted);
    void (async () => {
      try {
        if (prelaunchInterrupted) { finish(null, 1); return; }
        child = spawn(containment?.command ?? command, containment?.args ?? args, { stdio: 'inherit', detached, env });
        // Never learn the fallback root from a later /proc snapshot: after this
        // child exits its numeric PID can identify an unrelated replacement.
        // Cache the kernel identity immediately after spawn, or leave fallback
        // traversal empty when the short-lived launcher is already gone.
        if (containment && !detached && platform === 'linux' && child.pid) {
          captureTrackedRoot(child.pid, supervisedPids, processRecord(child.pid));
        }
        child.on('error', error => { console.error(error.message); stop(1); });
        const spawnedAt = performance.now(), releases = () => performance.now() - spawnedAt >= (options.earlyExitKeepsLeaseMs ?? 0);
        child.on('exit', (code, signal) => { if (releases()) endedOnItsOwn(`the agent process exited (${signal ?? `code ${code}`}) while its lease was live`); stop(code ?? 1); });
        timer = setInterval(async () => {
          if (pending || stopping) return;
          pending = true;
          const surrenderOrphaned = async (cause: string) => {
            clearInterval(timer);
            const release = releases();
            console.error(`Graphyard worker supervision has nothing left to supervise: ${cause}. ${release ? 'Releasing the lease and stopping' : 'Leaving the lease to its launcher and stopping'}.`);
            if (release) await surrenderAssignment(cause);
            stop(1);
          };
          try {
            const cause = orphaned();
            if (cause) { await surrenderOrphaned(cause); return; }
            const renewal = await renewWithRetry(() => stopping, orphaned, () => { if (!stopping) armDeadline(); });
            if (typeof renewal === 'object') await surrenderOrphaned(renewal.orphaned);
            else if (renewal === 'renewed') { if (!stopping) armDeadline(); }
            else if (renewal === 'refused') { console.error('Graphyard lease cannot be renewed. Stopping worker.'); stop(1); }
          }
          catch { console.error('Graphyard lease cannot be renewed. Stopping worker.'); stop(1); }
          finally { pending = false; }
        }, options.intervalMs ?? 25_000);
        armDeadline();
      } catch (error) { finish(error); }
    })();
  });
}

/**
 * The assignment a supervisor names in its own command line: `watch KEY EPOCH -- command`.
 *
 * It demands the exact invocation shape rather than a loose match: an ordinary command that
 * happens to carry a `watch` argument is never taken for a supervisor.
 */
export function watchAssignment(argv: string[]): { key: string; epoch: string } | null {
  const index = argv.indexOf('watch');
  if (index < 0) return null;
  const [key, epoch, separator] = argv.slice(index + 1, index + 4);
  return /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(key ?? '') && /^\d+$/.test(epoch ?? '') && separator === '--' ? { key, epoch } : null;
}
