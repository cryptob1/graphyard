import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { masterConfigSchema } from '../src/master.js';
import { emptyDaemonState, type DaemonEffects } from '../src/master-daemon.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1794: the read backoff the deployment-verification step applies after an unavailable or failed
// reading paces live reads, never the close of an item whose passing reading is already recorded — a
// pass recorded by hand while that backoff stands closes the item on the next pass, while an item
// with no passing reading is still read only once the backoff has run out. A close that itself fails
// is paced by its own failure cursor under the close's idempotency key — asked the pass after it
// failed, then at the widened step — never once per pass and never on the read backoff. GY-1779
// added the step; these tests drive it the way production wires it, over an in-memory work list.

const hour = 3_600_000, now = Date.parse('2026-10-13T12:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const filed = sha('a'), serving = sha('b'), mergeSha = sha('c');
const parentId = '11111111-1111-4111-8111-111111111111';
const proof = 'manual:post-deploy/webhook-deliveries-clean-24h', own = 'manual:webhook-deliveries-clean-24h-on-serving-release';
const base = (n: number, extra: Partial<Work> = {}): Work => ({
  id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, key: `GY-${n}`, title: `Item ${n}`, description: '', type: 'chore', priority: 1, stage: 'ready', ready: true, epoch: 0, revision: 3, policyRevision: 1,
  createdAt: iso(now - 30 * hour), updatedAt: iso(now - 2 * hour), stageEnteredAt: iso(now - 2 * hour), lease: null, lastAssignment: null, systemDriven: true, implementers: [],
  workspaces: [], sessions: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], criteria: [], plannedFiles: [],
  policy: { checks: ['test', 'typecheck'], review: true }, dependencies: [],
  gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }],
  ...extra,
}) as unknown as Work;
const parent = base(1700, { id: parentId, stage: 'done', ready: true, criteria: [{ id: 'AC-2', text: 'A 24-hour window of live GitHub activity shows zero failed webhook deliveries', proofs: [proof] }],
  delivery: { mergeSha, mergedAt: iso(now - 40 * hour), deployment: { sha: filed, mergeSha, source: 'endpoint', observedAt: iso(now - 30 * hour), covers: 'descendant', at: iso(now - 30 * hour), observer: 'graphyard-master' } } } as Partial<Work>);
/** A follow-up the filer filed for `parent` AC-2 on the filed release, window closed an hour ago. */
const followUp = (n: number, extra: Partial<Work> = {}) => base(n, { description: `Post-deploy follow-up: post-deploy:${parentId}:AC-2:${proof}:${filed}\n\nowed`,
  criteria: [{ id: 'AC-1', text: `From this head against the serving release ${filed.slice(0, 12)} that carries GY-1700's merge: zero failed webhook deliveries over 24 hours`, proofs: [own] }],
  observationWindow: { notBefore: iso(now - hour), basis: 'criterion-window', detail: 'the 24-hour live window ran' }, ...extra });
/** The pass an operator records by hand on the serving release, bound as observationPass reads it. */
const handPass = (item: Work) => item.evidence.push({ id: randomUUID(), producer: 'graphyard-producer', trusted: true, executed: 1, skipped: 0, at: iso(now - 60_000), proof: own, sha: serving, baseSha: mergeSha, policyRevision: 1, result: 'pass', reading: { detail: 'recorded by hand' } });

