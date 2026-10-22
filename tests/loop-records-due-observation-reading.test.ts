import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { masterConfigSchema } from '../src/master.js';
import { emptyDaemonState, type DaemonEffects } from '../src/master-daemon.js';
import type { Cycle } from '../src/daemon/cycle.js';
import { isClosed, type Principal, type Work } from '../src/model.js';
import * as model from '../src/model.js';
import type { Services } from '../src/server/routes.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// GY-1694/GY-1799: the 2026-10-13 instants are the fixture's own clock, judged against the explicit `now` below: the daemon cycle is handed that `now`, and the delivered-observation close reads its clock from the fixture-clocked store the test hands it (src/server/close.ts judges the worker lease against the transaction's `now`), so nothing judges the fixture against the wall clock and the file holds no wall-clock reading to allow.

// GY-1779: GY-1724, GY-1725 and GY-1759 sat escalated past their windows for "the loop's reading" that
// no loop step recorded. The deployment-verification step now takes every due loop-owned reading on the
// release the control plane serves, through the post-deploy-checks filer and the proof's reader, records
// it as trusted evidence bound as loopObservation reads it, closes a pass as delivered-observation in the
// same pass, raises the escalation of a fail naming the measured values, and records why a reading this
// host cannot take was not taken. Every new module is imported at call time, so the base tree fails a case.
const hour = 3_600_000, now = Date.parse('2026-10-13T12:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const filed = sha('a'), serving = sha('b'), mergeSha = sha('c');
const parentId = '11111111-1111-4111-8111-111111111111';
const proof = 'manual:post-deploy/webhook-deliveries-clean-24h', own = 'manual:webhook-deliveries-clean-24h-on-serving-release';
const base = (n: number, extra: Partial<Work> = {}): Work => ({
  id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, key: `GY-${n}`, title: `Item ${n}`, description: '', type: 'chore', priority: 1, stage: 'ready', ready: true, epoch: 0, revision: 3, policyRevision: 1,
  createdAt: iso(now - 30 * hour), updatedAt: iso(now - 2 * hour), stageEnteredAt: iso(now - 2 * hour), lease: null, lastAssignment: null, systemDriven: true, implementers: [],
  workspaces: [], sessions: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], criteria: [], 
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

type Closing = (item: Work, release: string) => void;
/** The loop's cycle over `work` with the reading effects wired as production wires them, the reader and any extra effect injected; `closing` may refuse a close. */
async function makeCycle(work: Work[], directory: string, reader: DaemonEffects['readPostDeploy'], at = now, extra: Partial<DaemonEffects> = {}, closing: Closing = () => {}) {
  const token = join(directory, 'coordinator.token');
  await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: join(directory, 'graphyard.mjs'), repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], run: { deploymentReuseMinutes: 0 } });
  const state = emptyDaemonState(config);
  const recorded: { key: string; reading: Record<string, unknown> }[] = [], closed: { key: string; release: string; reason: string; idempotency: string }[] = [];
  const { localPostDeployChecks } = await import('../src/master-verification.js');
  const served = () => ({ source: 'endpoint', sha: serving, at: iso(at - 60_000), reason: null, deployed: work.filter(item => item.stage === 'done' && item.delivery && item.key !== 'GY-1733').map(item => item.key), pending: [], requests: 1 });
  const effects: DaemonEffects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work, now: iso(at) }), closeSession: () => {}, dispatch: async () => {}, persist: async () => {},
    observeDeployment: async () => served() as never,
    recordDeployment: async () => {},
    recordReading: async (item: Work, reading: Parameters<NonNullable<DaemonEffects['recordReading']>>[1]) => { recorded.push({ key: item.key, reading }); item.evidence.push({ id: randomUUID(), producer: 'graphyard-master', trusted: true, executed: 1, skipped: 0, at: iso(at), proof: reading.proof, sha: reading.sha, baseSha: reading.baseSha, policyRevision: reading.policyRevision, result: reading.result, reading: { detail: reading.detail } }); },
    closeObservation: async (item: Work, release: string, reason: string, idempotency: string) => { closing(item, release); closed.push({ key: item.key, release, reason, idempotency }); item.stage = 'done'; item.closure = { kind: 'delivered-observation', reason, ref: release, by: 'graphyard-master', at: iso(at), from: 'ready' }; },
    postDeployFiler: localPostDeployChecks, readPostDeploy: reader, ...extra,
  } as unknown as DaemonEffects;
  const cycle = { config, state, effects, now: () => at, clock: at, clockOffset: { min: 0, max: 0 }, performed: [], snapshot: { work, now: iso(at) }, open: work.filter(item => item.stage !== 'done'),
    isolate: async (_kind: string, _item: unknown, _name: string, body: () => Promise<unknown>) => body(), detached: false, launcher: { busy: () => false }, timings: { step: async (_name: string, body: () => Promise<unknown>) => body() } } as unknown as Cycle;
  const next = () => { cycle.state.cycle++; cycle.performed.length = 0; cycle.open = work.filter(item => item.stage !== 'done'); };
  return { state, recorded, closed, cycle, served, next };
}
async function cycleOver(work: Work[], directory: string, reader: DaemonEffects['readPostDeploy'], at = now, extra: Partial<DaemonEffects> = {}, closing: Closing = () => {}) {
  const made = await makeCycle(work, directory, reader, at, extra, closing);
  const { deploymentStep } = await import('../src/daemon/cycle-delivery.js');
  await deploymentStep(made.cycle);
  return { ...made, again: async () => { made.next(); await deploymentStep(made.cycle); } };
}

