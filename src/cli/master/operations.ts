// Concern: `graphyard master` operations subcommands — status, the confined master's restart request, dispatch, merge, recover.
import { parseArgs } from 'node:util';
import { resourceConflicts } from '../../coordination.js';
import { atomicPrivateWrite, dispatchWork, listHerdrAgents, readWorkerCredential } from '../../master.js';
import { loopRestartRequestPath } from '../../daemon/run.js';
import { masterStatusReport } from '../master-status.js';
import { unhandled, type MasterSession } from './session.js';
import { readSecretFromStdin } from '../context.js';
import { defaultChildRun } from '../../child-runner.js';
import { installDirectory } from '../../install/secrets.js';
import { installIdFor } from '../../install/types.js';
import { knownGoodState, pinKnownGood } from '../../master/known-good.js';
import { alignLoopUnit, loopUnitOf, type LoopSupervisorHost } from '../../supervisor.js';
import type { ChildRun } from '../../child-runner.js';
import { masterConfinementVariable } from '../../master/launch.js';

/** Whether this command runs inside the master session's confinement (GY-1658): its wrapper sets the variable. */
export const confinedMaster = (env: NodeJS.ProcessEnv = process.env) => env[masterConfinementVariable] === 'master';

/** `master recover`: repin the known-good coordinator (GY-1529). */
export const recoverUsage = 'Use master recover [--to SHA] [--reason TEXT] --admin-token-stdin (the admin credential on stdin; the pin returns to the previous known-good SHA without --to)';

/** What `graphyard master merge` answers: Graphyard runs no merge of its own. */
export const mergeAnswer = 'The control plane merges: the loop\'s merge writer trial-merges each submitted head whose gates pass, runs its proofs and pushes it to the base branch. There is no merge to run by hand.';

/** What `master recover` does outside this process; a test hands in its own so no real unit is touched. */
export interface RecoverEffects { run: ChildRun; host: LoopSupervisorHost; restart: (unit: string) => Promise<unknown> }
const recoverEffects: RecoverEffects = { run: defaultChildRun, host: {}, restart: unit => defaultChildRun('systemctl', ['--user', 'restart', unit], { timeoutMs: 60_000 }) };

/** Reading status and acting on one item: dispatch, merge. */
export async function operationsCommand(session: MasterSession, effects: RecoverEffects = recoverEffects): Promise<unknown> {
  const { id, args, print, root, master, masterApi, masterMutation, coordinator } = session;
  if (id === 'status') return print(await masterStatusReport(root, master, masterApi));
  // The confined master session sees no host systemd (GY-1658), so its restart is a request the loop serves through its own unit.
  if (id === 'restart' && confinedMaster()) {
    await atomicPrivateWrite(loopRestartRequestPath(master), { requestedAt: new Date().toISOString(), requestedBy: String(coordinator?.actor?.id ?? 'master'), reason: args.join(' ') || 'master restart from the confined master session' });
    return print({ requested: true, file: loopRestartRequestPath(master), detail: 'the loop restarts through its unit after its current cycle' });
  }
  if (id === 'dispatch') {
    const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
    if (!positionals[0]) throw new Error('Use master dispatch GY-N PROFILE');
    const snapshot = await masterApi('work-snapshot');
    const work = snapshot.work.find((item: any) => item.id === positionals[0] || item.key === positionals[0]);
    const profile = master.workers.find(item => item.name === positionals[1]);
    if (!work) throw new Error(`Unknown work item ${positionals[0]}`);
    if ((work.owner ?? null) !== (master.forPerson ?? null)) throw new Error('This master dispatches only its own items');
    if (!profile) throw new Error(`Unknown worker profile ${positionals[1]}`);
    const conflicts = resourceConflicts(work, snapshot.work, Date.parse(snapshot.now)); if (conflicts.length) throw new Error(`Dispatch blocked by exclusive resources: ${conflicts.map((conflict: any) => `${conflict.resource} held by ${conflict.key}`).join(', ')}`);
    if (profile.credentialFile) {
      const workerStatus = await masterApi('status', await readWorkerCredential(root, profile.credentialFile));
      if (workerStatus.actor?.role !== 'worker' || workerStatus.actor.id !== profile.principal) throw new Error('Worker credential no longer matches the configured principal; update the profile before dispatch');
    }
    return print(await dispatchWork(root, work, profile, await listHerdrAgents(), undefined, snapshot.work, undefined, undefined, undefined, snapshot.now));
  }
  // GitHub merges (docs/delivery.md): there is no Graphyard merge to run, by hand or by the loop.
  if (id === 'merge') return print({ merged: false, result: mergeAnswer });
  // GY-1529: repin the coordinator the loop runs from (previous known-good, or --to SHA), restart its unit, record the move.
  if (id === 'recover') {
    const { values } = parseArgs({ args, options: { to: { type: 'string' }, reason: { type: 'string' }, 'admin-token-stdin': { type: 'boolean' } }, allowPositionals: false });
    if (!values['admin-token-stdin']) throw new Error(recoverUsage);
    const installDir = installDirectory(installIdFor(master.repository)), before = knownGoodState(installDir);
    const wanted = values.to ?? before?.previous;
    if (!wanted) throw new Error(`There is no previous known-good SHA to return to: pass --to SHA. ${recoverUsage}`);
    const to = (await effects.run('git', ['-C', root, 'rev-parse', '--verify', `${wanted}^{commit}`])).trim().toLowerCase();
    const token = await readSecretFromStdin(10_000);
    const pinned = await pinKnownGood({ installDir, repository: root }, to, effects.run);
    const unit = await alignLoopUnit({ root, cliPath: master.cliPath, repository: master.repository, intervalSeconds: master.run.intervalSeconds, installDir }, effects.host);
    if (unit.wrote === 'refused') throw new Error(`The coordinator was repinned to ${to}, but its unit was not rewritten: ${unit.reason}`);
    await effects.restart(loopUnitOf(root, undefined, effects.host.home));
    const reason = values.reason?.trim() || (values.to ? `recovered to ${to}` : 'recovered to the previous known-good SHA');
    const event = await masterMutation('coordinator/recovered', { from: before?.sha ?? null, to, reason }, undefined, token);
    return print({ recovered: true, from: before?.sha ?? null, to, previous: pinned.previous, unit: loopUnitOf(root, undefined, effects.host.home), unitFile: unit.wrote, event });
  }
  return unhandled;
}
