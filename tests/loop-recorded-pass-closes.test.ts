import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { masterConfigSchema } from '../src/master.js';
import { emptyDaemonState, type DaemonEffects } from '../src/master-daemon.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { Principal, Work } from '../src/model.js';
import type { Services } from '../src/server/routes.js';
import { statusRoutes } from '../src/server/routes/status.js';
import { buildMasterStatus } from '../src/master/status.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1820: GY-1688 held two trusted passing readings recorded by hand through the coordinator's `reading`
// command, and the loop still read it as due. The loop and master status read the coordination view of the
// work snapshot, and that view kept an item's evidence only when it bound the item's candidate or a requested
// head: a loop-owned observation item has no candidate, so every recorded reading was cut before the loop saw
// it and observationPass found none. Here the reading goes through the real route against Postgres, with the
// parent delivered and settled before it, and the loop's readings step closes the item on the reading's
// release. The instants are the fixture's own clock: the cycle and the close are handed `now`.
const hour = 3_600_000, now = Date.parse('2026-10-15T05:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const filed = sha('a'), recordedOn = sha('b'), servedNow = sha('d'), mergeSha = sha('c');
const proof = 'manual:post-deploy/reclaim-pressure-below-false', own = 'manual:reclaim-pressure-below-false-on-serving-release';
const repository = 'owner/recorded-pass';
const operator: Principal = { id: 'recorded-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'recorded-master', role: 'coordinator', sessionKind: 'ai' };

let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1820;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('recorded-pass-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('recorded_pass_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/recorded_pass_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null;
});
after(async () => { await store?.close(); await database?.stop(); });

const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
/** An item created through the engine, then written as the control plane would have left it. */
async function plant(shape: Partial<Work>): Promise<Work> {
  const created = await engine.execute(operator, 'create', null, { title: shape.title ?? 'Planted', criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:recorded'] }] }, randomUUID()) as Work;
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [created.id, JSON.stringify({ ...created, ...shape, id: created.id, key: created.key })]);
  return reload(created.id);
}
/** The close path's services with the store's transactions handed the fixture's `now`. */
function clockedServices(): Services {
  const clocked = Object.assign(Object.create(engine), { store: Object.assign(Object.create(store), {
    transaction: (fn: Parameters<Store['transaction']>[0], options?: Parameters<Store['transaction']>[1]) => store.transaction((db, _at) => fn(db, new Date(now)), options),
  }) as Store });
  return { engine: clocked, github: { closeSupersededPullRequest: async () => 'closed' as const }, repository, principals: [] } as unknown as Services;
}
/** GET /api/work-snapshot as the loop asks for it: the coordination view, served by the real route over the store. */
async function coordinationView(): Promise<{ work: Work[]; now: string }> {
  const route = statusRoutes.routes.find(entry => entry.method === 'GET' && entry.path === '/api/work-snapshot')!;
  const view = await route.handle({ actor: coordinator, req: { headers: {} }, url: new URL('http://graphyard.test/api/work-snapshot?view=coordination'), services: clockedServices(), operatorVisible: <T>(items: T[]) => items } as never, []) as { work: Work[] };
  return { ...view, now: iso(now) };
}

test('unit:loop-recorded-pass-closes — a passing reading recorded through the coordinator\'s reading command on an earlier release closes the loop-owned item as delivered-observation on that release, read through the coordination view the loop polls', async () => {
  // The parent, delivered and settled before any reading: the coordination view serves it as the work index's summary.
  const parent = await plant({ title: 'Reclaim pressure', stage: 'done', ready: true, lease: null, nextAction: null, sessions: [], actionQueue: { actions: [], history: [] },
    criteria: [{ id: 'AC-5', text: 'The reclaim reports pressure below=false', proofs: [proof] }],
    delivery: { mergeSha, mergedAt: iso(now - 30 * hour), deployment: { sha: filed, mergeSha, source: 'endpoint', observedAt: iso(now - 20 * hour), covers: 'descendant', at: iso(now - 20 * hour), observer: 'graphyard-master' } } } as unknown as Partial<Work>);
  assert.equal((await store.pool.query('SELECT settled FROM work_index WHERE id=$1', [parent.id])).rows[0].settled, true, 'the parent is a settled delivery before the reading');
  const item = await plant({ title: 'Reclaim pressure on the serving release', stage: 'ready', ready: true, systemDriven: true, lease: null, blocker: null, candidate: null, dependencies: [], evidence: [], sessions: [], actionQueue: { actions: [], history: [] },
    description: `Post-deploy follow-up: post-deploy:${parent.id}:AC-5:${proof}:${filed}\n\nowed`,
    criteria: [{ id: 'AC-1', text: `From this head against the serving release ${filed.slice(0, 12)}: pressure below=false`, proofs: [own] }] } as unknown as Partial<Work>);
  // The pass recorded by hand, through the coordinator's `reading` command, on a release the plane has since moved past.
  await engine.execute(coordinator, 'reading', item.id, { proof: own, sha: recordedOn, baseSha: mergeSha, policyRevision: item.policyRevision, result: 'pass', detail: 'pressure below=false on the live host' }, randomUUID());

  const before = await coordinationView();
  const seen = before.work.find(entry => entry.id === item.id)!;
  assert.ok(seen.evidence.some(entry => entry.proof === own && entry.sha === recordedOn && entry.reading), 'the coordination view keeps the recorded reading of a candidate-less loop-owned item');
  const pending = buildMasterStatus(before, [], []).pendingReadings.find(entry => entry.key === item.key);
  assert.ok(pending, 'master status lists the item until it closes');
  assert.equal(pending.passedOn, recordedOn, 'master status reads the recorded pass, not a due reading');

  const directory = await temporaryDirectory('recorded-pass-loop');
  const token = join(directory, 'coordinator.token');
  await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: join(directory, 'graphyard.mjs'), repository, baseBranch: 'main',
    githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], run: { deploymentReuseMinutes: 0 } });
  const { closeWork } = await import('../src/server/close.js');
  const reads: string[] = [];
  const effects = {
    persist: async () => {},
    recordReading: async () => { throw new Error('a recorded pass is never read again'); },
    readPostDeploy: async () => { reads.push('read'); return { unavailable: 'cannot be taken from this host' }; },
    closeObservation: (work: Work, release: string, reason: string, key: string) => closeWork(clockedServices(), coordinator, work.id, { kind: 'delivered-observation', reason, ref: release }, key),
  } as unknown as DaemonEffects;
  const cycle = { config, state: emptyDaemonState(config), effects, now: () => now, clock: now, clockOffset: { min: 0, max: 0 }, performed: [], snapshot: before, open: before.work.filter(entry => entry.stage !== 'done'),
    isolate: async (_kind: string, _item: unknown, _name: string, body: () => Promise<unknown>) => body() } as unknown as Cycle;
  const { readingsStep } = await import('../src/daemon/cycle-readings.js');
  const served = { source: 'endpoint', sha: servedNow, at: iso(now - 60_000), reason: null, deployed: [parent.key], pending: [], requests: 1 } as never;
  await readingsStep(cycle, served, now + hour);

  const closed = await reload(item.id);
  assert.equal(closed.stage, 'done', 'the next cycle closes the item');
  assert.equal(closed.closure?.kind, 'delivered-observation');
  assert.equal(closed.closure?.ref, recordedOn, 'closed on the release its reading was taken on, not the release served now');
  assert.deepEqual(reads, [], 'no further reading is taken');
  const afterClose = await coordinationView();
  assert.equal(buildMasterStatus(afterClose, [], []).pendingReadings.some(entry => entry.key === item.key), false, 'master status no longer lists it among pending readings');
});
