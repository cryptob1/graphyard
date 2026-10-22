// Concern: `graphyard master` operations subcommands — status, settle-containment, checkout-restore and the confined master's loop requests, dispatch, merge, recover, reading.
import { parseArgs } from 'node:util';
import { resourceConflicts } from '../../coordination.js';
import { handSettlementRefusal } from '../../model/containment.js';
import { dispatchWork, listHerdrAgents, readWorkerCredential, snapshotWithClock, verifyContainmentDeath, withReviewerDefaults, withRoleDefaults } from '../../master.js';
import { observeDeployment, readDaemonState } from '../../master-daemon.js';
import { localPostDeployChecks, type PostDeployChecksInput } from '../../master-verification.js';
import { cycleBudget, masterStatusReport } from '../master-status.js';
import { masterHeartbeatMinutes, masterSessionMinutes } from '../../master/master-session.js';
import { assertHandDispatch } from '../hand-actions.js';
import { unhandled, type MasterSession } from './session.js';
import { masterHarnessDrift } from './fleet.js';
import { readSecretFromStdin } from '../context.js';
import { mergeWriterSummary } from '../../daemon/cycle-merge-writer.js';
import { defaultChildRun } from '../../child-runner.js';
import { installDirectory } from '../../install/secrets.js';
import { installIdFor } from '../../install/types.js';
import { knownGoodState, pinKnownGood } from '../../master/known-good.js';
import { alignLoopUnit, loopUnitOf, type LoopSupervisorHost } from '../../supervisor.js';
import type { ChildRun } from '../../child-runner.js';
import { readLockRefusal, supervisingUnit, unsupervisedHolderAttention } from '../../master/loop-restart.js';
import { checkoutRestoreCommand } from '../master-checkout-restore.js';
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

/**
 * `master post-deploy-checks` (GY-1732): this checkout's decision of a delivered item's post-deploy
 * checks and the follow-ups they file, printed as JSON from a `PostDeployChecksInput` on stdin.
 * The loop's readings run it from the observed release's isolated checkout, so a follow-up's text and
 * observation window are the serving release's, not those of a coordinator checkout behind it.
 */
export async function postDeployChecksCommand(stdin: AsyncIterable<string | Buffer> = process.stdin, write: (text: string) => void = text => process.stdout.write(text)) {
  let raw = ''; for await (const chunk of stdin) { raw += chunk; if (raw.length > 4_000_000) throw new Error('post-deploy-checks input is too large'); }
  const input = JSON.parse(raw) as PostDeployChecksInput;
  if (!input?.work?.id || typeof input.release !== 'string' || typeof input.now !== 'string') throw new Error('Use master post-deploy-checks with {"work","release","now","servedAt"} as JSON on stdin');
  write(`${JSON.stringify(await localPostDeployChecks(input))}\n`);
}

