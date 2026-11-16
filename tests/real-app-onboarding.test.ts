import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { onboardingServe } from '../src/model/onboarding-work.js';
import { checkServedApp, featureMapCaseId } from '../src/app-feature-check.js';
import { runTrialE2eCases } from '../src/merge-writer/e2e-trial.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { MasterConfig } from '../src/master.js';
import { batchGatePorts } from '../src/daemon/cycle-batch-gate.js';
import { gateChecks } from '../src/batch-gate.js';
import { freePort } from '../src/cli/test-isolation.js';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test' } }).trim();
test('integration:real-app-onboarding — main declares a real app and feature map; batch and deploy reach its features', async () => {
  const root = await temporaryDirectory('real-app-onboarding');
  git(root, 'init', '-q', '-b', 'main');
  const master = { url: 'http://127.0.0.1:5', repository: 'owner/Lumina', credentialFile: join(root, 'coordinator.token'), hostId: 'test', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 } } as unknown as MasterConfig;
  const status = () => masterStatusReport(root, master, async () => ({ work: [], now: new Date().toISOString() }), async (cmd, args) => cmd === 'git' ? git(root, ...args.slice(2)) : '');
  const save = async (config: object) => { await writeFile(join(root, 'graphyard.json'), JSON.stringify(config)); git(root, 'add', 'graphyard.json'); git(root, 'commit', '-qm', 'declaration'); };
  const batch = () => runTrialE2eCases({ worktree: root, mergeSha: git(root, 'rev-parse', 'HEAD'), proofs: [`e2e:${featureMapCaseId}`], env: { PATH: process.env.PATH! }, scratch: root, budgetMs: 30_000, holds: async () => false, log: () => {} });
  const features = [{ name: 'Application feature', url: '/feature', traps: ['The root is only a readiness page.'] }];
  const port = await freePort();
  const serve = { command: `node app.cjs`, url: `http://127.0.0.1:${port}/`, readySeconds: 10 };
  for (const config of [{}, { featureMap: features }, { e2e: { serve } }, { e2e: { serve: onboardingServe }, featureMap: features }]) {
    await save(config);
    assert.equal((await status()).serving.onboarding.onboarded, false);
    assert.match((await status()).attention.find(entry => entry.subject === 'e2e.serve')!.text, /Master fault: owner\/Lumina/);
    assert.equal((await batch())[0].failed, 1);
    assert.equal((await checkServedApp(root, serve.url, '')).verified, false);
  }
  await writeFile(join(root, 'app.cjs'), `require('http').createServer((q,r)=>{require('fs').appendFileSync('requests',q.url+'\\n'); r.statusCode=['/','/feature'].includes(q.url)?200:404;r.end('real feature')}).listen(${port},'127.0.0.1')`);
  await save({ e2e: { serve }, featureMap: features });
  const main = git(root, 'rev-parse', 'HEAD');
  const ports = batchGatePorts({ git: async (args: string[]) => git(root, ...args), now: Date.now } as never, []);
  for (const whole of [false, true]) assert.ok((await gateChecks(ports, { merges: [] }, main, [], whole)).includes(`e2e:${featureMapCaseId}`), 'every batch includes the real app map, even with no case catalog');
  // A dirty checkout cannot hide or introduce a main onboarding fault.
  await writeFile(join(root, 'graphyard.json'), JSON.stringify({ e2e: { serve: onboardingServe } }));
  assert.equal((await status()).serving.onboarding.onboarded, true);
  await writeFile(join(root, 'graphyard.json'), git(root, 'show', `${main}:graphyard.json`));
  const result = await batch();
  assert.deepEqual(result.map(({ executed, failed }) => ({ executed, failed })), [{ executed: 1, failed: 0 }], JSON.stringify(result));
  const { readFile } = await import('node:fs/promises');
  assert.match(await readFile(join(root, 'requests'), 'utf8'), /\/feature/);
  const requests: string[] = [];
  const app = createServer((request, response) => { requests.push(request.url!); response.end('real feature'); });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    assert.equal((await checkServedApp(root, url, '')).verified, true);
    assert.deepEqual(requests, ['/healthz', '/feature']);
  } finally { await new Promise<void>(resolve => app.close(() => resolve())); }
});

test('integration:real-app-onboarding — Graphyard maps its real dashboard and APIs', async () => {
  const { withDatabase } = await import('./helpers/postgres.js');
  const { Engine } = await import('../src/engine.js');
  const { server } = await import('../src/server.js');
  const { featureMapCase } = await import('../src/app-feature-check.js');
  const { runCases } = await import('../src/e2e/runner.js');
  const { parseRepositoryConfig } = await import('../src/model-boundary/documentation.js');
  const { readFile } = await import('node:fs/promises');
  assert.ok(parseRepositoryConfig(await readFile('graphyard.json', 'utf8')).featureMap?.length, 'the installer accepts the feature map');
  const store = await withDatabase('real_app_graphyard');
  await store.init();
  const http = server(new Engine(store, 120, 'cryptob1/graphyard'), [{ id: 'fixture-operator', role: 'admin', sessionKind: 'human', token: 'fixture-operator-token' }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  // The server serves the dashboard from ./dist; a trial that has not built it gets a stand-in page.
  const repo = process.cwd(), served = await temporaryDirectory('real-app-dist');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(served, 'dist'));
  await writeFile(join(served, 'dist', 'index.html'), '<!doctype html><title>Graphyard</title>');
  process.chdir(served);
  try {
    const mapped = featureMapCase(repo);
    assert.ok(mapped.definition.steps.length >= 5, 'the product features are mapped, not just readiness');
    const report = await runCases([mapped], { root: repo, url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, token: 'fixture-operator-token' });
    assert.equal(report.cases[0].verdict, 'passed', JSON.stringify(report.cases[0].failingStep));
  } finally { process.chdir(repo); await new Promise<void>(resolve => http.close(() => resolve())); }
});