/** The loop's cycle over `work` with the reading effects wired as production wires them; `closing` may refuse a close. */
async function makeCycle(work: Work[], directory: string, reader: DaemonEffects['readPostDeploy'], closing: (item: Work, release: string) => void = () => {}) {
  const token = join(directory, 'coordinator.token');
  await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: join(directory, 'graphyard.mjs'), repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], run: { deploymentReuseMinutes: 0 } });
  const state = emptyDaemonState(config);
  const recorded: { key: string; reading: Record<string, unknown> }[] = [], closed: { key: string; release: string; reason: string; idempotency: string }[] = [];
  const { localPostDeployChecks } = await import('../src/master-verification.js');
  const served = () => ({ source: 'endpoint', sha: serving, at: iso(now - 60_000), reason: null, deployed: work.filter(item => item.stage === 'done' && item.delivery).map(item => item.key), pending: [], requests: 1 });
  const effects: DaemonEffects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work, now: iso(now) }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, persist: async () => {},
    observeDeployment: async () => served() as never,
    recordDeployment: async () => {}, requestSmoke: () => {},
    recordReading: async (item: Work, reading: Parameters<NonNullable<DaemonEffects['recordReading']>>[1]) => { recorded.push({ key: item.key, reading }); item.evidence.push({ id: randomUUID(), producer: 'graphyard-master', trusted: true, executed: 1, skipped: 0, at: iso(now), proof: reading.proof, sha: reading.sha, baseSha: reading.baseSha, policyRevision: reading.policyRevision, result: reading.result, reading: { detail: reading.detail } }); },
    closeObservation: async (item: Work, release: string, reason: string, idempotency: string) => { closing(item, release); closed.push({ key: item.key, release, reason, idempotency }); item.stage = 'done'; item.closure = { kind: 'delivered-observation', reason, ref: release, by: 'graphyard-master', at: iso(now), from: 'ready' }; },
    postDeployFiler: localPostDeployChecks, readPostDeploy: reader,
  } as unknown as DaemonEffects;
  const cycle = { config, state, effects, now: () => now, clock: now, clockOffset: { min: 0, max: 0 }, performed: [], snapshot: { work, now: iso(now) }, open: work.filter(item => item.stage !== 'done'),
    isolate: async (_kind: string, _item: unknown, _name: string, body: () => Promise<unknown>) => body(), detached: false, launcher: { busy: () => false }, timings: { step: async (_name: string, body: () => Promise<unknown>) => body() } } as unknown as Cycle;
  const next = () => { cycle.state.cycle++; cycle.performed.length = 0; cycle.open = work.filter(item => item.stage !== 'done'); };
  const { deploymentStep } = await import('../src/daemon/cycle-delivery.js');
  const pass = async () => deploymentStep(cycle);
  return { state, recorded, closed, cycle, next, pass };
}

test('unit:recorded-pass-bypasses-read-backoff — a passing reading recorded by hand while a read backoff stands closes the item on the next deployment-verification pass; the backoff still delayed the live reads before it existed', async () => {
  const item = followUp(1794);
  const asked: string[] = [];
  const reader: DaemonEffects['readPostDeploy'] = async input => { asked.push(input.item.key); return { unavailable: 'the App\'s advanced delivery log needs a browser sign-in no loop step holds' }; };
  const run = await makeCycle([parent, item], await temporaryDirectory('recorded-pass'), reader);
  // The first two passes take the reading and record why it cannot be taken; the second widens the backoff.
  await run.pass();
  assert.equal(run.state.actions[`reading:${item.id}`]?.state, 'waiting');
  await run.next(); await run.pass();
  assert.deepEqual(asked, [item.key, item.key]);
  assert.equal(run.state.actions[`reading:${item.id}`]?.attempts, 2);
  // The third pass is inside the widened backoff: with no passing reading recorded, the live read waits.
  await run.next(); await run.pass();
  assert.deepEqual(asked, [item.key, item.key], 'the backoff delays the next live read of an item with no passing reading');
  // The fourth pass asks again on the widened backoff; the third unavailable reading leaves a four-pass backoff standing.
  await run.next(); await run.pass();
  assert.deepEqual(asked, [item.key, item.key, item.key]);
  assert.equal(run.state.actions[`reading:${item.id}`]?.attempts, 3);
  // Now the pass is recorded by hand on the serving release, and the next pass closes the item at once.
  handPass(item);
  await run.next(); await run.pass();
  assert.deepEqual(asked, [item.key, item.key, item.key], 'no live read runs for an item whose passing reading is already recorded');
  assert.deepEqual(run.closed.map(entry => [entry.key, entry.release]), [[item.key, serving]], 'the recorded pass closes the item while its backoff still stands');
  assert.equal(run.closed[0].idempotency, `reading:close:${item.id}:${serving}`);
  assert.match(run.closed[0].reason, /manual:webhook-deliveries-clean-24h-on-serving-release: recorded by hand/);
  assert.equal(run.state.actions[`reading:${item.id}`]?.state, 'done');
  assert.equal(item.stage, 'done');
  // A later pass neither closes it again nor reads anything: the closed item is no work.
  await run.next(); await run.pass();
  assert.deepEqual(asked, [item.key, item.key, item.key], 'the closed item is read no more');
  assert.equal(run.closed.length, 1, 'the closed item is closed no more');
});

