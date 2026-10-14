import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { contractPendingCases, cutCandidate, type CommitSummary, type ReleaseCandidate } from '../src/release-candidate.js';
import { defaultChildRun } from '../src/child-runner.js';
import { localReleasePorts } from '../src/daemon/release-ports.js';
import { settleLocalPromotion, type LocalReleasePorts } from '../src/daemon/promotion-local.js';
import { masterConfigSchema } from '../src/master.js';
import { readLedgerAsync, uatTagPrefix, productionTagPrefix, writeRecordAsync, type AsyncGit } from '../src/release-candidate.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { pendingFromPlane, readPlane, servingStage, type PlaneSnapshot } from '../src/release-pending.js';

/**
 * GY-1802: a simulated run of release candidates across days. A merged goal's plan is delivered
 * item by item while main keeps moving; every candidate is cut with the outcomes the plane then
 * holds pending. Asserts the pending state never sticks: it clears on the first candidate cut
 * after the serving item is done, an unreadable plane names none (blocks as before), and an item
 * merged after the candidate's SHA is still undelivered there.
 */
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const source = JSON.stringify({ outcomes: [{ id: 'goal-outcome', title: 'Goal', cases: ['goal-case'] }, { id: 'plain-outcome', title: 'Plain', cases: ['plain-case'] }] });
const day = 24 * 3_600_000;
const start = Date.parse('2030-06-01T00:00:00Z');

test('unit:soak-pending-outcomes — pending outcomes recorded per candidate clear once the serving item is done and never stick', async () => {
  const goals = [{ merged: true, protected: { outcomes: ['goal-outcome'] }, plan: { items: [{ ref: 'a', outcomes: ['goal-outcome'] }] }, items: [{ ref: 'a', key: 'GY-9001' }] }] as any;
  let stage: string | undefined = 'ready';
  let planeUp = true;
  const read = () => readPlane({ goals: async () => { if (!planeUp) throw new Error('403'); return goals; }, stage: async () => stage });
  let latest: ReleaseCandidate | null = null;
  const log: { day: number; pending: string[] | undefined; cases: string[] }[] = [];
  let tip = sha('main-0');
  for (let n = 1; n <= 24; n += 1) {
    tip = sha(`main-${n}`);
    if (n === 9) stage = 'done';
    planeUp = n !== 4 && n !== 5;
    const commits: CommitSummary[] = [{ sha: tip, parents: [sha(`main-${n - 1}`)], subject: `Merge pull request #${n} from graphyard/gy-${9000 + n}-1`, body: '' } as CommitSummary];
    const plane: PlaneSnapshot | null = await read();
    const result = cutCandidate({ tip, now: new Date(start + n * day), trigger: 'schedule', latest, promoted: null, commits, pendingOutcomes: pendingFromPlane(plane, source, { undelivered: new Set() }) });
    assert.ok(result.cut, `candidate ${n} is cut`);
    if (!result.cut) continue;
    latest = result.candidate;
    log.push({ day: n, pending: latest.pendingOutcomes, cases: contractPendingCases(JSON.parse(source), latest.pendingOutcomes) });
  }
  for (const entry of log) {
    const expectPending = entry.day < 9 && entry.day !== 4 && entry.day !== 5;
    assert.deepEqual(entry.pending, expectPending ? ['goal-outcome'] : undefined, `day ${entry.day}`);
    assert.deepEqual(entry.cases, expectPending ? ['goal-case'] : [], `day ${entry.day} cases`);
  }
  assert.equal(log.at(-1)!.pending, undefined, 'the pending state is cleared at the end of the run');
  // An item merged after the candidate's SHA is undelivered there, whatever the plane says.
  stage = 'done';
  assert.deepEqual(pendingFromPlane(await read(), source, { undelivered: new Set(['GY-9001']) }), ['goal-outcome']);
});

test('unit:soak-pending-outcomes — an item closed without delivery does not deliver its outcome', async () => {
  const goals = [{ merged: true, protected: { outcomes: ['goal-outcome'] }, plan: { items: [{ ref: 'a', outcomes: ['goal-outcome'] }] }, items: [{ ref: 'a', key: 'GY-9001' }] }] as any;
  const pendingFor = async (work: any) => pendingFromPlane(await readPlane({ goals: async () => goals, stage: async () => servingStage(work) }), source, { undelivered: new Set() });
  assert.deepEqual(await pendingFor({ stage: 'done', closure: { kind: 'duplicate' } }), ['goal-outcome']);
  assert.deepEqual(await pendingFor({ stage: 'done' }), []);
});

