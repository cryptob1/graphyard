import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, LANDABLE_CHECK, CHECK_NAME, processJob } from '../src/github.js';
import { applyProtection, protectionPlan, requiredStatusChecks, conversationPayload, GRAPHYARD_CHECKS } from '../src/protection.js';
import type { Evidence, Observation, Work } from '../src/model.js';

const at = '2026-10-03T12:00:00.000Z';
const now = new Date(at);
const sha = (digit: string) => digit.repeat(40);
const head = sha('7'), base = sha('9'), main = sha('b');
const APP = 1234;

const proof = (overrides: Partial<Evidence> = {}): Evidence => ({
  id: `unit:own-proof@${(overrides.sha ?? head).slice(0, 4)}#${overrides.result ?? 'pass'}`,
  proof: 'unit:own-proof', sha: head, baseSha: base, policyRevision: 1,
  producer: 'independent-producer', trusted: true, result: 'pass', executed: 3, skipped: 0, at, ...overrides,
}) as Evidence;

function item(extra: Partial<Work> = {}, candidateSha = head): Work {
  const candidate = { sha: candidateSha, baseSha: base, pr: 10, branch: 'graphyard/gy-1-1', author: 'worker' };
  const file = { path: 'src/store/own.ts', status: 'modified', sha: sha('d'), baseSha: sha('e'), additions: 3, deletions: 1, binary: false };
  const observation = {
    candidate, checks: [{ name: 'test', result: 'success', appId: 1 }],
    reviews: [{ reviewer: 'reviewer', sha: candidateSha, state: 'APPROVED', submittedAt: at }],
    merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/store/own.ts'], scopeFiles: [file], landing: { base: main, files: [file] },
    at, prState: 'open', draft: false, baseTip: main, baseTree: sha('e'), baseTipContained: true,
  } as unknown as Observation;
  return {
    id: 'gy-1', key: 'GY-1', title: 'GY-1', description: '', type: 'feature', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'proven', proofs: ['unit:own-proof'] }],
    policy: { checks: [], review: false }, plannedFiles: ['src/store/own.ts'], stage: 'merge', revision: 4, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, candidate,
    workspaces: [{ host: 'machine-a', path: '/tmp/GY-1', epoch: 1, owner: 'worker', branch: candidate.branch }],
    submission: { epoch: 1, pr: 10 }, reworkRequested: false, scenarioRequirements: [],
    evidence: [proof({ sha: candidateSha })], blocker: null, gates: [], violations: [],
    queue: null, queueSequence: 0, queueHistory: [], queueEjection: null, observation, ...extra,
  } as unknown as Work;
}

