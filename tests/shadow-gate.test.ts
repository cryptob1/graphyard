import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { daemonStateSchema, daemonSummary, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { keepVerdicts, shadowErrorKey, shadowKeptVerdicts, shadowLeftoverKey, shadowReads, shadowIdle, shadowStateSchema, shadowTimeoutKey, shadowTimeoutRetries, shadowVerdictBody, shadowVerdictKey } from '../src/daemon/cycle-shadow.js';
import { compareVerdicts, githubOutcome, judgedVerdicts, shadowDue, shadowGateAttention, shadowReport, submittedAtOf, trialLogTailLength, type ShadowVerdict } from '../src/merge-writer/shadow.js';
import { trialNeedsLog, TrialCleanupError, TrialTimeoutError, type TrialRun } from '../src/merge-writer/trial.js';
import { daemonEffects } from '../src/daemon/effects.js';
import { maxShadowTimeoutMinutes, shadowGateSettings, shadowGateSettingsSchema } from '../src/master/merge-writer-settings.js';
import { masterConfigSchema } from '../src/master.js';
import type { Principal, Work } from '../src/model.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1522: the shadow merge gate trial-merges one submitted head per cycle beside GitHub's gate,
// records the verdict, compares it with what GitHub then did, and writes nothing.

const start = Date.parse('2030-03-01T00:00:00Z');
const minute = 60_000;
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const item = (fields: Record<string, unknown>) => ({
  description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item'] }],
  policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: [], revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start),
  stageEnteredAt: iso(start), ready: true, epoch: 1, lease: null, workspaces: [], submission: null, candidate: null, reworkRequested: false,
  scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], gates: [], stage: 'build', ...fields,
}) as unknown as Work;
const submitted = (n: number, minutesAgo: number, fields: Record<string, unknown> = {}) => item({ id: `w${n}`, key: `GY-${n}`, stageEnteredAt: iso(start - minutesAgo * minute),
  submission: { epoch: 1, pr: n }, candidate: { sha: sha(`head${n}`), baseSha: sha('base'), pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' }, ...fields });
const tip = sha('main-tip');
const pipelined = (n: number, submittedAt: number, fields: Record<string, unknown> = {}) => submitted(n, 0, { pipeline: { submittedAt: iso(submittedAt), resubmittedAt: null }, ...fields });

test('unit:shadow-due-selection — submission time orders the trials, not stage entry; a head GitHub already merged has no turn, and only a delivery of this very head counts for GitHub', () => {
  const late = pipelined(1, start - 5 * minute, { stageEnteredAt: iso(start - 90 * minute) }), early = pipelined(2, start - 50 * minute, { stageEnteredAt: iso(start - 10 * minute) });
  assert.equal(shadowDue([late, early], [], tip)?.key, 'GY-2', 'the earlier submission goes first even though its stage was entered later');
  const resubmitted = pipelined(3, start - 80 * minute, { pipeline: { submittedAt: iso(start - 80 * minute), resubmittedAt: iso(start - 1 * minute) } });
  assert.equal(shadowDue([resubmitted, late], [], tip)?.key, 'GY-1', 'a resubmitted head is as old as its resubmission');
  // The loop's coordination view drops the pipeline timeline: there the moment this very head was observed orders, then the pull request's creation, then the stage entry.
  const observedLate = submitted(8, 90, { headObserved: { pr: 8, sha: sha('head8'), at: iso(start - 2 * minute) } }), observedEarly = submitted(9, 10, { headObserved: { pr: 9, sha: sha('head9'), at: iso(start - 40 * minute) } });
  assert.equal(shadowDue([observedLate, observedEarly], [], tip)?.key, 'GY-9', 'the head observed earlier goes first, whatever the stage entry');
  const staleObservation = submitted(10, 10, { headObserved: { pr: 10, sha: sha('older-head'), at: iso(start - 99 * minute) }, candidate: { sha: sha('head10'), baseSha: sha('base'), pr: 10, branch: 'b', author: 'w', createdAt: iso(start - 20 * minute) } });
  assert.equal(submittedAtOf(staleObservation), start - 20 * minute, 'an observation of an earlier head does not date the current one; the pull request creation does');
  assert.equal(submittedAtOf(submitted(11, 30)), start - 30 * minute, 'without either, the stage entry');
  const merged = pipelined(4, start - 99 * minute, { observation: { merged: true, candidate: { sha: sha('head4') }, checks: [] } });
  assert.equal(shadowDue([merged, late], [], tip)?.key, 'GY-1', 'GitHub merged GY-4 before its turn');
  const earlier = sha('old-head'), delivered = item({ id: 'd', key: 'GY-7', stage: 'done', candidate: { sha: sha('final') }, delivery: { mergedAt: iso(start), mergeSha: sha('d'), authorizationRevision: 1 } });
  assert.equal(githubOutcome(delivered, sha('final')), 'merged');
  assert.equal(githubOutcome(delivered, earlier), 'pending', 'an earlier reworked head was never what GitHub merged');
});

test('unit:shadow-step-records-verdict — a verdict the coordinator refuses is retried under the same key before the pair counts as tried, and eviction spares still-open pairs', async () => {
  const git = recordingGit(), now = () => start;
  let failing = 2;
  const posts: string[] = [];
  const reads = shadowReads(config, '/coordinator', git.run, { base: '/w', trial: async () => trialRun, record: async (work, entry) => { posts.push(`${work.id}:${entry.head}`); if (failing-- > 0) throw new Error('route down'); } });
  const work = [submitted(1, 30), submitted(2, 20)];
  const state = emptyDaemonState(config), effects = effectsFor({ work: () => work, now, shadow: reads });
  await runCycle(config, state, effects, now); await shadowIdle(state);
  await runCycle(config, state, effects, now);
  assert.deepEqual([state.shadow.length, posts.length], [0, 1], 'a refused post leaves the pair untried');
  await runCycle(config, state, effects, now);
  assert.deepEqual([state.shadow.length, posts.length], [0, 2], 'retried next cycle, no new trial started meanwhile');
  await runCycle(config, state, effects, now);
  assert.deepEqual([state.shadow.map(entry => entry.key), new Set(posts).size], [['GY-1'], 1], 'recorded on the third attempt, one head throughout');
  const many = Array.from({ length: shadowKeptVerdicts + 5 }, (_, index) => ({ ...verdict(`GY-${index}`), id: `w${index}` }));
  const stillOpen = submitted(0, 1, { id: 'w0', key: 'GY-0', candidate: { sha: many[0]!.head, branch: 'b' } });
  const kept = keepVerdicts(many, [stillOpen]);
  assert.equal(kept.length, shadowKeptVerdicts);
  assert.ok(kept.some(entry => entry.key === 'GY-0'), 'the oldest verdict survives because its item is still open at that head');
});

test('unit:shadow-due-selection — shadowDue picks the submitted head with the oldest submission that lacks a verdict for (head, main tip), one per cycle; delivered, unsubmitted and already-tried heads are skipped, and a moved tip makes a head due again', () => {
  const work = [submitted(3, 5), submitted(1, 30), submitted(2, 20), item({ id: 'w4', key: 'GY-4' }), submitted(5, 60, { stage: 'done' })];
  assert.equal(shadowDue(work, [], tip)?.key, 'GY-1', 'oldest submission first, and only one');
  const tried = [{ head: sha('head1'), baseTip: tip }];
  assert.equal(shadowDue(work, tried, tip)?.key, 'GY-2');
  assert.equal(shadowDue(work, [...tried, { head: sha('head2'), baseTip: tip }, { head: sha('head3'), baseTip: tip }], tip), null, 'nothing is due once every head has a verdict');
  assert.equal(shadowDue(work, tried, sha('newer-tip'))?.key, 'GY-1', 'a verdict against an older tip does not count');
  assert.equal(shadowDue([], [], tip), null);
});

const verdict = (key: string, overrides: Partial<ShadowVerdict> = {}): ShadowVerdict => ({ key, id: `w-${key}`, head: sha(`h-${key}`), baseTip: tip, mergeSha: sha(`m-${key}`), risk: 'normal', build: 'pass',
  tests: { passed: 3, failed: [], files: 3 }, conflict: [], durationMs: 1000, at: iso(start), outcome: 'pending', ...overrides });
const failedTests = { passed: 2, failed: ['tests/x.test.ts'], files: 3 };

test('unit:shadow-compare — compareVerdicts gives agree-pass, agree-fail, shadow-only-fail, shadow-missed (a shadow pass the main guard reverted) or pending, githubOutcome reads GitHub\'s side from the item, and shadowReport counts, times and lists the newest ten disagreements', () => {
  const pass = verdict('GY-1'), fail = verdict('GY-2', { tests: failedTests }), conflicted = verdict('GY-3', { mergeSha: null, conflict: ['a.txt'], build: 'fail' });
  assert.deepEqual([compareVerdicts(pass, 'merged'), compareVerdicts(pass, 'reverted'), compareVerdicts(pass, 'pending'), compareVerdicts(pass, 'failed')], ['agree-pass', 'shadow-missed', 'pending', 'pending']);
  assert.deepEqual([compareVerdicts(fail, 'merged'), compareVerdicts(fail, 'failed'), compareVerdicts(fail, 'reverted'), compareVerdicts(fail, 'pending')], ['shadow-only-fail', 'agree-fail', 'agree-fail', 'pending']);
  assert.equal(compareVerdicts(conflicted, 'merged'), 'shadow-only-fail', 'a conflict GitHub merged anyway is a shadow-only failure');
  assert.equal(compareVerdicts(verdict('GY-4', { build: 'fail' }), 'failed'), 'agree-fail');
  const delivered = item({ id: 'd', key: 'GY-1', stage: 'done', candidate: { sha: pass.head }, delivery: { mergedAt: iso(start), mergeSha: sha('d'), authorizationRevision: 1 } });
  const reverted = item({ id: 'r', key: 'GY-5', stage: 'done', candidate: { sha: pass.head }, delivery: { mergedAt: iso(start), mergeSha: sha('r'), authorizationRevision: 1 }, mainGuardReverts: [{ mergeSha: sha('r'), pr: 5, failing: ['test'], revert: null, state: 'merged', at: iso(start), settledAt: iso(start), revertSha: sha('rr'), reason: null }] });
  const red = submitted(6, 1, { observation: { candidate: { sha: sha('head6') }, checks: [{ name: 'test', result: 'failure', appId: 15368 }] } });
  assert.deepEqual([githubOutcome(delivered, pass.head), githubOutcome(reverted, pass.head), githubOutcome(red, sha('head6')), githubOutcome(red, sha('older')), githubOutcome(undefined, pass.head)], ['merged', 'reverted', 'failed', 'pending', 'pending']);
  // Only a revert of this head's own merge counts. An earlier delivery of the item the main guard reverted, fixed and
  // redelivered under a new head, leaves its revert on the record; that record says nothing about the new merge.
  const revertOf = (mergeSha: string, state: 'opened' | 'merged' | 'abandoned', fields: Record<string, unknown> = {}) => ({ mergeSha, pr: 5, failing: ['test'], revert: null, state, at: iso(start), settledAt: state === 'opened' ? null : iso(start), revertSha: null, reason: null, ...fields });
  const delivery = (mergeSha: string) => ({ mergedAt: iso(start + minute), mergeSha, authorizationRevision: 1 });
  const redelivered = item({ id: 'rd', key: 'GY-8', stage: 'done', candidate: { sha: pass.head }, delivery: delivery(sha('second-merge')), mainGuardReverts: [revertOf(sha('first-merge'), 'merged', { revertSha: sha('rr') })] });
  assert.equal(githubOutcome(redelivered, pass.head), 'merged', 'the revert of the earlier merge does not revert the redelivered head');
  assert.equal(compareVerdicts(pass, githubOutcome(redelivered, pass.head)), 'agree-pass');
  assert.equal(compareVerdicts(fail, githubOutcome(redelivered, pass.head)), 'shadow-only-fail');
  // A revert the guard opened or abandoned already judged the merge; a record whose cause is a cancelled CI run judged nothing.
  const guarded = (revert: Record<string, unknown>) => item({ id: 'g', key: 'GY-9', stage: 'done', candidate: { sha: pass.head }, delivery: delivery(sha('g-merge')), mainGuardReverts: [revert] });
  assert.deepEqual([githubOutcome(guarded(revertOf(sha('g-merge'), 'opened')), pass.head), githubOutcome(guarded(revertOf(sha('g-merge'), 'abandoned', { cause: 'conflict' })), pass.head), githubOutcome(guarded(revertOf(sha('g-merge'), 'abandoned', { cause: 'cancelled' })), pass.head)], ['reverted', 'reverted', 'merged']);
  // A reverted item is reopened with its delivery and candidate cleared. The verdict remembers the merge it saw delivered, so the
  // revert of exactly that merge still reads through the rework and the redelivery, while the new head is judged on its own merge.
  const first = sha('merge-1'), second = sha('merge-2'), newHead = sha('new-head');
  const seen = judgedVerdicts([pass], [item({ id: pass.id, key: 'GY-1', stage: 'done', candidate: { sha: pass.head }, delivery: delivery(first) })]);
  assert.deepEqual([seen[0]!.delivered, seen[0]!.outcome], [{ mergeSha: first }, 'agree-pass'], 'the merge of the head is remembered on the verdict');
  const reopened = item({ id: pass.id, key: 'GY-1', stage: 'ready', candidate: null, submission: null, mainGuardReverts: [revertOf(first, 'merged', { revertSha: sha('rr') })] });
  assert.equal(githubOutcome(reopened, pass.head), 'pending', 'a snapshot alone no longer links the head to its merge');
  assert.equal(judgedVerdicts(seen, [reopened])[0]!.outcome, 'shadow-missed', 'the remembered merge does');
  const again = item({ id: pass.id, key: 'GY-1', stage: 'done', candidate: { sha: newHead }, delivery: delivery(second), mainGuardReverts: [revertOf(first, 'merged', { revertSha: sha('rr') })] });
  const later = judgedVerdicts([...seen, verdict('GY-1', { head: newHead, at: iso(start + minute) })], [again]);
  assert.deepEqual(later.map(entry => [entry.outcome, entry.delivered?.mergeSha]), [['shadow-missed', first], ['agree-pass', second]], 'each head against its own merge');
  assert.deepEqual(shadowStateSchema.parse(later.map(entry => ({ ...entry }))), later, 'the remembered merge persists in the loop state');
  // A base refresh replaces head H with its successor H2 and keeps H on the snapshot as baseRefresh.from.sha. GitHub merged H2,
  // never H: H2's delivery is H2's outcome alone, H stays pending, and a main-guard revert of H2's merge misses only H2.
  const refreshedAway = sha('refreshed-away'), successor = sha('successor'), successorMerge = sha('successor-merge');
  const refresh = { at: iso(start), base: tip, baseTree: sha('tree'), from: { sha: refreshedAway, baseSha: sha('base') }, head: successor, carry: null, merge: null, trigger: 'behind base', policyRevision: 1 };
  const refreshedDelivered = item({ id: 'rf', key: 'GY-12', stage: 'done', candidate: { sha: successor }, baseRefresh: refresh, delivery: delivery(successorMerge) });
  assert.deepEqual([githubOutcome(refreshedDelivered, refreshedAway), githubOutcome(refreshedDelivered, successor)], ['pending', 'merged'], 'the delivery belongs to the refreshed head, not the one it replaced');
  const oldVerdict = verdict('GY-12', { id: 'rf', head: refreshedAway, tests: failedTests }), newVerdict = verdict('GY-12', { id: 'rf', head: successor, at: iso(start + minute) });
  const afterRefresh = judgedVerdicts([oldVerdict, newVerdict], [refreshedDelivered]);
  assert.deepEqual(afterRefresh.map(entry => [entry.outcome, entry.delivered?.mergeSha ?? null]), [['pending', null], ['agree-pass', successorMerge]], 'the replaced head is not judged by its successor\'s merge');
  const refreshedReverted = item({ id: 'rf', key: 'GY-12', stage: 'done', candidate: { sha: successor }, baseRefresh: refresh, delivery: delivery(successorMerge), mainGuardReverts: [revertOf(successorMerge, 'merged', { revertSha: sha('rr') })] });
  assert.deepEqual(judgedVerdicts(afterRefresh, [refreshedReverted]).map(entry => entry.outcome), ['pending', 'shadow-missed'], 'a revert of the successor\'s merge does not miss the replaced head');
  assert.deepEqual(shadowReport([oldVerdict, newVerdict], [refreshedDelivered]).counts, { 'agree-pass': 1, 'agree-fail': 0, 'shadow-only-fail': 0, 'shadow-missed': 0, pending: 1 }, 'the report counts the replaced head as pending, not as a shadow-only failure');
  const many = Array.from({ length: 12 }, (_, index) => verdict(`GY-${100 + index}`, { tests: failedTests, at: iso(start + index * minute), durationMs: (index + 1) * 1000, id: `w${index}` }));
  const work = many.map((entry, index) => item({ id: `w${index}`, key: entry.key, stage: 'done', candidate: { sha: entry.head }, delivery: { mergedAt: iso(start), mergeSha: sha(`x${index}`), authorizationRevision: 1 } }));
  const report = shadowReport([pass, ...many], work);
  assert.equal(report.total, 13);
  assert.deepEqual(report.counts, { 'agree-pass': 0, 'agree-fail': 0, 'shadow-only-fail': 12, 'shadow-missed': 0, pending: 1 }, 'a verdict whose item is not in the snapshot keeps its recorded outcome');
  assert.equal(report.disagreements.length, 10);
  assert.deepEqual(report.disagreements[0], { outcome: 'shadow-only-fail', key: 'GY-111', head: sha('h-GY-111'), mergeSha: sha('m-GY-111') }, 'newest first');
  assert.deepEqual([report.p50Ms, report.p90Ms], [6000, 11000]);
});

/** A git that answers the trial's reads and records every call; any write beyond the trial ref fails the test. */
function recordingGit() {
  const calls: string[][] = [];
  const run = ((command: string, args: string[]) => {
    calls.push([command, ...args]);
    assert.equal(command, 'git', `the shadow step runs only git, not ${command}`);
    const [, , sub, ...rest] = args;
    const writes = new Set(['push', 'branch', 'checkout', 'reset', 'commit', 'merge', 'tag', 'switch', 'remote', 'config']);
    assert.ok(!writes.has(sub!), `git ${sub} writes`);
    if (sub === 'update-ref') assert.match(rest[0]!, /^refs\/graphyard\/trial\/[0-9a-f]{40}$/, 'the only ref written is the trial ref');
    if (sub === 'fetch') assert.ok(!rest.some(arg => arg.includes(':') || arg.startsWith('+')), 'a fetch names no destination ref');
    if (sub === 'rev-parse') return `${tip}\n`;
    if (sub === 'merge-tree') return `${sha('tree')}\0`;
    if (sub === 'commit-tree') return `${sha('merge')}\n`;
    if (sub === 'diff') return 'src/store/schema.ts\ntests/shadow-gate.test.ts\n';
    return '';
  }) as never;
  return { calls, run };
}
const recorded: { id: string; verdict: Omit<ShadowVerdict, 'outcome'> }[] = [];
const githubDouble = new Proxy({}, { get: (_, name) => { throw new Error(`the shadow step called GitHub (${String(name)})`); } });
function effectsFor(world: { work: () => Work[]; now: () => number; shadow: ReturnType<typeof shadowReads> | null }) {
  return {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: world.work(), now: iso(world.now()) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(world.now()), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, decisions: async () => ({ decisions: [] }), persist: async () => {},
    github: githubDouble, merge: githubDouble, shadow: world.shadow,
  } as unknown as DaemonEffects;
}
const trialRun = { build: 'pass' as const, tests: { passed: 2, failed: [], files: 2 }, durationMs: 4200, logTail: 'ok' };

test('unit:shadow-step-records-verdict — one cycle starts the oldest owed trial beside the cycle, the next records its verdict (head, baseTip, mergeSha, risk, build, tests, durationMs) in state.shadow and through the coordinator, and the head is not tried again against the same tip', async () => {
  const git = recordingGit(), now = () => start;
  const reads = shadowReads(config, '/coordinator', git.run, { base: '/worktrees', record: async (work, entry) => { recorded.push({ id: work.id, verdict: entry }); }, trial: async input => { assert.equal(input.mergeSha, sha('merge')); assert.deepEqual(input.changedFiles, ['src/store/schema.ts', 'tests/shadow-gate.test.ts']); return trialRun; } });
  const work = [submitted(2, 5), submitted(1, 30)];
  const state = emptyDaemonState(config);
  const effects = effectsFor({ work: () => work, now, shadow: reads });
  const { metrics } = await runCycle(config, state, effects, now);
  assert.equal(state.shadow.length, 0, 'the first cycle only starts the trial');
  await shadowIdle(state);
  await runCycle(config, state, effects, now);
  assert.equal(state.shadow.length, 1);
  assert.deepEqual({ ...state.shadow[0]!, at: undefined }, { key: 'GY-1', id: 'w1', head: sha('head1'), baseTip: tip, mergeSha: sha('merge'), risk: 'sensitive', build: 'pass', tests: { passed: 2, failed: [], files: 2 }, conflict: [], durationMs: 4200, at: undefined, outcome: 'pending' }, 'the oldest submission is tried first, and its delta touches the persistence layer, so it is sensitive');
  assert.deepEqual(recorded.map(entry => [entry.id, entry.verdict.head]), [['w1', sha('head1')]]);
  const steps = (metrics.timings?.steps ?? []).map(step => step.step);
  assert.ok(steps.indexOf('shadow gate') > steps.indexOf('merges'), `the shadow step runs after the merge step: ${steps.join(', ')}`);
  await shadowIdle(state);
  await runCycle(config, state, effects, now);
  await shadowIdle(state);
  await runCycle(config, state, effects, now);
  assert.deepEqual(state.shadow.map(entry => entry.key), ['GY-1', 'GY-2'], 'then the next owed head, once each');
  await shadowIdle(state);
  await runCycle(config, state, effects, now);
  assert.equal(state.shadow.length, 2, 'nothing is owed twice against the same tip');
  assert.deepEqual(daemonStateSchema.parse(JSON.parse(JSON.stringify(state))).shadow, state.shadow, 'the verdicts round-trip through the daemon state schema');
  assert.throws(() => shadowStateSchema.parse(Array.from({ length: shadowKeptVerdicts + 1 }, () => state.shadow[0])), 'the schema keeps at most 200');
  // A loop without the reads, or with the gate off, does nothing.
  const bare = emptyDaemonState(config);
  await runCycle(config, bare, effectsFor({ work: () => work, now, shadow: null }), now);
  const off = emptyDaemonState(config);
  await runCycle(config, off, effectsFor({ work: () => work, now, shadow: shadowReads({ ...config, run: { ...config.run, shadowGate: { enabled: false } } }, '/coordinator', git.run, { base: '/w', record: async () => {} }) }), now);
  assert.deepEqual([bare.shadow, off.shadow], [[], []]);
  assert.deepEqual([shadowGateSettings({}), shadowGateSettings({ shadowGate: { enabled: false, timeoutMinutes: 5 } })], [{ enabled: true, timeoutMinutes: 20 }, { enabled: false, timeoutMinutes: 5 }]);
  assert.throws(() => shadowGateSettingsSchema.parse({ timeoutMinutes: 0 }));
  assert.throws(() => shadowGateSettingsSchema.parse({ timeoutMinutes: maxShadowTimeoutMinutes + 1 }), 'two hours is the longest trial an install may ask for');
  assert.equal(maxShadowTimeoutMinutes, 120);
  assert.equal(masterConfigSchema.parse({ ...config, run: { shadowGate: { timeoutMinutes: 30 } } }).run.shadowGate?.timeoutMinutes, 30, 'run.shadowGate is a master.json setting');
});

test('unit:shadow-verdict-keeps-log-tail — a trial that did not pass (a failed build, a failing test file, or a runner that exited non-zero with every file passing) records the last 4000 characters of its output as logTail in the posted verdict and the route keeps it; a passing trial records none, and the loop\'s cursor never carries it', async () => {
  const runs: TrialRun[] = [
    { build: 'fail', tests: { passed: 0, failed: [], files: 0 }, durationMs: 1000, logTail: `$ npm run build\n${'x'.repeat(5000)}\nbuild broke\n[exit status 1]`, runnerExit: null },
    { build: 'pass', tests: { passed: 1, failed: ['tests/bad.test.ts'], files: 2 }, durationMs: 2000, logTail: 'not ok 1 - tests/bad.test.ts', runnerExit: 1 },
    { build: 'pass', tests: { passed: 3, failed: ['tests/helpers/run-tests.ts'], files: 3 }, durationMs: 3000, logTail: 'ok 3 - tests/c.test.ts\n[exit status 1]', runnerExit: 1 },
    { build: 'pass', tests: { passed: 3, failed: [], files: 3 }, durationMs: 3000, logTail: 'ok 3 - tests/c.test.ts\n[exit signal SIGKILL: stdout exceeded 16777216 bytes]', runnerExit: 137 },
    { build: 'pass', tests: { passed: 3, failed: [], files: 3 }, durationMs: 4000, logTail: 'ok 3 - tests/c.test.ts', runnerExit: 0 },
    { build: 'pass', tests: { passed: 0, failed: [], files: 0 }, durationMs: 100, logTail: 'affected: nothing', runnerExit: null },
  ];
  assert.deepEqual(runs.map(trialNeedsLog), [true, true, true, true, false, false]);
  const posted: Record<string, unknown>[] = [];
  let clock = start;
  const now = () => clock;
  const work = runs.map((_, index) => submitted(index + 1, runs.length - index));
  const reads = shadowReads(config, '/coordinator', recordingGit().run, { base: '/worktrees', record: async (_work, entry) => { posted.push(shadowVerdictBody(entry)); }, trial: async input => runs[work.findIndex(item => item.key === input.key)]! });
  const state = emptyDaemonState(config);
  const effects = effectsFor({ work: () => work, now, shadow: reads });
  for (let cycle = 0; cycle < runs.length; cycle++) { await runCycle(config, state, effects, now); await shadowIdle(state); clock += minute; }
  await runCycle(config, state, effects, now);
  assert.deepEqual(posted.map(body => body.logTail), [runs[0]!.logTail.slice(-4000), runs[1]!.logTail, runs[2]!.logTail, runs[3]!.logTail, undefined, undefined], 'the posted verdict keeps the log tail exactly when the trial did not pass');
  assert.equal((posted[0]!.logTail as string).length, 4000, 'the last 4000 characters');
  assert.ok(!('logTail' in posted[4]!) && !('logTail' in posted[5]!), 'a passing verdict posts no logTail key');
  assert.deepEqual(Object.keys(shadowVerdictBody({ ...verdict('GY-7'), logTail: 'tail' })).sort(), ['baseTip', 'build', 'conflict', 'durationMs', 'head', 'logTail', 'mergeSha', 'risk', 'tests']);
  assert.equal(state.shadow.length, runs.length);
  assert.ok(state.shadow.every(entry => !('logTail' in entry)), 'the cursor records the verdict without its log');
  assert.deepEqual(shadowStateSchema.parse(JSON.parse(JSON.stringify(state.shadow))), state.shadow);
  assert.deepEqual(state.shadow.map(entry => entry.tests.failed), runs.map(run => run.tests.failed));
  assert.equal(trialLogTailLength, 4000);
});

test('unit:shadow-step-writes-nothing — across a conflicting head, a passing one and an infrastructure failure the step runs only git (fetch, rev-parse, merge-tree, commit-tree, update-ref on refs/graphyard/trial/*, diff), pushes nothing, moves no refs/heads/* and never touches the GitHub double', async () => {
  const git = recordingGit(), now = () => start;
  const inner = git.run as unknown as (command: string, args: string[]) => string;
  const run = ((command: string, args: string[]) => {
    if (args[2] === 'merge-tree' && args.includes(sha('head1'))) { throw Object.assign(new Error('conflict'), { status: 1, stdout: `${sha('tree')}\0a.txt\0\0CONFLICT` }); }
    if (args[2] === 'fetch' && args.includes('graphyard/gy-3-1')) throw new Error('network down');
    return inner(command, args);
  }) as never;
  const reads = shadowReads(config, '/coordinator', run, { base: '/w', record: async (work, entry) => { recorded.push({ id: work.id, verdict: entry }); }, trial: async () => trialRun });
  const work = [submitted(1, 30), submitted(2, 20), submitted(3, 10)];
  const state = emptyDaemonState(config), effects = effectsFor({ work: () => work, now, shadow: reads });
  recorded.length = 0;
  await runCycle(config, state, effects, now); await shadowIdle(state);
  await runCycle(config, state, effects, now);
  assert.equal(state.shadow[0]?.mergeSha, null);
  assert.deepEqual(state.shadow[0]?.conflict, ['a.txt'], 'a conflicting head is a recorded failure');
  assert.equal(state.shadow[0]?.build, 'fail');
  await shadowIdle(state); await runCycle(config, state, effects, now); await shadowIdle(state);
  await runCycle(config, state, effects, now); await shadowIdle(state);
  await runCycle(config, state, effects, now);
  assert.deepEqual(state.shadow.map(entry => entry.key), ['GY-1', 'GY-2'], 'a head whose trial could not run records no verdict');
  assert.match(state.actions[shadowErrorKey(sha('head3'), tip)]?.detail ?? '', /network down/);
  // A trial past its time budget is no verdict either: excluded from the counts, and the pair stays owed. It waits behind every
  // head not yet tried, is retried up to shadowTimeoutRetries times against this tip, then given up under one attention line.
  const tried: string[] = [];
  const timing = shadowReads(config, '/coordinator', git.run, { base: '/w', record: async () => {}, trial: async input => { tried.push(input.key!); if (input.key === 'GY-4') throw new TrialTimeoutError('tests', 1_200_000, 'ok - tests/a.test.ts'); return trialRun; } });
  const slow = emptyDaemonState(config), slowEffects = effectsFor({ work: () => [submitted(4, 50), submitted(5, 5)], now, shadow: timing });
  const lines: string[] = [];
  for (let cycle = 0; cycle < 12; cycle++) { lines.push(...(await runCycle(config, slow, slowEffects, now)).actions.filter(action => action.detail.startsWith('Shadow merge gate timeouts:')).map(action => action.detail)); await shadowIdle(slow); }
  assert.deepEqual(slow.shadow.map(entry => entry.key), ['GY-5'], 'a timeout records no verdict; the head that passed has one');
  assert.deepEqual(tried, ['GY-4', 'GY-5', 'GY-4', 'GY-4'], 'the oldest head times out, the untried head goes next, then the timed-out pair is retried until given up');
  assert.equal(slow.actions[shadowTimeoutKey(sha('head4'), tip)]?.attempts, shadowTimeoutRetries);
  assert.match(slow.actions[shadowTimeoutKey(sha('head4'), tip)]?.detail ?? '', /timed out \(3 of 3\): The trial timed out during its tests after 1200s; a timeout measures the host, not the merge, so it is no verdict and the pair is given up/);
  assert.deepEqual(lines.map(line => line.startsWith(`Shadow merge gate timeouts: GY-4 head ${sha('head4')} timed out 3 times on ${tip}`)), [true], 'one attention line, once');
  assert.ok(!slow.actions[shadowErrorKey(sha('head4'), tip)], 'a timeout is not an error');
  // A checkout the trial could not remove is recorded beside the verdict it reached, not instead of it.
  const leftover = shadowReads(config, '/coordinator', git.run, { base: '/w', record: async () => {}, trial: async () => { throw new TrialCleanupError('/w/graphyard-trial-gy-6-abc', { ...trialRun, tests: failedTests }, new Error('EBUSY'), 'the trial itself answered build pass, 1 failing test file(s)'); } });
  const stuck = emptyDaemonState(config), stuckEffects = effectsFor({ work: () => [submitted(6, 5)], now, shadow: leftover });
  await runCycle(config, stuck, stuckEffects, now); await shadowIdle(stuck); await runCycle(config, stuck, stuckEffects, now);
  assert.deepEqual(stuck.shadow.map(entry => [entry.key, entry.tests.failed]), [['GY-6', ['tests/x.test.ts']]], 'the verdict is kept');
  assert.match(stuck.actions[shadowLeftoverKey(sha('head6'), tip)]?.detail ?? '', /left its checkout behind; the verdict is recorded and the orphan reclaim removes the directory: The trial checkout \/w\/graphyard-trial-gy-6-abc was not removed \(EBUSY\)/);
  const subcommands = new Set(git.calls.map(call => call[3]));
  for (const forbidden of ['push', 'branch', 'checkout', 'reset', 'commit', 'merge', 'tag', 'remote']) assert.ok(!subcommands.has(forbidden), `no git ${forbidden}`);
  assert.ok(['fetch', 'merge-tree'].every(name => subcommands.has(name)), git.calls.map(call => call.slice(3, 5).join(' ')).join(' / '));
  assert.ok(git.calls.every(call => call[0] === 'git' && call[1] === '-C' && call[2] !== 'gh'));
});

test('unit:shadow-status — master status lists the gate report and, for each item with a shadow-only-fail or shadow-missed, one escalation line raised once, and docs/delivery-redesign.md Rollout names the fields within 50 net words', async () => {
  const entries = [verdict('GY-1', { outcome: 'agree-pass' }), verdict('GY-2', { outcome: 'shadow-only-fail', tests: failedTests }), verdict('GY-3', { outcome: 'shadow-missed' })];
  const summary = shadowReport(entries, []);
  assert.deepEqual(summary.counts, { 'agree-pass': 1, 'agree-fail': 0, 'shadow-only-fail': 1, 'shadow-missed': 1, pending: 0 });
  assert.deepEqual([summary.total, summary.p50Ms, summary.p90Ms, summary.disagreements.map(entry => entry.key).sort()], [3, 1000, 1000, ['GY-2', 'GY-3']]);
  // The step raises each disagreement once, however many cycles follow.
  const git = recordingGit(), now = () => start;
  let delivered = false, reverted = false;
  const open = submitted(1, 30), fields = open as unknown as Record<string, unknown>;
  const reads = shadowReads(config, '/coordinator', git.run, { base: '/w', record: async () => {}, trial: async () => ({ ...trialRun, tests: failedTests }) });
  const snapshotItem = () => reverted ? item({ ...fields, stage: 'ready', candidate: null, submission: null, mainGuardReverts: [{ mergeSha: sha('d'), pr: 1, failing: ['test'], revert: null, state: 'merged', at: iso(start), settledAt: iso(start), revertSha: sha('rr'), reason: null }] })
    : delivered ? item({ ...fields, stage: 'done', delivery: { mergedAt: iso(start), mergeSha: sha('d'), authorizationRevision: 1 } }) : open;
  const state = emptyDaemonState(config), effects = effectsFor({ work: () => [snapshotItem()], now, shadow: reads });
  await runCycle(config, state, effects, now); await shadowIdle(state);
  await runCycle(config, state, effects, now);
  assert.equal(state.shadow[0]?.outcome, 'pending');
  delivered = true;
  const raised: string[] = [];
  for (let cycle = 0; cycle < 3; cycle++) raised.push(...(await runCycle(config, state, effects, now)).actions.filter(action => action.detail.startsWith('Shadow merge gate:')).map(action => action.detail));
  assert.equal(state.shadow[0]?.outcome, 'shadow-only-fail');
  assert.equal(raised.length, 1, 'raised once');
  assert.equal(state.shadow[0]?.delivered?.mergeSha, sha('d'), 'the step keeps the merge GitHub made of the head');
  const section = daemonSummary(state, now(), config.run.intervalSeconds * 1000, config.hostId).shadowGate;
  assert.equal(section.counts['shadow-only-fail'], 1);
  assert.deepEqual(section.disagreements.map(entry => entry.key), ['GY-1'], 'master status carries the shadowGate section with the report');
  // The main guard reverts that merge and the item is reopened without its delivery or candidate: the verdict follows, to agree-fail, under no new line.
  reverted = true;
  const afterRevert = await runCycle(config, state, effects, now);
  assert.equal(state.shadow[0]?.outcome, 'agree-fail', 'the revert of the remembered merge is read after the reopen');
  assert.equal(afterRevert.actions.filter(action => action.detail.startsWith('Shadow merge gate:')).length, 0);
  assert.equal(daemonSummary(state, now(), config.run.intervalSeconds * 1000, config.hostId).shadowGate.counts['agree-fail'], 1);
  // master status: one attention line per disagreeing item, from the item's newest verdict, however many verdicts it has.
  const lines = shadowGateAttention([...entries, verdict('GY-2', { outcome: 'agree-pass', at: iso(start + minute) }), verdict('GY-3', { outcome: 'shadow-missed', at: iso(start - minute) })]);
  assert.deepEqual(lines.map(line => [line.subject, line.role, line.human, line.text.startsWith('Shadow merge gate: GY-3')]), [['shadow-gate', 'master', false, true]], 'GY-2 is agreed at its newest verdict; GY-3 keeps its one line');
  assert.match(lines[0]!.next, /before the switch to control-plane merging/);
  assert.deepEqual(shadowGateAttention([]), []);
  // The loop's own effects carry the reads: the verdict is posted as the coordinator under one idempotency key per (head, tip), with the route's body.
  const posted: { path: string; data: unknown; key?: string }[] = [];
  const wired = daemonEffects('/coordinator', config, { snapshot: async () => ({ work: [], now: iso(start) }), mutate: async (path, data, key) => { posted.push({ path, data, key }); return {}; }, run: git.run });
  assert.ok(wired.shadow?.enabled);
  const entry = verdict('GY-5', { id: 'w5' });
  await wired.shadow!.record(item({ id: 'w5', key: 'GY-5' }), entry);
  assert.deepEqual(posted, [{ path: 'work/w5/shadow-verdict', data: shadowVerdictBody(entry), key: shadowVerdictKey({ id: 'w5' }, entry) }]);
  assert.deepEqual(Object.keys(shadowVerdictBody(entry)).sort(), ['baseTip', 'build', 'conflict', 'durationMs', 'head', 'mergeSha', 'risk', 'tests']);
  assert.equal(daemonEffects('/coordinator', { ...config, run: { ...config.run, shadowGate: { enabled: false } } }, { snapshot: async () => ({ work: [], now: iso(start) }), mutate: async () => ({}), run: git.run }).shadow?.enabled, false);
  const docs = readFileSync(fileURLToPath(new URL('../docs/delivery-redesign.md', import.meta.url)), 'utf8');
  const rollout = docs.split(/^## Rollout\s*$/m)[1]!.split(/\n## /)[0]!;
  for (const field of ['`shadowGate`', 'agree-pass', 'agree-fail', 'shadow-only-fail', 'shadow-missed', 'pending', 'p50/p90', 'newest ten']) assert.ok(rollout.includes(field), `Rollout names ${field}`);
  // The base page: origin/main where the checkout has it, else the first parent (a pull request's CI checkout is the merge onto the base, fetched two deep).
  const base = ['origin/main', 'HEAD^1'].map(ref => { try { return execFileSync('git', ['show', `${ref}:docs/delivery-redesign.md`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } }).find(text => text !== null) ?? null;
  const mainRollout = base?.split(/^## Rollout\s*$/m)[1]?.split(/\n## /)[0];
  const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
  if (mainRollout) assert.ok(words(rollout) - words(mainRollout) <= 50, `Rollout grew by ${words(rollout) - words(mainRollout)} words, at most 50`);
});

// ——— The verdict route: the loop's coordinator identity only, one event per Idempotency-Key. ———
const repository = 'owner/project';
const admin: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const principals = [admin, coordinator, worker];
const credentials = principals.map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let pg: EmbeddedPostgres, store: Store, http: ReturnType<typeof server>, url: string;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1522;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('shadow-gate-pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('shadow_gate_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/shadow_gate_test`); await store.init();
  const engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null; engine.directMergeEnvironment = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pg) await pg.stop(); });
async function request(credential: string, path: string, body?: unknown, key = randomUUID()) {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}

test('integration:shadow-verdict-route-coordinator-only — POST /api/work/:id/shadow-verdict records a shadow.verdict event for the coordinator identity only; admin and worker are refused with nothing written, a retried key replays, a malformed body or unknown item is refused', async () => {
  const id = randomUUID();
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [id, JSON.stringify({ id, key: 'GY-9001', stage: 'build' })]);
  const body = { head: sha('head1'), baseTip: tip, mergeSha: sha('merge'), risk: 'normal', build: 'pass', tests: { passed: 2, failed: [], files: 2 }, conflict: [], durationMs: 4200 };
  const count = async () => (await store.pool.query("SELECT count(*)::int AS n FROM events WHERE kind='shadow.verdict'")).rows[0].n as number;
  for (const credential of [token(admin), token(worker)]) assert.equal((await request(credential, `work/${id}/shadow-verdict`, body)).status, 403);
  assert.equal(await count(), 0, 'a refused identity writes nothing');
  const key = randomUUID();
  const recordedOnce = await request(token(coordinator), `work/${id}/shadow-verdict`, body, key);
  assert.equal(recordedOnce.status, 200, JSON.stringify(recordedOnce.body));
  assert.deepEqual(recordedOnce.body, { recorded: true, key: 'GY-9001', head: body.head, baseTip: tip });
  const event = (await store.pool.query("SELECT work_id, actor, payload FROM events WHERE kind='shadow.verdict'")).rows[0];
  assert.deepEqual([event.work_id, event.actor, event.payload.mergeSha, event.payload.durationMs, event.payload.key, 'logTail' in event.payload], [id, coordinator.id, sha('merge'), 4200, 'GY-9001', false]);
  assert.equal((await request(token(coordinator), `work/${id}/shadow-verdict`, body, key)).status, 200);
  assert.equal(await count(), 1, 'a retried key replays');
  assert.equal((await request(token(coordinator), `work/${id}/shadow-verdict`, { ...body, durationMs: 1 }, key)).status, 409, 'a key reused with other input is refused');
  assert.ok([400, 422].includes((await request(token(coordinator), `work/${id}/shadow-verdict`, { ...body, head: 'main' })).status));
  assert.equal((await request(token(coordinator), `work/${randomUUID()}/shadow-verdict`, body)).status, 404);
  assert.equal(await count(), 1);
  // unit:shadow-verdict-keeps-log-tail: a failing verdict's log tail is kept in the event, up to 4000 characters.
  const failing = { ...body, baseTip: sha('other-tip'), tests: { passed: 2, failed: ['tests/helpers/run-tests.ts'], files: 2 }, logTail: `ok 2 - tests/b.test.ts\n[exit status 1]` };
  assert.equal((await request(token(coordinator), `work/${id}/shadow-verdict`, failing)).status, 200);
  const kept = (await store.pool.query("SELECT payload FROM events WHERE kind='shadow.verdict' AND payload->>'baseTip'=$1", [sha('other-tip')])).rows[0];
  assert.equal(kept.payload.logTail, failing.logTail);
  assert.ok([400, 422].includes((await request(token(coordinator), `work/${id}/shadow-verdict`, { ...failing, logTail: 'x'.repeat(4001) })).status), 'a log tail over 4000 characters is refused');
  assert.equal(await count(), 2);
});
