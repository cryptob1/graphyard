import type { Work } from '../model.js';
import { humanDecisionKinds, type HumanDecisionKind, type HumanRequestRow } from '../model/human-request.js';
import { scopeRequestOutcome } from '../model/scope.js';
import type { CliContext } from './context.js';
import { workMutation, type CliCommand } from './registry.js';

/**
 * The commands a session runs about its own item, rather than about the fleet: the worker's live
 * scope request, and the two halves of a human-only wait — the worker parks the item, the human
 * lists what waits and answers it. `master status` reports on them; none of them is a master
 * command, so they live beside it rather than in it.
 */

/** The worker half of live scope negotiation: ask, or withdraw, without leaving the lease. */
export const scopeRequestCommand: CliCommand = {
  name: 'scope-request',
  scope: 'work',
  help: [
    '  scope-request GY-N EPOCH PATH... -- REASON',
    '                                Ask to widen plannedFiles with PATH... for a reason; the',
    '                                widening rule, a review finding or the independent approver',
    '                                decides it and the attempt keeps its lease. `scope-request',
    '                                GY-N EPOCH --wait` waits up to 9 minutes and prints the',
    '                                outcome; `scope-request GY-N EPOCH -` withdraws the request.',
    '                                A free-text blocker is never needed for scope',
  ],
  async run(context, work) {
    const { args, print } = context;
    const epoch = Number(args[0]);
    if (!Number.isInteger(epoch) || epoch < 1) throw new Error('Use scope-request GY-N EPOCH PATH... -- REASON, scope-request GY-N EPOCH --wait, or scope-request GY-N EPOCH - to withdraw');
    if (args[1] === '-') return print(await workMutation(context, work)('scope', { epoch, paths: [], reason: 'Withdrawn by the worker' }));
    if (args[1] === '--wait') return print(await awaitScopeOutcome(context, work, epoch));
    const separator = args.indexOf('--');
    const paths = args.slice(1, separator < 0 ? args.length : separator);
    const reason = separator < 0 ? '' : args.slice(separator + 1).join(' ').trim();
    if (!paths.length || !reason) throw new Error('Name at least one PATH outside plannedFiles and give a REASON after --');
    return print(await workMutation(context, work)('scope', { epoch, paths, reason }));
  },
};

/**
 * The outcome of this attempt's open scope request, read from the item as the control plane holds
 * it (GY-176): the worker's own command reads durable state, so nothing is pasted into its session.
 * Polls until the request is decided or no longer open, or the wait (bounded under a shell tool's
 * ten-minute limit) runs out, and reports it pending then. An approval clears the request, so one
 * decided before the worker waits is read from the decision this attempt's request received.
 */
export async function awaitScopeOutcome(context: Pick<CliContext, 'api'>, work: Work, epoch: number, options: { waitMs?: number; everyMs?: number; cli?: string } = {}) {
  const decided = decisionOfAttempt(work, epoch);
  const request = work.scopeRequest?.epoch === epoch ? work.scopeRequest : decided && { at: decided.requestedAt, paths: decided.paths };
  if (!request) throw new Error(`${work.key} has no scope request for epoch ${epoch}; ask with scope-request ${work.key} ${epoch} PATH... -- REASON`);
  const ask = { epoch, at: request.at, paths: request.paths }, cli = options.cli ?? 'graphyard';
  const deadline = Date.now() + (options.waitMs ?? 540_000);
  for (let item = work; ; ) {
    const outcome = scopeRequestOutcome(item, ask, cli);
    if (outcome.state !== 'pending' || Date.now() >= deadline) return { key: work.key, epoch, paths: ask.paths, ...outcome, ...(outcome.state === 'pending' ? { next: `Run scope-request ${work.key} ${epoch} --wait again` } : {}) };
    await new Promise(resolve => setTimeout(resolve, Math.min(options.everyMs ?? 10_000, Math.max(0, deadline - Date.now()))));
    item = ((await context.api('work')) as Work[]).find(entry => entry.id === work.id) ?? item;
  }
}

/**
 * The decision this attempt's request received. One recorded before decisions carried their epoch
 * has none, so it is this attempt's only when the live lease is this epoch's, its holder asked,
 * and it was asked after this epoch's claim: a legacy outcome of an earlier attempt never is.
 */
