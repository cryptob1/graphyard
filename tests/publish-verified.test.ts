import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publishVerified } from '../src/publish-verified.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3214: each commit Graphyard's batch gate verifies is published as two images and the npm
// package `@cryptob1/graphyard` in Actions or local registry tests.

const identity = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = identity) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();

/** A checkout holding a launcher and a private package.json, committed late on 9 November in a zone west of UTC. */
async function checkout() {
  const root = await temporaryDirectory('publish-verified');
  git(root, ['init', '-q', '-b', 'main']);
  await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'bin', 'graphyard.mjs'), '#!/usr/bin/env node\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@cryptob1/graphyard', version: '0.1.0', private: true, type: 'module', description: 'd', license: 'Apache-2.0', bin: { graphyard: './bin/graphyard.mjs' }, dependencies: { zod: '4.4.3' } }));
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'base'], { ...identity, GIT_COMMITTER_DATE: '2026-11-09T23:30:00-05:00' });
  return { root, commit: git(root, ['rev-parse', 'HEAD']) };
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
  const { root, commit } = await checkout(), { run, calls, published } = stubs();
  const outcome = await publishVerified(commit, { root, run, env: { NPM_TOKEN: 'npm-secret', GITHUB_TOKEN: 'ghcr-secret' } });
  const short = commit.slice(0, 12), version = `2026.11.10-${short}`;
  assert.deepEqual(outcome, { version, images: [`ghcr.io/cryptob1/graphyard:${commit}`, 'ghcr.io/cryptob1/graphyard:verified', `ghcr.io/cryptob1/graphyard-trial:${commit}`, 'ghcr.io/cryptob1/graphyard-trial:verified'] },
    'the version is the commit\'s UTC day and short sha; each image is tagged by the commit and as verified');
  const build = calls.find(call => call.startsWith('docker build '))!, trial = calls.find(call => call.startsWith('docker buildx build '))!;
  for (const [call, image] of [[build, 'graphyard'], [trial, 'graphyard-trial']] as const) {
    assert.match(call, new RegExp(`--build-arg GRAPHYARD_BUILD_SHA=${commit} `), `${image} is stamped with the commit`);
    assert.match(call, new RegExp(`--tag ghcr\\.io/cryptob1/${image}:${commit} --tag ghcr\\.io/cryptob1/${image}:verified `));
  }
  assert.match(trial, /--target trial .*--push /);
  assert.deepEqual(calls.filter(call => call.startsWith('docker image push ')), [`docker image push ghcr.io/cryptob1/graphyard:${commit}`, 'docker image push ghcr.io/cryptob1/graphyard:verified']);
  assert.ok(calls.includes(`docker image rm ghcr.io/cryptob1/graphyard:${commit} ghcr.io/cryptob1/graphyard:verified`), 'the pushed image does not pile up on the publishing host');
  assert.match(calls.find(call => call.startsWith('npm '))!, /^npm publish --tag latest /, 'latest moves to the published version');
  assert.equal(published.length, 1);
  const { manifest, npmrc } = published[0]!;
  assert.deepEqual({ name: manifest.name, version: manifest.version, graphyardCommit: manifest.graphyardCommit, graphyardUpstream: manifest.graphyardUpstream, private: manifest.private, dependencies: manifest.dependencies, bin: manifest.bin },
    { name: '@cryptob1/graphyard', version, graphyardCommit: commit, graphyardUpstream: 'https://github.com/cryptob1/graphyard', private: undefined, dependencies: undefined, bin: { graphyard: './bin/graphyard.mjs' } }, 'the package names the commit it fetches and installs nothing itself');
  assert.match(npmrc, /^\/\/registry\.npmjs\.org\/:_authToken=\$\{NPM_TOKEN\}$/m);
  assert.ok(!calls.some(call => /npm-secret|ghcr-secret/.test(call)), 'no token is a command argument');
  assert.match(calls[0]!, /printf %s "\$GITHUB_TOKEN".*docker login .*--password-stdin/, 'docker reads the environment token on stdin');
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).private, true, 'the checkout itself is not modified');
  assert.equal(git(root, ['status', '--porcelain']), '');

  // Another registry (a mirror, or a test's local one) is named by the environment.
  const mirror = stubs();
  const mirrored = await publishVerified(commit, { root, run: mirror.run, env: { NPM_TOKEN: 'npm-secret', GRAPHYARD_IMAGE_REGISTRY: '127.0.0.1:5000/mirror', npm_config_registry: 'http://127.0.0.1:4873/' } }) as { images: string[] };
  assert.equal(mirrored.images[0], `127.0.0.1:5000/mirror/graphyard:${commit}`);
  assert.match(mirror.published[0]!.npmrc, /^registry=http:\/\/127\.0\.0\.1:4873\/\n\/\/127\.0\.0\.1:4873\/:_authToken=\$\{NPM_TOKEN\}$/m);
});

test('unit:tests/publish-verified.test.ts — Actions publishes with provenance and OIDC without any npm token', async () => {
  const { root, commit } = await checkout(), { run, calls, published } = stubs();
  await publishVerified(commit, { root, run, env: { GITHUB_TOKEN: 'actions-token' }, provenance: true });
  assert.match(calls.find(call => call.startsWith('npm '))!, /^npm publish --provenance --tag latest --access public /);
  assert.equal(published[0]!.npmrc, 'registry=https://registry.npmjs.org/\n');
  assert.ok(!calls.some(call => call.includes('--builder')), 'a fresh Actions runner uses its selected buildx builder');
});

test('unit:tests/publish-verified.test.ts — a failed push or publish rejects, so Actions reports the failed release', async () => {
  const { root, commit } = await checkout();
  for (const step of ['docker image push', 'npm publish']) await assert.rejects(publishVerified(commit, { root, run: stubs(step).run, env: { NPM_TOKEN: 'npm-secret', GITHUB_TOKEN: 'ghcr-secret' } }), new RegExp(`${step} failed`));
});
