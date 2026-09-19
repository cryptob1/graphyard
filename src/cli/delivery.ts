import { readFile } from 'node:fs/promises';
import { defineCommands } from './registry.js';

/** Releases and observed production delivery. */
export const deliveryCommands = defineCommands([
  {
    name: 'delivery',
    help: [
      '  delivery [ACTION file.json]  Show releases and observed delivery, or submit a',
      '                                release/observation command (build|release|approve|',
      '                                select|lease|observe|notify|sweep|rollback|rollback-claim|',
      '                                rollback-settle|rollback-resolve)',
      '  delivery observations ENV [CURSOR]',
      "                                Page through an environment's deployment observations",
    ],
    async run({ id, args, api, print }) {
      if (!id || id === 'status') return print(await api('delivery'));
      if (id === 'observations' && args[0]) return print(await api(`delivery/observations?environment=${encodeURIComponent(args[0])}${args[1] ? `&cursor=${encodeURIComponent(args[1])}` : ''}`));
      if (id === 'sweep') return print(await api('delivery/sweep', {}));
      if (!['build', 'release', 'approve', 'select', 'lease', 'observe', 'notify', 'rollback', 'rollback-claim', 'rollback-settle', 'rollback-resolve'].includes(id) || !args[0]) throw new Error('Use delivery [status] | delivery observations ENV [CURSOR] | delivery sweep | delivery ACTION file.json');
      return print(await api(`delivery/${id}`, JSON.parse(await readFile(args[0], 'utf8'))));
    },
  },
]);
