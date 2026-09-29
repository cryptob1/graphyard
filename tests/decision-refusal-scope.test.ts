import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { decisionSituation, foldDecisions, standingRefusal, unansweredRefusal, type DecisionEvent } from '../src/model/approval.js';
import { Refusal, RefusedResponse } from '../src/model/refusal.js';
import { requestDecision } from '../src/server/decisions.js';
import { canonical } from '../src/server/decision-ledger.js';
import { emptyDaemonState, refusalNamedIn, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Observation, Principal, Work } from '../src/model.js';
import type { Services } from '../src/server/routes.js';

/**
 * GY-229: on 2026-09-25 GY-173's candidate conflicted with its base and needed a sync rework, and
 * `master decide GY-173 rework` was refused because a rework refused hours earlier, for an older
 * candidate on an older base, had the same input. Rework input is the bare attestation
 * `{ previousWorkerStopped: true }`, so one refusal blocked every later rework on the item. A
 * refusal now stands only against the candidate head and base it judged.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const minute = 60_000;
const shaA = 'a'.repeat(40), shaB = 'c'.repeat(40), base = 'b'.repeat(40), base2 = 'd'.repeat(40);
const input = { previousWorkerStopped: true };
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function item(sha: string, baseSha = base, observedAt = iso(-20_000)): Work {
  const candidate = { sha, baseSha, pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' };
  const observation = {
    clockOffset: { min: 0, max: 0 }, candidate, checks: [{ name: 'test', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'independent-reviewer', sha, state: 'CHANGES_REQUESTED' }],
    protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/loop.ts'], scopeFiles: [], at: observedAt,
  } as Observation;
  return {
    id: '00000000-0000-4000-8000-000000000042', key: 'GY-42', title: 'Refusals judge one candidate', description: '', type: 'bug', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:loop'] }], policy: { checks: ['test'], review: true },
    plannedFiles: ['src/loop.ts'], stage: 'review', revision: 5, policyRevision: 1, createdAt: iso(-4 * 60 * minute), updatedAt: iso(0),
    stageEnteredAt: iso(-30 * minute), ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: 42 },
    candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null, violations: [],
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }],
  } as unknown as Work;
}

/**
 * The request route over an in-memory ledger: the same code path the control plane runs, with the
 * handful of queries it makes answered from a list of events.
 */
