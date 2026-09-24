import { execFileSync } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { agentOwner, atomicPrivateWrite, closeHerdrPane, diskThresholdBytes, isProfileSession, neverStartedReason, privateFile, profileConcurrency, worktreesDirectory, type AttentionItem, type HerdrAgent, type MasterConfig } from './master.js';
import { pinnedSessionRecords, readReviewLedger, sessionLedgerBound, SessionLedgerFullError, sessionLedgerRefusal, terminalSessionStates, updateReviewLedger, type ReviewRecord } from './reviewer.js';
import { readProducerLedger, saveProducerLedger, type ProducerRecord } from './producer.js';
import type { Work } from './model.js';

/**
 * The control plane's own resources (GY-132).
 *
 * Graphyard gates every work item and, until this registry, observed none of what it consumes
 * itself. On 23 September 2026 the review ledger sat at its 200-record cap for hours: every review
 * launch was refused by the ledger's schema, and `master status` reported the downstream symptom —
 * "reviewer agent … is busy in Herdr" — while seven items starved. Finished panes held agent names
 * the next launch needed and were reported the same way. Nothing named either resource.
 *
 * Every bounded resource the loop and the plane consume is declared once, below: what bounds it,
 * where its usage is read, the component that owns it, how it is reclaimed and within what bound,
 * and what to do when it runs low. `master status` reports each one as used-of-bound with its
 * headroom and raises attention before exhaustion; a refusal caused by one is attributed to it;
 * the reclaim pass gives each one back; and `/healthz` reports the plane unhealthy while it cannot record.
 */

export const resourceIds = ['review-ledger', 'producer-ledger', 'agent-names', 'session-slots', 'github-budget', 'executor-liveness', 'loaded-revision', 'database-capacity', 'worktree-disk'] as const;
export type ResourceId = typeof resourceIds[number];
export type ResourceState = 'ok' | 'low' | 'exhausted' | 'unknown';

/** One reading of one resource (or of one instance of it: a profile's namespace, a role's slots). */
export interface ResourceReading {
  id: string; resource: ResourceId; title: string; unit: string;
  used: number | null; bound: number | null; headroom: number | null;
  /** Headroom below which the reading is `low` and raises attention. */
  warnBelow: number;
  state: ResourceState; owner: string; reclaim: string; remedy: string; detail: string | null;
  /** Holders nothing live owns any more (a finished pane on a name, a settled record): what a reclaim gives back. */
  reclaimable: number;
  /** Requests waiting on this resource; a full slot pool with nobody waiting is the fleet working, not a warning. */
  waiting?: number;
}

/** `advisory`: the bound is a default nobody configured, so reaching it warns but does not fail health. */
export interface PlaneReading { used: number | null; bound: number | null; detail?: string | null; advisory?: boolean; tables?: { table: string; bytes: number }[] }
/** What `/healthz` reports about the plane's own resources. */
export interface PlaneResources { writable: boolean; writeError: string | null; database: PlaneReading | null; github: PlaneReading | null }

/** Everything a reading is computed from; each field is null when it could not be read. */
type NamedProfile = { name: string; agentName: string; concurrency?: number };
/** The launch profiles whose sessions consume names and slots. */
export interface ProfileSet { workers: (NamedProfile & { principal: string; mode: string })[]; reviewers: NamedProfile[]; producers: NamedProfile[] }
export interface ResourceInputs {
  now: number;
  reviews: ReviewRecord[] | null; producers: ProducerRecord[] | null;
  profiles: ProfileSet;
  agents: HerdrAgent[] | null;
  work: Work[];
  plane: PlaneResources | null;
  loop: { lagMs: number | null; stalledAfterMs: number; detail: string } | null;
  revision: { behind: number; loaded: string; checkout: string } | null;
  disk: { path: string; totalBytes: number; freeBytes: number; thresholdBytes: number } | null;
}

export interface ResourceDefinition {
  id: ResourceId; title: string; unit: string;
  /** What bounds the resource, as configured or declared in code. */
  bound: string;
  /** Where its current usage is read. */
  usage: string;
  /** The component that consumes it and is answerable for it. */
  owner: string;
  /** How it is given back, and within what bound. */
  reclaim: string;
  /** What the master does when it runs low. */
  remedy: string;
  /** Headroom below which the resource warns, from its bound. */
  warnBelow: (bound: number) => number;
  /** Downstream refusals this resource causes when it is at its bound. */
  symptoms: RegExp[];
  /** The ledger schema whose array cap this resource is, when it is a ledger. */
  ledgerSchema?: string;
  read: (input: ResourceInputs) => Omit<ResourceReading, 'resource' | 'title' | 'unit' | 'owner' | 'reclaim' | 'remedy' | 'headroom' | 'state' | 'warnBelow'>[];
}

/** Terminal ledger records are kept this long after they settle, then reaped. */
export const ledgerRetentionMs = 15 * 60_000;
/** A pending session blocked on a prompt this long, or absent from Herdr on every pass this long, releases its slot. */
export const stuckSessionMs = 10 * 60_000;
/** A finished session is closed once its record has been settled this long (the launcher's own close gets the first chance). */
export const finishedSessionGraceMs = 60_000;
/** The plane's database bound when GRAPHYARD_DATABASE_MAX_BYTES is unset. */
export const defaultDatabaseMaxBytes = 10 * 1024 ** 3;
/** The default warning line: a tenth of the bound, and at least one unit. */
export const tenthOf = (bound: number) => Math.max(1, Math.ceil(bound / 10));

// Both session ledgers share `sessionLedgerBound` (GY-131): a write keeps every live and pinned
// record and is refused only when those alone would pass it; other terminal records are reaped.
export const reviewLedgerBound = sessionLedgerBound;
export const producerLedgerBound = sessionLedgerBound;

