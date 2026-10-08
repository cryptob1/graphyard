import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { masterConfigSchema, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { daemonEffects, emptyDaemonState } from '../src/master-daemon.js';
import { loadedRevision, nameReclaimBoundMs, readReclaimState, readResources, reclaimResources, resourceAttention, selfUpgradeBoundMs, unownedPaneConfirmMs, type ResourceInputs } from '../src/master-resources.js';
import { resourceStatus } from '../src/master-status.js';
import { classifyAttention } from '../src/model/fault-classes.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1547 (manual:fault-class-resources): three resources faults on 8 October 2026, none of them a
 * remedy failing to act. GY-1379 made every resource reading judge the cycle's snapshot at the
 * snapshot's own instant; each instance here is an input the faults step measures later in the
 * cycle — the loop's age from `ps`, Herdr's pane inventory — judged by that earlier snapshot:
 *
 * - resource:agent-names:claude-secondary at 09:58:19Z — the first cycle after a crash loop
 *   (09:58:19Z to 09:59:13Z). The dispatcher launched graphyard-claude-2 for GY-1537 into pane
 *   w1V:pM77 at 09:59:02Z, after the snapshot; the faults step then read Herdr with the pane present
 *   and its runtime not yet reporting (`unknown`). The snapshot held no lease for the principal and
 *   named the pane in no session, so the reading settled the new pane from the principal's sessions
 *   on panes w1V:pM58 and w1V:pM6J (last active 08:20Z) and read it "not reclaimed within 10 minutes
 *   of settling". A session that names its pane now settles that pane alone, and a pane nothing in
 *   the snapshot settled, not reported finished, waits on the reclaim pass's own clock, which the
 *   pass now keeps through a close attempt that fails.
 * - resource:loaded-revision at 11:46:55Z and 12:49:02Z — the self-upgrade had checked out
 *   395475a3 at 10:54:08Z and 56ca8041 at 11:47:17Z, and the supervisor restarted the loop 17 and
 *   19 seconds after each (unit journal: started 10:54:25Z as pid 481853, 11:47:36Z as pid 866257).
 *   The reading counted the loop's age, answered by `ps` 18 and 23 seconds into the cycle, back
 *   from the snapshot's instant, placed the start before the checkout move the restart followed,
 *   and named the revision before the move as loaded: 16 commits behind, past the 30-minute bound.
 *   The age now counts back from the host's clock as `ps` is asked.
 *
 * Each instance is replayed from its own detail and the unit journal; beside each, the state that
 * is a real fault still raises one.
 */

const iso = (ms: number) => new Date(ms).toISOString();
const seconds = (at: string | number) => Math.floor((typeof at === 'string' ? Date.parse(at) : at) / 1000);
const full = (prefix: string) => prefix.padEnd(40, '0');
const minute = 60_000;
const config = (overrides: Record<string, unknown> = {}): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/nonexistent/coordinator.token',
  cliPath: '/nonexistent/graphyard.mjs', repository: 'cryptob1/graphyard', baseBranch: 'main', githubAppId: 1234, hostId: 'vishrog', masterAgentName: 'graphyard-master-graphyard',
  autoMerge: true, mergeMethod: 'merge', workers: [], ...overrides });
/** The resources faults on one resource's subjects, classified as the loop classifies them; the host's own /tmp or disk state never decides a replay. */
const resourceFaults = (items: { subject: string; text: string }[], resource: string) => classifyAttention(items as any).filter(item => item.faultClass === 'resources' && item.subject.startsWith(`resource:${resource}`)).map(item => item.subject);

