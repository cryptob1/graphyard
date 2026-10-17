import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as netServer, type AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbeddedPostgres from 'embedded-postgres';
import { Store, save } from '../src/store.js';
import { lockedWork } from '../src/store/locked-read.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { masterConfigSchema } from '../src/master.js';
import { emptyDaemonState } from '../src/daemon/state-cursor.js';
import { mergeWriterReads, mergeWriterStep } from '../src/daemon/cycle-merge-writer.js';
import { mergeRecordKey, previewRecordEvent, type MergeRecordEvent } from '../src/merge-writer/executor.js';
import { composeLeftovers, composeMountProblems, composeStack, composePreviewConfig, composeProjectName, composeProjectPrefix, sweepComposePreviews, composeBounds, currentOwner, defaultDocker, removeComposeProject, snapshotComposeSite, type Docker } from '../src/compose-preview.js';
import { previewPath, type ItemPreview } from '../src/project-previews.js';
import { defaultChildRun } from '../src/child-runner.js';
import type { Cycle } from '../src/daemon/cycle.js';
import { PreviewPanel } from '../web/pages/work-details.js';
import { processPidNamespace } from '../src/tmp-reclaim.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1903 (GOAL-1, preview-isolation and declared-app-previews): a declared Compose application is
// previewed locally like GY-1902's static site, as its own Compose project — its own state, database,
// network and volumes, no production credential, bounded — and every container, volume and network of
// it is removed when the preview ends, however it ends. Everything runs on this host's Docker daemon:
// no Railway, no GitHub Actions.

const fixtureSource = fileURLToPath(new URL('./fixtures/goal-compose-preview/', import.meta.url));
const operator: Principal = { id: 'operator', role: 'admin' }, coordinator: Principal = { id: 'graphyard', role: 'coordinator' };
const tokens = { operator: `operator-${'o'.repeat(40)}`, coordinator: `coordinator-${'c'.repeat(40)}` };
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/fixture', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-fixture', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy', retrials: 1 } } });
/** Production credentials the loop's host holds: none of them may reach a preview. */
const production = { GRAPHYARD_UAT_TOKEN: 'prod-secret-uat-token', DATABASE_URL: 'postgres://prod:prod-secret-password@db.internal/production', GITHUB_TOKEN: 'ghp_prodsecretgithubtoken' };
/** The configured bounds every preview container runs under. */
const bounds = { GRAPHYARD_PREVIEW_CPUS: '0.5', GRAPHYARD_PREVIEW_MEMORY_MB: '64', GRAPHYARD_PREVIEW_PIDS: '64' };
const environment = { PATH: process.env.PATH, ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}), ...production, ...bounds };

let database: EmbeddedPostgres, store: Store, http: ReturnType<typeof server>, url: string, scratch: string, repo: string, base: string;
const shas: Record<string, string> = {};
const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0 && spawnSync('docker', ['image', 'inspect', 'alpine:3'], { encoding: 'utf8' }).status === 0;
const freePort = async () => { const probe = netServer(); await new Promise<void>(done => probe.listen(0, '127.0.0.1', done)); const { port } = probe.address() as AddressInfo; await new Promise<void>(done => probe.close(() => done())); return port; };
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const dockerJson = (...args: string[]) => JSON.parse(execFileSync('docker', args, { encoding: 'utf8' }));

