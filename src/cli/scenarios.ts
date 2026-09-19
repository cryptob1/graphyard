import { readFile } from 'node:fs/promises';
import { defineCommands } from './registry.js';

/** The versioned E2E test-case registry. */
export const scenarioCommands = defineCommands([
  {
    name: 'scenarios',
    help: ['  scenarios                    List versioned E2E test-case definitions'],
    run: async ({ api, print }) => print(await api('scenarios')),
  },
  {
    name: 'scenario',
    help: ['  scenario file.json           Publish a scenario version (operator)'],
    run: async ({ id, api, print }) => print(await api('scenarios', JSON.parse(await readFile(id!, 'utf8')))),
  },
]);
