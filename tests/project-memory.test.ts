import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { docsWords } from '../src/model/documentation.js';
import {
  emptyProjectMemory,
  projectMemoryDigest,
  projectMemoryWordBudget,
  recordDecisionInMemory,
  recordPitfallInMemory,
  recordChangeInMemory,
  recordSettledDecision,
  updateProjectMemoryFromWork,
  sanctionedRemedies,
  isDecisionRoleRelevant,
  isPitfallRoleRelevant,
  type ProjectMemory,
} from '../src/model/project-memory.js';
import {
  readProjectMemory,
  writeProjectMemory,
  syncProjectMemory,
} from '../src/project-memory.js';
import { workerPrompt } from '../src/master/dispatch.js';
import { reviewPrompt } from '../src/reviewer.js';
import { producerPrompt } from '../src/producer.js';
import { piProducerPrompt } from '../src/runner/roles.js';
import { buildMasterStatus } from '../src/master/status.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { Work } from '../src/model/work.js';
import { emptyDaemonState, writeDaemonState, type DaemonState } from '../src/daemon/state.js';
import { masterConfigSchema, type MasterConfig } from '../src/master/profiles.js';

function createSampleMemory(): ProjectMemory {
  const memory = emptyProjectMemory('2026-10-02T12:00:00Z');
  // Decisions
  recordDecisionInMemory(memory, {
    id: 'dec-1',
    key: 'GY-1001',
    action: 'scope',
    reason: 'Widen scope for auth helpers in src/auth.ts',
    state: 'applied',
    approvedBy: 'graphyard-approver',
    at: '2026-10-02T10:00:00Z',
  });
  recordDecisionInMemory(memory, {
    id: 'dec-2',
    key: 'GY-1002',
    action: 'review',
    reason: 'Approve single-party bypass for docs chore',
    state: 'approved',
    approvedBy: 'operator',
    at: '2026-10-02T11:00:00Z',
  });
  recordDecisionInMemory(memory, {
    id: 'dec-3',
    key: 'GY-1003',
    action: 'attest',
    reason: 'Attest mechanical proof criteria pass',
    state: 'applied',
    approvedBy: 'graphyard-approver',
    at: '2026-10-02T11:30:00Z',
  });

  // Pitfalls
  recordPitfallInMemory(memory, {
    faultClass: 'scope',
    count: 3,
    at: '2026-10-02T09:00:00Z',
  });
  recordPitfallInMemory(memory, {
    faultClass: 'review-convergence',
    count: 2,
    at: '2026-10-02T09:30:00Z',
  });
  recordPitfallInMemory(memory, {
    faultClass: 'proof',
    count: 4,
    at: '2026-10-02T08:00:00Z',
  });

  // Changes
  recordChangeInMemory(memory, {
    key: 'GY-1000',
    sha: '1111111111222222222233333333334444444444',
    baseSha: '0000000000111111111122222222223333333333',
    files: ['src/auth.ts', 'tests/auth.test.ts'],
    mergedAt: '2026-10-02T07:00:00Z',
  });
  recordChangeInMemory(memory, {
    key: 'GY-999',
    sha: '5555555555666666666677777777778888888888',
    baseSha: '0000000000111111111122222222223333333333',
    files: ['README.md', 'docs/overview.md'],
    mergedAt: '2026-10-02T06:00:00Z',
  });
  // The merge every sample session is based on: it and anything before it is not news.
  recordChangeInMemory(memory, {
    key: 'GY-998',
    sha: '0000000000111111111122222222223333333333',
    files: ['src/old.ts'],
    mergedAt: '2026-10-02T05:00:00Z',
  });

  return memory;
}

test('unit:session-request-carries-project-memory — worker request carries role-relevant project-memory digest within word budget', () => {
  const memory = createSampleMemory();
  const baseSha = '0000000000111111111122222222223333333333';
  const digest = projectMemoryDigest(memory, 'worker', { baseSha });

  assert.ok(digest.includes('Shared project memory:'));
  assert.ok(digest.includes('GY-1001 (scope): Widen scope for auth helpers in src/auth.ts [approved by graphyard-approver]'));
  assert.ok(digest.includes('scope (3 recurrences): ' + sanctionedRemedies['scope']));
  assert.ok(digest.includes('GY-1000 (1111111111): src/auth.ts, tests/auth.test.ts'));
  assert.ok(docsWords(digest) <= projectMemoryWordBudget);

  const request = workerPrompt(
    { cliPath: '/bin/graphyard.mjs' },
    { key: 'GY-1125', title: 'Project memory' },
    { principal: 'graphyard-claude-2' },
    1,
    null,
    memory,
    baseSha
  );

  assert.ok(request.includes('Implement GY-1125: Project memory.'));
  assert.ok(request.includes('Shared project memory:'));
  assert.ok(request.includes('Recent decisions:'));
  assert.ok(request.includes('Recurring pitfalls and remedies:'));
  assert.ok(request.includes('Recent merges to main since base 0000000000: - GY-1000 (1111111111): src/auth.ts, tests/auth.test.ts - GY-999 (5555555555): README.md, docs/overview.md'));
  assert.ok(!request.includes('GY-998'), 'the base merge itself is not news to the session');
});