/** A synthetic production credential the loop's host keeps outside every checkout: an env file and a directory. */
const outsideCredential = 'synthetic-production-credential-1903';
/** The fixture project (tests/fixtures/goal-compose-preview): main, a static change, a Compose change, a Compose change that breaks its case, and ones reaching host credentials or the engine. */
async function fixture() {
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  await cp(fixtureSource, repo, { recursive: true });
  const commit = (name: string) => { git('add', '-A'); git('commit', '-q', '-m', name); shas[name] = git('rev-parse', 'HEAD'); };
  commit('main');
  const change = async (name: string, edit: () => Promise<void>) => { git('checkout', '-q', '--detach', shas.main!); await edit(); commit(name); };
  await change('static', () => writeFile(join(repo, 'site/index.html'), '<h1>Fixture static site</h1>\n<p>Static change S is live</p>\n'));
  await change('compose', () => writeFile(join(repo, 'app/banner.txt'), 'Compose change C is live\n'));
  await change('broken', () => writeFile(join(repo, 'app/heading.txt'), 'Something else\n'));
  await change('mount', async () => { const file = join(repo, 'compose.yml'); await writeFile(file, (await readFile(file, 'utf8')).replace('      - state:/state\n', '      - state:/state\n      - /var/run/docker.sock:/var/run/docker.sock\n')); });
  // Reaching outside the checkout: an env file the resolution would read, a tracked symlink a bind mount follows, and the engine's implicit API socket.
  const outside = join(scratch, 'outside'); await mkdir(join(outside, 'credentials'), { recursive: true });
  await writeFile(join(outside, 'production.env'), `PREVIEW_LEAK=${outsideCredential}\n`); await writeFile(join(outside, 'credentials', 'token'), `${outsideCredential}\n`);
  const compose = async (from: string, to: string) => { const file = join(repo, 'compose.yml'); await writeFile(file, (await readFile(file, 'utf8')).replace(from, to)); };
  const web = '    command: ["sh", "/app/web-start.sh"]\n';
  await change('envfile', () => compose(web, `${web}    env_file: ${join(outside, 'production.env')}\n`));
  await change('symlink', async () => { await symlink(join(outside, 'credentials'), join(repo, 'credential-dir')); await compose('      - state:/state\n', '      - state:/state\n      - ./credential-dir:/credentials:ro\n'); });
  await change('socket', () => compose(web, `${web}    use_api_socket: true\n`));
  // The checkout's own .env, which Compose would interpolate from, linking to the host's production env file.
  await change('dotenv', async () => { await symlink(join(outside, 'production.env'), join(repo, '.env')); git('add', '-f', '.env'); await compose('      APP_STATE:', '      PREVIEW_LEAK: ${PREVIEW_LEAK:-unset}\n      APP_STATE:'); });
  git('checkout', '-q', 'main');
}

