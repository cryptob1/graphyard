import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { daemonEffects, emptyDaemonState, runDaemon, writeDaemonState, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { describeTimings, mapBounded, serverCallName, slowCallMs, timedFetch, timedRun, childCall, Timings, withTimings } from '../src/master/timings.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-377. On 2026-09-25 loop cycles went from ~10 s to 3-4 minutes and `master status` to 2-4
 * minutes with 167 open items, and neither said where the time went. The cycle's own step metrics,
 * once it was asked, put 150-230 s in the step that classifies faults, which builds the attention
 * master status adds; timing the server's routes from this host named the two reads behind both:
 *
 *   - GET interventions?window=7 answered in 59 s with 929 KB, read by every cycle (which timed out
 *     at 30 s and failed) and by every status build;
 *   - GET work/:id/decisions, ~0.43 s each, read one after another for every open item — 170 of
 *     them are 73 s. Sent twelve at a time they still took 63 s, because the server loaded every
 *     work document to answer each one.
 *
 * The first is now read through a cache the loop refreshes off its critical path; the second reads
 * one document on the server, and it and the per-escalation context reads run bounded-concurrently.
 * These tests hold the loop and status to the item's budgets against fakes with those latencies.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
/**
 * The latencies measured on 2026-09-25, in real milliseconds. The fakes below sleep for them scaled
 * by `scale`, and the budgets are scaled the same way, so the proportions — and a serial pass's
 * failure to fit — are exactly those of the production host, in half the time. The host's own work
 * (the fault observation, the /tmp and worktree scans, git) is not scaled, and on a loaded trial host it
 * took 7 s: a finer scale inflates it past the budget.
 */
const measured = { snapshot: 1_960, status: 760, actions: 660, decisions: [390, 910, 270, 590, 220, 340, 420, 410], context: 400, mutation: 300 };
const scale = 1 / 2;
const cycleBudgetMs = 30_000 * scale, statusBudgetMs = 20_000 * scale;
const scaled = (ms: number) => Math.round(ms * scale);

function config(credentialFile: string, worktreeRoot: string): MasterConfig {
  // A server address that refuses at once: the few reads this test does not fake (the plane's
  // resource probe) fail immediately instead of waiting on a name lookup. The managed checkout root
  // is the fixture's own, so the loop's reclaim scans this test's checkouts and never the host's.
  return masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:9', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [], run: { worktreeRoot } });
}
function item(index: number, now: string): Work {
  const key = `GY-${index}`;
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, key, title: `Item ${key}`, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [],
    policy: { checks: ['test'], review: true }, stage: 'backlog', revision: 1, policyRevision: 1,
    createdAt: now, updatedAt: now, stageEnteredAt: now, ready: false, epoch: 0, lease: null, workspaces: [],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: `${key} waits on a vendor`,
    gates: [], violations: [],
  } as unknown as Work;
}

/** A fake Graphyard server with the measured latencies, scaled by `factor`, answering both the loop's fetch and master status's reader, and honouring each caller's timeout. */
function slowServer(work: () => Work[], factor = scale) {
  const reads: string[] = [];
  let decision = 0;
  const latency = (path: string) => path.startsWith('work-snapshot') ? measured.snapshot : path === 'status' ? measured.status : path === 'actions' ? measured.actions
    : /\/decisions$/.test(path) ? measured.decisions[decision++ % measured.decisions.length]
      : /\/context/.test(path) ? measured.context : 50;
  const answer = (path: string) => path.startsWith('work-snapshot') ? { work: work(), now: new Date().toISOString() }
    : path === 'status' ? { actor: { id: 'coordinator-1', role: 'coordinator' } }
      : path === 'actions' ? { executors: undefined }
        : /\/decisions$/.test(path) ? { decisions: [] } : {};
  /** One read: it takes its measured time, scaled, unless the caller's own timeout ends it first. */
  const read = async (path: string, timeoutMs?: number) => {
    reads.push(path);
    const ms = Math.round(latency(path) * factor);
    if (timeoutMs !== undefined && timeoutMs < ms) { await sleep(timeoutMs); throw new Error(`GET ${path} timed out after ${timeoutMs}ms`); }
    await sleep(ms);
    return answer(path);
  };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace(/^\/api\//, '') + new URL(String(input)).search;
    const body = await read(path);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { reads, read, fetcher };
}

/** The effects the loop runs with in production, over the fake server, with Herdr, the accounts and the deployment faked at their measured cost. */
function loopEffects(root: string, master: MasterConfig, server: ReturnType<typeof slowServer>, extra: Partial<DaemonEffects> = {}): DaemonEffects {
  const effects = daemonEffects(root, master, {
    snapshot: () => server.read('work-snapshot') as Promise<{ work: Work[]; now: string }>,
    mutate: async (path: string) => { await sleep(scaled(measured.mutation)); return { path }; },
    run: async (command: string) => { await sleep(3); if (command === 'herdr') return JSON.stringify({ result: { agents: [] } }); return ''; },
    fetcher: server.fetcher,
  });
  return Object.assign(effects, {
    agents: async () => [], herdr: async () => ({ agents: [], available: true }), credentials: async () => ({}), roleHealth: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }),
 closeSession: async () => {},
  }, extra) as DaemonEffects;
}

