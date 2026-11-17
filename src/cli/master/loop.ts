// Concern: `graphyard master run` — wiring the durable loop to its effects.
import { insideMasterConfinement } from '../../master/confinement.js';
import { parseArgs } from 'node:util';
import { liveMasterConfig } from '../../master.js';
import { daemonEffects, retriedSnapshot } from '../../daemon/effects.js';
import { readDaemonState } from '../../daemon/state.js';
import { runDaemon } from '../../daemon/run.js';
import { coordinationViewHeader } from '../../server/work-view.js';
import { encodeLoopCheckoutTrust, encodeLoopCpu, encodeLoopHosts, loopHostsHeader, encodeLoopPanes, encodeLoopStepFailure, loopAlertsHeader, loopCheckoutTrustHeader, loopCpuHeader, loopFetchRefusalHeader, loopStallAlarmHeader, loopStepFailureHeader, loopSupervisionHeader, loopWorkerGrowthHeader, loopPanesHeader, loopPresenceHeader } from '../../model/loop-presence.js';
import { cpuWaiting } from '../../daemon/cpu-pressure.js';
import { encodeLoopWhere, loopWhereHeader } from '../../model/where-things-run.js';
import { loopWhereReport } from '../../master/where.js';
import { checkoutTrustKey, standingStepFailures, workerGrowthKey } from '../../daemon/cycle.js';
import { fetchRefusalKey } from '../../daemon/cycle-batch-gate.js';
import { stallAlarmKey } from '../../daemon/stall-alarm.js';
import { herdrServerSeen, herdrTarget } from '../../master/herdr.js';
import { unhandled, type MasterSession } from './session.js';
import { exitWhenStopped, recordingLockRefusal } from '../../master/loop-restart.js';
import { processConnectAccounts } from '../../master/connect-accounts.js';
import { syncTeamAccess } from '../../master/team-access.js';
import { recordRunningPin } from '../../master/known-good.js';
import { installDirectory } from '../../install/secrets.js';
import { installIdFor } from '../../install/types.js';
import { terminalSessionReader } from '../../master/terminal-session.js';
import { bridgeTerminals } from '../../master/terminal-bridge.js';
import { alertMinutesOf } from '../../daemon/yard-alerts.js';
import { joinHostHeavyBudget } from '../../master/verification-slots.js';

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
    // since evidence submission refuses every coordinator (GY-2934). GY-3347: a plane that is down
    // at startup is waited out rather than refused — the loop keeps running for the plane to
    // answer, and the plane itself enforces the credential on every call the loop then makes.
    if (coordinator) {
      if (coordinator.actor.role !== 'coordinator') throw new Error('The durable master loop requires a coordinator credential; operator, producer, and worker credentials are refused');
      assertProtocol(coordinator);
    }
    // GY-3290: everything heavy this loop runs or launches shares the host's budget with every other Graphyard project here.
    joinHostHeavyBudget(master.repository);
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
    // GY-3293: and names the standing repeated step-failure line (a step failing the same way ten consecutive cycles), for the Setup checklist's Needs you item.
    // GY-3277: and names where this install's parts run — its units, containers, port, URL and directories — for the Setup page's panel.
    // GY-3348: and names the host's CPU ('some avg60' and steal percent), for the Workers page's two figures; GY-3416: and its launches-waiting word.
    const where = await loopWhereReport(root, master);
    const stepFailureLine = (failure: Parameters<typeof encodeLoopStepFailure>[0] | undefined) => failure ? encodeLoopStepFailure(failure) : 'off';
    const coordinationSnapshot = (timeoutMs?: number) => masterApi('work-snapshot', masterToken, timeoutMs, { [coordinationViewHeader]: 'coordination', [loopPresenceHeader]: String(loopInterval()), [loopSupervisionHeader]: current().supervision ?? 'autonomous', [loopPanesHeader]: loopHerdrReport(current().hostId, state.master.pane), [loopAlertsHeader]: current().run.alertUrl ? String(alertMinutesOf(current().run)) : 'off', [loopCheckoutTrustHeader]: state.actions[checkoutTrustKey]?.state === 'failed' ? encodeLoopCheckoutTrust(state.actions[checkoutTrustKey]!.detail) : 'off', [loopWorkerGrowthHeader]: state.actions[workerGrowthKey]?.state === 'failed' ? encodeLoopCheckoutTrust(state.actions[workerGrowthKey]!.detail) : 'off', [loopStepFailureHeader]: stepFailureLine(standingStepFailures(state)[0]), [loopFetchRefusalHeader]: state.actions[fetchRefusalKey]?.state === 'failed' ? encodeLoopCheckoutTrust(state.actions[fetchRefusalKey]!.detail) : 'off', [loopStallAlarmHeader]: state.actions[stallAlarmKey] ? encodeLoopCheckoutTrust(state.actions[stallAlarmKey]!.detail) : 'off', ...(where ? { [loopWhereHeader]: encodeLoopWhere(where) } : {}), [loopCpuHeader]: state.cpuPressure ? encodeLoopCpu({ avg60: state.cpuPressure.avg60, steal: state.cpuPressure.steal, celsius: state.cpuPressure.celsius, testBudget: state.cpuPressure.testBudget, trialCap: state.cpuPressure.trialCap, waiting: cpuWaiting(state) !== null }) : 'off', [loopHostsHeader]: state.hosts.length ? encodeLoopHosts(state.hosts) : 'off' });
    const effects = daemonEffects(root, current, { snapshot: retriedSnapshot(() => coordinationSnapshot()), sessionHistory: async work => (await masterApi(`work/${work.id}`, masterToken)).sessions ?? [], mutate: masterMutation,
      messages: async () => (await masterApi('master/messages', masterToken)).messages ?? [] });
    // GY-1603: a stopped loop's process exits within its unit's stop bound, whatever handle is left open.
    const exit = exitWhenStopped();
    const held = state.lock && state.lock.pid !== process.pid ? state.lock : null;
    const stopping = new AbortController();
    // A run refused on another loop's lock is recorded for master status, which names a holder outside the unit.
    const daemonRun = recordingLockRefusal(root, held, runDaemon(master, state, effects, { once: values.once, intervalMs: values.interval ? intervalSeconds * 1000 : () => current().run.intervalSeconds * 1000, identity: { pid: process.pid, host: master.hostId }, reload: cycleReload, root,
      // GY-3347: a loop started while the plane is down knows no actor of its own yet; no event reads as its own, so any event may wake it — one more cycle, never a lost one.
      events: { read: () => masterApi('events?view=rows&order=desc&limit=100&payload=none', masterToken), self: coordinator?.actor.id ?? '' } }))
      .finally(() => stopping.abort());
    // GY-409: the loop turns a connect made in Settings › Agents into a registered account on this host, one pass at a time.
    let connecting = false;
    const connects = values.once ? undefined : setInterval(() => {
      if (connecting || !current().url || !current().hostId) return;
      connecting = true;
      processConnectAccounts(current()).catch(error => console.error(`[graphyard-master] connect-account worker: ${error instanceof Error ? error.message : String(error)}`))
        // GY-3294: and carries Setup's team access to this machine's shared record and back (a server without the routes answers 404).
        .then(() => syncTeamAccess(current())).catch(error => { if (error?.status !== 404) console.error(`[graphyard-master] team access: ${error instanceof Error ? error.message : String(error)}`); })
        .finally(() => { connecting = false; });
    }, 15_000);
    connects?.unref?.();
    stopping.signal.addEventListener('abort', () => clearInterval(connects));
    // GY-3241: and streams the Master page's terminal for a server (a compose container) that has no Herdr of its own,
    // and the headless worker run logs this host holds for the item page (GY-3259).
    if (!values.once && current().url) bridgeTerminals(current().url!, masterToken, stopping.signal, undefined, terminalSessionReader(current), root);
    const result = await daemonRun;
    // A cycle that threw was recorded and retried in-process (GY-119); it is reported here, never as an exit.
    if (result.stopped) exit.stopped();
    return print({ repository: master.repository, coordinator: coordinator?.actor.id ?? null, intervalSeconds, cycles: result.cycles.length, failedCycles: result.failed.length, stopped: result.stopped ? 'signal' : 'completed', last: result.cycles.at(-1) ?? null, lastFailure: result.failed.at(-1) ?? null });
  }
  return unhandled;
}
