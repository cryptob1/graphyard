import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyReworkReason, outsideItemReworkCauses, recentDelivered, reworkRoundsByCause, summarizeReworkSplit, type ReworkRound } from '../src/flow-analytics.js';
import type { Work } from '../src/model.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, writeDaemonState } from '../src/master-daemon.js';
// @ts-expect-error Dependency-free report script.
import { attributeRounds, fileFixItem, filingPayload, findFixItem, parseArguments, render } from '../scripts/rework-causes.mjs';

// GY-643: rework rounds classified by cause. Each test is named for the proof it produces —
// unit:rework-round-causes-classified (AC-1) and unit:rework-rounds-split-by-cause (AC-2).

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);

// A fixture ledger in the shape the live control plane serves: one delivered item per row of the
// population, each `rework` row carrying the reason text the control plane recorded when it
// returned a submitted candidate to a worker. The texts mirror the markers real rounds carry.
const id = (key: string) => `00000000-0000-4000-8000-${key.padStart(12, '0')}`;
const A = id('a00000000001'), B = id('b00000000001'), C = id('c00000000001'), D = id('d00000000001');
const submittedAt = '2026-09-26T08:00:00.000Z';
const deliveredItem = (id: string, key: string, rounds: number) => ({
  id, key, title: `Fixture ${key}`, description: '', type: 'feature', priority: 1, dependencies: [], plannedFiles: ['src/x.ts'],
  stage: 'done', createdAt: '2026-09-26T07:00:00.000Z', updatedAt: '2026-09-26T10:00:00.000Z', stageEnteredAt: '2026-09-26T10:00:00.000Z',
  epoch: rounds + 1, gates: [], violations: [], workspaces: [], sessions: [], policy: { checks: ['test', 'typecheck'], review: true },
  submission: { epoch: 1, pr: 400 },
  delivery: { pr: 400, mergeSha: sha40(key), mergedAt: '2026-09-26T10:00:00.000Z', mergedAtRepository: '2026-09-26T10:00:00.000Z' },
  pipeline: { attempts: [], submittedAt, resubmittedAt: submittedAt, reworkRounds: rounds, interventions: { blocked: 0, requirements: 0 } },
});
const fixtureWork = [
  { ...deliveredItem(A, 'GY-901', 2), pipeline: { attempts: [], submittedAt: '2026-09-26T06:00:00.000Z', resubmittedAt: submittedAt, reworkRounds: 2, interventions: { blocked: 0, requirements: 0 } } },
  deliveredItem(B, 'GY-902', 2),
  deliveredItem(C, 'GY-903', 1),
  { ...deliveredItem(D, 'GY-904', 0), pipeline: { attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } } },
];
const row = (seq: number, workId: string, at: string, reason: string) => ({ seq: String(seq), work_id: workId, actor: 'graphyard-master', kind: 'rework', created_at: at, details: { reason, previousWorkerStopped: true } });
// Reasons carry the markers real rounds do: the decision text is quoted from the ledger shapes.
const fixtureEvents = [
  // Before the item's first submission: no round, however causal it reads.
  row(10, A, '2026-09-26T05:30:00.000Z', 'GY-901: graphyard-reviewer[bot] requested changes on 1f0f369dd3.'),
  // GY-901 round 1: the base moved under the candidate.
  row(11, A, '2026-09-26T08:10:00.000Z', '[Decided from the GitHub observation taken at 2026-09-26T08:09:00.000Z.] GY-901: GitHub reports that candidate aaa1 conflicts with base branch tip bbb2. Only a sync can resolve it, so the candidate returns to a worker. [decision x, approved: Verified independently.]'),
  // GY-901 round 2: a reviewer verdict on the item's own change.
  row(12, A, '2026-09-26T09:10:00.000Z', '[Decided from the GitHub observation.] GY-901: graphyard-reviewer[bot] requested changes on ccc3. The verdict stands against the current head, so the item returns to a worker. [decision y, approved: blocking finding holds.]'),
  // GY-902 round 1: base breakage — the check fails on a merge of a base main has since fixed.
  row(13, B, '2026-09-26T08:20:00.000Z', 'Base refresh only: the candidate\'s required test check failed on tests main has since fixed (the fixed-date reset). A rerun reuses the old merge and fails again. No change to the item\'s own work is expected. [decision z]'),
  // GY-902 round 2: the docs word budget, reached through a CI failure the approver attributed.
  row(14, B, '2026-09-26T09:20:00.000Z', '[Decided from the GitHub observation.] GY-902: required CI check test failed on candidate ddd4. [decision w, approved: The failure is deterministic, not a flake: unit:docs-word-budget reports README+docs total 12058 words against a 12000 budget.]'),
  // GY-903 round 1: evidence that does not exercise its criterion — the approval is lost.
  row(15, C, '2026-09-26T09:30:00.000Z', '[Decided from the GitHub observation.] GY-903: the producer recorded evidence that does not exercise its criterion on eee5 — unit:sealed: "does not exercise AC-2". [decision v]'),
];
const openItems = [
  { key: 'GY-880', title: 'Fix docs budget churn: pages re-trimmed every round', stage: 'ready' },
  { key: 'GY-870', title: 'Merge queue pushes speculative tips that cost approvals', stage: 'merge' },
  { key: 'GY-860', title: 'Delivered and closed item that must never match', stage: 'done', closure: { kind: 'obsolete' } },
];

