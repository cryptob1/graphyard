// Concern: `graphyard master status` — one page: the managed repository's served commit against its base tip (only what a deployment provider records; unconfigured when none does), each open item, the merge writer, live sessions and free worker profiles.
import { type MasterConfig, inspectWorkerCredentials, observeHerdrAgents, readSessionScreen } from '../master.js';
import type { Work } from '../model/work.js';
import { type ChildRun, defaultChildRun } from '../child-runner.js';
import { daemonSummary } from '../daemon/run.js';
import { emptyMasterSession, masterSummary, readDaemonState } from '../daemon/state.js';
import { profileHealth } from '../daemon/sessions.js';
import { attemptBoundSummary } from '../master/attempt-bound.js';
import { mergeWriterSummary } from '../daemon/cycle-merge-writer.js';
import { servingReport } from '../deploy-watch.js';
import { gateRecordPath, gateSummary, readGateRecord } from '../batch-gate.js';
import { trialTestGateStatus } from '../merge-writer/trial.js';
import { attemptLabel, readAttemptLaunch, type AttemptLaunch } from '../master/session-resume.js';
import { noServe, plainStage, waitingReason } from '../model/plain-stage.js';
import { noRelease } from '../model/release.js';
import { specCheckCurrent } from '../model/spec-check.js';
import { stalledDelivery, stalledDeliveryAction } from '../daemon/master-stalled-delivery.js';
import { cliUnreachableRefusal } from '../reviewer.js';
import { stoppedRoles } from '../master/stopped-roles.js';
import type { FleetView } from '../model/registry.js';

const short = (sha: string | null | undefined) => sha ? sha.slice(0, 12) : null;

/** One open item's line: its plain stage (GY-2988; Waiting with its reason, GY-3095), its attempt (and the one it resumed, GY-2971), who holds it, the head it submitted, and what blocks it. */
export function itemLine(item: Work, now: number, launched: AttemptLaunch | null = null) {
  const lease = item.lease && Date.parse(item.lease.expiresAt) > now ? item.lease : null;
  const stage = plainStage(item, noRelease, noServe, now);
  return { key: item.key, title: item.title, stage, ...(stage === 'Waiting' ? { waiting: waitingReason(item) } : {}), attempt: attemptLabel(item.epoch, launched), owner: lease?.owner ?? null, humanOwner: item.owner ?? null, head: short(item.candidate?.sha),
    blocker: item.blocker ?? (item.humanRequest && !item.humanRequest.answer ? `waits on a human: ${item.humanRequest.needed}` : null) };
}

