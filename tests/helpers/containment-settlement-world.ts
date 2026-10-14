import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../../src/master-daemon.js';
import { assessContainment, masterConfigSchema, type MasterConfig, type WorkerProfile } from '../../src/master.js';
import { containmentAttestation, containmentSettlementRefusals, containmentVerificationSchema } from '../../src/quarantine.js';
import type { SupervisorProbeReport } from '../../src/containment-probe.js';
import type { Work } from '../../src/model.js';
import type { SessionHandle } from '../../src/model/sessions.js';
import { temporaryDirectory } from './temp-dirs.js';

/**
 * GY-1633. A control plane and one coordinator host, as far as containment fences go: the plane
 * judges every autosettle on its own record with containmentSettlementRefusals, as the engine does,
 * and each item's supervisor on the host runs until the pane its session was launched in is closed.
 */
export const host = 'coordinator-host';
export const minute = 60_000;
export const worker = { name: 'opencode-1', principal: 'worker-a', agentName: 'graphyard-opencode-1', mode: 'launch', kind: 'claude', credentialFile: '/srv/credentials/opencode-1.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;
const launcher = fileURLToPath(new URL('../../bin/graphyard.mjs', import.meta.url));
export const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const clone = <T>(value: T): T => structuredClone(value);
export const scopeOf = (key: string) => ({ unit: `graphyard-watch-${key}.scope`, pid: 1000 + Number(key.replace(/\D/g, '')) });

/** `key`'s epoch-4 fence, its lease lapsed `lapsedMs` ago and its launch window long past. */
export function fenced(key: string, lapsedMs: number, overrides: Partial<Work> = {}): Work {
  const path = `/srv/worktrees/${key}-4`;
  return {
    id: `work-${key}`, key, title: `${key} fenced`, description: '', type: 'feature', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'build', revision: 9, policyRevision: 1,
    createdAt: iso(-120 * minute), updatedAt: iso(0), stageEnteredAt: iso(-30 * minute), ready: true, epoch: 4, lease: null,
    lastAssignment: { owner: 'worker-a', epoch: 4, claimedAt: iso(-30 * minute) },
    workspaces: [{ host, path, epoch: 4, owner: 'worker-a', branch: `graphyard/${key.toLowerCase()}-1` }],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [],
    containmentQuarantine: { owner: 'worker-a', epoch: 4, at: iso(-30 * minute), settlementHash: 'a'.repeat(64), launchAcknowledgedAt: iso(-30 * minute),
      launchExpiresAt: iso(-28 * minute), leaseExpiresAt: iso(-lapsedMs), scope: scopeOf(key) },
    ...overrides,
  } as Work;
}
/** The epoch-4 implementation session's handle, still running in `pane`. */
export const running = (key: string, pane: string) => ({ id: 'worker-a:4', kind: 'implementation', principal: 'worker-a', runtime: 'claude', host, subject: key, state: 'running', outcome: null, pane, workspace: 'w1',
  epoch: null, startedAt: iso(-30 * minute), updatedAt: iso(-29 * minute), endedAt: null } as unknown as SessionHandle);

/**
 * `supervisorsRunning` are the keys whose supervisor is up; of them, `ignoringStop` survive a stop
 * through their scope. A pane closed while its item's supervisor still runs is recorded in
 * `closedUnderLive`: that is the close the loop must never make.
 */
export function world(initial: Work[], supervisorsRunning: string[] = [], ignoringStop: string[] = []) {
  const plane = { items: new Map(initial.map(item => [item.id, clone(item)])), settles: [] as string[] };
  const running = new Set(supervisorsRunning), stubborn = new Set(ignoringStop), panesClosed: string[] = [], stopped: string[] = [], closedUnderLive: string[] = [];
  const byKey = (key: string) => [...plane.items.values()].find(item => item.key === key)!;
  const probe = (target: { key: string; workspacePath: string }): SupervisorProbeReport => {
    const live = running.has(target.key), scope = scopeOf(target.key);
    return { method: 'linux-proc-systemd', platform: 'linux', uid: 1000, workspacePath: target.workspacePath, held: [], inaccessible: 0, unverifiable: [],
      processes: live ? [{ pid: scope.pid, evidence: 'command' }] : [],
      scopes: live ? [{ unit: scope.unit, activeState: 'active', processes: [scope.pid], attributed: [] }] : [],
      recordedScope: { ...scope, activeState: live ? 'active' : 'inactive' } } as unknown as SupervisorProbeReport;
  };
  const effects: Partial<DaemonEffects> = {
    controlPlaneClock: async () => ({ clockOffset: { min: 0, max: 0 }, roundTripMs: 1, source: 'timed read' }),
    containment: (work, observed) => assessContainment(work, { hostId: host, observedAt: observed.now, clockOffset: observed.clockOffset, clockRoundTripMs: observed.clockRoundTripMs, clockSource: observed.clockSource, probe: probe as any }),
    settleContainment: async (work, assessment) => {
      const item = plane.items.get(work.id)!;
      if (item.containmentQuarantine?.epoch !== assessment.epoch) throw new Error('{"error":"Containment quarantine is missing, superseded, or does not match this verification"}');
      const refusals = containmentSettlementRefusals(item, containmentVerificationSchema.parse(assessment.verification), { now: Date.now() });
      if (refusals.length) throw Object.assign(new Error(JSON.stringify({ error: `Automatic containment settlement refused: ${refusals.join('; ')}. ${containmentAttestation(item.key)}` })), { confirmedRefusal: true });
      plane.settles.push(item.key);
      item.containmentQuarantine = null;
    },
    recordSession: async (work, handle) => {
      const item = plane.items.get(work.id)!, sessions = item.sessions ?? [], existing = sessions.find(entry => entry.id === handle.id);
      item.sessions = [...sessions.filter(entry => entry.id !== handle.id), { ...existing, ...handle, epoch: existing?.epoch ?? null } as SessionHandle];
    },
    preserveWork: async () => ({ state: 'clean' }),
    reportCapacity: async work => clone(plane.items.get(work.id)!),
    // The guarded stop: a supervisor that honours SIGTERM through its scope exits.
    stopSupervisor: async orphan => {
      stopped.push(orphan.key);
      if (!stubborn.has(orphan.key)) running.delete(orphan.key);
    },
    // Closing a session's pane hangs up its runtime, and the supervisor it ran under exits with it.
    closeSession: async (pane: string) => {
      panesClosed.push(pane);
      for (const item of plane.items.values()) if (item.sessions?.some(handle => handle.pane === pane)) {
        if (running.has(item.key)) closedUnderLive.push(`${item.key} (pane ${pane})`);
        running.delete(item.key);
      }
    },
    persist: async () => {},
  };
  return { plane, byKey, running, stubborn, panesClosed, stopped, closedUnderLive, effects, snapshot: () => [...plane.items.values()].map(clone) };
}

/** The real loop over `effects`, reading `snapshot` each cycle. */
export async function loop(effects: Partial<DaemonEffects>, snapshot: () => Work[]) {
  const directory = await temporaryDirectory('containment-settlement');
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: host,
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [worker] });
  const state: DaemonState = emptyDaemonState(config);
  const all = {
    agents: () => [], herdr: () => ({ agents: [], available: true }),
    credentials: async (profiles: WorkerProfile[]) => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: snapshot(), now: iso(0) }),
    dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    ...effects,
  } as unknown as DaemonEffects;
  return { config, state, run: () => runCycle(config, state, all), cleanup: () => rm(directory, { recursive: true, force: true }) };
}
