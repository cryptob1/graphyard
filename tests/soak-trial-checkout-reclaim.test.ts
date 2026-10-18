import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultChildRun } from '../src/child-runner.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { shadowIdle, shadowReads } from '../src/daemon/cycle-shadow.js';
import { reclaimTrialCheckouts, runTrial, trialCheckoutPrefix, trialCheckoutRoots, trialExcludedRoots } from '../src/merge-writer/trial.js';
import { processPidNamespace, processStartTicks, tempOwnerMarker, writeTempOwner } from '../src/tmp-reclaim.js';
import type { FilesystemProbe } from '../src/install/worktree-root.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-2020 (review of 9c5bf7cc113d): every trial first takes back the short checkouts crashed trials
 * left in the on-disk trials folder, which is shared by every head and item and which no tmp reclaim
 * scans. Over a simulated day of the real loop's cycles, the shadow gate runs a real trial (a real
 * detached checkout, made and removed) for each submitted head, in the trials folder; trials crash
 * now and then, leaving a checkout whose owner is gone; one checkout is held by a process that lives
 * until midday and dies then; one is this process's own and lives all day. Each crashed checkout is
 * taken back by the next trial, the midday one after its owner dies and never before, the live one
 * never; no trial's checkout outlives it; the folder never holds more than the live ones plus the
 * crashes since the last trial; nothing lands under /tmp, /var/tmp or the tmpdir's name for the
 * folder; and every system invariant holds after every cycle.
 */
