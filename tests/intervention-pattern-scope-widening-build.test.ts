import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeInterventionReport, detectPatterns, foldInterventions, type InterventionLedgerRow } from '../src/interventions.js';
import { ledgerReach, underThreshold } from '../src/interventions/report.js';
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
// the causes their instances show and the rework rounds their items carried (`accounted`), the whole
// pattern's causes and rounds against the standing item (`causes`, `reworkRounds`), the instances
// themselves (`instances`), and how long every rolling window has held under the threshold within the
// ledger's reach over every counted instance, linked or not (`underThreshold`): 20 in 7 days is 20
// interventions whoever owns them, so that reading is 0 days at the report, and the 14 days AC-2 asks
// for begin no earlier than 2026-10-15T10:32:39.087Z, when the count falls to 2; the board renders the fold.

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
  assert.deepEqual({ count: row.count, unlinked: row.unlinked, threshold: row.threshold, crossed: row.crossed, work: row.work, causes: row.causes, reworkRounds: row.reworkRounds, accounted: row.accounted },
    { count: 20, unlinked: 2, threshold: 3, crossed: true, work: { id: uuid('GY-1682'), key: 'GY-1682', stage: 'build' }, causes: { 'requirements-ambiguity': 18, 'triage-scope-decision': 2 }, reworkRounds: 3,
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
    'counted: 18 from requirements the plan left ambiguous, 2 from triage scope decisions · 3 rework rounds', 'at or past the threshold now (peak 20 since', 'if nothing further is recorded', 'Counted instances', '>GY-1617</button>', '>GY-1675</button>', 'operator-widening (from triage scope decisions)', 'refused-by-loop (from requirements the plan left ambiguous)', 'owned by GY-1682 · 3 rework rounds', 'owned by GY-1388'])
    assert.ok(patterns.includes(needle), needle);
  assert.doesNotMatch(patterns, /an item opens within a minute/);
  assert.equal(patterns.match(/<li/g)!.length, 1 + 20, 'one row, twenty instances');
  // Without an owner for a crossed pair the row still says the scan's promise, as it did; a pair under the threshold with no item says neither.
  assert.match(page({ ...data, patterns: [{ ...data.patterns[0], work: null, unlinked: 3, crossed: true }] }), /an item opens within a minute/);
  const under = page({ ...report(owners), ledger: data.ledger });
  assert.ok(under.includes('2 of 3 unlinked') && under.includes('>GY-1388</button> (14, delivered') && !under.includes('within a minute'), 'owned, not unfiled');
  // A pair at the threshold now reads so, with its peak over every counted instance; a pair whose instances all left the window keeps its reading at count 0, with its days of the 14.
  const third = instance(['GY-X', 2480000, '2026-10-10T12:00:00.000Z', 'refused-by-loop', null]);
  assert.match(page({ ...report(fleet, reportAt, { interventions: [...interventions, third] }), ledger: data.ledger }), /3 of 3 unlinked.*at or past the threshold now \(peak 21/);
  assert.match(page({ ...report(fleet, '2026-10-19T00:00:00.000Z', { reach: ledgerSince }), ledger: data.ledger }), /0 × scope widening at build.*0 of 3 unlinked.*under the threshold in every rolling window for 3 of 14 days/);
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
    details: { epoch: 2, before: { blocker: null, plannedFiles: withObservation }, decision: { at: refusedAt, epoch: 2, paths: asked, state: 'refused', reason: refusalReason, waitedMs: 8245, decidedBy: 'graphyard', treeRead: true, requestedAt: askedAt, requestedBy: worker } }, work: item1675({ epoch: 2, plannedFiles: withObservation, blocker: refusal }) },
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
const decision = { state: 'refused', reason: refusalReason, at: refusedAt, decidedBy: 'graphyard', treeRead: true, waitedMs: 8245, paths: asked, requestedBy: worker, requestedAt: askedAt, epoch: 2 };
const request = { epoch: 2, paths: asked, reason: 'Answering review of 6defae905bcd', requestedBy: worker, at: askedAt, decision };
/** GY-1675 as the record held it while the refused ask stood, with a live epoch-2 lease. */
const live = (fields: Record<string, unknown> = {}) => ({ id: gy1675, ...item1675({ epoch: 2, plannedFiles: withObservation, blocker: refusal }), criteria: [{ id: 'AC-1', text: 'The stranded commits land through a gated pull request', proofs: ['manual:stranded-commits-land'] }],
  lease: { owner: worker, epoch: 2, expiresAt: '2026-10-10T23:28:00.000Z' }, scopeRequest: request, escalations: [], violations: [], ...fields }) as unknown as Work;
