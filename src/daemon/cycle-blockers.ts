// Concern: cycle step 2d — every standing blocker re-checked each cycle (GY-1008): environmental causes probed and cleared, a needs-decision blocker's approver launched.
import type { Work } from '../model.js';
import { blockerClassMeaning, environmentalBlockerClasses, itemBlockerClass, maxAutomaticClears, needsSomeone, uncoveredBlockerPaths, unrepresentableScope, type BlockerClassification } from '../model/blocker-class.js';
import { scopeRefusalBlocker } from '../model/scope.js';
import { approvalWatchSchema, message, type DaemonAction } from './state.js';
import { readyToRetry } from './sessions.js';
import { boundDetail, detailChanged, handWatchPrefix, namePaths } from './decisions.js';
import { record } from './effects.js';
import { workerHandle } from './cycle-resume.js';
import { credentialBlockedKey, credentialFailure } from '../worker-credential.js';
import type { BlockerProbeResult } from './blocker-probes.js';
import type { Cycle } from './cycle.js';

/** How often an unchanged failing probe is written to the item again, so the board's "last probe" stays current without a revision every cycle. */
export const blockerRecordMs = 5 * 60_000;
export const blockerKey = (item: Pick<Work, 'id'>) => `blocker:${item.id}`;
// Both are per blocker episode: the base tip keyed by the attempt that met the failure, the approver
// launch by its decision. Each is retired with the blocker, so the cursor holds none past it.
const baseKey = (item: Pick<Work, 'id' | 'epoch'>, blocker: string) => `blocker:base:${item.id}:${item.epoch}:${blocker.length}:${blocker.slice(0, 40)}`;
const approverKey = (item: Pick<Work, 'id'>, decision: string) => `blocker:approver:${item.id}:${decision}`;
const episodeKey = (item: Pick<Work, 'id'>, key: string) => key.startsWith(`blocker:base:${item.id}:`) || key.startsWith(`blocker:approver:${item.id}:`);
const episodeKeys = (state: { actions: Record<string, unknown> }, item: Pick<Work, 'id'>) => Object.keys(state.actions).filter(key => episodeKey(item, key));

/**
 * 2d. Blocked work unblocks itself (GY-1008). A recorded blocker has already ended its attempt
 * (the engine's `blocked`), so no blocked item holds a worker slot. Each cycle every standing
 * blocker is read into its class (model/blocker-class.ts) and:
 * - an environmental class has its cause probed the way the next attempt would meet it — the
 *   credential and write probes inside the confinement the worker's launch describes — once per
 *   cause per cycle, and the probe is written on the item; a passing probe clears the blocker in
 *   the same write, which the control plane allows only after classifying the blocker itself;
 * - a planned-file-scope blocker is put to the approver as an additive widening by the decision
 *   step (`blockerScopeDecision`), and cleared here once plannedFiles cover every file it names;
 * - a needs-decision blocker gets the approver of its standing decision launched when no session
 *   judges it yet — watched from launch as a hand-launched approver is, so the decision step closes
 *   it once the decision is judged — and is cleared once no decision on the item stands requested;
 * - a genuine or human-only blocker, a planned-file-scope one no fold represents under the
 *   plannedFiles cap, or one this loop has cleared `maxAutomaticClears` times in a row, is left to
 *   the master (or the human), which is all `master status` counts as needing someone.
 * The per-episode cursor rows (the base tip, the approver launch) are retired once the blocker is
 * gone, and a delivered or closed item's rows with it, so `state.actions` stays bounded.
 */
