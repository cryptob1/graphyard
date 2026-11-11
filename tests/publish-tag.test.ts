import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gateRecordPath, readGateRecord } from '../src/batch-gate.js';
import { batchGateStep } from '../src/daemon/cycle-batch-gate.js';
import { mergeWriterReads, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { deployOnce, deployRecordPath, writeControlPlaneRecord, controlPlaneRecordPath } from '../src/deploy-watch.js';
import { masterStatusReport, npmPublishedVersion } from '../src/cli/master-status.js';
import type { MasterConfig } from '../src/master.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import type { Work } from '../src/model.js';
import { publishedVersion } from '../src/release.js';
import { graphyardRepository } from '../src/scenarios.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const identity = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: identity, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Graphyard's own coordinator checkout over a scratch origin, a trial that always passes, and `merge()` to land one more item on main. */
async function gateFixture(repository = graphyardRepository) {
  const base = await temporaryDirectory('publish-verified-gate');
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), coordinator = join(base, 'coordinator');
  git(base, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(base, ['clone', '-q', origin, pusher]);
  await mkdir(join(pusher, 'e2e', 'cases'), { recursive: true });
  await writeFile(join(pusher, 'graphyard.json'), JSON.stringify({ gate: { core: ['smoke'] } }));
  await writeFile(join(pusher, 'e2e', 'cases', 'smoke.json'), '{}');
  git(pusher, ['add', '.']); git(pusher, ['commit', '-q', '-m', 'base']); git(pusher, ['push', '-q', 'origin', 'HEAD:main']);
  git(base, ['clone', '-q', origin, coordinator]);
  const work: Work[] = [];
  const merge = async () => {
    const n = work.length + 1;
    git(pusher, ['checkout', '-q', '-b', `item-${n}`]);
    await writeFile(join(pusher, `f${n}.txt`), 'ok\n');
    git(pusher, ['add', '.']); git(pusher, ['commit', '-q', '-m', `change ${n}`]); git(pusher, ['checkout', '-q', 'main']);
    git(pusher, ['merge', '-q', '--no-ff', '-m', `Merge GY-${n}: change ${n}`, `item-${n}`]); git(pusher, ['push', '-q', 'origin', 'HEAD:main']);
    work.push({ id: `work-${n}`, key: `GY-${n}`, title: `change ${n}`, description: '', type: 'feature', priority: 2, criteria: [{ id: 'AC-1', text: 'works', proofs: ['e2e:smoke'] }], mergeLedger: null } as unknown as Work);
    return git(pusher, ['rev-parse', 'HEAD']);
  };
  const run = (...args: string[]) => git(coordinator, args);
  const calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const deployKey = join(base, 'deploy-key');
  const production = mergeWriterReads({ repository, baseBranch: 'main', run: { mergeWriter: { deployKeyFile: deployKey } } } as any, coordinator,
    (command, args, options) => {
      calls.push({ command, args, env: options?.env });
      assert.equal(command, 'git', 'the host may run only git, never npm or docker');
      return execFileSync(command, args, { encoding: 'utf8', env: options?.env ?? identity, stdio: ['ignore', 'pipe', 'pipe'] });
    }, { base, record: async () => undefined, environment: identity });
  const reads: MergeWriterReads = {
    baseBranch: 'main', now: Date.now,
    fetch: async () => { run('fetch', '-q', 'origin', 'main'); return run('rev-parse', 'origin/main'); },
    git: async args => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', env: identity }),
    merge: async () => { throw new Error('unused'); },
    trial: async (_commit, _files, item) => ({ build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {},
      e2e: item.criteria.flatMap(criterion => criterion.proofs).map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: 0 })) }) as unknown as MergeTrialRun,
    push: async () => 'pushed', holds: async () => true, record: async () => undefined, createWork: async () => null,
    gate: { root: coordinator, repository },
    pushReleaseTag: production.pushReleaseTag,
  };
  let state = emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as any), lines: string[] = [];
  const cycle = () => ({ state, effects: { mergeWriter: reads } as any, snapshot: { work, now: new Date().toISOString() } as any, now: Date.now, log: (line: string) => lines.push(line) });
  /** Run both gate flights to their end, then observe the persisted handoff on another cycle. */
  const gate = async () => {
    const first = await batchGateStep(cycle());
    await first!.gate; await first!.diagnostics;
    const next = await batchGateStep(cycle());
    await next!.gate; await next!.diagnostics;
  };
  const deploy = async (tip: string, extra = {}) => writeFile(deployRecordPath(coordinator), JSON.stringify({ repository, tip, failed: null, reason: null, at: new Date().toISOString(), ...extra }));
  const restart = () => { state = emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as any); };
  return { coordinator, origin, merge, gate, deploy, restart, calls, deployKey, lines };
}

