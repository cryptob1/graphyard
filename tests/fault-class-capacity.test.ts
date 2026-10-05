import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Work } from '../src/model.js';
import {
  automaticProducerConcurrency,
  buildMasterStatus,
  concurrencyAttention,
  concurrencyStarvedMs,
  masterRunSchema,
  producerProfileSchema,
  profileConcurrency,
  roleConcurrency,
  withProducerDefaults,
  withRoleDefaults,
  type ProducerProfile,
} from '../src/master.js';
import {
  classified,
  faultClassOf,
  trackFaults,
  type FaultRecord,
} from '../src/model/fault-classes.js';

// GY-1113 names this file for its proof: manual:fault-class-capacity. The master loop filed 3 capacity
// faults in 24 hours on 2 October 2026. Every one was concurrency-starved attention on producer concurrency:
// 6 producer profiles were configured without an explicit concurrency setting, so each profile defaulted to 1
// session (total limit 6). When sustained proof demand arrived (17, 15, and 12 queued requests), requests
// waited over 10 minutes (up to 62 minutes) for a slot, tripping the concurrency-starved attention threshold
// (concurrencyStarvedMs = 10 * 60_000) and recording capacity faults.
//
// The shared cause:
//   - producer profiles with unset concurrency defaulted to 1 session, unlike reviewer profiles which already
//     had automaticReviewerConcurrency = 4. With 6 producer profiles, limit was 6 instead of 24.
//   - withProducerDefaults / withRoleDefaults now defaults producer profiles with unset concurrency to
//     automaticProducerConcurrency (4 sessions), matching the reviewer role and raising total producer
//     concurrency to 24.
//
// Each instance listed on GY-1113 is replayed below as it stood when the loop recorded it. Against the base
// (default concurrency 1) each reproduces: roleConcurrency reports starved: true, concurrencyAttention emits
// the exact saturated attention line, and trackFaults records a capacity fault.
// Against the candidate (automaticProducerConcurrency = 4) each is shown not to recur: limit is 24, running (6)
// is well below limit, starved is false, no attention is emitted, and 0 capacity faults are recorded.
// Genuinely starved producer capacity (e.g. 24 sessions running against limit of 24 with waiting requests > 10m)
// is shown to still raise concurrency-starved attention and track a capacity fault.

interface Instance {
  id: string;
  at: string;
  role: 'producer';
  subject: string;
  kind: 'concurrency-starved';
  running: number;
  limit: number;
  profiles: string[];
  waitingCount: number;
  longestWork: string;
  longestGroup: string;
  longestWaitMs: number;
  text: string;
}

const instances: Instance[] = [
  {
    id: 'concurrency-starved|producer concurrency|2026-10-02T13:04:29.413Z',
    at: '2026-10-02T13:04:29.413Z',
    role: 'producer',
    subject: 'producer concurrency',
    kind: 'concurrency-starved',
    running: 6,
    limit: 6,
    profiles: [
      'claude-producer',
      'claude-producer-2',
      'claude-producer-3',
      'claude-producer-4',
      'claude-producer-5',
      'claude-producer-6',
    ],
    waitingCount: 17,
    longestWork: 'GY-1052',
    longestGroup: 'manual',
    longestWaitMs: 62 * 60_000,
    text: 'producer capacity is saturated: 6 sessions running against a limit of 6 (claude-producer 1/1, claude-producer-2 1/1, claude-producer-3 1/1, claude-producer-4 1/1, claude-producer-5 1/1, claude-producer-6 1/1), 17 requests waiting for a slot, the longest (GY-1052 manual proofs) for 62 minutes',
  },
  {
    id: 'concurrency-starved|producer concurrency|2026-10-02T13:42:02.373Z',
    at: '2026-10-02T13:42:02.373Z',
    role: 'producer',
    subject: 'producer concurrency',
    kind: 'concurrency-starved',
    running: 6,
    limit: 6,
    profiles: [
      'claude-producer',
      'claude-producer-2',
      'claude-producer-3',
      'claude-producer-4',
      'claude-producer-5',
      'claude-producer-6',
    ],
    waitingCount: 15,
    longestWork: 'GY-566',
    longestGroup: 'unit',
    longestWaitMs: 55 * 60_000,
    text: 'producer capacity is saturated: 6 sessions running against a limit of 6 (claude-producer 1/1, claude-producer-2 1/1, claude-producer-3 1/1, claude-producer-4 1/1, claude-producer-5 1/1, claude-producer-6 1/1), 15 requests waiting for a slot, the longest (GY-566 unit proofs) for 55 minutes',
  },
  {
    id: 'concurrency-starved|producer concurrency|2026-10-02T14:20:01.429Z',
    at: '2026-10-02T14:20:01.429Z',
    role: 'producer',
    subject: 'producer concurrency',
    kind: 'concurrency-starved',
    running: 6,
    limit: 6,
    profiles: [
      'claude-producer',
      'claude-producer-2',
      'claude-producer-3',
      'claude-producer-4',
      'claude-producer-5',
      'claude-producer-6',
    ],
    waitingCount: 12,
    longestWork: 'GY-1039',
    longestGroup: 'manual',
    longestWaitMs: 62 * 60_000,
    text: 'producer capacity is saturated: 6 sessions running against a limit of 6 (claude-producer 1/1, claude-producer-2 1/1, claude-producer-3 1/1, claude-producer-4 1/1, claude-producer-5 1/1, claude-producer-6 1/1), 12 requests waiting for a slot, the longest (GY-1039 manual proofs) for 62 minutes',
  },
];

