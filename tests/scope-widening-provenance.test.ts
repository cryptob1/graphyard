import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { foldInterventions, type InterventionLedgerRow } from '../src/interventions.js';
import { blockerScopeDecision } from '../src/daemon/decisions.js';
import { scopeDecisionReason } from '../src/model/scope.js';
import { groundedWideningReason, handScopeWideningRefusal, routedScopeAsk, routedWideningDecision, scopeAskCommand, wideningSettlement } from '../src/model/scope-provenance.js';
import { nextCommand } from '../src/model/board.js';
import { scopeRequestAttention } from '../src/cli/owed-report.js';
import type { Work } from '../src/model.js';

// GY-1388: 427 build-stage scope widenings in 7 days, most of them settled by the control plane on
// its own — the loop's audited grounds, or the independent approver on an ask the loop routed — and
// a partly widened ask counted twice. Each test replays the ledger shape of a linked instance through
// the real fold and the real reason builders.

const workId = '7b2e50cf-577b-4096-90ac-6ad020286a56', key = 'GY-1381';
const operator = 'graphyard-master-graphyard-operator', approver = 'graphyard-approver-graphyard';
const criteria = [{ id: 'AC-1', text: 'The dashboard reads one row per item' }];
const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 12, minute)).toISOString();
let seq = 0;
const row = (kind: string, minute: number, actor: string, details: Record<string, unknown>, plannedFiles: string[], blocker: string | null = null): InterventionLedgerRow =>
  ({ seq: ++seq, workId, actor, kind, at: at(minute), details, work: { key, stage: 'build', title: 'Dashboard reads', plannedFiles, blocker } });
const ask = (minute: number, paths: string[], planned: string[]) => [
  row('scope', minute, 'graphyard-opencode-1', { epoch: 1, paths, reason: 'the change needs them' }, planned),
  row('autoscope', minute + 1, 'graphyard', { epoch: 1, decision: { state: 'refused', reason: `${paths.join(', ')} is outside what this item's own criteria imply` } }, planned),
];
/** The loop's widening on its own grounds, as an operator agent's row records it (engine.ts). */
const grounded = (minute: number, before: string[], after: string[]) => {
  const reason = `${groundedWideningReason(key)}a review finding names it …: ${after.filter(path => !before.includes(path)).join(', ')} (review 5436383318). graphyard-opencode-1 asked because the change needs them`;
  return row('requirements', minute, operator, { before: { plannedFiles: before }, intent: { reason, plannedFiles: after }, reason, liveScopeWidening: true }, after);
};
/**
 * A requirements decision requested by the operator agent and, once the approver approves it, applied
 * under its requester (server/decisions.ts applyThroughEngine): the reason with its audit suffix, cut
 * to the 2000-character bound, which a routed reason already fills.
 */
const decided = (minute: number, before: string[], after: string[], decisionReason: string) => [
  { seq: ++seq, workId, actor: operator, kind: 'decision.requested', at: at(minute), details: undefined, payload: { id: '0b8f3a52-5d6e-4c4f-9a43-1d2b3c4d5e6f', action: 'requirements', input: { plannedFiles: after }, reason: decisionReason } } as InterventionLedgerRow,
  row('requirements', minute + 2, operator, { reason: `${decisionReason} [decision 0b8f3a52-5d6e-4c4f-9a43-1d2b3c4d5e6f, requested by ${operator}, approved by ${approver}: Justified additive widening]`.slice(0, 2000), plannedFiles: after, liveScopeWidening: true, before: { plannedFiles: before } }, after),
];
/** A widening a master session authored itself (`master scope`). */
const authored = (minute: number, before: string[], after: string[]) => {
  const reason = `Approve graphyard-opencode-1's scope request: the change needs them`;
  return row('requirements', minute, operator, { before: { plannedFiles: before }, intent: { reason, plannedFiles: after }, reason, liveScopeWidening: true }, after);
};
const routedReason = (paths: string[], named = criteria) => scopeDecisionReason(key, { requestedBy: 'graphyard-opencode-1', reason: 'the change needs them', decision: { state: 'refused', reason: 'outside the rule', at: at(1), decidedBy: 'graphyard', waitedMs: 0, paths, requestedBy: 'graphyard-opencode-1', requestedAt: at(0) } }, named, paths, null);
const widenings = (rows: InterventionLedgerRow[]) => foldInterventions(rows, [], at(59)).interventions.filter(entry => entry.kind === 'scope-widening');

