// Concern: the account a session actually launched on, and the hold an item's repeated limit notices on one account place (GY-1582).
import type { Work } from '../model.js';
import type { CapacityRole, ExhaustionRecord } from '../model/capacity.js';
import type { MasterConfig } from './profiles.js';
import { observedExhaustions, readEnvironmentLog, recordObservedExhaustion, selectionKey, type ObservedExhaustion } from './environments.js';
import { readProfileLaunchRecords } from './dispatch.js';

/**
 * The account a role's session spent, for the hold its limit notice places (GY-1582). A worker
 * attempt is charged to the account its own launch record names — the account and runtime the
 * dispatch actually started it on — never to the profile's nominal account or to a selection the
 * environment log kept from an earlier launch: a profile named for one runtime can run on another
 * account entirely when its own are spent. Only a launch record of another attempt (or none) falls
 * back to the environment log's selection for the profile.
 */
export async function sessionAccount(root: string, config: Pick<MasterConfig, 'credentialFile'>, role: CapacityRole, profile: string, launch?: { work: string; epoch: number }): Promise<{ environment: string | null; kind: string | null } | null> {
  if (role === 'worker' && launch) {
    const record = (await readProfileLaunchRecords(root, [{ name: profile }]))[profile];
    if (record && record.key === launch.work && record.epoch === launch.epoch) return { environment: record.account, kind: record.runtime };
  }
  return (await readEnvironmentLog(config)).selected?.[selectionKey(role, profile)] ?? null;
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
 * of its quota exhaustions all name it and the latest is within `repeatedLimitWindowMs`. An attempt
 * interrupted for another cause ends the run, as does one on no named account.
 */
export function repeatedLimitAccount(work: Pick<Work, 'capacity'>, now = Date.now()): { account: string; records: ExhaustionRecord[] } | null {
  const worker = (work.capacity?.exhaustions ?? []).filter(entry => entry.role === 'worker');
  const last = worker.at(-1);
  if (!last?.account || (last.cause ?? 'quota') !== 'quota' || now - Date.parse(last.at) > repeatedLimitWindowMs) return null;
  const records: ExhaustionRecord[] = [];
  for (const entry of [...worker].reverse()) {
    if (entry.account !== last.account || (entry.cause ?? 'quota') !== 'quota') break;
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
export async function holdRepeatedLimitAccount(config: Pick<MasterConfig, 'credentialFile'> & Partial<Pick<MasterConfig, 'environments' | 'url' | 'hostId'>>, work: Pick<Work, 'key' | 'capacity'>, now = Date.now(), report?: Parameters<typeof recordObservedExhaustion>[4]): Promise<{ account: string; hold: ObservedExhaustion } | null> {
  const repeated = repeatedLimitAccount(work, now);
  if (!repeated || (await observedExhaustions(config, now))[repeated.account]) return null;
  const last = repeated.records.at(-1)!;
  const hold = await recordObservedExhaustion(config, repeated.account, { at: new Date(now).toISOString(), resetsAt: last.resetsAt, role: 'worker', profile: last.profile, work: work.key,
    reason: `${work.key}'s last ${repeated.records.length} worker launches (epochs ${repeated.records.map(entry => entry.epoch ?? '?').join(', ')}) each ended on ${repeated.account}'s limit notice: ${last.reason}` }, now, report);
  return { account: repeated.account, hold };
}
