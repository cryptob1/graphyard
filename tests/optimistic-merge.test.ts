import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { evaluate, type Work } from '../src/model.js';
import { Engine } from '../src/engine.js';
import { GitHub, guardMain } from '../src/github.js';
import { masterConfigSchema, mergeWork, type MasterConfig } from '../src/master.js';
import { optimisticMergeEnabled } from '../src/master/profiles.js';
import { optimisticGuardAttention, optimisticStatus } from '../src/master/optimistic-attention.js';
import { applyPostMerge, applyRevert, bisectCulprit, optimisticEligibility, optimisticMetrics, postMergeVerdict, revertRefusal, sharedInfrastructure, type GuardState, type OptimisticMerge, type OptimisticRevert, type PostMergeVerdict } from '../src/optimistic-merge.js';
import OptimisticMerges from '../web/optimistic-merges.js';

// GY-500: a green entry whose files are disjoint from everything merged since its base lands at
// once, past the queue; main is guarded after the merge and a culprit is reverted automatically.
// Each test is named for the proof it produces.
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const now = new Date('2026-09-25T09:00:00.000Z'), at = '2026-09-25T08:00:00.000Z';
const ci = 15368;

/** An item every gate but the merge queue passes for: submitted, observed fresh, checked, unreviewed policy, no criteria. */
function item(key: string, files: string[], baseChanges: string[] | null, extra: Partial<Work> = {}): Work {
  const candidate = { sha: sha40(`a${key.slice(3)}`), baseSha: sha40('b0'), pr: 100 + Number(key.slice(3)), branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' };
  return { id: `id-${key}`, key, title: key, description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: files, criteria: [],
    policy: { checks: ['test'], review: false }, stage: 'merge', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'machine', path: `/tmp/${key}`, branch: candidate.branch, epoch: 1, owner: 'agent' }], candidate, submission: { epoch: 1, pr: candidate.pr }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, violations: [], gates: [],
    observation: { clockOffset: { min: 0, max: 0 }, candidate, baseTip: sha40('b1'), baseTree: sha40('e1'), checks: [{ name: 'test', result: 'success', appId: ci }], reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null,
      files, scopeFiles: [], baseChanges, at: now.toISOString() },
    ...extra } as unknown as Work;
}
const judge = (work: Work, all: Work[] = [work], optimistic?: boolean) => Object.assign(work, evaluate(work, all, now, [ci], optimistic === undefined ? 4 : { batchSize: 4, optimistic }));
const mergeGate = (work: Work) => work.gates.find(gate => gate.name === 'merge')!;

// ---------------------------------------------------------------------------
// unit:optimistic-eligibility (AC-1)
// ---------------------------------------------------------------------------
test('unit:optimistic-eligibility a green entry disjoint from every change since its base merges head-bound past the queue', () => {
  const work = judge(item('GY-1', ['src/feature-a.ts', 'docs/a.md'], ['src/feature-b.ts', 'README.md']));
  assert.equal(work.queue, null, 'an eligible entry never joins the queue');
  assert.equal(work.stage, 'merge');
  assert.deepEqual(mergeGate(work).reasons, [], 'no queue reason stands on its merge gate');
  assert.ok(work.gates.every(gate => gate.passed));
  const verdict = optimisticEligibility(work, [work], { enabled: true, gatesPass: true });
  assert.equal(verdict.eligible, true);
  assert.deepEqual(verdict.eligible && verdict.lane, { head: work.candidate!.sha, baseSha: work.candidate!.baseSha, baseTip: sha40('b1'), files: ['docs/a.md', 'src/feature-a.ts'], baseChanges: ['README.md', 'src/feature-b.ts'], policyRevision: 1 });
  // The engine records the lane the merge gate passed on: the head it binds and when it first did.
  const engine = new Engine(null as never);
  const recorded = item('GY-1', ['src/feature-a.ts'], ['src/feature-b.ts']);
  engine.evaluate(recorded, [recorded], now);
  assert.equal(recorded.optimistic?.head, recorded.candidate!.sha);
  assert.equal(recorded.optimistic?.at, now.toISOString());
  engine.evaluate(recorded, [recorded], new Date(now.getTime() + 60_000));
  assert.equal(recorded.optimistic?.at, now.toISOString(), 'the lane keeps the time it was first taken for the same head');
});

