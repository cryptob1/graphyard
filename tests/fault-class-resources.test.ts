import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { classifyAttention, faultClassOf } from '../src/model/fault-classes.js';
import { hostMemoryAttention, hostMemoryFloor, judgeHostMemory, memoryRecoveryMarginBytes, nameReclaimBoundMs, readReclaimState, readResources, reclaimResources, resourceAttention, type ResourceInputs } from '../src/master-resources.js';
import { acquireVerificationSlot, bytesPerSuiteFile, declareSlotFiles, heldSlots, othersDeclaredFiles } from '../src/master/verification-slots.js';
import { suiteBreadth } from './helpers/run-tests.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { HerdrAgent } from '../src/master.js';
import type { Work } from '../src/model.js';

// GY-1821 names this file for its proof: manual:fault-class-resources. The master loop filed 3
// resources faults in 24 hours (threshold 3) on 14–15 October 2026, and every one traces to what
// the host runs at its heaviest — the suites the loop's own sessions verify with.
//
// The shared cause, in two mechanisms:
//   1. A full suite ran at node --test's default breadth, one file per CPU whatever the host held.
//      Measured on the 24-CPU host the instances were recorded on: one suite swung available memory
//      from 27.4 GB to 9.4 GB (about `bytesPerSuiteFile` a file), so the second suite the slots
//      bound still admitted took the host under the 6.2 GB floor the loop defers launches at —
//      instances 2 and 3, one `memory-pressure` fault per dip.
//   2. While the host sat there, the reclaim pass erased its own progress on agent names: a pass
//      that reads no inventory (the cycle passes `agents` null) and a pass that skips a worker pane
//      while a launch of its principal is under way each dropped the pane's seen-unowned sighting
//      from .graphyard/resource-reclaims.json, the two-pass confirmation restarted, and the name
//      stood past its bound — instance 1, "not reclaimed within 10 minutes of settling".
//
// The candidate: the suite's own breadth is what the host's memory affords beyond the floor and the
// deferral margin, less the files runs on already-held slots declared (suiteBreadth; the slot's
// owner record carries the declaration), and the reclaim keeps every sighting it could not judge.
// Each instance below is rebuilt from its own detail line, faults against the base's behaviour, and
// is shown not to recur against the candidate's; beside each, the state that is a real fault still
// raises one.

/** The instances as the item lists them: at, kind, subject — the evidence this file replays. */
const instances = [
  { at: '2026-10-14T09:29:03.341Z', kind: 'resource-bound', subject: 'resource:agent-names:claude-senary' },
  { at: '2026-10-14T09:41:19.113Z', kind: 'memory-pressure', subject: 'memory' },
  { at: '2026-10-15T05:19:03.594Z', kind: 'memory-pressure', subject: 'memory' },
];

const agentNamesAt = Date.parse(instances[0].at), memoryTwoAt = Date.parse(instances[2].at);
const GiB = 2 ** 30;
const iso = (ms: number) => new Date(ms).toISOString();

test('manual:fault-class-resources — the item lists 3 instances, and every one is replayed below', () => {
  assert.equal(instances.length, 3);
  assert.equal(new Set(instances.map(instance => instance.at)).size, 3);
  assert.ok(instances.every(instance => faultClassOf(instance.kind) === 'resources'));
  assert.deepEqual([...new Set(instances.map(instance => instance.kind))].sort(), ['memory-pressure', 'resource-bound']);
});

// ---- Instance 1: resource-bound on resource:agent-names:claude-senary -------------------------

const profile = { name: 'claude-senary', principal: 'graphyard-codex-2', agentName: 'graphyard-opencode-4', mode: 'launch' as const };
const holder = { name: 'graphyard-opencode-4', agent_status: 'unknown', pane_id: 'w1V:pPP9', agent: 'codex' } as HerdrAgent;
const settledAt = agentNamesAt - 11 * 60_000;
/** The worker session that settled the name: pane pPP9, no lease, its record 11 minutes old at the fault. */
const settledSession = {
  id: randomUUID(), key: 'GY-1', stage: 'build', lease: null,
  sessions: [{ id: 'graphyard-codex-2:1', kind: 'implementation', principal: profile.principal, epoch: 1, runtime: 'claude', host: 'vishrog', workspace: 'w1V', tab: null, pane: 'w1V:pPP9', agentName: null, role: null, head: null, attach: null, transcript: null, subject: 'GY-1', startedAt: iso(settledAt - 20 * 60_000), updatedAt: iso(settledAt), endedAt: iso(settledAt), state: 'finished', outcome: null }],
} as unknown as Work;
/** A relaunch of the same principal under way: the pane's replacement arriving, its lease not landed. */
const relaunching = (startedAt: number) => ({
  id: randomUUID(), key: 'GY-2', stage: 'build', lease: null,
  sessions: [{ id: 'graphyard-codex-2:2', kind: 'implementation', principal: profile.principal, epoch: 1, runtime: 'claude', host: 'vishrog', workspace: 'w1V', tab: null, pane: null, agentName: null, role: null, head: null, attach: null, transcript: null, subject: 'GY-2', startedAt: iso(startedAt), updatedAt: iso(startedAt), endedAt: null, state: 'running', outcome: null }],
}) as unknown as Work;
const reading = (overrides: Partial<ResourceInputs> = {}): ResourceInputs => ({ now: agentNamesAt, reviews: [], producers: [], agents: [holder], work: [settledSession], plane: null, loop: null, revision: null, disk: null, reclaimSeen: null,
  profiles: { workers: [profile], reviewers: [], producers: [] }, ...overrides });