const settledAt = (record: { closedAt?: string; idleSince?: string; requestedAt: string }) => Date.parse(record.closedAt ?? record.idleSince ?? record.requestedAt);
const finished = ['idle', 'done', 'blocked'];
type Role = 'worker' | 'reviewer' | 'producer';
const roleProfiles = (input: Pick<ResourceInputs, 'profiles'>): { role: Role; name: string; agentName: string; concurrency?: number; principal?: string }[] => [
  ...input.profiles.workers.filter(profile => profile.mode === 'launch' && profile.agentName).map(profile => ({ role: 'worker' as const, name: profile.name, agentName: profile.agentName, principal: profile.principal })),
  ...input.profiles.reviewers.map(profile => ({ role: 'reviewer' as const, ...profile })),
  ...input.profiles.producers.map(profile => ({ role: 'producer' as const, ...profile })),
];
/** Live request ids: a record answering one of them is still counted by the relaunch rule and is never reaped. */
function liveRequests(work: Work[]) {
  const ids = new Set<string>();
  for (const item of work) {
    if (item.stage === 'done') continue;
    const review = item.autoDispatch?.review;
    if (review && review.state === 'requested') ids.add(review.id);
    for (const producer of item.autoDispatch?.producers ?? []) if (producer.state === 'requested') ids.add(producer.id);
  }
  return ids;
}
/** Whether a live session owns an agent name: a pending ledger record, or a worker's live lease. */
function liveOwner(profile: ReturnType<typeof roleProfiles>[number], name: string, input: Pick<ResourceInputs, 'reviews' | 'producers' | 'work' | 'now'>) {
  if (profile.role === 'worker') return input.work.some(item => !!item.lease && item.lease.owner === profile.principal && Date.parse(item.lease.expiresAt) > input.now);
  const records: { agentName: string; state: string }[] = profile.role === 'reviewer' ? input.reviews ?? [] : input.producers ?? [];
  return records.some(record => record.state === 'pending' && record.agentName === name);
}
/** A terminal record nothing reads any more: not pinned by an open request or a verdict a pending review checks against (GY-131). */
const unpinnedTerminal = <T extends { state: string; requestedAt: string }>(records: T[]) => {
  const pinned = pinnedSessionRecords(records as any);
  return records.filter(record => (terminalSessionStates as readonly string[]).includes(record.state) && !pinned.has(record as any));
};
// Usage is what the bound applies to: live records and the terminal records still read (pinned).
// Other terminal records are retained diagnostics the next write gives up, so they never count.
const ledgerReading = (records: { state: string; requestId?: string; closedAt?: string; idleSince?: string; requestedAt: string }[] | null, bound: number, input: ResourceInputs, file: string) => {
  if (!records) return [{ id: '', used: null, bound, detail: `${file} could not be read`, reclaimable: 0 }];
  const live = liveRequests(input.work);
  const free = unpinnedTerminal(records);
  const pending = records.filter(record => !(terminalSessionStates as readonly string[]).includes(record.state)).length;
  const reapable = free.filter(record => !(record.requestId && live.has(record.requestId)) && input.now - settledAt(record) >= ledgerRetentionMs).length;
  return [{ id: '', used: records.length - free.length, bound, detail: `${pending} live, ${records.length - pending - free.length} pinned terminal, ${free.length} retained terminal (${reapable} past the ${ledgerRetentionMs / 60_000}-minute retention) in ${file}`, reclaimable: reapable }];
};
/** The refusal `SessionLedgerFullError` raises for one ledger (reviewer.ts). */
const ledgerRefused = (kind: 'review' | 'producer') => new RegExp(sessionLedgerRefusal.source.replace('(review|producer)', kind));

