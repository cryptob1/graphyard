// The actionable shared-base refusals, read from the same ledger after a loop restart.
import { createHash } from 'node:crypto';
import { specCheckCurrent } from '../model/spec-check.js';
import type { DaemonState } from './state.js';
import type { DispatchCursor } from '../auto-dispatch.js';
import type { ServingReport } from '../deploy-watch.js';
import type { Work } from '../model.js';
import { parseBaseFailureReason } from '../merge-writer/executor.js';
import { gateCauses, type GateRecord } from '../batch-gate.js';

export const stalledDeliveryAction = 'Diagnose the shared base failure, file or advance its repair, and resume delivery with every test and merge requirement intact. Act as the operator-agent; no human review or approval is needed.';

export function stalledDelivery(work: readonly Work[]) {
  const reasons = new Map<string, Set<string>>();
  for (const item of work) {
    const ledger = item.mergeLedger;
    if (item.stage === 'done' || item.reworkRequested || !item.candidate || ledger?.head !== item.candidate.sha || ledger.state !== 'refused' || ledger.refusal?.kind !== 'merge') continue;
    const failure = parseBaseFailureReason(ledger.refusal.reason);
    if (!failure) continue;
    const key = `base:${failure.tip}`;
    if (!reasons.has(key)) reasons.set(key, new Set());
    reasons.get(key)!.add(ledger.refusal.reason);
  }
  return [...reasons].sort(([a], [b]) => a.localeCompare(b)).map(([key, reasons]) => {
    const detail = [...reasons].sort().join('\n');
    return { key, detail, digest: createHash('sha1').update(detail).digest('hex') };
  });
}

export type MasterCause = { key: string; detail: string; digest: string };
const cause = (key: string, detail: string): MasterCause => ({ key, detail, digest: createHash('sha1').update(detail).digest('hex') });
const subject = (kind: string, id: string) => `${kind}:${createHash('sha1').update(id).digest('hex')}`;

/** Current board/cursor refusals only: successful retries and resolved work drop their subjects. */
export function masterCauses(work: readonly Work[], actions: DaemonState['actions'] = {}): MasterCause[] {
  const open = work.filter(item => item.stage !== 'done');
  const causes = stalledDelivery(open);
  for (const item of open) {
    if (item.blocker) causes.push(cause(subject('blocker', item.id), `${item.key}: ${item.blocker}`));
    for (const action of item.actionQueue?.actions ?? []) {
      const last = action.history.at(-1);
      if (last?.event === 'failed') causes.push(cause(subject('operation', action.id), `${item.key} ${action.kind}: ${last.reason}${last.result ? `; ${last.result}` : ''}`));
    }
  }
  for (const [key, action] of Object.entries(actions)) {
    const item = open.find(item => item.key === action.work);
    const earlyExit = key.startsWith('early-exit:');
    if (!item || (!earlyExit && action.epoch !== null && action.epoch !== item.epoch)) continue;
    if (key.startsWith('spec-check-') && specCheckCurrent(item)) continue;
    if ((action.state === 'failed' || action.state === 'indeterminate') && ['dispatch', 'review', 'proof', 'attention'].includes(action.kind)) {
      const entry = cause(subject('cursor', key), `${action.work} ${action.kind}: ${action.detail}`);
      // An unchanged crash on a new lease is the same incident; its prompt still names the exact epoch.
      if (earlyExit) entry.digest = cause(entry.key, action.detail.replace(/(?:epoch|attempt) \d+/g, 'attempt')).digest;
      causes.push(entry);
    }
  }
  return causes;
}

export function dispatchCauses(work: readonly Work[], cursor: Pick<DispatchCursor, 'failures' | 'abandoned'>): MasterCause[] {
  return work.filter(item => item.stage !== 'done').flatMap(item => {
    const requests = [item.autoDispatch?.review, item.autoDispatch?.product, ...(item.autoDispatch?.producers ?? [])];
    return requests.flatMap(request => {
      if (!request || request.state !== 'requested' || request.sha !== item.candidate?.sha) return [];
      const failure = cursor.abandoned[request.id] ?? cursor.failures[request.id];
      return failure ? [cause(subject('request', request.id), `${item.key} ${request.kind}: ${failure.reason}`)] : [];
    });
  });
}

export function deploymentCauses(failure: ServingReport['failedDeploy']): MasterCause[] {
  return failure ? [cause('deployment', `Deployment ${failure.tip ?? 'unknown'}: ${failure.reason ?? 'failed'}${failure.restoring ? `; restoring ${failure.restoring}` : ''}`)] : [];
}
export const batchGateCauses = (record: GateRecord | null): MasterCause[] => gateCauses(record).map(entry => cause(entry.key, entry.detail));
export const masterCausePrompt = (causes: MasterCause[]) =>
  `Graphyard needs coordinator action:\n${causes.map(cause => cause.detail).join('\n')}\nNext agent action: Diagnose the named causes and affected work. Use typed master commands to clear resolved blockers, file or advance repairs, and retry failed launch/review/proof operations. Preserve every test and merge requirement. Act as the operator-agent; routine repair needs no human review or approval.`;
