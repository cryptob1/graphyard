import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeInterventionReport, detectPatterns, foldInterventions, type InterventionLedgerRow } from '../src/interventions.js';
import { exemption } from '../src/intervention-exemptions.js';
import { interventionSummary } from '../src/cli/intervention-status.js';
import { handFiledPattern, type Intervention, type PatternRow } from '../src/model/interventions.js';
import { groundedWideningReason } from '../src/model/scope-provenance.js';
import { scopeBlockedBudgetMs, scopeRefusalBlocker } from '../src/model/scope.js';
import type { Work } from '../src/model.js';
import InterventionsPage from '../web/pages/interventions.js';
import type { Dashboard } from '../web/pages/dashboard.js';

// GY-1682 names this file for its proofs: manual:pattern-item-owns-scope-widening and
// manual:intervention-pattern-within-threshold.
//
// On 2026-10-10 at 23:16:36Z master status raised an intervention-pattern fault: 21 scope widenings
// at the build stage in 7 days, past the threshold of 3, no item standing, "the server opens one
// within a minute". At 01:10:49Z on 2026-10-11 the same report read 20, `crossed: false`, no item,
// and the master filed GY-1682 by hand as a scan that had failed its promise. It had not. Of the 20:
//
//   - 14 are linked to GY-1388 (delivered 2026-10-07T05:46:02Z): a master widened by hand an ask the
//     rule had refused and the loop was already putting to the independent approver; GY-1388 made the
//     control plane refuse that hand widening while the approver holds the ask.
//   - 4 are linked to GY-1568 (delivered 2026-10-09T07:04:46Z): asks between GY-1388's detection and
//     its landing, and one an attempt carried past its end, which the loop withdrew as moved past;
//     GY-1568 keeps the carried ask the approver's.
//   - GY-1675's requirements#2489179 (23:12:05Z): the approver had approved the exact path
//     src/server/control-plane-observation.ts, but the engine collapsed a new file's exact path to
//     src/ under the live lease, so the master applied it by hand once the lease ended. GY-1676
//     (delivered 2026-10-10, 8eb4c47cfd75) removed the collapse. GY-1675 then carried 3 rework
//     rounds; that cost is counted here against GY-1682, the item standing for the unlinked pair.
//   - GY-1617's requirements#2470341 (2026-10-09T23:48:58Z): the master completed the item's plan
//     with the existing tests/orphan-supervisor.test.ts 8 seconds after releasing it and 1.7 seconds
//     after the first claim, so the fold read a planning step as a widening of a started attempt. No
//     ask preceded it and no worker had a workspace yet; it is recorded here against GY-1682.
//
// The two unlinked instances are under the threshold. The 21st, counted only at 23:13, was GY-1675's
// epoch-2 scope request: asked at 23:12:58Z, refused by the rule at 23:13:06Z, widened by the loop
// on its audited grounds at 23:13:27Z. For those 21 seconds the fold reported the refused ask as a
// waiting scope widening, so whoever read the report then saw the pattern crossed, while the
// minutely scan did not and opened nothing — two readers of one fold disagreeing about one fact.
//
// Removed here: a live attempt's refused ask the loop will still settle inside the bound it promises
// (scopeBlockedBudgetMs) is the loop's, judged as the fault pass judges it (standingScopeRequest);
// the report's pattern row names the count the threshold judges (`unlinked`), the items that own
// every counted instance (`accounted`) and the instances themselves (`instances`); and GY-1682 — a
// fault-class item the master filed by hand, which the scan's `origin.pattern` lookup never saw, so
// the row named no owner and a third unlinked instance would have opened a second item beside it —
// stands for the pair as the record holds it (handFiledPattern), and the board renders the fold.