async function fixture(open: number, worktrees: number) {
  const root = await temporaryDirectory('latency-root'), secrets = await temporaryDirectory('latency-secrets');
  execFileSync('git', ['init', '-q', root]);
  const credential = join(secrets, 'coordinator.token');
  await writeFile(credential, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master = config(credential, join(secrets, 'checkouts'));
  await writeDaemonState(master, emptyDaemonState(master));
  // Every assignment worktree the host has kept.
  const directory = join(root, '.graphyard/worktrees');
  await mapBounded(Array.from({ length: worktrees }, (_, index) => index), 64, async index => { await mkdir(join(directory, `GY-${index + 1}-1`), { recursive: true }); });
  const now = new Date().toISOString();
  const work = Array.from({ length: open }, (_, index) => item(index + 1, now));
  return { root, secrets, master, work, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(secrets, { recursive: true, force: true }); } };
}

test('unit:cycle-step-timings — a cycle records every step and every external call of a second or more, names its three slowest steps and slowest call on its completion line, and master status reports its own per-phase timings', async () => {
  // The recorder names calls as the cycle's line prints them.
  assert.equal(serverCallName('GET', 'work/7f1c3a52-0000-4000-8000-000000000001/decisions'), 'GET work/:id/decisions');
  assert.equal(serverCallName('GET', `work/GY-12/context?trigger=review`), 'GET work/:id/context?trigger');
  assert.deepEqual(childCall('gh', ['api', '--paginate', 'repos/owner/project/check-runs/991/annotations']), { kind: 'github', name: 'gh api repos/:repo/check-runs/:id/annotations' });
  assert.deepEqual(childCall('herdr', ['agent', 'list', '--workspace', 'w1']), { kind: 'herdr', name: 'herdr agent list' });
  assert.deepEqual(childCall('git', ['-C', '/tmp/x', 'fetch', 'origin']), { kind: 'git', name: 'git fetch' });

  const { root, master, work, cleanup } = await fixture(3, 3);
  try {
    // Two slow fakes the production wiring times: a GitHub deployment listing through the loop's
    // child runner, and an account-quota probe; everything else answers at once — a tenth of the
    // measured latencies, so a loaded host never stretches a read past the 1 s a recorded call takes.
    const server = slowServer(() => work, 1 / 10);
    const run = timedRun(async (command: string, args: string[]) => { await sleep(args[1]?.includes('/deployments') ? 1_450 : 1); return '[]'; });
    const probe = timedFetch(async () => { await sleep(1_150); return new Response('{}'); });
    const lines: string[] = [];
    const state: DaemonState = emptyDaemonState(master);
    const effects = loopEffects(root, master, server, {
      snapshot: async () => ({ work, now: new Date().toISOString() }),
      credentials: async () => { await probe('https://api.anthropic.com/api/oauth/usage'); return {}; },
      observeDeployment: async () => { await run('gh', ['api', 'repos/owner/project/deployments?environment=production']); return { source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }; },
    });
    await runDaemon(master, state, effects, { once: true, intervalMs: 30_000, identity: { pid: process.pid, host: master.hostId }, log: line => lines.push(line), signals: [] });
    const timings = state.metrics.at(-1)!.timings!;
    assert.ok(timings, 'the cycle recorded its timings on the cursor');
    const steps = timings.steps.map(step => step.step);
    for (const step of ['snapshot', 'observe', 'credentials', 'close', 'reclaim', 'dispatch', 'launches', 'rework', 'reviews and proofs', 'merges', 'deployment verification', 'invariants', 'measure'])
      assert.ok(steps.includes(step), `the cycle records its ${step} step: ${steps.join(', ')}`);
    const slowest = [...timings.steps].sort((a, b) => b.ms - a.ms);
    assert.equal(slowest[0].step, 'deployment verification');
    assert.ok(slowest[0].ms >= 1_400, `the deployment step took at least its slow listing: ${slowest[0].ms}ms`);
    assert.equal(slowest[1].step, 'credentials');
    assert.deepEqual(timings.calls.map(call => [call.kind, call.name, call.step]), [['github', 'gh api repos/:repo/deployments', 'deployment verification'], ['account', 'GET api.anthropic.com/api/oauth/usage', 'credentials']],
      'both calls of a second or more, slowest first, each with the step it was made in; nothing faster is recorded');
    assert.ok(timings.calls[0].ms >= 1_400 && timings.calls[1].ms >= 1_100);
    // The completion line names the three slowest steps and the slowest call, with durations (their floors are asserted above; a loaded host only lengthens them).
    const complete = lines.find(line => / complete in /.test(line))!;
    assert.match(complete, /slowest steps: deployment verification \d+(\.\d)?s, credentials \d+(\.\d)?s, \S[^,;]* \d+(\.\d)?s; slowest call: github gh api repos\/:repo\/deployments \d+(\.\d)?s in deployment verification \(2 calls of 1s or more\)/, complete);

    // master status: the same recorder over its own phases, returned under `timings`.
    const status = slowServer(() => work, 1 / 10);
    // Master status no longer reads GET actions; the board read is the one slow server read left to time.
    const slowBoard = async (path: string, _credential?: string, timeoutMs?: number) => path === 'board' ? (await sleep(1_250), status.read(path, timeoutMs)) : status.read(path, timeoutMs);
    const report = await masterStatusReport(root, master, slowBoard, { actor: { id: 'coordinator-1' } }, { commit: null });
    assert.ok(report.timings, 'master status reports its timings');
    const phases = report.timings.steps.map(step => step.step);
    for (const phase of ['herdr', 'credentials', 'snapshot', 'reconcile reviews', 'reconcile producers', 'setup', 'worktrees', 'build status', 'attention: derived'])
      assert.ok(phases.includes(phase), `status times its ${phase} phase: ${phases.join(', ')}`);
    const statusSlowest = [...report.timings.steps].sort((a, b) => b.ms - a.ms)[0];
    assert.equal(statusSlowest.step, 'board', `the board read is the slowest phase: ${describeTimings(report.timings)}`);
    assert.ok(statusSlowest.ms >= 1_200);
    assert.deepEqual(report.timings.calls.map(call => [call.kind, call.name, call.step]), [['server', 'GET board', 'board']]);
    assert.ok(report.timings.calls[0].ms >= 1_200 && report.timings.calls[0].ms < 5_000, JSON.stringify(report.timings.calls));
    assert.ok(report.timings.totalMs >= statusSlowest.ms);
  } finally { await cleanup(); }
});

