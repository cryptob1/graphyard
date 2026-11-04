// Concern: merging the next few queued heads together (GY-2088) — one trial and one push for the batch, falling back to one head at a time when the batch fails — and trialling several batches at once, each stacked on the one before it.
import type { Work } from '../model.js';
import { riskOf } from '../model/risk-class.js';
import { trialFailurePrefix } from '../model/rework-ground.js';
import { criterionProofs, e2eProofsOf, failureIsBase, mergeOne, requiredProofFailure, trialFailureReason, trialFlaked, type MergeOutcome, type MergePorts } from './executor.js';
import { previewFailureReason, type PreviewVerdict } from './preview.js';
import { TrialTimeoutError, recordedTests } from './trial.js';

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
 * conflict) is retried individually after the rest settles and the rest still batch; a held head is left
 * queued. The chain's tip is trialled once (the build and the tests its combined change affects,
 * with every head's proofs) and previewed; every head records its intent before the trial and its verdict afterward,
 * the tip is pushed once with a lease on the tip it was tested on, and every head is recorded pushed
 * and reconciled at its own merge commit. A rejected push, or a stacked trial whose tip did not
 * land (`lands`), trials the batch again on the tip as it now stands, `retrials` times at most. A failing trial or preview, a hold that arrives during the
 * trial, a trial timeout or a push rejected past the bound trials the heads one at a time with `mergeOne`, so only a failing head is
 * refused. A single head is `mergeOne`'s alone.
 */
export async function mergeBatch(ports: MergePorts, items: readonly Work[], retrial = 0): Promise<BatchResult[]> {
  const conflicts: Work[] = [];
  const results = await mergeBatchReady(ports, items, retrial, conflicts);
  return [...results, ...await alone(ports, conflicts)];
}