test('unit:scope-widening-settled-by-control-plane — a widening the loop grants on its own audited grounds is no intervention (GY-1381 shape)', () => {
  const planned = ['src/server/routes/board.ts'], wide = [...planned, 'src/server/main.ts', 'docs/dashboard.md'];
  assert.deepEqual(widenings([...ask(0, ['src/server/main.ts', 'docs/dashboard.md'], planned), grounded(3, planned, wide)]), []);
  // The loop's reason is built by the very helper cycle-scope.ts writes it with, so the two cannot drift.
  return readFile(new URL('../src/daemon/cycle-scope.ts', import.meta.url), 'utf8').then(source => assert.match(source, /\$\{groundedWideningReason\(item\.key\)\}a review finding names it/));
});

test('unit:scope-widening-settled-by-control-plane — the independent approver settling an ask the loop routed is no intervention (GY-1292, GY-1383 shape)', () => {
  const planned = ['docs/operations.md'], paths = ['tests/store-init.test.ts', 'tests/workers-tab.test.ts'];
  assert.deepEqual(widenings([...ask(0, paths, planned), ...decided(4, planned, [...planned, ...paths], routedReason(paths))]), []);
  // A routed planned-file-scope blocker is the same decision, with no master involved (GY-1008).
  const blocked = { key, stage: 'build', plannedFiles: [], criteria, blocker: 'SCOPE NEEDED: src/model/queue.ts (the carry reads the queue entry) for commit 8106499e9f' } as unknown as Work;
  const decision = blockerScopeDecision(blocked);
  assert.ok(decision, 'the loop routes the blocker to the approver');
  const rows = [row('blocked', 0, 'graphyard-opencode-1', { reason: blocked.blocker }, [], blocked.blocker), ...decided(5, [], ['src/model/queue.ts'], decision!.reason)];
  assert.deepEqual(widenings(rows), []);
  assert.equal(wideningSettlement(rows[2].details, [decision!.reason]), 'routed-approver');
  // The routed reason fills the bound, so the applied row carries no audit suffix at all: it is read by the reason it was requested with.
  const long = routedReason(['tests/a.test.ts'], [{ id: 'AC-1', text: 'The dashboard reads one row per item. '.repeat(60) }]);
  assert.equal(long.length, 2000);
  assert.deepEqual(widenings([...ask(20, ['tests/a.test.ts'], planned), ...decided(24, planned, [...planned, 'tests/a.test.ts'], long)]), []);
});

test('unit:scope-widening-settled-by-control-plane — a partly widened ask is one signal, never two: settled by the approver it is none, finished by a master it is one with the whole wait (GY-1385 shape)', () => {
  const planned = ['src/throughput.ts'], both = ['src/daemon/cycle-delivery.ts', 'src/daemon/effects.ts'], first = [...planned, both[0]], all = [...planned, ...both];
  assert.deepEqual(widenings([...ask(0, both, planned), grounded(2, planned, first), ...decided(6, first, all, routedReason([both[1]]))]), []);
  const finished = widenings([...ask(10, both, planned), grounded(12, planned, first), authored(20, first, all)]);
  assert.equal(finished.length, 1, JSON.stringify(finished));
  assert.equal(finished[0].requestedAt, at(10), 'the wait runs from the worker\'s ask, not from the partial widening');
  assert.equal(finished[0].trigger, 'refused-by-loop');
  assert.equal(finished[0].resolvedAt, at(20));
});

test('unit:scope-widening-settled-by-control-plane — a widening somebody authors still counts, whatever its wording quotes', () => {
  const planned = ['src/a.ts'];
  assert.equal(widenings([...ask(0, ['src/b.ts'], planned), authored(5, planned, [...planned, 'src/b.ts'])]).length, 1);
  // An operator agent quoting the routed judgement in its own words is still the operator: only an applied routed decision carries it.
  const quoted = routedReason(['src/c.ts']);
  assert.equal(wideningSettlement({ intent: { reason: quoted }, reason: quoted }, [quoted]), null);
  // A decision a master requested in its own words is applied the same way, and counts.
  assert.equal(widenings([...ask(30, ['src/c.ts'], planned), ...decided(35, planned, [...planned, 'src/c.ts'], 'GY-1381: AC-1 needs src/c.ts')]).length, 1);
});

