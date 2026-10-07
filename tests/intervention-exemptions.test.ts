import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { computeInterventionReport, foldInterventions, type InterventionLedgerRow } from '../src/interventions.js';
import { exemption, interventionExemptions, type ExemptionMoment } from '../src/intervention-exemptions.js';
import { groundedWideningReason } from '../src/model/scope-provenance.js';
import { scopeDecisionReason } from '../src/model/scope.js';
import { laneApprover } from '../src/model/rework-ground.js';
import { leaseLossReason } from '../src/model/escalation.js';
import type { Work } from '../src/model.js';
import type { ReworkGroundsWork as ReworkGrounds } from '../src/rework-grounds.js';

// GY-1427: the fold's per-kind exemption rules live in src/intervention-exemptions.ts, one named
// predicate each, consulted in one ordered list. The split moves code only: the fold's output over
// the intervention fixtures and over a ledger that reaches every rule is the one the unsplit fold
// produced (the digests below were taken from it, at main eac0fe0b29).

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const policy = { threshold: 3, windowDays: 7 };
/** The fold and its 7- and 30-day reports, as one digest. */
const digest = (rows: InterventionLedgerRow[], work: Work[], now: string) => {
  const folded = foldInterventions(rows, work, now);
  const reports = ([7, 30] as const).map(days => computeInterventionReport(folded, work, policy, { days, now }));
  return createHash('sha256').update(JSON.stringify({ folded, reports })).digest('hex');
};

/** GY-1389's 386 linked review rounds, replayed as intervention-rework-rounds.test.ts replays them, with a stable id per item. */
function reworkRounds() {
  const fixture = JSON.parse(source('tests/fixtures/gy-1389-rework-rounds.json')) as { window: { to: string }; instances: { id: string; work: string; decision: { id: string; seq: number; at: string; binding: string | null; approved: { seq: number; at: string; actor: string; role: string } | null } | null; rework: { seq: number; at: string; actor: string; sha: string | null; pr: number | null } }[] };
  const rows = fixture.instances.flatMap((instance): InterventionLedgerRow[] => {
    const workId = uuid(instance.work), work = { key: instance.work, stage: 'review', title: instance.work, candidate: instance.rework.sha ? { sha: instance.rework.sha, pr: instance.rework.pr ?? 0 } : null };
    const decision = instance.decision, approved = decision?.approved;
    return [
      ...(decision ? [{ seq: decision.seq, workId, actor: 'graphyard-master-graphyard-operator', kind: 'decision.requested', at: decision.at, details: undefined, stageBefore: 'review',
        payload: { id: decision.id, action: 'rework', input: { previousWorkerStopped: true, ...(decision.binding ? { binding: decision.binding } : {}) }, requester: { id: 'graphyard-master-graphyard-operator', role: 'operator-agent' } } }] : []),
      ...(decision && approved ? [{ seq: approved.seq, workId, actor: approved.actor, kind: 'decision.approved', at: approved.at, details: undefined, stageBefore: 'review',
        payload: { id: decision.id, action: 'rework', approver: { id: approved.actor, role: approved.role }, requestedBy: 'graphyard-master-graphyard-operator' } }] : []),
      { seq: instance.rework.seq, workId, actor: instance.rework.actor, kind: 'rework', at: instance.rework.at, details: { reason: 'the loop returns the candidate to a worker', previousWorkerStopped: true }, stageBefore: 'review', work: { ...work, stage: 'build' }, grounds: { candidate: work.candidate } as InterventionLedgerRow['grounds'] },
    ];
  }).sort((a, b) => a.seq - b.seq);
  return { rows, work: [] as Work[], now: fixture.window.to };
}

