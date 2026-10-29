// Concern: `graphyard master status` — one page: the managed repository's served commit against its base tip (only what a deployment provider records; unconfigured when none does), each open item, the merge writer, live sessions and free worker profiles.
import { type MasterConfig, inspectWorkerCredentials, observeHerdrAgents } from '../master.js';
import type { Work } from '../model/work.js';
import { type ChildRun, defaultChildRun } from '../child-runner.js';
import { daemonSummary, emptyMasterSession, masterSummary, profileHealth, readDaemonState } from '../master-daemon.js';
import { attemptBoundSummary } from '../master/attempt-bound.js';
import { mergeWriterSummary } from '../daemon/cycle-merge-writer.js';
import { servingReport } from '../deploy-watch.js';
import { trialTestGateStatus } from '../merge-writer/trial.js';
import { attemptLabel, readAttemptLaunch, type AttemptLaunch } from '../master/session-resume.js';

const short = (sha: string | null | undefined) => sha ? sha.slice(0, 12) : null;

/** One open item's line: its stage, its attempt (and the one it resumed, GY-2971), who holds it, the head it submitted, and what blocks it. */
export function itemLine(item: Work, now: number, launched: AttemptLaunch | null = null) {
  const lease = item.lease && Date.parse(item.lease.expiresAt) > now ? item.lease : null;
  return { key: item.key, title: item.title, stage: item.stage, attempt: attemptLabel(item.epoch, launched), owner: lease?.owner ?? null, head: short(item.candidate?.sha),
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
  }), observeHerdrAgents(), inspectWorkerCredentials(root, master.workers), readDaemonState(root, master).catch(() => null)]);
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
  const masterAgent = state?.master.agentName ? runtime.agents.find(agent => agent.name === state.master.agentName || (!!state.master.pane && agent.pane_id === state.master.pane)) : undefined;
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
  const launched = await Promise.all(open.map(item => readAttemptLaunch(root, item.key)));
  return {
    controlPlane: unreachable || recorded ? { reachable: !unreachable, error: unreachable ?? recorded?.error ?? null, unreachableSince: recorded?.unreachableSince ?? null, lastExitReason: recorded?.exitReason ?? null, freeDisk: recorded?.freeDisk ?? null, restartedAt: recorded?.restartedAt ?? null, restart: recorded?.restart ?? null } : { reachable: true },
    serving,
    loop: loop ? { state: loop.liveness.state, detail: loop.liveness.detail, cycle: loop.cycle, steps: loop.metrics?.steps ?? null } : { state: 'absent', detail: 'The loop cursor cannot be read' },
    // The loop's own master session (GY-2949): working / idle / `limited until T` while the account hold stands / absent.
    masterSession: masterSummary(state?.master ?? emptyMasterSession(), now, masterAgent),
    items: open.map((item, index) => itemLine(item, now, launched[index])),
    mergeWriter: (({ queue, inFlight, lastMergeAt, refusals }) => ({ queue, inFlight, lastMergeAt, lastRefusal: refusals.at(-1) ?? null }))(mergeWriterSummary(state?.mergeWriter, now)),
    trialTests,
    sessions,
    freeWorkers: health.filter(entry => entry.healthy).map(entry => entry.profile.name),
  };
}
