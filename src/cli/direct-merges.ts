import { parseArgs } from 'node:util';
import { defineCommands } from './registry.js';

/** Operator-owned policy: direct-merge mode (src/direct-merge.ts), set and cleared with an admin credential only. */
export const operatorCommands = defineCommands([
  {
    name: 'operator',
    help: [
      '  operator direct-merges status       Show direct-merge mode: open windows, who set them, and the history',
      '  operator direct-merges on --since ISO [--until ISO] REASON  Deliver merges into the base branch inside',
      '                                the window as operator-authorized instead of holding them (admin)',
      '  operator direct-merges off REASON   Close the open window now; later merges need the guarded path (admin)',
    ],
    async run({ id, args, api, print }) {
      if (id !== 'direct-merges') throw new Error('Use operator direct-merges status|on|off');
      const [action, ...rest] = args;
      if (!action || action === 'status') return print(await api('direct-merges'));
      if (action === 'on') {
        const { values, positionals } = parseArgs({ args: rest, options: { since: { type: 'string' }, until: { type: 'string' } }, allowPositionals: true });
        const reason = positionals.join(' ').trim();
        if (!values.since || !reason) throw new Error('Use operator direct-merges on --since ISO [--until ISO] REASON');
        return print(await api('direct-merges/on', { since: values.since, ...(values.until ? { until: values.until } : {}), reason }));
      }
      if (action === 'off') {
        const reason = rest.join(' ').trim();
        if (!reason) throw new Error('Use operator direct-merges off REASON');
        return print(await api('direct-merges/off', { reason }));
      }
      throw new Error('Use operator direct-merges status|on|off');
    },
  },
]);
