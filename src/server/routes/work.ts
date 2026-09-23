import { demand, type Principal } from '../../model.js';
import type { Command } from '../../engine.js';
import { producerIndependenceRefusal, recordEvidenceRefusal, recordLeadViolation } from '../../delegation.js';
import { ciRunBindingSchema, isCiProducer, observeCiCheckRun, type CiRunObservation } from '../../model/ci-proofs.js';
import { defineRoutes, parseJson, type RouteContext } from '../routes.js';
import { approveDecision, requestDecision } from '../decisions.js';
import { listDecisions } from '../decision-ledger.js';
import { answerHumanDecision, listHumanRequests, recordCapacity, requestHumanDecision } from '../waits.js';
import { readEscalationContext } from '../escalation-context.js';
import { judgeClosedQuestion } from '../closed-question.js';

// Every mutating work route refuses a slice lead the same way and leaves the same
// ledger entry. Routing order decides which handler matches first; it must never
// decide whether the attempt is recorded.
const refuseLead = async ({ actor, services }: RouteContext, id: string | null, attemptedAction: string) => {
  if (actor.role !== 'slice-lead') return;
  await recordLeadViolation(services.engine.store, actor, id, attemptedAction);
  demand(false, 'Slice leads cannot perform lifecycle mutations', 403);
};

/** Work mutations: two-party decisions, the guarded merge broker and every engine command. */
export const workRoutes = defineRoutes('work', [
  // Two-party decisions: an agent requests, a second independent agent approves, and the
  // control plane applies. They precede the generic route, which would read them as commands.
  { method: 'GET', path: /^\/api\/work\/([^/]+)\/decisions$/, handle: ({ actor, services }, [id]) => listDecisions(services, actor, decodeURIComponent(id)) },
  // The context a spawned escalation handler decides from: four layers, deterministic, bounded.
  { method: 'GET', path: /^\/api\/work\/([^/]+)\/context$/, handle: ({ actor, services, url }, [id]) => readEscalationContext(services, actor, decodeURIComponent(id), url.searchParams) },
  {
    method: 'POST', path: /^\/api\/work\/([^/]+)\/(decide|approve)$/,
    async handle(context, [id, action]) {
      await refuseLead(context, id, action);
      const data = await parseJson(context), key = context.idempotencyKey(), target = decodeURIComponent(id);
      return action === 'decide' ? requestDecision(context.services, context.actor, target, data, key) : approveDecision(context.services, context.actor, target, data, key);
    },
  },
  // The two waits that stall only their own item (GY-89): a human-only decision a worker records
  // (`park`) and the human answers (`answer`), and the provider capacity the loop observes
  // (`capacity`). They precede the generic route for the same reason the decisions do.
  { method: 'GET', path: '/api/human-requests', handle: ({ actor, services }) => listHumanRequests(services, actor) },
  {
    method: 'POST', path: /^\/api\/work\/([^/]+)\/(park|answer|capacity)$/,
    async handle(context, [id, action]) {
      await refuseLead(context, id, action);
      const data = await parseJson(context), key = context.idempotencyKey(), target = decodeURIComponent(id);
      return action === 'park' ? requestHumanDecision(context.services, context.actor, target, data, key)
        : action === 'answer' ? answerHumanDecision(context.services, context.actor, target, data, key)
        : recordCapacity(context.services, context.actor, target, data, key);
    },
  },
  // A closed-question proof (GY-109): the control plane asks the configured responder against the
  // bound candidate state and records the answer as evidence, never as an approval.
  {
    method: 'POST', path: /^\/api\/work\/([^/]+)\/closed-question$/,
    async handle(context, [id]) {
      await refuseLead(context, id, 'closed-question');
      return judgeClosedQuestion(context.services, context.actor, decodeURIComponent(id), await parseJson(context), context.idempotencyKey());
    },
  },
  {
    method: 'POST', path: /^\/api\/work\/([^/]+)\/merge-(acquire|cancel|verify|commit)$/,
    async handle(context, [id, action]) {
      const { actor, services: { engine, github } } = context;
      // These routes sit above the generic work route, so their own refusal
      // is recorded here rather than inherited from a handler never reached.
      await refuseLead(context, id, `merge-${action}`);
      const data = await parseJson(context, undefined, '{}'), key = context.idempotencyKey();
      if (action === 'acquire') return engine.acquireMerge(actor, id, data, key);
      if (action === 'cancel') return engine.cancelMerge(actor, id, data, key);
      if (action === 'commit') return engine.commitMerge(actor, id, data, key);
      demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
      demand(github, 'GitHub integration is required for merge verification', 503);
      const work = (await engine.store.list()).find(item => item.id === id || item.key === id); demand(work?.submission, 'Submitted work item required', 404);
      const replay = await engine.replayMergeVerification(actor, work.id, data, key); if (replay) return replay;
      const observation = await github.verify(work);
      const before = (await engine.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      const providerTime = await github.serverTime();
      const after = (await engine.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      // Bound DB minus GitHub time using the request interval and GitHub's
      // whole-second Date precision. Keep all network I/O outside transactions.
      observation.clockOffset = { min: before.getTime() - providerTime - 1000, max: after.getTime() - providerTime };
      return engine.verifyMerge(actor, work.id, data, observation, key);
    },
  },
  {
    method: 'POST', path: /^\/api\/work(?:\/([^/]+)\/([a-z]+))?$/,
    async handle(context, [id, command]) {
      const { actor, services: { engine } } = context;
      const attempted = command ?? 'create';
      // Creating work names no existing item, so the refusal is recorded
      // unscoped rather than dropped for want of a ledger to append to.
      await refuseLead(context, id ?? null, attempted);
      const raw = await context.body();
      if (attempted === 'evidence' && id && actor.role !== 'worker') {
        const item = (await engine.store.list()).find(w => w.id === id || w.key === id);
        const dependent = item ? producerIndependenceRefusal(actor as Principal, item, engine.principals) : null;
        if (item && dependent) {
          // An unparsable body is still a recorded refusal; the engine repeats this decision.
          let proof: unknown = null;
          try { proof = JSON.parse(raw.toString() || '{}')?.proof; } catch { proof = null; }
          await recordEvidenceRefusal(engine.store, actor, item.id, proof, dependent);
          demand(false, dependent, 403);
        }
      }
      const input = JSON.parse(raw.toString() || '{}');
      // CI-produced evidence is verified against the job GitHub reports, read here with the
      // control plane's own App so provider I/O stays outside the coordination transaction.
      // The engine repeats every judgement; this only supplies the observation it needs.
      let ciRun: CiRunObservation | null | undefined;
      if (attempted === 'evidence' && id && isCiProducer(actor as Principal)) {
        const { services: { github, repository } } = context;
        demand(github, 'GitHub integration is required to verify CI-produced evidence', 503);
        const binding = ciRunBindingSchema.safeParse(input?.ciRun);
        // A job GitHub cannot report (unknown id, a refused read) leaves nothing to verify against;
        // the engine then refuses the record as unobserved rather than answering a server error.
        try { ciRun = binding.success ? observeCiCheckRun(repository, await github.request(`/check-runs/${binding.data.jobId}`)) : null; } catch { ciRun = null; }
      }
      return engine.execute(actor, attempted as Command, id ?? null, input, context.idempotencyKey(), ciRun === undefined ? {} : { ciRun });
    },
  },
]);
