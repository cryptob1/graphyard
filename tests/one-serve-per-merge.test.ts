import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeOne, type MergePorts, type MergeRecordEvent, type MergeTrialRun } from '../src/merge-writer/executor.js';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { runTrialE2eCases } from '../src/merge-writer/e2e-trial.js';
import { defaultChildRun } from '../src/child-runner.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3032 AC-1: a merge serves and tests its head once. The trial serves the head from
// delivery.applications and runs its bound case; no per-merge preview serves it again, even where
// the loop's environment still names the retired GRAPHYARD_UAT_STATIC preview. Each serve of the
// static site runs its build, which appends one line to a counter outside the checkout.

const made: string[] = [];
after(async () => { for (const directory of made) await rm(directory, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('unit:one-serve-per-merge — one merge of a static-site head starts one serve: the trial\'s, whose bound case passes, and none after it', { timeout: 60_000 }, async () => {
  const root = await realpath(await temporaryDirectory('one-serve')); made.push(root);
  const repo = join(root, 'repo'), base = join(root, 'worktrees'), counter = join(root, 'serves');
  await mkdir(base);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 't@example.com'); git(repo, 'config', 'user.name', 'T');
  const build = `echo serve >> ${counter} && mkdir -p dist && cp -R site/. dist/`;
  const write = async (path: string, content: unknown) => { await mkdir(join(repo, path, '..'), { recursive: true }); await writeFile(join(repo, path), typeof content === 'string' ? content : JSON.stringify(content)); };
  await write('site/index.html', '<h1>Play</h1>');
  await write('graphyard.json', { delivery: { mode: 'local', applications: [{ id: 'site', kind: 'static', directory: 'dist', build }], cases: { home: 'site' } } });
  await write('e2e/cases/home.json', { id: 'home', title: 'The home page answers', tags: ['api'], target: 'any', required: false, steps: [{ kind: 'http', name: 'home', method: 'GET', path: '/', status: 200 }] });
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'site and its case');
  const mergeSha = git(repo, 'rev-parse', 'HEAD');

  // The trial: a checkout of the merge, its bound cases run against the head served there.
  const trial = async (input: { mergeSha: string; e2eProofs?: readonly string[] }): Promise<MergeTrialRun> => {
    const worktree = join(base, 'trial');
    git(repo, 'worktree', 'add', '-q', '--detach', worktree, input.mergeSha);
    const home = join(root, 'home');
    await mkdir(home, { recursive: true });
    try {
      const e2e = await runTrialE2eCases({ worktree, mergeSha: input.mergeSha, proofs: input.e2eProofs ?? [], env: { PATH: process.env.PATH!, HOME: home }, scratch: root, budgetMs: 30_000,
        holds: async path => existsSync(join(worktree, path)), log: () => {} });
      return { build: 'pass', tests: { passed: 0, failed: [], files: 0 }, durationMs: 1, logTail: '', files: [], e2e,
        proofs: Object.fromEntries(e2e.map(entry => [entry.proof, { executed: entry.executed, failed: entry.failed }])) } as unknown as MergeTrialRun;
    } finally { git(repo, 'worktree', 'remove', '--force', worktree); }
  };
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  const events: MergeRecordEvent[] = [];
  const reads = mergeWriterReads(config, repo, defaultChildRun, { base, record: async (_item, event) => { events.push(event); return {}; },
    environment: { PATH: process.env.PATH!, GRAPHYARD_UAT_STATIC: 'dist', GRAPHYARD_UAT_BUILD: build }, trial: trial as never });
  const tip = mergeSha;
  let landed = false;
  const ports: MergePorts = { ...reads, now: () => 1_893_456_000_000, fetch: async () => landed ? mergeSha : tip, merge: async () => ({ mergeSha, files: ['site/index.html', 'e2e/cases/home.json'], addedOrModified: ['e2e/cases/home.json'] }),
    push: async () => { landed = true; return 'pushed'; }, holds: async () => false };
  const work = {
    id: 'w1', key: 'GY-1', description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'The home page answers', proofs: ['e2e:home'] }],
    policy: { checks: ['test'], review: true }, revision: 1, policyRevision: 1, stage: 'build', ready: true, epoch: 1, lease: null, workspaces: [],
    submission: { epoch: 1, pr: 1 }, candidate: { sha: mergeSha, baseSha: tip, pr: 1, branch: 'graphyard/gy-1-1', author: 'worker' }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: null, blocker: null, violations: [], gates: [], mergeLedger: null,
  } as unknown as Work;

  const outcome = await mergeOne(ports, work);
  assert.equal(outcome.outcome, 'merged', JSON.stringify({ outcome, events }));
  const recorded = events.find(event => event.kind === 'trial') as { e2e?: { proof: string; executed: number; failed: number }[] };
  assert.deepEqual(recorded.e2e?.map(entry => [entry.proof, entry.executed, entry.failed]), [['e2e:home', 1, 0]], 'the trial served the head and its bound case passed');
  assert.deepEqual(readFileSync(counter, 'utf8').trim().split('\n'), ['serve'], 'one merge started one serve of its head');
});
