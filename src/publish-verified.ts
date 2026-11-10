// GY-3214: what Graphyard's own install publishes for each commit its batch gate verifies, so
// `npx graphyard up` works on a host that holds no checkout: the control-plane and trial images,
// by commit, and the npm package `graphyard` — the launcher alone, naming the commit it fetches.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildRun } from './child-runner.js';
import { trialBuilder } from './install/trial-image.js';
import { graphyardUpstreamUrl, publishedImages } from './release.js';

/** The operator's publishing credentials, each a 0600 file under the install directory. */
export const publishTokenFiles = (directory: string) => ({ npm: join(directory, 'npm-token'), ghcr: join(directory, 'ghcr-token') });

/** YYYY.M.D-<sha12>: the commit's own UTC commit day, so one commit is one version wherever and whenever it is published. */
export function publishedVersion(commit: string, committedAt: Date) {
  return `${committedAt.getUTCFullYear()}.${committedAt.getUTCMonth() + 1}.${committedAt.getUTCDate()}-${commit.slice(0, 12)}`;
}

/** The published package.json: the launcher and no dependency, since everything else is fetched from the upstream it names, at the commit it names. */
export function publishedPackage(source: Record<string, unknown>, commit: string, version: string) {
  return { name: source.name, version, description: source.description, license: source.license, type: source.type, bin: source.bin,
    graphyardCommit: commit, graphyardUpstream: graphyardUpstreamUrl, files: ['bin/graphyard.mjs', 'bin/bootstrap.mjs', 'bin/cli-release.mjs'], engines: { node: '>=24' },
    repository: { type: 'git', url: `git+${graphyardUpstreamUrl}.git` } };
}

/** An image reference without its tag (a registry host may carry a port). */
const repositoryOf = (image: string) => image.slice(0, image.lastIndexOf(':'));

export type PublishOutcome = { version: string; images: string[] } | { blocker: string };

/**
 * Builds and pushes both images at `commit` (also tagged `verified`) and publishes the npm package
 * as `latest`, from an export of the commit — the checkout at `root` is never modified. A missing
 * token publishes nothing and answers the blocker naming it; any failed command rejects.
 */
export async function publishVerified(commit: string, ports: { root: string; directory: string; run: ChildRun; env?: NodeJS.ProcessEnv }): Promise<PublishOutcome> {
  const files = publishTokenFiles(ports.directory), env = ports.env ?? process.env;
  const missing = [...(existsSync(files.npm) ? [] : [`an npm token that may publish the package graphyard, in ${files.npm}`]),
    ...(existsSync(files.ghcr) ? [] : [`a GitHub token with write:packages for ${repositoryOf(publishedImages(commit, env).server)}, in ${files.ghcr}`])];
  if (missing.length) return { blocker: `Publishing Graphyard for npx graphyard up needs ${missing.join(' and ')} (mode 0600); nothing is published until the operator stores ${missing.length > 1 ? 'them' : 'it'}.` };
  const run = (command: string, args: string[], cwd?: string) => Promise.resolve(ports.run(command, args, { timeoutMs: 1_800_000, env, ...(cwd ? { cwd } : {}) })).then(String);
  const scratch = await mkdtemp(join(tmpdir(), 'graphyard-publish-'));
  try {
    const tree = join(scratch, 'tree');
    await mkdir(tree);
    await run('git', ['-C', ports.root, 'archive', '--format=tar', `--output=${join(scratch, 'tree.tar')}`, commit]);
    await run('tar', ['-xmf', join(scratch, 'tree.tar'), '-C', tree]);
    const version = publishedVersion(commit, new Date(Number((await run('git', ['-C', ports.root, 'show', '-s', '--format=%ct', commit])).trim()) * 1000));

    const images = publishedImages(commit, env), tags = (image: string) => [image, `${repositoryOf(image)}:verified`];
    const registry = images.server.split('/')[0]!, owner = images.server.split('/')[1]!;
    // The token reaches docker on stdin, from its file: never an argument another process can read.
    await run('sh', ['-c', 'docker login "$0" --username "$1" --password-stdin < "$2"', registry, owner, files.ghcr]);
    const stamp = ['--build-arg', `GRAPHYARD_VERSION=unreleased ${commit.slice(0, 12)}`, '--build-arg', `GRAPHYARD_BUILD_REVISION=${commit}`, '--build-arg', `GRAPHYARD_BUILD_SHA=${commit}`];
    await run('docker', ['build', ...stamp, ...tags(images.server).flatMap(tag => ['--tag', tag]), tree]);
    for (const tag of tags(images.server)) await run('docker', ['image', 'push', tag]);
    // Pushed, the image needs no name on this host: none piles up here, one per verified commit.
    await run('docker', ['image', 'rm', ...tags(images.server)]);
    // The trial image is pushed straight from Graphyard's own builder, whose cache the loop prunes (GY-3188).
    await run('docker', ['buildx', 'build', '--builder', trialBuilder, '--target', 'trial', ...stamp, ...tags(images.trial).flatMap(tag => ['--tag', tag]), '--push', tree]);

    await writeFile(join(tree, 'package.json'), `${JSON.stringify(publishedPackage(JSON.parse(await readFile(join(tree, 'package.json'), 'utf8')), commit, version), null, 2)}\n`);
    const npmRegistry = new URL(env.npm_config_registry || 'https://registry.npmjs.org/');
    await writeFile(join(scratch, 'npmrc'), `registry=${npmRegistry.href}\n//${npmRegistry.host}${npmRegistry.pathname}:_authToken=${(await readFile(files.npm, 'utf8')).trim()}\n`, { mode: 0o600 });
    await run('npm', ['publish', '--tag', 'latest', '--access', 'public', '--userconfig', join(scratch, 'npmrc')], tree);
    return { version, images: [...tags(images.server), ...tags(images.trial)] };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