test('unit:rework-round-causes-classified — the classifier reads a fixture ledger and the report asserts every round\'s cause, the share of each, and the open fix item each largest cause links to', async () => {
  // The classifier alone: each cause by its recorded marker, first match wins.
  assert.equal(classifyReworkReason('GY-x: GitHub reports that candidate a conflicts with base branch tip b. Only a sync can resolve it.').cause, 'conflict');
  assert.equal(classifyReworkReason('Base refresh only: the required test check failed on tests main has since fixed.').cause, 'base-breakage');
  assert.equal(classifyReworkReason('GY-x: unit:docs-word-budget reports README+docs total 12058 words against a 12000 budget.').cause, 'docs-budget');
  assert.equal(classifyReworkReason('GY-x: the producer recorded evidence that does not exercise its criterion on a.').cause, 'lost-approval-or-proof');
  assert.equal(classifyReworkReason('Launch readiness flake; clear and retry.').cause, 'ci-flake');
  assert.equal(classifyReworkReason('GY-x: graphyard-reviewer[bot] requested changes on a. The verdict stands against the current head.').cause, 'own-change');
  assert.equal(classifyReworkReason('GY-x: required CI check test failed on candidate a, cause not established by the text.').cause, 'other', 'an unattributed round is counted as other, never guessed into a named cause');

  // The report: rounds only at or after the item's first submission, classified and shared.
  const classify = (reason: string) => classifyReworkReason(reason);
  const entries = attributeRounds(fixtureWork, fixtureEvents, classify);
  assert.deepEqual(entries.map((entry: any) => [entry.key, entry.rounds.length, entry.measured]), [['GY-901', 2, true], ['GY-902', 2, true], ['GY-903', 1, true], ['GY-904', 0, false]], 'pre-submission rows are not rounds; an item with no recorded submission is unmeasured, not silent');
  const byCause = reworkRoundsByCause(entries.flatMap((entry: any) => entry.rounds));
  assert.equal(byCause.total, 5);
  assert.deepEqual(byCause.counts, { 'own-change': 1, 'base-breakage': 1, 'conflict': 1, 'docs-budget': 1, 'lost-approval-or-proof': 1, 'ci-flake': 0, 'other': 0 });
  assert.deepEqual(byCause.shares['conflict'], 0.2);
  // The three largest (all tied here, so declaration order) each link to an open fix item or name the filing owed.
  const largest = byCause.largest.filter(entry => entry.count > 0).slice(0, 3).map(entry => entry.cause);
  assert.deepEqual(largest, ['own-change', 'base-breakage', 'conflict']);
  const linked = findFixItem(openItems, 'docs-budget');
  assert.deepEqual(linked, { key: 'GY-880', title: 'Fix docs budget churn: pages re-trimmed every round' }, 'the oldest open item whose title names the cause');
  assert.equal(findFixItem(openItems, 'conflict'), null, 'the delivered GY-860 is closed and never matches; conflict has no open item here');
  const filing = filingPayload('conflict', 'Conflict with the base', 3, 0.2);
  assert.match(filing.title, /[Cc]onflict with the base/);
  assert.equal(filing.criteria[0].proofs[0], 'manual:rework-cause-fix');
  // Filing records a refusal instead of throwing, so a read-only credential still reports.
  const refused = await fileFixItem('https://graphyard.example', 'token', filing, async () => new Response(JSON.stringify({ error: 'Operator permission required' }), { status: 403 }));
  assert.deepEqual(refused, { filed: false, status: 403, reason: 'Operator permission required' });
  const filed = await fileFixItem('https://graphyard.example', 'token', filing, async () => new Response(JSON.stringify({ key: 'GY-901' }), { status: 200 }));
  assert.deepEqual(filed, { filed: true, key: 'GY-901' });

  // Command-line surface: the population bound and the filing opt-out are the only knobs.
  assert.deepEqual(parseArguments(['--items', '50', '--no-file']), { items: 50, record: null, json: false, file: false });
  assert.throws(() => parseArguments(['--items', '0']), /positive integer/);
  assert.throws(() => parseArguments(['--unknown']), /Unknown argument/);
});

