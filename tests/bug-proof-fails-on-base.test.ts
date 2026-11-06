import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { mergeOne, type MergePorts, type MergeRecordEvent } from '../src/merge-writer/executor.js';
import { masterGuide } from '../src/master/guide.js';
import { masterConfigSchema } from '../src/master.js';
import { trialFailurePrefix } from '../src/model/rework-ground.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2984, GY-3167: a feature or bug item's proofs run on the base tip in the merge writer's trial; one whose
// proofs all already pass there is refused as not reproduced. Chores are exempt.

const identity = { GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com', GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
const own = 'unit:tests/bug-proof-fails-on-base.test.ts';
const proof = 'unit:bug-proof-fails-on-base', e2eProof = 'e2e:home-shows-fix';
const servePort = 20000 + ((process.pid + 7) % 20_000);
const homeCase = { id: 'home-shows-fix', title: 'The home page shows the fix', target: 'any', required: false,
  steps: [{ kind: 'http', method: 'GET', path: '/', status: 200, expect: [{ path: 'message', equals: 'fixed' }] }] };
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy' } } });
const policy = { mode: 'local', mergeGate: { preMerge: [{ check: 'test', command: 'npm run test', source: 'script', reason: 'fixture' }], perCandidate: [] }, candidateSchedule: null, deploy: { adapter: 'command', project: null, uat: null, production: null } };

/** A repository whose test check prints the proof's case passing exactly when src/fixed exists; `fixedOnBase` puts the fix on the base, else the head adds it; `newProof` adds the proof file only on the head. */
async function repository(fixedOnBase: boolean, e2e = false, newProof = false) {
  const root = await temporaryDirectory('bug-proof-repo', tmpdir());
  const write = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  gitIn(root, 'init', '-q', '-b', 'main');
  write('package.json', JSON.stringify({ name: 'fixture', scripts: { build: 'true', test: 'node test.js' } }));
  write('graphyard.json', JSON.stringify({ delivery: policy, ...(e2e ? { e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'node serve.js', url: `http://127.0.0.1:${servePort}`, readySeconds: 10 } } } : {}) }));
  if (e2e) {
    write('serve.js', `require('node:http').createServer((q, r) => { r.writeHead(200, {'Content-Type':'application/json'}); r.end(JSON.stringify({ message: 'fixed' })); }).listen(${servePort}, '127.0.0.1');\n`);
    write('e2e/cases/home-shows-fix.json', JSON.stringify(homeCase));
  }
  write('test.js', `const ok = require('node:fs').existsSync('src/fixed');\nconsole.log((ok ? 'ok' : 'not ok') + ' 1 - ${proof} the fix holds');\nprocess.exit(ok ? 0 : 1);\n`);
  if (!newProof) write('tests/fix.test.ts', `// ${proof}\n`);
  if (fixedOnBase) write('src/fixed', '');
  gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', 'base');
  const base = gitIn(root, 'rev-parse', 'HEAD');
  gitIn(root, 'checkout', '-q', '--detach');
  write(fixedOnBase ? 'src/other' : 'src/fixed', '');
  if (newProof) write('tests/fix.test.ts', `// ${proof}\n`);
  gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', 'head');
  const head = gitIn(root, 'rev-parse', 'HEAD');
  gitIn(root, 'checkout', '-q', 'main');
  return { root, base, head };
}

// The test check runs for real in the trial checkout; npm's install and build are stood in for.
const run: ChildRun = async (command, args, options) => {
  if (command === 'git') return defaultChildRun(command, args, { ...options, env: { ...process.env, ...identity, ...options?.env } });
  if (command !== 'npm') return defaultChildRun(command, args, options);
  if (args[0] === 'run' && args[1] === 'test') {
    try { return await defaultChildRun('node', ['test.js'], options); }
    catch (error) { throw Object.assign(new Error('Command failed: npm run test'), { status: 1, signal: null, stdout: (error as { stdout?: string }).stdout ?? '', stderr: '' }); }
  }
  return '';
};

