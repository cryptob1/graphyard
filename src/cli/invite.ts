import { parseArgs } from 'node:util';
import type { CliCommand } from './registry.js';
import { asRecordedOperator } from './session-commands.js';

/**
 * GY-3215: the operator invites a teammate as their own human principal, or revokes one. The link it
 * prints is single use and lives ten minutes; the operator delivers it, and the session it opens
 * renews itself until 90 days unused. After that session ends, the operator invites again.
 */
export const inviteCommand: CliCommand = {
  name: 'invite',
  help: ['  invite NAME --role ROLE      Print a one-time link (10 minutes) that signs teammate NAME in as their own',
    '                                person; ROLE viewer reads everything, maintainer also files work',
    '  invite revoke NAME           End teammate NAME\'s sessions at once and remove them'],
  async run(context) {
    const { values, positionals } = parseArgs({ args: [context.id ?? '', ...context.args].filter(Boolean), allowPositionals: true, options: { role: { type: 'string' } } });
    const revoke = positionals[0] === 'revoke' && positionals.length === 2;
    const name = revoke ? positionals[1] : positionals[0];
    if (!name || positionals.length > (revoke ? 2 : 1) || (!revoke && !values.role)) throw new Error('Usage: graphyard invite NAME --role viewer|maintainer, or graphyard invite revoke NAME');
    const recorded = await asRecordedOperator(context.repositoryRoot());
    if (revoke) return context.print(await context.api(`invites/${encodeURIComponent(name)}/revoke`, {}));
    const link = await context.api('invites', { name, role: values.role }) as { code: string; principal: string; role: string; expiresAt: string };
    return context.print({ invite: `${(recorded?.reachableUrl ?? context.base).replace(/\/+$/, '')}/#sign-in=${link.code}`, teammate: link.principal, role: link.role, expiresAt: link.expiresAt, singleUse: true,
      next: `Send this link to ${link.principal}; it opens their own session, which renews itself until 90 days unused` });
  },
};