test('unit:session-request-carries-project-memory — merges since base exclude the base and every merge it already contains', () => {
  const memory = createSampleMemory();
  const digest = projectMemoryDigest(memory, 'worker', { baseSha: '5555555555666666666677777777778888888888' });
  assert.ok(digest.includes('Recent merges to main since base 5555555555: - GY-1000 (1111111111): src/auth.ts, tests/auth.test.ts'));
  assert.ok(!digest.includes('GY-999 (') && !digest.includes('GY-998'));
  // At the newest merge, nothing changed on main since the session's base.
  assert.ok(!projectMemoryDigest(memory, 'worker', { baseSha: '1111111111222222222233333333334444444444' }).includes('Recent merges'));
  // A base memory does not hold keeps the whole recent window, labelled as such.
  assert.ok(projectMemoryDigest(memory, 'worker', { baseSha: 'f'.repeat(40) }).includes('Recent merges to main in last 24h: - GY-1000'));
});

test('unit:session-request-carries-project-memory — the digest renders each section in its exact form', () => {
  const memory = emptyProjectMemory('2026-10-02T12:00:00Z');
  recordDecisionInMemory(memory, { id: 'd', key: 'GY-1', action: 'scope', reason: 'Widen to src/a.ts', state: 'applied', approvedBy: 'approver-1', at: '2026-10-02T10:00:00Z' });
  recordPitfallInMemory(memory, { faultClass: 'merge', count: 1, at: '2026-10-02T09:00:00Z' });
  recordChangeInMemory(memory, { key: 'GY-2', sha: 'a'.repeat(40), files: ['src/a.ts'], mergedAt: '2026-10-02T08:00:00Z' });
  assert.equal(projectMemoryDigest(memory, 'worker'),
    `Shared project memory: Recent decisions: - GY-1 (scope): Widen to src/a.ts [approved by approver-1] Recurring pitfalls and remedies: - merge (1 recurrence): ${sanctionedRemedies.merge} Recent merges to main in last 24h: - GY-2 (aaaaaaaaaa): src/a.ts `);
  assert.equal(projectMemoryDigest(emptyProjectMemory(), 'worker'), '');
  assert.equal(projectMemoryDigest(null, 'reviewer'), '');
});

test('unit:session-request-carries-project-memory — reviewer request carries role-relevant project-memory digest within word budget', () => {
  const memory = createSampleMemory();
  const baseSha = '0000000000111111111122222222223333333333';
  const digest = projectMemoryDigest(memory, 'reviewer', { baseSha });

  assert.ok(digest.includes('Shared project memory:'));
  assert.ok(digest.includes('GY-1002 (review): Approve single-party bypass for docs chore [approved by operator]'));
  assert.ok(digest.includes('review-convergence (2 recurrences): ' + sanctionedRemedies['review-convergence']));
  assert.ok(docsWords(digest) <= projectMemoryWordBudget);

  const request = reviewPrompt(
    { repository: 'owner/project' },
    { key: 'GY-1125', pr: 1125, sha: 'abcdef1234567890abcdef1234567890abcdef12', baseSha, policyRevision: 1 },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    null,
    memory
  );

  assert.ok(request.includes('Review pull request #1125'));
  assert.ok(request.includes('Shared project memory:'));
  assert.ok(request.includes('GY-1002 (review)'));
});

