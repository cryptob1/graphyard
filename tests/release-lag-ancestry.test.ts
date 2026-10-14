import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { releaseLag, releaseLagGraceMs, type LagComponent, type LagDelivery, type PromotionWait, type ReleaseLagReport } from '../src/master/release-lag.js';
import { agentOwner, type AttentionItem } from '../src/master/attention.js';
import { shortCommit } from '../src/executor-fleet.js';
import { alignedWithDeployment, describePromotion, promotionOnSchedule } from '../src/master/release-lag.js';
import type { ChildRun } from '../src/child-runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1776: the release-lag report answers every delivery's ancestry with one git child run per
 * component. Until this item it ran `git merge-base --is-ancestor` once per delivery per component,
 * so `master status` on a plane with hundreds of deliveries spent seconds in git subprocesses.
 *
 * The fake git is a linear history: a commit contains every commit at or before it in `order`.
 * It answers the shipped read — `rev-list --right-only --ignore-missing COMMIT...MERGE …` lists
 * the commits reachable from a merge but not from the commit, dropping a range either side of
 * which it cannot place — and the legacy read, `merge-base --is-ancestor MERGE COMMIT`, exiting 1
 * for "not contained" and 128 for a commit it cannot place. `legacyReleaseLag` is the report as it
 * stood before this item, over the legacy read: the oracle for "the same rows, attention and
 * promotion fields as before".
 */
const sha = (n: number) => n.toString(16).padStart(40, '0');
const unknown = 'f'.repeat(40);

function fakeGit(order: readonly string[]) {
  const calls: string[][] = [];
  const positions = new Map(order.map((commit, at) => [commit, at]));
  const index = (commit: string) => positions.get(commit) ?? -1;
  const run: ChildRun = (command, args) => {
    assert.equal(command, 'git');
    calls.push(args);
    const [flag, root, op, ...operands] = args;
    assert.deepEqual([flag, root], ['-C', '/coordinator']);
    if (op === 'rev-list') {
      assert.deepEqual(operands.slice(0, 2), ['--right-only', '--ignore-missing'], 'the right side of the symmetric differences, dropping what git cannot place');
      const listed = new Set<string>();
      for (const range of operands.slice(2)) {
        const [commit, merge] = range.split('...');
        const from = index(commit), to = index(merge);
        if (from < 0 || to < 0) continue;
        for (let at = from + 1; at <= to; at++) listed.add(order[at]);
      }
      return `${[...listed].join('\n')}\n`;
    }
    if (op === 'merge-base' && operands[0] === '--is-ancestor') {
      const [merge, commit] = operands.slice(1);
      if (index(commit) < 0 || index(merge) < 0) throw Object.assign(new Error(`fatal: Not a valid commit name ${index(commit) < 0 ? commit : merge}`), { status: 128 });
      if (index(merge) <= index(commit)) return '';
      throw Object.assign(new Error('not an ancestor'), { status: 1 });
    }
    throw new Error(`fake git cannot answer: git ${args.slice(2).join(' ')}`);
  };
  return { run, calls };
}

