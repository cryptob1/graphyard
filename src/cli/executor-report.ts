import { agentOwner, loadMasterConfig, type AttentionItem } from '../master.js';
import type { Work } from '../model.js';
import { openActions } from '../model/actions.js';
import { describeUnserved, executorLiveMs, withLoopMerger, type ExecutorReport, type ReportedLoopMerger } from '../model/executor-presence.js';
import { executorSupervisionStatus, executorUnit, type SystemctlRunner } from '../repository-setup.js';
import { detectLoopMerger } from '../executor.js';
import { executorRestartTimeoutMs } from '../executor-fleet.js';
import { execFileSync } from 'node:child_process';

/**
 * The executor fleet as `master status` reports it (GY-105): who is alive to claim, judged by the
 * control plane from the polls it sees; every pending action whose kind none of them serves, with
 * its wait and what to start; and what this host declared and what systemd says of each slot.
 *
 * Two observations, deliberately kept apart. Presence comes from the control plane, because it is
 * the one place every executor on every host reports to. Supervision comes from this host, because
 * the unit to start is a local one. An unserved kind is named with the local unit when this host
 * declared executors and one of them is down, and with the generic command otherwise.
 *
 * A live master loop on this host is the installation's merger (GY-245): its pending merge rows
 * wait on the loop, so they are never named unserved here, whatever the control plane last saw
 * (GY-916). Without a live loop the report and its start command are the control plane's own.
 */

export interface ExecutorFleet {
  /** What the control plane saw; null when the deployed server predates presence reporting. */
  presence: (ExecutorReport & { available: true }) | { available: false; reason: string; live: []; served: []; unserved: []; liveMs: number; loop?: ReportedLoopMerger | null };
  supervision: Awaited<ReturnType<typeof executorSupervisionStatus>>;
  /** One line per unserved kind, longest wait first. */
  unserved: ReturnType<typeof describeUnserved>;
  /** Each declared slot as systemd or, without a user manager, the control plane sees it (GY-1431). */
  slots: SlotObservation[];
  /**
   * Why nothing serves the unserved kinds (GY-1432): `slots-down` when a declared slot is down past
   * the upgrade bound — start it — apart from `no-capacity`, where no declared slot is down;
   * `restarting` while every down slot is inside the bound, which raises nothing; `served` otherwise.
   */
  capacity: 'served' | 'no-capacity' | 'restarting' | 'slots-down';
  attention: AttentionItem[];
}

/**
 * A slot systemd is stopping is in a transition, not down (GY-1086): every restart — the loop's
 * self-upgrade restarting the fleet, an operator's — passes through it, and a stop that holds reads
 * `inactive` on the next observation. A slot starting (`activating`) stays judged: a crash loop
 * sits there between its failures.
 */
export const slotDown = (active: string) => active !== 'active' && active !== 'deactivating' && active !== 'reloading';

/**
 * One declared slot as it can be seen (GY-1431): systemd's state where this host has a user manager
 * to ask, otherwise the control plane's presence — a supervised slot claims as `<principal>@<host>/<slot>`,
 * so a declared slot with no live executor of that name on this host is down. On 2026-10-07 the loop
 * read no user manager, and both slots of this host lay inactive with three dispatches requested.
 */
export interface SlotObservation {
  slot: number; unit: string; active: string; seenBy: 'systemd' | 'presence';
  /** How long a stopped slot has been down, from systemd (GY-1432); null when it cannot say. */
  downMs?: number | null;
}

/**
 * How long a declared slot may stay stopped before it pages (GY-1432): the fleet restart's own wait
 * for a slot to register again. A self-upgrade stops and starts each slot in seconds, so a slot
 * systemd reads `inactive` inside this bound is mid-upgrade and raises nothing — neither the slot
 * fault nor a slots-down unserved line. Only a stopped slot systemd can date is given the bound: a
 * `failed` slot, one `activating` between the crashes of a restart loop, or one read from presence
 * is no upgrade in passage.
 */
