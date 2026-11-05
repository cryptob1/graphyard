import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { mergeOne, mergeRecordKinds, type MergeRecordEvent, type MergeTrialInput } from '../src/merge-writer/executor.js';
import { foldMergeLedger } from '../src/model-boundary/merge-ledger.js';
import { defaultChildRun } from '../src/child-runner.js';
import { trialFailurePrefix } from '../src/model/rework-ground.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';

// GY-3120 AC-1: a head whose trial passed lands without another trial when main has moved. Against a
// real bare origin, main gains a commit while the head's trial runs; the leased push is rejected, the
// merge writer re-merges the same reviewed head onto the new tip (`Merge GY-N`, the head unchanged as
// its second parent) and pushes it. A conflict on the new tip returns the head for rework.

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function fixture(label: string) {
  const directory = await temporaryDirectory(label), origin = join(directory, 'origin.git'), checkout = join(directory, 'checkout'), other = join(directory, 'other');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  for (const path of [checkout, other]) {
    execFileSync('git', ['clone', '-q', origin, path], { stdio: 'ignore' });
    git(path, 'config', 'user.name', 'Fixture'); git(path, 'config', 'user.email', 'fixture@example.com');
  }
  await writeFile(join(checkout, 'shared.txt'), 'base\n');
  git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'base'); git(checkout, 'push', '-q', 'origin', 'main');
  const baseTip = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'checkout', '-qb', 'graphyard/gy-1-1');
  await writeFile(join(checkout, 'item.txt'), 'the item\n');
  git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'GY-1 change');
  const head = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'checkout', '-q', '--detach', baseTip);
  git(other, 'pull', '-q', 'origin', 'main');
  /** Another merge lands on main: `path` gains `content`. */
  const moveMain = async (path: string, content: string) => {
    await writeFile(join(other, path), content);
    git(other, 'add', '.'); git(other, 'commit', '-qm', `land ${path}`); git(other, 'push', '-q', 'origin', 'main');
    return git(other, 'rev-parse', 'HEAD');
  };
  const candidate = { sha: head, baseSha: baseTip, pr: 1, branch: 'graphyard/gy-1-1', author: 'worker' };
  const work = { id: 'w1', key: 'GY-1', title: 'The item', type: 'feature', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }], submission: { epoch: 1, pr: 1 }, candidate,
    observation: { source: 'control-plane', candidate, files: ['item.txt'], scopeFiles: [], checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, at: new Date().toISOString() },
    gates: [], policy: { checks: ['test'], review: true }, epoch: 1, policyRevision: 1, mergeLedger: null } as unknown as Work;
  const events: { kind: string; payload: unknown; work: string }[] = [], trials: MergeTrialInput[] = [];
  const config = masterConfigSchema.parse({ version: 1, repository: 'owner/project', baseBranch: 'main', url: 'https://graphyard.example', credentialFile: '/unused', cliPath: '/unused', githubAppId: 1, hostId: 'fixture', masterAgentName: 'fixture', workers: [], run: { mergeWriter: { deployKeyFile: join(directory, 'unused-key') } } });
  let duringTrial = async () => {};
  const reads = mergeWriterReads(config, checkout, defaultChildRun, { base: join(directory, 'managed'),
    trial: async input => {
      trials.push(input);
      await duringTrial();
      return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } };
    },
    record: async (item, event: MergeRecordEvent) => {
      const { kind, ...payload } = event;
      events.push({ kind: mergeRecordKinds[kind], work: item.key, payload: kind === 'intent' ? { ...payload, key: item.key } : kind === 'refused' ? { ...payload, kind: 'merge' } : payload });
    } });
  return { origin, head, baseTip, work, reads, events, trials, moveMain, setDuringTrial: (call: () => Promise<void>) => { duringTrial = call; } };
}

test('integration:affected-trial-merge-without-retrial — main moves during a passing trial: the same reviewed head is re-merged onto the new tip and pushed with no second trial', { timeout: 60_000 }, async () => {
  const f = await fixture('affected-trial-merge');
  let moved = '';
  f.setDuringTrial(async () => { moved = await f.moveMain('other.txt', 'another item\n'); });
  const outcome = await mergeOne(f.reads, f.work);
  assert.equal(outcome.outcome, 'merged', JSON.stringify(outcome));
  assert.equal(f.trials.length, 1, 'one trial, though main moved before the push');
  assert.deepEqual(f.trials[0]!.changedFiles, ['item.txt'], 'the trial selects tests from the head\'s own change (scripts/ci-tests.mjs affected), never the full suite');
  assert.deepEqual(f.trials[0]!.proofs, ['unit:item-works'], 'and runs the item\'s proofs beside them');
  const landed = git(f.origin, 'rev-parse', 'main');
  assert.equal(outcome.outcome === 'merged' && outcome.mergeSha, landed);
  assert.equal(outcome.outcome === 'merged' && outcome.baseTip, moved, 'the landing is leased on the moved tip');
  assert.deepEqual(git(f.origin, 'log', '-1', '--format=%P', landed).split(' '), [moved, f.head], 'a Merge GY-N commit onto the new tip whose second parent is the reviewed head, unchanged');
  assert.match(git(f.origin, 'log', '-1', '--format=%s', landed), /^Merge GY-1\b/);
  assert.deepEqual(f.events.map(event => event.kind), ['merge.intent', 'merge.trial', 'merge.intent', 'merge.pushed', 'merge.reconciled'], 'the re-merge records its intent before the push');
  const state = foldMergeLedger(f.events)['GY-1']!;
  assert.equal(state.state, 'reconciled');
  assert.equal(state.trial?.head, f.head, 'the passing trial stays bound to the head across its re-merge, so the item stays landable');
  assert.deepEqual(state.trial?.proofs['unit:item-works'], { executed: 1, failed: 0 });
});

test('integration:affected-trial-merge-without-retrial — a re-merge onto the moved tip that conflicts returns the head for rework and pushes nothing', { timeout: 60_000 }, async () => {
  const f = await fixture('affected-trial-conflict');
  let moved = '';
  f.setDuringTrial(async () => { moved = await f.moveMain('item.txt', 'a conflicting change\n'); });
  const outcome = await mergeOne(f.reads, f.work);
  assert.equal(outcome.outcome, 'refused');
  assert.ok(outcome.outcome === 'refused' && outcome.reason.startsWith(`${trialFailurePrefix}: the merge conflicts in item.txt`), JSON.stringify(outcome));
  assert.equal(f.trials.length, 1, 'no second trial');
  assert.equal(git(f.origin, 'rev-parse', 'main'), moved, 'main holds only the other landing');
  assert.equal(f.events.at(-1)?.kind, 'merge.refused');
});
