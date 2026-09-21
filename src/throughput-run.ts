import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { server } from './server.js';
import { executorEffects, runExecutor, type ExecutorStep } from './auto-dispatch.js';
import { controlPlaneHandlers } from './executor.js';
import { masterConfigSchema } from './master.js';
import { holdsMergeExecution } from './model/escalation.js';
import { nextAction } from './model/next-action.js';
import { nearestRankPercentiles, type Percentiles } from './pipeline-speed.js';
import { queueRef, type QueueSpeculation } from './merge-queue.js';
import { judgeThroughput, sampleQueue, type QueueSample, type ThroughputWitness } from './throughput.js';
import type { Observation, Principal, Work } from './model.js';

/**
 * The conducted witness run behind `manual:throughput-without-master` (AC-6).
 *
 * AC-6 is stated over deliveries made *with no master session running*. Production cannot supply
 * them before this change ships — it runs the coordination loop this change replaces, so every
 * delivery in its ledger was moved by a master and `throughput.ts` excludes every one of them —
 * and a criterion that could only be met after the merge it gates is a criterion nothing can ever
 * satisfy. So the witness conducts the window instead of waiting for one: it stands a control
 * plane up, runs stateless executors against it with no master anywhere in the process tree, and
 * measures the deliveries they make, on the wall clock, with the same arithmetic `master status`
 * reports.
 *
 * What is real here is everything the criterion is about. The control plane is the shipped
 * `Engine` over a real Postgres behind the shipped HTTP server, evaluating real gates. The queue
 * is the real action queue, with real derived ids, real leases and real idempotency. The
 * executors are the shipped loop (`runExecutor`) over the shipped HTTP effects
 * (`executorEffects`), each under its own identity and host, claiming and settling through
 * `/api/actions/*` — so the concurrency, the claim races and the settle authority are the
 * production paths, not a simulation of them.
 *
 * What is stood in for is named in the report and nowhere hidden: the provider (no GitHub in a
 * witness run) and the four judgments a language model makes — implement, review, produce
 * evidence and resolve an escalation. Each stand-in does to the control plane exactly what that
 * session really does, and takes no coordination decision of its own. The honest limit that
 * leaves is stated with the verdict: a run whose agents answer immediately measures the
 * coordination the inversion owns, not how long a human-scale agent takes to think.
 */

/** Every part of the world a conducted run cannot have, named with the verdict rather than implied. */
export const fleetStandIns = [
  'the provider: no GitHub is reachable in a witness run, so the pull request each worker stand-in submits is observed from the control plane itself',
  'implement: a worker stand-in claims under its own worker credential, registers a workspace and submits, in place of an agent session writing the change',
  'review: a reviewer stand-in returns an approval of the exact head, in place of an agent session reading it',
  'produce-evidence: a producer stand-in submits a passing record for the exact head, base and policy the request named, under a producer credential independent of the item',
  'the guarded merge reaches the same broker contract (acquire, verify, commit, observe) against the control plane rather than against GitHub',
] as const;

