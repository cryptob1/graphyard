import { headlessInventory, sessionAgents } from '../../session-inventory.js';

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { listHerdrAgents, masterHarness, masterSettingsFromArgs, producerCommand, registeredReview, saveMasterSettings, saveWorkerProfile, startMaster, workerProfileSchema } from '../../master.js';
import { reviewCommand as launchReview } from '../../reviewer.js';
import { writeHarnessPermissions } from '../../harness.js';
import { reviewerCommand } from '../master-reviewer.js';
import { registryCommand, workersCommand } from '../master-registry.js';
import { unhandled, type MasterSession } from './session.js';

/** Launch profiles, the master session, reviewer launches and the master's harness rules. */
export async function fleetCommand(session: MasterSession): Promise<unknown> {
  const { id, args, print, root, master, masterApi, masterMutation } = session;
  const reviewCommand = (...a: Parameters<typeof launchReview>) => registeredReview(master, a[1], a[2], masterMutation, () => launchReview(...a));
  if (id === 'start') {
    const kind = workerProfileSchema.shape.kind.safeParse(args[0]); if (!kind.success) throw new Error('Use master start with a supported agent kind such as codex or claude');
    const separator = args.indexOf('--'); const agentArgs = separator < 0 ? [] : args.slice(separator + 1);
    if (separator > 1 || separator < 0 && args.length > 1) throw new Error('Put agent-specific arguments after --');
    return print(await startMaster(root, kind.data, agentArgs, await listHerdrAgents()));
  }
  if (id === 'worker' && args[0] === 'add' && args[1]) return print(await saveWorkerProfile(root, JSON.parse(await readFile(args[1], 'utf8')), credential => masterApi('status', credential)));
  if (id === 'producer') return print(await producerCommand(root, args, credential => masterApi('status', credential)));
  if (id === 'config') return print(await saveMasterSettings(root, masterSettingsFromArgs(args)));
  if (id === 'registry') return print(await registryCommand(master, args, { read: path => masterApi(path), write: (path, data) => masterMutation(path, data) }));
  if (id === 'workers') return print(await workersCommand(args, { read: path => masterApi(path), write: (path, data) => masterMutation(path, data) }));
  if (id === 'reviewer') return reviewerCommand(root, master, args, print);
  // The fleet on this host against the CLI checkout's commit: the release a restart would load.
  if (id === 'review') {
    const snapshot = await masterApi('work-snapshot');
    return print(await reviewCommand(root, args, snapshot, sessionAgents(headlessInventory())));
  }
  if (id === 'harness') {
    const { values, positionals } = parseArgs({ args, options: { apply: { type: 'boolean' } }, allowPositionals: true });
    const kind = workerProfileSchema.shape.kind.safeParse(positionals[0] ?? 'claude');
    if (!kind.success) throw new Error('Use master harness with a supported agent kind such as claude or codex');
    return print(await writeHarnessPermissions(root, masterHarness(root, master, kind.data!), !!values.apply));
  }
  return unhandled;
}