/** GY-1386's 493 build-stage rework instances, replayed as rework-interventions.test.ts replays them. */
function reworkInstances() {
  const fixture = JSON.parse(source('tests/fixtures/gy-1386-rework-instances.json')) as { window: { to: string }; instances: { key: string; workId: string; stage: string; decision: { seq: string; at: string; id: string; binding: string | null } | null; rework: { seq: string; at: string; actor: string; submission: { pr: number; epoch: number } | null; grounds: any } }[] };
  const rows = fixture.instances.flatMap((instance): InterventionLedgerRow[] => [
    ...(instance.decision ? [{ seq: Number(instance.decision.seq), workId: instance.workId, actor: instance.rework.actor, kind: 'decision.requested', at: instance.decision.at, details: null, stageBefore: instance.stage,
      payload: { id: instance.decision.id, action: 'rework', input: { previousWorkerStopped: true, ...(instance.decision.binding ? { binding: instance.decision.binding } : {}) } } }] : []),
    { seq: Number(instance.rework.seq), workId: instance.workId, actor: instance.rework.actor, kind: 'rework', at: instance.rework.at, details: { reason: 'replayed' }, stageBefore: instance.stage,
      work: { key: instance.key, stage: 'build', candidate: instance.rework.grounds.candidate, submission: instance.rework.submission }, grounds: instance.rework.grounds },
  ]).sort((a, b) => a.seq - b.seq);
  const work = [...new Map(fixture.instances.map(instance => [instance.workId, { id: instance.workId, key: instance.key, title: instance.key, stage: 'build' } as unknown as Work])).values()];
  return { rows, work, now: fixture.window.to };
}

const uuid = (name: string) => { const hex = createHash('sha256').update(name).digest('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`; };
const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 12, minute)).toISOString();
const operator = 'graphyard-master-graphyard-operator', worker = 'graphyard-opencode-1', sha = 'a'.repeat(40);

/**
 * One ledger that reaches every exemption rule, and the case beside each that the rule leaves a
 * signal: the loop's autosettle inside the bound and one by hand, an approved and a refused
 * autoscope, a successor re-plan, the loop's audited widening, a routed one, an unstarted re-plan
 * and a started one, a direct-merge window and an operator-authorized merge, a lane-grounded
 * rework, a failed-check round, an open loop round and an open hand request, an undecided scope
 * ask, and a lease-loss inside its settle bound and past it.
 */
