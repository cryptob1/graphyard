// Concern: the loop's batch gate on main (GY-3119): one gate at a time beside the cycle, the
// scheduled diagnostics beside it, both over the merge writer's trial container and git.
import type { Work } from '../model.js';
import { bootstrapGate, gateRecordPath, readGateRecord, runDiagnostics, runGate, writeGateRecord, type GatePorts, type GateRecord } from '../batch-gate.js';
import { deployRecordPath, readDeployRecord } from '../deploy-watch.js';
import { relandItemFor, revertMergeCommit, serveLandings, serveRangeCommits, trialAndPushRevert } from '../merge-writer/serve-revert.js';
import type { MergeWriterReads } from './cycle-merge-writer.js';
import type { Cycle } from './cycle.js';
import { message, storeAction } from './state.js';

/** The gate's own item key in the trial (a proofless pseudo-item, like a revert's). */
const gateKey = 'batch-gate';
const lines = (out: string) => out.split('\n').map(line => line.trim()).filter(Boolean);

/** What one trial run of `checks` on `commit` failed, as gate check ids. */
async function trialChecks(reads: MergeWriterReads, commit: string, checks: readonly string[], files: readonly string[]): Promise<string[]> {
  const cases = checks.filter(check => check.startsWith('e2e:'));
  const tests = checks.includes('affected') ? files : checks.filter(check => check.startsWith('test:')).map(check => check.slice(5));
  const run = await reads.trial(commit, tests, { key: gateKey, criteria: cases.length ? [{ id: 'AC-1', text: 'The batch gate cases pass', proofs: cases }] as Work['criteria'] : [] });
  const failed = [...(run.build === 'fail' ? ['build'] : []),
    ...(run.e2e ?? []).filter(entry => entry.failed > 0 || entry.missing || entry.executed === 0).map(entry => entry.proof),
    ...run.tests.failed.map(file => `test:${file}`)];
  return failed.filter(check => checks.includes(check) || (check.startsWith('test:') && checks.includes('affected')));
}

/** The gate's ports over the merge writer's reads. */
export function batchGatePorts(reads: MergeWriterReads & { git: NonNullable<MergeWriterReads['git']> }, work: readonly Work[]): GatePorts & { diagnose(commit: string): Promise<{ failed: string[]; catalogMs: number }> } {
  const git = reads.git;
  const file = async (input: { title: string; description: string; key: string }) => {
    await reads.createWork?.({ title: input.title.slice(0, 200), type: 'bug', priority: 1, description: input.description, dependencies: [],
      criteria: [{ id: 'AC-1', text: `${input.title} is fixed at its cause, not skipped or weakened`.slice(0, 2000), proofs: ['manual:batch-gate-repaired', 'e2e:create-work-item'] }],
      reason: `Filed by the batch gate on ${reads.baseBranch}` }, input.key);
  };
  const catalog = async (commit: string) => lines(await git(['ls-tree', '--name-only', `${commit}:e2e/cases`])).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
  return {
    now: reads.now,
    fetch: reads.fetch,
    landings: async (from, to) => serveLandings(await serveRangeCommits(git, from, to), work),
    files: async (from, to) => lines(await git(['diff', '--name-only', from, to])),
    catalog,
    core: async commit => {
      try { return JSON.parse(await git(['show', `${commit}:graphyard.json`])).gate?.core ?? []; } catch { return []; }
    },
    run: (commit, checks, files) => trialChecks(reads, commit, checks, files),
    revert: async (landing, tip, check) => {
      const revert = await revertMergeCommit(git, { mergeSha: landing.sha, before: landing.before, baseTip: tip, subject: landing.subject });
      if ('conflict' in revert) return { held: `the revert of ${landing.item.key}'s merge ${landing.sha.slice(0, 12)} does not apply cleanly on ${tip.slice(0, 12)}: ${revert.conflict.slice(0, 20).join(', ')}` };
      const files = lines(await git(['diff', '--name-only', tip, revert.revertSha]));
      const pushed = await trialAndPushRevert(reads, { revertSha: revert.revertSha, files, baseTip: tip, culpritKey: landing.item.key, mergeSha: landing.sha });
      if ('held' in pushed) return { held: pushed.held };
      if ('retry' in pushed) return { held: pushed.retry };
      const failingCase = check.startsWith('e2e:') ? check.slice(4) : null;
      const reland = relandItemFor(landing.item, { serve: tip, failingCase: failingCase ?? check, failingStep: null, failingReason: `the batch gate's check ${check} failed`, mergeSha: landing.sha, baseBranch: reads.baseBranch });
      // A build or test failure names no case: the re-land carries the original criteria alone.
      await reads.createWork?.(failingCase ? reland : { ...reland, criteria: landing.item.criteria.map(({ id, text, proofs }) => ({ id, text, proofs: [...proofs] })) }, `gate-reland:${landing.sha}`).catch(() => null);
      return { revertSha: revert.revertSha };
    },
    file,
    // The full suite (a package.json change selects every test) and the whole catalog, each its own trial so the catalog's time is its own.
    diagnose: async commit => {
      const suite = await trialChecks(reads, commit, ['build', 'affected'], ['package.json']);
      const cases = (await catalog(commit)).map(id => `e2e:${id}`), started = reads.now();
      const failed = cases.length ? await trialChecks(reads, commit, cases, []) : [];
      return { failed: [...new Set([...suite, ...failed])], catalogMs: reads.now() - started };
    },
  };
}

