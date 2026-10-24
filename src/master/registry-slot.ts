// Concern: the agent-registry session a reviewer or producer session was launched under, ended
// when that session's work is over (GY-2944), so a finished review or proof stops consuming its
// role's concurrency. The launch recorded the registry session on its ledger record
// (`record.session`); this is the release side of that promise.
import { httpFleetClient, type FleetClient } from '../fleet.js';
import { launchGraceMs, liveSessions } from '../model/registry-sessions.js';
import { readProducerLedger } from '../producer.js';
import { readReviewLedger } from '../reviewer.js';
import type { AgentRegistry } from '../model/registry.js';
import type { MasterConfig } from './profiles.js';

/** The review or proof session whose slot is released: what the item's session handle carries. */
export interface RegistrySlot { key: string; id: string; kind: 'review' | 'proof'; head: string | null; pane: string | null; agentName: string | null }
/** A live registry session of this host no Herdr pane backs, with the pane that would back it. */
export interface OrphanedRegistrySession { id: string; role: string; work: string | null; pane: string; agentName: string | null }

/**
 * The live reviewer or producer sessions of `host` that no pane of `agents` backs (GY-2945): a
 * session whose launching loop died before any miss has no handle in the successor loop, so the
 * ledgers are what name its pane — the record that launched under the session (`record.session`).
 * A session inside its launch grace is still starting and is never judged, and one whose record
 * names no pane (a launch that never confirmed one, or a headless run) is left to the passes that
 * own it. `agents` null is a listing that could not be read: a gap, never a miss. Pure.
 */
export function orphanedRegistrySessions(registry: AgentRegistry, host: string | null | undefined, agents: { pane_id?: string }[] | null,
  records: { session?: string; pane?: string | null; agentName?: string | null; runtime?: string }[], now: number): OrphanedRegistrySession[] {
  if (!agents) return [];
  const panes = new Set(agents.map(agent => agent.pane_id).filter((pane): pane is string => !!pane)), named = new Map(records.filter(record => record.session).map(record => [record.session!, record]));
  const orphans: OrphanedRegistrySession[] = [];
  for (const session of liveSessions(registry)) {
    if (session.host !== host || (session.role !== 'reviewer' && session.role !== 'producer')) continue;
    if (now - Date.parse(session.selectedAt) < launchGraceMs) continue;
    const record = named.get(session.id);
    if (!record?.pane || record.runtime === 'pi' || panes.has(record.pane)) continue;
    orphans.push({ id: session.id, role: session.role, work: session.work, pane: record.pane, agentName: record.agentName ?? null });
  }
  return orphans;
}

/**
 * The registry document the dispatch step reconciles this host's sessions against (GY-2945), or
 * null when this configuration names no control plane or the control plane cannot be asked — a
 * gap the next tick retries, never a judgment.
 */
export async function registryDocument(config: Pick<MasterConfig, 'url' | 'credentialFile'>, fetcher?: typeof fetch): Promise<AgentRegistry | null> {
  if (!config.url) return null;
  try { return await httpFleetClient({ url: config.url, credentialFile: config.credentialFile }, fetcher).document(); }
  catch { return null; }
}

/** End one live registry session by id, with the reason its reconciliation judged (GY-2945). */
export async function endRegistrySessionById(config: Pick<MasterConfig, 'url' | 'credentialFile'>, id: string, reason: string, client: FleetClient | null = null): Promise<void> {
  await (client ?? httpFleetClient({ url: config.url!, credentialFile: config.credentialFile })).end(id, reason.slice(0, 500));
}

/**
 * The registry session the ledgers record for one review or proof session, matched by the
 * dispatch request the handle answers (`record.requestId === handle.id`), or by head and pane
 * for a record that named no request. Null when no record of this host names one — a launch the
 * registry did not choose leaves nothing to release.
 */
export async function registrySlotOf(root: string, session: RegistrySlot): Promise<string | null> {
  const records = session.kind === 'review' ? (await readReviewLedger(root)).reviews : (await readProducerLedger(root)).producers;
  const match = records.filter(record => record.key === session.key && !!record.session
    && (record.requestId ? record.requestId === session.id : record.sha === session.head && record.pane === session.pane));
  return match.find(record => record.state === 'pending')?.session ?? match.at(-1)?.session ?? null;
}

/**
 * End the session's registry slot with the reason the close step judged, and return the id that
 * was ended (null when no ledger record named a session). The registry itself is idempotent: a
 * session something else ended first takes only the reason's outcome.
 */
export async function endRegistrySlot(root: string, config: Pick<MasterConfig, 'url' | 'credentialFile'>, session: RegistrySlot, reason: string,
  client: FleetClient | null = null): Promise<string | null> {
  const id = await registrySlotOf(root, session);
  if (!id) return null;
  await (client ?? httpFleetClient({ url: config.url, credentialFile: config.credentialFile })).end(id, reason.slice(0, 500));
  return id;
}
