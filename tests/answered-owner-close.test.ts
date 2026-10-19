import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActionRow } from '../src/model/actions.js';
import type { Work } from '../src/model.js';
import { throughputAnsweredAt, throughputClaimVisibility, throughputDecision, throughputOwnerItem, verifyThroughput, type ThroughputReport } from '../src/throughput.js';
// Time-bomb allowance (GY-1694): the 2026-10-07 base instants are throughput fixtures judged by verifyThroughput against the explicit `now` derived from base; no wall clock is read.

// GY-1609: a throughput owner stays open across releases, so the escalated miss it answers is on the
// release serving when it was asked, not the one in its title. The loop and master status judge that
// answer alike, and master status never asks `master decide` for a decision already applied.
// (GY-2186 retired the loop's owner filing, closing and raises; what remains is the pure reading.)
const minute = 60_000;
const base = Date.parse('2026-10-07T12:00:00.000Z');
const at = (minutes: number) => new Date(base + minutes * minute).toISOString();
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const now = base + 2 * 24 * 60 * minute;
const escalated = { escalated: true } as const;

function row(kind: string, history: ActionRow['history']): ActionRow {
  return { id: `${kind}-${history[0]!.at}`, kind, work: 'w', key: 'GY-1', inputs: { kind }, gate: 'build', refusal: null, reason: '', binding: `${kind}:0`,
    requestedBy: 'graphyard', requestedAt: history[0]!.at, state: 'done', claim: null, attempts: 1, resolvedAt: history.at(-1)!.at, result: 'done', resolution: 'settled', history } as unknown as ActionRow;
}
const executed = row('request-review', [
  { at: at(11), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: '' },
  { at: at(12), event: 'claimed', requester: 'graphyard', executor: 'executor-a', result: null, reason: 'attempt 1 claimed by executor-a on host-a' },
  { at: at(13), event: 'completed', requester: 'graphyard', executor: 'executor-a', result: 'done', reason: '' },
]);
function delivery(key: string, history: ActionRow[] = [executed]): Work {
  return {
    id: key.toLowerCase(), key, title: `Delivery ${key}`, stage: 'done', gates: [], violations: [], policy: { checks: [], review: true }, implementers: ['worker-1'], workspaces: [], sessions: [],
    submission: { pr: Number(key.split('-')[1]) }, candidate: null, updatedAt: at(60), delivery: { mergeSha: sha('a'), mergedAt: at(50) },
    pipeline: { attempts: [{ epoch: 1, owner: 'worker-1', claimedAt: at(0), endedAt: at(10), end: 'submitted' }], submittedAt: at(10), reworkRounds: 0, interventions: { blocked: 0, requirements: 0 }, backfill: null },
    actionQueue: { actions: [], history },
  } as unknown as Work;
}
const deliveries = () => [...Array.from({ length: 9 }, (_, index) => delivery(`GY-${600 + index}`)), delivery('GY-468')];
/** The measurement of `release`: ten admitted deliveries whose submit→merge p50 (40 minutes) misses its budget, so an escalated pursuit raises the escalated miss. */
const missed = (release: string): ThroughputReport =>
  verifyThroughput(deliveries(), now, { deployed: { revision: release, version: '1', origin: 'https://example.invalid', observedAt: at(0), containsClaim: true, reason: null }, since: at(-60) });
const decideOn = (visible: ReturnType<typeof throughputClaimVisibility>) => (visible.stall ? visible.owner.item ?? 'GY-N' : null);

test('unit:next-action-no-decide-on-applied-decision — while the answering revision stands applied on the open owner, master status names no master decide or master approver for it; the line says it is answered', () => {
  const release = sha('0'), report = missed(release), pursuit = { escalated: true, text: 'escalated', blocker: null } as any;
  assert.equal(throughputDecision(report, escalated)?.cause, 'escalated-miss', 'the measurement stands an escalated miss');
  const owner = { key: 'GY-1605', policyRevision: 1 };
  const asked = throughputClaimVisibility({ report, file: 't.json' }, { revision: release, version: '1' }, 10, pursuit, owner, null, 1);
  assert.equal(decideOn(asked), 'GY-1605', 'unanswered, it is asked');
  // Revision 2 applied over the decision raised at revision 1.
  const applied = throughputClaimVisibility({ report, file: 't.json' }, { revision: release, version: '1' }, 10, pursuit, { ...owner, policyRevision: 2 }, null, 1);
  assert.equal(applied.stall, null);
  assert.doesNotMatch(applied.attention!.next, /master decide|master approver/);
  assert.doesNotMatch(applied.attention!.text, /needs decision/);
  assert.equal(applied.attention!.approvedBy ?? null, null, 'not the decide-then-approver path');
  assert.match(applied.attention!.text, /GY-1605's needs-decision \(raised at its requirements revision 1\) was answered by its requirements revision 2, which is applied; no item owns the verification until a recorded measurement of the release verifies it/);
  // A revision with no decision raised, or the one it was raised at, answers nothing: the decision is still asked.
  for (const raisedAt of [null, 2]) assert.equal(decideOn(throughputClaimVisibility({ report, file: 't.json' }, { revision: release, version: '1' }, 10, pursuit, { ...owner, policyRevision: 2 }, null, raisedAt)), 'GY-1605');
  // An owner closed on the serving release's answer, filed for an older one, answers the successor's ask.
  const closed = { title: throughputOwnerItem(sha('7'), null).title, closure: { kind: 'obsolete', at: at(0), ref: null, by: 'operator-agent', from: 'backlog',
    reason: `GY-1601's needs-decision (raised at its requirements revision 1 on an escalated budget miss) was answered by its requirements revision 2; the loop closes it, and files a second owner for ${release.slice(0, 12)} only while a measurement of it under the applied rule still shows a needs-decision standing` } } as unknown as Work;
  assert.equal(throughputAnsweredAt([closed], release), base);
  assert.equal(decideOn(throughputClaimVisibility({ report, file: 't.json' }, { revision: release, version: '1' }, 10, pursuit, owner, throughputAnsweredAt([closed], release), null)), null);
});