function ledger(work: { current: Work }) {
  const events: { actor: string; kind: string; payload: any; created_at: string }[] = [];
  const receipts = new Map<string, { fingerprint: string; result: unknown }>();
  const db = {
    query: async (sql: string, params: any[] = []) => {
      if (sql.startsWith('SELECT * FROM receipts')) { const row = receipts.get(`${params[0]}:${params[1]}`); return { rows: row ? [row] : [] }; }
      if (sql.startsWith('INSERT INTO receipts')) { receipts.set(`${params[0]}:${params[1]}`, { fingerprint: params[2], result: JSON.parse(params[3]) }); return { rows: [] }; }
      if (sql.startsWith('SELECT document FROM work_items')) return { rows: [{ document: work.current }] };
      if (sql.startsWith('SELECT actor, kind, payload, created_at FROM events')) return { rows: events.filter(event => event.kind.startsWith('decision.')) };
      if (sql.startsWith('SELECT count(*)::int AS count FROM events')) return { rows: [{ count: 0 }] };
      if (sql.startsWith('INSERT INTO events')) { events.push({ actor: params[1], kind: params[2], payload: JSON.parse(params[3]), created_at: new Date(clock + events.length).toISOString() }); return { rows: [] }; }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const services = { repository: 'owner/project', principals: [], engine: { store: { transaction: (body: (db: unknown, now: Date) => unknown) => body(db, new Date(clock)) } } } as unknown as Services;
  return { events, services };
}

const operator: Principal = { id: 'graphyard-master-operator', role: 'admin' } as Principal;
let keys = 0;
const request = (services: Services, work: Work, reason: string) =>
  requestDecision(services, operator, work.id, { action: 'rework', input, reason }, `key-${++keys}`);

test('unit:refusal-scoped-to-candidate — a rework refused on candidate A does not block a rework on candidate B or on a new base, and a repeat on candidate A is still refused', async () => {
  const work = { current: item(shaA) };
  const { events, services } = ledger(work);

  // A rework is requested on candidate A, and the approver refuses it.
  const refused = await request(services, work.current, 'The verdict on candidate A needs another round');
  assert.deepEqual(events.at(-1)!.payload.situation, { sha: shaA, baseSha: base }, 'the request records the candidate and base it was made against');
  events.push({ actor: 'graphyard-approver', kind: 'decision.declined', payload: { id: refused.id, reason: 'The verdict was already answered' }, created_at: iso(1000) });

  // The same request on the same candidate is still a retry of the refused one.
  await assert.rejects(request(services, work.current, 'The verdict on candidate A needs another round, again'),
    (error: Error) => error.message.includes(refused.id) && error.message.includes(shaA.slice(0, 12)));

  // The item moves to candidate B: a new rework request judges a new situation and is accepted.
  work.current = item(shaB);
  const onB = await request(services, work.current, 'Candidate B conflicts with the base and needs a sync');
  assert.equal(onB.state, 'requested');
  assert.deepEqual(onB.situation, { sha: shaB, baseSha: base });
  events.push({ actor: 'graphyard-approver', kind: 'decision.declined', payload: { id: onB.id, reason: 'Not yet' }, created_at: iso(2000) });

  // The same head rebuilt on a new base is a new situation as well.
  work.current = item(shaB, base2);
  const onNewBase = await request(services, work.current, 'Candidate B on the new base still conflicts');
  assert.equal(onNewBase.state, 'requested');
  events.push({ actor: 'graphyard-approver', kind: 'decision.declined', payload: { id: onNewBase.id, reason: 'Not yet' }, created_at: iso(3000) });

  // Back on candidate A, its refusal still stands until a request answers it by id.
  work.current = item(shaA);
  await assert.rejects(request(services, work.current, 'Candidate A needs another round'), (error: Error) => error.message.includes(refused.id));
  const answered = await request(services, work.current, `New grounds for candidate A: answers refused rework decision ${refused.id}`);
  assert.equal(answered.state, 'requested');

  // The model's own fold and match, as the loop reads them.
  const history = foldDecisions(work.current.id, events.map(event => ({ ...event, at: event.created_at })) as DecisionEvent[]);
  assert.deepEqual(history.find(entry => entry.id === refused.id)!.situation, { sha: shaA, baseSha: base });
  assert.equal(unansweredRefusal(history, 'rework', input, 'Other grounds', same, [], decisionSituation('rework', item('e'.repeat(40)))), null, 'no refusal judged candidate E');
  assert.match(unansweredRefusal(history, 'rework', input, 'Other grounds', same, [], decisionSituation('rework', item(shaB)))!, new RegExp(onB.id));
  // recover is situated the same way; other actions bind what they judge in their input.
  assert.deepEqual(decisionSituation('recover', item(shaA)), { sha: shaA, baseSha: base });
  assert.equal(decisionSituation('merge', item(shaA)), null);
  // A refusal recorded before situations were kept names no candidate, so it stands as it always did until cited.
  const legacy = [{ id: refused.id, action: 'rework' as const, state: 'refused', input, reason: 'Legacy', refusal: null }];
  assert.match(unansweredRefusal(legacy, 'rework', input, 'Other grounds', same, [], decisionSituation('rework', item(shaB)))!, new RegExp(refused.id));
  assert.equal(unansweredRefusal(legacy, 'rework', input, `Other grounds; answers ${refused.id}`, same, [], decisionSituation('rework', item(shaB))), null);
});

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [] });
}

type Recorded = { id: string; action: string; state: string; input: any; reason: string; precedent: string[]; approvedBy: null; refusal: { approver: string; reason: string } | null; situation: { sha: string | null; baseSha: string | null } | null };