const ask = { seq: 2489231, at: '2026-10-10T23:12:58.720Z', stage: 'build' as const, kind: 'scope-request' as const, blocked: `files outside plannedFiles: ${asked.join(', ')}`, paths: asked, trigger: 'refused-by-loop', epoch: 2, sources: [{ seq: 2489231, kind: 'scope' }, { seq: 2489236, kind: 'autoscope' }] };
const buildWidenings = (ledger: InterventionLedgerRow[], work: Work[], now: string) => foldInterventions(ledger, work, now).interventions.filter(entry => entry.kind === 'scope-widening' && entry.stage === 'build').map(entry => ({ work: entry.work!.key, trigger: entry.trigger, open: entry.resolvedAt === null }));
const resolved = [{ work: 'GY-1675', trigger: 'operator-widening', open: false }, { work: 'GY-1617', trigger: 'operator-widening', open: false }];
const waiting = { work: 'GY-1675', trigger: 'refused-by-loop', open: true };
const during = '2026-10-10T23:13:10.000Z';

test('manual:pattern-item-owns-scope-widening — a refused ask the record shows no route for is the loop\'s while it can still route it and counted from its own instant once it cannot: GY-1675\'s 21 seconds read as nothing, a routable ask past the bound or one nothing can route as a third unlinked instance owned by GY-1682, and the scan and the status read one fold', async () => {
  const late = new Date(Date.parse(askedAt) + scopeBlockedBudgetMs + 60_000).toISOString();
  const livePast = { lease: { owner: worker, epoch: 2, expiresAt: '2026-10-11T00:00:00.000Z' } };
  // GY-1755: four seconds after the rule's refusal the loop has yet to reach its decision step, but the record shows an ask it routes: no instance.
  assert.deepEqual(buildWidenings(rows, [done1617, live()], during), resolved);
  assert.equal(exemption({ at: 'open-ask', ask, item: live(), now: during }), 'scope-refusal-within-bound');
  // Past the bound the loop promises, the same ask is counted from its own instant: both readers see three.
  assert.deepEqual(buildWidenings(rows, [done1617, live(livePast)], late), [waiting, ...resolved]);
  const record = [done1617, live(livePast)];
  const folded = foldInterventions(rows, [...record, gy1682], late).interventions;
  const pattern = detectPatterns(folded, [...record, gy1682], policy, late).find(entry => entry.kind === 'scope-widening' && entry.stage === 'build')!;
  assert.deepEqual({ count: pattern.count, unlinked: pattern.unlinked.length, item: pattern.item?.key }, { count: 3, unlinked: 3, item: 'GY-1682' }, 'crossed and owned: the scan opens nothing beside GY-1682');
  assert.deepEqual(await attention(computeInterventionReport({ interventions: folded, judgements: [] }, [...record, gy1682], policy, { days: 7, now: late })), [], 'owned, so master status raises nothing');
  // Without GY-1682 the same fold is crossed with no item for both readers: the status names the scan's promise and the scan would open the item — one fold, one fact.
  const unownedAttention = await attention(computeInterventionReport({ interventions: folded, judgements: [] }, record, policy, { days: 7, now: late }));
  assert.equal(unownedAttention.length, 1);
  assert.match(unownedAttention[0].text, /3 scope-widening interventions at the build stage in 7 days crossed the threshold of 3 and no item stands for the pattern yet; the server opens one within a minute/);
  assert.deepEqual(detectPatterns(folded, record, policy, late).find(entry => entry.kind === 'scope-widening')!.unlinked.length, 3);
  const open = foldInterventions(rows, record, late).interventions.find(entry => entry.kind === 'scope-widening' && entry.resolvedAt === null)!;
  assert.deepEqual({ requestedAt: open.requestedAt, waitedMs: open.waitedMs }, { requestedAt: ask.at, waitedMs: Date.parse(late) - Date.parse(ask.at) });
  // After the loop's widening answered the ask, the two stand: the ask was the loop's and left no instance.
  assert.deepEqual(buildWidenings([...rows, loopWidening], [done1617, live({ blocker: null, scopeRequest: null, plannedFiles: widened })], '2026-10-10T23:14:00.000Z'), resolved);
  // GY-1755: the approver's decline of a multi-path additive ask (answerScopeRequest rewrites the ask's decision as the approver's refusal) leaves the live attempt a narrower ask to make within the bound, which the fault pass does not stand (standingScopeRequest, GY-1757): no instance while it holds. A one-path ask has nothing narrower to re-ask, and an ask an ended attempt left nobody re-asks: counted at once, as before.
  assert.deepEqual(buildWidenings(rows, [done1617, live({ scopeRequest: { ...request, decision: { ...decision, decidedBy: 'graphyard-approver-graphyard' } } })], during), resolved);
  const onePath = ['docs/delivery-redesign.md'];
  assert.deepEqual(buildWidenings(rows, [done1617, live({ scopeRequest: { ...request, paths: onePath, decision: { ...decision, paths: onePath, decidedBy: 'graphyard-approver-graphyard' } } })], during), [waiting, ...resolved], 'a one-path ask the approver declined has nothing narrower to re-ask');
  assert.deepEqual(buildWidenings(rows, [done1617, live({ lease: null })], during), [waiting, ...resolved]);
  // A request the fold cannot carry under the plannedFiles cap, or one that rewrites criteria, is never routed (routableScopeRequest): the ask is somebody's to decide at once.
  assert.deepEqual(buildWidenings(rows, [done1617, live({ scopeRequest: { ...request, criteria: [{ id: 'AC-1', text: 'x', proofs: [] }] } })], during), [waiting, ...resolved]);
});

