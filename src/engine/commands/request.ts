import { randomUUID } from 'node:crypto';
import { activeLease, demand } from '../../model.js';
import { boundedAgentRequests, deciderFor, leaseHeldRequestTypes, requestResolutionRefusal } from '../../model/agent-requests.js';
import type { AgentRequest } from '../../model/agent-requests.js';
import { endAttempt, recordIntervention } from '../../pipeline-speed.js';
import type { Ctx } from './types.js';

export function run(c: Ctx) {
  const { actor, data, now, work } = c;
  demand(['worker', 'producer', 'coordinator', 'admin'].includes(actor.role), 'Worker, producer or coordinator permission required', 403);
  work.agentRequests ??= [];
  if (data.resolve) {
    const open = work.agentRequests.find(entry => entry.id === data.resolve && entry.state === 'open');
    demand(open, 'No open request with that id', 404);
    // The decider the record names is the only party that may close it; otherwise a session
    // could record a request for an approver or the operator and answer it itself.
    const refusal = requestResolutionRefusal(open!, actor);
    demand(!refusal, refusal ?? '', 403);
    open!.state = 'resolved'; open!.resolvedAt = now.toISOString(); open!.resolution = data.reason;
  } else {
    // Recording a typed request is the same write as the command it replaces, so it needs
    // the same authority: the live lease of the attempt that is asking. Only a note, which
    // moves nothing a gate reads, may be recorded without one.
    if (leaseHeldRequestTypes.includes(data.type)) {
      demand(data.epoch !== undefined, `A ${data.type} names the attempt epoch that is asking; it is recorded by the session holding the item`);
      activeLease(work, actor, data.epoch, now);
    } else if (data.epoch !== undefined) activeLease(work, actor, data.epoch, now);
    const request: AgentRequest = { id: randomUUID(), type: data.type, epoch: data.epoch ?? null, requestedBy: actor.id, at: now.toISOString(), reason: data.reason,
      ...(data.humanDecision ? { humanDecision: data.humanDecision } : {}),
      decider: deciderFor(work.key, data), releasedLease: false, state: 'open' };
    // Each type projects onto the state the gates and the existing machinery already read,
    // so a typed request is the same fact as the command it replaces, with a decider named.
    if (data.type === 'blocker') { work.blocker = data.reason; work.blockedAt = now.toISOString(); recordIntervention(work, 'blocked'); }
    // A note is a record; every other type is a hand-off, so the attempt ends here rather
    // than holding the item while its session waits for an answer.
    const release = data.release ?? data.type !== 'note';
    if (release && data.epoch !== undefined && work.lease?.epoch === data.epoch) {
      endAttempt(work, data.epoch, 'released', now); work.lease = null; request.releasedLease = true;
    }
    work.agentRequests = boundedAgentRequests([...work.agentRequests, request], request);
  }
}
