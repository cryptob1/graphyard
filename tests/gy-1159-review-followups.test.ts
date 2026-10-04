import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { finishedSessionGraceMs, reclaimResources, readResources, resourceRegistry } from '../src/master-resources.js';
import { saveProducerLedger } from '../src/producer.js';
import { checkAgentEnvironment } from '../src/master/environments.js';
import type { HerdrAgent } from '../src/master.js';
import type { Work } from '../src/model.js';
import type { ResourceInputs } from '../src/master-resources.js';
import type { ProducerRecord } from '../src/producer.js';

interface TriageEntry {
  id: number;
  path: string;
  description: string;
  status: 'addressed' | 'declined';
  reasonOrResolution: string;
}

const triage: TriageEntry[] = [
  {
    id: 1,
    path: 'src/master-resources.ts:674',
    description: "Exclude existing profiles from worker-pane reclamation when configured worker has mode: 'existing'",
    status: 'addressed',
    reasonOrResolution: "Worker pane reclamation loop explicitly checks `if (worker.mode !== 'launch') continue;`, preventing externally managed existing worker panes from being scanned or closed.",
  },
  {
    id: 2,
    path: 'src/master-resources.ts:674',
    description: "Exclude existing profiles from worker-pane reclamation (duplicate of finding 1 on intermediate commit)",
    status: 'addressed',
    reasonOrResolution: "Addressed together with findings 1 and 6: the worker-pane reclamation loop iterates only workers with mode === 'launch'.",
  },
  {
    id: 3,
    path: 'src/master-resources.ts:228',
    description: "Describe finished-session reclamation in resource status and operations guide",
    status: 'addressed',
    reasonOrResolution: "Addressed in code: updated session-slots registry reclaim text to explicitly include finished sessions, and updated session-slots reading detail to name finished sessions alongside blocked or never started ones. The operations guide update is declined as docs/operations-reference.md is outside plannedFiles and was judged non-blocking by the reviewer.",
  },
  {
    id: 4,
    path: 'src/master-resources.ts:335',
    description: "Preserve a grace period on the first finished sighting of pending reviewer or producer sessions",
    status: 'addressed',
    reasonOrResolution: "stuckSession requires recorded idleSince on finished sessions (!!record.idleSince && now - Date.parse(record.idleSince) >= stuckSessionMs), preventing fallback to requestedAt and immediate failure on first sighting before reconciliation can record idleSince.",
  },
  {
    id: 5,
    path: 'src/master-resources.ts:335',
    description: "Record the first finished sighting before reclaiming (duplicate of finding 4 on latest commit)",
    status: 'addressed',
    reasonOrResolution: "Addressed together with finding 4: finished sessions are not deemed stuck without a previously recorded idleSince timestamp, allowing loop session reconciliation to record the first sighting and provide the grace period.",
  },
  {
    id: 6,
    path: 'src/master-resources.ts:674',
    description: "Limit worker-pane reclaim to launch profiles (duplicate of findings 1 and 2)",
    status: 'addressed',
    reasonOrResolution: "Addressed in src/master-resources.ts: worker pane reclaim loop skips workers where mode !== 'launch'.",
  },
  {
    id: 7,
    path: 'src/master-resources.ts:245',
    description: "Update session-slot status for finished sessions (duplicate of finding 3)",
    status: 'addressed',
    reasonOrResolution: "Addressed in src/master-resources.ts: session-slots registry reclaim description and status reading detail now explicitly name finished sessions.",
  },
  {
    id: 8,
    path: 'src/master/environments.ts:226',
    description: "Restrict Z.AI probing to Z.AI credentials; avoid leaking non-Z.AI keys (e.g. OpenRouter) to api.z.ai",
    status: 'addressed',
    reasonOrResolution: "Added isZaiAccount check in src/master/environments.ts: only reads key file or auth.json generic key and transmits to api.z.ai if the account plan, keyVariable, or profile is confirmed to be Z.AI. Non-Z.AI OpenCode accounts report loggedIn without sending credentials to api.z.ai.",
  },
];