export async function blockerStep(cycle: Cycle) {
  const { config, state, effects, now, clock, performed, isolate, open, launcher } = cycle;
  for (const item of open) await isolate('blocker', item, item.key, () => endCredentialBlockedSession(cycle, item));
  if (!effects.recordBlockerProbe) return;
  // Rows of items no longer open (delivered, closed, gone from the snapshot) go with them.
  const orphaned = Object.keys(state.actions).filter(key => key.startsWith('blocker:') && !open.some(item => key === blockerKey(item) || episodeKey(item, key)));
  if (orphaned.length) { for (const key of orphaned) delete state.actions[key]; await effects.persist(state); }
  const intervalMs = (config.run.intervalSeconds ?? 20) * 1000;
  // One probe per cause per cycle: eight items blocked on one credential cost one `gh auth status`.
  const probes = new Map<string, Promise<BlockerProbeResult | null>>();
  const probe = (item: Work, classification: BlockerClassification) => {
    const workspace = item.workspaces.find(entry => entry.epoch === item.epoch && entry.host === config.hostId);
    const memo = `${classification.class}:${classification.class === 'worktree-mismatch' ? item.id : `${workspace?.path ?? ''}:${classification.path ?? ''}`}`;
    if (!probes.has(memo)) probes.set(memo, effects.probeBlocker ? effects.probeBlocker(item, classification) : Promise.resolve(null));
    return probes.get(memo)!;
  };
  const note = async (key: string, item: Work, outcome: DaemonAction['state'], detail: string, attempts = 1) =>
    record(state, key, { kind: 'blocker', work: item.key, principal: null, epoch: item.epoch, state: outcome, detail: boundDetail(detail), attempts, cycle: state.cycle }, now(), effects.persist);

  for (const item of open) await isolate('blocker', item, item.key, async () => {
    const classification = itemBlockerClass(item);
    const key = blockerKey(item);
    if (!classification || !item.blocker) {
      const retired = [...(state.actions[key] ? [key] : []), ...episodeKeys(state, item)];
      if (retired.length) { for (const entry of retired) delete state.actions[entry]; await effects.persist(state); }
      return;
    }
    const blocker = item.blocker;
    const standing = (detail: string) => detailChanged(state.actions[key], detail) ? note(key, item, 'done', detail) : Promise.resolve(null);
    // Handed to the master (or the human): reported once, as the cycle's action, when it first stands.
    const handOver = async (detail: string) => { const noted = await standing(detail); if (noted) performed.push(noted); };
    if (needsSomeone(classification.class)) { await handOver(`${item.key} is blocked (${classification.class}: ${blockerClassMeaning[classification.class]}); it needs someone: ${blocker}`); return; }
    // A refused scope request is the scope step's to put to the approver; its answer clears it.
    if (blocker.startsWith(scopeRefusalBlocker)) return;
    if (unrepresentableScope(item, classification)) {
      await handOver(`${item.key} is blocked (planned-file-scope) on files no widening can represent under the plannedFiles cap, so it needs the master: ${blocker}`);
      return;
    }
    const clears = item.blockerProbe?.clears ?? 0;
    if (clears >= maxAutomaticClears) {
      await handOver(`${item.key} is blocked (${classification.class}) again after the loop cleared its blocker ${clears} times in a row without a submission, so it is left to the master: ${blocker}`);
      return;
    }

    let result: BlockerProbeResult | null = null;
    if (environmentalBlockerClasses.includes(classification.class)) {
      result = await probe(item, classification);
      if (!result) return;
      // The base tip the failure was met on is the first one the loop read; a later tip is a new base.
      if (classification.class === 'outside-scope-test-failure' && result.baseTip) {
        const seen = state.actions[baseKey(item, blocker)];
        if (!seen) await note(baseKey(item, blocker), item, 'done', result.baseTip);
        else if (seen.detail !== result.baseTip) result = { ...result, passed: true, detail: `the base tip moved from ${seen.detail.slice(0, 12)} to ${result.baseTip.slice(0, 12)}` };
      }
    } else if (classification.class === 'planned-file-scope') {
      const missing = uncoveredBlockerPaths(item, classification);
      result = missing.length ? { probe: 'plannedFiles cover the named files', passed: false, detail: `awaiting the additive widening decision for ${namePaths(missing)} (commit ${classification.commit!.slice(0, 12)}) from the independent approver` }
        : { probe: 'plannedFiles cover the named files', passed: true, detail: `plannedFiles now cover ${namePaths(classification.paths)}` };
    } else if (classification.class === 'needs-decision') {
      if (!effects.decisions) return;
      const requested = (await effects.decisions(item)).decisions.filter(decision => decision.state === 'requested');
      const decision = requested.find(entry => entry.id === classification.decision) ?? requested[0];
      if (!decision) result = { probe: 'no decision on the item stands requested', passed: true, detail: classification.decision ? `decision ${classification.decision} was judged` : 'every decision on the item was judged' };
      else {
        result = { probe: 'no decision on the item stands requested', passed: false, detail: `decision ${decision.id} (${decision.action}) waits on its approver` };
        const watched = Object.values(state.approvals).some(watch => watch.decision === decision.id && !watch.settledAt) || launcher.busy(`launch:approver:${decision.id}`)
          || (await effects.approverLaunches?.().catch(() => []) ?? []).some(entry => entry.decision === decision.id);
        const launchKey = approverKey(item, decision.id), previous = state.actions[launchKey];
        if (!watched && effects.approver && (!previous || (previous.state === 'failed' && readyToRetry(previous, state.cycle)))) {
          const attempts = (previous?.attempts ?? 0) + 1;
          try {
            const launched = await effects.approver(item, decision.id);
            // Watched from launch, as a `master approver` session is: the decision step's hand-watch
            // supervision closes it once its decision is judged, and relaunches it within the bound.
            const stamp = new Date(clock).toISOString();
            state.approvals[`${handWatchPrefix}${decision.id}`] = approvalWatchSchema.parse({ work: item.key, action: decision.action, decision: decision.id, requestedAt: stamp, agentName: launched.agentName, pane: launched.pane,
              launchedAt: stamp, launches: 1, account: launched.account ?? null, runtime: launched.runtime ?? null, session: launched.session ?? null });
            performed.push(await note(launchKey, item, 'done', `${item.key} is blocked on decision ${decision.id} (${decision.action}) that no approver session judged; launched approver ${launched.agentName}${launched.pane ? ` in pane ${launched.pane}` : ''}`, attempts));
            result = { ...result, detail: `decision ${decision.id} (${decision.action}): approver ${launched.agentName} launched` };
          } catch (error) {
            performed.push(await note(launchKey, item, 'failed', `${item.key} is blocked on decision ${decision.id}; its approver could not be launched: ${message(error)}`, attempts));
          }
        }
      }
    }
    if (!result) return;

    const last = item.blockerProbe?.blocker === blocker ? item.blockerProbe : null;
    const outcome = result.passed ? 'pass' : 'fail';
    const due = result.passed || !last || last.result !== outcome || last.detail !== result.detail || last.probe !== result.probe || clock - Date.parse(last.at) >= blockerRecordMs;
    if (!due) return;
    try {
      await effects.recordBlockerProbe!(item, { blocker, class: classification.class, probe: result.probe.slice(0, 300), result: outcome, detail: result.detail.slice(0, 500), nextAt: new Date(clock + intervalMs).toISOString() });
      if (result.passed) for (const entry of episodeKeys(state, item)) delete state.actions[entry];
      if (result.passed) performed.push(await note(key, item, 'done', `Cleared ${item.key}'s ${classification.class} blocker: ${result.probe} passed (${result.detail}); it was: ${blocker}`));
      else await standing(`${item.key} is blocked (${classification.class}); the loop re-checks it every cycle: ${result.probe} fails (${result.detail})`);
    } catch (error) {
      performed.push(await note(key, item, 'failed', `Could not record ${item.key}'s ${classification.class} blocker probe (${result.probe}: ${outcome}): ${message(error)}`, (state.actions[key]?.attempts ?? 0) + 1));
    }
  });
}