test('unit:cycle-latency-budget — with 170 open items and 1,100 worktrees at the measured latencies, a cycle fits 30 s and master status 20 s, and independent launches run at once, bounded by capacity', async () => {
  const { root, master, work, cleanup } = await fixture(170, 1_100);
  try {
    const server = slowServer(() => work);
    const state = emptyDaemonState(master);
    const lines: string[] = [];
    const started = Date.now();
    await runDaemon(master, state, loopEffects(root, master, server), { once: true, intervalMs: 30_000, identity: { pid: process.pid, host: master.hostId }, log: line => lines.push(line), signals: [] });
    const cycle = state.metrics.at(-1)!;
    assert.ok(Date.now() - started < cycleBudgetMs, `the cycle ran in ${Date.now() - started}ms against the scaled budget of ${cycleBudgetMs}ms: ${describeTimings(cycle.timings!)}`);
    assert.ok(cycle.durationMs < cycleBudgetMs);
    assert.match(lines.find(line => / complete in /.test(line))!, /slowest steps: /);

    // Status right after: a bounded live read, never the whole minute.
    let begun = Date.now();
    const cold = await masterStatusReport(root, master, (path, _credential, timeoutMs) => server.read(path, timeoutMs), { actor: { id: 'coordinator-1' } }, { commit: null });
    assert.ok(Date.now() - begun < statusBudgetMs, `a cold master status took ${Date.now() - begun}ms against the scaled budget of ${statusBudgetMs}ms: ${describeTimings(cold.timings)}`);
    assert.equal(cold.disk.reclaimable.length, 0, 'the 1,100 worktrees were inventoried; none is reclaimable while its item is open');

    // Independent worker launches run at once, bounded by capacity: four free profiles, six ready items, 400 ms per launch.
    // The launcher beside the cycle runs `run.launchConcurrency` of them at once (GY-616, default 3), set here to the four profiles.
    const profiles = ['a', 'b', 'c', 'd'].map(name => ({ name: `worker-${name}`, principal: `graphyard-${name}`, agentName: `agent-${name}`, mode: 'launch', kind: 'claude', credentialFile: join(root, `${name}.token`) }));
    const launching = { ...master, workers: profiles, run: { ...master.run, launchConcurrency: 4 } } as unknown as MasterConfig;
    const ready = Array.from({ length: 6 }, (_, index) => ({ ...item(500 + index, new Date().toISOString()), stage: 'build', ready: true, blocker: null }) as unknown as Work);
    let inFlight = 0, peak = 0;
    const dispatched: string[] = [];
    const launchState = emptyDaemonState(launching);
    begun = Date.now();
    await runDaemon(launching, launchState, loopEffects(root, launching, slowServer(() => ready), {
      snapshot: async () => ({ work: ready, now: new Date().toISOString() }),
      credentials: async () => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
      dispatch: async (target: Work, profile: { name: string }) => { inFlight++; peak = Math.max(peak, inFlight); await sleep(400); inFlight--; dispatched.push(`${target.key}:${profile.name}`); return { pane: null }; },
    }), { once: true, intervalMs: 30_000, identity: { pid: process.pid, host: master.hostId }, log: () => {}, signals: [] });
    assert.equal(dispatched.length, 4, `each free profile took one item: ${dispatched.join(', ')}`);
    assert.equal(peak, 4, 'the four launches ran at once, and no more than the four profiles');
    const launches = launchState.metrics.at(-1)!.timings!.steps.find(step => step.step === 'launches')!;
    assert.ok(launches.ms < 2 * 400, `the launches took ${launches.ms}ms, one launch's time, not four`);
  } finally { await cleanup(); }
});

test('mapBounded keeps order and never exceeds its limit; a recorder keeps its own calls apart from one running beside it', async () => {
  let inFlight = 0, peak = 0;
  const out = await mapBounded([5, 1, 4, 2, 3], 2, async value => { inFlight++; peak = Math.max(peak, inFlight); await sleep(value * 5); inFlight--; return value * 10; });
  assert.deepEqual(out, [50, 10, 40, 20, 30]);
  assert.equal(peak, 2);
  const run = timedRun(async (_command: string, args: string[]) => { await sleep(Number(args[1])); return ''; });
  const first = new Timings(), second = new Timings();
  await Promise.all([
    withTimings(first, () => first.step('one', () => run('herdr', ['agent', String(slowCallMs + 20)]))),
    withTimings(second, () => second.step('two', () => run('gh', ['pr', String(slowCallMs + 40)]))),
  ]);
  assert.deepEqual(first.report().calls.map(call => [call.name, call.step]), [['herdr agent ' + (slowCallMs + 20), 'one']]);
  assert.deepEqual(second.report().calls.map(call => [call.name, call.step]), [['gh pr ' + (slowCallMs + 40), 'two']]);
});