/** The report exactly as it stood before GY-1776: one `merge-base --is-ancestor` per delivery per component. */
async function legacyReleaseLag(baseTip: string | null, deliveries: readonly LagDelivery[], components: readonly LagComponent[],
  deps: { root: string; run: ChildRun; now: number; graceMs?: number; promotion?: PromotionWait | null }): Promise<ReleaseLagReport> {
  const sameCommit = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));
  const graceMs = deps.graceMs ?? releaseLagGraceMs;
  const contains = async (commit: string, mergeSha: string): Promise<boolean> => {
    if (commit === mergeSha) return true;
    try { await deps.run('git', ['-C', deps.root, 'merge-base', '--is-ancestor', mergeSha, commit]); return true; }
    catch (error: any) { return error?.status !== 1; }
  };
  const wait = deps.promotion ?? null;
  const onSchedule = promotionOnSchedule(wait, deps.now);
  const pending = new Set(wait?.pending ?? []);
  const rows = components.map(async component => {
    const commit = component.release.commit;
    const behind: LagDelivery[] = [];
    for (const delivery of deliveries) if (commit && !(await contains(commit, delivery.mergeSha.toLowerCase()))) behind.push(delivery);
    const awaiting = new Set(onSchedule ? behind.filter(delivery => pending.has(delivery.key)).map(delivery => delivery.key) : []);
    const counted = behind.filter(delivery => !awaiting.has(delivery.key));
    const began = [counted.length >= 2 ? Date.parse(counted[1].mergedAt) : Number.NaN, component.startedAt ? Date.parse(component.startedAt) : Number.NaN].filter(Number.isFinite);
    const since = counted.length >= 2 && began.length ? new Date(Math.max(...began)).toISOString() : null;
    const late = counted.length > 1 && !!since && deps.now - Date.parse(since) > graceMs;
    return { component: component.name, label: component.label, release: component.release, baseTip, behind: behind.map(({ key, mergedAt }) => ({ key, mergedAt })), since, late, awaitingPromotion: [...awaiting], restart: component.restart };
  });
  const settled = await Promise.all(rows);
  const servesDeployed = (row: ReleaseLagReport['components'][number]) => !!wait && alignedWithDeployment(wait) && sameCommit(row.release.commit, wait.deployedSha);
  const attention: AttentionItem[] = settled.filter(row => row.late).map(row => ({
    subject: row.component === 'loop' ? 'loop' : row.component,
    text: `${row.label} runs ${shortCommit(row.release.commit)}${row.release.dirty ? ' (dirty)' : ''}, more than one delivery behind the base tip ${shortCommit(baseTip)} since ${row.since}: ${row.behind.map(entry => entry.key).join(', ')} merged and are not in what it loads${servesDeployed(row) ? `; it runs the verified release production serves, and ${wait!.pending.length ? `${wait!.pending.join(', ')} wait on ${describePromotion(wait!)}` : `the rest wait on ${describePromotion(wait!)}`}` : ''}`,
    ...agentOwner('master', servesDeployed(row)
      ? `Nothing to restart: ${row.label.toLowerCase()} already runs ${shortCommit(wait!.deployedSha)}, the release production serves, and loads the rest once a verified release serves them. ${onSchedule ? `They wait on ${describePromotion(wait!)}` : `${describePromotion(wait!)} has passed with no candidate in validation: master status names the promotion drive under promotion${row.component === 'loop' ? ', and a restart the self-upgrade owes onto a checkout ahead of what the loop loaded (GY-1464) under upgrade' : ''}`}`
      : row.restart ?? `The loop upgrades itself between cycles once a delivery is verified deployed; a dirty or non-detached coordinator checkout holds it back, and master status names it under upgrade`) }));
  return { baseTip, components: settled, attention, promotion: wait ? { nextDueAt: wait.nextDueAt, inFlight: wait.inFlight, onSchedule, pending: wait.pending } : null };
}

