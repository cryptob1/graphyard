import type { RuntimeSession } from '../model/sessions.js';
import type { SessionInventory } from '../session-inventory.js';
// Concern: the effects a cycle acts through — their interface and cursor records; the production wiring lives beside it in ./effects-production.ts.
import type { Work } from '../model.js';
import type { SessionHandle, SessionHandleInput } from '../model/sessions.js';
import type { ExhaustionSignal, PartialWork } from '../model/capacity.js';
import type { RegistrySlot } from '../master/registry-slot.js';
import type { AgentRegistry, CanaryOffer, FleetRuntime } from '../model/registry.js';
import type { MasterConfig, WorkerProfile } from '../master/profiles.js';
import type { ProfileAccountHealth } from '../master/environments.js';
import type { CheckoutTrustRefusal } from '../harness.js';
import type { MasterSessionEffects } from '../master/master-session.js';
import { type DaemonAction, type DaemonState, type LeftoverDisk, type LoopRelease, storeAction } from './state.js';
import type { MergeWriterReads } from './cycle-merge-writer.js';
import type { AdoptedRun } from './run-adoption.js';
import type { ComposeServer } from './compose-recovery.js';
export { snapshotRetryDelayMs, retriedSnapshot } from './snapshot-retry.js';

/** GY-1713: body `error` + zod `issues` so a refusal names the refused field; else stringify. */
export function refusedBodyDetail(result: unknown): string {
  if (!result || typeof result !== 'object') return JSON.stringify(result);
  const body = result as { error?: unknown; issues?: unknown };
  if (typeof body.error !== 'string') return JSON.stringify(result);
  const issues = Array.isArray(body.issues) ? body.issues : [];
  if (!issues.length) return body.error;
  const named = issues.map((issue: unknown) => {
    if (!issue || typeof issue !== 'object') return String(issue);
    const row = issue as { path?: unknown; message?: unknown };
    const path = Array.isArray(row.path) ? row.path.map(String).join('.') : '';
    const text = typeof row.message === 'string' ? row.message : String(issue);
    return path ? `${path}: ${text}` : text;
  }).join('; ');
  return `${body.error}: ${named}`;
}

