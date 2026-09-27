// Concern: live session tails (GY-713) — what the loop reads of the sessions it launched, and how
// often it publishes that to the control plane for the dashboard's read-only viewer.
import { mkdirSync, readdirSync, statSync, unlinkSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import { redactString } from './evidence-replay.js';
import type { Work } from './model.js';

/**
 * A running session is otherwise watchable only from the machine that runs it: a Herdr pane by
 * attaching to it, a headless run not at all. The loop that launched a session reads its recent
 * output — a Herdr pane through Herdr's pane-read API, a headless run from the per-run log its
 * runner writes — and publishes a bounded, redacted tail to the control plane, which serves it to
 * the dashboard's read-only viewer (web/session-viewer.tsx).
 *
 * Only sessions this loop launched are ever read: a Herdr pane only when the item carries a
 * running handle this host registered with a launch token and Herdr lists that pane under the
 * handle's own name (a worker's: its launch profile's), a headless run only from the runs this
 * process started.
 * An operator's own pane, or another host's, is never read.
 */

/** Lines kept per session: the tail a viewer sees. */
export const sessionTailLines = 200;
/** How often a session a viewer is watching is refreshed, and how often one nobody watches is. */
export const watchedRefreshMs = 3_000;
export const idleRefreshMs = 30_000;
/** The longest line kept; the rest of it is cut. */
export const tailLineLimit = 1_000;
/** How many bytes of a log are read for its tail: enough for 200 long lines, never the whole file. */
const logTailBytes = 256 * 1024;

/** Terminal control sequences: a tail is text, never a sequence a browser or terminal would act on. */
const controlSequences = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * The last `limit` lines of `text`, each stripped of control sequences, redacted by the rule the
 * evidence replay path applies to every exported string (`redactString`), and bounded.
 */
export function tailLines(text: string, limit = sessionTailLines): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return lines.slice(-limit).map(line => redactString(line.replace(controlSequences, '')).slice(0, tailLineLimit));
}

/** The end of a log file as text: at most `bytes` from its end, starting at a whole line. */
export function readLogTail(path: string, bytes = logTailBytes): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size, start = Math.max(0, size - bytes), buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { closeSync(fd); }
}

/** Where a headless run's stdout and stderr are written: ignored local state, one file per run. */
export const runLogDirectory = (root: string) => resolve(root, '.graphyard', 'runs');
const logRetentionMs = 24 * 60 * 60_000;
export function runLogFile(root: string, name: string, now = Date.now()) {
  const directory = runLogDirectory(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // A day of logs is kept; older ones, and any sidecar a Herdr-surface run left, are removed as new
  // runs start, so the directory stays bounded.
  try {
    for (const entry of readdirSync(directory)) {
      const path = resolve(directory, entry);
      try { if (/\.log(\.(sh|stderr|exit))?$/.test(entry) && now - statSync(path).mtimeMs > logRetentionMs) unlinkSync(path); } catch { /* removed by another run */ }
    }
  } catch { /* an unreadable directory keeps its logs */ }
  return resolve(directory, `${name.replace(/[^A-Za-z0-9._-]/g, '-')}-${now}.log`);
}

/**
 * The account a headless run on no registry account is on, as the live view names it: the login of
 * the environment wrapper (`pi-a`) or runtime binary it runs through.
 */
export const commandAccount = (command: string) => `${basename(command.trim().split(/\s+/)[0] || 'pi')} login`;

/** Where a session's tail is read from: a Herdr pane, or a headless run's log. */
export const tailSurfaces = ['herdr', 'headless'] as const;
export type TailRole = 'worker' | 'reviewer' | 'producer' | 'approver' | 'doctor' | 'research' | 'coordination';
/** One session the loop launched, and where its output is read from. */
export interface TailSource {
  /** The item's id. */
  work: string;
  /** The session's name: its runtime name, else its handle id. */
  session: string;
  role: TailRole; runtime: string; account: string | null;
  /** The identity the session works as, when its handle names one. */
  principal: string | null;
  /** When the session started; null when its launcher recorded no start. */
  startedAt: string | null;
  /** Where a Herdr pane is read from, or the log a headless run writes. */
  surface: { kind: 'herdr'; pane: string } | { kind: 'headless'; log: string };
  attach: string | null; transcript: string | null;
}

/** A headless run this process started, as the run registry and the research step hold it. */
export interface LaunchedRun { name: string; work: string; role: TailRole; runtime: string; account?: string | null; startedAt: string | null; log: string | null; pane?: string | null }

const handleRole = (kind: string, role: string | null): TailRole => {
  const slot = (role ?? '').split(/[:\s]/)[0];
  if (['worker', 'reviewer', 'producer', 'approver', 'doctor', 'research'].includes(slot)) return slot as TailRole;
  return kind === 'implementation' ? 'worker' : kind === 'review' ? 'reviewer' : kind === 'proof' ? 'producer' : 'coordination';
};

/** One launch's account choice, as the host's environment log records it under `role:profile`. */
export interface AccountChoice { environment: string | null; at: string; work: string | null }
/**
 * The account a Herdr session was launched on: the host's latest recorded choice for its role and
 * item made no later than it started; a choice of no named account is its profile's own login.
 */
export function chosenAccount(choices: Readonly<Record<string, AccountChoice>>, item: Pick<Work, 'id' | 'key'>, role: TailRole, startedAt: string | null): string | null {
  const started = startedAt ? Date.parse(startedAt) : Number.POSITIVE_INFINITY;
  const found = Object.entries(choices).filter(([key, choice]) => key.startsWith(`${role}:`) && (choice.work === item.key || choice.work === item.id) && !(Date.parse(choice.at) > started + 60_000))
    .sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at))[0];
  return found ? found[1].environment ?? `${found[0].slice(role.length + 1)} own login` : null;
}