const now = Date.parse('2026-10-13T12:00:00.000Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
const minute = 60_000, hour = 60 * minute;
const component = (name: string, commit: string | null, startedAt = ago(3 * hour)): LagComponent =>
  ({ name, label: name === 'loop' ? 'The master loop' : `Executor ${name}`, release: { commit, dirty: false }, startedAt, restart: name === 'loop' ? null : `systemctl --user restart graphyard-executor@${name}.service` });

// A history of base, three delivered merges, and a commit past the base tip (a checkout ahead of what main holds).
const [base, one, two, three, ahead] = [sha(1), sha(2), sha(3), sha(4), sha(5)];
const history = [base, one, two, three, ahead];
const deliveries: LagDelivery[] = [
  { key: 'GY-1', mergeSha: one, mergedAt: ago(2 * hour) },
  { key: 'GY-2', mergeSha: two, mergedAt: ago(hour) },
  { key: 'GY-3', mergeSha: three, mergedAt: ago(20 * minute) },
];
const components: LagComponent[] = [
  component('loop', base), component('exec-behind', base), component('exec-mid', two), component('exec-equal', three),
  component('exec-ahead', ahead), component('exec-unplaced', unknown), component('exec-unread', null), component('exec-young', base, ago(5 * minute)),
];
const waits: (PromotionWait | null)[] = [
  null,
  { deployedSha: base, alignedRelease: base, pending: ['GY-1', 'GY-2', 'GY-3'], nextDueAt: ago(-30 * minute), inFlight: false },
  { deployedSha: base, alignedRelease: base, pending: ['GY-3'], nextDueAt: ago(-30 * minute), inFlight: false },
  { deployedSha: base, alignedRelease: base, pending: ['GY-1', 'GY-2', 'GY-3'], nextDueAt: ago(30 * minute), inFlight: false },
  { deployedSha: base, alignedRelease: base, pending: ['GY-1', 'GY-2', 'GY-3'], nextDueAt: ago(30 * minute), inFlight: true },
  { deployedSha: two, alignedRelease: base, pending: ['GY-3'], nextDueAt: ago(-30 * minute), inFlight: false },
];

test('unit:release-lag-one-call-per-component — releaseLag runs git at most once per component whatever the number of deliveries, and returns the same rows, attention and promotion fields as the per-delivery read did for components ahead of, behind and equal to the base tip, one delivery behind, young, unread, and a release commit git cannot place, under every promotion wait', async () => {
  for (const promotion of waits) {
    const fresh = fakeGit(history), legacy = fakeGit(history);
    const report = await releaseLag(three, deliveries, components, { root: '/coordinator', run: fresh.run, now, promotion });
    const expected = await legacyReleaseLag(three, deliveries, components, { root: '/coordinator', run: legacy.run, now, promotion });
    assert.deepEqual(report, expected, `the same report as the per-delivery read, promotion ${JSON.stringify(promotion)}`);
    assert.ok(fresh.calls.length <= components.length, `${fresh.calls.length} git runs for ${components.length} components`);
    assert.ok(fresh.calls.every(args => args[2] === 'rev-list' && args.slice(5).length === deliveries.length), 'every run lists every delivery against one release');
    assert.ok(legacy.calls.length > fresh.calls.length, 'the per-delivery read ran more');
    // Components sharing a release share one answer; a component with no release runs nothing.
    const releases = new Set(components.map(entry => entry.release.commit).filter((commit): commit is string => !!commit));
    assert.equal(fresh.calls.length, releases.size);
    assert.deepEqual(new Set(fresh.calls.map(args => args[5].split('...')[0])), releases);
  }
  // The rows, spelled out: what each component is behind, and who is named.
  const report = await releaseLag(three, deliveries, components, { root: '/coordinator', run: fakeGit(history).run, now });
  const rows = Object.fromEntries(report.components.map(row => [row.component, row]));
  assert.deepEqual(Object.fromEntries(Object.entries(rows).map(([name, row]) => [name, row.behind.map(entry => entry.key)])),
    { loop: ['GY-1', 'GY-2', 'GY-3'], 'exec-behind': ['GY-1', 'GY-2', 'GY-3'], 'exec-mid': ['GY-3'], 'exec-equal': [], 'exec-ahead': [], 'exec-unplaced': [], 'exec-unread': [], 'exec-young': ['GY-1', 'GY-2', 'GY-3'] });
  assert.deepEqual(report.attention.map(item => item.subject), ['loop', 'exec-behind'], 'late components are named; a young one, one delivery behind, equal, ahead, unplaced and unread are not');
  assert.equal(rows['exec-young'].late, false);
  assert.equal(report.promotion, null);
  // No deliveries: nothing is asked.
  const none = fakeGit(history);
  const empty = await releaseLag(three, [], components, { root: '/coordinator', run: none.run, now });
  assert.deepEqual(none.calls, []);
  assert.ok(empty.components.every(row => row.behind.length === 0 && !row.late));
  // A run that fails outright (no repository under the root) leaves every delivery uncounted, as before.
  const failing: ChildRun = () => { throw Object.assign(new Error('fatal: not a git repository'), { status: 128 }); };
  const unread = await releaseLag(three, deliveries, components, { root: '/coordinator', run: failing, now });
  assert.ok(unread.components.every(row => row.behind.length === 0), 'nothing is counted on what git cannot answer');
  assert.deepEqual(unread.attention, []);

  // Against real git, the shipped read answers the same rows with exactly one child run per release.
  const root = await temporaryDirectory('release-lag-ancestry');
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q');
    const commit = (message: string) => { git('commit', '-q', '--allow-empty', '-m', message); return git('rev-parse', 'HEAD'); };
    const realBase = commit('base'), realOne = commit('one'), realTwo = commit('two'), realThree = commit('three'), realAhead = commit('ahead');
    const realDeliveries: LagDelivery[] = [
      { key: 'GY-1', mergeSha: realOne, mergedAt: ago(2 * hour) }, { key: 'GY-2', mergeSha: realTwo, mergedAt: ago(hour) }, { key: 'GY-3', mergeSha: realThree, mergedAt: ago(20 * minute) },
      // A merge this checkout does not hold is never counted against anyone.
      { key: 'GY-4', mergeSha: unknown, mergedAt: ago(10 * minute) },
    ];
    const realComponents = [component('loop', realBase), component('exec-mid', realTwo), component('exec-equal', realThree), component('exec-ahead', realAhead), component('exec-unplaced', 'e'.repeat(40))];
    const calls: string[][] = [];
    const counting: ChildRun = (command, args) => { calls.push(args); return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); };
    const real = await releaseLag(realThree, realDeliveries, realComponents, { root, run: counting, now });
    assert.equal(calls.length, realComponents.length, 'one git run per component');
    assert.deepEqual(Object.fromEntries(real.components.map(row => [row.component, row.behind.map(entry => entry.key)])),
      { loop: ['GY-1', 'GY-2', 'GY-3'], 'exec-mid': ['GY-3'], 'exec-equal': [], 'exec-ahead': [], 'exec-unplaced': [] });
    assert.deepEqual(real.attention.map(item => item.subject), ['loop']);
    assert.match(real.attention[0].text, new RegExp(`^The master loop runs ${realBase.slice(0, 12)}, more than one delivery behind the base tip ${realThree.slice(0, 12)} since ${realDeliveries[1].mergedAt}: GY-1, GY-2, GY-3 merged`));
    // The same rows the legacy read computes over the real repository.
    const expected = await legacyReleaseLag(realThree, realDeliveries, realComponents, { root, run: counting, now });
    assert.deepEqual(real, expected);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:release-lag-bounded-time — with 1,500 deliveries and three components against a stubbed child runner, releaseLag completes in under one second and runs git at most three times', async () => {
  const merges = Array.from({ length: 1500 }, (_, n) => sha(10 + n));
  const order = [sha(1), ...merges, sha(2000)];
  const many: LagDelivery[] = merges.map((mergeSha, n) => ({ key: `GY-${n + 1}`, mergeSha, mergedAt: ago((1500 - n) * minute) }));
  const three = [component('loop', sha(1)), component('exec-mid', merges[750]), component('exec-equal', merges[1499])];
  const fake = fakeGit(order);
  const started = performance.now();
  const report = await releaseLag(merges[1499], many, three, { root: '/coordinator', run: fake.run, now });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1000, `releaseLag took ${elapsed.toFixed(0)} ms`);
  assert.ok(fake.calls.length <= 3, `${fake.calls.length} git runs for three components`);
  const rows = Object.fromEntries(report.components.map(row => [row.component, row.behind.length]));
  assert.deepEqual(rows, { loop: 1500, 'exec-mid': 749, 'exec-equal': 0 });
  assert.deepEqual(report.attention.map(item => item.subject), ['loop', 'exec-mid']);
});
