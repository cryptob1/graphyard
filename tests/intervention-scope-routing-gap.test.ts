import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { detectPatterns, foldInterventions, type InterventionLedgerRow } from '../src/interventions.js';
import { exemption } from '../src/intervention-exemptions.js';
import { routedScopeJudgement } from '../src/model/scope-provenance.js';
import { scopeBlockedBudgetMs } from '../src/model/scope.js';
import type { Work } from '../src/model.js';

// GY-1755 names this file for its proof manual:intervention-pattern-scope-widening-build.
//
// On 2026-10-13 the 7-day pattern read four build-stage scope widenings: GY-1746, GY-1747, GY-1752 and
// GY-1751. Each was an additive ask the widening rule refused and the loop routed to the independent
// approver, who approved it; the operator never stepped in. But the loop refuses in its scope step and
// routes in its decision step, behind dispatch and reclaim, and the ledger shows the gap (refusal
// to decision.requested): GY-1746 8m17s, GY-1747 8m50s, GY-1752 5m12s, GY-1751 2m40s. The pattern was
// detected at 00:07:19Z inside that gap for all four, and the fold counted each refused ask with no
// route on the record as a person's wait (36 s, 82 s, 405 s and 472 s). An ask the loop owes a route
// is the loop's, so the fold now leaves it out (loopOwesScopeRoute) until it outlasts the bound the
// loop promises, a routed decision settles without applying, or nothing can route it.