async function merge(repo: Awaited<ReturnType<typeof repository>>, type: Work['type'], proofs = [proof]) {
  const events: MergeRecordEvent[] = [];
  const reads = mergeWriterReads(config, repo.root, run, { base: await temporaryDirectory('bug-proof-trials', tmpdir()), record: async () => {},  environment: { PATH: process.env.PATH! } });
  const ports: MergePorts = { baseBranch: 'main', now: () => Date.parse('2030-01-01T00:00:00Z'), fetch: async () => repo.base, merge: reads.merge, trial: reads.trial,
    push: async () => 'pushed', holds: async () => false, record: async (_work, event) => { events.push(event); } };
  const work = { id: 'w-2984', key: 'GY-2984', type, title: 'fix', candidate: { sha: repo.head, baseSha: repo.base, pr: 1, branch: 'graphyard/gy-2984-1', author: 'worker' },
    submission: { epoch: 1, pr: 1 }, criteria: [{ id: 'AC-1', text: 'the bug is fixed', proofs }] } as unknown as Work;
  return { outcome: await mergeOne(ports, work), events };
}

test(`${own} — a bug or feature item whose proof passes on the base tip is refused as not reproduced naming the proof and the tip; a chore merges; one whose proof fails on the base and passes on the head merges`, { timeout: 300_000 }, async () => {
  const fixed = await repository(true);
  for (const type of ['bug', 'feature'] as const) {
    const refused = await merge(fixed, type);
    assert.equal(refused.outcome.outcome, 'refused', `${type}: ${JSON.stringify(refused.outcome)}`);
    assert.equal((refused.outcome as { reason: string }).reason, `${trialFailurePrefix}: not reproduced: ${proof} passes on the base tip ${fixed.base}`);
    assert.ok(refused.events.some(event => event.kind === 'refused'), 'the refusal is recorded, grounding the rework');
  }

  const chore = await merge(fixed, 'chore');
  assert.equal(chore.outcome.outcome, 'merged', JSON.stringify(chore.outcome));

  const broken = await repository(false);
  for (const type of ['bug', 'feature'] as const) {
    const fix = await merge(broken, type);
    assert.equal(fix.outcome.outcome, 'merged', `${type}: ${JSON.stringify(fix.outcome)}`);
    const trial = fix.events.find(event => event.kind === 'trial');
    assert.deepEqual(trial && 'proofs' in trial ? trial.proofs[proof] : null, { executed: 1, failed: 0 }, 'the head\'s own run counts the proof passing');
  }
});

test(`${own} — a feature whose proof file is new on the head merges even though the behaviour it checks already holds on the base`, { timeout: 300_000 }, async () => {
  const repo = await repository(true, false, true);
  const feature = await merge(repo, 'feature');
  assert.equal(feature.outcome.outcome, 'merged', JSON.stringify(feature.outcome));
});

test(`${own} — the master guide's e2e rule says a feature's or bug's proofs must include one failing on the base tip, else the trial refuses it as not reproduced, and chores are exempt`, () => {
  const paragraph = masterGuide.split('\n').find(line => line.startsWith('Every item needs an `e2e:NAME` criterion')) ?? '';
  assert.match(paragraph, /A feature's or bug's proofs must include one that fails on the base tip, or the merge trial refuses it as not reproduced; chores are exempt\./);
});

test(`${own} — a bug item whose unit proof and E2E proof both pass on the base tip is refused as not reproduced naming both: the bound case is served from the base too`, { timeout: 300_000 }, async () => {
  const fixed = await repository(true, true);
  const bug = await merge(fixed, 'bug', [proof, e2eProof]);
  assert.equal(bug.outcome.outcome, 'refused', JSON.stringify(bug.outcome));
  assert.equal((bug.outcome as { reason: string }).reason, `${trialFailurePrefix}: not reproduced: ${proof}, ${e2eProof} pass on the base tip ${fixed.base}`);
});