export interface FleetWitnessOptions {
  /** A Postgres the run may create its own schema in; it is never production. */
  databaseUrl: string;
  /** How many items the fleet drives to delivery; the criterion asks for at least ten. */
  deliveries?: number;
  /** How many stateless executors poll the queue. */
  executors?: number;
  /** The executor idle poll interval, how often the control plane reconciles, and how often the queue is sampled. */
  intervalMs?: number; reconcileIntervalMs?: number; sampleIntervalMs?: number;
  /** The run gives up after this long rather than hanging on a queue that will not drain. */
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface FleetWitnessReport {
  startedAt: string; endedAt: string; elapsedMs: number;
  requested: number; delivered: number;
  executors: { id: string; host: string; ran: number; failed: number; kinds: string[] }[];
  /** How long a row waited from being requested to being claimed, over every row the run settled. */
  queueWait: Percentiles;
  /**
   * Every item the run released and did not deliver, with where it stands and what it is waiting
   * for. A run that leaves one behind is not met, whatever the deliveries it did make measured.
   */
  undelivered: { key: string; stage: string; refusals: string[]; nextAction: string | null; lastFailure: string | null }[];
  /** The parts of the world this run stood in for. */
  standIns: readonly string[];
  /** The honest limit of a conducted run, carried beside the verdict. */
  caveat: string;
  witness: ThroughputWitness;
  samples: QueueSample[];
  steps: ExecutorStep[];
}

export const fleetCaveat = 'A conducted run measures the coordination this change owns — who claims a row, how long one waits, whether anything sits idle while actionable, and whether a master is needed at all. It does not measure how long a human-scale agent takes to implement, review or prove an item; the agents here answer immediately, so the submit→merge figure is the coordination component of the criterion and is reported as such.';

/**
 * The run's own connection pool, which a scratch database going away may not take the verdict with.
 *
 * A pool with no `error` listener turns the loss of one idle connection into an uncaught
 * exception, and a witness run loses idle connections as a matter of course: the database it
 * measured against is thrown away when it ends, and `pool.end()` resolves once its clients are
 * forgotten rather than once their sockets have closed, so the server's shutdown can reach a
 * connection the pool has already let go of. That killed the instrument after the fleet had
 * finished and before the verdict was written — a failure of the witness, reported as one of the
 * loop. An idle connection carries no query, so losing one is logged and costs nothing: a query
 * that fails is raised where it was made, and fails the action or the run that made it.
 */
export function witnessStore(databaseUrl: string, log: (line: string) => void = () => {}): Store {
  const store = new Store(databaseUrl);
  store.pool.on('error', error => log(`[witness] an idle database connection was lost (${error.message}); no query was on it`));
  return store;
}

/** Close the pool and wait for its sockets to be gone, so whoever stops the database next races nothing. */
export async function closeWitnessStore(store: Store, graceMs = 2_000): Promise<void> {
  const open = store.pool.totalCount;
  const waiting = new AbortController();
  let removed = 0;
  const gone = new Promise<void>(resolve => {
    if (!open) return resolve();
    store.pool.on('remove', () => { if (++removed >= open) resolve(); });
  });
  await store.close();
  await Promise.race([gone, delay(graceMs, undefined, { signal: waiting.signal }).catch(() => {})]);
  waiting.abort();
}

const token = (label: string) => label.padEnd(32, '0').slice(0, 32);
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);

/**
 * Run the fleet and judge what it delivered.
 *
 * The run owns its control plane for its whole life and closes it again, so a witness leaves
 * nothing behind but its report.
 */