function makeWaitingWork(key: string, requestedAt: string, group: string): Work {
  const reqId = createHash('sha256').update(`req-${key}-${group}`).digest('hex').slice(0, 32);
  return {
    id: `work-${key}`,
    key,
    title: key,
    description: '',
    type: 'feature',
    priority: 1,
    dependencies: [],
    criteria: [],
    policy: { checks: [], review: true },
    plannedFiles: ['src/'],
    stage: 'review',
    stageEnteredAt: requestedAt,
    createdAt: requestedAt,
    updatedAt: requestedAt,
    ready: true,
    epoch: 1,
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
    revision: 1,
    policyRevision: 1,
    implementers: [],
    autoDispatch: {
      review: null,
      producers: [
        {
          id: reqId,
          kind: 'producer',
          group,
          proofs: [`${group}:proof`],
          sha: 'a'.repeat(40),
          baseSha: 'b'.repeat(40),
          policyRevision: 1,
          requestedAt,
          state: 'requested',
        },
      ],
      history: [],
    },
  } as unknown as Work;
}

function makeRunningWork(key: string, startedAt: string, group: string, reqId: string): Work {
  return {
    id: `work-${key}`,
    key,
    title: key,
    description: '',
    type: 'feature',
    priority: 1,
    dependencies: [],
    criteria: [],
    policy: { checks: [], review: true },
    plannedFiles: ['src/'],
    stage: 'review',
    stageEnteredAt: startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
    ready: true,
    epoch: 1,
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
    revision: 1,
    policyRevision: 1,
    implementers: [],
    autoDispatch: {
      review: null,
      producers: [
        {
          id: reqId,
          kind: 'producer',
          group,
          proofs: [`${group}:proof`],
          sha: 'a'.repeat(40),
          baseSha: 'b'.repeat(40),
          policyRevision: 1,
          requestedAt: startedAt,
          state: 'running',
        },
      ],
      history: [],
    },
  } as unknown as Work;
}

test('manual:fault-class-capacity — the item lists 3 instances, and every one is replayed below', () => {
  assert.equal(instances.length, 3);
  assert.equal(new Set(instances.map(instance => instance.id)).size, 3);
  assert.ok(instances.every(instance => instance.kind === 'concurrency-starved'));
  assert.ok(instances.every(instance => instance.subject === 'producer concurrency'));
  assert.ok(instances.every(instance => faultClassOf(instance.kind) === 'capacity'));
});

