import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { docsWords } from '../src/model/documentation.js';
import {
  emptyProjectMemory,
  projectMemoryDigest,
  projectMemoryWordBudget,
  recordNoteInMemory,
  recordChangeInMemory,
  updateProjectMemoryFromWork,
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
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { Work } from '../src/model/work.js';
// Time-bomb allowance (GY-1694): the 2026-10-02 instants are memory/answer timestamps that updateProjectMemoryFromWork only sorts; its 24 h merge window runs on Date.now() against mergedAt values also derived from Date.now().

function createSampleMemory(): ProjectMemory {
  const memory = emptyProjectMemory('2026-10-02T12:00:00Z');
  // Decisions
  recordNoteInMemory(memory, {
    id: 'dec-1',
    key: 'GY-1001',
    kind: 'scope',
    text: 'Widen scope for auth helpers in src/auth.ts',
    by: 'graphyard-approver',
    at: '2026-10-02T10:00:00Z',
  });
  recordNoteInMemory(memory, {
    id: 'dec-2',
    key: 'GY-1002',
    kind: 'review',
    text: 'Approve single-party bypass for docs chore',
    by: 'operator',
    at: '2026-10-02T11:00:00Z',
  });
  recordNoteInMemory(memory, {
    id: 'dec-3',
    key: 'GY-1003',
    kind: 'attest',
    text: 'Attest mechanical proof criteria pass',
    by: 'graphyard-approver',
    at: '2026-10-02T11:30:00Z',
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
  assert.ok(digest.includes('GY-1001 (scope): Widen scope for auth helpers in src/auth.ts [by graphyard-approver]'));
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
  assert.ok(request.includes('Recent notes:'));
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
  recordNoteInMemory(memory, { id: 'd', key: 'GY-1', kind: 'scope', text: 'Widen to src/a.ts', by: 'approver-1', at: '2026-10-02T10:00:00Z' });
  recordChangeInMemory(memory, { key: 'GY-2', sha: 'a'.repeat(40), files: ['src/a.ts'], mergedAt: '2026-10-02T08:00:00Z' });
  assert.equal(projectMemoryDigest(memory, 'worker'),
    `Shared project memory: Recent notes: - GY-1 (scope): Widen to src/a.ts [by approver-1] Recent merges to main in last 24h: - GY-2 (aaaaaaaaaa): src/a.ts `);
  assert.equal(projectMemoryDigest(emptyProjectMemory(), 'worker'), '');
  assert.equal(projectMemoryDigest(null, 'reviewer'), '');
});

test('unit:session-request-carries-project-memory — reviewer request carries role-relevant project-memory digest within word budget', () => {
  const memory = createSampleMemory();
  const baseSha = '0000000000111111111122222222223333333333';
  const digest = projectMemoryDigest(memory, 'reviewer', { baseSha });

  assert.ok(digest.includes('Shared project memory:'));
  assert.ok(digest.includes('GY-1002 (review): Approve single-party bypass for docs chore [by operator]'));
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
  assert.ok(digest.includes('GY-1003 (attest): Attest mechanical proof criteria pass [by graphyard-approver]'));
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
});

test('unit:session-request-carries-project-memory — fixed word budget truncates overflow and prioritizes role-relevant entries', () => {
  const memory = emptyProjectMemory();
  for (let i = 0; i < 50; i++) {
    recordNoteInMemory(memory, {
      id: `dec-${i}`,
      key: `GY-${2000 + i}`,
      kind: i % 2 === 0 ? 'scope' : 'other',
      text: `Detailed explanation for decision ${i} explaining the full architecture context and requirements rationale for this specific change`,
      by: 'approver',
      at: new Date(Date.now() - i * 60_000).toISOString(),
    });
  }

  const digest = projectMemoryDigest(memory, 'worker', { wordBudget: 100 });
  assert.ok(docsWords(digest) <= 100, `Expected word count <= 100 but got ${docsWords(digest)}`);
  assert.ok(digest.startsWith('Shared project memory:'));
});

test('unit:session-request-carries-project-memory — memory updates from operator answers and merges only', async () => {
  const memory = emptyProjectMemory();

  // 1. Settled operator answers
  const work: Work[] = [
    {
      id: 'w-1',
      key: 'GY-500',
      title: 'Human decision item',
      stage: 'done',
      // The files its delivered candidate was observed to change are the change memory records.
      observation: { files: ['src/deploy.ts'] },
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
    } as any,
  ];

  updateProjectMemoryFromWork(memory, work, Date.now());

  assert.equal(memory.notes.length, 1);
  assert.equal(memory.notes[0].key, 'GY-500');
  assert.equal(memory.notes[0].kind, 'credentials-for-people');
  assert.ok(memory.notes[0].text.includes('Deploy token for production: Token created and stored in vault'));
  assert.equal(memory.notes[0].by, 'operator-1');
  assert.ok(!memory.notes.some(d => d.id === 'hr-0'), 'a declined answer decided nothing');

  assert.equal(memory.changes.length, 1);
  assert.equal(memory.changes[0].key, 'GY-500');
  assert.deepEqual(memory.changes[0].files, ['src/deploy.ts']);

  // 2. A sync over the same work records nothing new.
  await syncProjectMemory({
    existing: memory,
    work,
    now: Date.parse('2026-10-02T10:00:00Z'),
  });

  assert.equal(memory.notes.length, 1);
  assert.equal(memory.changes.length, 1);
});

test('unit:session-request-carries-project-memory — an unanswered human request records nothing', () => {
  const memory = emptyProjectMemory();

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
  assert.equal(memory.notes.length, 0, 'Unanswered human requests must not be recorded');
  assert.equal(memory.changes.length, 0, 'Unmerged items must not be recorded');
});

test('unit:session-request-carries-project-memory — file persistence round-trips to .graphyard/project-memory.json', async () => {
  const dir = await temporaryDirectory('persistence');
  try {
    const memory = createSampleMemory();
    await writeProjectMemory(dir, memory);

    const loaded = await readProjectMemory(dir);
    assert.equal(loaded.version, 1);
    assert.equal(loaded.notes.length, memory.notes.length);
    assert.equal(loaded.changes.length, memory.changes.length);

    assert.deepEqual(loaded.notes[0], memory.notes[0]);
    assert.deepEqual(loaded.changes[0], memory.changes[0]);

    // ENOENT falls back to emptyProjectMemory
    const emptyDir = await temporaryDirectory('persistence-empty');
    try {
      const empty = await readProjectMemory(emptyDir);
      assert.equal(empty.version, 1);
      assert.deepEqual(empty.notes, []);
      assert.deepEqual(empty.changes, []);
    } finally {
      await rm(emptyDir, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