export async function runFleetWitness(options: FleetWitnessOptions): Promise<FleetWitnessReport> {
  const deliveries = options.deliveries ?? 12, executorCount = options.executors ?? 2;
  const intervalMs = options.intervalMs ?? 200, sampleIntervalMs = options.sampleIntervalMs ?? 1_000;
  const reconcileIntervalMs = options.reconcileIntervalMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const log = options.log ?? (() => {});
  if (!Number.isInteger(deliveries) || deliveries < 1) throw new Error('deliveries takes a whole number of items to drive');
  if (!Number.isInteger(executorCount) || executorCount < 1) throw new Error('executors takes a whole number of executors to run');

  const PROOF = 'integration:inverted-loop';
  const operator: Principal = { id: 'witness-operator', role: 'admin', sessionKind: 'human' };
  const workers: Principal[] = [{ id: 'witness-worker-a', role: 'worker', runtime: 'claude' }, { id: 'witness-worker-b', role: 'worker', runtime: 'cursor' }];
  const producer: Principal = { id: 'witness-producer', role: 'producer', proofs: [PROOF] };
  const coordinators: Principal[] = Array.from({ length: executorCount }, (_unused, index) => ({ id: `witness-executor-${index + 1}`, role: 'coordinator' }));

  const store = witnessStore(options.databaseUrl, log);
  await store.init();
  const engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [operator, ...workers, ...coordinators, producer];
  // No provider is reachable, and a witness run must never reach for one: the observations below
  // are the stand-in, made explicitly where the run makes them.
  engine.submissionObserver = null;
  const http = server(engine, [{ ...operator, token: token('witness-operator') }, ...coordinators.map(actor => ({ ...actor, token: token(actor.id) }))]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as any).port}`;

  const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
  const head = (item: Work) => sha40(`${item.key.replace(/\D/g, '')}ead`);
  const base = sha40('ba5e'), mergeSha = (item: Work) => sha40(`${item.key.replace(/\D/g, '')}c0`);
  /** The provider's view of a candidate, as the stand-in supplies it. */
  const observation = (item: Work, overrides: Partial<Observation> = {}): Observation => ({
    clockOffset: { min: 0, max: 0 },
    candidate: { sha: head(item), baseSha: base, pr: item.submission!.pr, branch: item.workspaces.at(-1)!.branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'witness-reviewer', sha: head(item), state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, files: ['src/loop.ts'], scopeFiles: [], at: new Date().toISOString(),
    prState: 'open', draft: false, baseTip: base, baseTree: sha40('7e'), baseTipContained: true, ...overrides,
  });
  /** Publish the queue tip the merge authorization requires, as the queue's own publisher does. */
  const publishTip = async (item: Work) => {
    const current = await reload(item.id);
    if (!current.queue || current.queue.speculation) return current;
    const speculation: QueueSpeculation = { ref: queueRef(current.key), tip: current.candidate!.sha, base: current.candidate!.baseSha, baseTree: sha40('7e'), predecessors: [], policyRevision: current.policyRevision, publishedAt: new Date().toISOString() };
    // Published once per queue entry, and decided by the database rather than by the reading
    // above: two executors that both saw an unpublished entry would otherwise both publish, and
    // the second would move `publishedAt` under an authorization the first had already been given.
    await store.pool.query(`UPDATE work_items SET document=jsonb_set(document,'{queue,speculation}',$2::jsonb)
      WHERE id=$1 AND jsonb_typeof(document #> '{queue}')='object' AND COALESCE(jsonb_typeof(document #> '{queue,speculation}'),'null')='null'`, [current.id, JSON.stringify(speculation)]);
    return reload(current.id);
  };
  /**
   * The guarded merge's own contract, against the control plane: acquire, verify, commit, observe.
   *
   * A reading that lost a race with the reconciliation pass is what the real broker retries
   * rather than reports — the control plane refuses an observation bound to a revision that has
   * since moved, and the next reading is bound to the one that stands. Without that retry here
   * the race would settle the action as failed, and the row would wait out the queue's own
   * backoff before anyone tried again: a measurement of this harness's impatience rather than of
   * the loop. A failure that is not that race is raised, so a merge that genuinely cannot happen
   * still fails its row.
   */
  const staleRead = (error: unknown) => /Task changed while GitHub was being observed|Task changed before merge execution/.test(error instanceof Error ? error.message : String(error));
  /**
   * Apply a reading, and take it again when it lost a race.
   *
   * The control plane refuses an observation bound to a revision that has since moved, exactly as
   * it refuses one from the real provider job, and the real job answers that the way this does:
   * it reads again, against the revision that stands. Letting the lost reading pass instead is
   * not neutral here. The action that asked for it settles as done with nothing applied, a
   * completed row holds its situation for the queue's whole settle window before anyone is owed
   * another attempt, and no provider job exists in a witness run to make the reading in the
   * meantime — so one lost race parked an item for ten minutes, which is a fact about the
   * stand-in and would have been reported as one about the loop. A reading that still cannot be
   * applied is raised, so the action fails and backs off as any failed action does.
   */
  const observeNow = async (item: Work, overrides: Partial<Observation> = {}, attempts = 20): Promise<Work> => {
    const current = await reload(item.id);
    try { return await engine.observe(current.id, current.revision, observation(current, overrides)); }
    catch (error) {
      if (!staleRead(error) || attempts <= 1) throw error;
      await delay(25);
      return observeNow(item, overrides, attempts - 1);
    }
  };
  /**
   * The guarded merge's own contract, against the control plane: acquire, verify, commit, observe.
   *
   * It resumes rather than restarts, because a merge execution is the authority to merge and not
   * a step: once one is held, the control plane refuses any further reading of the item that does
   * not report the matching merge, so beginning again from a fresh observation would be refused
   * for as long as the execution stood. That is what the real broker does with an execution it
   * still owns, and standing down from one it does not is what it does with the other — an
   * execution another instance holds is never resumed (GY-92), so this raises rather than takes it
   * and the row backs off as it should.
   */
  const ownedBy = (owner: string, actor: Principal) => owner === actor.id || owner.startsWith(`${actor.id}#`);
  const holdsOwnExecution = (work: Work, actor: Principal) =>
    !!work.mergeExecution && !work.mergeExecution.fenced && holdsMergeExecution(work, Date.now()) && ownedBy(work.mergeExecution.owner, actor);
  const heldExecution = (work: Work, actor: Principal) => {
    const execution = work.mergeExecution;
    if (!execution || execution.fenced || !holdsMergeExecution(work, Date.now())) return null;
    if (!ownedBy(execution.owner, actor)) throw new Error(`${work.key} has an in-flight merge execution held by ${execution.owner}; this executor stands down rather than resuming it`);
    return execution;
  };
  const mergeItem = async (actor: Principal, item: Work, attempts = 6): Promise<Work> => {
    let current = await reload(item.id);
    try {
      let execution: NonNullable<Work['mergeExecution']> | null = heldExecution(current, actor);
      if (!execution) {
        current = await publishTip(current);
        current = await engine.observe(current.id, current.revision, observation(current));
        execution = (await engine.acquireMerge(actor, current.id, { expectedRevision: current.revision, sha: head(current), baseSha: base, policyRevision: current.policyRevision }, randomUUID())).execution as NonNullable<Work['mergeExecution']>;
        current = await reload(current.id);
      }
      const held = execution!;
      // Each step is skipped when the record already holds it. An execution that was verified,
      // or committed, and lost its reading to a race is resumed from where it stands: committing
      // a second time is refused, and the merge the provider has already been handed is not one
      // to hand it again.
      let committingAt: string | undefined = held.committingAt;
      if (!committingAt) {
        if (!held.verifiedAt) await engine.verifyMerge(actor, current.id, { executionId: held.id }, observation(current), randomUUID());
        committingAt = (await engine.commitMerge(actor, current.id, { executionId: held.id }, randomUUID())).committingAt;
      }
      const mergedAt = new Date(Math.ceil((Date.parse(committingAt!) + 1) / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
      current = await reload(current.id);
      return await engine.observe(current.id, current.revision, { ...observation(current), merged: true, mergeSha: mergeSha(current), mergedAt });
    } catch (error) {
      // An execution this executor already holds is not abandoned half-finished: while it stands,
      // no other broker may take it and every other reading of the item is refused, so walking
      // away would leave the item waiting out the execution's own lease with nobody entitled to
      // move it. The broker that acquired it finishes it or fails it, and that is what this does.
      if (attempts <= 1 || !(staleRead(error) || holdsOwnExecution(await reload(item.id), actor))) throw error;
      await delay(100);
      return mergeItem(actor, await reload(item.id), attempts - 1);
    }
  };

  const config = masterConfigSchema.parse({
    version: 1, url, credentialFile: '/witness/master.token', cliPath: '/witness/graphyard.mjs',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 15368, hostId: 'witness-host', masterAgentName: 'none', herdrWorkspace: 'witness',
    workers: workers.map((actor, index) => ({ name: `witness-worker-${index + 1}`, principal: actor.id, agentName: `witness-agent-${index + 1}`, mode: 'launch', kind: actor.runtime, credentialFile: `/witness/worker-${index + 1}.token`, approvals: 'auto' })),
    reviewer: { appId: 4242, installationId: 99, slug: 'graphyard-reviewer', credentialFile: '/witness/reviewer.json', boundAt: '2026-09-01T00:00:00.000Z' },
    reviewers: [{ name: 'witness-reviewer', agentName: 'witness-review', kind: 'claude', approvals: 'auto' }],
    producers: [{ name: 'witness-producer', principal: producer.id, agentName: 'witness-proof', kind: 'claude', credentialFile: '/witness/producer.token', approvals: 'auto' }],
    run: { reviewerProfile: 'witness-reviewer' },
  });

  const seeded = new Set<string>();
  const startedAt = new Date();
  const stopping = new AbortController();
  const samples: QueueSample[] = [];

  /**
   * One executor's effects: the shipped handlers over the shipped HTTP transport, with the
   * outside world each handler reaches stood in for. The kind selection, the typed inputs, the
   * session-handle recording and the settle path are all the shipped code.
   */
  const effectsFor = (actor: Principal) => {
    const handlers = controlPlaneHandlers(() => config, {
      snapshot: async () => ({ work: await store.list(), now: new Date().toISOString() }),
      // The control-plane calls each handler makes. `resync` is the one that would reach the
      // provider, so the stand-in supplies the reading the observation job would have fetched.
      mutate: async (path, body) => {
        const [, id, command] = path.split('/');
        const item = await reload(id);
        if (command === 'resync') {
          if (item.submission && item.workspaces.length) await observeNow(item, { reviews: [] });
          return engine.resyncWork(actor, id);
        }
        return engine.execute(actor, command as any, id, body, randomUUID());
      },
      agents: () => [],
      workerCredentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
      producerCredentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
      dispatchWorker: async (item, profile) => {
        const who = workers.find(candidate => candidate.id === profile.principal);
        if (!who) throw new Error(`the run has no worker stand-in for profile ${profile.name} (principal ${profile.principal})`);
        let claimed = await engine.execute(who, 'claim', item.id, {}, randomUUID());
        claimed = await engine.execute(who, 'workspace', claimed.id, { epoch: claimed.epoch, host: `witness-${who.id}`, path: `/witness/${claimed.id}-${claimed.epoch}`, branch: `graphyard/${claimed.key.toLowerCase()}-${claimed.epoch}` }, randomUUID());
        await engine.execute(who, 'submit', claimed.id, { epoch: claimed.epoch, pr: Number(claimed.key.replace(/\D/g, '')) || 1 }, randomUUID());
        return { pane: 'witness-worker' };
      },
      launchReview: async item => {
        await observeNow(item);
        return { pane: 'witness-review' };
      },
      launchProducer: async (item, request) => {
        const current = await reload(item.id);
        for (const proof of request.proofs ?? []) await engine.execute(producer, 'evidence', current.id, { proof, sha: request.sha, baseSha: request.baseSha, policyRevision: request.policyRevision, result: 'pass', executed: 3, skipped: 0 }, randomUUID());
        return { pane: 'witness-proof' };
      },
      merge: async item => {
        await mergeItem(actor, await reload(item.id));
        return { key: item.key, result: 'merge requested; Graphyard will mark Done only after observing the merge' };
      },
      observeDeployment: async delivered => ({ source: 'endpoint', sha: sha40('de'), at: new Date().toISOString(), reason: null, deployed: delivered.map(item => item.key), pending: [] }),
      recordSession: (item, handle) => engine.execute(actor, 'session', item.id, handle, randomUUID()),
    });
    // The claim, the renewal and the settlement go over HTTP under this executor's own
    // credential: that is the coordination surface the criterion is about.
    return executorEffects({ url, token: token(actor.id) }, handlers);
  };

  try {
    for (let index = 0; index < deliveries; index++) {
      const created = await engine.execute(operator, 'create', null, { title: `Witness delivery ${index + 1}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }] }, randomUUID());
      await engine.execute(operator, 'ready', created.id, {}, randomUUID());
      seeded.add(created.id);
    }
    log(`[witness] ${deliveries} items released; ${executorCount} executor(s) polling, no master session in the run`);

    const fleet = coordinators.map((actor, index) => ({ identity: { id: actor.id, host: `witness-host-${index + 1}` }, effects: effectsFor(actor) }));
    const running = fleet.map(member => runExecutor(member.identity, member.effects, { intervalMs, signal: stopping.signal, log }));

    // The control plane's own reconciliation pass, which production runs as a server worker: it
    // re-evaluates items nothing has mutated — the next candidate in the merge queue above all —
    // and is what keeps a queue that is waiting its turn from being a queue nobody is serving.
    // It ticks on its own interval; the queue is sampled on the slower one, because a sample is a
    // reading for the witness rather than a step of the loop.
    const deadline = Date.now() + timeoutMs;
    let nextSample = 0;
    for (;;) {
      await engine.reconcile();
      const all = await store.list();
      if (Date.now() >= nextSample) { samples.push(sampleQueue(all, new Date())); nextSample = Date.now() + sampleIntervalMs; }
      const mine = all.filter(item => seeded.has(item.id));
      if (mine.every(item => item.stage === 'done')) break;
      if (Date.now() >= deadline) { log(`[witness] the run reached its ${Math.round(timeoutMs / 1000)}s deadline with ${mine.filter(item => item.stage === 'done').length}/${deliveries} delivered`); break; }
      await delay(reconcileIntervalMs);
    }
    stopping.abort();
    const results = await Promise.all(running);
    const endedAt = new Date();

    const all = await store.list();
    const mine = all.filter(item => seeded.has(item.id));
    samples.push(sampleQueue(all, endedAt));
    const steps = results.flatMap(result => result.steps);
    // How long each row waited from being requested to being claimed: the latency the number of
    // executors moves, and the one a single master session used to set by its poll interval.
    const waits: number[] = [];
    for (const item of mine) for (const row of [...(item.actionQueue?.actions ?? []), ...(item.actionQueue?.history ?? [])]) {
      const requested = row.history.find(entry => entry.event === 'requested');
      const claimed = row.history.find(entry => entry.event === 'claimed');
      if (requested && claimed) waits.push(Math.max(0, Date.parse(claimed.at) - Date.parse(requested.at)));
    }
    const judged = judgeThroughput(mine, endedAt.getTime(), samples, { since: startedAt.toISOString() });
    // The run released these items itself, so one it did not deliver is a finding and not a gap
    // in the sample: ten good deliveries do not certify a loop that left the eleventh stuck.
    const undelivered = mine.filter(item => item.stage !== 'done').map(item => {
      const next = nextAction(item, all, endedAt);
      const failure = steps.filter(step => (step.work === item.id || step.work === item.key) && step.result === 'failed').at(-1);
      return { key: item.key, stage: item.stage, refusals: item.gates.filter(gate => !gate.passed).flatMap(gate => gate.reasons.map(reason => `${gate.name}: ${reason}`)),
        nextAction: next ? `${next.kind}: ${next.reason}` : null, lastFailure: failure ? `${failure.kind} by ${failure.executor}: ${failure.reason}` : null };
    });
    const witness: ThroughputWitness = undelivered.length ? { ...judged, met: false, reasons: [...judged.reasons,
      `${undelivered.length} of the ${deliveries} items the run released ${undelivered.length === 1 ? 'was' : 'were'} not delivered within ${Math.round(timeoutMs / 1000)}s: ${undelivered.map(entry => `${entry.key} in ${entry.stage}${entry.lastFailure ? ` (${entry.lastFailure})` : ''}`).join('; ')}`] } : judged;
    return {
      startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), elapsedMs: endedAt.getTime() - startedAt.getTime(),
      requested: deliveries, delivered: mine.filter(item => item.stage === 'done').length,
      executors: fleet.map(member => ({ id: member.identity.id, host: member.identity.host,
        ran: steps.filter(step => step.executor === member.identity.id && step.action).length,
        failed: steps.filter(step => step.executor === member.identity.id && step.result === 'failed').length,
        kinds: [...new Set(steps.filter(step => step.executor === member.identity.id && step.kind).map(step => step.kind!))].sort() })),
      queueWait: nearestRankPercentiles(waits),
      undelivered, standIns: fleetStandIns, caveat: fleetCaveat, witness, samples, steps,
    };
  } finally {
    stopping.abort();
    await new Promise<void>(resolve => http.close(() => resolve()));
    await closeWitnessStore(store);
  }
}
