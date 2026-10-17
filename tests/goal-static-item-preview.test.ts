import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer as netServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
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
import { mergeRecordKey, type MergeRecordEvent } from '../src/merge-writer/executor.js';
import { previewCheckoutPrefix } from '../src/merge-writer/preview.js';
import { previewPath, type ItemPreview } from '../src/project-previews.js';
import { defaultChildRun } from '../src/child-runner.js';
import type { Cycle } from '../src/daemon/cycle.js';
import { PreviewPanel } from '../web/pages/work-details.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1902 (GOAL-1, static-item-previews): a change whose criteria cite an E2E case bound to a
// declared static application gets an openable local preview of that exact change, built from the
// coordinator checkout by the loop's own merge-writer step (GY-1718's preview, kept served), its
// declared cases' results recorded on the item and the running site relayed at /preview/KEY.

const operator: Principal = { id: 'operator', role: 'admin' }, coordinator: Principal = { id: 'graphyard', role: 'coordinator' }, worker: Principal = { id: 'worker-1', role: 'worker' };
const tokens = { operator: `operator-${'o'.repeat(40)}`, coordinator: `coordinator-${'c'.repeat(40)}`, worker: `worker-${'w'.repeat(40)}` };
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/fixture', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-fixture', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy', retrials: 1 } } });