// ---- Instance 1: agent-names:claude-secondary, a pane launched after the snapshot ----------------
const claudeSecondary = { name: 'claude-secondary', principal: 'graphyard-claude-2', agentName: 'graphyard-claude-2', mode: 'launch', kind: 'claude', credentialFile: '/nonexistent/graphyard-claude-2.token', agentArgs: [], environment: {} };
const snapshotAt = Date.parse('2026-10-08T09:58:19.250Z');
/** graphyard-claude-2 in pane w1V:pM77, as Herdr reported it to the faults step: launched at 09:59:02Z, runtime not yet reporting. */
const pM77 = (status = 'unknown'): HerdrAgent => ({ name: 'graphyard-claude-2', agent_status: status, pane_id: 'w1V:pM77', agent: 'claude' } as HerdrAgent);
const session = (id: string, subject: string, pane: string, startedAt: string, updatedAt: string, endedAt: string | null, state: string) => ({
  id, kind: 'implementation', principal: 'graphyard-claude-2', epoch: 1, runtime: 'claude', host: 'vishrog', workspace: 'w1V', tab: null, pane, agentName: 'graphyard-claude-2', role: null, head: null,
  attach: null, transcript: null, subject, startedAt, updatedAt, endedAt, state, outcome: null });
const item = (key: string, sessions: unknown[], lease: { expiresAt: number } | null = null) => ({
  id: `work-${key.toLowerCase()}`, key, title: key, description: '', type: 'bug', stage: 'build', epoch: 1, priority: 1, blocker: null, dependencies: [], criteria: [], policy: { checks: ['test'], review: true },
  plannedFiles: [], revision: 1, policyRevision: 1, createdAt: '2026-10-08T00:00:00.000Z', updatedAt: iso(snapshotAt), stageEnteredAt: '2026-10-08T06:00:00.000Z', ready: true, workspaces: [], candidate: null,
  submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, gates: [], violations: [],
  lease: lease ? { owner: 'graphyard-claude-2', epoch: 13, expiresAt: iso(lease.expiresAt) } : null, sessions,
}) as unknown as Work;
/** The snapshot at 09:58:19Z: the principal's sessions on two other panes, neither ended yet (the dispatcher closed both as vanished at 09:58:49Z), and no lease. */
const snapshotWork = () => [
  item('GY-1522', [session('graphyard-claude-2:1', 'GY-1522', 'w1V:pM58', '2026-10-08T06:50:00.000Z', '2026-10-08T07:21:28.746Z', null, 'running')]),
  item('GY-1543', [session('graphyard-claude-2:1', 'GY-1543', 'w1V:pM6J', '2026-10-08T07:40:00.000Z', '2026-10-08T08:20:06.355Z', null, 'running')]),
];
/** The next snapshot: GY-1537 claimed, its session on w1V:pM77 running, the two older sessions closed. */
const nextWork = () => [
  item('GY-1522', [session('graphyard-claude-2:1', 'GY-1522', 'w1V:pM58', '2026-10-08T06:50:00.000Z', '2026-10-08T09:58:49.000Z', '2026-10-08T09:58:49.000Z', 'lost')]),
  item('GY-1543', [session('graphyard-claude-2:1', 'GY-1543', 'w1V:pM6J', '2026-10-08T07:40:00.000Z', '2026-10-08T09:58:49.000Z', '2026-10-08T09:58:49.000Z', 'lost')]),
  item('GY-1537', [session('graphyard-claude-2:13', 'GY-1537', 'w1V:pM77', '2026-10-08T09:59:02.000Z', '2026-10-08T09:59:06.000Z', null, 'running')], { expiresAt: snapshotAt + 5 * minute }),
];
const inputs = (overrides: Partial<ResourceInputs>): ResourceInputs => ({ now: snapshotAt, reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, revision: null, disk: null,
  profiles: { workers: [claudeSecondary as ResourceInputs['profiles']['workers'][number]], reviewers: [], producers: [] }, ...overrides });