/** The `master status` page. `run` reads main's tip from the checkout's remote-tracking ref; the deploy unit fetches it. */
export async function masterStatusReport(root: string, master: MasterConfig, masterApi: (path: string) => Promise<any>, run: ChildRun = defaultChildRun) {
  // An unreachable control plane (GY-2966) is reported, not thrown: since when, the server's last exit and the free disk space, as the loop recorded them.
  let unreachable: string | null = null;
  const [snapshot, runtime, credentials, state] = await Promise.all([(masterApi('work-snapshot') as Promise<{ work: Work[]; now: string }>).catch(error => {
    if (typeof error?.status === 'number') throw error;
    unreachable = error instanceof Error ? error.message : String(error);
    return { work: [] as Work[], now: new Date().toISOString() };
  }), observeHerdrAgents(run), inspectWorkerCredentials(root, master.workers), readDaemonState(root, master).catch(() => null)]);
  // The registry as this host's launches see it (GY-3095): a role nothing can launch on is the plain stopped signal.
  const fleet = unreachable ? null : await (masterApi(`agent-registry?host=${encodeURIComponent(master.hostId)}`) as Promise<FleetView>).catch(() => null);
  // The install master lists only unowned items; count personal scopes so the operator still sees them.
  const personalScopes = master.forPerson ? 0 : snapshot.work.filter(item => item.owner).length;
  snapshot.work = snapshot.work.filter(item => (item.owner ?? null) === (master.forPerson ?? null));
  const now = Date.parse(snapshot.now) || Date.now();
  // The managed repository's release health reads only what its own deployment records as served,
  // and only a record that names this repository as the one it serves. The control plane's deploy
  // unit writes the same file for the revision its loop restarts onto; for an install managing a
  // different repository that record names the control plane's code, not the game's, and neither it
  // nor the control plane's own build revision (state.release, the Graphyard build this loop
  // loaded) ever stands in as the game's release health (GY-2951, GY-2955). What the repository's
  // declared serve serves (GY-2976) is its own serving truth instead: the served commit, whether it
  // is main, the URL and the last build failure (servingReport reads main's tip from the checkout's
  // remote-tracking ref; the deploy unit fetches it).
  const report = await servingReport(root, master.repository, master.baseBranch, args => Promise.resolve(run('git', ['-C', root, ...args])).then(String));
  const serving = {
    unconfigured: report.unconfigured, commit: short(report.commit), main: short(report.main), atMain: report.atMain,
    failedDeploy: report.failedDeploy ? { tip: short(report.failedDeploy.tip), reason: report.failedDeploy.reason, restoring: short(report.failedDeploy.restoring) } : null,
    // A repository that declares no serve.json reports exactly what it reported before it (GY-2976), with the serve fields null.
    ...(report.serve ? { pending: report.pending, serve: report.serve } : { serve: null }),
  };
  const health = state ? profileHealth(master.workers, credentials, runtime.agents, state, now, snapshot.work) : [];
  const session = master.forPerson ? state?.personalMasters[master.forPerson] : state?.master;
  const masterAgent = session?.agentName ? runtime.agents.find(agent => agent.name === session.agentName || (!!session.pane && agent.pane_id === session.pane)) : undefined;
  const masterScreen = session?.agentName ? await readSessionScreen(masterAgent?.pane_id ?? session.agentName, run) : undefined;
  const loop = state ? daemonSummary(state, now, master.run.intervalSeconds * 1000, master.hostId, masterAgent) : null;
  const sessions = snapshot.work.flatMap(item => (item.sessions ?? []).filter(session => session.state === 'running')
    .map(session => ({ work: item.key, id: session.id, kind: session.kind, pane: session.pane, live: runtime.available ? runtime.agents.some(agent => !!session.pane && agent.pane_id === session.pane) : null,
      // A live worker attempt names its bound (GY-2961): how long is left, what extends it, and the ceiling.
      ...(session.kind === 'implementation' ? { attempt: attemptBoundSummary(item, session, master.run, now) } : {}) })));
  // GY-2958: the trial's test gate for this checkout — ci-tests, repository checks, or an explicit
  // "no test check configured" so a managed repository never looks like it trials with zero tests.
  const trialTests = trialTestGateStatus(root);
  const recorded = state?.controlPlane ?? null;
  const open = snapshot.work.filter(item => item.stage !== 'done');
  const stalled = stalledDelivery(open);
  const launched = await Promise.all(open.map(item => readAttemptLaunch(root, item.key)));
  const stopped = stoppedRoles(fleet, now, master.run.intervalSeconds * 1000);
  return {
    // GY-3095: the pipeline has stopped where a role cannot launch; each line names the role, the refusal, how long it has lasted and the next command.
    attention: stopped,
    controlPlane: unreachable || recorded ? { reachable: !unreachable, error: unreachable ?? recorded?.error ?? null, unreachableSince: recorded?.unreachableSince ?? null, lastExitReason: recorded?.exitReason ?? null, freeDisk: recorded?.freeDisk ?? null, restartedAt: recorded?.restartedAt ?? null, restart: recorded?.restart ?? null } : { reachable: true },
    serving,
    loop: loop ? { state: loop.liveness.state, detail: loop.liveness.detail, cycle: loop.cycle, steps: loop.metrics?.steps ?? null } : { state: 'absent', detail: 'The loop cursor cannot be read' },
    // The loop's own master session (GY-2949): working / idle / `limited until T` while the account hold stands / absent.
    masterSession: masterSummary(session ?? emptyMasterSession(), now, masterAgent, masterScreen),
    delivery: stalled.length ? { state: 'stalled', reason: stalled.map(cause => cause.detail).join('\n'), nextAction: stalledDeliveryAction }
      : { state: state?.mergeWriter.inFlight ? 'validating' : 'no shared base failure', reason: null, nextAction: null },
    items: open.map((item, index) => itemLine(item, now, launched[index])),
    ...(personalScopes > 0 ? { personalScopes: `${personalScopes} items in personal scopes` } : {}),
    mergeWriter: (({ queue, inFlight, inFlights, lastMergeAt, refusals, serveRevert, trials, stepMedians }) => ({ queue, inFlight, ...(inFlights ? { inFlights } : {}), lastMergeAt, trials: trials ?? [], stepMedians: stepMedians ?? {}, lastRefusal: refusals.at(-1) ?? null,
      // GY-2990: a revert that failed its own trial is held here, with the serve and reason that held it.
      serveRevert: serveRevert?.held ?? null }))(mergeWriterSummary(state?.mergeWriter, now)),
    trialTests,
    // GY-3119: the batch gate on main — the verified commit that serves, the gate in flight, a held batch and the revert rate over the last 20 merges.
    batchGate: gateSummary(readGateRecord(gateRecordPath(root))),
    sessions,
    // GY-2994: a spec checker that ended without a report, named with its reason until the item's check reports.
    specChecksEnded: Object.entries(state?.actions ?? {}).filter(([key, action]) => key.startsWith('spec-check-ended:') && open.some(item => item.key === action.work && !specCheckCurrent(item)))
      .map(([, action]) => ({ work: action.work, at: action.at, reason: action.detail })),
    // GY-2995: a launch whose sandbox cannot reach the CLI the prompt names, named while the refusal stands, with the spec checks it is withholding.
    ...(cliUnreachableRefusal(master) ? { cliRefusal: { reason: cliUnreachableRefusal(master)!, specChecks: Object.entries(state?.actions ?? {}).filter(([key]) => key.startsWith('spec-check-cli-refused:'))
      .map(([, action]) => ({ work: action.work, at: action.at })) } } : { cliRefusal: null }),
    freeWorkers: health.filter(entry => entry.healthy).map(entry => entry.profile.name),
  };
}
