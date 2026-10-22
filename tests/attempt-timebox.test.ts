import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { attemptEndsNeedingRetry, attemptHoldCauses, attemptRetryHold, failedAttemptCount, maxFailedAttempts, overlongKey, overlongMarker, overlongReason, retryBackoffMs, runtimeToAvoid } from '../src/daemon/reblocked-attempts.js';
import { masterConfigSchema, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import type { Work } from '../src/model.js';

/**
 * GY-885. Attempts that simply ran too long held their leases for hours (GY-710 ran 7h12m against
 * a 4h role maximum) and were only reported as overlong. Now an implementation attempt past its
 * role's time box is ended within one cycle past the bound — its work kept on its branch, its
 * supervisor stopped, its pane closed — and the item goes to a fresh attempt, preferably on
 * another runtime. Each retry waits a backoff after the failure before it (5, then 15 minutes),
 * and every retry past the third failure in a row waits the longest backoff (45 minutes); nothing
 * holds the item beyond it. Every rung of the ladder is computed from the item's own record, so a
 * restarted daemon waits exactly what the record holds.
 */
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const maximumMs = 4 * 3_600_000;

async function setup() {
  const directory = await temporaryDirectory('attempt-timebox');
  const workers: WorkerProfile[] = [];
  for (const name of ['alpha', 'beta']) {
    const file = join(directory, `${name}.token`);
    await writeFile(file, `${name}-token-`.padEnd(40, 'x'), { mode: 0o600 });
    workers.push({ name, principal: `${name}-principal`, agentName: `agent-${name}`, mode: 'launch', kind: name === 'alpha' ? 'claude' : 'opencode', credentialFile: file, agentArgs: [], environment: {} } as unknown as WorkerProfile);
  }
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', herdrWorkspace: 'w1',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers });
  return { directory, master };
}
/** An attempt holding a live lease, its session running since five hours ago (the role maximum is four). Its session pushed a head a minute ago, as a progressing attempt's does: one with no submission progress is ended at the 120-minute worker bound first (GY-1460). */
/** An attempt holding a live lease, its session running since five hours ago (the role maximum is four). */
function held(overrides: Partial<Work> = {}): Work {
  const epoch = overrides.epoch ?? 1;
  const leased = overrides.lease !== null;
  const session = { id: `alpha-principal:${epoch}`, kind: 'implementation' as const, principal: 'alpha-principal', epoch, runtime: 'claude', host: 'machine-a',
    workspace: null, tab: null, pane: 'w1:p1', agentName: 'agent-alpha', role: null, head: 'c'.repeat(40), headAt: iso(-60_000), attach: 'herdr pane attach w1:p1', transcript: null,
    subject: 'GY-885: Disposable attempts', state: 'running' as const, outcome: null, startedAt: iso(-5 * 3_600_000), updatedAt: iso(-60_000), endedAt: null };
  return {
    id: 'work-885', key: 'GY-885', title: 'Disposable attempts', description: '', type: 'feature', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, stage: 'build', revision: 3, policyRevision: 1,
    createdAt: iso(-6 * 3_600_000), updatedAt: iso(0), stageEnteredAt: iso(-6 * 3_600_000), ready: true, epoch,
    lease: leased ? { owner: 'alpha-principal', epoch, expiresAt: iso(3_600_000) } : null,
    lastAssignment: { owner: 'alpha-principal', epoch, claimedAt: iso(-5 * 3_600_000) },
    sessions: leased ? [session] : [],
    workspaces: [{ host: 'machine-a', path: `/srv/worktrees/GY-885-${epoch}`, epoch, owner: 'alpha-principal', branch: `graphyard/gy-885-${epoch}` }],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }], violations: [],
    ...overrides,
  } as Work;
}

/** One overlong end as the control plane's capacity record keeps it, ended `age` before the clock. */
const overlongEnd = (epoch: number, ageMs: number, runtime = 'claude') => ({
  at: iso(-ageMs), owner: 'alpha-principal', recordedBy: 'loop', cause: 'interrupted', role: 'worker', epoch,
  profile: 'alpha', account: null, runtime, reason: overlongReason({ key: 'GY-885' }, epoch, 5 * 3_600_000, maximumMs, epoch - 1),
  resetsAt: null, partialWork: { state: 'committed' as const, commit: 'a'.repeat(40), branch: `graphyard/gy-885-${epoch}` },
});

