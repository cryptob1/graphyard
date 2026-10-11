import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { readInterventionLedger } from '../src/interventions/ledger.js';
import { ledgerReach, readInterventionReport, windowStart } from '../src/interventions/report.js';
import { interventionDecisionReachMs } from '../src/intervention-exemptions.js';
import { interventionPolicyDefaults } from '../src/model/interventions.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1682 AC-2 (manual:intervention-pattern-within-threshold): the under-threshold reading of a
// truncated ledger read begins where the record the read holds is whole — at the oldest row the
// read retained. The read keeps the newest `limit` rows of the window, and beside them adds the
// requests of the decisions the window settles (withDecisionsBeyondReach), each older than the
// window's oldest row. Review PRRT_kwDOUZby-s6rJ1Ps on PR #1115: telling the added rows from the
// retained ones by kind took every retained `decision.requested` and `decision.approved` row for an
// added one, so a window whose oldest retained rows were ordinary decision rows written inside it
// began its reading later than its record — or now, when it retained only decision rows — and
// understated the peak and the days observed. The read now names the oldest row it retained itself.

let pg: EmbeddedPostgres, store: Store;
const workId = randomUUID();
const hour = 60 * 60_000, day = 24 * hour;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1690;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('intervention-ledger-retained-reach'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('intervention_ledger_retained_reach_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/intervention_ledger_retained_reach_test`); await store.init();
  await store.pool.query('INSERT INTO work_items(id, document) VALUES($1, $2)', [workId, JSON.stringify({ id: workId, key: 'GY-1675', title: 'GY-1675', stage: 'build', epoch: 2, plannedFiles: [] })]);
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

/** One ledger row at an explicit insertion instant, in insertion order, so `seq` follows `created_at` as the ledger's own writes do. */
const write = async (kind: string, at: string, payload: Record<string, unknown> = {}) =>
  Number((await store.pool.query('INSERT INTO events(work_id, actor, kind, payload, created_at) VALUES($1, $2, $3, $4, $5) RETURNING seq', [workId, 'graphyard-master', kind, JSON.stringify(payload), at])).rows[0].seq);
const iso = (ms: number) => new Date(ms).toISOString();

test('manual:intervention-pattern-within-threshold — a truncated read names the oldest row it retained, a decision row written inside the window as much as any other, and never a request it read from beyond the window', async () => {
  const now = Date.now(), since = iso(now - 7 * day), opened = Date.parse(since);
  // Beyond the window and beyond the decisions' own reach: the request of a decision the window settles. Read only because the window holds its settlement.
  await write('decision.requested', iso(opened - 2 * day), { id: 'decision-settled-inside', action: 'rework' });
  // Inside the decisions' reach before the window: a withdrawal the window neither holds nor settles. Retained by the read, dropped by the window (windowOutcomes), still the oldest row the read retained.
  const withdrawnBefore = iso(opened - interventionDecisionReachMs + hour / 2);
  await write('decision.withdrawn', withdrawnBefore, { id: 'decision-withdrawn-before', action: 'scope' });
  // Inside the decisions' reach before the window: the request of a decision the window declines. Retained by the read, kept by the window for the decision it settles.
  const earlyRequest = iso(opened - interventionDecisionReachMs + hour);
  await write('decision.requested', earlyRequest, { id: 'decision-declined-inside', action: 'scope' });
  // The window's own rows, oldest first.
  const inside = [
    ['scope', iso(opened + 12 * hour), { details: { epoch: 2 } }],
    ['decision.requested', iso(opened + day), { id: 'decision-approved-inside', action: 'scope' }],
    ['decision.approved', iso(opened + day + hour), { id: 'decision-approved-inside', action: 'scope' }],
    ['scope', iso(opened + 2 * day), { details: { epoch: 2 } }],
    ['decision.applied', iso(opened + 3 * day), { id: 'decision-settled-inside', action: 'rework' }],
    ['rework', iso(opened + 4 * day), { details: { epoch: 2 } }],
    ['decision.declined', iso(opened + 5 * day), { id: 'decision-declined-inside', action: 'scope' }],
  ] as const;
  for (const [kind, at, payload] of inside) await write(kind, at, payload);
  const at = (index: number) => inside[index][1];

  // Not truncated: the read holds the whole window and the early request, and the reach is the window start.
  const whole = await readInterventionLedger(store.pool, { since, limit: 20 });
  assert.equal(whole.truncated, false);
  assert.deepEqual(whole.rows.map(row => row.kind), ['decision.requested', 'decision.requested', ...inside.map(([kind]) => kind)], 'the settled decision\'s request comes from beyond the window, the declined one\'s from inside the decisions\' reach');
  assert.equal(whole.retainedFrom, withdrawnBefore, 'the oldest retained row is the withdrawal before the window, retained by the read though the window drops it');
  assert.equal(ledgerReach(whole.retainedFrom, whole.truncated, since, iso(now)), since);

  // Cut to the newest six: the oldest retained row is the window's `decision.requested`, written inside it. The reading begins there, not at the later `scope` row.
  const six = await readInterventionLedger(store.pool, { since, limit: 6 });
  assert.equal(six.truncated, true);
  assert.deepEqual(six.rows.map(row => [row.kind, row.at]), [['decision.requested', iso(opened - 2 * day)], ['decision.requested', earlyRequest], ...inside.slice(1).map(([kind, at]) => [kind, at])], 'the requests of both decisions the retained rows settle are read from beyond the retained rows — the early request now among them, cut with the first `scope` row');
  assert.equal(six.retainedFrom, at(1));
  assert.equal(ledgerReach(six.retainedFrom, six.truncated, since, iso(now)), at(1));

  // Cut to the newest five: the oldest retained row is the window's `decision.approved`.
  const five = await readInterventionLedger(store.pool, { since, limit: 5 });
  assert.equal(five.truncated, true);
  assert.equal(five.retainedFrom, at(2));

  // Cut to the newest two: only decision rows are retained, and the added request precedes them. The reading begins at the oldest retained row, not now and not at the added request.
  const two = await readInterventionLedger(store.pool, { since, limit: 2 });
  assert.deepEqual(two.rows.map(row => [row.kind, row.at]), [['decision.requested', earlyRequest], ['rework', at(5)], ['decision.declined', at(6)]], 'the declined decision\'s request is read from beyond the retained rows; the settled one\'s is not, its settlement being cut');
  assert.equal(two.retainedFrom, at(5));
  assert.equal(ledgerReach(two.retainedFrom, two.truncated, since, iso(now)), at(5));
  // Cut to the newest three: the retained rows are a settlement and the two after it, and the settled decision's request is added before them. The reading begins at the settlement, not at the added request.
  const three = await readInterventionLedger(store.pool, { since, limit: 3 });
  assert.deepEqual(three.rows.map(row => [row.kind, row.at]), [['decision.requested', iso(opened - 2 * day)], ['decision.requested', earlyRequest], ['decision.applied', at(4)], ['rework', at(5)], ['decision.declined', at(6)]]);
  assert.equal(three.retainedFrom, at(4));
  assert.equal(ledgerReach(three.retainedFrom, three.truncated, since, iso(now)), at(4));

  // Cut to the newest seven: the oldest retained row is the first `scope` row; the early request, cut, is read back only for the decision the window declines.
  const seven = await readInterventionLedger(store.pool, { since, limit: 7 });
  assert.equal(seven.truncated, true);
  assert.deepEqual(seven.rows.map(row => row.kind), ['decision.requested', 'decision.requested', ...inside.map(([kind]) => kind)]);
  assert.equal(seven.retainedFrom, at(0));
  assert.equal(ledgerReach(seven.retainedFrom, seven.truncated, since, iso(now)), at(0));
  // Cut to the newest eight: the oldest retained row is the early request, before the window; the reach never precedes the read.
  const eight = await readInterventionLedger(store.pool, { since, limit: 8 });
  assert.equal(eight.truncated, true, 'the withdrawal before the window was cut');
  assert.equal(eight.retainedFrom, earlyRequest);
  assert.equal(ledgerReach(eight.retainedFrom, eight.truncated, since, iso(now)), since);
  // A read that retained nothing names no row; the reading begins now.
  const none = await readInterventionLedger(store.pool, { since, limit: 0 });
  assert.equal(none.truncated, true); assert.equal(none.retainedFrom, null);
  assert.equal(ledgerReach(none.retainedFrom, none.truncated, since, iso(now)), iso(now));
});

test('manual:intervention-pattern-within-threshold — the report\'s `ledger.reach`, where every row\'s under-threshold reading begins, is the oldest retained row of a truncated read', async () => {
  const report = await readInterventionReport(store, interventionPolicyDefaults, { days: 7, limit: 6 });
  const since = windowStart(report.window.to, 7);
  assert.equal(report.ledger.truncated, true);
  assert.equal(report.ledger.since, since);
  const read = await readInterventionLedger(store.reportPool, { since, limit: 6 });
  assert.equal(report.ledger.reach, read.retainedFrom);
  assert.equal(read.rows.find(row => row.at === read.retainedFrom)?.kind, 'decision.requested', 'the oldest retained row is a decision row written inside the window');
  assert.ok(report.ledger.reach > since, 'the reach lies inside the window');
  for (const row of report.patterns) assert.equal(row.underThreshold.reach, report.ledger.reach);
  const untruncated = await readInterventionReport(store, interventionPolicyDefaults, { days: 7 });
  assert.equal(untruncated.ledger.truncated, false); assert.equal(untruncated.ledger.reach, untruncated.ledger.since);
  for (const row of untruncated.patterns) assert.equal(row.underThreshold.reach, untruncated.ledger.since);
});

test('manual:intervention-pattern-within-threshold — the reach is the cutoff row\'s insertion instant, never its document\'s earlier `updatedAt`, and steps past an instant the cut shares (rows one transaction wrote, cut between)', async () => {
  // Codex on PR #1115 (src/interventions/ledger.ts, head 185ae9594c55): a reach moved back to a retained row's own
  // earlier instant held rows the cut omitted, inserted before the cutoff; the record was not whole from it.
  const now = Date.now(), since = iso(now - 7 * day);
  // A row written with its document, whose `updatedAt` precedes the insertion by five seconds: the row's own instant.
  const documented = iso(now - hour), documentedAt = iso(now - hour - 5_000);
  await write('scope', documented, { work: { id: workId, key: 'GY-1675', title: 'GY-1675', stage: 'build', epoch: 2, plannedFiles: [], updatedAt: documentedAt } });
  // Two rows inserted in one instant, as one transaction's writes share `created_at`.
  const shared = iso(now - hour / 2);
  await write('scope', shared, { details: { epoch: 2 } });
  await write('scope', shared, { details: { epoch: 2 } });
  // Cut between the two: the retained one's instant is the omitted one's too, and no retained row follows it — the read names no instant, and the reading begins now.
  const between = await readInterventionLedger(store.pool, { since, limit: 1 });
  assert.equal(between.truncated, true); assert.deepEqual(between.rows.map(row => row.at), [shared]);
  assert.equal(between.retainedFrom, null);
  assert.equal(ledgerReach(between.retainedFrom, between.truncated, since, iso(now)), iso(now));
  const after = iso(now - 10 * 60_000);
  await write('rework', after, { details: { epoch: 2 } });
  // Cut between the two again: the reach steps to the first retained row inserted after the shared instant.
  const stepped = await readInterventionLedger(store.pool, { since, limit: 2 });
  assert.deepEqual(stepped.rows.map(row => row.at), [shared, after]);
  assert.equal(stepped.retainedFrom, after);
  // Cut before both: the newest omitted row precedes the shared instant, which is the reach.
  const pair = await readInterventionLedger(store.pool, { since, limit: 3 });
  assert.deepEqual(pair.rows.map(row => row.at), [shared, shared, after]);
  assert.equal(pair.retainedFrom, shared);
  // Cut at the documented row: the reach is its insertion instant; its own instant, five seconds earlier, lies before the reach, as the rows the cut omitted may.
  const documentedCut = await readInterventionLedger(store.pool, { since, limit: 4 });
  assert.equal(documentedCut.truncated, true);
  assert.deepEqual(documentedCut.rows.map(row => row.at), [documentedAt, shared, shared, after], 'the row keeps its document\'s instant');
  assert.equal(documentedCut.retainedFrom, documented);
  assert.ok(documentedCut.rows[0].at < documentedCut.retainedFrom!, 'the reach never moves back to a retained row\'s earlier own instant');
  assert.equal(ledgerReach(documentedCut.retainedFrom, documentedCut.truncated, since, iso(now)), documented);
});
