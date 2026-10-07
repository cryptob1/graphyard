import { agentOwner, type AttentionItem } from '../master.js';
import type { Work } from '../model.js';
import { openActions } from '../model/actions.js';
import { describeUnserved, executorLiveMs, withLoopMerger, type ExecutorReport, type ReportedLoopMerger } from '../model/executor-presence.js';
import { executorSupervisionStatus, type SystemctlRunner } from '../repository-setup.js';
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
  /**
   * Why nothing serves those kinds (GY-1432): `slots-down` when a declared slot on this host is
   * down past the upgrade bound — start it — apart from `no-capacity`, where every declared slot
   * runs and none serves the kind; `restarting` while every down slot is inside the bound, which
   * raises nothing; `served` when nothing is unserved.
   */
  capacity: 'served' | 'no-capacity' | 'restarting' | 'slots-down';
  /** Each declared slot that is down, with how long (null when systemd does not say) and whether it is past the bound. */
  slots: SlotDown[];
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
 * How long a declared slot may stay stopped before it pages the operator (GY-1432): the fleet
 * restart's own wait for a slot to register again. A self-upgrade stops and starts each slot in
 * seconds, so a slot `inactive` inside this bound is mid-upgrade and raises nothing; past it the
 * `systemctl --user start` attention names the unit. Only a stopped slot (`inactive`) is given the
 * bound: a `failed` slot, or one `activating` between the crashes of a restart loop, is no upgrade.
 */
export const slotUpgradeBoundMs = executorRestartTimeoutMs;
export interface SlotDown { slot: number; unit: string; active: string; downMs: number | null; paged: boolean }

/** How long ago the unit last left `active`, from systemd; null when it never was or the reading fails. */
export function slotDownMs(run: SystemctlRunner, unit: string, now: number): number | null {
  try {
    const value = run(['show', unit, '-p', 'ActiveExitTimestamp', '--value', '--timestamp=unix']).trim();
    const seconds = /^@(\d+(?:\.\d+)?)$/.exec(value)?.[1];
    return seconds ? Math.max(0, now - Number(seconds) * 1000) : null;
  } catch { return null; }
}
const defaultSystemctl: SystemctlRunner = args => execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }).trim();
const seconds = (ms: number) => ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}h${Math.floor(ms % 3_600_000 / 60_000)}m` : ms >= 60_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 1000)}s`;

export async function executorFleet(root: string, masterApi: (path: string) => Promise<any>, snapshot: { work: Work[]; now: string }, run?: SystemctlRunner, merger?: ReportedLoopMerger | null | (() => Promise<{ name: string; live?: boolean } | null>)): Promise<ExecutorFleet> {
  const resolvedLoop = typeof merger === 'function' ? await merger().catch(() => null) : merger;
  // The loop on this host, read from its cursor's live lock when the caller did not name it.
  const loop: ReportedLoopMerger | null = resolvedLoop !== undefined
    ? (resolvedLoop ? { live: (resolvedLoop as any).live !== false, name: resolvedLoop.name } : null)
    : await detectLoopMerger(root).catch(() => null);
  const supervision = await executorSupervisionStatus(root, run);
  const now = Date.parse(snapshot.now) || Date.now();
  const slots: SlotDown[] = supervision.units.filter(unit => slotDown(unit.active)).map(unit => {
    const downMs = unit.active === 'inactive' ? slotDownMs(run ?? defaultSystemctl, unit.unit, now) : null;
    return { slot: unit.slot, unit: unit.unit, active: unit.active, downMs, paged: downMs === null || downMs >= slotUpgradeBoundMs };
  });
  const paged = slots.filter(slot => slot.paged);
  const startPaged = `systemctl --user start ${paged.map(slot => slot.unit).join(' ')}`;
  const named = (slot: SlotDown) => `${slot.unit} ${slot.active}${slot.downMs === null ? '' : ` for ${seconds(slot.downMs)}, past the ${seconds(slotUpgradeBoundMs)} upgrade bound`}`;
  let presence: ExecutorFleet['presence'];
  try {
    const answer = (await masterApi('actions')).executors as ExecutorReport | undefined;
    presence = answer ? { ...withLoopMerger(answer, loop), available: true } : { available: false, reason: 'the deployed server reports no executor presence; deploy main so GET /api/actions carries executors', live: [], served: [], unserved: [], liveMs: executorLiveMs };
  } catch (error) { presence = { available: false, reason: `GET /api/actions failed: ${error instanceof Error ? error.message : String(error)}`, live: [], served: [], unserved: [], liveMs: executorLiveMs }; }
  const unserved = describeUnserved(presence);
  // Slots down is not a fleet short of capacity: the remedy is to start the unit, not to add one.
  // A slot mid-upgrade is neither, and nothing is raised until it outlasts the bound.
  const capacity: ExecutorFleet['capacity'] = !unserved.length ? 'served' : !supervision.declaration || !slots.length ? 'no-capacity' : paged.length ? 'slots-down' : 'restarting';
  const attention: AttentionItem[] = capacity === 'restarting' ? [] : unserved.map(entry => capacity === 'slots-down'
    ? { subject: entry.keys[0], text: `Nothing can run ${entry.kind}: ${entry.keys[0]} has waited ${seconds(entry.waitedMs)}${entry.keys.length > 1 ? ` and ${entry.keys.length - 1} more` : ''} because declared executor slots on this host are down, not because the fleet lacks capacity: ${paged.map(named).join(', ')}`, ...agentOwner('master', startPaged) }
    : { subject: entry.keys[0], text: entry.text, ...agentOwner('master', `${entry.start}; on this host: ${supervision.start}`) });
  // Without presence the control plane cannot say who is alive, but a host whose every declared
  // slot is down while rows are pending is unserved from here, and is named as such.
  const pending = openActions(snapshot.work, new Date(snapshot.now)).filter(({ row }) => !(loop?.live && row.kind === 'merge'));
  if (!presence.available && pending.length && supervision.units.length && slots.length === supervision.units.length && paged.length) {
    attention.push({ subject: pending[0].row.key, text: `Every declared executor slot on this host is down (${slots.map(named).join(', ')}) while ${pending.length} action(s) are pending, the oldest ${pending[0].row.kind} for ${pending[0].row.key} since ${pending[0].row.requestedAt}; ${presence.reason}`, ...agentOwner('master', startPaged) });
  }
  // A declared slot that stays down is worth a line on its own: the fleet is one short of what
  // the host said it runs, whether or not anything is unserved yet. One inside the upgrade bound
  // is a restart in passage and pages nobody.
  for (const slot of paged) {
    if (attention.some(item => item.next === `systemctl --user start ${slot.unit}` || item.next.includes(slot.unit))) continue;
    attention.push({ subject: 'executors', text: `Executor slot ${slot.slot} is ${slot.active} although this host declares ${supervision.declaration!.count} slot(s)${slot.downMs === null ? '' : `, down ${seconds(slot.downMs)}, past the ${seconds(slotUpgradeBoundMs)} upgrade bound`}; journalctl --user -u ${slot.unit} says why`, ...agentOwner('master', `systemctl --user start ${slot.unit}`) });
  }
  return { presence, supervision, unserved, capacity, slots, attention };
}