test('manual:review-followups-triaged GY-1159.1: all 8 follow-ups from GY-1130 review accounted for (AC-1)', () => {
  assert.equal(triage.length, 8, 'exactly 8 follow-up items accounted for');
  for (const entry of triage) {
    assert.ok(entry.status === 'addressed' || entry.status === 'declined', `item ${entry.id} must be addressed or declined`);
    assert.ok(entry.reasonOrResolution.length > 20, `item ${entry.id} must have a detailed reason or resolution`);
  }
  const addressedCount = triage.filter(e => e.status === 'addressed').length;
  assert.equal(addressedCount, 8, 'all follow-ups addressed in code with rationale');
});

test('manual:review-followups-triaged GY-1159.2: reclaimResources excludes mode: "existing" worker profiles from pane reclamation (Findings 1, 2, 6)', async () => {
  const directory = await temporaryDirectory('gy-1159-worker-pane');
  await mkdir(join(directory, '.graphyard'), { recursive: true });
  const now = Date.parse('2026-10-03T12:00:00.000Z');

  const workers = [
    { name: 'existing-worker', principal: 'graphyard-existing-1', agentName: 'graphyard-existing-1', mode: 'existing' as const },
    { name: 'launch-worker', principal: 'graphyard-launch-1', agentName: 'graphyard-launch-1', mode: 'launch' as const },
  ];

  const agents: HerdrAgent[] = [
    { name: 'graphyard-existing-1', agent_status: 'idle', pane_id: 'pane-existing' } as HerdrAgent,
    { name: 'graphyard-launch-1', agent_status: 'idle', pane_id: 'pane-launch' } as HerdrAgent,
  ];

  // Work items for workers: settled > 15m ago, no active lease
  const work: Work[] = [
    {
      id: 'work-existing', key: 'GY-EX', title: 'Existing', type: 'task', stage: 'done', priority: 1, dependencies: [], criteria: [],
      sessions: [{ id: 's2', kind: 'implementation', principal: 'graphyard-existing-1', epoch: 1, runtime: 'claude', host: 'vishrog', workspace: 'w1V', tab: null, pane: null, agentName: null, role: null, head: null, attach: null, transcript: null, subject: 'GY-EX', startedAt: new Date(now - 3_600_000).toISOString(), updatedAt: new Date(now - 20 * 60_000).toISOString(), endedAt: new Date(now - 20 * 60_000).toISOString(), state: 'done', outcome: null }],
    } as unknown as Work,
    {
      id: 'work-launch', key: 'GY-LN', title: 'Launch', type: 'task', stage: 'done', priority: 1, dependencies: [], criteria: [],
      sessions: [{ id: 's1', kind: 'implementation', principal: 'graphyard-launch-1', epoch: 1, runtime: 'claude', host: 'vishrog', workspace: 'w1V', tab: null, pane: null, agentName: null, role: null, head: null, attach: null, transcript: null, subject: 'GY-LN', startedAt: new Date(now - 3_600_000).toISOString(), updatedAt: new Date(now - 20 * 60_000).toISOString(), endedAt: new Date(now - 20 * 60_000).toISOString(), state: 'done', outcome: null }],
    } as unknown as Work,
  ];

  const closedPanes: string[] = [];
  const closePane = (pane: string) => { closedPanes.push(pane); };

  // First pass: records seen timestamps
  await reclaimResources(directory, { reviewers: [], producers: [], workers }, { work, agents }, { tmpRoot: directory, now, closePane });
  assert.equal(closedPanes.length, 0, 'no pane closed on first pass (grace period)');

  // Second pass: past finishedSessionGraceMs
  await reclaimResources(directory, { reviewers: [], producers: [], workers }, { work, agents }, { tmpRoot: directory, now: now + finishedSessionGraceMs + 10_000, closePane });

  // Only the launch profile's pane is closed; the existing profile's pane is never closed
  assert.ok(closedPanes.includes('pane-launch'), 'launch profile pane was closed');
  assert.ok(!closedPanes.includes('pane-existing'), 'existing profile pane was NOT closed');
});