export const resourceRegistry: ResourceDefinition[] = [
  {
    id: 'review-ledger', title: 'Review ledger', unit: 'records', ledgerSchema: 'reviewLedgerSchema',
    bound: `sessionLedgerBound (${reviewLedgerBound} live and pinned records); a write past it is refused as SessionLedgerFullError, after retained terminal records are given up`,
    usage: 'records in .graphyard/reviews.json', owner: 'src/reviewer.ts — the review launcher and its reconciliation',
    reclaim: `the reclaim pass reaps terminal records ${ledgerRetentionMs / 60_000} minutes after they settle, unless they answer a live review request`,
    remedy: 'graphyard master run --once runs the reclaim pass now; while terminal records answer live requests, settle those requests first',
    warnBelow: tenthOf, symptoms: [ledgerRefused('review')],
    read: input => ledgerReading(input.reviews, reviewLedgerBound, input, '.graphyard/reviews.json'),
  },
  {
    id: 'producer-ledger', title: 'Producer ledger', unit: 'records', ledgerSchema: 'producerLedgerSchema',
    bound: `sessionLedgerBound (${producerLedgerBound} live and pinned records); a write past it is refused as SessionLedgerFullError, after retained terminal records are given up`,
    usage: 'records in .graphyard/producers.json', owner: 'src/producer.ts — the proof-producer launcher and its reconciliation',
    reclaim: `the reclaim pass reaps terminal records ${ledgerRetentionMs / 60_000} minutes after they settle, unless they answer a live producer request`,
    remedy: 'graphyard master run --once runs the reclaim pass now; while live or pinned records fill the bound, settle those sessions and requests first',
    warnBelow: tenthOf, symptoms: [ledgerRefused('producer')],
    read: input => ledgerReading(input.producers, producerLedgerBound, input, '.graphyard/producers.json'),
  },
  {
    id: 'agent-names', title: 'Herdr agent-name namespace', unit: 'names',
    bound: "each launch profile's concurrency: its fixed agent name at concurrency 1, or that many derived <agentName>-<8hex> names above it",
    usage: 'Herdr agent list: every agent whose name is one of the profile\'s session names', owner: 'Herdr, through the worker, reviewer and producer launchers in src/master.ts',
    reclaim: `the reclaim pass closes a finished pane on one of the names once its record has been settled ${finishedSessionGraceMs / 1000}s and two passes that far apart saw it unowned (a worker pane is closed by the loop's first step once its lease ends)`,
    remedy: 'close the finished panes holding the names (graphyard master run --once, or herdr pane close PANE after confirming the session posted its result)',
    // A name held by a live session is the slot pool working; only names nothing live owns warn.
    warnBelow: () => 1, symptoms: [/\b(?:reviewer|producer) agent (\S+) is (?:busy|already visible) in Herdr/i, /agent_name_taken/],
    read: input => roleProfiles(input).map(profile => {
      if (!input.agents) return { id: profile.name, used: null, bound: profileConcurrency(profile), detail: 'Herdr could not be read', reclaimable: 0 };
      const held = input.agents.filter(agent => isProfileSession(profile, agent.name));
      const stale = held.filter(agent => !liveOwner(profile, agent.name!, input));
      return { id: profile.name, used: held.length, bound: profileConcurrency(profile), reclaimable: stale.length,
        detail: held.length ? `${profile.role} profile ${profile.name}: ${held.map(agent => `${agent.name} (${agent.agent_status ?? 'unknown'}${stale.includes(agent) ? ', no live session' : ''}${agent.pane_id ? `, pane ${agent.pane_id}` : ''})`).join(', ')}` : `${profile.role} profile ${profile.name}: no name held` };
    }),
  },
  {
    id: 'session-slots', title: 'Session slots', unit: 'sessions',
    bound: 'the summed concurrency of the role\'s launch profiles in .graphyard/master.json',
    usage: 'pending reviewer and producer ledger records, and live worker leases held by launch-profile principals', owner: 'the master loop and its dispatcher (src/master-daemon.ts, src/auto-dispatch.ts)',
    reclaim: `a session settles when its request is answered or superseded; the reclaim pass fails a pending session blocked on a prompt for ${stuckSessionMs / 60_000} minutes, or absent from Herdr on every pass for ${stuckSessionMs / 60_000} minutes, which releases its slot`,
    remedy: 'raise concurrency on a profile of the role, or add a profile on another account, in .graphyard/master.json',
    warnBelow: () => 1, symptoms: [/every (?:reviewer|independent producer) profile is busy/, /is at its concurrency limit/],
    read: input => (['worker', 'reviewer', 'producer'] as const).map(role => {
      const profiles = roleProfiles(input).filter(profile => profile.role === role);
      const bound = profiles.reduce((sum, profile) => sum + profileConcurrency(profile), 0);
      const live = liveRequests(input.work);
      if (role === 'worker') {
        const used = input.work.filter(item => !!item.lease && Date.parse(item.lease.expiresAt) > input.now && profiles.some(profile => profile.principal === item.lease!.owner)).length;
        return { id: role, used, bound, detail: `${used} live worker lease(s) across ${profiles.length} launch profile(s)`, reclaimable: 0 };
      }
      const records: { state: string; requestId?: string; agentName: string; idleSince?: string; requestedAt: string }[] | null = role === 'reviewer' ? input.reviews : input.producers;
      if (!records) return { id: role, used: null, bound, detail: 'the ledger could not be read', reclaimable: 0 };
      const pending = records.filter(record => record.state === 'pending');
      const answered = new Set(pending.map(record => record.requestId).filter(Boolean));
      const waiting = input.work.flatMap(item => role === 'reviewer' ? [item.autoDispatch?.review?.id] : (item.autoDispatch?.producers ?? []).map(entry => entry.id)).filter((id): id is string => !!id && live.has(id) && !answered.has(id)).length;
      const stuck = pending.filter(record => stuckSession(record, input.agents, input.now)).length;
      return { id: role, used: pending.length, bound, waiting, reclaimable: stuck, detail: `${pending.length} ${role} session(s) pending across ${profiles.length} profile(s), ${waiting} request(s) waiting for a slot${stuck ? `, ${stuck} stuck on a prompt or never started` : ''}` };
    }),
  },
  {
    id: 'github-budget', title: 'GitHub App request budget', unit: 'requests',
    bound: 'the installation token\'s hourly core rate limit, as GitHub reports it on GET /rate_limit',
    usage: '/healthz resources.github, read by the plane from GET /rate_limit (cached for a minute; that read costs nothing against the budget); while the client is paused after a rate-limit refusal it reads as spent until the pause ends', owner: 'the control plane\'s GitHub client (src/github.ts) and its observation jobs',
    reclaim: 'GitHub restores the budget at the reset time it reports; the client pauses every request until then once it is spent',
    remedy: 'lower observation load (fewer open candidates, a longer job interval) until the reset; every merge waits on fresh observations',
    warnBelow: tenthOf, symptoms: [/GitHub requests paused until/, /rate limited; requests paused/],
    read: input => [{ id: '', used: input.plane?.github?.used ?? null, bound: input.plane?.github?.bound ?? null, detail: input.plane?.github?.detail ?? (input.plane ? 'the plane has no GitHub App configured' : 'the plane\'s /healthz could not be read'), reclaimable: 0 }],
  },
  {
    id: 'executor-liveness', title: 'Master loop liveness', unit: 'ms since last cycle',
    bound: 'two cycle intervals past the last completed cycle (plus any announced backoff): the loop\'s own stalled bound',
    usage: 'the daemon cursor (lastCycleAt, lock) the loop writes every cycle', owner: 'the master loop process (graphyard master run, supervised as graphyard-master)',
    reclaim: 'the supervisor restarts a loop whose watchdog stops hearing from it; graphyard master restart does the same by hand',
    remedy: 'graphyard master restart (a supervised deployment restarts it on its own: systemctl --user restart graphyard-master)',
    warnBelow: bound => Math.ceil(bound / 2), symptoms: [],
    read: input => [{ id: '', used: input.loop?.lagMs ?? null, bound: input.loop?.stalledAfterMs ?? null, detail: input.loop?.detail ?? 'the daemon cursor could not be read', reclaimable: 0 }],
  },
  {
    id: 'loaded-revision', title: 'Loop loaded-code revision', unit: 'commits behind',
    bound: 'zero: the loop must run the code its checkout holds',
    usage: 'commits the coordinator checkout moved past the one the running loop process loaded, from the checkout\'s HEAD reflog and the process start time', owner: 'the master loop process and the coordinator checkout',
    reclaim: 'a restart loads the checkout\'s revision',
    remedy: 'graphyard master restart so the loop runs the code the checkout holds',
    warnBelow: () => 0, symptoms: [],
    read: input => [{ id: '', used: input.revision?.behind ?? null, bound: 0, detail: input.revision ? `the loop loaded ${input.revision.loaded.slice(0, 12)}; the checkout is at ${input.revision.checkout.slice(0, 12)}` : 'no running loop process, or its start could not be read', reclaimable: 0 }],
  },
  {
    id: 'database-capacity', title: 'Control-plane database', unit: 'bytes',
    bound: `GRAPHYARD_DATABASE_MAX_BYTES on the plane (default ${defaultDatabaseMaxBytes / 1024 ** 3} GiB, which only warns; a configured bound also fails health): set it to the database volume's size`,
    usage: '/healthz resources.database: pg_database_size of the plane\'s database', owner: 'the control plane (src/store)',
    reclaim: 'none automatic: the ledger is append-only history; grow the volume, or restore a backup onto a larger one (docs/operations-reference.md)',
    remedy: 'grow the database volume and raise GRAPHYARD_DATABASE_MAX_BYTES to match before writes fail',
    warnBelow: tenthOf, symptoms: [/could not extend file|No space left on device|disk full/i],
    read: input => [{ id: '', used: input.plane?.database?.used ?? null, bound: input.plane?.database?.bound ?? null, detail: input.plane?.database?.detail ?? (input.plane ? null : 'the plane\'s /healthz could not be read'), reclaimable: 0 }],
  },
  {
    id: 'worktree-disk', title: 'Coordinator worktree disk', unit: 'bytes',
    bound: 'the size of the volume holding .graphyard/worktrees; it warns at run.diskThresholdGb free',
    usage: 'statfs of .graphyard/worktrees', owner: 'the worker launcher and the loop\'s worktree reclamation (src/master.ts)',
    reclaim: 'the loop reclaims dependency directories of finished worktrees every cycle while free space is below the threshold',
    remedy: 'graphyard master run --once reclaims now; lower run.reclaimIdleHours to make more worktrees disposable',
    warnBelow: bound => bound, symptoms: [/ENOSPC|No space left on device|Disk quota exceeded/],
    read: input => [input.disk ? { id: '', used: input.disk.totalBytes - input.disk.freeBytes, bound: input.disk.totalBytes, detail: `${input.disk.path}`, reclaimable: 0 } : { id: '', used: null, bound: null, detail: 'free space could not be read', reclaimable: 0 }],
  },
];