const faults = (input: ResourceInputs) => classifyAttention(resourceAttention(readResources(input))).filter(item => item.faultClass === 'resources').map(item => item.subject);

test('manual:fault-class-resources — instance 1 reproduces: the holder in the item\'s own detail line is at its bound, word for word', () => {
  assert.deepEqual(faults(reading()), ['resource:agent-names:claude-senary']);
  const detail = readResources(reading()).find(entry => entry.id === 'agent-names:claude-senary')!.detail!;
  assert.match(detail, /worker profile claude-senary: graphyard-opencode-4 \(unknown, no live session, not reclaimed within 10 minutes of settling, pane w1V:pPP9\)/);
});

test('manual:fault-class-resources — instance 1: the base\'s passes erase the sighting (the state the fault names); the candidate\'s keep it and the pane is given back inside the bound', async () => {
  const directory = await temporaryDirectory('fault-class-resources-names');
  const closePane = () => {};
  // First sighting, 70s after the settle: no launch under way, the pass records the pane as unowned.
  const first = await reclaimResources(directory, { workers: [profile], reviewers: [], producers: [] }, { work: [settledSession], agents: [holder] }, { tmpRoot: directory, now: settledAt + 70_000, closePane });
  assert.deepEqual(first.closed, []);
  assert.ok((await readReclaimState(directory)).seen['w1V:pPP9'], 'the first pass records the sighting');

  // The base's next pass: a relaunch of the principal is under way, the pass skips the pane — and
  // REPRODUCE against base: the skip dropped the sighting from the file, so the two-pass
  // confirmation restarted. The reading the item recorded at 09:29 is exactly that state: no
  // sighting, the settling clock past the bound, the name a fault with the instance's wording.
  assert.deepEqual(faults(reading({ reclaimSeen: null })), ['resource:agent-names:claude-senary']);

  // CANDIDATE: the same pass, with the relaunch under way, keeps the sighting it cannot re-judge…
  const relaunch = relaunching(settledAt + 90_000);
  await reclaimResources(directory, { workers: [profile], reviewers: [], producers: [] }, { work: [settledSession, relaunch], agents: [holder] }, { tmpRoot: directory, now: settledAt + 100_000, closePane });
  assert.ok((await readReclaimState(directory)).seen['w1V:pPP9'], 'the launch-bound skip keeps the recorded sighting');

  // …and a pass that reads no inventory keeps it too (the base dropped it there as well).
  await reclaimResources(directory, { workers: [profile], reviewers: [], producers: [] }, { work: [settledSession, relaunch], agents: null }, { tmpRoot: directory, now: settledAt + 130_000, closePane });
  assert.ok((await readReclaimState(directory)).seen['w1V:pPP9'], 'a blind pass keeps the sighting it could not judge');

  // The launch window passed: the next pass closes the pane — 230s after the settle, inside the bound.
  const closes: string[] = [];
  const last = await reclaimResources(directory, { workers: [profile], reviewers: [], producers: [] }, { work: [settledSession, relaunch], agents: [holder] }, { tmpRoot: directory, now: settledAt + 230_000, closePane: pane => { closes.push(pane); } });
  assert.deepEqual(closes, ['w1V:pPP9']);
  assert.match(last.closed[0].reason, /Herdr reports it unknown/);
  assert.ok(settledAt + 230_000 - settledAt < nameReclaimBoundMs, 'given back well inside the 10-minute name bound');

  // So the hour the item reads never sees the holder: no fault at the instance's own instant.
  assert.deepEqual(faults(reading({ agents: [] })), []);
  assert.deepEqual(faults(reading({ reclaimSeen: { 'w1V:pPP9': iso(settledAt + 70_000) } })), [], 'even while the close is under way, the sighting holds the reading under its bound');
});

test('manual:fault-class-resources — instance 1: a name really stuck still faults, and a running holder never does', () => {
  // Seen unowned past the bound, its launch long over, the pane still there: the fault stands.
  assert.deepEqual(faults(reading({ reclaimSeen: { 'w1V:pPP9': iso(agentNamesAt - nameReclaimBoundMs) }, work: [settledSession] })), ['resource:agent-names:claude-senary']);
  // A working holder is a live session, never a fault, whatever the clocks say.
  assert.deepEqual(faults(reading({ agents: [{ ...holder, agent_status: 'working' }] })), []);
});

// ---- Instances 2 and 3: memory-pressure on memory ---------------------------------------------

