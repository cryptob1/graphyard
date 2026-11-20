// Concern: `graphyard master status` — one page: the managed repository's served commit against its base tip (only what a deployment provider records; unconfigured when none does), each open item, the merge writer, live sessions and free worker profiles.
import type { pendingWorkerVerifications } from '../server/worker-verification-queue.js';
import { latestReleaseNote, releaseNotesPath } from '../release-notes.js';
import { type MasterConfig, inspectWorkerCredentials, observeHerdrAgents } from '../master.js';
import { readSessionScreenOrError } from '../master/prompt-delivery.js';
import type { Work } from '../model/work.js';
import { type ChildRun, defaultChildRun } from '../child-runner.js';
import { daemonSummary } from '../daemon/run.js';
import { emptyMasterSession, masterSummary, readDaemonState } from '../daemon/state.js';
import { standingStepFailures, workerGrowthKey, masterLaunchKey, masterLaunchBackoffAfter } from '../daemon/cycle.js';
import { fetchRefusalKey, gateStallKey } from '../daemon/cycle-batch-gate.js';
import { cpuPerMergedItem, implementationWaiting } from '../daemon/cpu-pressure.js';
import { heatReading } from '../merge-writer/trial-load.js';
import { overloadAlarm, overloaded, sessionFigures } from '../session-share.js';
import { profileHealth, repeatedLaunchFailures } from '../daemon/sessions.js';
import { workersAllowed } from '../master/worker-pool.js';
import { heavyDrainLine, heavyJobLimit, heavyJobsDirectory, readHeavyDrain, readStrictCap, slotHolders } from '../master/verification-slots.js';
import { standingLimit } from '../master/profiles.js';
import { attemptBoundSummary } from '../master/attempt-bound.js';
import { mergeWriterSummary, trialImageKey } from '../daemon/cycle-merge-writer.js';
import { servingReport, controlPlaneRecordPath, controlPlaneSummary, readControlPlaneRecord } from '../deploy-watch.js';
import { gateRecordPath, gateHoldAttention, gateSummary, readGateRecord } from '../batch-gate.js';
import { thisWeekReport } from '../project-memory.js';
import { trialTestGateStatus } from '../merge-writer/trial.js';
import { outdatedShimAttention, readRemoteShardRuns, remoteShardSummary } from '../merge-writer/remote-shards.js';
import { attemptLabel, readAttemptLaunch, type AttemptLaunch } from '../master/session-resume.js';
import { plainStage, waitingReason } from '../model/plain-stage.js';
import { stalledDelivery, stalledDeliveryAction } from '../daemon/master-stalled-delivery.js';
import { failureHeld, repeatedFailureCause } from '../daemon/repeated-failure.js';
import { alertMinutesOf } from '../daemon/yard-alerts.js';
import { stallAlarmKey } from '../daemon/stall-alarm.js';
import { stoppedRoles, type StoppedRole } from '../master/stopped-roles.js';
import { deliverySpeed, type MergedItem, type SpeedEvent } from '../pipeline-speed.js';
import { unspecifiedModel, type FleetView } from '../model/registry.js';
import { observeApplications } from '../production-watch.js';
import { appRelease } from '../app-url.js';
import { applicationAttention, reworkAttention } from '../master/attention.js';
import { trialFloorAttention } from '../merge-writer/trial-load.js';
import { parkedOnHuman } from '../model/human-request.js';
import { blockerSince } from '../model/work.js';
import { formatAge } from '../model/duration.js';
import { loadProjectDelivery, parseProjectDelivery } from '../model-boundary/project-applications.js';
import { backedOffProfiles, readDispatchCursor, type DispatchCursor } from '../dispatch/cursor.js';
import { liveReviewRequest } from '../model/dispatch.js';

/** GY-3105: an item's whole non-routine ledger, oldest first, paged by cursor to the end; null when any page cannot be read. */
export async function itemLedger(masterApi: (path: string) => Promise<any>, id: string): Promise<SpeedEvent[] | null> {
  const events: SpeedEvent[] = [];
  let cursor: string | null = null;
  try {
    do {
      const page: { events: SpeedEvent[]; page: { nextCursor: string | null } } = await masterApi(`events?work=${id}&order=asc&limit=1000&view=page${cursor ? `&cursor=${cursor}` : ''}`);
      events.push(...page.events);
      cursor = page.page.nextCursor;
    } while (cursor);
  } catch { return null; }
  return events;
}

