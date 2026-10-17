import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyAttention, faultClassOf, faultClassPolicyDefaults, landedAt, predateLanding, recurringClasses, releaseOvertakenLinks, trackFaults } from '../src/model/fault-classes.js';
import { finishedSessionGraceMs, hostMemoryAttention, hostMemoryFloor, judgeHostMemory, memoryRecoveryMarginBytes, nameReclaimBoundMs, readReclaimState, readResources, readTmpInodes, reclaimResources, resourceAttention, describeReclaim, settleTmpReclaim, tmpErrorPrefix, unownedPaneConfirmMs, type ResourceInputs, type ResourceReclaimReport } from '../src/master-resources.js';
import * as masterResources from '../src/master-resources.js';
import { diskThresholdBytes, masterConfigSchema, type MasterConfig } from '../src/master.js';
import { cycleFaults, emptyDaemonState } from '../src/master-daemon.js';
import { judgeWorktreeDisk, worktreePassCurrentMs } from '../src/master/worktree-disk.js';
import { foreignObstruction, ForeignSubtreeError, readTempResidue, reclaimTmpDirectories, settleForeignResidue, tempResidueMarker, tempResidueStands, testTempMinAgeMs, writeTempResidue } from '../src/tmp-reclaim.js';
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

// ---- GY-1828: the class recurred — 3 more resources faults in the next 24 hours ----------------
//
// The new instances, replayed the way the ones above are: every one is rebuilt from its own detail
// line, faults against the base's behaviour, and is shown not to recur against the candidate's.
//
// The shared cause, in two mechanisms:
//   1. The worktree volume sat below its line while the loop's reclaim pass was taking the last
//      reclaimable thing back: the pass that very minute removed 1 unowned managed checkout, and
//      the answer rule — GY-1784's letter of "drained: it removed nothing" — judged that pass as
//      reach it still held, so the registry reading (instance 1, resource-bound on
//      resource:worktree-disk) and the loop's derived disk line (instance 2, disk-pressure on disk)
//      both raised on a reading whose own detail said "nothing is reclaimable now ... outside its
//      reach". The candidate answers the out-of-reach judgement: a current pass above the floor
//      whose plan holds nothing disposable, with no backlog and no error, is the drain finished,
//      whatever it removed; without a plan read the letter stands.
//   2. The loop's /tmp pass could not free an entry it owned: /var/tmp/gy-teK30QK held a sandbox
//      repository whose .git/worktrees/GY-7-1 directory was mode 0555, and rm reported
//      "EACCES: permission denied, unlink .../GY-7-1/HEAD" — the action recorded failed (instance
//      3, action:reclaim) and every later pass reported the same error again, the 39 MB beside it
//      held for good. The candidate makes the owner-held directories writable before unlinking and
//      frees the entry; an entry not owned by the pass's uid is never touched, and a kept one's
//      modes are left exactly as they were.

const instance1At = Date.parse('2026-10-15T23:30:40.457Z');
const instance3At = Date.parse('2026-10-16T00:15:14.998Z');
const worktreesVolume = '/home/vish/code/graphyard/.graphyard/worktrees';
const volumeBytes = 1_022_000_000_000, freeAtInstance = 7_800_000_000, thresholdBytes = 10_000_000_000;

test('manual:fault-class-resources — GY-1828 lists 3 instances, and every one is replayed below', () => {
  const instances = [
    { at: instance1At, kind: 'resource-bound', subject: 'resource:worktree-disk' },
    { at: instance1At, kind: 'disk-pressure', subject: 'disk' },
    { at: instance3At, kind: 'action:reclaim', subject: 'reclaim:resources:2026-10-16T00:15:14.991Z' },
  ];
  assert.equal(instances.length, 3);
  assert.ok(instances.every(instance => faultClassOf(instance.kind) === 'resources'));
});

/** The pass summary the item's own detail line quotes: 1 unowned managed checkout taken back, nothing else left. */
const instancePass = { at: new Date(instance1At).toISOString(), removed: 0, trees: 0, treeBacklog: 0, checkouts: 1, errors: 0, freeBytes: freeAtInstance };
/** The registry inputs over the volume, as the loop reports them. */
const volumeReading = (overrides: Record<string, unknown> = {}) => ({
  now: instance1At, reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, revision: null,
  profiles: { workers: [], reviewers: [], producers: [] },
  disk: { path: worktreesVolume, totalBytes: volumeBytes, freeBytes: freeAtInstance, thresholdBytes, pass: instancePass, reclaimable: 0, ...overrides },
} as ResourceInputs);
const diskLine = (worktreeReclaimable: number | null | undefined) => {
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/credentials/coordinator.token', cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'vishrog', masterAgentName: 'graphyard-master-project', workers: [], run: { intervalSeconds: 20, diskThresholdGb: 10 } }) as MasterConfig;
  const state = emptyDaemonState(config);
  // The cursor's summary carries the pass's errors as strings; this pass met none.
  state.reclaim = { ...instancePass, errors: [], scanned: 241, kept: 240, freedBytes: 0, checkoutsOffVolume: 0, rootFreeBytes: freeAtInstance } as typeof state.reclaim;
  return cycleFaults(state, [], instance1At, { config, worktreeReclaimable }).filter(fault => fault.subject === 'disk');
};