/**
 * The sessions this loop may read, and nothing else. A Herdr pane qualifies only through a running
 * handle on an item that this host registered with a launch token, whose pane Herdr lists under
 * that handle's own name (a worker's: the loop's launch profile for its principal); a headless run
 * only when this process started it. `runs` name their item by key or id.
 */
export function launchedTailSources(work: readonly Work[], agents: readonly { name?: string; pane_id?: string }[], hostId: string, runs: readonly LaunchedRun[] = [],
  profiles: readonly { principal: string; agentName: string }[] = [], choices: Readonly<Record<string, AccountChoice>> = {}): TailSource[] {
  const sources: TailSource[] = [], seen = new Set<string>(), read = new Set<string>();
  for (const item of work) {
    for (const handle of item.sessions ?? []) {
      if (handle.state !== 'running' || handle.host !== hostId || !handle.launch) continue;
      // A worker's handle is registered by its supervisor without Herdr coordinates: the pane is the
      // one Herdr lists under the name of the launch profile this loop runs that principal on — and
      // only while the handle's attempt holds the item's lease, since the profile's pane moves on to
      // the principal's next item while an earlier handle may still read as running.
      const byProfile = !handle.agentName;
      if (byProfile && (item.lease?.owner !== handle.principal || item.lease?.epoch !== handle.epoch)) continue;
      const name = handle.agentName ?? profiles.find(profile => profile.principal === handle.principal)?.agentName;
      const agent = name ? agents.find(entry => entry.name === name && !!entry.pane_id && (!handle.pane || entry.pane_id === handle.pane)) : undefined;
      if (!name || !agent?.pane_id || read.has(agent.pane_id)) continue;
      const id = `${item.id}/${name}`;
      if (seen.has(id)) continue;
      seen.add(id); read.add(agent.pane_id);
      const role = handleRole(handle.kind, handle.role);
      sources.push({ work: item.id, session: name, role, runtime: handle.runtime, account: chosenAccount(choices, item, role, handle.startedAt), principal: handle.principal, startedAt: handle.startedAt,
        surface: { kind: 'herdr', pane: agent.pane_id }, attach: handle.attach, transcript: handle.transcript });
    }
  }
  for (const run of runs) {
    const item = work.find(entry => entry.id === run.work || entry.key === run.work);
    if (!item) continue;
    const id = `${item.id}/${run.name}`;
    if (seen.has(id)) continue;
    const surface = run.pane ? { kind: 'herdr' as const, pane: run.pane } : run.log ? { kind: 'headless' as const, log: run.log } : null;
    if (!surface) continue;
    seen.add(id);
    sources.push({ work: item.id, session: run.name, role: run.role, runtime: run.runtime, account: run.account ?? null, principal: null, startedAt: run.startedAt, surface,
      attach: run.pane ? `herdr pane attach ${run.pane}` : null, transcript: run.log });
  }
  return sources;
}

