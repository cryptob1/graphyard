import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import { deploymentRecordCutoffMs } from '../src/model/delivery.js';
import { claimAction, openActions, reconcileActions } from '../src/model/actions.js';
import { nextAction } from '../src/model/next-action.js';
import { deliverySpeed } from '../src/flow-analytics.js';
import { controlPlaneHandlers } from '../src/executor.js';
import type { MasterConfig } from '../src/master.js';

// GY-1824: a delivery whose policy asks for no post-deployment smoke proof used to stop at
// `delivered` the moment it merged, so nothing ever recorded the serving release on it: the loop's
// deployment step recorded deployments for smoke items only, and the only remaining path was a
// master session running `graphyard master verify-deployment GY-N` by hand — forever, one item at
// a time, while flow-analytics counted each of them pending. The unattended path now records the
// release for every served delivery, through the executor's verify-deployment handler, which files
// and releases any owed post-deploy follow-up before the record exactly as it does for a smoke
// item. The reach is bounded (`deploymentRecordCutoffMs`), so the first evaluation after this
// ships raises the deliveries the loop could have recorded recently, never the whole delivery
// history at once; a smoke item's raise is unchanged.

const day = 86_400_000;
const nowMs = Date.parse('2030-06-01T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const mergeSha = 'f'.repeat(40), release = 'a'.repeat(40);
const postDeployProof = 'manual:post-deploy/harness-drift-cleared';
const policy: Work['policy'] = { checks: ['test', 'typecheck'], review: true };
const smokePolicy: Work['policy'] = { ...policy, deploySmoke: true };

/** A done, unclosed delivery merged `ageMs` ago, its serving release unrecorded unless `deployment` says otherwise. */
const delivered = (key: string, ageMs: number, overrides: Partial<Work> = {}, itemPolicy: Work['policy'] = policy): Work => ({
  id: `id-${key}`, key, title: key, description: '', type: 'bug', priority: 1,
  dependencies: [], criteria: [{ id: 'AC-1', text: 'The harness contract applies on the serving release', proofs: [postDeployProof] }],
  policy: itemPolicy, plannedFiles: [],
  stage: 'done', revision: 40, policyRevision: 1, createdAt: iso(nowMs - ageMs - day), updatedAt: iso(nowMs - ageMs), stageEnteredAt: iso(nowMs - ageMs),
  ready: true, epoch: 1, lease: null, workspaces: [], candidate: null, submission: { epoch: 1, pr: 1110 }, reworkRequested: false,
  scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [],
  delivery: { mergeSha, mergedAt: iso(nowMs - ageMs), authorizationRevision: 33 }, ...overrides,
} as Work);

const record = (observedAt: number) => ({ sha: release, mergeSha, source: 'endpoint' as const, observedAt: iso(observedAt), covers: 'descendant' as const, at: iso(observedAt + 1000), observer: 'executor-1' });
const unusable = async (): Promise<never> => { throw new Error('not reached'); };

/** The handlers Graphyard ships, over one in-memory snapshot, with the observation and the calls recorded. */
function handlers(work: Work, all: Work[], calls: string[], fileWork?: (input: unknown, requestId: string) => Promise<{ key?: string }>) {
  return controlPlaneHandlers(() => ({}) as MasterConfig, {
    snapshot: async () => ({ work: all.some(item => item.id === work.id) ? all : [work], now: iso(nowMs) }),
    // The coordinator credential records the observation and never creates work.
    mutate: async (path: string) => { calls.push(path); return {}; },
    agents: () => [], workerCredentials: async () => ({}), producerCredentials: async () => ({}),
    dispatchWorker: unusable, launchReview: unusable, launchProducer: unusable,
    observeDeployment: async () => ({ source: 'endpoint', sha: release, at: iso(nowMs - 60_000), reason: null, deployed: [work.key], pending: [] }) as never,
    releaseWork: async (key: string) => { calls.push(`release ${key}`); },
    now: () => nowMs,
    ...(fileWork ? { fileWork } : {}),
  });
}
const verifyRow = (work: Work) => ({ id: 'row-1', work: work.id, key: work.key, kind: 'verify-deployment', inputs: { kind: 'verify-deployment', mergeSha, mergedAt: work.delivery!.mergedAt, state: 'delivered' } }) as never;

test('unit:unattended-verify-deployment — a served non-smoke delivery is recorded by the executor with no master session, filing and releasing the owed post-deploy follow-up first, and never recorded twice', async () => {
  const item = delivered('GY-1900', 2 * day);
  // The item is done, unclosed, asks for no smoke proof, and no release observation is recorded: it owes verify-deployment.
  const action = nextAction(item, [item], new Date(nowMs));
  assert.equal(action?.kind, 'verify-deployment');
  assert.deepEqual(action!.inputs, { kind: 'verify-deployment', mergeSha, mergedAt: item.delivery!.mergedAt, state: 'delivered' });
  // The raise is a claimable row a stateless executor is offered, exactly as a smoke item's is.
  assert.equal(reconcileActions(item, [item], new Date(nowMs)).filter(entry => entry.event === 'requested').length, 1);
  const offered = openActions([item], new Date(nowMs));
  assert.equal(offered.length, 1);
  assert.equal(offered[0].row.kind, 'verify-deployment');
  assert.equal(claimAction([item], { id: 'executor-1', host: 'host-1', principal: 'executor-1' }, new Date(nowMs))!.row.kind, 'verify-deployment');

  // The executor's handler records the observation only after it has filed and released the owed post-deploy follow-up.
  const calls: string[] = [];
  const filed: string[] = [];
  const result = await handlers(item, [item], calls, async (input: unknown, requestId: string) => {
    calls.push(`file ${requestId}`); filed.push(String((input as { title: string }).title)); return { key: 'GY-1901' };
  })['verify-deployment']!(verifyRow(item), { host: 'host-1', id: 'executor-1' }) as unknown as Promise<string>;
  assert.match(String(result), /AC-1 owes its post-deploy observation \(GY-1901\)/);
  assert.deepEqual(calls, [`file post-deploy:${item.id}:AC-1:manual:post-deploy/harness-drift-cleared:${release}`, 'release GY-1901', `work/${item.id}/deployment`]);
  assert.match(filed[0], /^Post-deploy verification of GY-1900 AC-1/);

  // Without an operator-agent identity to file with, nothing is recorded: the observation waits for the filing.
  const refused: string[] = [];
  await assert.rejects(handlers(item, [item], refused)['verify-deployment']!(verifyRow(item), { host: 'host-1', id: 'executor-1' }) as unknown as Promise<string>,
    /owes its post-deploy follow-up, and this executor has no operator-agent identity/);
  assert.deepEqual(refused, [], 'nothing is recorded while the follow-up is unfiled');

  // Once the record is on the delivery it is never raised again: the item is settled, not verified a second time.
  item.delivery!.deployment = record(nowMs - 60_000);
  assert.equal(nextAction(item, [item], new Date(nowMs)), null);
  assert.equal(reconcileActions(item, [item], new Date(nowMs)).length, 0);
  assert.equal(openActions([item], new Date(nowMs)).length, 0);
});

test('unit:unattended-verify-deployment — the reach is bounded by the merge age, and a smoke item raises and waits exactly as before', async () => {
  // Beyond the unattended reach an unrecorded delivery is left to the master's hand: no action.
  const old = delivered('GY-1902', deploymentRecordCutoffMs + day);
  assert.equal(nextAction(old, [old], new Date(nowMs)), null);
  // Inside it, the raise stands; the boundary itself is reached.
  const edge = delivered('GY-1903', deploymentRecordCutoffMs);
  assert.equal(nextAction(edge, [edge], new Date(nowMs))?.kind, 'verify-deployment');
  // A closed delivery is settled whatever its age: closure, not the policy, ends the item.
  const closed = delivered('GY-1904', 2 * day, { closure: { kind: 'delivered-observation', reason: 'closed after its observation was read', ref: release, by: 'graphyard', at: iso(nowMs - 3_600_000), from: 'done' } as never });
  assert.equal(nextAction(closed, [closed], new Date(nowMs)), null);

  // A smoke item's behaviour is unchanged: the raise is unbounded by age and names the awaiting state...
  const smoke = delivered('GY-1905', deploymentRecordCutoffMs + day, {}, smokePolicy);
  const raised = nextAction(smoke, [smoke], new Date(nowMs));
  assert.equal(raised?.kind, 'verify-deployment');
  assert.deepEqual(raised!.inputs, { kind: 'verify-deployment', mergeSha, mergedAt: smoke.delivery!.mergedAt, state: 'awaiting-deployment' });
  // ...and once the deployment is recorded it waits for its smoke proof rather than settling: the loop requests that proof.
  smoke.delivery!.deployment = record(nowMs - 60_000);
  assert.equal(nextAction(smoke, [smoke], new Date(nowMs)), null);
});

test('unit:unattended-verify-deployment — deliverySpeed counts a recorded delivery merged-to-promoted instead of pending', async () => {
  const item = delivered('GY-1906', 2 * day);
  const mergedAt = nowMs - 2 * day;
  // Unrecorded, the item only hangs over the figure as pending.
  const before = deliverySpeed([item], { now: nowMs }).mergedToProduction['7d'];
  assert.equal(before.count, 0);
  assert.equal(before.pending, 1);
  assert.deepEqual(before.slowest.filter(entry => entry.pending).map(entry => entry.key), ['GY-1906']);
  // Recorded, it moves into the merged→promoted figure with its own span.
  item.delivery!.deployment = record(mergedAt + 3 * 3_600_000);
  const after = deliverySpeed([item], { now: nowMs }).mergedToProduction['7d'];
  assert.equal(after.count, 1);
  assert.equal(after.p90Ms, 3 * 3_600_000);
  assert.equal(after.pending, 0);
});
