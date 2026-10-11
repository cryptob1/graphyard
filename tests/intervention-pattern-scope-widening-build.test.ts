import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeInterventionReport, detectPatterns, foldInterventions, type InterventionLedgerRow } from '../src/interventions.js';
import { underThreshold } from '../src/interventions/report.js';
import { exemption } from '../src/intervention-exemptions.js';
import { interventionSummary } from '../src/cli/intervention-status.js';
import { handFiledPatterns, patternCause, type Intervention, type PatternRow } from '../src/model/interventions.js';
import { groundedWideningReason, routedScopeJudgement } from '../src/model/scope-provenance.js';
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
//     rounds; that cost is read against GY-1682, the item standing for the unlinked pair.
//   - GY-1617's requirements#2470341 (2026-10-09T23:48:58Z): the master completed the item's plan
//     with the existing tests/orphan-supervisor.test.ts 8 seconds after releasing it and 1.7 seconds
//     after the first claim, so the fold read a planning step as a widening of a started attempt. No
//     ask preceded it and no worker had a workspace yet; it is read here against GY-1682.
//
// The two unlinked instances are under the threshold. The 21st, counted only at 23:13, was GY-1675's
// epoch-2 scope request: asked at 23:12:58Z, refused by the rule at 23:13:06Z (autoscope#2489236),
// widened by the loop on its audited grounds at 23:13:27Z (requirements#2489250) — no decision was
// routed between. For those 21 seconds nothing on the record said the loop would answer, so the fold
// counts the refused ask then, as it counts one a deployment never routes: a refused ask is the
// approver's only while the ledger shows the loop put it to the approver (`decision.requested`) and the
// approver has not answered (approver-holds-scope-request); every other refused ask is counted from
// its own instant, never hidden until the loop's bound.
//
// Standing for the pair: GY-1682 — a fault-class item the master filed by hand, which the scan's
// `origin.pattern` lookup never saw, so the row named no owner and a third unlinked instance would have
// opened a second item beside it — stands for every pair its text quotes (handFiledPatterns). The row
// names the count the threshold judges (`unlinked`), the items that own every counted instance with
// the causes their instances show and the rework rounds their items carried (`accounted`), the
// instances themselves (`instances`), and how long every rolling window has held under the threshold
// within the ledger's reach (`underThreshold`); the board renders the fold.