test('unit:session-request-carries-project-memory — producer request carries role-relevant project-memory digest within word budget', () => {
  const memory = createSampleMemory();
  const baseSha = '0000000000111111111122222222223333333333';
  const digest = projectMemoryDigest(memory, 'producer', { baseSha });

  assert.ok(digest.includes('Shared project memory:'));
  assert.ok(digest.includes('GY-1003 (attest): Attest mechanical proof criteria pass [approved by graphyard-approver]'));
  assert.ok(digest.includes('proof (4 recurrences): ' + sanctionedRemedies['proof']));
  assert.ok(docsWords(digest) <= projectMemoryWordBudget);

  const request = producerPrompt(
    { repository: 'owner/project', cliPath: '/bin/graphyard.mjs' },
    { key: 'GY-1125', pr: 1125, sha: 'abcdef1234567890abcdef1234567890abcdef12', baseSha, policyRevision: 1, group: 'unit', proofs: ['unit:session-request-carries-project-memory'] },
    { principal: 'graphyard-producer' },
    undefined,
    memory
  );

  assert.ok(request.includes('Produce trusted evidence for work item GY-1125'));
  assert.ok(request.includes('Shared project memory:'));
  assert.ok(request.includes('GY-1003 (attest)'));
  assert.ok(request.includes('proof (4 recurrences)'));
});

test('unit:session-request-carries-project-memory — piProducerPrompt carries role-relevant project-memory digest', () => {
  const memory = createSampleMemory();
  const baseSha = '0000000000111111111122222222223333333333';
  const request = piProducerPrompt(
    { repository: 'owner/project' },
    { key: 'GY-1125', pr: 1125, sha: 'abcdef1234567890abcdef1234567890abcdef12', baseSha, policyRevision: 1, group: 'unit', proofs: ['unit:session-request-carries-project-memory'] },
    [{ id: 'AC-1', text: 'Digest carried', proofs: ['unit:session-request-carries-project-memory'] }],
    { directory: '/srv/proof', worktree: '/srv/proof/checkout' },
    '/srv/repo',
    memory
  );

  assert.ok(request.includes('Produce evidence for work item GY-1125'));
  assert.ok(request.includes('Shared project memory:'));
  assert.ok(request.includes('proof (4 recurrences)'));
});

test('unit:session-request-carries-project-memory — fixed word budget truncates overflow and prioritizes role-relevant entries', () => {
  const memory = emptyProjectMemory();
  for (let i = 0; i < 50; i++) {
    recordDecisionInMemory(memory, {
      id: `dec-${i}`,
      key: `GY-${2000 + i}`,
      action: i % 2 === 0 ? 'scope' : 'other',
      reason: `Detailed explanation for decision ${i} explaining the full architecture context and requirements rationale for this specific change`,
      state: 'applied',
      approvedBy: 'approver',
      at: new Date(Date.now() - i * 60_000).toISOString(),
    });
  }

  const digest = projectMemoryDigest(memory, 'worker', { wordBudget: 100 });
  assert.ok(docsWords(digest) <= 100, `Expected word count <= 100 but got ${docsWords(digest)}`);
  assert.ok(digest.startsWith('Shared project memory:'));
});

