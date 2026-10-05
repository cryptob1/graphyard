import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { observationBand } from '../src/github.js';
import { defaultParallelTips, describeTipWindow, maxParallelTips, mergeParallelTipsEvent, mergeQueueInsights, predictQueue, queueRef, windowBatchView } from '../src/merge-queue.js';
import { server } from '../src/server.js';
import { daemonEffects } from '../src/master-daemon.js';
import { buildMasterStatus, masterConfigSchema } from '../src/master.js';
import { mergeParallelTips, mergeQueueStatus } from '../src/master/profiles.js';
import { computeFlow, queueWait, type FlowDataset, type FlowFact } from '../src/flow-analytics.js';
import type { Work } from '../src/model.js';
import { prSteps } from '../src/model/pr-steps.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LandedPerDay } from '../web/pages/insights-flow.js';

// GY-498: the merge queue validates speculative tips for the first `mergeQueue.parallelTips`
// positions at once instead of one combined tip at a time. Each test is named for the proof it
// produces.
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const keys = ['GY-1', 'GY-2', 'GY-3', 'GY-4', 'GY-5', 'GY-6'];
const CI_APP = 15368;

// GitHub delivery is the only delivery (GY-1235): evaluate places no candidate in a Graphyard merge
// queue, so the queue simulations that validated speculative tips through it are gone; what remains
// is the window's reporting, configuration and observation band over a recorded tip chain.
// A four-entry validated chain, tips published on the one ahead, with CI states per tip.
const now = Date.parse('2026-09-25T09:00:00.000Z'), at = '2026-09-25T08:00:00.000Z';
const B0 = sha40('b0'), tip = (index: number) => sha40(`c${index + 1}`);
const pass = { name: 'test', result: 'success', appId: CI_APP }, running = { name: 'test', result: 'in_progress', appId: CI_APP }, failing = { name: 'test', result: 'failure', appId: CI_APP };
function entry(index: number, checks: object[], overrides: Partial<Work> = {}): Work {
  const key = keys[index], sha = tip(index), baseSha = index === 0 ? B0 : tip(index - 1), branch = `graphyard/${key.toLowerCase()}-1`;
  const candidate = { sha, baseSha, pr: 100 + index, branch, author: 'implementer' };
  return { id: `id-${key}`, key, title: key, description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, stage: 'merge', revision: 3, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    workspaces: [], candidate, submission: { epoch: 1, pr: 100 + index }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [],
    observation: { clockOffset: { min: 0, max: 0 }, candidate, baseTip: B0, checks, reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, files: [], scopeFiles: [], at: new Date(now).toISOString() },
    queue: { sequence: index + 1, enqueuedAt: at, policyRevision: 1, speculation: { ref: queueRef(key), tip: sha, base: baseSha, baseTree: sha40(`e${index}`), tipTree: sha40(`t${index}`), predecessors: keys.slice(0, index), policyRevision: 1, publishedAt: at, reviewedHead: sha40(`a${index + 1}`) } },
    queueSequence: index + 1,
    gates: [{ name: 'merge', passed: false, reasons: [`Merge queue is validating speculative tip ${sha.slice(0, 12)}: Required CI check test has not passed on the current candidate`] }], ...overrides } as unknown as Work;
}