// A real-loop soak: the loop's own promotion cycle drives the production release ports (localReleasePorts) over a real
// origin and checkout, one merge and one cycle a simulated day, while the plane's goal record and item stage change under it.
test('unit:soak-pending-outcomes — the real promotion cycle cuts a candidate per day whose pending outcomes follow the plane: pending until the serving item is done, unrecorded while the plane is unreadable, delivered after, and every candidate settles', { timeout: 300_000 }, async () => {
  const root = await realpath(await temporaryDirectory('soak-pending'));
  try {
    const origin = join(root, 'origin.git'), checkout = join(root, 'checkout'), managed = join(root, 'managed');
    await mkdir(managed, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
    const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const asyncGit: AsyncGit = async args => git(...args);
    for (const [key, value] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) git('config', key, value);
    await mkdir(join(checkout, 'e2e'), { recursive: true });
    await writeFile(join(checkout, 'e2e', 'contract.json'), source);
    await writeFile(join(checkout, 'README.md'), '# Fixture\n');
    git('add', '.'); git('commit', '-q', '-m', 'base'); git('push', '-q', 'origin', 'main'); git('fetch', '-q', 'origin');
    const merge = async (n: number) => {
      const branch = `graphyard/gy-${9000 + n}-1`;
      git('checkout', '-q', '-b', branch, 'refs/remotes/origin/main');
      await writeFile(join(checkout, `change-${n}.txt`), `${n}\n`); git('add', '.'); git('commit', '-q', '-m', `GY-${9000 + n} change`);
      git('checkout', '-q', '--detach', 'refs/remotes/origin/main');
      git('merge', '-q', '--no-ff', branch, '-m', `Merge pull request #${n} from owner/${branch}`, '-m', `GY-${9000 + n}: the change`);
      git('push', '-q', 'origin', 'HEAD:main'); git('fetch', '-q', 'origin');
      return git('rev-parse', 'HEAD');
    };
    const goals = [{ merged: true, protected: { outcomes: ['goal-outcome'] }, plan: { items: [{ ref: 'a', outcomes: ['goal-outcome'] }] }, items: [{ ref: 'a', key: 'GY-9006' }] }] as any;
    let stage: string | undefined = 'ready', planeUp = true, clock = start;
    const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
      repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { candidates: { everyMerges: 1, idleMinutes: 15 }, mergeWriter: { deployKeyFile: join('/keys', 'deploy'), retrials: 2 } } });
    const real = () => localReleasePorts(config, checkout, defaultChildRun, { base: managed, record: async () => ({}), environment: { ...process.env, GRAPHYARD_UAT_URL: 'https://uat.example.test' }, now: () => clock,
      plane: { goals: async () => { if (!planeUp) throw new Error('403'); return goals; }, stage: async () => stage } })!;
    const recorded: { id: string; pending: string[] | undefined; cases: string[] }[] = [];
    const settled: string[] = [];
    const ports = (): LocalReleasePorts => ({ ...real(),
      uat: async id => ({ sha: (await readLedgerAsync(asyncGit)).candidates.find(entry => entry.id === id)!.sha }),
      validate: async id => {
        const entry = (await readLedgerAsync(asyncGit)).candidates.find(candidate => candidate.id === id)!;
        const cases = contractPendingCases(JSON.parse(source), entry.pendingOutcomes);
        recorded.push({ id, pending: entry.pendingOutcomes, cases });
        const record = { id, sha: entry.sha, result: 'passed' as const, deployedSha: entry.sha, at: new Date(clock).toISOString(), suites: [{ name: 'e2e', passed: true, detail: 'ok' }], followUp: null };
        await writeRecordAsync(asyncGit, `${uatTagPrefix}${id}`, entry.sha, record, true);
        return { record, followUp: null };
      },
      promote: async id => {
        const entry = (await readLedgerAsync(asyncGit)).candidates.find(candidate => candidate.id === id)!;
        await writeRecordAsync(asyncGit, `${productionTagPrefix}${id}`, entry.sha, { id, sha: entry.sha, at: new Date(clock).toISOString() }, true);
        settled.push(id);
        return { promoted: true, sha: entry.sha };
      },
      verify: async served => ({ served, verified: true }),
    });
    let state = null as Awaited<ReturnType<typeof settleLocalPromotion>>['state'] | null;
    for (let n = 1; n <= 12; n += 1) {
      clock = start + n * day;
      if (n === 7) stage = 'done';
      planeUp = n !== 3 && n !== 4;
      const tip = await merge(n);
      const local = ports();
      const reads = { ledger: async () => { const ledger = await readLedgerAsync(asyncGit); return { mainSha: tip, promotedSha: ledger.production[0]?.sha ?? null, promotedAt: null, behind: null,
        candidates: ledger.candidates.map(entry => ({ id: entry.id, sha: entry.sha, cutAt: entry.cutAt, prs: entry.prs ?? entry.items.length, queued: entry.queued ?? 0 })) }; },
        runs: async () => [], dispatch: async () => { throw new Error('no dispatch in control-plane mode'); }, local };
      const result = await settleLocalPromotion(state, reads, { now: clock, everyMinutes: 10, intervalMs: 120_000, frozen: null, watchedTip: tip });
      assert.equal(result.failure, null, `day ${n}: ${result.state.reason ?? ''}`);
      state = result.state;
      assert.equal(state.inFlight, false, `day ${n} settles its candidate`);
    }
    assert.equal(recorded.length, 12, 'one candidate was cut and validated per day');
    assert.equal(settled.length, 12, 'every candidate settled to production');
    recorded.forEach((entry, index) => {
      const dayNumber = index + 1, expectPending = dayNumber < 7 && dayNumber !== 3 && dayNumber !== 4;
      assert.deepEqual(entry.pending, expectPending ? ['goal-outcome'] : undefined, `day ${dayNumber}`);
      assert.deepEqual(entry.cases, expectPending ? ['goal-case'] : [], `day ${dayNumber} cases`);
    });
    assert.equal(new Set(recorded.map(entry => entry.id)).size, 12, 'no candidate was cut twice');
  } finally { await rm(root, { recursive: true, force: true }); }
});
