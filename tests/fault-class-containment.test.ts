import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { cycleFaults, emptyDaemonState } from '../src/master-daemon.js';
import { workFaults } from '../src/model/fault-classes.js';
import { containmentPhase } from '../src/model/containment.js';

// GY-1151 names this file for its proof: manual:fault-class-containment. The master loop filed 7 containment
// faults in 24 hours on 3 October 2026. Every one was a completed or interrupted attempt whose containment
// fence was inside the 120-second grace window (containmentGraceMs) before supervisor absence can legally
// be verified or settled. Within minutes, autosettle cleanly settled every one of them without intervention.
//
// The shared cause:
//   - workFaults emitted a containment fault on any item with containmentQuarantine whenever it lacked an
//     active lease, ignoring whether the item was in its routine grace window (containmentPhase 'grace');
//   - cycleFaults classified the derived attention line containment-grace as a containment fault when not
//     covered by an own fault.
//
// Each instance is replayed from the ledger (`graphyard events GY-N`) as the item stood at the instant
// the loop recorded it. Against the base each subtest fails: the instance reproduces. Against the candidate
// each passes: no fault is observed while inside the grace window, and genuinely lapsed quarantines past
// grace are observed as containment faults.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const config = (): MasterConfig => masterConfigSchema.parse({
  version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
  autoMerge: true, mergeMethod: 'merge', workers: [],
});

interface Instance {
  id: string;
  subject: string;
  observedAt: string;
  epoch: number;
  owner: string;
  leaseExpiresAt: string;
  launchExpiresAt: string;
  settlementHash: string;
  settled: string;
}

const instances: Instance[] = [
  {
    id: 'containment|GY-1027|2026-10-03T08:26:44.721Z',
    subject: 'GY-1027',
    observedAt: '2026-10-03T08:26:44.721Z',
    epoch: 16,
    owner: 'graphyard-claude-2',
    leaseExpiresAt: '2026-10-03T08:28:18.423Z',
    launchExpiresAt: '2026-10-03T08:27:00.000Z',
    settlementHash: '8b7f2f118121db5976b70743b18566d8ba9c9963e6e8e8ce1b29a24d2ef79a29',
    settled: 'submitted 08:26:39, autosettled 08:32:15',
  },
  {
    id: 'containment|GY-566|2026-10-03T11:09:53.672Z',
    subject: 'GY-566',
    observedAt: '2026-10-03T11:09:53.672Z',
    epoch: 73,
    owner: 'graphyard-claude-2',
    leaseExpiresAt: '2026-10-03T11:08:56.840Z',
    launchExpiresAt: '2026-10-03T11:07:00.000Z',
    settlementHash: 'bb9a1adccdb898083aae0c78a05f32eb4a16b9cbbe2c2cead26c459ca2a5f78c',
    settled: 'interrupted 11:06:57, autosettled 11:12:39',
  },
  {
    id: 'containment|GY-973|2026-10-03T11:09:53.672Z',
    subject: 'GY-973',
    observedAt: '2026-10-03T11:09:53.672Z',
    epoch: 17,
    owner: 'graphyard-cursor-2',
    leaseExpiresAt: '2026-10-03T11:08:33.208Z',
    launchExpiresAt: '2026-10-03T11:07:00.000Z',
    settlementHash: '2fb2853177894d8a55e2d67ad97e55ceea73fcb5c71b697669d03d3ce6b2518e',
    settled: 'interrupted 11:06:57, autosettled 11:12:39',
  },
  {
    id: 'containment|GY-1070|2026-10-03T11:09:53.672Z',
    subject: 'GY-1070',
    observedAt: '2026-10-03T11:09:53.672Z',
    epoch: 20,
    owner: 'graphyard-claude-3',
    leaseExpiresAt: '2026-10-03T11:08:40.852Z',
    launchExpiresAt: '2026-10-03T11:07:00.000Z',
    settlementHash: 'd3d62283084196ddc862bc341df47da3dcbf1ca75fbca8e3f43454b5ae17e817',
    settled: 'interrupted 11:06:47, autosettled 11:12:39',
  },
  {
    id: 'containment|GY-1098|2026-10-03T11:09:53.672Z',
    subject: 'GY-1098',
    observedAt: '2026-10-03T11:09:53.672Z',
    epoch: 14,
    owner: 'graphyard-claude-4',
    leaseExpiresAt: '2026-10-03T11:08:12.783Z',
    launchExpiresAt: '2026-10-03T11:07:00.000Z',
    settlementHash: 'f4f3c0598858db1e2333b2bf0dbb6e22f281e5927ad2ff5507ea9999a4c86cb3',
    settled: 'interrupted 11:06:37, autosettled 11:12:18',
  },
  {
    id: 'containment|GY-1099|2026-10-03T11:09:53.672Z',
    subject: 'GY-1099',
    observedAt: '2026-10-03T11:09:53.672Z',
    epoch: 14,
    owner: 'graphyard-opencode-3',
    leaseExpiresAt: '2026-10-03T11:08:12.836Z',
    launchExpiresAt: '2026-10-03T11:07:00.000Z',
    settlementHash: 'f72da0c7ba0d7dbe9812401ba2a94fb2193b2a3c74daaf013cf8e87498c4b7b2',
    settled: 'interrupted 11:06:37, autosettled 11:12:18',
  },
  {
    id: 'containment|GY-1147|2026-10-03T11:09:53.672Z',
    subject: 'GY-1147',
    observedAt: '2026-10-03T11:09:53.672Z',
    epoch: 1,
    owner: 'graphyard-opencode-4',
    leaseExpiresAt: '2026-10-03T11:09:04.288Z',
    launchExpiresAt: '2026-10-03T11:07:00.000Z',
    settlementHash: '23e20ec42c3886566dca0b1c099042b47ecda4a572a6b22bce37d45f3efefb61',
    settled: 'interrupted 11:07:11, autosettled 11:12:18',
  },
];