test('unit:optimistic-eligibility the merge broker lands an optimistic head without a queue tip, and only on the base it was judged against', async () => {
  const engine = new Engine(null as never);
  const work = item('GY-10', ['src/feature-a.ts'], ['src/feature-b.ts']);
  engine.evaluate(work, [work], now);
  assert.ok(work.mergeAuthorization && !work.queue && work.optimistic, 'authorized to merge on its optimistic lane, with no queue entry');
  const config = { repository: 'owner/project', baseBranch: 'main' } as MasterConfig;
  const requests: string[] = [];
  const snapshot = async () => ({ work: [work], now: new Date(now.getTime() + 1000).toISOString() });
  const enqueue = async (_: Work, authorization: { sha: string }) => { requests.push(authorization.sha); return { enqueue: { sha: authorization.sha, at: now.toISOString() } }; };
  const github = (tip: string) => (_command: string, args: string[]) => {
    if (args[1] === 'view') return JSON.stringify({ headRefOid: work.candidate!.sha, baseRefName: 'main', state: 'OPEN', isDraft: false });
    if (args[1]?.includes('/git/ref/heads/')) return JSON.stringify({ object: { type: 'commit', sha: tip } });
    throw new Error(`no other GitHub call: ${args.join(' ')}`);
  };
  // The head is behind the base tip (the base moved by disjoint changes) and has no published tip: it still lands.
  const result = await mergeWork(config, work, snapshot, enqueue, github(sha40('b1')));
  assert.equal(result.enqueued, true);
  assert.deepEqual(requests, [work.candidate!.sha], 'the merge is requested for exactly the head, head-bound');
  // A base that moved again since the judgement is judged again first.
  await assert.rejects(mergeWork(config, work, snapshot, enqueue, github(sha40('b2'))), /judged disjoint against base tip b1f{10}, but the base branch is now at b2f{10}/);
  assert.equal(requests.length, 1);
});

test('unit:optimistic-eligibility an entry whose files overlap a change merged since its base takes the queue', () => {
  const work = judge(item('GY-2', ['src/feature-a.ts', 'src/shared.ts'], ['src/shared.ts']));
  assert.ok(work.queue, 'an overlapping entry enters the queue');
  assert.ok(mergeGate(work).reasons.length, 'its merge gate waits on the queue');
  const verdict = optimisticEligibility({ ...work, queue: null }, [work], { enabled: true, gatesPass: true });
  assert.equal(verdict.eligible, false);
  assert.match(!verdict.eligible ? verdict.reasons.join('; ') : '', /overlap changes merged since its base [0-9a-f]{12}: src\/shared\.ts/);
  // An unknown list of base changes is never disjoint.
  const unknown = optimisticEligibility(item('GY-3', ['src/feature-a.ts'], null), [], { enabled: true, gatesPass: true });
  assert.equal(unknown.eligible, false);
  assert.match(!unknown.eligible ? unknown.reasons.join('; ') : '', /files the base changed since [0-9a-f]{12} are not known/);
  // Another item already merging optimistically over the same file holds this one back.
  const first = judge(item('GY-4', ['src/feature-c.ts'], []));
  first.optimistic = { head: first.candidate!.sha, baseSha: first.candidate!.baseSha, baseTip: sha40('b1'), files: ['src/feature-c.ts'], baseChanges: [], policyRevision: 1, at };
  const second = item('GY-5', ['src/feature-c.ts'], []);
  const held = optimisticEligibility(second, [first, second], { enabled: true, gatesPass: true });
  assert.match(!held.eligible ? held.reasons.join('; ') : '', /GY-4 is merging optimistically over the same files: src\/feature-c\.ts/);
  // A failing gate, a queued entry, and optimistic mode off each refuse.
  assert.equal(optimisticEligibility(item('GY-6', ['src/x.ts'], []), [], { enabled: true, gatesPass: false }).eligible, false);
  const off = judge(item('GY-7', ['src/x.ts'], []), undefined, false);
  assert.ok(off.queue, 'with mergeQueue.optimistic false every entry takes the queue');
  assert.match(optimisticEligibility({ ...off, queue: null }, [], { enabled: false, gatesPass: true }).eligible ? '' : 'off', /off/);
});

