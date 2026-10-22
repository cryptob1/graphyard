// Concern: the production wiring of the cycle's effects — every read, launch and write the loop runs, bound to one coordinator process.
import { wakeOwnObservation } from '../master/base-break-refresh.js';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { type ChildRun, childRunner } from '../child-runner.js';
import type { Work } from '../model.js';
import type { SessionHandleInput } from '../model/sessions.js';
import { paneAlreadyGone, withPaneGone } from '../request-settlement.js';
import { dispatchRefusal } from '../server/plane-health.js';
import { RefusedResponse } from '../model/refusal.js';
import { rerunFailedChecks } from '../master/profiles.js';
import type { CapacityRole, PartialWork } from '../model/capacity.js';
import { readProducerLedger, saveProducerLedger, launchProducer } from '../producer.js';
import { followUpThreadIds, readReviewLedger, updateReviewLedger, launchReview } from '../reviewer.js';
import { defaultAwaitReviewers, readDispatchCursor } from '../auto-dispatch.js';
import { relaunchSession } from './relaunch.js';
import { type MasterSessionEffects, masterSessionEffects } from '../master/master-session.js';
import { type WorkerProfile, type HerdrAgent, type ObservedExhaustion, type ProfileAccountHealth, type MasterConfig, agentToken, holdRepeatedLimitAccount, listHerdrAgents, sessionAccount, preservePartialWork, recordObservedExhaustion, closeHerdrPane, inspectProfileAccounts, inspectProducerCredentials, observeHerdrAgents, inspectWorkerCredentials, deliverPrompt, dispatchWork, writeFailure, herdrJson, readCredentialFile, heldAwareProbe, removeAttemptWorktree, type SessionIdentity } from '../master.js';
import { herdrCall, listHerdrPanes, type HerdrPane } from '../master/herdr.js';
import { httpFleetClient, reconcileFleetSessions, selectFleetSession, settledRecordSessions } from '../fleet.js';
import { type ContainmentRetention, type DaemonAction, type DaemonState, type LoopRelease, storeAction, type DeploymentObservation, message, writeDaemonState } from './state.js';
import { writeProjectMemory } from '../project-memory.js';
import { observeDeployment, deploymentEnvironmentName } from './deployment.js';
import { mergeRecordKey, mergeWriterReads, type MergeWriterReads } from './cycle-merge-writer.js';
import { worktreeRoot } from '../install/worktree-root.js';
import { readingEffects } from './reading-effect.js';
import { alignRunningLoopUnit, awaitSupervisorRestart, detectLoopSupervisorUnit, performSelfUpgrade, recoverMovedHead, type SelfUpgradeDeps, type SelfUpgradeOutcome } from './upgrade.js';
import { loopCodeRoot } from './checkout-state.js';
import { readRelease } from '../protocol-version.js';
import type { RunRecord, Runner } from '../runner/types.js';
import { loopRunAdoption, type AdoptedRun } from './run-adoption.js';
import { answeredMechanicalReviews } from './mechanical-plan-report.js';
import { mechanicalFixState, readMechanicalFixState } from '../mechanical-findings.js';
import { retriedSnapshot } from './snapshot-retry.js';
import { promptTarget, refusedBodyDetail, type DaemonEffects } from './effects.js';

