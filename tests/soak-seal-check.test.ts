import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cutAsync, gitIn, writeRecord, type ReleaseCandidate } from '../src/release-candidate.js';
import { sealAuthority, sealCheckRecord, sealCheckTag, sealRefusalAttention } from '../src/validation-import.js';
import { defaultPromoteEveryMinutes, promotionCandidatesListed, promotionCycle, promotionReads, type PromotionReads } from '../src/daemon/deployment.js';
import { emptyDaemonState, readDaemonState, writeDaemonState, type PromotionState } from '../src/daemon/state.js';
import { masterConfigSchema } from '../src/master.js';
import { defaultChildRun } from '../src/child-runner.js';
import type { Principal } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1882: the seal check over simulated days. A release candidate is cut every six hours on a real
 * git origin; the uat imports job checks the newest one's credential every cycle (so one candidate
 * gathers far more checks than the old global twenty-record window held), and an explicitly named
 * older candidate is re-checked now and then, as a retried promotion would. The uat credential holds
 * the release-filing identity, then a reader token, then a revoked one, and is repaired after each.
 * Every cycle the loop's real promotion step (promotionCycle over the real promotionReads ledger
 * read, or with promotion off its seal-check read alone) records its state on the real cursor (writeDaemonState), and master status's attention is
 * read back from that cursor (readDaemonState, sealRefusalAttention).
 *
 * Invariants: master status raises exactly one item while the newest check across the listed
 * candidates, as of the loop's last ledger read, was refused, and none otherwise — so it clears once
 * a later check passes; an older candidate's later refusal surfaces however many checks a newer one
 * gathered; each ledger read makes a bounded number of git calls whatever the number of checks; the
 * cursor lists at most promotionCandidatesListed candidates and stays bounded. Instants are epoch
 * milliseconds from a fixed origin, never a wall-clock reading.
 */

const minute = 60_000, hour = 60 * minute, t0 = 1_760_000_000_000, intervalMs = 10 * minute, days = 3, cutEveryMs = 6 * hour;
const releaseFiler: Principal = { id: 'graphyard-release-follow-up', role: 'operator-agent' };
const reader: Principal = { id: 'stale-release-token', role: 'reader' };
/** The uat credential at a moment: null is a token the plane no longer accepts (401). */
const credentialAt = (into: number): Principal | null =>
  into >= 10 * hour && into < 16 * hour ? reader
    : into >= 50 * hour && into < 53 * hour ? null
      // A wrong-role token stored only while an older candidate's promotion is retried, after the newest passed many times.
      : into >= 40 * hour + 30 * minute && into < 41 * hour ? reader
        : releaseFiler;
const answerOf = (credential: Principal | null) => credential ? sealAuthority(credential) : { mayseal: false as const, role: 'unauthenticated', needed: ['admin', 'operator-agent'] };

const scratches: string[] = [];
after(async () => { for (const scratch of scratches) await rm(scratch, { recursive: true, force: true }); });

test('soak:seal-check-attention — over three simulated days of cuts, repeated checks and credential refusal and repair, master status raises one item exactly while the newest check is refused, from bounded reads and a bounded cursor', async () => {
  const { ledgerReads, sealReads } = await soak(defaultPromoteEveryMinutes);
  assert.ok(ledgerReads >= days * 24 * hour / (30 * minute), `the ledger is read throughout (${ledgerReads})`);
  assert.equal(sealReads, 0, 'the ledger carries the seal checks while the loop promotes');
});

test('soak:seal-check-attention — with loop promotion off (run.promoteEveryMinutes 0), the seal checks workflow-run promotions record still raise and clear the item, from bounded reads that never touch the ledger or GitHub', async () => {
  const { ledgerReads, sealReads } = await soak(0);
  assert.equal(ledgerReads, 0, 'promotion that is off reads no ledger');
  assert.ok(sealReads >= days * 24 * hour / (30 * minute), `the seal checks are read throughout (${sealReads})`);
});

