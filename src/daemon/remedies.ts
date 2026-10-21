// Concern: the deterministic remedies (AC-3) — what the doctor would apply most often needs no judgement, so the loop applies it itself, every cycle, without an agent.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Work } from '../model.js';
import { scopeRefusalBlocker, unplannedPaths } from '../model/scope.js';
import { approverSessionName } from '../master/autonomy.js';
import { containmentPhase, masterHarness } from '../master.js';
import { HarnessCheckoutRefusal, harnessApplyCheckout, recordServingUnits } from '../master/harness.js';
import { installUnitsFile } from '../install/units.js';
import { coordinatorCheckoutRoot } from '../master/profiles.js';
import { harnessDrift, writeHarnessPermissions } from '../harness.js';
import { message, touchStanding, type DaemonAction } from './state.js';
import { readyToRetry } from './sessions.js';
import { workspaceGone } from './dispatch-failures.js';
import { record, stoppedStates } from './effects.js';
import { decisionReadConcurrency } from './decision-reads.js';
import { maxApproverLaunches } from './decisions.js';
import type { Cycle } from './cycle.js';

// ---------------------------------------------------------------------------
// The deterministic remedies (AC-3): what the doctor would apply most often needs no judgement,
// so the loop applies it itself, every cycle, without an agent.
// ---------------------------------------------------------------------------

/** The remedies' own record, one key per item and remedy, so each is applied once per situation. */
const remedyKey = (remedy: string, id: string) => `remedy:${remedy}:${id}`;

/**
 * Remedy 1: settle a lapsed containment whose attempt submitted. Its work is on the pull request,
 * so the fence protects nothing once its supervisor is gone. The loop verifies that on this host
 * with the same probe `master settle-containment` runs and settles through the same `autosettle`
 * contract, carrying the probe's verification for the control plane to re-check: a supervisor
 * still present, or a probe the control plane would refuse, is left standing and recorded.
 */
