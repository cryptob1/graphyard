// Concern: GY-3159 — the detached merge trial's own entry point. The loop launches this module as a
// run that survives its restart (trial-run.ts `launchTrialRun`): it runs the merge trial exactly as
// the loop's own `trial` port would, records each step as it reaches it, and writes the verdict —
// or the trial's own failure — to the run's directory, where whichever loop watches the run reads
// it. It holds no credential the loop did not already pass every trial child.
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun } from '../child-runner.js';
import { proofTestFiles, runMergeTrial } from './executor.js';
import { serializeTrialError, trialRunFiles, type TrialRunSpec } from './trial-run.js';

const directory = process.argv[2];
if (!directory) throw new Error('the detached trial run names no directory');
const spec: TrialRunSpec = JSON.parse(await readFile(join(directory, 'spec.json'), 'utf8'));
const files = trialRunFiles(directory);
const record = async (line: object) => { try { await appendFile(files.steps, `${JSON.stringify(line)}\n`); } catch { /* a step that cannot be recorded never stops the trial */ } };

try {
  const run = await runMergeTrial({
    root: spec.root, base: spec.base, mergeSha: spec.mergeSha, changedFiles: spec.changedFiles,
    proofs: spec.proofs, e2eProofs: spec.e2eProofs, proofFiles: [],
    discoverProofFiles: options => proofTestFiles(defaultChildRun, spec.root, spec.mergeSha, spec.proofs, options),
    timeoutMs: spec.timeoutMs, key: spec.key, ...(spec.bug ? { bug: true } : {}), hidden: spec.hidden,
    ...(spec.baseTip ? { baseTip: spec.baseTip } : {}), ...(spec.cores ? { cores: spec.cores } : {}),
    onStep: step => void record({ step, at: new Date().toISOString() }),
    onTiming: (step, durationMs) => void record({ timing: step, durationMs }),
    environment: process.env,
  });
  await writeFile(`${files.result}.tmp`, `${JSON.stringify({ ok: true, run } as const)}\n`);
} catch (error) {
  // The trial's own failure is the run's outcome (GY-1832): every attempt it made travels with it.
  const { trialAttempts } = await import('./trial.js');
  await writeFile(`${files.result}.tmp`, `${JSON.stringify({ ok: false, error: serializeTrialError(error, trialAttempts(error)) } as const)}\n`);
}
await rename(`${files.result}.tmp`, files.result);