function everyRule() {
  let seq = 0;
  const rows: InterventionLedgerRow[] = [], work: Work[] = [];
  const item = (key: string, fields: Record<string, unknown> = {}) => { const entry = { id: uuid(key), key, title: key, stage: 'build', epoch: 1, plannedFiles: ['src/a.ts'], blocker: null, ...fields } as unknown as Work; work.push(entry); return entry; };
  const row = (owner: Work, kind: string, minute: number, actor: string, details: unknown, fields: Partial<InterventionLedgerRow> = {}) =>
    rows.push({ seq: ++seq, workId: owner.id, actor, kind, at: at(minute), details, stageBefore: owner.stage, work: { key: owner.key, stage: owner.stage, title: owner.title, epoch: owner.epoch, plannedFiles: owner.plannedFiles, blocker: owner.blocker ?? null }, ...fields });

  for (const [key, details] of [['GY-1', { origin: 'loop', lapsedAt: at(1), reason: 'verified dead' }], ['GY-2', { reason: 'settled by hand' }], ['GY-3', { origin: 'loop', lapsedAt: at(1), reason: 'late' }]] as const) {
    const fenced = item(key);
    row(fenced, 'quarantine', 0, 'graphyard', { epoch: 1 });
    row(fenced, 'lease.expired', 1, 'graphyard', { epoch: 1, cause: 'expired' });
    row(fenced, 'autosettle', key === 'GY-3' ? 40 : 4, 'graphyard', details);
  }
  for (const state of ['approved', 'refused']) {
    const asked = item(`GY-autoscope-${state}`, { blocker: 'SCOPE NEEDED', scopeRequest: { paths: ['src/b.ts'] } });
    row(asked, 'scope', 0, worker, { epoch: 1, paths: ['src/b.ts'], reason: 'the change needs it' });
    row(asked, 'autoscope', 1, 'graphyard', { epoch: 1, decision: { state } });
  }
  const widen = (key: string, details: (before: string[], after: string[]) => Record<string, unknown>, fields: Record<string, unknown> = {}) => {
    const owner = item(key, fields), before = owner.plannedFiles, after = [...before, 'src/b.ts'];
    if (owner.stage === 'build') { row(owner, 'scope', 0, worker, { epoch: 1, paths: ['src/b.ts'], reason: 'the change needs it' }); row(owner, 'autoscope', 1, 'graphyard', { epoch: 1, decision: { state: 'refused' } }); }
    return { owner, before, after, details: details(before, after) };
  };
  const successor = widen('GY-successor', (before, after) => ({ before: { plannedFiles: before }, intent: { rule: 'successor', reason: 'Re-planned GY-successor onto the successors of the files it plans', plannedFiles: after }, reason: 'Re-planned GY-successor onto the successors of the files it plans', liveScopeWidening: true }));
  const audited = widen('GY-audited', (before, after) => { const reason = `${groundedWideningReason('GY-audited')}a review finding names it: src/b.ts`; return { before: { plannedFiles: before }, intent: { reason, plannedFiles: after }, reason, liveScopeWidening: true }; });
  const authored = widen('GY-authored', (before, after) => ({ before: { plannedFiles: before }, intent: { reason: 'Approve the scope request', plannedFiles: after }, reason: 'Approve the scope request', liveScopeWidening: true }));
  const unstarted = widen('GY-unstarted', (before, after) => ({ before: { epoch: 0, plannedFiles: before }, intent: { reason: 'plan it', plannedFiles: after }, reason: 'plan it' }), { stage: 'ready', epoch: 0 });
  const started = widen('GY-started', (before, after) => ({ before: { epoch: 1, plannedFiles: before, submission: { epoch: 1, pr: 7 }, pipeline: { attempts: [{ end: 'submitted' }] } }, intent: { reason: 'plan it', plannedFiles: after }, reason: 'plan it' }), { stage: 'ready' });
  for (const { owner, after, details } of [successor, audited, authored, unstarted, started]) row(owner, 'requirements', 5, operator, details, { work: { key: owner.key, stage: owner.stage, title: owner.title, epoch: owner.epoch, plannedFiles: after, blocker: null } });
  const routed = widen('GY-routed', () => ({}));
  const routedReason = scopeDecisionReason('GY-routed', { requestedBy: worker, reason: 'the change needs it', decision: { state: 'refused', reason: 'outside the rule', at: at(1), decidedBy: 'graphyard', waitedMs: 0, paths: ['src/b.ts'], requestedBy: worker, requestedAt: at(0) } }, [{ id: 'AC-1', text: 'It works' }], ['src/b.ts'], null);
  row(routed.owner, 'decision.requested', 2, operator, undefined, { payload: { id: uuid('routed'), action: 'requirements', input: { plannedFiles: routed.after }, reason: routedReason } });
  row(routed.owner, 'requirements', 4, operator, { reason: `${routedReason} [decision approved]`.slice(0, 2000), plannedFiles: routed.after, liveScopeWidening: true, before: { plannedFiles: routed.before } }, { work: { key: 'GY-routed', stage: 'build', title: 'GY-routed', plannedFiles: routed.after, blocker: null } });

  const merged = item('GY-merged', { stage: 'done' });
  row(merged, 'merge.reconciled', 3, 'graphyard', { directMerge: true, mergeSha: sha, mergedAt: at(3) });
  const bypassed = item('GY-bypassed');
  row(bypassed, 'merge.reconciliation.refused', 2, 'graphyard', { mergeSha: sha, reasons: ['review missing'], mergedAt: at(2) });
  row(bypassed, 'merge.operator-authorized', 6, operator, { mergeSha: sha, operator: 'vish', reason: 'hotfix' });

  const decide = (owner: Work, id: string, minute: number, requester: string, binding: string | null) =>
    row(owner, 'decision.requested', minute, operator, undefined, { payload: { id: uuid(id), action: 'rework', input: { previousWorkerStopped: true, ...(binding ? { binding } : {}) }, requester: { id: operator, role: requester } } });
  const candidate = { sha, pr: 9 };
  const lane = item('GY-lane', { candidate });
  decide(lane, 'lane', 1, 'coordinator', null);
  row(lane, 'decision.approved', 2, laneApprover, undefined, { payload: { id: uuid('lane'), action: 'rework', ground: 'standing change request', approver: { id: laneApprover, role: 'risk-lane' } } });
  row(lane, 'rework', 3, operator, { reason: 'lane rework' }, { work: { key: 'GY-lane', stage: 'build', title: 'GY-lane', epoch: 1, candidate } });
  const failed = item('GY-failed-check', { candidate });
  decide(failed, 'failed', 1, 'coordinator', `${sha}:ci:test`);
  row(failed, 'rework', 3, operator, { reason: 'checks failed' }, { work: { key: 'GY-failed-check', stage: 'build', title: 'GY-failed-check', epoch: 1, candidate } });
  const handRework = item('GY-hand-rework', { candidate });
  decide(handRework, 'hand-rework', 1, 'coordinator', null);
  row(handRework, 'rework', 3, operator, { reason: 'by hand' }, { work: { key: 'GY-hand-rework', stage: 'build', title: 'GY-hand-rework', epoch: 1, candidate } });
  decide(item('GY-open-loop', { candidate: { sha: 'b'.repeat(40), pr: 3 } }), 'open-loop', 2, 'operator-agent', `${'c'.repeat(40)}:verdict:graphyard-reviewer[bot]`);
  decide(item('GY-open-hand', { candidate: { sha: 'b'.repeat(40), pr: 4 } }), 'open-hand', 2, 'coordinator', null);

  const undecided = item('GY-undecided', { blocker: 'SCOPE NEEDED', scopeRequest: { paths: ['src/c.ts'] } });
  row(undecided, 'scope', 3, worker, { epoch: 1, paths: ['src/c.ts'], reason: 'needs it' });
  row(undecided, 'blocked', 4, worker, { reason: 'cannot continue' });
  for (const [key, minute] of [['GY-lease-fresh', 58], ['GY-lease-stale', 30]] as const) {
    const lost = item(key, { epoch: 2, lease: null, escalations: [{ trigger: 'lease-loss', reason: leaseLossReason({ owner: worker, epoch: 2 }), at: at(minute), actor: 'graphyard' }] });
    row(lost, 'lease.expired', minute, 'graphyard', { epoch: 2, cause: 'expired' }, { work: { key, stage: 'build', title: key, epoch: 2, escalations: (lost as any).escalations } });
  }
  return { rows, work, now: at(60) };
}