const short = (sha: string | null | undefined) => sha ? sha.slice(0, 12) : null;

/** One open item's line: its plain stage (GY-2988; Waiting with its reason, GY-3095), its attempt (and the one it resumed, GY-2971), who holds it, the head it submitted, and what blocks it. */
export function itemLine(item: Work, now: number, launched: AttemptLaunch | null = null) {
  const lease = item.lease && Date.parse(item.lease.expiresAt) > now ? item.lease : null;
  const stage = plainStage(item, now);
  return { key: item.key, title: item.title, stage, ...(stage === 'Waiting' ? { waiting: waitingReason(item) } : {}), attempt: attemptLabel(item.epoch, launched), owner: lease?.owner ?? null, humanOwner: item.owner ?? null, head: short(item.candidate?.sha),
    blocker: item.blocker ?? (item.humanRequest && !item.humanRequest.answer ? `waits on a human: ${item.humanRequest.needed}` : null) };
}

/** Read npm's latest release without confusing it with the managed repository's serving state. */
export async function npmPublishedVersion(run: ChildRun): Promise<string> {
  try {
    const version = JSON.parse(String(await run('npm', ['view', '@cryptob1/graphyard', 'version', '--json', '--registry=https://registry.npmjs.org/'], { timeoutMs: 5_000 })));
    return typeof version === 'string' && version ? version : 'not published';
  } catch (error) {
    return /E404/.test(String(error)) ? 'not published' : 'unavailable';
  }
}

/** The `master status` page. `run` reads main's tip from the checkout's remote-tracking ref; the deploy unit fetches it. */