const minute = 60_000;
const start = Date.parse('2030-03-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const githubDouble = new Proxy({}, { get: (_, name) => { throw new Error(`the shadow step called GitHub (${String(name)})`); } });
const identity = { GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com', GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

const work = (n: number, submittedAt: number, mergedAt: number, now: number): Work => ({
  id: `w${n}`, key: `GY-${n}`, description: '', type: 'feature', priority: 1, dependencies: [], criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: [],
  revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(submittedAt), ready: true, epoch: 1, lease: null, workspaces: [],
  submission: { epoch: 1, pr: n }, candidate: { sha: sha(`head${n}`), baseSha: sha('base'), pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' }, reworkRequested: false,
  scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], gates: [],
  ...(now >= mergedAt ? { stage: 'done', delivery: { mergedAt: iso(mergedAt), mergeSha: sha(`merge${n}`), authorizationRevision: 1 } } : { stage: 'review' }),
}) as unknown as Work;

test('unit:soak-trial-checkout-reclaim — a simulated day of real trials on the real loop: crashed trials\' checkouts in the shared on-disk trials folder are taken back by the next trial, a live owner\'s never, a dying owner\'s only after it dies, the folder stays bounded, nothing lands in a temporary root, and every system invariant holds', { timeout: 300_000 }, async () => {
  // A repository the merge does not make a Node package builds and selects nothing: each trial is its real checkout, made and removed.
  const repo = await temporaryDirectory('soak-trial-repo', tmpdir());
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
  git('init', '-q', '-b', 'main'); writeFileSync(join(repo, 'a.txt'), 'one\n'); git('add', '-A'); git('commit', '-q', '-m', 'base');
  const mergeSha = git('rev-parse', 'HEAD');
  const sessions = await temporaryDirectory('soak-trial-sessions', tmpdir()), clean = await temporaryDirectory('soak-trial-tmp', tmpdir());
  const home = await temporaryDirectory('soak-trial-home', tmpdir());
  const [trials] = trialCheckoutRoots(home);
  const durable: FilesystemProbe = async path => ({ probed: path, volatile: null, freeBytes: 1e12 });
  // The live owners: this process all day, and a child that dies at midday.
  const kept = join(trials!, `${trialCheckoutPrefix}live`), dying = join(trials!, `${trialCheckoutPrefix}dying`);
  mkdirSync(join(kept, 'checkout'), { recursive: true }); mkdirSync(join(dying, 'checkout'), { recursive: true });
  await writeTempOwner(kept);
  const child = spawn('sleep', ['3600'], { stdio: 'ignore' });
  const ticks = processStartTicks(child.pid!);
  writeFileSync(tempOwnerMarker(dying), `${JSON.stringify({ pid: child.pid, startedAt: ticks, pidNamespace: processPidNamespace(), at: iso(start) })}\n`);
  const exited = new Promise(resolve => child.once('exit', resolve));
  let crashes = 0, gone = 2 ** 22;
  const crash = () => {
    // A trial killed before its cleanup: its checkout and its marker naming a process that is gone.
    const left = join(trials!, `${trialCheckoutPrefix}crash${++crashes}`);
    mkdirSync(join(left, 'checkout', 'node_modules'), { recursive: true }); writeFileSync(join(left, 'checkout', 'a.txt'), 'x\n');
    writeFileSync(tempOwnerMarker(left), `${JSON.stringify({ pid: ++gone, startedAt: 1, pidNamespace: processPidNamespace(), at: iso(start) })}\n`);
    return left;
  };
  const checkouts: string[] = [], reclaimed: string[] = [];
  let pending: string[] = [], running = 0, widest = 0, dyingAlive = true;
  const reads = shadowReads(config, '/coordinator', ((command: string, args: string[]) => {
    const [, , sub] = args;
    if (sub === 'rev-parse') return `${sha('tip')}\n`;
    if (sub === 'merge-tree') return `${sha('tree')}\0`;
    if (sub === 'commit-tree') return `${sha(`merge-${args.join(' ')}`)}\n`;
    if (sub === 'diff') return 'src/a.ts\n';
    return '';
  }) as never, { base: '/w', record: async () => {}, trial: async input => {
    running += 1; widest = Math.max(widest, running);
    try {
      // What the folder holds as the trial starts, and so what its reclaim pass sees.
      const before = new Set(readdirSync(trials!).filter(name => !name.endsWith('.owner')).map(name => join(trials!, name)));
      const verdict = await runTrial({ root: repo, base: sessions, mergeSha, changedFiles: [], timeoutMs: 120_000, key: input.key ?? 'trial', environment: { PATH: process.env.PATH! },
        temporaryRoots: [clean], checkoutRoots: [trials!], probe: durable, run: async (command, args, options) => {
          if (command === 'git' && args.includes('worktree') && args.includes('add')) {
            const made = args[args.indexOf('--detach') + 1]!;
            checkouts.push(made);
            // While the trial runs, every crashed checkout before it is gone, the live one stands, and the dying one stands while its owner lives.
            for (const left of pending) assert.equal(existsSync(left), false, `${left} outlived the trial after its crash`);
            reclaimed.push(...pending); pending = [];
            assert.ok(existsSync(kept), 'the live owner\'s checkout is never taken');
            if (dyingAlive) assert.ok(existsSync(dying), 'a checkout whose owner lives is never taken');
            assert.ok(before.has(kept));
          }
          return defaultChildRun(command, args, options);
        } });
      return verdict;
    } finally { running -= 1; }
  } });
  const items = 96, cycles = 24 * 60 / 2;
  const submittedAt = (n: number) => start + n * 15 * minute, mergedAt = (n: number) => submittedAt(n) + 25 * minute;
  let now = start;
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: Array.from({ length: items }, (_, index) => index + 1).filter(n => submittedAt(n) <= now).map(n => work(n, submittedAt(n), mergedAt(n), now)), now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, decisions: async () => ({ decisions: [] }), persist: async () => {},
    github: githubDouble, merge: githubDouble, shadow: reads } as unknown as DaemonEffects;
  const state = emptyDaemonState(config), violations: string[] = [];
  let most = 0, dyingGoneBy: number | null = null;
  try {
    for (let cycle = 0; cycle < cycles; cycle++) {
      now = start + cycle * 2 * minute;
      // A trial crashes every 47 minutes or so, two at once now and then.
      if (cycle % 23 === 5) pending.push(crash());
      if (cycle % 115 === 60) pending.push(crash());
      if (cycle === cycles / 2) { child.kill('SIGKILL'); await exited; dyingAlive = false; }
      await runCycle(config, state, effects, () => now);
      await shadowIdle(state);
      for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle}: ${check.invariant} — ${check.line}`);
      const held = readdirSync(trials!).filter(name => !name.endsWith('.owner'));
      most = Math.max(most, held.length);
      // Bounded: the two live owners' checkouts and the crashes since the last trial, never a trial's own after it ends.
      assert.ok(held.length <= 2 + pending.length, `cycle ${cycle}: the trials folder holds ${held.join(', ')}`);
      for (const made of checkouts) assert.equal(existsSync(made), false, `cycle ${cycle}: ${made} outlived its trial`);
      if (!dyingAlive && dyingGoneBy === null && !existsSync(dying)) dyingGoneBy = cycle;
    }
  } finally { if (dyingAlive) child.kill('SIGKILL'); }
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.ok(checkouts.length >= 60, `the gate made progress: ${checkouts.length} real trials`);
  assert.equal(widest, 1, 'one trial at a time');
  assert.ok(crashes >= 30 && reclaimed.length >= crashes - pending.length, `${reclaimed.length} of ${crashes} crashed checkouts were taken back by the next trial`);
  for (const left of reclaimed) assert.equal(existsSync(tempOwnerMarker(left)), false, `${left}'s marker went with it`);
  assert.ok(dyingGoneBy !== null && dyingGoneBy >= cycles / 2, `the dying owner's checkout went only after its owner died (cycle ${dyingGoneBy})`);
  assert.ok(existsSync(kept) && existsSync(tempOwnerMarker(kept)), 'the live owner\'s checkout stands at the end of the day');
  // Every checkout was in the on-disk trials folder, under none of /tmp, /var/tmp or the tmpdir by the folder's own choice of root.
  for (const made of checkouts) assert.ok(made.startsWith(`${trials}/${trialCheckoutPrefix}`) && made.endsWith('/checkout'), `${made} is in the trials folder`);
  assert.deepEqual(trialExcludedRoots('/var/tmp'), ['/tmp', '/var/tmp'], 'the default folder keeps out of the temporary roots');
  assert.deepEqual(await reclaimTrialCheckouts(trials!), pending, 'a last pass takes back only what crashed since the last trial');
  assert.ok(most <= 4, `the folder never held more than ${most} entries`);
});
