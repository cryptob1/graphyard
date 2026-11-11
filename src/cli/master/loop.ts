import { insideMasterConfinement } from '../../master/confinement.js';
// Concern: `graphyard master run` — wiring the durable loop to its effects.
import { parseArgs } from 'node:util';
import { liveMasterConfig } from '../../master.js';
import { daemonEffects, retriedSnapshot } from '../../daemon/effects.js';
import { readDaemonState } from '../../daemon/state.js';
import { runDaemon } from '../../daemon/run.js';
import { coordinationViewHeader } from '../../server/work-view.js';
import { encodeLoopCheckoutTrust, encodeLoopPanes, loopAlertsHeader, loopCheckoutTrustHeader, loopPanesHeader, loopPresenceHeader, loopSupervisionHeader } from '../../model/loop-presence.js';
import { checkoutTrustKey } from '../../daemon/cycle.js';
import { herdrServerSeen, herdrTarget } from '../../master/herdr.js';
import { unhandled, type MasterSession } from './session.js';
import { exitWhenStopped, recordingLockRefusal } from '../../master/loop-restart.js';
import { processConnectAccounts } from '../../master/connect-accounts.js';
import { recordRunningPin } from '../../master/known-good.js';
import { installDirectory } from '../../install/secrets.js';
import { installIdFor } from '../../install/types.js';
import { terminalSessionReader } from '../../master/terminal-session.js';
import { bridgeTerminals } from '../../master/terminal-bridge.js';
import { alertMinutesOf } from '../../daemon/yard-alerts.js';

/** The Herdr server the loop names on each read (GY-1511): the instance its herdr calls target, its host, whether it last answered, and the master's pane (GY-3211). */
export const loopHerdrReport = (host: string | null, master: string | null = null) => encodeLoopPanes({ configHome: herdrTarget()?.configHome ?? null, session: herdrTarget()?.session ?? null, host, running: herdrServerSeen(), master });

export async function loopCommand(session: MasterSession): Promise<unknown> {
  const { id, args, print, root, master, masterToken, masterApi, masterMutation, coordinator, assertProtocol } = session;
  if (id === 'run') {
    if (insideMasterConfinement()) throw new Error('master run must execute on the unconfined host to launch confined reviewers; use the install host loop.');
    if (master.forPerson) throw new Error('Personal masters use the install’s shared loop; run master run from the install checkout');
    const { values } = parseArgs({ args, options: { once: { type: 'boolean' }, interval: { type: 'string' } }, allowPositionals: false });
    const intervalSeconds = values.interval ? Number(values.interval) : master.run.intervalSeconds;
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 5 || intervalSeconds > 900) throw new Error('Use master run --interval with whole seconds between 5 and 900');
    // A coordinator credential is the daemon's entire authority; its roster --proof patterns cover only the loop's readings,
    // since evidence submission refuses every coordinator (GY-2934).
    if (coordinator.actor.role !== 'coordinator') throw new Error('The durable master loop requires a coordinator credential; operator, producer, and worker credentials are refused');
    assertProtocol(coordinator);
    const state = await readDaemonState(root, master);
    // The deploy unit pins new tips while this loop still runs from its own pin; it keeps the one recorded here.
    try { recordRunningPin(installDirectory(installIdFor(master.repository))); } catch { /* no install directory: no pin to keep */ }
    // The cycle and the dispatcher poll the bounded coordination view (by header, so an older
    // server answers with whole documents). GitHub merges; the loop runs no merge of its own.
    const live = liveMasterConfig(root, master), current = () => live.current;
    // GY-2600: each cycle checks the configured Herdr workspace still exists and adopts a live one if not.
    const cycleReload = () => live.reload(true);
    // Each read also names the loop to the control plane (GY-916), which then knows the merger lives,
    // and who reviews and merges (GY-1501), which the dashboard's Setup checklist reads.
    const loopInterval = () => values.interval ? intervalSeconds : current().run.intervalSeconds;
    // GY-1511: and names the Herdr server holding the install's agents, for the Setup page.
    // GY-3101: and names whether it alerts the operator directly (run.alertUrl) and after how many minutes, for the same page.
    // GY-3225: and names the standing checkout-trust refusal (an untrusted checkout carrying repository Claude configuration), for the Setup checklist's one item.
    const coordinationSnapshot = (timeoutMs?: number) => masterApi('work-snapshot', masterToken, timeoutMs, { [coordinationViewHeader]: 'coordination', [loopPresenceHeader]: String(loopInterval()), [loopSupervisionHeader]: current().supervision ?? 'autonomous', [loopPanesHeader]: loopHerdrReport(current().hostId, state.master.pane), [loopAlertsHeader]: current().run.alertUrl ? String(alertMinutesOf(current().run)) : 'off', [loopCheckoutTrustHeader]: state.actions[checkoutTrustKey]?.state === 'failed' ? encodeLoopCheckoutTrust(state.actions[checkoutTrustKey]!.detail) : 'off' });
    const effects = daemonEffects(root, current, { snapshot: retriedSnapshot(() => coordinationSnapshot()), sessionHistory: async work => (await masterApi(`work/${work.id}`, masterToken)).sessions ?? [], mutate: masterMutation });
    // GY-1603: a stopped loop's process exits within its unit's stop bound, whatever handle is left open.
    const exit = exitWhenStopped();
    const held = state.lock && state.lock.pid !== process.pid ? state.lock : null;
    const stopping = new AbortController();
    // A run refused on another loop's lock is recorded for master status, which names a holder outside the unit.
    const daemonRun = recordingLockRefusal(root, held, runDaemon(master, state, effects, { once: values.once, intervalMs: values.interval ? intervalSeconds * 1000 : () => current().run.intervalSeconds * 1000, identity: { pid: process.pid, host: master.hostId }, reload: cycleReload, root,
      events: { read: () => masterApi('events?view=rows&order=desc&limit=100&payload=none', masterToken), self: coordinator.actor.id } }))
      .finally(() => stopping.abort());
    // GY-409: the loop turns a connect made in Settings › Agents into a registered account on this host, one pass at a time.
    let connecting = false;
    const connects = values.once ? undefined : setInterval(() => {
      if (connecting || !current().url || !current().hostId) return;
      connecting = true;
      processConnectAccounts(current()).catch(error => console.error(`[graphyard-master] connect-account worker: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { connecting = false; });
    }, 15_000);
    connects?.unref?.();
    stopping.signal.addEventListener('abort', () => clearInterval(connects));
    // GY-3241: and streams the Master page's terminal for a server (a compose container) that has no Herdr of its own.
    if (!values.once && current().url) bridgeTerminals(current().url!, masterToken, stopping.signal, undefined, terminalSessionReader(current));
    const result = await daemonRun;
    // A cycle that threw was recorded and retried in-process (GY-119); it is reported here, never as an exit.
    if (result.stopped) exit.stopped();
    return print({ repository: master.repository, coordinator: coordinator.actor.id, intervalSeconds, cycles: result.cycles.length, failedCycles: result.failed.length, stopped: result.stopped ? 'signal' : 'completed', last: result.cycles.at(-1) ?? null, lastFailure: result.failed.at(-1) ?? null });
  }
  return unhandled;
}
