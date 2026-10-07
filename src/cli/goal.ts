import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineCommands } from './registry.js';
import type { CliContext } from './context.js';

/**
 * Goals (GY-1417, src/model/goal.ts), planned by the planner role (GY-1418). `goal FILE` records one from a JSON file; the rest read a
 * goal or move it on, each a call to /api/goals that the server authorizes and records in the
 * goal's history. A reason is everything after `--`.
 */
const usage = `Use goal FILE | goal list [--all] | goal show GOAL-N | goal draft GOAL-N DRAFT.json | goal approve|refuse GOAL-N -- REASON
  | goal land GOAL-N | goal closed GOAL-N PR -- REASON | goal plan GOAL-N PLAN.json | goal plan-approve|plan-refuse GOAL-N -- REASON | goal release GOAL-N | goal deliver GOAL-N GY-N... -- REASON | goal case-change GOAL-N GY-N CASE... -- REASON | goal case-change-approve|case-change-refuse GOAL-N CHANGE_ID -- REASON`;
/** The words before `--`, and the reason after it. */
function split(args: string[]) {
  const at = args.indexOf('--');
  const words = at < 0 ? args : args.slice(0, at), reason = at < 0 ? '' : args.slice(at + 1).join(' ').trim();
  return { words, reason };
}
const json = async (file: string | undefined) => {
  if (!file) throw new Error(usage);
  return JSON.parse(await readFile(resolve(file), 'utf8'));
};
const needReason = (reason: string) => { if (!reason) throw new Error(`Name the reason after --. ${usage}`); return reason; };

async function goal(context: CliContext) {
  const { id: sub, args, api, print } = context;
  const { words, reason } = split(args);
  const [ref, ...rest] = words;
  const post = (verb: string, body: unknown) => api(`goals/${encodeURIComponent(ref ?? '')}/${verb}`, body, process.env.GRAPHYARD_REQUEST_ID ?? randomUUID());
  if (!sub || sub === 'help') throw new Error(usage);
  if (sub === 'list') return print((await api(`goals?view=summary${args.includes('--all') ? '' : '&open=1'}`)).goals);
  if (sub === 'show') return print(await api(`goals/${encodeURIComponent(ref ?? '')}`));
  if (['draft', 'approve', 'refuse', 'deliver', 'land', 'closed', 'plan', 'plan-approve', 'plan-refuse', 'release', 'case-change', 'case-change-approve', 'case-change-refuse'].includes(sub) && !ref) throw new Error(usage);
  if (sub === 'draft') return print(await post('draft', await json(rest[0])));
  if (sub === 'approve' || sub === 'refuse') return print(await post(sub, { reason: needReason(reason) }));
  if (sub === 'deliver') return print(await post('deliver', { items: rest, reason: needReason(reason) }));
  if (sub === 'land') return print(await post('land', {}));
  if (sub === 'plan') return print(await post('plan', await json(rest[0])));
  if (sub === 'plan-approve' || sub === 'plan-refuse') return print(await post(sub, { reason: needReason(reason) }));
  if (sub === 'release') return print(await post('release', {}));
  if (sub === 'closed') return print(await post('closed', { pr: Number(rest[0]), reason: needReason(reason) }));
  if (sub === 'case-change') return print(await post('case-change', { work: rest[0], cases: rest.slice(1), reason: needReason(reason) }));
  if (sub === 'case-change-approve' || sub === 'case-change-refuse') return print(await post(sub, { change: rest[0], reason: needReason(reason) }));
  // Anything else names the goal file to record.
  return print(await api('goals', await json(sub), process.env.GRAPHYARD_REQUEST_ID ?? randomUUID()));
}

export const goalCommands = defineCommands([{
  name: 'goal',
  help: [
    '  goal FILE                     Record a goal from JSON: {statement, users, constraints,',
    '                                deployTarget}. The acceptance role drafts its customer',
    '                                outcomes and one required uat E2E case per outcome',
    '  goal list [--all] | goal show GOAL-N',
    '                                Open goals with stage and next actor; one goal with history',
    '  goal approve|refuse GOAL-N -- REASON',
    '                                Judge an acceptance draft (never its author)',
    '  goal land GOAL-N              Land the approved acceptance PR at its approved head;',
    '                                merged there, its cases are protected',
    '  goal closed GOAL-N PR -- REASON',
    '                                Record the acceptance PR closed unmerged (drafted again)',
    '  goal plan GOAL-N PLAN.json    Record a plan {note, items} for a goal whose acceptance',
    '                                merged (the planner role writes it)',
    '  goal plan-approve|plan-refuse GOAL-N -- REASON',
    '                                Judge a plan (never its author)',
    '  goal release GOAL-N           Create and release the approved plan\'s items in',
    '                                dependency order',
    '  goal deliver GOAL-N GY-N... -- REASON',
    '                                Record the goal delivered once those items are done and',
    '                                served by production',
    '  goal case-change GOAL-N GY-N CASE... -- REASON',
    '                                Ask to change protected cases for one item; judged by',
    '                                goal case-change-approve|case-change-refuse GOAL-N ID --',
    '                                REASON, never by the requester or an implementer',
  ],
  readsConnection: () => true,
  run: context => goal(context),
}]);