test('unit:parallel-tips-visible — status shows each in-flight tip (position, entries, CI state), the dashboard names the window, and status reports merges per hour and median queue wait', () => {
  const all = [entry(0, [pass]), entry(1, [pass]), entry(2, [failing]), entry(3, [running])];
  const placements = predictQueue(all, now), window = 4;
  // The in-flight tips as master status reports them: position, entries, tip, CI state.
  const tips = mergeQueueInsights(all, now, window, [CI_APP]).tips;
  assert.deepEqual(tips.map(tip => [tip.position, tip.entries, tip.ci]), [
    [1, ['GY-1'], 'pass'], [2, ['GY-1', 'GY-2'], 'pass'], [3, ['GY-1', 'GY-2', 'GY-3'], 'fail'], [4, ['GY-1', 'GY-2', 'GY-3', 'GY-4'], 'running'],
  ], 'each in-flight tip names its position, the entries it holds and its CI state');
  assert.deepEqual(describeTipWindow(all, placements, window, [CI_APP]).get('GY-3'), { position: 2, tips: tips.slice(0, 3), firstFailure: tips[2], validated: false, own: tips[2] });
  assert.equal(describeTipWindow(all, placements, 2, [CI_APP]).get('GY-3')!.tips.length, 0, 'an entry outside the window requires nothing yet');
  // The control plane records the window on the queue entry, and the dashboard's Merge step reads it.
  const third = all[2], fourth = all[3];
  const windowViews = describeTipWindow(all, placements, window, [CI_APP]);
  const thirdView = windowBatchView('GY-3', windowViews.get('GY-3')!, window);
  assert.equal(thirdView.state, 'ejecting', 'entry 3 is the cause: its tip is the first failing one');
  const fourthView = windowBatchView('GY-4', windowViews.get('GY-4')!, window);
  assert.equal(fourthView.state, 'waiting', 'entry 4 waits: the first failing tip is not its own');
  assert.match(fourthView.summary, /tip 2 \(GY-1, GY-2\) passed; tip 3 \(GY-1, GY-2, GY-3\) failed test/, 'the summary names every in-flight tip with its entries and CI state');
  // The dashboard's Merge step names each in-flight tip the entry merges behind: position,
  // entries and CI state, never a single "combined tip of batch 1".
  const fourthSteps = prSteps({ ...fourth, queue: { ...fourth.queue!, batch: fourthView, tips: windowViews.get('GY-4')!.tips } } as Work, now);
  assert.equal(fourthSteps.current, 'merge');
  assert.equal(fourthSteps.label, 'Merging · validating 4 parallel tips: tip 1 (GY-1) passed; tip 2 (GY-1, GY-2) passed; tip 3 (GY-1, GY-2, GY-3) failed test; tip 4 (GY-1, GY-2, GY-3, GY-4) running · 0 of 1 checks done',
    'the dashboard shows every in-flight tip with its position, entries and CI state');
  assert.doesNotMatch(fourthSteps.label, /batch 1/);
  const unpublished = { position: 2, entries: ['GY-1', 'GY-2'], tip: null, ci: 'none' as const };
  assert.equal(prSteps({ ...third, gates: [{ name: 'merge', passed: false, reasons: ['Merge queue position 2 of 4: GY-1 is ahead'] }], queue: { ...third.queue!, tips: [windowViews.get('GY-1')!.tips[0], unpublished] } } as Work, now).detail,
    'validating 2 parallel tips: tip 1 (GY-1) passed; tip 2 (GY-1, GY-2) not published yet', 'a tip not yet published reads so, before its own checks exist');
  // Insights: merges per hour and the median queue wait.
  const mergedSince = (key: string, minutesAgo: number) => entry(0, [pass], { key, id: `id-${key}`, stage: 'done', queue: null,
    observation: { clockOffset: { min: 0, max: 0 }, candidate: { sha: sha40(key), baseSha: B0, pr: 1, branch: 'b', author: 'a' }, baseTip: B0, checks: [pass], reviews: [], protected: true, mergeable: true, merged: true, mergeSha: sha40(`m${key}`), mergedAt: new Date(now - minutesAgo * 60_000).toISOString(), files: [], scopeFiles: [], at: new Date(now - minutesAgo * 60_000).toISOString() } } as unknown as Work);
  const busy = [...all, mergedSince('GY-9', 10), mergedSince('GY-8', 20), mergedSince('GY-7', 90)];
  const insights = mergeQueueInsights(busy, now, window, [CI_APP]);
  assert.equal(insights.mergesPerHour, 2, 'merges observed in the trailing hour');
  assert.ok(insights.medianQueueWaitMs !== null && insights.medianQueueWaitMs > 0, 'the median wait of the entries queued now');
  assert.deepEqual(mergeQueueInsights([mergedSince('GY-9', 10)], now, window, [CI_APP]).medianQueueWaitMs, null, 'no queue, no median wait');
  // The status fields the report carries, through the CLI helper the report is assembled with.
  const master = masterConfigSchema.parse({ version: 1, url: 'http://x', credentialFile: '/c', cliPath: '/cli', repository: 'o/r', baseBranch: 'main', githubAppId: 1, hostId: 'h', masterAgentName: 'graphyard-master', mergeQueue: { parallelTips: 6 } });
  const reported = mergeQueueStatus(master, { work: busy, now: new Date(now).toISOString() }, { ciAppIds: [CI_APP] });
  assert.deepEqual([reported.batchSize, reported.parallelTips, reported.mergesPerHour, reported.tips.length], [4, 6, 2, 4], 'before the control plane reports a window, the master\'s own configuration');
  // Once the control plane reports the window it runs (`/api/status` mergeQueue), status reports that one.
  const effective = mergeQueueStatus(master, { work: busy, now: new Date(now).toISOString() }, { ciAppIds: [CI_APP], mergeQueue: { batchSize: 2, parallelTips: 2 } });
  assert.deepEqual([effective.batchSize, effective.parallelTips, effective.tips.length, effective.configured], [2, 2, 2, { batchSize: 4, parallelTips: 6 }], 'the effective window, beside what master.json configures');
  // Each queue row of master status carries the tips its entry merges behind, and its batch view is the window's.
  const status = buildMasterStatus({ work: all, now: new Date(now).toISOString() }, [], [], {}, {}, undefined, 'main', { ciAppIds: [CI_APP] } as any, undefined, undefined, undefined, 'graphyard', { batchSize: 4, parallelTips: window });
  const row = (key: string) => status.queue.find((entry: { key: string }) => entry.key === key) as { tips?: { position: number; entries: string[]; ci: string }[]; batch: { state: string } | null };
  assert.deepEqual(row('GY-4').tips!.map(tip => [tip.position, tip.entries.length, tip.ci]), [[1, 1, 'pass'], [2, 2, 'pass'], [3, 3, 'fail'], [4, 4, 'running']]);
  assert.deepEqual([row('GY-3').batch!.state, row('GY-4').batch!.state], ['ejecting', 'waiting']);
  // Master config: `mergeQueue.parallelTips`, default 4, bounded like the batch size.
  const base = { version: 1, url: 'http://x', credentialFile: '/c', cliPath: '/cli', repository: 'o/r', baseBranch: 'main', githubAppId: 1, hostId: 'h', masterAgentName: 'graphyard-master' };
  assert.equal(defaultParallelTips, 4);
  assert.equal(mergeParallelTips(masterConfigSchema.parse(base)), 4, 'the default window is four positions');
  assert.equal(mergeParallelTips(masterConfigSchema.parse({ ...base, mergeQueue: { parallelTips: 1 } })), 1);
  assert.throws(() => masterConfigSchema.parse({ ...base, mergeQueue: { parallelTips: 0 } }));
  assert.throws(() => masterConfigSchema.parse({ ...base, mergeQueue: { parallelTips: maxParallelTips + 1 } }));
});

