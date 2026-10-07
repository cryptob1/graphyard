import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineCommands } from './registry.js';
import type { CliContext } from './context.js';

/**
 * Goals (GY-1417, src/model/goal.ts). `goal FILE` records one from a JSON file; the rest read a
 * goal or move it on, each a call to /api/goals that the server authorizes and records in the
 * goal's history. A reason is everything after `--`.
 */
const usage = `Use goal FILE | goal list [--all] | goal show GOAL-N | goal draft GOAL-N DRAFT.json | goal approve|refuse|deliver GOAL-N -- REASON
  | goal merged GOAL-N PR [MERGE_SHA] | goal case-change GOAL-N GY-N CASE... -- REASON | goal case-change-approve|case-change-refuse GOAL-N CHANGE_ID -- REASON`;
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
  if (['draft', 'approve', 'refuse', 'deliver', 'merged', 'case-change', 'case-change-approve', 'case-change-refuse'].includes(sub) && !ref) throw new Error(usage);
  if (sub === 'draft') return print(await post('draft', await json(rest[0])));
  if (sub === 'approve' || sub === 'refuse' || sub === 'deliver') return print(await post(sub, { reason: needReason(reason) }));
  if (sub === 'merged') return print(await post('merged', { pr: Number(rest[0]), ...(rest[1] ? { mergeSha: rest[1] } : {}) }));
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
    '  goal merged GOAL-N PR [SHA] | goal deliver GOAL-N -- REASON',
    '                                Record the acceptance PR merged (its cases are then',
    '                                protected), or the goal delivered',
    '  goal case-change GOAL-N GY-N CASE... -- REASON',
    '                                Ask to change protected cases for one item; judged by',
    '                                goal case-change-approve|case-change-refuse GOAL-N ID --',
    '                                REASON, never by the requester or an implementer',
  ],
  readsConnection: () => true,
  run: context => goal(context),
}]);