const faults = (input: ResourceInputs, resource = 'agent-names') => resourceFaults(resourceAttention(readResources(input)), resource);
const nameReading = (input: ResourceInputs) => readResources(input).find(entry => entry.id === 'agent-names:claude-secondary')!;
/** The loop's own wiring of the report-only attention, as faultStep reads it: the snapshot's work and instant, Herdr as read later in the cycle. */
async function loopReport(work: Work[], agents: HerdrAgent[], seen: Record<string, string> = {}) {
  const root = await temporaryDirectory('gy-1547-root');
  const token = join(root, 'coordinator.token');
  await writeFile(token, 'coordinator-token-'.padEnd(48, 'c'), { mode: 0o600 });
  if (Object.keys(seen).length) {
    await mkdir(join(root, '.graphyard'), { recursive: true, mode: 0o700 });
    await writeFile(join(root, '.graphyard', 'resource-reclaims.json'), JSON.stringify({ version: 1, reports: [], seen }), { mode: 0o600 });
  }
  const fetcher = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
  const effects = daemonEffects(root, config({ credentialFile: token, workers: [claudeSecondary] }), { snapshot: async () => ({ work, now: iso(snapshotAt) }), mutate: async () => { throw new Error('not used'); }, executor: { principal: 'coordinator', instance: 'gy-1547' }, fetcher } as any);
  const { items } = await effects.reportedAttention!(work, { github: true } as any, { agents, available: true, approvals: [], loop: null as any, now: iso(snapshotAt) });
  return resourceFaults(items, 'agent-names');
}

test('manual:fault-class-resources — GY-1547 agent-names:claude-secondary: a pane launched after the cycle\'s snapshot, which no session in it names, is no fault while the reclaim pass has not judged it', async () => {
  assert.deepEqual(await loopReport(snapshotWork(), [pM77()]), [], 'REPRODUCE: the base settled the new pane from the principal\'s sessions on other panes (last active 08:20Z) and read it overdue at once');
  const reading = nameReading(inputs({ work: snapshotWork(), agents: [pM77()] }));
  assert.equal(reading.state, 'exhausted', 'the namespace still reads full: a launch into it would be refused and attributed');
  assert.equal(reading.overdue, 0);
  assert.match(reading.detail!, /graphyard-claude-2 \(unknown, no live session, reclaim under way \(no session of this snapshot names the pane; the reclaim pass judges it on its own clock\), pane w1V:pM77\)/);
  // The next snapshot holds the claim and the session on the pane: owned, nothing to reclaim.
  assert.deepEqual(await loopReport(nextWork(), [pM77('working')]), []);
  assert.equal(nameReading(inputs({ work: nextWork(), agents: [pM77('working')] })).reclaimable, 0);
});

test('manual:fault-class-resources — GY-1547 agent-names: the same pane still faults once the reclaim pass has seen it unowned for the bound, when it finished with no session naming it, or when the session naming it settled past the bound', async () => {
  // The reclaim pass's clock: seen unowned for the bound, the pass did not give the name back.
  assert.deepEqual(await loopReport(snapshotWork(), [pM77()], { 'w1V:pM77': iso(snapshotAt - nameReclaimBoundMs) }), ['resource:agent-names:claude-secondary']);
  assert.deepEqual(await loopReport(snapshotWork(), [pM77()], { 'w1V:pM77': iso(snapshotAt - nameReclaimBoundMs / 2) }), [], 'inside the bound the reclaim is under way');
  // A finished pane nothing settled has no launch under way to wait for: a fault at once, as before.
  for (const status of ['idle', 'done']) assert.deepEqual(faults(inputs({ work: snapshotWork(), agents: [pM77(status)] })), ['resource:agent-names:claude-secondary'], `${status} with no session naming the pane`);
  // The session naming this very pane settled past the bound: the pane outlived every reclaim path.
  const settled = (endedAt: number) => [item('GY-1537', [session('graphyard-claude-2:13', 'GY-1537', 'w1V:pM77', iso(endedAt - 30 * minute), iso(endedAt), iso(endedAt), 'done')])];
  const late = inputs({ work: settled(snapshotAt - 15 * minute), agents: [pM77()] });
  assert.deepEqual(faults(late), ['resource:agent-names:claude-secondary']);
  assert.match(nameReading(late).detail!, /not reclaimed within 10 minutes of settling/);
  assert.deepEqual(faults(inputs({ work: settled(snapshotAt - 30_000), agents: [pM77()] })), [], 'settled a moment ago: the close is under way');
});