/** Loop effects whose `decide` refuses exactly what the control plane's request route refuses. */
function effects(work: Work, history: Recorded[], read: 'ok' | 'fails', sent: string[]): DaemonEffects {
  return {
    agents: () => [], herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({}),
    snapshot: async () => ({ work: [work], now: iso(0), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (target, action, reason) => {
      sent.push(reason);
      const situation = decisionSituation(action, target);
      const repeated = unansweredRefusal(history as any, action as 'rework', input, reason, same, [], situation);
      if (repeated) throw new Error(`Graphyard refused work/${target.id}/decide (409): ${repeated}`);
      const id = `5d8a8b9e-0000-4000-8000-${String(history.length).padStart(12, '0')}`;
      history.push({ id, action, state: 'requested', input, reason, precedent: [], approvedBy: null, refusal: null, situation });
      return { id };
    },
    decisions: async () => { if (read === 'fails') throw new Error('Graphyard is restarting'); return { decisions: history }; },
    approver: async () => ({ agentName: 'graphyard-approver-gy-42', pane: 'pane-1' }),
    persist: async () => {},
  };
}

const refusal = (id: string, sha: string, reason: string): Recorded => ({ id, action: 'rework', state: 'refused', input, reason, precedent: [], approvedBy: null,
  refusal: { approver: 'graphyard-approver', reason: 'Judged on the earlier candidate' }, situation: { sha, baseSha: base } });

test('unit:loop-rework-not-blocked-by-stale-refusal — the loop\'s rework request succeeds after a refusal on another candidate, and cites a refusal on the same candidate automatically', async () => {
  const onA = '68a66582-0000-4000-8000-000000000001', onB = '68a66582-0000-4000-8000-000000000002';

  // A rework was refused hours ago for candidate A; the item now holds candidate B with a fresh verdict.
  const stale = [refusal(onA, shaA, 'The verdict on candidate A needs another round')];
  const sent: string[] = [];
  let state = emptyDaemonState(config());
  let result = await runCycle(config(), state, effects(item(shaB), stale, 'ok', sent), () => clock);
  assert.equal(sent.length, 1, 'the loop requests the rework once');
  assert.ok(!sent[0].includes(onA), 'a refusal judged on another candidate is not the request\'s to answer');
  assert.equal(stale.at(-1)!.state, 'requested', 'the control plane accepted the request');
  assert.deepEqual(stale.at(-1)!.situation, { sha: shaB, baseSha: base });
  assert.ok(result.actions.some(action => action.kind === 'decision' && action.state === 'done' && action.detail.includes(`Requested decision ${stale.at(-1)!.id} (rework)`)));

  // A refusal on candidate B itself is cited with the loop's new grounds, and the request succeeds.
  const standing = [refusal(onA, shaA, 'Earlier grounds on A'), refusal(onB, shaB, 'Earlier grounds on B')];
  const cited: string[] = [];
  state = emptyDaemonState(config());
  await runCycle(config(), state, effects(item(shaB), standing, 'ok', cited), () => clock);
  assert.equal(cited.length, 1);
  assert.ok(cited[0].includes(onB) && !cited[0].includes(onA), `the request cites exactly this candidate's refusal: ${cited[0]}`);
  assert.equal(standing.at(-1)!.state, 'requested');

  // The loop's history read fails: the server's refusal names the standing refusal, and the loop
  // answers it by citing it instead of failing the request on every cycle.
  const unread = [refusal(onB, shaB, 'Earlier grounds on B')];
  const retried: string[] = [];
  state = emptyDaemonState(config());
  result = await runCycle(config(), state, effects(item(shaB), unread, 'fails', retried), () => clock);
  assert.equal(retried.length, 2, 'one uncited request, then one that cites the refusal the server named');
  assert.ok(!retried[0].includes(onB) && retried[1].includes(onB));
  assert.equal(unread.at(-1)!.state, 'requested');
  assert.ok(!result.actions.some(action => action.kind === 'decision' && action.state === 'failed'), 'nothing is recorded as failed');
  assert.equal(refusalNamedIn(`Decision ${onB} (rework) with this input for candidate ${shaB.slice(0, 12)} on base ${base.slice(0, 12)} was refused by x`), onB);
  assert.equal(refusalNamedIn('Decision is already requested'), null);
});

/**
 * GY-265, the follow-ups of GY-229's review: a legacy refusal's message tells a hand `master decide`
 * to cite it by id; the server names the standing refusal as a field of its 409 body, so the loop's
 * retry survives any rewording of the message; and a recover request answers a refusal its history
 * read missed exactly as a rework does.
 */
test('unit:legacy-refusal-names-its-citation — a refusal recorded before situations were kept tells a hand request to cite it, and the 409 body names it as a field', async () => {
  const legacyId = '68a66582-0000-4000-8000-0000000000aa';
  const legacy = [{ id: legacyId, action: 'rework' as const, state: 'refused', input, reason: 'Legacy', refusal: null }];
  const found = standingRefusal(legacy, 'rework', input, 'Other grounds', same, [], decisionSituation('rework', item(shaB)))!;
  assert.equal(found.decision, legacyId);
  assert.equal(found.legacy, true);
  assert.match(found.message, new RegExp(`stands against every candidate of this item until a request cites it: pass --precedent ${legacyId}`));
  // A refusal that recorded its candidate carries no such note.
  const situated = [{ ...legacy[0], situation: { sha: shaB, baseSha: base } }];
  const current = standingRefusal(situated, 'rework', input, 'Other grounds', same, [], decisionSituation('rework', item(shaB)))!;
  assert.equal(current.legacy, false);
  assert.doesNotMatch(current.message, /--precedent/);

  // The request route answers with the refused decision as a field beside the message.
  const work = { current: item(shaA) };
  const { events, services } = ledger(work);
  const refused = await request(services, work.current, 'Candidate A needs another round');
  events.push({ actor: 'graphyard-approver', kind: 'decision.declined', payload: { id: refused.id, reason: 'Not yet' }, created_at: iso(1000) });
  await assert.rejects(request(services, work.current, 'Candidate A needs another round, again'),
    (error: unknown) => error instanceof Refusal && error.status === 409 && (error.details as any)?.standingRefusal?.decision === refused.id && (error.details as any).standingRefusal.action === 'rework');
});

test('unit:refusal-named-structurally — the loop reads the standing refusal from the response body, for rework and recover, whatever the message says', () => {
  const id = '68a66582-0000-4000-8000-0000000000bb';
  const body = (action: string) => ({ error: 'Reworded entirely: no decision id in this prose', standingRefusal: { decision: id, action, legacy: false } });
  assert.equal(refusalNamedIn(new RefusedResponse('Graphyard refused work/x/decide (409): reworded', 409, body('rework')), 'rework'), id);
  assert.equal(refusalNamedIn(new RefusedResponse('Graphyard refused work/x/decide (409): reworded', 409, body('recover')), 'recover'), id);
  assert.equal(refusalNamedIn(new RefusedResponse('reworded', 409, body('recover')), 'rework'), null, 'a refusal of another action is not this request\'s to answer');
  assert.equal(refusalNamedIn(new RefusedResponse('reworded', 409, { error: 'x', standingRefusal: { decision: 'not-an-id', action: 'rework' } }), 'rework'), null);
  // A server predating the field is still read from its message, for either situated action.
  assert.equal(refusalNamedIn(new Error(`Decision ${id} (recover) with this input was refused by x`), 'recover'), id);
  assert.equal(refusalNamedIn(new Error(`Decision ${id} (recover) with this input was refused by x`), 'rework'), null);
});

test('unit:loop-recover-answers-missed-refusal — a loop recover request refused on a refusal its history read missed cites it and is accepted', async () => {
  const onEpoch = '68a66582-0000-4000-8000-0000000000cc';
  const delivered = { ...item(shaB), stage: 'done', lease: null,
    containmentQuarantine: { at: iso(-3 * 60 * minute), epoch: 1, owner: 'graphyard-worker-1', scope: null, leaseExpiresAt: iso(-2 * 60 * minute), launchExpiresAt: iso(-2 * 60 * minute), launchAcknowledgedAt: iso(-3 * 60 * minute), settlementHash: 'f'.repeat(64) } } as unknown as Work;
  const history: Recorded[] = [{ id: onEpoch, action: 'recover', state: 'refused', input: { previousWorkerStopped: true, binding: '1' }, reason: 'Earlier grounds', precedent: [], approvedBy: null,
    refusal: { approver: 'graphyard-approver', reason: 'Not yet' }, situation: { sha: shaB, baseSha: base } }];
  const sent: string[] = [];
  const recoverEffects: DaemonEffects = {
    ...effects(delivered, history, 'fails', sent),
    containment: () => ({ [delivered.id]: { key: delivered.key, id: delivered.id, epoch: 1, owner: 'graphyard-worker-1', at: iso(0), host: 'machine-a', workspacePath: null, scope: null, settleable: true, refusals: [], attestation: 'supervisor gone', verification: null } }),
    // The server's own match, answered with a message that names no id: only the field can.
    decide: async (target, action, reason, given) => {
      sent.push(reason);
      const situation = decisionSituation(action, target);
      const found = standingRefusal(history as any, action as 'recover', { previousWorkerStopped: true, ...(given ?? {}) }, reason, same, [], situation);
      if (found) throw new RefusedResponse('Graphyard refused work/x/decide (409): refused, reworded', 409, { error: 'refused, reworded', standingRefusal: { decision: found.decision, action: found.action, legacy: found.legacy } });
      const id = `5d8a8b9e-0000-4000-8000-${String(history.length).padStart(12, '0')}`;
      history.push({ id, action, state: 'requested', input: given, reason, precedent: [], approvedBy: null, refusal: null, situation });
      return { id };
    },
  };
  const result = await runCycle(config(), emptyDaemonState(config()), recoverEffects, () => clock);
  assert.equal(sent.length, 2, `one uncited request, then one citing the refusal the server named: ${JSON.stringify(result.actions.filter(action => action.kind === 'decision'))}`);
  assert.ok(!sent[0].includes(onEpoch) && sent[1].includes(onEpoch) && /refused recover decision/.test(sent[1]), sent[1]);
  assert.equal(history.at(-1)!.state, 'requested');
  assert.ok(!result.actions.some(action => action.kind === 'decision' && action.state === 'failed'), 'nothing is recorded as failed');
});
