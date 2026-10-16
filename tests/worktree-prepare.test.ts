import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, appendFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchWork, loadMasterConfig, prepareWorkerLaunch, saveWorkerProfile, setupMaster } from '../src/master.js';
import { readProfileLaunchRecords, workerLaunchRows, workerLaunchStatus } from '../src/master/dispatch.js';
import { profileLaunchedFile } from '../src/master/dispatch-reservation.js';
import type { WorkerProfile } from '../src/master/profiles.js';
import { holdCycleBase, readWorktreePrepares, recordWorktreePrepare, worktreePreparePercentiles, worktreePrepareFile, worktreePrepareWindowMs, type WorktreePrepareRecord } from '../src/master/worktrees.js';
import type { Work } from '../src/model.js';
import { clock, hour, minute } from './helpers/soak-world.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Each test is named for the proof it produces (GY-1836): unit:one-fetch-per-cycle (AC-1) and
// unit:worktree-prepare-time-recorded (AC-2). AC-1: one dispatcher cycle makes at most one fetch of
// origin, and every worktree the cycle prepares is created from the coordinator's object store at
// that fetched tip, holding the branch and commit it always held; a later cycle fetches again, and
// a hand preparation, its own cycle, fetches for itself. AC-2: each dispatch record names how long
// its worktree took to prepare, and master status ranks the day's preparations p50 and p90. The
// soak at the end runs the real dispatch path — dispatchWork with its own prepareWorkerLaunch —
// across several of the loop's simulated cycles and days, asserting the invariants the loop
// repeats every cycle: one fetch per cycle with launches queued across cycles, a failed fetch
// retried rather than cached, no queued launch building from a tip older than its own cycle's
// fetch, the preparation log bounded by its retention over the days, and percentiles that rank
// only the last day.

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

/** The installed master configuration and one launch profile, exactly as a dispatch reads them. The soak's install points `cliPath` at the fixture CLI the day's claims run through. */
async function muse(root: string, credentialDirectory: string, cliPath: string = launcher): Promise<WorkerProfile> {
  const credential = join(credentialDirectory, 'muse-1.token');
  await writeFile(credential, workerToken, { mode: 0o600 });
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath, credentialDirectory }, coordinatorStatus as typeof fetch);
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

    // The daemon's launcher records several dispatches at once in one process: every one is kept.
    const concurrent = Array.from({ length: 12 }, (_, index) => ({ at: at(0), key: `GY-${9100 + index}`, epoch: 1, profile: 'p', ms: index }));
    await Promise.all(concurrent.map(entry => recordWorktreePrepare(root, entry)));
    const together = (await readWorktreePrepares(root)).map(entry => entry.key);
    assert.deepEqual([...together].sort(), ['GY-9006', 'GY-9007', ...concurrent.map(entry => entry.key)].sort(), 'concurrent recordings never drop one another\'s entry');
    assert.deepEqual((await readdir(dirname(worktreePrepareFile(root)))).filter(name => name.endsWith('.tmp')), [], 'no temporary file is left behind');
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});

