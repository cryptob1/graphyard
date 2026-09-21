import type { Work } from '../model.js';
import { humanDecisionKinds, type HumanDecisionKind, type HumanRequestRow } from '../model/human-request.js';
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
    '                                Ask the master to widen plannedFiles with PATH... for a',
    "                                reason; `scope-request GY-N EPOCH -` withdraws the open",
    '                                request. The master approves it with one command:',
    '                                `graphyard master scope GY-N`, and the attempt keeps its',
    '                                lease — a free-text blocker that waits on a human is never',
    '                                needed for scope',
  ],
  async run(context, work) {
    const { args, print } = context;
    const epoch = Number(args[0]);
    if (!Number.isInteger(epoch) || epoch < 1) throw new Error('Use scope-request GY-N EPOCH PATH... -- REASON, or scope-request GY-N EPOCH - to withdraw');
    if (args[1] === '-') return print(await workMutation(context, work)('scope', { epoch, paths: [], reason: 'Withdrawn by the worker' }));
    const separator = args.indexOf('--');
    const paths = args.slice(1, separator < 0 ? args.length : separator);
    const reason = separator < 0 ? '' : args.slice(separator + 1).join(' ').trim();
    if (!paths.length || !reason) throw new Error('Name at least one PATH outside plannedFiles and give a REASON after --');
    return print(await workMutation(context, work)('scope', { epoch, paths, reason }));
  },
};

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