const uuid = (name: string) => { const hex = createHash('sha256').update(name).digest('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`; };
const policy = { threshold: 3, windowDays: 7 };
const operator = 'graphyard-master-graphyard-operator', worker = 'graphyard-claude-1';
const reportAt = '2026-10-11T01:10:49.424Z';
const day = 86_400_000;

/** The 20 build-stage scope widenings the 7-day report counted at 01:10:49Z: item, ledger seq of the first source, instant, trigger, and the pattern item that links it. */
const counted = [
  ['GY-1272', 2258210, '2026-10-05T07:08:34.776Z', 'refused-by-loop', 'GY-1388'],
  ['GY-1286', 2270061, '2026-10-05T09:46:50.725Z', 'scope-request', 'GY-1388'],
  ['GY-1287', 2270825, '2026-10-05T10:01:59.079Z', 'refused-by-loop', 'GY-1388'],
  ['GY-1236', 2293806, '2026-10-05T14:15:09.599Z', 'refused-by-loop', 'GY-1388'],
  ['GY-1320', 2312309, '2026-10-05T19:50:05.471Z', 'refused-by-loop', 'GY-1388'],
  ['GY-1327', 2316720, '2026-10-05T22:28:33.470Z', 'refused-by-loop', 'GY-1388'],
  ['GY-1339', 2318782, '2026-10-06T01:30:05.621Z', 'refused-by-loop', 'GY-1388'],
  ['GY-1345', 2319902, '2026-10-06T02:57:59.411Z', 'refused-by-loop', 'GY-1388'],
  ['GY-1348', 2321633, '2026-10-06T04:05:10.394Z', 'refused-by-loop', 'GY-1388'],
  ['GY-1349', 2322244, '2026-10-06T04:36:16.641Z', 'refused-by-loop', 'GY-1388'],
  ['GY-1352', 2322801, '2026-10-06T05:16:06.194Z', 'refused-by-loop', 'GY-1388'],
  ['GY-1378', 2329831, '2026-10-06T15:53:46.902Z', 'refused-by-loop', 'GY-1388'],
  ['GY-1377', 2330754, '2026-10-06T18:09:01.238Z', 'refused-by-loop', 'GY-1388'],
  ['GY-1379', 2331363, '2026-10-06T18:35:16.887Z', 'refused-by-loop', 'GY-1388'],
  ['GY-1412', 2343912, '2026-10-07T04:43:56.705Z', 'refused-by-loop', 'GY-1568'],
  ['GY-1413', 2343913, '2026-10-07T04:43:56.939Z', 'refused-by-loop', 'GY-1568'],
  ['GY-1389', 2346081, '2026-10-07T05:06:40.133Z', 'refused-by-loop', 'GY-1568'],
  ['GY-1520', 2410948, '2026-10-08T10:32:39.087Z', 'refused-by-loop', 'GY-1568'],
  ['GY-1617', 2470341, '2026-10-09T23:48:58.838Z', 'operator-widening', null],
  ['GY-1675', 2489179, '2026-10-10T23:12:05.763Z', 'operator-widening', null],
] as const;
/**
 * The cause each counted instance shows in its ledger rows, by the item the row names as its owner.
 * The trigger is the typed half of the cause: `scope-request` and `refused-by-loop` are a worker's
 * ask the plan did not carry (requirements the plan left ambiguous), `operator-widening` a master's
 * own revision of the plan with no ask before it (a triage scope decision).
 */
const causes = {
  'GY-1388': 'a master widened by hand an ask the rule refused and the loop was putting to the approver',
  'GY-1568': 'an ask between GY-1388\'s detection and its landing, or carried past its attempt\'s end',
  'GY-1682': 'GY-1617: the plan completed seconds after release, racing the first claim (no ask, no workspace yet); GY-1675: an approved exact path for a new file collapsed to src/ under the live lease and was applied by hand after it (removed by GY-1676), then 3 rework rounds',
} as const;

const instance = ([key, seq, requestedAt, trigger]: typeof counted[number]): Intervention => ({ id: `scope-widening:${uuid(key)}:${seq}`, kind: 'scope-widening', source: 'ledger', work: { id: uuid(key), key, title: key }, stage: 'build',
  blocked: 'files outside plannedFiles', trigger, requestedAt, resolvedAt: requestedAt, waitedMs: 0, resolvedBy: operator, resolution: 'widened', sources: [{ seq, kind: trigger === 'operator-widening' ? 'requirements' : 'scope' }] });
const patternItem = (key: string, mergedAt: string, instances: Intervention[]) => ({ id: uuid(key), key, title: `Recurring scope widening interventions at the build stage: ${instances.length} in 7 days`, stage: 'done', delivery: { mergedAt },
  origin: { pattern: { kind: 'scope-widening', stage: 'build', instances: instances.map(entry => ({ id: entry.id, work: entry.work!.key, requestedAt: entry.requestedAt })) } } }) as unknown as Work;
const interventions = counted.map(instance);
const linkedTo = (key: string) => interventions.filter((_, index) => counted[index][4] === key);
const owners = [patternItem('GY-1388', '2026-10-07T05:46:02Z', linkedTo('GY-1388')), patternItem('GY-1568', '2026-10-09T07:04:46Z', linkedTo('GY-1568'))];
/** GY-1682 as the record holds it: a fault-class origin the master filed by hand (events#2491258), no `origin.pattern`, the fault's own line quoted in the description. */
const gy1682 = {
  id: uuid('GY-1682'), key: 'GY-1682', stage: 'build', type: 'bug', priority: 1,
  title: 'Scope-widening build-stage interventions crossed the pattern threshold (21 in 7 days) and no item stands for the pattern',
  description: 'Evidence: intervention-pattern fault 2026-10-10T23:16:36.002Z records 21 scope-widening interventions at the build stage in 7 days, past the threshold of 3, with no item standing for the pattern and the server promising to open one within a minute. At board 2026-10-11T00:52:53.923Z — 1.6h later — no such item stands.',
  origin: { faultClass: { class: 'scope', count: 1, instances: [], threshold: 1, windowHours: 1, detectedAt: '2026-10-11T01:04:24.147Z' } },
} as unknown as Work;
const fleet = [...owners, gy1682];
const buildRow = (report: ReturnType<typeof computeInterventionReport>) => report.patterns.find(pattern => pattern.kind === 'scope-widening' && pattern.stage === 'build');
const buildPattern = (work: Work[], now: string, list = interventions) => detectPatterns(list, work, policy, now).find(entry => entry.kind === 'scope-widening' && entry.stage === 'build');
const report = (work: Work[], now = reportAt) => computeInterventionReport({ interventions, judgements: [] }, work, policy, { days: 7, now });
const attention = async (data: ReturnType<typeof computeInterventionReport>) => (await interventionSummary(async () => ({ ...data, scan: { enabled: true, variable: 'GRAPHYARD_INTERVENTION_PATTERNS' }, ledger: { rows: 0, truncated: false, oldest: null } }))).attentionItems;
const share = (row: PatternRow) => Object.fromEntries(row.accounted.map(entry => [entry.key, entry.count]));

test('manual:pattern-item-owns-scope-widening — the board\'s pattern row names the count the threshold judges, every counted instance, and the items that own them: the delivered pattern items for 18 and GY-1682, filed by hand for the pattern\'s fault, for the two the threshold judges', async () => {
  const row = buildRow(report(fleet))!;
  assert.deepEqual({ count: row.count, unlinked: row.unlinked, threshold: row.threshold, crossed: row.crossed, work: row.work, accounted: row.accounted },
    { count: 20, unlinked: 2, threshold: 3, crossed: true, work: { id: uuid('GY-1682'), key: 'GY-1682', stage: 'build' },
      accounted: [{ id: uuid('GY-1388'), key: 'GY-1388', stage: 'done', count: 14 }, { id: uuid('GY-1568'), key: 'GY-1568', stage: 'done', count: 4 }, { id: uuid('GY-1682'), key: 'GY-1682', stage: 'build', count: 2 }] });
  // The counted instances themselves, newest first, each with its item, trigger and owner.
  assert.equal(row.instances.length, 20);
  assert.deepEqual(row.instances.map(entry => entry.work!.key), [...counted].reverse().map(([key]) => key));
  assert.deepEqual(row.instances.slice(0, 2).map(entry => ({ key: entry.work!.key, trigger: entry.trigger, owner: entry.owner, requestedAt: entry.requestedAt })),
    [{ key: 'GY-1675', trigger: 'operator-widening', owner: 'GY-1682', requestedAt: '2026-10-10T23:12:05.763Z' }, { key: 'GY-1617', trigger: 'operator-widening', owner: 'GY-1682', requestedAt: '2026-10-09T23:48:58.838Z' }]);
  for (const entry of row.instances) assert.equal(entry.owner, counted.find(([key]) => key === entry.work!.key)![4] ?? 'GY-1682', `${entry.work!.key} is owned by the item whose pattern links it, else by the standing item`);
  assert.deepEqual(buildPattern(fleet, reportAt)!.unlinked.map(entry => entry.work!.key), ['GY-1617', 'GY-1675'], 'the two the threshold judges are the two since GY-1568 landed');
  // The scan reads the same fold: an item stands for the pair, so `openPatternItems` opens nothing beside it, and master status raises no unfiled pattern.
  assert.equal(buildPattern(fleet, reportAt)!.item, gy1682);
  assert.deepEqual(await attention(report(fleet)), []);
  // Without GY-1682 the row owned 18 and stood for none; the same fold read as 20 counted, no crossing, no item, which is what the master read as a scan that failed.
  const unowned = buildRow(report(owners))!;
  assert.deepEqual({ crossed: unowned.crossed, work: unowned.work, accounted: share(unowned), unowned: unowned.instances.filter(entry => !entry.owner).map(entry => entry.work!.key) }, { crossed: false, work: null, accounted: { 'GY-1388': 14, 'GY-1568': 4 }, unowned: ['GY-1675', 'GY-1617'] });
  assert.deepEqual(await attention(report(owners)), [], 'two unlinked is under the threshold: nothing is owed an item');
});

test('manual:pattern-item-owns-scope-widening — a loop-filed fault item quoting the pattern fault\'s own line stands for that pair while open; an operator\'s own item, a delivered one, another pair\'s, or the scan\'s own item beside it never changes the owner', () => {
  assert.deepEqual(handFiledPattern(gy1682), { kind: 'scope-widening', stage: 'build' });
  const quoting = (fields: Record<string, unknown>) => ({ ...gy1682, id: uuid(String(fields.key)), ...fields }) as unknown as Work;
  // The fault's wording for a pair at no stage, from the scan's item and from the fault line, both read as no stage.
  assert.deepEqual(handFiledPattern(quoting({ key: 'GY-A', description: 'the report shows 4 escalation interventions at no stage in 7 days' })), { kind: 'escalation', stage: null });
  assert.deepEqual(handFiledPattern(quoting({ key: 'GY-B', title: '3 escalation interventions at the none stage in 7 days crossed the threshold', description: '' })), { kind: 'escalation', stage: null });
  // An operator's own item mentioning the pattern is its author's; a scan item is read through its origin; a sentence that is not the fault's names nothing.
  assert.equal(handFiledPattern(quoting({ key: 'GY-C', origin: null })), null);
  assert.equal(handFiledPattern(quoting({ key: 'GY-D', origin: { ...gy1682.origin, pattern: owners[0].origin!.pattern } })), null);
  assert.equal(handFiledPattern(quoting({ key: 'GY-E', description: 'scope widenings at the build stage keep recurring' })), null);
  // Delivered, it stands for nothing; filed for another pair, it stands for that pair only.
  assert.equal(buildPattern([...owners, quoting({ key: 'GY-1682', stage: 'done' })], reportAt)!.item, null);
  const review = quoting({ key: 'GY-F', description: '3 scope-widening interventions at the review stage in 7 days crossed the threshold' });
  assert.equal(buildPattern([...owners, review], reportAt)!.item, null);
  assert.equal(detectPatterns(interventions.map(entry => ({ ...entry, stage: 'review' as const })), [review], policy, reportAt)[0].item, review);
  // The scan's own open item for the pair stands first; a hand-filed item never displaces it.
  const scanned = { ...patternItem('GY-G', '', []), stage: 'build', delivery: null } as unknown as Work;
  assert.equal(buildPattern([...fleet, scanned], reportAt)!.item, scanned);
  assert.equal(buildPattern([scanned, ...fleet], reportAt)!.item, scanned);
  // The first hand-filed item in fleet order stands, as the scan's items always have.
  const second = quoting({ key: 'GY-H' });
  assert.equal(buildPattern([...fleet, second], reportAt)!.item, gy1682);
  assert.equal(buildPattern([second, ...fleet], reportAt)!.item, second);
});

test('manual:pattern-item-owns-scope-widening — the Interventions board renders the fold: the row, the unlinked count against the threshold, the standing item, the owners with their shares and the counted instances', () => {
  const data = { ...report(fleet), ledger: { rows: 20, truncated: false, oldest: counted[0][2] } };
  const markup = renderToStaticMarkup(createElement(InterventionsPage, { api: async () => data, status: { actor: { role: 'reader' } }, busy: false, setBusy() {}, setError() {}, setSelected() {}, work: [], initialReport: data } as unknown as Dashboard));
  const patterns = markup.slice(markup.indexOf('aria-label="Patterns"'), markup.indexOf('aria-label="Judgement about delivered work"'));
  for (const needle of ['20 × scope widening at build', '2 of 3 unlinked', '>GY-1682</button>', 'owned by ', '>GY-1388</button> (14, delivered)', '>GY-1568</button> (4, delivered)', '>GY-1682</button> (2)', 'Counted instances', '>GY-1617</button>', '>GY-1675</button>', 'operator-widening', 'refused-by-loop', 'owned by GY-1682', 'owned by GY-1388'])
    assert.ok(patterns.includes(needle), needle);
  assert.doesNotMatch(patterns, /an item opens within a minute/);
  assert.equal(patterns.match(/<li/g)!.length, 1 + 20, 'one row, twenty instances');
  // Without an owner for a crossed pair the row still says the scan's promise, as it did; a pair under the threshold with no item says neither.
  const crossed = { ...data, patterns: [{ ...data.patterns[0], work: null, unlinked: 3, crossed: true }] };
  assert.match(renderToStaticMarkup(createElement(InterventionsPage, { api: async () => crossed, status: { actor: { role: 'reader' } }, busy: false, setBusy() {}, setError() {}, setSelected() {}, work: [], initialReport: crossed } as unknown as Dashboard)), /an item opens within a minute/);
  const quiet = { ...report(owners), ledger: data.ledger };
  const under = renderToStaticMarkup(createElement(InterventionsPage, { api: async () => quiet, status: { actor: { role: 'reader' } }, busy: false, setBusy() {}, setError() {}, setSelected() {}, work: [], initialReport: quiet } as unknown as Dashboard));
  assert.ok(under.includes('2 of 3 unlinked') && under.includes('>GY-1388</button> (14, delivered)') && !under.includes('within a minute'), 'owned, not unfiled');
});

// GY-1675's rows from 23:12:05Z to 23:13:27Z and GY-1617's one, as the ledger holds them.
const gy1675 = uuid('GY-1675'), gy1617 = uuid('GY-1617');
const planned = Array.from({ length: 37 }, (_, index) => `src/planned-${index}.ts`);
const withObservation = [...planned, 'src/server/control-plane-observation.ts'];
const asked = ['docs/delivery-redesign.md', 'tests/trial-merge.test.ts', 'tests/submit-head.test.ts', 'tests/soak-control-plane-observation.test.ts'];
const widened = [...withObservation, ...asked];
const refusalReason = 'tests/trial-merge.test.ts, tests/submit-head.test.ts, tests/soak-control-plane-observation.test.ts are outside what this item\'s own criteria and the repository\'s documentation rule imply; an operator decides scope the item does not already carry';
const refusal = `${scopeRefusalBlocker}: ${refusalReason}`;
const askedAt = '2026-10-10T23:12:58.293Z', refusedAt = '2026-10-10T23:13:06.538Z';
const exactPath = 'Add exact path src/server/control-plane-observation.ts and AC-3 naming its creation (approved as exact path by approvers bccd33e4/5e9f7452/016ad8f4; applied now that no lease or quarantine stands): the observation job moves out of src/server/main.ts to keep its module budget';
const orphanPlan = ['src/cli/orphan-supervisors.ts', 'tests/orphan-supervisors.test.ts', 'tests/helpers/timing-baseline.json'];
const item1675 = (fields: Partial<Record<string, unknown>>) => ({ key: 'GY-1675', title: 'Land the 14 operator commits stranded on the coordinator checkout', stage: 'build', ...fields });
const rows: InterventionLedgerRow[] = [
  { seq: 2470341, workId: gy1617, actor: operator, kind: 'requirements', at: '2026-10-09T23:48:58.838Z', stageBefore: 'build',
    details: { before: { epoch: 1, plannedFiles: orphanPlan, pipeline: { attempts: [{ end: null }] } }, intent: { reason: 'Add the existing tests/orphan-supervisor.test.ts to plannedFiles', plannedFiles: [...orphanPlan, 'tests/orphan-supervisor.test.ts'] }, reason: 'Add the existing tests/orphan-supervisor.test.ts to plannedFiles', liveScopeWidening: false },
    work: { key: 'GY-1617', title: 'master status names an orphaned watch supervisor only once the loop establishes it', stage: 'build', epoch: 1, plannedFiles: [...orphanPlan, 'tests/orphan-supervisor.test.ts'], blocker: null } },
  { seq: 2489179, workId: gy1675, actor: operator, kind: 'requirements', at: '2026-10-10T23:12:05.763Z', stageBefore: 'build',
    details: { before: { epoch: 1, plannedFiles: planned, pipeline: { attempts: [{ end: 'submitted' }] } }, intent: { reason: exactPath, plannedFiles: withObservation }, reason: exactPath, liveScopeWidening: false }, work: item1675({ epoch: 1, plannedFiles: withObservation, blocker: null }) },
  { seq: 2489231, workId: gy1675, actor: worker, kind: 'scope', at: '2026-10-10T23:12:58.720Z', stageBefore: 'build',
    details: { epoch: 2, paths: asked, reason: 'Answering review of 6defae905bcd: docs/delivery-redesign.md must state the trial\'s new phase conditions; the three tests cover the findings' }, work: item1675({ epoch: 2, plannedFiles: withObservation, blocker: null }) },
  { seq: 2489236, workId: gy1675, actor: 'graphyard-master', kind: 'autoscope', at: '2026-10-10T23:13:06.568Z', stageBefore: 'build',
    details: { epoch: 2, before: { blocker: null, plannedFiles: withObservation }, decision: { at: refusedAt, epoch: 2, paths: asked, state: 'refused', reason: refusalReason, waitedMs: 8245, decidedBy: 'graphyard', requestedAt: askedAt, requestedBy: worker } }, work: item1675({ epoch: 2, plannedFiles: withObservation, blocker: refusal }) },
];
const loopWidening: InterventionLedgerRow = { seq: 2489250, workId: gy1675, actor: operator, kind: 'requirements', at: '2026-10-10T23:13:27.272Z', stageBefore: 'build',
  details: { before: { plannedFiles: withObservation }, intent: { reason: `${groundedWideningReason('GY-1675')}a review finding names it: docs/delivery-redesign.md, tests/trial-merge.test.ts, tests/submit-head.test.ts, tests/soak-control-plane-observation.test.ts`, plannedFiles: widened }, reason: `${groundedWideningReason('GY-1675')}a review finding names it`, liveScopeWidening: true },
  work: item1675({ epoch: 2, plannedFiles: widened, blocker: null }) };
const done1617 = { id: gy1617, key: 'GY-1617', title: 'GY-1617', stage: 'done' } as unknown as Work;
const decision = { state: 'refused', reason: refusalReason, at: refusedAt, decidedBy: 'graphyard', waitedMs: 8245, paths: asked, requestedBy: worker, requestedAt: askedAt, epoch: 2 };
const request = { epoch: 2, paths: asked, reason: 'Answering review of 6defae905bcd', requestedBy: worker, at: askedAt, decision };
/** GY-1675 as the record held it while the refused ask stood, with a live epoch-2 lease. */
const live = (fields: Record<string, unknown> = {}) => ({ id: gy1675, ...item1675({ epoch: 2, plannedFiles: withObservation, blocker: refusal }), criteria: [{ id: 'AC-1', text: 'The stranded commits land through a gated pull request', proofs: ['manual:stranded-commits-land'] }],
  lease: { owner: worker, epoch: 2, expiresAt: '2026-10-10T23:28:00.000Z' }, scopeRequest: request, escalations: [], violations: [], ...fields }) as unknown as Work;
const ask = { seq: 2489231, at: '2026-10-10T23:12:58.720Z', stage: 'build' as const, kind: 'scope-request' as const, blocked: `files outside plannedFiles: ${asked.join(', ')}`, paths: asked, trigger: 'refused-by-loop', sources: [{ seq: 2489231, kind: 'scope' }, { seq: 2489236, kind: 'autoscope' }] };
const buildWidenings = (ledger: InterventionLedgerRow[], work: Work[], now: string) => foldInterventions(ledger, work, now).interventions.filter(entry => entry.kind === 'scope-widening' && entry.stage === 'build').map(entry => ({ work: entry.work!.key, trigger: entry.trigger, open: entry.resolvedAt === null }));
const resolved = [{ work: 'GY-1675', trigger: 'operator-widening', open: false }, { work: 'GY-1617', trigger: 'operator-widening', open: false }];

test('manual:pattern-item-owns-scope-widening — GY-1675\'s refused ask of 23:12:58Z is the loop\'s for the 21 seconds before its audited widening, so the crossing read at 23:13 is not a pattern the scan failed to file', () => {
  const during = '2026-10-10T23:13:10.000Z';
  // Four seconds after the rule's refusal: the two hand widenings, and no waiting third.
  assert.deepEqual(buildWidenings(rows, [done1617, live()], during), resolved);
  assert.equal(exemption({ at: 'open-ask', ask, item: live(), now: during }), 'loop-settling-scope-request');
  const pattern = detectPatterns(foldInterventions(rows, [done1617, live()], during).interventions, [], policy, during).find(entry => entry.kind === 'scope-widening' && entry.stage === 'build')!;
  assert.deepEqual({ count: pattern.count, unlinked: pattern.unlinked.length, crossed: pattern.unlinked.length >= policy.threshold }, { count: 2, unlinked: 2, crossed: false });
  // After the loop's widening answered the ask, the same two stand: no instance appeared and vanished.
  assert.deepEqual(buildWidenings([...rows, loopWidening], [done1617, live({ blocker: null, scopeRequest: null, plannedFiles: widened })], '2026-10-10T23:14:00.000Z'), resolved);
  // Past the bound the loop promises, still refused and still the attempt's: somebody has to decide it, and it is counted as waiting from its own instant.
  const late = new Date(Date.parse(askedAt) + scopeBlockedBudgetMs + 60_000).toISOString();
  const waiting = { work: 'GY-1675', trigger: 'refused-by-loop', open: true };
  const lateRecord = [done1617, live({ lease: { owner: worker, epoch: 2, expiresAt: '2026-10-11T00:00:00.000Z' } })];
  assert.deepEqual(buildWidenings(rows, lateRecord, late), [waiting, ...resolved]);
  const counted = foldInterventions(rows, lateRecord, late).interventions.find(entry => entry.kind === 'scope-widening' && entry.resolvedAt === null)!;
  assert.deepEqual({ requestedAt: counted.requestedAt, waitedMs: counted.waitedMs }, { requestedAt: ask.at, waitedMs: Date.parse(late) - Date.parse(ask.at) }, 'an ask a deployment never routes is read late, with its whole wait, never lost');
  // Refused by the approver, nothing judges it again; left by an ended attempt, it is the record's: counted at once, as before.
  assert.deepEqual(buildWidenings(rows, [done1617, live({ scopeRequest: { ...request, decision: { ...decision, decidedBy: 'graphyard-approver-graphyard' } } })], during), [waiting, ...resolved]);
  assert.deepEqual(buildWidenings(rows, [done1617, live({ lease: null })], during), [waiting, ...resolved]);
});

test('manual:intervention-pattern-within-threshold — every counted build-stage instance carries its cause and owner on the row, and over 14 consecutive days of rolling 7-day windows from the report the unlinked count stays under 3 with GY-1682 standing and nothing owed an item', async () => {
  // The row's own accounting, not a fixture's: each instance names its owner and its trigger, the typed half of its cause.
  const row = buildRow(report(fleet))!;
  const byOwner: Record<string, number> = {}, byTrigger: Record<string, number> = {};
  for (const entry of row.instances) { byOwner[entry.owner!] = (byOwner[entry.owner!] ?? 0) + 1; byTrigger[entry.trigger!] = (byTrigger[entry.trigger!] ?? 0) + 1; }
  assert.deepEqual(byOwner, { 'GY-1388': 14, 'GY-1568': 4, 'GY-1682': 2 });
  assert.deepEqual(byTrigger, { 'refused-by-loop': 17, 'scope-request': 1, 'operator-widening': 2 }, '18 asks the plan did not carry, 2 revisions of the plan with no ask');
  for (const key of Object.keys(byOwner)) assert.ok(causes[key as keyof typeof causes], `${key} owns a named cause`);
  assert.deepEqual(row.instances.filter(entry => entry.owner === 'GY-1682').map(entry => [entry.work!.key, entry.trigger]), [['GY-1675', 'operator-widening'], ['GY-1617', 'operator-widening']]);
  // The transient the fault counted is no instance at any instant of its 21 seconds, so the window holds the two unlinked ones.
  for (const second of [7, 10, 20, 26]) {
    const now = new Date(Date.parse(refusedAt) + second * 1000 - 6_538).toISOString();
    assert.equal(buildWidenings(rows, [done1617, live()], now).filter(entry => entry.open).length, 0, `nothing waits at ${now}`);
  }
  // Fourteen consecutive days from the report, one rolling 7-day window a day over the recorded instances
  // and GY-1675's rows as they settled: each window holds fewer than 3 unlinked, GY-1682 stands for them
  // while they are inside the window, and master status raises no unfiled pattern on any day.
  const settled = [done1617, live({ blocker: null, scopeRequest: null, plannedFiles: widened })];
  for (let dayIndex = 0; dayIndex < 14; dayIndex++) {
    const now = new Date(Date.parse(reportAt) + dayIndex * day).toISOString();
    const replayed = foldInterventions([...rows, loopWidening], settled, now).interventions.filter(entry => entry.kind === 'scope-widening' && entry.stage === 'build');
    assert.deepEqual(replayed.filter(entry => entry.resolvedAt === null), [], `nothing waits on day ${dayIndex}`);
    const pattern = buildPattern(fleet, now);
    const unlinked = pattern?.unlinked.length ?? 0;
    assert.ok(unlinked < policy.threshold, `day ${dayIndex} (${now}): ${unlinked} unlinked of ${pattern?.count ?? 0} counted`);
    assert.equal(pattern?.item ?? null, pattern ? gy1682 : null, `GY-1682 stands on day ${dayIndex}`);
    const daily = report(fleet, now), dailyRow = buildRow(daily);
    assert.deepEqual(await attention(daily), [], `nothing is owed an item on day ${dayIndex}`);
    if (dailyRow) assert.deepEqual({ unlinked: dailyRow.unlinked, work: dailyRow.work?.key, unowned: dailyRow.instances.filter(entry => !entry.owner).length }, { unlinked, work: 'GY-1682', unowned: 0 });
  }
  // The two leave the 7-day window at 2026-10-17T23:12:05.763Z, inside the 14 days; from then the pair has no instance at all.
  assert.equal(buildPattern(fleet, '2026-10-17T23:12:05.764Z'), undefined);
  assert.equal(buildPattern(fleet, new Date(Date.parse(reportAt) + 13 * day).toISOString()), undefined);
});
