import { demand, type Principal } from '../../model.js';
import { flagPathRefusal, RenewalFault, type Command } from '../../engine.js';
import { leaseCommands } from '../../store/pools.js';
import { producerIndependenceRefusal, recordEvidenceRefusal, recordLeadViolation } from '../../delegation.js';
import { ciRunBindingSchema, isCiProducer, observeCiCheckRun, type CiRunObservation } from '../../model/ci-proofs.js';
import { defineRoutes, parseJson, type RouteContext } from '../routes.js';
import { approveDecision, requestDecision } from '../decisions.js';
import { listDecisions } from '../decision-ledger.js';
import { answerHumanDecision, listHumanRequests, recordCapacity, requestHumanDecision } from '../waits.js';
import { readEscalationContext } from '../escalation-context.js';
import { judgeClosedQuestion } from '../closed-question.js';
import { recordBlockerProbe } from '../blocker-probe.js';
import { closeWork } from '../close.js';
import { recordTriage } from '../followups.js';
import { answerResearch, recordResearch } from '../../research.js';
import { recordDecomposition } from '../../decomposition.js';
import { recordShadowVerdict } from '../shadow-verdict.js';
import { recordReviewLaunch, recordReviewVerdict } from '../review-verdict.js';
import { issuePushCredential } from '../push-credential.js';
import { controlPlaneSyncPush } from '../../sync.js';

/** Whether a request is a lease command (store/pools.ts `leaseCommands`), which authenticates and runs on the lease pool (GY-558). */
export const leaseCommandRequest = (method: string | undefined, pathname: string) => {
  const command = method === 'POST' ? /^\/api\/work\/[^/]+\/([a-z]+)$/.exec(pathname)?.[1] : undefined;
  return !!command && leaseCommands.has(command);
};

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
      // A flag is never a planned path (GY-522): refused when the revision is asked, not only when
      // its approval applies it through the engine.
      const request = data as { action?: string; input?: { plannedFiles?: unknown } } | null;
      const planned = action === 'decide' && request?.action === 'requirements' && Array.isArray(request.input?.plannedFiles) ? request.input.plannedFiles.filter((path): path is string => typeof path === 'string') : undefined;
      const flag = flagPathRefusal(planned, 'plannedFiles'); demand(!flag, flag!, 422);
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
  // The loop's probe of a standing blocker's cause (GY-1008): recorded, and on a pass the blocker cleared.
  {
    method: 'POST', path: /^\/api\/work\/([^/]+)\/blocker-probe$/,
    async handle(context, [id]) {
      await refuseLead(context, id, 'blocker-probe');
      return recordBlockerProbe(context.services, context.actor, decodeURIComponent(id), await parseJson(context), context.idempotencyKey());
    },
  },
  // Research before build (GY-259): the loop records a run and its brief as the coordinator, and
  // the operator answers the brief's product questions. Neither holds the item. Splitting a broad
  // item before dispatch (GY-1126): the loop records the run, and the split it decides is made here.
  {
    method: 'POST', path: /^\/api\/work\/([^/]+)\/(research|research-answer|decomposition)$/,
    async handle(context, [id, action]) {
      await refuseLead(context, id, action);
      const data = await parseJson(context), key = context.idempotencyKey(), target = decodeURIComponent(id);
      if (action === 'decomposition') return recordDecomposition(context.services, context.actor, target, data, key);
      return action === 'research' ? recordResearch(context.services, context.actor, target, data, key) : answerResearch(context.services, context.actor, target, data, key);
    },
  },
  // Closing an item that will never be delivered: the master's or an admin's, never a worker's.
  {
    method: 'POST', path: /^\/api\/work\/([^/]+)\/close$/,
    async handle(context, [id]) {
      await refuseLead(context, id, 'close');
      return closeWork(context.services, context.actor, decodeURIComponent(id), await parseJson(context), context.idempotencyKey());
    },
  },
  // The triage agent's judgement of a machine-filed item (GY-402). Review follow-ups are no longer
  // recorded, filed or promoted (GY-1249): findings worth fixing are fixed on the same pull request.
  {
    method: 'POST', path: /^\/api\/work\/([^/]+)\/triage$/,
    async handle(context, [id]) {
      await refuseLead(context, id, 'triage');
      return recordTriage(context.services, context.actor, decodeURIComponent(id), await parseJson(context), context.idempotencyKey());
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
  // The shadow merge gate's verdict for a head (GY-1522): an observation recorded by the loop's coordinator identity only.
  {
    method: 'POST', path: /^\/api\/work\/([^/]+)\/shadow-verdict$/,
    async handle(context, [id]) {
      await refuseLead(context, id, 'shadow-verdict');
      return recordShadowVerdict(context.services, context.actor, decodeURIComponent(id), await parseJson(context), context.idempotencyKey());
    },
  },
  // Review by risk in control-plane mode (GY-1525): the coordinator registers each reviewer launch
  // with its token hash, and the launched session posts its one verdict as that token.
  {
    method: 'POST', path: /^\/api\/work\/([^/]+)\/(review-launch|review-verdict)$/,
    async handle(context, [id, action]) {
      await refuseLead(context, id, action);
      const data = await parseJson(context), key = context.idempotencyKey(), target = decodeURIComponent(id);
      return action === 'review-launch' ? recordReviewLaunch(context.services, context.actor, target, data, key) : recordReviewVerdict(context.services, context.actor, target, data, key);
    },
  },
  // A worker session's short-lived push credential (GY-999), for the lease holder only.
  {
    method: 'POST', path: /^\/api\/work\/([^/]+)\/push-credential$/,
    async handle(context, [id]) {
      await refuseLead(context, id, 'push-credential');
      return issuePushCredential(context.services, context.actor, decodeURIComponent(id), await parseJson(context));
    },
  },
  // A base sync carrying the base branch's workflow changes, pushed by the control plane (GY-1098).
  {
    method: 'POST', path: /^\/api\/work\/([^/]+)\/sync-push$/,
    async handle(context, [id]) {
      await refuseLead(context, id, 'sync-push');
      return controlPlaneSyncPush(context.services, context.actor, decodeURIComponent(id), await parseJson(context, 64 * 1024 * 1024));
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
        const item = await engine.store.workDocument(id);
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
      try { return await engine.execute(actor, attempted as Command, id ?? null, input, context.idempotencyKey(), ciRun === undefined ? {} : { ciRun }); }
      catch (error) {
        // A renewal that failed server-side says what grace its recorded fault earned (GY-558), so the supervisor keeps retrying through it.
        if (error instanceof RenewalFault) return context.send(503, { error: error.message, renewalFault: error.grace });
        throw error;
      }
    },
  },
]);