test('unit:parallel-tips-visible — the flow report behind Insights counts merges per hour and the median queue wait, and Insights shows both', () => {
  const to = '2026-09-25T12:00:00.000Z', hour = 3_600_000, at = (hoursAgo: number) => new Date(Date.parse(to) - hoursAgo * hour).toISOString();
  const items = ['GY-11', 'GY-12', 'GY-13'].map((key, index) => ({ id: `3111111${index}-2222-4333-8444-555555555555`, key, title: key, type: 'feature', stage: 'done', plannedFiles: ['src/'], criteria: [], evidence: [], gates: [], violations: [], observation: null }) as unknown as Work);
  let id = 0;
  const fact = (item: Work, kind: string, observedAt: string, details: Record<string, unknown> = {}): FlowFact => ({ id: ++id, workId: item.id, workKey: item.key, kind: kind as FlowFact['kind'], observedAt, recordedAt: observedAt,
    source: 'graphyard', sourceEvent: id, stage: 'merge', workType: 'feature', slices: ['src'], details, dedupe: `${kind}:${id}` });
  // GY-11 queued 3h ago and merged 1h ago (2h wait); GY-12 was ejected, re-queued 2h ago and merged
  // 1h ago (1h wait from its last entry); GY-13 queued 5h ago and merged 1h ago (4h wait).
  const facts = [
    fact(items[0], 'gates.changed', at(3), { queued: true }), fact(items[0], 'merged', at(1)),
    fact(items[1], 'gates.changed', at(4), { queued: true }), fact(items[1], 'gates.changed', at(3), { queued: false }), fact(items[1], 'gates.changed', at(2), { queued: true }), fact(items[1], 'gates.changed', at(1.5), { queued: true }), fact(items[1], 'merged', at(1)),
    fact(items[2], 'gates.changed', at(5), { queued: true }), fact(items[2], 'merged', at(1)),
  ].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  assert.equal(queueWait(facts.filter(entry => entry.workId === items[1].id && entry.kind === 'gates.changed'), Date.parse(at(1))), hour, 'an ejected entry waits from its last entry to the queue');
  assert.equal(queueWait([], Date.parse(at(1))), null, 'no queued gate fact, no wait');
  const created = items.map(item => fact(item, 'work.created', at(24 * 10)));
  const dataset: FlowDataset = { observedAt: to, from: at(24 * 7), to, days: 7, work: items, included: items, facts, latest: [...created, ...facts.filter(entry => entry.kind === 'merged')], carryIn: [], deployments: [], mergedForDeployments: [],
    scanned: facts.length, truncated: false, workTruncated: false, deploymentsTruncated: false, deploymentMergesTruncated: false, projection: { lastEvent: 10, updatedAt: to, pendingEvents: 0, pendingCapped: false } } as FlowDataset;
  const report = computeFlow(dataset, { days: 7 });
  assert.deepEqual([report.mergeQueue.merges, report.mergeQueue.mergesPerHour, report.mergeQueue.queueWait.n, report.mergeQueue.queueWait.medianMs], [3, 0.018, 3, 2 * hour], 'three merges over seven days, median wait two hours');
  assert.ok(report.definitions.mergeQueue, 'the metric is defined with the report');
  // Insights renders both figures beside what landed; an unmeasured figure reads Unavailable, never
  // zero, and a figure from fewer than five merges reads '—' with its sample count (sparse data).
  const sparsePage = renderToStaticMarkup(createElement(LandedPerDay, { report }));
  assert.match(sparsePage, /data-pace="merges-per-hour"[^>]*><dt[^>]*>Merges per hour<\/dt><dd[^>]* data-sparse="true"[^>]*>—<\/dd><small[^>]*>3 merges<\/small>/);
  assert.match(sparsePage, /data-pace="median-queue-wait"[^>]*><dt[^>]*>Median queue wait<\/dt><dd[^>]* data-sparse="true"[^>]*>—<\/dd><small[^>]*>3 merged<\/small>/);
  const denseReport = { ...report, mergeQueue: { ...report.mergeQueue, merges: 6, mergesPerHour: 0.036, queueWait: { ...report.mergeQueue.queueWait, n: 6, sparse: false } } };
  const densePage = renderToStaticMarkup(createElement(LandedPerDay, { report: denseReport }));
  assert.match(densePage, /data-pace="merges-per-hour"[^>]*><dt[^>]*>Merges per hour<\/dt><dd[^>]*>0.036<\/dd>/);
  assert.match(densePage, /data-pace="median-queue-wait"[^>]*><dt[^>]*>Median queue wait<\/dt><dd[^>]*>2h[^<]*<small> of 6 merged<\/small>/);
  const empty = renderToStaticMarkup(createElement(LandedPerDay, { report: { ...report, mergeQueue: { merges: 0, mergesPerHour: null, queueWait: { n: 0, medianMs: null } } } }));
  assert.match(empty, /Merges per hour<\/dt><dd[^>]*>Unavailable/);
  assert.match(empty, /Median queue wait<\/dt><dd[^>]*>Unavailable/);
});

