import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitWatchPorts } from '../src/cli/upgrade.js';
import { deployRecordPath, readDeployRecord, watchMain, type DeployWatchPorts } from '../src/deploy-watch.js';
import { defaultChildRun } from '../src/child-runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2942: each install's deploy watcher uses its own checkout and checks health against the
// deployed commit's release, so two installs on one host no longer roll each other back.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

/** An origin, a second clone that pushes to it, and the CLI checkout the deploy unit watches, at commit A. */
async function repositories() {
  const base = await temporaryDirectory('deploy-watch-isolation');
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), checkout = join(base, 'checkout');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, pusher);
  const commit = async (name: string) => { await writeFile(join(pusher, 'release.txt'), name); git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', name); git(pusher, 'push', '-q', 'origin', 'HEAD:main'); return git(pusher, 'rev-parse', 'HEAD'); };
  const a = await commit('A');
  git(base, 'clone', '-q', origin, checkout);
  git(checkout, 'checkout', '-q', '--detach', a);
  return { checkout, commit, a };
}

test('unit:deploy-health-expects-deployed-commit — a checkout whose HEAD another install moves between restart and health still has its health step expect the deployed commit\'s release, never the HEAD\'s', async () => {
  // Imported here so the test fails as a case, not at load, against code without the export.
  const { deployHealth } = await import('../src/cli/upgrade.js') as { deployHealth?: (cliRoot: string, url: string, attempts?: number, pauseMs?: number) => (commit: string) => Promise<void> };
  // Short refusal: a long assert message against the base fills spawnSync's pipe and deadlocks verify's exercise.
  if (typeof deployHealth !== 'function') throw new Error('deployHealth is not exported');
  const { checkout, commit, a } = await repositories();
  const b = await commit('B');
  let version = '';
  const server = createHttpServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, healthy: true, version })); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const moveTo = a;
  const ports: DeployWatchPorts = {
    ...gitWatchPorts(checkout, 'main', defaultChildRun),
    build: async () => {}, pin: async () => {}, prune: async () => {},
    // The other install's rollback moves the shared HEAD once the restart has stamped the image.
    restart: async sha => { version = `unreleased ${sha.slice(0, 12)}`; git(checkout, 'checkout', '-q', '--detach', moveTo); },
    health: deployHealth(checkout, url, 1, 0),
    schema: async () => 7, database: async () => 7,
  };
  const file = deployRecordPath(await temporaryDirectory('deploy-health-commit'));
  try {
    await watchMain(file, ports, { intervalMs: 1000, once: true, log: () => {} });
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), a, 'the checkout was moved off the deployed commit before health');
    assert.deepEqual([readDeployRecord(file)?.tip, readDeployRecord(file)?.failed], [b, null], '/healthz reporting the deployed commit\'s release passes');

    // A server answering the moved HEAD's release fails, against the deployed commit's release.
    const c = await commit('C');
    ports.restart = async () => { version = `unreleased ${b.slice(0, 12)}`; git(checkout, 'checkout', '-q', '--detach', b); };
    await watchMain(file, ports, { intervalMs: 1000, once: true, log: () => {} });
    assert.equal(readDeployRecord(file)?.failed, c);
    assert.match(readDeployRecord(file)?.reason ?? '', new RegExp(`health failed: /healthz reports unreleased ${b.slice(0, 12)}, not unreleased ${c.slice(0, 12)}`));
  } finally { server.close(); }
});

test('unit:deploy-unit-has-own-checkout — the deploy unit names a checkout under its install\'s own directory, never the operator\'s source checkout, and two installs on one host get two', async () => {
  const { deployUnitText } = await import('../src/supervisor.js');
  const home = await temporaryDirectory('deploy-unit-home'), source = await temporaryDirectory('deploy-unit-source');
  const previous = process.env.GRAPHYARD_CONFIG_HOME;
  process.env.GRAPHYARD_CONFIG_HOME = home;
  try {
    const checkouts = ['owner/one', 'owner/two'].map(repository => {
      const text = deployUnitText({ root: source, cliPath: join(source, 'bin', 'graphyard.mjs'), repository });
      const checkout = /^ExecStart=.* upgrade --watch --checkout (\S+)$/m.exec(text)?.[1];
      // Short refusal: dumping the unit text against the base fills spawnSync's pipe and deadlocks verify.
      assert.ok(checkout, 'deploy unit ExecStart must name --checkout');
      assert.ok(checkout.startsWith(join(home, repository.replace('/', '-')) + '/'), 'checkout is under the install\'s own directory');
      assert.ok(!checkout.startsWith(source), 'not the operator\'s source checkout');
      return checkout;
    });
    assert.notEqual(checkouts[0], checkouts[1], 'each install deploys from its own checkout');
  } finally { if (previous === undefined) delete process.env.GRAPHYARD_CONFIG_HOME; else process.env.GRAPHYARD_CONFIG_HOME = previous; }
});
