import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyAttention, faultClassOf, faultClassPolicyDefaults, predateLanding, recurringClasses, releaseOvertakenLinks, trackFaults } from '../src/model/fault-classes.js';
import { hostMemoryAttention, hostMemoryFloor, judgeHostMemory, memoryRecoveryMarginBytes, nameReclaimBoundMs, readReclaimState, readResources, reclaimResources, resourceAttention, describeReclaim, tmpErrorPrefix, type ResourceInputs, type ResourceReclaimReport } from '../src/master-resources.js';
import { diskThresholdBytes, masterConfigSchema, type MasterConfig } from '../src/master.js';
import { cycleFaults, emptyDaemonState } from '../src/master-daemon.js';
import { judgeWorktreeDisk, worktreePassCurrentMs } from '../src/master/worktree-disk.js';
import { reclaimTmpDirectories, testTempMinAgeMs } from '../src/tmp-reclaim.js';
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

test('manual:fault-class-resources — GY-1828 instance 3 reproduces: the base pass reports the entry EACCES and frees nothing; the candidate frees it whole and the action records done', async () => {
  const base = await temporaryDirectory('fault-class-resources-readonly');
  const now = instance3At - 3_600_000;
  const { tmp, entry } = await staleSandboxEntry(base, now);

  // REPRODUCE against the base: the removal the base's pass runs fails exactly as the item
  // recorded — `EACCES: permission denied, unlink` on the first file inside the 0555 directory —
  // and the entry stays, so the pass reports the error the action record carried as a fault.
  const baseError = await rm(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }).then(() => null, error => error as NodeJS.ErrnoException);
  assert.match(baseError!.message, /EACCES: permission denied, unlink '.*\.git\/worktrees\/GY-7-1\/HEAD'$/, 'the base\'s removal primitive fails on the read-only admin directory');
  assert.equal(existsSync(entry), true, 'the base frees nothing: the entry stands');
  const baseReport = { at: new Date(instance3At).toISOString(), reaped: { review: 1, producer: 0 }, closed: [], released: [], tmp: { removed: 1, bytes: 38_973_291 }, errors: [`/var/tmp/gy-teK30QK: ${baseError!.message}`] } as unknown as ResourceReclaimReport;
  const baseLine = describeReclaim(baseReport)!;
  assert.match(baseLine, /^Resource reclaim: reaped 1 review and 0 producer ledger record\(s\); freed 39 MB from 1 stale \/tmp entry; 1 could not be reclaimed: \/var\/tmp\/gy-teK30QK: EACCES: permission denied, unlink/);
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
  // the error the instances record — the same entry, the same unlink, four times in sixteen minutes
  // (the recorded lines name /var/tmp/gy-teK30QK on the host; the fixture builds the same tree in
  // its own temporary root).
  const base = await temporaryDirectory('fault-class-resources-1830-base');
  const stale = await staleSandboxEntry(base, firstAt - 3_600_000);
  const firstError = await rm(stale.entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }).then(() => null, error => error as NodeJS.ErrnoException);
  assert.match(firstError!.message, /EACCES: permission denied, unlink '.*\/graphyard-sandbox-[^/]+\/repo\/.git\/worktrees\/GY-7-1\/HEAD'$/, 'the base\'s removal primitive fails on the read-only admin directory, as every instance records');
  assert.equal(existsSync(stale.entry), true, 'the base frees nothing, so the next pass meets the same entry again');
  const again = await rm(stale.entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }).then(() => null, error => error as NodeJS.ErrnoException);
  assert.equal(again!.code, 'EACCES', 'the second pass fails the same way: one unresolved entry is how four instances accumulated');
  const recorded = describeReclaim({ at: gy1830[1].at, reaped: { review: 0, producer: 0 }, closed: [], released: [], tmp: { removed: 0, bytes: 0 }, errors: [`${tmpErrorPrefix}/var/tmp/gy-teK30QK: ${firstError!.message}`] } as unknown as ResourceReclaimReport)!;
  assert.match(recorded, /^Resource reclaim: 1 could not be reclaimed: Tmp reclaim: \/var\/tmp\/gy-teK30QK: EACCES: permission denied, unlink '.*\/graphyard-sandbox-[^/]+\/repo\/.git\/worktrees\/GY-7-1\/HEAD'$/, 'the line instances 1, 2 and 4 record (instance 3 adds the reaped clause in front of the same tail)');

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
});