async function soak(everyMinutes: number) {
  const scratch = await temporaryDirectory('gy-1882-soak');
  scratches.push(scratch);
  const origin = join(scratch, 'origin.git'), work = join(scratch, 'work'), root = join(scratch, 'loop');
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  sh(scratch, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(scratch, 'clone', '-q', origin, work);
  for (const [key, value] of [['user.name', 'test'], ['user.email', 'test@example.test'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) sh(work, 'config', key, value);
  sh(work, 'commit', '-q', '--allow-empty', '-m', 'initial');
  sh(work, 'push', '-q', 'origin', 'HEAD:main');
  sh(scratch, 'clone', '-q', origin, root);
  const git = gitIn(work), asyncGit = async (args: string[]) => git(args);

  const credentials = await temporaryDirectory('credentials', scratch);
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard-soak.example', credentialFile: `${credentials}/coordinator.token`, cliPath: '/outside/graphyard.mjs',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'soak-host', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });

  // Every check the uat imports job made, as the ledger holds them; the truth master status must show is derived from these alone.
  const candidates: ReleaseCandidate[] = [];
  const checks: { id: string; at: number; mayseal: boolean }[] = [];
  const refusedNow = () => {
    const listed = new Set([...candidates].sort((a, b) => b.id.localeCompare(a.id)).slice(0, promotionCandidatesListed).map(candidate => candidate.id));
    const newest = checks.filter(check => listed.has(check.id)).reduce<(typeof checks)[number] | null>((best, check) => !best || check.at >= best.at ? check : best, null);
    return newest ? !newest.mayseal : false;
  };
  const check = (candidate: ReleaseCandidate, now: number) => {
    const answer = answerOf(credentialAt(now - t0));
    const record = sealCheckRecord(candidate, answer, new Date(now));
    writeRecord(git, sealCheckTag(record), record.sha, record, true);
    checks.push({ id: candidate.id, at: now, mayseal: answer.mayseal });
  };

  let gitCalls = 0, maxLedgerCalls = 0, ledgerReads = 0, sealReads = 0, expected = false;
  const counted = (async (command: string, args: string[], options?: any) => { if (command === 'git') gitCalls++; return defaultChildRun(command, args, options); }) as typeof defaultChildRun;
  const real = promotionReads(config, root, counted, true, false)!;
  const reads: PromotionReads = {
    ledger: async () => {
      const before = gitCalls, read = await real.ledger();
      maxLedgerCalls = Math.max(maxLedgerCalls, gitCalls - before); ledgerReads++;
      expected = refusedNow();
      return read;
    },
    sealChecks: async () => {
      const before = gitCalls, read = await real.sealChecks!();
      maxLedgerCalls = Math.max(maxLedgerCalls, gitCalls - before); sealReads++;
      expected = refusedNow();
      return read;
    },
    runs: async () => { assert.ok(everyMinutes > 0, 'promotion that is off asks GitHub nothing'); return []; },
    dispatch: async () => { assert.ok(everyMinutes > 0, 'promotion that is off dispatches nothing'); },
  };

  let promotion: PromotionState | null = null, raised = 0, cleared = 0, olderSurfaced = false, maxCursorBytes = 0;
  const violations: string[] = [];
  let previous = false;
  for (let now = t0; now <= t0 + days * 24 * hour; now += intervalMs) {
    const into = now - t0;
    if (into % cutEveryMs === hour % cutEveryMs || !candidates.length) {
      sh(work, 'commit', '-q', '--allow-empty', '-m', `merge at +${into / minute} min`);
      sh(work, 'push', '-q', 'origin', 'HEAD:main');
      const result = await cutAsync(asyncGit, { base: 'main', trigger: 'schedule', now: new Date(now), push: true });
      assert.ok(result.cut, `a candidate is cut at +${into / minute} min`);
      candidates.push(result.candidate);
    }
    // The newest candidate's imports job runs every cycle but while an older promotion is retried on day two; the third-newest is retried twice an hour then.
    const newest = candidates.at(-1)!;
    if (into < 40 * hour + 30 * minute || into >= 41 * hour + 10 * minute) check(newest, now);
    const older = candidates.at(-3);
    if (older && into >= 36 * hour && into < 44 * hour && into % (30 * minute) === 0) check(older, now + 1);

    promotion = (await promotionCycle(promotion, reads, { now: now + 2, everyMinutes, intervalMs })).state;
    await writeDaemonState(config, { ...emptyDaemonState(config), promotion });
    const cursor = await readDaemonState(root, config);
    const items = sealRefusalAttention(cursor.promotion, config.repository);
    const at = `+${into / minute} min`;
    if (items.length > 1) violations.push(`${at}: ${items.length} seal attention items`);
    if ((items.length === 1) !== expected) violations.push(`${at}: ${items.length} item(s) while the newest check as last read was ${expected ? 'refused' : 'allowed'}`);
    if (items.length && !previous) raised++;
    if (!items.length && previous) cleared++;
    if (items.length && older && into >= 40 * hour && into < 41 * hour && items[0].text.includes(`candidate ${older.id} `)) olderSurfaced = true;
    previous = items.length > 0;
    if (Math.max(cursor.promotion?.candidates?.length ?? 0, cursor.promotion?.sealChecks?.length ?? 0) > promotionCandidatesListed) violations.push(`${at}: the cursor lists more than ${promotionCandidatesListed} candidates`);
    maxCursorBytes = Math.max(maxCursorBytes, JSON.stringify(cursor.promotion).length);
  }

  assert.deepEqual(violations, []);
  assert.ok(checks.length > 4 * promotionCandidatesListed * 4, `the newest candidate gathers many more checks than the old global window held (${checks.length})`);
  assert.ok(olderSurfaced, 'an older candidate refused after a newer one passed dozens of times is the item master status raises');
  assert.equal(raised, 3, 'one item for each refusal: the reader token, the retried older candidate and the revoked token');
  assert.equal(cleared, 3, 'and each clears once a later check passes');
  assert.ok(maxLedgerCalls <= 6 + 2 * promotionCandidatesListed, `a ledger or seal-check read makes a bounded number of git calls whatever the checks (${maxLedgerCalls})`);
  assert.ok(maxCursorBytes < 8_000, `the cursor's promotion state stays bounded (${maxCursorBytes} bytes)`);
  return { ledgerReads, sealReads };
}