/** One published tail, as the control plane stores and serves it. */
export interface PublishedTail extends Omit<TailSource, 'surface'> { surface: 'herdr' | 'headless'; lines: string[]; readAt: string; error: string | null }

export interface TailPublisherDeps {
  /** Reads a Herdr pane's recent output through Herdr's pane-read API. */
  readPane: (pane: string, lines: number) => Promise<string>;
  /** Reads a headless run's log. */
  readLog?: (path: string) => string;
  /** Sends one batch of tails; answers with the sessions a viewer is watching now. */
  publish: (host: string, tails: PublishedTail[]) => Promise<{ watched: string[] }>;
  /** The sessions a viewer is watching now (`work/session`), read every watched interval. */
  watched: () => Promise<string[]>;
  now?: () => number;
}

const keyOf = (source: Pick<TailSource, 'work' | 'session'>) => `${source.work}/${source.session}`;

/**
 * Publishes the tails of the sessions this loop launched. `observe` hands it the current roster
 * (every cycle); `tick` runs every `watchedRefreshMs` and publishes each session that is due: one
 * a viewer is watching every 3 s, any other every 30 s. A session dropped from the roster is never
 * read again.
 */
export class SessionTailPublisher {
  private sources = new Map<string, TailSource>();
  private published = new Map<string, number>();
  private watching = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  constructor(private readonly host: string, private readonly deps: TailPublisherDeps) {}

  observe(sources: readonly TailSource[]) {
    this.sources = new Map(sources.map(source => [keyOf(source), source]));
    for (const key of this.published.keys()) if (!this.sources.has(key)) this.published.delete(key);
  }
  roster() { return [...this.sources.values()]; }

  /** Starts the refresh timer; it never holds the process open. */
  start(intervalMs = watchedRefreshMs) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, intervalMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  /** Whether the refresh timer runs: only while the roster holds a session. */
  get running() { return this.timer !== null; }

  /** The sessions due now: watched ones after 3 s, the rest after 30 s. */
  due(now: number) {
    return [...this.sources.values()].filter(source => {
      const last = this.published.get(keyOf(source));
      return last === undefined || now - last >= (this.watching.has(keyOf(source)) ? watchedRefreshMs : idleRefreshMs) - 250;
    });
  }

  async tick(): Promise<PublishedTail[]> {
    if (this.ticking || !this.sources.size) return [];
    this.ticking = true;
    try {
      try { this.watching = new Set(await this.deps.watched()); } catch { /* keep the last answer */ }
      const now = (this.deps.now ?? Date.now)();
      const tails: PublishedTail[] = [];
      for (const source of this.due(now)) {
        let text = '', error: string | null = null;
        try {
          text = source.surface.kind === 'herdr' ? await this.deps.readPane(source.surface.pane, sessionTailLines)
            : (this.deps.readLog ?? readLogTail)(source.surface.log);
        } catch (failure) { error = redactString(failure instanceof Error ? failure.message : String(failure)).slice(0, 300); }
        const { surface, ...rest } = source;
        tails.push({ ...rest, surface: surface.kind, lines: tailLines(text), readAt: new Date(now).toISOString(), error });
        this.published.set(keyOf(source), now);
      }
      if (tails.length) {
        const answer = await this.deps.publish(this.host, tails);
        this.watching = new Set(answer.watched ?? []);
      }
      return tails;
    } finally { this.ticking = false; }
  }
}

/** The loop's session-tail effect: what a cycle hands its roster to, and where a pane's account is read. */
export interface SessionTailEffect {
  observe: (sources: TailSource[]) => void;
  /** The host's recorded account choices (`role:profile`), for naming a pane's account. */
  accounts?: () => Promise<Readonly<Record<string, AccountChoice>>>;
}
/**
 * The effect the loop runs: one publisher for the process, created on the first roster, whose one
 * timer runs while the roster holds a session and stops when it is empty.
 */