test('manual:pattern-item-owns-scope-widening — a refused ask the loop put to the independent approver is the approver\'s while the record shows the decision standing, and stays the loop\'s inside its bound once a decision settles without applying; counted when it outlasts the bound, when its attempt ends, or when nothing narrower is left to ask', () => {
  const routed = [...rows, routedDecision];
  // The decision.requested row names the ask (input.answers); the fold marks the ask routed, and the open ask is exempt.
  assert.deepEqual(buildWidenings(routed, [done1617, live()], during), resolved);
  assert.equal(exemption({ at: 'open-ask', ask: { ...ask, routed: { seq: 2489237, at: '2026-10-10T23:13:07.900Z', decision: 'decision-1675-scope' } }, item: live(), now: during }), 'approver-holds-scope-request');
  // Declined by the approver within the bound: the ask's decision is now the approver's refusal, but the live attempt holds a narrower ask to make inside the bound (standingScopeRequest, GY-1757), so the fold counts nothing (GY-1755, as the pattern read GY-1751 five minutes after its decline).
  const declined = [...routed, settledRouted('decision.declined', 2489240, '2026-10-10T23:14:00.000Z')];
  assert.deepEqual(buildWidenings(declined, [done1617, live({ scopeRequest: { ...request, decision: { ...decision, decidedBy: 'graphyard-approver-graphyard', at: '2026-10-10T23:14:00.000Z' } } })], '2026-10-10T23:14:30.000Z'), resolved);
  // Stale, withdrawn, superseded or failed without applying: the ask is back inside the loop's bound, which the fold reads as the fault pass does — the loop's again while it holds.
  for (const kind of ['decision.stale', 'decision.withdrawn', 'decision.superseded', 'decision.failed'])
    assert.deepEqual(buildWidenings([...routed, settledRouted(kind, 2489240, '2026-10-10T23:14:00.000Z')], [done1617, live()], '2026-10-10T23:14:30.000Z'), resolved, kind);
  // Past the bound the loop promises, the approver holding it is a wait somebody must notice (standingScopeRequest); an ended attempt's ask is the record's.
  const late = new Date(Date.parse(askedAt) + scopeBlockedBudgetMs + 60_000).toISOString();
  assert.deepEqual(buildWidenings(routed, [done1617, live({ lease: { owner: worker, epoch: 2, expiresAt: '2026-10-11T00:00:00.000Z' } })], late), [waiting, ...resolved]);
  assert.deepEqual(buildWidenings(routed, [done1617, live({ lease: null })], during), [waiting, ...resolved]);
  // Approved and applied: the approver's widening answers the ask (routed-scope-widening), and the pair holds the two it held.
  const applied = [...routed, settledRouted('decision.approved', 2489258, '2026-10-10T23:14:59.000Z'), settledRouted('decision.applied', 2489259, '2026-10-10T23:14:59.500Z'), approverWidening];
  assert.deepEqual(buildWidenings(applied, [done1617, live({ blocker: null, scopeRequest: null, plannedFiles: widened })], '2026-10-10T23:16:00.000Z'), resolved);
  // A routed decision for another attempt's ask marks nothing: the row names the ask it answers.
  const other = { ...routedDecision, payload: { ...routedDecision.payload, input: { ...routedDecision.payload.input, answers: { epoch: 1, at: '2026-10-10T20:00:00.000Z' } } } };
  // (Read past the bound: within it an unrouted ask is the loop's, scope-refusal-within-bound, whichever decision is on the record.)
  const nearBound = new Date(Date.parse(askedAt) + scopeBlockedBudgetMs - 1_000).toISOString(), longLease = live({ lease: { owner: worker, epoch: 2, expiresAt: '2026-10-11T00:00:00.000Z' } });
  assert.deepEqual(buildWidenings([...rows, other], [done1617, longLease], '2026-10-10T23:30:00.000Z'), [waiting, ...resolved]);
  assert.deepEqual(buildWidenings([...rows, other, routedDecision], [done1617, longLease], nearBound), resolved);
  // A decision naming no ask marks nothing either: the routed reason alone says the loop routed something, not which ask.
  assert.deepEqual(buildWidenings([...rows, { ...routedDecision, payload: { ...routedDecision.payload, input: { plannedFiles: widened } } }], [done1617, longLease], '2026-10-10T23:30:00.000Z'), [waiting, ...resolved]);
});