test('unit:optimistic-eligibility an entry touching shared infrastructure, or whose base changed it, takes the queue', () => {
  for (const path of ['package.json', 'web/package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.github/workflows/ci.yml', 'tests/helpers/run-tests.ts', 'src/model/work.ts', 'src/store/schema.ts', 'db/migrations/0001_init.sql', 'src/store/tables.ts', 'src/store/tables/flow.ts'])
    assert.equal(sharedInfrastructure(path), true, path);
  for (const path of ['src/model/queue.ts', 'tests/optimistic-merge.test.ts', 'docs/github.md', 'src/github.ts'])
    assert.equal(sharedInfrastructure(path), false, path);
  const own = judge(item('GY-8', ['src/feature-a.ts', 'package.json'], []));
  assert.ok(own.queue, 'an entry changing package.json takes the queue');
  assert.match((optimisticEligibility({ ...own, queue: null }, [], { enabled: true, gatesPass: true }) as { reasons: string[] }).reasons.join('; '), /changes shared infrastructure: package\.json/);
  const base = judge(item('GY-9', ['src/feature-a.ts'], ['.github/workflows/ci.yml']));
  assert.ok(base.queue, 'an entry whose base changed CI since its own run takes the queue');
  assert.match((optimisticEligibility({ ...base, queue: null }, [], { enabled: true, gatesPass: true }) as { reasons: string[] }).reasons.join('; '), /base changed shared infrastructure since [0-9a-f]{12}: \.github\/workflows\/ci\.yml/);
  // The setting: on by default, off when the master config says so.
  assert.equal(optimisticMergeEnabled(null), true);
  assert.equal(optimisticMergeEnabled({ mergeQueue: { optimistic: false } }), false);
  assert.equal(masterConfigSchema.shape.mergeQueue.safeParse({ batchSize: 2, optimistic: false }).success, true);
  assert.equal(masterConfigSchema.shape.mergeQueue.safeParse({ optimistic: 'yes' }).success, false);
});

// ---------------------------------------------------------------------------
// unit:optimistic-auto-revert (AC-2)
// ---------------------------------------------------------------------------
/** A delivered item merged on its optimistic lane at `mergedAt`. */
function delivered(key: string, files: string[], mergedAt: string, extra: Partial<Work> = {}): Work {
  const work = item(key, files, [], extra), mergeSha = sha40(`d${key.slice(3)}`);
  const lane = { head: work.candidate!.sha, baseSha: work.candidate!.baseSha, baseTip: sha40('b1'), files, baseChanges: [], policyRevision: 1, at: new Date(Date.parse(mergedAt) - 60_000).toISOString() };
  const merge: OptimisticMerge = { lane, pr: work.candidate!.pr, mergeSha, mergedAt, postMerge: null, revert: null };
  return Object.assign(work, { stage: 'done', delivery: { mergedAt, mergeSha, authorizationRevision: 1 }, optimistic: lane, optimisticMerges: [merge],
    observation: { ...work.observation!, merged: true, mergeSha, mergedAt }, pipeline: { attempts: [], submittedAt: at, resubmittedAt: at, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } } }) as Work;
}

/**
 * The guard's world in memory: the engine's two transitions applied exactly as the engine applies
 * them (applyPostMerge, applyRevert, then evaluate), the ledger rows it appends, and a GitHub that
 * reports the given check runs per commit and records the reverts it opens and merges.
 */
function harness(work: Work[], checks: Record<string, string>) {
  const events: { kind: string; details: any }[] = [], opened: { key: string; reason: string }[] = [], merged: number[] = [];
  const run = (sha: string) => checks[sha] ? [{ name: 'test', result: checks[sha], appId: ci, id: 1 }] : [];
  const engine = {
    ciAppIds: [ci],
    store: { list: async () => work, pool: { query: async (text: string, values: unknown[] = []) => {
      if (text.startsWith('INSERT')) { events.push({ kind: values[1] as string, details: JSON.parse(values[2] as string).details }); return { rows: [], rowCount: 1 }; }
      return { rows: events.filter(event => event.kind === 'optimistic.guard').slice(-1).map(event => ({ details: event.details })), rowCount: 0 };
    } } },
    recordPostMerge: async (id: string, mergeSha: string, verdict: PostMergeVerdict, on?: string) => {
      const target = work.find(entry => entry.id === id)!;
      if (applyPostMerge(target, mergeSha, verdict, now, on)) events.push({ kind: 'optimistic.post-merge', details: { key: target.key, mergeSha, on: on ?? mergeSha, ...verdict } });
      return target;
    },
    recordOptimisticRevert: async (id: string, mergeSha: string, revert: OptimisticRevert) => {
      const target = work.find(entry => entry.id === id)!, wasDone = target.stage === 'done';
      if (!applyRevert(target, mergeSha, revert, now)) return target;
      if (wasDone && target.stage !== 'done') Object.assign(target, evaluate(target, work, now, [ci], 4));
      events.push({ kind: `optimistic.revert.${revert.state}`, details: { key: target.key, mergeSha, revert } });
      return target;
    },
  };
  const github = {
    commitChecks: async (sha: string) => run(sha),
    baseBranch: async () => ({ tip: sha40('f9'), tree: sha40('e9') }),
    permissionShortfall: () => null,
    openRevert: async (target: Work, merge: OptimisticMerge, reason: string) => { opened.push({ key: target.key, reason }); return { pr: 900 + opened.length, head: sha40(`c${opened.length}`) }; },
    mergeRevert: async (_: Work, revert: { pr: number | null }) => { merged.push(revert.pr!); checks[sha40(`e${revert.pr}`)] ??= 'in_progress'; return sha40(`e${revert.pr}`); },
  };
  return { engine: engine as never, github: github as never, events, opened, merged, checks };
}