export async function masterStatusReport(root: string, master: MasterConfig, masterApi: (path: string) => Promise<any>, run: ChildRun = defaultChildRun) {
  // An unreachable control plane (GY-2966) is reported, not thrown: since when, the server's last exit and the free disk space, as the loop recorded them.
  let unreachable: string | null = null;
  const [snapshot, runtime, credentials, state] = await Promise.all([(masterApi('work-snapshot') as Promise<{ work: Work[]; now: string; workerVerifications?: ReturnType<typeof pendingWorkerVerifications> }>).catch(error => {
    if (typeof error?.status === 'number') throw error;
    unreachable = error instanceof Error ? error.message : String(error);
    return { work: [] as Work[], now: new Date().toISOString(), workerVerifications: [] };
  }), observeHerdrAgents(run), inspectWorkerCredentials(root, master.workers), readDaemonState(root, master).catch(() => null)]);
  // The registry as this host's launches see it (GY-3095): a role nothing can launch on is the plain stopped signal.
  const fleet = unreachable ? null : await (masterApi(`agent-registry?host=${encodeURIComponent(master.hostId)}`) as Promise<FleetView>).catch(() => null);
  // The install master lists only unowned items; count personal scopes so the operator still sees them.
  const personalScopes = master.forPerson ? 0 : snapshot.work.filter(item => item.owner).length;
  // GY-3418: every merge counts against the host's CPU, whoever's scope it is in.
  const mergedAt = snapshot.work.flatMap(item => item.stage === 'done' ? [item.delivery?.mergedAt ?? item.observation?.mergedAt].filter((at): at is string => !!at) : []);
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
    onboarding: report.onboarding,
    unconfigured: report.unconfigured, commit: short(report.commit), main: short(report.main), atMain: report.atMain,
    failedDeploy: report.failedDeploy ? { tip: short(report.failedDeploy.tip), reason: report.failedDeploy.reason, restoring: short(report.failedDeploy.restoring) } : null,
    // A repository that declares no node application reports exactly what it reported before it (GY-2976), with the serve fields null.
    ...(report.serve ? { pending: report.pending, serve: report.serve } : { serve: null }),
  };
  // GY-3204: each declared application with a versionUrl, as its host serves it against main.
  // GY-3459: declared as main's graphyard.json declares them, not the checkout's own (possibly stale) copy;
  // a declaration that does not parse is named, never read as no applications.
  const git = (args: readonly string[]) => Promise.resolve(run('git', ['-C', root, ...args])).then(String);
  let declared: ReturnType<typeof loadProjectDelivery>['applications'] = [], declarationError: string | null = null;
  try {
    const text = report.main ? await git(['show', `${report.main}:graphyard.json`]).catch(() => null) : undefined;
    declared = text === undefined ? loadProjectDelivery({}, root).applications : text === null ? [] : parseProjectDelivery(text, `graphyard.json on ${master.baseBranch}`).applications;
  } catch (error) { declarationError = error instanceof Error ? error.message : String(error); }
  const observed = await observeApplications(declared, report.main, git);
  // GY-3434: first, where the app runs — main's app.url with its machine, serving commit and deploy time, or the setting to add.
  const app = await appRelease(git, report, master.hostId);
  const applications = [{ id: 'app', url: app.url, machine: app.machine, serving: short(app.commit), deployedAt: app.deployedAt, ...(app.refused ? { refused: app.refused } : {}), ...(app.missing ? { missing: app.missing } : {}) },
    ...observed.map(app => ({ id: app.id, serving: short(app.serving), main: short(app.main), state: app.state, ...(app.reason ? { reason: app.reason } : {}) }))];
  const health = state ? profileHealth(master.workers, credentials, runtime.agents, state, now, snapshot.work) : [];
  const session = master.forPerson ? state?.personalMasters[master.forPerson] : state?.master;
  const masterAgent = session?.agentName ? runtime.agents.find(agent => agent.name === session.agentName || (!!session.pane && agent.pane_id === session.pane)) : undefined;
  const { screen: masterScreen, error: screenError } = session?.agentName ? await readSessionScreenOrError(masterAgent?.pane_id ?? session.agentName, run) : { screen: undefined, error: null };
  const loop = state ? daemonSummary(state, now, master.run.intervalSeconds * 1000, master.hostId, masterAgent) : null;
  const sessions = snapshot.work.flatMap(item => (item.sessions ?? []).filter(session => session.state === 'running')
    .map(session => ({ work: item.key, id: session.id, kind: session.kind, pane: session.pane, live: runtime.available ? runtime.agents.some(agent => !!session.pane && agent.pane_id === session.pane) : null,
      // A live worker attempt names its bound (GY-2961): how long is left, what extends it, and the ceiling.
      ...(session.kind === 'implementation' ? { attempt: attemptBoundSummary(item, session, master.run, now) } : {}) })));
  // GY-2958: the trial's test gate for this checkout — ci-tests, repository checks, or an explicit
  // "no test check configured" so a managed repository never looks like it trials with zero tests.
  const trialTests = trialTestGateStatus(root);
  const recorded = state?.controlPlane ?? null;
  const controlUpdate = controlPlaneSummary(readControlPlaneRecord(controlPlaneRecordPath(root)), now);
  const open = snapshot.work.filter(item => item.stage !== 'done');
  // GY-3280: every recorded worker blocker is attention the cycle it lands, naming the item, the
  // blocker and how long it has waited — the master session is prompted the same cycle. GY-3394:
  // however long it stands it stays the Master's (the Master page carries it too), never the
  // owner's Needs you.
  const blockerAttention = open.filter(item => item.blocker && !parkedOnHuman(item)).map(item => {
    const since = blockerSince(item);
    return { subject: item.key, text: `${item.key}'s blocker${since !== null ? ` has waited ${formatAge(since, now)}` : ''}: ${item.blocker}`,
      next: `Clear the cause, then graphyard master unblock ${item.key} REASON` };
  });
  const leaseLosses = open.flatMap(item => {
    const run = state?.failureRuns[item.id];
    return run?.kind === 'lease' && failureHeld(run)
      ? [{ subject: item.key, text: repeatedFailureCause(run)!.detail, next: `Diagnose the lease loss, then graphyard master rework ${item.key} REASON` }] : [];
  });
  const stalled = stalledDelivery(open);
  const launched = await Promise.all(open.map(item => readAttemptLaunch(root, item.key)));
  // GY-3105: delivery speed from the event ledger for the last merged items, computed now.
  const merged: MergedItem[] = unreachable ? [] : await Promise.all(snapshot.work.filter(item => item.stage === 'done' && (item.delivery?.mergedAt ?? item.observation?.mergedAt))
    .sort((a, b) => Date.parse(b.delivery?.mergedAt ?? b.observation!.mergedAt!) - Date.parse(a.delivery?.mergedAt ?? a.observation!.mergedAt!)).slice(0, 50)
    .map(async item => ({ key: item.key, mergedAt: (item.delivery?.mergedAt ?? item.observation!.mergedAt)!, attempts: item.pipeline?.attempts?.length ?? 0,
      events: await itemLedger(masterApi, item.id) })));
  const stopped = stoppedRoles(fleet, now, master.run.intervalSeconds * 1000, session?.session ?? null);
  // GY-3235: a profile skipped after failing its launch probe twice, with the cause, while its backoff stands.
  const cursor = await readDispatchCursor(root, master).catch(() => null);
  const backedOff = backedOffProfiles(cursor ?? { profileBackoff: {} }, now)
    .map(entry => ({ subject: `${entry.role} profile ${entry.profile}`, text: `Backed off until ${entry.until}, the next profile launches instead: ${entry.cause}`, next: 'Grant the path the launch probe names; the profile is tried again once its backoff ends' }));
  // GY-3413: an item whose worker launch failed the same way twice waits out its backoff, one line naming the reason and the retry.
  const launchFailures = (state ? repeatedLaunchFailures(state, now) : []).flatMap(entry => {
    const item = open.find(candidate => candidate.id === entry.id);
    return item ? [{ subject: item.key, text: `${item.key}'s worker launch failed ${entry.failures} times with the same reason, so it is not relaunched until ${entry.until}: ${entry.reason}`,
      next: `Repair the cause the reason names; the loop launches ${item.key} again once its backoff ends` }] : [];
  });
  const reworked = reworkAttention(open);
  // GY-3331: a product review that could not run, one line per item — the fault is the launch's
  // or the reviewer's own environment, retried on another eligible reviewer, never the worker's.
  const couldNotRunReviews = open.flatMap(item => {
    const review = item.productReview;
    if (!review || review.verdict !== 'could-not-run' || review.sha !== item.candidate?.sha) return [];
    return [{ subject: item.key, text: `${item.key}'s product review could not run on ${review.sha.slice(0, 12)}: ${(review.findings.split('\n')[0] ?? '').slice(0, 300)}; another eligible reviewer is tried, and the item never returns to its worker for this`,
      next: 'Fix what the review names (its GRAPHYARD_URL, the Graphyard CLI, or a browser tool on the reviewer\'s PATH), or route product review to a runtime that has them' }];
  });
  // GY-3299: worker-pool growth the loop could not do, with the cause and the capacity it leaves, until growth succeeds.
  // GY-3304: a drain stands until master resume; it names why and who asked.
  const drain = readHeavyDrain(heavyJobsDirectory()), strictCap = readStrictCap(heavyJobsDirectory(), now);
  const standing = (limit: { value: number; until: string } | undefined) => standingLimit(limit, now) === undefined ? null : limit!;
  const drained = drain ? [{ subject: 'heavy work', text: heavyDrainLine(drain), next: 'graphyard master resume once the quiet window is over' }] : [];
  const growth = state?.actions[workerGrowthKey]?.state === 'failed' ? [{ subject: 'worker pool', text: state.actions[workerGrowthKey]!.detail, next: 'Fix the cause named; the next loop cycle adds the missing worker profiles and clears this' }] : [];
  // GY-3328: the trial host lacks the trial image and could not provision it, until a trial runs again.
  const trialImageFault = state?.actions[trialImageKey]?.state === 'failed' ? [{ subject: 'trial image', text: state.actions[trialImageKey]!.detail, next: 'Fix Docker on the trial host as the error names; the next merge trial provisions the image again and clears this' }] : [];
  // GY-3336: the remote refusing the fetch of the base branch — one line quoting the remote's
  // refusal and the fix — while the loop's backoff stands.
  const fetchRefused = state?.actions[fetchRefusalKey]?.state === 'failed' ? [{ subject: 'the repository', text: state.actions[fetchRefusalKey]!.detail, next: 'Fix what the line names; the loop fetches again once its backoff passes and clears this' }] : [];
  // GY-3336: the master session's launch failing the same way three times — one line while the
  // loop's backoff stands, instead of a failed pane per cycle.
  const launchRefused = state?.actions[masterLaunchKey];
  const launchBackoff = launchRefused?.state === 'failed' && launchRefused.attempts >= masterLaunchBackoffAfter
    ? [{ subject: 'the master session', text: launchRefused.detail, next: 'Repair the cause the failure names; the loop launches the master again once its backoff passes' }] : [];
  // GY-3293: a cycle step failing the same way ten consecutive cycles — attention naming the step
  // and the error, raised by the loop itself (the same line the dashboard's Setup page carries as
  // its Needs you item), so it reaches the operator even with no master session to prompt.
  // GY-3344: each message a reporter (another install's Master) sent that the Master has not replied to, naming the sender.
  // GY-3345: one this Master sent a peer is not; a peer's message is answered with master send, which carries the reply back.
  const messages: { id: number; from: string; to?: string; text: string; at: string; replies: unknown[] }[] = unreachable ? [] : await Promise.resolve().then(() => masterApi('master/messages')).then(body => Array.isArray(body?.messages) ? body.messages : [], () => []);
  const messageAttention = messages.filter(message => !message.to && !message.replies.length).reverse().map(message => ({ subject: `message ${message.id} from ${message.from}`,
    text: `${message.from} wrote ${formatAge(message.at, now)} ago: ${message.text}`, next: master.peers?.some(peer => peer.name === message.from)
      ? `Act on it, then graphyard master send ${message.from} --reply ${message.id} TEXT (or master reply ${message.id} TEXT to dismiss it without sending)` : `Act on it, then graphyard master reply ${message.id} TEXT` }));
  const stepFailureAttention = standingStepFailures(state ?? { actions: {} }).map(detail => ({ subject: 'the master loop', text: detail, next: 'Read the loop journal for the failing step and repair its cause; the alert clears on the first cycle the step succeeds' }));
  // GY-3383: the gate record once — a held batch gate is one attention line naming the hold and its reason.
  const gateRecord = readGateRecord(gateRecordPath(root));
  const heldGateAttention = gateHoldAttention(gateRecord, now);
  // GY-3450: a gate in flight whose checks have not started for five minutes, naming who holds the host's heavy-job slots.
  const gateStalled = state?.actions[gateStallKey]?.state === 'failed' ? [{ subject: 'the batch gate', text: state.actions[gateStallKey]!.detail, next: 'Free a host heavy-job slot (stop the stuck holder it names); the alarm clears once a gate check starts' }] : [];
  // GY-3438: a session using far more than its share of a saturated machine for five minutes raises the overload alarm, naming it.
  const overloadAttention = overloaded(state?.sessions ?? [], now).map(session => ({ subject: session.name ?? session.unit, text: `Overload: ${overloadAlarm(session, now)}`, next: 'The session is only held to its share, not stopped; see what it runs on the Workers page' }));
  return {
    // GY-3432: the stall alarm the loop raised, first, until a launch starts or the item is acted on.
    stallAlarm: state?.actions[stallAlarmKey]?.detail ?? null,
    // GY-3095: the pipeline has stopped where a role cannot launch; each line names the role, the refusal, how long it has lasted and the next command.
    // GY-3204: and each application whose versionUrl lags main or fails to answer.
    attention: [...leaseLosses, ...blockerAttention, ...drained, ...growth, ...trialImageFault, ...trialFloorAttention(), ...stopped, ...launchFailures, ...reworked, ...couldNotRunReviews, ...(cursor ? reviewLaunchAttention(open, cursor, now) : []), ...backedOff, ...unspecifiedModelAttention(fleet), ...loggedOutAttention(fleet), ...applicationAttention(observed), ...(declarationError ? [{ subject: 'delivery.applications', text: `Applications not observed: ${declarationError}`, next: `Fix graphyard.json delivery on ${master.baseBranch}` }] : []), ...stepFailureAttention, ...messageAttention, ...fetchRefused, ...launchBackoff, ...heldGateAttention, ...outdatedShimAttention(state?.hosts ?? []), ...gateStalled, ...overloadAttention, ...(report.onboarding.fault ? [{ subject: 'e2e.serve', text: `${report.onboarding.fault} Master fault: ${master.repository} is not onboarded.`, next: 'The Master must declare the real application serve and feature map on main.' }] : [])] as (Partial<StoppedRole> & Pick<StoppedRole, 'subject' | 'text' | 'next'>)[],
    // GY-3199: the control plane's own update record — the Graphyard commit this install runs, its
    // last check and last update, the step of a failed upgrade, and the staleness the daily
    // diagnostics reports (a check over a day old, or a verified commit first seen over a day ago
    // that the install still does not run). Never the managed repository's serving (GY-2955).
    controlPlaneUpdate: controlUpdate ? { ...controlUpdate, publishedVersion: await npmPublishedVersion(run) } : null,
    controlPlane: unreachable || recorded ? { reachable: !unreachable, error: unreachable ?? recorded?.error ?? null, unreachableSince: recorded?.unreachableSince ?? null, lastExitReason: recorded?.exitReason ?? null, freeDisk: recorded?.freeDisk ?? null, restartedAt: recorded?.restartedAt ?? null, restart: recorded?.restart ?? null } : { reachable: true },
    serving,
    applications,
    ...(declarationError ? { applicationsError: declarationError } : {}),
    // GY-3101: the stalled-yard alert. On, with the stop it last recorded; off names itself, because no run.alertUrl is configured.
    alerts: master.run.alertUrl
      ? { on: true, url: master.run.alertUrl, minutes: alertMinutesOf(master.run), stoppedAt: state?.alerts.stoppedAt ?? null, lastAlertAt: state?.alerts.lastAlertAt ?? null }
      : { on: false },
    // GY-3122: free space below the floor after the loop reclaimed its own leftovers: no new trial or worker starts.
    diskHeadroom: state?.diskHeadroom ?? null,
    heavyDrain: drain,
    // GY-3447: who holds the host's heavy-job slots (trials, gates, whole suites, deploy builds) and the limit they share.
    heavyJobs: { limit: heavyJobLimit(heavyJobsDirectory()), holders: slotHolders(heavyJobsDirectory()) },
    // GY-3446: the temporary limits standing now, each with the time it reverts to the default; null once expired or never set.
    temporaryLimits: { trialCap: standing(master.run.trialCap), launchHotCelsius: standing(master.run.launchHotCelsius), hostHeavyJobs: strictCap ? { value: strictCap.limit, until: strictCap.until, by: strictCap.requestedBy } : null },
    // GY-3348: the host's CPU as the loop last read it — pressure (avg60) and steal percent, the
    // same figures the Workers page shows, with the hottest CPU sensor (GY-3373) — and the one
    // waiting line while launches are held; GY-3401: each new session's test budget and the trial cap.
    cpuPressure: state?.cpuPressure
      ? { at: state.cpuPressure.at, avg60: state.cpuPressure.avg60, steal: state.cpuPressure.steal, celsius: state.cpuPressure.celsius,
        // GY-3532: the latest package sample beside the 120 s mean the heat rule compares (null under 4 samples).
        ...((heat) => ({ latestCelsius: heat?.latest ?? null, meanCelsius: heat?.mean ?? null }))(heatReading(state.cpuPressure.samples)),
        waiting: implementationWaiting(state), testBudget: state.cpuPressure.testBudget, trialCap: state.cpuPressure.trialCap }
      : null,
    // GY-3438: every live agent session with its CPU and memory use beside its fair share, as the loop last read its cgroup.
    sessionUsage: (state?.sessions ?? []).map(session => ({ session: session.name ?? session.unit, use: sessionFigures(session), overSince: session.overSince })),
    // GY-3190: the latest daily report of what the loop's sweeps stopped or removed, and the disk Graphyard's leftovers hold.
    leftovers: state?.leftovers.report ?? null,
    loop: loop ? { state: loop.liveness.state, detail: loop.liveness.detail, cycle: loop.cycle, steps: loop.metrics?.steps ?? null } : { state: 'absent', detail: 'The loop cursor cannot be read' },
    // The loop's own master session (GY-2949): working / idle / `limited until T` while the account hold stands / absent.
    masterSession: { ...masterSummary(session ?? emptyMasterSession(), now, masterAgent, masterScreen), screenError },
    delivery: stalled.length ? { state: 'stalled', reason: stalled.map(cause => cause.detail).join('\n'), nextAction: stalledDeliveryAction }
      : { state: state?.mergeWriter.inFlight ? 'validating' : 'no shared base failure', reason: null, nextAction: null },
    deliverySpeed: deliverySpeed(merged, open, now),
    // GY-3418: the host's busy CPU-seconds per merged item over the last 7 days, with the target: half the first measured day's figure.
    cpuPerMergedItem: cpuPerMergedItem(state?.cpuSeconds?.days ?? {}, mergedAt, now),
    workerVerifications: snapshot.workerVerifications ?? [],
    items: open.map((item, index) => itemLine(item, now, launched[index])),
    ...(personalScopes > 0 ? { personalScopes: `${personalScopes} items in personal scopes` } : {}),
    mergeWriter: (({ queue, inFlight, inFlights, lastMergeAt, refusals, serveRevert, trials, stepMedians }) => ({ queue, inFlight, ...(inFlights ? { inFlights } : {}), lastMergeAt, trials: trials ?? [], stepMedians: stepMedians ?? {}, lastRefusal: refusals.at(-1) ?? null,
      // GY-2990: a revert that failed its own trial is held here, with the serve and reason that held it.
      serveRevert: serveRevert?.held ?? null }))(mergeWriterSummary(state?.mergeWriter, now)),
    trialTests,
    // GY-3412: test shards run on other hosts over the last 20 trials — the share run remotely, trial
    // wall time, waits while a host idled, this machine's peak CPU temperature and each host's latest probe (GY-3517).
    remoteShards: remoteShardSummary(readRemoteShardRuns(root), state?.hosts),
    // GY-3119: the batch gate on main — the verified commit that serves, the gate in flight with its current step, the last run's outcome with its reason or failing check (GY-3141), a held batch and the revert rate over the last 20 merges.
    batchGate: gateSummary(gateRecord),
    // GY-3399: the week's reverts beside the week's gates removed (lessons turned into code), with their items.
    thisWeek: await thisWeekReport(root, now),
    // GY-3146: what the latest verified batch changed and how to try it.
    releaseNote: latestReleaseNote(releaseNotesPath(root)),
    // GY-3285: worker sessions running of the number the registry worker role allows (master workers N sets it).
    workers: `${sessions.filter(session => session.kind === 'implementation').length}/${workersAllowed(master, fleet?.roles ? { roles: fleet.roles.map(role => ({ ...role, name: role.role })) } : null)}`,
    sessions,
    freeWorkers: health.filter(entry => entry.healthy).map(entry => entry.profile.name),
  };
}
/**
 * GY-3421: an item whose review request the loop could not launch — every launch refused, its
 * attempts spent, or reviewer capacity exhausted — one line naming the item, why no reviewer is
 * eligible and what would make one eligible.
 */