function decisionOfAttempt(work: Work, epoch: number) {
  const decision = work.scopeDecision;
  if (!decision) return null;
  if (decision.epoch !== undefined) return decision.epoch === epoch ? decision : null;
  const claim = work.lastAssignment?.epoch === epoch ? work.lastAssignment.claimedAt : undefined;
  return work.lease?.epoch === epoch && decision.requestedBy === work.lease.owner && !!claim && Date.parse(decision.requestedAt) >= Date.parse(claim) ? decision : null;
}

/**
 * The worker half of a human-only wait (GY-89): record the decision only a human may make as a
 * typed request. The same call ends the attempt's lease and parks the item, so the session exits
 * owning nothing; the human answers it and the loop dispatches the item again.
 */
export const parkCommand: CliCommand = {
  name: 'park',
  scope: 'work',
  help: [
    '  park GY-N EPOCH KIND NEEDED... -- REASON',
    '                                Record a decision only a human may make and end this attempt:',
    `                                KIND is ${humanDecisionKinds.join(', ')};`,
    '                                NEEDED is the exact thing the human must provide. The item',
    '                                parks without a lease and nothing else waits on it',
  ],
  async run(context, work) {
    const { args, print } = context;
    const epoch = Number(args[0]), kind = args[1], separator = args.indexOf('--');
    const needed = args.slice(2, separator < 0 ? args.length : separator).join(' ').trim();
    const reason = separator < 0 ? '' : args.slice(separator + 1).join(' ').trim();
    if (!Number.isInteger(epoch) || epoch < 1 || !humanDecisionKinds.includes(kind as HumanDecisionKind) || !needed || !reason) throw new Error(`Use park GY-N EPOCH KIND NEEDED... -- REASON, where KIND is ${humanDecisionKinds.join(', ')}`);
    return print(await workMutation(context, work)('park', { epoch, kind, needed, reason }));
  },
};

/** The human half: list what waits on you, and answer it. The answer is what resumes the item. */
export const humanRequestsCommand: CliCommand = {
  name: 'human-requests',
  help: ['  human-requests               List every open human-only request: what is needed, why, how', '                                long it has waited, and the command that answers it'],
  async run({ api, print }) {
    const { now, requests } = await api('human-requests') as { now: string; requests: HumanRequestRow[] };
    return print({ observedAt: now, waiting: requests.length, requests: requests.map(row => ({ work: row.work, title: row.title, decision: row.decision, needed: row.request.needed, reason: row.request.reason,
      requestedBy: row.request.requestedBy, requestedAt: row.request.at, waited: waitedText(row.waitedMs), answer: row.answer.cli, decline: row.answer.decline })) });
  },
};
export const answerHumanCommand: CliCommand = {
  name: 'answer',
  scope: 'work',
  help: [
    '  answer GY-N [REQUEST] [--decline] ANSWER...',
    '                                Answer the item\'s open human-only request (operator). The item',
    '                                resumes on its own: the loop dispatches it on its next cycle.',
    '                                --decline keeps it parked with your reason as its blocker',
  ],
  async run(context, work) {
    const open = (work as Work).humanRequest;
    if (!open) throw new Error(`${work.key} has no open human-only request; graphyard human-requests lists the ones that wait`);
    const args = [...context.args];
    // The request id is optional on the command line: an item has at most one open request.
    const request = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args[0] ?? '') ? args.shift()! : open.id;
    const declined = args.includes('--decline');
    const answer = args.filter(arg => arg !== '--decline').join(' ').trim();
    if (!answer) throw new Error('Use answer GY-N [REQUEST] [--decline] ANSWER...');
    return context.print(await workMutation(context, work)('answer', { request, outcome: declined ? 'declined' : 'provided', answer }));
  },
};
/** A wait as a person reads it: minutes under an hour, then hours, then days. */
export const waitedText = (ms: number) => ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))}m` : ms < 172_800_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 86_400_000)}d`;

/** The session commands the CLI registers beside the master's, in the order the help prints them. */
export const sessionCommands: CliCommand[] = [scopeRequestCommand, parkCommand, humanRequestsCommand, answerHumanCommand];