test('manual:fault-class-resources — GY-1828 instances 1 and 2 reproduce: the pass that took back the last checkout is judged as reach left, and both lines raise on a reading its own detail calls out of reach', () => {
  // The state the item recorded, at the instant both instances carry: the reading is low above the
  // floor, the pass that just took back 1 unowned managed checkout is current, and the plan over
  // the inventory holds nothing — the reading's own detail calls what remains out of reach.
  const judged = judgeWorktreeDisk({ freeBytes: freeAtInstance, thresholdBytes, pass: instancePass, reclaimable: 0 }, instance1At);
  assert.ok(judged.low && !judged.atFloor && judged.current, 'low above the floor, the pass current');
  assert.equal(judged.outOfReach, true, 'the plan was read and holds nothing, no backlog, no error');
  // The base's answer gate was the letter of drained — a pass that removed nothing — and this pass
  // removed a checkout: the base judged it as reach left and raised, exactly the contradiction the
  // instances record. The detail is the item's own line, word for word.
  assert.equal(judged.drained, false);
  assert.match(judged.detail!, /nothing is reclaimable now \(the loop's latest worktree-reclaim pass at .* took back 1 unowned managed checkouts removed\) \(no disposable dependency directories, reclaimable worktrees or unowned managed checkouts\), so the volume's remaining holders are outside its reach/);

  // Instance 1: the registry line's raise — kind, class and the reading's wording, over the same
  // volume with reach the base judged the pass to still hold (a state both rules raise on).
  const [raised] = classifyAttention(resourceAttention(readResources(volumeReading({ reclaimable: 2 })))).filter(entry => entry.subject === 'resource:worktree-disk');
  assert.equal(raised.kind, 'resource-bound');
  assert.equal(raised.faultClass, 'resources');
  assert.match(raised.text, /^Coordinator worktree disk is low: 1014\.\d GB used of 1022\.0 GB, 7\.8 GB left — \/home\/vish\/code\/graphyard\/\.graphyard\/worktrees; /);
  // …and the reading at the instance's own state carries the detail line the instance quotes.
  const reading = readResources(volumeReading()).find(entry => entry.resource === 'worktree-disk')!;
  assert.equal(reading.state, 'low');
  assert.match(reading.detail!, /nothing is reclaimable now \(the loop's latest worktree-reclaim pass at [^)]* took back 1 unowned managed checkouts removed\)/);

  // Instance 2: the loop's derived line — the item's wording is the line's fixed text at this pass
  // summary, raised wherever the answer gate fails (reach beside it, the base's drained letter at
  // the instance state itself).
  const lines = diskLine(2);
  assert.deepEqual(lines.map(line => line.kind), ['disk-pressure']);
  assert.match(lines[0].text, /^Free space below its configured bound at the last reclaim \(2026-10-15T23:30:40\.457Z\)$/);
  const opened = trackFaults(emptyDaemonState(masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/credentials/coordinator.token', cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'vishrog', masterAgentName: 'graphyard-master-project', workers: [], run: { intervalSeconds: 20, diskThresholdGb: 10 } })).faults, lines, new Date(instance1At).toISOString());
  assert.deepEqual(opened.map(line => `${line.kind}|${line.subject}`), ['disk-pressure|disk'], 'one crossing opens each line its instance');
});

test('manual:fault-class-resources — GY-1828 instances 1 and 2 do not recur: the same pass over the plan it drained to empty answers both lines, and everything the base honoured still raises', () => {
  // The candidate: the out-of-reach judgement answers — the removals were the drain, not reach left.
  const judged = judgeWorktreeDisk({ freeBytes: freeAtInstance, thresholdBytes, pass: instancePass, reclaimable: 0 }, instance1At);
  assert.equal(judged.answered, true);
  assert.deepEqual(classifyAttention(resourceAttention(readResources(volumeReading()))).filter(entry => entry.subject === 'resource:worktree-disk').map(entry => entry.subject), [], 'the registry line raises nothing');
  assert.deepEqual(diskLine(0), [], 'the derived line raises nothing with it');

  // Everything the base answered still answers, and everything it raised still raises.
  assert.equal(judgeWorktreeDisk({ freeBytes: freeAtInstance, thresholdBytes, pass: instancePass, reclaimable: 2 }, instance1At).answered, false, 'a plan with reach now is reach');
  assert.equal(judgeWorktreeDisk({ freeBytes: freeAtInstance, thresholdBytes, pass: { ...instancePass, treeBacklog: 3 }, reclaimable: 0 }, instance1At).answered, false, 'worktrees waiting on the next cycle are reach');
  assert.equal(judgeWorktreeDisk({ freeBytes: freeAtInstance, thresholdBytes, pass: { ...instancePass, errors: 1 }, reclaimable: 0 }, instance1At).answered, false, 'a pass that met an error has unknown reach');
  assert.equal(judgeWorktreeDisk({ freeBytes: freeAtInstance, thresholdBytes, pass: instancePass, reclaimable: null }, instance1At).answered, false, 'a plan that could not be read never answers');
  assert.equal(judgeWorktreeDisk({ freeBytes: freeAtInstance, thresholdBytes, pass: instancePass }, instance1At).answered, false, 'judging from the pass alone keeps the letter of drained: only a pass that removed nothing answers');
  assert.equal(judgeWorktreeDisk({ freeBytes: thresholdBytes / 2, thresholdBytes, pass: instancePass, reclaimable: 0 }, instance1At).answered, false, 'at the exhaustion floor the reading raises whatever the pass answered');
  assert.equal(judgeWorktreeDisk({ freeBytes: freeAtInstance, thresholdBytes, pass: instancePass, reclaimable: 0 }, instance1At + worktreePassCurrentMs + 1).answered, false, 'a stale pass answers nothing');
  assert.equal(judgeWorktreeDisk({ freeBytes: freeAtInstance, thresholdBytes, pass: instancePass, reclaimable: 0, standing: true }, instance1At).answered, false, 'a standing fault is never answered');
  // And the two lines stay honest beside it: reach and an unreadable plan raise the derived line as before.
  assert.match(diskLine(2)[0].text, /^Free space below its configured bound/);
  assert.equal(diskLine(null).length, 1, 'a plan the loop cannot read never answers the derived line');
});

/** The stale entry the item names, rebuilt: a `gy-` test temp holding a sandbox repository whose linked worktree's admin directory git left mode 0555. */
async function staleSandboxEntry(base: string, now: number) {
  const tmp = join(base, 'tmp'), entry = join(tmp, 'gy-teK30QK');
  const admin = join(entry, 'graphyard-sandbox-5ClynR', 'repo', '.git', 'worktrees', 'GY-7-1');
  await mkdir(join(admin, 'logs'), { recursive: true });
  await writeFile(join(admin, 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(admin, 'index'), 'x');
  await writeFile(join(admin, 'gitdir'), `${join(entry, 'worktree', '.git')}\n`);
  await writeFile(join(admin, 'logs', 'HEAD'), 'x');
  await chmod(admin, 0o555);
  const age = testTempMinAgeMs + 3_600_000;
  for (const path of [entry, join(entry, 'graphyard-sandbox-5ClynR'), join(entry, 'graphyard-sandbox-5ClynR', 'repo'), join(entry, 'graphyard-sandbox-5ClynR', 'repo', '.git'), join(entry, 'graphyard-sandbox-5ClynR', 'repo', '.git', 'worktrees'), admin, join(admin, 'logs'), join(admin, 'HEAD'), join(admin, 'index'), join(admin, 'gitdir'), join(admin, 'logs', 'HEAD')])
    await utimes(path, new Date(now - age), new Date(now - age));
  return { tmp, entry, admin };
}

/**
 * The base's recursive rm inside the 0555 admin directory fails with EACCES on whichever entry
 * readdir returns first — unlink HEAD, index or gitdir, or rmdir logs after emptying it — and stops
 * there. Which entry that is, is the filesystem's directory order, which the test does not control
 * (GY-1837: the recorded instances name HEAD, gitdir and logs across hosts), so the reproduction
 * asserts the failure the behaviour names — the code, and the met entry inside GY-7-1 — never one
 * child's name.
 */
function assertAdminEacces(error: NodeJS.ErrnoException | null, message: string) {
  assert.ok(error, message);
  assert.equal(error!.code, 'EACCES', message);
  assert.match(error!.message, /^EACCES: permission denied, (?:unlink|rmdir) '.*\.git\/worktrees\/GY-7-1\/[^/]+'$/, message);
}

test('manual:fault-class-resources — GY-1828 instance 3 reproduces: the base pass reports the entry EACCES and frees nothing; the candidate frees it whole and the action records done', async () => {
  const base = await temporaryDirectory('fault-class-resources-readonly');
  const now = instance3At - 3_600_000;
  const { tmp, entry } = await staleSandboxEntry(base, now);

  // REPRODUCE against the base: the removal the base's pass runs fails exactly as the item
  // recorded — `EACCES: permission denied` on whichever entry inside the 0555 directory readdir
  // returns first, unlink or rmdir — and the entry stays, so the pass reports the error the action
  // record carried as a fault.
  const baseError = await rm(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }).then(() => null, error => error as NodeJS.ErrnoException);
  assertAdminEacces(baseError, 'the base\'s removal primitive fails on the read-only admin directory, on whichever of its entries readdir returns first');
  assert.equal(existsSync(entry), true, 'the base frees nothing: the entry stands');
  const baseReport = { at: new Date(instance3At).toISOString(), reaped: { review: 1, producer: 0 }, closed: [], released: [], tmp: { removed: 1, bytes: 38_973_291 }, errors: [`/var/tmp/gy-teK30QK: ${baseError!.message}`] } as unknown as ResourceReclaimReport;
  const baseLine = describeReclaim(baseReport)!;
  assert.match(baseLine, /^Resource reclaim: reaped 1 review and 0 producer ledger record\(s\); freed 39 MB from 1 stale \/tmp entry; 1 could not be reclaimed: \/var\/tmp\/gy-teK30QK: EACCES: permission denied, (?:unlink|rmdir)/);
  assert.equal(baseLine.includes('could not be reclaimed'), true, 'the loop records the reclaim action failed on this report: the action:reclaim fault the item lists');

  // CANDIDATE: the same tree, the pass as it now runs — owner-held directories are made writable
  // before unlinking, the entry goes whole, and no error is reported.
  const fresh = await staleSandboxEntry(await temporaryDirectory('fault-class-resources-readonly-freed'), now);
  // A wide retry window: the assertion is that the writability pass frees the entry, not how fast
  // the pass's own 2 s default window closes on a loaded runner.
  const report = await reclaimTmpDirectories({ tmpRoot: fresh.tmp, now, held: new Set(), retryMs: 10_000 });
  assert.deepEqual(report.errors, [], 'no EACCES is reported for the owned entry');
  assert.deepEqual(report.removed.map(removed => removed.path), [fresh.entry], 'the entry is freed whole');
  assert.ok(report.bytes > 0, 'the bytes come back with it');
  assert.equal(report.classes?.testTemp, 1);
  assert.equal(existsSync(fresh.entry), false);
  const candidateLine = describeReclaim({ at: report.at, reaped: { review: 0, producer: 0 }, closed: [], released: [], tmp: { removed: report.removed.length, bytes: report.bytes }, errors: report.errors } as unknown as ResourceReclaimReport)!;
  assert.match(candidateLine, /freed \d+ (MB|GB) from 1 stale \/tmp entry/);
  assert.equal(candidateLine.includes('could not be reclaimed'), false, 'the action records done: the instance\'s fault never opens');
});

test('unit:tmp-reclaim-read-only-directories — the pass frees an owned entry holding read-only directories, never touches a kept one\'s modes, and never touches another user\'s entry', async () => {
  const now = instance3At - 3_600_000;
  // An entry younger than its bound is kept, and its read-only directory keeps its mode exactly.
  const kept = await temporaryDirectory('tmp-reclaim-readonly-kept');
  const keptRoot = join(kept, 'tmp'), keptEntry = join(keptRoot, 'gy-young');
  const keptAdmin = join(keptEntry, 'repo', '.git', 'worktrees', 'GY-1-1');
  await mkdir(keptAdmin, { recursive: true });
  await writeFile(join(keptAdmin, 'HEAD'), 'x');
  await chmod(keptAdmin, 0o555);
  const young = now - 60_000;
  for (const path of [keptEntry, join(keptEntry, 'repo'), join(keptEntry, 'repo', '.git'), join(keptEntry, 'repo', '.git', 'worktrees'), keptAdmin, join(keptAdmin, 'HEAD')]) await utimes(path, new Date(young), new Date(young));

  // The stale owned entry beside it goes, errors and all.
  const base = await temporaryDirectory('tmp-reclaim-readonly');
  const { tmp, entry, admin } = await staleSandboxEntry(base, now);
  const report = await reclaimTmpDirectories({ tmpRoot: join(base, 'tmp'), now, held: new Set(), retryMs: 10_000 });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.removed.map(removed => removed.path), [entry]);
  assert.equal(existsSync(admin), false, 'the owner-held read-only directory went with the entry');

  // What the pass keeps is never made writable: the young entry's 0555 directory keeps its mode.
  const keptReport = await reclaimTmpDirectories({ tmpRoot: keptRoot, now, held: new Set() });
  assert.deepEqual(keptReport.removed, []);
  assert.equal((await stat(keptAdmin)).mode & 0o777, 0o555, 'a kept entry\'s read-only directory keeps its mode');

  // Another user's entry is never touched: a pass running as another uid skips it whole, and the
  // 0555 directory inside it stands exactly as it was.
  const foreign = await temporaryDirectory('tmp-reclaim-readonly-foreign');
  const { tmp: foreignRoot, entry: foreignEntry, admin: foreignAdmin } = await staleSandboxEntry(foreign, now);
  const getuid = process.getuid, realUid = getuid!.call(process);
  process.getuid = () => realUid + 1;
  let others;
  try { others = await reclaimTmpDirectories({ tmpRoot: foreignRoot, now, held: new Set() }); } finally { process.getuid = getuid; }
  assert.deepEqual(others.errors, []);
  assert.deepEqual(others.removed, [], 'an entry that is not the pass\'s uid\'s is never removed');
  assert.equal(existsSync(foreignEntry), true);
  assert.equal((await stat(foreignAdmin)).mode & 0o777, 0o555, 'another user\'s read-only directory is never made writable');
});

// ---- GY-1830: the class recurred once more — the same EACCES, after the fix had already merged --
//
// All four instances are GY-1828's third mechanism still firing: the one stale /var/tmp/gy-teK30QK
// sandbox entry, reported EACCES by every pass that met it. What is new is when: GY-1828's fix
// merged at 01:42:44Z and its release was promoted at 02:01:51Z, but the loop went on running the
// old revision until it restarted onto it at 02:05:26Z — and every pass in between raised the same
// reclaim failure again (01:48, 01:53, 01:59, 02:04), so the class filed twice more (GY-1829 at
// 02:05:13, GY-1830 — this item — at 02:38:45) for a cause the delivered fix already answers.
//
// The candidate: a delivered item's cover is counted from the moment its fix is running, not from
// its GitHub merge — the deployment observation that saw a release serving the merge (recorded by
// the restarted loop, whose own revision is what runs for a fault the loop itself raises) is the
// landing GY-1632 compares instances against. The instances the old revision raised in between
// predate the fix, so they link to it and file nothing, and a link to an item closed as its
// duplicate is not released; an instance first seen after the fix is running files as before.

const gy1830 = [
  { at: '2026-10-16T01:48:17.117Z', kind: 'action:reclaim', subject: 'reclaim:resources:2026-10-16T01:48:17.113Z' },
  { at: '2026-10-16T01:53:45.480Z', kind: 'action:reclaim', subject: 'reclaim:resources:2026-10-16T01:53:45.476Z' },
  { at: '2026-10-16T01:59:13.548Z', kind: 'action:reclaim', subject: 'reclaim:resources:2026-10-16T01:59:13.543Z' },
  { at: '2026-10-16T02:04:51.597Z', kind: 'action:reclaim', subject: 'reclaim:resources:2026-10-16T02:04:51.593Z' },
];

test('manual:fault-class-resources — GY-1830 lists 4 instances, and every one is replayed below', () => {
  assert.equal(gy1830.length, 4);
  assert.equal(new Set(gy1830.map(instance => instance.at)).size, 4);
  assert.ok(gy1830.every(instance => faultClassOf(instance.kind) === 'resources'));
  assert.ok(gy1830.every(instance => instance.subject.startsWith('reclaim:resources:')));
});

test('manual:fault-class-resources — GY-1830 reproduces: every pass the old revision ran reported the same EACCES (one entry, four instances); the candidate frees the entry on the first pass and the later passes report nothing', async () => {
  const firstAt = Date.parse(gy1830[0].at);

  // REPRODUCE against the base: the removal the base's passes ran failed on every one of them with
  // the error the instances record — the same entry, the same EACCES on the first met entry, four
  // times in sixteen minutes (the recorded lines name /var/tmp/gy-teK30QK on the host; the fixture
  // builds the same tree in its own temporary root).
  const base = await temporaryDirectory('fault-class-resources-1830-base');
  const stale = await staleSandboxEntry(base, firstAt - 3_600_000);
  const firstError = await rm(stale.entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }).then(() => null, error => error as NodeJS.ErrnoException);
  assertAdminEacces(firstError, 'the base\'s removal primitive fails on the read-only admin directory, as every instance records');
  assert.equal(existsSync(stale.entry), true, 'the base frees nothing, so the next pass meets the same entry again');
  const again = await rm(stale.entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }).then(() => null, error => error as NodeJS.ErrnoException);
  assert.equal(again!.code, 'EACCES', 'the second pass fails the same way: one unresolved entry is how four instances accumulated');
  const recorded = describeReclaim({ at: gy1830[1].at, reaped: { review: 0, producer: 0 }, closed: [], released: [], tmp: { removed: 0, bytes: 0 }, errors: [`${tmpErrorPrefix}/var/tmp/gy-teK30QK: ${firstError!.message}`] } as unknown as ResourceReclaimReport)!;
  assert.match(recorded, /^Resource reclaim: 1 could not be reclaimed: Tmp reclaim: \/var\/tmp\/gy-teK30QK: EACCES: permission denied, (?:unlink|rmdir) '.*\/graphyard-sandbox-[^/]+\/repo\/.git\/worktrees\/GY-7-1\/[^/]+'$/, 'the line instances 1, 2 and 4 record (instance 3 adds the reaped clause in front of the same tail)');

  // CANDIDATE: the pass as it now runs frees the entry whole at the first of the four instants,
  // without an error, so the passes at the other three instants meet nothing and report nothing —
  // no action:reclaim fault ever opens, and the class never counts the four.
  const fresh = await staleSandboxEntry(await temporaryDirectory('fault-class-resources-1830-candidate'), firstAt - 3_600_000);
  const freed = await reclaimTmpDirectories({ tmpRoot: fresh.tmp, now: firstAt, held: new Set(), retryMs: 10_000 });
  assert.deepEqual(freed.errors, [], 'the candidate\'s first pass frees the entry without an error');
  assert.deepEqual(freed.removed.map(removed => removed.path), [fresh.entry]);
  assert.equal(existsSync(fresh.entry), false);
  for (const instance of gy1830.slice(1)) {
    const next = await reclaimTmpDirectories({ tmpRoot: fresh.tmp, now: Date.parse(instance.at), held: new Set() });
    assert.deepEqual(next.errors, [], `the pass at ${instance.at} meets nothing: the instance never opens`);
    assert.deepEqual(next.removed, []);
  }
});

test('unit:fault-class-resources-order-independent — the EACCES the reproductions accept is order-independent: the gitdir unlink and the logs rmdir the recorded instances name pass the same assertion, a wrong code or a met entry outside GY-7-1 never does', () => {
  // The two failures CI recorded beside HEAD, chosen by readdir order on hosts the fixture does not
  // control: on one runner rm met gitdir before HEAD, on another it emptied logs and failed to
  // remove the directory. Whichever entry the base's rm meets first, the same assertion accepts it —
  assertAdminEacces({ code: 'EACCES', message: "EACCES: permission denied, unlink '/var/tmp/gy-teK30QK/graphyard-sandbox-5ClynR/repo/.git/worktrees/GY-7-1/gitdir'" } as NodeJS.ErrnoException, 'the gitdir unlink the recorded instances name');
  assertAdminEacces({ code: 'EACCES', message: "EACCES: permission denied, rmdir '/var/tmp/gy-teK30QK/graphyard-sandbox-5ClynR/repo/.git/worktrees/GY-7-1/logs'" } as NodeJS.ErrnoException, 'the logs rmdir the recorded instances name');
  assertAdminEacces({ code: 'EACCES', message: "EACCES: permission denied, unlink '/var/tmp/gy-teK30QK/graphyard-sandbox-5ClynR/repo/.git/worktrees/GY-7-1/index'" } as NodeJS.ErrnoException, 'any child of the admin directory: the index unlink too');
  // …and it still refuses what no pass inside the 0555 admin directory produces: another code, or a
  // met entry the admin directory does not hold.
  assert.throws(() => assertAdminEacces({ code: 'EPERM', message: "EPERM: operation not permitted, unlink '/var/tmp/gy-teK30QK/graphyard-sandbox-5ClynR/repo/.git/worktrees/GY-7-1/HEAD'" } as NodeJS.ErrnoException, 'x'), 'a pass that met the directory at all failed EACCES');
  assert.throws(() => assertAdminEacces({ code: 'EACCES', message: "EACCES: permission denied, unlink '/var/tmp/gy-teK30QK/HEAD'" } as NodeJS.ErrnoException, 'x'), 'the met entry stands inside .git/worktrees/GY-7-1');
  assert.throws(() => assertAdminEacces(null, 'x'), 'the removal must have failed: the base frees nothing');
});

/** The delivered GY-1828 record: with the deployment observation the restarted loop recorded, and without it — the base read the merge alone. */
const gy1828 = (observed: boolean) => ({
  id: 'id-gy-1828', key: 'GY-1828', stage: 'done',
  origin: { faultClass: { class: 'resources', threshold: 3, windowHours: 24, count: 3, detectedAt: '2026-10-16T00:20:25.949Z', instances: [] } },
  delivery: {
    mergedAt: '2026-10-16T01:42:44Z', mergeSha: '9f9b403b10cd98aff8ac5317292bc3603e43bc1d', authorizationRevision: 1,
    ...(observed ? { deployment: { sha: '9f9b403b10cd98aff8ac5317292bc3603e43bc1d', mergeSha: '9f9b403b10cd98aff8ac5317292bc3603e43bc1d', source: 'endpoint', observedAt: '2026-10-16T02:16:20.633Z', covers: 'exact', at: '2026-10-16T02:16:21.769Z', observer: 'graphyard-master' } } : {}),
  },
}) as unknown as Work;
const gy1830Instances = gy1830.map(entry => ({
  id: `${entry.kind}|${entry.subject}|${entry.at}`, kind: entry.kind, faultClass: 'resources' as const, subject: entry.subject,
  text: 'Resource reclaim: 1 could not be reclaimed: Tmp reclaim: /var/tmp/gy-teK30QK: EACCES: permission denied, unlink \u0027/var/tmp/gy-teK30QK/graphyard-sandbox-5ClynR/repo/.git/worktrees/GY-7-1/HEAD\u0027',
  at: entry.at, lastSeenAt: entry.at, linkedTo: null,
}));
/** The cycle that filed GY-1830: its detectedAt on the item. */
const gy1830DetectedAt = Date.parse('2026-10-16T02:38:16.072Z');

test('unit:fault-class-cover-from-running-fix — the GY-1828 timeline: the instances raised between the merge and the running moment link to the delivered item and file nothing, a closed duplicate\'s links are not released, and an instance after the fix is running files as before', () => {
  const policy = faultClassPolicyDefaults;

  // REPRODUCE at the base: the base counted a delivered item's cover from its GitHub merge
  // (01:42:44Z), so none of the four predates it, the cover fell, and the class filed afresh —
  // GY-1829 (detected 02:04:36) and GY-1830, the item whose instances these are. The fallback a
  // record without the serving observation still takes is exactly that rule.
  assert.equal(predateLanding(gy1830Instances, Date.parse('2026-10-16T01:42:44Z')), false, 'the merge-time rule covers none of the four');
  const atBase = recurringClasses(gy1830Instances, [gy1828(false)], policy, gy1830DetectedAt);
  assert.deepEqual(atBase.map(recurrence => [recurrence.faultClass, recurrence.file, recurrence.item?.key ?? null]), [['resources', true, null]], 'the merge-time rule files the class afresh over the four');

  // CANDIDATE: the same record with the observed serving of the release carrying the merge — every
  // instance first seen between the merge and the running moment predates the fix, the cover
  // stands, and the cycle links instead of filing.
  const candidate = recurringClasses(gy1830Instances, [gy1828(true)], policy, gy1830DetectedAt);
  assert.deepEqual(candidate.map(recurrence => [recurrence.faultClass, recurrence.file, recurrence.item?.key ?? null]), [['resources', false, 'GY-1828']], 'the running moment covers the class: nothing files');
  assert.equal(candidate[0].unlinked.length, 4, 'every instance the old revision raised links to the delivered fix');

  // …nor is a link to an item closed as its duplicate released: GY-1829 closed as GY-1828's
  // duplicate keeps its linked instance, first seen before the fix ran. The merge-time rule
  // released it, which is how it came to count toward filing GY-1830.
  const closedDuplicate = {
    id: 'id-gy-1829', key: 'GY-1829', stage: 'done',
    origin: { faultClass: { class: 'resources', threshold: 3, windowHours: 24, count: 3, detectedAt: '2026-10-16T02:04:36.246Z', instances: [] } },
    closure: { kind: 'duplicate', reason: 'Covered by GY-1828, delivered for the resources fault class', ref: 'GY-1828', by: 'graphyard-triage', at: '2026-10-16T02:20:00.000Z', from: 'backlog' },
  } as unknown as Work;
  const linked = { ...gy1830Instances[1], linkedTo: 'GY-1829' };
  const kept = [linked];
  releaseOvertakenLinks(kept, [gy1828(true), closedDuplicate]);
  assert.equal(kept[0].linkedTo, 'GY-1829', 'predating the running moment, the link to the closed duplicate stands');
  const released = [{ ...linked }];
  releaseOvertakenLinks(released, [gy1828(false), closedDuplicate]);
  assert.equal(released[0].linkedTo, null, 'the merge-time rule released it, and the instance counted toward filing the class afresh');

  // An instance first seen after the fix is running still files as before: the old four are linked
  // and counted by GY-1828, and three fresh ones past the running moment re-file the class, alone.
  const after = ['2026-10-16T02:20:00.000Z', '2026-10-16T02:25:00.000Z', '2026-10-16T02:30:00.000Z'].map((at, index) => ({
    ...gy1830Instances[0], id: `action:reclaim|reclaim:resources:after-${index}|${at}`, subject: `reclaim:resources:after-${index}`, at, lastSeenAt: at, linkedTo: null }));
  const refiled = recurringClasses([...gy1830Instances.map(entry => ({ ...entry, linkedTo: 'GY-1828' })), ...after], [gy1828(true)], policy, gy1830DetectedAt);
  assert.deepEqual(refiled.map(recurrence => [recurrence.faultClass, recurrence.file, recurrence.item?.key ?? null]), [['resources', true, null]], 'a recurrence past the threshold after the fix is running files a new item, as before');
  assert.deepEqual(refiled[0].recent.map(entry => entry.at), after.map(entry => entry.at), 'the new filing carries the post-running instances, never the pre-running ones');

  // The boundary between the observation and the record's write stamp: the restarted loop passes the
  // instant it saw the release serving as observedAt (02:16:20.633) and the server stamps the
  // record's write later as `at` (02:16:21.769). An instance first seen in between postdates the
  // landing — the fix is already known running — so it still files; a landing read from the write
  // stamp would call the same instant predating and swallow the real recurrence.
  const observed = gy1828(true), serving = observed.delivery!.deployment!;
  const boundary = '2026-10-16T02:16:21.000Z';
  assert.ok(Date.parse(serving.observedAt) < Date.parse(boundary) && Date.parse(boundary) < Date.parse(serving.at), 'the boundary instant sits between the observed serving and the record\'s write stamp');
  const gap = { ...gy1830Instances[0], id: `action:reclaim|reclaim:resources:boundary|${boundary}`, subject: 'reclaim:resources:boundary', at: boundary, lastSeenAt: boundary, linkedTo: null };
  assert.equal(predateLanding([gap], landedAt(observed)!), false, 'against the observed serving the boundary instance postdates the running fix');
  assert.equal(predateLanding([gap], Date.parse(serving.at)), true, 'read from the write stamp, the same instant counts as predating — the recurrence this landing keeps');
  const boundaryInstances = [0, 1, 2].map(index => ({ ...gap, id: `action:reclaim|reclaim:resources:boundary-${index}|${boundary}`, subject: `reclaim:resources:boundary-${index}` }));
  const refiledBoundary = recurringClasses([...gy1830Instances.map(entry => ({ ...entry, linkedTo: 'GY-1828' })), ...boundaryInstances], [observed], policy, gy1830DetectedAt);
  assert.deepEqual(refiledBoundary.map(recurrence => [recurrence.faultClass, recurrence.file, recurrence.item?.key ?? null]), [['resources', true, null]], 'an instance first seen between the observation and the write stamp files as before');
  assert.deepEqual(refiledBoundary[0].recent.map(entry => entry.at), boundaryInstances.map(entry => entry.at), 'the boundary filing carries the instances the write stamp would have swallowed');
});

// ---- GY-1955: the class recurred as three resource-bound agent-names faults on 17 October 2026 --
//
// Every instance is the same window, one the loop keeps reopening against itself: a launch whose
// pane exists and whose agent Herdr has registered but whose runtime has not yet reported
// (`agent_status 'unknown'`) — the session handle that names the pane lands 1–13 seconds after the
// fault. The base's holderSettledAt counted an implementation handle with pane null as settling any
// pane of the principal (`!pane || !handle.pane || handle.pane === pane`), and a pane-less handle
// is exactly what every launch that failed before its pane landed records, kept on its open item.
// So each faulting principal carried an older finished pane-less handle, holderSettledAt returned
// that failed launch's endedAt for the brand-new pane, the GY-1547 unplaced guard (nothing settles
// it → a launch in flight, never overdue at once) never fired, and the reading called the namespace
// overdue at its bound off a 'settled ≥ 10 minutes' the pane-less handle supplied — a resource-bound
// fault against the launch in progress, starving the profile it just chose. The reclaim passes of
// the same minutes closed nothing (their file shows no sighting of the panes); the fault was the
// reading's alone.
//
// The candidate: a named pane is judged only by handles that name it — a pane-less handle settles
// the name as a whole, never a named pane — so the guard holds again, while a pane whose own naming
// handle finished still ages and reclaims exactly as before.
//
// The pane-scoped judge itself is proof here, so the candidate exports holderSettledAt and the
// replays below call it through this lookup: the base did not export it (its pane judgment was the
// name-wide one), and a missing named import would fail the whole file at the base's load step
// instead of at the replay the criterion names.
const holderSettledOf = (masterResources as { holderSettledAt?: typeof masterResources.holderSettledAt }).holderSettledAt;

const gy1955 = [
  // GY-1872: graphyard-codex-2:5 on w1V:pQFG, handle landed 13.2s after the fault; the principal's
  // GY-1841:2 failed launch ended 03:37:23.365Z with pane null. Namespace: claude-senary, whose
  // recorded agent name (GY-1821's instance 1, same profile) is graphyard-opencode-4.
  { at: '2026-10-17T07:33:17.100Z', profile: { name: 'claude-senary', principal: 'graphyard-codex-2', agentName: 'graphyard-opencode-4' }, agentName: 'graphyard-opencode-4', pane: 'w1V:pQFG', handleLandedAt: '2026-10-17T07:33:30.312Z', priorFailedAt: '2026-10-17T03:37:23.365Z' },
  // GY-1903: graphyard-claude-1:2 on w1V:pQWD, handle landed 1.1s after the fault; GY-1907:4 ended 12:40:05.485Z.
  { at: '2026-10-17T15:31:51.149Z', profile: { name: 'claude-primary', principal: 'graphyard-claude-1', agentName: 'graphyard-claude-1' }, agentName: 'graphyard-claude-1', pane: 'w1V:pQWD', handleLandedAt: '2026-10-17T15:31:52.287Z', priorFailedAt: '2026-10-17T12:40:05.485Z' },
  // GY-1942: graphyard-opencode-1:1 on w1V:pQ0H, handle landed 6.7s after the fault; GY-1932:1 ended 18:34:32.140Z. This instance's own line is recorded verbatim.
  { at: '2026-10-17T20:02:02.167Z', profile: { name: 'opencode-primary', principal: 'graphyard-opencode-1', agentName: 'graphyard-opencode-1' }, agentName: 'graphyard-opencode-1', pane: 'w1V:pQ0H', handleLandedAt: '2026-10-17T20:02:08.859Z', priorFailedAt: '2026-10-17T18:34:32.140Z' },
];

/** One instance replayed from its recorded detail: the agent registered 'unknown' on the pane, the snapshot predating the naming handle, the older finished pane-less handle, no live lease. */
const gy1955Reading = (instance: (typeof gy1955)[number]) => {
  const at = Date.parse(instance.at), profile = { ...instance.profile, mode: 'launch' as const };
  const priorFailed = {
    id: randomUUID(), key: 'GY-1932', stage: 'build', lease: null,
    sessions: [{ id: `${profile.principal}:1`, kind: 'implementation', principal: profile.principal, epoch: 1, runtime: 'claude', host: 'vishrog', workspace: 'w1V', tab: null, pane: null, agentName: null, role: null, head: null, attach: null, transcript: null, subject: 'GY-1932', startedAt: iso(Date.parse(instance.priorFailedAt) - 20 * 60_000), updatedAt: instance.priorFailedAt, endedAt: instance.priorFailedAt, state: 'lost', outcome: null }],
  } as unknown as Work;
  const agents = [{ name: instance.agentName, agent_status: 'unknown', pane_id: instance.pane, agent: 'claude' }] as HerdrAgent[];
  const input = (overrides: Partial<ResourceInputs> = {}): ResourceInputs => ({ now: at, reviews: [], producers: [], agents, work: [priorFailed], plane: null, loop: null, revision: null, disk: null, reclaimSeen: null,
    profiles: { workers: [profile], reviewers: [], producers: [] }, ...overrides });
  return { at, profile: { ...profile, role: 'worker' as const }, agents, input };
};

test('manual:fault-class-resources — GY-1955 lists 3 instances, and every one is replayed below', () => {
  assert.equal(gy1955.length, 3);
  assert.ok(gy1955.every(instance => Date.parse(instance.handleLandedAt) > Date.parse(instance.at)), 'each faulting pane is the pane the next session record names, landed after the fault');
  assert.ok(gy1955.every(instance => Date.parse(instance.at) - Date.parse(instance.priorFailedAt) >= nameReclaimBoundMs), 'each principal carries a pane-less handle older than the 10-minute bound: the settled time the readings printed');
});

test('unit:agent-names-launch-in-flight-not-overdue — every GY-1953 instance replayed from its recorded detail raises no resources fault at the candidate', () => {
  for (const instance of gy1955) {
    const { at, profile, input } = gy1955Reading(instance);
    // CANDIDATE: the named pane is judged by handles that name it — nothing does, so it is unplaced,
    // a launch in flight, and the reading raises nothing though the namespace stays at its bound.
    // At the base this is the instance's own fault: the resource-bound line the class filed, here
    // replayed at its instant (the assertion fails there with the fault as its actual value).
    const faultsHere = faults(input());
    assert.deepEqual(faultsHere, [], `the instance at ${instance.at} raises no resources fault`);
    // The base judged the named pane by its name-wide fallback: with no handle naming the pane, the
    // `!handle.pane` clause admitted the failed launch's pane-less handle alone, so the pane-scoped
    // reading was exactly this name-wide one — the failed launch's endedAt, past the bound.
    const baseJudged = holderSettledOf!(profile, instance.agentName, { reviews: [], producers: [], work: input().work });
    assert.ok(baseJudged !== null && at - baseJudged >= nameReclaimBoundMs, 'REPRODUCE against the base: the pane read as settled by the principal\'s pane-less failed launch, past the 10-minute bound');
    assert.equal(holderSettledOf!(profile, instance.agentName, { reviews: [], producers: [], work: input().work }, instance.pane), null, 'the pane-less handle never settles the named pane');
    const reading = readResources(input()).find(entry => entry.id === `agent-names:${profile.name}`)!;
    assert.equal(reading.state, 'exhausted', 'the namespace still reads full: a launch into it is still refused and attributed');
    assert.equal(reading.overdue, 0);
    assert.match(reading.detail!, new RegExp(`${instance.agentName} \\(unknown, no live session, reclaim under way \\(no session of this snapshot names the pane; the reclaim pass judges it on its own clock\\), pane ${instance.pane}\\)`));
    // The launch's own snapshot a moment later: the naming handle landed, the pane is owned.
    const landed = { id: randomUUID(), key: 'GY-1872', stage: 'build', lease: { owner: profile.principal, epoch: 1, expiresAt: iso(at + 5 * 60_000) },
      sessions: [{ id: `${profile.principal}:5`, kind: 'implementation', principal: profile.principal, epoch: 1, runtime: 'claude', host: 'vishrog', workspace: 'w1V', tab: null, pane: instance.pane, agentName: instance.agentName, role: null, head: null, attach: null, transcript: null, subject: 'GY-1872', startedAt: instance.handleLandedAt, updatedAt: instance.handleLandedAt, endedAt: null, state: 'running', outcome: null }] } as unknown as Work;
    assert.deepEqual(faults(input({ work: [input().work[0], landed] })), [], 'the landed handle names the pane and the live lease owns it: nothing to reclaim');
  }
});

test('unit:holder-settled-pane-scoped — holderSettledAt judges a named worker pane only by handles that name that pane', () => {
  const profile = { role: 'worker' as const, name: 'claude-primary', agentName: 'graphyard-claude-1', principal: 'graphyard-claude-1' };
  const now = Date.parse('2026-10-17T20:02:02.167Z');
  const session = (id: string, pane: string | null, endedAt: number | null) => ({ id, kind: 'implementation', principal: profile.principal, epoch: 1, runtime: 'claude', host: 'vishrog', workspace: 'w1V', tab: null, pane, agentName: null, role: null, head: null, attach: null, transcript: null, subject: 'GY-1', startedAt: iso(now - 30 * 60_000), updatedAt: iso(endedAt ?? now - 60_000), endedAt: endedAt === null ? null : iso(endedAt), state: endedAt === null ? 'running' : 'lost', outcome: null });
  const work = [{ id: 'work-1', key: 'GY-1', sessions: [
    session('graphyard-claude-1:1', 'w1V:pQ0H', now - 12 * 60_000), // the pane's own naming handle, finished
    session('graphyard-claude-1:2', null, now - 30 * 60_000), // an older failed launch's pane-less record
    session('graphyard-claude-1:3', 'w1V:pQWD', now - 5 * 60_000), // a session on another pane
  ] }] as unknown as Work[];
  const input = { reviews: [] as never, producers: [] as never, work };
  // A named pane is settled by its own naming handle alone, whatever else the principal carries.
  assert.equal(holderSettledOf!(profile, 'graphyard-claude-1', input, 'w1V:pQ0H'), now - 12 * 60_000);
  // A pane no handle names is settled by nothing: not by the pane-less failed launch, not by
  // another pane's session — a launch in flight stays unplaced (GY-1547) even when the principal
  // carries pane-less handles from earlier failed launches (GY-1955), however fresh one is.
  const freshFailed = [{ id: 'work-2', key: 'GY-2', sessions: [session('graphyard-claude-1:4', null, now - 10_000)] }] as unknown as Work[];
  assert.equal(holderSettledOf!(profile, 'graphyard-claude-1', { reviews: [] as never, producers: [] as never, work: freshFailed }, 'w1V:pNEW'), null, 'a pane-less handle never settles a named pane, however recent');
  assert.equal(holderSettledOf!(profile, 'graphyard-claude-1', input, 'w1V:pNEW'), null);
  // The name as a whole keeps the name-wide reading: every handle counts, pane-less ones included.
  assert.equal(holderSettledOf!(profile, 'graphyard-claude-1', input), now - 5 * 60_000, 'with no pane judged the newest handle settles the name, as before');
  assert.equal(holderSettledOf!(profile, 'graphyard-claude-1', { reviews: [] as never, producers: [] as never, work: freshFailed }), now - 10_000, 'a pane-less handle settles the name when no pane is judged');
  // And the reading-level consequence: with only a pane-less finished handle present, a new pane is
  // unplaced, never overdue — the GY-1547 guard holds where the pane-less handles defeated it.
  const agents = [{ name: 'graphyard-claude-1', agent_status: 'unknown', pane_id: 'w1V:pNEW', agent: 'claude' }] as HerdrAgent[];
  const reading: ResourceInputs = { now, reviews: [], producers: [], agents, work: freshFailed, plane: null, loop: null, revision: null, disk: null, reclaimSeen: null,
    profiles: { workers: [{ ...profile, mode: 'launch' }], reviewers: [], producers: [] } };
  assert.deepEqual(faults(reading), []);
});

test('unit:agent-name-stale-holder-still-faults — a pane whose naming handle finished past the bound still raises, and a fresh one still waits', () => {
  const profile = { name: 'opencode-primary', principal: 'graphyard-opencode-1', agentName: 'graphyard-opencode-1', mode: 'launch' as const };
  const now = Date.parse('2026-10-17T20:02:02.167Z');
  const session = (pane: string | null, endedAt: number) => ({ id: 'graphyard-opencode-1:1', kind: 'implementation', principal: profile.principal, epoch: 1, runtime: 'claude', host: 'vishrog', workspace: 'w1V', tab: null, pane, agentName: null, role: null, head: null, attach: null, transcript: null, subject: 'GY-1', startedAt: iso(endedAt - 20 * 60_000), updatedAt: iso(endedAt), endedAt: iso(endedAt), state: 'done', outcome: null });
  const item = (sessions: unknown[]) => ({ id: randomUUID(), key: 'GY-1', stage: 'build', lease: null, sessions }) as unknown as Work;
  const agents = (status: string) => [{ name: profile.agentName, agent_status: status, pane_id: 'w1V:pQ0H', agent: 'claude' }] as HerdrAgent[];
  const readingWith = (work: Work[], status = 'idle'): ResourceInputs => ({ now, reviews: [], producers: [], agents: agents(status), work, plane: null, loop: null, revision: null, disk: null, reclaimSeen: null,
    profiles: { workers: [profile], reviewers: [], producers: [] } });
  // The pane's own naming handle finished 11 minutes ago and no live lease holds the principal —
  // beside an older pane-less failed launch, whose record must not blur the pane's own age. The
  // fault stands whether Herdr has seen the session finish (idle) or not (unknown): the pane's own
  // naming handle is what dates it.
  const stale = [item([session('w1V:pQ0H', now - 11 * 60_000), session(null, now - 90 * 60_000)])];
  const raised = classifyAttention(resourceAttention(readResources(readingWith(stale)))).filter(entry => entry.subject === 'resource:agent-names:opencode-primary');
  assert.deepEqual(raised.map(entry => entry.kind), ['resource-bound'], 'a genuinely stale holder still faults');
  assert.match(raised[0].text, /not reclaimed within 10 minutes of settling/);
  // The same pane still faults while Herdr has not yet seen the session finish (the runtime's
  // last report is 'unknown'): its own naming handle's settled time is what dates it, pane-less
  // handles or not.
  assert.match(classifyAttention(resourceAttention(readResources(readingWith(stale, 'unknown')))).find(entry => entry.subject === 'resource:agent-names:opencode-primary')!.text, /not reclaimed within 10 minutes of settling/);
  // A naming handle that finished a moment ago is a close under way, never a fault — the older
  // pane-less record does not move the pane's clock in either direction.
  const fresh = [item([session('w1V:pQ0H', now - 30_000), session(null, now - 90 * 60_000)])];
  assert.deepEqual(faults(readingWith(fresh)), [], 'settled a moment ago: the close is under way');
});

test('integration:reclaim-closes-finished-worker-pane — the reclaim pass still closes a finished worker pane, off its own naming handle\'s settle time', async () => {
  const directory = await temporaryDirectory('fault-class-resources-finished-pane');
  const profiles = { workers: [{ name: 'opencode-primary', principal: 'graphyard-opencode-1', agentName: 'graphyard-opencode-1', mode: 'launch' as const }], reviewers: [], producers: [] };
  const now = Date.parse('2026-10-17T20:02:02.167Z');
  const session = (pane: string | null, endedAt: number, state = 'done') => ({ id: 'graphyard-opencode-1:1', kind: 'implementation', principal: 'graphyard-opencode-1', epoch: 1, runtime: 'claude', host: 'vishrog', workspace: 'w1V', tab: null, pane, agentName: null, role: null, head: null, attach: null, transcript: null, subject: 'GY-1', startedAt: iso(endedAt - 20 * 60_000), updatedAt: iso(endedAt), endedAt: iso(endedAt), state, outcome: null });
  // The pane's naming handle finished 90s ago — past the 60s grace, inside the 10-minute name
  // bound; the older pane-less failed launch sits beside it.
  const work = [{ id: randomUUID(), key: 'GY-1', stage: 'build', lease: null, sessions: [session('w1V:pQ0H', now - 90_000), session(null, now - 90 * 60_000)] }] as unknown as Work[];
  const agents = [{ name: 'graphyard-opencode-1', agent_status: 'idle', pane_id: 'w1V:pQ0H', agent: 'claude' }] as HerdrAgent[];
  const closes: string[] = [];
  // First sighting, past the 60s grace: the pass records the pane unowned and closes nothing.
  const first = await reclaimResources(directory, profiles, { work, agents }, { tmpRoot: directory, now, closePane: pane => { closes.push(pane); } });
  assert.deepEqual(first.closed, []);
  assert.equal((await readReclaimState(directory)).seen['w1V:pQ0H'], iso(now), 'the first sighting starts the pass\'s own clock');
  // Two sightings 120s apart: the second pass closes the finished pane.
  const second = await reclaimResources(directory, profiles, { work, agents }, { tmpRoot: directory, now: now + unownedPaneConfirmMs, closePane: pane => { closes.push(pane); } });
  assert.deepEqual(closes, ['w1V:pQ0H']);
  assert.match(second.closed[0].reason, /its worker session finished and holds no active assignment/);
  assert.ok(unownedPaneConfirmMs + 90_000 < nameReclaimBoundMs, 'given back 210s after the settle, well inside the 10-minute name bound');
});

test('integration:reclaim-worker-launch-in-flight-spared — the worker branch spares a launch in flight on the pane-scoped settle time, and closes a genuinely stuck one only off its own sighting clock', async () => {
  const profiles = { workers: [{ name: 'opencode-primary', principal: 'graphyard-opencode-1', agentName: 'graphyard-opencode-1', mode: 'launch' as const }], reviewers: [], producers: [] };
  const now = Date.parse('2026-10-17T20:02:02.167Z');
  const pane = 'w1V:pQ0H';
  const agent = { name: 'graphyard-opencode-1', agent_status: 'unknown', pane_id: pane, agent: 'claude' } as HerdrAgent;
  // The principal's earlier failed launch: ended 90 minutes ago, its handle recorded with pane null.
  const priorFailed = [{ id: randomUUID(), key: 'GY-1932', stage: 'build', lease: null, sessions: [{ id: 'graphyard-opencode-1:1', kind: 'implementation', principal: 'graphyard-opencode-1', epoch: 1, runtime: 'claude', host: 'vishrog', workspace: 'w1V', tab: null, pane: null, agentName: null, role: null, head: null, attach: null, transcript: null, subject: 'GY-1932', startedAt: iso(now - 110 * 60_000), updatedAt: iso(now - 90 * 60_000), endedAt: iso(now - 90 * 60_000), state: 'lost', outcome: null }] }] as unknown as Work[];
  // The settle time the worker branch judges this pane by: nothing names it, so nothing settles it —
  // the pane-less failed launch never does (on the base this returned that launch's endedAt).
  assert.equal(holderSettledOf!({ role: 'worker', ...profiles.workers[0] }, 'graphyard-opencode-1', { reviews: [] as never, producers: [] as never, work: priorFailed }, pane), null);

  // A launch in flight whose record lands inside the window: sighted once on the pass's own clock,
  // spared every pass after, and its sighting dropped once the pane is owned.
  const directory = await temporaryDirectory('fault-class-resources-launch-spared');
  const closes: string[] = [];
  const first = await reclaimResources(directory, profiles, { work: priorFailed, agents: [agent] }, { tmpRoot: directory, now, closePane: pane => { closes.push(pane); } });
  assert.deepEqual(first.closed, [], 'the first pass closes nothing: the sighting only starts the clock');
  assert.equal((await readReclaimState(directory)).seen[pane], iso(now));
  const second = await reclaimResources(directory, profiles, { work: priorFailed, agents: [agent] }, { tmpRoot: directory, now: now + 70_000, closePane: pane => { closes.push(pane); } });
  assert.deepEqual(second.closed, [], 'inside the launch bound the pane is spared, never closed off the pane-less handle\'s settled time');
  // The handle lands (GY-1942's did 6.7s after the fault): the pane is the launch's own, owned.
  const landed = [{ id: randomUUID(), key: 'GY-1942', stage: 'build', lease: { owner: 'graphyard-opencode-1', epoch: 1, expiresAt: iso(now + 5 * 60_000) },
    sessions: [{ id: 'graphyard-opencode-1:1', kind: 'implementation', principal: 'graphyard-opencode-1', epoch: 1, runtime: 'claude', host: 'vishrog', workspace: 'w1V', tab: null, pane, agentName: 'graphyard-opencode-1', role: null, head: null, attach: null, transcript: null, subject: 'GY-1942', startedAt: iso(now + 7_000), updatedAt: iso(now + 70_000), endedAt: null, state: 'running', outcome: null }] }] as unknown as Work[];
  const third = await reclaimResources(directory, profiles, { work: landed, agents: [{ ...agent, agent_status: 'working' }] }, { tmpRoot: directory, now: now + 2 * unownedPaneConfirmMs, closePane: pane => { closes.push(pane); } });
  assert.deepEqual(third.closed, [], 'the landed handle and the live lease own the pane');
  assert.deepEqual((await readReclaimState(directory)).seen, {}, 'the sighting goes once the pass reads the pane owned');
  assert.deepEqual(closes, [], 'a launch in flight is never closed');

  // A launch whose record never lands is GY-1166's stuck pane, and stays so: the close comes at the
  // 120s sighting confirm, off the pass's own first sighting — never off the pane-less handle's age.
  const stuck = await temporaryDirectory('fault-class-resources-launch-stuck');
  await reclaimResources(stuck, profiles, { work: priorFailed, agents: [agent] }, { tmpRoot: stuck, now, closePane: () => {} });
  const stuckCloses: string[] = [];
  const stuckReport = await reclaimResources(stuck, profiles, { work: priorFailed, agents: [agent] }, { tmpRoot: stuck, now: now + unownedPaneConfirmMs, closePane: pane => { stuckCloses.push(pane); } });
  assert.deepEqual(stuckCloses, [pane], 'confirmed unowned past the launch bound, the pass closes it');
  assert.equal(stuckReport.closed[0].pane, pane);
  assert.match(stuckReport.closed[0].reason, /holds no active assignment and Herdr reports it unknown/);
});

// ---- GY-1967: the class recurred — 3 action:reclaim faults on the evening of 17 October 2026 ---
//
// Every instance is one entry and one refusal: the loop's /tmp pass could not remove /tmp/gy-tY0unUD
// — a merge trial's own temporary directory (src/merge-writer/trial.ts), exported as TMPDIR to the
// checkout's test run — because a writer inside that sandboxed run had planted
// graphyard-goal-compose-preview-ExM37A in it under another account (nobody:nobody on the host):
// the goal Compose preview test's scratch, made through the tests' shared helper under the TMPDIR
// it was handed. rm cannot empty a directory another account owns, makeOwnerWritable deliberately
// leaves such directories alone ("a directory another user owns is never touched — it is theirs,
// and chmod would refuse it anyway"), and the pass carried the entry in its unfinished removals —
// so every pass met the same refusal and recorded the same failed action: three faults in four
// minutes, and recurrence forever while the subtree stood.
//
// The candidate: the pass settles the refusal as kept residue (GY-1967). The entry stays, a marker
// beside it names the directory that holds it, and later passes honour the marker with one stat
// instead of meeting the refusal again — no error, no carried retry, no repeating fault — until
// the obstruction is gone, when the marker goes and the entry is due like any other. The report
// counts the settled entry as `residue`, the action line names it without failing (a pass whose
// only outcome is the residue records no action row at all), and the resources reading shows what
// stands.
//
// The reproduction runs the recorded shape for real: the planted directory is created by the same
// account that created the recorded one (uid 65534 in a container, as the Compose previews'
// fixtures do), so the kernel refuses the removal exactly as the instances record — EACCES, rmdir,
// the foreign account's directory. The foreign judgement itself — whose uid the pass reads as
// another account's — is pinned beside it without a container, the way the base's foreign-skip
// rule is pinned.

const gy1967 = [
  { at: '2026-10-17T22:05:57.024Z', subject: 'reclaim:resources:2026-10-17T22:05:57.019Z' },
  { at: '2026-10-17T22:06:52.279Z', subject: 'reclaim:resources:2026-10-17T22:06:52.275Z' },
  { at: '2026-10-17T22:09:14.122Z', subject: 'reclaim:resources:2026-10-17T22:09:14.117Z' },
];
const gy1967Entry = 'gy-tY0unUD', gy1967Planted = 'graphyard-goal-compose-preview-ExM37A';
const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0 && spawnSync('docker', ['image', 'inspect', 'alpine:3'], { encoding: 'utf8' }).status === 0;
/** Run one alpine command as the sandbox account that planted the recorded directories (uid 65534, nobody on the host), on `directory` mounted at /w. */
const asPlantedAccount = (directory: string, command: string) => execFileSync('docker', ['run', '--rm', '--user', '65534:65534', '--workdir', '/w', '-e', 'TZ=UTC', '-v', `${directory}:/w`, 'alpine:3', 'sh', '-c', command], { encoding: 'utf8' });
/** A `touch -d` stamp, for the container's own account to age what this account may not touch. */
const touchStamp = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
/** The trial-shaped entry the instances name, holding the scratch the sandboxed run planted under the TMPDIR it was handed. */
async function plantedEntry(base: string, now: number) {
  const tmp = join(base, 'tmp'), entry = join(tmp, gy1967Entry), planted = join(entry, gy1967Planted);
  await mkdir(tmp); await mkdir(entry, { mode: 0o1700 });
  // The sandbox's writer needed the same write the trial's sticky-private mode denies a stranger:
  // the fixture grants it, the way the exported TMPDIR did, and the planted tree is the account's own.
  await chmod(entry, 0o1777);
  asPlantedAccount(entry, `mkdir -p '${gy1967Planted}/worktrees' && touch -d '${touchStamp(now - 3 * 3_600_000)}' '${gy1967Planted}' '${gy1967Planted}/worktrees'`);
  const age = now - testTempMinAgeMs - 3_600_000;
  await utimes(entry, new Date(age), new Date(age));
  return { tmp, entry, planted };
}

test('manual:fault-class-resources — GY-1967 lists 3 instances, and every one is replayed below', () => {
  assert.equal(gy1967.length, 3);
  assert.equal(new Set(gy1967.map(instance => instance.at)).size, 3);
  assert.ok(gy1967.every(instance => faultClassOf('action:reclaim') === 'resources'));
  assert.ok(gy1967.every(instance => instance.subject.startsWith('reclaim:resources:')));
  assert.ok(gy1967.every(instance => Date.parse(instance.at) - Date.parse(gy1967[0].at) < 24 * 3_600_000), 'all three inside the class window');
});

test('manual:fault-class-resources — GY-1967 reproduces and does not recur: the pass meets the planted subtree, reports nothing from the second pass on, and frees the entry once it is gone', async t => {
  if (!docker) { assert.ok(!process.env.CI, 'CI runs the Compose previews'); t.skip('no Docker Compose or alpine:3 image on this host'); return; }
  const base = await temporaryDirectory('fault-class-resources-1967');
  const now = Date.parse(gy1967[1].at);
  const { tmp, entry, planted } = await plantedEntry(base, now);
  // Whatever an assertion leaves behind: the planted tree is what the pass cannot remove, so it
  // goes first, or this test would leave the very residue it is here to settle.
  t.after(() => { try { asPlantedAccount(entry, `rm -rf '${gy1967Planted}'`); } catch { /* already gone */ } });

  // REPRODUCE against the base: the removal the base's pass ran fails exactly as the instances
  // record — EACCES on rmdir of the foreign account's empty worktrees directory — and the entry
  // stands, so the next pass meets the same entry and fails the same way: one unresolved refusal
  // is how three instances accumulated in four minutes.
  const baseError = await rm(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }).then(() => null, error => error as NodeJS.ErrnoException);
  assert.equal(baseError?.code, 'EACCES');
  assert.match(baseError!.message, new RegExp(`^EACCES: permission denied, rmdir '.*${gy1967Planted.replace(/-/g, '\\-')}/worktrees'$`));
  assert.equal(existsSync(entry), true, 'the base frees nothing: the entry stands');
  const again = await rm(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }).then(() => null, error => error as NodeJS.ErrnoException);
  assert.equal(again?.code, 'EACCES', 'the second pass fails the same way');
  const recorded = describeReclaim({ at: gy1967[0].at, reaped: { review: 0, producer: 0 }, closed: [], released: [], tmp: { removed: 0, bytes: 0 }, errors: [`${tmpErrorPrefix}/tmp/${gy1967Entry}: ${baseError!.message.replace(join(tmp, gy1967Entry), `/tmp/${gy1967Entry}`)}`] } as unknown as ResourceReclaimReport)!;
  assert.match(recorded, /^Resource reclaim: 1 could not be reclaimed: Tmp reclaim: \/tmp\/gy-tY0unUD: EACCES: permission denied, rmdir '\/tmp\/gy-tY0unUD\/graphyard-goal\-compose\-preview\-ExM37A\/worktrees'$/, 'the instance line, word for word');

  // CANDIDATE, first pass (at the first instance's instant): the refusal is settled as kept
  // residue — the entry stays, the marker beside it names the directory that holds it, and no
  // error the action record would fail on is reported. A pass whose only outcome is the residue
  // records no action row at all.
  const first = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set(), unfinished: new Set() });
  assert.deepEqual(first.errors, [], 'no error is reported for the planted subtree');
  assert.equal(first.residue, 1, 'the entry is counted as settled residue');
  assert.deepEqual(first.removed, [], 'kept residue is not removed');
  assert.equal(existsSync(entry), true);
  const marker = await readTempResidue(entry);
  assert.equal(marker?.obstruction, planted, 'the marker names the directory that holds the entry');
  assert.equal(existsSync(tempResidueMarker(entry)), true);
  const firstLine = describeReclaim({ at: first.at, reaped: { review: 0, producer: 0 }, closed: [], released: [], tmp: { removed: 0, bytes: 0 }, errors: [], tmpPass: { residue: first.residue } } as unknown as ResourceReclaimReport);
  assert.equal(firstLine, null, 'a residue-only pass records no action row: the state is steady, not an event');

  // …and at the third instance's instant the pass honours the marker with one stat: settled
  // again, reported never. The recurring fault is gone while the obstruction stands.
  const second = await reclaimTmpDirectories({ tmpRoot: tmp, now: Date.parse(gy1967[2].at), held: new Set(), unfinished: new Set() });
  assert.deepEqual(second.errors, [], `the pass at ${gy1967[2].at} reports nothing: the instance never opens`);
  assert.equal(second.residue, 1);
  assert.equal(existsSync(entry), true);

  // The resources reading shows what stands: the report carries the residue and the status names it.
  // The pass runs beside the cycle, so the first call starts it and the second records what it found.
  const reportRoot = await temporaryDirectory('fault-class-resources-1967-status');
  const passOptions = { tmpRoot: tmp, tmpPass: (pass: Parameters<typeof reclaimTmpDirectories>[0]) => reclaimTmpDirectories({ ...pass, held: new Set(), unfinished: new Set() }) } as const;
  await reclaimResources(reportRoot, { reviewers: [], producers: [] }, { work: [], agents: [] }, passOptions);
  await settleTmpReclaim();
  await reclaimResources(reportRoot, { reviewers: [], producers: [] }, { work: [], agents: [] }, passOptions);
  await settleTmpReclaim();
  const inodes = await readTmpInodes(reportRoot, tmp, async () => ({ files: 1_048_576, ffree: 354_178 }));
  assert.equal(inodes?.latest?.residue, 1, 'the latest pass\'s residue count reaches the record');
  const reading = readResources({ now, reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, revision: null, disk: null, tmp: inodes, profiles: { workers: [], reviewers: [], producers: [] } }).find(entry2 => entry2.id === 'tmp-inodes');
  assert.match(reading?.detail ?? '', /1 entry held as another account's residue, marked beside it until its obstruction is gone/);

  // The obstruction is gone (the sandbox's account takes its tree back): the marker no longer
  // stands, and the same pass clears both — the entry is due like any other and goes whole. Its
  // own mtime moved when the tree left it, so the fixture ages the freed entry as the bound would
  // find it a bound later; the marker is what makes the pass free it, not the age.
  asPlantedAccount(entry, `rm -rf '${gy1967Planted}'`);
  const freedAge = Date.parse(gy1967[2].at) - testTempMinAgeMs - 3_600_000;
  await utimes(entry, new Date(freedAge), new Date(freedAge));
  const third = await reclaimTmpDirectories({ tmpRoot: tmp, now: Date.parse(gy1967[2].at) + 60_000, held: new Set(), unfinished: new Set() });
  assert.deepEqual(third.errors, []);
  assert.deepEqual(third.removed.map(removed => removed.path), [entry], 'the entry is freed whole once its obstruction is gone');
  assert.equal(third.classes?.testTemp, 1);
  assert.equal(existsSync(entry), false);
  assert.equal(await readTempResidue(entry), null, 'the residue marker went with it');
  const doneLine = describeReclaim({ at: third.at, reaped: { review: 0, producer: 0 }, closed: [], released: [], tmp: { removed: third.removed.length, bytes: third.bytes }, errors: [], tmpPass: { residue: third.residue } } as unknown as ResourceReclaimReport)!;
  assert.match(doneLine, /freed \d+ (MB|GB) from 1 stale \/tmp entry/);
  assert.equal(doneLine.includes('could not be reclaimed'), false, 'the action records done: the instances\' fault never opens');
});

