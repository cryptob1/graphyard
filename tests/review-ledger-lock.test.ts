import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { bindReviewer, launchReview, readReviewLedger, reconcileReviews, reviewLedgerLockStaleMs, saveReviewerProfile, updateReviewLedger } from '../src/reviewer.js';
import { reconcileLedgers } from '../src/cli/master-status-pipeline.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1303, 2026-10-05: with the coordinator checkout mounted read-only, every reconcile pass failed
// on the review-ledger lock .graphyard/reviews.json.lock (EROFS) after GY-1301 had moved only the
// follow-up lock, and master status reported runtime.reviews unavailable for over an hour. The lock
// is now taken under the managed data root, and a lock location that cannot be written degrades
// to a lockless read-modify-write by the single writer the coordinator then is.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const H = 'a1'.padEnd(40, 'f'), B = 'b1'.padEnd(40, 'f');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });
const verdict = () => ({ state: 'APPROVED', reviewer: 'graphyard-reviewer[bot]', reviewId: 77, submittedAt: '2026-10-05T12:00:00Z' });
const herdrRun = (_command: string, args: string[]) => startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
const runsAsRoot = process.getuid?.() === 0;

async function boundMaster() {
  const root = await temporaryDirectory('ledger-lock'), credentialDirectory = await temporaryDirectory('ledger-lock-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentialDirectory, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' });
  return { root, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}
