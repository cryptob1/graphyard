// Concern: merging the next few queued heads together (GY-2088) — one trial and one push for the batch, falling back to one head at a time when the batch fails.
import type { Work } from '../model.js';
import { riskOf } from '../model/risk-class.js';
import { trialFailurePrefix } from '../model/rework-ground.js';
import { criterionProofs, e2eProofsOf, failureIsBase, mergeOne, trialFailureReason, trialFlaked, type MergeOutcome, type MergePorts } from './executor.js';
import { previewFailureReason, type PreviewVerdict } from './preview.js';
import { TrialTimeoutError } from './trial.js';

/** How many queued heads one batch merges (GY-2088): one trial and one push for all of them. */
export const defaultMergeBatch = 4;
/** What one head of a batch came to: its merge outcome, or the error that left it queued. */
export type BatchResult = { work: Work; outcome: MergeOutcome } | { work: Work; error: unknown };

const alone = async (ports: MergePorts, items: readonly Work[]) => {
  const results: BatchResult[] = [];
  for (const work of items) {
    try { results.push({ work, outcome: await mergeOne(ports, work) }); }
    catch (error) { results.push({ work, error }); }
  }
  return results;
};

/**
 * GY-2088. The heads, in queue order, merged one onto the other from the fetched tip: each head's
 * merge commit has the previous one as its first parent (or is the head itself, when its own
 * first-parent chain holds the previous tip, trial.ts `trialMerge`), so main's first-parent history
 * holds every head's own merge commit once the last is pushed. A head the queue's chain cannot merge (a
 * conflict) is refused as `mergeOne` refuses it and the rest still batch; a held head is left
 * queued. The chain's tip is trialled once (the build and the tests its combined change affects,
 * with every head's proofs) and previewed; when it passes, every head is recorded intent and trial,
 * the tip is pushed once with a lease on the tip it was tested on, and every head is recorded pushed
 * and reconciled at its own merge commit. A failing trial or preview, a hold that arrives during the
 * trial, a trial timeout or a rejected push trials the heads one at a time with `mergeOne`, so only a failing head is
 * refused. A single head is `mergeOne`'s alone.
 */
export async function mergeBatch(ports: MergePorts, items: readonly Work[]): Promise<BatchResult[]> {
  if (items.length < 2) return alone(ports, items);
  const at = () => new Date(ports.now()).toISOString();
  const results: BatchResult[] = [], batch: { work: Work; head: string; baseTip: string; mergeSha: string }[] = [], files = new Set<string>();
  const baseTip = await ports.fetch();
  let tip = baseTip;
  for (const work of items) {
    const held = ports.hold ? await ports.hold(work) : null;
    if (held) { results.push({ work, outcome: { outcome: 'requeued', reason: held, pushes: 0 } }); continue; }
    const head = work.candidate!.sha.toLowerCase(), merged = await ports.merge(head, tip, work);
    if ('conflict' in merged) {
      const reason = trialFailureReason({ conflict: merged.conflict })!;
      await ports.record(work, { kind: 'refused', head, reason });
      results.push({ work, outcome: { outcome: 'refused', reason, trial: null, conflict: merged.conflict } });
      continue;
    }
    batch.push({ work, head, baseTip: tip, mergeSha: merged.mergeSha });
    for (const file of merged.files) files.add(file);
    tip = merged.mergeSha;
  }
  const works = batch.map(entry => entry.work);
  if (batch.length < 2) return [...results, ...await alone(ports, works)];
  try {
    // A batch trial that times out is trialled one head at a time, so a timeout counts only on the head it is its own (GY-2079).
    const run = await ports.trial(tip, [...files], { key: works[0]!.key, criteria: works.flatMap(work => work.criteria) }, baseTip, ports.onStep).catch(error => { if (error instanceof TrialTimeoutError) return null; throw error; });
    if (!run) return [...results, ...await alone(ports, works)];
    let failed = failureIsBase(run) || !!trialFailureReason({ run }), preview: PreviewVerdict | null = null;
    // A preview that could not run is no pass: each head is then previewed alone, as `mergeOne` previews it.
    if (!failed && ports.preview) preview = await ports.preview(tip, [...files], works[0]!).catch(() => { failed = true; return null; });
    if (failed || previewFailureReason(preview, trialFailurePrefix)) return [...results, ...await alone(ports, works)];
    for (const work of works) if (ports.hold && await ports.hold(work)) return [...results, ...await alone(ports, works)];
    const flaked = run.flaked ? trialFlaked(run.flaked, at()) : null;
    for (const [index, { work, head, baseTip: parent, mergeSha }] of batch.entries()) {
      // Every head's proofs (unit, integration and the bound e2e cases) were counted on the batch's one trial; the e2e results ride the first head's record only, so the trusted run records once.
      const proofs = Object.fromEntries([...criterionProofs(work), ...e2eProofsOf(work)].map(proof => [proof, run.proofs[proof] ?? { executed: 0, failed: 0 }]));
      await ports.record(work, { kind: 'intent', head, baseTip: parent, mergeSha, risk: riskOf(work).risk, at: at() });
      await ports.record(work, { kind: 'trial', head, baseTip: parent, mergeSha: tip, outcome: 'verdict', build: run.build, tests: run.tests, files: run.files, proofs, durationMs: run.durationMs,
        ...(run.phases ? { phases: run.phases } : {}), attempts: run.retried ?? [], ...(index === 0 && run.e2e?.length ? { e2e: run.e2e } : {}), ...(preview ? { preview } : {}), ...(flaked && index === 0 ? { flaked } : {}) });
    }
    if (await ports.push(tip, baseTip) !== 'pushed') return [...results, ...await alone(ports, works)];
    for (const { work, mergeSha } of batch) await ports.record(work, { kind: 'pushed', mergeSha, pushedAt: at() });
    const observedTip = await ports.fetch();
    for (const { work, mergeSha, baseTip: parent } of batch) {
      await ports.record(work, { kind: 'reconciled', mergeSha, observedTip });
      results.push({ work, outcome: { outcome: 'merged', mergeSha, baseTip: parent, observedTip, pushes: 1 } });
    }
    return results;
  } catch (error) {
    // A trial with no verdict, a host failure or a lost record leaves every head queued; an intent left open is reconciled against the base next cycle.
    return [...results, ...works.filter(work => !results.some(entry => entry.work === work)).map(work => ({ work, error }))];
  }
}