export const slotUpgradeBoundMs = executorRestartTimeoutMs;
/** How long ago the unit last left `active`, from systemd, against `now` read from this host's clock; null when it never was or the reading fails. */
export function slotDownMs(run: SystemctlRunner, unit: string, now: number): number | null {
  try {
    const value = run(['show', unit, '-p', 'ActiveExitTimestamp', '--value', '--timestamp=unix']).trim();
    const seconds = /^@(\d+(?:\.\d+)?)$/.exec(value)?.[1];
    return seconds ? Math.max(0, now - Number(seconds) * 1000) : null;
  } catch { return null; }
}
/** Whether a down slot is past the upgrade bound, and so pages. */
export const slotPaged = (entry: SlotObservation) => !(entry.seenBy === 'systemd' && entry.active === 'inactive' && typeof entry.downMs === 'number' && entry.downMs < slotUpgradeBoundMs);
const defaultSystemctl: SystemctlRunner = args => execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }).trim();
const duration = (ms: number) => ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}h${Math.floor(ms % 3_600_000 / 60_000)}m` : ms >= 60_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 1000)}s`;
const downFor = (entry: SlotObservation) => typeof entry.downMs === 'number' ? ` for ${duration(entry.downMs)}, past the ${duration(slotUpgradeBoundMs)} upgrade bound` : '';
export function executorSlots(supervision: ExecutorFleet['supervision'], presence: ExecutorFleet['presence'], hostId: string | null): SlotObservation[] {
  if (supervision.units.length) return supervision.units.map(unit => ({ ...unit, seenBy: 'systemd' as const }));
  if (!supervision.declaration || supervision.supervised || !presence.available || (presence as ExecutorReport).listening || !hostId) return [];
  return Array.from({ length: supervision.declaration.count }, (_, index) => {
    const slot = index + 1;
    const live = presence.live.some(entry => entry.host === hostId && entry.executor.endsWith(`@${hostId}/${slot}`));
    return { slot, unit: executorUnit(slot), active: live ? 'active' : 'inactive', seenBy: 'presence' as const };
  });
}

/**
 * A declared slot that is down is a resources fault of its own (GY-1431): the host is one executor
 * short of what it declared, and nothing it would claim is queued behind other work — the fleet is
 * down, not saturated. The line names the unit and the journalctl command that says why it stopped,
 * and it stands until the unit is observed active again; a stop in progress is a transition (GY-1086).
 */
export function executorSlotFaults(slots: SlotObservation[], declared: number, reason: string | null = null): AttentionItem[] {
  return slots.filter(entry => slotDown(entry.active) && slotPaged(entry)).map(entry => ({
    subject: 'executors', kind: 'resource-bound' as const, faultClass: 'resources' as const, resource: entry.unit,
    text: `Executor slot ${entry.slot} is ${entry.active}${downFor(entry)} although this host declares ${declared} slot(s)${entry.seenBy === 'presence' ? ` (read from the control plane: no executor claims as slot ${entry.slot} of this host${reason ? `; ${reason}` : ''})` : ''}; journalctl --user -u ${entry.unit} -n 200 says why it stopped, and the fault stands until ${entry.unit} is active again`,
    ...agentOwner('master', `systemctl --user start ${entry.unit} on this host, then journalctl --user -u ${entry.unit} -n 200 for why it stopped`),
  }));
}

