import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { daemonEffects, emptyDaemonState } from '../src/master-daemon.js';
import { checkAgentEnvironment, masterConfigSchema, type AgentEnvironment } from '../src/master.js';
import { clearPlanUsageCache } from '../src/provider-usage.js';
import { docsWords } from '../src/model/documentation.js';
import {
  emptyProjectMemory,
  projectMemoryDigest,
  projectMemoryWordBudget,
  recordChangeInMemory,
  recordDecisionInMemory,
  recordPitfallInMemory,
  retainedMemoryChanges,
  retainedMemoryDecisions,
  retainedMemoryPitfalls,
  updateProjectMemoryFromWork,
  type MemoryDecision,
  type ProjectMemory,
} from '../src/model/project-memory.js';
import {
  projectMemoryPath,
  readProjectMemory,
  syncProjectMemory,
  writeProjectMemory,
} from '../src/project-memory.js';
import type { Work } from '../src/model/work.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

test('unit:review-followups-triaged — decisions are retained strictly by answer time rather than work-item order (Finding 2)', () => {
  const memory = emptyProjectMemory();

  // Create 30 work items with answers spaced 1 minute apart.
  // Item 1 has the oldest answer (t=1 min), item 30 has the newest answer (t=30 min).
  const baseTime = Date.parse('2026-10-01T00:00:00.000Z');
  const items: Work[] = [];
  for (let i = 1; i <= 30; i++) {
    const at = new Date(baseTime + i * 60_000).toISOString();
    items.push({
      id: `id-${i}`,
      key: `GY-${1000 + i}`,
      title: `Item ${i}`,
      stage: 'implementation',
      humanRequests: [
        {
          id: `req-${i}`,
          kind: 'scope',
          needed: `Scope ${i}`,
          by: 'graphyard-worker',
          at: new Date(baseTime + (i - 0.5) * 60_000).toISOString(),
          answer: {
            text: `Answer for item ${i}`,
            by: 'operator',
            at,
            outcome: 'provided',
          },
        },
      ],
    } as unknown as Work);
  }

  // Shuffle or reverse item order in the snapshot
  const reversed = [...items].reverse();
  updateProjectMemoryFromWork(memory, reversed);

  // Must retain exactly 20 decisions
  assert.equal(memory.decisions.length, retainedMemoryDecisions);

  // The retained decisions must be the 20 newest (items 11 through 30), strictly sorted newest first
  for (let i = 0; i < retainedMemoryDecisions; i++) {
    const expectedItemNumber = 30 - i;
    assert.equal(memory.decisions[i].key, `GY-${1000 + expectedItemNumber}`);
    assert.equal(memory.decisions[i].id, `req-${expectedItemNumber}`);
  }

  // Verify that an older answer on a high-numbered item never evicts a newer answer on a low-numbered item
  const memory2 = emptyProjectMemory();
  const workMixed: Work[] = [
    {
      id: 'id-old-high',
      key: 'GY-9999',
      stage: 'implementation',
      humanRequests: [
        {
          id: 'req-old',
          kind: 'scope',
          needed: 'Old request',
          by: 'worker',
          at: new Date(baseTime).toISOString(),
          answer: { text: 'Old answer', by: 'operator', at: new Date(baseTime + 10_000).toISOString(), outcome: 'provided' },
        },
      ],
    } as unknown as Work,
    {
      id: 'id-new-low',
      key: 'GY-1',
      stage: 'implementation',
      humanRequests: [
        {
          id: 'req-new',
          kind: 'scope',
          needed: 'New request',
          by: 'worker',
          at: new Date(baseTime + 100_000).toISOString(),
          answer: { text: 'New answer', by: 'operator', at: new Date(baseTime + 200_000).toISOString(), outcome: 'provided' },
        },
      ],
    } as unknown as Work,
  ];

  updateProjectMemoryFromWork(memory2, workMixed);
  assert.equal(memory2.decisions[0].key, 'GY-1');
  assert.equal(memory2.decisions[1].key, 'GY-9999');
});

test('unit:review-followups-triaged — oversized memory decision is abbreviated and included within word budget (Finding 3)', () => {
  const memory = emptyProjectMemory();

  // Create an oversized answer with ~600 words (over 4,000 characters), exceeding the default 500-word budget
  const reasonWords = Array.from({ length: 600 }, (_, i) => `word${i}`);
  const reason = reasonWords.join(' ');
  assert.ok(docsWords(reason) >= 600);

  recordDecisionInMemory(memory, {
    id: 'req-oversized',
    key: 'GY-2000',
    action: 'human-answer',
    reason,
    state: 'provided',
    approvedBy: 'operator',
    at: '2026-10-01T12:00:00.000Z',
  });

  const digest = projectMemoryDigest(memory, 'worker', { wordBudget: 500 });

  // The digest must NOT be empty
  assert.ok(digest.length > 0);
  assert.ok(digest.includes('Shared project memory:'));
  assert.ok(digest.includes('Recent decisions:'));
  assert.ok(digest.includes('- GY-2000 (human-answer):'));
  // Must end with ellipsis indicating abbreviation
  assert.ok(digest.includes('… [approved by operator]'));
  // Must strictly respect the word budget
  assert.ok(docsWords(digest) <= 500, `Expected <= 500 words, got ${docsWords(digest)}`);
  // The one computed slice fills the budget exactly rather than leaving words unused (GY-1180).
  assert.equal(docsWords(digest), 500);
});