test('unit:parallel-speculative-tips — the master publishes mergeQueue.parallelTips from master.json, and the control plane validates by it and reads it back from the installation ledger', async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 498;
  const databaseDir = await temporaryDirectory('parallel-tips');
  const database = new EmbeddedPostgres({ databaseDir, user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_parallel_tips');
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_parallel_tips`);
  const tokens = { coordinator: 'm'.repeat(32), worker: 'w'.repeat(32) };
  let http: ReturnType<typeof server> | undefined;
  try {
    await store.init();
    const engine = new Engine(store, [CI_APP], 120, 'owner/project');
    assert.equal(engine.parallelTips, 4, 'the default window is four positions');
    assert.equal(await engine.loadParallelTips(), 4, 'the default stands before any publication');
    http = server(engine, [{ id: 'master', role: 'coordinator', token: tokens.coordinator }, { id: 'worker-a', role: 'worker', token: tokens.worker }]);
    await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const api = async (path: string, token: string, init: RequestInit = {}) => {
      const response = await fetch(`${url}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } });
      return { status: response.status, body: await response.json() };
    };
    assert.deepEqual((await api('/api/status', tokens.coordinator)).body.mergeQueue, { batchSize: 4, parallelTips: 4, rerunFailedChecks: 1 }, 'status reports the window the control plane runs');
    const post = (token: string, body: object) => api('/api/merge-queue', token, { method: 'POST', body: JSON.stringify(body) });
    assert.equal((await post(tokens.worker, { parallelTips: 2 })).status, 403, 'only the master (or an operator) sets it');
    assert.equal((await post(tokens.coordinator, { parallelTips: 0 })).status, 400);
    assert.equal((await post(tokens.coordinator, { parallelTips: maxParallelTips + 1 })).status, 400);
    assert.equal((await post(tokens.coordinator, {})).status, 400, 'a publication names at least one setting');
    // The loop publishes the values in its own master config, once per change, through the route.
    const posted: unknown[] = [];
    const mutate = async (path: string, data: unknown) => { posted.push(data); const response = await api(`/api/${path}`, tokens.coordinator, { method: 'POST', body: JSON.stringify(data) }); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; };
    let configured: { batchSize?: number; parallelTips?: number } | undefined = { parallelTips: 2 };
    const effects = daemonEffects(process.cwd(), () => ({ url, run: {}, mergeQueue: configured }) as any, { snapshot: async () => ({ work: [], now: new Date().toISOString() }), mutate });
    await effects.publishMergeBatchSize!();
    await effects.publishMergeBatchSize!();
    assert.deepEqual(posted, [{ batchSize: 4, parallelTips: 2, rerunFailedChecks: 1 }], 'published once, not every cycle');
    assert.equal(engine.parallelTips, 2, 'the control plane validates by the master\'s window at once');
    assert.deepEqual((await api('/api/status', tokens.coordinator)).body.mergeQueue, { batchSize: 4, parallelTips: 2, rerunFailedChecks: 1 });
    const ledger = async (kind: string) => (await store.pool.query('SELECT payload FROM events WHERE work_id IS NULL AND kind=$1 ORDER BY seq', [kind])).rows.map(row => row.payload);
    assert.deepEqual(await ledger(mergeParallelTipsEvent), [{ parallelTips: 2, previous: null }], 'recorded in the installation ledger');
    // A restarted control plane reads the published value back from the installation ledger.
    const restarted = new Engine(store, [CI_APP], 120, 'owner/project');
    assert.equal(await restarted.loadParallelTips(), 2);
    // Changing only the window records only the window; removing it publishes the default.
    configured = { parallelTips: 8 };
    await effects.publishMergeBatchSize!();
    configured = undefined;
    await effects.publishMergeBatchSize!();
    assert.equal(posted.length, 3);
    assert.equal(await restarted.loadParallelTips(), 4, 'removing the setting publishes the default');
    assert.deepEqual((await ledger(mergeParallelTipsEvent)).map(payload => payload.parallelTips), [2, 8, 4], 'one ledger entry per change');
    assert.deepEqual((await ledger('merge-queue.batch-size')).map(payload => payload.batchSize), [4], 'the unchanged batch size is recorded once');
  } finally {
    if (http) await new Promise<void>(resolve => http!.close(() => resolve()));
    await store.close();
    await database.stop();
  }
});


