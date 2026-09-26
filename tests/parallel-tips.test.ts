import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { defaultParallelTips, describeTipWindow, maxParallelTips, mergeParallelTipsEvent, mergeQueueInsights, predictQueue, queueRef, reconcileWindow, tipValidationPrefix, windowBatchView } from '../src/merge-queue.js';
import { masterConfigSchema } from '../src/master.js';
import { mergeParallelTips } from '../src/master/profiles.js';
import { mergeQueueStatus } from '../src/cli/master-status.js';
import { evaluate, type Work } from '../src/model.js';
import { prSteps } from '../web/pr-steps.js';

// GY-498: the merge queue validates speculative tips for the first `mergeQueue.parallelTips`
// positions at once instead of one combined tip at a time. Each test is named for the proof it
// produces.
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const keys = ['GY-1', 'GY-2', 'GY-3', 'GY-4', 'GY-5', 'GY-6'];
const CI_APP = 15368;

/**
 * The live queue driven through the control plane's own gate evaluation — `evaluate` reconciled
 * with the parallel-tip window exactly as the engine runs it — against a fake CI of a fixed
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
  const windowed = (item: Work) => reconcileWindow(evaluate(item, items, new Date(clock), [CI_APP], 1), item, items, new Date(clock), [CI_APP], 1, parallelTips);
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

test('unit:parallel-tips-visible — status shows each in-flight tip (position, entries, CI state), the dashboard names the window, and Insights reports merges per hour and median queue wait', () => {
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
  const steps = prSteps({ ...third, queue: { ...third.queue!, batch: thirdView } } as Work, now);
  assert.equal(steps.current, 'merge');
  assert.match(steps.label, /Merging · validating the combined tip of batch 1 with GY-1, GY-2/, 'the dashboard shows the entries the tip holds');
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
  assert.deepEqual([reported.batchSize, reported.parallelTips, reported.mergesPerHour, reported.tips.length], [4, 6, 2, 4]);
  // Master config: `mergeQueue.parallelTips`, default 4, bounded like the batch size.
  const base = { version: 1, url: 'http://x', credentialFile: '/c', cliPath: '/cli', repository: 'o/r', baseBranch: 'main', githubAppId: 1, hostId: 'h', masterAgentName: 'graphyard-master' };
  assert.equal(defaultParallelTips, 4);
  assert.equal(mergeParallelTips(masterConfigSchema.parse(base)), 4, 'the default window is four positions');
  assert.equal(mergeParallelTips(masterConfigSchema.parse({ ...base, mergeQueue: { parallelTips: 1 } })), 1);
  assert.throws(() => masterConfigSchema.parse({ ...base, mergeQueue: { parallelTips: 0 } }));
  assert.throws(() => masterConfigSchema.parse({ ...base, mergeQueue: { parallelTips: maxParallelTips + 1 } }));
});

test('the control plane validates by the published parallel-tip window, read back from the installation ledger', async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 498;
  const database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-parallel-tips-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_parallel_tips');
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_parallel_tips`);
  let http: ReturnType<typeof import('../src/server.js').server> | undefined;
  try {
    await store.init();
    const engine = new Engine(store, [CI_APP], 120, 'owner/project');
    assert.equal(engine.parallelTips, 4, 'the default window is four positions');
    // Before any publication the deployment environment's setting answers, then the default.
    process.env.GRAPHYARD_MERGE_PARALLEL_TIPS = '3';
    try { assert.equal(await engine.loadParallelTips(), 3, 'the deployment environment sets the window before any publication'); }
    finally { delete process.env.GRAPHYARD_MERGE_PARALLEL_TIPS; }
    assert.equal(await engine.loadParallelTips(), 4, 'and the default stands with neither');
    // The master publishes `mergeQueue.parallelTips` (POST /api/merge-queue), which records the
    // value in the installation ledger the same way the batch size is recorded.
    await store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', ['graphyard-master', mergeParallelTipsEvent, JSON.stringify({ parallelTips: 2, previous: null })]);
    assert.equal(await engine.loadParallelTips(), 2, 'the published window applies at once');
    // A restarted control plane reads the published value back from the installation ledger.
    const restarted = new Engine(store, [CI_APP], 120, 'owner/project');
    assert.equal(await restarted.loadParallelTips(), 2);
  } finally {
    if (http) await new Promise<void>(resolve => http!.close(() => resolve()));
    await store.close();
    await database.stop();
  }
});
