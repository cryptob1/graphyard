import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Work } from '../src/model.js';
import { masterConfigSchema, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runDaemon, type DaemonEffects } from '../src/master-daemon.js';
import { classified, trackFaults, type FaultRecord } from '../src/model/fault-classes.js';
import { codeReloadReason, liveChildren, loadedRevision, readReclaimSightings, readResources, reclaimResources, resourceAttention, revisionReloadGraceMs, unownedNameGraceMs, type ResourceInputs } from '../src/master-resources.js';

/**
 * GY-531: three resources faults in 24 hours, each the loop flagging a state it produces and undoes
 * itself. One case per instance the item lists, each reproduced as the loop saw it:
 *
 * - 07:38:33 resource:loaded-revision — a delivery moved the coordinator checkout one commit past
 *   the code the loop loaded, and a zero bound read that as exhausted at once, though nothing but a
 *   person's restart would ever bring the loop onto it. The loop now reloads itself under its
 *   supervisor, and the reading warns only once that reload is overdue.
 * - 07:39:59 resource:agent-names:claude-primary — a worker's name held by its pane in the moment
 *   between its lease ending and the loop's first step closing that pane read as a name nothing
 *   gives back. A holder now warns only once the reclaim pass has seen it unowned past the bound.
 * - 07:39:59 resource:loaded-revision — the same standing fault as the first, counted again because
 *   the next merge changed the checkout's commit id in its text. Commit ids are figures now.
 */

const loaded = '4c6c9a6ae1d8'.padEnd(40, '0'), first = '61a9670f14b5'.padEnd(40, '1'), second = '147272e15953'.padEnd(40, '2');
const at = Date.parse('2026-09-26T07:38:33.294Z');
const worker = { name: 'claude-primary', principal: 'graphyard-claude-1', agentName: 'graphyard-claude-1', mode: 'launch' };
const blank = (overrides: Partial<ResourceInputs> = {}): ResourceInputs => ({ now: at, reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, revision: null, disk: null,
  profiles: { workers: [], reviewers: [], producers: [] }, ...overrides });
const raised = (input: ResourceInputs) => resourceAttention(readResources(input)).map(item => item.subject);

