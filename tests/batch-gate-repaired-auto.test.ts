import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gateRecordPath, readGateRecord, writeGateRecord } from '../src/batch-gate.js';
import { batchGateStep, repairedProof } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { deployRecordPath } from '../src/deploy-watch.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3443: a verified batch gate records manual:batch-gate-repaired on every open item owing it,
// citing the verified tip, so no master attestation is waited on; a reverted or held gate records nothing.

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const repository = 'owner/project';

/** An origin whose main holds a verified base and two merges: GY-1's breaks its case, GY-2's is fine. */
async function fixture() {
  const base = await temporaryDirectory('batch-gate-repaired');
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), coordinator = join(base, 'coordinator');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, pusher);
  const write = async (files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) { await mkdir(join(pusher, name, '..'), { recursive: true }); await writeFile(join(pusher, name), text); }
    git(pusher, 'add', '.');
  };
  await write({ 'graphyard.json': '{}', 'e2e/cases/case-1.json': '{}', 'e2e/cases/case-2.json': '{}' });
  git(pusher, 'commit', '-q', '-m', 'base');
  git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  const verified = git(pusher, 'rev-parse', 'HEAD');
  for (const n of [1, 2]) {
    git(pusher, 'checkout', '-q', '-b', `item-${n}`);
    await write({ [`src/f${n}.ts`]: n === 1 ? 'broken\n' : 'ok\n' });
    git(pusher, 'commit', '-q', '-m', `change ${n}`);
    git(pusher, 'checkout', '-q', 'main');
    git(pusher, 'merge', '-q', '--no-ff', '-m', `Merge GY-${n}: change ${n}`, `item-${n}`);
  }
  git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  git(base, 'clone', '-q', origin, coordinator);
  await mkdir(join(coordinator, '.graphyard'), { recursive: true });
  await writeFile(deployRecordPath(coordinator), JSON.stringify({ tip: verified, failed: null, reason: null, at: new Date().toISOString(), repository }));
  return coordinator;
}

const merged = (n: number) => ({ id: `work-${n}`, key: `GY-${n}`, title: `change ${n}`, description: '', type: 'feature', stage: 'done', criteria: [{ id: 'AC-1', text: 'works', proofs: [`e2e:case-${n}`] }], mergeLedger: null }) as unknown as Work;
/** An open gate filing in acceptance: its candidate head owes the repaired proof. */
const filing = (key: string, proofs: string[], stage = 'acceptance') => ({ id: `work-${key}`, key, title: `Flaky check: ${key}`, description: '', type: 'bug', stage, policyRevision: 3,
  candidate: { sha: `${key.toLowerCase()}-head`, baseSha: 'base', pr: 1, branch: 'b', author: 'w' }, evidence: [], workspaces: [], lease: null,
  criteria: [{ id: 'AC-1', text: 'pinned', proofs: ['unit:x-pinned'] }, { id: 'AC-2', text: 'The batch gate passes again', proofs }] }) as unknown as Work;

test('integration:batch-gate-repaired-auto — after a batch gate verifies a tip, every open item owing manual:batch-gate-repaired gets trusted passing evidence for its candidate head citing that tip, once; a reverted or held gate records nothing', async () => {
  const coordinator = await fixture();
  const attested: { key: string; proof: string; sha: string; policyRevision: number; reason: string }[] = [];
  const work = [merged(1), merged(2), filing('GY-50', [repairedProof, 'e2e:create-work-item']), filing('GY-51', ['e2e:create-work-item']), filing('GY-52', [repairedProof], 'done')];
  const run = (...args: string[]) => git(coordinator, ...args);
  const reads: MergeWriterReads = {
    baseBranch: 'main', now: Date.now,
    fetch: async () => { run('fetch', '-q', 'origin', 'main'); return run('rev-parse', 'origin/main'); },
    git: async (args, extra) => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
    merge: async () => { throw new Error('unused'); },
    trial: async (commit, _files, trialItem) => {
      const proofs = trialItem.criteria.flatMap(criterion => criterion.proofs);
      const broken = run('ls-tree', '-r', '--name-only', commit, 'src').split('\n').filter(file => file && run('show', `${commit}:${file}`) === 'broken').map(file => `e2e:case-${/f(\d+)/.exec(file)![1]}`);
      return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {},
        e2e: proofs.map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: broken.includes(proof) ? 1 : 0 })) } as unknown as MergeTrialRun;
    },
    push: async (sha, baseTip) => { run('push', '-q', `--force-with-lease=main:${baseTip}`, 'origin', `${sha}:main`); return 'pushed'; },
    holds: async () => true,
    record: async () => undefined,
    createWork: async () => ({ key: 'GY-99' }),
    attest: async (item, proof, reason) => {
      attested.push({ key: item.key, proof, sha: item.candidate!.sha, policyRevision: item.policyRevision, reason });
      // The control plane records the trusted pass on the candidate, as the next snapshot shows it.
      item.evidence.push({ id: `e-${item.key}`, proof, sha: item.candidate!.sha, baseSha: item.candidate!.baseSha, policyRevision: item.policyRevision, trusted: true, result: 'pass', producer: 'graphyard-master-operator', executed: 1, skipped: 0 } as unknown as Work['evidence'][number]);
    },
    gate: { root: coordinator, repository },
  };
  const state = emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as never);
  const step = async () => {
    const flights = await batchGateStep({ state, effects: { mergeWriter: reads } as never, snapshot: { work, now: new Date().toISOString() } as never, now: Date.now, log: () => {} });
    await flights?.gate; await flights?.diagnostics;
  };

  // The first batch fails GY-1's case and reverts it: nothing is recorded, then or on the next cycle.
  await step();
  assert.equal(readGateRecord(gateRecordPath(coordinator))!.lastOutcome?.outcome, 'reverted');
  await step();
  const record = readGateRecord(gateRecordPath(coordinator))!;
  assert.equal(record.lastOutcome?.outcome, 'verified', 'the recut batch verifies');
  assert.equal(attested.length, 0, 'a reverted gate records nothing');

  // The cycle after the verified gate records the pass on the one open item owing it, citing the tip.
  await step();
  const tip = record.lastOutcome!.tip!;
  assert.deepEqual(attested.map(entry => [entry.key, entry.proof, entry.sha, entry.policyRevision]), [['GY-50', repairedProof, 'gy-50-head', 3]]);
  assert.match(attested[0]!.reason, new RegExp(`batch gate verified ${tip}`));

  // Recorded once per head: the next cycle finds current evidence and writes nothing.
  await step();
  assert.equal(attested.length, 1);

  // A new candidate head owes it again; a held last outcome records nothing for it.
  work[2]!.candidate = { ...work[2]!.candidate!, sha: 'gy-50-head-2' };
  await writeGateRecord(gateRecordPath(coordinator), { ...readGateRecord(gateRecordPath(coordinator))!, lastOutcome: { tip, outcome: 'held', reason: 'failing recut', finishedAt: new Date().toISOString() } });
  await step();
  assert.equal(attested.length, 1, 'a held gate records nothing');
});
