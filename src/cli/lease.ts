import { readFile } from 'node:fs/promises';
import { defineCommands, workMutation } from './registry.js';
import { verifyCommand } from './verify.js';
import { completeCommand } from './complete.js';

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
  verifyCommand,
  completeCommand,
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
