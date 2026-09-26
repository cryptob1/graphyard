import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { CHECK_NAME, GitHub } from '../src/github.js';
import { regressionRefusals } from '../src/regression-guard.js';
import { Refusal, type Observation, type Principal, type Work } from '../src/model.js';

/**
 * GY-744. The landing-regression guard asks git before naming a pull request unlanded: a peer whose
 * head is an ancestor of the base branch tip has landed whatever its item records, none of its files
 * is read as a revert, and its merge is reconciled at once. Before this, a peer merged outside the
 * queue stayed "unlanded" on its item until its own observation came round, and every candidate
 * that had merged main since was refused at `complete` for "reverting" that peer's files.
 */
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const root = sha('root'), peerHead = sha('peer-head'), mainTip = sha('main-tip'), head = sha('worker-head');
// Each commit's full history: main's tip is the peer's merge, and the worker merged main since.
const history: Record<string, string[]> = { [root]: [root], [peerHead]: [peerHead, root], [mainTip]: [mainTip, peerHead, root], [head]: [head, mainTip, peerHead, root] };
// The peer shipped `src/shared.ts` at one blob; a later commit on main (in its merge) moved it on,
// and the worker's head holds main's version: exactly what the base tip holds, not the peer's.
const shipped = sha('shared-by-peer'), current = sha('shared-on-main');
const blobs: Record<string, Record<string, string>> = { [mainTip]: { 'src/shared.ts': current }, [head]: { 'src/shared.ts': current } };
let pg: EmbeddedPostgres, store: Store, engine: Engine;
let serial = 0;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 744;
  pg = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-landing-ancestry-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('landing_ancestry_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/landing_ancestry_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/repo'); engine.submissionObserver = null;
  // The peer merged straight into main: the deployment's direct-merge window owns that merge.
  engine.directMergeEnvironment = { since: '2026-01-01T00:00:00.000Z', until: null, reason: 'test repository merges straight into main', setBy: 'environment', enabledAt: '2026-01-01T00:00:00.000Z', source: 'environment', event: null };
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

