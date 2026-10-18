import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { composeAdapter, type AdapterContext, type AdapterObservation } from '../src/install/adapters.js';
import { checkoutRelease, stampedRelease } from '../src/release.js';
// @ts-expect-error Dependency-free gate script.
import { judge } from '../scripts/upgrade-from-stable.mjs';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const version = '2026.10.18.2';
const image = `ghcr.io/cryptob1/graphyard:${version}`;

/** The environment the Dockerfile gives the image for a `docker build` argv: each ARG's default unless `--build-arg` names it. */
async function imageEnvironment(argv: string[]) {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const env: Record<string, string> = Object.fromEntries([...dockerfile.matchAll(/^ARG (GRAPHYARD_\w+)=(.*)$/gm)].map(match => [match[1], match[2]]));
  argv.forEach((arg, index) => { if (argv[index - 1] === '--build-arg') { const at = arg.indexOf('='); env[arg.slice(0, at)] = arg.slice(at + 1); } });
  return env;
}

/** What /healthz serves from that image: releaseInfo() in a process whose /app has no .git. */
async function servedHealth(argv: string[]) {
  const env = await imageEnvironment(argv);
  const app = await temporaryDirectory('upgrade-stamped-app');
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(app);
  try {
    const stamped = stampedRelease(env, () => 'unknown');
    return { version: (stamped ?? checkoutRelease(app, env.GRAPHYARD_BUILD_REVISION || 'unknown')).version, commit: stamped?.revision ?? (env.GRAPHYARD_BUILD_REVISION || 'unknown') };
  } finally { if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = ceiling; }
}

/** The upgraded CLI checkout: the candidate's commit, tagged with the date version the upgrade moved to. */
async function candidateCheckout() {
  const root = await temporaryDirectory('upgrade-stamped-cli');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  await writeFile(join(root, 'README.md'), 'candidate\n');
  git('add', '.'); git('-c', 'user.name=gate', '-c', 'user.email=gate@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'candidate');
  git('tag', version);
  return { root, sha: git('rev-parse', 'HEAD') };
}

/** The upgrade's redeploy step runs the target CLI's compose install, whose provision builds the image. */
async function provisionBuild(sourceRoot: string) {
  const calls: { program: string; args: string[] }[] = [];
  const transport = { exec: async (program: string, args: string[]) => { calls.push({ program, args }); return { code: 0, stdout: '', stderr: '' }; } };
  await composeAdapter.provision({ image, sourceRoot, transport } as unknown as AdapterContext, { database: false, app: false } as AdapterObservation);
  const build = calls.find(call => call.program === 'docker' && call.args[0] === 'build');
  assert.ok(build, 'the compose provision builds the image');
  assert.equal(build.args.at(-1), sourceRoot);
  assert.equal(build.args[build.args.indexOf('--tag') + 1], image);
  return build.args;
}

test('unit:upgrade-serves-stamped-release — after an upgrade through the compose path, /healthz reports the upgraded-to version and commit, not unreleased unknown', async () => {
  const { root, sha } = await candidateCheckout();
  // The cause: the base's provision rebuilt the image as `docker build --tag IMAGE SOURCE`, so the
  // Dockerfile's unstamped defaults replaced the stamp the gate's own build had given that tag.
  assert.deepEqual(await servedHealth(['build', '--tag', image, root]), { version: 'unreleased unknown', commit: 'unknown' });

  const health = await servedHealth(await provisionBuild(root));
  assert.deepEqual(health, { version, commit: sha });
  const verdict = judge({}, { health }, { version, sha }).find((check: { name: string }) => check.name === 'health-reports-candidate');
  assert.equal(verdict.ok, true, verdict.detail);

  const plan = composeAdapter.plan({ image, sourceRoot: root, workdir: '/w', port: 4310 } as unknown as AdapterContext, { database: false, app: false } as AdapterObservation);
  assert.match(plan.find(action => action.id === 'provider.image')?.command ?? '', new RegExp(`--build-arg GRAPHYARD_VERSION=${version.replaceAll('.', '\\.')} --build-arg GRAPHYARD_BUILD_REVISION=${sha} --tag `));
});

test('unit:upgrade-gate-still-refuses-wrong-health — health-reports-candidate fails an upgrade whose /healthz does not report the candidate\'s version and commit, and promote still needs the gate', async () => {
  const { sha } = await candidateCheckout();
  const healthCheck = (health: unknown) => judge({}, { health }, { version, sha }).find((check: { name: string }) => check.name === 'health-reports-candidate');
  for (const health of [{ version: 'unreleased unknown', commit: 'unknown' }, { version, commit: 'unknown' }, { version, commit: 'f'.repeat(40) }, { version: '2026.10.18.1', commit: sha }, {}]) {
    const verdict = healthCheck(health);
    assert.equal(verdict.ok, false, `${JSON.stringify(health)} must fail the gate`);
    assert.match(verdict.detail, new RegExp(`not ${version.replaceAll('.', '\\.')} at ${sha}`));
  }
  assert.equal(healthCheck({ version, commit: sha.toUpperCase() }).ok, true);

  const workflow = await readFile(new URL('../.github/workflows/release-candidate.yml', import.meta.url), 'utf8');
  assert.match(workflow, /\n {2}upgrade:\n[\s\S]*?run: node --import tsx scripts\/upgrade-from-stable\.mjs --previous stable --candidate "\$CANDIDATE_SHA"/);
  assert.match(workflow, /\n {2}promote:\n[\s\S]*?needs: \[[^\]]*\bupgrade\b[^\]]*\]\n\s*if: [^\n]*needs\.upgrade\.result == 'success'/);
});