test('unit:routed-scope-ask-not-pre-empted — the guard and the board leave a routed ask to the approver, and only while it judges it', () => {
  const now = Date.parse(at(10));
  const refused = { at: at(1), state: 'refused' as const, reason: 'outside the rule', decidedBy: 'graphyard', waitedMs: 0, paths: ['src/b.ts'], requestedBy: 'graphyard-opencode-1', requestedAt: at(0), epoch: 1 };
  const item = { key, plannedFiles: ['src/a.ts'], criteria, lease: { owner: 'graphyard-opencode-1', epoch: 1, expiresAt: at(30) }, blocker: 'Scope request refused: outside the rule',
    scopeRequest: { epoch: 1, paths: ['src/b.ts'], reason: 'the change needs it', requestedBy: 'graphyard-opencode-1', at: at(0), decision: refused } } as unknown as Work;
  assert.ok(routedScopeAsk(item, ['src/a.ts', 'src/b.ts'], now), 'a widening covering the routed ask pre-empts it');
  assert.equal(routedScopeAsk(item, ['src/a.ts', 'docs/x.md'], now), null, 'one leaving the asked path alone does not');
  assert.equal(routedScopeAsk({ ...item, scopeRequest: { ...item.scopeRequest!, decision: { ...refused, decidedBy: approver } } }, ['src/a.ts', 'src/b.ts'], now), null, 'an approver\'s refusal leaves it the master\'s');
  assert.equal(routedScopeAsk({ ...item, scopeRequest: { ...item.scopeRequest!, decision: undefined } }, ['src/a.ts', 'src/b.ts'], now), null, 'an undecided ask is the rule\'s next step, not the approver\'s');
  assert.equal(routedScopeAsk({ ...item, lease: { ...item.lease!, expiresAt: at(5) } }, ['src/a.ts', 'src/b.ts'], now), null, 'an ended attempt\'s ask is moot');
  const request = item.scopeRequest!;
  const pending = [{ id: 'd-1', ended: false }], ended = [{ id: 'd-0', ended: true }];
  assert.match(handScopeWideningRefusal(key, request, pending, now)!, /routed it as requirements decision d-1/);
  assert.match(handScopeWideningRefusal(key, request, [], now)!, /within 15 minutes of the rule's refusal/);
  assert.equal(handScopeWideningRefusal(key, request, ended, now), null, 'a decision that ended leaves it the master\'s');
  assert.equal(handScopeWideningRefusal(key, request, [], Date.parse(at(17))), null, 'no routed decision within the bound (no approver serves): the master\'s');
  assert.match(handScopeWideningRefusal(key, request, [...ended, ...pending], Date.parse(at(50)))!, /d-1/, 'a pending decision holds past the bound');
  assert.equal(scopeAskCommand({ ...item, scopeRequest: { ...request, decision: { ...refused, decidedBy: approver } } }, now), `graphyard master scope ${key}`);
  // The board and `master status` name exactly what the guard leaves open (GY-1388 review PRRT_kwDOUZby-s6pw-MH, -MK).
  const late = Date.parse(at(17)), stillLeased = { ...item, lease: { ...item.lease!, expiresAt: at(90) } } as Work;
  for (const [decisions, when, holds] of [[[], now, true], [pending, now, true], [ended, now, false], [[], late, false], [pending, Date.parse(at(50)), true], [ended, late, false]] as const) {
    const guard = handScopeWideningRefusal(key, request, decisions, when) !== null;
    assert.equal(guard, holds);
    const command = holds ? `graphyard master decisions ${key}` : `graphyard master scope ${key}`;
    assert.equal(scopeAskCommand(stillLeased, when, decisions), command, `the command agrees with the guard (${JSON.stringify(decisions)} at ${new Date(when).toISOString()})`);
    assert.equal(nextCommand(stillLeased, 'blocked', 'master', undefined, when, decisions), command, 'the board names what the guard allows');
    const watches = decisions.map(entry => ({ work: key, action: 'requirements', decision: entry.id, settledAt: entry.ended ? at(9) : null, scope: { epoch: 1, at: at(0) } }));
    const owed = scopeRequestAttention({ work: [stillLeased], now: new Date(when).toISOString() }, watches);
    assert.deepEqual(owed.map(entry => entry.next), holds ? [] : [command], 'master status owes the master only what the guard lets it run');
  }
});

test('unit:scope-widening-settled-by-control-plane — a routed decision is known by the ask it answers, and an applied one whose request lies beyond the report\'s reach still reads as routed', () => {
  assert.equal(routedWideningDecision({ action: 'requirements', input: { plannedFiles: [], answers: { epoch: 1, at: at(0) } }, reason: 'GY-1381: in a master\'s words' }), true);
  assert.equal(routedWideningDecision({ action: 'requirements', input: { plannedFiles: [] }, reason: 'GY-1381: in a master\'s words' }), false);
  const reason = routedReason(['src/d.ts']);
  assert.equal(wideningSettlement({ reason: `${reason} [decision 0b8f3a52, requested by ${operator}, approved by ${approver}: ok]` }, []), 'routed-approver');
  const planned = ['src/a.ts'];
  // Only the application lies inside the window: the request row before it is beyond the reach.
  assert.deepEqual(widenings([...ask(40, ['src/d.ts'], planned), decided(44, planned, [...planned, 'src/d.ts'], reason)[1]]), []);
});