/** A GitHub whose base branch tip is the peer's merge commit, with pull requests keyed by number. */
function fakeGitHub(pulls: Record<number, any>) {
  const github = new GitHub({ repository: 'owner/repo', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used-in-adapter-test' });
  github.controlPlaneLogin = async () => 'graphyard-owner-repo[bot]';
  const requests: string[] = [];
  github.request = async (path, method = 'GET') => {
    requests.push(path);
    if (method !== 'GET') return { id: 12 };
    const pull = path.match(/^\/pulls\/(\d+)$/);
    if (pull) return structuredClone(pulls[Number(pull[1])]);
    if (/^\/pulls\/\d+\/files/.test(path)) return path.includes('page=1') || !path.includes('page=') ? pulls[Number(path.split('/')[2])].files : [];
    if (/^\/pulls\/\d+\/reviews/.test(path)) return [];
    if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: mainTip } };
    if (/^\/commits\/[a-f0-9]{40}$/.test(path)) return { sha: path.slice(9), commit: { tree: { sha: sha(`tree-${path.slice(9)}`) } }, parents: [] };
    if (path.startsWith('/compare/')) {
      const [from, to] = path.slice(9).split('?')[0].split('...');
      const ahead = (history[to] ?? [to]).filter(commit => !(history[from] ?? [from]).includes(commit));
      const status = from === to ? 'identical' : (history[to] ?? []).includes(from) ? 'ahead' : (history[from] ?? []).includes(to) ? 'behind' : 'diverged';
      return { status, commits: ahead.map(commit => ({ sha: commit })), total_commits: ahead.length, files: [] };
    }
    if (path.includes('/protection')) return { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
    if (path.startsWith('/contents/')) {
      const target = decodeURIComponent(path.slice(10, path.indexOf('?'))), ref = path.slice(path.indexOf('ref=') + 4);
      const blob = blobs[ref]?.[target];
      if (!blob) throw new Refusal(`GitHub GET ${path} failed (404)`, 502);
      return { type: 'file', sha: blob, path: target };
    }
    if (path.includes('/check-runs')) return { check_runs: [] };
    throw new Error(`Unexpected request ${path}`);
  };
  return { github, requests };
}
const pullRequest = (number: number, sha: string, ref: string, files: any[], merged: string | null) => ({ number, head: { sha, ref, repo: { full_name: 'owner/repo' } }, base: { sha: root, ref: 'main', repo: { full_name: 'owner/repo' } },
  user: { login: 'implementer' }, merged: !!merged, merged_at: merged ? '2026-09-26T17:00:00Z' : null, merge_commit_sha: merged, mergeable: merged ? null : true, draft: false, state: merged ? 'closed' : 'open', created_at: '2026-09-26T16:00:00Z', files });

async function claimed(title: string, plannedFiles: string[]) {
  const n = ++serial;
  let w = await engine.execute(operator, 'create', null, { title, plannedFiles, criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['unit:behaves'] }] }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID()); w = await engine.execute(worker, 'claim', w.id, {}, randomUUID());
  return engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/landing-ancestry-${n}`, branch: `graphyard/landing-${n}` }, randomUUID());
}
/** The peer: submitted, and last observed open, so its item still records it unlanded. */
async function stalePeer(pr: number) {
  let peer = await claimed(`Peer ${pr}`, ['src/shared.ts']);
  peer = await engine.execute(worker, 'submit', peer.id, { epoch: 1, pr }, randomUUID());
  const stale: Observation = { clockOffset: { min: 0, max: 0 }, candidate: { sha: peerHead, baseSha: root, pr, branch: peer.workspaces[0].branch, author: 'implementer' },
    checks: [], reviews: [], protected: true, mergeable: true, merged: false, prState: 'open', draft: false, mergeSha: null, mergedAt: null, baseTip: root, baseTree: sha('tree-root'), files: ['src/shared.ts'],
    scopeFiles: [{ path: 'src/shared.ts', status: 'modified', sha: shipped, baseSha: sha('shared-at-root'), additions: 3, deletions: 1, binary: false }], at: new Date().toISOString() } as Observation;
  peer = await engine.observe(peer.id, peer.revision, stale);
  assert.equal(peer.observation?.merged, false); assert.notEqual(peer.stage, 'done');
  return peer;
}

test('unit:landing-guard-checks-ancestry — a peer recorded unmerged whose PR head is in main\'s history is landed: complete is accepted and no revert is reported', async () => {
  const peer = await stalePeer(291);
  let work = await claimed('Worker change', ['src/own.ts']);
  const { github } = fakeGitHub({
    291: pullRequest(291, peerHead, peer.workspaces[0].branch, [{ filename: 'src/shared.ts', status: 'modified', sha: shipped, additions: 3, deletions: 1 }], mainTip),
    292: pullRequest(292, head, work.workspaces[0].branch, [{ filename: 'src/own.ts', status: 'added', sha: sha('own'), additions: 5, deletions: 0 }], null),
  });
  const all = await store.list();
  const observation = await github.observe({ ...work, submission: { epoch: 1, pr: 292 } }, all);
  // Git decided: the peer's head is on main's tip, so it is landed, not foreign and not carried.
  assert.deepEqual(observation.landing?.landed, [{ key: peer.key, pr: 291, head: peerHead, mergeSha: mainTip }]);
  assert.deepEqual(observation.landing?.foreign, []); assert.deepEqual(observation.landing?.carried, []);
  assert.deepEqual(regressionRefusals(work, observation, all), []);
  // The same observation with the landed answer removed is what the guard used to refuse on.
  const stale = { ...observation, landing: { ...observation.landing!, landed: [], foreign: [{ key: peer.key, pr: 291, head: peerHead }],
    carried: [{ key: peer.key, pr: 291, head: peerHead, dropped: [{ path: 'src/shared.ts', detail: 'the file is held exactly as the commit it would land on holds it' }] }] } };
  assert.match(regressionRefusals(work, stale, all).join('\n'), /unlanded pull request #291/);
  // And a landed answer overrides a stale foreign/carried one the item's record would otherwise support.
  assert.deepEqual(regressionRefusals(work, { ...stale, landing: { ...stale.landing, landed: observation.landing!.landed } }, all), []);

  // `complete` itself: observed through the same adapter, accepted with no revert reported.
  engine.submissionObserver = (probe, peers) => github.observe(probe, peers);
  try {
    work = await engine.execute(worker, 'submit', work.id, { epoch: 1, pr: 292 }, randomUUID());
  } finally { engine.submissionObserver = null; }
  assert.deepEqual(work.submission, { epoch: 1, pr: 292 });
  assert.ok(!work.gates.flatMap(gate => gate.reasons).some(reason => /Landing regression|unlanded|Carried from/.test(reason)), JSON.stringify(work.gates));
});

test('unit:ancestry-landing-reconciled — a delivery detected by ancestry reconciles the owning item at once: delivered, with the merge commit', async () => {
  const peer = await stalePeer(301);
  const work = await claimed('Second worker change', ['src/own.ts']);
  const { github, requests } = fakeGitHub({
    301: pullRequest(301, peerHead, peer.workspaces[0].branch, [{ filename: 'src/shared.ts', status: 'modified', sha: shipped, additions: 3, deletions: 1 }], mainTip),
    302: pullRequest(302, head, work.workspaces[0].branch, [{ filename: 'src/own.ts', status: 'added', sha: sha('own'), additions: 5, deletions: 0 }], null),
  });
  engine.submissionObserver = (probe, peers) => github.observe(probe, peers);
  try {
    await engine.execute(worker, 'submit', work.id, { epoch: 1, pr: 302 }, randomUUID());
  } finally { engine.submissionObserver = null; }
  // The peer's pull request was observed during the submission, not left to its own cadence.
  assert.ok(requests.some(path => path.startsWith('/pulls/301/reviews')), requests.join('\n'));
  const reconciled = (await store.list()).find(item => item.id === peer.id)!;
  assert.equal(reconciled.stage, 'done', JSON.stringify(reconciled.gates));
  assert.equal(reconciled.observation?.merged, true);
  assert.equal(reconciled.delivery?.mergeSha, mainTip);
  // Delivered, it is never named unlanded again: a later observation leaves it out of the peers entirely.
  const again = await github.observe({ ...(await store.list()).find(item => item.id === work.id)!, submission: { epoch: 1, pr: 302 } }, await store.list());
  assert.deepEqual(again.landing?.landed ?? [], []); assert.deepEqual(again.landing?.foreign ?? [], []);
});
