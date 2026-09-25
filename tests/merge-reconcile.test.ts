import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateKey, emptyDaemonState, mergeRetryCapMs, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, mergeWork, type MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';

// GY-202: a retained merge execution with an unknown provider outcome waited up to two minutes for
// its expiry although GitHub could answer in one read, and a refused guarded merge on an unchanged,
// mergeable candidate backed off for up to thirty cycles. The pull request is read on the next tick:
// merged is delivered from merge_commit_sha, open at the same head is cancelled and retried on the
// next tick (never on the read that said open, which a lagging replica can serve), and a mergeable candidate is retried at least once a minute until GitHub shows it merged or its
// head moves.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha = 'a'.repeat(40), baseSha = 'b'.repeat(40), mergeSha = 'c'.repeat(40), movedSha = 'd'.repeat(40);
const validProtection = { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: 'Graphyard / merge', app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };

async function masterConfig() {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-merge-reconcile-'));
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  return { config, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

let executions = 0;
const execution = (owner = 'master') => ({ id: `44444444-4444-4444-8444-${String(++executions).padStart(12, '0')}`, owner, sha, baseSha, policyRevision: 2, authorizationRevision: 9,
  issuedAt: new Date(Date.now() - 10_000).toISOString(), expiresAt: new Date(Date.now() + 110_000).toISOString() });
/** A committed execution, far from expiry, whose provider outcome is unknown. */
const retained = (owner = 'master') => ({ ...execution(owner), verifiedAt: new Date(Date.now() - 8000).toISOString(), committingAt: new Date(Date.now() - 6000).toISOString(), clockOffset: { min: 0, max: 0 } });

function work(overrides: Partial<Work> = {}) {
  const candidate = { sha, baseSha, pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' };
  const queue = { sequence: 1, enqueuedAt: '2030-01-01T00:30:00Z', policyRevision: 2,
    speculation: { ref: 'refs/graphyard/queue/gy-42', tip: sha, base: baseSha, baseTree: 'e'.repeat(40), predecessors: [], policyRevision: 2, publishedAt: '2030-01-01T00:31:00Z' } };
  return { id: 'work-id', key: 'GY-42', queue, title: 'Merge reconcile', description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:merge'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'merge', revision: 9, policyRevision: 2, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 42 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: { at: new Date().toISOString(), candidate, reviews: [] }, blocker: null, gates: [{ name: 'merge', passed: true, reasons: [] }], violations: [],
    mergeAuthorization: { sha, baseSha, policyRevision: 2, at: new Date().toISOString() }, ...overrides } as Work;
}

/**
 * GitHub as the broker sees it. `pull` is what GET /repos/{repo}/pulls/{n} answers; `refuse` makes
 * the provider merge answer HTTP 405, and otherwise the provider merges and the pull request reads
 * merged from then on.
 */
function github(pull: { merged: boolean; state: string; head: string }) {
  const calls: string[][] = []; let refuse = false;
  const run = (_command: string, args: string[]) => {
    calls.push(args);
    if (args[1] === 'view') return JSON.stringify({ headRefOid: pull.head, baseRefName: 'main', state: pull.state.toUpperCase(), isDraft: false });
    if (args[1] === 'repos/owner/project/pulls/42') return JSON.stringify({ number: 42, merged: pull.merged, merge_commit_sha: pull.merged ? mergeSha : null, state: pull.state, head: { sha: pull.head } });
    if (args[1]?.includes('/git/ref/heads/')) return JSON.stringify({ ref: 'refs/heads/main', object: { type: 'commit', sha: baseSha } });
    if (args[1]?.includes('/check-runs')) return JSON.stringify({ check_runs: [{ name: 'Graphyard / merge', status: 'completed', conclusion: 'success', started_at: new Date().toISOString(), app: { id: 1234 } }] });
    if (args.includes('--include')) return `Date: ${new Date().toUTCString()}\n\n{}`;
    if (args[1] === '--method') {
      if (refuse) throw new Error('gh: Base branch was modified. Review and try the merge again. (HTTP 405)');
      Object.assign(pull, { merged: true, state: 'closed' });
      return JSON.stringify({ merged: true, sha: mergeSha });
    }
    return JSON.stringify(validProtection);
  };
  return { calls, run, pull, refuse: (value: boolean) => { refuse = value; },
    providerCalls: () => calls.filter(args => args[1] === '--method').length,
    pullReads: () => calls.filter(args => args[1] === 'repos/owner/project/pulls/42').length };
}

/** The control plane: acquire, cancel and commit move the execution; refresh observes GitHub and delivers a merge it shows. */
function plane(initial: Work, gh: ReturnType<typeof github>) {
  let item = initial; const counts = { acquired: 0, cancelled: 0, refreshed: 0 };
  const snapshot = async () => ({ work: [item], now: new Date().toISOString() });
  const acquire = async () => { counts.acquired++; const granted = execution(); item = { ...item, mergeExecution: granted }; return { execution: granted }; };
  const cancel = async (_work: Work, cancelled: { id: string }) => { counts.cancelled++; assert.equal(item.mergeExecution?.id, cancelled.id); item = { ...item, mergeExecution: null }; };
  const commit = async () => { const committingAt = new Date(Date.now() - 2000).toISOString(); item = { ...item, mergeExecution: { ...item.mergeExecution!, committingAt } }; return { executionId: item.mergeExecution!.id, sha, committingAt }; };
  const verify = async () => ({ executionId: item.mergeExecution!.id, sha, verifiedAt: new Date(Date.now() - 2000).toISOString(), providerDelayMs: 0, clockOffset: { min: 0, max: 0 } });
  // The control plane's own observation: a merged pull request is delivered from its merge commit
  // and the execution closed, exactly what engine.observe records for a merged reading.
  const refresh = async () => {
    counts.refreshed++;
    if (gh.pull.merged) item = { ...item, stage: 'done', mergeExecution: null, delivery: { mergedAt: new Date().toISOString(), mergeSha, authorizationRevision: 9 } as Work['delivery'],
      observation: { ...item.observation!, merged: true, mergeSha } as Work['observation'] };
  };
  return { get item() { return item; }, set: (next: Work) => { item = next; }, snapshot, acquire, cancel, commit, verify, refresh, counts };
}

function broker(config: MasterConfig, control: ReturnType<typeof plane>, gh: ReturnType<typeof github>) {
  return (item: Work) => mergeWork(config, item, control.snapshot, control.acquire, control.cancel, control.verify, gh.run, 'master', control.commit, undefined, control.refresh);
}

function loop(config: MasterConfig, control: ReturnType<typeof plane>, gh: ReturnType<typeof github>): DaemonEffects {
  return {
    agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: control.snapshot,
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, requestSmoke: () => {}, recordDeployment: async () => {},
    merge: broker(config, control, gh),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    persist: async () => {},
  };
}

test('unit:unknown-merge-reconciled-from-github — a retained unknown outcome GitHub shows merged is delivered from merge_commit_sha on the next tick, with no provider call', async () => {
  const { config, cleanup } = await masterConfig();
  try {
    const gh = github({ merged: true, state: 'closed', head: sha });
    const item = work({ mergeExecution: retained() });
    const control = plane(item, gh);
    const reported = await broker(config, control, gh)(item) as { merged?: boolean; pending?: boolean; mergeSha?: string; result: string };
    assert.equal(reported.merged, true, `GitHub's merged answer settles the unknown outcome: ${reported.result}`);
    assert.notEqual(reported.pending, true);
    assert.equal(reported.mergeSha, mergeSha, 'the merge commit is the one GitHub reported');
    assert.equal(gh.pullReads(), 1, 'one GitHub read of the pull request');
    assert.equal(gh.providerCalls(), 0, 'no second provider merge');
    assert.deepEqual([control.counts.acquired, control.counts.cancelled, control.counts.refreshed], [0, 0, 1], 'the control plane observes it; nothing is acquired or cancelled');
    assert.equal(control.item.stage, 'done');
    assert.equal(control.item.delivery?.mergeSha, mergeSha, 'the delivery is recorded from merge_commit_sha');
    assert.equal(control.item.mergeExecution, null, 'and the execution is closed');

    // In the loop: the first tick records the merge done, well before the execution would expire.
    const again = work({ mergeExecution: retained() }); const looped = github({ merged: true, state: 'closed', head: sha }); const next = plane(again, looped);
    const state = emptyDaemonState(config);
    const cycle = await runCycle(config, state, loop(config, next, looped));
    const merge = cycle.actions.find(action => action.kind === 'merge');
    assert.equal(merge?.state, 'done', merge?.detail);
    assert.match(merge!.detail, /merged as cccccccccccc/);
    assert.equal(next.item.delivery?.mergeSha, mergeSha);
    assert.equal(looped.providerCalls(), 0);
  } finally { await cleanup(); }
});

test('unit:unknown-merge-reconciled-from-github — a retained unknown outcome GitHub shows open at the same head is cancelled, and the guarded merge is retried exactly once on the next tick', async () => {
  const { config, cleanup } = await masterConfig();
  try {
    const gh = github({ merged: false, state: 'open', head: sha });
    const item = work({ mergeExecution: retained() });
    const control = plane(item, gh);
    const state = emptyDaemonState(config);
    const start = Date.now();
    const first = (await runCycle(config, state, loop(config, control, gh), () => start)).actions.find(action => action.kind === 'merge');
    assert.ok(Date.parse(item.mergeExecution!.expiresAt) > Date.now() + 60_000, 'the retained execution was nowhere near expiry');
    assert.equal(control.counts.cancelled, 1, 'the retained execution is cancelled');
    assert.equal(control.counts.acquired, 0, 'no fresh execution is acquired on the read that said open');
    assert.equal(gh.providerCalls(), 0, 'and no provider call is made in that tick');
    assert.equal(first?.state, 'waiting', first?.detail);
    assert.match(first!.detail, /retried next cycle/);
    const second = (await runCycle(config, state, loop(config, control, gh), () => start + 20_000)).actions.find(action => action.kind === 'merge');
    assert.equal(control.counts.acquired, 1, 'the next tick acquires a fresh execution');
    assert.equal(gh.providerCalls(), 1, 'the guarded merge is retried exactly once');
    assert.equal(second?.state, 'done', second?.detail);
    assert.match(second!.detail, /merge requested/);

    // The lagged read: the provider merged, and the first read of the pull request still says open.
    // The execution is cancelled and nothing else happens; the next reading delivers the merge.
    const lagging = github({ merged: true, state: 'closed', head: sha });
    const lagRun = lagging.run; let lagged = true;
    const replica = { ...lagging, run: (command: string, args: string[]) => {
      if (args[1] === 'repos/owner/project/pulls/42' && lagged) { lagged = false; lagging.calls.push(args); return JSON.stringify({ number: 42, merged: false, merge_commit_sha: null, state: 'open', head: { sha } }); }
      return lagRun(command, args);
    } };
    const raced = plane(work({ mergeExecution: retained() }), lagging);
    const racedOutcome = await mergeWork(config, raced.item, raced.snapshot, raced.acquire, raced.cancel, raced.verify, replica.run, 'master', raced.commit, undefined, raced.refresh) as { pending?: boolean; result: string };
    assert.equal(racedOutcome.pending, true, racedOutcome.result);
    assert.deepEqual([raced.counts.cancelled, raced.counts.acquired, lagging.providerCalls()], [1, 0, 0], 'no execution is acquired for the lagging read, so none can be bound to the merge');
    assert.equal(raced.counts.refreshed, 1, 'the control plane is asked to observe');
    assert.equal(raced.item.stage, 'done', 'and its observation records the delivery');
    assert.equal(raced.item.delivery?.mergeSha, mergeSha);

    // A refresh that fails is reported with the pending outcome rather than swallowed.
    const refusing = github({ merged: false, state: 'open', head: sha });
    const failing = plane(work({ mergeExecution: retained() }), refusing);
    const unobserved = await mergeWork(config, failing.item, failing.snapshot, failing.acquire, failing.cancel, failing.verify, refusing.run, 'master', failing.commit, undefined, async () => { throw new Error('control plane answered 503'); }) as { pending?: boolean; result: string };
    assert.equal(unobserved.pending, true);
    assert.match(unobserved.result, /asking the control plane to observe it failed: control plane answered 503/);

    // A lapsed execution another executor instance committed is never cancelled from here: it stays
    // pending, and the control plane is asked to observe it.
    const foreign = github({ merged: false, state: 'open', head: sha });
    const held = plane(work({ mergeExecution: { ...retained('master#other'), expiresAt: new Date(Date.now() - 1000).toISOString() } }), foreign);
    const reported = await mergeWork(config, held.item, held.snapshot, held.acquire, held.cancel, held.verify, foreign.run, 'master', held.commit, undefined, held.refresh) as { pending?: boolean; result: string };
    assert.equal(reported.pending, true, reported.result);
    assert.match(reported.result, /belongs to master#other/);
    assert.deepEqual([held.counts.cancelled, held.counts.acquired, held.counts.refreshed, foreign.providerCalls()], [0, 0, 1, 0]);
  } finally { await cleanup(); }
});

test('unit:merge-retries-until-merged-or-head-moves — a refused merge on an unchanged, mergeable candidate is retried at least once a minute until GitHub shows it merged', async () => {
  const { config, cleanup } = await masterConfig();
  try {
    const gh = github({ merged: false, state: 'open', head: sha });
    gh.refuse(true);
    const item = work();
    const control = plane(item, gh);
    const state = emptyDaemonState(config);
    const start = Date.now(); const clock = { at: start };
    const attemptsAt: number[] = [];
    const effects = loop(config, control, gh);
    const counting: DaemonEffects = { ...effects, merge: async target => { attemptsAt.push(clock.at); return effects.merge(target); } };
    // Twelve ticks, twenty seconds apart: four simulated minutes of GitHub refusing.
    for (let tick = 0; tick < 12; tick++) { clock.at = start + tick * 20_000; await runCycle(config, state, counting, () => clock.at); }
    const key = candidateKey('merge', item);
    assert.equal(state.actions[key].state, 'failed', 'a refusal is never recorded as done');
    assert.ok(attemptsAt.length >= 5, `retries continue across ticks (saw ${attemptsAt.length})`);
    const gaps = attemptsAt.slice(1).map((at, index) => at - attemptsAt[index]);
    assert.ok(gaps.every(gap => gap <= mergeRetryCapMs), `no pause exceeds one minute: ${gaps.join(', ')}`);
    assert.ok(attemptsAt.at(-1)! >= start + 11 * 20_000 - mergeRetryCapMs, 'still retrying at the end of the stretch');
    assert.equal(control.item.stage, 'merge');
    assert.equal(gh.providerCalls(), attemptsAt.length, 'every attempt reached GitHub');
    assert.match(state.actions[key].detail, /HTTP 405/);
    assert.equal(control.counts.cancelled, gh.providerCalls(), 'every refused execution is released');

    // GitHub now accepts: the next due attempt merges, the control plane observes it, and retries stop.
    gh.refuse(false);
    for (let tick = 12; tick < 16 && control.item.stage === 'merge'; tick++) {
      clock.at = start + tick * 20_000; await runCycle(config, state, counting, () => clock.at);
      if (gh.pull.merged) await control.refresh();
    }
    assert.equal(state.actions[key].state, 'done', 'done only once GitHub answered merged');
    assert.equal(control.item.delivery?.mergeSha, mergeSha);
    const settled = attemptsAt.length;
    for (let tick = 16; tick < 20; tick++) { clock.at = start + tick * 20_000; await runCycle(config, state, counting, () => clock.at); }
    assert.equal(attemptsAt.length, settled, 'no attempt follows the merged observation');
  } finally { await cleanup(); }
});

test('unit:merge-retries-until-merged-or-head-moves — retries for a head stop when the head moves, and an unknown outcome stays waiting until GitHub shows merged', async () => {
  const { config, cleanup } = await masterConfig();
  try {
    const gh = github({ merged: false, state: 'open', head: sha });
    gh.refuse(true);
    const item = work();
    const control = plane(item, gh);
    const state = emptyDaemonState(config);
    const start = Date.now(); const clock = { at: start };
    const heads: string[] = [];
    const effects = loop(config, control, gh);
    const counting: DaemonEffects = { ...effects, merge: async target => { heads.push(target.candidate!.sha); return effects.merge(target); } };
    for (let tick = 0; tick < 4; tick++) { clock.at = start + tick * 20_000; await runCycle(config, state, counting, () => clock.at); }
    assert.ok(heads.length >= 2 && heads.every(head => head === sha));

    // The worker pushed: the moved head is a new candidate whose gates have not passed yet.
    const moved = { ...item, candidate: { ...item.candidate!, sha: movedSha }, mergeAuthorization: null, gates: [{ name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }] } as unknown as Work;
    control.set(moved);
    const before = heads.length;
    for (let tick = 4; tick < 10; tick++) { clock.at = start + tick * 20_000; await runCycle(config, state, counting, () => clock.at); }
    assert.equal(heads.slice(before).filter(head => head === sha).length, 0, 'the old head is never attempted again');
    assert.notEqual(state.actions[candidateKey('merge', item)].state, 'done');

    // A committed execution whose pull request GitHub cannot yet answer for stays waiting, never done.
    const unread = github({ merged: false, state: 'open', head: sha });
    const unreadRun = unread.run;
    let answer = false;
    const flaky = { ...unread, run: (command: string, args: string[]) => {
      if (args[1] === 'repos/owner/project/pulls/42' && !answer) { unread.calls.push(args); throw new Error('gh: HTTP 502'); }
      return unreadRun(command, args);
    } };
    const pending = plane(work({ mergeExecution: retained() }), unread);
    const waitingState = emptyDaemonState(config);
    for (let tick = 0; tick < 3; tick++) {
      const merge = (await runCycle(config, waitingState, loop(config, pending, flaky as typeof unread))).actions.find(action => action.kind === 'merge');
      assert.equal(merge?.state, 'waiting', merge?.detail);
    }
    assert.equal(unread.providerCalls(), 0);
    unread.pull.merged = true; unread.pull.state = 'closed'; answer = true;
    const merge = (await runCycle(config, waitingState, loop(config, pending, flaky as typeof unread))).actions.find(action => action.kind === 'merge');
    assert.equal(merge?.state, 'done', merge?.detail);
    assert.equal(pending.item.delivery?.mergeSha, mergeSha);
    assert.equal(unread.providerCalls(), 0);
  } finally { await cleanup(); }
});