test('manual:pattern-item-owns-scope-widening — a routed decision answers the ask of its exact identity, epoch and instant, as the server matches it: a worker\'s merged ask in the same attempt has a new instant, so a delayed decision for the earlier ask leaves it counted, and only a decision naming the merged ask holds it for the approver', () => {
  // The worker adds a path to its refused ask (mergedScopeRequest): a new ask, same epoch, new instant, refused by the rule in turn.
  const merged = [...asked, 'tests/trial-merge-phases.test.ts'], mergedAskedAt = '2026-10-10T23:13:20.100Z', mergedRefusedAt = '2026-10-10T23:13:28.004Z';
  const mergedRows: InterventionLedgerRow[] = [...rows,
    { seq: 2489238, workId: gy1675, actor: worker, kind: 'scope', at: '2026-10-10T23:13:20.517Z', stageBefore: 'build', details: { epoch: 2, paths: merged, reason: 'Answering review of 6defae905bcd | the phase test names the trial too' }, work: item1675({ epoch: 2, plannedFiles: withObservation, blocker: refusal }) },
    { seq: 2489239, workId: gy1675, actor: 'graphyard-master', kind: 'autoscope', at: mergedRefusedAt, stageBefore: 'build',
      details: { epoch: 2, before: { blocker: refusal, plannedFiles: withObservation }, decision: { ...decision, at: mergedRefusedAt, paths: merged, requestedAt: mergedAskedAt } }, work: item1675({ epoch: 2, plannedFiles: withObservation, blocker: refusal }) },
  ];
  const mergedRequest = { ...request, at: mergedAskedAt, paths: merged, decision: { ...decision, at: mergedRefusedAt, paths: merged, requestedAt: mergedAskedAt } };
  // GY-1755: an unrouted ask is the loop's while it can route it, so the identity of a routed decision is read once the bound has passed.
  const record = [done1617, live({ scopeRequest: mergedRequest, lease: { owner: worker, epoch: 2, expiresAt: '2026-10-11T00:00:00.000Z' } })], now = new Date(Date.parse(mergedAskedAt) + scopeBlockedBudgetMs + 60_000).toISOString();
  assert.deepEqual(buildWidenings(mergedRows, [done1617, live({ scopeRequest: mergedRequest })], '2026-10-10T23:13:35.000Z'), resolved, 'within the bound the unrouted merged ask is the loop\'s');
  const answering = (at: string, seq = 2489241) => ({ ...routedDecision, seq, at: '2026-10-10T23:13:30.000Z', payload: { ...routedDecision.payload, input: { plannedFiles: [...widened, 'tests/trial-merge-phases.test.ts'], answers: { epoch: 2, at } } } });
  const open = (ledger: InterventionLedgerRow[]) => foldInterventions(ledger, record, now).interventions.find(entry => entry.kind === 'scope-widening' && entry.resolvedAt === null);
  // The merged ask is the one open ask, counted from its own instant.
  assert.deepEqual(buildWidenings(mergedRows, record, now), [waiting, ...resolved]);
  assert.equal(open(mergedRows)!.requestedAt, '2026-10-10T23:13:20.517Z');
  // The decision for the earlier ask lands after the merge: same epoch, the earlier instant. The server would not apply it to the merged ask, and the fold does not hold the merged ask for it.
  assert.deepEqual(buildWidenings([...mergedRows, answering(askedAt)], record, now), [waiting, ...resolved], 'the merged ask stays counted');
  assert.equal(open([...mergedRows, answering(askedAt)])!.requestedAt, '2026-10-10T23:13:20.517Z');
  // The decision naming the merged ask holds it for the approver while it stands.
  const soon = '2026-10-10T23:13:35.000Z';
  assert.deepEqual(buildWidenings([...mergedRows, answering(mergedAskedAt)], record, soon), resolved, 'the approver holds the merged ask');
  // Both on the record, the earlier one first: only the one naming the merged ask marks it.
  assert.deepEqual(buildWidenings([...mergedRows, answering(askedAt), answering(mergedAskedAt, 2489242)], record, soon), resolved);
  assert.deepEqual(buildWidenings([...mergedRows, answering(mergedAskedAt), { ...settledRouted('decision.stale', 2489243, '2026-10-10T23:13:33.000Z') }], record, now), [waiting, ...resolved], 'stale, the merged ask is back with whoever decides it');
});

