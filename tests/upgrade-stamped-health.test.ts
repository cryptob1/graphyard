import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { composeAdapter, type AdapterContext, type AdapterObservation } from '../src/install/adapters.js';
import type { InstallRecord } from '../src/install/secrets.js';
import type { Transport } from '../src/install/transport.js';
import { cliChangesOf, liveEffects, resolveTarget, runUpgrade, upgradePlan, type UpgradeInputs } from '../src/cli/upgrade.js';
import { checkoutRelease, imageRepository } from '../src/release.js';
// @ts-expect-error Dependency-free gate script.
import { judge } from '../scripts/upgrade-from-stable.mjs';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const previousVersion = '2026.10.18.1', version = '2026.10.18.2';
const databasePort = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 38;
const repositoryRoot = new URL('..', import.meta.url).pathname;
let database: EmbeddedPostgres;
let databaseUrl: string;

before(async () => {
  const scratch = await temporaryDirectory('upgrade-stamped-pg');
  database = new EmbeddedPostgres({ databaseDir: join(scratch, 'pg'), user: 'graphyard', password: 'testing-only', port: databasePort, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise();
  await database.start();
  await database.createDatabase('upgrade_stamped_health');
  databaseUrl = `postgres://graphyard:testing-only@127.0.0.1:${databasePort}/upgrade_stamped_health`;
});
after(async () => { await database?.stop(); });

/**
 * The installation's CLI checkout, as the upgrade gate builds it: this repository's committed code
 * borrowed through its objects, detached at the previous release, with the candidate one commit on.
 */
async function cliCheckout() {
  const root = await temporaryDirectory('upgrade-stamped-cli');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=gate', '-c', 'user.email=gate@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'advice.detachedHead=false', ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  const objects = execFileSync('git', ['-C', repositoryRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  await writeFile(join(root, '.git/objects/info/alternates'), `${join(objects, 'objects')}\n`);
  git('checkout', '--quiet', '--detach', execFileSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  let modules = repositoryRoot;
  while (!existsSync(join(modules, 'node_modules'))) modules = dirname(modules);
  await symlink(join(modules, 'node_modules'), join(root, 'node_modules'));
  await writeFile(join(root, '.git/info/exclude'), 'node_modules\n');
  git('tag', previousVersion);
  const previous = git('rev-parse', 'HEAD');
  git('commit', '--quiet', '--allow-empty', '-m', 'candidate');
  git('tag', version);
  const candidate = git('rev-parse', 'HEAD');
  git('checkout', '--quiet', '--detach', previous);
  return { root, previous, candidate };
}

/**
 * The Docker a Compose install drives, run on this machine: `docker build` gives the tag the
 * environment the build context's Dockerfile ENV lines bake in (each ARG's default unless
 * `--build-arg` names it), and `docker compose up` replaces the served container with that build
 * context's real server process, with the bundle's server.env, the test database and no .git.
 */
function localDocker(port: number) {
  const images = new Map<string, { env: Record<string, string>; root: string }>();
  const servers: ChildProcess[] = [];
  const builds: string[][] = [];
  const stop = () => Promise.all(servers.splice(0).map(server => server.exitCode !== null ? null : new Promise(resolve => { server.once('exit', resolve); server.kill(); })));
  async function exec(program: string, args: string[]) {
    assert.equal(program, 'docker');
    if (args[0] === 'build') {
      builds.push(args);
      const root = args.at(-1)!;
      const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8');
      const values: Record<string, string> = Object.fromEntries([...dockerfile.matchAll(/^ARG (\w+)=(.*)$/gm)].map(match => [match[1], match[2]]));
      args.forEach((arg, index) => { if (args[index - 1] === '--build-arg') { const at = arg.indexOf('='); values[arg.slice(0, at)] = arg.slice(at + 1); } });
      const env = Object.fromEntries([...dockerfile.matchAll(/^ENV (\w+)=\$\{(\w+)\}$/gm)].map(match => [match[1], values[match[2]] ?? '']));
      images.set(args[args.indexOf('--tag') + 1], { env, root });
    } else if (args[0] === 'compose' && args.includes('up')) {
      const workdir = args[args.indexOf('--project-directory') + 1];
      const bundle = await readFile(join(workdir, 'compose.yaml'), 'utf8');
      const built = images.get(bundle.match(/^ {2}server:\n {4}image: (\S+)$/m)![1]);
      assert.ok(built, 'compose serves the image the install built');
      const serverEnv = Object.fromEntries((await readFile(join(workdir, 'server.env'), 'utf8')).split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
      const noGit = await temporaryDirectory('upgrade-stamped-nogit');
      const { GRAPHYARD_VERSION: _v, GRAPHYARD_BUILD_REVISION: _r, GRAPHYARD_BUILD_SHA: _s, ...host } = process.env;
      await stop();
      servers.push(spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: built.root, stdio: 'ignore',
        env: { ...host, ...built.env, ...serverEnv, DATABASE_URL: databaseUrl, HOST: '127.0.0.1', PORT: String(port), GIT_DIR: noGit } }));
    }
  }
  return { exec, builds, stop };
}

/** The served /healthz release, once the server answers. */
async function servedHealth(port: number) {
  for (let attempt = 0; attempt < 600; attempt++) {
    try {
      const body = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json() as { version: string; commit: string | null };
      return { version: body.version, commit: body.commit };
    } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error(`the server on ${port} never answered /healthz`);
}

/**
 * The compose install the CLI checkout runs: its own src/install/adapters.ts, loaded in a fresh
 * process from the revision checked out now, builds the image from that checkout, writes the bundle
 * into the installation's workdir and brings it up. Its docker calls replay through `docker`.
 */
async function composeInstall(cliRoot: string, image: string, workdir: string, port: number, docker: ReturnType<typeof localDocker>) {
  const script = join(await temporaryDirectory('upgrade-stamped-script'), 'install.mjs');
  await writeFile(script, `import { writeFile } from 'node:fs/promises';
const [adapters, image, workdir, port] = process.argv.slice(2);
const { composeAdapter } = await import(adapters);
const calls = [];
const transport = { description: 'recorded docker', async putFile(path, content) { await writeFile(path, content); }, async exec(program, args) { calls.push([program, args]); return { code: 0, stdout: '', stderr: '' }; } };
const ctx = { image, sourceRoot: process.cwd(), transport, workdir, port: Number(port), installId: 'gate', databasePassword: 'unused' };
await composeAdapter.provision(ctx, { database: true, app: true });
await composeAdapter.setEnv(ctx, [{ name: 'GRAPHYARD_PRINCIPALS', value: JSON.stringify([{ id: 'admin', role: 'admin', token: 'a'.repeat(32) }]), secret: true }]);
await composeAdapter.deploy(ctx);
process.stdout.write(JSON.stringify(calls));
`);
  const { GRAPHYARD_VERSION: _v, GRAPHYARD_BUILD_REVISION: _r, GRAPHYARD_BUILD_SHA: _s, ...env } = process.env;
  const calls = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', script, new URL(`file://${join(cliRoot, 'src/install/adapters.ts')}`).href, image, workdir, String(port)], { cwd: cliRoot, env, encoding: 'utf8' })) as [string, string[]][];
  for (const [program, args] of calls) await docker.exec(program, args);
  return servedHealth(port);
}

test('unit:upgrade-serves-stamped-release — graphyard upgrade of an installed compose release redeploys an image whose /healthz reports the upgraded-to version and commit, not unreleased unknown', async () => {
  const { root: cliRoot, previous, candidate } = await cliCheckout();
  const port = databasePort + 1;
  const workdir = await temporaryDirectory('upgrade-stamped-install');
  const docker = localDocker(port);
  try {
    // The installed previous release: its own CLI's compose install, serving its own build.
    const installed = await composeInstall(cliRoot, `${imageRepository}:${previousVersion}`, workdir, port, docker);
    const url = `http://127.0.0.1:${port}`;
    const record = { provider: 'compose', repository: 'upgrade-gate/fixture', baseBranch: 'main', reviewPolicy: 'github', principals: [], noGithubApp: true,
      deployment: { sshHost: null, sshUser: 'root', local: false, port, image: `${imageRepository}:${previousVersion}` } } as unknown as InstallRecord;
    const target = resolveTarget(cliRoot, version);
    const inputs: UpgradeInputs = { cliRoot, repoRoot: cliRoot, current: checkoutRelease(cliRoot), target, databaseSchema: target.schema, install: record, url,
      backupFile: join(workdir, 'backup.json'), cliChanges: cliChangesOf(cliRoot) };
    assert.equal(inputs.current.revision, previous);
    const plan = upgradePlan(inputs);
    const live = liveEffects(inputs, join(workdir, 'upgrade.json'));
    let upgraded: { version: string; commit: string | null } | null = null;
    // checkout and the strict /healthz check run as graphyard upgrade runs them, and the redeploy
    // runs the checked-out CLI's compose install into the same workdir. The rest needs a network,
    // a GitHub repository or a host supervisor, and none of it changes what /healthz serves.
    const result = await runUpgrade(plan, {
      record: live.record,
      async run(step) {
        if (step.id === 'checkout' || step.id === 'health') return live.run(step);
        if (step.id === 'redeploy') {
          const image = `${imageRepository}:${version}`;
          // GY-2168: the redeploy names the checkout the checkout step moved to the candidate, so the
          // image builds from that tree however the pinned CLI's own code root stands.
          assert.ok(step.command.includes(`--source-root ${cliRoot} --apply`), step.command);
          assert.match(step.command, new RegExp(`install --repo upgrade-gate/fixture --provider compose .*--image ${image.replaceAll('.', '\\.')} .*--apply$`));
          upgraded = await composeInstall(cliRoot, image, workdir, port, docker);
        }
      },
    });
    assert.deepEqual(result, { ok: true, steps: plan.steps.map(step => step.id) });
    assert.equal(checkoutRelease(cliRoot).revision, candidate);
    assert.notDeepEqual(upgraded, installed);
    assert.deepEqual(upgraded, { version, commit: candidate }, `after graphyard upgrade --to ${version} the compose install's /healthz reports ${JSON.stringify(upgraded)}`);
    const verdict = judge({}, { health: await servedHealth(port) }, { version, sha: candidate }).find((check: { name: string }) => check.name === 'health-reports-candidate');
    assert.equal(verdict.ok, true, verdict.detail);
    assert.deepEqual(docker.builds.at(-1)!.slice(0, 5), ['build', '--build-arg', `GRAPHYARD_VERSION=${version}`, '--build-arg', `GRAPHYARD_BUILD_REVISION=${candidate}`]);
  } finally { await docker.stop(); }

  const plan = composeAdapter.plan({ image: `${imageRepository}:${version}`, sourceRoot: cliRoot, workdir: '/w', port: 4310 } as unknown as AdapterContext, { database: false, app: false } as AdapterObservation);
  assert.match(plan.find(action => action.id === 'provider.image')?.command ?? '', new RegExp(`--build-arg GRAPHYARD_VERSION=${version.replaceAll('.', '\\.')} --build-arg GRAPHYARD_BUILD_REVISION=${candidate} --tag `));

  // A tracked modification is not the candidate's bytes, so the build claims no release for it.
  await writeFile(join(cliRoot, 'README.md'), 'modified\n');
  const dirtyPlan = composeAdapter.plan({ image: `${imageRepository}:${version}`, sourceRoot: cliRoot, workdir: '/w', port: 4310 } as unknown as AdapterContext, { database: false, app: false } as AdapterObservation);
  assert.doesNotMatch(dirtyPlan.find(action => action.id === 'provider.image')?.command ?? '', /--build-arg/);
});

test('unit:upgrade-gate-still-refuses-wrong-health — health-reports-candidate fails an upgrade whose /healthz does not report the candidate\'s version and commit, and promote still needs the gate', async () => {
  const sha = execFileSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const healthCheck = (health: unknown) => judge({}, { health }, { version, sha }).find((check: { name: string }) => check.name === 'health-reports-candidate');
  for (const health of [{ version: 'unreleased unknown', commit: null }, { version, commit: null }, { version, commit: 'f'.repeat(40) }, { version: '2026.10.18.1', commit: sha }, {}]) {
    const verdict = healthCheck(health);
    assert.equal(verdict.ok, false, `${JSON.stringify(health)} must fail the gate`);
    assert.match(verdict.detail, new RegExp(`not ${version.replaceAll('.', '\\.')} at ${sha}`));
  }
  assert.equal(healthCheck({ version, commit: sha.toUpperCase() }).ok, true);

  const workflow = await readFile(new URL('../.github/workflows/release-candidate.yml', import.meta.url), 'utf8');
  assert.match(workflow, /\n {2}upgrade:\n[\s\S]*?run: node --import tsx scripts\/upgrade-from-stable\.mjs --previous stable --candidate "\$CANDIDATE_SHA"/);
  assert.match(workflow, /\n {2}promote:\n[\s\S]*?needs: \[[^\]]*\bupgrade\b[^\]]*\]\n\s*if: [^\n]*needs\.upgrade\.result == 'success'/);
});
