import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { mergeRecordKey, mergeWriterIdle, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { MergePorts, MergeRecordEvent } from '../src/merge-writer/executor.js';
import type { MergeLedgerState } from '../src/model/merge-ledger.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';

// GY-1852: a merge record whose reply was lost is replayed with its exact input under its exact key,
// and a key the server refuses as reused is never sent again: the ledger is adopted and the next
// attempt runs under a new attempt id.

const start = Date.parse('2030-04-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const tip = sha('main-tip');
const reused = 'Idempotency key reused with different input';
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy', retrials: 3 } } });
const gates = ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: name !== 'merge', reasons: name !== 'merge' ? [] : ['merge refused'] }));
const candidate = { sha: sha('head1'), baseSha: tip, pr: 1, branch: 'graphyard/gy-1-1', author: 'worker' };
const submitted = () => ({
  id: 'w1', key: 'GY-1', description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
  policy: { checks: ['test'], review: true }, revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(start - 600_000),
  ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: 1 }, candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [], gates, stage: 'build',
  observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, baseTip: tip, baseTipContained: true, at: iso(start) },
}) as unknown as Work;

/**
 * The coordinator's merge-record route as far as these tests need it: the receipt rule (a key replays
 * its own input and refuses any other, server/merge-record.ts), the item's ledger folded from what it
 * accepted, and a push the base then holds. `loseReply` drops the reply of a write the server kept.
 */
function coordinator(options: { loseReply?: (event: MergeRecordEvent) => boolean; dropRequest?: (event: MergeRecordEvent) => boolean; failTrial?: boolean; receipts?: [string, MergeRecordEvent][]; ledger?: MergeLedgerState | null } = {}) {
  const receipts = new Map((options.receipts ?? []).map(([key, event]) => [key, JSON.stringify(event)]));
  const sent: { key: string; input: string; answer: 'stored' | 'receipt' | 'refused' | 'lost' }[] = [];
  const lost = new Set<string>(), dropped = new Set<string>();
  const decisions: { kind: string; head: string | undefined }[] = [];
  let reworked = false;
  let ledger: MergeLedgerState | null = options.ledger ?? null, pushes = 0, clock = start;
  const pushed = new Set<string>(ledger?.state === 'pushed' && ledger.mergeSha ? [ledger.mergeSha] : []);
  const record: MergePorts['record'] = async (item, event) => {
    const key = mergeRecordKey(item, event), input = JSON.stringify(event), held = receipts.get(key);
    // A request that never reached the server: nothing stored, no reply.
    if (!dropped.has(event.kind) && options.dropRequest?.(event)) { dropped.add(event.kind); sent.push({ key, input, answer: 'lost' }); throw new Error('connect ECONNREFUSED'); }
    if (held !== undefined) {
      if (held !== input) { sent.push({ key, input, answer: 'refused' }); throw Object.assign(new Error(`Graphyard refused work/${item.id}/merge-record (409): ${reused}`), { status: 409 }); }
      sent.push({ key, input, answer: 'receipt' });
      return { receipt: key };
    }
    receipts.set(key, input);
    if (event.kind === 'intent') ledger = { key: item.key, state: 'intent', head: event.head, baseTip: event.baseTip, mergeSha: event.mergeSha, risk: event.risk, intentAt: event.at, pushedAt: null, observedTip: null, refusal: null, events: (ledger?.events ?? 0) + 1 };
    else if (event.kind === 'pushed' && ledger) ledger = { ...ledger, state: 'pushed', pushedAt: event.pushedAt, events: ledger.events + 1 };
    else if (event.kind === 'reconciled' && ledger) ledger = { ...ledger, state: 'reconciled', observedTip: event.observedTip, events: ledger.events + 1 };
    else if (event.kind === 'refused') ledger = { key: item.key, head: event.head, baseTip: null, mergeSha: null, risk: null, intentAt: null, pushedAt: null, observedTip: null, events: 1, ...ledger, state: 'refused', refusal: { kind: 'merge', reason: event.reason } };
    if (!lost.has(event.kind) && options.loseReply?.(event)) { lost.add(event.kind); sent.push({ key, input, answer: 'lost' }); throw new Error('socket hang up'); }
    sent.push({ key, input, answer: 'stored' });
    return { stored: key };
  };
  // Every call reads a later clock, so a write rebuilt on a retry would carry new input.
  const ports: MergePorts = {
    baseBranch: 'main', retrials: 3, now: () => (clock += 1000),
    fetch: async () => tip,
    merge: async (head, baseTip) => ({ mergeSha: sha(`merge:${head}:${baseTip}`), files: ['src/app.ts'] }),
    trial: async mergeSha => ({ build: options.failTrial ? 'fail' : 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1000, logTail: mergeSha, files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } }),
    push: async mergeSha => { pushes++; pushed.add(mergeSha); return 'pushed'; },
    holds: async mergeSha => pushed.has(mergeSha),
    record,
  };
  const reads: MergeWriterReads = { ...ports, merger: async () => 'control-plane' };
  const work = () => { const item = submitted(); return [{ ...item, mergeLedger: ledger, reworkRequested: reworked, ...(ledger?.state === 'reconciled' ? { stage: 'done' } : {}) } as Work]; };
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: work(), now: iso(start) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(start), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, decisions: async () => ({ decisions: [] }), persist: async () => {},
    mergeWriter: reads,
    decide: async (item: Work, kind: string) => { decisions.push({ kind, head: item.candidate?.sha }); reworked = true; return { id: `decision-${decisions.length}` }; },
  } as unknown as DaemonEffects;
  return { effects, sent, decisions, ledger: () => ledger, pushes: () => pushes };
}