const digests = {
  reworkRounds: '02b6250c6e0d0cfa0725d5c828e32d2bf16ebb6c68cbffbdde099aa2a7c1fce8',
  reworkInstances: '4b473d0fe00a81835f6a808081b66db0acf7f9926a864becf0802569255be281',
  everyRule: 'ad9a1d5d0d57fa11212408b8eb5063b51fb42d4ab63a2851811c5fd0259c5c17',
};

test('unit:intervention-exemptions-fold-unchanged — the report over the intervention fixtures and over a ledger reaching every exemption rule is the one the unsplit fold produced', () => {
  const actual = { reworkRounds: reworkRounds(), reworkInstances: reworkInstances(), everyRule: everyRule() };
  if (process.env.GY_PRINT_DIGESTS) console.log(JSON.stringify(Object.fromEntries(Object.entries(actual).map(([name, { rows, work, now }]) => [name, digest(rows, work, now)]))));
  for (const [name, { rows, work, now }] of Object.entries(actual)) assert.equal(digest(rows, work, now), digests[name as keyof typeof digests], `${name}: the fold's output changed`);
});

test('unit:intervention-exemptions-module — the fold consults one ordered list of named exemption predicates from src/intervention-exemptions.ts, and src/interventions.ts is at least 150 lines shorter', () => {
  assert.deepEqual(interventionExemptions.map(entry => entry.name), [
    'approved-autoscope', 'successor-replan', 'audited-scope-widening', 'routed-scope-widening', 'unstarted-replan',
    'routine-rework-ground', 'lane-rework-ground', 'failed-check-round', 'loop-rework-round',
    'direct-merge-window', 'loop-autosettle-in-bound', 'answered-off-ledger', 'undecided-scope-request', 'lease-loss-resolve',
  ]);
  assert.ok(interventionExemptions.every(entry => typeof entry.exempts === 'function'), 'one predicate per rule');
  const fold = source('src/interventions.ts');
  // 770 lines on main (eac0fe0b29) before the split.
  assert.ok(fold.split('\n').length - 1 <= 770 - 150, `src/interventions.ts has ${fold.split('\n').length - 1} lines`);
  assert.match(fold, /from '\.\/intervention-exemptions\.js'/);
  for (const inline of ['loopSettledInBound(', 'routineReworkGround(', 'failedCheckRound(', 'loopRound(', 'wideningSettlement(', 'unstarted(', 'endedLeaseLoss(', 'details.directMerge', "intent.rule === 'successor'", "decision.state === 'approved'", 'laneApprover'])
    assert.ok(!fold.includes(inline), `the fold no longer judges ${inline} inline`);

  // Each rule exempts its own moment and nothing else; the first that holds names it.
  const candidate = { sha: 'a'.repeat(40) };
  const decision = { seq: 1, at: at(0), id: 'd', stage: 'review' as const, binding: null, loopRequested: true, approvedBy: null };
  const item = { id: uuid('item'), key: 'GY-1', stage: 'build', epoch: 2, lease: null, blocker: 'SCOPE NEEDED', scopeRequest: null } as unknown as Work;
  const lost = { trigger: 'lease-loss' as const, reason: leaseLossReason({ owner: worker, epoch: 2 }), at: at(58), actor: 'graphyard' };
  const requirements = { at: 'requirements', details: {}, reason: 'revised', widened: true, asked: false, routed: [], stage: 'build', work: { epoch: 1, blocker: null }, blockerBefore: null } as const;
  const cases: [ExemptionMoment, string | null][] = [
    [{ at: 'autoscope', decision: { state: 'approved' } }, 'approved-autoscope'],
    [{ at: 'autoscope', decision: { state: 'refused' } }, null],
    [{ ...requirements, details: { intent: { rule: 'successor' } } }, 'successor-replan'],
    [{ ...requirements, details: { intent: { reason: `${groundedWideningReason('GY-1')}a review finding names it` } } }, 'audited-scope-widening'],
    [{ ...requirements, stage: 'ready', details: { before: { epoch: 0 } }, work: { epoch: 0, blocker: null } }, 'unstarted-replan'],
    [{ ...requirements, stage: 'ready', asked: true, details: { before: { epoch: 0 } }, work: { epoch: 0, blocker: null } }, null],
    [requirements, null],
    [{ at: 'rework', decision: { ...decision, binding: `${candidate.sha}:verdict:graphyard-reviewer[bot]` }, asked: true, grounds: { candidate } as ReworkGrounds, candidate }, 'routine-rework-ground'],
    [{ at: 'rework', decision: { ...decision, self: true }, asked: false, grounds: null, candidate }, 'lane-rework-ground'],
    [{ at: 'rework', decision: { ...decision, self: true }, asked: true, grounds: null, candidate }, null],
    [{ at: 'rework', decision: { ...decision, binding: `${candidate.sha}:ci:test` }, asked: false, grounds: null, candidate }, 'failed-check-round'],
    [{ at: 'rework', decision: { ...decision, binding: 'x:base', approvedBy: laneApprover }, asked: false, grounds: null, candidate }, 'loop-rework-round'],
    [{ at: 'rework', decision: { ...decision, binding: 'x:base' }, asked: false, grounds: null, candidate }, null],
    [{ at: 'open-rework', decision: { ...decision, binding: 'x:base' }, asked: false, grounds: null, candidate }, 'loop-rework-round'],
    [{ at: 'merge', details: { directMerge: true } }, 'direct-merge-window'],
    [{ at: 'merge', details: {} }, null],
    [{ at: 'settlement', kind: 'autosettle', details: { origin: 'loop', lapsedAt: at(0) }, when: at(5) }, 'loop-autosettle-in-bound'],
    [{ at: 'settlement', kind: 'recover', details: { origin: 'loop', lapsedAt: at(0) }, when: at(5) }, null],
    [{ at: 'open-ask', ask: { seq: 1, at: at(0), stage: 'build', kind: 'blocked-report', blocked: 'x', paths: [], sources: [] }, item: { ...item, blocker: null } as Work }, 'answered-off-ledger'],
    [{ at: 'open-ask', ask: { seq: 1, at: at(0), stage: 'build', kind: 'scope-request', blocked: 'x', paths: ['a'], sources: [] }, item }, 'undecided-scope-request'],
    [{ at: 'open-ask', ask: { seq: 1, at: at(0), stage: 'build', kind: 'scope-request', blocked: 'x', paths: ['a'], trigger: 'refused-by-loop', sources: [] }, item }, null],
    [{ at: 'open-escalation', item, escalation: lost, now: at(60) }, 'lease-loss-resolve'],
    [{ at: 'open-escalation', item, escalation: { ...lost, at: at(30) }, now: at(60) }, null],
  ];
  for (const [moment, expected] of cases) assert.equal(exemption(moment), expected, JSON.stringify(moment));
  const routed = scopeDecisionReason('GY-1', { requestedBy: worker, reason: 'needs it', decision: { state: 'refused', reason: 'outside the rule', at: at(1), decidedBy: 'graphyard', waitedMs: 0, paths: ['src/b.ts'], requestedBy: worker, requestedAt: at(0) } }, [{ id: 'AC-1', text: 'It works' }], ['src/b.ts'], null);
  assert.equal(exemption({ ...requirements, details: { reason: routed }, reason: routed, routed: [routed] }), 'routed-scope-widening');
});
