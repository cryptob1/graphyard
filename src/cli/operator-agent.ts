import { readFile } from 'node:fs/promises';
import { defineCommands } from './registry.js';
import { readSecretFromStdin } from './context.js';

/** Scoped operator automation identities; secrets travel on stdin, never in argv. */
export const operatorAgentCommands = defineCommands([
  {
    name: 'operator-agent',
    help: [
      '  operator-agent list          Inspect configured identities, scopes and redacted fingerprints (admin)',
      '  operator-agent setup FILE --token-stdin  Create a scoped identity; FILE contains no secret (admin)',
      '  operator-agent configure ID FILE          Revise capabilities/scope with expectedRevision (admin)',
      '  operator-agent rotate ID SECONDS REASON --token-stdin  Rotate with a bounded overlap (admin)',
      '  operator-agent revoke ID REASON            Revoke immediately and fail closed (admin)',
    ],
    async run({ id, args, api, print }) {
      if (!id || id === 'list') return print(await api('operator-agents'));
      if (id === 'setup') {
        if (!args[0] || args[1] !== '--token-stdin') throw new Error('Use operator-agent setup FILE --token-stdin');
        const secret = await readSecretFromStdin(10000);
        if (!secret) throw new Error('Operator-agent credential is required; setup made no changes');
        return print(await api('operator-agents', { ...JSON.parse(await readFile(args[0], 'utf8')), token: secret }));
      }
      if (id === 'configure') {
        if (!args[0] || !args[1]) throw new Error('Use operator-agent configure ID FILE');
        return print(await api(`operator-agents/${encodeURIComponent(args[0])}/configure`, JSON.parse(await readFile(args[1], 'utf8'))));
      }
      if (id === 'rotate') {
        const marker = args.indexOf('--token-stdin'); if (!args[0] || marker < 0 || marker < 2) throw new Error('Use operator-agent rotate ID SECONDS REASON --token-stdin');
        const secret = await readSecretFromStdin(10000);
        if (!secret) throw new Error('New operator-agent credential is required; rotation made no changes');
        return print(await api(`operator-agents/${encodeURIComponent(args[0])}/rotate`, { token: secret, transitionSeconds: Number(args[1]), reason: args.slice(2, marker).join(' ') }));
      }
      if (id === 'revoke') {
        if (!args[0]) throw new Error('Use operator-agent revoke ID REASON');
        return print(await api(`operator-agents/${encodeURIComponent(args[0])}/revoke`, { reason: args.slice(1).join(' ') }));
      }
      throw new Error('Use operator-agent list, setup, configure, rotate, or revoke');
    },
  },
]);
