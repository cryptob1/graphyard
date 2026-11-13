// Concern: `graphyard master emblem [set FILE]` (GY-3273) — read or store the project's emblem.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { unhandled, type MasterSession } from './session.js';

/** The master draws the emblem; the control plane judges it and the dashboard serves it. */
export async function emblemCommand(session: MasterSession): Promise<unknown> {
  const { id, args, print, masterApi, masterMutation } = session;
  if (id !== 'emblem') return unhandled;
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  // Without arguments: whether the project has an emblem, who drew it and when (set: false until one is drawn).
  if (positionals.length === 0) return print(await masterApi('emblem'));
  if (positionals[0] !== 'set' || !positionals[1]) throw new Error('Use master emblem to read it, or master emblem set FILE (one <svg> root, at most 8 KB; the control plane refuses anything else with the reason)');
  // The control plane is the judge: a single <svg> root at most 8 KB with no script, no event
  // attributes and no references outside itself, refused with the reason; the dashboard shows the
  // stored emblem beside the project name and as the favicon.
  return print(await masterMutation('emblem', { svg: await readFile(positionals[1], 'utf8') }));
}