const flights = new WeakMap<object, { gate: Promise<void> | null; diagnostics: Promise<void> | null }>();

/** The commit served at rollout, which becomes the first verified commit: the deploy record's when it names this repository, else main's tip. */
async function rolloutCommit(root: string, repository: string, reads: MergeWriterReads) {
  const deployed = readDeployRecord(deployRecordPath(root));
  return deployed?.tip && deployed.repository?.toLowerCase() === repository.toLowerCase() ? deployed.tip : (await reads.fetch()).toLowerCase();
}

/**
 * Cycle step beside the merge writer: with no gate in flight, one gate starts on main's tip beside
 * the cycle; the scheduled diagnostics run beside it when due. Neither blocks the cycle or a merge.
 */
export async function batchGateStep(cycle: Pick<Cycle, 'state' | 'effects' | 'snapshot' | 'performed' | 'now'>) {
  const reads = cycle.effects.mergeWriter, gate = reads?.gate;
  if (!reads?.git || !gate) return null;
  const file = gateRecordPath(gate.root);
  const live = flights.get(cycle.state) ?? { gate: null, diagnostics: null };
  flights.set(cycle.state, live);
  let record: GateRecord | null = readGateRecord(file);
  if (!record || record.repository?.toLowerCase() !== gate.repository.toLowerCase()) {
    record = bootstrapGate(gate.repository, await rolloutCommit(gate.root, gate.repository, reads));
    await writeGateRecord(file, record);
  }
  const ports = batchGatePorts({ ...reads, git: reads.git }, cycle.snapshot.work);
  const note = (key: string, state: 'done' | 'failed', detail: string) => cycle.performed.push(storeAction(cycle.state, key,
    { kind: 'merge', work: null, principal: null, state, detail: detail.slice(0, 1900), attempts: 1, epoch: null, cycle: cycle.state.cycle, at: new Date(cycle.now()).toISOString() }));
  if (!live.gate) {
    const current = record;
    live.gate = (async () => {
      try {
        const outcome = await runGate({ ...ports, started: () => writeGateRecord(file, current) }, current);
        // The diagnostics' fields are theirs: a gate's write keeps what they recorded meanwhile.
        const latest = readGateRecord(file);
        await writeGateRecord(file, { ...current, catalogMs: latest?.catalogMs ?? current.catalogMs, diagnosticsAt: latest?.diagnosticsAt ?? current.diagnosticsAt });
        if (outcome.outcome !== 'idle') note(`batch-gate:${outcome.tip}`, outcome.outcome === 'held' ? 'failed' : 'done', `Batch gate on ${outcome.tip.slice(0, 12)}: ${outcome.outcome}${'reason' in outcome ? `: ${outcome.reason}` : 'culprit' in outcome ? `: reverted ${outcome.culprit} for ${outcome.check}` : ''}`);
      } catch (error) { note('batch-gate', 'failed', `The batch gate failed and runs again next cycle: ${message(error)}`); }
      finally { live.gate = null; }
    })();
  }
  if (!live.diagnostics) {
    live.diagnostics = (async () => {
      try {
        const fresh = readGateRecord(file) ?? record;
        const failed = await runDiagnostics(ports, fresh);
        if (failed) {
          // Re-read so the diagnostics' fields never overwrite what a gate recorded meanwhile.
          const latest = readGateRecord(file) ?? fresh;
          await writeGateRecord(file, { ...latest, catalogMs: fresh.catalogMs, diagnosticsAt: fresh.diagnosticsAt });
          note('batch-gate:diagnostics', 'done', `Diagnostics on ${fresh.verified?.slice(0, 12)}: ${failed.length} failure(s) filed`);
        }
      } catch (error) { note('batch-gate:diagnostics', 'failed', `The diagnostics failed and run again next cycle: ${message(error)}`); }
      finally { live.diagnostics = null; }
    })();
  }
  return { gate: live.gate, diagnostics: live.diagnostics };
}