async function mergeBatchReady(ports: MergePorts, items: readonly Work[], retrial: number, conflicts: Work[]): Promise<BatchResult[]> {
  if (items.length < 2) return alone(ports, items);
  // GY-2984: a bug item's proofs are judged on the base tip alone, so it is never batched.
  const bugs = items.filter(work => work.type === 'bug');
  if (bugs.length) return [...await alone(ports, bugs), ...await mergeBatch(ports, items.filter(work => work.type !== 'bug'))];
  const at = () => new Date(ports.now()).toISOString();
  const results: BatchResult[] = [], batch: { work: Work; head: string; baseTip: string; mergeSha: string }[] = [], files = new Set<string>();
  const baseTip = await ports.fetch();
  let tip = baseTip;
  for (const work of items) {
    const held = ports.hold ? await ports.hold(work) : null;
    if (held) { results.push({ work, outcome: { outcome: 'requeued', reason: held, pushes: 0 } }); continue; }
    const head = work.candidate!.sha.toLowerCase(), merged = await ports.merge(head, tip, work);
    if ('conflict' in merged) {
      // Neither earlier positions nor this batch's earlier heads have necessarily landed.
      // Retry conflicts individually after the rest settles, against the actual landed tip.
      conflicts.push(work);
      continue;
    }
    batch.push({ work, head, baseTip: tip, mergeSha: merged.mergeSha });
    for (const file of merged.files) files.add(file);
    tip = merged.mergeSha;
  }
  const works = batch.map(entry => entry.work);
  if (batch.length < 2) return [...results, ...await alone(ports, works)];
  try {
    // Publish every in-flight head before awaiting the trial, as mergeOne does.
    for (const { work, head, baseTip: parent, mergeSha } of batch)
      await ports.record(work, { kind: 'intent', head, baseTip: parent, mergeSha, risk: riskOf(work).risk, at: at() });
    // A batch trial that times out is trialled one head at a time, so a timeout counts only on the head it is its own (GY-2079).
    const run = await ports.trial(tip, [...files], { key: works[0]!.key, criteria: works.flatMap(work => work.criteria) }, baseTip, ports.onStep, undefined, batch.map(({ work, head }) => ({ key: work.key, head }))).catch(error => { if (error instanceof TrialTimeoutError) return null; throw error; });
    if (!run) return [...results, ...await alone(ports, works)];
    const again = async () => [...results, ...await (retrial < ports.retrials ? mergeBatch(ports, works, retrial + 1) : alone(ports, works))];
    if (ports.lands && !await ports.lands(baseTip)) return again();
    const proofFailure = works.some(work => requiredProofFailure(work, run));
    let failed = proofFailure || failureIsBase(run) || !!trialFailureReason({ run }), preview: PreviewVerdict | null = null;
    // A preview that could not run is no pass: each head is then previewed alone, as `mergeOne` previews it.
    if (!failed && ports.preview) preview = await ports.preview(tip, [...files], works[0]!).catch(() => { failed = true; return null; });
    if (!proofFailure && (failed || previewFailureReason(preview, trialFailurePrefix))) return [...results, ...await alone(ports, works)];
    for (const work of works) if (ports.hold && await ports.hold(work)) return [...results, ...await alone(ports, works)];
    const flaked = run.flaked ? trialFlaked(run.flaked, at()) : null;
    for (const [index, { work, head, baseTip: parent }] of batch.entries()) {
      // Every head's proofs (unit, integration and the bound e2e cases) were counted on the batch's one trial; each head's record carries only the runs of its own e2e cases.
      const own = e2eProofsOf(work), e2e = run.e2e?.filter(entry => own.includes(entry.proof)) ?? [];
      const proofs = Object.fromEntries([...criterionProofs(work), ...own].filter(proof => run.proofs[proof]).map(proof => [proof, run.proofs[proof]!]));
      await ports.record(work, { kind: 'trial', head, baseTip: parent, mergeSha: tip, outcome: 'verdict', build: run.build, tests: recordedTests(run.tests), files: run.files, proofs, durationMs: run.durationMs,
        ...(run.phases ? { phases: run.phases } : {}), attempts: run.retried ?? [], ...(e2e.length ? { e2e } : {}), ...(preview ? { preview } : {}), ...(flaked && index === 0 ? { flaked } : {}) });
    }
    // Retain the real batch counts before individual trials identify the head needing rework.
    if (proofFailure) return [...results, ...await alone(ports, works)];
    let obsolete = false;
    for (const { work, head } of batch) {
      const held = ports.hold ? await ports.hold(work) : null;
      if (held) { await ports.record(work, { kind: 'refused', head, reason: held }); obsolete = true; }
    }
    if (obsolete) return [...results, ...await alone(ports, works)];
    if (await ports.push(tip, baseTip) !== 'pushed') return again();
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

/**
 * Stacked parallel trials: the positions, in queue order, each one batch (`mergeBatch`), all
 * trialled at once — each on the tip the positions before it would leave, so the second trials on
 * the first's merge commit and the third on the second's — with the host's cores shared among
 * them. A position's verdict counts only once every position before it has finished, and only
 * when they left the base at the tip it was trialled on (`lands`): a trial stacked on a position
 * that did not land is discarded and trialled again on the tip as it now stands, so a failure
 * re-trials only the positions stacked on it, and the positions push strictly in queue order.
 * `onStep` names each position's trial step.
 */
export async function mergeStack(ports: MergePorts, positions: readonly (readonly Work[])[], onStep?: (position: number, step: string) => void): Promise<BatchResult[]> {
  const done = positions.map(() => false), offered: (string | null)[] = positions.map(() => null);
  let landed: string | null = null, wake = () => {}, moved = new Promise<void>(resolve => { wake = resolve; });
  const notify = () => { const woken = wake; moved = new Promise(resolve => { wake = resolve; }); woken(); };
  const until = async <T>(read: () => T | null): Promise<T> => { for (;;) { const value = read(); if (value !== null) return value; await moved; } };
  // The tip a position stands on: the commit the nearest unfinished position before it is trialling, or the remote's once every one has finished.
  const standing = (index: number) => { for (let before = index - 1; before >= 0; before--) if (!done[before]) return offered[before]; return 'remote'; };
  const offer = (index: number, sha: string | null) => { offered[index] = sha; notify(); };
  const portsOf = (index: number): MergePorts => ({
    ...ports,
    fetch: async () => { const tip = await until(() => standing(index)); return tip === 'remote' ? landed = await ports.fetch() : tip; },
    trial: async (mergeSha, files, item, baseTip, step, timing, heads) => {
      offer(index, mergeSha);
      try { return await ports.trial(mergeSha, files, item, baseTip, step, timing, heads, positions.length); } finally { offer(index, null); }
    },
    lands: async baseTip => { await until(() => done.slice(0, index).every(Boolean) || null); return baseTip === landed; },
    push: async (mergeSha, baseTip) => {
      const pushed = await ports.push(mergeSha, baseTip);
      if (pushed === 'pushed') landed = mergeSha;
      return pushed;
    },
    ...(onStep ? { onStep: (step: string) => onStep(index, step) } : {}),
  });
  const settled = await Promise.all(positions.map(async (items, index) => {
    try { return await mergeBatch(portsOf(index), items); }
    catch (error) { return items.map((work): BatchResult => ({ work, error })); }
    finally { done[index] = true; notify(); }
  }));
  return settled.flat();
}
