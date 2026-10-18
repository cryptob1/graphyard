import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { composeAdapter, type AdapterContext, type AdapterObservation } from '../src/install/adapters.js';
import type { Transport } from '../src/install/transport.js';
// @ts-expect-error Dependency-free gate script.
import { judge } from '../scripts/upgrade-from-stable.mjs';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const version = '2026.10.18.2';
const image = `ghcr.io/cryptob1/graphyard:${version}`;
const databasePort = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1977;
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

/**
 * The Docker a Compose install drives, run on this machine: `docker build` gives the tag the
 * environment the Dockerfile's ENV lines bake in (each ARG's default unless `--build-arg` names
 * it), and `docker compose up` serves that image as this checkout's real server process, with the
 * bundle's server.env, the test database and no .git under /app, exactly as the container runs it.
 */
function localDocker(port: number) {
  const images = new Map<string, Record<string, string>>();
  const servers: ChildProcess[] = [];
  const calls: string[][] = [];
  const stop = () => Promise.all(servers.splice(0).map(server => server.exitCode !== null ? null : new Promise(resolve => { server.once('exit', resolve); server.kill(); })));
  const transport: Transport = {
    description: 'local docker emulation',
    async putFile(path, content) { await writeFile(path, content); },
    async exec(program, args) {
      assert.equal(program, 'docker');
      calls.push(args);
      if (args[0] === 'build') {
        const dockerfile = await readFile(join(repositoryRoot, 'Dockerfile'), 'utf8');
        const values: Record<string, string> = Object.fromEntries([...dockerfile.matchAll(/^ARG (\w+)=(.*)$/gm)].map(match => [match[1], match[2]]));
        args.forEach((arg, index) => { if (args[index - 1] === '--build-arg') { const at = arg.indexOf('='); values[arg.slice(0, at)] = arg.slice(at + 1); } });
        const env = Object.fromEntries([...dockerfile.matchAll(/^ENV (\w+)=\$\{(\w+)\}$/gm)].map(match => [match[1], values[match[2]] ?? '']));
        images.set(args[args.indexOf('--tag') + 1], env);
      } else if (args[0] === 'compose' && args.includes('up')) {
        const workdir = args[args.indexOf('--project-directory') + 1];
        const bundle = await readFile(join(workdir, 'compose.yaml'), 'utf8');
        const baked = images.get(bundle.match(/^ {2}server:\n {4}image: (\S+)$/m)![1]);
        assert.ok(baked, 'compose serves the image the install built');
        const serverEnv = Object.fromEntries((await readFile(join(workdir, 'server.env'), 'utf8')).split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
        const noGit = await temporaryDirectory('upgrade-stamped-nogit');
        const { GRAPHYARD_VERSION: _v, GRAPHYARD_BUILD_REVISION: _r, GRAPHYARD_BUILD_SHA: _s, ...host } = process.env;
        await stop();
        servers.push(spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: repositoryRoot, stdio: 'ignore',
          env: { ...host, ...baked, ...serverEnv, DATABASE_URL: databaseUrl, HOST: '127.0.0.1', PORT: String(port), GIT_DIR: noGit } }));
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  return { transport, calls, stop };
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

/** What the upgrade's redeploy runs: the target CLI's compose install, which builds the image, writes the bundle and brings it up. */
async function redeploy(sourceRoot: string, transport: Transport, port: number) {
  const workdir = await temporaryDirectory('upgrade-stamped-install');
  const ctx = { image, sourceRoot, transport, workdir, port, installId: 'gate', databasePassword: 'unused' } as unknown as AdapterContext;
  await composeAdapter.provision(ctx, { database: false, app: false } as AdapterObservation);
  await composeAdapter.setEnv(ctx, [{ name: 'GRAPHYARD_PRINCIPALS', value: JSON.stringify([{ id: 'admin', role: 'admin', token: 'a'.repeat(32) }]), secret: true }]);
  await composeAdapter.deploy(ctx);
  return servedHealth(port);
}

test('unit:upgrade-serves-stamped-release — after an upgrade through the compose path, /healthz reports the upgraded-to version and commit, not unreleased unknown', async () => {
  const { root, sha } = await candidateCheckout();
  const port = databasePort + 1;

  // The base: its provision built the image as `docker build --tag IMAGE SOURCE`, so the
  // Dockerfile's unstamped defaults replaced the stamp the gate's own build had given that tag,
  // and the served process reported no release and no commit.
  const base = localDocker(port);
  const unstamped: Transport = { ...base.transport, exec: (program, args, options) => base.transport.exec(program, args[0] === 'build' ? args.filter((arg, index) => arg !== '--build-arg' && args[index - 1] !== '--build-arg') : args, options) };
  try { assert.deepEqual(await redeploy(root, unstamped, port), { version: 'unreleased unknown', commit: null }); } finally { await base.stop(); }

  const candidate = localDocker(port);
  try {
    const health = await redeploy(root, candidate.transport, port);
    assert.deepEqual(health, { version, commit: sha });
    const verdict = judge({}, { health }, { version, sha }).find((check: { name: string }) => check.name === 'health-reports-candidate');
    assert.equal(verdict.ok, true, verdict.detail);
    const build = candidate.calls.find(args => args[0] === 'build')!;
    assert.deepEqual(build.slice(0, 5), ['build', '--build-arg', `GRAPHYARD_VERSION=${version}`, '--build-arg', `GRAPHYARD_BUILD_REVISION=${sha}`]);
  } finally { await candidate.stop(); }

  const plan = composeAdapter.plan({ image, sourceRoot: root, workdir: '/w', port: 4310 } as unknown as AdapterContext, { database: false, app: false } as AdapterObservation);
  assert.match(plan.find(action => action.id === 'provider.image')?.command ?? '', new RegExp(`--build-arg GRAPHYARD_VERSION=${version.replaceAll('.', '\\.')} --build-arg GRAPHYARD_BUILD_REVISION=${sha} --tag `));
});

test('unit:upgrade-gate-still-refuses-wrong-health — health-reports-candidate fails an upgrade whose /healthz does not report the candidate\'s version and commit, and promote still needs the gate', async () => {
  const { sha } = await candidateCheckout();
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