test('unit:review-followups-triaged — loop continues on oversized entry instead of breaking, preserving subsequent shorter entries (Finding 5)', () => {
  const memory = emptyProjectMemory();

  // 1. Decisions: First decision is long, second is short.
  // With a small budget, the second short decision must still be included if it fits.
  recordDecisionInMemory(memory, {
    id: 'dec-1',
    key: 'GY-101',
    action: 'requirements',
    reason: Array.from({ length: 40 }, () => 'longdetail').join(' '),
    state: 'approved',
    approvedBy: 'operator',
    at: '2026-10-01T12:00:00.000Z',
  });
  recordDecisionInMemory(memory, {
    id: 'dec-2',
    key: 'GY-102',
    action: 'scope',
    reason: 'tiny fix',
    state: 'approved',
    approvedBy: 'operator',
    at: '2026-10-01T11:00:00.000Z',
  });

  // Budget allows dec-1 (abbreviated or full) or dec-1 + dec-2
  const digestDec = projectMemoryDigest(memory, 'worker', { wordBudget: 60 });
  assert.ok(digestDec.includes('GY-101'));
  assert.ok(docsWords(digestDec) <= 60);

  // 2. Pitfalls: First pitfall has an oversized remedy, second pitfall is short.
  // Under the old 'break', pitfall 2 would be dropped. Under 'continue', pitfall 2 is included.
  const memoryPitfalls = emptyProjectMemory();
  recordPitfallInMemory(memoryPitfalls, {
    faultClass: 'scope',
    count: 10,
    remedy: Array.from({ length: 50 }, () => 'verydetailedremedyinstruction').join(' '),
    at: '2026-10-01T12:00:00.000Z',
  });
  recordPitfallInMemory(memoryPitfalls, {
    faultClass: 'configuration',
    count: 5,
    remedy: 'short remedy',
    at: '2026-10-01T11:00:00.000Z',
  });

  // Budget of 25: cannot fit 50-word scope remedy, but can fit configuration remedy
  const digestPit = projectMemoryDigest(memoryPitfalls, 'worker', { wordBudget: 25 });
  assert.ok(digestPit.includes('configuration (5 recurrences): short remedy'));
  assert.ok(!digestPit.includes('verydetailedremedyinstruction'));
  assert.ok(docsWords(digestPit) <= 25);

  // 3. Merges: First merge has many files and exceeds budget, second merge has 1 file.
  const memoryMerges = emptyProjectMemory();
  recordChangeInMemory(memoryMerges, {
    key: 'GY-201',
    sha: '1111111111222222222233333333334444444444',
    files: Array.from({ length: 10 }, (_, i) => `src/nested/path/to/longfilename${i}.ts`),
    mergedAt: '2026-10-01T12:00:00.000Z',
  });
  recordChangeInMemory(memoryMerges, {
    key: 'GY-202',
    sha: '2222222222333333333344444444445555555555',
    files: ['tiny.ts'],
    mergedAt: '2026-10-01T11:00:00.000Z',
  });

  // Small budget of 20: Change 1 does not fit, Change 2 fits via continue
  const digestChange = projectMemoryDigest(memoryMerges, 'worker', { wordBudget: 20 });
  assert.ok(digestChange.includes('GY-202 (2222222222): tiny.ts'));
  assert.ok(!digestChange.includes('GY-201'));
  assert.ok(docsWords(digestChange) <= 20);
});