/**
 * What the loop consumes that the registry does not declare: a capped ledger schema no entry
 * names, or a resource no entry reads. Empty when the registry is complete.
 */
export function registryGaps(consumed: { ledgers: string[]; resources: string[] }, registry: ResourceDefinition[] = resourceRegistry) {
  const ledgers = new Set(registry.map(entry => entry.ledgerSchema).filter(Boolean));
  const ids = new Set<string>(registry.map(entry => entry.id));
  return [...consumed.ledgers.filter(name => !ledgers.has(name)).map(name => `ledger ${name}`), ...consumed.resources.filter(id => !ids.has(id)).map(id => `resource ${id}`)];
}

function stuckSession(record: { state: string; agentName: string; idleSince?: string; requestedAt: string }, agents: HerdrAgent[] | null, now: number) {
  if (record.state !== 'pending' || !agents) return false;
  const agent = agents.find(candidate => candidate.name === record.agentName);
  if (!agent) return now - Date.parse(record.requestedAt) >= stuckSessionMs;
  return agent.agent_status === 'blocked' && now - Date.parse(record.idleSince ?? record.requestedAt) >= stuckSessionMs;
}

const disk = new Set<ResourceId>(['worktree-disk', 'database-capacity']);
/** Every registered resource read from one set of inputs. */
export function readResources(input: ResourceInputs, registry = resourceRegistry): ResourceReading[] {
  return registry.flatMap(definition => definition.read(input).map(part => {
    const headroom = part.used === null || part.bound === null ? null : part.bound - part.used;
    const warnBelow = definition.id === 'worktree-disk' && input.disk ? input.disk.thresholdBytes : part.bound === null ? 0 : definition.warnBelow(part.bound);
    const exhausted = headroom !== null && (headroom < 0 || (headroom === 0 && (part.bound ?? 0) > 0));
    const state: ResourceState = headroom === null ? 'unknown' : exhausted ? 'exhausted' : headroom < warnBelow ? 'low' : 'ok';
    return { ...part, id: part.id ? `${definition.id}:${part.id}` : definition.id, resource: definition.id, title: definition.title, unit: definition.unit, headroom, warnBelow, state,
      owner: definition.owner, reclaim: definition.reclaim, remedy: definition.remedy };
  }));
}

const amount = (reading: Pick<ResourceReading, 'unit' | 'resource'>, value: number | null) => value === null ? 'unknown'
  : disk.has(reading.resource) ? `${(value / 1e9).toFixed(1)} GB` : reading.unit.startsWith('ms') ? `${Math.round(value / 1000)}s` : `${value} ${reading.unit}`;
/** One sentence naming the resource, its usage against its bound, and its headroom. */
export const describeReading = (reading: ResourceReading) =>
  `${reading.title}${reading.id.includes(':') ? ` (${reading.id.split(':')[1]})` : ''} is ${reading.state === 'exhausted' ? 'at its bound' : 'low'}: ${amount(reading, reading.used)} used of ${amount(reading, reading.bound)}, ${amount(reading, reading.headroom === null ? null : Math.max(0, reading.headroom))} left${reading.detail ? ` — ${reading.detail}` : ''}`;