test('unit:fault-class-resources-foreign-residue — the foreign judgement names the shallowest directory another account owns, the marker stands only while it does, and the settle keeps the entry without reporting it', async t => {
  const base = await temporaryDirectory('fault-class-resources-1967-unit');
  const tmp = join(base, 'tmp');
  const entry = join(tmp, 'gy-unit000'), planted = join(entry, 'graphyard-goal-compose-preview-UNIT00'), worktrees = join(planted, 'worktrees');
  await mkdir(tmp); await mkdir(entry, { mode: 0o1777 }); await mkdir(planted, { mode: 0o1777 }); await mkdir(worktrees);
  // mkdir's mode is the umask's subject: grant the world-writable bits the walk descends through
  // explicitly, so the shallowest refusal is the planted account's, not the fixture's own mask.
  await chmod(entry, 0o1777); await chmod(planted, 0o1777);
  const getuid = process.getuid, realUid = getuid!.call(process);
  try {
    process.getuid = () => realUid + 1;
    // The pass's own ownership reading: a directory the pass may write through is descended, and
    // the shallowest foreign one whose modes keep the pass out is what a settled removal names.
    assert.equal(await foreignObstruction(entry, realUid + 1), worktrees, 'the planted directory is walked through, the refusing one is named');
    assert.equal(await foreignObstruction(worktrees, realUid + 1), worktrees);
    assert.equal(await foreignObstruction(entry, realUid), null, 'the same tree, read as this user\'s own, holds no obstruction');

    // The marker a settled entry carries, and the standing judgement later passes honour.
    await writeTempResidue(entry, worktrees, Date.parse(gy1967[0].at));
    const residue = await readTempResidue(entry);
    assert.equal(residue?.obstruction, worktrees);
    assert.equal(residue?.uid, realUid, 'the marker records the obstruction\'s owner as the tree holds it');
    assert.equal(await tempResidueStands(residue!, realUid + 1), true, 'another account\'s directory keeps the pass out: the entry is skipped with one stat');
    assert.equal(await tempResidueStands(residue!, realUid), false, 'read as this user\'s own, the same directory never stands: the entry is due again');
    await rm(worktrees, { recursive: true });
    assert.equal(await tempResidueStands(residue!, realUid + 1), false, 'a cleared obstruction does not stand');
    assert.equal(await tempResidueStands({ obstruction: null, uid: null, at: '' }, realUid + 1), false, 'a settlement that named no directory is re-probed, never kept for good');

    // The settle: the entry stays, counted, marked — and any other failure is the caller's.
    const counted: { residue?: number } = {};
    assert.equal(await settleForeignResidue(entry, new ForeignSubtreeError(planted), counted), true);
    assert.equal(counted.residue, 1);
    assert.equal((await readTempResidue(entry))?.obstruction, planted, 'the marker names the obstruction for the later passes');
    assert.equal(await settleForeignResidue(entry, new Error('EACCES: something else'), {}), false, 'a failure the pass may cure is carried and reported as before');
  } finally { process.getuid = getuid; }

  // The marker is the pass's own bookkeeping: never a removal candidate, and taken back when its
  // entry is gone.
  const orphanBase = await temporaryDirectory('fault-class-resources-1967-orphan');
  const orphanTmp = join(orphanBase, 'tmp');
  await mkdir(orphanTmp);
  const orphanMarker = join(orphanTmp, 'gy-gone000.foreign');
  await writeFile(orphanMarker, '{}');
  const orphanNow = Date.parse(gy1967[2].at);
  await utimes(orphanMarker, new Date(orphanNow - 6 * 3_600_000), new Date(orphanNow - 6 * 3_600_000));
  const swept = await reclaimTmpDirectories({ tmpRoot: orphanTmp, now: orphanNow, held: new Set(), unfinished: new Set() });
  assert.deepEqual(swept.errors, []);
  assert.equal(existsSync(orphanMarker), false, 'a residue marker whose entry is gone is taken back');

  // And the action line names the residue without ever failing on it.
  const line = describeReclaim({ at: gy1967[0].at, reaped: { review: 0, producer: 0 }, closed: [], released: [], tmp: { removed: 1, bytes: 1024 }, errors: [], tmpPass: { residue: 1 } } as unknown as ResourceReclaimReport)!;
  assert.match(line, /^Resource reclaim: freed .* from 1 stale \/tmp entry; 1 tmp entry held as another account's residue$/);
  assert.equal(line.includes('could not be reclaimed'), false, 'the action records done: the instance\'s fault never opens');
});