test('manual:fault-class-resources — GY-1547 agent-names: the reclaim pass keeps its first sighting of an unowned pane through a close that fails, so the reading flags the failed reclaim once the bound has run', async () => {
  const directory = await temporaryDirectory('gy-1547-pass');
  await mkdir(join(directory, '.graphyard'), { recursive: true });
  const profiles = { workers: [{ name: 'claude-secondary', principal: 'graphyard-claude-2', agentName: 'graphyard-claude-2', mode: 'launch' as const }], reviewers: [], producers: [] };
  const attempts: number[] = [];
  const pass = (at: number) => reclaimResources(directory, profiles, { work: [], agents: [pM77()] }, { tmpRoot: directory, now: at, closePane: () => { attempts.push(at); throw new Error('herdr pane close: the pane is busy'); } });
  const first = await pass(snapshotAt);
  assert.deepEqual([first.closed, first.errors, attempts], [[], [], []], 'the first sighting only starts the clock');
  const second = await pass(snapshotAt + unownedPaneConfirmMs);
  assert.deepEqual(attempts, [snapshotAt + unownedPaneConfirmMs], 'confirmed unowned past the launch bound, the pass tries to close it');
  assert.match(second.errors[0], /Closing graphyard-claude-2 \(pane w1V:pM77\): herdr pane close: the pane is busy/);
  const third = await pass(snapshotAt + unownedPaneConfirmMs + minute);
  const { seen } = await readReclaimState(directory);
  assert.equal(seen['w1V:pM77'], iso(snapshotAt), 'REPRODUCE: the base dropped the sighting on the pass that tried the close, so the next pass started the clock over');
  assert.equal(third.errors.length, 1, 'the close is retried every pass');
  assert.deepEqual(faults(inputs({ now: snapshotAt + nameReclaimBoundMs, agents: [pM77()], reclaimSeen: seen })), ['resource:agent-names:claude-secondary'], 'the reading flags the reclaim the pass could not finish within the bound');
  assert.match(nameReading(inputs({ now: snapshotAt + nameReclaimBoundMs, agents: [pM77()], reclaimSeen: seen })).detail!, /not reclaimed within 10 minutes of the reclaim pass first seeing it unowned/);
  assert.deepEqual(faults(inputs({ now: snapshotAt + unownedPaneConfirmMs + minute, agents: [pM77()], reclaimSeen: seen })), [], 'inside the bound the pass is still at it');
});

// ---- Instances 2 and 3: loaded-revision, the loop's age counted back from the snapshot's instant --
/** A git and ps answering for the coordinator checkout's reflog (newest first) and one loop process, its age measured at `measuredAt`. */
const host = (started: string | number, measuredAt: () => number, reflog: [string, string][], behind: number) => (command: string, args: string[]) => {
  if (command === 'ps') return `${Math.floor(measuredAt() / 1000) - seconds(started)}\n`;
  if (args.includes('rev-parse')) return `${reflog[0][0]}\n`;
  if (args.includes('reflog')) return reflog.map(([commit, at]) => `${commit} HEAD@{${seconds(at)}}`).join('\n') + '\n';
  if (args.includes('diff')) return 'src/master-resources.ts\n';
  return `${behind}\n`;
};
const instances = [
  // The loop (pid 481853) started 10:54:25Z, 17 s after the self-upgrade's checkout of 395475a3; the faults step asked ps 18 s into the cycle.
  { at: '2026-10-08T11:46:55.943Z', started: '2026-10-08T10:54:25Z', measured: '2026-10-08T11:47:14Z', pid: 481853, behind: 16,
    reflog: [[full('395475a3e19b'), '2026-10-08T10:54:08Z'], [full('7c7c6d1fb9dd'), '2026-10-08T10:42:46Z'], [full('507c6e7dcd63'), '2026-10-08T10:33:10Z']] as [string, string][] },
  // The loop (pid 866257) started 11:47:36Z, 19 s after the checkout of 56ca8041; the faults step asked ps 23 s into the cycle.
  { at: '2026-10-08T12:49:02.272Z', started: '2026-10-08T11:47:36Z', measured: '2026-10-08T12:49:25Z', pid: 866257, behind: 16,
    reflog: [[full('56ca80414ca9'), '2026-10-08T11:47:17Z'], [full('395475a3e19b'), '2026-10-08T10:54:08Z'], [full('7c7c6d1fb9dd'), '2026-10-08T10:42:46Z']] as [string, string][] },
];
const master = config();
const root = '/nonexistent/coordinator';
const fetcher = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
/** master status's resources as the loop reads them in the faults step: the snapshot's instant as `now`, the host's clock for `ps`. */
const status = (run: (command: string, args: string[]) => string, pid: number, now: number, clock?: () => number) => resourceStatus(root, master,
  { reviews: [], producers: [], agents: [], work: [], loop: { state: 'running', lagMs: 0, stalledAfterMs: 600_000, detail: 'cycling', self: true, lock: { pid, host: 'vishrog' } } },
  { fetcher, run, now, ...(clock ? { clock } : {}), cursor: async () => emptyDaemonState(master) });