let database: EmbeddedPostgres, store: Store, http: ReturnType<typeof server>, url: string, scratch: string, repo: string, base: string;
const shas: Record<string, string> = {};
const freePort = async () => { const probe = netServer(); await new Promise<void>(done => probe.listen(0, '127.0.0.1', done)); const { port } = probe.address() as AddressInfo; await new Promise<void>(done => probe.close(() => done())); return port; };
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = async (path: string, content: unknown) => { await mkdir(join(repo, path, '..'), { recursive: true }); await writeFile(join(repo, path), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`); };

/**
 * The fixture project: graphyard.json declares the static site `site` (built into dist/, the
 * build appending the change's title from GRAPHYARD_PREVIEW_TITLE) and binds fixture-static-home to
 * it; that case reads the served heading. Commits: main, two changes, and a change that breaks it.
 */
async function fixture() {
  const origin = join(scratch, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T'); git('remote', 'add', 'origin', origin);
  await write('graphyard.json', { delivery: { mode: 'local', applications: [{ id: 'site', kind: 'static', directory: 'dist', build: 'mkdir -p dist && cp -R site/. dist/ && printf "<p>%s</p>\\n" "$GRAPHYARD_PREVIEW_TITLE" >> dist/index.html' }], cases: { 'fixture-static-home': 'site' } } });
  await write('e2e/cases/fixture-static-home.json', { id: 'fixture-static-home', title: "The fixture static site's home shows the change", tags: ['fixture', 'preview'], target: 'any', required: false,
    steps: [{ kind: 'http', name: 'read the heading', method: 'GET', path: '/home.json', status: 200, expect: [{ path: 'heading', equals: 'Fixture static site' }] }] });
  const commit = async (name: string, heading: string, body: string) => {
    await write('site/home.json', { heading }); await write('site/index.html', `<h1>${heading}</h1>\n<p>${body}</p>\n`);
    git('add', '-A'); git('commit', '-q', '-m', name); shas[name] = git('rev-parse', 'HEAD');
  };
  await commit('main', 'Fixture static site', 'The base branch');
  git('push', '-q', 'origin', 'main'); git('fetch', '-q', 'origin');
  for (const [name, heading, body] of [['changeA', 'Fixture static site', 'Change A is live'], ['changeA2', 'Fixture static site', 'Change A, second head'], ['broken', 'Something else', 'A broken change']]) {
    git('checkout', '-q', '--detach', shas.main!); await commit(name!, heading!, body!);
  }
  git('checkout', '-q', 'main');
}

before(async () => {
  scratch = await realpath(await temporaryDirectory('goal-static-preview'));
  repo = join(scratch, 'repo'); base = join(scratch, 'worktrees'); await mkdir(base);
  await fixture();
  const port = await freePort();
  database = new EmbeddedPostgres({ databaseDir: join(scratch, 'pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('preview_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/preview_test`); await store.init();
  http = server(new Engine(store, [15368], 120, 'owner/fixture'), [{ ...operator, token: tokens.operator }, { ...coordinator, token: tokens.coordinator }, { ...worker, token: tokens.worker }]);
  await new Promise<void>(done => http.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
after(async () => {
  if (http) await new Promise<void>(done => http.close(() => done()));
  if (store) await store.close(); if (database) await database.stop(); if (scratch) await rm(scratch, { recursive: true, force: true });
});

const call = async (method: string, path: string, as: keyof typeof tokens, body?: unknown, key?: string) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${tokens[as]}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const read = async (id: string): Promise<Work> => { const answer = await call('GET', `work/${id}`, 'operator'); assert.equal(answer.status, 200); return answer.body; };
let created = 0;
async function change(title: string) {
  const answer = await call('POST', 'work', 'operator', { title, description: 'A change whose declared application case needs a local preview of the fixture site.', type: 'feature', priority: 3,
    policy: { checks: ['test'], review: true }, criteria: [{ id: 'AC-1', text: "The fixture site's home heading shows this change", proofs: ['e2e:fixture-static-home'] }] }, `create-${++created}`);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body as Work;
}
/** The item's submitted head moves to `name`'s commit, as a worker's submission records it. */
async function submit(item: Work, name: string) {
  await store.transaction(async (db, now) => {
    const work = (await lockedWork(db, [item.id])).find(entry => entry.id === item.id)!;
    work.candidate = { sha: shas[name]!, baseSha: shas.main!, pr: 100 + created, branch: `graphyard/${work.key.toLowerCase()}-1`, author: 'worker-1' };
    await save(db, work, 'test', 'test.submitted', now);
  });
}

/** The loop's merge-writer step as the daemon wires it, its records written through the server as the coordinator, its snapshot read from the server. */
function loop() {
  const state = emptyDaemonState(config);
  const record = async (work: Pick<Work, 'id' | 'key'>, event: MergeRecordEvent) => {
    const answer = await call('POST', `work/${work.id}/merge-record`, 'coordinator', event, mergeRecordKey(work, event));
    if (answer.status !== 200) throw new Error(`${answer.status}: ${answer.body.error}`);
    return answer.body;
  };
  const reads = { ...mergeWriterReads(config, repo, defaultChildRun, { base, record, merger: async () => 'github', environment: { PATH: process.env.PATH } }), advisory: undefined };
  const step = async (ids: string[]) => {
    const work = await Promise.all(ids.map(read));
    await mergeWriterStep({ state, effects: { mergeWriter: reads, persist: async () => {} }, now: Date.now, snapshot: { work }, performed: [] } as unknown as Cycle);
  };
  return { step };
}
/** Steps the loop until `done` holds of the item read from the server. */
async function until(run: ReturnType<typeof loop>, ids: string[], target: string, done: (preview: ItemPreview | null | undefined, work: Work) => boolean) {
  for (let round = 0; round < 300; round++) {
    await run.step(ids);
    const work = await read(target);
    if (done(work.preview, work)) return work;
    await new Promise(accept => setTimeout(accept, 100));
  }
  assert.fail(`${target}'s preview never settled: ${JSON.stringify((await read(target)).preview)}`);
}
const checkouts = async () => (await readdir(base)).filter(name => name.startsWith(previewCheckoutPrefix) && !name.endsWith('.owner'));
const open = (key: string, path = '') => fetch(`${url}${previewPath(key)}${path}`);

test('integration:goal-static-item-preview — a submitted change citing a declared static application case is previewed automatically: the item names an openable link serving that exact change, its case results are durable on the item, and a failed case leaves no passing preview', { timeout: 120_000 }, async () => {
  const run = loop();
  const item = await change('Static preview of change A');
  await submit(item, 'changeA');
  const work = await until(run, [item.id], item.id, preview => preview?.state === 'running');
  const preview = work.preview!;
  assert.equal(preview.path, `/preview/${item.key}`);
  assert.equal(preview.runner, 'local');
  assert.equal(preview.application, 'site');
  assert.deepEqual({ sha: preview.sha, source: preview.source }, { sha: shas.changeA, source: 'head' }, 'the exact submitted head is previewed');
  assert.deepEqual(preview.cases, [{ case: 'fixture-static-home', result: 'pass' }]);
  assert.match(preview.origin!, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(preview.readyAt && !preview.cleanedAt && !preview.endReason);

  // The link opens without a token and serves that change, built with the item's own title, sandboxed away from the dashboard's origin.
  const served = await open(item.key);
  assert.equal(served.status, 200);
  const page = await served.text();
  assert.match(page, /Change A is live/);
  assert.match(page, /<p>Static preview of change A<\/p>/);
  assert.match(served.headers.get('content-security-policy') ?? '', /^sandbox allow-scripts/);
  assert.deepEqual(await (await open(item.key, '/home.json')).json(), { heading: 'Fixture static site' });
  assert.deepEqual(await (await open(item.key, '//example.com/home.json')).json(), { heading: 'Fixture static site' }, 'a // path stays a path on the preview origin');

  // Durable: the record is the stored document's, as every later read and the coordination snapshot see it.
  assert.deepEqual((await store.workDocument(item.id))!.preview, preview);
  const snapshot = await call('GET', 'work-snapshot?view=coordination', 'coordinator');
  assert.deepEqual(snapshot.body.work.find((entry: Work) => entry.id === item.id).preview, preview);

  // A failed case: the change is built and served, its case fails, the failure is recorded with the case's result and nothing of it stays served.
  const broken = await change('A change that breaks the heading');
  await submit(broken, 'broken');
  const failed = (await until(run, [item.id, broken.id], broken.id, value => value?.state === 'failed')).preview!;
  assert.deepEqual(failed.cases.map(entry => [entry.case, entry.result]), [['fixture-static-home', 'fail']]);
  assert.deepEqual({ origin: failed.origin, endReason: failed.endReason, sha: failed.sha }, { origin: null, endReason: 'failed', sha: shas.broken });
  assert.equal((await open(broken.key)).status, 404, 'a failed preview serves nothing');
  assert.equal((await checkouts()).length, 1, 'only the running preview keeps a checkout');
  // A failed preview is not retried on the same commit, and no passing record can be written over a failing case.
  await run.step([item.id, broken.id]);
  assert.equal((await read(broken.id)).preview!.id, failed.id);
  const forged: ItemPreview = { ...failed, id: crypto.randomUUID(), state: 'running', origin: preview.origin, cleanedAt: null, endReason: null };
  const refused = await call('POST', `work/${broken.id}/merge-record`, 'coordinator', { kind: 'preview', preview: forged }, 'forged-running');
  assert.equal(refused.status, 400);
  assert.ok(refused.body.issues.some((issue: { message: string }) => issue.message === 'a running preview has every declared case passed'));
  assert.equal((await read(broken.id)).preview!.state, 'failed');
  // Settled, the running preview is cleaned up with nothing left behind.
  assert.equal((await call('POST', `work/${item.id}/close`, 'operator', { kind: 'obsolete', reason: 'Previewed' }, 'close-first')).status, 200);
  await until(run, [item.id, broken.id], item.id, value => value?.state === 'cleaned');
  assert.deepEqual(await checkouts(), []);
});

test('integration:goal-static-preview-lifecycle — superseding or cancelling a preview removes its process and checkout and records its final state; Work details show the link, state and case results; workers gain no producer authority', { timeout: 120_000 }, async () => {
  const run = loop();
  const item = await change('Lifecycle of a static preview');
  // Before any head, the base branch is previewed; a submitted head supersedes it.
  const based = (await until(run, [item.id], item.id, preview => preview?.state === 'running')).preview!;
  assert.deepEqual({ sha: based.sha, source: based.source }, { sha: shas.main, source: 'base' });
  await submit(item, 'changeA');
  const first = (await until(run, [item.id], item.id, preview => preview?.state === 'running' && preview.sha === shas.changeA)).preview!;
  assert.deepEqual((await read(item.id)).previewHistory!.map(entry => [entry.id, entry.state, entry.endReason]), [[based.id, 'cleaned', 'superseded']]);

  // Supersession: the head moves, the old preview's server is closed and its checkout removed before the new one is recorded.
  const before = new Set(await checkouts());
  assert.equal(before.size, 1);
  await submit(item, 'changeA2');
  const second = (await until(run, [item.id], item.id, preview => preview?.state === 'running' && preview.sha === shas.changeA2)).preview!;
  const work = await read(item.id);
  const superseded = work.previewHistory!.find(entry => entry.id === first.id)!;
  assert.deepEqual({ state: superseded.state, endReason: superseded.endReason, origin: superseded.origin }, { state: 'cleaned', endReason: 'superseded', origin: null });
  assert.ok(superseded.cleanedAt);
  await assert.rejects(fetch(first.origin!), 'the superseded preview\'s server no longer answers');
  assert.ok(![...before].some(name => existsSync(join(base, name))), 'the superseded checkout is removed');
  assert.ok(!git('worktree', 'list').includes(join(base, [...before][0]!)), 'git forgets the superseded worktree');
  assert.match(await (await open(item.key)).text(), /Change A, second head/);

  // Work details: the link, the state and the actual case results; an ended preview names why.
  const panel = renderToStaticMarkup(createElement(PreviewPanel, { preview: second }));
  for (const text of [`href="/preview/${item.key}"`, 'Running', 'fixture-static-home passed', shas.changeA2!.slice(0, 12), 'site · local runner']) assert.ok(panel.includes(text), text);
  assert.ok(renderToStaticMarkup(createElement(PreviewPanel, { preview: superseded })).includes('Cleaned up · superseded'));

  // No producer authority: a worker cannot write a preview record, and the record is no evidence.
  const denied = await call('POST', `work/${item.id}/merge-record`, 'worker', { kind: 'preview', preview: { ...second, detail: 'forged' } }, 'worker-forged');
  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /Only the loop's coordinator identity records an item's preview/);
  assert.equal(work.evidence.length, 0, 'a preview records no evidence and satisfies no proof');

  // Cancellation: closing the item ends its running preview; the item records it cleaned, the link stops serving.
  const serving = await checkouts();
  assert.equal((await call('POST', `work/${item.id}/close`, 'operator', { kind: 'obsolete', reason: 'The case settles this change' }, 'close-lifecycle')).status, 200);
  const cleaned = (await until(run, [item.id], item.id, preview => preview?.state === 'cleaned')).preview!;
  assert.deepEqual({ id: cleaned.id, endReason: cleaned.endReason, origin: cleaned.origin }, { id: second.id, endReason: 'cancelled', origin: null });
  assert.ok(cleaned.cleanedAt);
  assert.deepEqual(cleaned.cases, second.cases, 'the final state keeps the case results');
  assert.equal((await open(item.key)).status, 404);
  await assert.rejects(fetch(second.origin!));
  assert.ok(!serving.some(name => existsSync(join(base, name))));

  // Cancelling a preview still starting: it is stopped, cleaned and recorded so.
  const early = await change('Cancelled while starting');
  await submit(early, 'changeA');
  await run.step([early.id]);
  assert.equal((await read(early.id)).preview!.state, 'starting');
  assert.equal((await call('POST', `work/${early.id}/close`, 'operator', { kind: 'obsolete', reason: 'Closed while its preview starts' }, 'close-early')).status, 200);
  const stopped = (await until(run, [early.id], early.id, preview => preview?.state === 'cleaned')).preview!;
  assert.equal(stopped.endReason, 'cancelled');

  // A restarted loop backs no record it finds running: it records it cleaned (restarted) and serves the change afresh.
  const restarted = await change('Survives a loop restart');
  await submit(restarted, 'changeA');
  const old = (await until(run, [restarted.id], restarted.id, preview => preview?.state === 'running')).preview!;
  const fresh = loop();
  const renewed = (await until(fresh, [restarted.id], restarted.id, preview => preview?.state === 'running' && preview.id !== old.id)).preview!;
  assert.deepEqual((await read(restarted.id)).previewHistory!.map(entry => [entry.id, entry.endReason]), [[old.id, 'restarted']]);
  assert.match(await (await open(restarted.key)).text(), /Change A is live/);
  assert.equal(renewed.sha, shas.changeA);
  // Settled: closing it ends the live preview of the new loop; the old loop's leftover is reclaimed as the restart's sweep would.
  await call('POST', `work/${restarted.id}/close`, 'operator', { kind: 'obsolete', reason: 'Done with the restart' }, 'close-restarted');
  await until(fresh, [restarted.id], restarted.id, preview => preview?.state === 'cleaned');
  await until(run, [restarted.id], restarted.id, preview => preview?.state === 'cleaned');
  assert.deepEqual(await checkouts(), []);
});
