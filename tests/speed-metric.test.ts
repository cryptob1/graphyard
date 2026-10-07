import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { GitHub } from '../src/github.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { pipelineSpeedSummary, withPipelineTimelines, type PipelineTimeline, type StoredTimeline, type TimelineBackfill } from '../src/pipeline-speed.js';

// GY-1489: master status reads the coordination view, which drops every document's `pipeline`,
// so its speed report measured 0 of 737 deliveries. The timelines are now read on their own
// (GET /api/pipeline-timelines) and attached before the summary runs.

const now = Date.parse('2026-10-07T23:40:00.000Z');
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const finished = (retained = true): TimelineBackfill => ({ at: at(0), source: 'ledger', events: 4, fromEvent: '1', toEvent: '4', retained, truncated: false });

/** A delivered item as the coordination view answers it: no `pipeline`. */
const delivered = (n: number, mergedMinutesAgo: number) =>
  ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, key: `GY-${n}`, stage: 'done', delivery: { mergedAt: at(mergedMinutesAgo), mergeSha: 'a'.repeat(40) } }) as unknown as Work;
/** Its stored timeline: claimed, submitted `submitToMerge` minutes before the merge. */
const timeline = (item: Work, mergedMinutesAgo: number, submitToMerge: number | null, backfill?: TimelineBackfill): StoredTimeline => {
  const submittedAt = submitToMerge === null ? null : at(mergedMinutesAgo + submitToMerge);
  const claimedAt = at(mergedMinutesAgo + (submitToMerge ?? 0) + 20);
  const pipeline: PipelineTimeline = { attempts: [{ epoch: 1, owner: 'worker', claimedAt, endedAt: submittedAt ?? at(mergedMinutesAgo + 5), end: submittedAt ? 'submitted' : 'released' }],
    submittedAt, resubmittedAt: submittedAt, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 }, ...(backfill ? { backfill } : {}) };
  return { id: item.id, pipeline };
};
/** The stubbed plane: the coordination snapshot carries no timelines; `pipeline-timelines` answers them. */
const plane = (timelines: StoredTimeline[]) => {
  const paths: string[] = [];
  return { paths, read: async (path: string) => { paths.push(path); assert.equal(path, 'pipeline-timelines'); return { timelines }; } };
};

test('unit:speed-measured — every delivered item with a submission and a merge is measured, with its submit→merge p50 and p90', async () => {
  // Ten deliveries, submit→merge 10, 20, … 100 minutes: nearest-rank p50 is 50 min, p90 90 min.
  const work = Array.from({ length: 10 }, (_, index) => delivered(index + 1, 30 + index));
  const stored = work.map((item, index) => timeline(item, 30 + index, (index + 1) * 10, finished()));
  const blind = pipelineSpeedSummary(structuredClone(work), now);
  assert.equal(blind.measured, 0, 'the coordination view alone measures nothing: the defect this item fixes');
  assert.equal(blind.unmeasured, 10);

  const { paths, read } = plane(stored);
  assert.deepEqual(await withPipelineTimelines(work, read), { read: 10, attached: 10 });
  assert.deepEqual(paths, ['pipeline-timelines'], 'one read of the timelines, never the ledger');
  const speed = pipelineSpeedSummary(work, now);
  assert.equal(speed.measured, 10, 'measured equals the delivered count');
  assert.equal(speed.unmeasured, 0);
  assert.equal(speed.coverage.delivered, 10);
  assert.equal(speed.coverage.complete, true);
  assert.deepEqual(speed.submitToMerge, { count: 10, p50Ms: 50 * 60_000, p90Ms: 90 * 60_000 });
  assert.deepEqual(speed.routine.submitToMerge, { count: 10, p50Ms: 50 * 60_000, p90Ms: 90 * 60_000 });
  assert.equal(speed.met, false);
  assert.match(speed.reason ?? '', /p50 50 min exceeds 30 min; submit→merge p90 90 min exceeds 60 min/);
});

test('unit:speed-measured — every delivery left unmeasured is named with its reason', async () => {
  const measured = [delivered(1, 10), delivered(2, 20)];
  const pruned = delivered(3, 30), noSubmission = delivered(4, 40), unread = delivered(5, 50), pending = delivered(6, 60);
  const work = [...measured, pruned, noSubmission, unread, pending];
  const stored = [timeline(measured[0], 10, 15, finished()), timeline(measured[1], 20, 25, finished()),
    timeline(pruned, 30, null, finished(false)), timeline(noSubmission, 40, null, finished()),
    timeline(pending, 60, null, { ...finished(), truncated: true })];
  await withPipelineTimelines(work, plane(stored).read);
  const speed = pipelineSpeedSummary(work, now);
  assert.equal(speed.measured, 2);
  assert.deepEqual(speed.submitToMerge, { count: 2, p50Ms: 15 * 60_000, p90Ms: 25 * 60_000 });
  assert.equal(speed.unmeasured, 4);
  assert.deepEqual({ awaitingBackfill: speed.coverage.awaitingBackfill, eventsPruned: speed.coverage.eventsPruned, noSubmission: speed.coverage.noSubmission },
    { awaitingBackfill: 2, eventsPruned: 1, noSubmission: 1 });
  assert.deepEqual(speed.coverage.items.map(entry => [entry.key, entry.coverage]).sort(),
    [['GY-3', 'events-pruned'], ['GY-4', 'no-submission'], ['GY-5', 'awaiting-backfill'], ['GY-6', 'awaiting-backfill']]);
  assert.match(speed.coverage.statement, /^2 of 6 deliveries in this window are measured; 4 are not \(2 awaiting the ledger reconstruction, 1 whose events are no longer retained, 1 the ledger records no submission for\)/);
});

