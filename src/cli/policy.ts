import { readFile } from 'node:fs/promises';
import { defineCommands, workMutation } from './registry.js';

/** Operator decisions about one work item: requirements, release, recovery and review policy. */
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
    name: 'resolve',
    scope: 'work',
    help: ['  resolve GY-N TRIGGER REASON   Resolve a standing escalation with an audit reason (operator)'],
    async run(context, work) {
      const { args } = context;
      if (!args[0] || !args.slice(1).length) throw new Error('Name the standing escalation trigger and an audit reason');
      return context.print(await workMutation(context, work)('resolve', { trigger: args[0], expectedRevision: work.revision, reason: args.slice(1).join(' ') }));
    },
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
  {
    name: 'recover-containment',
    scope: 'work',
    help: [
      '  recover-containment GY-N --previous-worker-stopped REASON',
      "                                Release delivered work's stopped-worker quarantine (operator)",
    ],
    async run(context, work) {
      if (context.args[0] !== '--previous-worker-stopped') throw new Error('Stop the previous worker first, then pass --previous-worker-stopped and an audit reason');
      return context.print(await workMutation(context, work)('recover', { reason: context.args.slice(1).join(' '), previousWorkerStopped: true }));
    },
  },
  {
    name: 'rereview',
    scope: 'work',
    help: ['  rereview GY-N [EPOCH]         Request a fresh provider review (operator or current worker)'],
    run: async (context, work) => context.print(await workMutation(context, work)('rereview', context.args[0] ? { epoch: Number(context.args[0]) } : {})),
  },
  {
    name: 'reviewpolicy',
    scope: 'work',
    help: [
      '  reviewpolicy GY-N github|codex|agent POLICY_REVISION REASON [--profiles FILE]',
      '                                Revise reviewer source; agent review reads its ordered',
      '                                reviewer profiles from FILE (operator)',
    ],
    async run(context, work) {
      const { args } = context;
      const flag = args.indexOf('--profiles');
      const profilesFile = flag < 0 ? undefined : args[flag + 1];
      if (flag >= 0 && !profilesFile) throw new Error('Pass the reviewer profile file after --profiles');
      const positional = flag < 0 ? args : [...args.slice(0, flag), ...args.slice(flag + 2)];
      return context.print(await workMutation(context, work)('reviewpolicy', { provider: positional[0], expectedPolicyRevision: Number(positional[1]), reason: positional.slice(2).join(' '),
        ...(profilesFile ? { reviewerProfiles: JSON.parse(await readFile(profilesFile, 'utf8')) } : {}) }));
    },
  },
]);
