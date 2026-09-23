import { agentOwner, type AttentionItem } from '../master.js';
import type { Work } from '../model.js';
import { openActions } from '../model/actions.js';
import { describeUnserved, executorLiveMs, type ExecutorReport } from '../model/executor-presence.js';
import { executorSupervisionStatus, type SystemctlRunner } from '../repository-setup.js';

/**
 * The executor fleet as `master status` reports it (GY-105): who is alive to claim, judged by the
 * control plane from the polls it sees; every pending action whose kind none of them serves, with
 * its wait and what to start; and what this host declared and what systemd says of each slot.
 *
 * Two observations, deliberately kept apart. Presence comes from the control plane, because it is
 * the one place every executor on every host reports to. Supervision comes from this host, because
 * the unit to start is a local one. An unserved kind is named with the local unit when this host
 * declared executors and one of them is down, and with the generic command otherwise.
 */

export interface ExecutorFleet {
  /** What the control plane saw; null when the deployed server predates presence reporting. */
  presence: (ExecutorReport & { available: true }) | { available: false; reason: string; live: []; served: []; unserved: []; liveMs: number };
  supervision: Awaited<ReturnType<typeof executorSupervisionStatus>>;
  /** One line per unserved kind, longest wait first. */
  unserved: ReturnType<typeof describeUnserved>;
  attention: AttentionItem[];
}

export async function executorFleet(root: string, masterApi: (path: string) => Promise<any>, snapshot: { work: Work[]; now: string }, run?: SystemctlRunner): Promise<ExecutorFleet> {
  const supervision = await executorSupervisionStatus(root, run);
  let presence: ExecutorFleet['presence'];
  try {
    const answer = (await masterApi('actions')).executors as ExecutorReport | undefined;
    presence = answer ? { ...answer, available: true } : { available: false, reason: 'the deployed server reports no executor presence; deploy main so GET /api/actions carries executors', live: [], served: [], unserved: [], liveMs: executorLiveMs };
  } catch (error) { presence = { available: false, reason: `GET /api/actions failed: ${error instanceof Error ? error.message : String(error)}`, live: [], served: [], unserved: [], liveMs: executorLiveMs }; }
  const unserved = describeUnserved(presence);
  const attention: AttentionItem[] = unserved.map(entry => ({ subject: entry.keys[0], text: entry.text, ...agentOwner('master', supervision.declaration && supervision.units.some(unit => unit.active !== 'active') ? supervision.start : `${entry.start}; on this host: ${supervision.start}`) }));
  // Without presence the control plane cannot say who is alive, but a host whose every declared
  // slot is down while rows are pending is unserved from here, and is named as such.
  const pending = openActions(snapshot.work, new Date(snapshot.now));
  if (!presence.available && pending.length && supervision.units.length && supervision.units.every(unit => unit.active !== 'active')) {
    attention.push({ subject: pending[0].row.key, text: `Every declared executor slot on this host is down (${supervision.units.map(unit => `${unit.unit} ${unit.active}`).join(', ')}) while ${pending.length} action(s) are pending, the oldest ${pending[0].row.kind} for ${pending[0].row.key} since ${pending[0].row.requestedAt}; ${presence.reason}`, ...agentOwner('master', supervision.start) });
  }
  // A declared slot that is not running is worth a line on its own: the fleet is one short of
  // what the host said it runs, whether or not anything is unserved yet.
  for (const unit of supervision.units.filter(entry => entry.active !== 'active')) {
    if (attention.some(item => item.next === `systemctl --user start ${unit.unit}` || item.next.includes(unit.unit))) continue;
    attention.push({ subject: 'executors', text: `Executor slot ${unit.slot} is ${unit.active} although this host declares ${supervision.declaration!.count} slot(s); journalctl --user -u ${unit.unit} says why`, ...agentOwner('master', `systemctl --user start ${unit.unit}`) });
  }
  return { presence, supervision, unserved, attention };
}