before(async () => {
  if (!docker) return;
  scratch = await realpath(await temporaryDirectory('goal-compose-preview'));
  repo = join(scratch, 'repo'); base = join(scratch, 'worktrees'); await mkdir(base);
  await fixture();
  const port = await freePort();
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('goal-compose-preview-pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('compose_preview_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/compose_preview_test`); await store.init();
  http = server(new Engine(store, [15368], 120, 'owner/fixture'), [{ ...operator, token: tokens.operator }, { ...coordinator, token: tokens.coordinator }]);
  await new Promise<void>(done => http.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
after(async () => {
  if (http) await new Promise<void>(done => http.close(() => done()));
  if (store) await store.close(); if (database) await database.stop();
  // Whatever a failed assertion left of this file's previews goes with it.
  if (docker) for (const project of execFileSync('docker', ['ps', '-a', '--format', '{{.Label "com.docker.compose.project"}}'], { encoding: 'utf8' }).split('\n').filter(name => name.startsWith(`${composeProjectPrefix}gy-`) || name.startsWith(`${composeProjectPrefix}abandoned`)))
    spawnSync('docker', ['compose', '-p', project, 'down', '--volumes', '--timeout', '1']);
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

const call = async (method: string, path: string, as: keyof typeof tokens, body?: unknown, key?: string) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${tokens[as]}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const read = async (id: string): Promise<Work> => { const answer = await call('GET', `work/${id}`, 'operator'); assert.equal(answer.status, 200); return answer.body; };
let created = 0;
async function change(title: string, proof: string) {
  const answer = await call('POST', 'work', 'operator', { title, description: 'A change whose declared application case needs a local preview.', type: 'feature', priority: 3,
    policy: { checks: ['test'], review: true }, criteria: [{ id: 'AC-1', text: 'The declared application shows this change', proofs: [`e2e:${proof}`] }] }, `create-${++created}`);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body as Work;
}
async function submit(item: Work, name: string) {
  await store.transaction(async (db, now) => {
    const work = (await lockedWork(db, [item.id])).find(entry => entry.id === item.id)!;
    work.candidate = { sha: shas[name]!, baseSha: shas.main!, pr: 100 + created, branch: `graphyard/${work.key.toLowerCase()}-1`, author: 'worker-1' };
    await save(db, work, 'test', 'test.submitted', now);
  });
}
const close = async (item: Work, reason: string) => assert.equal((await call('POST', `work/${item.id}/close`, 'operator', { kind: 'obsolete', reason }, `close-${item.id}`)).status, 200);

/** The loop's merge-writer step as the daemon wires it, in a host environment holding production credentials and the configured bounds. */
function loop(docker?: Docker) {
  const state = emptyDaemonState(config);
  const record = async (work: Pick<Work, 'id' | 'key'>, event: MergeRecordEvent) => {
    const answer = await call('POST', `work/${work.id}/merge-record`, 'coordinator', event, mergeRecordKey(work, event));
    if (answer.status !== 200) throw new Error(`${answer.status}: ${answer.body.error}`);
    return answer.body;
  };
  const reads = { ...mergeWriterReads(config, repo, defaultChildRun, { base, record, merger: async () => 'github', environment, itemPreviews: { docker } }), advisory: undefined };
  return { step: async (ids: string[]) => {
    const work = await Promise.all(ids.map(read));
    await mergeWriterStep({ state, effects: { mergeWriter: reads, persist: async () => {} }, now: Date.now, snapshot: { work }, performed: [] } as unknown as Cycle);
  } };
}
async function until(run: ReturnType<typeof loop>, ids: string[], target: string, done: (preview: ItemPreview | null | undefined) => boolean) {
  for (let round = 0; round < 600; round++) {
    await run.step(ids);
    const work = await read(target);
    if (done(work.preview)) return work.preview!;
    await new Promise(accept => setTimeout(accept, 100));
  }
  assert.fail(`${target}'s preview never settled: ${JSON.stringify((await read(target)).preview)}`);
}
const open = async (key: string, path = '/') => fetch(`${url}${previewPath(key)}${path}`);
const project = (item: Work, preview: ItemPreview) => composeProjectName(item.key, preview.id);
/** Brings up `name` from the main fixture as a preview a gone process owned. */
async function leaveAbandoned(name: string) {
  const resolved = JSON.parse(execFileSync('docker', ['compose', '-f', 'compose.yml', '-p', name, 'config', '--format', 'json'], { cwd: repo, encoding: 'utf8' }));
  const directory = await temporaryDirectory('compose-abandoned');
  await writeFile(join(directory, 'compose.json'), JSON.stringify(composePreviewConfig(resolved, { project: name, service: 'web', port: 8080, bounds: composeBounds(bounds), variables: {}, owner: { pid: spawnSync('true').pid!, startedAt: 1, pidNamespace: processPidNamespace(), at: new Date().toISOString() } })));
  execFileSync('docker', ['compose', '-f', join(directory, 'compose.json'), '-p', name, '--project-directory', repo, 'up', '--detach', '--wait'], { stdio: 'ignore' });
  assert.equal((await composeLeftovers(name)).containers.length, 2);
}
const nothingLeft = async (name: string) => assert.deepEqual(await composeLeftovers(name), { containers: [], volumes: [], networks: [] }, `${name} left nothing behind`);

test('integration:goal-declared-application-previews — a declared static site and a declared Compose application each get a real local preview of the exact change: the item names the local runner, the link serves the changed page, and the declared cases\' results are on the item', { timeout: 300_000 }, async t => {
  if (!docker) { assert.ok(!process.env.CI, 'CI runs the Compose previews'); t.skip('no Docker Compose or alpine:3 image on this host'); return; }
  const run = loop();
  const site = await change('A change to the static site', 'fixture-static-home'), app = await change('A change to the compose app', 'fixture-compose-app');
  await submit(site, 'static'); await submit(app, 'compose');
  const staticPreview = await until(run, [site.id, app.id], site.id, preview => preview?.state === 'running');
  const composePreview = await until(run, [site.id, app.id], app.id, preview => preview?.state === 'running');
  for (const [item, preview, application, sha] of [[site, staticPreview, 'site', shas.static], [app, composePreview, 'app', shas.compose]] as const) {
    assert.deepEqual({ path: preview.path, runner: preview.runner, application: preview.application, sha: preview.sha, source: preview.source }, { path: `/preview/${item.key}`, runner: 'local', application, sha, source: 'head' });
    assert.match(preview.origin!, /^http:\/\/127\.0\.0\.1:\d+$/, 'served on this host\'s loopback');
  }
  assert.deepEqual(staticPreview.cases, [{ case: 'fixture-static-home', result: 'pass' }]);
  assert.deepEqual(composePreview.cases, [{ case: 'fixture-compose-app', result: 'pass' }]);
  assert.deepEqual({ instance: composePreview.instance, database: composePreview.database, secrets: composePreview.secrets }, { instance: `preview-${app.key}`, database: `preview-${app.key}-db`, secrets: [] });

  // The static link serves the changed page built with the item's title.
  const staticPage = await (await open(site.key)).text();
  assert.match(staticPage, /Fixture static site/); assert.match(staticPage, /Static change S is live/); assert.match(staticPage, /A change to the static site/);
  // The Compose link serves the running application's page: the changed banner, the item's title, its own state and database.
  const served = await open(app.key);
  assert.equal(served.status, 200);
  const page = await served.text();
  for (const text of ['Fixture compose app', 'Compose change C is live', 'A change to the compose app', `state preview-${app.key}`, `database preview-${app.key}-db`, 'production credentials none']) assert.ok(page.includes(text), `${text} in ${page}`);
  assert.deepEqual(await (await open(app.key, '/status.json')).json(), { heading: 'Fixture compose app', state: `preview-${app.key}`, database: `preview-${app.key}-db`, credentials: 'none' }, 'the page\'s relative link is published too');
  // The live application answers the same on the loop's origin.
  assert.match(await (await fetch(`${composePreview.origin}/`)).text(), /Compose change C is live/);
  // Work details name the application, the runner and the isolation.
  const panel = renderToStaticMarkup(createElement(PreviewPanel, { preview: composePreview }));
  for (const text of ['app · local runner', `preview-${app.key}-db`, 'no production credentials', 'fixture-compose-app passed']) assert.ok(panel.includes(text), text);

  await close(site, 'Previewed'); await close(app, 'Previewed');
  await until(run, [site.id, app.id], site.id, preview => preview?.state === 'cleaned');
  assert.equal((await until(run, [site.id, app.id], app.id, preview => preview?.state === 'cleaned')).endReason, 'cancelled');
  await nothingLeft(project(app, composePreview));
});

test('integration:goal-compose-preview-isolation-cleanup — two simultaneous Compose previews keep their own state and database, get no production credential and run bounded; their containers, volumes and networks are removed on success, failure and cancellation; restart recovery keeps live owners and removes abandoned previews', { timeout: 300_000 }, async t => {
  if (!docker) { assert.ok(!process.env.CI, 'CI runs the Compose previews'); t.skip('no Docker Compose or alpine:3 image on this host'); return; }
  // The daemon refuses removals while `failing`: cleanup must not be recorded until a later removal succeeds.
  let failing = false;
  const flaky: Docker = (args, options) => failing && (args[0] === 'rm' || (['volume', 'network'].includes(args[0]!) && args[1] === 'rm') || args.includes('down'))
    ? Promise.reject(new Error(`docker ${args.slice(0, 2).join(' ')} failed: injected daemon failure`))
    : defaultDocker(args, options).catch(error => { console.error(`docker ${args.join(' ')}: ${error.message}`); throw error; });
  const run = loop(flaky);
  const first = await change('First compose change', 'fixture-compose-app'), second = await change('Second compose change', 'fixture-compose-app');
  await submit(first, 'compose'); await submit(second, 'compose');
  const a = await until(run, [first.id, second.id], first.id, preview => preview?.state === 'running');
  const b = await until(run, [first.id, second.id], second.id, preview => preview?.state === 'running');
  assert.notEqual(project(first, a), project(second, b));
  assert.deepEqual([a.instance, a.database, b.instance, b.database], [`preview-${first.key}`, `preview-${first.key}-db`, `preview-${second.key}`, `preview-${second.key}-db`]);
  assert.deepEqual([a.secrets, b.secrets], [[], []]);

  // Both run at once, each answering its own state and database — read from its own volumes over its own network.
  for (const [item, preview] of [[first, a], [second, b]] as const) {
    const status = await (await fetch(`${preview.origin}/status.json`)).json();
    assert.deepEqual(status, { heading: 'Fixture compose app', state: `preview-${item.key}`, database: `preview-${item.key}-db`, credentials: 'none' });
    const page = await (await open(item.key)).text();
    for (const text of [`state preview-${item.key}`, `database preview-${item.key}-db`, 'production credentials none']) assert.ok(page.includes(text), text);
  }
  const left = { a: await composeLeftovers(project(first, a)), b: await composeLeftovers(project(second, b)) };
  assert.equal(left.a.containers.length, 2); assert.equal(left.b.containers.length, 2);
  assert.deepEqual(left.a.volumes.filter(name => left.b.volumes.includes(name)), [], 'no volume is shared');
  assert.deepEqual(left.a.networks.filter(name => left.b.networks.includes(name)), [], 'no network is shared');
  for (const id of [...left.a.containers, ...left.b.containers]) {
    const [container] = dockerJson('inspect', id);
    // No production credential reached any container, by value or by host path.
    const env: string[] = container.Config.Env;
    for (const secret of Object.values(production)) assert.ok(!env.some(entry => entry.includes(secret)), `${container.Name} holds no production credential`);
    for (const mount of container.Mounts) assert.ok(mount.Type === 'volume' || mount.Source.startsWith(base), `${container.Name} mounts only its own volumes and the change's checkout, not ${mount.Source}`);
    assert.deepEqual(container.Config.Env.filter((entry: string) => entry.startsWith('HOME=/home') || entry.startsWith('XDG_RUNTIME_DIR=')), []);
    // The configured bounds hold.
    assert.deepEqual({ cpus: container.HostConfig.NanoCpus, memory: container.HostConfig.Memory, pids: container.HostConfig.PidsLimit, privileged: container.HostConfig.Privileged, restart: container.HostConfig.RestartPolicy.Name },
      { cpus: 500_000_000, memory: 64 * 1024 * 1024, pids: 64, privileged: false, restart: 'no' }, container.Name);
    assert.ok(container.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
    assert.ok(Object.values<{ HostIp: string }[] | null>(container.NetworkSettings.Ports).flat().every(binding => !binding || binding.HostIp === '127.0.0.1'), 'published on loopback only');
  }

  // Restart recovery: a preview whose owner still runs is kept; one a gone process left is removed, volumes and networks with it.
  const abandoned = `${composeProjectPrefix}abandoned-${process.pid}`;
  await leaveAbandoned(abandoned);
  const removed = await sweepComposePreviews();
  assert.ok(removed.includes(abandoned), 'the abandoned preview is removed');
  assert.ok(!removed.includes(project(first, a)) && !removed.includes(project(second, b)), 'live previews are kept');
  await nothingLeft(abandoned);
  assert.equal((await fetch(`${b.origin}/status.json`)).status, 200, 'a live preview keeps serving through the sweep');

  // Success: the first change settles; its preview is cleaned automatically while the other keeps running.
  await close(first, 'The case settles this change');
  const cleaned = await until(run, [first.id, second.id], first.id, preview => preview?.state === 'cleaned');
  assert.deepEqual({ instance: cleaned.instance, cases: cleaned.cases }, { instance: `preview-${first.key}`, cases: [{ case: 'fixture-compose-app', result: 'pass' }] });
  assert.ok(cleaned.cleanedAt);
  assert.equal((await open(first.key)).status, 404, 'the cleaned link stops serving');
  await nothingLeft(project(first, a));
  assert.equal((await open(second.key)).status, 200, 'the other preview keeps running');

  // Failure: a change whose case fails ran for real, and nothing of it remains.
  const broken = await change('A compose change that breaks its case', 'fixture-compose-app');
  await submit(broken, 'broken');
  const failed = await until(run, [second.id, broken.id], broken.id, preview => preview?.state === 'failed');
  assert.deepEqual(failed.cases.map(entry => [entry.case, entry.result]), [['fixture-compose-app', 'fail']]);
  await nothingLeft(project(broken, failed));
  assert.equal((await open(broken.key)).status, 404);

  // A change mounting a host credential path is refused before anything starts.
  const mounting = await change('A compose change mounting the Docker socket', 'fixture-compose-app');
  await submit(mounting, 'mount');
  const refused = await until(run, [second.id, mounting.id], mounting.id, preview => preview?.state === 'failed');
  assert.match(refused.detail, /mounts the host path \/var\/run\/docker\.sock, outside the change's checkout/);
  await nothingLeft(project(mounting, refused));

  // An env file outside the checkout, a tracked symlink to a host directory, and the engine's implicit API socket are refused before anything starts; the credential reaches no container.
  for (const [name, reason] of [['envfile', /reads the env file .*production\.env, outside the change's checkout/], ['symlink', /mounts the host path .*credential-dir, outside the change's checkout/], ['socket', /asks for the Docker engine's API socket/]] as const) {
    const item = await change(`A compose change reaching outside (${name})`, 'fixture-compose-app');
    await submit(item, name);
    const outcome = await until(run, [second.id, item.id], item.id, preview => preview?.state === 'failed');
    assert.match(outcome.detail, reason, name);
    assert.ok(!outcome.detail.includes(outsideCredential), 'the credential is never read into the record');
    await nothingLeft(project(item, outcome));
  }

  // The checkout's own .env linking to the host's production env file is never interpolated: the preview runs, and the credential reaches no container.
  const dotenv = await change('A compose change whose .env links outside', 'fixture-compose-app');
  await submit(dotenv, 'dotenv');
  const linked = await until(run, [second.id, dotenv.id], dotenv.id, preview => preview?.state === 'running' || preview?.state === 'failed');
  const linkedLeft = await composeLeftovers(project(dotenv, linked));
  assert.ok(linkedLeft.containers.length, `the preview ran: ${linked.detail}`);
  assert.ok(linkedLeft.containers.some(id => dockerJson('inspect', id)[0].Config.Env.includes('PREVIEW_LEAK=unset')), 'interpolation read no .env');
  for (const id of execFileSync('docker', ['ps', '-aq'], { encoding: 'utf8' }).split('\n').filter(Boolean))
    assert.ok(!JSON.stringify(dockerJson('inspect', id)).includes(outsideCredential), `container ${id} never holds the outside credential`);
  await close(dotenv, 'Checked');
  await until(run, [second.id, dotenv.id], dotenv.id, preview => preview?.state === 'cleaned' || preview?.state === 'failed');
  await nothingLeft(project(dotenv, linked));

  // Cancellation while it starts: the item closes before its preview is up; it is stopped, cleaned and leaves nothing.
  const early = await change('Cancelled while its compose preview starts', 'fixture-compose-app');
  await submit(early, 'compose');
  await run.step([second.id, early.id]);
  const starting = (await read(early.id)).preview!;
  assert.equal(starting.state, 'starting');
  await close(early, 'Closed while its preview starts');
  assert.equal((await until(run, [second.id, early.id], early.id, preview => preview?.state === 'cleaned')).endReason, 'cancelled');
  await nothingLeft(project(early, starting));

  // Cancellation of the running one: closed, cleaned, nothing left — after a removal the daemon refused, which is retried and not recorded until it succeeds.
  failing = true;
  await close(second, 'Done');
  for (let round = 0; round < 3; round++) await run.step([second.id]);
  assert.equal((await read(second.id)).preview!.state, 'running', 'not recorded cleaned while its containers remain');
  assert.equal((await composeLeftovers(project(second, b))).containers.length, 2, 'the refused removal left the containers');
  failing = false;
  assert.equal((await until(run, [second.id], second.id, preview => preview?.state === 'cleaned')).endReason, 'cancelled');
  await nothingLeft(project(second, b));
  assert.equal((await fetch(`${b.origin}/`).catch(() => null)), null, 'its loopback origin no longer answers');

  // Restart with a preview the gone loop left running while the daemon refuses removal: it is neither recorded cleaned nor replaced until its project is removed.
  const lost = await change('A compose preview a restart lost', 'fixture-compose-app');
  await submit(lost, 'compose');
  const record: ItemPreview = { id: randomUUID(), path: previewPath(lost.key), state: 'starting', runner: 'local', application: 'app', sha: shas.compose!, source: 'head', origin: null, cases: [{ case: 'fixture-compose-app', result: 'unrun' }],
    detail: '', startedAt: new Date().toISOString(), readyAt: null, cleanedAt: null, endReason: null, instance: `preview-${lost.key}`, database: `preview-${lost.key}-db`, secrets: [] };
  const event = previewRecordEvent(record), seeded = await call('POST', `work/${lost.id}/merge-record`, 'coordinator', event, mergeRecordKey(lost, event));
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
  const lostProject = composeProjectName(lost.key, record.id);
  await leaveAbandoned(lostProject);
  const restarted = loop(flaky);
  failing = true;
  for (let round = 0; round < 3; round++) await restarted.step([lost.id]);
  assert.deepEqual((({ id, state, cleanedAt }) => ({ id, state, cleanedAt }))((await read(lost.id)).preview!), { id: record.id, state: 'starting', cleanedAt: null }, 'not recorded cleaned, and nothing replaces it, while its project remains');
  assert.equal((await composeLeftovers(lostProject)).containers.length, 2);
  failing = false;
  const replaced = await until(restarted, [lost.id], lost.id, preview => preview?.id !== record.id && preview?.state === 'running');
  await nothingLeft(lostProject);
  await close(lost, 'Recovered');
  await until(restarted, [lost.id], lost.id, preview => preview?.state === 'cleaned');
  await nothingLeft(project(lost, replaced));
});

test('unit:compose-preview-config — the resolved configuration is refused for host mounts and privileges, and rewritten without host ports or container names, bounded and labelled', () => {
  const checkout = '/work/checkout';
  const resolved = { name: 'x', services: {
    web: { image: 'alpine:3', container_name: 'fixed', ports: [{ target: 8080, published: '8080' }], deploy: { resources: { limits: { cpus: '8' } } }, volumes: [{ type: 'bind', source: '/work/checkout/app', target: '/app' }] },
    db: { image: 'alpine:3', ports: [{ target: 5432, published: '5432' }], volumes: [{ type: 'bind', source: '/home/me/.ssh', target: '/root/.ssh' }], privileged: true, network_mode: 'host', cap_add: ['SYS_ADMIN'] },
  }, volumes: { data: { name: 'shared-db' } }, networks: { outside: { external: true } }, secrets: { token: { file: '/etc/graphyard/token' } } };
  assert.deepEqual(composeMountProblems(resolved, checkout, 'web'), [
    'service db mounts the host path /home/me/.ssh, outside the change\'s checkout', 'service db is privileged', 'service db shares the host network_mode', 'service db adds capabilities SYS_ADMIN',
    'the network outside is external, shared with something outside the preview', 'the secret token reads /etc/graphyard/token, outside the change\'s checkout']);
  assert.deepEqual(composeMountProblems(resolved, checkout, 'api')[0], 'the Compose file declares no service "api" to serve');
  const owner = currentOwner();
  const rewritten = composePreviewConfig(resolved, { project: 'graphyard-preview-gy-1-abcdef12', service: 'web', port: 8080, bounds: composeBounds({ GRAPHYARD_PREVIEW_CPUS: '99', GRAPHYARD_PREVIEW_MEMORY_MB: '128' }), variables: { GRAPHYARD_PREVIEW_INSTANCE: 'preview-GY-1' }, owner });
  assert.equal(rewritten.services.web.container_name, undefined);
  assert.deepEqual(rewritten.services.web.ports, [{ target: 8080, host_ip: '127.0.0.1', protocol: 'tcp' }]);
  assert.equal(rewritten.services.db.ports, undefined, 'only the served service is published');
  assert.deepEqual({ cpus: rewritten.services.web.cpus, memory: rewritten.services.web.mem_limit, pids: rewritten.services.web.pids_limit, deploy: rewritten.services.web.deploy }, { cpus: 16, memory: '128m', pids: 256, deploy: undefined }, 'bounds are clamped and replace the file\'s own');
  assert.equal(rewritten.services.web.environment.GRAPHYARD_PREVIEW_INSTANCE, 'preview-GY-1');
  assert.equal(rewritten.services.web.labels['graphyard.preview.owner'], JSON.stringify(owner));
  assert.equal(rewritten.volumes.data.name, 'graphyard-preview-gy-1-abcdef12_data', 'a fixed volume name is the preview\'s own');
  assert.equal(rewritten.networks.outside.labels['graphyard.preview.owner'], JSON.stringify(owner));
  assert.equal(composeProjectName('GY-12', 'ABCDEF12-0000'), 'graphyard-preview-gy-12-abcdef12');
  assert.deepEqual(composeBounds({}), { cpus: 1, memoryMb: 512, pids: 256, lifetimeMs: 720 * 60_000, concurrent: 4 });
});

test('unit:compose-preview-config-reach — symlinks out of the checkout, the API socket, another container\'s volumes and replicas never reach a preview', async () => {
  const directory = await realpath(await temporaryDirectory('compose-reach'));
  try {
    const checkout = join(directory, 'checkout'), secrets = join(directory, 'secrets');
    await mkdir(checkout); await mkdir(secrets); await symlink(secrets, join(checkout, 'credential-dir'));
    const resolved = { services: { web: { image: 'alpine:3', use_api_socket: true, volumes_from: ['container:production', 'db'], scale: 50, volumes: [{ type: 'bind', source: join(checkout, 'credential-dir'), target: '/c' }, { type: 'bind', source: join(checkout, 'app'), target: '/app' }] },
      db: { image: 'alpine:3', deploy: { replicas: 300, labels: { tier: 'db' } }, env_file: [{ path: join(checkout, 'credential-dir', 'prod.env') }] } }, secrets: { token: { file: join(checkout, 'credential-dir', 'token') } } };
    assert.deepEqual(composeMountProblems(resolved, checkout, 'web'), [
      `service web mounts the host path ${join(checkout, 'credential-dir')}, outside the change's checkout`, 'service web asks for the Docker engine\'s API socket', 'service web takes the volumes of the container production, outside the preview',
      `service db reads the env file ${join(checkout, 'credential-dir', 'prod.env')}, outside the change's checkout`, `the secret token reads ${join(checkout, 'credential-dir', 'token')}, outside the change's checkout`]);
    const rewritten = composePreviewConfig(resolved, { project: 'graphyard-preview-gy-1-abcdef12', service: 'web', port: 8080, bounds: composeBounds({}), variables: {}, owner: currentOwner() });
    assert.deepEqual([rewritten.services.web.scale, rewritten.services.db.deploy], [undefined, { labels: { tier: 'db' } }], 'one container per service');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:compose-preview-env-files-checked-unresolved — under a Compose that resolves env files despite --no-env-resolution, an env file outside the checkout is refused from the uninterpolated declaration and nothing starts', async () => {
  const directory = await realpath(await temporaryDirectory('compose-env-files'));
  try {
    const calls: string[][] = [];
    const docker: Docker = async args => {
      calls.push(args);
      if (!args.includes('config')) return '';
      return JSON.stringify(args.includes('--no-interpolate')
        ? { services: { web: { image: 'alpine:3', env_file: [{ path: '/srv/production.env' }] }, db: { image: 'alpine:3', env_file: ['${HOST_ENV}'] } } }
        : { services: { web: { image: 'alpine:3', environment: { LEAK: outsideCredential } }, db: { image: 'alpine:3' } } });
    };
    const stack = composeStack({ checkout: directory, file: 'compose.yml', service: 'web', port: 8080, project: 'graphyard-preview-gy-1-abcdef12', environment: {}, variables: {}, bounds: composeBounds({}), scratch: join(directory, 'scratch'), docker });
    await assert.rejects(stack.start(AbortSignal.timeout(5_000), 5_000), /service web reads the env file \/srv\/production\.env, outside the change's checkout; service db names its env file by a variable/);
    assert.deepEqual(calls.map(args => args.includes('config') ? 'config' : args.at(-1)), ['config'], 'only the declaration was read; nothing resolved or started');
    assert.ok(calls[0]!.includes('--env-file') && calls[0]!.includes('--no-env-resolution'), 'interpolation never reads the checkout\'s .env');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:compose-preview-removal-confirmed — a removal the daemon refuses rejects, naming what remains, and succeeds only once nothing of the project is left', async () => {
  let refuse = true;
  const held = { containers: ['c1'], volumes: ['graphyard-preview-gy-1-abcdef12_data'], networks: ['graphyard-preview-gy-1-abcdef12_default'] };
  const docker: Docker = async args => {
    if (args[0] === 'ps') return held.containers.join('\n');
    if (args[0] === 'volume' && args[1] === 'ls') return held.volumes.join('\n');
    if (args[0] === 'network' && args[1] === 'ls') return held.networks.join('\n');
    if (refuse) throw new Error('injected daemon failure');
    held.containers = []; held.volumes = []; held.networks = [];
    return '';
  };
  await assert.rejects(removeComposeProject('graphyard-preview-gy-1-abcdef12', { docker, env: {} }), /was not removed: container c1, volume graphyard-preview-gy-1-abcdef12_data, network graphyard-preview-gy-1-abcdef12_default remain/);
  refuse = false;
  await removeComposeProject('graphyard-preview-gy-1-abcdef12', { docker, env: {} });
  assert.deepEqual(held, { containers: [], volumes: [], networks: [] });
});

test('unit:compose-preview-snapshot — root-relative links resolve under the preview link, and an answer past the byte bound is cut off while it streams', async () => {
  const pages: Record<string, () => Response> = {
    '/': () => new Response('<link href="/assets/app.css"><a href="/about">About</a><a href="//cdn.example/x">x</a>', { headers: { 'content-type': 'text/html' } }),
    '/assets/app.css': () => new Response('body { background: url(/assets/bg.png) }', { headers: { 'content-type': 'text/css' } }),
    '/assets/bg.png': () => new Response('png', { headers: { 'content-type': 'image/png' } }),
    '/about': () => new Response('<img src="/assets/bg.png">', { headers: { 'content-type': 'text/html' } }),
  };
  const site = await snapshotComposeSite('http://127.0.0.1:1', (async (target: URL) => pages[target.pathname]?.() ?? new Response('', { status: 404 })) as typeof fetch);
  const text = Object.fromEntries(site.map(file => [file.path, Buffer.from(file.content, 'base64').toString()]));
  assert.deepEqual(text, { 'about/index.html': '<img src="../assets/bg.png">', 'assets/app.css': 'body { background: url(../assets/bg.png) }', 'assets/bg.png': 'png',
    'index.html': '<link href="./assets/app.css"><a href="./about">About</a><a href="//cdn.example/x">x</a>' });
  let sent = 0;
  const endless = new ReadableStream<Uint8Array>({ pull(controller) { sent += 1 << 20; controller.enqueue(new Uint8Array(1 << 20)); } });
  await assert.rejects(snapshotComposeSite('http://127.0.0.1:1', (async () => new Response(endless, { headers: { 'content-type': 'text/html' } })) as typeof fetch), /larger than the \d+ bytes a preview publishes/);
  assert.ok(sent < 64 << 20, `stopped reading at the bound, not after ${sent} bytes`);
});
