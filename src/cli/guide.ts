import { defineCommands } from './registry.js';
import { guideList, guideText } from '../guide.js';

/**
 * `guide TOPIC` prints one procedure topic; with no topic it lists them (GY-2972). The
 * launched instruction stays short and names the topics its role needs, so reading a
 * procedure is this one local command: it reads no connection file and talks to no server.
 */
export const guideCommands = defineCommands([
  {
    name: 'guide',
    readsConnection: () => false,
    help: [
      '  guide TOPIC                   Print one procedure topic',
      '                                (topics: claim, sync, complete, park, blocked, review, proof, master);',
      '                                guide with no topic lists them',
    ],
    async run(context) { console.log(context.id ? guideText(context.id) : guideList()); },
  },
]);