const uuid = (name: string) => { const hex = createHash('sha256').update(name).digest('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`; };
const policy = { threshold: 3, windowDays: 7 };
const operator = 'graphyard-master-graphyard-operator', worker = 'graphyard-claude-1';
const reportAt = '2026-10-11T01:10:49.424Z';
/** Where a 30-day read of the ledger begins, as the API's `reach` names it: the under-threshold reading starts here. */
const ledgerSince = '2026-10-04T00:00:00.000Z';
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

const instance = ([key, seq, requestedAt, trigger]: readonly [string, number, string, string, string | null]): Intervention => ({ id: `scope-widening:${uuid(key)}:${seq}`, kind: 'scope-widening', source: 'ledger', work: { id: uuid(key), key, title: key }, stage: 'build',
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
/** The two items the unlinked instances name, as the snapshot's summaries hold them: GY-1675 carried 3 rework rounds (`pipeline.reworkRounds`), GY-1617 none. */
const record1675 = { id: uuid('GY-1675'), key: 'GY-1675', title: 'Land the 14 operator commits stranded on the coordinator checkout', stage: 'build', pipeline: { reworkRounds: 3, interventions: { blocked: 0, requirements: 1 } } } as unknown as Work;
const record1617 = { id: uuid('GY-1617'), key: 'GY-1617', title: 'GY-1617', stage: 'done', pipeline: { reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } } } as unknown as Work;
const fleet = [...owners, gy1682, record1675, record1617];
const buildRow = (report: ReturnType<typeof computeInterventionReport>) => report.patterns.find(pattern => pattern.kind === 'scope-widening' && pattern.stage === 'build');
const buildPattern = (work: Work[], now: string, list = interventions) => detectPatterns(list, work, policy, now).find(entry => entry.kind === 'scope-widening' && entry.stage === 'build');
const report = (work: Work[], now = reportAt, options: { reach?: string; interventions?: Intervention[] } = {}) => computeInterventionReport({ interventions: options.interventions ?? interventions, judgements: [] }, work, policy, { days: 7, now, reach: options.reach });
const attention = async (data: ReturnType<typeof computeInterventionReport>) => (await interventionSummary(async () => ({ ...data, scan: { enabled: true, variable: 'GRAPHYARD_INTERVENTION_PATTERNS' }, ledger: { rows: 0, truncated: false, oldest: null } }))).attentionItems;
const share = (row: PatternRow) => Object.fromEntries(row.accounted.map(entry => [entry.key, entry.count]));
const page = (data: object) => renderToStaticMarkup(createElement(InterventionsPage, { api: async () => data, status: { actor: { role: 'reader' } }, busy: false, setBusy() {}, setError() {}, setSelected() {}, work: [], initialReport: data } as unknown as Dashboard));

test('manual:pattern-item-owns-scope-widening — the board\'s pattern row names the count the threshold judges, every counted instance, and the items that own them: the delivered pattern items for 18 and GY-1682, filed by hand for the pattern\'s fault, for the two the threshold judges', async () => {
  const row = buildRow(report(fleet))!;
  assert.deepEqual({ count: row.count, unlinked: row.unlinked, threshold: row.threshold, crossed: row.crossed, work: row.work, accounted: row.accounted },
    { count: 20, unlinked: 2, threshold: 3, crossed: true, work: { id: uuid('GY-1682'), key: 'GY-1682', stage: 'build' },
      accounted: [
        { id: uuid('GY-1388'), key: 'GY-1388', stage: 'done', count: 14, causes: { 'requirements-ambiguity': 14 }, reworkRounds: 0 },
        { id: uuid('GY-1568'), key: 'GY-1568', stage: 'done', count: 4, causes: { 'requirements-ambiguity': 4 }, reworkRounds: 0 },
        { id: uuid('GY-1682'), key: 'GY-1682', stage: 'build', count: 2, causes: { 'triage-scope-decision': 2 }, reworkRounds: 3 }] });
  // The counted instances themselves, newest first, each with its item, trigger, owner, cause and its item's rework rounds.
  assert.equal(row.instances.length, 20);
  assert.deepEqual(row.instances.map(entry => entry.work!.key), [...counted].reverse().map(([key]) => key));
  assert.deepEqual(row.instances.slice(0, 2).map(entry => ({ key: entry.work!.key, trigger: entry.trigger, owner: entry.owner, requestedAt: entry.requestedAt, cause: entry.cause, reworkRounds: entry.reworkRounds })),
    [{ key: 'GY-1675', trigger: 'operator-widening', owner: 'GY-1682', requestedAt: '2026-10-10T23:12:05.763Z', cause: 'triage-scope-decision', reworkRounds: 3 }, { key: 'GY-1617', trigger: 'operator-widening', owner: 'GY-1682', requestedAt: '2026-10-09T23:48:58.838Z', cause: 'triage-scope-decision', reworkRounds: 0 }]);
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

test('manual:pattern-item-owns-scope-widening — a loop-filed fault item quoting the pattern fault\'s own line stands for every pair it quotes while open; an operator\'s own item, a delivered one, another pair\'s, or the scan\'s own item beside it never changes the owner', () => {
  assert.deepEqual(handFiledPatterns(gy1682), [{ kind: 'scope-widening', stage: 'build' }]);
  const quoting = (fields: Record<string, unknown>) => ({ ...gy1682, id: uuid(String(fields.key)), ...fields }) as unknown as Work;
  // The fault's wording for a pair at no stage, from the scan's item and from the fault line, both read as no stage.
  assert.deepEqual(handFiledPatterns(quoting({ key: 'GY-A', description: 'the report shows 4 escalation interventions at no stage in 7 days' })), [{ kind: 'escalation', stage: null }]);
  assert.deepEqual(handFiledPatterns(quoting({ key: 'GY-B', title: '3 escalation interventions at the none stage in 7 days crossed the threshold', description: '' })), [{ kind: 'escalation', stage: null }]);
  // An operator's own item mentioning the pattern is its author's; a scan item is read through its origin; a sentence that is not the fault's names nothing.
  assert.deepEqual(handFiledPatterns(quoting({ key: 'GY-C', origin: null })), []);
  assert.deepEqual(handFiledPatterns(quoting({ key: 'GY-D', origin: { ...gy1682.origin, pattern: owners[0].origin!.pattern } })), []);
  assert.deepEqual(handFiledPatterns(quoting({ key: 'GY-E', description: 'scope widenings at the build stage keep recurring' })), []);
  // Delivered, it stands for nothing; filed for another pair, it stands for that pair only.
  assert.equal(buildPattern([...owners, quoting({ key: 'GY-1682', stage: 'done' })], reportAt)!.item, null);
  const review = quoting({ key: 'GY-F', description: '3 scope-widening interventions at the review stage in 7 days crossed the threshold' });
  assert.equal(buildPattern([...owners, review], reportAt)!.item, null);
  assert.equal(detectPatterns(interventions.map(entry => ({ ...entry, stage: 'review' as const })), [review], policy, reportAt)[0].item, review);
  // A fault-class item lists every recent instance of its class (faultClassItem), so one may quote two patterns' faults:
  // it stands for both pairs, each quoted once however often it recurs, and the scan opens nothing beside it for either.
  const two = quoting({ key: 'GY-TWO', description: ['Instances (the evidence):', '- 2026-10-10T23:16:36Z intervention-pattern on interventions: 21 scope-widening interventions at the build stage in 7 days crossed the threshold of 3',
    '- 2026-10-10T23:40:00Z intervention-pattern on interventions: 4 escalation interventions at the review stage in 7 days crossed the threshold of 3', '- 2026-10-11T00:16:36Z intervention-pattern on interventions: 22 scope-widening interventions at the build stage in 7 days crossed the threshold of 3'].join('\n') });
  assert.deepEqual(handFiledPatterns(two), [{ kind: 'scope-widening', stage: 'build' }, { kind: 'escalation', stage: 'review' }]);
  const escalations = interventions.slice(0, 4).map(entry => ({ ...entry, id: `escalation:${entry.id}`, kind: 'escalation' as const, stage: 'review' as const, trigger: 'lease-loss' }));
  const both = detectPatterns([...interventions, ...escalations], [...owners, two], policy, reportAt);
  assert.deepEqual(both.map(pattern => [pattern.kind, pattern.stage, pattern.unlinked.length, pattern.item?.key ?? null]), [['scope-widening', 'build', 2, 'GY-TWO'], ['escalation', 'review', 4, 'GY-TWO']], 'both pairs are owned, so neither opens an item');
  // The scan's own open item for the pair stands first; a hand-filed item never displaces it.
  const scanned = { ...patternItem('GY-G', '', []), stage: 'build', delivery: null } as unknown as Work;
  assert.equal(buildPattern([...fleet, scanned], reportAt)!.item, scanned);
  assert.equal(buildPattern([scanned, ...fleet], reportAt)!.item, scanned);
  // The first hand-filed item in fleet order stands, as the scan's items always have.
  const second = quoting({ key: 'GY-H' });
  assert.equal(buildPattern([...fleet, second], reportAt)!.item, gy1682);
  assert.equal(buildPattern([second, ...fleet], reportAt)!.item, second);
});

test('manual:pattern-item-owns-scope-widening — the Interventions board renders the fold: the row, the unlinked count against the threshold, the standing item, the owners with their shares, causes and rework rounds, the under-threshold reading and the counted instances', () => {
  const data = { ...report(fleet), ledger: { rows: 20, truncated: false, oldest: counted[0][2] } };
  const markup = page(data);
  const patterns = markup.slice(markup.indexOf('aria-label="Patterns"'), markup.indexOf('aria-label="Judgement about delivered work"'));
  for (const needle of ['20 × scope widening at build', '2 of 3 unlinked', '>GY-1682</button>', 'owned by ',
    '>GY-1388</button> (14, delivered: 14 from requirements the plan left ambiguous · 0 rework rounds)', '>GY-1568</button> (4, delivered: 4 from requirements the plan left ambiguous · 0 rework rounds)', '>GY-1682</button> (2: 2 from triage scope decisions · 3 rework rounds)',
    'under the threshold in every rolling window for 7 days', 'peak 2', 'Counted instances', '>GY-1617</button>', '>GY-1675</button>', 'operator-widening (from triage scope decisions)', 'refused-by-loop (from requirements the plan left ambiguous)', 'owned by GY-1682 · 3 rework rounds', 'owned by GY-1388'])
    assert.ok(patterns.includes(needle), needle);
  assert.doesNotMatch(patterns, /an item opens within a minute/);
  assert.equal(patterns.match(/<li/g)!.length, 1 + 20, 'one row, twenty instances');
  // Without an owner for a crossed pair the row still says the scan's promise, as it did; a pair under the threshold with no item says neither.
  assert.match(page({ ...data, patterns: [{ ...data.patterns[0], work: null, unlinked: 3, crossed: true }] }), /an item opens within a minute/);
  const under = page({ ...report(owners), ledger: data.ledger });
  assert.ok(under.includes('2 of 3 unlinked') && under.includes('>GY-1388</button> (14, delivered') && !under.includes('within a minute'), 'owned, not unfiled');
  // A pair at the threshold now reads so, with its peak; a pair whose instances all left the window keeps its reading at count 0.
  const third = instance(['GY-X', 2480000, '2026-10-10T12:00:00.000Z', 'refused-by-loop', null]);
  assert.match(page({ ...report(fleet, reportAt, { interventions: [...interventions, third] }), ledger: data.ledger }), /3 of 3 unlinked.*at or past the threshold now \(peak 3/);
  assert.match(page({ ...report(fleet, '2026-10-19T00:00:00.000Z', { reach: ledgerSince }), ledger: data.ledger }), /0 × scope widening at build.*0 of 3 unlinked.*under the threshold in every rolling window for 15 days/);
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
/** What the record shows when the loop routes the refused ask instead (cycle-scope.ts step 4c, daemon/decisions.ts): a requirements decision requested for the approver, naming the ask it answers. */
const routedReason = `Widen GY-1675's plannedFiles with ${asked.join(', ')}: ${routedScopeJudgement}`;
const routedDecision: InterventionLedgerRow = { seq: 2489237, workId: gy1675, actor: operator, kind: 'decision.requested', at: '2026-10-10T23:13:07.900Z', stageBefore: 'build', details: null, work: null,
  payload: { id: 'decision-1675-scope', action: 'requirements', input: { plannedFiles: widened, answers: { epoch: 2, at: askedAt } }, reason: routedReason, requester: { role: 'operator-agent' } } };
const settledRouted = (kind: string, seq: number, at: string): InterventionLedgerRow => ({ seq, workId: gy1675, actor: 'graphyard-approver-graphyard', kind, at, stageBefore: 'build', details: null, work: null, payload: { id: 'decision-1675-scope', action: 'requirements' } });
/** The approver's approval applied: the requirements row opens with the routed reason (server/decisions.ts applyThroughEngine), as `routedScopeWidening` reads it. */
const approverWidening: InterventionLedgerRow = { seq: 2489260, workId: gy1675, actor: operator, kind: 'requirements', at: '2026-10-10T23:15:00.000Z', stageBefore: 'build',
  details: { before: { plannedFiles: withObservation }, plannedFiles: widened, reason: `${routedReason} [approved by graphyard-approver-graphyard]`, liveScopeWidening: true }, work: item1675({ epoch: 2, plannedFiles: widened, blocker: null }) };
const done1617 = { id: gy1617, key: 'GY-1617', title: 'GY-1617', stage: 'done' } as unknown as Work;
const decision = { state: 'refused', reason: refusalReason, at: refusedAt, decidedBy: 'graphyard', waitedMs: 8245, paths: asked, requestedBy: worker, requestedAt: askedAt, epoch: 2 };
const request = { epoch: 2, paths: asked, reason: 'Answering review of 6defae905bcd', requestedBy: worker, at: askedAt, decision };
/** GY-1675 as the record held it while the refused ask stood, with a live epoch-2 lease. */
const live = (fields: Record<string, unknown> = {}) => ({ id: gy1675, ...item1675({ epoch: 2, plannedFiles: withObservation, blocker: refusal }), criteria: [{ id: 'AC-1', text: 'The stranded commits land through a gated pull request', proofs: ['manual:stranded-commits-land'] }],
  lease: { owner: worker, epoch: 2, expiresAt: '2026-10-10T23:28:00.000Z' }, scopeRequest: request, escalations: [], violations: [], ...fields }) as unknown as Work;
const ask = { seq: 2489231, at: '2026-10-10T23:12:58.720Z', stage: 'build' as const, kind: 'scope-request' as const, blocked: `files outside plannedFiles: ${asked.join(', ')}`, paths: asked, trigger: 'refused-by-loop', epoch: 2, sources: [{ seq: 2489231, kind: 'scope' }, { seq: 2489236, kind: 'autoscope' }] };
const buildWidenings = (ledger: InterventionLedgerRow[], work: Work[], now: string) => foldInterventions(ledger, work, now).interventions.filter(entry => entry.kind === 'scope-widening' && entry.stage === 'build').map(entry => ({ work: entry.work!.key, trigger: entry.trigger, open: entry.resolvedAt === null }));
const resolved = [{ work: 'GY-1675', trigger: 'operator-widening', open: false }, { work: 'GY-1617', trigger: 'operator-widening', open: false }];
const waiting = { work: 'GY-1675', trigger: 'refused-by-loop', open: true };
const during = '2026-10-10T23:13:10.000Z';

test('manual:pattern-item-owns-scope-widening — a refused ask the record shows no route for is counted from its own instant, on any deployment: GY-1675\'s 21 seconds before the loop\'s own widening read as a third unlinked instance, owned by GY-1682, and the scan and the status read one fold', async () => {
  // Four seconds after the rule's refusal, nothing on the record says the loop will answer: the ask waits, and both readers see three.
  assert.deepEqual(buildWidenings(rows, [done1617, live()], during), [waiting, ...resolved]);
  assert.equal(exemption({ at: 'open-ask', ask, item: live(), now: during }), null, 'no route on the record, no exemption');
  const folded = foldInterventions(rows, [done1617, live(), gy1682], during).interventions;
  const pattern = detectPatterns(folded, [done1617, live(), gy1682], policy, during).find(entry => entry.kind === 'scope-widening' && entry.stage === 'build')!;
  assert.deepEqual({ count: pattern.count, unlinked: pattern.unlinked.length, item: pattern.item?.key }, { count: 3, unlinked: 3, item: 'GY-1682' }, 'crossed and owned: the scan opens nothing beside GY-1682');
  assert.deepEqual(await attention(computeInterventionReport({ interventions: folded, judgements: [] }, [done1617, live(), gy1682], policy, { days: 7, now: during })), [], 'owned, so master status raises nothing');
  // Without GY-1682 the same fold is crossed with no item for both readers: the status names the scan's promise and the scan would open the item — one fold, one fact.
  const unownedAttention = await attention(computeInterventionReport({ interventions: folded, judgements: [] }, [done1617, live()], policy, { days: 7, now: during }));
  assert.equal(unownedAttention.length, 1);
  assert.match(unownedAttention[0].text, /3 scope-widening interventions at the build stage in 7 days crossed the threshold of 3 and no item stands for the pattern yet; the server opens one within a minute/);
  assert.deepEqual(detectPatterns(folded, [done1617, live()], policy, during).find(entry => entry.kind === 'scope-widening')!.unlinked.length, 3);
  // After the loop's widening answered the ask, the two stand: the ask was the loop's and left no instance.
  assert.deepEqual(buildWidenings([...rows, loopWidening], [done1617, live({ blocker: null, scopeRequest: null, plannedFiles: widened })], '2026-10-10T23:14:00.000Z'), resolved);
  // A deployment that routes nothing leaves the record exactly as the 21 seconds did, so its refused ask is read as waiting at once, with its own instant, and keeps waiting past the bound.
  const late = new Date(Date.parse(askedAt) + scopeBlockedBudgetMs + 60_000).toISOString();
  const lateRecord = [done1617, live({ lease: { owner: worker, epoch: 2, expiresAt: '2026-10-11T00:00:00.000Z' } })];
  for (const now of [during, late]) {
    const counted = buildWidenings(rows, lateRecord, now);
    assert.deepEqual(counted, [waiting, ...resolved], `waiting at ${now}`);
    const open = foldInterventions(rows, lateRecord, now).interventions.find(entry => entry.kind === 'scope-widening' && entry.resolvedAt === null)!;
    assert.deepEqual({ requestedAt: open.requestedAt, waitedMs: open.waitedMs }, { requestedAt: ask.at, waitedMs: Date.parse(now) - Date.parse(ask.at) });
  }
  // Refused by the approver, or left by an ended attempt: counted, as before.
  assert.deepEqual(buildWidenings(rows, [done1617, live({ scopeRequest: { ...request, decision: { ...decision, decidedBy: 'graphyard-approver-graphyard' } } })], during), [waiting, ...resolved]);
  assert.deepEqual(buildWidenings(rows, [done1617, live({ lease: null })], during), [waiting, ...resolved]);
});

test('manual:pattern-item-owns-scope-widening — a refused ask the loop put to the independent approver is the approver\'s while the record shows the decision standing: counted again when the approver declines it, when the decision goes stale, when it waits past the loop\'s bound or when its attempt ends; an approval applies the widening and leaves no instance', () => {
  const routed = [...rows, routedDecision];
  // The decision.requested row names the ask (input.answers); the fold marks the ask routed, and the open ask is exempt.
  assert.deepEqual(buildWidenings(routed, [done1617, live()], during), resolved);
  assert.equal(exemption({ at: 'open-ask', ask: { ...ask, routed: { seq: 2489237, at: '2026-10-10T23:13:07.900Z', decision: 'decision-1675-scope' } }, item: live(), now: during }), 'approver-holds-scope-request');
  // Declined by the approver: the record's decision is the approver's refusal, counted from the ask's own instant.
  const declined = [...routed, settledRouted('decision.declined', 2489240, '2026-10-10T23:14:00.000Z')];
  assert.deepEqual(buildWidenings(declined, [done1617, live({ scopeRequest: { ...request, decision: { ...decision, decidedBy: 'graphyard-approver-graphyard', at: '2026-10-10T23:14:00.000Z' } } })], '2026-10-10T23:14:30.000Z'), [waiting, ...resolved]);
  // Stale, withdrawn or superseded without applying: the ask is back with whoever decides it, even if the item's own decision still reads the rule's.
  for (const kind of ['decision.stale', 'decision.withdrawn', 'decision.superseded', 'decision.failed'])
    assert.deepEqual(buildWidenings([...routed, settledRouted(kind, 2489240, '2026-10-10T23:14:00.000Z')], [done1617, live()], '2026-10-10T23:14:30.000Z'), [waiting, ...resolved], kind);
  // Past the bound the loop promises, the approver holding it is a wait somebody must notice (standingScopeRequest); an ended attempt's ask is the record's.
  const late = new Date(Date.parse(askedAt) + scopeBlockedBudgetMs + 60_000).toISOString();
  assert.deepEqual(buildWidenings(routed, [done1617, live({ lease: { owner: worker, epoch: 2, expiresAt: '2026-10-11T00:00:00.000Z' } })], late), [waiting, ...resolved]);
  assert.deepEqual(buildWidenings(routed, [done1617, live({ lease: null })], during), [waiting, ...resolved]);
  // Approved and applied: the approver's widening answers the ask (routed-scope-widening), and the pair holds the two it held.
  const applied = [...routed, settledRouted('decision.approved', 2489258, '2026-10-10T23:14:59.000Z'), settledRouted('decision.applied', 2489259, '2026-10-10T23:14:59.500Z'), approverWidening];
  assert.deepEqual(buildWidenings(applied, [done1617, live({ blocker: null, scopeRequest: null, plannedFiles: widened })], '2026-10-10T23:16:00.000Z'), resolved);
  // A routed decision for another attempt's ask marks nothing: the row names the ask it answers.
  const other = { ...routedDecision, payload: { ...routedDecision.payload, input: { ...routedDecision.payload.input, answers: { epoch: 1, at: '2026-10-10T20:00:00.000Z' } } } };
  assert.deepEqual(buildWidenings([...rows, other], [done1617, live()], during), [waiting, ...resolved]);
});

test('manual:intervention-pattern-within-threshold — the causes are read against the owning item, and the row reads how long every rolling 7-day window has held under 3 within the ledger\'s reach: the instrument the 14 days are read off, exact over the recorded instances', async () => {
  // Each counted instance carries its cause — the typed half the trigger holds — and its item's rework rounds; the owner tallies both.
  assert.deepEqual([patternCause('scope-widening', 'refused-by-loop'), patternCause('scope-widening', 'scope-request'), patternCause('scope-widening', 'operator-widening'), patternCause('scope-widening', 'recorded-by-hand'), patternCause('escalation', 'operator-widening')],
    ['requirements-ambiguity', 'requirements-ambiguity', 'triage-scope-decision', null, null]);
  const row = buildRow(report(fleet, reportAt, { reach: ledgerSince }))!;
  const gy1682Owner = row.accounted.find(entry => entry.key === 'GY-1682')!;
  assert.deepEqual({ causes: gy1682Owner.causes, reworkRounds: gy1682Owner.reworkRounds }, { causes: { 'triage-scope-decision': 2 }, reworkRounds: 3 }, 'GY-1682 owns two triage scope decisions, one of them GY-1675\'s with its 3 rework rounds');
  assert.deepEqual(row.instances.filter(entry => entry.owner === 'GY-1682').map(entry => [entry.work!.key, entry.cause, entry.reworkRounds]), [['GY-1675', 'triage-scope-decision', 3], ['GY-1617', 'triage-scope-decision', 0]]);
  assert.deepEqual(row.instances.filter(entry => entry.owner !== 'GY-1682').map(entry => entry.cause), Array(18).fill('requirements-ambiguity'), '18 asks the plan did not carry');
  assert.equal(row.instances.find(entry => entry.work!.key === 'GY-1272')!.reworkRounds, null, 'an item the snapshot does not hold has no rounds to read');
  // The under-threshold reading: within the read ledger no rolling window held 3 unlinked, so the streak is as old as the reach, 7 whole days at the report, peak 2.
  assert.deepEqual(row.underThreshold, { since: ledgerSince, days: 7, peak: 2, reach: ledgerSince });
  // The sweep is exact: a third unlinked instance on 2026-10-10 puts the window at the threshold until GY-1617 leaves it, 7 days after its instant, and the streak begins then.
  const third = instance(['GY-X', 2480000, '2026-10-10T12:00:00.000Z', 'refused-by-loop', null]);
  const unlinkedThree = [...interventions.slice(18), third];
  assert.deepEqual(underThreshold(unlinkedThree, policy, ledgerSince, reportAt), { since: null, days: 0, peak: 3, reach: ledgerSince });
  assert.deepEqual(underThreshold(unlinkedThree, policy, ledgerSince, '2026-10-16T23:48:58.837Z'), { since: null, days: 0, peak: 3, reach: ledgerSince });
  assert.deepEqual(underThreshold(unlinkedThree, policy, ledgerSince, '2026-10-16T23:48:58.839Z'), { since: '2026-10-16T23:48:58.838Z', days: 0, peak: 3, reach: ledgerSince });
  assert.deepEqual(underThreshold(unlinkedThree, policy, ledgerSince, '2026-10-18T00:00:00.000Z'), { since: '2026-10-16T23:48:58.838Z', days: 1, peak: 3, reach: ledgerSince });
  assert.deepEqual(underThreshold([], policy, ledgerSince, reportAt), { since: ledgerSince, days: 7, peak: 0, reach: ledgerSince });
  const crossedRow = buildRow(report(fleet, reportAt, { reach: ledgerSince, interventions: [...interventions, third] }))!;
  assert.deepEqual({ unlinked: crossedRow.unlinked, crossed: crossedRow.crossed, work: crossedRow.work?.key, under: crossedRow.underThreshold }, { unlinked: 3, crossed: true, work: 'GY-1682', under: { since: null, days: 0, peak: 3, reach: ledgerSince } });
  // Fourteen consecutive days from the report over the recorded instances and GY-1675's rows as they settled, the
  // reach fixed where a 30-day read begins: each day's row reads one more day under the threshold, GY-1682 stands
  // while an instance is inside the window, the row stays at count 0 once they have left it, nothing waits and
  // nothing is owed an item. This is the instrument's reading over the record as it stands; the fourteen live days
  // are the serving release's to show on GET /api/interventions?window=30 after this ships, and the independent
  // producer judges that reading, not this walk.
  const settled = [done1617, live({ blocker: null, scopeRequest: null, plannedFiles: widened })];
  for (let dayIndex = 0; dayIndex < 14; dayIndex++) {
    const now = new Date(Date.parse(reportAt) + dayIndex * day).toISOString();
    const replayed = foldInterventions([...rows, loopWidening], settled, now).interventions.filter(entry => entry.kind === 'scope-widening' && entry.stage === 'build');
    assert.deepEqual(replayed.filter(entry => entry.resolvedAt === null), [], `nothing waits on day ${dayIndex}`);
    const pattern = buildPattern(fleet, now);
    const unlinked = pattern?.unlinked.length ?? 0;
    assert.ok(unlinked < policy.threshold, `day ${dayIndex} (${now}): ${unlinked} unlinked of ${pattern?.count ?? 0} counted`);
    assert.equal(pattern?.item ?? null, pattern ? gy1682 : null, `GY-1682 stands on day ${dayIndex}`);
    const daily = report(fleet, now, { reach: ledgerSince }), dailyRow = buildRow(daily)!;
    assert.deepEqual(await attention(daily), [], `nothing is owed an item on day ${dayIndex}`);
    assert.deepEqual({ count: dailyRow.count, unlinked: dailyRow.unlinked, work: dailyRow.work?.key ?? null, unowned: dailyRow.instances.filter(entry => !entry.owner).length, under: dailyRow.underThreshold },
      { count: pattern?.count ?? 0, unlinked, work: pattern ? 'GY-1682' : null, unowned: 0, under: { since: ledgerSince, days: 7 + dayIndex, peak: 2, reach: ledgerSince } }, `day ${dayIndex}`);
  }
  // The two leave the 7-day window at 2026-10-17T23:12:05.763Z, inside the 14 days; from then the pair has no counted instance, and its row reads the days instead.
  assert.equal(buildPattern(fleet, '2026-10-17T23:12:05.764Z'), undefined);
  assert.equal(buildPattern(fleet, new Date(Date.parse(reportAt) + 13 * day).toISOString()), undefined);
  assert.equal(buildRow(report(fleet, '2026-10-17T23:12:05.764Z')), undefined, 'a 7-day read reaches no instance, so it has no row to read');
  assert.deepEqual(buildRow(report(fleet, '2026-10-25T01:10:49.424Z', { reach: ledgerSince }))!.underThreshold, { since: ledgerSince, days: 21, peak: 2, reach: ledgerSince }, 'a 30-day read keeps the reading');
});
