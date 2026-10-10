import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActionRow } from '../src/model/actions.js';
import type { Work } from '../src/model.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import * as deliveryStep from '../src/daemon/cycle-delivery.js';
import { throughputEscalatedAt, throughputEscalationKey } from '../src/daemon/cycle-delivery.js';
import { openThroughputOwner, throughputAnsweredAt, throughputClaimVisibility, throughputDecision, throughputOwnerAnswered, throughputOwnerItem, verifyThroughput, type ThroughputReport } from '../src/throughput.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1609: a throughput owner stays open across releases, so the escalated miss it answers is on the
// release serving when the loop closes it, not the one in its title. The loop and master status
// judge that answer alike, the loop raises a standing needs-decision on an open owner before any
// revision can answer it, and master status never asks `master decide` for a decision already applied.
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
/** A request-rework left actionable and unclaimed for ten minutes: the idle budget missed over an admitted population. */
const staleRework = { ...row('request-rework', [
  { at: at(12), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: '' },
  { at: at(22), event: 'cancelled', requester: 'graphyard', executor: null, result: null, reason: 'now needs dispatch instead' },
]), id: 'rework-runnable', attempts: 0 } as unknown as ActionRow;
function delivery(key: string, history: ActionRow[] = [executed]): Work {
  return {
    id: key.toLowerCase(), key, title: `Delivery ${key}`, stage: 'done', gates: [], violations: [], policy: { checks: [], review: true }, implementers: ['worker-1'], workspaces: [], sessions: [],
    submission: { pr: Number(key.split('-')[1]) }, candidate: null, updatedAt: at(40), delivery: { mergeSha: sha('a'), mergedAt: at(30) },
    pipeline: { attempts: [{ epoch: 1, owner: 'worker-1', claimedAt: at(0), endedAt: at(10), end: 'submitted' }], submittedAt: at(10), reworkRounds: 0, interventions: { blocked: 0, requirements: 0 }, backfill: null },
    actionQueue: { actions: [], history },
  } as unknown as Work;
}
const deliveries = () => [...Array.from({ length: 9 }, (_, index) => delivery(`GY-${600 + index}`)), delivery('GY-468', [executed, staleRework])];
/** The measurement of `release`: ten admitted deliveries whose budgets miss, so an escalated pursuit raises the escalated miss. */
const missed = (release: string): ThroughputReport =>
  verifyThroughput(deliveries(), now, { deployed: { revision: release, version: '1', origin: 'https://example.invalid', observedAt: at(0), containsClaim: true, reason: null }, since: at(-60) });
const ownerOf = (key: string, release: string, policyRevision = 1) => ({ ...delivery(key), id: key.toLowerCase(), title: throughputOwnerItem(release, null).title, stage: 'backlog', criteria: [], ready: false, epoch: 0, lease: null,
  blocker: null, submission: null, reworkRequested: false, dependencies: [], evidence: [], delivery: undefined, closure: undefined, policyRevision, revision: 1, systemDriven: true } as unknown as Work);

/**
 * The loop over a fleet whose serving release the test moves: every release is measured once and
 * shows the escalated miss, filing and closing go through the operator-agent as live, and closing
 * records the loop's reason, so the closed owners carry what the plane would.
 */