test('unit:tests/publish-tag.test.ts — a verified deploy pushes exactly one version tag with the deploy key, including across restart', async () => {
  const f = await gateFixture();
  await f.gate();
  const commit = await f.merge(); await f.gate();
  assert.equal(readGateRecord(gateRecordPath(f.coordinator))!.verified, commit);
  const pushes = () => f.calls.filter(call => call.args.includes('push'));
  assert.equal(pushes().length, 0, 'verification alone must not publish');
  await f.deploy(commit, { reason: 'health failed; kept because schema changed' }); await f.gate();
  assert.equal(pushes().length, 0, 'a kept unhealthy deployment must not publish');
  await f.deploy(commit, { repository: 'owner/other' }); await f.gate();
  assert.equal(pushes().length, 0, 'another repository is not Graphyard deployment evidence');
  await f.deploy(commit); f.restart(); await f.gate();
  const tag = `v${publishedVersion(commit, new Date(Number(git(f.coordinator, ['show', '-s', '--format=%ct', commit])) * 1000))}`;
  assert.equal(pushes().length, 1);
  assert.deepEqual(pushes()[0]!.args, ['-C', f.coordinator, 'push', 'origin', `${commit}:refs/tags/${tag}`]);
  assert.match(pushes()[0]!.env!.GIT_SSH_COMMAND!, new RegExp(`ssh -i ${f.deployKey} `));
  assert.equal(pushes()[0]!.env!.GITHUB_TOKEN, undefined);
  assert.equal(git(f.origin, ['rev-parse', `refs/tags/${tag}`]), commit);
  assert.equal(readGateRecord(gateRecordPath(f.coordinator))!.releaseTagged, commit);
  for (let i = 0; i < 3; i++) { f.restart(); await f.gate(); }
  assert.equal(pushes().length, 1, 'the durable handoff prevents repeated pushes each cycle/restart');
  const next = await f.merge(); await f.gate();
  assert.equal(pushes().length, 1, 'a later verification still waits for deployment');
  await f.deploy(next); await f.gate();
  assert.equal(pushes().length, 2);
});

test('unit:tests/publish-tag.test.ts — a successful deploy remains eligible when verification advances before the loop observes it', async () => {
  const f = await gateFixture();
  await f.gate();
  const commit = await f.merge(); await f.gate();
  const steps: string[] = [];
  assert.equal(await deployOnce(deployRecordPath(f.coordinator), {
    fetch: async () => commit, head: async () => git(f.coordinator, ['rev-parse', 'HEAD']),
    build: async () => { steps.push('build'); }, restart: async () => { steps.push('restart'); },
    health: async () => { steps.push('health'); }, checkout: async () => { steps.push('checkout'); }, pin: async () => { steps.push('pin'); },
    prune: async () => {}, schema: async () => 1, database: async () => 1,
  }, () => {}, graphyardRepository), 'deployed');
  assert.deepEqual(steps, ['build', 'restart', 'health', 'checkout', 'pin']);
  // Simulate a gate that finished while deploy was completing and before its next observation.
  const later = await f.merge();
  const file = gateRecordPath(f.coordinator), record = readGateRecord(file)!;
  await writeFile(file, JSON.stringify({ ...record, verified: later }));
  f.restart(); await f.gate();
  const pushes = f.calls.filter(call => call.args.includes('push'));
  assert.equal(pushes.length, 1);
  assert.ok(pushes[0]!.args.at(-1)!.startsWith(`${commit}:refs/tags/v`));
});

