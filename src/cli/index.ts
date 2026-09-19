import { createContext } from './context.js';
import type { CliCommand } from './registry.js';
import { installCommands } from './install.js';
import { dbCommands } from './db.js';
import { masterCommands } from './master.js';
import { workCommands } from './work.js';
import { policyCommands } from './policy.js';
import { validationCommands } from './validation.js';
import { deliveryCommands } from './delivery.js';
import { runnerCommands } from './runner.js';
import { scenarioCommands } from './scenarios.js';
import { grantsCommands } from './grants.js';
import { operatorAgentCommands } from './operator-agent.js';
import { leaseCommands } from './lease.js';
import { workspaceCommands } from './workspace.js';

/**
 * Every command the launcher answers to, in help order. A feature adds its commands to
 * one module, or adds a module here; nothing else in the launcher changes.
 */
export const commands: readonly CliCommand[] = [
  ...installCommands, ...dbCommands, ...masterCommands, ...workCommands, ...policyCommands,
  ...validationCommands, ...deliveryCommands, ...runnerCommands, ...scenarioCommands,
  ...grantsCommands, ...operatorAgentCommands, ...leaseCommands, ...workspaceCommands,
];

export function renderHelp() {
  return `Graphyard 0.1 — distributed work, explicit proof

Environment: GRAPHYARD_URL, GRAPHYARD_TOKEN (individual role-scoped credential)
${commands.flatMap(entry => entry.help).join('\n')}

Use GRAPHYARD_REQUEST_ID to safely retry an identical command after a network timeout.
Never share an operator or producer credential with an implementation agent.`;
}

export async function main(argv = process.argv.slice(2)) {
  try { process.loadEnvFile(); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const [command, id, ...args] = argv;
  if (!command || command === 'help' || command === '--help') { console.log(renderHelp()); return; }
  const selected = commands.find(entry => entry.name === command);
  const context = await createContext(command, id, args, selected?.readsConnection?.(id) ?? true);
  if (selected && selected.scope !== 'work') return selected.run(context, undefined);
  if (selected?.unscoped && !id) return selected.unscoped(context);
  // Work-scoped commands name an item by ID or display key; the lookup precedes the
  // command check so an unknown item is reported before an unknown command.
  const items = await context.api('work'); const work = items.find((w: any) => w.id === id || w.key === id);
  if (!work) throw new Error(`Unknown work item ${id}`);
  if (!selected) throw new Error(`Unknown command: ${command}`);
  return selected.run(context, work);
}
