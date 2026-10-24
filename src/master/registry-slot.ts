// Concern: the agent-registry session a reviewer or producer session was launched under, ended
// when that session's work is over (GY-2944), so a finished review or proof stops consuming its
// role's concurrency. The launch recorded the registry session on its ledger record
// (`record.session`); this is the release side of that promise.
import { httpFleetClient, type FleetClient } from '../fleet.js';
import { readProducerLedger } from '../producer.js';
import { readReviewLedger } from '../reviewer.js';
import type { MasterConfig } from './profiles.js';

/** The review or proof session whose slot is released: what the item's session handle carries. */
export interface RegistrySlot { key: string; id: string; kind: 'review' | 'proof'; head: string | null; pane: string | null; agentName: string | null }

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