test('unit:tests/publish-tag.test.ts — other installations never push Graphyard release tags', async () => {
  const f = await gateFixture('owner/project');
  await f.gate(); const commit = await f.merge(); await f.gate(); await f.deploy(commit); await f.gate();
  assert.equal(f.calls.filter(call => call.args.includes('push')).length, 0);
});

test('unit:tests/publish-tag.test.ts — the release workflow is tag-only, uses OIDC and runs the shared publisher without npm secrets', () => {
  const workflow = readFileSync('.github/workflows/publish.yml', 'utf8');
  assert.match(workflow, /on:\n  push:\n    tags: \['v\*'\]\npermissions:/);
  assert.doesNotMatch(workflow, /workflow_dispatch|pull_request|branches:|NPM_TOKEN|NODE_AUTH_TOKEN/);
  for (const permission of ['contents: read', 'id-token: write', 'packages: write']) assert.ok(workflow.includes(permission));
  assert.deepEqual([...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map(match => match[1]), ['GITHUB_TOKEN']);
  assert.match(workflow, /node-version: '24'/);
  assert.match(workflow, /npm install --global npm@11\.5\.2/);
  assert.match(workflow, /docker\/setup-buildx-action@/);
  assert.match(workflow, /node scripts\/build-publisher\.mjs/);
  assert.match(workflow, /node scripts\/publish-verified\.mjs --provenance/);
  assert.match(workflow, /GRAPHYARD_PUBLISH_COMMIT: \$\{\{ github.sha \}\}/);
  // Inspect every production source file, not just the former caller, for the retired token path.
  const files = execFileSync('git', ['ls-files', 'src'], { encoding: 'utf8' }).trim().split('\n');
  for (const file of files) assert.doesNotMatch(readFileSync(file, 'utf8'), /publishTokenFiles|npm-token|ghcr-token/, file);
  assert.doesNotMatch(readFileSync('src/daemon/cycle-merge-writer.ts', 'utf8'), /publishVerified/);
  assert.doesNotMatch(readFileSync('src/daemon/cycle-batch-gate.ts', 'utf8'), /publishVerified|Publishing Graphyard for npx/);
});

test('unit:tests/publish-tag.test.ts — status shows npm latest beside the control plane commit even when managing another repository', async () => {
  const root = await temporaryDirectory('publish-status'), commit = 'a'.repeat(40), version = '2026.11.10-aaaaaaaaaaaa';
  await writeControlPlaneRecord(controlPlaneRecordPath(root), { commit });
  const config = { url: 'http://127.0.0.1:5', repository: 'owner/project', credentialFile: join(root, 'credential'), hostId: 'test', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 } } as unknown as MasterConfig;
  const report = await masterStatusReport(root, config, async () => ({ work: [], now: new Date().toISOString() }), async (command, args) => {
    if (command === 'npm') { assert.deepEqual(args, ['view', '@cryptob1/graphyard', 'version', '--json', '--registry=https://registry.npmjs.org/']); return JSON.stringify(version); }
    return '';
  });
  assert.equal(report.controlPlaneUpdate!.commit, commit.slice(0, 12));
  assert.equal(report.controlPlaneUpdate!.publishedVersion, version);
  assert.equal(report.serving.commit, null, 'Graphyard release is not the managed project release');
  assert.equal(await npmPublishedVersion(async () => { throw new Error('E404'); }), 'not published');
  assert.equal(await npmPublishedVersion(async () => { throw new Error('offline'); }), 'unavailable');
});
