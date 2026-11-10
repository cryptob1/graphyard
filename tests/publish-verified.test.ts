import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gateRecordPath, readGateRecord } from '../src/batch-gate.js';
import { batchGateStep } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import type { Work } from '../src/model.js';
import { publishTokenFiles, publishVerified, type PublishOutcome } from '../src/publish-verified.js';
import { graphyardRepository } from '../src/scenarios.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3214: each commit Graphyard's batch gate verifies is published as two images and the npm
// package `graphyard`, from the operator's tokens; publishing never touches the verification.

const identity = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = identity) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();

/** A checkout holding a launcher and a private package.json, committed late on 9 November in a zone west of UTC. */
async function checkout() {
  const root = await temporaryDirectory('publish-verified'), directory = await temporaryDirectory('publish-verified-install');
  git(root, ['init', '-q', '-b', 'main']);
  await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'bin', 'graphyard.mjs'), '#!/usr/bin/env node\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'graphyard', version: '0.1.0', private: true, type: 'module', description: 'd', license: 'Apache-2.0', bin: { graphyard: './bin/graphyard.mjs' }, dependencies: { zod: '4.4.3' } }));
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'base'], { ...identity, GIT_COMMITTER_DATE: '2026-11-09T23:30:00-05:00' });
  const files = publishTokenFiles(directory);
  await writeFile(files.npm, 'npm-secret\n', { mode: 0o600 });
  await writeFile(files.ghcr, 'ghcr-secret\n', { mode: 0o600 });
  return { root, directory, commit: git(root, ['rev-parse', 'HEAD']), files };
}

/** docker and npm stubbed: every call is recorded, and `npm publish` reads what it would publish. */
function stubs(fail: string | null = null) {
  const calls: string[] = [], published: { manifest: any; npmrc: string }[] = [];
  const run = (command: string, args: string[], options?: { cwd?: string }) => {
    if (command === 'git' || command === 'tar') return execFileSync(command, args, { encoding: 'utf8' });
    calls.push([command, ...args].join(' '));
    if (fail && calls.at(-1)!.startsWith(fail)) throw new Error(`${fail} failed`);
    if (command === 'npm') published.push({ manifest: JSON.parse(readFileSync(join(options!.cwd!, 'package.json'), 'utf8')), npmrc: readFileSync(args[args.indexOf('--userconfig') + 1]!, 'utf8') });
    return '';
  };
  return { run, calls, published };
}