test('unit:review-followups-triaged — syncProjectMemory caps retention and change-only disk writes are non-redundant (Finding 6)', async () => {
  const root = await temporaryDirectory('project-memory-test');
  let memory = emptyProjectMemory();

  // Populate memory beyond caps
  for (let i = 1; i <= 30; i++) {
    recordDecisionInMemory(memory, {
      id: `dec-${i}`,
      key: `GY-${i}`,
      action: 'scope',
      reason: `Reason ${i}`,
      state: 'approved',
      approvedBy: 'approver',
      at: new Date(Date.now() + i * 1000).toISOString(),
    });
  }
  for (let i = 1; i <= 30; i++) {
    recordPitfallInMemory(memory, {
      faultClass: `fault-${i}`,
      count: i,
      at: new Date(Date.now() + i * 1000).toISOString(),
    });
  }
  for (let i = 1; i <= 40; i++) {
    recordChangeInMemory(memory, {
      key: `GY-M-${i}`,
      sha: `sha${i}`.padEnd(40, '0'),
      files: [`file${i}.ts`],
      mergedAt: new Date(Date.now() + i * 1000).toISOString(),
    });
  }

  // Retention caps must be enforced
  assert.equal(memory.decisions.length, retainedMemoryDecisions); // 20
  assert.equal(memory.pitfalls.length, retainedMemoryPitfalls);   // 20
  assert.equal(memory.changes.length, retainedMemoryChanges);     // 30

  // Write to disk and read back
  await writeProjectMemory(root, memory);
  const fromDisk = await readProjectMemory(root);
  assert.equal(fromDisk.decisions.length, retainedMemoryDecisions);
  assert.equal(fromDisk.pitfalls.length, retainedMemoryPitfalls);
  assert.equal(fromDisk.changes.length, retainedMemoryChanges);

  // Change-only persistence, driven through the loop's real persist (GY-1180): the mirror file is
  // removed after the first write, so a cycle that rewrote unchanged memory would bring it back.
  const secrets = await temporaryDirectory('project-memory-persist');
  const credentialFile = join(secrets, 'coordinator.token');
  const master = masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:9', credentialFile, cliPath: 'bin/graphyard.mjs',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [], run: { worktreeRoot: join(secrets, 'checkouts') } });
  const effects = daemonEffects(root, master, {
    snapshot: async () => ({ work: [], now: new Date().toISOString() }), mutate: async () => ({}),
    executor: { principal: 'coordinator-1', instance: 'persist' }, run: async () => '',
  });
  const state = { ...emptyDaemonState(master), projectMemory: fromDisk };
  try {
    await effects.persist(state);
    assert.deepEqual(await readProjectMemory(root), fromDisk);
    await rm(projectMemoryPath(root));
    for (let c = 0; c < 10; c++) await effects.persist(state);
    await assert.rejects(stat(projectMemoryPath(root)), 'File must not be rewritten when project memory is unchanged');
    // A changed memory is written on the next cycle.
    recordChangeInMemory(fromDisk, { key: 'GY-M-new', sha: 'f'.repeat(40), files: ['new.ts'], mergedAt: new Date(Date.now() + 60_000).toISOString() });
    await effects.persist(state);
    assert.equal((await readProjectMemory(root)).changes[0]?.key, 'GY-M-new');
  } finally {
    await rm(secrets, { recursive: true, force: true });
  }
});

test('unit:review-followups-triaged — settled summary items preserve existing project memory decisions without backfill (Finding 1 & 4)', () => {
  const memory = emptyProjectMemory();

  // Existing decision in memory
  recordDecisionInMemory(memory, {
    id: 'existing-dec',
    key: 'GY-500',
    action: 'requirements',
    reason: 'Existing approved requirement',
    state: 'approved',
    approvedBy: 'operator',
    at: '2026-10-01T10:00:00.000Z',
  });

  // Settled work item as delivered summary in snapshot: summary=true, no humanRequests or researchBrief
  const settledSummaryWork: Work[] = [
    {
      id: 'settled-item-id',
      key: 'GY-400',
      title: 'Settled delivery item',
      stage: 'done',
      summary: true,
      delivery: {
        mergedAt: new Date(Date.now() - 3_600_000).toISOString(),
        mergeSha: 'abcdef1234567890abcdef1234567890abcdef12',
      },
    } as unknown as Work,
  ];

  updateProjectMemoryFromWork(memory, settledSummaryWork);

  // Existing decisions are intact
  assert.equal(memory.decisions.length, 1);
  assert.equal(memory.decisions[0].key, 'GY-500');
  // Settled item with delivery is recorded in changes
  assert.equal(memory.changes.length, 1);
  assert.equal(memory.changes[0].key, 'GY-400');
});

test('unit:review-followups-triaged — accounts on one shared provider plan read its quota endpoint once, not once per account (GY-1180)', async () => {
  clearPlanUsageCache();
  const homes = await temporaryDirectory('shared-plan-accounts');
  try {
    let calls = 0;
    const fetcher = (async () => { calls++; return new Response(JSON.stringify({ windows: [{ window: '5h', percent: 12, resetsAt: null }] }), { status: 200 }); }) as typeof fetch;
    const accounts = ['opencode-a', 'opencode-b', 'opencode-c'].map(name => ({ name, kind: 'opencode' as const, home: join(homes, name), plan: 'zai-shared' }));
    for (const account of accounts) { await mkdir(account.home, { recursive: true }); await writeFile(join(account.home, 'zai.key'), `key-${account.name}`); }
    const now = Date.parse('2026-10-03T00:00:00.000Z');
    const health = [];
    for (const account of accounts) health.push(await checkAgentEnvironment(account as AgentEnvironment, { fetch: fetcher, now: () => now }));
    assert.equal(calls, 1, 'the second and third accounts reuse the plan reading');
    assert.deepEqual(health.map(entry => [entry.quota, entry.usage[0]?.percent]), [['available', 12], ['available', 12], ['available', 12]]);
    // A reading from the cache does not re-stamp it: once the window passes, the endpoint is read again.
    await checkAgentEnvironment({ ...accounts[0], name: 'opencode-d' } as AgentEnvironment, { fetch: fetcher, now: () => now + 31_000 });
    assert.equal(calls, 2);
  } finally {
    clearPlanUsageCache();
    await rm(homes, { recursive: true, force: true });
  }
});
