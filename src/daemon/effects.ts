// Concern: the effects a cycle acts through — their interface and cursor records; the production wiring lives beside it in ./effects-production.ts.
import type { Work } from '../model.js';
import type { SessionHandleInput } from '../model/sessions.js';
import type { WorkerProfile, HerdrAgent, ProfileAccountHealth } from '../master.js';
import type { MasterSessionEffects } from '../master/master-session.js';
import { type DaemonAction, type DaemonState, type LoopRelease, storeAction } from './state.js';
import type { MergeWriterReads } from './cycle-merge-writer.js';
import type { AdoptedRun } from './run-adoption.js';
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

/** GY-852: paste by pane_id, else name (profiles reuse names across sessions). */
export const promptTarget = (agent: Pick<HerdrAgent, 'name' | 'pane_id'>) => agent.pane_id ?? agent.name ?? '';

export interface DaemonEffects {
  /** The coordination read: the work snapshot, one GET. */
  snapshot: () => Promise<{ work: Work[]; now: string }>;
  /** Herdr's agent inventory: an empty list when Herdr cannot be read. */
  agents: () => HerdrAgent[] | Promise<HerdrAgent[]>;
  /** The same inventory with whether it could be read at all. */
  herdr?: () => { agents: HerdrAgent[]; available: boolean } | Promise<{ agents: HerdrAgent[]; available: boolean }>;
  credentials: (profiles: WorkerProfile[]) => Promise<Record<string, { available: boolean; reason: string | null; accounts?: ProfileAccountHealth[] }>>;
  closeSession: (pane: string) => void | Promise<void>;
  /** Records a session's handle on its item: the launch writes it running, the close step finished. */
  recordSession?: (work: Work, handle: SessionHandleInput) => Promise<unknown>;
  /** The control plane's reconciliation of an item whose lease lapsed with nothing submitted (`POST work/:id/resync`). */
  reclaimLease?: (work: Work) => Promise<unknown>;
  /** Removes an ended attempt's worktree (never forced); whether one was removed. */
  removeWorktree?: (path: string) => Promise<boolean>;
  /** Removes the managed checkouts no live session owns past their grace. */
  sweepCheckouts?: () => Promise<unknown>;
  dispatch: (work: Work, profile: WorkerProfile, agents: HerdrAgent[], snapshot: { work: Work[]; now: string }) => Promise<unknown>;
  /** Returns one head to a worker with the master's own operator-agent identity (`POST work/:id/rework`). */
  rework?: (work: Work, reason: string, binding?: string) => Promise<unknown>;
  /** One reviewer and producer dispatch tick over the cycle's snapshot (auto-dispatch.ts). */
  dispatchTick?: (snapshot: { work: Work[]; now: string }) => Promise<unknown>;
  /** The loop's own master session (GY-898): absent, none is launched. */
  masterSession?: MasterSessionEffects;
  /** Types one prompt into a session's pane. */
  promptSession?: (agent: HerdrAgent, text: string) => void | Promise<void>;
  /** The control-plane merge executor's reads (cycle-merge-writer.ts); absent, the merge writer does nothing. */
  mergeWriter?: MergeWriterReads | null;
  /** The headless runs a restart left running (GY-453). */
  adoptRuns?: () => Promise<AdoptedRun[]>;
  /** Tells the process supervisor the loop is alive, so a hung cycle becomes a restart. */
  notify?: (state: 'ready' | 'alive') => void | Promise<void>;
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
