import { parseArgs } from 'node:util';
import type { CliCommand } from './registry.js';
import { asRecordedOperator } from './session-commands.js';

/**
 * GY-3215: the operator invites a teammate as their own human principal, or revokes one. GY-3514: the
 * link it prints opens once, on the install's Funnel address, within the days the operator picks.
 */
export const inviteCommand: CliCommand = {
  name: 'invite',
  help: ['  invite NAME --role ROLE [--days 1|7|30]  Print one link that signs NAME in once (7 days by default);',
    '                                ROLE viewer reads everything; maintainer also files work and types into the master',
    '  invite revoke NAME           End teammate NAME\'s sessions at once and remove them'],
  async run(context) {
    const { values, positionals } = parseArgs({ args: [context.id ?? '', ...context.args].filter(Boolean), allowPositionals: true, options: { role: { type: 'string' }, days: { type: 'string' } } });
    const revoke = positionals[0] === 'revoke' && positionals.length === 2;
    const name = revoke ? positionals[1] : positionals[0];
    if (!name || positionals.length > (revoke ? 2 : 1) || (!revoke && !values.role)) throw new Error('Usage: graphyard invite NAME --role viewer|maintainer [--days 1|7|30], or graphyard invite revoke NAME');
    await asRecordedOperator(context.repositoryRoot());
    if (revoke) return context.print(await context.api(`invites/${encodeURIComponent(name)}/revoke`, {}));
    const invite = await context.api('invites', { name, role: values.role, ...(values.days ? { days: Number(values.days) } : {}) }) as { link: string; name: string; role: string; expiresAt: string; note: string | null };
    return context.print({ ...invite, next: `Send this link to ${invite.name}; it opens once` });
  },
};
