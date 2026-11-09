import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyDelivery, onboardingServe } from '../src/repository-setup.js';
import { runTrialE2eCases } from '../src/merge-writer/e2e-trial.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { daemonStatePath } from '../src/daemon/state.js';
import type { MasterConfig } from '../src/master.js';
import { freePort } from '../src/cli/test-isolation.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3208: onboarding's placeholder e2e.serve answers with graphyard.json, so a case run against it
// exercises nothing. The merge trial fails such a case naming the placeholder, and master status
// says the placeholder is in force; a declared real serve runs the same case, and it passes.

const sha = 'd'.repeat(40);
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

test('e2e:placeholder-serve-fails — a case against the placeholder serve fails naming it and master status shows it; a declared serve passes it', async () => {
  const root = await temporaryDirectory('placeholder-serve');
  git(root, 'init', '-q', '-b', 'main');
  const policy = { mode: 'local' as const, mergeGate: { preMerge: [], perCandidate: [] }, candidateSchedule: null, deploy: { adapter: 'command' as const, project: null, uat: null, production: null } };
  assert.equal((await applyDelivery(root, policy, 'node')).wroteServe, true);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'graphyard.json'), 'utf8')).e2e.serve, onboardingServe);
  // The application's own HTTP case: on the placeholder its 200 would pass without running the app.
  await mkdir(join(root, 'e2e/cases'), { recursive: true });
  await writeFile(join(root, 'e2e/cases/app-home.json'), JSON.stringify({ id: 'app-home', title: 'The app home answers', target: 'any', required: false,
    steps: [{ kind: 'http', name: 'the home answers', method: 'GET', path: '/', status: 200 }] }));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'onboarded');
  const credentials = await temporaryDirectory('placeholder-serve-credentials');
  const master = { url: 'http://127.0.0.1:5', repository: 'owner/fixture', credentialFile: join(credentials, 'coordinator.token'), hostId: 'test-host', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 } } as unknown as MasterConfig;
  await writeFile(daemonStatePath(master), JSON.stringify({ version: 1, url: master.url, repository: master.repository }));
  const status = () => masterStatusReport(root, master, async () => ({ work: [], now: new Date().toISOString() }), async () => `${sha}\n`);
  const run = () => runTrialE2eCases({ worktree: root, mergeSha: sha, proofs: ['e2e:app-home'], env: { PATH: process.env.PATH! }, scratch: root, budgetMs: 30_000, holds: async path => existsSync(join(root, path)), log: () => {} });

  const onPlaceholder = await run();
  assert.equal(onPlaceholder[0]?.failed, 1, JSON.stringify(onPlaceholder));
  assert.match(onPlaceholder[0]?.failingStep ?? '', /placeholder serve/);
  const line = (await status()).attention.find(entry => entry.subject === 'e2e.serve');
  assert.match(line?.text ?? '', /^Placeholder serve: /, 'master status shows the placeholder line');

  // The repository declares the serve that runs its application.
  const port = await freePort();
  const config = JSON.parse(await readFile(join(root, 'graphyard.json'), 'utf8'));
  config.e2e.serve = { command: `node -e "require('http').createServer((q,r)=>r.end('the app')).listen(${port},'127.0.0.1')"`, url: `http://127.0.0.1:${port}/`, readySeconds: 30 };
  await writeFile(join(root, 'graphyard.json'), JSON.stringify(config));
  const declared = await run();
  assert.deepEqual(declared.map(entry => ({ executed: entry.executed, failed: entry.failed })), [{ executed: 1, failed: 0 }], JSON.stringify(declared));
  assert.equal((await status()).attention.find(entry => entry.subject === 'e2e.serve'), undefined, 'the placeholder line is gone');
});