/** The item as it stood when the loop observed it: attempt finished/interrupted, lease cleared, quarantine in grace window. */
function standing(entry: Instance): Work {
  return {
    id: `work-${entry.subject}`,
    key: entry.subject,
    title: entry.subject,
    description: '',
    type: 'feature',
    priority: 2,
    dependencies: [],
    criteria: [{ id: 'AC-1', text: 'The behaviour changes as described', proofs: ['unit:behaviour-changes'] }],
    policy: { checks: ['test'], review: true },
    plannedFiles: ['src/'],
    stage: 'implementation',
    revision: 1,
    policyRevision: 1,
    createdAt: entry.observedAt,
    updatedAt: entry.observedAt,
    stageEnteredAt: entry.observedAt,
    ready: true,
    epoch: entry.epoch,
    lease: null,
    workspaces: [],
    candidate: null,
    submission: null,
    reworkRequested: false,
    scenarioRequirements: [],
    evidence: [],
    observation: null,
    blocker: null,
    gates: [],
    violations: [],
    containmentQuarantine: {
      at: entry.observedAt,
      epoch: entry.epoch,
      owner: entry.owner,
      leaseExpiresAt: entry.leaseExpiresAt,
      launchExpiresAt: entry.launchExpiresAt,
      settlementHash: entry.settlementHash,
      scope: { pid: 12345, unit: `graphyard-${entry.subject}.scope` },
    },
  } as unknown as Work;
}

function containmentFaults(work: Work, at: string) {
  return cycleFaults(emptyDaemonState(config()), [work], Date.parse(at), { config: config() })
    .filter(fault => fault.faultClass === 'containment');
}

for (const entry of instances) {
  test(`manual:fault-class-containment — ${entry.id} (${entry.settled}) is no fault while in grace window`, () => {
    const work = standing(entry);
    const clock = Date.parse(entry.observedAt);
    const phase = containmentPhase(work, clock);
    assert.equal(phase?.state, 'grace', `${entry.subject} must be in grace window at observed timestamp`);
    assert.deepEqual(workFaults(work, clock).filter(fault => fault.faultClass === 'containment'), [], 'workFaults observes no containment fault during grace');
    assert.deepEqual(containmentFaults(work, entry.observedAt).map(fault => fault.kind), [], `${entry.subject} has no containment fault while in grace`);
  });
}

test('manual:fault-class-containment — a genuinely lapsed quarantine past grace window is observed as a containment fault', () => {
  const entry = instances[0];
  const work = standing(entry);
  // 5 minutes after the grace window expires
  const pastGrace = Date.parse(entry.leaseExpiresAt) + 120_000 + 300_000;
  const phase = containmentPhase(work, pastGrace);
  assert.equal(phase?.state, 'lapsed', 'quarantine must be lapsed after grace window has passed');
  const own = workFaults(work, pastGrace).filter(fault => fault.faultClass === 'containment');
  assert.equal(own.length, 1);
  assert.equal(own[0].kind, 'containment');
  assert.match(own[0].text, /Containment quarantine from epoch 16 holds GY-1027/);
  const cycle = containmentFaults(work, new Date(pastGrace).toISOString());
  assert.equal(cycle.length, 1);
  assert.equal(cycle[0].kind, 'containment');
});