/**
 * Whether a reading raises attention. A low or exhausted resource does, before it is exhausted
 * where its threshold allows. Two resources are judged on what nothing live is using: a name held
 * by a running session, or a slot pool full with nobody waiting, is the fleet working.
 */
export function needsAttention(reading: ResourceReading) {
  if (reading.state !== 'low' && reading.state !== 'exhausted') return false;
  if (reading.resource === 'agent-names') return reading.reclaimable > 0;
  if (reading.resource === 'session-slots') return (reading.waiting ?? 0) > 0;
  return true;
}
/** One attention item per resource below its warning line: the resource, its bound, its usage and its remedy. */
export function resourceAttention(readings: ResourceReading[]): AttentionItem[] {
  return readings.filter(needsAttention).map(reading => ({ subject: `resource:${reading.id}`,
    text: `${describeReading(reading)}. It warns below ${amount(reading, reading.warnBelow)} of headroom; ${reading.reclaim}`, ...agentOwner('master', reading.remedy) }));
}

/** An error whose cause is a registered resource at its bound. */
export class ResourceExhaustedError extends Error {
  constructor(readonly reading: ResourceReading, cause?: string) {
    super(`${describeReading(reading)}. ${reading.remedy}${cause ? ` — ${cause}` : ''}`);
  }
}

/**
 * The reading a refusal is attributed to: an exhausted (or low) reading one of whose symptoms the
 * refusal matches. A namespace symptom names the agent, and only that agent's namespace takes it.
 */
export function attributionFor(reason: string, readings: ResourceReading[]): ResourceReading | null {
  for (const reading of readings) {
    if (reading.state !== 'exhausted') continue;
    const definition = resourceRegistry.find(entry => entry.id === reading.resource);
    for (const symptom of definition?.symptoms ?? []) {
      const match = symptom.exec(reason);
      if (!match) continue;
      if (reading.resource === 'agent-names' && match[1] && !(reading.detail ?? '').includes(`${match[1]} (`)) continue;
      return reading;
    }
  }
  return null;
}

/**
 * A ledger write refused by its own bound names the ledger, even where nothing read it first:
 * `SessionLedgerFullError` (reviewer.ts) names which ledger refused.
 */
export function ledgerExhaustion(error: unknown): ResourceReading | null {
  const text = error instanceof Error ? error.message : String(error);
  for (const [kind, resource, bound] of [['review', 'review-ledger', reviewLedgerBound], ['producer', 'producer-ledger', producerLedgerBound]] as const) {
    if (!(error instanceof SessionLedgerFullError ? error.spec.role === (kind === 'review' ? 'reviewer' : 'producer') : ledgerRefused(kind).test(text))) continue;
    const definition = resourceRegistry.find(entry => entry.id === resource)!;
    return { id: resource, resource, title: definition.title, unit: definition.unit, used: bound, bound, headroom: 0, warnBelow: definition.warnBelow(bound), state: 'exhausted',
      owner: definition.owner, reclaim: definition.reclaim, remedy: definition.remedy, detail: `a write of a further record was refused by its bound (SessionLedgerFullError)`, reclaimable: 0 };
  }
  return null;
}

/**
 * The reason a failed action records. A refusal caused by a registered resource at its bound
 * names the resource and its bound instead of the downstream effect; any other reason is kept.
 */
export function attributeRefusal(error: unknown, readings: ResourceReading[] = []): Error {
  if (error instanceof ResourceExhaustedError) return error;
  const text = error instanceof Error ? error.message : String(error);
  const ledger = ledgerExhaustion(error);
  // A ledger refusal keeps its own text after the resource: master status attributes a standing
  // ledger refusal from it (GY-131's `sessionLedgerRefusal`).
  if (ledger) return new ResourceExhaustedError(ledger, text);
  const reading = attributionFor(text, readings);
  return reading ? new ResourceExhaustedError(reading) : error instanceof Error ? error : new Error(text);
}

/** The agent-name readings of the given profiles against a Herdr inventory, for a launcher that has nothing else read. */
export function agentNameReadings(profiles: Partial<ProfileSet>, agents: HerdrAgent[], context: Partial<Pick<ResourceInputs, 'reviews' | 'producers' | 'work'>> = {}, now = Date.now()) {
  const names = resourceRegistry.find(entry => entry.id === 'agent-names')!;
  return readResources({ now, reviews: context.reviews ?? null, producers: context.producers ?? null, work: context.work ?? [], agents, plane: null, loop: null, revision: null, disk: null,
    profiles: { workers: profiles.workers ?? [], reviewers: profiles.reviewers ?? [], producers: profiles.producers ?? [] } }, [names]);
}

/**
 * Refuses a launch into an exhausted namespace before the runtime is asked: every name the
 * profile may take is held, so the launch would be refused as a name already taken.
 */
export function assertNameAvailable(role: 'reviewer' | 'producer', profile: { name: string; agentName: string; concurrency?: number }, agents: HerdrAgent[], context: Partial<Pick<ResourceInputs, 'reviews' | 'producers' | 'work'>> = {}) {
  const reading = agentNameReadings(role === 'reviewer' ? { reviewers: [profile] } : { producers: [profile] }, agents, context)[0];
  if (reading?.state === 'exhausted') throw new ResourceExhaustedError(reading);
}

// ---- Reading the inputs on the coordinator host ----------------------------------------------