test('unit:soak-prepare-cycles — over simulated cycles and days the real dispatch path fetches origin at most once per cycle (a launch queued on an older snapshot prepares from its own cycle\'s tip however many cycles later it runs, the bound never dropping a cycle a queued launch holds, and a preparation on that instant fetches for itself once its launches settled), retries a failed fetch instead of caching it, never builds a worktree from a tip older than its own cycle\'s fetch, keeps the preparation log within its retention across the days, and ranks only the last day', { timeout: 300_000 }, async () => {
  // The review round on 7460f0e68d asked for this soak: the day's launches through the real
  // dispatch path — dispatchWork with its own prepareWorkerLaunch, so the real child runner, the
  // cycle's shared fetch (cycleBaseTip) and the preparation log — across several of the loop's
  // cycles and then days, on a simulated clock. The world stands in where every soak's world
  // stands in, at its boundaries: `git` on PATH forwards every command and redirects only a fetch
  // of `origin` to a real local bare repository (whose configured URL stays the GitHub one
  // discovery reads), and the CLI a launch claims and builds its worktree through is a script
  // beside the coordinator root; both keep logs the day's facts are read back from. The fetch is
  // real, and the origin's main advances once per cycle, so every cycle's fetch holds a tip no
  // earlier cycle held and every worktree's base names the commit it was created from.
  const root = await host();
  const credentialDirectory = await temporaryDirectory('worktree-prepare-credentials');
  const originPath = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', originPath]);
  const committer = { GIT_AUTHOR_NAME: 'soak', GIT_AUTHOR_EMAIL: 'soak@example', GIT_COMMITTER_NAME: 'soak', GIT_COMMITTER_EMAIL: 'soak@example' };
  const inOrigin = (args: string[], input?: string): string => execFileSync('git', args, { cwd: originPath, input, encoding: 'utf8', env: { ...process.env, ...committer }, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const tips = new Map<number, string>();
  tips.set(0, inOrigin(['commit-tree', inOrigin(['mktree'], ''), '-m', 'seed']));
  inOrigin(['update-ref', 'refs/heads/main', tips.get(0)!]);
  // The origin moves before each cycle of the day, the way the base branch does between the loop's cycles.
  const advanceOrigin = (number: number): string => {
    const blob = inOrigin(['hash-object', '-w', '--stdin'], `cycle ${number}\n`);
    const tip = inOrigin(['commit-tree', inOrigin(['mktree'], `100644 blob ${blob}\tfile.txt\n`), '-p', [...tips.values()].at(-1)!, '-m', `cycle ${number}`]);
    inOrigin(['update-ref', 'refs/heads/main', tip]);
    tips.set(number, tip);
    return tip;
  };
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const fetchLog = join(root, 'fetch.log'), failFetch = join(root, 'fail-fetch'), cliLog = join(root, 'fixture-cli.jsonl');
  const binDirectory = join(root, 'bin');
  mkdirSync(binDirectory, { recursive: true });
  await writeFile(join(binDirectory, 'git'), `#!/usr/bin/env node
import { appendFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] === 'fetch') {
  appendFileSync(${JSON.stringify(fetchLog)}, 'fetch\\n');
  if (existsSync(${JSON.stringify(failFetch)})) {
    rmSync(${JSON.stringify(failFetch)});
    appendFileSync(${JSON.stringify(fetchLog)}, 'failed\\n');
    process.stderr.write('fatal: could not read from remote repository\\n');
    process.exit(128);
  }
  const redirected = args.map(argument => argument === 'origin' ? ${JSON.stringify(originPath)} : argument);
  process.exit(spawnSync(${JSON.stringify(realGit)}, redirected, { stdio: 'inherit' }).status ?? 1);
}
process.exit(spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }).status ?? 1);
`, { mode: 0o755 });
  const fixtureCli = join(root, 'fixture-cli.mjs');
  await writeFile(fixtureCli, `import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = ${JSON.stringify(root)}, log = ${JSON.stringify(cliLog)};
const command = process.argv[2], key = process.argv[3];
const say = value => process.stdout.write(\`\${JSON.stringify(value)}\\n\`);
const entries = () => existsSync(log) ? readFileSync(log, 'utf8').split('\\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const record = entry => appendFileSync(log, \`\${JSON.stringify(entry)}\\n\`);
if (command === 'claim') {
  const epoch = entries().filter(entry => entry.command === 'claim' && entry.key === key).length + 1;
  record({ command, key, epoch });
  say({ epoch, lease: { owner: 'muse-1' } });
} else if (command === 'worktree') {
  const epoch = Number(process.argv[4]), base = process.argv[5];
  const path = join(root, 'assigned', \`\${key}-\${epoch}\`);
  mkdirSync(path, { recursive: true });
  const branch = \`graphyard/\${key.toLowerCase()}-\${epoch}\`;
  record({ command, key, epoch, base, branch });
  say({ path, branch, reclaimed: [] });
} else if (command === 'push-credential') {
  mkdirSync(process.argv[5], { recursive: true });
  say({});
} else {
  record({ command, key });
  say({});
}
`);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDirectory}:${previousPath}`;
  const profile = await muse(root, credentialDirectory, fixtureCli);
  // The launcher's Herdr reads: the only calls that still run through dispatchWork's runner, as
  // the real path routes them — git and the CLI run as child processes of their own.
  const herdrRun = (command: string, args: string[]): string => {
    if (command !== 'herdr') throw new Error(`Unexpected command ${command} ${args.join(' ')}: the real path runs git and the CLI as child processes, never through this runner`);
    return JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'muse-pane', tab_id: 'muse-tab' }, tab: { tab_id: 'muse-tab' } } : args[1] === 'get' ? { type: 'agent_info', agent: { pane_id: 'muse-pane', agent: 'muse', agent_status: 'working' } } : {} });
  };
  // One dispatch as production's effects make it (src/daemon/effects-production.ts:300): the real
  // prepare, release and renewal through the real child runner, the snapshot's instant as the
  // cycle. Only the plane's merger read and the start bound stand in, as the other soaks' worlds do.
  const dispatch = (key: string, at: string) => dispatchWork(root, item(key), profile, [], herdrRun, [item(key)], undefined, undefined, undefined, at,
    { start: { wait: () => {} }, readMergeWriter: async () => 'github' as const });
  const markCycle = (label: string) => appendFileSync(fetchLog, `cycle ${label}\n`);
  const fetchesByCycle = async () => {
    const counts = new Map<string, number>(), failed = new Map<string, number>();
    let label = 'unmarked';
    for (const line of (await readFile(fetchLog, 'utf8')).split('\n').filter(Boolean)) {
      if (line.startsWith('cycle ')) { label = line.slice(6); continue; }
      const into = line === 'failed' ? failed : counts;
      into.set(label, (into.get(label) ?? 0) + 1);
    }
    return { counts, failed };
  };
  const start = Date.now();
  clock.install(start);
  try {
    const at = (offsetMs: number): string => new Date(start + offsetMs).toISOString();
    const results: { key: string; epoch: number; prepareMs: number }[] = [];
    const cliEntries = async () => (await readFile(cliLog, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { command: string; key: string; epoch: number; base: string; branch: string });
    const worktreeEntries = async () => (await cliEntries()).filter(entry => entry.command === 'worktree');
    const dispatchSuccessfully = async (key: string, instant: string, cycleTip: number) => {
      const result = await dispatch(key, instant);
      assert.equal(typeof result.prepareMs, 'number');
      assert.ok(result.prepareMs! >= 0, `the dispatch measured its preparation: ${result.prepareMs}ms`);
      assert.equal(result.epoch, 1, `${key} was launched at its first epoch`);
      const worktree = (await worktreeEntries()).at(-1)!;
      assert.equal(worktree.key, key);
      assert.equal(worktree.base, tips.get(cycleTip), `${key} was created from the object store at cycle ${cycleTip}'s fetched tip`);
      assert.equal(worktree.branch, `graphyard/${key.toLowerCase()}-1`, `${key}: the worktree holds the item's branch`);
      results.push({ key, epoch: result.epoch, prepareMs: result.prepareMs! });
      return result;
    };
    // Day 1: five cycles, five minutes apart, each advancing the origin and dispatching through the real path.
    const day1: string[][] = [['GY-9101', 'GY-9102'], ['GY-9103'], ['GY-9104'], ['GY-9105'], ['GY-9106']];
    // Cycle 1 queues two launches the launcher runs only cycles later: the loop's dispatch step
    // holds the cycle's fetch for them from the moment it queues them (holdCycleBase).
    const queuedOnC1 = [holdCycleBase(at(5 * minute)), holdCycleBase(at(5 * minute))];
    for (const [index, keys] of day1.entries()) {
      const number = index + 1;
      markCycle(`C${number}`);
      advanceOrigin(number);
      const instant = at(number * 5 * minute);
      if (number === 4) {
        // The cycle's fetch fails once: the launch is refused before anything is claimed, nothing
        // is recorded, and the next preparation of the same cycle fetches again rather than
        // reading a cached failure — one outage costs one refused launch, not the cycle's every launch.
        await writeFile(failFetch, '');
        await assert.rejects(dispatch('GY-9105', instant), /Command failed: git fetch --quiet --no-tags origin/);
        assert.ok(!(await cliEntries()).some(entry => entry.command === 'claim' && entry.key === 'GY-9105'), 'the failed fetch refused the launch before its claim');
        assert.ok((await readWorktreePrepares(root)).every(entry => entry.key !== 'GY-9105'), 'a refused preparation records no preparation time');
      }
      for (const key of keys) await dispatchSuccessfully(key, instant, number);
    }
    // One successful fetch of origin per cycle; the only failed one is the one the scenario armed, retried within its cycle.
    const day1Fetches = await fetchesByCycle();
    assert.deepEqual([1, 2, 3, 4, 5].map(number => day1Fetches.counts.get(`C${number}`)), [1, 1, 1, 2, 1], 'each cycle fetched origin once, the fourth once more because its first fetch failed and was retried');
    assert.deepEqual([...day1Fetches.failed], [['C4', 1]], 'the failed fetch was retried, not cached, and never failed twice');

    // A launch queued from cycle 1's snapshot, prepared after four later cycles ran, still reads
    // its own cycle's held fetch: no fetch of its own, and the tip cycle 1 fetched — never older,
    // never a newer cycle's.
    markCycle('C1-queued');
    await dispatchSuccessfully('GY-9107', at(5 * minute), 1);
    queuedOnC1[0]();
    assert.equal((await fetchesByCycle()).counts.get('C1-queued'), undefined, 'the queued launch made no fetch: it read its cycle\'s held one');

    // Five more cycles fetch, ten in all, past the eight the bound keeps, and cycle 1's is the
    // oldest: the bound drops cycle 2's instead while cycle 1's second queued launch holds it, so
    // that launch, prepared now with origin moved on, makes no fetch and prepares from the tip
    // cycle 1 fetched.
    for (const [index, key] of ['GY-9108', 'GY-9109', 'GY-9110', 'GY-9111', 'GY-9116'].entries()) {
      const number = 6 + index;
      markCycle(`C${number}`);
      advanceOrigin(number);
      await dispatchSuccessfully(key, at(number * 5 * minute), number);
    }
    markCycle('C1-queued-2');
    advanceOrigin(90);
    await dispatchSuccessfully('GY-9112', at(5 * minute), 1);
    assert.equal((await fetchesByCycle()).counts.get('C1-queued-2'), undefined, 'past the bound the held cycle\'s queued launch still reads its cycle\'s tip, with no fetch of its own');
    // Its last launch settled, cycle 1 holds nothing and the bound drops it: a preparation on that
    // instant now — nothing queued on it — fetches for itself, from the tip origin holds.
    // Given back twice, as a settle and a refused hand-over both might: the hold counts once.
    queuedOnC1[1]();
    queuedOnC1[1]();
    markCycle('C1-released');
    await dispatchSuccessfully('GY-9115', at(5 * minute), 90);
    assert.equal((await fetchesByCycle()).counts.get('C1-released'), 1, 'once its launches settled the cycle\'s fetch is no longer held');

    // The day's log holds one record per prepared worktree, and master status ranks them all.
    assert.equal(results.length, 14);
    const day1Records = await readWorktreePrepares(root);
    assert.deepEqual(day1Records.map(entry => entry.key), results.map(result => result.key), 'each prepared worktree recorded its preparation time, in the order they were prepared');
    assert.ok(day1Records.every(entry => Date.parse(entry.at) >= start && Date.parse(entry.at) < start + 90 * minute), 'every record is dated the cycle that prepared it');
    assert.equal((await workerLaunchStatus(root, await loadMasterConfig(root))).prepare.count, 14, 'master status ranks the day\'s preparations');
    // A slow preparation from day 1 joins the log, inside the window it stands in.
    await recordWorktreePrepare(root, { at: at(20 * minute), key: 'GY-9110', epoch: 1, profile: profile.name, ms: 900_000 });
    assert.equal((await readWorktreePrepares(root)).length, 15);

    // Three days on, two more cycles dispatch: the first record past the retention prunes day 1,
    // so the log stays bounded across the days, and the percentiles rank only the last day — the
    // day-1 records, the 900_000 ms one included, read in none of them.
    clock.advance(3 * 24 * hour);
    for (const [index, key] of ['GY-9113', 'GY-9114'].entries()) {
      const number = 12 + index;
      markCycle(`C${number}`);
      advanceOrigin(number);
      await dispatchSuccessfully(key, at(3 * 24 * hour + number * 5 * minute), number);
    }
    const kept = await readWorktreePrepares(root);
    assert.deepEqual(kept.map(entry => entry.key), ['GY-9113', 'GY-9114'], 'the log stays bounded by its retention across the days: day 1 is pruned');
    const status = await workerLaunchStatus(root, await loadMasterConfig(root));
    const ranked = kept.map(entry => entry.ms).sort((a, b) => a - b);
    assert.deepEqual(status.prepare, { count: 2, p50Ms: ranked[0], p90Ms: ranked[1], windowMs: worktreePrepareWindowMs }, 'the percentiles reflect only the last day');
    assert.ok(status.prepare.p90Ms! < 900_000, `the slow day-1 preparation is out of the window: p90 ${status.prepare.p90Ms}ms`);
    assert.equal(status.rows[profile.name]!.prepareMs, results.at(-1)!.prepareMs, 'the profile row names the last dispatch\'s preparation time');

    // Every launch of the two days claimed exactly once: the failed fetch spent no attempt, and
    // no launch was refused for an identity it did not hold.
    const entries = await cliEntries();
    assert.deepEqual(entries.filter(entry => entry.command === 'claim').map(entry => entry.key).sort(), results.map(result => result.key).sort(), 'every launch of the two days claimed exactly once');
  } finally {
    process.env.PATH = previousPath;
    clock.uninstall();
    await rm(root, { recursive: true, force: true });
    await rm(credentialDirectory, { recursive: true, force: true });
  }
});