test('manual:intervention-pattern-within-threshold — a truncated ledger read begins the under-threshold reading where the record it holds is whole, never at the window start the rows before it were cut from: the streak and the peak are read off the record, not off rows never read', () => {
  const since = '2026-09-11T01:10:49.424Z';
  // Within the limit, the reach is the window start: every row since it was read, whatever the oldest retained row's own instant.
  assert.equal(ledgerReach('2026-10-01T00:00:00.000Z', false, since, reportAt), since);
  assert.equal(ledgerReach('2026-09-10T02:00:00.000Z', false, since, reportAt), since);
  // Truncated, the reach is the oldest row the read retained, as the ledger read names it (`retainedFrom`, tests/intervention-ledger-retained-reach.test.ts): a decision row written inside the window as much as any other.
  assert.equal(ledgerReach('2026-10-02T06:00:00.000Z', true, since, reportAt), '2026-10-02T06:00:00.000Z');
  // A read that retained no row holds no record to begin a reading at: it begins now, 0 days.
  assert.equal(ledgerReach(null, true, since, reportAt), reportAt);
  // A retained row's own instant may precede the read (a decision row inside the day before the window, kept for the decision it settles); the reach never precedes the read.
  assert.equal(ledgerReach('2026-09-11T01:10:49.000Z', true, since, reportAt), since);
  assert.equal(ledgerReach('2026-09-10T02:00:00.000Z', true, since, reportAt), since);
  // Read at the truncated reach, the row's reading begins there and claims nothing earlier: the instances before it are not the record's, and the reading says where it reads from.
  // The 17 instances before the reach still belong to every rolling window reaching before it, so the reading is established only a policy
  // window past the reach (2026-10-15T00:00Z): at the report no window is whole, the reading says so rather than reading the three retained
  // instances as the whole count, and the streak begins at the first established instant the recorded count is under 3 — when GY-1520's leaves.
  const truncatedReach = '2026-10-08T00:00:00.000Z', truncatedEstablished = '2026-10-15T00:00:00.000Z';
  const truncatedRow = buildRow(report(fleet, reportAt, { reach: truncatedReach }))!;
  assert.deepEqual(truncatedRow.underThreshold, { since: null, days: 0, holdDays: 14, peak: 0, projected: '2026-10-15T10:32:39.087Z', reach: truncatedReach, established: truncatedEstablished }, 'no window is whole yet; the three instances recorded since the reach and the 17 before it are not a reading');
  assert.deepEqual(buildRow(report(fleet, '2026-10-15T00:00:00.000Z', { reach: truncatedReach }))!.underThreshold, { since: null, days: 0, holdDays: 14, peak: 3, projected: '2026-10-15T10:32:39.087Z', reach: truncatedReach, established: truncatedEstablished }, 'the first whole window holds the three retained instances: at the threshold');
  assert.deepEqual(buildRow(report(fleet, '2026-10-15T10:32:39.088Z', { reach: truncatedReach }))!.underThreshold, { since: '2026-10-15T10:32:39.087Z', days: 0, holdDays: 14, peak: 3, projected: null, reach: truncatedReach, established: truncatedEstablished });
  assert.ok(underThreshold(interventions.filter(entry => entry.requestedAt >= truncatedReach), policy, truncatedReach, '2026-10-29T10:32:39.087Z').days <= underThreshold(interventions, policy, ledgerSince, '2026-10-29T10:32:39.087Z').days, 'a later reach never lengthens the streak');
});

