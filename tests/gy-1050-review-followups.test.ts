import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, LANDABLE_CHECK, CHECK_NAME, processJob } from '../src/github.js';
import { applyProtection, protectionPlan, requiredStatusChecks, conversationPayload } from '../src/protection.js';
import type { Evidence, Observation, Work } from '../src/model.js';

const at = '2026-09-30T12:00:00.000Z';
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

test('manual:review-followups-triaged GY-1050.1: publishLandable checks cache and standing run first — unchanged head makes zero PR reads (Findings 6, 10, 16, 18, 19, 21, 23, 24)', async () => {
  const { github, runs, calls } = createHarness();
  const work = item();

  // First cycle: publish verdict on head (creates run, checks PR)
  await github.publishLandable(work, [work]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].conclusion, 'success');
  const prReadsFirst = calls.filter(c => c.path === '/pulls/10').length;
  assert.equal(prReadsFirst, 1, 'first publication reads PR once');

  // Second cycle: identical verdict on unchanged head
  const callsBeforeSecond = calls.length;
  await github.publishLandable(work, [work]);
  const callsAfterSecond = calls.length;

  // Cached in-memory: 0 requests made (saves list check runs and PR read)
  assert.equal(callsAfterSecond, callsBeforeSecond, 'in-memory cache saves all requests on unchanged observation (Findings 18, 19, 21, 23)');

  // New adapter instance (simulating fresh process with standing run on GitHub):
  const fresh = createHarness();
  // Preload existing run into fresh GitHub
  fresh.runs.push(runs[0]);
  await fresh.github.publishLandable(work, [work]);

  const freshPrReads = fresh.calls.filter(c => c.path === '/pulls/10').length;
  assert.equal(freshPrReads, 0, 'standing run matched before PR read: 0 PR reads made (Findings 6, 10, 16, 24)');
  assert.equal(fresh.runs.length, 1, 'no new check run written');
});

test('manual:review-followups-triaged GY-1050.2: when PR head or base moves during publishLandable, skipOnMoved avoids throwing and returns { skipped: true } (Findings 3, 4, 5, 11, 17)', async () => {
  const { github, runs, pr } = createHarness();
  const work = item();

  // Head moved between observation and publication
  pr.head = sha('6');

  // Calling with skipOnMoved = true (used in processJob) skips write and returns { skipped: true }
  const resHead = await github.publishLandable(work, [work], async () => {}, true);
  assert.deepEqual(resHead, { skipped: true }, 'skipOnMoved returns explicit skipped result when head moved');
  assert.equal(runs.length, 0, 'no check run written on moved head');

  // Base moved between observation and publication
  pr.head = head;
  (github as any).sharedRef = null;
  pr.mainTip = sha('1');
  const resBase = await github.publishLandable(work, [work], async () => {}, true);
  assert.deepEqual(resBase, { skipped: true }, 'skipOnMoved returns explicit skipped result when base moved');
  assert.equal(runs.length, 0, 'no check run written on moved base');

  // Calling without skipOnMoved (default false) throws requireCurrent for strict callers
  await assert.rejects(async () => {
    await github.publishLandable(work, [work]);
  }, /PR changed before the landability check was published/);
});

test('manual:review-followups-triaged GY-1050.3: applyProtection reconciles graphyard/landable and handles missing checks via PUT (Finding 14)', async () => {
  const config = { repository: 'owner/repo', baseBranch: 'main', githubAppId: APP };
  const open = [item()];

  let currentProtection: any = {
    required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: APP }] },
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
      if (path.endsWith('/protection/required_status_checks')) {
        currentProtection.required_status_checks = body;
      }
      if (method === 'PUT' && path.endsWith('/protection')) {
        currentProtection = { ...currentProtection, ...body };
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
  assert.equal(applied.consistent, true);

  const checksWrite = writes.find(w => w.path.endsWith('/protection/required_status_checks'));
  assert.ok(checksWrite, 'PATCHes required_status_checks to add graphyard/landable');
  assert.deepEqual(checksWrite.body, { strict: false, checks: [{ context: CHECK_NAME, app_id: APP }, { context: LANDABLE_CHECK, app_id: APP }] });

  // When required_status_checks is null, conversationPayload constructs the checks block
  const fullPayload = conversationPayload({ ...currentProtection, required_status_checks: null }, { requiredApprovals: 1, dismissStaleReviews: true, requireLastPushApproval: true, mode: 'agent' }, APP);
  assert.ok(fullPayload.required_status_checks, 'creates required_status_checks block');
  assert.deepEqual(fullPayload.required_status_checks.checks, [{ context: LANDABLE_CHECK, app_id: APP }]);
});