test('GY-531 instance 1 — a checkout one commit past the loop, just moved, is not a resource at its bound; the supervised loop reloads itself onto it', async () => {
  // As the loop read it at 07:38:33: one commit behind, the checkout having moved a moment before.
  const behind = { behind: 1, loaded, checkout: first, movedAt: at - 90_000 };
  assert.deepEqual(raised(blank({ revision: behind })), [], 'a checkout that has just moved is the reload about to happen, not a fault');
  const reading = readResources(blank({ revision: behind })).find(entry => entry.id === 'loaded-revision')!;
  assert.equal(reading.state, 'exhausted', 'the reading still reports the loop behind its checkout');
  assert.equal(reading.overdue, false);
  // The fault the reading exists for stays: a loop that has not reloaded within the bound warns.
  assert.deepEqual(raised(blank({ revision: { ...behind, movedAt: at - revisionReloadGraceMs } })), ['resource:loaded-revision']);
  // A reading that cannot say when the checkout moved warns as before.
  assert.deepEqual(raised(blank({ revision: { behind: 1, loaded, checkout: first } })), ['resource:loaded-revision']);

  // When the checkout moved is its reflog entry after the process started.
  const started = Math.floor(at / 1000) - 600, moved = started + 540;
  const git = (command: string, args: string[]) => command === 'ps' ? '600\n'
    : args.includes('rev-parse') ? `${first}\n`
    : args.includes('reflog') ? `${first} HEAD@{${moved}}\n${loaded} HEAD@{${started - 60}}\n`
    : '1\n';
  assert.deepEqual(loadedRevision('/nonexistent', 1, git, at), { loaded, checkout: first, behind: 1, movedAt: moved * 1000 });

  // The loop reloads itself only when it is behind and nothing it launched is still running.
  const revision = () => ({ loaded, checkout: first, behind: 1 });
  assert.match(codeReloadReason('/nonexistent', 1, { revision, children: () => 0 })!, /moved 1 commit\(s\) past the code this loop loaded \(4c6c9a6ae1d8 → 61a9670f14b5\)/);
  assert.equal(codeReloadReason('/nonexistent', 1, { revision, children: () => 1 }), null, 'an in-process run (a headless session) is never cut short');
  assert.equal(codeReloadReason('/nonexistent', 1, { revision, children: () => null }), null, 'children that cannot be read are not assumed absent');
  assert.equal(codeReloadReason('/nonexistent', 1, { revision: () => ({ loaded, checkout: loaded, behind: 0 }), children: () => 0 }), null);
  if (process.platform === 'linux') assert.equal(typeof liveChildren(process.pid), 'number');

  // Under a supervisor the loop exits after the cycle so the supervisor starts the new revision.
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/nonexistent/coordinator.token', cliPath: '/nonexistent/graphyard.mjs',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] }) as MasterConfig;
  const effects = (): DaemonEffects => ({
    agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [], now: new Date(at).toISOString() }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(at).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {}, notify: async () => {},
  });
  const options = { intervalMs: 5, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGUSR2' as NodeJS.Signals], log: () => {} };
  let asked = 0;
  const reason = () => { asked += 1; return codeReloadReason('/nonexistent', 1, { revision, children: () => 0 }); };
  const supervised = await runDaemon(master, emptyDaemonState(master), effects(), { ...options, environment: { NOTIFY_SOCKET: '/nonexistent/notify' }, codeReload: reason });
  assert.equal(supervised.cycles.length, 1, 'the loop ran one cycle and ended for its supervisor to restart it');
  assert.match(supervised.reloading!, /exiting so the supervisor starts it on the checkout's revision/);
  assert.equal(supervised.stopped, false);
  // Outside a supervisor nothing would start it again, so it keeps running the code it has.
  let cycles = 0;
  const bare = effects();
  bare.snapshot = async () => { if (++cycles >= 2) process.emit('SIGUSR2' as NodeJS.Signals); return { work: [], now: new Date(at).toISOString() }; };
  const unsupervised = await runDaemon(master, emptyDaemonState(master), bare, { ...options, environment: {}, codeReload: reason });
  assert.equal(unsupervised.reloading, null);
  assert.equal(asked, 1, 'an unsupervised loop never asks');
});

test('GY-531 instance 2 — a worker name held in the moment after its lease ended warns only once the reclaim pass has seen it unowned past the bound', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gy-531-'));
  try {
    await mkdir(join(directory, '.graphyard'), { recursive: true, mode: 0o700 });
    // As the loop read it at 07:39:59: claude-primary's one name held by its pane, working, no live lease.
    const agents: HerdrAgent[] = [{ name: 'graphyard-claude-1', pane_id: 'w1V:p4TY', agent_status: 'working' }];
    const work: Work[] = [];
    const profiles = { workers: [worker], reviewers: [], producers: [] };
    const now = Date.parse('2026-09-26T07:39:59.301Z');
    // Without any reclaim record nothing is giving the name back, so it warns at once, as before.
    assert.deepEqual(raised(blank({ now, agents, profiles })), ['resource:agent-names:claude-primary']);

    // The cycle's reclaim pass notes the holder (a worker's pane is the loop's to close, not the pass's).
    const closed: string[] = [];
    await reclaimResources(directory, profiles, { work, agents }, { now, closePane: pane => { closed.push(pane); } });
    assert.deepEqual(closed, [], 'the reclaim pass never closes a worker pane');
    const unowned = await readReclaimSightings(directory);
    assert.equal(unowned?.['unowned:graphyard-claude-1'], new Date(now).toISOString());
    const reading = readResources(blank({ now, agents, profiles, unowned })).find(entry => entry.id === 'agent-names:claude-primary')!;
    assert.deepEqual({ used: reading.used, bound: reading.bound, state: reading.state, reclaimable: reading.reclaimable }, { used: 1, bound: 1, state: 'exhausted', reclaimable: 0 });
    assert.deepEqual(raised(blank({ now, agents, profiles, unowned })), [], 'a holder first seen unowned this pass is the close about to happen, not a fault');

    // Seen unowned on every pass for the whole bound, it is a name nothing gave back: that still warns.
    await reclaimResources(directory, profiles, { work, agents }, { now: now + unownedNameGraceMs, closePane: pane => { closed.push(pane); } });
    const later = await readReclaimSightings(directory);
    assert.equal(later?.['unowned:graphyard-claude-1'], new Date(now).toISOString(), 'the first sighting is kept while the holder stands');
    assert.deepEqual(raised(blank({ now: now + unownedNameGraceMs, agents, profiles, unowned: later })), ['resource:agent-names:claude-primary']);

    // A name its live lease owns is noted by nothing.
    const leased = [{ key: 'GY-9', stage: 'build', lease: { owner: 'graphyard-claude-1', epoch: 1, expiresAt: new Date(now + 600_000).toISOString() } }] as unknown as Work[];
    await reclaimResources(directory, profiles, { work: leased, agents }, { now: now + unownedNameGraceMs + 1 });
    assert.equal((await readReclaimSightings(directory))?.['unowned:graphyard-claude-1'], undefined);
    assert.deepEqual(raised(blank({ now: now + unownedNameGraceMs + 1, agents, profiles, work: leased, unowned: await readReclaimSightings(directory) })), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('GY-531 instance 3 — the loaded-revision fault standing across a second merge is one instance, not two', () => {
  const text = (behind: number, checkout: string) => `Loop loaded-code revision is at its bound: ${behind} commits behind used of 0 commits behind, 0 commits behind left — the loop loaded ${loaded.slice(0, 12)}; the checkout is at ${checkout.slice(0, 12)}. It warns below 0 commits behind of headroom; a restart loads the checkout's revision`;
  const observe = (behind: number, checkout: string) => ({ ...classified('resource-bound'), subject: 'resource:loaded-revision', text: text(behind, checkout) });
  const record: FaultRecord = { instances: [], open: {}, failing: {} };
  assert.equal(trackFaults(record, [observe(1, first)], '2026-09-26T07:38:33.294Z').length, 1);
  assert.deepEqual(trackFaults(record, [observe(2, second)], '2026-09-26T07:39:59.301Z'), [], 'the checkout moving further is the same fault still standing');
  assert.equal(record.instances.length, 1);
  assert.equal(record.instances[0].lastSeenAt, '2026-09-26T07:39:59.301Z');
  // A fault that cleared and came back is still a new instance.
  trackFaults(record, [], '2026-09-26T07:45:00.000Z');
  assert.equal(trackFaults(record, [observe(1, second)], '2026-09-26T08:00:00.000Z').length, 1);
});