test('unit:parallel-speculative-tips — every active tip receives merge-band verdict reads while CI is running', () => {
  const all = keys.map((_, index) => entry(index, [running]));
  const views = describeTipWindow(all, predictQueue(all, now), 4, [CI_APP]);
  for (const work of all) work.queue!.tips = views.get(work.key)!.tips;
  assert.deepEqual(all.map(work => observationBand(work, all, new Date(now), { kind: 'merge' } as any).band),
    ['merge', 'merge', 'merge', 'merge', 'idle', 'idle']);
});

test('unit:parallel-tips-failure-rebuild — a failed check held for rerun is running, not an attributed failure', () => {
  const first = entry(0, [pass]);
  const second = entry(1, [{ ...failing, id: 42 }], { checkReruns: [{ sha: tip(1), check: 'test', failedRunId: 42, state: 'requested', at }] });
  const all = [first, second];
  const view = describeTipWindow(all, predictQueue(all, now), 4, [CI_APP]).get(second.key)!;
  assert.equal(view.own!.ci, 'running');
  assert.equal(view.firstFailure, null);
  assert.equal(view.validated, false);
  second.checkReruns![0].state = 'failed';
  assert.equal(describeTipWindow(all, predictQueue(all, now), 4, [CI_APP]).get(second.key)!.own!.ci, 'fail', 'once the rerun failed, the failure is the tip\'s own');
});