test('unit:tests/publish-verified.test.ts — a verified commit is pushed as both images by commit and as verified, stamped with the commit, and published to npm as YYYY.M.D-<sha> on latest', async () => {
  const { root, directory, commit } = await checkout(), { run, calls, published } = stubs();
  const outcome = await publishVerified(commit, { root, directory, run, env: {} });
  const short = commit.slice(0, 12), version = `2026.11.10-${short}`;
  assert.deepEqual(outcome, { version, images: [`ghcr.io/cryptob1/graphyard:${commit}`, 'ghcr.io/cryptob1/graphyard:verified', `ghcr.io/cryptob1/graphyard-trial:${commit}`, 'ghcr.io/cryptob1/graphyard-trial:verified'] },
    'the version is the commit\'s UTC day and short sha; each image is tagged by the commit and as verified');
  const build = calls.find(call => call.startsWith('docker build '))!, trial = calls.find(call => call.startsWith('docker buildx build '))!;
  for (const [call, image] of [[build, 'graphyard'], [trial, 'graphyard-trial']] as const) {
    assert.match(call, new RegExp(`--build-arg GRAPHYARD_BUILD_SHA=${commit} `), `${image} is stamped with the commit`);
    assert.match(call, new RegExp(`--tag ghcr\\.io/cryptob1/${image}:${commit} --tag ghcr\\.io/cryptob1/${image}:verified `));
  }
  assert.match(trial, /--target trial .*--push /);
  assert.deepEqual(calls.filter(call => call.startsWith('docker push ')), [`docker push ghcr.io/cryptob1/graphyard:${commit}`, 'docker push ghcr.io/cryptob1/graphyard:verified']);
  assert.ok(calls.includes(`docker image rm ghcr.io/cryptob1/graphyard:${commit}`), 'the pushed commit tag does not pile up on the publishing host');
  assert.match(calls.find(call => call.startsWith('npm '))!, /^npm publish --tag latest /, 'latest moves to the published version');
  assert.equal(published.length, 1);
  const { manifest, npmrc } = published[0]!;
  assert.deepEqual({ name: manifest.name, version: manifest.version, graphyardCommit: manifest.graphyardCommit, graphyardUpstream: manifest.graphyardUpstream, private: manifest.private, dependencies: manifest.dependencies, bin: manifest.bin },
    { name: 'graphyard', version, graphyardCommit: commit, graphyardUpstream: 'https://github.com/cryptob1/graphyard', private: undefined, dependencies: undefined, bin: { graphyard: './bin/graphyard.mjs' } }, 'the package names the commit it fetches and installs nothing itself');
  assert.match(npmrc, /^\/\/registry\.npmjs\.org\/:_authToken=npm-secret$/m);
  assert.ok(!calls.some(call => /npm-secret|ghcr-secret/.test(call)), 'no token is a command argument');
  assert.match(calls[0]!, /^sh -c docker login "\$0" .*--password-stdin < "\$2" ghcr\.io cryptob1 .*ghcr-token$/, 'docker logs in from the token file before anything is built');
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).private, true, 'the checkout itself is not modified');
  assert.equal(git(root, ['status', '--porcelain']), '');

  // Another registry (a mirror, or a test's local one) is named by the environment.
  const mirror = stubs();
  const mirrored = await publishVerified(commit, { root, directory, run: mirror.run, env: { GRAPHYARD_IMAGE_REGISTRY: '127.0.0.1:5000/mirror', npm_config_registry: 'http://127.0.0.1:4873/' } }) as { images: string[] };
  assert.equal(mirrored.images[0], `127.0.0.1:5000/mirror/graphyard:${commit}`);
  assert.match(mirror.published[0]!.npmrc, /^registry=http:\/\/127\.0\.0\.1:4873\/\n\/\/127\.0\.0\.1:4873\/:_authToken=npm-secret$/m);
});

test('unit:tests/publish-verified.test.ts — a missing token publishes nothing and names exactly the token that is needed', async () => {
  const { root, directory, commit, files } = await checkout();
  await rm(files.npm);
  const one = stubs(), outcome = await publishVerified(commit, { root, directory, run: one.run, env: {} });
  assert.ok('blocker' in outcome);
  assert.ok(outcome.blocker.includes(files.npm) && !outcome.blocker.includes(files.ghcr), outcome.blocker);
  assert.match(outcome.blocker, /an npm token that may publish the package graphyard/);
  assert.deepEqual(one.calls, [], 'nothing is built, pushed or published');
  await rm(files.ghcr);
  const both = await publishVerified(commit, { root, directory, run: stubs().run, env: {} }) as { blocker: string };
  assert.ok(both.blocker.includes(files.npm) && both.blocker.includes(files.ghcr), both.blocker);
  assert.match(both.blocker, /a GitHub token with write:packages for ghcr\.io\/cryptob1\/graphyard/);
});

test('unit:tests/publish-verified.test.ts — a failed push or publish rejects, so the gate logs it and the next verified commit publishes again', async () => {
  const { root, directory, commit } = await checkout();
  for (const step of ['docker push', 'npm publish']) await assert.rejects(publishVerified(commit, { root, directory, run: stubs(step).run, env: {} }), new RegExp(`${step} failed`));
});