test('unit:speed-measured — a timeline the snapshot already carries stands, and a failed read leaves the snapshot as it was', async () => {
  const item = delivered(1, 10);
  const own = timeline(item, 10, 5, finished()).pipeline;
  const work = [{ ...item, pipeline: own } as Work];
  assert.deepEqual(await withPipelineTimelines(work, plane([timeline(item, 10, 40, finished())]).read), { read: 1, attached: 0 });
  assert.equal(pipelineSpeedSummary(work, now).submitToMerge.p50Ms, 5 * 60_000);

  const bare = [delivered(2, 10)];
  await assert.rejects(withPipelineTimelines(bare, async () => { throw new Error('plane unreachable'); }), /plane unreachable/);
  assert.equal(bare[0].pipeline, undefined);
  assert.equal(pipelineSpeedSummary(bare, now).coverage.awaitingBackfill, 1);
});

const cleanup: (() => Promise<unknown>)[] = [];
after(async () => { for (const step of cleanup.reverse()) await step().catch(() => {}); });
const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
});

test('integration:speed-timelines-read — GET /api/pipeline-timelines answers the timelines the coordination view drops, and they measure the item', async () => {
  const port = await freePort();
  const database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('speed-metric'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); cleanup.push(() => database.stop());
  await database.createDatabase('graphyard_test');
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init(); cleanup.push(() => store.close());
  const engine = new Engine(store, [15368], 120, 'owner/project');
  engine.submissionObserver = null;
  const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' }, implementer: Principal = { id: 'implementer', role: 'worker' };
  const http = server(engine, [{ ...operator, token: 'o'.repeat(32) }, { ...implementer, token: 'w'.repeat(32) }, { id: 'master', role: 'coordinator', token: 'm'.repeat(32) }],
    { config: { repository: 'owner/project', appId: 1234, installationId: 1, base: 'main' } } as unknown as GitHub);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve)); cleanup.push(() => new Promise(resolve => http.close(resolve)));
  const base = `http://127.0.0.1:${(http.address() as { port: number }).port}/api/`;
  const read = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, { headers: { Authorization: `Bearer ${'m'.repeat(32)}`, ...headers } });
    assert.equal(response.status, 200, `GET /api/${path}`); return response.json();
  };

  const criteria = [{ id: 'AC-1', text: 'Measured', proofs: ['unit:speed-measured'] }];
  let item = await engine.execute(operator, 'create', null, { title: 'Timed item', plannedFiles: ['src/pipeline-speed.ts'], criteria }, randomUUID());
  item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
  item = await engine.execute(implementer, 'claim', item.id, {}, randomUUID());
  item = await engine.execute(implementer, 'workspace', item.id, { epoch: item.epoch, host: 'machine-a', path: `/tmp/speed/${item.id}`, branch: 'graphyard/timed-1' }, randomUUID());
  item = await engine.execute(implementer, 'submit', item.id, { epoch: item.epoch, pr: 7 }, randomUUID());

  const coordination = await read('work-snapshot', { 'X-Graphyard-View': 'coordination' });
  const work: Work[] = coordination.work;
  assert.equal(work.find(entry => entry.id === item.id)?.pipeline, undefined, 'the coordination view master status reads carries no timeline');
  const answer = await read('pipeline-timelines');
  const entry = answer.timelines.find((timeline: { id: string }) => timeline.id === item.id);
  assert.equal(entry.key, item.key);
  assert.equal(entry.pipeline.submittedAt, item.pipeline!.submittedAt);
  assert.equal(entry.pipeline.attempts.length, 1);
  assert.equal(entry.pipeline.backfill?.resume, undefined, 'an unfinished replay state is never answered');
  assert.deepEqual(await withPipelineTimelines(work, async path => read(path)), { read: answer.timelines.length, attached: answer.timelines.length });
  // Delivered as the ledger records a merge: the attached timeline measures it.
  const merged = work.find(candidate => candidate.id === item.id)! as Work & { delivery: unknown };
  Object.assign(merged, { stage: 'done', delivery: { mergedAt: new Date(Date.parse(item.pipeline!.submittedAt!) + 12 * 60_000).toISOString(), mergeSha: 'b'.repeat(40) } });
  const speed = pipelineSpeedSummary(work, Date.now());
  assert.equal(speed.measured, 1);
  assert.deepEqual(speed.submitToMerge, { count: 1, p50Ms: 12 * 60_000, p90Ms: 12 * 60_000 });
});
