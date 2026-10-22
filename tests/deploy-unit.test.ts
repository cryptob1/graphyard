import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPlan, prepareInstall } from '../src/install/index.js';
import type { LocalSupervisor } from '../src/install/local.js';
import { gitWatchPorts } from '../src/cli/upgrade.js';
import { deployRecordPath, readDeployRecord, watchMain, type DeployWatchPorts } from '../src/deploy-watch.js';
import { cycleSteps } from '../src/master-daemon.js';
import { restartCause } from '../src/daemon/run.js';
import { defaultChildRun } from '../src/child-runner.js';
import { harness } from './install-harness.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2877: the continuous deploy runs in its own unit, graphyard-deploy.service, beside the loop's.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const freePort = () => new Promise<number>((accept, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => accept(port)); });
});
const foreground = (): LocalSupervisor => ({ systemd: null, reason: 'no systemd user manager answers (test host)', systemctl: async () => { throw new Error('no systemd'); }, detach: async () => { throw new Error('a plan starts nothing'); }, kill: async () => {} });

/** An origin, a second clone that pushes to it, and the CLI checkout the deploy unit watches, at commit A. */
async function repositories() {
  const base = await temporaryDirectory('deploy-watch');
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), checkout = join(base, 'checkout');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, pusher);
  const commit = async (name: string) => { await writeFile(join(pusher, 'release.txt'), name); git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', name); git(pusher, 'push', '-q', 'origin', 'HEAD:main'); return git(pusher, 'rev-parse', 'HEAD'); };
  const a = await commit('A');
  git(base, 'clone', '-q', origin, checkout);
  git(checkout, 'checkout', '-q', '--detach', a);
  return { checkout, commit, a };
}

test('unit:deploy-unit-watches-main — install --plan lists graphyard-deploy.service beside graphyard-master.service for compose and local; upgrade --watch once against an origin that moved builds, restarts, checks /healthz and records the tip, and on a failing health check rolls back to the previous tip; the loop restarts onto the recorded tip, and its cycle holds no deploy step', async () => {
  for (const provider of ['compose', 'local'] as const) {
    const fixture = await harness({ provider });
    try {
      const deps = provider === 'local' ? { ...fixture.deps, fetch, localSupervisor: foreground() } : fixture.deps;
      const plan = await buildPlan(await prepareInstall(fixture.root, { repository: 'owner/project', provider, ...(provider === 'local' ? { port: await freePort() } : {}) }, deps, 'plan'));
      const units = plan.actions.find(action => action.id === 'local.units');
      assert.ok(units, `the ${provider} plan lists the units`);
      assert.match(units.title, /graphyard-master\.service .*graphyard-deploy\.service \(upgrade --watch/);
      assert.deepEqual(units.values?.map(value => value.value), ['graphyard-master-owner-project.service', 'graphyard-deploy-owner-project.service']);
    } finally { await fixture.cleanup(); }
  }

  // The deploy unit's pass, against a checkout whose origin moved from A to B.
  const { checkout, commit, a } = await repositories();
  const b = await commit('B');
  let served = a, healthy = (sha: string) => sha !== 'never';
  const server = createHttpServer((request, response) => {
    const ok = request.url === '/healthz' && healthy(served);
    response.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok, commit: served }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const steps: string[] = [];
  const ports: DeployWatchPorts = {
    ...gitWatchPorts(checkout, 'main', defaultChildRun),
    build: async sha => { steps.push(`build ${sha.slice(0, 7)}`); },
    restart: async sha => { steps.push(`restart ${sha.slice(0, 7)}`); served = sha; },
    health: async sha => {
      steps.push(`healthz ${sha.slice(0, 7)}`);
      const response = await fetch(`${url}/healthz`), body = await response.json() as { ok: boolean; commit: string };
      if (!response.ok || !body.ok || body.commit !== sha) throw new Error(`/healthz answered ${response.status} for ${body.commit.slice(0, 7)}`);
    },
  };
  const root = await temporaryDirectory('deploy-record'), file = deployRecordPath(root);
  try {
    await watchMain(file, ports, { intervalMs: 1000, once: true, log: () => {} });
    assert.deepEqual(steps, [`build ${b.slice(0, 7)}`, `restart ${b.slice(0, 7)}`, `healthz ${b.slice(0, 7)}`]);
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), b, 'the checkout is on the new tip');
    assert.equal(readDeployRecord(file)?.tip, b, 'the served tip is recorded');
    // The loop restarts itself onto the tip the deploy unit serves.
    const config = { credentialFile: join(root, 'coordinator.token') };
    assert.match(restartCause(config, root, a) ?? '', new RegExp(`serves ${b.slice(0, 12)}, not ${a.slice(0, 12)}`));
    assert.equal(restartCause(config, root, b), null);

    // A tip whose health check fails is rolled back to the previous tip, and waits for the next one.
    const c = await commit('C');
    healthy = sha => sha !== c;
    steps.length = 0;
    await watchMain(file, ports, { intervalMs: 1000, once: true, log: () => {} });
    assert.deepEqual(steps, [`build ${c.slice(0, 7)}`, `restart ${c.slice(0, 7)}`, `healthz ${c.slice(0, 7)}`, `build ${b.slice(0, 7)}`, `restart ${b.slice(0, 7)}`, `healthz ${b.slice(0, 7)}`]);
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), b, 'the checkout is back on the previous tip');
    assert.deepEqual([readDeployRecord(file)?.tip, readDeployRecord(file)?.failed], [b, c]);
    assert.match(readDeployRecord(file)?.reason ?? '', /health failed: \/healthz answered 503/);
    steps.length = 0;
    await watchMain(file, ports, { intervalMs: 1000, once: true, log: () => {} });
    assert.deepEqual(steps, [], 'the failed tip is not tried again until the base moves');
  } finally { server.close(); }

  assert.ok(!cycleSteps.some(step => /deploy|upgrade/.test(step)), 'the master loop\'s cycle holds no deploy step');
});
