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
  const second = await reads().trial(sha('a2'), [], work('GY-1', proofs), sha('f1'));
  assert.deepEqual(ran, [sha('a1')], 'the identical tree was not trialled again');
  assert.deepEqual(second.reused, { mergeSha: sha('a1'), key: 'GY-1' });
  // The same tree on another base tip or with other changed files selects other affected tests: it runs.
  assert.equal((await reads().trial(sha('a3'), [], work('GY-1', proofs), sha('f2'))).reused, undefined);
  assert.equal((await reads().trial(sha('a4'), ['src/x.ts'], work('GY-1', proofs), sha('f1'))).reused, undefined);
  assert.equal(second.build, 'pass');

  // A different tree, or an extra proof on the same tree, runs the trial.
  await reads().trial(sha('b1'), [], work('GY-1', proofs), sha('f1'));
  const extra = await reads().trial(sha('a2'), [], work('GY-1', [...proofs, 'e2e:board']), sha('f1'));
  assert.equal(extra.reused, undefined);
  assert.deepEqual(ran, [sha('a1'), sha('a3'), sha('a4'), sha('b1'), sha('a2')]);

  // A failed trial is never reused.
  fail = true;
  await reads().trial(sha('c1'), [], work('GY-2', proofs), sha('f1'));
  const again = await reads().trial(sha('c2'), [], work('GY-2', proofs), sha('f1'));
  assert.equal(again.reused, undefined);
  assert.deepEqual(ran.slice(5), [sha('c1'), sha('c2')], 'the failed tree was trialled again');
});

test('integration:trial-reuses-identical-tree — passes finishing at once are all recorded', async () => {
  const base = await temporaryDirectory('trial-reuse-concurrent');
  const trees: Record<string, string> = { [sha('d1')]: sha('de'), [sha('e1')]: sha('ee'), [sha('d2')]: sha('de'), [sha('e2')]: sha('ee') };
  const run = async (_command: string, args: readonly string[]) => args[2] === 'rev-parse' ? `${trees[args[3].replace('^{tree}', '')]}\n` : '';
  const ran: string[] = [];
  // Both trials read the empty record before either finishes, as stacked parallel trials do.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reads = () => mergeWriterReads(config, '/repo', run, { base, record: async () => ({}),
    trial: async input => { ran.push(input.mergeSha); await gate; return verdict([], [...input.proofs]); } });
  const both = Promise.all([reads().trial(sha('d1'), [], work('GY-3', ['unit:a']), sha('f1'), undefined, 2), reads().trial(sha('e1'), [], work('GY-4', ['unit:a']), sha('f1'), undefined, 2)]);
  await new Promise(resolve => setTimeout(resolve, 10));
  release();
  await both;
  const d = await reads().trial(sha('d2'), [], work('GY-3', ['unit:a']), sha('f1'));
  const e = await reads().trial(sha('e2'), [], work('GY-4', ['unit:a']), sha('f1'));
  assert.deepEqual([d.reused?.key, e.reused?.key], ['GY-3', 'GY-4'], 'both concurrent passes were recorded');
  assert.deepEqual(ran, [sha('d1'), sha('e1')]);
});
