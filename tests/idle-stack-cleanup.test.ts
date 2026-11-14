import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Docker } from '../src/compose-preview.js';
import { itemPreviewStep, type ItemPreviewPorts, type LivePreview, type OpenedPreview } from '../src/merge-writer/preview.js';
import { applyPreviewRecord, previewRecordBodySchema, type ItemPreview } from '../src/project-previews.js';
import type { ProjectDelivery } from '../src/project-applications.js';
import type { Principal, Work } from '../src/model.js';
import { processPidNamespace, processStartTicks, type TempOwner } from '../src/tmp-reclaim.js';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workFixture } from './helpers/work-fixture.js';

// GY-3291: idle Graphyard previews and abandoned temporary stacks are stopped on a shared host,
// with `docker stop` only, while active previews, live jobs, installed services, foreign containers
// and the shared builder keep running. The idle-stacks module is loaded by the test so a tree
// without it fails here as a test case.
const idleStacks = () => import('../src/idle-stacks.js').catch(() => assert.fail('src/idle-stacks.ts is missing: nothing stops idle Graphyard stacks'));

const minute = 60_000, t0 = Date.parse('2030-06-01T00:00:00Z'), iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const made: string[] = [];
after(async () => { for (const directory of made) await rm(directory, { recursive: true, force: true }); });

/** This process as an owner label records it: alive. A pid no process holds: gone. */
const liveOwner = (): TempOwner => ({ pid: process.pid, startedAt: processStartTicks(process.pid), pidNamespace: processPidNamespace(), at: iso(t0) });
const deadOwner = (): TempOwner => ({ pid: 99_999_999, startedAt: 1, pidNamespace: processPidNamespace(), at: iso(t0) });

interface Container { id: string; project: string; owner: TempOwner | null; running: boolean; volume?: string }
/** The Docker CLI over a controlled container inventory: `ps` (running, or `--all`, by project), `stop`, and `compose down`; every call recorded. */
function fakeDocker(containers: Container[]) {
  const calls: string[][] = [];
  const docker: Docker = async args => {
    calls.push(args);
    const project = args.find(arg => arg.startsWith('label=com.docker.compose.project='))?.split('=')[2];
    if (args[0] === 'ps') {
      const listed = containers.filter(entry => (args.includes('--all') || entry.running) && (!project || entry.project === project) && (!args.includes('label=com.docker.compose.project') || entry.project));
      if (args.includes('--quiet')) return listed.map(entry => entry.id).join('\n');
      const format = args[args.indexOf('--format') + 1]!;
      return listed.map(entry => format.replace('{{.ID}}', entry.id).replace('{{.Label "com.docker.compose.project"}}', entry.project)
        .replace('{{.Label "graphyard.preview.owner"}}', entry.owner ? JSON.stringify(entry.owner) : '')).join('\n');
    }
    if (args[0] === 'stop') { for (const id of args.slice(3)) containers.find(entry => entry.id === id)!.running = false; return ''; }
    if (args[0] === 'compose' && args.includes('down')) { const named = args[args.indexOf('-p') + 1]; containers.splice(0, containers.length, ...containers.filter(entry => entry.project !== named)); return ''; }
    return '';
  };
  return { docker, calls, stops: () => calls.filter(call => call[0] === 'stop').flatMap(call => call.slice(3)) };
}
/** What every host keeps beside Graphyard's own stacks: an installed control plane and its database, a foreign Compose project, an unlabelled preview-named one and the shared BuildKit builder. */
const untouchable = (): Container[] => [
  { id: 'server', project: 'graphyard-cryptob1-graphyard', owner: null, running: true },
  { id: 'database', project: 'graphyard-cryptob1-graphyard', owner: null, running: true, volume: 'graphyard-cryptob1-graphyard_db' },
  { id: 'huck', project: 'hello-huck', owner: null, running: true },
  { id: 'openworld', project: 'cryptob1-graphyard-openworld', owner: null, running: true },
  { id: 'unowned', project: 'graphyard-preview-gy-1-unowned', owner: null, running: true },
  { id: 'builder', project: '', owner: null, running: true },
];
const destructive = (calls: string[][]) => calls.filter(call => call.some(arg => /^(rm|prune|down|--volumes|-v)$/.test(arg)) || call.includes('volume'));