test('unit:rework-rounds-split-by-cause — the split excludes causes outside the item\'s own change from the median, master status reports it beside the raw figure, and docs/ states it', async () => {
  // The split itself: raw counts keep every round; the own-change counts drop base breakage,
  // conflict, docs budget, lost approval or proof, and CI flakes.
  const round = (cause: string): ReworkRound => ({ workId: A, key: 'GY-901', seq: '1', at: submittedAt, cause: cause as ReworkRound['cause'], marker: null });
  const split = summarizeReworkSplit([
    { key: 'GY-901', mergedAt: '2026-09-26T10:00:00.000Z', measured: true, rounds: [round('conflict'), round('base-breakage')] },
    { key: 'GY-902', mergedAt: '2026-09-26T10:05:00.000Z', measured: true, rounds: [round('own-change'), round('other')] },
    { key: 'GY-903', mergedAt: '2026-09-26T10:10:00.000Z', measured: true, rounds: [round('ci-flake')] },
  ]);
  assert.deepEqual({ rounds: split.rounds, outsideItem: split.outsideItem, ownChange: split.ownChange }, { rounds: 5, outsideItem: 3, ownChange: 2 });
  assert.deepEqual([split.rawMedian, split.median, split.rawP90, split.p90], [2, 0, 2, 2], 'the raw median is 2; with out-of-item rounds removed it is 0 — the figure a GY-115-style change is measured against');
  assert.equal(split.byCause['own-change'] + split.byCause['other'], split.ownChange);
  assert.equal(split.unmeasured, 0);
  for (const cause of outsideItemReworkCauses) assert.ok(split.shares[cause] !== null, `${cause} is named with its share even when excluded from the median`);
  assert.equal(split.shares['own-change'], 0.2);

  // The population: the last N delivered items by accepted merge, with a read window back to the
  // earliest first submission, so one bounded events read covers every round they hold.
  const recent = recentDelivered(fixtureWork as unknown as Work[], 2);
  assert.deepEqual(recent.items.map(item => item.key), ['GY-903', 'GY-904'], 'ordered by accepted merge instant, last two');
  assert.equal(recent.since, '2026-09-26T08:00:00.000Z', 'the window opens at the earliest first submission in the population, not at the first merge');

  // Master status wiring: the report carries the split under speed.reworkRounds.ownChange,
  // read from the same ledger rows, with the raw figure untouched beside it.
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-rework-causes-'));
  const root = await mkdtemp(join(tmpdir(), 'graphyard-rework-causes-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'c'.repeat(32), { mode: 0o600 });
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  await writeDaemonState(master, emptyDaemonState(master));
  const now = '2026-09-26T12:00:00.000Z';
  const masterApi = async (path: string) => {
    if (path === 'work-snapshot') return { work: fixtureWork, now };
    if (path.startsWith('events?')) {
      const query = new URLSearchParams(path.slice('events?'.length));
      assert.equal(query.get('kind'), 'rework');
      assert.equal(query.get('payload'), 'details');
      return { events: fixtureEvents, page: { hasMore: false, nextCursor: null }, filters: { kinds: ['rework'] } };
    }
    if (path === 'board') throw new Error('not served under test');
    return {};
  };
  try {
    const report = await masterStatusReport(root, master, masterApi, { actor: { id: 'coordinator-1' } }, { commit: null },
      { supervisorHost: { platform: 'linux', temporaryDirectories: [], run: (command: string, args: string[]) => command === 'loginctl' ? '\n' : args[1] === 'is-enabled' ? 'enabled\n' : args[1] === 'is-active' ? 'active\n' : '' } });
    const ownChange = report.speed.reworkRounds as typeof report.speed.reworkRounds & {
      ownChange: { items: number; measured: number; unmeasured: number; rounds: number; median: number; rawMedian: number; eventsComplete: boolean; statement: string | null;
        byCause: Record<string, number>; shares: Record<string, number | null>; largest: { cause: string; count: number; share: number | null }[]; window: { since: string | null; until: string } };
    };
    assert.ok(ownChange.ownChange, 'master status reports the classified rounds');
    const split = ownChange.ownChange;
    assert.deepEqual([split.rounds, split.median, split.rawMedian], [5, 0, 2], 'raw median 2 over three measured items; the own-change median drops to 0 once the base, budget and proof rounds are removed');
    assert.deepEqual(split.byCause, { 'own-change': 1, 'base-breakage': 1, 'conflict': 1, 'docs-budget': 1, 'lost-approval-or-proof': 1, 'ci-flake': 0, 'other': 0 });
    assert.equal(split.eventsComplete, true);
    assert.equal(split.statement, null);
    assert.equal(split.unmeasured, 1, 'GY-904 has no recorded submission and is named, not dropped');
    assert.ok(report.speed.reworkRounds.median !== undefined, 'the raw rework rounds stand beside the split');
    // The rendered report names the split the docs state.
    const text = render({ population: { items: 100, delivered: 4, measured: 3, unmeasured: 1 }, window: split.window, statement: null,
      rounds: 5, ownChange: 2, outsideItem: 3, causes: split.byCause, shares: split.shares,
      largest: split.largest.filter(entry => entry.count > 0).slice(0, 3), reworkRounds: { rawMedian: 2, rawP90: 2, median: 0, p90: 2 }, fix: [] });
    assert.match(text, /own-change median 0/);
    assert.match(text, /outside it/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
