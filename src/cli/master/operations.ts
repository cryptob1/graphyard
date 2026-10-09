// Concern: `graphyard master` operations subcommands — status, settle-containment, dispatch, merge, verify-deployment, main-watch.
import { parseArgs } from 'node:util';
import { resourceConflicts } from '../../coordination.js';
import { dispatchWork, listHerdrAgents, readWorkerCredential, snapshotWithClock, verifyContainmentDeath, withReviewerDefaults, withRoleDefaults } from '../../master.js';
import { readDaemonState } from '../../master-daemon.js';
import { verificationEffects, verifyDeployment } from '../../master-verification.js';
import { cycleBudget, masterStatusReport } from '../master-status.js';
import { masterHeartbeatMinutes, masterSessionMinutes } from '../../master/master-session.js';
import { assertHandDispatch } from '../hand-actions.js';
import { unhandled, type MasterSession } from './session.js';
import { masterHarnessDrift } from './fleet.js';
import { readSecretFromStdin } from '../context.js';
import { acknowledgeCommand, mainWatchAttention } from '../../daemon/main-watch.js';
import { shadowGateSummary } from '../../daemon/cycle-shadow.js';
import { shadowGateAttention } from '../../merge-writer/shadow.js';
import { mergeWriterSummary } from '../../daemon/cycle-merge-writer.js';
import { defaultChildRun } from '../../child-runner.js';
import { installDirectory } from '../../install/secrets.js';
import { installIdFor } from '../../install/types.js';
import { knownGoodState, pinKnownGood } from '../../master/known-good.js';
import { alignLoopUnit, loopUnitOf, type LoopSupervisorHost } from '../../supervisor.js';
import type { ChildRun } from '../../child-runner.js';
import { readLockRefusal, supervisingUnit, unsupervisedHolderAttention } from '../../master/loop-restart.js';

/** `master main-watch`: the watch's state and policy, or an admin's acknowledgement of one commit (GY-1519). */
export const mainWatchUsage = 'Use master main-watch acknowledge SHA --reason TEXT --admin-token-stdin (the admin credential on stdin), or master main-watch status';

/** `master recover`: repin the known-good coordinator (GY-1529). */
export const recoverUsage = 'Use master recover [--to SHA] [--reason TEXT] --admin-token-stdin (the admin credential on stdin; the pin returns to the previous known-good SHA without --to)';

/** What `graphyard master merge` answers: Graphyard runs no merge of its own. */
export const githubMergesAnswer = 'GitHub merges: a pull request whose build, review and required checks pass on its head is merged by GitHub on its branch protection, and Graphyard records the delivery from the merged observation. There is no Graphyard merge to run.';

/** What `master recover` does outside this process; a test hands in its own so no real unit is touched. */
export interface RecoverEffects { run: ChildRun; host: LoopSupervisorHost; restart: (unit: string) => Promise<unknown> }
const recoverEffects: RecoverEffects = { run: defaultChildRun, host: {}, restart: unit => defaultChildRun('systemctl', ['--user', 'restart', unit], { timeoutMs: 60_000 }) };

