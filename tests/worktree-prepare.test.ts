import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchWork, loadMasterConfig, prepareWorkerLaunch, saveWorkerProfile, setupMaster } from '../src/master.js';
import { readProfileLaunchRecords, workerLaunchRows, workerLaunchStatus } from '../src/master/dispatch.js';
import { profileLaunchedFile } from '../src/master/dispatch-reservation.js';
import type { WorkerProfile } from '../src/master/profiles.js';
import { readWorktreePrepares, recordWorktreePrepare, worktreePreparePercentiles, worktreePrepareWindowMs, type WorktreePrepareRecord } from '../src/master/worktrees.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Each test is named for the proof it produces (GY-1836): unit:one-fetch-per-cycle (AC-1) and
// unit:worktree-prepare-time-recorded (AC-2). AC-1: one dispatcher cycle makes at most one fetch of
// origin, and every worktree the cycle prepares is created from the coordinator's object store at
// that fetched tip, holding the branch and commit it always held; a later cycle fetches again, and
// a hand preparation, its own cycle, fetches for itself. AC-2: each dispatch record names how long
// its worktree took to prepare, and master status ranks the day's preparations p50 and p90.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const workerToken = 'worker-token-'.padEnd(40, 'x');
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));

/** A host repository the launcher accepts, with the managed base branch. */
async function host() {
  const root = await temporaryDirectory('worktree-prepare');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  return root;
}

/** The installed master configuration and one launch profile, exactly as a dispatch reads them. */
async function muse(root: string, credentialDirectory: string): Promise<WorkerProfile> {
  const credential = join(credentialDirectory, 'muse-1.token');
  await writeFile(credential, workerToken, { mode: 0o600 });
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory }, coordinatorStatus as typeof fetch);
  await saveWorkerProfile(root, { name: 'muse-primary', principal: 'muse-1', agentName: 'engineering-muse-1', mode: 'launch', kind: 'muse', credentialFile: credential, agentArgs: ['--approval-mode', 'never', '--trust-workspace'] }, async token => ({ actor: { id: token === workerToken ? 'muse-1' : 'wrong', role: 'worker' } }));
  return (await loadMasterConfig(root)).workers[0];
}

/** A released item on its first attempt, ready to dispatch. */
function item(key: string): Work {
  return { id: `id-${key}`, key, title: `Prepare ${key}`, description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:one-fetch-per-cycle'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'ready', revision: 1, policyRevision: 1, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 0, lease: null,
    workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null,
    blocker: null, gates: [], violations: [], mergeAuthorization: null } as Work;
}

test('unit:one-fetch-per-cycle — dispatching several items in one cycle fetches origin once and prepares every worktree from that fetched tip, on the branch and commit it always held', async () => {
  const root = await host();
  const credentialDirectory = await temporaryDirectory('worktree-prepare-credentials');
  try {
    const profile = await muse(root, credentialDirectory);
    const base = 'c'.repeat(40);
    const git: string[][] = [], worktrees: string[][] = [];
    const claims = new Map<string, number>();
    const run = (command: string, args: string[]) => {
      if (command === 'git') {
        git.push(args);
        return args[0] === 'rev-parse' ? `${base}\n` : '';
      }
      if (args[1] === 'claim') {
        const epoch = (claims.get(args[2]) ?? 0) + 1;
        claims.set(args[2], epoch);
        return JSON.stringify({ epoch, lease: { owner: profile.principal } });
      }
      if (args[1] === 'worktree') {
        worktrees.push(args);
        return JSON.stringify({ path: join(root, 'assigned', `${args[2]}-${args[3]}`) });
      }
      return '{}'; // push-credential, heartbeat
    };
    // One cycle: every preparation of one dispatcher cycle shares its single fetch.
    const cycle = new Date().toISOString();
    await prepareWorkerLaunch(root, 'GY-9001', profile.name, run, undefined, undefined, cycle);
    await prepareWorkerLaunch(root, 'GY-9002', profile.name, run, undefined, undefined, cycle);
    const fetches = git.filter(args => args[0] === 'fetch');
    assert.equal(fetches.length, 1, 'one dispatcher cycle makes one fetch of origin');
    assert.deepEqual(fetches[0].slice(1, 5), ['--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
    const resolutions = git.filter(args => args[0] === 'rev-parse');
    assert.equal(resolutions.length, 1, 'the fetched tip is resolved once');
    assert.deepEqual(resolutions[0], ['rev-parse', '--verify', 'refs/remotes/origin/main']);
    assert.deepEqual(worktrees.map(args => args[2]), ['GY-9001', 'GY-9002']);
    assert.deepEqual(worktrees.map(args => args[4]), [base, base], 'every worktree of the cycle is created from the object store at the fetched tip');
    // The next cycle's snapshot fetches origin again for its own tip.
    await prepareWorkerLaunch(root, 'GY-9003', profile.name, run, undefined, undefined, new Date(Date.parse(cycle) + 1).toISOString());
    assert.equal(git.filter(args => args[0] === 'fetch').length, 2, 'a later cycle fetches origin once more');
    assert.equal(worktrees[2][4], base);
    // A hand preparation is its own cycle: each fetches for itself, unchanged.
    await prepareWorkerLaunch(root, 'GY-9004', profile.name, run);
    await prepareWorkerLaunch(root, 'GY-9005', profile.name, run);
    assert.equal(git.filter(args => args[0] === 'fetch').length, 4, 'a hand dispatch without a cycle fetches for itself, as it always did');

    // Every launch of one dispatch snapshot shares that snapshot's instant as its cycle, so the
    // shared fetch above is the one the cycle's dispatches make, and no others.
    const cycles: (string | undefined)[] = [];
    const prepare = async (_root: string, _key: string, _profile: string, _run?: unknown, _claimBy?: number, _onClaimed?: unknown, cycle?: string) => {
      cycles.push(cycle);
      return { epoch: 9, path: join(root, 'assigned'), base };
    };
    const herdrRun = (_command: string, args: string[]) => JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'muse-pane', tab_id: 'muse-tab' }, tab: { tab_id: 'muse-tab' } }
      : args[1] === 'get' ? { type: 'agent_info', agent: { pane_id: 'muse-pane', agent: 'muse', agent_status: 'working' } } : {} });
    const dispatch = (key: string) => dispatchWork(root, item(key), profile, [], herdrRun, [item('GY-9006'), item('GY-9007')], prepare, async () => {}, 5_000, cycle,
      { start: { wait: () => {} }, mergeWriter: 'github' });
    await dispatch('GY-9006');
    await dispatch('GY-9007');
    assert.deepEqual(cycles, [cycle, cycle], 'both dispatches of one snapshot prepare on the cycle the snapshot names, whose single fetch the preparer shares');
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});