/** The plane's own report of its resources, from its unauthenticated health endpoint. */
export async function readPlaneResources(url: string, fetcher: typeof fetch = fetch): Promise<PlaneResources | null> {
  try {
    const response = await fetcher(`${url.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(10_000) });
    const body = await response.json() as { writable?: boolean; causes?: string[]; resources?: { database?: PlaneReading | null; github?: PlaneReading | null } };
    return { writable: body.writable !== false, writeError: body.writable === false ? body.causes?.[0] ?? 'writes are refused' : null, database: body.resources?.database ?? null, github: body.resources?.github ?? null };
  } catch { return null; }
}

/**
 * How far the checkout moved past the code a process loaded: the HEAD it had when the process
 * started (from the times of the checkout's reflog entries) against HEAD now. Null when the process is gone or the
 * reflog does not reach back to its start.
 */
export function loadedRevision(root: string, pid: number, run: (command: string, args: string[]) => string = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }), now = Date.now()) {
  try {
    const elapsed = Number(run('ps', ['-o', 'etimes=', '-p', String(pid)]).trim());
    if (!Number.isFinite(elapsed)) return null;
    const startedAt = Math.floor(now / 1000) - elapsed;
    const checkout = run('git', ['-C', root, 'rev-parse', 'HEAD']).trim();
    // The reflog entry's own time (`%gd` under --date=unix is HEAD@{<seconds>}), not the commit's:
    // a checkout that fast-forwards onto an older commit moved after the process started.
    const moves = run('git', ['-C', root, 'reflog', 'show', '--date=unix', '--format=%H %gd', '-n', '200', 'HEAD']).trim().split('\n')
      .map(line => { const [sha, selector] = line.split(' '); return [sha, /@\{(\d+)\}/.exec(selector ?? '')?.[1]] as const; }).filter(([sha, at]) => sha && at);
    const loaded = moves.find(([, at]) => Number(at) <= startedAt)?.[0] ?? (moves.length && moves.length < 200 ? moves.at(-1)![0] : null);
    if (!loaded) return null;
    return { loaded, checkout, behind: loaded === checkout ? 0 : Number(run('git', ['-C', root, 'rev-list', '--count', `${loaded}..${checkout}`]).trim()) || 0 };
  } catch { return null; }
}

export async function readDisk(root: string, config: MasterConfig) {
  const path = worktreesDirectory(root);
  for (const candidate of [path, root]) {
    try { const info = await statfs(candidate); return { path, totalBytes: Number(info.blocks) * Number(info.bsize), freeBytes: Number(info.bavail) * Number(info.bsize), thresholdBytes: diskThresholdBytes(config) }; }
    catch { /* the worktree directory may not exist yet: the checkout's volume stands in */ }
  }
  return null;
}

// ---- The reclaim pass --------------------------------------------------------------------------

export interface ResourceReclaimReport {
  at: string;
  reaped: { review: number; producer: number };
  closed: { name: string; pane: string; reason: string }[];
  released: { name: string; ledger: 'review' | 'producer'; reason: string }[];
  errors: string[];
}
export const resourceReportFile = (root: string) => resolve(root, '.graphyard/resource-reclaims.json');
const retainedReports = 50;

interface ReclaimFile { version: 1; reports: ResourceReclaimReport[]; seen: Record<string, string> }
async function readReclaimFile(root: string): Promise<ReclaimFile> {
  try { await privateFile(resourceReportFile(root)); const body = JSON.parse(await readFile(resourceReportFile(root), 'utf8')); return { version: 1, reports: body.reports ?? [], seen: body.seen ?? {} }; }
  catch { return { version: 1, reports: [], seen: {} }; }
}
export async function readReclaimReports(root: string): Promise<ResourceReclaimReport[]> { return (await readReclaimFile(root)).reports; }

/**
 * Gives every reclaimable resource back, and records what it took. Within the bounds the registry
 * documents: a terminal ledger record is reaped once it has been settled `ledgerRetentionMs` and
 * answers no live request; a finished pane holding a profile's name whose record settled
 * `finishedSessionGraceMs` ago, with no pending record on the name, is closed and its name
 * released once an earlier pass at least that long before saw it the same way; a pending session
 * blocked on a prompt for `stuckSessionMs`, or absent from every pass for that long, is failed —
 * its slot released and the relaunch rule free to try again — and its pane closed. The ledger is
 * written from a fresh read once the panes are closed, so a launch recorded meanwhile survives.
 *
 * It runs every cycle of the loop and from `master run --once`. It removes nothing a live request
 * or a running session needs, and it never touches a worker's pane: the loop's first step closes
 * those once their lease ends.
 */
export async function reclaimResources(root: string, config: Pick<ProfileSet, 'reviewers' | 'producers'>, observed: { work: Work[]; agents: HerdrAgent[] | null }, options: { now?: number; closePane?: (pane: string) => void | Promise<void> } = {}): Promise<ResourceReclaimReport> {
  const now = options.now ?? Date.now();
  const close = options.closePane ?? (pane => { closeHerdrPane(pane); });
  const report: ResourceReclaimReport = { at: new Date(now).toISOString(), reaped: { review: 0, producer: 0 }, closed: [], released: [], errors: [] };
  // A pane is closed only once it has been seen finished and unowned by an earlier pass at least
  // the grace ago: a session launched a moment ago holds its name before its record is written.
  // A pending session is failed as absent only once every pass for `stuckSessionMs` missed it: one
  // inventory that omits a working session is not its end.
  const file = await readReclaimFile(root);
  const seen: Record<string, string> = {};
  const live = liveRequests(observed.work);
  type Settleable = { id: string; state: string; agentName: string; pane: string | null; requestId?: string; closedAt?: string; idleSince?: string; requestedAt: string; resolution?: string; acknowledgedAt?: string };
  const identity = (record: Settleable) => record.id;
  /** Decides from one read what to fail, close and reap; the ledger is written from a fresh read afterwards. */
  const reclaimLedger = async (kind: 'review' | 'producer', records: Settleable[], profiles: { name: string; agentName: string; concurrency?: number }[]) => {
    const failed = new Map<string, { resolution: string }>();
    // 1. Pending sessions stuck on a prompt, or absent from Herdr for the whole bound: failed, so their slot is released.
    for (const record of records) {
      if (!stuckSession(record, observed.agents, now)) continue;
      const agent = observed.agents?.find(candidate => candidate.name === record.agentName);
      if (!agent) {
        const key = `missing:${identity(record)}`;
        const first = file.seen[key] ?? report.at;
        if (now - Date.parse(first) < stuckSessionMs) { seen[key] = first; continue; }
      }
      const reason = agent ? `blocked on a prompt in Herdr for over ${stuckSessionMs / 60_000} minutes without a result` : `absent from Herdr on every pass for ${stuckSessionMs / 60_000} minutes`;
      // A session never acknowledged and gone from Herdr never started: the launcher's retry policy for that case applies.
      const resolution = !agent && !record.acknowledgedAt
        ? `${neverStartedReason}: the session left Herdr without acting on its request (reclaimed; its slot is released and the request may be launched again)`
        : `Reclaimed: the session was ${reason}; its slot is released and the request may be launched again`;
      failed.set(identity(record), { resolution });
      report.released.push({ name: record.agentName, ledger: kind, reason });
    }
    // 2. Panes on a profile's names whose session settled and nothing pending holds the name.
    for (const agent of observed.agents ?? []) {
      if (!agent.pane_id || !agent.name || !profiles.some(profile => isProfileSession(profile, agent.name))) continue;
      if (records.some(record => record.state === 'pending' && record.agentName === agent.name && !failed.has(identity(record)))) continue;
      const settled = records.filter(record => record.agentName === agent.name).at(-1);
      // A session this pass just released is closed at once; any other waits out the grace, finished.
      const released = report.released.some(entry => entry.name === agent.name);
      if (!settled || (!released && (now - settledAt(settled) < finishedSessionGraceMs || !finished.includes(agent.agent_status ?? '')))) continue;
      const first = file.seen[agent.pane_id] ?? report.at;
      if (!released && now - Date.parse(first) < finishedSessionGraceMs) { seen[agent.pane_id] = first; continue; }
      const state = failed.has(identity(settled)) ? 'failed' : settled.state, resolution = failed.get(identity(settled))?.resolution ?? settled.resolution;
      try { await close(agent.pane_id); report.closed.push({ name: agent.name, pane: agent.pane_id, reason: `its ${kind} session ${state}${resolution ? `: ${resolution.slice(0, 160)}` : ''}` }); }
      catch (error) { report.errors.push(`Closing ${agent.name} (pane ${agent.pane_id}): ${error instanceof Error ? error.message : String(error)}`); }
    }
    // 3. Terminal records past retention that answer no live request.
    // A pinned record (GY-131) is never reaped: an open request or a pending review still reads it.
    const reap = new Set(unpinnedTerminal(records).filter(record => !(record.requestId && live.has(record.requestId)) && now - settledAt(record) >= ledgerRetentionMs).map(identity));
    return { failed, reap };
  };
  /**
   * Applies the decisions to the ledger as it is now, not as it was read before the panes were
   * closed: a launcher that appended a record meanwhile keeps it, and a record that settled
   * meanwhile is not failed over its own result.
   */
  const apply = <R extends Settleable>(kind: 'review' | 'producer', records: R[], decided: { failed: Map<string, { resolution: string }>; reap: Set<string> }) => {
    let changed = false;
    const kept = records.filter(record => {
      const fail = decided.failed.get(identity(record));
      if (fail && record.state === 'pending') { Object.assign(record, { state: 'failed', resolution: fail.resolution, closedAt: report.at }); changed = true; }
      return !(decided.reap.has(identity(record)) && record.state !== 'pending');
    });
    report.reaped[kind] = records.length - kept.length;
    return { records: kept, changed: changed || kept.length !== records.length };
  };
  try {
    const decided = await reclaimLedger('review', (await readReviewLedger(root)).reviews, config.reviewers);
    if (decided.failed.size || decided.reap.size) await updateReviewLedger(root, ledger => { ledger.reviews = apply('review', ledger.reviews, decided).records; });
  } catch (error) { report.errors.push(`Review ledger: ${error instanceof Error ? error.message : String(error)}`); }
  try {
    const decided = await reclaimLedger('producer', (await readProducerLedger(root)).producers, config.producers);
    if (decided.failed.size || decided.reap.size) {
      const ledger = await readProducerLedger(root);
      const result = apply('producer', ledger.producers, decided);
      if (result.changed) await saveProducerLedger(root, { ...ledger, producers: result.records });
    }
  } catch (error) { report.errors.push(`Producer ledger: ${error instanceof Error ? error.message : String(error)}`); }
  const took = !!(report.reaped.review || report.reaped.producer || report.closed.length || report.released.length || report.errors.length);
  if (took || JSON.stringify(seen) !== JSON.stringify(file.seen)) {
    try { await atomicPrivateWrite(resourceReportFile(root), { version: 1, reports: (took ? [...file.reports, report] : file.reports).slice(-retainedReports), seen }); }
    catch (error) { report.errors.push(`Recording the reclaim: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return report;
}

/** One line for the loop's action record: what the pass took back. */
export function describeReclaim(report: ResourceReclaimReport) {
  const parts = [
    report.reaped.review || report.reaped.producer ? `reaped ${report.reaped.review} review and ${report.reaped.producer} producer ledger record(s)` : '',
    report.closed.length ? `closed ${report.closed.length} finished session(s) and released their names (${report.closed.map(entry => entry.name).join(', ')})` : '',
    report.released.length ? `released ${report.released.length} stuck session slot(s) (${report.released.map(entry => entry.name).join(', ')})` : '',
    report.errors.length ? `${report.errors.length} could not be reclaimed: ${report.errors[0]}` : '',
  ].filter(Boolean);
  return parts.length ? `Resource reclaim: ${parts.join('; ')}` : null;
}

// ---- The plane's health ------------------------------------------------------------------------

/**
 * Whether the plane can record anything: a write in a transaction that is rolled back. A
 * read-only database, a standby, or a role without write privilege refuses it; a database that
 * cannot be reached refuses it too.
 */
export async function probeWrites(pool: { connect(): Promise<{ query(sql: string): Promise<unknown>; release(): void }> }): Promise<string | null> {
  let client: Awaited<ReturnType<typeof pool.connect>> | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    try {
      await client.query('UPDATE graphyard_schema SET version = version WHERE false');
      await client.query('SELECT pg_current_xact_id()');
    } finally { await client.query('ROLLBACK').catch(() => {}); }
    return null;
  } catch (error) { return error instanceof Error ? error.message : String(error); }
  finally { client?.release(); }
}

/**
 * The plane's database size against its declared bound. The default bound is a guess at a volume
 * nobody sized, so it is advisory: `master status` warns on it, but only a configured bound fails health.
 */
export async function readDatabaseCapacity(pool: { query(sql: string): Promise<{ rows: any[] }> }, env: NodeJS.ProcessEnv = process.env): Promise<PlaneReading> {
  const configured = Number(env.GRAPHYARD_DATABASE_MAX_BYTES);
  const set = Number.isFinite(configured) && configured > 0;
  const bound = set ? configured : defaultDatabaseMaxBytes;
  try {
    const used = Number((await pool.query('SELECT pg_database_size(current_database()) AS size')).rows[0].size);
    // The largest tables, so growth is attributed from outside the database (a catalogue read, no scan).
    const tables = await pool.query(`SELECT relname AS table, pg_total_relation_size(c.oid) AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = 'public' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 6`).then(r => r.rows.map(row => ({ table: String(row.table), bytes: Number(row.bytes) })), () => undefined);
    return { used, bound, advisory: !set, ...(tables ? { tables } : {}), detail: `pg_database_size against ${set ? 'GRAPHYARD_DATABASE_MAX_BYTES' : 'the default bound (GRAPHYARD_DATABASE_MAX_BYTES unset; it warns but does not fail health)'}` };
  } catch (error) { return { used: null, bound, advisory: !set, detail: `pg_database_size could not be read: ${error instanceof Error ? error.message : String(error)}` }; }
}

const budgetCache = new WeakMap<object, { at: number; reading: PlaneReading }>();
/** The installation's documented minimum hourly limit: the bound shown for a pause before any budget read succeeded. */
const minimumInstallationLimit = 5000;
/**
 * The App installation's core budget, read at most once a minute; `/rate_limit` costs nothing
 * against it. The client pauses every request once a rate limit refuses one (src/github.ts), and
 * only a rate limit pauses it, so a live pause is the budget spent: it reads as used to its bound
 * until the pause ends, and no request is made while it lasts.
 */
export async function readGitHubBudget(github: object | null, now = Date.now()): Promise<PlaneReading | null> {
  if (!github) return null;
  const client = github as unknown as { blockedUntil?: number; apiRequest(path: string): Promise<any> };
  const paused = () => {
    const until = client.blockedUntil ?? 0;
    if (until <= now) return null;
    const bound = budgetCache.get(github)?.reading.bound ?? minimumInstallationLimit;
    return { used: bound, bound, detail: `the GitHub client paused every request until ${new Date(until).toISOString()} after a rate-limit refusal; the budget is spent until then` };
  };
  const pause = paused();
  if (pause) return pause;
  const cached = budgetCache.get(github);
  if (cached && now - cached.at < 60_000) return cached.reading;
  let reading: PlaneReading;
  try {
    // The client's own authenticated request path; /rate_limit is not a repository route.
    const body = await client.apiRequest('/rate_limit');
    const core = body?.resources?.core ?? body?.rate;
    reading = { used: Number(core.limit) - Number(core.remaining), bound: Number(core.limit), detail: `${core.remaining} of ${core.limit} left; resets ${new Date(Number(core.reset) * 1000).toISOString()}` };
  } catch (error) {
    // The read itself may be the request a rate limit refused, which starts the pause.
    const started = paused();
    if (started) return started;
    reading = { used: null, bound: null, detail: `GET /rate_limit failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  budgetCache.set(github, { at: now, reading });
  return reading;
}

/**
 * The plane's own health: unhealthy while writes are refused or a resource it owns is exhausted,
 * each cause named. A plane that cannot record results must not be dispatched into. A database
 * at an advisory (default) bound is reported by `master status`, not here.
 */
export function planeVerdict(writeError: string | null, resources: { database: PlaneReading | null; github: PlaneReading | null }) {
  const causes: string[] = [];
  if (writeError) causes.push(`Writes are refused: ${writeError}`);
  const exhausted = (reading: PlaneReading | null) => !!reading && reading.used !== null && reading.bound !== null && reading.used >= reading.bound;
  if (exhausted(resources.database) && !resources.database!.advisory) causes.push(`Control-plane database is at its bound: ${resources.database!.used} of ${resources.database!.bound} bytes (${resources.database!.detail ?? 'pg_database_size'}); grow the volume and raise GRAPHYARD_DATABASE_MAX_BYTES`);
  if (exhausted(resources.github)) causes.push(`GitHub App request budget is at its bound: ${resources.github!.used} of ${resources.github!.bound} requests (${resources.github!.detail ?? ''}); observations stop until the reset`);
  return { healthy: causes.length === 0, writable: !writeError, causes };
}

/**
 * The loop's gate before it dispatches: the plane must be able to record what a launch produces.
 * Returns the reason not to dispatch, or null. An unreachable plane is a reason too.
 */
export async function dispatchRefusal(url: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetcher(`${url.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(10_000) });
    const body = await response.json().catch(() => ({})) as { healthy?: boolean; causes?: string[] };
    if (response.ok && body.healthy !== false) return null;
    return `the control plane reports itself unhealthy (${(body.causes ?? [`HTTP ${response.status}`]).join('; ')}), so nothing is dispatched into a plane that cannot record the result`;
  } catch (error) { return `the control plane's /healthz could not be read (${error instanceof Error ? error.message : String(error)}), so nothing is dispatched into a plane that may not record the result`; }
}