export async function executorFleet(root: string, masterApi: (path: string) => Promise<any>, snapshot: { work: Work[]; now: string }, run?: SystemctlRunner, merger?: ReportedLoopMerger | null | (() => Promise<{ name: string; live?: boolean } | null>), hostId?: string | null): Promise<ExecutorFleet> {
  const resolvedLoop = typeof merger === 'function' ? await merger().catch(() => null) : merger;
  // The loop on this host, read from its cursor's live lock when the caller did not name it.
  const loop: ReportedLoopMerger | null = resolvedLoop !== undefined
    ? (resolvedLoop ? { live: (resolvedLoop as any).live !== false, name: resolvedLoop.name } : null)
    : await detectLoopMerger(root).catch(() => null);
  const supervision = await executorSupervisionStatus(root, run);
  let presence: ExecutorFleet['presence'];
  try {
    const answer = (await masterApi('actions')).executors as ExecutorReport | undefined;
    presence = answer ? { ...withLoopMerger(answer, loop), available: true } : { available: false, reason: 'the deployed server reports no executor presence; deploy main so GET /api/actions carries executors', live: [], served: [], unserved: [], liveMs: executorLiveMs };
  } catch (error) { presence = { available: false, reason: `GET /api/actions failed: ${error instanceof Error ? error.message : String(error)}`, live: [], served: [], unserved: [], liveMs: executorLiveMs }; }
  const unserved = describeUnserved(presence);
  const slots = executorSlots(supervision, presence, hostId !== undefined ? hostId : await loadMasterConfig(root).then(config => config.hostId ?? null, () => null));
  // systemd dates the stop by this host's clock, so its age is read against the same clock, never
  // the control plane's `snapshot.now`: a skew between the two would page mid-upgrade or hide a slot down.
  const hostNow = Date.now();
  for (const entry of slots) if (entry.seenBy === 'systemd' && entry.active === 'inactive') entry.downMs = slotDownMs(run ?? defaultSystemctl, entry.unit, hostNow);
  // Only slots down past the upgrade bound are down here: one inside it is mid-upgrade (GY-1432).
  const down = slots.filter(entry => slotDown(entry.active) && slotPaged(entry));
  const restarting = slots.some(entry => slotDown(entry.active)) && !down.length;
  const capacity: ExecutorFleet['capacity'] = !unserved.length ? 'served' : down.length && supervision.declaration ? 'slots-down' : restarting ? 'restarting' : 'no-capacity';
  // The dispatcher's two reasons for an unrun row are told apart (GY-1431): slots this host declared
  // are down, which a start answers, or every live executor is busy, which only capacity answers.
  const startDown = `systemctl --user start ${down.map(entry => entry.unit).join(' ')}`;
  const attention: AttentionItem[] = restarting ? [] : unserved.map(entry => ({ subject: entry.keys[0],
    text: down.length ? `${entry.text} This host's executor slots are down, not saturated: ${down.map(slot => `${slot.unit} ${slot.active}${downFor(slot)}`).join(', ')}.` : entry.text,
    ...agentOwner('master', supervision.declaration && down.length ? startDown : `${entry.start}; on this host: ${supervision.start}`) }));
  // Without presence the control plane cannot say who is alive, but a host whose every declared
  // slot is down while rows are pending is unserved from here, and is named as such.
  const pending = openActions(snapshot.work, new Date(snapshot.now)).filter(({ row }) => !(loop?.live && row.kind === 'merge'));
  if (!presence.available && pending.length && supervision.units.length && supervision.units.every(unit => slotDown(unit.active)) && down.length) {
    attention.push({ subject: pending[0].row.key, text: `Every declared executor slot on this host is down (${supervision.units.map(unit => `${unit.unit} ${unit.active}`).join(', ')}) while ${pending.length} action(s) are pending, the oldest ${pending[0].row.kind} for ${pending[0].row.key} since ${pending[0].row.requestedAt}; ${presence.reason}`, ...agentOwner('master', supervision.start) });
  }
  // A declared slot that is not running is a fault on its own: the fleet is one short of what the
  // host said it runs, whether or not anything is unserved yet, and it pages until the slot is back.
  if (supervision.declaration) attention.push(...executorSlotFaults(slots, supervision.declaration.count, supervision.reason));
  return { presence, supervision, unserved, slots, capacity, attention };
}