/** An item between attempts whose record holds the row of overlong ends the ladder reads. */
const betweenAttempts = (ends: ReturnType<typeof overlongEnd>[]) => held({ lease: null, capacity: { exhaustions: ends, spent: [] } } as Partial<Work>);

function harness(item: { current: Work[] }, agents: HerdrAgent[]) {
  const log = { closed: [] as string[], capacity: [] as Record<string, unknown>[], dispatches: [] as string[] };
  // The cycle's clock is the snapshot's: `time.value` is what the control plane is observed at.
  const time = { value: clock }, at = (offsetMs: number) => { time.value = clock + offsetMs; return time.value; };
  const effects: DaemonEffects = {
    agents: () => agents,
    credentials: async profiles => Object.fromEntries(profiles.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: item.current, now: new Date(time.value).toISOString() }),
    closeSession: pane => { log.closed.push(pane); },
    dispatch: async (_work, profile) => { log.dispatches.push(profile.name); },
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    persist: async () => {},
    recordSession: async () => {},
    // The control plane ends the attempt and appends the exhaustion record the ladder reads back.
    reportCapacity: async (work, event) => {
      log.capacity.push(event);
      item.current = item.current.map(entry => {
        if (entry.id !== work.id) return entry;
        const { endsBlocker: _endsBlocker, ...report } = event as Record<string, unknown>;
        return { ...entry, lease: null,
          capacity: { exhaustions: [...(entry.capacity?.exhaustions ?? []), { ...report, at: iso(0), owner: 'alpha-principal', recordedBy: 'loop', resetsAt: null, partialWork: { state: 'committed', commit: 'a'.repeat(40), branch: 'graphyard/gy-885-1' } }], spent: entry.capacity?.spent ?? [] } } as Work;
      });
      return item.current[0];
    },
    preserveWork: async () => ({ state: 'committed', commit: 'a'.repeat(40), branch: 'graphyard/gy-885-1', detail: 'kept as WIP' }),
  };
  return { log, effects, at };
}