/** Reading status and acting on one item: settle a quarantine, dispatch, merge, record a reading. */
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
    // GY-1603: a loop holding the lock outside this install's unit, which the unit's own run is refused on.
    const refusal = await readLockRefusal(root);
    const holder = refusal && state?.lock ? unsupervisedHolderAttention({ refusal, lock: state.lock, hostId: master.hostId, unit: await supervisingUnit(root, master, { host: effects.host }).catch(() => null) }) : null;
    const added = [...(harness ? [harness] : []), ...(holder ? [holder] : [])];
    const attention = added.length ? { attentionItems: [...report.attentionItems, ...added], counts: { ...report.counts, attention: report.counts.attention + added.length } } : {};
    // `mergeWriter` (GY-1524): the control-plane merge executor's queue (oldest first), the merge in flight, its last delivery and newest refusals.
    return print({ ...report, ...attention, harnessDrift: harness?.drift ?? null, mergeWriter: mergeWriterSummary(state?.mergeWriter), daemon: { ...report.daemon, cycleBudget: state ? cycleBudget(state, master.run.intervalSeconds * 1000) : null, ...(master2 ? { master: master2 } : {}) } });
  }
  // GY-1658: the loop restores a dirty coordinator checkout to a named ref and restarts itself; this files the request and reports the outcome.
  if (id === 'checkout-restore') return print(await checkoutRestoreCommand(master, args, String(coordinator?.actor?.id ?? coordinator?.actor?.name ?? 'master')));
  // The confined master session sees no host systemd (GY-1658), so its restart is a request the loop serves through its own unit.
  if (id === 'restart' && confinedMaster()) return print(await checkoutRestoreCommand(master, args, String(coordinator?.actor?.id ?? coordinator?.actor?.name ?? 'master'), { act: 'restart' }));
  if (id === 'settle-containment') {
    if (!args[0] || !args.slice(1).join(' ').trim()) throw new Error('Use master settle-containment GY-N REASON');
    const { snapshot, clockOffset } = await snapshotWithClock(() => masterApi('work-snapshot'));
    const work = snapshot.work.find((item: any) => item.id === args[0] || item.key === args[0]);
    if (!work) throw new Error(`Unknown work item ${args[0]}`);
    if (!work.containmentQuarantine) throw new Error(`${work.key} has no containment quarantine to settle`);
    // GY-1633: inside its settle bound a lapsed fence is the loop's reclaim step's to settle; a hand settlement is a second executor.
    const loopOwned = handSettlementRefusal(work, Date.parse(snapshot.now));
    if (loopOwned) throw new Error(loopOwned);
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
  // GY-1779: the master's hand record of a loop-owned observation item's reading the loop could not take from this host
  // (`pendingReadings` in master status names why), bound as the loop's own: the release the loop last verified serving,
  // the parent delivery's merge and the item's policy revision; the loop closes a passing one next cycle.
  if (id === 'reading') {
    // GY-1779: the hand path for a reading this host cannot take itself; the loop closes a recorded pass next cycle.
    const [key, result, ...rest] = args;
    const usage = 'Use master reading GY-N pass|fail [PROOF] DETAIL (the measured values, as observed on the serving release; PROOF names which of a multi-proof item\'s proofs, else the first still unread)';
    if (!key || (result !== 'pass' && result !== 'fail') || !rest.join(' ').trim()) throw new Error(usage);
    const snapshot = await masterApi('work-snapshot');
    const work = snapshot.work.find((item: any) => item.id === key || item.key === key);
    if (!work) throw new Error(`Unknown work item ${key}`);
    const { followUpRequest } = await import('../../model/observation-window.js');
    const { loopObservationProofs, loopReadingOn } = await import('../../model/loop-observation.js');
    const proofs = loopObservationProofs(work);
    if (!proofs) throw new Error(`${work.key} is not a loop-owned observation item; a reading is recorded only on an item whose every criterion is a post-deploy observation the loop takes`);
    const request = followUpRequest(work), parent = request ? snapshot.work.find((item: any) => item.id === request.work) : null;
    // The release is observed now, not read from the loop's last cycle: a rollout since then would bind the reading to a release the plane no longer serves.
    const retained = (await readDaemonState(root, master).catch(() => null))?.deployment?.containment ?? null;
    const served = await observeDeployment(master, [request && parent?.delivery ? parent : work], effects.run, fetch, () => Date.now(), { root, retained });
    if (!served.sha || served.source === 'unavailable') throw new Error(`The serving release could not be observed now${served.reason ? `: ${served.reason}` : ''}; the reading is bound to one, so retry once it can be`);
    if (request && !parent?.delivery) throw new Error(`${work.key}'s follow-up request names ${request.work}, which is not a delivered item`);
    // The same check the loop's reading makes: a release not observed carrying the parent's merge is no observation of it.
    if (request && !(served.deployed.includes(parent.key) || (served.containment?.release === served.sha && Object.hasOwn(served.containment.settled, parent.key)))) throw new Error(`${work.key}'s reading is due, and the release the control plane serves (${served.sha.slice(0, 12)}) is not observed carrying ${parent.key}'s merge ${String(parent.delivery.mergeSha).slice(0, 12)}; the loop reads it on a release that does`);
    // The proof named, else the first the loop has no passing reading of on this release, else the first.
    const named = proofs.includes(rest[0]) ? rest[0] : null, detail = (named ? rest.slice(1) : rest).join(' ').trim();
    if (!detail) throw new Error(usage);
    const proof = named ?? proofs.find(candidate => loopReadingOn(work, candidate, served.sha as string)?.result !== 'pass') ?? proofs[0];
    const reading = { proof, sha: served.sha, baseSha: request ? parent.delivery.mergeSha : served.sha, policyRevision: work.policyRevision, result, detail: detail.slice(0, 2000) };
    return print(await masterMutation(`work/${work.id}/reading`, reading));
  }
  return unhandled;
}