export function reviewLaunchAttention(open: readonly Work[], cursor: Pick<DispatchCursor, 'failures' | 'abandoned' | 'capacity'>, now: number) {
  const capacity = cursor.capacity.review && Date.parse(cursor.capacity.review.recheckAt) > now ? cursor.capacity.review : null;
  return open.flatMap(item => {
    const request = liveReviewRequest(item);
    const reason = request && ((cursor.abandoned[request.id] ?? cursor.failures[request.id])?.reason ?? capacity?.reason);
    return reason ? [{ subject: item.key, text: `${item.key}'s review of ${request.sha.slice(0, 12)} has no reviewer: ${reason}`,
      next: `Make a reviewer account eligible — log it in, wait for its reset, or add one to the reviewer role (graphyard master registry role set reviewer ACCOUNT[,ACCOUNT…] --reason R) — then graphyard master review ${item.key}` }] : [];
  });
}
/** GY-3441: each enabled account serving a role that is held as not logged in, with why, so a skipped reviewer is named. */
export const loggedOutAttention = (fleet: Pick<FleetView, 'accounts'> | null) => (fleet?.accounts ?? []).filter(account => account.enabled && account.roles.length && account.loggedIn === false && account.ineligible).map(account =>
  ({ subject: `account ${account.name}`, text: `${account.ineligible} — skipped for ${account.roles.map(entry => entry.role).join(', ')}`, next: `Log ${account.name} in again; the hold lifts when its probe reads the new login, or clear it with graphyard master registry account quota ${account.name} available --reason R` }));
/** GY-3302: each enabled account serving a role whose model names no concrete id runs its runtime's default, perhaps a free model. */
export const unspecifiedModelAttention = (fleet: Pick<FleetView, 'accounts'> | null) => (fleet?.accounts ?? []).filter(account => account.enabled && account.roles.length).flatMap(account => {
  const text = unspecifiedModel(account);
  return text ? [{ subject: `account ${account.name}`, text, next: `graphyard master registry model set ${account.model} --id ID --reason REASON names the model it runs` }] : [];
});