async function fleet(directory: string, work: Work[], serving: { release: string }) {
  const token = join(directory, 'coordinator.token');
  await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: join(directory, 'graphyard.mjs'), repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], run: { deploymentReuseMinutes: 0 } });
  const state = emptyDaemonState(master);
  state.lock = { id: 'lock', pid: process.pid, host: master.hostId, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() };
  const filed: Work[] = [], closed: string[] = [];
  let next = 1605, measured = 0;
  const asked = new Set<string>();
  let clock = Date.now();
  const stall = (release: string) => throughputDecision(missed(release), escalated);
  const effects: DaemonEffects = {
    agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work, now: new Date().toISOString() }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'endpoint', sha: serving.release, at: new Date().toISOString(), reason: null, deployed: [], pending: [], requests: 0 }) as any,
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    // Only a release's first measurement carries the stall: every later ask leaves it to the recorded one.
    measureThroughput: async (_items, observed) => { measured++; return { outcome: 'recorded', revision: observed, verdict: 'unverified', settled: false, stall: asked.has(observed) ? null : (asked.add(observed), stall(observed)),
      detail: `Recorded for ${observed.slice(0, 12)}: unverified: the claim; measured again from ${new Date(clock + 60 * minute).toISOString()} as deliveries accumulate` }; },
    standingThroughputStall: async release => stall(release),
    fileThroughputOwner: async input => { const owner = { ...ownerOf(`GY-${next++}`, serving.release), title: input.title } as Work; filed.push(owner); work.push(owner); return owner; },
    closeThroughputOwner: async (owner, reason) => {
      closed.push(owner.key);
      Object.assign(owner, { stage: 'done', closure: { kind: 'obsolete', reason, ref: null, by: 'operator-agent', at: new Date().toISOString(), from: 'backlog' } });
      return owner;
    },
  };
  // Each cycle a minute apart, the interval at which an open owner reads the standing decision.
  const cycle = () => { clock += (deliveryStep as { throughputStandingReadMs?: number }).throughputStandingReadMs ?? minute; return runCycle(master, state, effects, () => clock); };
  /** master status's throughput line over the serving release, with the loop's escalation record as status reads it. */
  const status = () => {
    const owner = openThroughputOwner(work);
    return throughputClaimVisibility({ report: missed(serving.release), file: 't.json' }, { revision: serving.release, version: '1' }, 10, { escalated: true, text: 'escalated', blocker: null } as any, owner,
      throughputAnsweredAt(work, serving.release), owner ? throughputEscalatedAt(state.actions, owner) : null);
  };
  return { state, effects, filed, closed, cycle, status, measured: () => measured };
}
/** The decide-then-approver ask a throughput line names, or null. */
const decideOn = (line: ReturnType<typeof throughputClaimVisibility>) => /graphyard master decide (GY-\d+) requirements/.exec(line.attention?.next ?? '')?.[1] ?? null;
/** Open owners whose needs-decision a revision already answered: the operatorBacklog residue this item removes. */
const answeredOpen = (work: Work[], actions: Parameters<typeof throughputEscalatedAt>[0]) => work.filter(item => item.title.startsWith(throughputOwnerItem('', null).title.replace(/: $/, '')) && item.stage !== 'done' && !item.closure)
  .filter(item => throughputOwnerAnswered(item, throughputEscalatedAt(actions, item)));

