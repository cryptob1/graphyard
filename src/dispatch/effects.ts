import { type SessionInventory, sessionInventory } from '../session-inventory.js';
import { randomUUID } from 'node:crypto';
import { childRunner, type ChildRun } from '../child-runner.js';
import { type Work } from '../model.js';
import { type SessionHandleInput, type RuntimeSession } from '../model/sessions.js';
import { type DispatchRequest } from '../model/dispatch.js';
import { type AgentRegistry } from '../model/registry.js';
import { inspectProducerCredentials } from '../master/config.js';
import { listHerdrAgents } from '../master/herdr.js';
import { readEnvironmentLog, recordObservedExhaustion, selectionKey, type ObservedExhaustion } from '../master/environments.js';
import { type MasterConfig, type ProducerProfile, type ReviewerProfile } from '../master/profiles.js';
import { endRegistrySessionById, registryDocument } from '../master/registry-slot.js';
import { launchReview, reconcileReviews, updateReviewLedger, type ReviewRecord } from '../reviewer.js';
import { readProjectMemory, recordNoteInMemory, writeProjectMemory } from '../project-memory.js';
import { agentToken } from '../master/autonomy.js';
import { launchProducer, reconcileProducers, type ProducerRecord } from '../producer.js';
import { type DispatchCursor, observationWakeIntervalMs, type RepairListener, repairLine, writeDispatchCursor } from './cursor.js';
import { watchInstantExit } from './launch-failover.js';
import { type SessionClosure, closureHandle, herdrSessionListing } from './session-sweep.js';
import { type PostMergeOutcome, unknownParent, postFollowUpItem } from './post-merge.js';
export interface DispatchEffects {
  inventory?: () => Promise<SessionInventory>;
  /** The work snapshot, read within `timeoutMs`: the tick's own read bound, which grows while ticks fail (GY-1373). */
  snapshot: (timeoutMs?: number) => Promise<{ work: Work[]; now: string }>;
  /** Herdr's agent list, or null when Herdr could not be read; read asynchronously, never blocking the loop beside it. */
  agents: () => RuntimeSession[] | null | Promise<RuntimeSession[] | null>;
  credentials: (profiles: ProducerProfile[]) => Promise<Record<string, { available: boolean; reason: string | null }>>;
  /** `released` names the panes, with their names, of settled sessions the pass closed (GY-1072): those names are free for this tick's launches. */
  reconcileReviews: (work: Work[], agents: RuntimeSession[] | null) => Promise<{ reviews: ReviewRecord[]; released?: { pane: string; agentName: string }[] }>;
  reconcileProducers: (work: Work[], agents: RuntimeSession[] | null) => Promise<{ producers: ProducerRecord[] }>;
  launchReview: (work: Work, request: DispatchRequest, profile: ReviewerProfile, agents: RuntimeSession[], observedAt: string) => Promise<unknown>;
  /** GY-2989: the product review of a user-facing feature, launched like a review on the same reviewer lanes. A dispatcher wired without it waits the request instead. */
  launchProductReview?: (work: Work, request: DispatchRequest, profile: ReviewerProfile, agents: RuntimeSession[], observedAt: string) => Promise<unknown>;
  launchProducer: (work: Work, request: DispatchRequest, profile: ProducerProfile, agents: RuntimeSession[], observedAt: string) => Promise<unknown>;
  /**
   * Records a launched reviewer or producer session's durable handle on the item. Without it a
   * launched session is visible only in this host's own ledger, which is the relaying the handle
   * exists to end; a dispatcher wired without it still launches, it simply records nothing.
   */
  recordSession?: (work: Work, handle: SessionHandleInput) => Promise<unknown>;
  /**
   * A session that exited within seconds of its launch on its provider's limit notice (GY-120) is
   * failed over exactly as one exhausted mid-session is (master-daemon.ts): the account its
   * launcher selected is held until the notice's reset, the exhaustion is recorded on the item,
   * and the request launches again on the profile's next account. A dispatcher wired without
   * `holdAccount` records the exit as the refusal it was.
   */
  selectedAccount?: (role: 'reviewer' | 'producer', profile: string) => Promise<{ environment: string | null; kind: string | null } | null>;
  holdAccount?: (account: string, observed: Omit<ObservedExhaustion, 'until'>) => Promise<{ until?: string } | void>;
  reportCapacity?: (work: Work, event: Record<string, unknown>) => Promise<unknown>;
  /**
   * Review by risk in control-plane mode (GY-1525): launches the one post-merge reviewer session of a
   * delivered normal-risk merge commit; a dispatcher wired without it launches none. `createWork`
   * files and releases one follow-up item per BLOCKING finding of its verdict (POST /api/work then
   * /ready, as the master's operator-agent identity), `recordFindings` keeps the other findings in project memory, and
   * `settlePostMerge` records on the ledger what was done so a verdict is filed once.
   */
  launchPostMergeReview?: (work: Work, request: DispatchRequest, profile: ReviewerProfile, agents: RuntimeSession[], observedAt: string) => Promise<unknown>;
  createWork?: (body: unknown, requestId: string) => Promise<{ key: string }>;
  recordFindings?: (work: Work, record: ReviewRecord, findings: string[]) => Promise<unknown>;
  settlePostMerge?: (record: ReviewRecord, outcome: PostMergeOutcome) => Promise<unknown>;
  /**
   * Ends one session record the liveness sweep found settled. A dispatcher wired without it still
   * launches and still judges liveness — it simply leaves the record standing, which is the state
   * GY-113 exists to end, so the shipped `dispatchEffects` always wires it.
   */
  endSession?: (closure: SessionClosure) => Promise<unknown>;
  /**
   * The control plane's agent registry document, or null when it cannot be read (GY-2945); and the
   * end of one of its live sessions — a reviewer or producer session of this host no Herdr pane
   * backs, which the ledgers name and this loop may never have launched, is ended on the second
   * consecutive miss (the first for a completed review ledger record) so it stops consuming
   * its role's concurrency. A dispatcher wired without
   * either leaves the registry's slots to the control plane's own settlement rules.
   */
  registry?: () => Promise<AgentRegistry | null>;
  endRegistrySession?: (session: { id: string; role: string; work: string | null; pane: string | null; agentName: string | null }, reason: string) => Promise<unknown>;
  /**
   * Wakes the item's observation job now (GY-1429), so a verdict a reviewer posted is read and its
   * request settled without waiting on the observation scheduler's cadence. A dispatcher wired
   * without it leaves the reading to that cadence.
   */
  wakeObservation?: (work: Work) => Promise<unknown>;
  /**
   * Hands the tick's snapshot and agent list to the loop beside it (GY-1490, daemon/loop-wake.ts),
   * which wakes its sleep for anything new its next cycle acts on. It never fails the tick.
   */
  observeLoopSubjects?: (work: Work[], agents: RuntimeSession[] | null, clock: number) => void;
  persist: (cursor: DispatchCursor) => Promise<void>;
}
/** Effects bound to the real coordinator process; `config` may be a live source the loop reloads. */
export function dispatchEffects(root: string, config: MasterConfig | (() => MasterConfig), deps: { snapshot: (timeoutMs?: number) => Promise<{ work: Work[]; now: string }>; mutate: (path: string, body: unknown, requestId?: string) => Promise<any>; run?: ChildRun; coordinatorRoot?: string; log?: (line: string) => void; now?: () => number }): DispatchEffects {
  // The dispatcher's own bounded asynchronous runner (GY-125): a `herdr agent start` that takes
  // its whole thirty seconds is awaited here, and the cycle's snapshot read beside it is served.
  const run = deps.run ?? childRunner({ timeoutMs: 90_000 });
  const current = typeof config === 'function' ? config : () => config;
  const log = deps.log ?? (line => console.error(line));
  // A repair is logged once per path: the same over-long string would otherwise be reported on
  // every tick that persists it, when one line naming the path is what a reader needs.
  const repaired = new Set<string>();
  const onRepair: RepairListener = repair => { if (repaired.has(repair.path)) return; repaired.add(repair.path); log(repairLine('persisting', repair)); };
  // The coordinator mutation every handle, closure and wake is recorded through: the loop's own (effects-production.ts).
  const mutate = deps.mutate;
  // An answered request's observation is woken at most once a minute per item (GY-1429): a prioritized
  // resync that waits on no tick, the same wake the loop sends for a refused step (GY-710).
  const observationWakes = new Map<string, number>();
  return {
    snapshot: deps.snapshot,
    inventory: () => sessionInventory(run),
    agents: () => listHerdrAgents(run).then(herdrSessionListing).catch(() => null),
    credentials: profiles => inspectProducerCredentials(root, profiles),
    reconcileReviews: (work, agents) => reconcileReviews(root, current(), { run, work, agents }),
    reconcileProducers: (work, agents) => reconcileProducers(root, current(), work, agents, { run }),
    wakeObservation: async work => {
      const at = (deps.now ?? Date.now)(), previous = observationWakes.get(work.id);
      if (previous !== undefined && at - previous < observationWakeIntervalMs) return;
      for (const [id, wokenAt] of observationWakes) if (at - wokenAt >= observationWakeIntervalMs) observationWakes.delete(id);
      await mutate(`work/${work.id}/resync`, { prioritized: true, wait: false });
      observationWakes.set(work.id, at);
    },
    // Each launch's reads of its own pane are watched: a runtime that exited on its provider's
    // limit notice is failed over below rather than counted as a refusal.
    launchReview: (work, request, profile, agents, observedAt) => { const watch = watchInstantExit(run, deps.now); return launchReview(root, work, profile.name, agents, observedAt, { run: watch.run, start: watch.start, coordinatorRoot: deps.coordinatorRoot, requestId: request.id, request: { sha: request.sha, baseSha: request.baseSha, policyRevision: request.policyRevision } }).catch(error => { throw watch.classify(error); }); },
    // The product review (GY-2989): the same session machinery, with the product prompt and a product launch registration.
    launchProductReview: (work, request, profile, agents, observedAt) => { const watch = watchInstantExit(run, deps.now); return launchReview(root, work, profile.name, agents, observedAt, { run: watch.run, start: watch.start, coordinatorRoot: deps.coordinatorRoot, requestId: request.id, request: { sha: request.sha, baseSha: request.baseSha, policyRevision: request.policyRevision }, product: true }).catch(error => { throw watch.classify(error); }); },
    launchProducer: (work, request, profile, agents, observedAt) => { const watch = watchInstantExit(run, deps.now); return launchProducer(root, work, request, profile, agents, observedAt, { run: watch.run, start: watch.start, coordinatorRoot: deps.coordinatorRoot }).catch(error => { throw watch.classify(error); }); },
    // Post-merge reviews (GY-1525): launched like a review of the delivered merge commit; the follow-ups
    // are filed as the master's operator-agent identity, the one that may create work, never the coordinator's.
    launchPostMergeReview: (work, request, profile, agents, observedAt) => { const watch = watchInstantExit(run, deps.now); return launchReview(root, work, profile.name, agents, observedAt, { run: watch.run, start: watch.start, coordinatorRoot: deps.coordinatorRoot, requestId: request.id, postMerge: { mergeSha: request.sha, ...(request.baseSha !== unknownParent ? { baseTip: request.baseSha } : {}) } }).catch(error => { throw watch.classify(error); }); },
    createWork: async (body, requestId) => {
      const config = current();
      if (!config.operatorAgent) throw new Error('No master operator-agent identity is provisioned; run graphyard master autonomy --admin-token-stdin --apply so the loop can file follow-up items');
      return postFollowUpItem(config.url, await agentToken(root, config, 'operatorAgent'), body, requestId);
    },
    recordFindings: async (work, record, findings) => {
      const memory = await readProjectMemory(root), at = new Date((deps.now ?? Date.now)()).toISOString();
      recordNoteInMemory(memory, { id: `post-merge-review:${work.key}:${record.sha.slice(0, 12)}`, key: work.key, kind: 'post-merge-review', by: record.verdict?.reviewer ?? 'reviewer', at,
        // Every finding, uncut: the entry is bounded by the verdict body the API accepted (65,536 characters).
        text: `Post-merge review of ${record.sha.slice(0, 12)} noted: ${findings.join(' | ')}` });
      await writeProjectMemory(root, memory);
    },
    settlePostMerge: (record, outcome) => updateReviewLedger(root, ledger => { const entry = ledger.reviews.find(candidate => candidate.id === record.id); if (entry) entry.postMergeFollowUps = outcome; }),
    // The handle goes where every Graphyard reader already looks, so watching a reviewer or
    // producer session the loop launched never means reading this host's own ledger.
    recordSession: (work: Work, handle: SessionHandleInput) => mutate(`work/${work.id}/session`, handle, randomUUID()),
    // And ends one when the sweep finds it over. The same coordinator mutation: a record that says
    // running is what holds the role slot, so closing it is as much this loop's job as opening it.
    endSession: (closure: SessionClosure) => mutate(`work/${closure.workId}/session`, closureHandle(closure), randomUUID()),
    // GY-2945: the registry this host's sessions are reconciled against, read with the same
    // coordinator credential every launch authenticates with, and the end of one of its sessions
    // no Herdr pane backs — a null document and an unreadable registry are gaps, never judgments.
    registry: () => registryDocument(current()),
    endRegistrySession: (session, reason) => endRegistrySessionById(current(), session.id, reason),
    // The same three moves the coordination loop makes for a session exhausted mid-work.
    selectedAccount: async (role, profile) => (await readEnvironmentLog(current())).selected?.[selectionKey(role, profile)] ?? null,
    holdAccount: (account, observed) => recordObservedExhaustion(current(), account, observed, deps.now?.(), {}),
    reportCapacity: (work, event) => mutate(`work/${work.id}/capacity`, event),
    persist: cursor => writeDispatchCursor(current(), cursor, onRepair),
  };
}