/**
 * GY-999 on an attempt its blocked report already ended: a GitHub credential failure lived in that
 * session's credential, so the session is done with — once per epoch the loop closes the pane its
 * handle records (unless another agent now holds it) and marks the handle finished, and the ending
 * counts on the retry ladder through the marker the engine wrote on it. The next attempt is launched
 * with a freshly minted push credential once the blocker clears, after the ladder's backoff.
 */
async function endCredentialBlockedSession(cycle: Cycle, item: Work) {
  const { config, state, effects, now, performed, agents } = cycle;
  const epoch = item.lastAssignment?.epoch ?? item.epoch, owner = item.lastAssignment?.owner;
  if (!item.blocker || !credentialFailure(item.blocker) || (item.lease && item.lease.epoch >= epoch) || !owner) return;
  const key = credentialBlockedKey(item, epoch);
  if (state.actions[key]) return;
  const profile = config.workers.find(worker => worker.principal === owner && worker.mode === 'launch');
  if (!profile) return;
  const handle = item.sessions?.find(session => session.kind === 'implementation' && session.id === `${owner}:${epoch}`);
  const pane = handle?.pane ?? null, holder = pane ? agents.find(agent => agent.pane_id === pane) : undefined;
  const closable = !!pane && (!holder || holder.name === profile.agentName);
  let closed = 'no pane was left to close';
  if (closable) {
    try { await effects.closeSession(pane!); closed = `pane ${pane} was closed`; }
    catch (error) { closed = `pane ${pane} could not be closed (${message(error)})`; }
  }
  await workerHandle(cycle, item, profile, epoch, pane ?? 'none', `closed as failed: credential-blocked attempt on epoch ${epoch}`, true);
  performed.push(await record(state, key, { kind: 'session', work: item.key, principal: owner, epoch, state: 'done', attempts: 1, cycle: state.cycle,
    detail: boundDetail(`${profile.agentName} on ${item.key} recorded a GitHub credential failure, which ended epoch ${epoch} with its work kept; ${closed}, and ${item.key} is launched again with a freshly minted push credential once its blocker clears`) }, now(), effects.persist));
}