test('manual:intervention-pattern-within-threshold — a truncated read never reads the windows the omitted instances may still belong to: the streak begins no earlier than one policy window past the reach, and until then the reading says no window is whole', () => {
  // graphyard-reviewer on PR #1115 (src/interventions/report.ts:55,117, head 0329d99533aa): two scope widenings omitted just before the cutoff
  // and one retained just after it are three in one rolling window — at the threshold — but a reading that began at the cutoff with
  // count 0 read them as one, and after 14 days reported a streak only the last seven of which the record established.
  const cut = '2026-10-10T12:00:00.000Z', whole = '2026-10-17T12:00:00.000Z';
  const omitted = [instance(['GY-O1', 2470000, '2026-10-10T11:58:00.000Z', 'refused-by-loop', null]), instance(['GY-O2', 2470001, '2026-10-10T11:59:00.000Z', 'refused-by-loop', null])];
  const retained = [instance(['GY-R1', 2470002, '2026-10-10T12:01:00.000Z', 'refused-by-loop', null])];
  // What the record truly holds at the threshold: read whole, the window is at 3 from GY-R1's instant until GY-O1's leaves.
  assert.deepEqual(underThreshold([...omitted, ...retained], policy, '2026-10-03T12:00:00.000Z', '2026-10-11T00:00:00.000Z'),
    { since: null, days: 0, holdDays: 14, peak: 3, projected: '2026-10-17T11:58:00.000Z', reach: '2026-10-03T12:00:00.000Z', established: '2026-10-10T12:00:00.000Z' });
  // Read from the cut, the one retained instance is a floor under the threshold, which proves nothing: no window is whole before `whole`.
  const atCut = (now: string) => underThreshold(retained, policy, cut, now);
  assert.deepEqual(atCut('2026-10-11T00:00:00.000Z'), { since: null, days: 0, holdDays: 14, peak: 0, projected: whole, reach: cut, established: whole }, 'the streak would begin when the reading is established, not at the cut');
  assert.deepEqual(atCut('2026-10-17T11:59:59.999Z'), { since: null, days: 0, holdDays: 14, peak: 0, projected: whole, reach: cut, established: whole }, 'not yet whole a millisecond before');
  assert.deepEqual(atCut(whole), { since: whole, days: 0, holdDays: 14, peak: 1, projected: null, reach: cut, established: whole }, 'the first whole window holds the retained instance alone');
  assert.deepEqual(atCut('2026-10-24T12:00:00.000Z'), { since: whole, days: 7, holdDays: 14, peak: 1, projected: null, reach: cut, established: whole });
  assert.deepEqual(atCut('2026-10-31T12:00:00.000Z'), { since: whole, days: 14, holdDays: 14, peak: 1, projected: null, reach: cut, established: whole }, '14 days are read only once 14 established days have passed: 21 after the cut');
  assert.equal(atCut('2026-10-24T11:59:59.999Z').days, 6, 'a reading that began at the cut would have read 13 here');
  // Three retained just after the cut are a floor at the threshold, which is a crossing whatever was omitted: the streak begins at the first established drop under it.
  const three = [retained[0], instance(['GY-R2', 2470003, '2026-10-10T12:02:00.000Z', 'refused-by-loop', null]), instance(['GY-R3', 2470004, '2026-10-10T12:03:00.000Z', 'refused-by-loop', null])];
  assert.deepEqual(underThreshold(three, policy, cut, '2026-10-11T00:00:00.000Z'), { since: null, days: 0, holdDays: 14, peak: 0, projected: '2026-10-17T12:01:00.000Z', reach: cut, established: whole });
  assert.deepEqual(underThreshold(three, policy, cut, '2026-10-17T12:00:30.000Z'), { since: null, days: 0, holdDays: 14, peak: 3, projected: '2026-10-17T12:01:00.000Z', reach: cut, established: whole }, 'the first whole window holds all three');
  assert.deepEqual(underThreshold(three, policy, cut, '2026-10-17T12:01:00.001Z'), { since: '2026-10-17T12:01:00.000Z', days: 0, holdDays: 14, peak: 3, projected: null, reach: cut, established: whole });
  // A read that retained no row reads from now and establishes nothing for a policy window.
  assert.deepEqual(underThreshold([], policy, reportAt, reportAt), { since: null, days: 0, holdDays: 14, peak: 0, projected: '2026-10-18T01:10:49.424Z', reach: reportAt, established: '2026-10-18T01:10:49.424Z' });
  // The board says so, in place of a crossing it cannot read.
  const data = { ...report(fleet, reportAt, { reach: cut }), ledger: { rows: 0, truncated: true, oldest: null } };
  assert.match(page(data), /no whole window on the record yet \(read from .*; the reading is established from .*, and the streak begins .* if nothing further is recorded\)/);
  assert.doesNotMatch(page(data), /at or past the threshold now|under the threshold in every rolling window/);
});