test('unit:overlong-attempt-ended', async t => {
  await t.test('an attempt past its role maximum is ended within one cycle, its work kept and its pane closed', async t => {
    const { directory, master } = await setup();
    try {
      const item = { current: [held()] };
      const agent: HerdrAgent = { name: 'agent-alpha', pane_id: 'w1:p1', agent_status: 'idle', agent: 'claude' };
      const { log, effects, at } = harness(item, [agent]);
      const state = emptyDaemonState(master);
      await runCycle(master, state, effects, () => at(0));

      assert.equal(log.capacity.length, 1, 'the attempt is ended on the record');
      const report = log.capacity[0];
      assert.equal(report.cause, 'interrupted');
      assert.equal(report.role, 'worker');
      assert.equal(report.epoch, 1);
      // The marker leads the reason: the retry ladder reads it back, and without it every count is zero.
      assert.ok(String(report.reason).startsWith(overlongMarker), `the end carries the overlong marker: ${report.reason}`);
      assert.match(String(report.reason), /ran 5h0m, past the 4h0m maximum/);
      assert.deepEqual(log.closed, ['w1:p1'], 'its pane is closed');
      assert.equal(item.current[0].lease, null, 'the ended lease frees the item');
      const ended = state.actions[overlongKey(item.current[0], 1)];
      assert.equal(ended?.state, 'done');
      assert.match(ended!.detail, /the attempt ended on the record/);

      // Ended once: the next cycle does nothing more for that epoch, and the record counts the end.
      await runCycle(master, state, effects, () => at(30_000));
      assert.equal(log.capacity.length, 1);
      assert.equal(failedAttemptCount(item.current[0]), 1, 'the end the marker leads is what the ladder counts');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await t.test('an attempt inside the bound is untouched', async t => {
    const { directory, master } = await setup();
    try {
      const item = { current: [held()] };
      item.current = [{ ...held(), sessions: [{ ...held().sessions![0], startedAt: iso(-2 * 3_600_000) }] } as Work];
      const agent: HerdrAgent = { name: 'agent-alpha', pane_id: 'w1:p1', agent_status: 'working', agent: 'claude' };
      const { log, effects, at } = harness(item, [agent]);
      const state = emptyDaemonState(master);
      await runCycle(master, state, effects, () => at(0));
      assert.equal(log.capacity.length, 0, 'an attempt inside its role maximum is not ended');
      assert.deepEqual(log.closed, [], 'no pane is closed');
      assert.equal(state.actions[overlongKey(item.current[0], 1)], undefined);
      assert.equal(attemptRetryHold(item.current[0], clock), null);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await t.test('the fresh attempt is dispatched, another runtime first, after the first backoff', async t => {
    const { directory, master } = await setup();
    try {
      const item = { current: [held()] };
      const agent: HerdrAgent = { name: 'agent-alpha', pane_id: 'w1:p1', agent_status: 'idle', agent: 'claude' };
      const { log, effects, at } = harness(item, [agent]);
      const state = emptyDaemonState(master);
      await runCycle(master, state, effects, () => at(0));
      assert.equal(log.capacity.length, 1);
      assert.deepEqual(log.dispatches, [], 'the first retry waits its backoff');

      // One minute later the backoff still holds; past five minutes the item dispatches, and the
      // runtime the overlong attempt ran on is tried last.
      await runCycle(master, state, effects, () => at(60_000));
      assert.deepEqual(log.dispatches, [], 'the 5-minute backoff holds the first retry');
      assert.equal(runtimeToAvoid(item.current[0]), 'claude', 'the ended attempt names the runtime to avoid');
      await runCycle(master, state, effects, () => at(6 * 60_000));
      assert.deepEqual(log.dispatches, ['beta'], 'a fresh attempt dispatches, another runtime first');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await t.test('the reason names the retry the next attempt stands for', () => {
    assert.equal(maxFailedAttempts, 3);
    const first = overlongReason({ key: 'GY-885' }, 1, 5 * 3_600_000, maximumMs, 0);
    const second = overlongReason({ key: 'GY-885' }, 2, 5 * 3_600_000, maximumMs, 1);
    assert.ok(first.startsWith(overlongMarker) && !first.includes('retry'));
    assert.ok(second.includes('retry 2 of 3'));
    assert.ok(overlongReason({ key: 'GY-885' }, 4, 5 * 3_600_000, maximumMs, 3).includes('retry 3 of 3'), 'the count never reads past the cap');
  });
});

test('unit:attempt-retries-capped', async t => {
  await t.test('the ladder counts only the row of overlong ends since the last submission', () => {
    assert.deepEqual(retryBackoffMs, [5 * 60_000, 15 * 60_000, 45 * 60_000]);
    const one = betweenAttempts([overlongEnd(1, 60_000)]);
    assert.equal(failedAttemptCount(one), 1);
    const row = attemptEndsNeedingRetry(one);
    assert.deepEqual(attemptRetryHold(one, clock), { count: 1, causes: attemptHoldCauses(row), ends: row, resumeAt: Date.parse(overlongEnd(1, 60_000).at) + 5 * 60_000 });
    assert.equal(attemptRetryHold(one, clock + 6 * 60_000), null, 'past the backoff the item dispatches');

    // A reblocked or idle hand-over breaks the row: it is not an overlong failure.
    const mixed = betweenAttempts([{ ...overlongEnd(1, 120_000), reason: 'idle with a live lease: no activity' }, overlongEnd(2, 60_000)]);
    assert.equal(failedAttemptCount(mixed), 1);
    // Neither does a submission: the row counts attempts after the one that submitted.
    const resubmitted = { ...betweenAttempts([overlongEnd(1, 120_000), overlongEnd(2, 60_000)]), submission: { epoch: 1, pr: 7 } } as unknown as Work;
    assert.equal(failedAttemptCount(resubmitted), 1);
  });

  await t.test('past three overlong ends the retry waits the longest backoff and then dispatches; nothing holds the item', async t => {
    const { directory, master } = await setup();
    try {
      const item = { current: [betweenAttempts([overlongEnd(1, 3 * 3_600_000), overlongEnd(2, 2 * 3_600_000), overlongEnd(3, 60_000)])] };
      const { log, effects, at } = harness(item, []);
      const state = emptyDaemonState(master);
      await runCycle(master, state, effects, () => at(0));
      assert.deepEqual(log.dispatches, [], 'the fourth attempt waits its backoff');
      const backoff = Object.entries(state.actions).find(([key]) => key.startsWith('retry:backoff:work-885'))?.[1];
      assert.match(backoff!.detail, /retry 4 waits 45 minutes/);
      assert.equal(Object.keys(state.actions).some(key => key.startsWith('retry:held:')), false, 'nothing holds the item');
      await runCycle(master, state, effects, () => at(46 * 60_000));
      assert.deepEqual(log.dispatches, ['beta'], 'the retry dispatches once its backoff is out, on the other runtime');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
