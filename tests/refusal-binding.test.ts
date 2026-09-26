import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionBindingMax, decisionInputs, decisionSituation, foldDecisions, unansweredRefusal, uncitedRefusals, type DecisionEvent } from '../src/model/approval.js';
import { routineDecision, threadResolutionGraceMs } from '../src/master-daemon.js';
import { situatedInput } from '../src/daemon/decisions.js';
import { decisionInput } from '../src/master.js';
import { requestDecision } from '../src/server/decisions.js';
import { canonical } from '../src/server/decision-ledger.js';
import type { Observation, Principal, Work } from '../src/model.js';
import type { Services } from '../src/server/routes.js';

/**
 * GY-407: on 2026-09-25 a rework the master requested for GY-200 on candidate ad7060a4 was refused
 * because a rework refused at 08:42 — judged on candidate 2b295e05 for a speculative-tip ejection —
 * was carried onto the new candidate's key. A refusal must bind the candidate head, the base and
 * the grounds binding it judged (GY-229 bound the head and base; GY-407 adds the grounds): the
 * request carries its binding in its input, and a refusal on one ground never bars another.
 */

const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const minute = 60_000;
const shaA = 'a'.repeat(40), shaB = 'c'.repeat(40), base = 'b'.repeat(40), base2 = 'd'.repeat(40);
const stopped = { previousWorkerStopped: true } as const;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function item(sha: string, baseSha = base, observedAt = iso(-20_000)): Work {
  const candidate = { sha, baseSha, pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' };
  const observation = {
    clockOffset: { min: 0, max: 0 }, candidate, checks: [{ name: 'test', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'independent-reviewer', sha, state: 'CHANGES_REQUESTED' }],
    protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/loop.ts'], scopeFiles: [], at: observedAt,
  } as Observation;
  return {
    id: '00000000-0000-4000-8000-000000000042', key: 'GY-42', title: 'Refusals judge head, base and grounds', description: '', type: 'bug', priority: 1,
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
      if (sql.startsWith("SELECT payload->>'id'")) return { rows: events.filter(event => event.kind === 'decision.requested' && event.payload?.action === params[0] && (params[1] as string[]).includes(event.payload?.id)).map(event => ({ id: event.payload.id })) };
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
const request = (services: Services, work: Work, ground: string, reason: string) =>
  requestDecision(services, operator, work.id, { action: 'rework', input: { ...stopped, binding: ground }, reason }, `key-${++keys}`);

test('unit:refusal-bound-to-head — a refusal bars only the same head, base and grounds binding: a later head, a refreshed base or another ground is never blocked by it', async () => {
  const work = { current: item(shaA) };
  const { events, services } = ledger(work);

  // A rework on head A for the base-refresh conflict is refused by the approver.
  const groundsA = `${shaA}:conflict`;
  const refused = await request(services, work.current, groundsA, 'The base conflict needs another round');
  assert.deepEqual(events.at(-1)!.payload.situation, { sha: shaA, baseSha: base }, 'the request records the head and base it judged');
  assert.deepEqual(events.at(-1)!.payload.input, { previousWorkerStopped: true, binding: groundsA }, 'the request names the grounds it judges');
  events.push({ actor: 'graphyard-approver', kind: 'decision.declined', payload: { id: refused.id, reason: 'Premature: the reviewer has not judged the head' }, created_at: iso(1000) });

  // An identical request on head A — same input, same head and base — is still a retry, refused.
  await assert.rejects(request(services, work.current, groundsA, 'The base conflict needs another round, again'),
    (error: Error) => error.message.includes(refused.id) && error.message.includes(shaA.slice(0, 12)));

  // The item moves to head B on new grounds (a verdict): a new request judges a new situation and
  // a different binding, and is accepted without citing the refusal judged on head A.
  const groundsB = `${shaB}:verdict:independent-reviewer`;
  work.current = item(shaB);
  const onB = await request(services, work.current, groundsB, 'The verdict on candidate B needs another round');
  assert.equal(onB.state, 'requested');
  assert.deepEqual(onB.situation, { sha: shaB, baseSha: base });
  assert.ok(!onB.reason.includes(refused.id), 'the new request is not made to answer the old refusal');
  events.push({ actor: 'graphyard-approver', kind: 'decision.declined', payload: { id: onB.id, reason: 'Not yet' }, created_at: iso(2000) });

  // The same head rebuilt on a refreshed base is not carried to either: the refusal judged on the
  // old base does not stand, even for the very grounds it refused.
  work.current = item(shaA, base2);
  const onRefreshedBase = await request(services, work.current, groundsA, 'Head A after a base refresh');
  assert.equal(onRefreshedBase.state, 'requested', 'a refusal judged on an earlier base is never carried across a base refresh');
  events.push({ actor: 'graphyard-approver', kind: 'decision.declined', payload: { id: onRefreshedBase.id, reason: 'Not yet' }, created_at: iso(2500) });

  // The same head A and base with other grounds is a new request too: a refusal judged on one
  // ground does not match a request whose binding differs.
  work.current = item(shaA);
  const onOtherGrounds = await request(services, work.current, `${shaA}:sync:${base2}`, 'Head A now conflicts with the new base tip');
  assert.equal(onOtherGrounds.state, 'requested', 'a refusal on one ground never bars the same head on another');
  events.push({ actor: 'graphyard-approver', kind: 'decision.declined', payload: { id: onOtherGrounds.id, reason: 'Not yet' }, created_at: iso(3000) });

  // Back on head A, base and the refused grounds with nothing new said: the refusal still stands,
  // and a request that answers it by id is accepted.
  await assert.rejects(request(services, work.current, groundsA, 'The base conflict needs another round, once more'), (error: Error) => error.message.includes(refused.id));
  const answered = await request(services, work.current, groundsA, `The reviewer has now judged the head: answers refused rework decision ${refused.id}`);
  assert.equal(answered.state, 'requested');

  // The model's own fold and match, as the loop and the server read them.
  const history = foldDecisions(work.current.id, events.map(event => ({ ...event, at: event.created_at })) as DecisionEvent[]);
  const judged = history.filter(entry => entry.state === 'refused');
  assert.deepEqual(uncitedRefusals(judged, 'rework', { ...stopped, binding: `${shaB}:threads:PRRT_x` }, same, decisionSituation('rework', item(shaB))), [], 'no refusal judged head B on other grounds than its own');
  assert.deepEqual(uncitedRefusals(judged, 'rework', { ...stopped, binding: groundsB }, same, decisionSituation('rework', item(shaB))), [onB.id], 'head B stands its own refused request');
  assert.deepEqual(uncitedRefusals(judged, 'rework', { ...stopped, binding: groundsA }, same, decisionSituation('rework', item(shaA))), [refused.id], 'only the refusal judged this head, base and grounds stands against it');
  assert.equal(unansweredRefusal(judged, 'rework', { ...stopped, binding: `${shaB}:threads:PRRT_x` }, 'Other grounds', same, [], decisionSituation('rework', item(shaB))), null);
  assert.match(unansweredRefusal(judged, 'rework', { ...stopped, binding: groundsB }, 'Other grounds', same, [], decisionSituation('rework', item(shaB)))!, new RegExp(onB.id));
  assert.match(unansweredRefusal(judged, 'rework', { ...stopped, binding: groundsA }, 'Other grounds', same, [], decisionSituation('rework', item(shaA)))!, new RegExp(refused.id));
  // A refusal recorded before bindings were kept shares only the bare attestation with a request
  // that names none; the loop's requests all name one, so none of them is barred by it.
  const legacy = [{ id: refused.id, action: 'rework' as const, state: 'refused', input: stopped, reason: 'Legacy', refusal: null }];
  assert.equal(unansweredRefusal(legacy, 'rework', decisionInput('rework', item(shaB), situatedInput({ action: 'rework', binding: groundsB }) ?? {}), 'New grounds', same, [], decisionSituation('rework', item(shaB))), null);
});

const at = iso(-30 * minute);
const thread = (id: string) => ({ id, author: 'chatgpt-codex-connector', path: 'src/a.ts', line: 3, outdated: false });
function verdictItem(reviews: { state: string; reviewer: string; submittedAt?: string }[], threads: { id: string; author: string; path: string; line: number; outdated: boolean }[] = []): Work {
  const candidate = { sha: shaA, baseSha: base, pr: 154, branch: 'graphyard/gy-42-1', author: 'worker' };
  return {
    id: 'gy-42', key: 'GY-42', title: 'Held fixes', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'review', revision: 4, policyRevision: 2,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 2, lease: null, workspaces: [], candidate,
    submission: { epoch: 2, pr: 154 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [],
    observation: { clockOffset: { min: 0, max: 0 }, candidate, checks: [], reviews: reviews.map(review => ({ submittedAt: at, ...review, sha: shaA })), merged: false, mergeSha: null, mergeable: true, protected: true,
      files: ['src/a.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: base, baseTree: base, baseTipContained: true,
      conversations: { required: true, unresolved: threads } },
  } as unknown as Work;
}

test('unit:rework-input-names-its-grounds — the loop sends its binding with a rework or recover request, so the server refuses repeats only of the same grounds', () => {
  // A standing verdict: the request carries the grounds binding the watch key is built from.
  const decided = routineDecision(verdictItem([{ state: 'CHANGES_REQUESTED', reviewer: 'graphyard-reviewer[bot]' }]), { autoMerge: true }, Date.parse(at))!;
  assert.equal(decided.action, 'rework');
  assert.deepEqual(decided.input, { binding: decided.binding }, 'the binding is the request input, so the refusal match sees the grounds');
  const posted = decisionInput('rework', verdictItem([]), decided.input ?? {});
  assert.deepEqual(decisionInputs.rework.parse(posted), { previousWorkerStopped: true, binding: decided.binding }, 'the control plane accepts exactly what the loop sends');

  // A binding past the input bound is truncated to it, and the truncated form still parses.
  const long = Array.from({ length: 8 }, (_, index) => `${'t'.repeat(300)}-${index}`);
  const threaded = routineDecision(verdictItem([{ state: 'APPROVED', reviewer: 'graphyard-reviewer[bot]', submittedAt: new Date(Date.parse(at) - threadResolutionGraceMs).toISOString() }],
    long.map(id => thread(id))), { autoMerge: true }, Date.parse(at))!;
  assert.equal(threaded.action, 'rework');
  assert.ok(threaded.binding.length > decisionBindingMax, 'the grounds binding alone is past the bound');
  assert.equal((threaded.input?.binding as string | undefined)?.length, decisionBindingMax, 'the loop truncates the binding it sends to the bound');
  assert.deepEqual(decisionInputs.rework.parse(decisionInput('rework', verdictItem([]), threaded.input ?? {})), { previousWorkerStopped: true, binding: threaded.input?.binding });

  // Recover is situated the same way; a resolve is not, and its input is left alone.
  assert.deepEqual(situatedInput({ action: 'recover', binding: '3' }), { binding: '3' });
  assert.deepEqual(situatedInput({ action: 'resolve', binding: 'lease-loss:2:x', input: { trigger: 'lease-loss' } }), { trigger: 'lease-loss' });

  // A legacy refusal that names no binding does not stand against the loop's request on the same
  // head: the binding is part of the input the match compares.
  const legacy = [{ id: '00000000-0000-4000-8000-000000000001', action: 'rework' as const, state: 'refused', input: stopped, reason: 'Legacy grounds', refusal: { approver: 'graphyard-approver', reason: 'Premature', at: at } }];
  const situation = decisionSituation('rework', verdictItem([]));
  const sent = decisionInput('rework', verdictItem([]), decided.input ?? {});
  assert.equal(unansweredRefusal(legacy, 'rework', sent, 'New grounds', same, [], situation), null, 'the request names grounds the refusal never judged');
  assert.deepEqual(uncitedRefusals(legacy, 'rework', sent, same, situation), [], 'and it is not the request\'s to cite');
});

test('unit:recover-binding-parses — a recover request may name its grounds binding, and the schema refuses a repeat of a refused one only on the same grounds', () => {
  assert.deepEqual(decisionInputs.recover.parse({ previousWorkerStopped: true, binding: '3' }), { previousWorkerStopped: true, binding: '3' });
  assert.deepEqual(decisionInputs.recover.parse(stopped), stopped);
  assert.throws(() => decisionInputs.rework.parse({ previousWorkerStopped: true, binding: ' ' }), /too small/i);
  assert.throws(() => decisionInputs.rework.parse({ previousWorkerStopped: true, binding: 'x'.repeat(decisionBindingMax + 1) }), /too big/i);
});