const uuid = (name: string) => { const hex = createHash('sha256').update(name).digest('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`; };
const detectedAt = '2026-10-13T00:07:19.555Z';
const operator = 'graphyard-master-graphyard-operator';
const policy = { threshold: 3, windowDays: 7 };
const criteria = [{ id: 'AC-1', text: 'The change is made', proofs: [] }];

// key, epoch, worker, planned, asked, asked at, refused at, ledger seqs (scope, autoscope), when the loop routed it
const instances = [
  ['GY-1746', 3, 'graphyard-opencode-2', ['src/worker-sandbox.ts'], ['tests/registry-discovery.test.ts'], '2026-10-13T00:06:42.710Z', '2026-10-13T00:06:51.598Z', [2534057, 2534070], '2026-10-13T00:15:08.632Z'],
  ['GY-1747', 6, 'graphyard-codex-1', ['src/master-verification.ts'], ['tests/post-deploy-criteria.test.ts', 'tests/post-deploy-follow-ups.test.ts'], '2026-10-13T00:05:57.605Z', '2026-10-13T00:06:42.625Z', [2534029, 2534055], '2026-10-13T00:15:32.687Z'],
  ['GY-1752', 1, 'graphyard-opencode-1', ['tests/fault-class-loop.test.ts'], ['src/auto-dispatch.ts', 'docs/'], '2026-10-13T00:00:34.913Z', '2026-10-13T00:04:19.236Z', [2533851, 2533989], '2026-10-13T00:09:31.144Z'],
  ['GY-1751', 1, 'graphyard-claude-2', ['tests/fault-class-decision.test.ts'], ['src/daemon/acceptance.ts', 'src/daemon/state.ts'], '2026-10-12T23:59:27.529Z', '2026-10-12T23:59:37.082Z', [2533807, 2533831], '2026-10-13T00:02:17.961Z'],
] as const;

const refusalReason = 'are outside what this item\'s own criteria and the repository\'s documentation rule imply; an operator decides scope the item does not already carry';
function record([key, epoch, worker, planned, asked, askedAt, refusedAt, [scopeSeq, autoscopeSeq], routedAt]: typeof instances[number], routed: boolean, lease: string | null) {
  const id = uuid(key);
  const decision = { at: refusedAt, epoch, paths: [...asked], state: 'refused' as const, reason: `${asked.join(', ')} ${refusalReason}`, waitedMs: 1000, decidedBy: 'graphyard', requestedAt: askedAt, requestedBy: worker };
  const work = { id, key, title: key, stage: 'build', epoch, plannedFiles: [...planned], criteria, blocker: null,
    lease: lease ? { owner: worker, epoch, expiresAt: lease } : null, scopeRequest: { epoch, paths: [...asked], reason: 'needed', requestedBy: worker, at: askedAt, decision }, escalations: [], violations: [] } as unknown as Work;
  const rows: InterventionLedgerRow[] = [
    { seq: scopeSeq, workId: id, actor: worker, kind: 'scope', at: askedAt, stageBefore: 'build', details: { epoch, paths: [...asked], reason: 'needed' }, work: { key, title: key, stage: 'build', epoch, plannedFiles: [...planned], blocker: null } },
    { seq: autoscopeSeq, workId: id, actor: 'graphyard-master', kind: 'autoscope', at: refusedAt, stageBefore: 'build', details: { epoch, before: { blocker: null, plannedFiles: [...planned] }, decision }, work: { key, title: key, stage: 'build', epoch, plannedFiles: [...planned], blocker: `Scope request refused: ${decision.reason}` } },
  ];
  if (routed) rows.push({ seq: autoscopeSeq + 100, workId: id, actor: operator, kind: 'decision.requested', at: routedAt, stageBefore: 'build', details: null, work: null,
    payload: { id: `decision-${key}`, action: 'requirements', input: { plannedFiles: [...planned, ...asked], answers: { epoch, at: askedAt } }, reason: `Widen ${key}'s plannedFiles with ${asked.join(', ')}: ${routedScopeJudgement}`, requester: { role: 'operator-agent' } } });
  return { work, rows };
}
const widenings = (rows: InterventionLedgerRow[], work: Work[], now: string) => foldInterventions(rows, work, now).interventions.filter(entry => entry.kind === 'scope-widening' && entry.stage === 'build');

test('manual:intervention-pattern-scope-widening-build — each linked instance, read at the pattern\'s own detection instant with the loop yet to route it, is the loop\'s and no intervention; the four no longer cross the threshold', () => {
  const lease = '2026-10-13T01:00:00.000Z';
  const all = instances.map(entry => record(entry, false, lease));
  for (const [index, entry] of instances.entries()) {
    const { work, rows } = all[index];
    assert.equal(exemption({ at: 'open-ask', ask: { seq: entry[7][1], at: entry[5], stage: 'build', kind: 'scope-request', blocked: 'x', paths: [...entry[4]], trigger: 'refused-by-loop', epoch: entry[1], sources: [] }, item: work, now: detectedAt }), 'loop-owes-scope-route', entry[0]);
    assert.deepEqual(widenings(rows, [work], detectedAt), [], `${entry[0]} left no instance`);
  }
  const rows = all.flatMap(entry => entry.rows), works = all.map(entry => entry.work);
  const found = detectPatterns(foldInterventions(rows, works, detectedAt).interventions, works, policy, detectedAt).find(pattern => pattern.kind === 'scope-widening' && pattern.stage === 'build');
  assert.ok(!found || found.count < policy.threshold, `the pattern is below the threshold, not ${found?.count}`);
});

test('manual:intervention-pattern-scope-widening-build — the same asks are counted when nothing will route them: past the loop\'s bound, with the attempt ended, or once a routed decision settled without applying', () => {
  for (const entry of instances) {
    const live = record(entry, false, '2026-10-13T02:00:00.000Z');
    const past = new Date(Date.parse(entry[5]) + scopeBlockedBudgetMs + 60_000).toISOString();
    assert.equal(widenings(live.rows, [live.work], past).length, 1, `${entry[0]} past the bound`);
    const ended = record(entry, false, null);
    assert.equal(widenings(ended.rows, [ended.work], detectedAt).length, 1, `${entry[0]} attempt ended`);
    const routed = record(entry, true, '2026-10-13T02:00:00.000Z');
    assert.equal(widenings(routed.rows, [routed.work], new Date(Date.parse(entry[8]) + 60_000).toISOString()).length, 0, `${entry[0]} routed and held by the approver`);
    const returned = [...routed.rows, { seq: entry[7][1] + 200, workId: routed.work.id, actor: 'graphyard-approver-graphyard', kind: 'decision.stale', at: new Date(Date.parse(entry[8]) + 60_000).toISOString(), stageBefore: 'build' as const, details: null, work: null, payload: { id: `decision-${entry[0]}`, action: 'requirements' } }];
    assert.equal(widenings(returned, [routed.work], new Date(Date.parse(entry[8]) + 120_000).toISOString()).length, 1, `${entry[0]} routed decision went stale`);
  }
});
