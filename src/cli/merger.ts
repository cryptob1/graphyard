import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mergerModes } from '../merger-mode.js';
import { defineCommands } from './registry.js';
import { masterCommands } from './master.js';
import { openMasterSession, unhandled, type MasterSession } from './master/session.js';

/** The one line `graphyard doctor` prints for the merger setting (src/merger-mode.ts), from /api/status `mergeWriter`. */
export const mergerDoctorLine = (mergeWriter: { merger: string; since: string | null; setBy: string | null } | null | undefined) =>
  !mergeWriter || !mergeWriter.setBy ? 'merger: github (default)' : `merger: ${mergeWriter.merger} (set by ${mergeWriter.setBy} at ${mergeWriter.since})`;

/** `master merger` prints the setting and its history; `master merger github|control-plane --reason TEXT` sets it (admin credential). */
export async function mergerCommand(session: MasterSession, env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const { id, args, print, masterApi, masterMutation, masterToken } = session;
  if (id !== 'merger') return unhandled;
  const { values, positionals } = parseArgs({ args, options: { reason: { type: 'string' } }, allowPositionals: true });
  const [mode, ...extra] = positionals;
  if (!mode) return print(await masterApi('merger'));
  if (!(mergerModes as readonly string[]).includes(mode) || extra.length) throw new Error(`Use master merger [${mergerModes.join('|')} --reason TEXT]`);
  if (!values.reason?.trim()) throw new Error(`Use master merger ${mode} --reason TEXT`);
  // Changing the setting needs an admin credential: the operator's GRAPHYARD_TOKEN, since the master's own is coordinator.
  return print(await masterMutation('merger', { merger: mode, reason: values.reason.trim() }, env.GRAPHYARD_REQUEST_ID ?? randomUUID(), env.GRAPHYARD_TOKEN?.trim() || masterToken));
}

/**
 * `master merger` is answered here, ahead of the `master` entry, which handles every other
 * subcommand; the help lines sit in the master block.
 */
export const mergerCommands = defineCommands([
  {
    name: 'master',
    readsConnection: () => false,
    help: [
      '  master merger [github|control-plane --reason TEXT]',
      '                                Show the merger setting and history; set it (admin credential)',
    ],
    async run(context, work) {
      if (context.id === 'merger') { await mergerCommand(await openMasterSession(context, context.repositoryRoot())); return; }
      return masterCommands.find(entry => entry.name === 'master')!.run(context, work);
    },
  },
]);
