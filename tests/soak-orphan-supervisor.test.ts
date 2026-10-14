import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, pruneDaemonState, runCycle, type DaemonEffects, type OrphanSupervisor } from '../src/master-daemon.js';
import { nameOrphanSupervisors, supervisorReclaimCommand } from '../src/cli/master-status.js';
import { buildMasterStatus, masterConfigSchema, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1617 (AC-1, AC-2). The loop's per-cycle orphan observation, and the establishment mark it now
 * keeps on it, over three simulated days of the real loop's cycles. Each day one attempt runs:
 * its session is reported, then vanishes while its supervisor keeps renewing the lease; the loop's
 * second observation establishes it and the stop fails while the lease goes on renewing; the session
 * is reported again, which ends the observation; it vanishes again, a fresh observation is made and
 * established, the stop takes and the lease lapses. After every cycle the system invariants hold,
 * and `master status` names the orphan exactly when the loop's two observations establish it —
 * never on the first snapshot of an absence, always after a failed stop, never once the session is back.
 */
const minute = 60_000, hour = 60 * minute, days = 3, cycleMs = 20 * minute, cyclesPerDay = (24 * hour) / cycleMs, leaseMs = 2 * minute;
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const worker = { name: 'opencode-1', principal: 'worker-a', agentName: 'graphyard-opencode-1', mode: 'launch', kind: 'codex', credentialFile: '/outside/opencode-1.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;
const live: HerdrAgent[] = [{ name: worker.agentName, agent_status: 'working', pane_id: 'w1:p7' }];

// One day's script, by cycle within the day: what Herdr reports, whether the supervisor still renews, and whether a stop can be carried out.
type Phase = { session: boolean; renewing: boolean; stopFails: boolean; named: boolean; why: string };
const script: Phase[] = [
  ...Array.from({ length: 4 }, () => ({ session: true, renewing: true, stopFails: true, named: false, why: 'the session is reported' })),
  { session: false, renewing: true, stopFails: true, named: false, why: 'one snapshot of the absence' },
  { session: false, renewing: true, stopFails: true, named: true, why: 'the second observation establishes it; the stop fails' },
  ...Array.from({ length: 4 }, () => ({ session: false, renewing: true, stopFails: true, named: true, why: 'the stop keeps failing while the lease renews' })),
  { session: true, renewing: true, stopFails: true, named: false, why: 'the session is reported again' },
  { session: false, renewing: true, stopFails: false, named: false, why: 'a later absence is one new snapshot' },
  { session: false, renewing: true, stopFails: false, named: true, why: 'established afresh; the stop takes' },
];

test('unit:orphan-status-two-observations — soak: over three days the establishment mark follows the loop\'s observations through failed stops, renewals and a returning session, and every invariant holds', { timeout: 300_000 }, async () => {
  const directory = await temporaryDirectory('soak-orphan');
  try {
    const credentialFile = join(directory, 'coordinator.token');
    await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
      repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'coordinator-host',
      masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [worker] });
    const start = Date.parse('2030-01-01T00:00:00.000Z');
    let now = start, lastExpiry: number | null = null, alive = true, phase: Phase = script[0], day = 0;
    const stops: { day: number; signal: NodeJS.Signals }[] = [], failures: number[] = [];

    // The day's attempt: epoch and supervisor pid are the day's own, so each day's observation is fresh.
    const scope = (epoch: number) => ({ unit: `graphyard-watch-${4100 + epoch}-soak.scope`, pid: 4100 + epoch });
    const item = (): Work => {
      const epoch = day + 1, at = (offset: number) => new Date(now + offset).toISOString();
      // A supervisor still alive renews each cycle; a stopped one leaves the expiry it last wrote, which then lapses.
      if (phase.renewing && alive) lastExpiry = now + leaseMs;
      const held = lastExpiry !== null && lastExpiry > now;
      return { id: 'work-83', key: 'GY-83', title: 'An orphaned watch supervisor renews a lease forever', description: '', type: 'bug', priority: 0,
        dependencies: [], criteria: [{ id: 'AC-1', text: 'Stops', proofs: ['unit:orphan-status-two-observations'] }],
        policy: { checks: ['test'], review: true }, plannedFiles: ['src/supervisor.ts'], stage: 'build', revision: 9, policyRevision: 1,
        createdAt: new Date(start).toISOString(), updatedAt: at(0), stageEnteredAt: at(-10 * minute), ready: true, epoch,
        lease: held ? { owner: 'worker-a', epoch, expiresAt: new Date(lastExpiry!).toISOString() } : null,
        workspaces: [{ host: 'coordinator-host', path: `/srv/worktrees/GY-83-${epoch}`, branch: `graphyard/gy-83-${epoch}`, epoch, owner: 'worker-a' }],
        candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
        gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [],
        containmentQuarantine: held ? { owner: 'worker-a', epoch, at: at(-hour), settlementHash: 'a'.repeat(64), launchAcknowledgedAt: at(-hour), launchExpiresAt: at(-hour), leaseExpiresAt: at(-hour), scope: scope(epoch) } : null,
      } as unknown as Work;
    };
    let current = item();
    const effects: DaemonEffects = {
      agents: () => [],
      herdr: () => ({ agents: phase.session ? live : [], available: true }),
      stopSupervisor: (orphan: OrphanSupervisor, signal: NodeJS.Signals) => {
        if (phase.stopFails) { failures.push(day); throw new Error('no user manager'); }
        assert.deepEqual(orphan.scope, scope(day + 1), 'only the day\'s own supervisor is ever stopped');
        stops.push({ day, signal }); alive = false;
      },
      credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
      snapshot: async () => ({ work: [current], now: new Date(now).toISOString() }),
      closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
      observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: new Date(now).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
      recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    };

    const state = emptyDaemonState(config), violations: string[] = [], mismatches: string[] = [];
    for (let cycle = 0; now < start + days * cyclesPerDay * cycleMs; cycle++, now += cycleMs) {
      day = Math.floor(cycle / cyclesPerDay);
      const index = cycle % cyclesPerDay;
      if (index === 0) { alive = true; lastExpiry = null; }
      // Past the day's script the stopped supervisor's lease has lapsed and the item waits, unheld.
      phase = script[index] ?? { session: false, renewing: false, stopFails: false, named: false, why: 'the stopped supervisor\'s lease has lapsed' };
      current = item();
      await runCycle(config, state, effects, () => now);
      pruneDaemonState(state);
      assert.ok(state.invariants.report.length, `cycle ${cycle}: the loop judged the system invariants`);
      for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle}: ${check.invariant} — ${check.reading}`);

      // What master status says from this very snapshot and the loop's persisted state.
      const agents = phase.session ? live : [];
      const report = nameOrphanSupervisors(buildMasterStatus({ work: [current], now: new Date(now).toISOString() }, [worker], agents), [current], [worker], { agents, available: true }, now, state);
      const row = report.work[0];
      const named = /an orphaned watch supervisor/.test(row?.attention ?? '') && !!row?.attentionOwner?.next.startsWith(supervisorReclaimCommand)
        && report.attentionItems.some(entry => entry.subject === 'GY-83' && /orphaned watch supervisor/.test(entry.text));
      const anyCommand = [...report.work.map(entry => entry.attentionOwner?.next ?? ''), ...report.attentionItems.map(entry => entry.next ?? '')].some(next => next.includes(supervisorReclaimCommand));
      if (named !== phase.named || anyCommand !== phase.named) mismatches.push(`day ${day} cycle ${index} (${phase.why}): named ${named}, stop command ${anyCommand}, expected ${phase.named}`);
      // The observation is bounded: one for the held attempt at most, none once the session is back or the lease is gone.
      const observations = Object.values(state.orphans);
      assert.ok(observations.length <= 1, `cycle ${cycle}: at most one observation is kept`);
      if (phase.session || !current.lease) assert.equal(observations.length, 0, `cycle ${cycle}: no observation outlives ${phase.why}`);
      if (phase.why === 'a later absence is one new snapshot') assert.equal(observations[0]?.establishedAt, null, `day ${day}: the re-absence starts unestablished`);
    }

    assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
    assert.deepEqual(mismatches, [], 'master status names the orphan exactly when the loop\'s two observations establish it');
    // Each day: five failed stops (the establishing cycle and four renewals), then one SIGTERM that takes on the re-absence — never more.
    assert.deepEqual(failures, Array.from({ length: days }, (_, d) => Array(5).fill(d)).flat());
    assert.deepEqual(stops, Array.from({ length: days }, (_, d) => ({ day: d, signal: 'SIGTERM' as NodeJS.Signals })));
    // Incidents stay keyed per attempt and supervisor, so the record never grows by the cycle.
    const incidents = Object.keys(state.actions).filter(key => key.startsWith('incident:orphan-supervisor:'));
    assert.ok(incidents.length <= days, `one incident key per day's supervisor at most: ${incidents.join(', ')}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
