import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { gateFiledItem, pinningProof } from '../src/daemon/cycle-batch-gate.js';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { mergeOne, type MergePorts } from '../src/merge-writer/executor.js';
import { masterConfigSchema } from '../src/master.js';
import { trialFailurePrefix } from '../src/model/rework-ground.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3160: an item the batch gate files binds a pinning test named from its check, so its bug trial reproduces the defect on base.

test('unit:gate-filed-item-pins-cause — a flake, known red or diagnostic filing binds a pinning-test proof named from its check, and create-work-item in a separate criterion', () => {
  assert.equal(pinningProof('known-red:test:tests/board-queue.test.ts'), 'unit:board-queue-pinned');
  assert.equal(pinningProof('flake:e2e:sign-in'), 'unit:e2e-sign-in-pinned');
  assert.equal(pinningProof('diagnostic:build'), 'unit:build-pinned');
  const item = gateFiledItem({ key: 'flake:e2e:sign-in', title: 'Flaky check on main: e2e:sign-in', description: 'd' }, 'main');
  assert.equal(item.type, 'bug');
  assert.deepEqual(item.criteria.map(criterion => criterion.proofs), [['unit:e2e-sign-in-pinned'], ['manual:batch-gate-repaired', 'e2e:create-work-item']]);
});

const identity = { GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com', GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
const servePort = 20000 + ((process.pid + 11) % 20_000);
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy' } } });
const policy = { mode: 'local', mergeGate: { preMerge: [{ check: 'test', command: 'npm run test', source: 'script', reason: 'fixture' }], perCandidate: [] }, candidateSchedule: null, deploy: { adapter: 'command', project: null, uat: null, production: null } };
const filing = { key: 'known-red:test:tests/board.test.ts', title: 'Known red on main: test:tests/board.test.ts', description: 'The test fails on main.' };
const proof = pinningProof(filing.key);

/** A repository whose create-work-item case passes on any commit; the head fixes the defect and adds the pinning test. */
async function repository() {
  const root = await temporaryDirectory('gate-filed-repo', tmpdir());
  const write = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  gitIn(root, 'init', '-q', '-b', 'main');
  write('package.json', JSON.stringify({ name: 'fixture', scripts: { build: 'true', test: 'node test.js' } }));
  write('graphyard.json', JSON.stringify({ delivery: policy, e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'node serve.js', url: `http://127.0.0.1:${servePort}`, readySeconds: 10 } } }));
  write('serve.js', `require('node:http').createServer((q, r) => { r.writeHead(200, {'Content-Type':'application/json'}); r.end(JSON.stringify({ created: true })); }).listen(${servePort}, '127.0.0.1');\n`);
  write('e2e/cases/create-work-item.json', JSON.stringify({ id: 'create-work-item', title: 'Create a work item', target: 'any', required: false,
    steps: [{ kind: 'http', method: 'GET', path: '/', status: 200, expect: [{ path: 'created', equals: true }] }] }));
  write('test.js', `const fs = require('node:fs');\nif (fs.existsSync('tests/board.test.ts')) console.log((fs.existsSync('src/fixed') ? 'ok' : 'not ok') + ' 1 - ${proof} the board renders');\nelse console.log('ok 1 - other');\n`);
  gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', 'base');
  const base = gitIn(root, 'rev-parse', 'HEAD');
  gitIn(root, 'checkout', '-q', '--detach');
  write('src/fixed', '');
  write('tests/board.test.ts', `// ${proof}\n`);
  gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', 'head');
  const head = gitIn(root, 'rev-parse', 'HEAD');
  gitIn(root, 'checkout', '-q', 'main');
  return { root, base, head };
}

const run: ChildRun = async (command, args, options) => {
  if (command === 'git') return defaultChildRun(command, args, { ...options, env: { ...process.env, ...identity, ...options?.env } });
  if (command !== 'npm') return defaultChildRun(command, args, options);
  if (args[0] === 'run' && args[1] === 'test') {
    try { return await defaultChildRun('node', ['test.js'], options); }
    catch (error) { throw Object.assign(new Error('Command failed: npm run test'), { status: 1, signal: null, stdout: (error as { stdout?: string }).stdout ?? '', stderr: '' }); }
  }
  return '';
};

async function merge(repo: Awaited<ReturnType<typeof repository>>, criteria: Work['criteria']) {
  const reads = mergeWriterReads(config, repo.root, run, { base: await temporaryDirectory('gate-filed-trials', tmpdir()), record: async () => {}, environment: { PATH: process.env.PATH! } });
  const ports: MergePorts = { baseBranch: 'main', now: () => Date.parse('2030-01-01T00:00:00Z'), fetch: async () => repo.base, merge: reads.merge, trial: reads.trial,
    push: async () => 'pushed', holds: async () => false, record: async () => {} };
  const work = { id: 'w-3160', key: 'GY-3160', type: 'bug', title: filing.title, candidate: { sha: repo.head, baseSha: repo.base, pr: 1, branch: 'graphyard/gy-3160-1', author: 'worker' },
    submission: { epoch: 1, pr: 1 }, criteria } as unknown as Work;
  return mergeOne(ports, work);
}

test('e2e:pipeline-gate-filed-item-merges — a gate-filed item whose head adds its pinning test merges; bound to create-work-item alone it was refused as not reproduced', { timeout: 300_000 }, async () => {
  const repo = await repository();
  const filed = await merge(repo, gateFiledItem(filing, 'main').criteria as Work['criteria']);
  assert.equal(filed.outcome, 'merged', JSON.stringify(filed));
  const old = await merge(repo, [{ id: 'AC-1', text: 'fixed', proofs: ['manual:batch-gate-repaired', 'e2e:create-work-item'] }] as Work['criteria']);
  assert.equal(old.outcome, 'refused', JSON.stringify(old));
  assert.match((old as { reason: string }).reason, new RegExp(`^${trialFailurePrefix}: not reproduced: e2e:create-work-item`));
});
