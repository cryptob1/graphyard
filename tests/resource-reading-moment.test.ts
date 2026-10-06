import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { masterConfigSchema, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { daemonEffects, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { readResources, resourceAttention, type ResourceInputs, type TmpInodes } from '../src/master-resources.js';
import { classifyAttention } from '../src/model/fault-classes.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1379 (manual:fault-class-resources): three resources faults in 24 hours on 6 October 2026,
 * and none was a recovery path failing to act. Each was a reading the loop counted against
 * something other than the moment and the subject it judged, for a state the product had already
 * handled:
 *
 * - resource:agent-names:claude-primary at 02:10:48Z — graphyard-claude-1 (pane w1V:pJWW) waited
 *   on GY-1331's scope decision with its lease renewed throughout (heartbeats every few seconds),
 *   and resumed the item at 02:28Z. The faults step read master status's resources against the
 *   wall clock at the end of a seven-minute cycle, but against the leases of the snapshot taken at
 *   its start: a two-minute lease read lapsed, so a live worker was "done, no live session, not
 *   reclaimed within 10 minutes of settling". The readings now judge the snapshot at its own instant.
 * - resource:executor-liveness at 16:50:31Z — "cycle 12761 is stalled", 887s of 600s, read by the
 *   loop itself in the faults step of the cycle it was running, after a restart. The loop's own
 *   liveness lines already read it as running there; the resources reading got the raw verdict.
 * - resource:tmp-inodes at 18:21:25Z — 254,401 of 1,048,576 inodes free, under the quarter-free
 *   early warning, with the loop's pass a minute old over /var/tmp and /tmp having taken back all
 *   it may: what filled the volume was other projects' entries. A pass current over the measured
 *   directory now answers the warning down to a tenth free; below a tenth it still faults.
 *
 * Each instance is replayed from its own detail and fails against the base; beside each, the state
 * that is a real fault still raises one.
 */

const iso = (ms: number) => new Date(ms).toISOString();
const config = (overrides: Record<string, unknown> = {}): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/nonexistent/coordinator.token',
  cliPath: '/nonexistent/graphyard.mjs', repository: 'cryptob1/graphyard', baseBranch: 'main', githubAppId: 1234, hostId: 'vishrog', masterAgentName: 'graphyard-master-graphyard',
  autoMerge: true, mergeMethod: 'merge', workers: [], ...overrides });
const resourceFaults = (items: { subject: string; text: string }[]) => classifyAttention(items as any).filter(item => item.faultClass === 'resources').map(item => item.subject);

// ---- Instance 1: agent-names:claude-primary, a live worker read against a later clock -------------
const claudePrimary = { name: 'claude-primary', principal: 'graphyard-claude-1', agentName: 'graphyard-claude-1', mode: 'launch', kind: 'claude', credentialFile: '/nonexistent/graphyard-claude-1.token', agentArgs: [], environment: {} };
const snapshotAt = Date.parse('2026-10-06T02:03:43.000Z');
const pane: HerdrAgent = { name: 'graphyard-claude-1', agent_status: 'done', pane_id: 'w1V:pJWW', agent: 'claude' } as HerdrAgent;
/** GY-1331 as the cycle's snapshot held it: graphyard-claude-1's lease, renewed seconds before, and its session idle on the scope decision since 01:40Z. */
const gy1331 = (leaseExpiresAt: number) => ({
  id: 'work-gy-1331', key: 'GY-1331', title: 'Soak review launch', description: '', type: 'bug', stage: 'build', epoch: 1, priority: 1, blocker: 'Scope request refused: src/landable-check.ts …',
  dependencies: [], criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], revision: 1, policyRevision: 1, createdAt: '2026-10-05T23:50:00.000Z', updatedAt: '2026-10-06T02:03:40.000Z',
  stageEnteredAt: '2026-10-05T23:58:00.000Z', ready: true, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, gates: [], violations: [],
  lease: { owner: 'graphyard-claude-1', epoch: 1, expiresAt: iso(leaseExpiresAt) },
  sessions: [{ id: 'graphyard-claude-1:1', kind: 'implementation', principal: 'graphyard-claude-1', epoch: 1, runtime: 'claude', host: 'vishrog', workspace: 'w1V', tab: null, pane: 'w1V:pJWW',
    agentName: 'graphyard-claude-1', role: null, head: null, attach: null, transcript: null, subject: 'GY-1331', startedAt: '2026-10-05T23:58:10.000Z', updatedAt: '2026-10-06T01:40:07.000Z', endedAt: null, state: 'idle', outcome: null }],
}) as unknown as Work;
/** The loop's own wiring of the report-only attention, its plane answering every read with an empty body. */
async function loopReport(work: Work[]) {
  const root = await temporaryDirectory('gy-1379-root');
  const token = join(root, 'coordinator.token');
  await writeFile(token, 'coordinator-token-'.padEnd(48, 'c'), { mode: 0o600 });
  const fetcher = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
  const effects = daemonEffects(root, config({ credentialFile: token, workers: [claudePrimary] }), { snapshot: async () => ({ work, now: iso(snapshotAt) }), mutate: async () => { throw new Error('not used'); }, executor: { principal: 'coordinator', instance: 'gy-1379' }, fetcher } as any);
  // The cycle hands the report its snapshot's work and instant, as faultStep does.
  const { items } = await effects.reportedAttention!(work, { github: true } as any, { agents: [pane], available: true, approvals: [], loop: null as any, now: iso(snapshotAt) });
  return resourceFaults(items);
}