/** Graphyard's own coordinator checkout over a scratch origin, a trial that always passes, and `merge()` to land one more item on main. */
async function gateFixture(publish: (commit: string) => Promise<PublishOutcome>, repository = graphyardRepository) {
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
  const reads: MergeWriterReads = {
    baseBranch: 'main', now: Date.now,
    fetch: async () => { run('fetch', '-q', 'origin', 'main'); return run('rev-parse', 'origin/main'); },
    git: async args => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', env: identity }),
    merge: async () => { throw new Error('unused'); },
    trial: async (_commit, _files, item) => ({ build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {},
      e2e: item.criteria.flatMap(criterion => criterion.proofs).map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: 0 })) }) as unknown as MergeTrialRun,
    push: async () => 'pushed', holds: async () => true, record: async () => undefined, createWork: async () => null,
    gate: { root: coordinator, repository },
    publishVerified: publish,
  };
  const state = emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as any), lines: string[] = [];
  const cycle = () => ({ state, effects: { mergeWriter: reads } as any, snapshot: { work, now: new Date().toISOString() } as any, now: Date.now, log: (line: string) => lines.push(line) });
  /** One gate to its end, then the publication it started (the following cycle sees it; that cycle's own gate finds nothing new). */
  const gate = async () => {
    await (await batchGateStep(cycle()))!.gate;
    const next = await batchGateStep(cycle());
    await next!.gate; await next!.publish;
  };
  return { coordinator, merge, gate, state, lines };
}

test('unit:tests/publish-verified.test.ts — the gate publishes each commit it verifies; a failure leaves the commit verified and the next one publishes; a missing token is recorded once', async () => {
  const asked: string[] = [];
  let answer: (commit: string) => PublishOutcome = () => ({ blocker: 'Publishing Graphyard for npx graphyard up needs an npm token' });
  const { coordinator, merge, gate, state, lines } = await gateFixture(async commit => { asked.push(commit); return answer(commit); });
  await gate(); // rollout: the served commit is the first verified one, and nothing new was verified
  assert.deepEqual(asked, []);

  // Two verified commits with the token missing: one blocker row, logged once.
  const first = await merge(); await gate();
  const second = await merge(); await gate();
  assert.deepEqual(asked, [first, second]);
  assert.equal(readGateRecord(gateRecordPath(coordinator))!.verified, second);
  assert.deepEqual(Object.values(state.actions).filter(action => action.kind === 'blocker').map(action => [action.state, action.detail]), [['failed', 'Publishing Graphyard for npx graphyard up needs an npm token']]);
  assert.equal(lines.filter(line => line.includes('needs an npm token')).length, 1, 'the missing token is recorded once, not per verified commit');

  // A failing publish never blocks or reverts the verification, and is logged.
  answer = () => { throw new Error('denied: push refused'); };
  const third = await merge(); await gate();
  assert.equal(readGateRecord(gateRecordPath(coordinator))!.verified, third, 'the commit stays verified');
  assert.equal(state.actions['publish-verified']!.state, 'failed');
  assert.ok(lines.some(line => line.includes(`Could not publish the verified commit ${third.slice(0, 12)}`) && line.includes('denied: push refused')));

  // The next verified commit publishes again, and the blocker row is gone once the tokens work.
  answer = commit => ({ version: `2026.11.10-${commit.slice(0, 12)}`, images: [`ghcr.io/cryptob1/graphyard:${commit}`] });
  const fourth = await merge(); await gate();
  assert.deepEqual(asked, [first, second, third, fourth]);
  assert.deepEqual([state.actions['publish-verified']!.state, state.actions['publish-verified:blocker']], ['done', undefined]);
  assert.ok(lines.some(line => line.includes(`Published graphyard@2026.11.10-${fourth.slice(0, 12)} as latest`)));
});

test('unit:tests/publish-verified.test.ts — an install gating another repository publishes nothing', async () => {
  const asked: string[] = [];
  const { coordinator, merge, gate } = await gateFixture(async commit => { asked.push(commit); return { blocker: 'unused' }; }, 'owner/project');
  await gate();
  const tip = await merge(); await gate();
  assert.equal(readGateRecord(gateRecordPath(coordinator))!.verified, tip);
  assert.deepEqual(asked, []);
});