test('unit:recorded-pass-bypasses-read-backoff — with no passing reading the backoff still delays the live read, and delays it only: the wait stands and the read resumes once the backoff has run out', async () => {
  const item = followUp(1795);
  const asked: string[] = [];
  const reader: DaemonEffects['readPostDeploy'] = async input => { asked.push(input.item.key); return { unavailable: 'no reader of the proof is configured on this loop' }; };
  const run = await makeCycle([parent, item], await temporaryDirectory('recorded-pass-delay'), reader);
  await run.pass();
  await run.next(); await run.pass();
  assert.equal(run.state.actions[`reading:${item.id}`]?.attempts, 2);
  await run.next(); await run.pass();
  assert.deepEqual(asked, [item.key, item.key], 'the standing backoff delays the live read');
  assert.deepEqual([run.recorded, run.closed], [[], []], 'a delayed read records nothing and closes nothing');
  assert.equal(item.stage, 'ready', 'the item stays open: the backoff paces the read, it never ends the wait');
  await run.next(); await run.pass();
  assert.deepEqual(asked, [item.key, item.key, item.key], 'once the backoff has run out the reading is asked again');
});

test('unit:recorded-pass-bypasses-read-backoff — a close that failed on a recorded pass is retried on the next pass and paced by its own failure cursor, never the read backoff and never every pass, and records the passing reading once', async () => {
  const item = followUp(1796);
  const asked: string[] = [];
  let refuse = 2;
  const reader: DaemonEffects['readPostDeploy'] = async input => { asked.push(input.item.key); return { result: 'pass', detail: 'the advanced delivery log shows 0 failed deliveries in the 24 hours' }; };
  const run = await makeCycle([parent, item], await temporaryDirectory('recorded-pass-retry'), reader, () => { if (refuse-- > 0) throw new Error('the control plane refused the close'); });
  await run.pass();
  assert.deepEqual([run.closed, run.recorded.map(entry => [entry.key, entry.reading.result])], [[], [[item.key, 'pass']]], 'the reading is recorded, its close is refused');
  assert.equal(run.state.actions[`reading:${item.id}`]?.state, 'failed', 'the pass that reads and closes records the refusal under the reading action');
  assert.equal(run.state.actions[`reading:close:${item.id}:${serving}`]?.attempts, 1, 'the failure also cursors the close under its idempotency key');
  await run.next(); await run.pass();
  assert.equal(run.state.actions[`reading:close:${item.id}:${serving}`]?.attempts, 2, 'the close is retried on the next pass, its first backoff step');
  assert.deepEqual([asked, run.recorded.length], [[item.key], 1], 'the recorded pass is never read or recorded twice');
  // The second refusal widens the close's own backoff to two passes: the next pass is inside it and asks nothing.
  await run.next(); await run.pass();
  assert.equal(run.state.actions[`reading:close:${item.id}:${serving}`]?.attempts, 2, 'the widened failure backoff withholds the close for a pass');
  assert.equal(run.closed.length, 0, 'nothing has landed');
  assert.deepEqual([asked, run.recorded.length], [[item.key], 1], 'the withheld pass neither reads nor records');
  await run.next(); await run.pass();
  assert.deepEqual(run.closed.map(entry => [entry.key, entry.release, entry.idempotency]), [[item.key, serving, `reading:close:${item.id}:${serving}`]], 'the close lands once its own failure backoff has run out, under the same key');
  assert.deepEqual([run.state.actions[`reading:${item.id}`]?.state, run.state.actions[`reading:${item.id}`]?.attempts], ['done', 3]);
});
