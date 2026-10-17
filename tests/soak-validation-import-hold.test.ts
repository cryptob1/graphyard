import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { productionBranch, readLedgerAsync, uatTagPrefix, uatValidationWindowMs, writeRecordAsync, type AsyncGit } from '../src/release-candidate.js';
import { defaultChildRun } from '../src/child-runner.js';
import { localReleasePorts } from '../src/daemon/release-ports.js';
import { settleLocalPromotion } from '../src/daemon/promotion-local.js';
import { masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Time-bomb allowance (GY-1860): the 2030-06-01 simulated clock is the ports' injected now; every cut, UAT record and hold read derives from it.
/**
 * GY-1860: a real-loop soak of the imported-run hold. The loop's own promotion cycle drives the
 * production release ports (localReleasePorts) over a real origin and checkout — the real cut and
 * the real promote, which reads each candidate's hold through the plane — one merge a simulated day
 * and a cycle every ten minutes. UAT is simulated and always passes; the plane answers each
 * candidate's hold from a script: held, unread, released, no import route, or held for good. Asserts
 * that a held or unread candidate is never promoted, that it is retried with a fresh hold read once a
 * promotion interval and promoted once its hold is released, without UAT rerunning; that a candidate
 * held past the UAT window stops being read and a newer cut supersedes it; and that no candidate is
 * validated or recorded in production twice.
 */
const day = 24 * 3_600_000, soakStep = 10 * 60_000, start = Date.parse('2030-06-01T00:00:00Z');
type Answer = 'held' | 'unread' | 'released' | 'absent';
// Each day's candidate: the answers its hold reads give in turn, the last repeating.
const holdScripts: Answer[][] = [
  ['held', 'held', 'released'],
  ['unread', 'unread', 'released'],
  ['held', 'unread', 'held', 'released'],
  ['absent'],
  ['held'],
  ['released'],
];

test('unit:soak-validation-import-hold — the real promotion cycle retries a held or unread candidate with a fresh hold read, promotes it once released without rerunning UAT, and never promotes a held candidate or writes twice', { timeout: 300_000 }, async () => {
  const root = await realpath(await temporaryDirectory('soak-import-hold'));
  try {
    const origin = join(root, 'origin.git'), checkout = join(root, 'checkout'), managed = join(root, 'managed');
    await mkdir(managed, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
    const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const asyncGit: AsyncGit = async args => git(...args);
    for (const [key, value] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) git('config', key, value);
    await writeFile(join(checkout, 'README.md'), '# Fixture\n');
    git('add', '.'); git('commit', '-q', '-m', 'base'); git('push', '-q', 'origin', 'main'); git('fetch', '-q', 'origin');
    const merge = async (n: number) => {
      const branch = `graphyard/gy-${9100 + n}-1`;
      git('checkout', '-q', '-b', branch, 'refs/remotes/origin/main');
      await writeFile(join(checkout, `change-${n}.txt`), `${n}\n`); git('add', '.'); git('commit', '-q', '-m', `GY-${9100 + n} change`);
      git('checkout', '-q', '--detach', 'refs/remotes/origin/main');
      git('merge', '-q', '--no-ff', branch, '-m', `Merge pull request #${n} from owner/${branch}`, '-m', `GY-${9100 + n}: the change`);
      git('push', '-q', 'origin', 'HEAD:main'); git('fetch', '-q', 'origin');
      return git('rev-parse', 'HEAD');
    };

    // The plane: each candidate's hold, answered from its day's script; every read is logged.
    let clock = start;
    const dayOf = new Map<string, number>();
    const reads: { day: number; id: string; at: number; answer: Answer }[] = [];
    const read = async (path: string) => {
      const [, sha = '', id = ''] = /^validation\/import\/([a-f0-9]{40})\?candidate=(.+)$/.exec(path) ?? [];
      const n = dayOf.get(sha);
      assert.ok(n !== undefined, `the hold read names a candidate head: ${path}`);
      const script = holdScripts[n - 1], answer = script[Math.min(reads.filter(entry => entry.day === n).length, script.length - 1)];
      reads.push({ day: n, id: decodeURIComponent(id), at: clock, answer });
      if (answer === 'unread') throw Object.assign(new Error('the plane is unavailable'), { status: 503 });
      if (answer === 'absent') throw Object.assign(new Error('no import route'), { status: 404 });
      return { hold: answer === 'held' ? { held: true, cases: [{ id: 'checkout', verdict: 'failed', runId: `run-${n}` }] } : { held: false, cases: [] } };
    };
    const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
      repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { candidates: { everyMerges: 1, idleMinutes: 15 }, mergeWriter: { deployKeyFile: join('/keys', 'deploy'), retrials: 2 } } });
    const ports = () => localReleasePorts(config, checkout, defaultChildRun, { base: managed, record: async () => ({}), environment: { ...process.env, GRAPHYARD_UAT_URL: 'https://uat.example.test' }, now: () => clock,
      plane: { goals: async () => [], stage: async () => undefined, read }, validation })!;
    const validated: string[] = [];
    // Only UAT itself is simulated, behind the ports' recorded-verdict check: the cut, the promotion and its hold read are the production ports.
    const validation = {
      uat: async (id: string) => ({ sha: (await readLedgerAsync(asyncGit)).candidates.find(entry => entry.id === id)!.sha }),
      validate: async (id: string) => {
        const entry = (await readLedgerAsync(asyncGit)).candidates.find(candidate => candidate.id === id)!;
        validated.push(id);
        const record = { id, sha: entry.sha, result: 'passed' as const, deployedSha: entry.sha, at: new Date(clock).toISOString(), suites: [{ name: 'e2e', passed: true, detail: 'ok' }], followUp: null };
        await writeRecordAsync(asyncGit, `${uatTagPrefix}${id}`, entry.sha, record, true);
        return { record, followUp: null };
      },
    };

    let state = null as Awaited<ReturnType<typeof settleLocalPromotion>>['state'] | null;
    const candidateOf = new Map<number, string>();
    for (let n = 1; n <= holdScripts.length; n += 1) {
      clock = start + n * day;
      const tip = await merge(n);
      dayOf.set(tip, n);
      // Six simulated hours of cycles: past the UAT window, so a hold that never releases stops being read.
      for (let at = clock; at < start + n * day + 6 * 3_600_000; at += soakStep) {
        clock = at;
        const local = ports();
        const ledgerRead = { ledger: async () => { const ledger = await readLedgerAsync(asyncGit); return { mainSha: tip, promotedSha: ledger.production[0]?.sha ?? null, promotedAt: null, behind: null,
          candidates: ledger.candidates.map(entry => ({ id: entry.id, sha: entry.sha, cutAt: entry.cutAt, prs: entry.prs ?? entry.items.length, queued: entry.queued ?? 0 })) }; },
          runs: async () => [], dispatch: async () => { throw new Error('no dispatch in control-plane mode'); }, local };
        const result = await settleLocalPromotion(state, ledgerRead, { now: clock, everyMinutes: 10, intervalMs: 120_000, frozen: null, watchedTip: tip });
        assert.equal(result.failure, null, `day ${n} at ${new Date(clock).toISOString()}: ${result.state.reason ?? ''}`);
        state = result.state;
        assert.equal(state.inFlight, false, `day ${n}: every cycle settles its candidate`);
      }
      const ledger = await readLedgerAsync(asyncGit);
      candidateOf.set(n, ledger.candidates.find(entry => entry.sha === tip)!.id);
    }

    const ledger = await readLedgerAsync(asyncGit);
    assert.equal(ledger.candidates.length, holdScripts.length, 'one candidate was cut a day, and a retry never cut another');
    assert.deepEqual([...validated].sort(), [...candidateOf.values()].sort(), 'each candidate ran UAT exactly once; a retry never reran it');
    const promoted = ledger.production.map(record => record.id);
    assert.equal(new Set(promoted).size, promoted.length, 'no candidate was recorded in production twice');
    const expected = [1, 2, 3, 4, 6].map(n => candidateOf.get(n)!);
    assert.deepEqual([...promoted].sort(), expected.sort(), 'every released candidate was promoted, and the one held for good was not');
    for (const [n, script] of holdScripts.entries()) {
      const mine = reads.filter(entry => entry.day === n + 1), id = candidateOf.get(n + 1)!;
      assert.ok(mine.every(entry => entry.id === id), `day ${n + 1}: the hold is read for that candidate only`);
      if (n + 1 === 5) {
        // Held for good: read once an interval, never past the UAT window, and never promoted.
        assert.ok(mine.length >= 2 && mine.length <= uatValidationWindowMs / soakStep + 1, `day 5 reads its hold a bounded number of times (${mine.length})`);
        assert.ok(mine.every(entry => entry.at - (start + 5 * day) < uatValidationWindowMs), 'no hold read past the UAT window');
        continue;
      }
      // Every scripted answer was read once, in order, and the candidate was promoted on the first releasing read.
      assert.deepEqual(mine.map(entry => entry.answer), script, `day ${n + 1}: one fresh read a retry until the hold released`);
      for (let i = 1; i < mine.length; i++) assert.ok(mine[i].at - mine[i - 1].at >= soakStep, `day ${n + 1}: retries are one promotion interval apart`);
    }
    // Production ends on the last released candidate, and the held one never reached it.
    assert.equal(git('ls-remote', 'origin', `refs/heads/${productionBranch}`).split(/\s/)[0], ledger.candidates.find(entry => entry.id === candidateOf.get(6))!.sha);
  } finally { await rm(root, { recursive: true, force: true }); }
});