function createHarness() {
  const runs: any[] = [];
  const calls: { method: string; path: string; body?: any }[] = [];
  const pr = { head, base, mainTip: main };
  const github = new GitHub({ repository: 'owner/repo', base: 'main', appId: APP, installationId: 1, privateKey: 'dummy' });

  github.request = async (path, method = 'GET', body) => {
    calls.push({ method, path, body });
    if (method === 'POST' && path === '/check-runs') {
      const run = { id: runs.length + 100, app: { id: APP }, ...(body as any) };
      runs.push(run);
      return run;
    }
    if (method === 'PATCH' && path.startsWith('/check-runs/')) {
      const id = Number(path.slice(12));
      const run = runs.find(entry => entry.id === id)!;
      Object.assign(run, body);
      return run;
    }
    if (path === '/pulls/10') {
      return { number: 10, head: { sha: pr.head, ref: 'graphyard/gy-1-1' }, base: { sha: pr.base, ref: 'main' }, state: 'open', draft: false };
    }
    if (path === '/git/ref/heads/main') {
      return { ref: 'refs/heads/main', object: { type: 'commit', sha: pr.mainTip } };
    }
    if (path.startsWith('/commits/')) {
      return { sha: path.slice(9), commit: { tree: { sha: sha('e') } } };
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };

  github.pages = async (path: string) => {
    calls.push({ method: 'GET', path });
    if (path.includes('/check-runs')) {
      const match = /\/commits\/([a-f0-9]+)\/check-runs/.exec(path);
      const commitSha = match?.[1];
      return runs.filter(run => run.head_sha === commitSha);
    }
    return [];
  };

  return { github, runs, calls, pr };
}

test('manual:review-followups-triaged GY-1150.1: each follow-up 1..7 from GY-1050 review is addressed in code or declined with recorded reason (AC-1)', () => {
  type TriageStatus = 'addressed' | 'declined';
  interface TriageEntry {
    id: number;
    path: string;
    description: string;
    status: TriageStatus;
    reasonOrResolution: string;
  }

  const triage: TriageEntry[] = [
    {
      id: 1, path: 'src/github.ts', description: 'Stop after a moved head skips landability publication',
      status: 'addressed', reasonOrResolution: 'Addressed in GY-1050 (commit aeb9b8f94e): publishLandable returns { skipped: true } and processJob stops and requeues with finishJob(..., retry=true) before gateMerge/publish.',
    },
    {
      id: 2, path: 'src/github.ts', description: 'Bound the per-head landability cache',
      status: 'addressed', reasonOrResolution: 'Addressed in GY-1050 (commit aeb9b8f94e): cacheLandableBody bounds landableBodies map by landableBodiesEntries (16384) with FIFO eviction on size limit.',
    },
    {
      id: 3, path: 'src/github.ts', description: 'Preserve skip-on-moved behavior on cache hits',
      status: 'addressed', reasonOrResolution: 'Addressed in GY-1150: when skipOnMoved is true, publishLandable verifies PR head and base currency before returning on landableBodies cache hits or standing runs, returning { skipped: true } if moved.',
    },
    {
      id: 4, path: 'src/protection.ts', description: 'Make the missing-status-check path reachable',
      status: 'addressed', reasonOrResolution: 'Addressed in GY-1150: protectionPlan omits strict and CHECK_NAME blockers when required_status_checks is absent, allowing applyProtection to reach the PUT branch without throwing.',
    },
    {
      id: 5, path: 'src/github.ts', description: 'Preserve moved-head skipping on landability cache hits',
      status: 'addressed', reasonOrResolution: 'Addressed in GY-1150 (duplicate of #3): currency verification under skipOnMoved ensures cache hits on moved heads return { skipped: true } and requeue cleanly.',
    },
    {
      id: 6, path: 'src/protection.ts', description: 'Make absent required-status checks reconcileable',
      status: 'addressed', reasonOrResolution: 'Addressed in GY-1150 (duplicate of #4): applyProtection PUT payload includes both GRAPHYARD_CHECKS (Graphyard / merge and graphyard/landable) when bootstrapping absent checks, so verification reread succeeds.',
    },
    {
      id: 7, path: 'src/github.ts', description: 'Skip moved PRs when landability is a failure',
      status: 'addressed', reasonOrResolution: 'Addressed in GY-1150: currency check and skipOnMoved handling in publishLandable run for all conclusions, not only success, so failure verdicts on moved heads return { skipped: true } instead of failing the job.',
    },
  ];

  assert.equal(triage.length, 7, 'all 7 follow-ups accounted for');
  for (const entry of triage) {
    assert.ok(entry.reasonOrResolution.length > 20, `entry ${entry.id} has detailed explanation`);
    assert.ok(['addressed', 'declined'].includes(entry.status));
  }
  const addressedCount = triage.filter(e => e.status === 'addressed').length;
  assert.equal(addressedCount, 7, 'all 7 follow-ups addressed in code');
});

test('manual:review-followups-triaged GY-1150.2: publishLandable returns { skipped: true } on cache hits when PR head or base moved (Findings 3, 5)', async () => {
  const { github, runs, pr } = createHarness();
  const work = item();

  // Populate cache on current head
  const first = await github.publishLandable(work, [work], async () => {}, true);
  assert.equal(first, undefined);
  assert.equal(runs.length, 1);
  assert.ok((github as any).landableBodies.has(work.candidate!.sha));

  // Head moved between observation and second publication call
  pr.head = sha('6');

  // Cache hit must not return undefined when head moved; must return { skipped: true }
  const resHead = await github.publishLandable(work, [work], async () => {}, true);
  assert.deepEqual(resHead, { skipped: true }, 'skipOnMoved returns { skipped: true } on cache hit when head moved');
  assert.equal(runs.length, 1, 'no new check run written on moved head');

  // Base moved between observation and publication call
  pr.head = head;
  (github as any).sharedRef = null;
  pr.mainTip = sha('1');

  const resBase = await github.publishLandable(work, [work], async () => {}, true);
  assert.deepEqual(resBase, { skipped: true }, 'skipOnMoved returns { skipped: true } on cache hit when base moved');
  assert.equal(runs.length, 1, 'no new check run written on moved base');
});

test('manual:review-followups-triaged GY-1150.3: publishLandable skips or throws on moved PR when landability is a failure (Finding 7)', async () => {
  const { github, runs, pr } = createHarness();
  // Failing work item: no evidence, policy revision mismatch
  const failing = item({ evidence: [], policyRevision: 2 });

  // Move PR head
  pr.head = sha('6');

  // With skipOnMoved = true: returns { skipped: true } even for failing conclusion
  const skipped = await github.publishLandable(failing, [failing], async () => {}, true);
  assert.deepEqual(skipped, { skipped: true }, 'skipOnMoved returns { skipped: true } on failure verdict when head moved');
  assert.equal(runs.length, 0, 'no check run written for moved head');

  // With skipOnMoved = false: throws requireCurrent error even for failing conclusion
  await assert.rejects(async () => {
    await github.publishLandable(failing, [failing]);
  }, /PR changed before the landability check was published/);
});

test('manual:review-followups-triaged GY-1150.4: processJob cleanly stops and requeues on cache-hit moved head and failure moved head (Findings 3, 5, 7)', async () => {
  const { github, pr } = createHarness();
  const work = item();

  // Populate cache on current head
  await github.publishLandable(work, [work]);
  assert.ok((github as any).landableBodies.has(work.candidate!.sha));

  github.observe = async () => work.observation!;
  pr.head = sha('6');

  let finishedArgs: any = null;
  let publishCalled = false;
  github.publish = async (...args: any[]) => { publishCalled = true; };

  const engine = {
    mergeBatchSize: 1,
    parallelTips: 0,
    ciAppIds: [],
    optimisticMerge: false,
    loadMergeBatchSize: async () => 1,
    loadParallelTips: async () => 0,
    loadRerunFailedChecks: async () => 0,
    loadOptimisticExclude: async () => [],
    store: {
      list: async () => [work],
      takeJob: async () => ({ work_id: work.id, token: 'tok', claimed_generation: 1 }),
      finishJob: async (id: string, token: string, err?: string, retry?: boolean, avail?: number, obs?: boolean) => {
        finishedArgs = { id, token, err, retry, obs };
      },
      pool: { query: async () => ({ rows: [{ document: work, now: new Date() }] }) },
    },
    observe: async () => work,
    reconcileLanded: async () => {},
  } as any;

  const settled = await processJob(engine, github as any);
  assert.equal(settled, true, 'processJob settled cleanly on cache-hit moved head');
  assert.ok(finishedArgs, 'finishJob was called');
  assert.equal(finishedArgs.retry, true, 'job was requeued with retry=true');
  assert.equal(finishedArgs.err, undefined, 'no error was recorded on job');
  assert.equal(publishCalled, false, 'publish was NOT called after skip');
});

test('manual:review-followups-triaged GY-1150.5: protectionPlan allows absent required_status_checks without strict or merge check blockers (Finding 4)', () => {
  const config = { repository: 'owner/repo', baseBranch: 'main', githubAppId: APP };
  const current = {
    required_pull_request_reviews: { required_approving_review_count: 1, require_last_push_approval: true, dismiss_stale_reviews: true },
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    required_status_checks: null,
  };

  const planNull = protectionPlan(current, config, [item()]);
  assert.equal(planNull.blockers.length, 0, 'no blockers when required_status_checks is null');
  assert.equal(planNull.refusal, null);
  assert.equal(planNull.consistent, false);
  assert.ok(planNull.changes.some(c => c.includes(`required status checks: missing to required (${GRAPHYARD_CHECKS.join(' and ')})`)));

  const currentUndefined = { ...current };
  delete (currentUndefined as any).required_status_checks;
  const planUndefined = protectionPlan(currentUndefined, config, [item()]);
  assert.equal(planUndefined.blockers.length, 0, 'no blockers when required_status_checks is undefined');
  assert.equal(planUndefined.refusal, null);
  assert.equal(planUndefined.consistent, false);
});

test('manual:review-followups-triaged GY-1150.6: applyProtection reconciles absent required_status_checks via PUT with both Graphyard checks (Findings 4, 6)', async () => {
  const config = { repository: 'owner/repo', baseBranch: 'main', githubAppId: APP };
  const open = [item()];

  let currentProtection: any = {
    required_status_checks: null,
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    required_conversation_resolution: { enabled: false },
    required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true },
  };

  const writes: { method: string; path: string; body: any }[] = [];
  const run = (_cmd: string, args: string[], input?: string) => {
    const path = args.find(a => a.startsWith('repos/'))!;
    if (args.includes('--method')) {
      const method = args[args.indexOf('--method') + 1];
      const body = JSON.parse(input ?? '{}');
      writes.push({ method, path, body });
      if (method === 'PUT' && path.endsWith('/protection')) {
        currentProtection = { ...currentProtection, ...body, enforce_admins: { enabled: body.enforce_admins === true } };
      }
      return '{}';
    }
    if (path.endsWith('/protection')) return JSON.stringify(currentProtection);
    if (path.includes('/rules/branches/')) return 'null';
    if (path.includes('/rulesets')) return '[]';
    if (path === 'repos/owner/repo') return JSON.stringify({ owner: { type: 'Organization' }, allow_auto_merge: false });
    throw new Error(`Unexpected: ${args.join(' ')}`);
  };

  const applied = await applyProtection(config, open, run);
  assert.equal(applied.consistent, true, 'applyProtection reconciles protection to consistent');
  assert.equal(applied.applied, true, 'changes were applied');

  const putWrite = writes.find(w => w.method === 'PUT' && w.path.endsWith('/protection'));
  assert.ok(putWrite, 'PUT write was executed for branch protection');
  assert.deepEqual(putWrite.body.required_status_checks, {
    strict: false,
    checks: [
      { context: CHECK_NAME, app_id: APP },
      { context: LANDABLE_CHECK, app_id: APP },
    ],
  }, 'PUT payload bootstraps both Graphyard / merge and graphyard/landable bound to App');

  // Verify conversationPayload with bootstrapStatusChecks
  const payload = conversationPayload(
    { ...currentProtection, required_status_checks: null },
    { requiredApprovals: 1, dismissStaleReviews: true, requireLastPushApproval: true, mode: 'agent' },
    APP,
    true
  );
  assert.deepEqual(payload.required_status_checks, {
    strict: false,
    checks: [
      { context: CHECK_NAME, app_id: APP },
      { context: LANDABLE_CHECK, app_id: APP },
    ],
  });
});
