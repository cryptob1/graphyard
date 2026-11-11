// What the release workflow publishes for each verified and deployed commit, so
// `npx @cryptob1/graphyard up` works on a host that holds no checkout: the control-plane and trial images,
// by commit, and the npm package `@cryptob1/graphyard` — the launcher alone, naming the commit it fetches.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from './child-runner.js';
import { pathToFileURL } from 'node:url';
import { graphyardUpstreamUrl, publishedImages, publishedVersion } from './release.js';

export { publishedVersion } from './release.js';

/** The published package.json: the launcher and no dependency, since everything else is fetched from the upstream it names, at the commit it names. */
export function publishedPackage(source: Record<string, unknown>, commit: string, version: string) {
  return { name: source.name, version, description: source.description, license: source.license, type: source.type, bin: source.bin,
    graphyardCommit: commit, graphyardUpstream: graphyardUpstreamUrl, files: ['bin/graphyard.mjs', 'bin/bootstrap.mjs', 'bin/cli-release.mjs'], engines: { node: '>=24' },
    repository: { type: 'git', url: `git+${graphyardUpstreamUrl}.git` } };
}

/** An image reference without its tag (a registry host may carry a port). */
const repositoryOf = (image: string) => image.slice(0, image.lastIndexOf(':'));

/** Publishes an exported commit. Actions authenticates npm with OIDC; local registry tests supply NPM_TOKEN. */
export async function publishVerified(commit: string, ports: { root: string; run: ChildRun; env?: NodeJS.ProcessEnv; provenance?: boolean }) {
  const env = ports.env ?? process.env;
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
    // Docker receives the Actions token on stdin, never as a command argument.
    await run('sh', ['-c', 'printf %s "$GITHUB_TOKEN" | docker login "$0" --username "$1" --password-stdin', registry, env.GITHUB_ACTOR || owner]);
    const stamp = ['--build-arg', `GRAPHYARD_VERSION=unreleased ${commit.slice(0, 12)}`, '--build-arg', `GRAPHYARD_BUILD_REVISION=${commit}`, '--build-arg', `GRAPHYARD_BUILD_SHA=${commit}`];
    await run('docker', ['build', ...stamp, ...tags(images.server).flatMap(tag => ['--tag', tag]), tree]);
    for (const tag of tags(images.server)) await run('docker', ['image', 'push', tag]);
    // Pushed, the image needs no name on this host: none piles up here, one per verified commit.
    await run('docker', ['image', 'rm', ...tags(images.server)]);
    // Uses the builder selected by setup-buildx-action (or the local test runner).
    await run('docker', ['buildx', 'build', '--target', 'trial', ...stamp, ...tags(images.trial).flatMap(tag => ['--tag', tag]), '--push', tree]);

    await writeFile(join(tree, 'package.json'), `${JSON.stringify(publishedPackage(JSON.parse(await readFile(join(tree, 'package.json'), 'utf8')), commit, version), null, 2)}\n`);
    const npmRegistry = new URL(env.npm_config_registry || 'https://registry.npmjs.org/');
    await writeFile(join(scratch, 'npmrc'), `registry=${npmRegistry.href}\n${env.NPM_TOKEN ? `//${npmRegistry.host}${npmRegistry.pathname}:_authToken=\${NPM_TOKEN}\n` : ''}`, { mode: 0o600 });
    await run('npm', ['publish', ...(ports.provenance ? ['--provenance'] : []), '--tag', 'latest', '--access', 'public', '--userconfig', join(scratch, 'npmrc')], tree);
    return { version, images: [...tags(images.server), ...tags(images.trial)] };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

// Built by `node scripts/build-publisher.mjs`; both Actions and the offline install proof run this entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const commit = process.env.GRAPHYARD_PUBLISH_COMMIT;
  if (!commit) throw new Error('GRAPHYARD_PUBLISH_COMMIT is required');
  console.log(JSON.stringify(await publishVerified(commit, { root: process.cwd(), run: defaultChildRun, provenance: process.argv.includes('--provenance') })));
}