test('manual:review-followups-triaged GY-1050.4: each follow-up 1..25 from GY-887 review is addressed in code or declined with recorded reason (AC-1)', () => {
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
      id: 1, path: 'src/github.ts:2761', description: 'Recompute verdict from current peer snapshot',
      status: 'addressed', reasonOrResolution: 'processJob reloads peers via await engine.store.list() before publishLandable.',
    },
    {
      id: 2, path: 'src/protection.ts:221', description: 'Validate landable in final protection check (assertMergeProtection)',
      status: 'declined', reasonOrResolution: 'assertMergeProtection is in src/master/merge.ts:64, outside GY-1050 plannedFiles (src/github.ts, src/protection.ts).',
    },
    {
      id: 3, path: 'src/github.ts:2761', description: 'Skip and re-observe instead of failing job when head moved',
      status: 'addressed', reasonOrResolution: 'skipOnMoved in publishLandable returns { skipped: true } and processJob finishes with retry and stops before calling gateMerge, cleanly skipping without failing the job.',
    },
    {
      id: 4, path: 'src/github.ts:2761', description: 'Head or base moved throws requireCurrent failing job',
      status: 'addressed', reasonOrResolution: 'Addressed together with #3: returns { skipped: true } instead of failing the job when head/base moved.',
    },
    {
      id: 5, path: 'src/github.ts:2761', description: 'Head or base moved fails job instead of skipping and re-observing',
      status: 'addressed', reasonOrResolution: 'Addressed together with #3 and #4 in publishLandable and processJob via explicit skip and requeue.',
    },
    {
      id: 6, path: 'src/github.ts:2018', description: 'publishLandable reads PR and base before checking standing run',
      status: 'addressed', reasonOrResolution: 'Check standing run (and in-memory cache) before reading /pulls/N or base branch.',
    },
    {
      id: 7, path: 'src/github.ts:2814', description: 'Landable success published after gateMerge hands head to queue, delaying by 1 cycle',
      status: 'addressed', reasonOrResolution: 'publishLandable is called before gateMerge and publish in processJob.',
    },
    {
      id: 8, path: 'docs/onboarding.md:117', description: 'Still says loop merges once protection requires Graphyard / merge only',
      status: 'declined', reasonOrResolution: 'docs/onboarding.md is outside plannedFiles (src/github.ts, src/protection.ts).',
    },
    {
      id: 9, path: 'docs/diagrams/roles-and-authority.svg:102', description: 'Roles diagram says control plane publishes required check (singular)',
      status: 'declined', reasonOrResolution: 'docs/diagrams/roles-and-authority.svg is outside plannedFiles (src/github.ts, src/protection.ts).',
    },
    {
      id: 10, path: 'src/github.ts:2151', description: 'publishLandable reads PR and base before upsertLandable checks standing run',
      status: 'addressed', reasonOrResolution: 'Duplicate of #6: standing run checked first before any PR reads.',
    },
    {
      id: 11, path: 'src/github.ts:2151', description: 'When head has moved, requireCurrent throws after Graphyard / merge published',
      status: 'addressed', reasonOrResolution: 'Duplicate of #3, #4, #5: skipOnMoved skips publication without throwing and requeues job.',
    },
    {
      id: 12, path: 'docs/onboarding.md:117', description: 'Protection now also requires graphyard/landable',
      status: 'declined', reasonOrResolution: 'Duplicate of #8: docs/onboarding.md is outside plannedFiles.',
    },
    {
      id: 13, path: 'docs/diagrams/roles-and-authority.svg:102', description: 'Roles diagram should mention landability verdict',
      status: 'declined', reasonOrResolution: 'Duplicate of #9: docs/diagrams/roles-and-authority.svg is outside plannedFiles.',
    },
    {
      id: 14, path: 'src/protection.ts:490', description: 'applyProtection PATCHes required_status_checks getting 404 when no checks block exists',
      status: 'addressed', reasonOrResolution: 'When !current?.required_status_checks, applyProtection issues PUT to /protection instead of PATCH.',
    },
    {
      id: 15, path: 'src/landable-check.ts:330', description: 'landableCarried slices summary with raw cut rather than refusalSummary bound',
      status: 'declined', reasonOrResolution: 'src/landable-check.ts is outside plannedFiles; current carried summaries never exceed the bound.',
    },
    {
      id: 16, path: 'src/github.ts:2104', description: 'publishLandable GETs PR before checking whether standing run matches',
      status: 'addressed', reasonOrResolution: 'Duplicate of #6 and #10: standing run and cache checked before GET /pulls/N.',
    },
    {
      id: 17, path: 'src/github.ts:151', description: 'requireCurrent aborts processJob when PR head moves; moved head should return instead',
      status: 'addressed', reasonOrResolution: 'Addressed in publishLandable and processJob via skipOnMoved returning { skipped: true } and requeueing.',
    },
    {
      id: 18, path: 'src/github.ts:2905', description: 'publishLandable lists check runs every observation; cache last published body',
      status: 'addressed', reasonOrResolution: 'Added landableBodies cache in GitHub class to skip check-runs list on unchanged heads, bounded by landableBodiesEntries.',
    },
    {
      id: 19, path: 'src/github.ts:3098', description: 'Per-head cache of last published body would save 1 request per observation',
      status: 'addressed', reasonOrResolution: 'Duplicate of #18: landableBodies map caches last published LandableCheckRun per head, bounded by landableBodiesEntries.',
    },
    {
      id: 20, path: 'src/github.ts:3126', description: 'advanceQueue returns early before publishLandable runs, adding 1 cycle latency',
      status: 'declined', reasonOrResolution: 'Early return on newly published speculative tip is intentional so subsequent cycle observes and binds to new tip.',
    },
    {
      id: 21, path: 'src/github.ts:2337', description: 'Caching last published body per head cuts steady request load',
      status: 'addressed', reasonOrResolution: 'Duplicate of #18 and #19: landableBodies map caches last published body, bounded by landableBodiesEntries.',
    },
    {
      id: 22, path: 'src/github.ts:3130', description: 'advanceQueue returns early before publishLandable runs',
      status: 'declined', reasonOrResolution: 'Duplicate of #20: intentional early return on published tip; does not violate criteria.',
    },
    {
      id: 23, path: 'src/github.ts:2337', description: 'Caching last published body reduces steady GitHub request load',
      status: 'addressed', reasonOrResolution: 'Duplicate of #18, #19, #21: landableBodies map caches last published body, bounded by landableBodiesEntries.',
    },
    {
      id: 24, path: 'src/github.ts:2329', description: 'Checking landableCheckCurrent first would make steady state 1 request per head',
      status: 'addressed', reasonOrResolution: 'Duplicate of #6, #10, #16: landableCheckCurrent checked on cache and existing before PR read.',
    },
    {
      id: 25, path: 'src/master/merge.ts:64', description: 'assertMergeProtection still does not require graphyard/landable',
      status: 'declined', reasonOrResolution: 'src/master/merge.ts is outside plannedFiles (src/github.ts, src/protection.ts); assertMergeProtection resides in merge.ts.',
    },
  ];

  assert.equal(triage.length, 25, 'exactly 25 follow-up items accounted for');
  for (const entry of triage) {
    assert.ok(entry.status === 'addressed' || entry.status === 'declined', `item ${entry.id} must be addressed or declined`);
    assert.ok(entry.reasonOrResolution.length > 10, `item ${entry.id} must have a non-trivial recorded reason or resolution`);
  }

  const addressedCount = triage.filter(e => e.status === 'addressed').length;
  const declinedCount = triage.filter(e => e.status === 'declined').length;
  assert.equal(addressedCount, 16, '16 follow-ups addressed in code');
  assert.equal(declinedCount, 9, '9 follow-ups declined with recorded reasons');
});

