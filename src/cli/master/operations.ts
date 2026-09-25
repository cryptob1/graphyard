// Concern: `graphyard master` operations subcommands — status, settle-containment, dispatch, merge, verify-deployment.
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { resourceConflicts } from '../../coordination.js';
import { approvedMerges, continueMergeBatch, currentMergeCandidates, dispatchWork, listHerdrAgents, mergeExecutor, readWorkerCredential, snapshotWithClock, verifyContainmentDeath } from '../../master.js';
import { readDaemonState } from '../../master-daemon.js';
import { verificationEffects, verifyDeployment } from '../../master-verification.js';
import { cycleBudget, masterStatusReport } from '../master-status.js';
import { assertHandAction, assertHandDispatch, systemDriven } from '../hand-actions.js';
import { unhandled, type MasterSession } from './session.js';

/** Reading status and acting on one item: settle a quarantine, dispatch, merge, verify a deployment. */
export async function operationsCommand(session: MasterSession): Promise<unknown> {
  const { id, args, print, root, master, masterApi, masterMutation, coordinator, cli, assertProtocol } = session;
  if (id === 'status') {
    const report = await masterStatusReport(root, master, masterApi, coordinator, cli);
    const state = await readDaemonState(root, master).catch(() => null);
    return print({ ...report, daemon: { ...report.daemon, cycleBudget: state ? cycleBudget(state, master.run.intervalSeconds * 1000) : null } });
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
  if (id === 'merge') {
    if (!args[0]) throw new Error('Use master merge GY-N or master merge --all');
    // Skew is refused before any candidate is read: an undeployed server is protocol skew, not a failed gate.
    assertProtocol(coordinator);
    const snapshot = await masterApi('work-snapshot');
    const selected = args[0] === '--all' ? currentMergeCandidates(snapshot.work, snapshot.now, coordinator.actor.id) : snapshot.work.filter((item: any) => item.id === args[0] || item.key === args[0]);
    if (!selected.length) throw new Error(args[0] === '--all' ? 'No work has a current all-gates-passing merge authorization' : `Unknown work item ${args[0]}`);
    // `--all` merges the candidates that are not system-driven and leaves the rest to the loop; a named item is refused (GY-175).
    if (args[0] === '--all') { const hand = selected.filter((item: any) => !systemDriven(item)); if (!hand.length) assertHandAction(selected[0], 'merge'); selected.splice(0, selected.length, ...hand); }
    else for (const item of selected) assertHandAction(item, 'merge');
    if (!master.autoMerge) selected.splice(0, selected.length, ...await approvedMerges(selected, item => masterApi(`work/${item.id}/decisions`), args[0] !== '--all'));
    // One executor instance per request id (see MergeExecutor in master.ts).
    const outerRequest = process.env.GRAPHYARD_REQUEST_ID ?? randomUUID();
    const mergeOne = mergeExecutor(master, () => masterApi('work-snapshot'), masterMutation, { principal: coordinator.actor.id, instance: outerRequest }, outerRequest);
    const results = args[0] === '--all' ? await continueMergeBatch(selected, mergeOne) : [await mergeOne(selected[0])];
    return print({ requestId: outerRequest, results });
  }
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