for (const instance of instances) {
  test(`manual:fault-class-capacity — ${instance.id}: reproduces on base (limit 6) and clears on candidate (limit 24)`, () => {
    const now = Date.parse(instance.at);

    // The 6 producer profiles configured in .graphyard/master.json with concurrency unset
    const rawProfiles: ProducerProfile[] = instance.profiles.map(name =>
      producerProfileSchema.parse({
        name,
        principal: 'proof-runner',
        agentName: name,
        kind: 'claude',
        credentialFile: `/outside/${name}.token`,
      }),
    );

    // In production, 6 producer sessions were running: 1 on each profile
    const runningAgents = instance.profiles.map(name => ({ name, agent_status: 'working' as const }));
    const runningLedger = instance.profiles.map((name, index) => ({
      producer: `p-${index + 1}`,
      requestId: createHash('sha256').update(`running-${index}`).digest('hex').slice(0, 32),
      work: `GY-${100 + index}`,
      agentName: name,
      state: 'pending',
    }));
    const runningWorks = instance.profiles.map((name, index) =>
      makeRunningWork(`GY-${100 + index}`, instance.at, 'unit', runningLedger[index].requestId),
    );

    // Waiting requests: the longest waiting request plus the remaining waitingCount - 1 requests
    const waitingWorks: Work[] = [];
    // 1. Longest waiting request
    const longestRequestedAt = new Date(now - instance.longestWaitMs).toISOString();
    waitingWorks.push(makeWaitingWork(instance.longestWork, longestRequestedAt, instance.longestGroup));
    // 2. Remaining requests waiting for shorter durations (< longestWaitMs)
    for (let index = 1; index < instance.waitingCount; index++) {
      const waitMs = instance.longestWaitMs - index * 60_000;
      const requestedAt = new Date(now - waitMs).toISOString();
      waitingWorks.push(makeWaitingWork(`GY-${800 + index}`, requestedAt, index % 2 === 0 ? 'unit' : 'manual'));
    }

    const allWork = [...runningWorks, ...waitingWorks];
    const sessions = {
      producers: { pending: runningLedger, completed: [] },
      failures: [],
      retries: [],
    };

    // -------------------------------------------------------------------------
    // 1. BASE REPRODUCTION:
    // With raw profiles (concurrency unset, defaulting to 1 per profile):
    // Limit is 6, running is 6, 17/15/12 requests wait over 10m, starved: true.
    // -------------------------------------------------------------------------
    const baseReport = roleConcurrency(
      'producer',
      rawProfiles,
      allWork,
      runningAgents,
      sessions.producers,
      sessions,
      now,
    );

    assert.equal(baseReport.limit, 6, 'base total limit is 6');
    assert.equal(baseReport.running, 6, 'base running sessions is 6');
    assert.equal(baseReport.waiting, instance.waitingCount, `base has ${instance.waitingCount} waiting requests`);
    assert.equal(baseReport.longestWaitMs, instance.longestWaitMs);
    assert.equal(baseReport.starved, true, 'base producer role is starved');

    const baseAttention = concurrencyAttention([baseReport]);
    assert.equal(baseAttention.length, 1);
    assert.equal(baseAttention[0].subject, 'producer concurrency');
    assert.equal(baseAttention[0].text, instance.text, 'base attention text matches production incident exactly');

    // Master status marks this attention item with classified('concurrency-starved')
    const baseItems = baseAttention.map(item => ({ ...item, ...classified('concurrency-starved') }));
    assert.equal(baseItems[0].faultClass, 'capacity');

    // trackFaults opens a capacity fault instance
    const baseRecord: FaultRecord = { instances: [], open: {}, failing: {} };
    const openedBaseFaults = trackFaults(baseRecord, baseItems, instance.at);
    assert.equal(openedBaseFaults.length, 1, 'base opens 1 capacity fault instance');
    assert.equal(openedBaseFaults[0].faultClass, 'capacity');
    assert.equal(openedBaseFaults[0].kind, 'concurrency-starved');

    // -------------------------------------------------------------------------
    // 2. CANDIDATE CLEARANCE:
    // With withRoleDefaults / withProducerDefaults applied:
    // Each profile defaults to automaticProducerConcurrency (4), limit is 24.
    // 6 running sessions < 24 limit, starved: false, no attention, 0 faults.
    // -------------------------------------------------------------------------
    const candidateProfiles = withProducerDefaults({ producers: rawProfiles }).producers;
    assert.deepEqual(
      candidateProfiles.map(p => profileConcurrency(p)),
      [4, 4, 4, 4, 4, 4],
      'candidate defaults unset concurrency to 4',
    );

    const candidateReport = roleConcurrency(
      'producer',
      candidateProfiles,
      allWork,
      runningAgents,
      sessions.producers,
      sessions,
      now,
    );

    assert.equal(candidateReport.limit, 24, 'candidate total limit is 24');
    assert.equal(candidateReport.running, 6, 'candidate running sessions is 6');
    assert.equal(candidateReport.waiting, instance.waitingCount);
    assert.equal(candidateReport.starved, false, 'candidate is not starved because running (6) < limit (24)');

    const candidateAttention = concurrencyAttention([candidateReport]);
    assert.deepEqual(candidateAttention, [], 'candidate emits no concurrency-starved attention');

    const candidateRecord: FaultRecord = { instances: [], open: {}, failing: {} };
    const openedCandidateFaults = trackFaults(candidateRecord, candidateAttention, instance.at);
    assert.equal(openedCandidateFaults.length, 0, 'candidate records 0 capacity faults');

    // -------------------------------------------------------------------------
    // 3. MASTER STATUS LEVEL VERIFICATION:
    // Verify buildMasterStatus behaves consistently on base and candidate.
    // -------------------------------------------------------------------------
    const baseStatus = buildMasterStatus(
      { work: allWork, now: instance.at },
      [],
      runningAgents,
      {},
      {},
      { pending: [], completed: [] },
      'main',
      undefined,
      sessions,
      undefined,
      { reviewers: [], producers: rawProfiles },
    );
    assert.equal(baseStatus.counts.concurrencyStarved, 1, 'base master status counts 1 concurrency-starved');
    assert.ok(
      baseStatus.attentionItems.some(item => item.subject === 'producer concurrency' && item.text === instance.text),
    );

    const candidateStatus = buildMasterStatus(
      { work: allWork, now: instance.at },
      [],
      runningAgents,
      {},
      {},
      { pending: [], completed: [] },
      'main',
      undefined,
      sessions,
      undefined,
      withRoleDefaults({ reviewers: [], producers: rawProfiles, run: masterRunSchema.parse({}) }),
    );
    assert.equal(candidateStatus.counts.concurrencyStarved, 0, 'candidate master status counts 0 concurrency-starved');
    assert.equal(
      candidateStatus.attentionItems.filter(item => item.subject === 'producer concurrency').length,
      0,
      'candidate master status has no producer concurrency attention',
    );
  });
}