test('manual:intervention-pattern-within-threshold — the causes and rounds are read against the owning item, and the row reads how long every rolling 7-day window has held under 3 over every counted instance, linked or not, within the ledger\'s reach: the instrument the 14 days are read off, truthful over the record as it stands', async () => {
  // Each counted instance carries its cause — the typed half the trigger holds — and its item's rework rounds; the owner tallies both.
  assert.deepEqual([patternCause('scope-widening', 'refused-by-loop'), patternCause('scope-widening', 'scope-request'), patternCause('scope-widening', 'operator-widening'), patternCause('scope-widening', 'recorded-by-hand'), patternCause('escalation', 'operator-widening')],
    ['requirements-ambiguity', 'requirements-ambiguity', 'triage-scope-decision', null, null]);
  const row = buildRow(report(fleet, reportAt, { reach: ledgerSince }))!;
  const gy1682Owner = row.accounted.find(entry => entry.key === 'GY-1682')!;
  assert.deepEqual({ causes: gy1682Owner.causes, reworkRounds: gy1682Owner.reworkRounds }, { causes: { 'triage-scope-decision': 2 }, reworkRounds: 3 }, 'GY-1682 owns two triage scope decisions, one of them GY-1675\'s with its 3 rework rounds');
  // The whole pattern's causes and rounds are recorded against the item that stands for it: all 20, not only the two no delivered item links.
  assert.deepEqual({ work: row.work?.key, causes: row.causes, reworkRounds: row.reworkRounds }, { work: 'GY-1682', causes: { 'requirements-ambiguity': 18, 'triage-scope-decision': 2 }, reworkRounds: 3 });
  assert.deepEqual(row.instances.filter(entry => entry.owner === 'GY-1682').map(entry => [entry.work!.key, entry.cause, entry.reworkRounds]), [['GY-1675', 'triage-scope-decision', 3], ['GY-1617', 'triage-scope-decision', 0]]);
  assert.deepEqual(row.instances.filter(entry => entry.owner !== 'GY-1682').map(entry => entry.cause), Array(18).fill('requirements-ambiguity'), '18 asks the plan did not carry');
  assert.equal(row.instances.find(entry => entry.work!.key === 'GY-1272')!.reworkRounds, null, 'an item the snapshot does not hold has no rounds to read');
  // The truthful reading at the report: 20 build-stage scope widenings in 7 days, linked to a delivered item or not — linking owns an
  // instance, it does not undo the intervention — so no rolling window has held under 3 since the reach, the peak is 20 and the streak
  // has not begun. The recorded instants fix where it would: when GY-1520's instance leaves the window at 2026-10-15T10:32:39.087Z, only
  // GY-1617's and GY-1675's remain, if nothing further is recorded.
  const streakFrom = '2026-10-15T10:32:39.087Z';
  // The reading is established one policy window past the reach, 2026-10-11T00:00Z: the windows before it reach before the read.
  const established = '2026-10-11T00:00:00.000Z';
  assert.deepEqual(row.underThreshold, { since: null, days: 0, holdDays: 14, peak: 20, projected: streakFrom, reach: ledgerSince, established });
  assert.deepEqual(buildRow(report([gy1682, record1675, record1617], reportAt, { reach: ledgerSince }))!.underThreshold, row.underThreshold, 'linking changes who owns an instance, never the count the rate is read from');
  assert.deepEqual(buildRow(report(fleet))!.underThreshold, { ...row.underThreshold, reach: '2026-10-04T01:10:49.424Z', established: reportAt }, 'a 7-day read reads the same over its own reach: its one whole window is the current one');
  // The sweep is exact at the edges: the instant the count falls under 3 begins the streak, 14 whole days later the reading is 14.
  assert.deepEqual(underThreshold(interventions, policy, ledgerSince, streakFrom), { since: null, days: 0, holdDays: 14, peak: 20, projected: streakFrom, reach: ledgerSince, established });
  assert.deepEqual(underThreshold(interventions, policy, ledgerSince, '2026-10-15T10:32:39.088Z'), { since: streakFrom, days: 0, holdDays: 14, peak: 20, projected: null, reach: ledgerSince, established });
  assert.deepEqual(underThreshold(interventions, policy, ledgerSince, '2026-10-29T10:32:39.086Z'), { since: streakFrom, days: 13, holdDays: 14, peak: 20, projected: null, reach: ledgerSince, established });
  assert.deepEqual(underThreshold(interventions, policy, ledgerSince, '2026-10-29T10:32:39.087Z'), { since: streakFrom, days: 14, holdDays: 14, peak: 20, projected: null, reach: ledgerSince, established });
  // One further instance under the threshold keeps the streak; two more while GY-1617's and GY-1675's are still inside put the window at 4, and the streak begins again only when it falls under 3.
  const later = (key: string, at: string) => instance([key, 2500000, at, 'refused-by-loop', null]);
  assert.deepEqual(underThreshold([...interventions, later('GY-A', '2026-10-20T00:00:00.000Z')], policy, ledgerSince, '2026-10-29T10:32:39.087Z'), { since: streakFrom, days: 14, holdDays: 14, peak: 20, projected: null, reach: ledgerSince, established });
  assert.deepEqual(underThreshold([...interventions, later('GY-A', '2026-10-16T00:00:00.000Z'), later('GY-B', '2026-10-16T00:00:00.000Z')], policy, ledgerSince, '2026-10-20T00:00:00.000Z'), { since: '2026-10-17T23:12:05.763Z', days: 2, holdDays: 14, peak: 20, projected: null, reach: ledgerSince, established });
  assert.deepEqual(underThreshold([...interventions, later('GY-A', '2026-10-16T00:00:00.000Z'), later('GY-B', '2026-10-16T00:00:00.000Z')], policy, ledgerSince, '2026-10-16T12:00:00.000Z'), { since: null, days: 0, holdDays: 14, peak: 20, projected: '2026-10-17T23:12:05.763Z', reach: ledgerSince, established });
  // No instance at all: the streak begins when the reading is established, a policy window past the reach, never at the reach.
  assert.deepEqual(underThreshold([], policy, ledgerSince, reportAt), { since: established, days: 0, holdDays: 14, peak: 0, projected: null, reach: ledgerSince, established });
  assert.deepEqual(underThreshold([], policy, ledgerSince, '2026-10-18T01:10:49.424Z'), { since: established, days: 7, holdDays: 14, peak: 0, projected: null, reach: ledgerSince, established });
  assert.deepEqual(underThreshold([later('GY-A', '2026-10-12T00:00:00.000Z')], policy, ledgerSince, reportAt), { since: established, days: 0, holdDays: 14, peak: 0, projected: null, reach: ledgerSince, established }, 'an instance recorded after now is not on the record yet');
  // A third unlinked instance crosses the scan's rule and the row says so; the reading counts it with the rest, and its exit moves where the streak would begin.
  const third = instance(['GY-X', 2480000, '2026-10-10T12:00:00.000Z', 'refused-by-loop', null]);
  const crossedRow = buildRow(report(fleet, reportAt, { reach: ledgerSince, interventions: [...interventions, third] }))!;
  assert.deepEqual({ unlinked: crossedRow.unlinked, crossed: crossedRow.crossed, work: crossedRow.work?.key, under: crossedRow.underThreshold }, { unlinked: 3, crossed: true, work: 'GY-1682', under: { since: null, days: 0, holdDays: 14, peak: 21, projected: '2026-10-16T23:48:58.838Z', reach: ledgerSince, established } });
  // The fourteen days themselves are not this test's to show: they pass on the serving release, and the independent producer reads them
  // off GET /api/interventions?window=30 — `underThreshold.days` of `holdDays` on this row — no earlier than 2026-10-29T10:32:39.087Z, and
  // only if no further build-stage scope widening is recorded before then. What this test fixes is what that reading says over the record
  // as it stands and that it stays readable once the counted instances have left the policy window.
  assert.equal(buildPattern(fleet, '2026-10-17T23:12:05.764Z'), undefined, 'the last counted instance leaves the 7-day window at 2026-10-17T23:12:05.763Z');
  assert.equal(buildRow(report(fleet, '2026-10-17T23:12:05.764Z')), undefined, 'a 7-day read reaches no instance, so it has no row to read');
  const kept = buildRow(report(fleet, '2026-10-25T01:10:49.424Z', { reach: ledgerSince }))!;
  assert.deepEqual({ count: kept.count, unlinked: kept.unlinked, work: kept.work, under: kept.underThreshold }, { count: 0, unlinked: 0, work: null, under: { since: streakFrom, days: 9, holdDays: 14, peak: 20, projected: null, reach: ledgerSince, established } }, 'a 30-day read keeps the reading at count 0');
  assert.deepEqual(await attention(report(fleet, '2026-10-25T01:10:49.424Z', { reach: ledgerSince })), [], 'nothing is owed an item');
});