test('manual:fault-class-resources — GY-1379 agent-names:claude-primary: a worker whose snapshot lease is live at the snapshot\'s instant is no fault, however late in the cycle the report is read', async () => {
  // The lease the snapshot held expired 90s after the snapshot; the faults step read it minutes later (in this test, years).
  assert.deepEqual(await loopReport([gy1331(snapshotAt + 90_000)]), [], 'REPRODUCE: the base judged the snapshot\'s lease against the wall clock at the faults step and read graphyard-claude-1 as unowned');
});

test('manual:fault-class-resources — GY-1379 agent-names: a worker pane whose lease had already lapsed at the snapshot\'s instant still faults once its reclaim is overdue', async () => {
  assert.deepEqual(await loopReport([gy1331(snapshotAt - 15 * 60_000)]), ['resource:agent-names:claude-primary']);
  assert.deepEqual(await loopReport([]), ['resource:agent-names:claude-primary'], 'a done pane no item accounts for is still a fault');
});

// ---- Instance 2: executor-liveness, the loop reading its own cycle as a stall ---------------------
const cycleAt = Date.parse('2026-10-06T16:50:31.964Z');
async function loopCycle(lagMs: number) {
  const seen: unknown[] = [];
  const effects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [], now: iso(cycleAt) }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(cycleAt), reason: 'not configured', deployed: [], pending: [] }),
    faultClassPolicy: { threshold: 3, windowHours: 24 }, persist: async () => {}, controlPlane: async () => ({ github: true }),
    // Master status's resources over the loop input faultStep hands it, as effects.reportedAttention reads them.
    reportedAttention: async (_work: Work[], _coordinator: unknown, observed: { loop: ResourceInputs['loop']; now: string }) => {
      seen.push(observed.loop);
      return { items: resourceAttention(readResources({ now: Date.parse(observed.now), reviews: [], producers: [], agents: [], work: [], plane: null, loop: observed.loop, revision: null, disk: null,
        profiles: { workers: [], reviewers: [], producers: [] } })) };
    },
  } as unknown as DaemonEffects;
  const master = config();
  const state = emptyDaemonState(master);
  // Pid 2107539 on vishrog, as the instance names it, alive (the probe is answered by the lock's host only).
  state.lock = { id: 'lock', pid: 2107539, host: 'another-host', startedAt: iso(cycleAt - lagMs), heartbeatAt: iso(cycleAt - lagMs) } as any;
  state.cycle = 12761;
  state.lastCycleAt = iso(cycleAt - lagMs);
  await runCycle(master, state, effects, () => cycleAt);
  return { seen, faults: state.faults.instances.filter(entry => entry.faultClass === 'resources').map(entry => entry.subject) };
}