test('unit:session-request-carries-project-memory — memory updates from settled decisions, recurring fault classes, and merges only', async () => {
  const memory = emptyProjectMemory();

  // 1. Settled operator answers
  const work: Work[] = [
    {
      id: 'w-1',
      key: 'GY-500',
      title: 'Human decision item',
      stage: 'done',
      // An answered request is cleared from humanRequest and kept in humanRequests.
      humanRequest: null,
      humanRequests: [{
        id: 'hr-1',
        kind: 'credentials-for-people',
        needed: 'Deploy token for production',
        reason: 'Operator token needed',
        at: '2026-10-02T08:00:00Z',
        answer: {
          outcome: 'provided',
          text: 'Token created and stored in vault',
          by: 'operator-1',
          at: '2026-10-02T08:30:00Z',
        },
      }, {
        id: 'hr-0',
        kind: 'money-or-accounts',
        needed: 'A paid runner plan',
        reason: 'Faster CI',
        at: '2026-10-02T07:00:00Z',
        answer: { outcome: 'declined', text: 'Decline: not this quarter', by: 'operator-1', at: '2026-10-02T07:10:00Z' },
      }],
      delivery: {
        epoch: 1,
        pr: 500,
        mergeSha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
        mergedAt: new Date(Date.now() - 3600_000).toISOString(),
        at: '2026-10-02T09:00:00Z',
        sha: '1234567890123456789012345678901234567890',
        baseSha: '0987654321098765432109876543210987654321',
      },
      plannedFiles: ['src/deploy.ts'],
    } as any,
  ];

  updateProjectMemoryFromWork(memory, work, Date.now());

  assert.equal(memory.decisions.length, 1);
  assert.equal(memory.decisions[0].key, 'GY-500');
  assert.equal(memory.decisions[0].action, 'credentials-for-people');
  assert.ok(memory.decisions[0].reason.includes('Deploy token for production: Token created and stored in vault'));
  assert.equal(memory.decisions[0].approvedBy, 'operator-1');
  assert.ok(!memory.decisions.some(d => d.id === 'hr-0'), 'a declined answer decided nothing');

  assert.equal(memory.changes.length, 1);
  assert.equal(memory.changes[0].key, 'GY-500');
  assert.deepEqual(memory.changes[0].files, ['src/deploy.ts']);

  // 2. Two-party decisions enter as the loop settles them: applied ones with the approver's reason, never a refusal.
  const watch = { work: 'GY-600', action: 'scope', decision: 'dec-approved-1' };
  assert.equal(recordSettledDecision(memory, watch, { state: 'applied', approvedBy: 'graphyard-approver', approvedAt: '2026-10-02T09:15:00Z', approvalReason: 'The criterion names src/auth.ts', reason: 'Widen to src/auth.ts' }, '2026-10-02T09:20:00Z'), true);
  assert.deepEqual(memory.decisions.find(d => d.key === 'GY-600'), { id: 'dec-approved-1', key: 'GY-600', action: 'scope', reason: 'The criterion names src/auth.ts', approvedBy: 'graphyard-approver', at: '2026-10-02T09:15:00Z' });
  const refusedWatch = { work: 'GY-601', action: 'requirements', decision: 'dec-refused-1' };
  assert.equal(recordSettledDecision(memory, refusedWatch, { state: 'refused', approvedBy: null, refusal: { approver: 'graphyard-approver', reason: 'Out of scope' } } as any, '2026-10-02T09:20:00Z'), false);
  assert.equal(recordSettledDecision(memory, refusedWatch, { state: 'withdrawn', approvedBy: null }, '2026-10-02T09:20:00Z'), false);
  assert.equal(recordSettledDecision(memory, refusedWatch, null, '2026-10-02T09:20:00Z'), false);
  assert.ok(!memory.decisions.some(d => d.key === 'GY-601'), 'a refused decision is never remembered as approved');

  // 3. Recurring fault classes; a settled approval watch alone (which a refusal also sets) adds no decision.
  const daemonState: DaemonState = {
    version: 1,
    url: 'http://localhost:3000',
    repository: 'owner/project',
    approvals: {
      'dec-watch-2': { decision: 'dec-refused-2', work: 'GY-602', action: 'requirements', requestedAt: '2026-10-02T09:00:00Z', settledAt: '2026-10-02T09:15:00Z', agentName: 'graphyard-approver' } as any,
    },
    faults: {
      instances: [
        { id: 'f-1', faultClass: 'scope', kind: 'action:scope', subject: 'GY-600', text: 'Scope error', at: '2026-10-02T09:00:00Z' },
        { id: 'f-2', faultClass: 'scope', kind: 'action:scope', subject: 'GY-601', text: 'Scope error 2', at: '2026-10-02T09:10:00Z' },
      ],
      open: {},
      failing: {},
    },
  } as any;

  await syncProjectMemory({
    existing: memory,
    work,
    state: daemonState,
    now: Date.parse('2026-10-02T10:00:00Z'),
    policy: { threshold: 2, windowHours: 24 },
  });

  assert.ok(!memory.decisions.some(d => d.key === 'GY-602'));
  assert.equal(memory.pitfalls.some(p => p.faultClass === 'scope' && p.count >= 2), true);
  assert.ok(memory.pitfalls.find(p => p.faultClass === 'scope')?.remedy.includes('Request scope widening'));
});

test('unit:session-request-carries-project-memory — unreviewed agent claims and unapproved decisions are rejected', () => {
  const memory = emptyProjectMemory();

  // Agent requests decision (state = requested or started, not applied/approved)
  const rejected1 = recordDecisionInMemory(memory, {
    id: 'agent-claim-1',
    key: 'GY-700',
    action: 'scope',
    reason: 'I claim that src/secret.ts is in scope',
    state: 'requested',
    at: '2026-10-02T10:00:00Z',
  });
  assert.equal(rejected1, false, 'Unapproved agent request must not be recorded');
  assert.equal(memory.decisions.length, 0);

  // Decision without approver
  const rejected2 = recordDecisionInMemory(memory, {
    id: 'agent-claim-2',
    key: 'GY-700',
    action: 'scope',
    reason: 'Self-approved scope claim',
    state: 'applied',
    approvedBy: undefined,
    at: '2026-10-02T10:00:00Z',
  });
  assert.equal(rejected2, false, 'Self-claim without approvedBy must not be recorded');
  assert.equal(memory.decisions.length, 0);

  // Unsettled human request (no answer provided)
  const unfinishedWork: Work[] = [
    {
      id: 'w-2',
      key: 'GY-701',
      title: 'Unanswered item',
      stage: 'implementation',
      humanRequest: {
        id: 'hr-2',
        kind: 'money-or-accounts',
        needed: 'Cloud budget increase',
        reason: 'Quota reached',
        at: '2026-10-02T10:00:00Z',
      },
    } as any,
  ];
  updateProjectMemoryFromWork(memory, unfinishedWork, Date.now());
  assert.equal(memory.decisions.length, 0, 'Unanswered human requests must not be recorded');
  assert.equal(memory.changes.length, 0, 'Unmerged items must not be recorded');
});

