import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { defaultParallelTips, describeTipWindow, maxParallelTips, mergeParallelTipsEvent, mergeQueueInsights, predictQueue, queueRef, tipValidationPrefix, windowBatchView } from '../src/merge-queue.js';
import { server } from '../src/server.js';
import { daemonEffects } from '../src/master-daemon.js';
import { buildMasterStatus, masterConfigSchema } from '../src/master.js';
import { mergeParallelTips, mergeQueueStatus } from '../src/master/profiles.js';
import { computeFlow, queueWait, type FlowDataset, type FlowFact } from '../src/flow-analytics.js';
import { evaluate, type Work } from '../src/model.js';
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

/**
 * The live queue driven through the control plane's own gate evaluation — `evaluate` under the
 * parallel-tip window exactly as the engine runs it — against a fake CI of a fixed
 * virtual duration. Every round publishes the tips the queue asks for (publishing never waits for
 * CI), evaluates every entry, lands the entries whose gates all pass in queue order, starts CI on
 * every tip the merge gates name, and advances the virtual clock to the next completion. A tip's
 * tree is named by the entries it holds, so a rebuilt tip holding the same entries binds the
 * entries behind it unchanged, as GY-100 binds them.
 */
function driveParallelTips(parallelTips: number, failing: string | null, count = keys.length) {
  const duration = 100, start = Date.parse('2026-09-25T09:00:00.000Z'), at = '2026-09-25T08:00:00.000Z';
  let clock = start, published = 0;
  const trees = new Map<string, string>(), holds = new Map<string, string[]>();
  const base = { sha: sha40('b0'), tree: sha40('e0') };
  trees.set(base.sha, base.tree); holds.set(base.sha, []);
  const items: Work[] = keys.slice(0, count).map((key, index) => {
    const own = sha40(`a${index + 1}`), candidate = { sha: own, baseSha: base.sha, pr: 100 + index, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' };
    return { id: `id-${key}`, key, title: key, description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: [`src/${key}/`], criteria: [],
      policy: { checks: ['test'], review: false }, stage: 'merge', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
      workspaces: [{ host: 'machine', path: `/tmp/${key}`, branch: candidate.branch, epoch: 1, owner: 'agent' }], candidate, submission: { epoch: 1, pr: 100 + index }, reworkRequested: false,
      scenarioRequirements: [], evidence: [], blocker: null, violations: [], gates: [],
      observation: { clockOffset: { min: 0, max: 0 }, candidate, baseTip: base.sha, baseTree: base.tree, checks: [], reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, files: [], scopeFiles: [], at: new Date(start).toISOString() },
      queue: { sequence: index + 1, enqueuedAt: at, policyRevision: 1, speculation: null }, queueSequence: index + 1 } as unknown as Work;
  });
  const queued = () => items.filter(item => !!item.queue && item.stage !== 'done').sort((a, b) => a.queue!.sequence - b.queue!.sequence);
  const observe = (item: Work, checks: Work['observation'] extends infer O ? O extends { checks: infer C } ? C : never : never) => {
    item.observation = { ...item.observation!, candidate: item.candidate!, baseTip: base.sha, baseTree: trees.get(base.sha)!, checks, at: new Date(clock).toISOString() };
  };
  const windowed = (item: Work) => evaluate(item, items, new Date(clock), [CI_APP], 1, parallelTips);
  // The control plane publishing each tip the queue asks for: the entry's own head merged onto its
  // predicted base. Publishing never waits for CI, so the whole chain builds at once.
  const publish = () => {
    for (let moved = true; moved;) {
      moved = false;
      for (const placement of predictQueue(items, clock)) {
        if (placement.current || !placement.publishable) continue;
        const item = items.find(entry => entry.id === placement.id)!, predicted = placement.predictedBase!;
        const holding = [...holds.get(predicted)!, item.key], tip = sha40(`c${++published}`), tree = sha40(`e${holding.map(key => key.slice(3)).join('')}`);
        trees.set(tip, tree); holds.set(tip, holding);
        item.candidate = { ...item.candidate!, sha: tip, baseSha: predicted };
        item.queue = { ...item.queue!, speculation: { ref: queueRef(item.key), tip, base: predicted, baseTree: trees.get(predicted)!, tipTree: tree, predecessors: placement.predecessors, policyRevision: 1, publishedAt: at, reviewedHead: sha40(`a${keys.indexOf(item.key) + 1}`) } };
        predictions.push({ key: item.key, predecessors: placement.predecessors, holding });
        observe(item, []);
        moved = true;
        break;
      }
    }
  };
  const runs: { tip: string; holding: string[]; startedAt: number }[] = [], merged: { key: string; at: number }[] = [], ejected: { key: string; reason: string }[] = [], predictions: { key: string; predecessors: string[]; holding: string[] }[] = [];
  for (let round = 0; queued().length && round < 200; round++) {
    publish();
    for (const item of queued()) Object.assign(item, windowed(item));
    for (const item of items) if (!item.queue && item.queueEjection && item.stage !== 'done' && !ejected.some(entry => entry.key === item.key)) ejected.push({ key: item.key, reason: item.queueEjection!.reason });
    // Entries whose every gate passed land in queue order; each landing moves the base and frees a window position.
    const landedBefore = merged.length, ejectedBefore = ejected.length;
    for (let landed = true; landed;) {
      landed = false;
      for (const item of queued()) {
        Object.assign(item, windowed(item));
        if (item.gates.every(gate => gate.passed)) {
          merged.push({ key: item.key, at: clock });
          base.sha = item.candidate!.sha; trees.set(base.sha, trees.get(item.candidate!.sha)!); holds.set(base.sha, holds.get(item.candidate!.sha)!);
          item.stage = 'done'; item.queue = null;
          for (const other of queued()) observe(other, other.observation!.checks);
          landed = true;
          break;
        }
      }
    }
    if (!queued().length) break;
    // CI runs on exactly the tips the merge gates name as under validation, one duration each.
    const named = new Set(queued().flatMap(item => item.gates.find(gate => gate.name === 'merge')!.reasons)
      .filter(reason => reason.startsWith(tipValidationPrefix)).map(reason => reason.slice(tipValidationPrefix.length, tipValidationPrefix.length + 12)));
    let next = Infinity, started = 0;
    for (const prefix of named) {
      const item = queued().find(entry => entry.candidate!.sha.startsWith(prefix))!;
      const known = runs.find(run => item.candidate!.sha.startsWith(run.tip));
      if (known) { next = Math.min(next, known.startedAt + duration); continue; }
      runs.push({ tip: prefix, holding: holds.get(item.candidate!.sha)!, startedAt: clock });
      next = Math.min(next, clock + duration);
      started++;
    }
    // A landing or an ejection moved the queue: republish and re-read it before judging progress.
    if (!Number.isFinite(next)) {
      if (started === 0 && merged.length === landedBefore && ejected.length === ejectedBefore) break;
      continue;
    }
    clock = next;
    for (const run of runs.filter(run => run.startedAt + duration === clock)) {
      const item = queued().find(entry => entry.candidate!.sha.startsWith(run.tip));
      if (item) observe(item, [{ name: 'test', result: failing && run.holding.includes(failing) ? 'failure' : 'success', appId: CI_APP }]);
    }
  }
  return { runs, merged, ejected, items, trees, holds, duration, predictions };
}

test('unit:parallel-speculative-tips — six entries with parallelTips 4 merge in about two CI durations, all four window tips validated at once; parallelTips 1 takes six', () => {
  const fast = driveParallelTips(4, null);
  const relative = (key: string) => fast.merged.find(entry => entry.key === key)!.at - start();
  assert.deepEqual(fast.merged.map(entry => entry.key), keys, 'all six merge, in queue order');
  assert.ok(relative('GY-4') <= fast.duration * 1.5, `the first four merge inside the first CI duration (at +${relative('GY-4')}ms of ${fast.duration}ms)`);
  assert.ok(relative('GY-6') <= fast.duration * 2.5, `all six merge in about two CI durations (last at +${relative('GY-6')}ms)`);
  // The window validated four tips at once: four runs started before the first one finished.
  const firstDone = Math.min(...fast.runs.map(run => run.startedAt)) + fast.duration;
  assert.equal(fast.runs.filter(run => run.startedAt < firstDone).length, 4, `four tips ran concurrently: ${JSON.stringify(fast.runs)}`);
  assert.ok(fast.runs.length <= 6, `no tip ran twice: ${JSON.stringify(fast.runs.map(run => run.holding))}`);

  // One tip at a time restores one CI duration per entry.
  const slow = driveParallelTips(1, null);
  assert.deepEqual(slow.merged.map(entry => entry.key), keys);
  const last = slow.merged.find(entry => entry.key === 'GY-6')!.at - start();
  assert.ok(last >= slow.duration * 5.5 && last <= slow.duration * 6.5, `six entries take about six durations with parallelTips 1 (last at +${last}ms)`);
  const concurrent = Math.max(...Array.from({ length: slow.runs.length }, (_, index) => slow.runs.filter(run => run.startedAt <= slow.runs[index].startedAt && run.startedAt + slow.duration > slow.runs[index].startedAt).length));
  assert.equal(concurrent, 1, 'only one tip is validated at a time');

  function start() { return Date.parse('2026-09-25T09:00:00.000Z'); }
});

test('unit:parallel-tips-failure-rebuild — tip 2 of 4 fails: entry 1 merges, entry 2 is ejected as the cause, tips 3-4 rebuild without entry 2 and merge', () => {
  const driven = driveParallelTips(4, 'GY-2', 4);
  assert.deepEqual(driven.merged.map(entry => entry.key), ['GY-1', 'GY-3', 'GY-4'], 'entries before the failure merge, and the rest merge after the rebuild, in queue order');
  assert.deepEqual(driven.ejected.map(entry => entry.key), ['GY-2'], 'exactly the attributed entry is ejected');
  assert.match(driven.ejected[0].reason, /^Required CI check test did not pass on speculative tip [0-9a-f]{12}, attributed to this entry: speculative tip [0-9a-f]{12} ahead of it passed test$/, `the failing tip is attributed by the passing prefix: ${driven.ejected[0].reason}`);
  const predictionsFor = (key: string) => driven.predictions.filter(prediction => prediction.key === key);
  assert.ok(predictionsFor('GY-3').length >= 2, 'the entry behind the failure had its tip rebuilt');
  assert.deepEqual(predictionsFor('GY-3').at(-1)!.holding, ['GY-1', 'GY-3'], `the rebuilt tip 3 holds entry 1 and itself only, not the ejected entry 2: ${JSON.stringify(predictionsFor('GY-3'))}`);
  assert.deepEqual(predictionsFor('GY-4').at(-1)!.holding, ['GY-1', 'GY-3', 'GY-4'], `the rebuilt tip 4 is built on the rebuilt tip 3: ${JSON.stringify(predictionsFor('GY-4'))}`);
  const firstEnd = Math.min(...driven.runs.map(run => run.startedAt)) + driven.duration;
  assert.deepEqual(driven.runs.filter(run => run.startedAt >= firstEnd).map(run => run.holding), [['GY-1', 'GY-3'], ['GY-1', 'GY-3', 'GY-4']], 'only the tips after the failure were rebuilt and re-run');
  // The rebuilt tips passed and merged within one further CI duration of the first merge.
  const at = (key: string) => driven.merged.find(entry => entry.key === key)!.at;
  assert.ok(at('GY-4') - at('GY-1') <= driven.duration * 1.5, `only the tips after the failure were rebuilt: +${at('GY-4') - at('GY-1')}ms`);
});

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
  const steps = prSteps({ ...third, queue: { ...third.queue!, batch: thirdView, tips: windowViews.get('GY-3')!.tips } } as Work, now);
  assert.equal(steps.current, 'merge');
  assert.match(steps.label, /Merging · validating the combined tip at position 3 with GY-1, GY-2/, 'the dashboard shows the entry\'s own tip position and the entries it holds');
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
  // Insights renders both figures beside what landed; an unmeasured figure reads Unavailable, never zero.
  const page = renderToStaticMarkup(createElement(LandedPerDay, { report }));
  assert.match(page, /data-pace="merges-per-hour"[^>]*><dt[^>]*>Merges per hour<\/dt><dd[^>]*>0.018<\/dd>/);
  assert.match(page, /data-pace="median-queue-wait"[^>]*><dt[^>]*>Median queue wait<\/dt><dd[^>]*>2h/);
  const empty = renderToStaticMarkup(createElement(LandedPerDay, { report: { ...report, mergeQueue: { merges: 0, mergesPerHour: null, queueWait: { n: 0, medianMs: null } } } }));
  assert.match(empty, /Merges per hour<\/dt><dd[^>]*>Unavailable/);
  assert.match(empty, /Median queue wait<\/dt><dd[^>]*>Unavailable/);
});