const totalBytes = 62 * GiB, floorBytes = hostMemoryFloor(totalBytes), marginBytes = memoryRecoveryMarginBytes;
/** The host the instances were recorded on, just before a suite: 24 CPUs, 27.4 GB available (measured, GY-1821). */
const quietBytes = Math.round(27.4 * GiB), cpus = 24;
/** The base's breadth: node --test's own default, one file per CPU minus one, whatever the host held. */
const baseBreadth = cpus - 1;
const budgetBytes = quietBytes - floorBytes - marginBytes;
/** The reading the loop derives the fault from, at the available memory a pair of base suites left. */
const afterSuites = (bytes: number) => judgeHostMemory(null, { totalBytes, availableBytes: bytes }, memoryTwoAt, 'vishrog');

test('manual:fault-class-resources — instances 2 and 3 reproduce: two base suites want more than the host affords beyond its floor, and the dip the item recorded is the fault', () => {
  const wanted = 2 * baseBreadth * bytesPerSuiteFile;
  assert.ok(wanted > quietBytes - floorBytes, 'the second suite the slots bound admitted took the host below its floor');
  const dip = afterSuites(quietBytes - wanted);
  assert.ok(dip.state.low, 'the reading is below the floor');
  const [attention] = hostMemoryAttention(dip.state);
  assert.equal(attention.subject, 'memory');
  const [classified] = classifyAttention([attention]);
  assert.equal(classified.kind, 'memory-pressure');
  assert.equal(classified.faultClass, 'resources');
  assert.match(attention.text, /below its .* floor/);
  assert.match(attention.text, /deferred/i);
});

test('manual:fault-class-resources — instances 2 and 3: at the candidate\'s breadth the suites the slots admit together stay inside the budget, and the floor holds', () => {
  // Alone, the suite runs at node's own breadth — full speed, inside the budget.
  const first = suiteBreadth({ budgetBytes, otherFiles: 0, cpus });
  assert.equal(first, baseBreadth, 'a suite alone runs as wide as the base\'s did');
  // The slots directory carries the declaration: a run that starts later takes only what is left.
  const second = suiteBreadth({ budgetBytes, otherFiles: first, cpus });
  assert.ok(second >= 2, 'never fewer than two files');
  const combined = (first + second) * bytesPerSuiteFile;
  assert.ok(combined <= budgetBytes, 'both suites together stay inside what the floor affords');
  const held = afterSuites(quietBytes - combined);
  assert.ok(!held.state.low, 'the floor and the recovery margin survive both suites: no memory-pressure fault');
});

test('manual:fault-class-resources — instances 2 and 3: the breadth is declared on the slot and read from the other holders', async () => {
  const directory = await temporaryDirectory('fault-class-resources-slots');
  const first = await acquireVerificationSlot({ directory, slots: 4, label: 'suite A', pid: 41001 });
  assert.equal(othersDeclaredFiles(directory, 41002), 0, 'nothing declared yet');
  declareSlotFiles(first, 23, 41001);
  assert.equal(othersDeclaredFiles(directory, 41002), 23, 'a later run deducts what the holder declared');
  assert.equal(othersDeclaredFiles(directory, 41001), 0, 'a holder does not deduct its own declaration');
  const second = suiteBreadth({ budgetBytes, otherFiles: othersDeclaredFiles(directory, 41002), cpus });
  assert.equal(second, suiteBreadth({ budgetBytes, otherFiles: 23, cpus }));
  // A declaration is best-effort on the holder's own record: a foreign or stale owner is left alone.
  declareSlotFiles(first, 5, 999999);
  assert.equal(othersDeclaredFiles(directory, 41002), 23, 'another pid cannot rewrite the holder\'s declaration');
  first.release();
  assert.deepEqual(heldSlots(directory).length, 0, 'the released slot is gone');
});

test('manual:fault-class-resources — instances 2 and 3: a host below its floor with nothing verifying is still a fault', () => {
  // The breadth bound never silences the reading: memory held by something the bound does not
  // reach — no slots held — dips the host exactly as before.
  const dip = afterSuites(floorBytes - GiB);
  assert.ok(dip.state.low);
  assert.deepEqual(classifyAttention(hostMemoryAttention(dip.state)).map(item => item.subject), ['memory']);
  // And the launch deferral's own margin still applies: just above the floor plus the margin is no fault.
  assert.ok(!afterSuites(floorBytes + memoryRecoveryMarginBytes).state.low);
});

test('manual:fault-class-resources — the breadth never falls below two files and never rises past node\'s own default', () => {
  // A budget already spent by other holders clamps at two files, and a run alone never exceeds
  // node --test's one-file-per-CPU default: small hosts and quiet hosts run exactly as before.
  assert.equal(suiteBreadth({ budgetBytes: 0, otherFiles: 1_000, cpus: 24 }), 2);
  assert.equal(suiteBreadth({ budgetBytes: 10 * bytesPerSuiteFile, otherFiles: 0, cpus: 4 }), 3, 'a 4-CPU host keeps node\'s own breadth');
  assert.equal(suiteBreadth({ budgetBytes: 4 * bytesPerSuiteFile, otherFiles: 3, cpus: 24 }), 2, 'three files declared leaves one affordable, clamped at two');
});
