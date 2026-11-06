import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultChildRun } from '../src/child-runner.js';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { mergeOne, type MergePorts } from '../src/merge-writer/executor.js';
import { masterConfigSchema } from '../src/master.js';
import { masterGuide } from '../src/master/guide.js';
import { trialFailurePrefix } from '../src/model/rework-ground.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3168: a feature's head adds or changes an e2e case its criteria name, read from real git
// merges through the production merge port; the trial itself is stood in for as passing.

const identity = { GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com', GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy' } } });
const delivered = 'e2e/cases/delivered.json', other = 'e2e/cases/other.json';

/** Merges a head onto a base holding two delivered cases, `change` being the head's own commit. */
async function merge(type: Work['type'], proofs: string[], change: (root: string, write: (path: string) => void) => void) {
  const root = await temporaryDirectory('feature-case-repo', tmpdir());
  const write = (path: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), `${path}\n${Math.random()}\n`); };
  gitIn(root, 'init', '-q', '-b', 'main');
  [delivered, other].forEach(write);
  gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', 'base');
  const base = gitIn(root, 'rev-parse', 'HEAD');
  gitIn(root, 'checkout', '-q', '--detach');
  write('src/app.ts');
  change(root, write);
  gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', 'head');
  const head = gitIn(root, 'rev-parse', 'HEAD');
  gitIn(root, 'checkout', '-q', 'main');
  const reads = mergeWriterReads(config, root, (command, args, options) => defaultChildRun(command, args, { ...options, env: { ...process.env, ...identity, ...options?.env } }), { base: await temporaryDirectory('feature-case-trials', tmpdir()), record: async () => {}, environment: { PATH: process.env.PATH! } });
  const passing = Object.fromEntries(proofs.map(proof => [proof, { executed: 1, failed: 0 }]));
  const ports: MergePorts = { baseBranch: 'main', now: () => Date.parse('2030-01-01T00:00:00Z'), fetch: async () => base, merge: reads.merge,
    trial: async () => ({ build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: passing }),
    push: async () => 'pushed', holds: async () => false, record: async () => {} };
  return mergeOne(ports, { id: 'w-3168', key: 'GY-3168', type, title: 'grow', candidate: { sha: head, baseSha: base, pr: 1, branch: 'graphyard/gy-3168-1', author: 'worker' },
    submission: { epoch: 1, pr: 1 }, criteria: [{ id: 'AC-1', text: 'it grows', proofs }] } as unknown as Work);
}

const refusal = (...proofs: string[]) => `${trialFailurePrefix}: ${proofs.join(', ')}: a feature's head must add or change one of their cases under e2e/cases/`;
const named = ['e2e:delivered', 'e2e:added'];

test('unit:tests/feature-adds-e2e-case.test.ts — a feature head that leaves every case it names untouched is refused naming its e2e proofs, even when it changes a case it does not name', async () => {
  const outcome = await merge('feature', named, (_root, write) => write(other));
  assert.equal(outcome.outcome, 'refused', JSON.stringify(outcome));
  assert.equal((outcome as { reason: string }).reason, refusal(...named));
});

test('unit:tests/feature-adds-e2e-case.test.ts — a head that deletes a bound case, or renames it away, is refused: neither adds nor modifies it', async () => {
  const deleted = await merge('feature', ['e2e:delivered'], root => rmSync(join(root, delivered)));
  assert.equal((deleted as { reason: string }).reason, refusal('e2e:delivered'));
  const renamed = await merge('feature', ['e2e:delivered'], root => gitIn(root, 'mv', delivered, 'e2e/cases/moved.json'));
  assert.equal((renamed as { reason: string }).reason, refusal('e2e:delivered'));
});

test('unit:tests/feature-adds-e2e-case.test.ts — a feature head that adds or modifies one case it names merges', async () => {
  const added = await merge('feature', named, (_root, write) => write('e2e/cases/added.json'));
  assert.equal(added.outcome, 'merged', JSON.stringify(added));
  const modified = await merge('feature', named, (_root, write) => write(delivered));
  assert.equal(modified.outcome, 'merged', JSON.stringify(modified));
});

test('unit:tests/feature-adds-e2e-case.test.ts — a bug or chore reusing a case unchanged merges, and so does a legacy feature naming no e2e proof', async () => {
  for (const type of ['bug', 'chore'] as const) {
    const outcome = await merge(type, named, () => {});
    assert.equal(outcome.outcome, 'merged', JSON.stringify(outcome));
  }
  const legacy = await merge('feature', ['unit:tests/legacy.test.ts'], () => {});
  assert.equal(legacy.outcome, 'merged', JSON.stringify(legacy));
});

test('unit:tests/feature-adds-e2e-case.test.ts — the master guide\'s e2e paragraph states the feature rule and who may reuse a delivered case', () => {
  const paragraph = masterGuide.split('\n').find(line => line.startsWith('Every item needs an'))!;
  assert.match(paragraph, /A feature's head must add or change one of its bound cases/);
  assert.match(paragraph, /reusing a delivered case unchanged is only for bugs, chores and loop repairs/);
});
