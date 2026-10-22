import { readFile } from 'node:fs/promises';
import { defineCommands, workMutation } from './registry.js';

/** Operator decisions about one work item: requirements, release, unblock and rework. */
export const policyCommands = defineCommands([
  {
    name: 'requirements',
    scope: 'work',
    help: [
      '  requirements GY-N file.json  Revise requirements with an audit reason (operator);',
      '                                a criterion may carry "bootstrap": {reason, contractPaths}',
      '                                to defer its proofs onto the named contract (operator with',
      '                                policy:bootstrap). Deferred proofs are never dropped.',
    ],
    run: async (context, work) => context.print(await workMutation(context, work)('requirements', JSON.parse(await readFile(context.args[0], 'utf8')))),
  },
  {
    name: 'ready',
    scope: 'work',
    help: ['  ready GY-N REASON            Release backlog item with an audit reason (operator)'],
    run: async (context, work) => context.print(await workMutation(context, work)('ready', context.args.length ? { expectedRevision: work.revision, reason: context.args.join(' ') } : {})),
  },
  {
    name: 'unblock',
    scope: 'work',
    help: ['  unblock GY-N REASON           Clear a blocker with an audit reason (operator)'],
    run: async (context, work) => context.print(await workMutation(context, work)('unblock', { expectedRevision: work.revision, reason: context.args.join(' ') })),
  },
  {
    name: 'rework',
    scope: 'work',
    help: ['  rework GY-N --previous-worker-stopped REASON  Authorize reassignment (operator)'],
    async run(context, work) {
      if (context.args[0] !== '--previous-worker-stopped') throw new Error('Stop the previous worker first, then pass --previous-worker-stopped and an audit reason');
      return context.print(await workMutation(context, work)('rework', { reason: context.args.slice(1).join(' '), previousWorkerStopped: true }));
    },
  },
]);