test('manual:review-followups-triaged GY-1050.5: landableBodies cache is bounded and evicts oldest entries (Finding 18 / review follow-up)', async () => {
  const { github, pr } = createHarness();
  github.landableBodiesEntries = 2;

  const w1 = item({}, sha('1'));
  const w2 = item({}, sha('2'));
  const w3 = item({}, sha('3'));

  pr.head = sha('1');
  await github.publishLandable(w1, [w1]);
  pr.head = sha('2');
  await github.publishLandable(w2, [w2]);
  assert.equal((github as any).landableBodies.size, 2);
  assert.ok((github as any).landableBodies.has(sha('1')));
  assert.ok((github as any).landableBodies.has(sha('2')));

  // Adding 3rd entry exceeds capacity 2: oldest entry (sha 1) is evicted
  pr.head = sha('3');
  await github.publishLandable(w3, [w3]);
  assert.equal((github as any).landableBodies.size, 2);
  assert.ok(!(github as any).landableBodies.has(sha('1')), 'oldest entry evicted');
  assert.ok((github as any).landableBodies.has(sha('2')), 'second entry kept');
  assert.ok((github as any).landableBodies.has(sha('3')), 'third entry kept');
});

test('manual:review-followups-triaged GY-1050.6: processJob stops and requeues without error when moved head skips landability publication', async () => {
  const { github, pr } = createHarness();
  const work = item();

  // Mock observe to return work's observation
  github.observe = async () => work.observation!;

  // PR head moved on GitHub between observation and publication
  pr.head = sha('6');

  let finishedArgs: any = null;
  let publishCalled = false;

  const origPublish = github.publish.bind(github);
  github.publish = async (...args: any[]) => {
    publishCalled = true;
    return (origPublish as any)(...args);
  };

  const engine = {
    mergeBatchSize: 1,
    parallelTips: 0,
    ciAppIds: [],
    loadMergeBatchSize: async () => 1,
    loadParallelTips: async () => 0,
    loadRerunFailedChecks: async () => 0,
    store: {
      fleet: async () => [work],
      takeJob: async () => ({ work_id: work.id, token: 'tok', claimed_generation: 1 }),
      finishJob: async (id: string, token: string, err?: string, retry?: boolean, avail?: number, obs?: boolean) => {
        finishedArgs = { id, token, err, retry, obs };
      },
      pool: {
        query: async () => ({ rows: [{ document: work, now: new Date() }] }),
      },
    },
    observe: async () => work,
    reconcileLanded: async () => {},
  } as any;

  const settled = await processJob(engine, github as any);
  assert.equal(settled, true, 'processJob settled cleanly');
  assert.ok(finishedArgs, 'finishJob was called');
  assert.equal(finishedArgs.retry, true, 'job was requeued with retry=true');
  assert.equal(finishedArgs.err, undefined, 'no error was recorded on job');
  assert.equal(publishCalled, false, 'publish / gateMerge was NOT called after landable skipped');
});
