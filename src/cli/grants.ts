import { defineCommands } from './registry.js';

/** Proof authority: who may produce trusted evidence, and the history behind it. */
export const grantsCommands = defineCommands([
  {
    name: 'grants',
    help: [
      '  grants                       Show live proof authority per principal and its source',
      '  grants grant ID PATTERNS REASON   Grant proof authority; PATTERNS is comma separated,',
      "                                exact names or bounded patterns such as 'integration:*' (admin)",
      '  grants revoke ID PATTERNS REASON  Revoke granted patterns immediately, no redeploy (admin)',
      '  grants history ID            Read the append-only grant history for one principal',
    ],
    async run({ id, args, api, print }) {
      if (!id || id === 'list') return print(await api('proof-grants'));
      if (id === 'history') {
        if (!args[0]) throw new Error('Use grants history PRINCIPAL_ID');
        return print(await api(`proof-grants/${encodeURIComponent(args[0])}/history`));
      }
      if (id === 'grant' || id === 'revoke') {
        const [principal, list, ...rest] = args;
        const patterns = (list ?? '').split(',').map(value => value.trim()).filter(Boolean);
        const why = rest.join(' ').trim();
        if (!principal || !patterns.length || !why) throw new Error(`Use grants ${id} PRINCIPAL_ID PATTERNS REASON`);
        return print(await api(`proof-grants/${encodeURIComponent(principal)}/${id}`, { patterns, reason: why }));
      }
      throw new Error('Use grants list, grant, revoke, or history');
    },
  },
]);
