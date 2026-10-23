
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { listHerdrAgents, masterHarness, masterSettingsFromArgs, producerCommand, registeredReview, saveMasterSettings, saveWorkerProfile, startMaster, workerProfileSchema } from '../../master.js';
import { reviewCommand as launchReview } from '../../reviewer.js';
import { writeHarnessPermissions } from '../../harness.js';
import { browserFlows, listConfirmAccessFixtures, runBrowserFlow, type BrowserFlow } from '../../master-browser.js';
import { reviewerCommand } from '../master-reviewer.js';
import { registryCommand } from '../master-registry.js';
import { unhandled, type MasterSession } from './session.js';

/** Launch profiles, the master session, reviewer launches, and GitHub administration through the operator. */
export async function fleetCommand(session: MasterSession): Promise<unknown> {
  const { id, args, print, root, master, masterApi, masterMutation, coordinator } = session;
  const reviewCommand: typeof launchReview = (...a) => registeredReview(master, a[1], a[2], masterMutation, () => launchReview(...a));
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
  if (id === 'reviewer') return reviewerCommand(root, master, args, print);
  // The fleet on this host against the CLI checkout's commit: the release a restart would load.
  if (id === 'review') {
    const snapshot = await masterApi('work-snapshot');
    return print(await reviewCommand(root, args, snapshot, await listHerdrAgents()));
  }
  if (id === 'browser') {
    const { values, positionals } = parseArgs({ args, options: { 'dry-run': { type: 'boolean' } }, allowPositionals: true });
    // The Confirm-access captures earlier flows recorded, for fixtures (GY-1482); nothing is opened.
    if (positionals[0] === 'fixtures' && positionals.length === 1 && !values['dry-run']) return print(await listConfirmAccessFixtures(root));
    const flow = positionals[0] as BrowserFlow | undefined;
    if (!flow || !browserFlows.includes(flow)) throw new Error(`Use master browser ${browserFlows.join('|')} [--dry-run], or master browser fixtures`);
    const result = await runBrowserFlow(root, master, flow, { coordinator: coordinator.actor.id, dryRun: !!values['dry-run'] });
    if (result.outcome === 'refused') process.exitCode = 1;
    return print(result);
  }
  if (id === 'harness') {
    const { values, positionals } = parseArgs({ args, options: { apply: { type: 'boolean' } }, allowPositionals: true });
    const kind = workerProfileSchema.shape.kind.safeParse(positionals[0] ?? 'claude');
    if (!kind.success) throw new Error('Use master harness with a supported agent kind such as claude or codex');
    return print(await writeHarnessPermissions(root, masterHarness(root, master, kind.data!), !!values.apply));
  }
  return unhandled;
}