/** Effects bound to the real coordinator process; `config` may be a live source the loop reloads. */
export function daemonEffects(root: string, source: MasterConfig | (() => MasterConfig), deps: {
  snapshot: () => Promise<{ work: Work[]; now: string }>;
  mutate: (path: string, data: unknown, requestId?: string) => Promise<any>;
  /** The child runner; a test's stub, or the process's own bounded asynchronous runner. */
  run?: ChildRun;
  fetcher?: typeof fetch;
}): DaemonEffects {
  // One runner for everything this loop runs — Herdr, gh, git, systemctl. Every child is awaited
  // on the event loop and bounded by the runner's timeout (GY-125).
  const current = typeof source === 'function' ? source : () => source;
  const run = deps.run ?? childRunner({ timeoutMs: 90_000 });
  const fetcher = deps.fetcher ?? fetch;
  const snapshot = async () => { await (await import('../master/environments.js')).reportPendingExhaustions(current(), { fetch: fetcher }).catch(() => {}); return deps.snapshot(); }; // resending first any account hold the agent registry has not heard of (GY-1573)
  const mutate = deps.mutate;
  /** One call as the master's own operator-agent identity — the identity that applies its decisions. */
  const asOperatorAgent = async (method: 'GET' | 'POST', path: string, body?: unknown, key: string = randomUUID()) => {
    const config = current();
    if (!config.operatorAgent) throw new Error('No master operator-agent identity is provisioned; run graphyard master autonomy --admin-token-stdin --apply so the loop can apply routine rework');
    const token = await agentToken(root, config, 'operatorAgent');
    const response = await fetcher(`${config.url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const text = await response.text(); // GY-1751: a proxy's empty or HTML 502-504 keeps its status
    let result: any; try { result = JSON.parse(text); } catch { result = response.ok ? undefined : { text: text.slice(0, 200) }; }
    // GY-1713: the message carries error and zod issues.
    if (!response.ok) throw new RefusedResponse(`Graphyard refused ${path} (${response.status}): ${refusedBodyDetail(result)}`, response.status, result);
    return result;
  };
  /** One read with the loop's own coordinator credential. */
  const asCoordinator = async (path: string, _credential?: string, timeoutMs = 30_000) => {
    const config = current();
    const response = await fetcher(`${config.url}/api/${path}`, { headers: { Authorization: `Bearer ${await readCredentialFile(config.credentialFile)}` }, signal: AbortSignal.timeout(timeoutMs) });
    const result = await response.json();
    // The status travels with the refusal, so a caller can tell a 404 from any other refusal.
    if (!response.ok) throw new RefusedResponse(`Graphyard refused ${path} (${response.status}): ${result?.error ?? JSON.stringify(result)}`, response.status, result);
    return result;
  };
  const rework: DaemonEffects['rework'] = (work, reason, binding) => asOperatorAgent('POST', `work/${work.id}/rework`, { reason, previousWorkerStopped: true, ...(binding ? { binding } : {}) });
  const endRegistrySession: DaemonEffects['endRegistrySession'] = async (session, reason) => {
    const config = current();
    if (config.url) await httpFleetClient({ url: config.url, credentialFile: config.credentialFile }).end(session, reason);
  };
  let publishedEnvironment: string | null = null, publishedMergeQueue: string | null = null;
  /** GY-1524: the recorded merger, read from /api/status afresh for every merge decision (AC-6), never cached: a switch to `github` stops the next merge, not the one after a window. */
  // The control plane is the only merge writer.
  const recordedMerger = async () => 'control-plane' as const;
  // The shared project memory (GY-1125) is mirrored to its own file only when it changed.
  let writtenMemory: string | null = null;
  const persistLoop = async (state: DaemonState) => {
    const memory = state.projectMemory ? JSON.stringify(state.projectMemory) : null;
    if (memory && memory !== writtenMemory) await writeProjectMemory(root, state.projectMemory).then(() => { writtenMemory = memory; }, () => {});
    return writeDaemonState(current(), state);
  };
  const upgradeDeps = (keepAlive?: () => Promise<void>): SelfUpgradeDeps => ({ root, run, // shared with the moved-HEAD recovery (GY-1356)
    restartSelf: async () => {
      const unit = detectLoopSupervisorUnit();
      if (!unit) throw new Error('this loop runs under no graphyard-master supervisor unit, so it cannot re-execute itself; run it under the packaged unit (examples/master/graphyard-master.service), or restart it by hand with systemctl --user restart graphyard-master');
      // --no-block queues the restart; systemd's stop then ends this wait, and reaches this process too (upgrade.ts restartEndedBySupervisorStop).
      await awaitSupervisorRestart(() => run('systemctl', ['--user', '--no-block', 'restart', unit]));
    },
    alignUnit: () => alignRunningLoopUnit(root, current()),
    persist: persistLoop,
    // GY-1982: continuous deploy, through the install's own adapter; imported when first used, as the CLI's upgrade module loads the installer.
    deploy: async () => (await import('../cli/upgrade.js')).deployPorts({ cliRoot: loopCodeRoot(current().cliPath, root), repoRoot: root, repository: current().repository, url: current().url, run, keepAlive }),
  });
  return Object.defineProperties({
    agents: () => listHerdrAgents(run).catch(() => []),
    panes: async () => { try { return { panes: await listHerdrPanes(run), available: true }; } catch { return { panes: [], available: false }; } },
    // A reviewer or producer session ends with its ledger record (GY-205): its Herdr name is not one the registry session determines.
    reconcileSessions: async (runtime, finished) => {
      const settled = new Map(finished);
      for (const [session, reason] of [...settledRecordSessions('reviewer', (await readReviewLedger(root).catch(() => null))?.reviews ?? []), ...settledRecordSessions('producer', (await readProducerLedger(root).catch(() => null))?.producers ?? [])])
        if (!settled.has(session)) settled.set(session, reason);
      return reconcileFleetSessions(current(), runtime, settled);
    },
    // The tail of the session's own terminal, unwrapped so a notice the pane folded reads as one line.
    sessionOutput: async (agent, lines = 60) => { const target = agent.name ?? agent.pane_id; return target ? herdrCall(run, ['agent', 'read', target, '--source', 'recent-unwrapped', '--lines', String(lines), '--format', 'text']) : null; },
    // The decline is typed into the pane and given a moment to close the dialog, so the instruction
    // that follows lands in the runtime's input rather than in the closing menu.
    answerSession: async (agent, keys) => { await herdrCall(run, ['pane', 'send-keys', agent.pane_id!, ...keys]); await delay(2_000); },
    promptSession: async (agent, text) => { await deliverPrompt(promptTarget(agent), text, run); },
    reportCapacity: (work, event) => mutate(`work/${work.id}/capacity`, event),
    adoptRuns: loopRunAdoption(root, current, deps.fetcher),
    launchedSessions: async () => [
      ...(await readReviewLedger(root)).reviews.filter(entry => entry.state === 'pending' && !entry.launching).map(entry => ({ role: 'reviewer' as const, record: entry.id, profile: entry.profile, agentName: entry.agentName, pane: entry.pane, work: entry.key, requestId: entry.requestId ?? null })),
      ...(await readProducerLedger(root)).producers.filter(entry => entry.state === 'pending').map(entry => ({ role: 'producer' as const, record: entry.id, profile: entry.profile, agentName: entry.agentName, pane: entry.pane, work: entry.key, requestId: entry.requestId, group: entry.group })),
    ],
    selectedAccount: (role, profile, session) => sessionAccount(root, current(), role, profile, session), // by the session's own identity (GY-1582)
    preserveWork: async (work, epoch, cause = 'interrupted by provider quota exhaustion') => {
      const workspace = work.workspaces.find(entry => entry.epoch === epoch);
      if (!workspace || workspace.host !== current().hostId) return { state: 'not-applicable', detail: workspace ? `the attempt worktree is on ${workspace.host}, not this host; its commits stay on ${workspace.branch}` : 'the attempt registered no workspace' };
      return preservePartialWork(workspace.path, `${work.key} attempt ${epoch} ${cause}`, run);
    },
    holdAccount: (account, observed) => recordObservedExhaustion(current(), account, observed, undefined, { fetch: fetcher }),
    endSession: async (session, resolution) => {
      // A pane that is already gone is closed (GY-137): the record still settles, and says so.
      let paneGone = false;
      try { if (session.pane) await closeHerdrPane(session.pane, run); } catch (error) { if (!paneAlreadyGone(error)) throw error; paneGone = true; }
      const closedAt = new Date().toISOString(), ended = { state: 'failed' as const, resolution: paneGone ? withPaneGone(resolution, session.pane!, 500) : resolution.slice(0, 500), closedAt };
      if (session.role === 'reviewer') await updateReviewLedger(root, ledger => { ledger.reviews = ledger.reviews.map(entry => entry.id === session.record && entry.state === 'pending' ? { ...entry, ...ended } : entry); });
      else { const ledger = await readProducerLedger(root); await saveProducerLedger(root, { ...ledger, producers: ledger.producers.map(entry => entry.id === session.record && entry.state === 'pending' ? { ...entry, ...ended } : entry) }); }
    },
    relaunch: async (session, work, snapshot) => {
      // launchReview/launchProducer also re-hold before selectAccount (GY-1705); this call keeps the
      // failover path refusing early when the durable hold cannot be written, before a pane starts.
      const holdAt = Date.now();
      await holdRepeatedLimitAccount(current(), work, holdAt, { fetch: fetcher }, session.role).catch((error: unknown) => {
        throw new Error(`${work.key}'s last ${session.role} sessions each ended on one account's limit notice, and the hold that keeps the next launch off it could not be placed: ${message(error).slice(0, 300)}; nothing was relaunched`, { cause: error });
      });
      return relaunchSession(current(), session, work, await listHerdrAgents(run), {
        review: (profile, request, agents) => launchReview(root, work, profile.name, agents, snapshot.now, { run, requestId: request.id }),
        producer: (profile, request, agents) => launchProducer(root, work, request, profile, agents, snapshot.now, { run }),
        record: handle => mutate(`work/${work.id}/session`, handle),
      });
    },
    endRegistrySession,
    roleHealth: async () => {
      const config = current();
      return {
        ...(config.reviewers.length ? { reviewer: { profiles: config.reviewers, health: await inspectProfileAccounts(config, 'reviewer', config.reviewers, Object.fromEntries(config.reviewers.map(profile => [profile.name, { available: true, reason: null as string | null }]))) } } : {}),
        ...(config.producers.length ? { producer: { profiles: config.producers, health: await inspectProducerCredentials(root, config.producers) } } : {}),
      };
    },
    herdr: async () => { const runtime = await observeHerdrAgents(run); return { agents: runtime.agents, available: runtime.available }; },
    credentials: profiles => inspectWorkerCredentials(root, profiles),
    snapshot,
    followUpThreads: async (work, at) => {
      const reviewer = current().reviewer;
      return followUpThreadIds((await readReviewLedger(root)).reviews, work, reviewer ? { reviewer: `${reviewer.slug}[bot]`, now: at } : undefined);
    },
    closeSession: pane => closeHerdrPane(pane, run),
    removeWorktree: path => removeAttemptWorktree(root, path, run),
    planeHealth: () => dispatchRefusal(current().url, fetcher),
    dispatch: (work, profile, agents, snapshot) => dispatchWork(root, work, profile, agents, run, snapshot.work, undefined, undefined, undefined, snapshot.now, { agents: () => listHerdrAgents(run) }),
    recordSession: (work, handle) => mutate(`work/${work.id}/session`, handle),
    wakeObservation: work => mutate(`work/${work.id}/resync`, { prioritized: true, wait: false }),
    reclaimLease: work => mutate(`work/${work.id}/resync`, {}, randomUUID()),
    observe: (work, waitMs) => wakeOwnObservation(body => mutate(`work/${work.id}/resync`, { ...body, prioritized: true }, randomUUID()), ms => delay(ms), { waitMs }),
    // `root` is this checkout: containment is derived from its object store, never from the forge.
    observeDeployment: (delivered, retained) => observeDeployment(current(), delivered, run, fetcher, () => Date.now(), { root, retained }),
    // GY-1524: the executor merges in this checkout's object store, pushes with the install's deploy key alone, records each step as the coordinator under one key per (step, commits), and acts only while the recorded merger is control-plane (read before every merge decision).
    get mergeWriter() { const config = current(); return mergeWriterReads(config, root, run, { base: worktreeRoot(root, config), record: (work, event) => mutate(`work/${work.id}/merge-record`, event, mergeRecordKey(work, event)), merger: recordedMerger }); },
    publishProductionEnvironment: async () => {
      const environment = deploymentEnvironmentName(current(), root);
      if (environment === publishedEnvironment) return;
      await mutate('production-environment', { environment });
      publishedEnvironment = environment;
    },
    // Imported when first run: only this step reads the install modules. Each run also registers the merge
    // writer's deploy key when it is missing (setupRenewingDeployKey; soaked in tests/soak-deploy-key-renewal.test.ts).
    selfProvision: async () => {
      const [{ loopSelfProvision, setupRenewingDeployKey }, { mergeWriterSettings }, { installIdFor }, { DEPLOY_KEY_FILE, ensureDeployKey }, { githubCli }, { localTransport }] = await Promise.all([
        import('../cli/master-setup.js'), import('../master/merge-writer-settings.js'), import('../install/types.js'), import('../install/deploy-key.js'), import('../install/github.js'), import('../install/transport.js')]);
      const config = current(), keyFile = mergeWriterSettings(config.run, installIdFor(config.repository)).deployKeyFile;
      return loopSelfProvision(root, config, { setup: setupRenewingDeployKey(async () => {
        if (basename(keyFile) !== DEPLOY_KEY_FILE) throw new Error(`the configured deploy key ${keyFile} is not the install's own; renewing it is the operator's`);
        return ensureDeployKey(dirname(keyFile), config.repository, githubCli(localTransport()));
      }) });
    },
    publishMergeSettings: async () => {
      const config = { rerunFailedChecks: rerunFailedChecks(current()) };
      const published = JSON.stringify(config);
      if (published === publishedMergeQueue) return;
      await mutate('merge-queue', config);
      publishedMergeQueue = published;
    },
    ...readingEffects(current, mutate), // GY-1779: the loop's own post-deploy readings
    readWork: async work => await asCoordinator(`work/${encodeURIComponent(work.id)}`) as Work,
    recordDeployment: (work, observation) => mutate(`work/${work.id}/deployment`, { sha: observation.sha, mergeSha: work.delivery!.mergeSha, source: observation.source, observedAt: observation.observedAt }),
    exhaustedProofs: async () => Object.entries((await readDispatchCursor(root, current(), () => {})).abandoned).filter(([, entry]) => entry.kind === 'producer')
      .map(([requestId, entry]) => ({ requestId, work: entry.work, sha: entry.sha, group: entry.group ?? null, proofs: entry.proofs ?? [], attempts: entry.attempts, reason: entry.reason })),
    // GY-1814: the read also names the approvals the ledger answered (planned, follow-ups filed, a fresh read, a fallback), so a plan still owed is reported only until the answer lands. A ledger that cannot be read answers everything: the requests-only read carries no `answered`, and the gate never holds what nothing backs.
    mechanicalFixes: async () => { try { const reviews = (await readReviewLedger(root)).reviews; return { ...mechanicalFixState(reviews), answered: answeredMechanicalReviews(reviews) }; } catch { return readMechanicalFixState(root); } }, recordMechanicalPlan: (work, plan, answered) => mutate(`work/${work.id}/mechanicalplan`, plan ? { ...plan, planned: true } : { reviewId: answered?.reviewId ?? work.mechanicalPlan?.reviewId ?? 1, head: answered?.head ?? work.mechanicalPlan?.head ?? work.candidate!.sha, planned: false }),
    // Rework exists only while the live configuration names the master's operator-agent identity; provisioning it brings it back on the next reload.
    get rework() { return current().operatorAgent ? rework : undefined; },
    // systemd-notify keep-alive (NOTIFY_SOCKET; NotifyAccess=all; bounded child via `run`). GY-437: upgrade between cycles, re-exec under the cgroup unit.
    // GY-1899: the release the loop records is the checkout its loaded code comes from — the one
    // the running CLI starts from, read once at process startup — never the managed repository's
    // root, whose HEAD names the managed project. A later move of that checkout is a moved head
    // (GY-1464), still judged between cycles; the startup reading stays what this process loaded.
    loadedRelease: readRelease(loopCodeRoot(current().cliPath, root)),
    selfUpgrade: (state, keepAlive) => performSelfUpgrade(current(), state, upgradeDeps(keepAlive)),
    recoverHead: (state, from, to, keepAlive) => recoverMovedHead(current(), state, from, to, upgradeDeps(keepAlive)),
    notify: async state => { await run('systemd-notify', state === 'ready' ? ['--ready'] : ['WATCHDOG=1']); },
    masterSession: masterSessionEffects(root, current, run),
    persist: persistLoop,
  }, {});
}