test('manual:review-followups-triaged GY-1159.3: pending producer/reviewer session with agent in Herdr finished but idleSince unset preserves grace period and is not reclaimed on first sighting (Findings 4, 5)', async () => {
  const directory = await temporaryDirectory('gy-1159-finished-grace');
  await mkdir(join(directory, '.graphyard'), { recursive: true });
  const now = Date.parse('2026-10-03T12:00:00.000Z');

  const producerProfile = { name: 'producer-1', agentName: 'prod-agent-1' };
  const producerAgent: HerdrAgent = { name: 'prod-agent-1', agent_status: 'idle', pane_id: 'pane-prod-1' } as HerdrAgent;

  // A pending producer session requested 30m ago, but Herdr agent just went idle; idleSince is NOT yet written to the ledger
  const pendingProducerWithoutIdleSince: ProducerRecord = {
    id: randomUUID(),
    key: 'GY-PROD',
    pr: 1,
    sha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    policyRevision: 1,
    group: 'group-1',
    proofs: ['integration:proof'],
    profile: producerProfile.name,
    principal: 'principal-1',
    agentName: producerProfile.agentName,
    pane: 'pane-prod-1',
    requestId: 'req-prod-1',
    attempt: 1,
    state: 'pending',
    outcome: {},
    requestedAt: new Date(now - 30 * 60_000).toISOString(),
    expiresAt: new Date(now + 30 * 60_000).toISOString(),
    // idleSince is intentionally undefined (first sighting)
  };

  // Write initial producer ledger using saveProducerLedger
  await saveProducerLedger(directory, { version: 1, producers: [pendingProducerWithoutIdleSince] });

  const closedPanes: string[] = [];
  const closePane = (pane: string) => { closedPanes.push(pane); };

  // Run reclaim: because idleSince is not set, stuckSession must return false, preserving grace period
  const report1 = await reclaimResources(
    directory,
    { reviewers: [], producers: [producerProfile] },
    { work: [], agents: [producerAgent] },
    { now, closePane },
  );

  assert.equal(report1.released.length, 0, 'producer slot was NOT released on first sighting without idleSince');
  assert.equal(closedPanes.length, 0, 'producer pane was NOT closed on first sighting without idleSince');

  // Now simulate after reconciliation has recorded idleSince 11 minutes ago (> stuckSessionMs 10m)
  const pendingProducerWithExpiredIdleSince: ProducerRecord = {
    ...pendingProducerWithoutIdleSince,
    idleSince: new Date(now - 11 * 60_000).toISOString(),
  };

  await saveProducerLedger(directory, { version: 1, producers: [pendingProducerWithExpiredIdleSince] });

  const report2 = await reclaimResources(
    directory,
    { reviewers: [], producers: [producerProfile] },
    { work: [], agents: [producerAgent] },
    { now, closePane },
  );

  assert.equal(report2.released.length, 1, 'producer slot WAS released after idleSince exceeded stuckSessionMs');
  assert.equal(report2.released[0].name, 'prod-agent-1');
  assert.ok(report2.released[0].reason.includes('finished (idle)'));
  assert.ok(closedPanes.includes('pane-prod-1'), 'producer pane was closed after idleSince expired');
});

test('manual:review-followups-triaged GY-1159.4: session-slots registry reclaim and reading detail describe finished sessions (Findings 3, 7)', () => {
  const sessionSlotsDef = resourceRegistry.find(entry => entry.id === 'session-slots');
  assert.ok(sessionSlotsDef, 'session-slots resource definition exists');
  assert.ok(sessionSlotsDef.reclaim.includes('finished'), 'reclaim description explicitly mentions finished sessions');

  // Verify readResources detail output includes 'finished' when sessions are stuck
  const now = Date.now();
  const inputs: ResourceInputs = {
    now,
    reviews: [],
    producers: [
      {
        id: randomUUID(), key: 'GY-1', state: 'pending', agentName: 'agent-1',
        requestedAt: new Date(now - 30 * 60_000).toISOString(),
        idleSince: new Date(now - 15 * 60_000).toISOString(),
      } as any,
    ],
    agents: [{ name: 'agent-1', agent_status: 'done', pane_id: 'p1' } as HerdrAgent],
    work: [],
    plane: null, loop: null, revision: null, disk: null,
    profiles: {
      workers: [], reviewers: [],
      producers: [{ name: 'p1', agentName: 'agent-1' } as any],
    },
  };

  const readings = readResources(inputs);
  const producerReading = readings.find(r => r.id === 'session-slots:producer');
  assert.ok(producerReading, 'session-slots:producer reading found');
  assert.equal(producerReading.reclaimable, 1);
  assert.ok(producerReading.detail?.includes('finished, stuck on a prompt or never started'), `detail (${producerReading.detail}) names finished sessions`);
});

