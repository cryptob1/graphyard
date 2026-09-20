import { readFile } from 'node:fs/promises';
import { defineCommands, workMutation } from './registry.js';

/** The worker protocol on one claimed item: lease, blockers, submission and evidence. */
export const leaseCommands = defineCommands([
  {
    name: 'claim',
    scope: 'work',
    help: ['  claim GY-N                   Acquire a two-minute lease; returns epoch'],
    run: async (context, work) => context.print(await workMutation(context, work)('claim', {})),
  },
  {
    name: 'heartbeat',
    scope: 'work',
    help: ['  heartbeat GY-N EPOCH          Extend current lease (refused once the epoch is submitted)'],
    run: async (context, work) => context.print(await workMutation(context, work)('heartbeat', { epoch: Number(context.args[0]) })),
  },
  {
    name: 'release',
    scope: 'work',
    help: ['  release GY-N EPOCH            Release current lease'],
    run: async (context, work) => context.print(await workMutation(context, work)('release', { epoch: Number(context.args[0]) })),
  },
  {
    name: 'register',
    scope: 'work',
    help: ['  register GY-N file.json       Register a Herdr/external workspace'],
    run: async (context, work) => context.print(await workMutation(context, work)('workspace', JSON.parse(await readFile(context.args[0], 'utf8')))),
  },
  {
    name: 'blocked',
    scope: 'work',
    help: ["  blocked GY-N EPOCH REASON     Set blocker; use '-' to clear"],
    run: async (context, work) => context.print(await workMutation(context, work)('blocked', { epoch: Number(context.args[0]), reason: context.args[1] === '-' ? null : context.args.slice(1).join(' ') })),
  },
  {
    name: 'complete',
    scope: 'work',
    help: [
      '  complete GY-N EPOCH PR        Submit implementation and end the lease; gates decide',
      '                                completion. Refused when the PR reverts, deletes or',
      '                                rewrites files outside plannedFiles relative to the base',
    ],
    run: async (context, work) => context.print(await workMutation(context, work)('submit', { epoch: Number(context.args[0]), pr: Number(context.args[1]) })),
  },
  {
    // AC-7: a session that needs something records the ask instead of holding the lease at a
    // prompt. The control plane derives the decider and ends the attempt in the same transaction.
    name: 'request',
    scope: 'work',
    help: [
      '  request GY-N file.json        Record a typed request — scope-request, decision, blocker,',
      '                                note or escalation — which names its decider and frees the',
      '                                item; every type but note carries the attempt epoch',
    ],
    run: async (context, work) => context.print(await workMutation(context, work)('request', JSON.parse(await readFile(context.args[0], 'utf8')))),
  },
  {
    // AC-8: the coordinates only this session has — the tab its runtime opened and the transcript
    // it writes — onto the handle its launcher started.
    name: 'session',
    scope: 'work',
    help: ['  session GY-N file.json        Record this session\'s durable handle: runtime, host, workspace, tab, pane, transcript'],
    run: async (context, work) => context.print(await workMutation(context, work)('session', JSON.parse(await readFile(context.args[0], 'utf8')))),
  },
  {
    name: 'evidence',
    scope: 'work',
    help: ['  evidence GY-N file.json       Submit evidence (trust follows credential)'],
    run: async (context, work) => context.print(await workMutation(context, work)('evidence', JSON.parse(await readFile(context.args[0], 'utf8')))),
  },
  {
    name: 'revoke',
    scope: 'work',
    help: ['  revoke GY-N file.json         Withdraw trusted evidence for a candidate (producer/operator)'],
    run: async (context, work) => context.print(await workMutation(context, work)('revoke', JSON.parse(await readFile(context.args[0], 'utf8')))),
  },
]);
