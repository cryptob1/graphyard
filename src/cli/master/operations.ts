// Concern: `graphyard master` operations subcommands — status, settle-containment, dispatch, merge, verify-deployment.
import { parseArgs } from 'node:util';
import { resourceConflicts } from '../../coordination.js';
import { dispatchWork, listHerdrAgents, readWorkerCredential, snapshotWithClock, verifyContainmentDeath, withReviewerDefaults } from '../../master.js';
import { readDaemonState } from '../../master-daemon.js';
import { verificationEffects, verifyDeployment } from '../../master-verification.js';
import { cycleBudget, masterStatusReport } from '../master-status.js';
import { masterHeartbeatMinutes, masterSessionMinutes } from '../../master/master-session.js';
import { assertHandDispatch } from '../hand-actions.js';
import { unhandled, type MasterSession } from './session.js';
import { masterHarnessDrift } from './fleet.js';

/** What `graphyard master merge` answers: Graphyard runs no merge of its own. */
export const githubMergesAnswer = 'GitHub merges: a pull request whose build, review and required checks pass on its head is merged by GitHub on its branch protection, and Graphyard records the delivery from the merged observation. There is no Graphyard merge to run.';

/** Reading status and acting on one item: settle a quarantine, dispatch, merge, verify a deployment. */
export async function operationsCommand(session: MasterSession): Promise<unknown> {
  const { id, args, print, root, master, masterApi, masterMutation, coordinator, cli } = session;
  if (id === 'status') {
    // Sessions are counted as the reviewer launchers count them: the automatic profile's default concurrency included (GY-1072).
    const report = await masterStatusReport(root, withReviewerDefaults(master), masterApi, coordinator, cli);
    const state = await readDaemonState(root, master).catch(() => null);
    // The master session's budgets (GY-898) come from this installation's config, not the cursor.
    const summary = report.daemon as typeof report.daemon & { master?: Record<string, unknown> | null };
    const master2 = summary.master ? { ...summary.master, budgetMinutes: masterSessionMinutes(master), heartbeatMinutes: masterHeartbeatMinutes(master) } : null;
    // An installed harness that differs from the current plan is drift the master repairs (GY-1217).
    const harness = await masterHarnessDrift(root, master);
    const attention = harness ? { attentionItems: [...report.attentionItems, harness], counts: { ...report.counts, attention: report.counts.attention + 1 } } : {};
    return print({ ...report, ...attention, harnessDrift: harness?.drift ?? null, daemon: { ...report.daemon, cycleBudget: state ? cycleBudget(state, master.run.intervalSeconds * 1000) : null, ...(master2 ? { master: master2 } : {}) } });
  }
  if (id === 'settle-containment') {
    if (!args[0] || !args.slice(1).join(' ').trim()) throw new Error('Use master settle-containment GY-N REASON');
    const { snapshot, clockOffset } = await snapshotWithClock(() => masterApi('work-snapshot'));
    const work = snapshot.work.find((item: any) => item.id === args[0] || item.key === args[0]);
    if (!work) throw new Error(`Unknown work item ${args[0]}`);
    if (!work.containmentQuarantine) throw new Error(`${work.key} has no containment quarantine to settle`);
    const assessment = await verifyContainmentDeath(work, { hostId: master.hostId, observedAt: snapshot.now, clockOffset });
    if (!assessment.settleable) {
      // Every process still holding the fence is printed with its command line and working
      // directory: the master verifies whose it is before stopping anything.
      const held = assessment.verification?.held ?? [];
      const processes = held.length ? `\nProcesses holding the fence (verify before stopping anything):\n${held.map(entry => `- pid ${entry.pid}${entry.unit ? ` in ${entry.unit}` : ''}: cmdline "${entry.command}" cwd ${entry.cwd ?? '<unreadable>'}`).join('\n')}` : '';
      const recorded = assessment.scope ? `\nRecorded launch scope: ${assessment.scope.unit} (supervisor pid ${assessment.scope.pid}); systemd reports it ${assessment.verification?.recordedScope?.activeState ?? 'unqueried'}` : '\nThis quarantine recorded no launch scope; every live graphyard-watch scope is judged by its members';
      console.error(`Automatic containment settlement refused for ${work.key}:\n- ${assessment.refusals.join('\n- ')}${recorded}${processes}\n${assessment.attestation}`);
      process.exitCode = 1; return;
    }
    const settled = await masterMutation(`work/${work.id}/autosettle`, { epoch: assessment.epoch, settlementHash: work.containmentQuarantine.settlementHash, reason: args.slice(1).join(' '), verification: assessment.verification });
    return print({ key: settled.key, epoch: assessment.epoch, scope: assessment.scope, containmentQuarantine: settled.containmentQuarantine, stage: settled.stage, verification: assessment.verification });
  }
  if (id === 'dispatch') {
    const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
    if (!positionals[0]) throw new Error('Use master dispatch GY-N PROFILE');
    const requestedAt = Date.now(), snapshot = await masterApi('work-snapshot');
    const work = snapshot.work.find((item: any) => item.id === positionals[0] || item.key === positionals[0]);
    const profile = master.workers.find(item => item.name === positionals[1]);
    if (!work) throw new Error(`Unknown work item ${positionals[0]}`);
    const { claimBy } = await assertHandDispatch(work, snapshot.now, master.run.dispatchIntervalSeconds, path => masterApi(path), requestedAt);
    if (!profile) throw new Error(`Unknown worker profile ${positionals[1]}`);
    const conflicts = resourceConflicts(work, snapshot.work, Date.parse(snapshot.now)); if (conflicts.length) throw new Error(`Dispatch blocked by exclusive resources: ${conflicts.map((conflict: any) => `${conflict.resource} held by ${conflict.key}`).join(', ')}`);
    if (profile.credentialFile) {
      const workerStatus = await masterApi('status', await readWorkerCredential(root, profile.credentialFile));
      if (workerStatus.actor?.role !== 'worker' || workerStatus.actor.id !== profile.principal) throw new Error('Worker credential no longer matches the configured principal; update the profile before dispatch');
    }
    return print(await dispatchWork(root, work, profile, await listHerdrAgents(), undefined, snapshot.work, undefined, undefined, undefined, snapshot.now, { claimBy }));
  }
  // GitHub merges (docs/delivery.md): there is no Graphyard merge to run, by hand or by the loop.
  if (id === 'merge') return print({ merged: false, result: githubMergesAnswer });
  if (id === 'verify-deployment') {
    if (!args[0]) throw new Error('Use master verify-deployment GY-N');
    const snapshot = await masterApi('work-snapshot');
    const work = snapshot.work.find((item: any) => item.id === args[0] || item.key === args[0]);
    if (!work) throw new Error(`Unknown work item ${args[0]}`);
    const result = await verifyDeployment(work, verificationEffects(master, { root, snapshot: () => masterApi('work-snapshot'), mutate: masterMutation }));
    if (result.result === 'refused') process.exitCode = 1;
    return print(result);
  }
  return unhandled;
}