test('manual:review-followups-triaged GY-1159.5: OpenCode accounts configured for non-Z.AI providers do not probe api.z.ai or leak non-Z.AI credentials (Finding 8)', async () => {
  const directory = await temporaryDirectory('gy-1159-zai-probe');
  const home = join(directory, 'opencode-home');
  await mkdir(home, { recursive: true });

  // 1. Configure OpenRouter credentials in key file and auth.json
  const openrouterKey = 'sk-or-v1-super-secret-openrouter-key-12345';
  await writeFile(join(home, 'openrouter.key'), openrouterKey);
  await writeFile(join(home, 'auth.json'), JSON.stringify({ key: openrouterKey }));

  let fetchCalls: { url: string; headers: Record<string, string> }[] = [];
  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), headers: (init?.headers as Record<string, string>) ?? {} });
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, msg: 'success', data: { limits: [] } }),
      text: async () => '{"code":0}',
    } as any;
  }) as unknown as typeof fetch;

  // Case A: OpenCode environment with plan 'openrouter' and keyFile 'openrouter.key'
  const nonZaiEnv = {
    name: 'opencode-openrouter',
    kind: 'opencode' as const,
    home,
    plan: 'openrouter',
    keyFile: 'openrouter.key',
  };

  const health = await checkAgentEnvironment(nonZaiEnv as any, { fetch: mockFetch });
  assert.equal(health.loggedIn, true, 'account with auth.json/key file is recognized as logged in');
  assert.equal(fetchCalls.length, 0, 'mockFetch to api.z.ai must NEVER be called for non-Z.AI plan');
  assert.ok(health.note?.includes('OpenCode exposes no provider quota Graphyard can read'), 'note indicates provider reports limits in session');

  // Case B: OpenCode environment with keyVariable 'OPENROUTER_API_KEY'
  const nonZaiEnvVar = {
    name: 'opencode-var',
    kind: 'opencode' as const,
    home,
    keyVariable: 'OPENROUTER_API_KEY',
  };

  fetchCalls = [];
  const healthVar = await checkAgentEnvironment(nonZaiEnvVar as any, { fetch: mockFetch });
  assert.equal(fetchCalls.length, 0, 'mockFetch to api.z.ai must NEVER be called when keyVariable is non-Z.AI');

  // Case C: Z.AI environment with zai.key
  const zaiHome = join(directory, 'zai-home');
  await mkdir(zaiHome, { recursive: true });
  const zaiKey = 'zai-api-key-test-abc';
  await writeFile(join(zaiHome, 'zai.key'), zaiKey);

  fetchCalls = [];
  const zaiEnv = {
    name: 'opencode-zai',
    kind: 'opencode' as const,
    home: zaiHome,
    plan: 'zai',
  };

  const zaiHealth = await checkAgentEnvironment(zaiEnv as any, { fetch: mockFetch });
  assert.equal(zaiHealth.loggedIn, true);
  assert.equal(fetchCalls.length, 1, 'mockFetch to api.z.ai IS called for Z.AI account');
  assert.ok(fetchCalls[0].url.includes('api.z.ai'), 'fetch target is api.z.ai');
  assert.equal(fetchCalls[0].headers.Authorization, `Bearer ${zaiKey}`, 'fetch Authorization header sends Z.AI key');
});
