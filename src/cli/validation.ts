import { readFile, writeFile } from 'node:fs/promises';
import { defineCommands } from './registry.js';

/** The validation runner protocol as seen from a client: requests, definitions, artifacts. */
export const validationCommands = defineCommands([
  {
    name: 'validation',
    help: [
      '  validation [ACTION file.json] List validation state or submit a protocol command',
      '  validation capacity          Runner capacity, queue dwell, reserved resources and the',
      '                                diagnosed next step for every live request',
      '  validation artifact-migrate TARGET [LIMIT]',
      '                                Move retained artifacts between postgres and the configured',
      '                                external backend, verifying each digest (operator)',
    ],
    async run(context) {
      const { id, args, api, base, print } = context;
      if (!id || id === 'requests') return print(await api('validation' + (args[0] ? `?cursor=${encodeURIComponent(args[0])}` : '')));
      if (id === 'capacity') return print(await api('validation/capacity'));
      if (id === 'artifact-migrate' && args[0]) return print(await api('validation/artifacts/migrate', { target: args[0], ...(args[1] ? { limit: Number(args[1]) } : {}) }));
      if (id === 'artifact-upload' && args.length === 1) return print(await api('validation/artifacts', JSON.parse(await readFile(args[0], 'utf8'))));
      if (id === 'artifact-download' && args.length === 3) {
        const token = await context.individualToken(); if (!token) throw new Error('An individual Graphyard credential is required');
        const response = await fetch(`${base}/api/validation/artifacts/${encodeURIComponent(args[0])}/${encodeURIComponent(args[1])}`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Artifact download refused (${response.status})`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 8_388_608) throw new Error('Artifact exceeds the supported size limit');
        await writeFile(args[2], bytes, { flag: 'wx', mode: 0o600 });
        return print({ saved: args[2], bytes: bytes.length });
      }
      if (id === 'definitions') return print(await api('validation/definitions' + (args[0] ? `?cursor=${encodeURIComponent(args[0])}` : '')));
      if (id === 'show-candidate' && args[0]) return print(await api(`validation/candidate/${encodeURIComponent(args[0])}`));
      if (!['define','build','candidate','request','dispatch','ack','heartbeat','result','cancel','settle','retry'].includes(id) || !args[0]) throw new Error('Use validation ACTION file.json');
      return print(await api(`validation/${id}`, JSON.parse(await readFile(args[0], 'utf8'))));
    },
  },
]);
