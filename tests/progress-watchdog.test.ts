import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { progressAttention, progressStallMs, releaseLagMs } from '../src/daemon/liveness.js';
import { emptyDaemonState, writeDaemonState } from '../src/master-daemon.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { promotionStateSchema } from '../src/daemon/state.js';
import { masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1980: the stall watchdog. The loop's only stall measure used to be the per-subject silence
// record, which restarted a subject's wait on every action that succeeded — so a loop that kept
// retrying or re-cutting looked busy for five hours (six failed release candidates on 2026-10-17)
// while nothing moved. progressAttention replaces it with two pure judgements over the snapshot
// and the release reading the cursor already keeps: one line when nothing has progressed, one
// when merges have not reached the running release. Thresholds are module constants, the lines
// carry no fault class (the fault step files nothing for them), and nothing is persisted.
//
// NOW is this file's only clock: every instant below is derived from it and handed to
// progressAttention or the report builder as a parameter, so no wall-clock call runs anywhere in
// this file and no calendar instant is judged against the machine's clock.

const NOW = Date.parse('2026-10-16T06:00:00.000Z');
const minute = 60_000, hour = 60 * minute;
const at = (offsetMinutes: number) => new Date(NOW + offsetMinutes * minute).toISOString();
const sha = (seed: string) => seed.padEnd(40, '0').slice(0, 40);

function item(key: string, overrides: Partial<Work> = {}): Work {
  return {
    id: randomUUID(), key, title: `Item ${key}`, description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Behaviour holds.', proofs: ['unit:behaviour'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/a.ts'], stage: 'build', revision: 1, policyRevision: 1,
    createdAt: at(-8 * 60), updatedAt: at(-30), stageEnteredAt: at(-30), ready: false, epoch: 1,
    lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], ...overrides,
  } as Work;
}
/** A delivered item, merged `mergedAgo` minutes before NOW. */
const delivered = (key: string, mergedAgo: number) => item(key, { stage: 'done', delivery: { mergeSha: sha(key), authorizationRevision: 1, mergedAt: at(-mergedAgo) } });
/** The release reading the cursor keeps: promoted `promotedAgo` minutes before NOW. */
const release = (promotedAgo: number | null) => promotedAgo === null ? null
  : promotionStateSchema.parse({ checkedAt: at(-1), mainSha: sha('main'), promotedSha: sha('release'), promotedAt: promotedAgo === null ? null : at(-promotedAgo), behind: 0, inFlight: false, runsReadAt: null, dispatchedAt: null, lastDispatchAt: null, nextDueAt: null, reason: null });

test('unit:progress-watchdog-no-progress — one line names the progress instant and the open item that has waited longest in its stage when every stage entry, merge and promotion is over an hour old; any newer instant, or no open item, is none', () => {
  // Every progress instant is hours old and an item sits open: one line, naming the oldest.
  // The newest progress instant is GY-2's stage entry, 125 minutes back — merges and the release
  // are older — so the line names that instant, and GY-3 as the longest waiter.
  const work = [delivered('GY-1', 200), item('GY-2', { stageEnteredAt: at(-125) }), item('GY-3', { stage: 'merge', stageEnteredAt: at(-200) })];
  const lines = progressAttention(work, release(180), NOW);
  assert.equal(lines.length, 1, lines.map(line => line.text).join('\n'));
  assert.equal(lines[0].subject, 'GY-3', 'the open item that has waited longest in its stage is named');
  assert.match(lines[0].text, new RegExp(`^Nothing has progressed for 125 minutes \\(since ${at(-125).replace(/[.]/g, '\\.')}\\): GY-3 has been in merge since ${at(-200).replace(/[.]/g, '\\.')}$`), 'the progress instant and the oldest item’s own stage entry are both named');
  assert.equal(lines[0].role, 'master');
  assert.equal(lines[0].human, false);

  // A stage moved ten minutes ago: progress happened, so no line, whatever else is old.
  const moved = [item('GY-2', { stageEnteredAt: at(-10) }), item('GY-3', { stage: 'merge', stageEnteredAt: at(-200) })];
  assert.deepEqual(progressAttention(moved, release(180), NOW), []);

  // A delivery merged ten minutes ago is progress too, even with every stage entry and the release old.
  const merged = [delivered('GY-4', 10), item('GY-3', { stage: 'merge', stageEnteredAt: at(-200) })];
  assert.deepEqual(progressAttention(merged, release(180), NOW), []);

  // A release that moved ten minutes ago is progress as well.
  assert.deepEqual(progressAttention([item('GY-3', { stageEnteredAt: at(-200) })], release(10), NOW), []);

  // Exactly on the bound is not past it: only more than sixty minutes is a stall.
  assert.deepEqual(progressAttention([item('GY-3', { stageEnteredAt: at(-60) })], release(60), NOW), [], 'sixty minutes on the dot is not a stall');
  assert.equal(progressAttention([item('GY-3', { stageEnteredAt: at(-61) })], release(61), NOW).length, 1, 'a minute past the bound is');

  // Nothing open — every item done or in backlog — is no stall, however old everything is.
  const closed = [delivered('GY-1', 200), item('GY-9', { stage: 'backlog', stageEnteredAt: at(-300) })];
  assert.deepEqual(progressAttention(closed, release(180), NOW), []);

  // The bound is the module constant, not a setting.
  assert.equal(progressStallMs, 60 * minute);
});