function work(): Work {
  const candidate = { sha: H, baseSha: B, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' };
  return { id: 'work-64', key: 'GY-64', title: 'Frobs', description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'The widget counts every frob.', proofs: ['unit:frob-count'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' },
    stage: 'review', revision: 7, policyRevision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stageEnteredAt: new Date().toISOString(), ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 64 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [], at: new Date().toISOString(),
      prState: 'open', draft: false, baseTip: B, baseTree: B, baseTipContained: true }, blocker: null, gates: [], violations: [] } as unknown as Work;
}
/** node:fs/promises with every write to the lock location refused as a read-only mount would. */
async function readOnlyLockFs(at: 'mkdir' | 'open' | 'write', code = 'EROFS') {
  const fs = await import('node:fs/promises');
  const refused = (path: unknown) => Object.assign(new Error(`${code}: read-only file system, open '${String(path)}'`), { code });
  return { ...fs,
    mkdir: (async (path: any, options: any) => { if (at === 'mkdir') throw refused(path); return fs.mkdir(path, options); }) as typeof fs.mkdir,
    open: (async (path: any, flags: any, mode: any) => {
      if (at === 'open') throw refused(path);
      const handle = await fs.open(path, flags, mode);
      if (at === 'write') handle.writeFile = (async () => { throw refused(path); }) as typeof handle.writeFile;
      return handle;
    }) as typeof fs.open };
}
/**
 * Runs `body` as master status runs on the host: GRAPHYARD_DATA_HOME set, and a `gh` on PATH that
 * answers the review list with the reviewer's approval of the head.
 */
async function asMasterStatus<T>(dataHome: string, body: () => Promise<T>): Promise<T> {
  const bin = await temporaryDirectory('ledger-lock-gh');
  const reviews = JSON.stringify([{ id: 77, user: { login: 'graphyard-reviewer[bot]' }, state: 'APPROVED', commit_id: H, submitted_at: new Date(Date.now() + 60_000).toISOString() }]);
  await writeFile(join(bin, 'gh'), `#!/bin/sh\ncase "$*" in *pulls/64/reviews) printf '%s' '${reviews}' ;; *) printf '[]' ;; esac\n`, { mode: 0o755 });
  const was = { data: process.env.GRAPHYARD_DATA_HOME, path: process.env.PATH };
  process.env.GRAPHYARD_DATA_HOME = dataHome;
  process.env.PATH = `${bin}:${was.path}`;
  try { return await body(); }
  finally {
    if (was.data === undefined) delete process.env.GRAPHYARD_DATA_HOME; else process.env.GRAPHYARD_DATA_HOME = was.data;
    process.env.PATH = was.path;
    await rm(bin, { recursive: true, force: true });
  }
}

test('unit:review-ledger-lock-erofs-degrades — a read-only ledger lock location runs the read-modify-write lockless, reconcile completes and master status reports reviews available', async () => {
  const dataHome = await temporaryDirectory('ledger-lock-erofs-data');
  const { root, cleanup } = await boundMaster();
  try {
    // The reported fault: the lock file's open fails EROFS; or its directory cannot be made; or the lock cannot be written once open.
    for (const at of ['open', 'mkdir', 'write'] as const) for (const code of ['EROFS', 'EACCES', 'EPERM']) {
      const reasons: string[] = [];
      const result = await updateReviewLedger(root, () => 'applied', { environment: { GRAPHYARD_DATA_HOME: dataHome }, fs: await readOnlyLockFs(at, code), onLockless: reason => reasons.push(reason) });
      assert.equal(result, 'applied', `${at}/${code}: the change runs`);
      assert.equal(reasons.length, 1, `${at}/${code}: the pass says it ran lockless`);
      assert.match(reasons[0]!, new RegExp(`review ledger lock .*review-ledger.*${code}`));
    }
    assert.equal(existsSync(join(root, '.graphyard', 'reviews.json.lock')), false, 'nothing is ever written beside the ledger');

    // A reconcile pass that records a verdict saves it although its lock location is read-only.
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => [] });
    const config = await loadMasterConfig(root);
    const reasons: string[] = [];
    const ledgerLock = { environment: { GRAPHYARD_DATA_HOME: dataHome }, fs: await readOnlyLockFs('open'), onLockless: (reason: string) => reasons.push(reason) };
    const settled = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), ledgerLock });
    assert.equal(settled.changed > 0, true);
    assert.equal(settled.reviews[0]!.verdict?.state, 'APPROVED', 'the verdict reconciles');
    assert.equal((await readReviewLedger(root)).reviews[0]!.verdict?.state, 'APPROVED', 'and is on the saved ledger');
    assert.match(reasons.join('\n'), /EROFS/);

    // Any other lock failure is still a failure, not a silent lockless pass.
    await assert.rejects(updateReviewLedger(root, () => {}, { environment: { GRAPHYARD_DATA_HOME: dataHome }, fs: await readOnlyLockFs('open', 'EIO') }), /EIO/);

    if (!runsAsRoot) {
      // Master status, on a real filesystem: the managed data root is unwritable, so the lock cannot be made there.
      const readOnlyHome = await temporaryDirectory('ledger-lock-readonly-home');
      await chmod(readOnlyHome, 0o500);
      try {
        await asMasterStatus(join(readOnlyHome, 'graphyard'), async () => {
          const ledger = await readReviewLedger(root);
          await updateReviewLedger(root, current => { current.reviews = ledger.reviews.map(record => ({ ...record, state: 'pending', verdict: undefined, closedAt: undefined })); }, { environment: { GRAPHYARD_DATA_HOME: dataHome } });
          const status = await reconcileLedgers(root, config, { work: [] }, { available: false });
          assert.deepEqual(status.reviewRuntime, { available: true, reason: null }, 'master status reports runtime.reviews available');
          assert.equal(status.reviewRecords[0]!.verdict?.state, 'APPROVED', 'and the verdict reconciled');

          // The ledger itself unwritable (the whole checkout read-only): the pass still completes, returns the
          // reconciled records and says they were left unsaved; it never reports the capability unavailable.
          await updateReviewLedger(root, current => { current.reviews = ledger.reviews.map(record => ({ ...record, state: 'pending', verdict: undefined, closedAt: undefined })); }, { environment: { GRAPHYARD_DATA_HOME: dataHome } });
          await chmod(join(root, '.graphyard'), 0o500);
          try {
            const unsaved = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict() });
            assert.equal(unsaved.reviews[0]!.verdict?.state, 'APPROVED');
            assert.match((unsaved as { unsaved?: string }).unsaved ?? '', /review ledger .*cannot be written \(EACCES/);
            const readOnlyStatus = await reconcileLedgers(root, config, { work: [] }, { available: false });
            assert.equal(readOnlyStatus.reviewRuntime.available, true);
          } finally { await chmod(join(root, '.graphyard'), 0o700); }
        });
      } finally { await chmod(readOnlyHome, 0o700); await rm(readOnlyHome, { recursive: true, force: true }); }
    }
  } finally { await cleanup(); await rm(dataHome, { recursive: true, force: true }); }
});