const revisionFaults = (revision: ResourceInputs['revision'], now: number) => faults(inputs({ now, revision }), 'loaded-revision');

test('manual:fault-class-resources — GY-1547 loaded-revision: a loop restarted seconds after the checkout move it followed is read as running that revision, however late in the cycle its age is measured', async () => {
  for (const instance of instances) {
    const at = Date.parse(instance.at), measured = () => Date.parse(instance.measured);
    const run = host(instance.started, measured, instance.reflog, instance.behind);
    const report = await status(run, instance.pid, at, measured);
    const reading = report.readings.find(entry => entry.id === 'loaded-revision')!;
    assert.equal(reading.used, 0, `${instance.at}: the loop runs the checkout's revision`);
    assert.match(reading.detail!, new RegExp(`the loop loaded ${instance.reflog[0][0].slice(0, 12)}; the checkout is at ${instance.reflog[0][0].slice(0, 12)}`));
    assert.deepEqual(resourceFaults(report.attention, 'loaded-revision'), []);
    // REPRODUCE: the base counted the age back from the snapshot's instant, 18-23 s before ps answered,
    // placed the start before the move and named the revision before it, 16 commits behind past the bound.
    const base = loadedRevision(root, instance.pid, run, at)!;
    assert.equal(base.loaded, instance.reflog[1][0]);
    assert.equal(base.behind, instance.behind);
    assert.ok(base.movedAt! + selfUpgradeBoundMs < at, 'the move was past the self-upgrade bound at the snapshot');
    assert.deepEqual(revisionFaults(base, at), ['resource:loaded-revision']);
  }
});

test('manual:fault-class-resources — GY-1547 loaded-revision: a loop that never restarted onto the move still faults past the bound, and the loop\'s own wiring measures the age on the host clock', async () => {
  const stale = instances[0], at = Date.parse(stale.at), measured = () => Date.parse(stale.measured);
  // The loop started 10:42:50Z and still runs 7c7c6d1 at 11:46:55Z, 52 minutes after the checkout moved.
  const report = await status(host('2026-10-08T10:42:50Z', measured, stale.reflog, stale.behind), stale.pid, at, measured);
  assert.deepEqual(resourceFaults(report.attention, 'loaded-revision'), ['resource:loaded-revision']);
  assert.match(report.readings.find(entry => entry.id === 'loaded-revision')!.detail!, /the loop loaded 7c7c6d1fb9dd; the checkout is at 395475a3e19b/);
  // No clock injected: the loop restarted 100 s ago, 10 s after the checkout moved; the snapshot it
  // judges is a minute old. The age ps answers now counts back from now, so the start lands after the move.
  const started = Date.now() - 100_000;
  const reflog: [string, string][] = [[full('b1b1b1b1b1b1'), iso(started - 10_000)], [full('a1a1a1a1a1a1'), iso(started - 80_000)]];
  const run = host(started, () => Date.now(), reflog, 3);
  const live = await status(run, 4242, Date.now() - 60_000);
  assert.equal(live.readings.find(entry => entry.id === 'loaded-revision')!.used, 0);
  assert.deepEqual(resourceFaults(live.attention, 'loaded-revision'), []);
  // REPRODUCE: the base's pairing, the age counted back from the minute-old snapshot, lands before the move.
  assert.equal(loadedRevision(root, 4242, run, Date.now() - 60_000)!.loaded, reflog[1][0]);
});
