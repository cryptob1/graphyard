// Concern: `graphyard master emblem set FILE` (GY-3273) — store the project's emblem.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { unhandled, type MasterSession } from './session.js';

/** The master draws the emblem; the control plane judges it and the dashboard serves it. */
export async function emblemCommand(session: MasterSession): Promise<unknown> {
  const { id, args, print, masterMutation } = session;
  if (id !== 'emblem') return unhandled;
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  if (positionals[0] !== 'set' || !positionals[1]) throw new Error('Use master emblem set FILE (one <svg> root, at most 8 KB; the control plane refuses anything else with the reason)');
  // The control plane is the judge: a single <svg> root at most 8 KB with no script, no event
  // attributes and no references outside itself, refused with the reason; the dashboard shows the
  // stored emblem beside the project name and as the favicon.
  return print(await masterMutation('emblem', { svg: await readFile(positionals[1], 'utf8') }));
}