export function tailPublisherEffect(host: () => string, deps: TailPublisherDeps, accounts?: SessionTailEffect['accounts']): SessionTailEffect & { publisher: () => SessionTailPublisher | null } {
  let tails: SessionTailPublisher | null = null;
  return {
    observe: sources => {
      tails ??= new SessionTailPublisher(host(), deps);
      tails.observe(sources);
      if (sources.length) tails.start(); else tails.stop();
    },
    ...(accounts ? { accounts } : {}),
    publisher: () => tails,
  };
}

/*
 * The control plane's side (routes/work.ts serves it): tails are transient runtime output, not
 * coordination state. They are held in memory beside the engine, bounded in count and size, dropped
 * once no loop has published them for a while, and decide nothing. A viewer's read marks its
 * session watched for a few seconds, which the loop reads back to refresh it every 3 s.
 */
/** How long one viewer read keeps a session watched, and how long an unpublished tail is kept. */
export const tailWatchMs = 10_000;
export const tailRetentionMs = 10 * 60_000;
const maxTails = 500;

const text = (max: number) => z.string().max(max);
const tailSchema = z.object({
  work: text(120).min(1), session: text(200).min(1),
  role: z.enum(['worker', 'reviewer', 'producer', 'approver', 'doctor', 'research', 'coordination']),
  runtime: text(80), account: text(200).nullable(), principal: text(200).nullable(), startedAt: text(40).nullable(),
  surface: z.enum(tailSurfaces),
  attach: text(500).nullable(), transcript: text(1000).nullable(),
  lines: z.array(z.string()).max(sessionTailLines), readAt: text(40), error: text(500).nullable(),
}).strict();
const publishSchema = z.object({ host: text(200).min(1), tails: z.array(tailSchema).max(200) }).strict();

interface StoredTail extends PublishedTail { host: string; publishedAt: number }

export class SessionTails {
  private tails = new Map<string, StoredTail>();
  private watchedUntil = new Map<string, number>();
  constructor(private readonly clock: () => number = Date.now) {}
  private prune(now: number) {
    for (const [key, tail] of this.tails) if (now - tail.publishedAt > tailRetentionMs) this.tails.delete(key);
    for (const [key, until] of this.watchedUntil) if (until < now) this.watchedUntil.delete(key);
  }
  /** Stores a host's batch, redacting again on the way in; answers with the sessions watched now. */
  publish(input: unknown) {
    const { host, tails } = publishSchema.parse(input), now = this.clock();
    this.prune(now);
    for (const tail of tails) {
      const key = `${tail.work}/${tail.session}`;
      if (!this.tails.has(key) && this.tails.size >= maxTails) {
        const oldest = [...this.tails.entries()].sort((a, b) => a[1].publishedAt - b[1].publishedAt)[0];
        if (oldest) this.tails.delete(oldest[0]);
      }
      this.tails.set(key, { ...tail, lines: tail.lines.map(line => redactString(line).slice(0, tailLineLimit)), error: tail.error && redactString(tail.error), host, publishedAt: now });
    }
    return { watched: this.watched() };
  }
  /** The sessions a viewer read within the watch window. */
  watched() { const now = this.clock(); this.prune(now); return [...this.watchedUntil.keys()]; }
  /** Every published session, without its lines; one item's when `work` is given. */
  list(work?: string | null) {
    const now = this.clock();
    this.prune(now);
    return [...this.tails.values()].filter(tail => !work || tail.work === work)
      .map(({ lines, publishedAt, ...rest }) => ({ ...rest, lineCount: lines.length, publishedAt: new Date(publishedAt).toISOString(), stale: now - publishedAt > 90_000 }));
  }
  /** One session's tail; reading it marks it watched. */
  read(work: string, session: string) {
    const now = this.clock(), key = `${work}/${session}`;
    this.prune(now);
    this.watchedUntil.set(key, now + tailWatchMs);
    const tail = this.tails.get(key);
    if (!tail) return null;
    const { publishedAt, ...rest } = tail;
    return { ...rest, publishedAt: new Date(publishedAt).toISOString(), stale: now - publishedAt > 90_000 };
  }
}

const stores = new WeakMap<object, SessionTails>();
/** The tails that belong to one engine; tests running several engines in one process never share them. */
export function sessionTails(owner: object): SessionTails {
  let store = stores.get(owner);
  if (!store) { store = new SessionTails(); stores.set(owner, store); }
  return store;
}