test('unit:optimistic-auto-revert two optimistic merges and a failing main: the culprit is reverted and reopened, the other kept', async () => {
  const one = delivered('GY-11', ['src/one.ts'], '2026-09-25T08:10:00.000Z'), two = delivered('GY-12', ['src/two.ts'], '2026-09-25T08:20:00.000Z');
  const world = harness([one, two], { [sha40('d11')]: 'success', [sha40('d12')]: 'failure' });
  const guard = await guardMain(world.engine, world.github, now);
  // The suite ran on each merge commit, the culprit was named, the revert opened and landed head-bound.
  assert.equal(one.optimisticMerges![0].postMerge?.verdict, 'pass');
  assert.equal(two.optimisticMerges![0].postMerge?.verdict, 'fail');
  assert.deepEqual(world.opened.map(entry => entry.key), ['GY-12']);
  assert.match(world.opened[0].reason, /GY-12's merge [0-9a-f]{12} broke main \(test \(failure\)\); GY-11 stays/);
  assert.deepEqual(world.merged, [901]);
  // The culprit is reopened for a rework round with the failure attached; its merge record keeps the revert.
  assert.notEqual(two.stage, 'done');
  assert.equal(two.delivery, undefined);
  assert.equal(two.submission, null);
  assert.equal(two.pipeline!.reworkRounds, 1);
  assert.match(two.reopened!.reason, /GY-12's optimistic merge \(PR #112, [0-9a-f]{12}\) broke main: test \(failure\) on its merge commit\. It was reverted by PR #901/);
  assert.deepEqual({ state: two.optimisticMerges![0].revert!.state, pr: two.optimisticMerges![0].revert!.pr, kept: two.optimisticMerges![0].revert!.kept }, { state: 'merged', pr: 901, kept: ['GY-11'] });
  // The other merge stays delivered, untouched.
  assert.equal(one.stage, 'done');
  assert.equal(one.optimisticMerges![0].revert, null);
  assert.equal(guard.state, 'green');
  // Every step is on the ledger.
  assert.deepEqual(world.events.map(event => event.kind), ['optimistic.post-merge', 'optimistic.post-merge', 'optimistic.guard', 'optimistic.revert.opened', 'optimistic.revert.merged']);
  assert.equal(world.events.find(event => event.kind === 'optimistic.guard')!.details.state, 'culprit');
});

test('unit:optimistic-auto-revert several optimistic merges are bisected, and the ones after the culprit are re-tested on its revert', async () => {
  const merges = ['GY-21', 'GY-22', 'GY-23'].map((key, index) => delivered(key, [`src/${key}.ts`], `2026-09-25T08:${10 + index * 10}:00.000Z`));
  const [first, second, third] = merges;
  const checks: Record<string, string> = { [sha40('d23')]: 'failure' };
  const world = harness(merges, checks);
  // The newest merge failed; the two before it have not reported. The bisection asks for the middle one first.
  const probe = (state: GuardState) => state.state === 'await' ? state.probe.key : null;
  let guard = await guardMain(world.engine, world.github, now);
  assert.equal(probe(guard), 'GY-22');
  assert.equal(world.opened.length, 0, 'nothing is reverted on a guess');
  checks[sha40('d22')] = 'failure';
  guard = await guardMain(world.engine, world.github, now);
  assert.equal(probe(guard), 'GY-21');
  checks[sha40('d21')] = 'success';
  guard = await guardMain(world.engine, world.github, now);
  // GY-22 broke main: it is reverted; GY-21 and GY-23 stay.
  assert.deepEqual(world.opened.map(entry => entry.key), ['GY-22']);
  assert.equal(second.stage, 'ready');
  assert.deepEqual(second.optimisticMerges![0].revert!.kept, ['GY-21', 'GY-23']);
  // Each probe the bisection waited on is on the ledger, then the last green commit it settled on.
  assert.deepEqual(world.events.filter(event => event.kind === 'optimistic.guard').map(event => [event.details.state, event.details.probe ?? null]), [['await', sha40('d22')], ['await', sha40('d21')], ['culprit', null]]);
  assert.deepEqual(second.optimisticMerges![0].revert!.probes, [sha40('d21')]);
  assert.equal(first.stage, 'done'); assert.equal(third.stage, 'done');
  // GY-23 failed on a commit that still held GY-22: it is re-tested on the revert commit, not blamed.
  assert.equal(third.optimisticMerges![0].postMerge?.verdict, 'pending');
  assert.equal(third.optimisticMerges![0].postMerge?.on, sha40('e901'));
  assert.equal(guard.state, 'pending');
  checks[sha40('e901')] = 'success';
  guard = await guardMain(world.engine, world.github, now);
  assert.equal(guard.state, 'green');
  assert.equal(third.optimisticMerges![0].revert, null);
  // The pure bisection agrees: with all verdicts known it names the first failure.
  const window = ['p', 'p', 'f', 'f'].map((verdict, index) => ({ key: `GY-${index}`, id: `${index}`, mergeSha: sha40(`d${index}`), mergedAt: at, verdict: verdict === 'p' ? 'pending' as const : 'fail' as const, failing: [] }));
  assert.equal('probe' in bisectCulprit(window) && bisectCulprit(window).probes.length, 1);
  assert.deepEqual(postMergeVerdict([{ name: 'test', result: 'success', appId: ci }, { name: 'typecheck', result: 'failure', appId: ci }], ['test', 'typecheck'], [ci]), { verdict: 'fail', failing: ['typecheck (failure)'] });
  assert.deepEqual(postMergeVerdict([{ name: 'test', result: 'failure', appId: 1 }], ['test'], [ci]), { verdict: 'pending' }, 'an untrusted app decides nothing');
});

test('unit:optimistic-auto-revert the revert restores the culprit\'s files on the base tip and lands exactly that head through the bypass', async () => {
  const culprit = delivered('GY-51', ['src/changed.ts', 'src/added.ts', 'bin/tool.sh'], '2026-09-25T08:10:00.000Z');
  const merge = culprit.optimisticMerges![0], parent = sha40('p0'), tip = sha40('f9');
  const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 1, privateKey: '' });
  const calls: { path: string; method: string; body?: any }[] = [];
  let laterChanges = ['src/unrelated.ts'];
  (github as any).request = async (path: string, method = 'GET', body?: any) => {
    calls.push({ path, method, body });
    if (path === '/git/ref/heads/main') return { object: { type: 'commit', sha: tip } };
    if (path === `/commits/${tip}`) return { commit: { tree: { sha: sha40('e9') } } };
    if (path === `/commits/${merge.mergeSha}`) return { parents: [{ sha: parent }], commit: { tree: { sha: sha40('e8') } } };
    if (path === `/commits/${parent}`) return { commit: { tree: { sha: sha40('e0') } } };
    if (path.startsWith(`/compare/${merge.mergeSha}...${tip}`)) return { status: 'ahead', files: laterChanges.map(filename => ({ filename })) };
    if (path === `/git/trees/${sha40('e0')}`) return { tree: [{ path: 'src', type: 'tree', mode: '040000', sha: sha40('e1') }, { path: 'bin', type: 'tree', mode: '040000', sha: sha40('e2') }] };
    if (path === `/git/trees/${sha40('e1')}`) return { tree: [{ path: 'changed.ts', type: 'blob', mode: '100644', sha: sha40('0a') }] };
    if (path === `/git/trees/${sha40('e2')}`) return { tree: [{ path: 'tool.sh', type: 'blob', mode: '100755', sha: sha40('0b') }] };
    if (path === '/git/trees' && method === 'POST') return { sha: sha40('e7') };
    if (path === '/git/commits' && method === 'POST') return { sha: sha40('c7') };
    if (path.startsWith('/git/refs')) return {};
    if (path.startsWith('/pulls?state=open')) return [];
    if (path === '/pulls' && method === 'POST') return { number: 907 };
    if (path === '/pulls/907') return { merged: calls.some(call => call.path === 'graphql'), merge_commit_sha: sha40('e907') };
    if (path.startsWith('/check-runs')) return {};
    throw new Error(`unexpected ${method} ${path}`);
  };
  (github as any).pages = async () => [];
  (github as any).graphql = async (query: string, variables: any) => {
    calls.push({ path: 'graphql', method: 'POST', body: variables });
    return /mergeQueue/.test(query) ? { repository: { mergeQueue: null, pullRequest: { id: 'PR_907', headRefOid: sha40('c7'), mergeQueueEntry: null, autoMergeRequest: null } } } : {};
  };
  const opened = await github.openRevert(culprit, merge, 'GY-51 broke main');
  assert.deepEqual(opened, { pr: 907, head: sha40('c7') });
  const tree = calls.find(call => call.path === '/git/trees' && call.method === 'POST')!.body;
  assert.equal(tree.base_tree, sha40('e9'), 'the revert is built on the base tip');
  assert.deepEqual([...tree.tree].sort((a: any, b: any) => a.path.localeCompare(b.path)), [
    { path: 'bin/tool.sh', mode: '100755', type: 'blob', sha: sha40('0b') },
    { path: 'src/added.ts', mode: '100644', type: 'blob', sha: null },
    { path: 'src/changed.ts', mode: '100644', type: 'blob', sha: sha40('0a') },
  ], 'each file returns to its first-parent version, with its mode; a file the merge added is removed');
  assert.deepEqual(calls.find(call => call.path === '/git/commits')!.body.parents, [tip]);
  assert.equal(calls.find(call => call.path === '/pulls' && call.method === 'POST')!.body.head, `graphyard-revert/gy-51-${merge.mergeSha.slice(0, 12)}`);
  // It lands head-bound: the check names the revert, and the merge binds exactly the revert commit.
  assert.equal(await github.mergeRevert(culprit, { pr: 907, head: sha40('c7'), failing: ['test (failure)'] }), sha40('e907'));
  assert.deepEqual(calls.filter(call => call.path === 'graphql').at(-1)!.body, { id: 'PR_907', head: sha40('c7'), method: 'MERGE' });
  // A later merge that changed one of the culprit's files refuses the revert before anything is written.
  laterChanges = ['src/changed.ts'];
  const writes = calls.filter(call => call.method !== 'GET').length;
  assert.match((await github.openRevert(culprit, merge, 'x') as { refusal: string }).refusal, /Later merges changed src\/changed\.ts/);
  assert.equal(calls.filter(call => call.method !== 'GET').length, writes);
});