test('unit:worktree-prepare-time-recorded — each dispatch names its worktree preparation time on the dispatch record, and master status ranks the day p50 and p90', async () => {
  const root = await host();
  const credentialDirectory = await temporaryDirectory('worktree-prepare-credentials');
  try {
    const profile = await muse(root, credentialDirectory);
    // A record written before the time was measured parses, and reads as null, never as a number.
    await mkdir(dirname(profileLaunchedFile(root, 'muse-legacy')), { recursive: true, mode: 0o700 });
    await writeFile(profileLaunchedFile(root, 'muse-legacy'), JSON.stringify({ key: 'GY-9000', epoch: 1, agentName: 'engineering-muse-1', at: new Date().toISOString(), runtime: 'muse', account: null, prefer: null, failedAccounts: [] }), { mode: 0o600 });
    const legacy = await readProfileLaunchRecords(root, [{ name: 'muse-legacy' }]);
    assert.equal(legacy['muse-legacy']!.prepareMs, null);
    assert.equal(workerLaunchRows([{ name: 'muse-legacy' }], legacy)['muse-legacy']!.prepareMs, null);

    const started = Date.now();
    const result = await dispatchWork(root, item('GY-9006'), profile, [], (_command, args) => JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'muse-pane', tab_id: 'muse-tab' }, tab: { tab_id: 'muse-tab' } } : args[1] === 'get' ? { type: 'agent_info', agent: { pane_id: 'muse-pane', agent: 'muse', agent_status: 'working' } } : {} }),
      [item('GY-9006')], async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { epoch: 3, path: join(root, 'assigned'), base: 'c'.repeat(40) }; }, async () => {}, 5_000, new Date().toISOString(), { start: { wait: () => {} }, mergeWriter: 'github' });
    assert.equal(typeof result.prepareMs, 'number');
    assert.ok(result.prepareMs! >= 10, `the recorded time measures the preparation it belongs to: ${result.prepareMs}ms`);
    const record = (await readProfileLaunchRecords(root, [profile]))[profile.name]!;
    assert.equal(record.prepareMs, result.prepareMs, 'the dispatch record names the preparation time beside runtime, account and prefer');
    const [logged] = await readWorktreePrepares(root);
    assert.deepEqual({ key: logged.key, epoch: logged.epoch, profile: logged.profile, ms: logged.ms }, { key: 'GY-9006', epoch: 3, profile: profile.name, ms: result.prepareMs });
    assert.ok(Math.abs(Date.parse(logged.at) - started) < 60_000, 'the record is dated the day it was prepared');

    const config = await loadMasterConfig(root);
    const status = await workerLaunchStatus(root, config);
    assert.deepEqual(status.prepare, { count: 1, p50Ms: result.prepareMs, p90Ms: result.prepareMs, windowMs: worktreePrepareWindowMs }, 'master status ranks the day p50 and p90');
    assert.equal(status.rows[profile.name]!.prepareMs, result.prepareMs);

    const now = Date.now();
    const at = (ageMs: number): string => new Date(now - ageMs).toISOString();
    const record0 = (ageMs: number, key: string, ms: number): WorktreePrepareRecord => ({ at: at(ageMs), key, epoch: 1, profile: 'p', ms });
    const ranked = worktreePreparePercentiles([record0(3_600_000, 'GY-A', 100), record0(2 * 3_600_000, 'GY-B', 300), record0(7_200_000, 'GY-C', 200), record0(3 * worktreePrepareWindowMs, 'GY-D', 900_000), { ...record0(-5_000, 'GY-E', 1), at: at(-5_000) }], now);
    assert.deepEqual({ count: ranked.count, p50Ms: ranked.p50Ms, p90Ms: ranked.p90Ms }, { count: 3, p50Ms: 200, p90Ms: 300 }, 'the window holds the last day alone, and the rank rule is the daemon metrics');
    assert.deepEqual(worktreePreparePercentiles([], now), { count: 0, p50Ms: null, p90Ms: null, windowMs: worktreePrepareWindowMs });

    // A record past the retention is pruned when the next one is recorded.
    await recordWorktreePrepare(root, { at: at(3 * worktreePrepareWindowMs), key: 'GY-OLD', epoch: 1, profile: 'p', ms: 5 });
    await recordWorktreePrepare(root, { at: at(0), key: 'GY-9007', epoch: 4, profile: 'p2', ms: 7 });
    const kept = await readWorktreePrepares(root);
    assert.equal(kept.some(entry => entry.key === 'GY-OLD'), false, 'a record no percentile can read again is pruned');
    assert.deepEqual(kept.map(entry => entry.key), ['GY-9006', 'GY-9007']);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});