test('unit:idle-stack-cleanup — the cleanup decision and its Docker adapter stop an expired unused preview and an abandoned temporary stack with docker stop, keep an accessed preview, one under review, a live trial stack, installed services, foreign, unowned and builder containers, and repeating it stops nothing and removes no volume', async () => {
  const { stackDecisions, stopIdleStacks, previewIdleMs } = await idleStacks();
  assert.equal(previewIdleMs({}), 30 * minute, 'previews idle out after 30 minutes by default');
  assert.equal(previewIdleMs({ GRAPHYARD_PREVIEW_IDLE_MINUTES: '45' }), 45 * minute);
  const containers: Container[] = [
    ...untouchable(),
    { id: 'idle-web', project: 'graphyard-preview-gy-57-f19d1670', owner: liveOwner(), running: true },
    { id: 'idle-db', project: 'graphyard-preview-gy-57-f19d1670', owner: liveOwner(), running: true, volume: 'gy-57-db' },
    { id: 'used-web', project: 'graphyard-preview-gy-58-aaaaaaaa', owner: liveOwner(), running: true },
    { id: 'reviewed-web', project: 'graphyard-preview-gy-59-bbbbbbbb', owner: liveOwner(), running: true },
    { id: 'trial-db', project: 'graphyard-preview-trial-services-gy-60-cccccccc', owner: liveOwner(), running: true },
    { id: 'left-db', project: 'graphyard-preview-trial-services-gy-61-dddddddd', owner: deadOwner(), running: true },
  ];
  const previews = new Map([
    ['graphyard-preview-gy-57-f19d1670', { key: 'GY-57', lastUsedAt: t0, inUse: false }],
    ['graphyard-preview-gy-58-aaaaaaaa', { key: 'GY-58', lastUsedAt: t0 + 25 * minute, inUse: false }],
    ['graphyard-preview-gy-59-bbbbbbbb', { key: 'GY-59', lastUsedAt: t0, inUse: true }],
  ]);
  const now = t0 + 31 * minute, { docker, calls, stops } = fakeDocker(containers);
  const stopped = await stopIdleStacks(previews, { now, idleMs: 30 * minute, docker, env: {} });
  assert.deepEqual(stopped.map(entry => entry.project), ['graphyard-preview-gy-57-f19d1670', 'graphyard-preview-trial-services-gy-61-dddddddd']);
  assert.match(stopped[0]!.reason, /^idle: GY-57's preview, last used 2030-06-01T00:00:00.000Z, unused for 31 min$/);
  assert.match(stopped[1]!.reason, /^abandoned: its owner pid 99999999 is gone$/);
  assert.deepEqual(stops().sort(), ['idle-db', 'idle-web', 'left-db']);
  assert.deepEqual(containers.filter(entry => entry.running).map(entry => entry.id).sort(), ['builder', 'database', 'huck', 'openworld', 'reviewed-web', 'server', 'trial-db', 'unowned', 'used-web']);
  const kept = Object.fromEntries(stackDecisions(containers.map(entry => ({ ...entry })), previews, { now, idleMs: 30 * minute }).filter(entry => !entry.stop).map(entry => [entry.project, entry.reason]));
  assert.equal(kept['graphyard-preview-gy-58-aaaaaaaa'], "GY-58's preview, last used 2030-06-01T00:25:00.000Z");
  assert.match(kept['graphyard-preview-gy-59-bbbbbbbb']!, /in use by a review$/);
  assert.match(kept['graphyard-preview-trial-services-gy-60-cccccccc']!, /^its owner pid \d+ still runs$/);
  for (const project of ['graphyard-cryptob1-graphyard', 'hello-huck', 'cryptob1-graphyard-openworld', 'graphyard-preview-gy-1-unowned', '']) assert.equal(kept[project], 'not a Graphyard stack', `${project || 'the builder'} is never Graphyard's to stop`);

  // Reconciling again, later, finds nothing new to stop: what it stopped is no longer running.
  assert.deepEqual(await stopIdleStacks(previews, { now: now + 2 * minute, idleMs: 30 * minute, docker, env: {} }), []);
  assert.deepEqual(stops().sort(), ['idle-db', 'idle-web', 'left-db'], 'repeating reconciliation stops nothing again');
  assert.deepEqual(destructive(calls), [], 'no container, volume or network is removed and nothing is pruned');
  assert.equal(containers.length, 13 - 1, 'every container is still there');
});

const delivery: ProjectDelivery = { mode: 'local', previews: 'local', candidateMaxChanges: 5, productionVerification: true, source: 'graphyard.json',
  applications: [{ id: 'app', kind: 'compose', file: 'compose.yaml', service: 'web', port: 80 } as ProjectDelivery['applications'][number]], cases: { 'app-home': 'app' } };
const item = (n: number): Work => workFixture({ id: randomUUID(), key: `GY-${n}`, title: `Item ${n}`, stage: 'build', priority: 1, criteria: [{ id: 'AC-1', text: 'The home shows the change', proofs: ['e2e:app-home'] }],
  candidate: { sha: sha(`head${n}`), baseSha: sha('base'), pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' }, submission: { epoch: 1, pr: n } });

/** The loop's preview ports over the fake daemon: `open` brings up a passing Compose preview whose two containers carry `owner`, and `record` applies records as the server does. */
function previewWorld(work: Work[], containers: Container[], docker: Docker, now: () => number) {
  const opened: { project: string; closed: boolean }[] = [];
  let owner = liveOwner;
  const ports = (root: string): ItemPreviewPorts => ({ root, base: root, timeoutMs: 30_000, delivery: () => delivery, baseTip: async () => sha('base'), now, docker, procRoot: undefined,
    hostEnvironment: { PATH: process.env.PATH ?? '' },
    record: async (target, preview: ItemPreview, site) => {
      previewRecordBodySchema.parse({ kind: 'preview', preview, ...(site ? { site } : {}) });
      const refusal = applyPreviewRecord(work.find(entry => entry.id === target.id)!, preview);
      if (refusal) throw new Error(`409: ${refusal}`);
      return { recorded: true };
    },
    open: async input => {
      const project = input.compose!.project, entry = { project, closed: false };
      opened.push(entry);
      containers.push({ id: `${project}-web`, project, owner: owner(), running: true }, { id: `${project}-db`, project, owner: owner(), running: true, volume: `${project}_db` });
      return { verdict: { result: 'pass', mergeSha: input.mergeSha, cases: [{ case: 'app-home', verdict: 'passed', required: true }], failed: [], detail: 'served', durationMs: 1 }, url: 'http://127.0.0.1:41000',
        publish: async () => [{ path: 'index.html', mediaType: 'text/html', content: Buffer.from('<p>home</p>').toString('base64') }],
        close: async () => { entry.closed = true; await docker(['compose', '-p', project, 'down', '--volumes'], { env: {}, timeoutMs: 1 }); } } satisfies OpenedPreview;
    } });
  return { ports, opened, ownedBy: (make: () => TempOwner) => { owner = make; } };
}
const settled = async (work: Work[], keys: string[], state: string) => {
  for (let waited = 0; waited < 5_000; waited += 5) { if (keys.every(key => work.find(entry => entry.key === key)!.preview?.state === state)) return; await new Promise(accept => setTimeout(accept, 5)); }
  assert.fail(`${keys.join(', ')} reach ${state}`);
};

test('unit:idle-stack-cleanup — the loop stops an item preview nobody opened for 30 minutes, keeps one opened through its link and one under review, records it ended idle with its last use, restarts and serves it once its link is opened, and after a loop restart resumes cleanup without touching a live trial', async () => {
  await idleStacks();
  const root = await realpath(await temporaryDirectory('idle-stack-cleanup')); made.push(root);
  await mkdir(join(root, 'worktrees'), { recursive: true });
  let now = t0;
  const work = [item(57), item(58), item(59)], containers: Container[] = [...untouchable(), { id: 'trial-db', project: 'graphyard-preview-trial-services-gy-60-cccccccc', owner: liveOwner(), running: true }];
  const { docker, calls, stops } = fakeDocker(containers), world = previewWorld(work, containers, docker, () => now);
  const ports = world.ports(join(root, 'worktrees'));
  const byKey = (key: string) => work.find(entry => entry.key === key)!;
  let live = new Map<string, LivePreview>();
  const log: string[] = [], print = console.log;
  console.log = (...args: unknown[]) => { log.push(args.join(' ')); };
  try {
    await itemPreviewStep(live, work, ports);
    await settled(work, ['GY-57', 'GY-58', 'GY-59'], 'running');
    const first = byKey('GY-57').preview!;

    // GY-58's link is opened 25 minutes in (the server's `lastUsedAt`); GY-59 is under review; a trial's services are left by a process that died.
    byKey('GY-58').preview = { ...byKey('GY-58').preview!, lastUsedAt: iso(t0 + 25 * minute) };
    byKey('GY-59').sessions = [{ id: 'review-1', kind: 'review', state: 'running' } as NonNullable<Work['sessions']>[number]];
    containers.push({ id: 'left-db', project: 'graphyard-preview-trial-services-gy-61-dddddddd', owner: deadOwner(), running: true });
    now = t0 + 31 * minute;
    const notes = await itemPreviewStep(live, work, ports);
    const project57 = world.opened[0]!.project;
    assert.deepEqual(stops().sort(), [`${project57}-db`, `${project57}-web`, 'left-db'], 'only the unused preview and the abandoned stack are stopped');
    assert.ok(log.some(line => line.startsWith(`Stopped ${project57} (idle: GY-57's preview, last used ${iso(first.readyAt ? Date.parse(first.readyAt) : t0)}, unused for 31 min); its containers and volumes are kept`)), 'the log names the stop, its reason, last use and owner');
    assert.ok(notes.some(line => /^Stopped graphyard-preview-trial-services-gy-61-dddddddd \(abandoned: its owner pid 99999999 is gone\)/.test(line)));
    const idle = byKey('GY-57').preview!;
    assert.equal(idle.state, 'cleaned'); assert.equal(idle.endReason, 'idle'); assert.equal(idle.id, first.id);
    assert.match(idle.detail, /stopped after 30 minutes unused: open the preview link to restart it/);
    assert.equal(world.opened[0]!.closed, false, 'the stopped preview is not removed: its volumes stay');
    assert.equal(byKey('GY-58').preview!.state, 'running', 'an opened preview keeps running');
    assert.equal(byKey('GY-58').preview!.lastUsedAt, iso(t0 + 25 * minute), 'the loop\'s records keep the link\'s last use');
    assert.equal(byKey('GY-59').preview!.state, 'running', 'a preview under review keeps running');

    // Repeating changes nothing, and an idle preview nobody asks for is not started again.
    now = t0 + 33 * minute;
    await itemPreviewStep(live, work, ports);
    assert.equal(stops().length, 3); assert.equal(world.opened.length, 3, 'nothing is started again');

    // Opening the idle preview's link (the server writes `lastUsedAt` past its end) restarts it and it serves again.
    byKey('GY-57').preview = { ...idle, lastUsedAt: iso(t0 + 40 * minute) };
    now = t0 + 40 * minute;
    await itemPreviewStep(live, work, ports);
    await settled(work, ['GY-57'], 'running');
    assert.notEqual(byKey('GY-57').preview!.id, first.id, 'a new preview serves the link');
    assert.equal(world.opened[0]!.closed, true, 'the stopped stack is replaced by the new one');
    assert.equal(byKey('GY-57').previewHistory?.at(-1)?.endReason, 'idle');

    // The loop restarts: its previews' owner is gone, the trial's live process is not. Cleanup resumes from the labels and the persisted records.
    for (const entry of containers) if (entry.owner?.pid === process.pid && entry.project !== 'graphyard-preview-trial-services-gy-60-cccccccc') entry.owner = deadOwner();
    world.ownedBy(liveOwner);
    live = new Map();
    const before = stops().length;
    now = t0 + 50 * minute;
    await itemPreviewStep(live, work, ports);
    now = t0 + 52 * minute;
    await itemPreviewStep(live, work, ports);
    await settled(work, ['GY-57', 'GY-58', 'GY-59'], 'running');
    const touched = [...stops().slice(before), ...calls.filter(call => call[0] === 'compose' && call.includes('down')).map(call => call[call.indexOf('-p') + 1]!)];
    assert.ok(!touched.some(name => name.startsWith('trial-db') || name === 'graphyard-preview-trial-services-gy-60-cccccccc'), 'the live trial\'s stack is never touched');
    assert.ok(containers.find(entry => entry.id === 'trial-db')!.running, 'the live trial keeps running');
    for (const id of ['server', 'database', 'huck', 'openworld', 'unowned', 'builder']) assert.ok(containers.find(entry => entry.id === id)!.running, `${id} keeps running`);
    for (const key of ['GY-57', 'GY-58', 'GY-59']) assert.equal(byKey(key).previewHistory?.at(-1)?.endReason, 'restarted', `${key}'s dead loop's preview is recorded ended and a new one serves`);
    assert.ok(!containers.some(entry => entry.owner?.pid === 99_999_999 && entry.running), 'no stack of a gone owner keeps running');
  } finally { console.log = print; }
});

test('unit:idle-stack-cleanup — opening a running preview\'s link renews its last use at most once a minute, and opening a preview stopped idle records the request and answers a page that reloads until it serves again', async () => {
  const { staticRoutes } = await import('../src/server/static.js');
  const { Engine } = await import('../src/engine.js');
  const { save } = await import('../src/store.js');
  const store = await withDatabase('idle-stack-cleanup'); await store.init();
  try {
    const engine = new Engine(store, 120, 'owner/project'), operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
    const created = await engine.execute(operator, 'create', null, { type: 'feature', title: 'Previewed', criteria: [{ id: 'AC-1', text: 'Shown', proofs: ['e2e:app-home'] }] }, randomUUID()) as Work;
    const at = iso(Date.now() - 40 * minute), id = randomUUID();
    const running: ItemPreview = { id, path: `/preview/${created.key}`, state: 'running', runner: 'local', application: 'app', sha: sha('head'), source: 'head', origin: 'http://127.0.0.1:41000',
      cases: [{ case: 'app-home', result: 'pass' }], detail: '', startedAt: at, readyAt: at, cleanedAt: null, endReason: null };
    const put = (preview: ItemPreview) => store.transaction(async (db, now) => {
      const { lockedWork } = await import('../src/store/locked-read.js');
      const doc = (await lockedWork(db, [created.id])).find(entry => entry.id === created.id)!;
      doc.preview = preview; await save(db, doc, 'test', 'preview.test', now);
    });
    await put(running);
    await store.pool.query('INSERT INTO item_preview_files(preview_id,work_id,path,media_type,bytes) VALUES ($1,$2,$3,$4,$5)', [id, created.id, 'index.html', 'text/html', Buffer.from('<p>home</p>')]);
    const route = staticRoutes.routes.find(entry => entry.path instanceof RegExp && entry.path.test(`/preview/${created.key}/`))!;
    const open = async () => {
      const response = { status: 0, body: '', headers: {} as Record<string, unknown>, setHeader(name: string, value: unknown) { this.headers[name] = value; }, writeHead(status: number, headers?: Record<string, unknown>) { this.status = status; Object.assign(this.headers, headers); },
        end(body?: unknown) { this.body = body === undefined ? '' : String(body); } };
      const url = new URL(`http://localhost/preview/${created.key}/`);
      await route.handle({ req: { method: 'GET', headers: {} }, res: response, url, services: { engine } } as never, [created.key, '/']);
      return response;
    };
    const used = async () => (await store.workDocument(created.key))!.preview!.lastUsedAt;

    assert.equal((await open()).status, 200);
    const first = await used();
    assert.ok(first && Date.now() - Date.parse(first) < minute, 'opening the link records its use');
    assert.equal((await open()).status, 200);
    assert.equal(await used(), first, 'a second open within the minute writes nothing');

    // Stopped idle: the link records the request once and answers a reloading page.
    const cleanedAt = iso(Date.now() - minute);
    await put({ ...running, state: 'cleaned', origin: null, cleanedAt, endReason: 'idle', lastUsedAt: iso(Date.now() - 35 * minute) });
    await store.pool.query('DELETE FROM item_preview_files WHERE preview_id=$1', [id]);
    const stopped = await open();
    assert.equal(stopped.status, 503);
    assert.match(stopped.body, /<meta http-equiv="refresh" content="15">/);
    assert.match(stopped.body, /preview stopped after going unused\. It is starting again/);
    const requested = await used();
    assert.ok(requested && Date.parse(requested) > Date.parse(cleanedAt), 'the request is recorded after the stop, which the loop reads as restart it');
    await open();
    assert.equal(await used(), requested, 'a pending request is written once');
  } finally { await store.close(); }
});