export interface DaemonEffects {
  inventory?: () => Promise<SessionInventory>;
  /** The coordination read: the work snapshot, one GET. */
  snapshot: () => Promise<{ work: Work[]; now: string }>;
  /** Full session history, read only to recover ownership of leftover panes omitted by coordination. */
  sessionHistory?: (work: Work) => Promise<SessionHandle[]>;
  /** Herdr's agent inventory: an empty list when Herdr cannot be read. */
  agents: () => RuntimeSession[] | Promise<RuntimeSession[]>;
  /** The same inventory with whether it could be read at all. */
  herdr?: () => { agents: RuntimeSession[]; available: boolean } | Promise<{ agents: RuntimeSession[]; available: boolean }>;
  credentials: (profiles: WorkerProfile[]) => Promise<Record<string, { available: boolean; reason: string | null; accounts?: ProfileAccountHealth[] }>>;
  closeSession: (pane: string) => void | Promise<void>;
  /** Records a session's handle on its item: the launch writes it running, the close step finished. */
  recordSession?: (work: Work, handle: SessionHandleInput) => Promise<unknown>;
  /**
   * Delivers the loop's one stall re-prompt to a worker session's pane (GY-2943): the session's own
   * work, sent again by the loop that supervises it. Absent, no quiet session is re-prompted.
   */
  promptSession?: (session: SessionHandle, text: string) => Promise<unknown>;
  /** Sends a blocked session's runtime the keys that answer its own prompt (GY-2959): the reject choice the prompt classifier read off the pane. Absent, a blocked session is only ended stalled. */
  sessionKeys?: (session: Pick<SessionHandle, 'pane' | 'agentName'>, keys: string[]) => Promise<unknown>;
  /** The session's terminal, as text; null when the runtime cannot be read (the limit-notice judge reads it). A master pane is judged by pane and name alone. */
  sessionScreen?: (session: Pick<SessionHandle, 'pane' | 'agentName'>) => string | null | Promise<string | null>;
  /**
   * Ends a stalled worker attempt (GY-2943): records the capacity event that releases its lease —
   * `interrupted` when the pane showed no provider limit notice, `quota` with the notice's reset
   * when it did, so the account the notice spent is held for the fleet's next selection — leaving
   * the item dispatchable again. Absent, no stalled session is ended.
   */
  endStall?: (work: Work, session: SessionHandle, stall: { reason: string; notice: ExhaustionSignal | null }) => Promise<unknown>;
  /**
   * Ends a worker attempt whose lease lapsed with nothing submitted (GY-2953): keeps what the
   * attempt had not committed as one WIP commit on its own branch in its own worktree, and records
   * the capacity exhaustion that ends the lease with that partial work on the item — before any
   * cleanup — so the redispatch's handoff names the commit instead of silently starting from the
   * shared base. Returns the partial work recorded, or null when this host holds nothing of the
   * attempt. Absent, the lease is only reconciled. The lease is named by its epoch and owner
   * alone: a lease the control plane already reconciled (GY-2956) carries no expiry on the record.
   */
  endExpiredLease?: (work: Work, lease: Pick<NonNullable<Work['lease']>, 'epoch' | 'owner'>) => Promise<PartialWork | null>;
  /**
   * Reads how the attempt's assigned worktree stands (GY-2961): its HEAD commit and a fingerprint
   * of its uncommitted changes — the reading whose change is the worktree progress that extends
   * the attempt bound. Null when the worktree cannot be read. Absent, no progress is recorded.
   */
  worktreeState?: (space: { path: string; epoch: number }) => { head: string | null; dirty: string | null } | null | Promise<{ head: string | null; dirty: string | null } | null>;
  /**
   * Ends a worker attempt the attempt bound stopped (GY-2961): keeps what the attempt had not
   * committed as one WIP commit on its own branch (a successor receives the diff), and records the
   * capacity exhaustion that releases its lease with that partial work on the item. Returns the
   * partial work recorded, or null when this host holds nothing of the attempt. Absent, no
   * attempt is stopped at its bound.
   */
  endAttemptBound?: (work: Work, session: SessionHandle, why: string) => Promise<PartialWork | null>;
  /** Ends the agent-registry session a review or proof session was launched under (GY-2944): the ledgers name it; absent, nothing is released. */
  releaseRegistrySession?: (session: RegistrySlot, reason: string) => Promise<unknown>;
  /** The control plane's reconciliation of an item whose lease lapsed with nothing submitted (`POST work/:id/resync`). */
  reclaimLease?: (work: Work) => Promise<unknown>;
  /** Removes an ended attempt's worktree, forced only when asked (a done item's, a day after its last attempt ended); whether one was removed. */
  removeWorktree?: (path: string, force?: boolean) => Promise<boolean>;
  /** The free space of each volume Graphyard writes (GY-3122). Absent, no headroom is kept. */
  diskVolumes?: () => Promise<{ path: string; freeBytes: number | null }[]>;
  /** Reclaims Graphyard's own leftovers when free space is below the floor (GY-3122): what it removed, by name. */
  reclaimDisk?: () => Promise<string[]>;
  /** Removes the managed checkouts no live session owns past their grace. */
  sweepCheckouts?: () => Promise<unknown>;
  /** Stops what still runs naming a removed worktree (GY-3185), answering what was stopped. */
  stopOrphanedProcesses?: () => Promise<string[]>;
  /** Stops running trial containers whose checkout is gone or that outlived twice the trial deadline (GY-3186), answering what was stopped. */
  stopOrphanTrials?: () => Promise<string[]>;
  /** Takes back what ended jobs left: owner-gone trial and verification scratch, stopped trial containers with their volumes, and trial build cache older than a day (GY-3188), answering what was removed. */
  reclaimJobLeftovers?: () => Promise<string[]>;
  /** The disk Graphyard's leftovers hold, read once a day for the leftovers report (GY-3190). */
  leftoverDisk?: () => Promise<LeftoverDisk>;
  /**
   * `diagnosis` is the prompt section a run of repeated equal failures asks for (GY-3104); empty otherwise.
   * GY-3103: `canaries` are the newer runtime versions this launch may run as their canary (the
   * result's `canary` names the one it ran, with its start failure if any); `exclude` names the
   * accounts whose runtime backs off this item; `onRuntime` hears the runtime each launch chose.
   */
  dispatch: (work: Work, profile: WorkerProfile, agents: RuntimeSession[], snapshot: { work: Work[]; now: string }, launch?: { diagnosis?: string; canaries?: CanaryOffer[]; exclude?: string[]; onRuntime?: (kind: string) => void }) => Promise<unknown>;
  /** The agent registry, read for runtime canaries and launch back-off (GY-3103); absent, neither applies to registry accounts. */
  registry?: () => Promise<Pick<AgentRegistry, 'runtimes' | 'accounts' | 'roles'>>;
  /**
   * GY-3225: which registered Claude account launches in this host's checkout the folder-trust step
   * would refuse — the checkout carries repository Claude configuration, and the account's config
   * records neither it nor an ancestor trusted. The dispatch step holds the roles it names with one
   * standing attention line and launches nothing until it answers empty; absent, nothing is held.
   */
  checkoutTrust?: () => Promise<CheckoutTrustRefusal[]>;
  /** A registry runtime.set with its reason: how a passed canary switches its runtime (GY-3103). */
  setRuntime?: (runtime: FleetRuntime, reason: string) => Promise<unknown>;
  /** The spec check a released feature item owes before dispatch (GY-2992): one fresh-context reviewer session, whose report gates the dispatch. Absent, none is launched. */
  launchSpecCheck?: (work: Work) => Promise<{ pane?: string | null; launch: string; settled?: Promise<string | null> } | void>;
  /** The install's compose server (GY-2966), which the loop starts when the control plane stays unreachable; null when the install is not a compose install on this host. */
  composeServer?: () => ComposeServer | null | Promise<ComposeServer | null>;
  /** Returns one head to a worker with the master's own operator-agent identity (`POST work/:id/rework`). */
  rework?: (work: Work, reason: string, binding?: string) => Promise<unknown>;
  /** Records one real-world check on Needs you for the item's head (GY-2986). */
  askHumanProof?: (work: Work, proof: string) => Promise<unknown>;
  /** Releases one backlog item with the master's own operator-agent identity (`POST work/:id/ready`, GY-2991): the dispatch step keeps the pipeline full itself. Absent, nothing is released; `master release` stays for an out-of-order pull. */
  release?: (work: Work, reason: string) => Promise<unknown>;
  /** One reviewer and producer dispatch tick over the cycle's snapshot (dispatch/tick.ts). */
  dispatchTick?: (snapshot: { work: Work[]; now: string }) => Promise<unknown>;
  /** The loop's own master session (GY-898): absent, none is launched. */
  masterSession?: MasterSessionEffects;
  personalMasterSession?: (config: MasterConfig) => MasterSessionEffects;
  /** The control-plane merge executor's reads (cycle-merge-writer.ts); absent, the merge writer does nothing. */
  mergeWriter?: MergeWriterReads | null;
  /** The headless runs a restart left running (GY-453). */
  adoptRuns?: () => Promise<AdoptedRun[]>;
  /** Tells the process supervisor the loop is alive, so a hung cycle becomes a restart. */
  notify?: (state: 'ready' | 'alive') => void | Promise<void>;
  /** POSTs one plain-text line to the operator's alert webhook (GY-3101: `run.alertUrl`, any receiver that takes a body, such as an ntfy topic). Absent, no alert is sent. */
  alertWebhook?: (text: string) => Promise<void>;
  /** The release this process loaded, read once at startup. */
  loadedRelease?: LoopRelease | null;
  persist: (state: DaemonState) => Promise<void>;
}

/** Put an action on the cursor, through storeAction, which bounds it. */
export async function record(state: DaemonState, key: string, action: Omit<DaemonAction, 'at' | 'epoch'> & { at?: string; epoch?: number | null }, now: number, persist: DaemonEffects['persist']) {
  const entry = storeAction(state, key, { epoch: null, ...action, at: action.at ?? new Date(now).toISOString() });
  await persist(state);
  return entry;
}

// The production wiring lives in ./effects-production.ts.
export { daemonEffects } from './effects-production.js';