test('unit:progress-watchdog-release-lag — one line counts the merges past the release and names the oldest when that merge is over ninety minutes old; every merge behind the release, or under the bound, is none', () => {
  // Two merges sit past a release that last moved four hours ago; the oldest is two hours old.
  const work = [delivered('GY-1', 150), delivered('GY-2', 120), delivered('GY-0', 300)];
  const lines = progressAttention(work, release(240), NOW);
  assert.equal(lines.length, 1, lines.map(line => line.text).join('\n'));
  assert.equal(lines[0].subject, 'release');
  assert.match(lines[0].text, /^2 merged change\(s\) have not reached the running release for 150 minutes; the oldest is GY-1 merged at /);
  assert.match(lines[0].text, new RegExp(`merged at ${at(-150).replace(/[.]/g, '\\.')}; the release last moved at ${at(-240).replace(/[.]/g, '\\.')}$`));

  // A merge exactly at the promotion instant predates the release, and everything older with it: no line.
  const behind = [delivered('GY-1', 240), delivered('GY-2', 300)];
  assert.deepEqual(progressAttention(behind, release(240), NOW), [], 'every merged item predates promotedAt');

  // Under the bound — the oldest unreleased merge is ninety minutes young — is the promotion window, not lag.
  assert.deepEqual(progressAttention([delivered('GY-1', 89)], release(240), NOW), []);
  assert.equal(progressAttention([delivered('GY-1', 91)], release(240), NOW).length, 1, 'a minute past the bound is');
  // A merge newer than the release but younger than the bound holds the line off even with older
  // merges beside it: only the unreleased ones count, and the oldest of those is the one judged.
  assert.deepEqual(progressAttention([delivered('GY-0', 300), delivered('GY-2', 30)], release(240), NOW).length, 0, 'the oldest unreleased merge is 30 minutes old: no lag yet');
  assert.equal(progressAttention([delivered('GY-0', 300), delivered('GY-2', 91)], release(240), NOW).length, 1, 'the same shape a minute past the bound is lag');

  // No release reading at all: every merged item is unreleased, and the line says so.
  const linesWithout = progressAttention([delivered('GY-1', 150), delivered('GY-2', 300), item('GY-3')], null, NOW);
  assert.equal(linesWithout.length, 1, linesWithout.map(line => line.text).join('\n'));
  assert.match(linesWithout[0].text, /^2 merged change\(s\) have not reached the running release for 300 minutes; the oldest is GY-2 merged at /);
  assert.match(linesWithout[0].text, /; no release has been observed$/);

  // Nothing delivered, or nothing merged past the bound: no line, with or without a release.
  assert.deepEqual(progressAttention([item('GY-3')], release(240), NOW), []);
  assert.deepEqual(progressAttention([delivered('GY-1', 150)], release(120), NOW), []);

  // The bound is the module constant, not a setting.
  assert.equal(releaseLagMs, 90 * minute);

  // Neither watchdog line carries a fault class: the fault step files and counts nothing for them.
  for (const line of [...progressAttention([item('GY-3', { stageEnteredAt: at(-200) })], release(240), NOW), ...progressAttention([delivered('GY-1', 150)], release(240), NOW)]) {
    assert.equal(line.kind, undefined);
    assert.equal(line.faultClass, undefined);
  }
});

test('unit:progress-watchdog-master-status — master status lists both watchdog lines in its loop attention, ahead of the work, each without a fault class', async () => {
  const directory = await temporaryDirectory('progress-watchdog');
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const root = await temporaryDirectory('progress-watchdog-root');
  execFileSync('git', ['init', '-q', root]);
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), repository: 'owner/project',
    baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  // The cursor keeps a release that last moved four hours ago; the snapshot holds an item whose
  // stage has not moved for three hours and a delivery merged two hours ago, past the release.
  const cursor = emptyDaemonState(master);
  cursor.promotion = release(240);
  await writeDaemonState(master, cursor);
  const work = [item('GY-2', { stageEnteredAt: at(-180) }), delivered('GY-1', 120)];
  const masterApi = async (path: string) => path === 'work-snapshot' ? { work, now: new Date(NOW).toISOString() } : { decisions: [] };
  const status = await masterStatusReport(root, master, masterApi, { actor: { id: 'coordinator-1' } }, { commit: null }, { now: () => NOW }) as { attentionItems: { subject: string; text: string; kind?: string; faultClass?: string }[] };
  const stall = status.attentionItems.findIndex(line => /^Nothing has progressed for \d+ minutes \(since /.test(line.text));
  const lag = status.attentionItems.findIndex(line => /^1 merged change\(s\) have not reached the running release for /.test(line.text));
  assert.ok(stall >= 0, `the no-progress line is listed: ${status.attentionItems.slice(0, 6).map(line => line.text).join(' | ')}`);
  assert.ok(lag >= 0, `the release-lag line is listed: ${status.attentionItems.slice(0, 6).map(line => line.text).join(' | ')}`);
  assert.match(status.attentionItems[stall].text, /: GY-2 has been in build since /);
  assert.match(status.attentionItems[lag].text, /the oldest is GY-1 merged at /);
  assert.match(status.attentionItems[lag].text, /; the release last moved at /);
  // Both ride the loop attention, ahead of every work item. The builder sets no kind, so the
  // fault step files nothing for them; the report's own blanket classification (GY-173) stamps
  // every kind-less line unclassified for display, exactly as the standing-stall lines already are.
  assert.ok(stall < 4 && lag < 4, `both lines sit in the report's loop attention (stall ${stall}, lag ${lag})`);
  assert.equal(status.attentionItems[stall].faultClass, 'unclassified');
  assert.equal(status.attentionItems[lag].faultClass, 'unclassified');
});
