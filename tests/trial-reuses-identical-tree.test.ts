import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { masterConfigSchema } from '../src/master.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const sha = (label: string) => label.padEnd(40, '0');
const work = (key: string, proofs: string[]) => ({ key, type: 'feature', criteria: [{ id: 'AC-1', text: 'works', proofs }] }) as unknown as Work;
const verdict = (failed: string[], proofs: string[]): MergeTrialRun => ({ build: 'pass', tests: { passed: 3, failed, files: 1 }, durationMs: 1, logTail: '', files: ['tests/a.test.ts'],
  proofs: Object.fromEntries(proofs.map(proof => [proof, { executed: 1, failed: failed.length ? 1 : 0 }])) });

test('integration:trial-reuses-identical-tree — the merge writer reuses its own pass on the same tree and proofs, never a failure', async () => {
  const base = await temporaryDirectory('trial-reuse');
  const trees: Record<string, string> = { [sha('a1')]: sha('ae'), [sha('a2')]: sha('ae'), [sha('b1')]: sha('be'), [sha('c1')]: sha('ce'), [sha('c2')]: sha('ce') };
  const run = async (_command: string, args: readonly string[]) => args[2] === 'rev-parse' ? `${trees[args[3].replace('^{tree}', '')]}\n` : '';
  const ran: string[] = [];
  let fail = false;
  // A fresh reads per call, as a restarted loop builds them: the passes are read back from the trial base.
  const reads = () => mergeWriterReads(config, '/repo', run, { base, record: async () => ({}),
    trial: async input => { ran.push(input.mergeSha); return verdict(fail ? ['tests/a.test.ts'] : [], [...input.proofs, ...(input.e2eProofs ?? [])]); } });
  const proofs = ['unit:alpha'];

  const first = await reads().trial(sha('a1'), [], work('GY-1', proofs), sha('f1'));
  assert.equal(first.reused, undefined);
  // A re-queue on a moved base that merges to the same tree: no second trial.
  const second = await reads().trial(sha('a2'), [], work('GY-1', proofs), sha('f2'));
  assert.deepEqual(ran, [sha('a1')], 'the identical tree was not trialled again');
  assert.deepEqual(second.reused, { mergeSha: sha('a1'), key: 'GY-1' });
  assert.equal(second.build, 'pass');

  // A different tree, or an extra proof on the same tree, runs the trial.
  await reads().trial(sha('b1'), [], work('GY-1', proofs), sha('f1'));
  const extra = await reads().trial(sha('a2'), [], work('GY-1', [...proofs, 'e2e:board']), sha('f1'));
  assert.equal(extra.reused, undefined);
  assert.deepEqual(ran, [sha('a1'), sha('b1'), sha('a2')]);

  // A failed trial is never reused.
  fail = true;
  await reads().trial(sha('c1'), [], work('GY-2', proofs), sha('f1'));
  const again = await reads().trial(sha('c2'), [], work('GY-2', proofs), sha('f1'));
  assert.equal(again.reused, undefined);
  assert.deepEqual(ran.slice(3), [sha('c1'), sha('c2')], 'the failed tree was trialled again');
});
