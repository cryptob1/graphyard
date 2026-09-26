import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { clearConsentHold, consentHoldSuffix, consentHoldVerdict, detectConsentPrompt, readConsentHolds, reclassifyConsentHold, writeConsentHold, type ConsentAnswer } from './consent-prompt.js';

interface Renewal { lease: { epoch: number; expiresAt: string } | null; updatedAt: string }

export interface Containment {
  command: string;
  args: string[];
  signal: (signal: NodeJS.Signals) => void;
  empty: () => boolean;
}

export function systemdContainment(command: string, args: string[], run: typeof execFileSync = execFileSync): Containment {
  run('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
  const unit = `graphyard-watch-${process.pid}-${randomUUID()}.scope`;
  return {
    command: 'systemd-run',
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
export function consentHoldProbe(checkout: string = process.cwd(), env: NodeJS.ProcessEnv = process.env, run: (command: string, args: string[]) => string = (command, args) => String(execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 })), now: () => number = Date.now): () => string | null {
  return () => {
    const hold = readConsentHolds(checkout)[0];
    if (!hold) return null;
    const pane = env.HERDR_PANE_ID ?? hold.pane;
    let named = hold.named !== false;
    if (!named) {
      try {
        run('herdr', ['agent', 'rename', pane, hold.agentName]);
        const parsed = JSON.parse(run('herdr', ['agent', 'get', pane])), agent = (parsed?.result ?? parsed)?.agent ?? (parsed?.result ?? parsed);
        named = agent?.name === hold.agentName;
      } catch { named = false; }
      if (named) {
        const { path: _path, named: _named, ...kept } = hold;
        writeConsentHold(hold.path.slice(0, -consentHoldSuffix.length), kept);
      }
    }
    let screen: string | null = null;
    try { screen = run('herdr', ['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', '40']); } catch { screen = null; }
    const verdict = consentHoldVerdict(hold, screen, now());
    if (verdict === 'changed') {
      const prompt = detectConsentPrompt(screen)!, stem = hold.path.slice(0, -consentHoldSuffix.length);
      let answer: ConsentAnswer | undefined;
      if (prompt.rule && prompt.keys) {
        try {
          run('herdr', ['pane', 'send-keys', pane, ...prompt.keys]);
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
          run('herdr', ['agent', 'prompt', pane, readFileSync(hold.request, 'utf8'), '--wait', '--until', 'working', '--until', 'blocked', '--timeout', String(consentRequestAcceptMs)]);
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
export function herdrSessionProbe(env: NodeJS.ProcessEnv = process.env, run: (command: string, args: string[]) => string = (command, args) => String(execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }))): () => boolean | null {
  const pane = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== '1' || !pane) return () => null;
  return () => {
    try {
      const parsed = JSON.parse(run('herdr', ['agent', 'list']));
      const agents = (parsed?.result ?? parsed)?.agents;
      return Array.isArray(agents) ? agents.some((agent: { pane_id?: string }) => agent?.pane_id === pane) : null;
    } catch { return null; }
  };
}

async function postAssignment(url: string, token: string, path: string, body: unknown) {
  const response = await fetch(`${url.replace(/\/+$/, '')}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} refused: ${text.slice(0, 200)}`);
}

/**
 * The worker protocol a supervisor follows when its session is gone: record the cause on the
 * assignment, withdraw that report, then release the lease.
 *
 * The blocked report is the one free-text entry a worker writes to the append-only ledger, and
 * the one Graphyard already reads back as the explanation for an attempt that ended early, so it
 * is where the cause belongs. It is withdrawn in the same breath because a standing blocker would
 * leave the freed item waiting for somebody to clear a condition that is already over: the event
 * keeps the cause, and the release ends the attempt as released rather than as a silent lapse.
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
    const reason = `Watch supervisor ended attempt ${epoch}: ${cause}`.slice(0, 2000);
    await post(url, token, `work/${assignment.key}/blocked`, { epoch, reason });
    await post(url, token, `work/${assignment.key}/blocked`, { epoch, reason: null });
    await post(url, token, `work/${assignment.key}/release`, { epoch });
  };
}

/** How long before the lease's own expiry a supervisor stops retrying a failed renewal (GY-274). */
export const renewalSafetyMarginMs = 15_000;
/**
 * Whether a failed renewal is the server's definite answer rather than a transient failure: a 4xx
 * refusal naming the epoch, the lease or its ownership, or a renewal that came back for another
 * epoch. A network error, a timeout, a 5xx, a 408 or 429, or a proxy's page during a deploy is
 * transient, and the lease that is still running is what decides whether the worker stops.
 */
export function definiteRenewalRefusal(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const { confirmedRefusal, status, definite } = error as { confirmedRefusal?: unknown; status?: unknown; definite?: unknown };
  if (confirmedRefusal === true || definite === true) return true;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
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

// The deadline uses elapsed local time and server-reported duration, not synchronized clocks.
export async function supervise(command: string, args: string[], epoch: number, renew: () => Promise<Renewal>, options: { intervalMs?: number; graceMs?: number; shutdownPollMs?: number; shutdownTimeoutMs?: number; safetyMarginMs?: number; retryMs?: number; retryMaxMs?: number; detached?: boolean; containment?: Containment; platform?: NodeJS.Platform; session?: SupervisedSession; quarantine?: { establish: () => Promise<unknown>; revalidate?: () => Promise<unknown>; acknowledge?: () => Promise<unknown>; settle: () => Promise<unknown> } } = {}) {
  let deadline = 0, granted = 0;
  async function heartbeat() {
    const started = performance.now();
    const result = await renew();
    const duration = Date.parse(result.lease?.expiresAt ?? '') - Date.parse(result.updatedAt);
    if (result.lease?.epoch !== epoch || !Number.isFinite(duration) || duration <= 0) throw Object.assign(new Error('Invalid lease renewal'), { definite: true });
    deadline = started + duration; granted = duration;
    if (deadline <= performance.now()) throw Object.assign(new Error('Lease expired during renewal'), { definite: true });
  }
  // The margin never exceeds a quarter of the lease the server granted, so a short lease still
  // gets its renewals; at the production 120 s lease it is the full 15 s.
  const margin = () => Math.min(options.safetyMarginMs ?? renewalSafetyMarginMs, granted / 4);
  const retryMs = options.retryMs ?? 1000, retryMaxMs = options.retryMaxMs ?? 10_000;
  /**
   * One renewal, retried with backoff while the lease still has more than the safety margin left
   * (GY-274). A deploy restarts the server for about a minute and its first reconcile used to hold
   * the pool; the lease is 120 s precisely so that a worker survives that. Returns 'renewed', or
   * 'refused' on the server's definite answer, or 'lapsing' when the retry window closed; a
   * lapsing lease is left to the expiry timer, which stops the worker only once it has expired.
   */
  async function renewWithRetry(stopped: () => boolean, extended: () => void = () => {}): Promise<'renewed' | 'refused' | 'lapsing' | 'stopped'> {
    for (let attempt = 0; ; attempt++) {
      // Inside the safety margin nothing more is attempted: the lease is left to expire on its own.
      if (attempt === 0 && deadline - margin() <= performance.now()) return 'lapsing';
      const started = performance.now();
      try { await heartbeat(); return 'renewed'; }
      catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 300) : String(error);
        if (definiteRenewalRefusal(error)) { console.error(`Graphyard refused the lease renewal: ${reason}`); return 'refused'; }
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
      }
    }
  }
  await heartbeat();
  const env = { ...process.env };
  for (const key of ['GRAPHYARD_PRINCIPALS', 'DATABASE_URL', 'GITHUB_PRIVATE_KEY', 'GITHUB_PRIVATE_KEY_FILE', 'GITHUB_WEBHOOK_SECRET']) delete env[key];
  const platform = options.platform ?? process.platform;
  const detached = options.detached ?? platform !== 'win32';
  if (!detached && platform !== 'linux' && !options.containment) throw new Error(`Foreground worker supervision requires durable containment and is not supported on ${platform}`);
  const containment = options.containment ?? (!detached && platform === 'linux' ? systemdContainment(command, args) : undefined);
  if (containment && !options.quarantine) throw new Error('Foreground worker supervision requires a durable Graphyard containment quarantine');
  const sessionVisible = options.session?.visible ?? herdrSessionProbe();
  const surrender = options.session?.surrender ?? assignmentSurrender(epoch);
  const unconsented = options.session?.unconsented ?? consentHoldProbe();
  return new Promise<number>((resolve, reject) => {
    let child: ReturnType<typeof spawn> | undefined;
    let stopping = false, pending = false, prelaunchInterrupted = false, finished = false;
    let sessionSeen = false, scopeSeen = false;
    const supervisedPids = new Map<number, string>();
    let containmentFailure: unknown;
    let expiry: ReturnType<typeof setTimeout>;
    let timer: ReturnType<typeof setInterval>;
    const finish = (error: unknown, code?: number) => {
      if (finished) return;
      finished = true;
      process.off('SIGTERM', interrupted); process.off('SIGINT', interrupted);
      if (error) reject(error); else resolve(code!);
    };
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child?.pid) return;
      if (containment) {
        try { containment.signal(signal); return; }
        catch (error) { containmentFailure ??= error; }
      }
      if (detached && platform !== 'win32') { try { process.kill(-child.pid, signal); } catch {} return; }
      if (platform === 'win32') { try { child.kill(signal); } catch {} return; }
      const rows = processTable();
      signalTrackedProcesses(child.pid, supervisedPids, rows, signal);
    };
    const interrupted = () => {
      if (!child) { prelaunchInterrupted = true; return; }
      stop(1);
    };
    function stop(code: number) {
      if (stopping) return;
      stopping = true; clearInterval(timer); clearTimeout(expiry);
      signalGroup('SIGTERM');
      // Keep this timer referenced even if the group leader exits first.
      setTimeout(async () => {
        signalGroup('SIGKILL');
        if (containment) {
          let empty = false, lastVerificationFailure: unknown;
          const shutdownDeadline = performance.now() + (options.shutdownTimeoutMs ?? 2000);
          do {
            try { if (containment.empty()) { empty = true; break; } }
            catch (error) { lastVerificationFailure = error; }
            const remaining = shutdownDeadline - performance.now();
            if (remaining <= 0) break;
            await delay(Math.min(options.shutdownPollMs ?? 50, remaining));
          } while (performance.now() < shutdownDeadline);
          containmentFailure ??= lastVerificationFailure;
          if (!empty) { finish(new Error(`Worker containment shutdown could not be verified${containmentFailure instanceof Error ? `: ${containmentFailure.message}` : ''}`)); return; }
          try { await options.quarantine!.settle(); }
          catch (error) { finish(new Error(`Worker containment shutdown was verified but its Graphyard quarantine could not be settled: ${error instanceof Error ? error.message : String(error)}`)); return; }
        }
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
    process.on('SIGTERM', interrupted); process.on('SIGINT', interrupted);
    void (async () => {
      try {
        if (containment) await options.quarantine!.establish();
        if (containment && options.quarantine!.revalidate) {
          try { await options.quarantine!.revalidate(); }
          catch (error) {
            if ((error as { settleAllowed?: boolean }).settleAllowed) {
              try { await options.quarantine!.settle(); }
              catch (settlementError) { throw new Error(`Fresh Graphyard state refused worker launch and its unlaunched quarantine could not be settled: ${settlementError instanceof Error ? settlementError.message : String(settlementError)}`); }
            }
            throw error;
          }
        }
        if (prelaunchInterrupted) {
          if (containment) {
            try { await options.quarantine!.settle(); }
            catch (error) { finish(new Error(`Worker launch was interrupted after its Graphyard quarantine was established, but the quarantine could not be settled: ${error instanceof Error ? error.message : String(error)}`)); return; }
          }
          finish(null, 1);
          return;
        }
        // Acknowledgement is durable launch authority. Rework cannot clear its
        // quarantine while this live lease (and response) may still reach us.
        if (containment && options.quarantine!.acknowledge) {
          await options.quarantine!.acknowledge();
        }
        if (prelaunchInterrupted) {
          if (containment) await options.quarantine!.settle();
          finish(null, 1); return;
        }
        child = spawn(containment?.command ?? command, containment?.args ?? args, { stdio: 'inherit', detached, env });
        // Never learn the fallback root from a later /proc snapshot: after this
        // child exits its numeric PID can identify an unrelated replacement.
        // Cache the kernel identity immediately after spawn, or leave fallback
        // traversal empty when the short-lived launcher is already gone.
        if (containment && !detached && platform === 'linux' && child.pid) {
          captureTrackedRoot(child.pid, supervisedPids, processRecord(child.pid));
        }
        child.on('error', error => { console.error(error.message); stop(1); });
        child.on('exit', code => stop(code ?? 1));
        timer = setInterval(async () => {
          if (pending || stopping) return;
          pending = true;
          try {
            const cause = orphaned();
            if (cause) {
              clearInterval(timer);
              console.error(`Graphyard worker supervision has nothing left to supervise: ${cause}. Releasing the lease and stopping.`);
              await surrenderAssignment(cause);
              stop(1);
              return;
            }
            const renewal = await renewWithRetry(() => stopping, () => { if (!stopping) armDeadline(); });
            if (renewal === 'renewed') { if (!stopping) armDeadline(); }
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

export interface SupervisorProbeTarget { key: string; epoch: number; workspacePath: string }
export interface SupervisorProbeDeps {
  platform?: NodeJS.Platform;
  uid?: number;
  listProcesses?: () => string[];
  readCommand?: (pid: number) => string;
  processOwner?: (pid: number) => number;
  readCwd?: (pid: number) => string;
  readParent?: (pid: number) => number;
  readCgroup?: (controlGroup: string) => string;
  resolvePath?: (path: string) => string;
  run?: (command: string, args: string[]) => string;
}

/**
 * The assignment a supervisor names in its own command line: `watch KEY EPOCH -- command`.
 *
 * This is only ever used to attribute a live process to a *different* assignment, so it
 * demands the exact invocation shape rather than a loose match: an ordinary command that
 * happens to carry a `watch` argument must never excuse a process from the fence.
 */
export function watchAssignment(argv: string[]): { key: string; epoch: string } | null {
  const index = argv.indexOf('watch');
  if (index < 0) return null;
  const [key, epoch, separator] = argv.slice(index + 1, index + 4);
  return /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(key ?? '') && /^\d+$/.test(epoch ?? '') && separator === '--' ? { key, epoch } : null;
}

const vanished = (error: unknown) => ['ENOENT', 'ESRCH'].includes((error as { code?: string }).code ?? '');
const detail = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 200);
export const scopePattern = /^graphyard-watch-[A-Za-z0-9:@._-]+\.scope$/;
const liveScope = ['active', 'activating', 'deactivating', 'reloading'];

/**
 * Observe, on the registered host, whether a contained worker is still running.
 *
 * This reports what it could see and what it could not: a signal it failed to collect is
 * never the same as an absence. Command lines identify a supervisor regardless of its
 * owner; working directories and containment scopes are readable only for the probing
 * user's own processes and user manager, which is the boundary local dispatch uses.
 */
export function probeSupervisorAbsence(target: SupervisorProbeTarget, deps: SupervisorProbeDeps = {}) {
  const platform = deps.platform ?? process.platform;
  const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid()! : 0);
  const processes: { pid: number; evidence: 'command' | 'workspace' }[] = [];
  const scopes: { unit: string; activeState: string; processes: number[]; attributed: number[] }[] = [];
  const unverifiable: string[] = [];
  let inaccessible = 0;
  const record = () => ({ method: 'linux-proc-systemd' as const, platform: String(platform), uid, workspacePath: target.workspacePath, processes, scopes, inaccessible, unverifiable });
  if (platform !== 'linux') {
    unverifiable.push(`Supervisor absence requires Linux process and systemd scope inspection; this host reports ${platform}`);
    return record();
  }
  const listProcesses = deps.listProcesses ?? (() => readdirSync('/proc'));
  const readCommand = deps.readCommand ?? ((pid: number) => readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
  const processOwner = deps.processOwner ?? ((pid: number) => statSync(`/proc/${pid}`).uid);
  const readCwd = deps.readCwd ?? ((pid: number) => readlinkSync(`/proc/${pid}/cwd`));
  // Parentage, like the command line, is world-readable, so ancestry can be followed
  // across owners; a supervisor's containment scope holds only its own descendants.
  const readParent = deps.readParent ?? ((pid: number) => {
    const status = linuxProcessRecord(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    if (!status) throw new Error(`Process ${pid} reported an unreadable status line`);
    return status.ppid;
  });
  const readCgroup = deps.readCgroup ?? ((controlGroup: string) => readFileSync(join('/sys/fs/cgroup', controlGroup, 'cgroup.procs'), 'utf8'));
  const run = deps.run ?? ((command: string, args: string[]) => String(execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 })));
  const resolvePath = deps.resolvePath ?? ((path: string) => { try { return realpathSync(path); } catch { return path; } });
  const workspace = resolvePath(target.workspacePath);
  // The kernel separates command-line arguments with NUL, and an argument may itself
  // contain spaces: only that boundary reconstructs the argv a supervisor was given.
  const commandArgv = (pid: number) => readCommand(pid).split('\0').filter(Boolean);
  // A working directory is readable for this user's ordinary processes and withheld for
  // privileged ones, so an unreadable answer is 'not inspectable', never 'not the worker'.
  const workspaceMember = (pid: number): 'inside' | 'outside' | 'gone' | 'unreadable' => {
    try { const cwd = readCwd(pid); return cwd === workspace || cwd.startsWith(`${workspace}/`) ? 'inside' : 'outside'; }
    catch (error) { return vanished(error) ? 'gone' : 'unreadable'; }
  };
  // Matching the fenced assignment blocks settlement, so it stays deliberately loose.
  const supervisesTarget = (argv: string[]) => argv.includes('watch') && argv.includes(target.key) && argv.includes(String(target.epoch));
  /**
   * Which assignment a live process belongs to, read from the supervisor it descends from.
   *
   * A contained worker is a descendant of the supervisor that created its scope, and both
   * parentage and command lines are readable for every process. Only reaching a supervisor
   * of a different work key or epoch attributes a process elsewhere: a broken chain, an
   * orphan reparented away from its dead supervisor, or a process this user cannot follow
   * is 'unresolved', which fences rather than excuses.
   */
  const assignmentOf = (pid: number): 'target' | 'other' | 'unresolved' => {
    const seen = new Set<number>();
    for (let current = pid; current > 1 && !seen.has(current); ) {
      seen.add(current);
      let argv: string[];
      try { argv = commandArgv(current); }
      catch { return 'unresolved'; }
      if (supervisesTarget(argv)) return 'target';
      const assignment = watchAssignment(argv);
      if (assignment) return assignment.key === target.key && assignment.epoch === String(target.epoch) ? 'target' : 'other';
      let parent: number;
      try { parent = readParent(current); }
      catch { return 'unresolved'; }
      if (!Number.isSafeInteger(parent) || parent <= 0) return 'unresolved';
      current = parent;
    }
    return 'unresolved';
  };
  let pids: number[] = [];
  try { pids = listProcesses().filter(name => /^\d+$/.test(name)).map(Number); }
  catch (error) { unverifiable.push(`Host process table could not be read: ${detail(error)}`); }
  for (const pid of pids) {
    let argv: string[];
    try { argv = commandArgv(pid); }
    catch (error) { if (!vanished(error)) unverifiable.push(`Command line of process ${pid} could not be read: ${detail(error)}`); continue; }
    // The supervisor is identified by its own command line, which every user can read.
    if (supervisesTarget(argv)) { processes.push({ pid, evidence: 'command' }); continue; }
    let owner: number;
    try { owner = processOwner(pid); }
    catch (error) { if (!vanished(error)) unverifiable.push(`Owner of process ${pid} could not be read: ${detail(error)}`); continue; }
    // Another user's descendants are outside this sweep; local dispatch runs the worker as
    // the coordinator's user, and the containment scope below covers the contained tree.
    if (owner !== uid) continue;
    const membership = workspaceMember(pid);
    if (membership === 'inside') processes.push({ pid, evidence: 'workspace' });
    if (membership === 'unreadable') inaccessible++;
  }
  try { run('systemctl', ['--user', 'show-environment']); }
  catch (error) {
    unverifiable.push(`systemd user manager is unavailable, so containment scopes cannot be queried: ${detail(error)}`);
    return record();
  }
  let units: string[] = [];
  try {
    units = [...new Set(run('systemctl', ['--user', 'list-units', '--all', '--plain', '--no-legend', '--type=scope', 'graphyard-watch-*.scope'])
      .split(/\r?\n/).map(line => line.trim().replace(/^[^A-Za-z0-9]+/, '').split(/\s+/)[0]).filter(unit => scopePattern.test(unit)))];
  } catch (error) { unverifiable.push(`Containment scope query failed: ${detail(error)}`); return record(); }
  for (const unit of units) {
    try {
      const properties = run('systemctl', ['--user', 'show', '--property=LoadState', '--property=ActiveState', '--property=ControlGroup', unit]).split(/\r?\n/);
      const property = (name: string) => properties.find(line => line.startsWith(`${name}=`))?.slice(name.length + 1).trim() ?? '';
      const activeState = property('ActiveState'), controlGroup = property('ControlGroup');
      if (!activeState) { unverifiable.push(`systemd reported no state for containment scope ${unit}`); continue; }
      if (property('LoadState') === 'not-found' || !liveScope.includes(activeState)) { scopes.push({ unit, activeState, processes: [], attributed: [] }); continue; }
      if (!controlGroup) { unverifiable.push(`Containment scope ${unit} is ${activeState} without a readable control group`); continue; }
      let members: number[];
      try { members = readCgroup(controlGroup).split(/\s+/).filter(value => /^\d+$/.test(value)).map(Number); }
      catch (error) { if (!vanished(error)) throw error; members = []; }
      // A scope name carries the supervisor's PID, not the work key, so it cannot say whose
      // assignment a live scope is. Every member it still holds therefore fences this one
      // unless that member is positively attributed to a different live assignment: a
      // working directory outside the workspace is not proof of belonging elsewhere.
      const held: number[] = [], attributed: number[] = [];
      for (const pid of members) {
        const membership = workspaceMember(pid);
        if (membership === 'gone') continue;
        if (membership !== 'inside' && assignmentOf(pid) === 'other') attributed.push(pid);
        else held.push(pid);
      }
      scopes.push({ unit, activeState, processes: held, attributed });
    } catch (error) { unverifiable.push(`Containment scope ${unit} could not be inspected: ${detail(error)}`); }
  }
  return record();
}

// --- The master loop's own supervisor ----------------------------------------
//
// GY-84 made the loop report itself: an absent process or a stalled cycle becomes the top
// attention item, "and a supervised deployment restarts it automatically". That last clause was an
// assumption about the host, never a fact anybody established — an installation could follow the
// guide end to end and still run an unsupervised loop, learning it only after hours of silence.
// What follows installs that supervisor, verifies it, and — where no supervisor can be installed —
// says so instead of leaving the promise unkept.

/** The one unit Graphyard installs for the loop; the master's harness rules name it exactly. */
export const loopUnitName = 'graphyard-master.service';
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
}
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

const canonical = (path: string) => { const absolute = resolve(path); try { return realpathSync(absolute); } catch { return absolute; } };
const within = (path: string, parent: string) => path === parent || path.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
/**
 * The directories every host treats as temporary, by name. A unit whose WorkingDirectory is under
 * one outlives the directory: on 2026-09-22 a unit written with a reviewer's `/var/tmp` checkout as
 * its WorkingDirectory crash-looped 233 times in 40 minutes after that checkout was deleted.
 */
export const temporaryDirectories = () => [...new Set([tmpdir(), '/tmp', '/var/tmp'].map(canonical))];

/**
 * Whether this process is the test suite. Node's test runner marks every process it runs a test
 * file in (`NODE_TEST_CONTEXT` in the children `--test` spawns, `--test` itself on the runner), and
 * `npm test` marks everything it starts with its lifecycle event. The marks are read from the real
 * process only: a `LoopSupervisorHost.env` says where a unit goes, never whether this is a test, so
 * no argument a test passes — or forgets — can switch the guard below off.
 */
export const underTestRunner = () => !!process.env.NODE_TEST_CONTEXT || process.execArgv.includes('--test') || process.env.npm_lifecycle_event === 'test';
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
ExecStart=${unitValue(execPath, 'Node executable')} ${unitValue(input.cliPath, 'CLI path')} master run
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

/** Whether this host can be given a supervisor at all, and why not when it cannot. */
export function supervisorSupport(host: LoopSupervisorHost = {}): { supported: boolean; reason: string | null } {
  const platform = host.platform ?? process.platform;
  if (platform !== 'linux') return { supported: false, reason: `Graphyard supervises the loop with a systemd user unit, and this host reports ${platform}` };
  try { supervisorRun(host)('systemctl', ['--user', 'show-environment']); return { supported: true, reason: null }; }
  catch (error) { return { supported: false, reason: `This host has no reachable systemd user manager, so no unit can be installed or enabled: ${detail(error)}` }; }
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
function observeUnit(run: (command: string, args: string[]) => string) {
  const enabled = supervisorState(run, ['--user', 'is-enabled', loopUnitName]);
  const active = supervisorState(run, ['--user', 'is-active', loopUnitName]);
  return {
    enabledState: enabled, activeState: active,
    enabled: enabled === null ? null : ['enabled', 'enabled-runtime', 'static', 'indirect', 'alias'].includes(enabled),
    active: active === null ? null : ['active', 'activating', 'reloading'].includes(active),
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
  const unitPath = join(unitDirectory, loopUnitName);
  if (!support.supported) return { supported: false, unit: loopUnitName, unitPath: null, installed: false, enabled: null, active: null, linger: null,
    wrote: 'none', refused: null, performed: [], reason: support.reason, instruction: unsupervisedInstruction(input) };
  const run = supervisorRun(host);
  const text = loopUnitText(input);
  const performed: string[] = [];
  let existing: string | null = null;
  const refused = (refusal: LoopSupervisorRefusal): LoopSupervisorInstallation => {
    // Nothing was written; what is there is reported as observed, so setup never claims a state. A
    // refusal raised before the unit was read still reports the unit that exists, not `installed: false`.
    const present = existing !== null || existsSync(unitPath);
    const observed = observeUnit(run);
    return { supported: true, unit: loopUnitName, unitPath, installed: present, enabled: present ? observed.enabled : false, active: present ? observed.active : false,
      linger: null, wrote: 'refused', refused: refusal.message, performed: [], reason: `Installing the loop's supervisor was refused: ${refusal.message}`, instruction: refusal.instruction };
  };
  try {
    testSuiteHomeGuard(unitDirectory);
    assertCoordinatorCheckout(input.root, host);
  } catch (error) { if (error instanceof LoopSupervisorRefusal) return refused(error); throw error; }
  try { existing = await readFile(unitPath, 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  // A unit that runs another loop — a different checkout or launcher — is somebody's installation,
  // and a re-run of setup from elsewhere must not take it over silently. A unit for this loop whose
  // other settings changed (the watchdog window follows the interval) is rewritten as before.
  if (existing !== null && !options.replace) {
    const home = host.home ?? ((host.env ?? process.env).HOME?.trim() || homedir());
    const differs = (['WorkingDirectory', 'ExecStart'] as const).filter(key => unitSetting(existing!, key, home) !== unitSetting(text, key, home));
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
  run('systemctl', ['--user', 'enable', '--now', loopUnitName]);
  performed.push(`systemctl --user enable --now ${loopUnitName}`);
  // A rewritten unit takes effect only when the service starts from it: `enable --now` leaves a
  // running loop on the old ExecStart and watchdog window, so it is restarted, and resumes from
  // the cursors it persists before and after every action.
  if (wrote === 'updated') { run('systemctl', ['--user', 'restart', loopUnitName]); performed.push(`systemctl --user restart ${loopUnitName}`); }
  // An enabled unit still never runs if this user's manager stops at logout and does not start at
  // boot, so lingering is part of "comes back after a reboot". A host that refuses it is reported
  // rather than left looking supervised.
  let linger: boolean | null = null, lingerReason: string | null = null;
  try { run('loginctl', ['enable-linger']); linger = true; performed.push('loginctl enable-linger'); }
  catch (error) { linger = false; lingerReason = `the unit is enabled, but user lingering could not be turned on, so this user's systemd manager may not start at boot: ${detail(error)}`; }
  const observed = observeUnit(run);
  const unreadable = [observed.enabled === null ? 'enabled' : null, observed.active === null ? 'active' : null].filter(Boolean).join(' and ');
  return { supported: true, unit: loopUnitName, unitPath, installed: true, enabled: observed.enabled, active: observed.active, linger,
    wrote, refused: null, performed, instruction: null,
    reason: [unreadable ? `systemd did not report whether the unit is ${unreadable}` : null, lingerReason].filter(Boolean).join('; ') || null };
}

/** The same facts, observed rather than installed: what `master status` reports about supervision. */
export async function loopSupervision(input: Pick<LoopUnitInput, 'root' | 'cliPath'>, host: LoopSupervisorHost = {}): Promise<LoopSupervision> {
  const support = supervisorSupport(host);
  const unitPath = join(loopUnitDirectory(host), loopUnitName);
  if (!support.supported) return { supported: false, unit: loopUnitName, unitPath: null, installed: false, enabled: null, active: null, linger: null,
    reason: support.reason, instruction: unsupervisedInstruction(input) };
  const run = supervisorRun(host);
  // Reading supervision must never be able to fail a report: an unreadable unit file is one signal
  // missing, and systemd's own answer below still decides whether a unit is installed.
  let installed = false;
  try { await readFile(unitPath, 'utf8'); installed = true; } catch { installed = false; }
  const observed = observeUnit(run);
  // A unit systemd knows by another path (a packaged or hand-placed one) is installed too.
  installed ||= observed.enabledState !== null && observed.enabledState !== 'not-found';
  const unreadable = [observed.enabled === null ? 'enabled' : null, observed.active === null ? 'active' : null].filter(Boolean).join(' and ');
  // Lingering is read, never assumed: a host that cannot answer leaves it unknown rather than false.
  // `show-user` needs the user named: without one it shows the login manager, which has no Linger
  // property and answers nothing, and the reboot half of the restart policy went unverified.
  let linger: boolean | null = null;
  try { const answer = run('loginctl', ['show-user', supervisedUser(), '--property=Linger', '--value']).trim().toLowerCase(); linger = answer === 'yes' ? true : answer === 'no' ? false : null; } catch { linger = null; }
  return { supported: true, unit: loopUnitName, unitPath, installed, enabled: installed ? observed.enabled : false, active: installed ? observed.active : false, linger,
    instruction: null, reason: unreadable ? `systemd did not report whether the unit is ${unreadable}` : null };
}

/**
 * Supervision that is missing, disabled, or stopped, each with the command that fixes it.
 * Verified rather than assumed: a loop nobody restarts is named here while the pipeline still
 * looks busy, which is the whole gap between GY-84's promise and what it delivered.
 */
export function loopSupervisionAttention(supervision: LoopSupervision): { text: string; next: string }[] {
  const reinstall = 'graphyard master init --token-stdin on this host reinstalls and enables the loop unit; repository setup is what installs it';
  if (!supervision.supported) return [{ text: `The master loop is not supervised on this host: ${supervision.reason}. A crash or a reboot leaves it down until somebody starts it`, next: supervision.instruction! }];
  if (!supervision.installed) return [{ text: `The master loop has no supervisor installed on this host (${supervision.unit} is not present), so nothing restarts it after a crash or a reboot and its own restart attention item has nobody to act on it`, next: reinstall }];
  const items: { text: string; next: string }[] = [];
  if (supervision.enabled === false) items.push({ text: `The master loop's supervisor ${supervision.unit} is installed but disabled, so it does not start at boot`, next: `systemctl --user enable --now ${supervision.unit}` });
  if (supervision.active === false) items.push({ text: `The master loop's supervisor ${supervision.unit} is installed but not running, so the loop is not being kept alive`, next: `systemctl --user start ${supervision.unit}` });
  if (supervision.enabled === null || supervision.active === null) items.push({ text: `Whether the master loop is supervised could not be verified: ${supervision.reason ?? 'systemd did not answer'}`, next: `systemctl --user status ${supervision.unit}` });
  if (supervision.linger === false) items.push({ text: `The master loop's supervisor is enabled, but this user's systemd manager may not start at boot, so a reboot can leave the loop down`, next: 'loginctl enable-linger (or, as root, loginctl enable-linger USER)' });
  return items;
}