/** Runs cycles, letting each merge in flight settle, until the item is reconciled with nothing owed or `limit` cycles pass; answers every action detail. */
async function cyclesUntilDelivered(state: DaemonState, world: ReturnType<typeof coordinator>, limit = 8) {
  const details: string[] = [];
  const now = () => start;
  for (let cycle = 0; cycle < limit && (world.ledger()?.state !== 'reconciled' || state.mergeWriter.unconfirmed?.length); cycle++) {
    const result = await runCycle(config, state, world.effects, now);
    details.push(...result.actions.map(action => action.detail));
    await mergeWriterIdle(state);
  }
  return details;
}
const attemptOf = (key: string) => key.split(':')[2];

test('unit:merge-record-replay-identical — a merge record that reached the server but whose reply was lost is replayed next cycle with the identical input under the identical key, answered by its stored receipt, and the merge proceeds: a lost pushed record is reconciled with one push, a lost intent is settled from the ledger and merged; no key is ever refused as reused', async () => {
  assert.equal(mergeRecordKey({ id: 'w1', mergeAttempt: { id: 'a1', write: 2 } }, { kind: 'pushed', mergeSha: sha('m'), pushedAt: iso(start) }), 'merge-record:w1:a1:2:pushed', 'under an attempt the key names the item, the attempt id, the write and the step');
  for (const lostKind of ['pushed', 'intent', 'trial', 'reconciled'] as const) {
    const world = coordinator({ loseReply: event => event.kind === lostKind });
    const state = emptyDaemonState(config);
    const details = await cyclesUntilDelivered(state, world);
    assert.equal(world.ledger()?.state, 'reconciled', `${lostKind}: the merge proceeds to delivery: ${details.join(' | ')}`);
    assert.ok(!world.sent.some(entry => entry.answer === 'refused'), `${lostKind}: no key is refused as reused: ${JSON.stringify(world.sent)}`);
    const lost = world.sent.find(entry => entry.answer === 'lost')!;
    const replay = world.sent.find(entry => entry.answer === 'receipt');
    assert.ok(replay, `${lostKind}: the lost write is replayed`);
    assert.deepEqual([replay.key, replay.input], [lost.key, lost.input], `${lostKind}: the replay sends the identical input under the identical key`);
    assert.ok(details.some(detail => /^Replayed the \w+ record of GY-1 .* with its exact input; the server answered its receipt/.test(detail)), details.join(' | '));
    assert.equal(state.mergeWriter.unconfirmed, undefined, `${lostKind}: nothing is left owed`);
    if (lostKind !== 'intent' && lostKind !== 'trial') assert.equal(world.pushes(), 1, `${lostKind}: the merge commit is pushed once`);
  }
});

