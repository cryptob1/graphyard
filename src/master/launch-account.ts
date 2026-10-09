// Concern: the account a session actually launched on, and the hold an item's repeated limit notices on one account place (GY-1582).
import type { Work } from '../model.js';
import type { CapacityRole, ExhaustionRecord } from '../model/capacity.js';
import type { MasterConfig } from './profiles.js';
import { observedExhaustions, readEnvironmentLog, recordObservedExhaustion, selectionKey, sessionKeyOf, type LaunchRole, type ObservedExhaustion } from './environments.js';
import { readProfileLaunchRecords } from './dispatch.js';

/**
 * The selection of one session, beside its profile's latest: a role's item and, for a producer, its
 * proof group, of which one session is pending at a time. A profile that runs sessions concurrently
 * overwrites its latest selection with each launch, so a limit notice is charged by this. Each
 * selection writes it (recordEnvironmentLog), and it is pruned two days on.
 */
export const sessionSelectionKey = (role: LaunchRole, profile: string, work: string, group?: string | null) => sessionKeyOf(selectionKey(role, profile), work, group);
/** The session a limit notice was read from: a worker attempt's item and epoch, or a reviewer's or producer's item and proof group. */
export interface SessionIdentity { work: string; epoch?: number; group?: string | null }

/**
 * The account a role's session spent, for the hold its limit notice places (GY-1582). A worker
 * attempt is charged to the account its own launch record names — the account and runtime the
 * dispatch actually started it on — never to the profile's nominal account or to a selection the
 * environment log kept from an earlier launch: a profile named for one runtime can run on another
 * account entirely when its own are spent. Only a launch record of another attempt (or none) falls
 * back to the environment log's selection for the profile. A reviewer or producer session is read
 * by its own identity — its item and proof group, of which only one session is pending at a time —
 * never from the profile's latest selection, which a later concurrent session on another account
 * overwrites; a selection recorded before sessions were kept is used only when it was for this item.
 */
export async function sessionAccount(root: string, config: Pick<MasterConfig, 'credentialFile'>, role: CapacityRole, profile: string, session?: SessionIdentity): Promise<{ environment: string | null; kind: string | null } | null> {
  if (role === 'worker' && session?.epoch !== undefined) {
    const record = (await readProfileLaunchRecords(root, [{ name: profile }]))[profile];
    if (record && record.key === session.work && record.epoch === session.epoch) return { environment: record.account, kind: record.runtime };
  }
  const { selected } = await readEnvironmentLog(config);
  if (role !== 'worker' && session) {
    const own = selected[sessionSelectionKey(role, profile, session.work, session.group)];
    if (own) return own;
    const latest = selected[selectionKey(role, profile)];
    return latest?.work === session.work ? latest : null;
  }
  return selected[selectionKey(role, profile)] ?? null;
}

/**
 * How recent the last of an item's repeated limit notices on one account must be to hold it again:
 * two of the hours an account whose notice named no reset is held (`unknownResetHoldMs`), written
 * out because this module and environments.ts import each other through dispatch.ts.
 */
export const repeatedLimitWindowMs = 2 * 3_600_000;
/** How many consecutive worker launches of one item ending on one account's limit notice hold that account. */
export const repeatedLimitLaunches = 2;

/**
 * The account an item's latest worker launches each ended on, when the last `repeatedLimitLaunches`
 * of its quota exhaustions all name it, were recorded by consecutive launch epochs ending at the item's
 * latest launch, and the latest is within `repeatedLimitWindowMs`. An attempt interrupted for another
 * cause, or one that ended without a limit notice (a gap in the epochs), ends the run, as does one on
 * no named account. A repeat whose last notice named a reset that has since passed is over: the
 * account has recovered, and only a new notice after that reset starts another.
 */
export function repeatedLimitAccount(work: Pick<Work, 'capacity'> & Partial<Pick<Work, 'epoch'>>, now = Date.now()): { account: string; records: ExhaustionRecord[] } | null {
  const worker = (work.capacity?.exhaustions ?? []).filter(entry => entry.role === 'worker');
  const last = worker.at(-1);
  if (!last?.account || (last.cause ?? 'quota') !== 'quota' || typeof last.epoch !== 'number' || now - Date.parse(last.at) > repeatedLimitWindowMs) return null;
  // The item was launched again after its last notice, and that launch ended some other way.
  if (typeof work.epoch === 'number' && work.epoch !== last.epoch) return null;
  if (last.resetsAt && Date.parse(last.resetsAt) <= now) return null;
  const records: ExhaustionRecord[] = [];
  for (const entry of [...worker].reverse()) {
    const next = records[0]?.epoch ?? last.epoch + 1;
    if (entry.epoch === next && records.length) continue; // one launch's notice reported twice is one launch
    if (entry.account !== last.account || (entry.cause ?? 'quota') !== 'quota' || entry.epoch !== next - 1) break;
    records.unshift(entry);
  }
  return records.length >= repeatedLimitLaunches ? { account: last.account, records } : null;
}

/**
 * Before a worker launch of `work` (GY-1582): an account the item's consecutive launches each ended
 * on with its limit notice is not chosen a third time. Each notice holds its account as it is read,
 * but a hold that was charged elsewhere, or lapsed on an assumed reset, would let selection hand the
 * spent account back; here it is held again, until the last notice's reset or the assumed hour, so
 * the attempt is routed to an eligible account. Returns the hold placed, or null when none was needed.
 */
export async function holdRepeatedLimitAccount(config: Pick<MasterConfig, 'credentialFile'> & Partial<Pick<MasterConfig, 'environments' | 'url' | 'hostId'>>, work: Pick<Work, 'key' | 'capacity'> & Partial<Pick<Work, 'epoch'>>, now = Date.now(), report?: Parameters<typeof recordObservedExhaustion>[4]): Promise<{ account: string; hold: ObservedExhaustion } | null> {
  const repeated = repeatedLimitAccount(work, now);
  if (!repeated || (await observedExhaustions(config, now))[repeated.account]) return null;
  const last = repeated.records.at(-1)!;
  const hold = await recordObservedExhaustion(config, repeated.account, { at: new Date(now).toISOString(), resetsAt: last.resetsAt, role: 'worker', profile: last.profile, work: work.key,
    reason: `${work.key}'s last ${repeated.records.length} worker launches (epochs ${repeated.records.map(entry => entry.epoch ?? '?').join(', ')}) each ended on ${repeated.account}'s limit notice: ${last.reason}` }, now, report);
  return { account: repeated.account, hold };
}
