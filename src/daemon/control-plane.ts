// Concern: GY-3199 — the control plane's own daily update, as the loop sees it. The deploy watch
// keeps .graphyard/control-plane.json; this step reads it each cycle: while an upgrade keeps
// failing it files one item naming the failed step (never one per retry — the record's verified
// commit and failed step are the filing's idempotency key), and once a day it reports the
// staleness the record shows — a check over a day old, or a verified commit first seen over a day
// ago that the install still does not run.
import { controlPlaneRecordPath, controlPlaneStaleLines, readControlPlaneRecord, type ControlPlaneRecord } from '../deploy-watch.js';
import { actionLine } from './run.js';
import { message, storeAction } from './state.js';
import type { Cycle } from './cycle.js';

/** The bug item a failed control-plane upgrade files: one item per verified commit and failed step. */
export function controlPlaneUpgradeItem(record: ControlPlaneRecord) {
  const step = record.failedStep ?? 'an unknown step', verified = record.verified ?? 'an unknown commit';
  return {
    title: `Control-plane upgrade stuck at ${step}`.slice(0, 200),
    type: 'bug' as const,
    priority: 1,
    description: `The daily control-plane upgrade to the verified Graphyard commit ${verified.slice(0, 12)} fails at ${step}: ${(record.failedReason ?? 'no reason recorded').slice(0, 500)}. The install keeps running ${record.commit?.slice(0, 12) ?? 'its previous version'} and retries about hourly; .graphyard/control-plane.json carries the record and master status shows it. Fix the upgrade's cause — the failed step and reason above — so the install runs the latest verified commit again.`,
    dependencies: [],
    criteria: [
      { id: 'AC-1', text: `The control-plane upgrade past ${verified.slice(0, 12)} no longer fails at ${step}; a new test pins the cause and fails without the fix`, proofs: ['unit:control-plane-upgrade-pinned'] },
      { id: 'AC-2', text: 'The install again runs the latest verified Graphyard commit within a day of its publishing', proofs: ['manual:control-plane-current'] },
    ],
    reason: 'Filed by the master loop from the control-plane update record (GY-3199)',
  };
}

/**
 * The control plane's own record, read beside the cycle: one item while an upgrade keeps failing,
 * and the daily staleness line. Nothing here writes the record — the deploy watch owns it.
 */
export async function controlPlaneStep(cycle: Pick<Cycle, 'state' | 'effects' | 'clock' | 'log'>) {
  const reads = cycle.effects.mergeWriter, root = reads?.gate?.root;
  if (!reads?.createWork || !root) return;
  const note = (key: string, state: 'done' | 'failed', detail: string) => {
    const entry = storeAction(cycle.state, key, { kind: 'attention', work: null, principal: null, state, detail: detail.slice(0, 1900), attempts: 1, epoch: null, cycle: cycle.state.cycle, at: new Date(cycle.clock).toISOString() });
    cycle.log(actionLine(cycle.state.cycle, entry));
  };
  const record = readControlPlaneRecord(controlPlaneRecordPath(root));
  if (record?.failedStep && record.verified) {
    // One item per verified commit and failed step: a retry, or a later pass still failing at the
    // same step of the same commit, files nothing new.
    const key = `control-plane-upgrade:${record.verified}:${record.failedStep}`;
    if (cycle.state.actions[key]?.state !== 'done') {
      try {
        const filed = await reads.createWork(controlPlaneUpgradeItem(record), key);
        await note(key, 'done', `Filed ${(filed as { key?: string } | null)?.key ?? 'an item'}: the control-plane upgrade to ${record.verified.slice(0, 12)} keeps failing at ${record.failedStep}, so the install still runs ${record.commit?.slice(0, 12) ?? 'its previous version'}`);
      } catch (error) { await note(key, 'failed', `Could not file the stuck control-plane upgrade (${record.failedStep} at ${record.verified.slice(0, 12)}): ${message(error)}`); }
    }
  }
  // The daily diagnostics: each staleness line once per UTC day, in the journal the leftovers
  // report writes to. Nothing stale logs nothing.
  const day = new Date(cycle.clock).toISOString().slice(0, 10);
  if (cycle.state.controlPlaneDay !== day) {
    cycle.state.controlPlaneDay = day;
    const stale = controlPlaneStaleLines(readControlPlaneRecord(controlPlaneRecordPath(root)), cycle.clock);
    if (stale.length) cycle.log(`[graphyard-master] control-plane diagnostics: ${stale.join('; ')}`);
  }
}