test('unit:merge-record-reuse-recovers — a merge record the server refuses as `Idempotency key reused with different input` is never sent under that key again: the loop reads the item\'s merge ledger, adopts what it recorded and continues under a new attempt id to delivery', async () => {
  const mergeSha = sha(`merge:${sha('head1')}:${tip}`);
  // A replay owed from an earlier process whose key the server holds with other input: refused once, then dropped for the ledger.
  const owed = { kind: 'pushed', mergeSha, pushedAt: iso(start) } as const;
  const key = mergeRecordKey({ id: 'w1', mergeAttempt: { id: 'old', write: 2 } }, owed);
  const ledger: MergeLedgerState = { key: 'GY-1', state: 'pushed', head: sha('head1'), baseTip: tip, mergeSha, risk: 'normal', intentAt: iso(start), pushedAt: iso(start - 5000), observedTip: null, refusal: null, events: 2 };
  const world = coordinator({ receipts: [[key, { ...owed, pushedAt: iso(start - 5000) }]], ledger });
  const state = emptyDaemonState(config);
  state.mergeWriter.unconfirmed = [{ key: 'GY-1', id: 'w1', attempt: 'old', write: 2, event: { ...owed }, sentAt: iso(start), replays: 0, lastError: 'socket hang up' }];
  const details = await cyclesUntilDelivered(state, world);
  assert.equal(world.sent.filter(entry => entry.key === key).length, 1, `the refused key is sent exactly once: ${JSON.stringify(world.sent)}`);
  assert.ok(details.some(detail => /refused as a key reused with different input; it is never sent again: the item's merge ledger \(pushed [0-9a-f]{12}\) is adopted and the next merge runs under a new attempt id/.test(detail)), details.join(' | '));
  assert.equal(world.ledger()?.state, 'reconciled', 'the adopted push is reconciled');
  assert.ok(world.sent.filter(entry => entry.key !== key).every(entry => attemptOf(entry.key) !== 'old' && entry.answer === 'stored'), JSON.stringify(world.sent));
  assert.equal(world.pushes(), 0, 'the adopted push is not pushed again');
  assert.equal(state.mergeWriter.unconfirmed, undefined);

  // A merge in flight refused a reused key: the refusal is not kept for replay, and the next attempt carries a new id.
  let refuseIntent = 1;
  const flight = coordinator();
  const inner = flight.effects.mergeWriter!;
  const record = inner.record;
  const refused: string[] = [];
  inner.record = async (item, event) => {
    if (event.kind === 'intent' && refuseIntent-- > 0) { refused.push(mergeRecordKey(item, event)); throw new Error(`Graphyard refused work/w1/merge-record (409): ${reused}`); }
    return record(item, event);
  };
  const live = emptyDaemonState(config);
  const flightDetails = await cyclesUntilDelivered(live, flight);
  assert.equal(flight.ledger()?.state, 'reconciled', flightDetails.join(' | '));
  assert.ok(flightDetails.some(detail => /was refused a record key reused with different input; that key is never sent again: the item's merge ledger is adopted and the head is tried again under a new attempt id/.test(detail)), flightDetails.join(' | '));
  assert.ok(!flight.sent.some(entry => entry.key === refused[0]), 'the refused key is never sent again');
  assert.ok(flight.sent.every(entry => attemptOf(entry.key) !== attemptOf(refused[0]!)), 'the next attempt runs under a new attempt id');
  assert.equal(live.mergeWriter.unconfirmed, undefined, 'a refused key is never kept for replay');
});

test('unit:merge-record-persist-recovers — a persist of the attempt id that fails before the attempt\'s first write leaves nothing in flight, so once persistence recovers a later cycle starts the merge afresh and delivers it', async () => {
  const world = coordinator();
  let failures = 1;
  world.effects.persist = async state => { if (state.mergeWriter.inFlight && failures-- > 0) throw new Error('EIO: write failed'); };
  const state = emptyDaemonState(config);
  const details = await cyclesUntilDelivered(state, world);
  assert.ok(failures < 1, 'the pre-launch persist failed once');
  assert.ok(details.some(detail => /EIO: write failed/.test(detail)), `the failed persist is reported: ${details.join(' | ')}`);
  assert.equal(world.ledger()?.state, 'reconciled', `a later cycle merges once persistence recovers: ${details.join(' | ')}`);
  assert.equal(world.pushes(), 1, 'the merge commit is pushed once');
  await runCycle(config, state, world.effects, () => start);
  assert.equal(state.mergeWriter.inFlight, null, 'nothing is left in flight');
});

test('unit:merge-record-replay-identical — a failed trial\'s refusal whose reply was lost, or which first reached the server on replay, still has its rework requested once the replay confirms it; the request settles it and later cycles ask nothing more', async () => {
  for (const [label, fault] of [['stored, reply lost', { loseReply: (event: MergeRecordEvent) => event.kind === 'refused' }], ['first stored on replay', { dropRequest: (event: MergeRecordEvent) => event.kind === 'refused' }]] as const) {
    const world = coordinator({ failTrial: true, ...fault });
    const state = emptyDaemonState(config);
    const details: string[] = [];
    for (let cycle = 0; cycle < 8; cycle++) {
      details.push(...(await runCycle(config, state, world.effects, () => start)).actions.map(action => action.detail));
      await mergeWriterIdle(state);
    }
    const refusals = world.sent.filter(entry => JSON.parse(entry.input).kind === 'refused');
    assert.deepEqual(refusals.map(entry => entry.answer), ['lost', label === 'stored, reply lost' ? 'receipt' : 'stored'], `${label}: the refusal is sent, then replayed once: ${JSON.stringify(world.sent)}`);
    assert.equal(new Set(refusals.map(entry => `${entry.key}|${entry.input}`)).size, 1, `${label}: the replay is the identical input under the identical key`);
    assert.equal(world.ledger()?.state, 'refused', label);
    assert.deepEqual(world.decisions, [{ kind: 'rework', head: candidate.sha }], `${label}: the rework the refusal grounds is requested exactly once: ${details.join(' | ')}`);
    assert.ok(details.some(detail => /^Requested the rework the merge writer's refusal of GY-1 head [0-9a-f]+ grounds/.test(detail)), `${label}: ${details.join(' | ')}`);
    assert.deepEqual([state.mergeWriter.reworks, state.mergeWriter.unconfirmed, state.mergeWriter.inFlight], [[], undefined, null], `${label}: nothing is left owed`);
    assert.ok(!world.sent.some(entry => entry.answer === 'refused'), `${label}: no key is refused as reused`);
  }
});
