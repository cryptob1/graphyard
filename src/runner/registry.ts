import type { Run, RunRecord } from './types.js';
import type { LaunchedRun } from '../session-tail.js';
import { surfacePane } from './herdr-surface.js';

/**
 * The runs this process started (GY-169). A headless run has no pane, so Herdr cannot list it;
 * the loop reads this registry beside its Herdr inventory instead (master.ts listHerdrAgents). A
 * live run reads as a working session under its session name; an ended one, and a run this process
 * never started, is absent: the same "gone" a closed pane is, judged by the same supervision. An
 * ended run's record stays readable here for a while after.
 */
export interface RegisteredRun {
  name: string;
  role: 'approver' | 'producer';
  work: string;
  /** The producer ledger record id, or the decision id, the run answers. */
  subject: string;
  run: Run<unknown>;
  /** The managed directory the run works in, when it was given one (the approver's, GY-391): a reclaim pass leaves it while the run lives. */
  checkout?: string;
  /** The runner's name, the account it runs on and when it started, for the live session view (GY-713). */
  runtime?: string; account?: string | null; startedAt?: string;
  /** Filled in when the run ends and its payload was applied. */
  record: RunRecord | null;
  endedAt: number | null;
}

const retentionMs = 30 * 60_000;
const runs = new Map<string, RegisteredRun>();

const prune = (now = Date.now()) => { for (const [name, entry] of runs) if (entry.endedAt !== null && now - entry.endedAt > retentionMs) runs.delete(name); };

export function registerRun(entry: Omit<RegisteredRun, 'record' | 'endedAt'>) {
  prune();
  const live = runs.get(entry.name);
  if (live && live.endedAt === null) throw new Error(`A ${live.role} run named ${entry.name} is already running for ${live.work}`);
  const registered: RegisteredRun = { ...entry, record: null, endedAt: null };
  runs.set(entry.name, registered);
  return registered;
}
export function endRun(name: string, record: RunRecord) {
  const entry = runs.get(name);
  if (entry) Object.assign(entry, { record, endedAt: Date.now() });
}
export const registeredRun = (name: string) => { prune(); return runs.get(name) ?? null; };
export const registeredRunFor = (subject: string) => { prune(); return [...runs.values()].find(entry => entry.subject === subject) ?? null; };
export const liveRun = (name: string) => { const entry = registeredRun(name); return entry && entry.endedAt === null ? entry : null; };

/** The managed directories live runs work in: not a reclaim pass's to take. */
export const liveRunCheckouts = () => { prune(); return [...runs.values()].filter(entry => entry.endedAt === null && entry.checkout).map(entry => entry.checkout!); };
/** The live runs as Herdr-shaped sessions: no pane, and a working status. */
export function runnerAgents(): { name: string; agent: string; agent_status: string }[] {
  prune();
  return [...runs.values()].filter(entry => entry.endedAt === null).map(entry => ({ name: entry.name, agent: 'pi', agent_status: 'working' }));
}
/** The Herdr inventory with this process's runs beside it; a name Herdr lists wins. */
export function withRunnerAgents<A extends { name?: string }>(agents: A[]): (A | ReturnType<typeof runnerAgents>[number])[] {
  const named = new Set(agents.map(agent => agent.name));
  return [...agents, ...runnerAgents().filter(agent => !named.has(agent.name))];
}

/** The live runs as the loop's session-tail roster reads them (GY-713): their log, and their pane when they run in Herdr. */
export function launchedRuns(): LaunchedRun[] {
  prune();
  return [...runs.values()].filter(entry => entry.endedAt === null).map(entry => ({ name: entry.name, work: entry.work, role: entry.role, runtime: entry.runtime ?? 'pi',
    account: entry.account ?? null, startedAt: entry.startedAt ?? null, log: entry.run.log ?? null, pane: surfacePane(entry.run.id) }));
}

/** Test seam: forget every run. */
export function clearRuns() { for (const entry of runs.values()) if (entry.endedAt === null) entry.run.cancel('the registry was cleared'); runs.clear(); }