test('manual:fault-class-resources — GY-1379 executor-liveness: the loop reading its own lag in the faults step of the cycle it runs is no stall and no resources fault', async () => {
  const { seen, faults } = await loopCycle(887_000);
  assert.ok(seen.length, 'the faults step read the report-only attention');
  assert.deepEqual(faults, [], `REPRODUCE: the base handed master status the raw verdict and counted the loop's own cycle as stalled: ${JSON.stringify(seen)}`);
  const reading = readResources({ now: cycleAt, reviews: [], producers: [], agents: [], work: [], plane: null, loop: seen[0] as ResourceInputs['loop'], revision: null, disk: null, profiles: { workers: [], reviewers: [], producers: [] } })
    .find(entry => entry.id === 'executor-liveness')!;
  assert.equal(reading.used, 887_000, 'the reading keeps the true lag');
  assert.match(reading.detail!, /read by the loop itself mid-cycle/);
});

test('manual:fault-class-resources — GY-1379 executor-liveness: a stalled loop read from outside it (master status) still faults', () => {
  const loop = { state: 'stalled' as const, lagMs: 887_000, stalledAfterMs: 600_000, detail: 'The master loop (pid 2107539 on vishrog) has not completed a cycle for 887s, past the two-interval bound of 600s; cycle 12761 is stalled.' };
  const items = resourceAttention(readResources({ now: cycleAt, reviews: [], producers: [], agents: [], work: [], plane: null, loop, revision: null, disk: null, profiles: { workers: [], reviewers: [], producers: [] } }));
  assert.deepEqual(resourceFaults(items), ['resource:executor-liveness']);
});

// ---- Instance 3: tmp-inodes, an early warning the loop's own pass already answered ----------------
const tmpAt = Date.parse('2026-10-06T18:21:25.299Z');
const tmp = (overrides: Partial<TmpInodes> = {}): TmpInodes => ({ path: '/tmp', totalInodes: 1_048_576, freeInodes: 254_401, removed: 54, removedAt: '2026-10-06T13:28:13.785Z',
  latest: { removed: 0, at: '2026-10-06T18:20:18.785Z', roots: ['/var/tmp', '/tmp'] }, measuredScanned: true, own: { entries: 3863, testTemp: 54, capped: false }, ...overrides });
const tmpFaults = (reading: TmpInodes, now = tmpAt) => resourceFaults(resourceAttention(readResources({ now, reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, revision: null, disk: null, tmp: reading,
  profiles: { workers: [], reviewers: [], producers: [] } })));

test('manual:fault-class-resources — GY-1379 tmp-inodes: below the quarter-free warning with the loop\'s pass current over the measured directory is reported, not a fault', () => {
  const reading = readResources({ now: tmpAt, reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, revision: null, disk: null, tmp: tmp(), profiles: { workers: [], reviewers: [], producers: [] } })
    .find(entry => entry.id === 'tmp-inodes')!;
  assert.equal(reading.state, 'low', 'master status still reports the volume low');
  assert.deepEqual(tmpFaults(tmp()), [], 'REPRODUCE: the base faulted on the early-warning line the loop\'s own pass had already answered');
  assert.match(reading.detail!, /that pass is current over \/tmp, so what remains is outside its reach/);
});

test('manual:fault-class-resources — GY-1379 tmp-inodes: a pass that is stale, missing or scanned elsewhere, or a volume below a tenth free, still faults', () => {
  assert.deepEqual(tmpFaults(tmp({ measuredScanned: false })), ['resource:tmp-inodes'], 'a pass over another directory answers nothing here');
  assert.deepEqual(tmpFaults(tmp({ measuredScanned: null, latest: { removed: 0, at: '2026-10-06T18:20:18.785Z' } })), ['resource:tmp-inodes'], 'a pass that named no roots');
  assert.deepEqual(tmpFaults(tmp({ latest: null, measuredScanned: null })), ['resource:tmp-inodes'], 'no pass recorded');
  assert.deepEqual(tmpFaults(tmp(), Date.parse('2026-10-06T18:50:18.785Z')), ['resource:tmp-inodes'], 'a pass 30 minutes old is not current');
  assert.deepEqual(tmpFaults(tmp({ freeInodes: 104_857 })), ['resource:tmp-inodes'], 'below a tenth free it faults whoever fills the volume');
});