test('unit:review-ledger-lock-writable-root — the ledger lock is taken under the managed data root, serializes writers, waits out a held lock and is released on success and failure', async () => {
  const dataHome = await temporaryDirectory('ledger-lock-data'), root = await temporaryDirectory('ledger-lock-checkout');
  const environment = { GRAPHYARD_DATA_HOME: dataHome };
  const lockFiles = async () => existsSync(join(dataHome, 'review-ledger')) ? (await readdir(join(dataHome, 'review-ledger'))).map(name => join(dataHome, 'review-ledger', name)) : [];
  try {
    // Held during the change, under the data root and keyed by the checkout; never beside the ledger.
    let held: string[] = [];
    await updateReviewLedger(root, async () => { held = await lockFiles(); }, { environment });
    assert.equal(held.length, 1);
    assert.match(held[0]!, new RegExp(`^${dataHome}/review-ledger/[0-9a-f]{12}\\.lock$`));
    assert.equal(existsSync(join(root, '.graphyard', 'reviews.json.lock')), false);
    assert.ok(existsSync(join(root, '.graphyard', 'reviews.json')), 'the ledger is still written in the checkout');
    assert.deepEqual(await lockFiles(), [], 'released on completion');
    // Another checkout on the same host keeps its own lock.
    const other = await temporaryDirectory('ledger-lock-other');
    try {
      let both: string[] = [];
      await updateReviewLedger(root, async () => { await updateReviewLedger(other, async () => { both = await lockFiles(); }, { environment }); }, { environment });
      assert.equal(new Set(both).size, 2);
    } finally { await rm(other, { recursive: true, force: true }); }

    // Released on failure, and the failure propagates.
    await assert.rejects(updateReviewLedger(root, () => { throw new Error('change failed'); }, { environment }), /change failed/);
    assert.deepEqual(await lockFiles(), []);

    // One writer per read-modify-write: concurrent updates never overlap.
    let active = 0, peak = 0;
    await Promise.all(Array.from({ length: 5 }, () => updateReviewLedger(root, async () => { active++; peak = Math.max(peak, active); await new Promise(done => setTimeout(done, 30)); active--; }, { environment })));
    assert.equal(peak, 1);

    // A live holder's lock is waited out until the deadline, then the write is refused.
    let lock = '';
    await updateReviewLedger(root, async () => { [lock] = await lockFiles(); }, { environment });
    await writeFile(lock, `${process.pid} ${Date.now()}`, { mode: 0o600 });
    await assert.rejects(updateReviewLedger(root, () => {}, { environment, waitMs: 150 }), /review ledger lock .* is held by process/);
    // A holder releasing within the deadline lets the waiter through.
    setTimeout(() => { rm(lock, { force: true }).catch(() => {}); }, 100);
    assert.equal(await updateReviewLedger(root, () => 'waited', { environment, waitMs: 5_000 }), 'waited');
    // A stale or dead holder's lock is broken.
    await writeFile(lock, `${process.pid} ${Date.now() - reviewLedgerLockStaleMs - 1_000}`, { mode: 0o600 });
    assert.equal(await updateReviewLedger(root, () => 'stale broken', { environment, waitMs: 150 }), 'stale broken');
    await writeFile(lock, `999999999 ${Date.now()}`, { mode: 0o600 });
    assert.equal(await updateReviewLedger(root, () => 'dead broken', { environment, waitMs: 150 }), 'dead broken');
    assert.deepEqual(await lockFiles(), []);
    assert.equal(await readFile(join(root, '.graphyard', 'reviews.json'), 'utf8').then(text => JSON.parse(text).version), 1);
  } finally { await rm(dataHome, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});