test('unit:parallel-speculative-tips — the master publishes mergeQueue.parallelTips from master.json, and the control plane validates by it and reads it back from the installation ledger', async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 498;
  const database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-parallel-tips-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_parallel_tips');
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_parallel_tips`);
  const tokens = { coordinator: 'm'.repeat(32), worker: 'w'.repeat(32) };
  let http: ReturnType<typeof server> | undefined;
  try {
    await store.init();
    const engine = new Engine(store, [CI_APP], 120, 'owner/project');
    assert.equal(engine.parallelTips, 4, 'the default window is four positions');
    // Before any publication the deployment environment's setting answers, then the default.
    process.env.GRAPHYARD_MERGE_PARALLEL_TIPS = '3';
    try { assert.equal(await engine.loadParallelTips(), 3, 'the deployment environment sets the window before any publication'); }
    finally { delete process.env.GRAPHYARD_MERGE_PARALLEL_TIPS; }
    assert.equal(await engine.loadParallelTips(), 4, 'and the default stands with neither');
    http = server(engine, [{ id: 'master', role: 'coordinator', token: tokens.coordinator }, { id: 'worker-a', role: 'worker', token: tokens.worker }]);
    await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const api = async (path: string, token: string, init: RequestInit = {}) => {
      const response = await fetch(`${url}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } });
      return { status: response.status, body: await response.json() };
    };
    assert.deepEqual((await api('/api/status', tokens.coordinator)).body.mergeQueue, { batchSize: 4, parallelTips: 4 }, 'status reports the window the control plane runs');
    const post = (token: string, body: object) => api('/api/merge-queue', token, { method: 'POST', body: JSON.stringify(body) });
    assert.equal((await post(tokens.worker, { parallelTips: 2 })).status, 403, 'only the master (or an operator) sets it');
    assert.equal((await post(tokens.coordinator, { parallelTips: 0 })).status, 400);
    assert.equal((await post(tokens.coordinator, { parallelTips: maxParallelTips + 1 })).status, 400);
    assert.equal((await post(tokens.coordinator, {})).status, 400, 'a publication names at least one setting');
    // The loop publishes the values in its own master config, once per change, through the route.
    const posted: unknown[] = [];
    const mutate = async (path: string, data: unknown) => { posted.push(data); const response = await api(`/api/${path}`, tokens.coordinator, { method: 'POST', body: JSON.stringify(data) }); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; };
    let configured: { batchSize?: number; parallelTips?: number } | undefined = { parallelTips: 2 };
    const effects = daemonEffects(process.cwd(), () => ({ url, run: {}, mergeQueue: configured }) as any, { snapshot: async () => ({ work: [], now: new Date().toISOString() }), mutate, executor: {} as any });
    await effects.publishMergeBatchSize!();
    await effects.publishMergeBatchSize!();
    assert.deepEqual(posted, [{ batchSize: 4, parallelTips: 2 }], 'published once, not every cycle');
    assert.equal(engine.parallelTips, 2, 'the control plane validates by the master\'s window at once');
    assert.deepEqual((await api('/api/status', tokens.coordinator)).body.mergeQueue, { batchSize: 4, parallelTips: 2 });
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