test('integration:loop-records-due-observation-reading — the deployment-verification step reads every due loop-owned item on the serving release through the filer and the reader, records the reading bound as loopObservation reads it, closes a pass as delivered-observation and raises a fail naming the measured values', async () => {
  const { loopObservation } = model as unknown as { loopObservation: (work: Work, at: Date, all: Work[]) => { due: boolean } | null };
  const passing = followUp(1724), failing = followUp(1726), untakeable = followUp(1727), windowed = followUp(1728, { observationWindow: { notBefore: iso(now + 6 * hour), basis: 'criterion-window', detail: 'later' } });
  // GY-1725 as it stands: an unsubmitted pre-GY-1762 worker candidate left in build is read the same way.
  const inBuild = followUp(1725, { stage: 'build', epoch: 3, candidate: { pr: 1172, sha: sha('d'), baseSha: sha('e'), author: 'bot', branch: 'graphyard/gy-1725-3', createdAt: iso(now - 5 * hour) } } as Partial<Work>);
  // The parent already carries a trusted passing observation of the proof on the serving release: the filer reads it observed, and no reader runs.
  const observedParent = { ...parent, id: '22222222-2222-4222-8222-222222222222', key: 'GY-1749', evidence: [{ id: randomUUID(), proof, sha: serving, baseSha: mergeSha, policyRevision: 1, producer: 'graphyard-producer', trusted: true, result: 'pass', executed: 1, skipped: 0, at: iso(now - hour) }] } as Work;
  const observed = followUp(1759, { description: `Post-deploy follow-up: post-deploy:${observedParent.id}:AC-2:${proof}:${filed}\n\nowed` });
  const asked: string[] = [];
  const reader: DaemonEffects['readPostDeploy'] = async input => {
    asked.push(input.item.key);
    assert.equal(input.proof, proof, 'the reader is asked for the parent\'s declared proof'); assert.equal(input.release, serving); assert.equal(input.criterion?.id, 'AC-2');
    if (input.item.key === 'GY-1726') return { result: 'fail', detail: 'the advanced delivery log shows 3 failed deliveries (2 × 502, 1 connection failure) in the 24 hours to 2026-10-13T12:00Z' };
    if (input.item.key === 'GY-1727') return { unavailable: 'the App\'s advanced delivery log needs a browser sign-in no loop step holds' };
    return { result: 'pass', detail: 'the advanced delivery log shows 0 failed deliveries in the 24 hours to 2026-10-13T12:00Z' };
  };
  const work = [parent, observedParent, passing, failing, untakeable, windowed, inBuild, observed];
  for (const item of [passing, failing, untakeable, inBuild, observed]) assert.equal(loopObservation(item, new Date(now), work)?.due, true, `${item.key} is due`);
  assert.equal(loopObservation(windowed, new Date(now), work)?.due, false);
  const directory = await temporaryDirectory('loop-readings');
  const run = await cycleOver(work, directory, reader);
  // Every due reading was taken on the serving release — a later release than the follow-ups were filed for, observed carrying the parent's merge — never the windowed one.
  assert.deepEqual(asked.sort(), ['GY-1724', 'GY-1725', 'GY-1726', 'GY-1727'], 'the observed parent\'s follow-up needs no reader: the filer reads it observed');
  const reading = (key: string) => run.recorded.find(entry => entry.key === key)?.reading;
  for (const key of ['GY-1724', 'GY-1725', 'GY-1726', 'GY-1759']) assert.deepEqual([reading(key)?.proof, reading(key)?.sha, reading(key)?.baseSha, reading(key)?.policyRevision], [own, serving, mergeSha, 1], `${key}'s reading is bound as loopObservation reads it`);
  assert.equal(reading('GY-1727'), undefined, 'a reading this host cannot take is not recorded');
  assert.equal(reading('GY-1728'), undefined, 'a reading that cannot exist yet is not taken');
  assert.deepEqual([reading('GY-1724')?.result, reading('GY-1725')?.result, reading('GY-1726')?.result, reading('GY-1759')?.result], ['pass', 'pass', 'fail', 'pass']);
  assert.match(String(reading('GY-1759')?.detail), /post-deploy-checks filer reads GY-1749 AC-2's manual:post-deploy\/webhook-deliveries-clean-24h observed on release bbbbbbbbbbbb/);
  // The recorded reading ends the wait as loopObservation reads it, on the serving release rather than the filed one.
  for (const item of [passing, inBuild, observed]) assert.equal(loopObservation(item, new Date(now), work), null, `${item.key}'s wait ended`);
  assert.equal(loopObservation(failing, new Date(now), work)?.due, true, 'a failed reading leaves the wait standing');
  // A pass closes the item as delivered-observation in the same pass, on the release it was read on.
  assert.deepEqual(run.closed.map(entry => [entry.key, entry.release]).sort(), [['GY-1724', serving], ['GY-1725', serving], ['GY-1759', serving]]);
  assert.match(run.closed.find(entry => entry.key === 'GY-1724')!.reason, /passed on the serving release bbbbbbbbbbbb: manual:webhook-deliveries-clean-24h-on-serving-release: the advanced delivery log shows 0 failed deliveries/);
  assert.equal(run.closed.find(entry => entry.key === 'GY-1724')!.idempotency, `reading:close:${passing.id}:${serving}`);
  // A fail records the reading, raises the item's escalation naming the measured values and is asked again on the backoff, never closed.
  const escalation = run.state.actions[`escalation:reading:${failing.id}`];
  assert.equal(escalation?.kind, 'escalation');
  assert.match(escalation!.detail, /GY-1726's reading of manual:webhook-deliveries-clean-24h-on-serving-release failed on the serving release bbbbbbbbbbbb: .*3 failed deliveries \(2 × 502, 1 connection failure\)/);
  assert.equal(run.state.actions[`reading:${failing.id}`]?.state, 'waiting');
  // A reading this host cannot take records why, so the item is never left owed to nobody.
  const untaken = run.state.actions[`reading:${untakeable.id}`];
  assert.equal(untaken?.state, 'waiting');
  assert.match(untaken!.detail, /GY-1727's reading is due on release bbbbbbbbbbbb and cannot be taken from this host: manual:webhook-deliveries-clean-24h-on-serving-release: the App's advanced delivery log needs a browser sign-in/);
  assert.equal(run.state.actions[`reading:${windowed.id}`], undefined);
  assert.equal(run.state.actions[`reading:${passing.id}`]?.state, 'done');
  assert.match(run.state.actions[`reading:${passing.id}`]!.detail, /closed it as delivered-observation/);
  // The next cycle records nothing twice: a done reading stands, and the failed one is read again on its backoff but, failing again, is not recorded a second time.
  const before = run.recorded.length, askedBefore = asked.length;
  await run.again();
  assert.equal(run.recorded.length, before);
  assert.deepEqual(asked.slice(askedBefore), ['GY-1726', 'GY-1727'], 'the failed and the untakeable readings are asked again; the done ones never');
  assert.equal(run.state.actions[`reading:${failing.id}`]?.attempts, 2);
  assert.equal(run.closed.length, 3);
});

test('integration:loop-records-due-observation-reading — a follow-up owing a second proof reads a proof no parent proof stands behind as unavailable, never as the first', async () => {
  const second = 'manual:other-check-on-serving-release', multi = followUp(1735, { criteria: [followUp(1735).criteria[0], { id: 'AC-2', text: 'a second check', proofs: [second] }] });
  const asked: string[] = [];
  // The parent's filer would read the request's proof observed: the second proof must not borrow that.
  const reader: DaemonEffects['readPostDeploy'] = async input => { asked.push(input.proof); return { result: 'pass', detail: 'read' }; };
  const run = await cycleOver([parent, multi], await temporaryDirectory('loop-readings-multi'), reader);
  assert.deepEqual(asked, [proof], 'only the request\'s own proof is read through the parent proof');
  assert.deepEqual(run.recorded, [], 'a reading waits for every proof: nothing is recorded while the second cannot be taken');
  assert.match(run.state.actions[`reading:${multi.id}`]!.detail, /manual:other-check-on-serving-release is not the item proof of exactly one post-deploy proof of GY-1700/);
});

test('integration:loop-records-due-observation-reading — an added proof with its own parent post-deploy check is read through that parent proof, and an older parent carried only by the serving release\'s retained containment is read', async () => {
  const added = 'manual:post-deploy/other-check', addedOwn = 'manual:other-check-on-serving-release';
  const two = { ...parent, criteria: [parent.criteria[0], { id: 'AC-3', text: 'another live check', proofs: [added] }] } as Work;
  const multi = followUp(1736, { criteria: [followUp(1736).criteria[0], { id: 'AC-2', text: 'a second check', proofs: [addedOwn] }] });
  const asked: string[] = [];
  const reader: DaemonEffects['readPostDeploy'] = async input => { asked.push(input.proof); return { result: 'pass', detail: 'read' }; };
  const settled = { release: serving, settled: { [two.key]: serving } };
  const run = await cycleOver([two, multi], await temporaryDirectory('loop-readings-added'), reader, now, { observeDeployment: async () => ({ source: 'endpoint', sha: serving, at: iso(now - 60_000), reason: null, deployed: [], pending: [], requests: 1, containment: settled }) as never });
  assert.deepEqual(asked.sort(), [added, proof].sort(), 'each item proof reads through the parent proof it was filed for');
  assert.equal(run.recorded.length, 2);
});

test('integration:loop-records-due-observation-reading — an unreleased item or one with unfinished dependencies is not read, recorded or closed', async () => {
  const unreleased = followUp(1741, { ready: false }), waiting = followUp(1742, { dependencies: [base(1799).id] }), blocker = base(1799, { stage: 'ready' });
  const asked: string[] = [];
  const run = await cycleOver([parent, unreleased, waiting, blocker], await temporaryDirectory('loop-readings-unreleased'), async input => { asked.push(input.item.key); return { result: 'pass', detail: 'read' }; });
  assert.deepEqual(asked, [], 'neither item is read');
  assert.deepEqual([run.recorded, run.closed], [[], []]);
});

test('integration:loop-records-due-observation-reading — two parent proofs sharing one item proof name are never confused: the request\'s own proof is read, an unrequested ambiguous one is unavailable', async () => {
  const first = 'manual:post-deploy/a/b', second = 'manual:post-deploy/a-b', shared = 'manual:a-b-on-serving-release';
  const two = { ...parent, criteria: [{ id: 'AC-2', text: 'first', proofs: [first] }, { id: 'AC-3', text: 'second', proofs: [second] }] } as Work;
  const request = (name: string) => `Post-deploy follow-up: post-deploy:${parentId}:AC-3:${name}:${filed}\n\nowed`;
  const asked: string[] = [];
  const reader: DaemonEffects['readPostDeploy'] = async input => { asked.push(input.proof); return { result: 'pass', detail: 'read' }; };
  const mine = followUp(1743, { description: request(second), criteria: [{ id: 'AC-1', text: 'second', proofs: [shared] }] });
  await cycleOver([two, mine], await temporaryDirectory('loop-readings-collide-own'), reader);
  assert.deepEqual(asked, [second], 'the proof the follow-up was filed for, not the first that shares its name');
  asked.length = 0;
  const other = followUp(1744, { description: request('manual:post-deploy/elsewhere'), criteria: [{ id: 'AC-1', text: 'ambiguous', proofs: [shared] }] });
  const run = await cycleOver([two, other], await temporaryDirectory('loop-readings-collide-ambiguous'), reader);
  assert.deepEqual([asked, run.recorded], [[], []], 'an ambiguous name reads as neither');
});

test('integration:loop-records-due-observation-reading — a definite fail is recorded and escalated although another proof of the item is unavailable', async () => {
  const second = 'manual:post-deploy/other-check', secondOwn = 'manual:other-check-on-serving-release';
  const two = { ...parent, criteria: [parent.criteria[0], { id: 'AC-3', text: 'another live check', proofs: [second] }] } as Work;
  const multi = followUp(1745, { criteria: [followUp(1745).criteria[0], { id: 'AC-2', text: 'a second check', proofs: [secondOwn] }] });
  const reader: DaemonEffects['readPostDeploy'] = async input => input.proof === proof ? { result: 'fail', detail: 'three failed deliveries' } : { unavailable: 'no reader' };
  const run = await cycleOver([two, multi], await temporaryDirectory('loop-readings-fail-unavailable'), reader);
  assert.deepEqual(run.recorded.map(entry => [entry.reading.proof, entry.reading.result]), [[own, 'fail']]);
  assert.match(run.state.actions[`escalation:reading:${multi.id}`]!.detail, /three failed deliveries/);
  assert.deepEqual(run.closed, []);
});

test('integration:loop-records-due-observation-reading — a due reading never stands on a reused observation: production may have rolled within the reuse window', async () => {
  const item = followUp(1737), directory = await temporaryDirectory('loop-readings-reuse'), observed: number[] = [];
  const made = await makeCycle([parent, item], directory, async () => ({ result: 'pass', detail: 'read' }), now, { observeDeployment: async () => { observed.push(1); return made.served() as never; } });
  (made.cycle.config.run as { deploymentReuseMinutes?: number }).deploymentReuseMinutes = 15;
  made.state.deployment = { ...made.served(), at: iso(now - 60_000), pending: [] } as never;
  const { deploymentStep } = await import('../src/daemon/cycle-delivery.js');
  await deploymentStep(made.cycle);
  assert.equal(observed.length, 2, 'the due reading reads the release afresh, then observes it again after its reads');
});

test('integration:loop-records-due-observation-reading — a reading taken while the plane moved to another release is discarded unrecorded and never closes the item', async () => {
  const item = followUp(1738), directory = await temporaryDirectory('loop-readings-moved'), asks: number[] = [];
  const moved = 'f'.repeat(40);
  const made = await makeCycle([parent, item], directory, async () => ({ result: 'pass', detail: 'read' }), now, { observeDeployment: async () => { asks.push(1); return (asks.length > 1 ? { ...made.served(), sha: moved } : made.served()) as never; } });
  const { deploymentStep } = await import('../src/daemon/cycle-delivery.js');
  await deploymentStep(made.cycle);
  assert.equal(asks.length, 2);
  assert.deepEqual(made.recorded, [], 'a reading of a release the plane has left is recorded nowhere');
  assert.deepEqual(made.closed, [], 'and closes nothing');
  assert.match(made.state.actions[`reading:${item.id}`].detail, /moved to ffffffffffff/);
});

test('integration:loop-records-due-observation-reading — a fail measured on a later release is recorded even when the proof\'s newest reading failed on an earlier one', async () => {
  const item = followUp(1738), directory = await temporaryDirectory('loop-readings-later-fail');
  item.evidence.push({ id: randomUUID(), producer: 'graphyard-master', trusted: true, executed: 1, skipped: 0, at: iso(now - 2 * hour), proof: own, sha: filed, baseSha: mergeSha, policyRevision: 1, result: 'fail', reading: { detail: 'earlier release failed' } } as never);
  const made = await cycleOver([parent, item], directory, async () => ({ result: 'fail', detail: 'still failing on the serving release' }));
  assert.deepEqual(made.recorded.map(entry => [entry.key, entry.reading.sha, entry.reading.result]), [['GY-1738', serving, 'fail']], 'the fail on the serving release is durable evidence bound to it');
});

test('integration:loop-records-due-observation-reading — the serving release not yet observed carrying the parent\'s merge, or unobserved this cycle, records why and takes no reading', async () => {
  const item = followUp(1731), directory = await temporaryDirectory('loop-readings-unserved');
  const other = { ...parent, id: '33333333-3333-4333-8333-333333333333', key: 'GY-1733' } as Work;
  const orphan = followUp(1732, { description: `Post-deploy follow-up: post-deploy:${other.id}:AC-2:${proof}:${filed}\n\nowed` });
  const run = await cycleOver([parent, other, item, orphan], directory, async () => ({ result: 'pass', detail: 'clean' }));
  assert.deepEqual(run.recorded.map(entry => entry.key), ['GY-1731']);
  const unserved = run.state.actions[`reading:${orphan.id}`];
  assert.equal(unserved?.state, 'waiting');
  assert.match(unserved!.detail, /release the control plane serves \(bbbbbbbbbbbb\) is not observed carrying GY-1733's merge cccccccccccc/);
});

test('integration:loop-records-due-observation-reading — a recorded pass whose close was refused is closed next cycle under the same idempotency key without a second record, and a pass recorded by hand is closed on the release it was read on', async () => {
  const refused = followUp(1741);
  // GY-1725 by hand: `master reading GY-1742 pass …` recorded the pass on the filed release an hour before its close was ever attempted.
  const byHand = followUp(1742, { evidence: [{ id: randomUUID(), proof: own, sha: filed, baseSha: mergeSha, policyRevision: 1, producer: 'readings-master', trusted: true, result: 'pass', executed: 1, skipped: 0, at: iso(now - 30 * 60_000), reading: { detail: 'the advanced delivery log shows 0 failed deliveries, read by hand' } }] } as Partial<Work>);
  const asked: string[] = [];
  let refusing = true;
  const run = await cycleOver([parent, refused, byHand], await temporaryDirectory('loop-readings-close'), async input => { asked.push(input.item.key); return { result: 'pass', detail: 'clean' }; }, now, {},
    (item: Work) => { if (refusing && item.key === 'GY-1741') throw Object.assign(new Error('GitHub refused closing #1172 (503): upstream unavailable'), { status: 503 }); });
  // The hand-recorded pass needed no reader and closed on the filed release, where it was read, under its key.
  assert.deepEqual(asked, ['GY-1741'], 'the item whose pass is recorded is not read again');
  assert.deepEqual(run.closed.map(entry => [entry.key, entry.release, entry.idempotency]), [['GY-1742', filed, `reading:close:${byHand.id}:${filed}`]]);
  assert.equal(run.state.actions[`reading:${byHand.id}`]?.state, 'done');
  assert.match(run.state.actions[`reading:${byHand.id}`]!.detail, /closed it as delivered-observation: manual:webhook-deliveries-clean-24h-on-serving-release: the advanced delivery log shows 0 failed deliveries, read by hand/);
  // The refused close is a failed action on the item: the pass stands recorded, and the item is still open.
  assert.deepEqual(run.recorded.map(entry => entry.key), ['GY-1741']);
  const failed = run.state.actions[`reading:${refused.id}`];
  assert.equal(failed?.state, 'failed');
  assert.match(failed!.detail, /Recorded GY-1741's passing reading on release bbbbbbbbbbbb, and could not close it as delivered-observation: GitHub refused closing #1172 \(503\)/);
  assert.equal(refused.stage, 'ready');
  // Next cycle the loop closes it on the recorded pass: no second reading, no reader, the same idempotency key.
  refusing = false;
  await run.again();
  assert.deepEqual(asked, ['GY-1741']);
  assert.deepEqual(run.recorded.map(entry => entry.key), ['GY-1741']);
  assert.deepEqual(run.closed.map(entry => [entry.key, entry.release, entry.idempotency]).sort(), [['GY-1741', serving, `reading:close:${refused.id}:${serving}`], ['GY-1742', filed, `reading:close:${byHand.id}:${filed}`]]);
  assert.deepEqual([run.state.actions[`reading:${refused.id}`]?.state, run.state.actions[`reading:${refused.id}`]?.attempts], ['done', 2]);
  assert.match(run.state.actions[`reading:${refused.id}`]!.detail, /closed it as delivered-observation: manual:webhook-deliveries-clean-24h-on-serving-release: clean/);
  // Closed items are left alone.
  await run.again();
  assert.equal(run.closed.length, 2);
});

test('integration:loop-records-due-observation-reading — the reads run under the deployment step\'s budget: a reading still running at the bound is deferred, left in flight and recorded by the cycle that finds it settled; the report is read once per item for the filer and the reader together', async () => {
  const { readingsStep } = await import('../src/daemon/cycle-readings.js');
  const { postDeployReader } = await import('../src/master/post-deploy-readings.js');
  // A pattern proof: the reader takes it from the intervention report's row the filer's projection already read.
  const patternProof = 'manual:post-deploy/intervention-pattern-escalation-build', ownPattern = 'manual:intervention-pattern-escalation-build-on-serving-release';
  const patternParent = { ...parent, id: '44444444-4444-4444-8444-444444444444', key: 'GY-1744', criteria: [{ id: 'AC-2', text: 'The intervention report shows the escalation rate at the build stage below 3 per 1 days after it ships', proofs: [patternProof] }] } as Work;
  const item = followUp(1745, { description: `Post-deploy follow-up: post-deploy:${patternParent.id}:AC-2:${patternProof}:${filed}\n\nowed`, criteria: [{ id: 'AC-1', text: 'From this head against the serving release: the escalation rate at the build stage stays below 3 per 1 days', proofs: [ownPattern] }] });
  let release: (() => void) | null = null;
  const reads: string[] = [];
  const readPattern = async (pattern: { kind: string; stage: string }) => { reads.push(`${pattern.kind}-${pattern.stage}`); await new Promise<void>(resolve => { release = resolve; }); return { since: iso(now - 3 * 24 * hour), projected: null }; };
  const made = await makeCycle([patternParent, item], await temporaryDirectory('loop-readings-budget'), postDeployReader(readPattern as never), now, { readPattern: readPattern as never });
  // The report read does not settle within the 5 ms left: the reading is deferred, nothing is noted, and the read is left in flight.
  assert.equal(await readingsStep(made.cycle, made.served() as never, now + 5), 1);
  assert.deepEqual([made.recorded.length, made.state.actions[`reading:${item.id}`]], [0, undefined]);
  assert.deepEqual(reads, ['escalation-build'], 'the report was read once, for the filer');
  // The read settles; the next cycle records the reading from it — the reader took the projection the filer read, never the report again — and closes the item.
  release!();
  made.next();
  assert.equal(await readingsStep(made.cycle, made.served() as never, now + 5), 0);
  assert.deepEqual(reads, ['escalation-build'], 'the reader took the projection already read');
  assert.deepEqual(made.recorded.map(entry => [entry.key, entry.reading.result]), [['GY-1745', 'pass']]);
  assert.match(String(made.recorded[0].reading.detail), /under its threshold since 2026-10-10T12:00:00.000Z, 3.0 days at 2026-10-13T12:00:00.000Z, which meets the 1-day window on release bbbbbbbbbbbb/);
  assert.deepEqual(made.closed.map(entry => [entry.key, entry.release]), [['GY-1745', serving]]);
});

// The control plane's side of the same pass, against a real Postgres: the coordinator's `reading`
// command records the trusted evidence loopObservation binds to a later serving release, refuses a
// reading of anything else, and closing as delivered-observation closes the superseded pull request.
const repository = 'owner/loop-readings';
const operator: Principal = { id: 'readings-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'readings-master', role: 'coordinator', sessionKind: 'ai' };
const worker: Principal = { id: 'readings-worker', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, worker].map(principal => ({ ...principal, token: `readings-${principal.id}-${'x'.repeat(32)}` }));
let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1790;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('loop-readings-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('readings_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/readings_test`); await store.init();
  engine = new Engine(store, 300, repository); engine.submissionObserver = null;
});
after(async () => { await store?.close(); await database?.stop(); });
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
/** An item created through the engine, then written as the control plane would have left it: the fixture for what the reading binds to. */
async function plant(shape: Work): Promise<Work> {
  const created = await engine.execute(operator, 'create', null, { title: shape.title, criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:readings'] }] }, randomUUID()) as Work;
  const { id, key, ...rest } = shape;
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [created.id, JSON.stringify({ ...created, ...rest, id: created.id, key: created.key })]);
  return reload(created.id);
}

/** GY-1799: the close path's services with the store's clock replaced — every transaction the close opens (src/server/close.ts judges the worker lease against the transaction's `now`) is handed the fixture's `now`, so the live-lease refusal is judged against the fixture's own clock, never the database's wall clock. */
function clockedServices(): Services {
  const clocked = Object.assign(Object.create(engine), { store: Object.assign(Object.create(store), {
    transaction: (fn: Parameters<Store['transaction']>[0], options?: Parameters<Store['transaction']>[1]) => store.transaction((db, at) => fn(db, new Date(now)), options),
  }) as Store });
  return { engine: clocked, repository, principals: [] } as unknown as Services;
}

test('integration:loop-records-due-observation-reading — the coordinator records the reading as trusted evidence bound to the serving release, refuses one off the parent\'s merge or on another item, and and the delivered-observation close closes the item, touching no pull request', async () => {
  const { loopObservation } = model as unknown as { loopObservation: (work: Work, at: Date, all: Work[]) => { due: boolean } | null };
  const delivered = await plant(parent);
  const item = await plant({ ...followUp(0, { stage: 'build', epoch: 2, candidate: { pr: 1172, sha: sha('d'), baseSha: sha('e'), author: 'bot', branch: 'graphyard/gy-x-2', createdAt: iso(now - hour) } } as Partial<Work>), description: `Post-deploy follow-up: post-deploy:${delivered.id}:AC-2:${proof}:${filed}\n\nowed` } as Work);
  const code = await plant(base(0, { criteria: [{ id: 'AC-1', text: 'Code', proofs: ['unit:code'] }] }));
  const reading = { proof: own, sha: serving, baseSha: mergeSha, policyRevision: 1, result: 'pass' as const, detail: 'the advanced delivery log shows 0 failed deliveries in 24 hours' };
  await assert.rejects(engine.execute(worker, 'reading', item.id, reading, randomUUID()), /Coordinator permission required/);
  await assert.rejects(engine.execute(coordinator, 'reading', code.id, { ...reading, proof: 'unit:code' }, randomUUID()), /not a loop-owned observation item/);
  await assert.rejects(engine.execute(coordinator, 'reading', item.id, { ...reading, baseSha: sha('f') }, randomUUID()), /bound to the parent delivery's merge/);
  const { closeWork } = await import('../src/server/close.js');
  const services = clockedServices();
  const close = (principal: Principal, id: string, ref: string | null = serving) => closeWork(services, principal, id, { kind: 'delivered-observation', reason: 'read', ref }, randomUUID());
  // No reading yet: the close is refused. A worker never closes; neither does the kind close a code item.
  await assert.rejects(close(coordinator, item.id), /carries no passing reading of manual:webhook-deliveries-clean-24h-on-serving-release as the loop reads one/);
  await assert.rejects(close(worker, item.id), /Only the master \(coordinator or operator agent\) or an admin may close work/);
  await assert.rejects(close(coordinator, code.id), /is not a loop-owned observation item/);
  // Only a failed reading: still refused.
  await engine.execute(coordinator, 'reading', item.id, { ...reading, result: 'fail', detail: '2 failed deliveries' }, randomUUID());
  await assert.rejects(close(coordinator, item.id), /carries no passing reading/);
  const read = await engine.execute(coordinator, 'reading', item.id, reading, randomUUID()) as Work;
  const entry = read.evidence.at(-1)!;
  assert.deepEqual([entry.trusted, entry.producer, entry.sha, entry.baseSha, entry.result, entry.reading], [true, coordinator.id, serving, mergeSha, 'pass', { detail: reading.detail }]);
  assert.equal(loopObservation(read, new Date(now), [delivered]), null, 'the loop\'s reading on the later serving release ends the wait');
  // The pass is on the serving release: a close naming another release, or none, is refused; so is one while a worker lease is live.
  await assert.rejects(close(coordinator, item.id, null), /names the release its reading was taken on/);
  await assert.rejects(close(coordinator, item.id, filed), /passing reading was taken on release bbbbbbbbbbbb, not aaaaaaaaaaaa/);
  // The close judges the lease against the fixture-clocked store's `now` (clockedServices), so the fixture's own expiry — now + 24 h — stays live on any wall-clock date (GY-1799, superseding GY-1795's wall-clock lease).
  const leased = await plant({ ...followUp(0, { stage: 'build', epoch: 2, lease: { owner: worker.id, epoch: 2, expiresAt: iso(now + 24 * hour) }, candidate: { pr: 1174, sha: sha('d'), baseSha: sha('e'), author: 'bot', branch: 'graphyard/gy-y-2', createdAt: iso(now - hour) }, evidence: [{ ...entry, id: randomUUID() }] } as Partial<Work>), description: `Post-deploy follow-up: post-deploy:${delivered.id}:AC-2:${proof}:${filed}\n\nowed` } as Work);
  await assert.rejects(close(coordinator, leased.id), /has a live worker lease/);
  // The close as delivered-observation closes the item on the reading; since GY-2010 no pull request is touched or recorded.
  const closed = await closeWork(services, coordinator, item.id, { kind: 'delivered-observation', reason: `${read.key}'s reading passed on the serving release`, ref: serving }, randomUUID()) as Work;
  assert.deepEqual([closed.stage, closed.closure?.kind, closed.closure?.ref, closed.closure?.by, isClosed(closed)], ['done', 'delivered-observation', serving, coordinator.id, true]);
  const audit = (await store.pool.query("SELECT payload FROM events WHERE work_id=$1 AND kind='work.closed'", [item.id])).rows[0].payload;
  assert.equal(audit.details.pullRequest, undefined, 'the closure records no pull request');
  assert.equal(closed.closure?.pullRequest, undefined);
  assert.equal((await store.pool.query("SELECT 1 FROM events WHERE work_id=$1 AND kind='work.pull-request-closed'", [item.id])).rowCount, 0);
});

test('unit:observation-reading-close-judges-fixture-clock — the delivered-observation close judges a live worker lease against the fixture clock it is handed, never the wall clock', async () => {
  const delivered = await plant(parent);
  const owed = async (extra: Partial<Work>) => plant({ ...followUp(0, { stage: 'build', epoch: 2, ...extra } as Partial<Work>), description: `Post-deploy follow-up: post-deploy:${delivered.id}:AC-2:${proof}:${filed}\n\nowed` } as Work);
  const reading = { id: randomUUID(), producer: coordinator.id, trusted: true, executed: 1, skipped: 0, at: iso(now - 30 * 60_000), proof: own, sha: serving, baseSha: mergeSha, policyRevision: 1, result: 'pass' as const, reading: { detail: 'the advanced delivery log shows 0 failed deliveries in 24 hours' } };
  // The lease expires a fixture-day after the fixture's `now`: judged against the clock the close is
  // handed, it is live and the close refuses. Judged against the wall clock it reads expired and the
  // item would close — the time bomb this proof pins shut.
  const leased = await owed({ lease: { owner: worker.id, epoch: 2, expiresAt: iso(now + 24 * hour) }, evidence: [{ ...reading, id: randomUUID() }] });
  const { closeWork } = await import('../src/server/close.js');
  await assert.rejects(closeWork(clockedServices(), coordinator, leased.id, { kind: 'delivered-observation', reason: 'read', ref: serving }, randomUUID()), /has a live worker lease/);
  // The same close through the same clocked path on an unleased twin closes: the refusal is the lease
  // itself, judged live at the fixture's now, not the handed clock refusing everything.
  const free = await owed({ evidence: [{ ...reading, id: randomUUID() }] });
  const closed = await closeWork(clockedServices(), coordinator, free.id, { kind: 'delivered-observation', reason: 'read', ref: serving }, randomUUID()) as Work;
  assert.deepEqual([closed.stage, closed.closure?.kind, isClosed(closed)], ['done', 'delivered-observation', true]);
});