test('manual:fault-class-capacity — genuine starvation at candidate limit of 24 still raises attention and tracks capacity fault', () => {
  const at = '2026-10-02T15:00:00.000Z';
  const now = Date.parse(at);

  const rawProfiles: ProducerProfile[] = [
    'claude-producer',
    'claude-producer-2',
    'claude-producer-3',
    'claude-producer-4',
    'claude-producer-5',
    'claude-producer-6',
  ].map(name =>
    producerProfileSchema.parse({
      name,
      principal: 'proof-runner',
      agentName: name,
      kind: 'claude',
      credentialFile: `/outside/${name}.token`,
    }),
  );

  const candidateProfiles = withProducerDefaults({ producers: rawProfiles }).producers;
  assert.equal(candidateProfiles.reduce((sum, p) => sum + profileConcurrency(p), 0), 24);

  // 24 running sessions across the 6 profiles (4 per profile)
  const runningAgents: { name: string; agent_status: 'working' }[] = [];
  const runningLedger: { producer: string; requestId: string; work: string; agentName: string; state: string }[] = [];
  const runningWorks: Work[] = [];

  let sessionCount = 0;
  for (const profile of candidateProfiles) {
    for (let slot = 0; slot < 4; slot++) {
      sessionCount++;
      const reqId = createHash('sha256').update(`gen-running-${sessionCount}`).digest('hex').slice(0, 32);
      const sessionName = slot === 0 ? profile.agentName : `${profile.agentName}-${reqId.slice(0, 8)}`;
      runningAgents.push({ name: sessionName, agent_status: 'working' });
      runningLedger.push({
        producer: `p-${sessionCount}`,
        requestId: reqId,
        work: `GY-${200 + sessionCount}`,
        agentName: sessionName,
        state: 'pending',
      });
      runningWorks.push(makeRunningWork(`GY-${200 + sessionCount}`, at, 'unit', reqId));
    }
  }

  // 3 requests waiting, longest waiting for 15 minutes (> 10m threshold)
  const waitingWorks = [
    makeWaitingWork('GY-901', new Date(now - 15 * 60_000).toISOString(), 'manual'),
    makeWaitingWork('GY-902', new Date(now - 12 * 60_000).toISOString(), 'unit'),
    makeWaitingWork('GY-903', new Date(now - 11 * 60_000).toISOString(), 'integration'),
  ];

  const allWork = [...runningWorks, ...waitingWorks];
  const sessions = {
    producers: { pending: runningLedger, completed: [] },
    failures: [],
    retries: [],
  };

  const report = roleConcurrency(
    'producer',
    candidateProfiles,
    allWork,
    runningAgents,
    sessions.producers,
    sessions,
    now,
  );

  assert.equal(report.limit, 24, 'limit is 24');
  assert.equal(report.running, 24, 'all 24 slots are occupied');
  assert.equal(report.waiting, 3, '3 requests waiting');
  assert.equal(report.longestWaitMs, 15 * 60_000);
  assert.equal(report.starved, true, 'role is starved at true capacity');

  const attention = concurrencyAttention([report]);
  assert.equal(attention.length, 1);
  assert.equal(attention[0].subject, 'producer concurrency');
  assert.match(attention[0].text, /producer capacity is saturated: 24 sessions running against a limit of 24/);
  assert.match(attention[0].text, /3 requests waiting for a slot, the longest \(GY-901 manual proofs\) for 15 minutes/);

  const items = attention.map(item => ({ ...item, ...classified('concurrency-starved') }));
  const record: FaultRecord = { instances: [], open: {}, failing: {} };
  const opened = trackFaults(record, items, at);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].faultClass, 'capacity');
  assert.equal(opened[0].kind, 'concurrency-starved');
});