test('unit:optimistic-auto-revert a culprit a later merge built on is not reverted blind: optimistic merges hold until main passes', async () => {
  const culprit = delivered('GY-31', ['src/culprit.ts'], '2026-09-25T08:10:00.000Z');
  assert.match(revertRefusal(culprit.optimisticMerges![0], ['src/culprit.ts', 'src/other.ts'])!, /Later merges changed src\/culprit\.ts after [0-9a-f]{12}/);
  assert.equal(revertRefusal(culprit.optimisticMerges![0], ['src/other.ts']), null);
  const world = harness([culprit], { [sha40('d31')]: 'failure' });
  (world.github as any).openRevert = async () => ({ refusal: 'Later merges changed src/culprit.ts after it' });
  const guard = await guardMain(world.engine, world.github, now);
  assert.equal(guard.state, 'refused');
  assert.equal(culprit.stage, 'done', 'nothing is reopened without a revert');
  // While main is red, nothing else merges optimistically, and master status names the fix the master files.
  const next = item('GY-32', ['src/next.ts'], []);
  assert.match((optimisticEligibility(next, [culprit, next], { enabled: true, gatesPass: true }) as { reasons: string[] }).reasons.join('; '), /Main is red after an optimistic merge/);
  const [attention] = optimisticGuardAttention([culprit]);
  assert.equal(attention.subject, 'GY-31');
  assert.equal(attention.role, 'master');
  assert.match(attention.next, /graphyard master create FILE REASON files the fix for GY-31/);
  // Once the base branch tip passes again the hold is released.
  world.checks[sha40('f9')] = 'success';
  assert.equal((await guardMain(world.engine, world.github, now)).state, 'green');
  assert.equal(optimisticEligibility(next, [culprit, next], { enabled: true, gatesPass: true }).eligible, true);
});

