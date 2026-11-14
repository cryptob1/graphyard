// GY-2010: an item reaches done the one way production delivers it now — the merge writer's
// ledger records (intent, push, reconcile) through the plane's own merge-record handler — so a
// test that needs a delivered item records them instead of a GitHub merge observation. Main is
// read as holding the merge commit (the handler's ancestry check answers yes), as the writer's
// fetch would show after its push.
import { randomUUID } from 'node:crypto';
import type { Engine } from '../../src/engine.js';
import { currentEvidence } from '../../src/model/evidence.js';
import type { Principal, Work } from '../../src/model.js';
import type { Services } from '../../src/server/routes.js';
import { recordMergeEvent } from '../../src/server/merge-record.js';

const writer: Principal = { id: 'merge-writer-test', role: 'coordinator' };

/** The common no-op E2E fixture added by delivery tests is a required proof too. */
export async function proveFixtureCase(engine: Engine, work: Work): Promise<Work> {
  const proof = 'e2e:fixture';
  if (!work.criteria.some(c => c.proofs.includes(proof)) || currentEvidence(work, proof, new Date())) return work;
  return engine.execute({ id: 'fixture-case-producer', role: 'producer', proofs: [proof] }, 'evidence', work.id,
    { proof, sha: work.candidate!.sha, baseSha: work.candidate!.baseSha, policyRevision: work.policyRevision,
      result: 'pass', executed: 1, skipped: 0, exercise: { behaviour: 'the fixture case', result: 'fail', executed: 1 } }, randomUUID());
}

/** Records the writer's intent, push and reconcile of `mergeSha` for the item's current candidate; `pushedAt` becomes `delivery.mergedAt`. */
export async function deliverThroughLedger(engine: Engine, workId: string, mergeSha: string, pushedAt = new Date().toISOString()): Promise<Work> {
  const work = await proveFixtureCase(engine, (await engine.store.workItem(workId))!);
  const head = work.candidate!.sha.toLowerCase(), baseTip = work.candidate!.baseSha.toLowerCase(), merge = mergeSha.toLowerCase();
  const services = { engine } as unknown as Services;
  const previous = engine.gitRunner;
  engine.gitRunner = (async () => ({ status: 0, stdout: '', stderr: '' })) as unknown as Engine['gitRunner'];
  try {
    await recordMergeEvent(services, writer, work.id, { kind: 'intent', head, baseTip, mergeSha: merge, risk: 'normal', at: pushedAt }, randomUUID());
    await recordMergeEvent(services, writer, work.id, { kind: 'pushed', mergeSha: merge, pushedAt }, randomUUID());
    await recordMergeEvent(services, writer, work.id, { kind: 'reconciled', mergeSha: merge, observedTip: merge }, randomUUID());
  } finally { engine.gitRunner = previous; }
  return (await engine.store.workItem(work.id))!;
}