test('integration:answered-owner-closes-in-cycle — an owner open across a release change is asked the serving release\'s escalated miss, closed by the loop in the cycle after its answer is applied, and its successor is never asked the decision already answered, so no master closes it by hand', async () => {
  const directory = await temporaryDirectory('answered-owner-closes');
  try {
    // GY-1601, filed for 77db400620f4, is still open when 07094753fccc serves (2026-10-09T21:03Z).
    const older = sha('7'), serving = { release: sha('0') };
    const predecessor = ownerOf('GY-1601', older);
    const work: Work[] = [predecessor];
    const loop = await fleet(directory, work, serving);
    await loop.cycle();
    assert.equal(loop.state.actions[throughputEscalationKey('GY-1601', 1)]?.state, 'waiting', 'the serving release\'s escalated miss is raised on the open owner');
    assert.equal(decideOn(loop.status()), 'GY-1601', 'and master status asks that same decision on it');

    // The master's revision is approved and applied: the loop closes the owner in the very next cycle.
    predecessor.policyRevision = 2;
    const applied = loop.status();
    assert.equal(decideOn(applied), null, 'the applied decision is never asked again');
    await loop.cycle();
    assert.deepEqual(loop.closed, ['GY-1601'], 'closed by the loop within one cycle of its answer');
    assert.match(predecessor.closure!.reason, new RegExp(`answered by its requirements revision 2; .* files a second owner for ${serving.release.slice(0, 12)} `));
    // Its successor owns the serving release, and the miss on it is answered: neither the loop nor master status asks it again.
    const successor = openThroughputOwner(work)!;
    assert.equal(successor.key, loop.filed[0]!.key);
    assert.equal(throughputAnsweredAt(work, serving.release), Date.parse(predecessor.closure!.at), 'answered on the release it was asked on, whatever the closed owner\'s title says');
    assert.equal(throughputEscalatedAt(loop.state.actions, successor), null, 'the loop raises nothing on the successor');
    for (let cycle = 0; cycle < 3; cycle++) await loop.cycle();
    assert.equal(throughputEscalatedAt(loop.state.actions, successor), null);
    const line = loop.status();
    assert.equal(decideOn(line), null, 'master status asks the successor nothing either (the GY-1605 ask)');
    assert.match(line.attention!.text, new RegExp(`answered at .*, so ${successor.key} carries the verification`));

    // An owner whose standing decision the loop had not raised (no cycle measured since it stood) has it
    // raised from the recorded measurement before any revision can answer it, and closes on that answer.
    const third = ownerOf('GY-1700', older);
    Object.assign(successor, { stage: 'done', closure: { kind: 'obsolete', reason: 'verified elsewhere', ref: null, by: 'operator-agent', at: new Date().toISOString(), from: 'backlog' } });
    serving.release = sha('9');
    work.push(third);
    await loop.cycle();
    assert.equal(throughputEscalatedAt(loop.state.actions, third), 1, 'raised at the revision it stood at');
    delete loop.state.actions[throughputEscalationKey(third.key, 1)];
    await loop.cycle();
    assert.ok(loop.measured() > 0);
    assert.equal(throughputEscalatedAt(loop.state.actions, third), 1, 'read back from the recorded measurement within one cycle, no measurement of its own carrying it');
    third.policyRevision = 2;
    await loop.cycle();
    assert.ok(loop.closed.includes(third.key), 'closed on its answer within one cycle');
    assert.deepEqual(answeredOpen(work, loop.state.actions), [], 'no answered owner is left open');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:next-action-no-decide-on-applied-decision — while the answering revision stands applied on the open owner, master status names no master decide or master approver for it; the line says it is answered and the loop closes it', () => {
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
  assert.match(applied.attention!.text, /GY-1605's needs-decision \(raised at its requirements revision 1\) was answered by its requirements revision 2, which is applied; the loop closes GY-1605 on its next deployment step/);
  // A revision with no decision raised, or the one it was raised at, answers nothing: the decision is still asked.
  for (const raisedAt of [null, 2]) assert.equal(decideOn(throughputClaimVisibility({ report, file: 't.json' }, { revision: release, version: '1' }, 10, pursuit, { ...owner, policyRevision: 2 }, null, raisedAt)), 'GY-1605');
  // An owner the loop closed on the serving release's answer, filed for an older one, answers the successor's ask.
  const closed = { title: throughputOwnerItem(sha('7'), null).title, closure: { kind: 'obsolete', at: at(0), ref: null, by: 'operator-agent', from: 'backlog',
    reason: `GY-1601's needs-decision (raised at its requirements revision 1 on an escalated budget miss) was answered by its requirements revision 2; the loop closes it, and files a second owner for ${release.slice(0, 12)} only while a measurement of it under the applied rule still shows a needs-decision standing` } } as unknown as Work;
  assert.equal(throughputAnsweredAt([closed], release), base);
  assert.equal(decideOn(throughputClaimVisibility({ report, file: 't.json' }, { revision: release, version: '1' }, 10, pursuit, owner, throughputAnsweredAt([closed], release), null)), null);
});

test('integration:answered-owner-bound-to-asked-release — an owner asked on one release whose answer is applied once the next serves answers that release\'s miss only: the closure names the release it was asked on, and the serving release\'s miss is asked on the successor in the same cycle', async () => {
  const directory = await temporaryDirectory('answered-owner-bound');
  try {
    const first = sha('a'), serving = { release: first };
    const work: Work[] = [];
    const loop = await fleet(directory, work, serving);
    await loop.cycle();
    const owner = loop.filed[0]!;
    assert.equal(throughputEscalatedAt(loop.state.actions, owner), 1, 'the miss on the first release is raised on its owner');
    // The next release serves, and its miss stands, before the first release's decision is approved.
    serving.release = sha('b');
    await loop.cycle();
    assert.equal(loop.closed.length, 0, 'unanswered, the owner stays open across the release change');
    owner.policyRevision = 2;
    await loop.cycle();
    assert.deepEqual(loop.closed, [owner.key]);
    assert.match(owner.closure!.reason, new RegExp(`on an escalated budget miss of ${first.slice(0, 12)}\\) was answered by its requirements revision 2`));
    assert.equal(throughputAnsweredAt(work, first), Date.parse(owner.closure!.at), 'the answer counts for the release it was asked on');
    assert.equal(throughputAnsweredAt(work, serving.release), null, 'and never for the release serving when it landed');
    const successor = openThroughputOwner(work)!;
    assert.notEqual(successor.key, owner.key);
    assert.equal(throughputEscalatedAt(loop.state.actions, successor), 1, 'the serving release\'s own escalated miss is asked on the successor in the closing cycle');
    assert.equal(decideOn(loop.status()), successor.key, 'and master status asks it there');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('integration:answered-owner-refreshed-before-raise — a requirements revision applied to the open owner after the cycle\'s snapshot but before the loop raises its decision answers nothing: the loop reads the owner again, raises at that revision, and the owner stays open until a later answer', async () => {
  const directory = await temporaryDirectory('answered-owner-refreshed');
  try {
    const serving = { release: sha('c') };
    const owner = ownerOf('GY-1700', sha('7'));
    const work: Work[] = [owner];
    const loop = await fleet(directory, work, serving);
    // The snapshot the cycle works from carries revision 1; revision 2 is applied as the loop reads the decision standing.
    loop.effects.snapshot = async () => ({ work: work.map(item => ({ ...item })), now: new Date().toISOString() });
    const read = loop.effects.standingThroughputStall!, measure = loop.effects.measureThroughput!;
    loop.effects.standingThroughputStall = async release => { const stall = await read(release); if (stall) owner.policyRevision = 2; return stall; };
    loop.effects.measureThroughput = async (items, observed) => { const outcome = await measure(items, observed); if (outcome.stall) owner.policyRevision = 2; return outcome; };
    loop.effects.readThroughputOwner = async item => ({ ...work.find(held => held.id === item.id)! });
    await loop.cycle();
    assert.equal(throughputEscalatedAt(loop.state.actions, owner), 2, 'raised at the revision the owner holds now, not the snapshot\'s');
    for (let cycle = 0; cycle < 3; cycle++) await loop.cycle();
    assert.deepEqual(loop.closed, [], 'the revision applied before the raise answers nothing');
    assert.equal(decideOn(loop.status()), owner.key, 'master status still asks the decision');
    owner.policyRevision = 3;
    await loop.cycle();
    assert.deepEqual(loop.closed, [owner.key], 'the later answer closes it within one cycle');
    // Unreadable, the owner's decision is not raised from the stale snapshot: a later read raises it.
    const other = ownerOf('GY-1701', sha('7'));
    Object.assign(owner, { stage: 'done' });
    work.splice(0, work.length, other);
    serving.release = sha('d');
    loop.effects.readThroughputOwner = async () => { throw new Error('control plane unreachable'); };
    await loop.cycle();
    assert.equal(throughputEscalatedAt(loop.state.actions, other), null, 'nothing raised on an unread owner');
    loop.effects.readThroughputOwner = async item => ({ ...work.find(held => held.id === item.id)! });
    await loop.cycle();
    assert.notEqual(throughputEscalatedAt(loop.state.actions, other), null, 'raised once the owner reads');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