// ---------------------------------------------------------------------------
// unit:optimistic-metrics (AC-3)
// ---------------------------------------------------------------------------
test('unit:optimistic-metrics master status and Insights count optimistic merges, reverts and time-to-merge per lane', () => {
  const minute = 60_000;
  // Two optimistic merges, 1 and 3 minutes from lane to merge; one of them reverted since.
  const kept = delivered('GY-41', ['src/a.ts'], '2026-09-25T08:10:00.000Z');
  kept.optimisticMerges![0].postMerge = { verdict: 'pass', observedAt: at };
  const reverted = delivered('GY-42', ['src/b.ts'], '2026-09-25T08:20:00.000Z');
  reverted.optimisticMerges![0].lane.at = new Date(Date.parse('2026-09-25T08:20:00.000Z') - 3 * minute).toISOString();
  reverted.optimisticMerges![0].postMerge = { verdict: 'fail', failing: ['test (failure)'], observedAt: at };
  applyRevert(reverted, sha40('d42'), { at, failing: ['test (failure)'], probes: [], kept: ['GY-41'], state: 'merged', pr: 901, head: sha40('c1'), mergeSha: sha40('e1'), refusal: null }, now);
  // Two queued deliveries, 10 and 30 minutes from entering the queue to merge; a closed item counts nowhere.
  const queued = (key: string, enqueued: string, mergedAt: string) => Object.assign(item(key, ['src/q.ts'], null), { stage: 'done', delivery: { mergedAt, mergeSha: sha40(`d${key.slice(3)}`), authorizationRevision: 1 },
    queueHistory: [{ at: '2026-09-25T06:00:00.000Z', event: 'enqueued', sequence: 1 }, { at: '2026-09-25T06:05:00.000Z', event: 'ejected', sequence: 1, reason: 'x' }, { at: enqueued, event: 'enqueued', sequence: 2 }] }) as Work;
  const all = [kept, reverted, queued('GY-43', '2026-09-25T07:00:00.000Z', '2026-09-25T07:10:00.000Z'), queued('GY-44', '2026-09-25T07:00:00.000Z', '2026-09-25T07:30:00.000Z'),
    Object.assign(queued('GY-45', '2026-09-25T07:00:00.000Z', '2026-09-25T09:00:00.000Z'), { closure: { reason: 'closed', at } }) as Work];
  const metrics = optimisticMetrics(all);
  assert.equal(metrics.enabled, true);
  assert.equal(metrics.merges, 2);
  assert.equal(metrics.reverts, 1);
  assert.deepEqual(metrics.postMerge, { passed: 1, failed: 1, pending: 0 });
  assert.deepEqual(metrics.timeToMerge.optimistic, { count: 2, p50Ms: 1 * minute, p90Ms: 3 * minute });
  assert.deepEqual(metrics.timeToMerge.queued, { count: 2, p50Ms: 10 * minute, p90Ms: 30 * minute });
  assert.equal(metrics.guard.state, 'green');
  assert.equal(optimisticMetrics([], false).enabled, false);
  assert.deepEqual(optimisticGuardAttention(all), [], 'a green main raises nothing');
  // master status reports the setting beside the batch size, and the same counters.
  const status = optimisticStatus({ mergeQueue: { optimistic: false } }, all, 4);
  assert.deepEqual(status.mergeQueue, { batchSize: 4, optimistic: false });
  assert.deepEqual([status.optimisticMerge.enabled, status.optimisticMerge.merges, status.optimisticMerge.reverts], [false, 2, 1]);
  // Insights draws the same counters.
  const markup = renderToStaticMarkup(createElement(OptimisticMerges, { work: all, enabled: true }));
  assert.match(markup, /data-count="merges">2</);
  assert.match(markup, /data-count="reverts">1</);
  assert.match(markup, /data-lane="Optimistic"><th scope="row">Optimistic<\/th><td>2<\/td><td>1m<\/td><td>3m<\/td>/);
  assert.match(markup, /data-lane="Queued"><th scope="row">Queued<\/th><td>2<\/td><td>10m<\/td><td>30m<\/td>/);
  assert.match(markup, /data-optimistic="on"/);
});