export async function settleSubmittedContainment(cycle: Cycle) {
  const { state, effects, now, snapshot, clock, clockOffset, performed, isolate } = cycle;
  if (!effects.containment || !effects.settleContainment) return;
  for (const item of snapshot.work.filter(item => item.containmentQuarantine
    && item.submission?.epoch === item.containmentQuarantine.epoch && containmentPhase(item, clock)?.state === 'lapsed')) {
    await isolate('settle', item, item.key, async () => {
      const epoch = item.containmentQuarantine!.epoch, key = remedyKey('settle', `${item.id}:${epoch}`);
      // The reclaim step settles a verified-dead fence itself; this remedy is not a second settler of the same one.
      if (['done', 'started'].includes(state.actions[`settle:${item.id}:${epoch}`]?.state ?? '')) return;
      const previous = state.actions[key];
      if (previous && (previous.state === 'done' || !readyToRetry(previous, state.cycle))) return;
      const assessment = (await effects.containment!([item], { now: snapshot.now, clockOffset }))[item.id];
      if (!assessment) return;
      const attempts = (previous?.attempts ?? 0) + 1;
      if (!assessment.settleable || !assessment.verification) {
        const detail = `The lapsed containment of ${item.key} epoch ${epoch}, whose attempt submitted pull request #${item.submission!.pr}, is not verified settleable on this host: ${assessment.refusals.join('; ') || 'the probe returned no verification'}`.slice(0, 2000);
        if (previous?.detail !== detail) performed.push(await record(state, key, { kind: 'settle', work: item.key, principal: null, state: 'failed', detail, attempts, epoch, cycle: state.cycle }, now(), effects.persist));
        return;
      }
      await record(state, key, { kind: 'settle', work: item.key, principal: null, state: 'started', detail: `Settling the lapsed containment of ${item.key} epoch ${epoch}: the attempt submitted and its supervisor is verified gone`, attempts, epoch, cycle: state.cycle }, now(), effects.persist);
      try {
        await effects.settleContainment!(item, assessment);
        performed.push(await record(state, key, { kind: 'settle', work: item.key, principal: null, state: 'done', detail: `Settled the lapsed containment of ${item.key} epoch ${epoch}: the attempt submitted pull request #${item.submission!.pr} and its supervisor is verified gone on ${assessment.host ?? cycle.config.hostId}`, attempts, epoch, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        performed.push(await record(state, key, { kind: 'settle', work: item.key, principal: null, state: 'failed', detail: `Could not settle the lapsed containment of ${item.key} epoch ${epoch} whose attempt submitted: ${message(error)}`, attempts, epoch, cycle: state.cycle }, now(), effects.persist));
      }
    });
  }
}

/** A word of free text that names a file: it has a directory part, or a file extension (`README.md`). */
const pathWord = /^(?:[\w.@-]+\/)+[\w.@-]*$|^[\w@-][\w.@-]*\.[A-Za-z][\w]*$/;

/**
 * The paths a scope-refusal blocker is about, when plannedFiles already covers every one of them,
 * else null. Coverage is judged from the item's structured scope record — the open request's paths,
 * or the paths its last scope decision named — never from the blocker's prose alone, so an item with
 * no such record keeps its blocker. Any file the prose names besides must be planned as well: a
 * refusal that cites a root-level file the record does not carry is not covered.
 */
export function coveredScopePaths(item: Pick<Work, 'blocker' | 'plannedFiles' | 'scopeRequest' | 'scopeDecision'>) {
  const recorded = item.scopeRequest?.paths ?? item.scopeDecision?.paths ?? [];
  if (!recorded.length) return null;
  const words = (item.blocker ?? '').split(/[\s,;()'"`]+/).map(word => word.replace(/[.:,;!?]+$/, '')).filter(word => pathWord.test(word) && !/^https?:/.test(word));
  const named = [...new Set([...recorded, ...words])];
  return unplannedPaths(item.plannedFiles, named).length ? null : named;
}

/**
 * Remedy 2: clear a blocker whose named scope is already in plannedFiles. A scope refusal left the
 * item's blocker standing, and a widening since applied covers every path it names. Clearing it
 * weakens nothing, so the loop applies `unblock` itself as the master's operator-agent identity,
 * bound to the revision it read — the non-weakening intent that identity owns, never requested.
 */
export async function clearCoveredBlockers(cycle: Cycle) {
  const { state, effects, now, snapshot, performed, isolate } = cycle;
  const unblock = effects.unblock;
  if (!unblock) return;
  for (const item of snapshot.work.filter(item => item.stage !== 'done' && item.blocker?.startsWith(scopeRefusalBlocker))) {
    await isolate('decision', item, item.key, async () => {
      // The remedy is only for a scope refusal whose every named path a later widening covered.
      const named = coveredScopePaths(item);
      if (!named) return;
      // Keyed by the revision it read: a blocker set again later is a new situation.
      const key = remedyKey('unblock', `${item.id}:${item.revision}`);
      const previous = state.actions[key];
      if (previous && (previous.state === 'done' || !readyToRetry(previous, state.cycle))) return;
      const attempts = (previous?.attempts ?? 0) + 1;
      try {
        await unblock(item, `The loop cleared ${item.key}'s scope-refusal blocker: every path it names (${named.join(', ')}) is already in plannedFiles, so nothing is widened and nothing is weakened (GY-711).`);
        performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: `Cleared ${item.key}'s blocker as the operator-agent identity: its scope refusal names only paths plannedFiles already covers (${named.join(', ')})`.slice(0, 2000), attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'failed', detail: `Could not clear ${item.key}'s covered scope-refusal blocker: ${message(error)}`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
      }
    });
  }
}

/**
 * Remedy 2b (GY-2600): re-queue the items the loop stopped redispatching because Herdr refused the
 * workspace it was configured with. Once the configured workspace is another one, the cause is
 * gone, so the dispatch-failure blocker is cleared and the item dispatches again into the live workspace.
 */
export async function requeueWorkspaceRefusals(cycle: Cycle) {
  const { config, state, effects, now, snapshot, performed, isolate } = cycle;
  const unblock = effects.unblock, current = config.herdrWorkspace;
  if (!unblock || !current) return;
  for (const item of snapshot.work.filter(item => item.stage !== 'done' && item.blocker?.startsWith('Dispatch failed '))) {
    const dead = /workspace (\S+) not found/.exec(item.blocker!)?.[1];
    if (!dead || dead === current || !workspaceGone(item.blocker!, dead)) continue;
    await isolate('decision', item, item.key, async () => {
      const key = remedyKey('requeue', `${item.id}:${item.revision}`);
      const previous = state.actions[key];
      if (previous && (previous.state === 'done' || !readyToRetry(previous, state.cycle))) return;
      const attempts = (previous?.attempts ?? 0) + 1;
      try {
        await unblock(item, `The loop re-queued ${item.key}: its dispatches failed only because Herdr workspace ${dead} no longer exists, and the loop now launches into ${current} (GY-2600).`);
        performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: `Re-queued ${item.key}: its dispatch-failure blocker named the dead Herdr workspace ${dead}; launches now go to ${current}`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'failed', detail: `Could not re-queue ${item.key} after the Herdr workspace switch: ${message(error)}`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
      }
    });
  }
}

/** How long a requested decision may stand with no approver session before the loop relaunches one. */
export const unansweredDecisionMs = 10 * 60_000;

/**
 * Remedy 3: relaunch an approver for a decision unanswered past ten minutes. A requested decision
 * whose approver session is gone is a decision nobody will ever judge; the loop launches a fresh
 * independent session for it, within the launch bound every decision carries.
 */
export async function relaunchUnansweredApprovers(cycle: Cycle) {
  const { state, effects, now, snapshot, clock, performed, agents, isolate, launcher } = cycle;
  const { decisions, approver } = effects;
  if (!decisions || !approver) return;
  const checked = state.doctor.decisionsCheckedAt, held = cycle.heldDecisions;
  for (const id of Object.keys(checked)) if (!snapshot.work.some(item => item.id === id && item.stage !== 'done')) delete checked[id];
  let reads = decisionReadConcurrency;
  for (const item of snapshot.work.filter(item => item.stage !== 'done')) {
    // A history the decisions step holds is current to this cycle's ledger read (GY-1142) and costs
    // nothing. Any other is read at most once per item per `decisionCheckMs`, at most
    // `decisionReadConcurrency` a cycle, and first only `unansweredDecisionMs` after the remedy first
    // sees the item (its check is dated forward so): no decision is relaunched before ten minutes,
    // so an earlier read finds nothing to do and loads the control plane. What the remedy reads
    // joins the held histories, kept until the ledger shows the item's decisions moved.
    const kept = held.histories.get(item.id), last = checked[item.id];
    if (!last) checked[item.id] = new Date(clock + unansweredDecisionMs - decisionCheckMs).toISOString();
    if (!kept && (!last || clock - Date.parse(last) < decisionCheckMs || reads <= 0)) continue;
    if (!kept) { checked[item.id] = new Date(clock).toISOString(); reads -= 1; }
    await isolate('decision', item, item.key, async () => {
      const history = kept ?? await decisions(item).then(result => { held.histories.set(item.id, result.decisions); return result.decisions; }, () => []);
      for (const decision of history.filter(entry => entry.state === 'requested')) {
        if (!decision.requestedAt || clock - Date.parse(decision.requestedAt) < unansweredDecisionMs) continue;
        const name = approverSessionName(item, decision.id);
        if (agents.some(agent => agent.name === name && !stoppedStates.includes(agent.agent_status ?? ''))) continue;
        if (launcher.busy(`launch:approver:${decision.id}`)) continue;
        // A decision the loop watches — its own request, or a `master approver` session it adopted —
        // is relaunched and escalated by its approval supervision (GY-551); a second launcher here
        // would double its sessions and spend its bound twice. This remedy covers the rest.
        if (Object.values(state.approvals).some(entry => entry.decision === decision.id)) continue;
        const key = remedyKey('approver', decision.id);
        const previous = state.actions[key];
        // A replacement that also left without judging is relaunched again once the decision has
        // stood unanswered another ten minutes, within the launch bound every decision carries, so a
        // decision requested with no approver at all is never given up on.
        if (previous && (previous.attempts >= maxApproverLaunches || (previous.state === 'done' ? clock - Date.parse(previous.at) < unansweredDecisionMs : !readyToRetry(previous, state.cycle)))) continue;
        const attempts = (previous?.attempts ?? 0) + 1;
        const relaunch = async (sink: DaemonAction[]) => {
          try {
            const launched = await approver(item, decision.id);
            sink.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: `Relaunched approver ${launched.agentName} for ${item.key}'s unanswered ${decision.action} decision ${decision.id} (requested ${decision.requestedAt}, unanswered past ${unansweredDecisionMs / 60_000} min; launch ${attempts} of ${maxApproverLaunches})`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
          } catch (error) {
            sink.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'failed', detail: `Could not relaunch the approver for ${item.key}'s unanswered decision ${decision.id}: ${message(error)}`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
          }
        };
        // The launch runs on the launcher beside the loop's cycle (GY-616), as the loop's own approver
        // launches do, so slow launches never hold up this cycle's merges and dispatches; its result
        // is reported next cycle. A cycle run on its own launches in place.
        if (cycle.detached) cycle.launch('decision', item, `launch:approver:${decision.id}`, [], relaunch);
        else await relaunch(performed);
      }
    });
  }
}

/** How often the approver remedy reads one item's decision history. */
export const decisionCheckMs = 2 * 60_000;

/**
 * Remedy 4 (GY-1652): apply the Claude harness contract from the loop's unconfined process — the
 * doctor's checkout is read-only (GY-888), so only the loop can heal host-derived drift. Uses the
 * CLI checkout (GY-1662), never research's scratch. Refusals wait; failures retry per distinct cause.
 */
/** Claude harness settings path relative to the checkout (masterHarnessPlan's file). */
const claudeSettingsFile = '.claude/settings.local.json';

export async function applyHarnessContract(cycle: Cycle) {
  const { state, effects, now, performed, config, isolate } = cycle;
  // GY-1662: the loop's managed checkout (its CLI's), never the research scratch worktree runDaemon rewrites research's cwd to.
  const root = (config.cliPath ? coordinatorCheckoutRoot(config.cliPath) : null) ?? effects.doctor?.cwd;
  // A root that does not exist is no checkout at all (a configuration whose CLI path names no files): nothing to validate or write.
  if (!root || !existsSync(root)) return;
  await isolate('config', null, 'harness contract', async () => {
    const key = remedyKey('harness', 'claude'), previous = state.actions[key], attempts = (previous?.attempts ?? 0) + 1;
    try {
      // GY-1692 (GY-1666): a checkout that records no units, served by a unit that runs it, records its own before validation, instead of waiting on a person's master init.
      const units = effects.harness?.servingUnit ? await recordServingUnits(root, config.repository, { servingUnit: effects.harness.servingUnit, unitDirectory: effects.harness.unitDirectory }) : null;
      const recorded = units ? `Recorded this install's units (${units.master}, ${units.executorTemplate}) in ${root}/${installUnitsFile} from ${effects.harness!.servingUnit}, the unit serving the loop, which runs it. ` : '';
      // Every resolved checkout is validated first, settings installed or not: one that records no units waits on master init (GY-1662).
      harnessApplyCheckout(root, { servingUnit: effects.harness?.servingUnit, unitDirectory: effects.harness?.unitDirectory });
      // A validated checkout with no Claude settings installed has nothing to apply (harnessDrift is null without the file).
      const plan = existsSync(resolve(root, claudeSettingsFile)) ? masterHarness(root, config, 'claude') : null;
      if (!plan || !await harnessDrift(root, plan)) {
        // A refusal the operator's remedy has cleared, or a failure the checkout recovered from, closes once the contract already holds (GY-1662).
        if ((previous && previous.state !== 'done') || units) performed.push(await record(state, key, { kind: 'config', work: null, principal: null, state: 'done', detail: `${recorded}${plan ? `The Claude harness contract already holds for ${root}` : `No Claude harness settings are installed under ${root} (${claudeSettingsFile})`}${previous && previous.state !== 'done' ? `: the earlier ${previous.state} row is resolved with nothing to apply` : ': nothing to apply'}`.slice(0, 2000), attempts, cycle: state.cycle }, now(), effects.persist));
        return;
      }
      const written = await writeHarnessPermissions(root, plan, true);
      const changed = [...written.removed.map(entry => `removed stale ${entry.list} ${entry.rule}`), ...written.added.map(entry => `added ${entry.list} ${entry.rule}`)].join(', ');
      performed.push(await record(state, key, { kind: 'config', work: null, principal: null, state: 'done', detail: `${recorded}Applied the Claude harness contract to ${written.file} from the loop's own process, as graphyard master harness claude --apply does, keeping operator-added entries: ${changed}`.slice(0, 2000), attempts, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      // A checkout refusal waits on the operator's remedy, which it names: journaled once, never refreshed or retried as a fault, until its cause changes.
      if (error instanceof HarnessCheckoutRefusal) {
        const detail = error.message.slice(0, 2000);
        if (previous?.state !== 'waiting' || previous.detail !== detail) performed.push(await record(state, key, { kind: 'config', work: null, principal: null, state: 'waiting', detail, attempts, cycle: state.cycle }, now(), effects.persist));
        return;
      }
      // A filesystem refusal names its random temporary file; its code and the settings directory are the cause, stable across cycles.
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const detail = `Could not apply the Claude harness contract from the loop's own process: ${code ? `${code} writing the harness settings under ${root}/.claude` : message(error)}`.slice(0, 2000);
      // The same cause again is the one standing failure: its time moves (touchStanding), so the fault window keeps the run open while it lasts, but nothing new is journaled.
      if (previous?.state === 'failed' && previous.detail === detail) { touchStanding(state, key, new Date(now()).toISOString()); await effects.persist(state); return; }
      performed.push(await record(state, key, { kind: 'config', work: null, principal: null, state: 'failed', detail, attempts, cycle: state.cycle }, now(), effects.persist));
    }
  });
}

/** The deterministic remedies, every cycle, before the doctor itself is scheduled. */
export async function routineRemedies(cycle: Cycle) {
  await settleSubmittedContainment(cycle);
  await clearCoveredBlockers(cycle);
  await requeueWorkspaceRefusals(cycle);
  await relaunchUnansweredApprovers(cycle);
  await applyHarnessContract(cycle);
}