test('unit:session-request-carries-project-memory — master status shows project memory', async () => {
  const memory = createSampleMemory();
  const dir = await temporaryDirectory('master-status');
  try {
    await writeProjectMemory(dir, memory);

    // 1. buildMasterStatus directly
    const status = buildMasterStatus(
      { work: [], now: new Date().toISOString() },
      [],
      [],
      {},
      {},
      { pending: [], completed: [] },
      'main',
      undefined,
      undefined,
      undefined,
      undefined,
      'graphyard',
      { projectMemory: memory }
    );

    assert.ok(status.projectMemory, 'buildMasterStatus must include projectMemory');
    assert.equal(status.projectMemory.decisions.length, 3);
    assert.equal(status.projectMemory.pitfalls.length, 3);
    assert.equal(status.projectMemory.changes.length, 3);

    // 2. masterStatusReport
    const credentials = await temporaryDirectory('master-status-credentials');
    const tokenFile = join(credentials, 'master.token');
    await writeFile(tokenFile, 'dummy-token');
    const config = masterConfigSchema.parse({
      version: 1,
      repository: 'owner/project',
      baseBranch: 'main',
      url: 'http://localhost:3000',
      credentialFile: tokenFile,
      cliPath: '/bin/graphyard.mjs',
      hostId: 'test-host',
      githubAppId: 12345,
      masterAgentName: 'master-agent',
      workers: [],
      reviewers: [],
      producers: [],
    });

    // master status shows the memory the loop's cursor holds.
    // The cursor is read only from outside the repository's worktrees, so the root is a repository.
    execFileSync('git', ['init', '-q', dir]);
    const loop = emptyDaemonState(config);
    loop.projectMemory = memory;
    await writeDaemonState(config, loop);

    const mockApi = async (path: string) => {
      if (path === 'work-snapshot') return { work: [], now: new Date().toISOString() };
      return {};
    };

    const report = await masterStatusReport(
      dir,
      config,
      mockApi,
      { actor: { id: 'coordinator-1' } },
      { commit: null },
      { reportReadBoundMs: 1000 }
    );

    assert.ok(report.projectMemory, `masterStatusReport must include projectMemory: ${JSON.stringify(report.daemon).slice(0, 400)}`);
    assert.equal(report.projectMemory.decisions.length, 3);
    assert.equal(report.projectMemory.pitfalls.length, 3);
    assert.equal(report.projectMemory.changes.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('unit:session-request-carries-project-memory — file persistence round-trips to .graphyard/project-memory.json', async () => {
  const dir = await temporaryDirectory('persistence');
  try {
    const memory = createSampleMemory();
    await writeProjectMemory(dir, memory);

    const loaded = await readProjectMemory(dir);
    assert.equal(loaded.version, 1);
    assert.equal(loaded.decisions.length, memory.decisions.length);
    assert.equal(loaded.pitfalls.length, memory.pitfalls.length);
    assert.equal(loaded.changes.length, memory.changes.length);

    assert.deepEqual(loaded.decisions[0], memory.decisions[0]);
    assert.deepEqual(loaded.pitfalls[0], memory.pitfalls[0]);
    assert.deepEqual(loaded.changes[0], memory.changes[0]);

    // ENOENT falls back to emptyProjectMemory
    const emptyDir = await temporaryDirectory('persistence-empty');
    try {
      const empty = await readProjectMemory(emptyDir);
      assert.equal(empty.version, 1);
      assert.deepEqual(empty.decisions, []);
      assert.deepEqual(empty.pitfalls, []);
      assert.deepEqual(empty.changes, []);
    } finally {
      await rm(emptyDir, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
