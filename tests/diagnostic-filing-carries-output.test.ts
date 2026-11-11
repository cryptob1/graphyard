import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapGate, runDiagnostics } from '../src/batch-gate.js';
import { batchGatePorts } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { runTrialE2eGroup } from '../src/merge-writer/e2e-trial.js';
import { commandApplication } from '../src/merge-writer/serve-head.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3265: a diagnostic run on main whose e2e case fails at a named step files an item naming the
// case, the failing step and the last lines of that step's output; the trial record keeps none of it.

test('e2e:diagnostic-filing-carries-output — a fixture diagnostic run on main whose case fails at a named step files the case, the step and the last lines of its output (GY-3265)', async () => {
  const worktree = await temporaryDirectory('diagnostic-output');
  await mkdir(join(worktree, 'e2e/cases'), { recursive: true });
  await writeFile(join(worktree, 'e2e/cases/fixture-red.json'), JSON.stringify({
    id: 'fixture-red', title: 'A fixture case that fails', target: 'any', required: false,
    steps: [{ kind: 'command', name: 'solve the fixture', run: 'for i in $(seq 1 120); do echo "fixture line $i"; done; echo "expected 42, received 41"; exit 1', timeoutSeconds: 60 }],
  }));
  const target = commandApplication({ command: 'true', url: 'http://127.0.0.1:1', readySeconds: 1 });
  const filed: { key: string; description: string }[] = [];
  const reads = {
    baseBranch: 'main', now: Date.now, fetch: async () => 'a'.repeat(40),
    git: async (args: string[]) => args[0] === 'ls-tree' ? 'fixture-red.json' : '',
    trial: async (_commit: string, _files: readonly string[], item: { criteria: { proofs: string[] }[] }) => {
      const proofs = item.criteria.flatMap(criterion => criterion.proofs);
      const e2e = proofs.length ? await runTrialE2eGroup(target, proofs, { worktree, mergeSha: 'a'.repeat(40), proofs, env: { PATH: process.env.PATH ?? '' }, scratch: worktree,
        budgetMs: 60_000, holds: async () => true, log: () => {} }, 'http://127.0.0.1:1') : [];
      return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {}, e2e } as unknown as MergeTrialRun;
    },
    createWork: async (input: { description: string }, key: string) => { filed.push({ key, description: input.description }); return { key: 'GY-1' }; },
  } as unknown as MergeWriterReads;
  const record = bootstrapGate('owner/project', 'b'.repeat(40));
  assert.deepEqual(await runDiagnostics(batchGatePorts({ ...reads, git: reads.git! }, []), record), ['e2e:fixture-red']);
  const description = filed.find(entry => entry.key === 'diagnostic:e2e:fixture-red')?.description ?? '';
  assert.match(description, /failed e2e:fixture-red: step 1 solve the fixture: the command exited 1/, 'the case and its failing step');
  assert.match(description, /The last lines of its output:[\s\S]*fixture line 120\nexpected 42, received 41\n```$/, 'the step\'s last lines of output close the description');
  assert.doesNotMatch(description, /fixture line 10\n/, 'only the tail is kept');
});