/** Reading status and acting on one item: settle a quarantine, dispatch, merge, verify a deployment. */
export async function operationsCommand(session: MasterSession, effects: RecoverEffects = recoverEffects): Promise<unknown> {
  const { id, args, print, root, master, masterApi, masterMutation, coordinator, cli } = session;
  if (id === 'status') {
    // Sessions are counted as the reviewer and producer launchers count them: automatic profile defaults included (GY-1072, GY-1113).
    const report = await masterStatusReport(root, withRoleDefaults(master), masterApi, coordinator, cli);
    const state = await readDaemonState(root, master).catch(() => null);
    // The master session's budgets (GY-898) come from this installation's config, not the cursor.
    const summary = report.daemon as typeof report.daemon & { master?: Record<string, unknown> | null };
    const master2 = summary.master ? { ...summary.master, budgetMinutes: masterSessionMinutes(master), heartbeatMinutes: masterHeartbeatMinutes(master) } : null;
    // An installed harness that differs from the current plan is drift the master repairs (GY-1217).
    const harness = await masterHarnessDrift(root, master);
    // GY-1519: each commit on the base branch the main watch cannot explain is one attention line, report-only.
    // GY-1522 / GY-1560: each unexplained shadow-only-fail or shadow-missed is one attention line until explained;
    // the ledger's standing list covers pairs the cursor may have dropped, and a later head of the same item does not.
    type Standing = { key: string; head: string; baseTip: string; outcome: 'shadow-only-fail' | 'shadow-missed'; mergeSha: string | null; build: 'pass' | 'fail'; tests: { passed: number; failed: string[]; files: number }; conflict?: string[]; at: string; explained: boolean; cause?: string | null };
    const shadowStatus = await masterApi('shadow-disagreements').then(
      (body: { explanations?: { key: string; head: string; baseTip: string }[]; disagreements?: Standing[] }) => body ?? {},
      () => ({} as { explanations?: { key: string; head: string; baseTip: string }[]; disagreements?: Standing[] }),
    );
    const explanations = shadowStatus.explanations ?? [];
    const standing = shadowStatus.disagreements ?? [];
    const standingVerdicts = standing.map(entry => ({
      key: entry.key, id: entry.key, head: entry.head, baseTip: entry.baseTip, mergeSha: entry.mergeSha, risk: 'normal' as const,
      build: entry.build, tests: entry.tests, conflict: entry.conflict ?? [], durationMs: 0, at: entry.at, outcome: entry.outcome,
      ...(entry.cause ? { cause: entry.cause } : {}),
    }));
    const shadowAttention = shadowGateAttention([...(state?.shadow ?? []), ...standingVerdicts], explanations);
    // GY-1603: a loop holding the lock outside this install's unit, which the unit's own run is refused on.
    const refusal = await readLockRefusal(root);
    const holder = refusal && state?.lock ? unsupervisedHolderAttention({ refusal, lock: state.lock, hostId: master.hostId, unit: (() => { try { return supervisingUnit(root, { host: effects.host }); } catch { return null; } })() }) : null;
    const added = [...(harness ? [harness] : []), ...(holder ? [holder] : []), ...mainWatchAttention(state?.mainWatch ?? null, master.baseBranch), ...shadowAttention];
    const attention = added.length ? { attentionItems: [...report.attentionItems, ...added], counts: { ...report.counts, attention: report.counts.attention + added.length } } : {};
    // `shadowGate`: outcome counts and trial times from the cursor; unexplained/explained counts from the ledger so eviction cannot hide a standing pair.
    // `mergeWriter` (GY-1524): the control-plane merge executor's queue (oldest first), the merge in flight, its last delivery and newest refusals.
    const shadowGate = {
      ...shadowGateSummary(state?.shadow ?? [], explanations),
      unexplainedDisagreements: standing.filter(entry => !entry.explained).length,
      explainedDisagreements: standing.filter(entry => entry.explained).length,
    };
    return print({ ...report, ...attention, harnessDrift: harness?.drift ?? null, shadowGate, mergeWriter: mergeWriterSummary(state?.mergeWriter), daemon: { ...report.daemon, cycleBudget: state ? cycleBudget(state, master.run.intervalSeconds * 1000) : null, ...(master2 ? { master: master2 } : {}) } });
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
  // GY-1519: an admin acknowledges a commit the main watch cannot explain, lifting the promotion freeze on it.
  // The control plane records it with an admin credential only, so the command reads one from stdin
  // (`--admin-token-stdin`, as `master promote` does) and never offers the master's coordinator credential.
  if (id === 'main-watch') {
    const { values, positionals } = parseArgs({ args, options: { reason: { type: 'string' }, 'admin-token-stdin': { type: 'boolean' } }, allowPositionals: true });
    const [action, sha] = positionals;
    if (action === 'status') return print({ mainWatch: (await readDaemonState(root, master).catch(() => null))?.mainWatch ?? null, policy: await masterApi('main-watch') });
    if (action !== 'acknowledge' || !sha || !values.reason?.trim()) throw new Error(mainWatchUsage);
    if (!values['admin-token-stdin']) throw new Error(`An acknowledgement is recorded with an admin credential, which the master does not hold: pipe one to ${acknowledgeCommand(sha)}`);
    return print(await masterMutation('main-watch/acknowledge', { sha, reason: values.reason.trim() }, undefined, await readSecretFromStdin(10_000)));
  }
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
