import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Principal, Work } from '../src/model.js';
import { controlPlaneSyncPush, syncPushBodyLimit, syncPushTooLarge, type GitDataApi } from '../src/sync.js';
import { baseWorkflowChanges } from '../src/cli/workspace.js';
import { workRoutes } from '../src/server/routes/work.js';
import { matchRoute, type RouteContext } from '../src/server/routes.js';
import { Refusal } from '../src/model.js';
import { describeSyncCommit, gitDateToIso } from '../src/cli/sync-push.js';
import { controlPlanePermissions, permissionTable, requiredPermissions } from '../src/github-permissions.js';
import { workerPushPermissions } from '../src/worker-credential.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1098: since GY-1093 changed .github/workflows on main, every worker whose branch merged
// origin/main was refused "refusing to allow a GitHub App to create or update workflow … without
// workflows permission": worker push credentials never carry workflows. The control plane now
// pushes such a base sync itself, guarded. One section per proof:
// unit:workflow-sync-push-guarded, unit:workflow-sync-push-attributed.

const branch = 'graphyard/gy-1098-1';
const worker: Principal = { id: 'worker-a', role: 'worker' } as Principal;

/**
 * GitHub's Git Data API over a real bare repository: blobs, trees built on a base tree, commits
 * with explicit people and dates, refs moved only by fast-forward unless forced. What it builds is
 * real git, so a rebuilt commit has the named sha only when the request describes it exactly.
 */
function fakeGitHub(origin: string): GitDataApi & { calls: string[] } {
  const git = (args: string[], input?: Buffer | string, env: Record<string, string> = {}) => execFileSync('git', args, { cwd: origin, input, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] }).toString('utf8').trim();
  const has = (args: string[]) => { try { git(args); return true; } catch { return false; } };
  const fromIso = (date: string) => { const zone = date.slice(19).replace(':', ''); return `${Date.parse(date) / 1000} ${zone}`; };
  const calls: string[] = [];
  return {
    calls, config: { base: 'main' },
    async request(path: string, method = 'GET', body?: any) {
      calls.push(`${method} ${path}`);
      let match: RegExpMatchArray | null;
      if (method === 'GET' && (match = path.match(/^\/git\/ref\/heads\/(.+)$/))) {
        const ref = `refs/heads/${decodeURIComponent(match[1])}`;
        if (!has(['rev-parse', '--verify', '-q', ref])) throw new Error(`GET ${path} (404)`);
        return { object: { sha: git(['rev-parse', ref]) } };
      }
      if (method === 'GET' && (match = path.match(/^\/compare\/([0-9a-f]{40})\.\.\.(.+)$/))) {
        const head = git(['rev-parse', decodeURIComponent(match[2])]);
        return { status: head === match[1] ? 'identical' : has(['merge-base', '--is-ancestor', match[1], head]) ? 'ahead' : 'diverged' };
      }
      if (method === 'GET' && (match = path.match(/^\/git\/commits\/([0-9a-f]{40})$/))) return { tree: { sha: git(['rev-parse', `${match[1]}^{tree}`]) } };
      if (method === 'POST' && path === '/git/blobs') return { sha: git(['hash-object', '-w', '--stdin'], Buffer.from(body.content, 'base64')) };
      if (method === 'POST' && path === '/git/trees') {
        const index = join(origin, `index-${calls.length}`);
        const env = { GIT_INDEX_FILE: index };
        git(['read-tree', body.base_tree], undefined, env);
        git(['update-index', '--index-info'], body.tree.map((entry: any) => entry.sha ? `${entry.mode} ${entry.sha}\t${entry.path}` : `0 ${'0'.repeat(40)}\t${entry.path}`).join('\n') + '\n', env);
        const sha = git(['write-tree'], undefined, env);
        await rm(index, { force: true });
        return { sha };
      }
      if (method === 'POST' && path === '/git/commits') {
        const sha = git(['commit-tree', body.tree, ...body.parents.flatMap((parent: string) => ['-p', parent]), '-F', '-'], body.message, {
          GIT_AUTHOR_NAME: body.author.name, GIT_AUTHOR_EMAIL: body.author.email, GIT_AUTHOR_DATE: fromIso(body.author.date),
          GIT_COMMITTER_NAME: body.committer.name, GIT_COMMITTER_EMAIL: body.committer.email, GIT_COMMITTER_DATE: fromIso(body.committer.date),
        });
        return { sha };
      }
      if (method === 'PATCH' && (match = path.match(/^\/git\/refs\/heads\/(.+)$/))) {
        const ref = `refs/heads/${decodeURIComponent(match[1])}`, current = git(['rev-parse', ref]);
        if (!body.force && !has(['merge-base', '--is-ancestor', current, body.sha])) throw new Error(`PATCH ${path} (422): Update is not a fast forward`);
        git(['update-ref', ref, body.sha]);
        return { object: { sha: body.sha } };
      }
      throw new Error(`Unexpected ${method} ${path}`);
    },
  };
}

function item(overrides: Partial<Work> = {}): Work {
  const at = new Date().toISOString();
  return { id: 'work-1098', key: 'GY-1098', title: 'Workflow sync push', description: '', type: 'feature', priority: 1, dependencies: [], plannedFiles: ['src/feature.ts'],
    criteria: [], policy: { checks: ['test'], review: true }, stage: 'build', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1,
    lease: { owner: worker.id, epoch: 1, expiresAt: new Date(Date.now() + 600_000).toISOString() }, workspaces: [{ host: 'test', path: '/w', branch, epoch: 1, owner: worker.id }],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], ...overrides } as Work;
}
/** The store slice the push uses: the item, and the history rows it appends. */
function store(work: Work) {
  const events: { workId: string; actor: string; kind: string; payload: any }[] = [];
  return { events, engine: { store: { list: async () => [work], transaction: async (fn: any) => fn({ query: async (_sql: string, [workId, actor, kind, payload]: any[]) => { events.push({ workId, actor, kind, payload: JSON.parse(payload) }); } }, new Date()) } as any } };
}

/**
 * main carries a workflow and a source file; the worker's branch is pushed; then main changes the
 * workflow (as GY-1093 did) and the source file, and the worker merges origin/main resolving the
 * source conflict by hand — a blob neither parent holds. Dates carry a non-UTC zone.
 */
async function stranded() {
  const directory = await temporaryDirectory('sync-workflow-push');
  const origin = join(directory, 'origin.git'), work = join(directory, 'worker');
  const env = { ...process.env, GIT_AUTHOR_DATE: '1790000000 +0530', GIT_COMMITTER_DATE: '1790000100 -0700' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: work, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const bytes = (...args: string[]) => execFileSync('git', args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  execFileSync('git', ['clone', '--quiet', origin, work], { stdio: 'ignore' });
  git('config', 'user.email', 'worker@example.com'); git('config', 'user.name', 'Worker'); git('config', 'commit.gpgsign', 'false'); git('checkout', '--quiet', '-B', 'main');
  await mkdir(join(work, '.github/workflows'), { recursive: true }); await mkdir(join(work, 'src'), { recursive: true });
  const write = (path: string, text: string) => writeFile(join(work, path), text);
  await write('.github/workflows/ci.yml', 'name: ci\njobs: {}\n'); await write('src/feature.ts', 'export const a = 1;\n'); await write('src/old.ts', 'old\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'Initial'); git('push', '--quiet', 'origin', 'main');
  git('checkout', '--quiet', '-b', branch);
  await write('src/feature.ts', 'export const a = 2;\n'); git('commit', '--quiet', '-am', 'Worker change'); git('push', '--quiet', 'origin', branch);
  git('checkout', '--quiet', 'main');
  await write('.github/workflows/ci.yml', 'name: ci\njobs: { fast: {} }\n'); await write('.github/workflows/rc.yml', 'name: rc\n'); await write('src/feature.ts', 'export const a = 3;\n'); git('rm', '--quiet', 'src/old.ts');
  git('add', '.'); git('commit', '--quiet', '-m', 'Main changes workflows'); git('push', '--quiet', 'origin', 'main');
  git('checkout', '--quiet', branch);
  try { git('merge', '--no-edit', 'origin/main'); } catch { /* the source conflict is resolved by hand below */ }
  await write('src/feature.ts', 'export const a = 2 + 3;\n'); git('add', 'src/feature.ts'); git('commit', '--quiet', '--no-edit');
  return { directory, origin, git, bytes, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
const rejects = async (promise: Promise<unknown>, pattern: RegExp) => { await assert.rejects(promise, (error: Error) => { assert.match(error.message, pattern); return true; }); };

test('unit:workflow-sync-push-guarded — a base sync that only carries main\'s workflow changes is pushed by the control plane; anything else is refused naming the differing paths', async () => {
  const { origin, git, bytes, cleanup } = await stranded();
  try {
    const github = fakeGitHub(origin);
    const remote = () => execFileSync('git', ['rev-parse', `refs/heads/${branch}`], { cwd: origin, encoding: 'utf8' }).trim();
    const pushed = remote(), merge = git('rev-parse', 'HEAD');
    const request = describeSyncCommit(git, bytes, merge, 1);
    assert.deepEqual(request.parents, [pushed, git('rev-parse', 'origin/main')]);
    assert.deepEqual(request.entries.map(entry => [entry.path, entry.sha === null]), [['src/feature.ts', false]], 'the entries are what the commit changes against the base it merged: only the resolved source');
    assert.equal(request.blobs.length, 1, 'only the hand-resolved blob, which neither parent holds, is sent');
    assert.equal(request.author.date, gitDateToIso('1790000000', '+0530'));

    // A merge that edits a workflow beyond the base is refused naming the path, and nothing moves.
    git('checkout', '--quiet', '-b', 'tampered', merge);
    execFileSync('sh', ['-c', 'printf "name: ci\\njobs: { fast: {}, extra: {} }\\n" > .github/workflows/ci.yml'], { cwd: git('rev-parse', '--show-toplevel') });
    git('commit', '--quiet', '--amend', '-a', '--no-edit');
    const tampered = describeSyncCommit(git, bytes, git('rev-parse', 'HEAD'), 1);
    const withGitHub = (work: Work) => ({ ...store(work), github });
    let { events, engine } = store(item());
    await rejects(controlPlaneSyncPush({ engine, github }, worker, 'GY-1098', tampered), /changes workflow files beyond origin\/main outside plannedFiles.*: \.github\/workflows\/ci\.yml$/);
    assert.equal(remote(), pushed, 'a refused push leaves the branch where it was');
    assert.equal(events[0].kind, 'sync.workflow-push.refused'); assert.deepEqual(events[0].payload.workflowPaths, ['.github/workflows/ci.yml']);

    // An entry list that hides the workflow edit cannot rebuild the commit: its tree differs.
    const hidden = { ...tampered, entries: tampered.entries.filter(entry => !entry.path.startsWith('.github/')) };
    await rejects(controlPlaneSyncPush(withGitHub(item()), worker, 'GY-1098', hidden), /the entries do not describe the commit/);
    assert.equal(remote(), pushed);
    // GitHub applies a directory-level entry to its whole subtree, so deleting or replacing
    // `.github/workflows` or `.github` is a workflow change, refused even with every workflow file
    // planned; a path GitHub might resolve elsewhere is refused before it is judged.
    const allPlanned = item({ plannedFiles: ['src/feature.ts', '.github/workflows/ci.yml', '.github/workflows/rc.yml'] });
    for (const entry of [{ path: '.github/workflows', mode: '100644', type: 'blob', sha: null }, { path: '.github', mode: '160000', type: 'commit', sha: pushed }] as const) {
      ({ events, engine } = store(allPlanned));
      await rejects(controlPlaneSyncPush({ engine, github }, worker, 'GY-1098', { ...request, entries: [...request.entries, entry] }), new RegExp(`outside plannedFiles, so it is not a pure base sync: ${entry.path.replace('.', '\\.')}$`));
      assert.deepEqual(events[0].payload.workflowPaths, [entry.path]);
    }
    for (const path of ['.github/./workflows/ci.yml', '.github//workflows/ci.yml', 'src/../.github/workflows/ci.yml', '/.github/workflows/ci.yml']) {
      await rejects(controlPlaneSyncPush(withGitHub(allPlanned), worker, 'GY-1098', { ...request, entries: [...request.entries, { path, mode: '100644', type: 'blob', sha: null }] }), /entries that are not file-level paths/);
    }
    assert.equal(remote(), pushed);
    // A workflow path in plannedFiles is the item's own change, so that same commit is allowed.
    ({ events, engine } = store(item({ plannedFiles: ['src/feature.ts', '.github/workflows/ci.yml'] })));
    const own = await controlPlaneSyncPush({ engine, github }, worker, 'GY-1098', tampered);
    assert.equal(remote(), tampered.commit); assert.deepEqual(own.workflowPaths, ['.github/workflows/ci.yml']);
    execFileSync('git', ['update-ref', `refs/heads/${branch}`, pushed], { cwd: origin });

    // A commit that is not a merge, one whose first parent is not the branch head, and one whose
    // second parent is not in origin/main are each refused before anything is written.
    git('checkout', '--quiet', branch);
    await rejects(controlPlaneSyncPush(withGitHub(item()), worker, 'GY-1098', describeSyncCommit(git, bytes, pushed, 1)), /is not a base sync: it has 1 parent/);
    await rejects(controlPlaneSyncPush(withGitHub(item()), worker, 'GY-1098', { ...request, parents: [request.parents[1], request.parents[0]] }), /does not fast-forward graphyard\/gy-1098-1/);
    git('checkout', '--quiet', '-b', 'side', 'origin/main'); git('commit', '--quiet', '--allow-empty', '-m', 'Not on main');
    const side = git('rev-parse', 'HEAD');
    git('checkout', '--quiet', '-b', 'off-base', pushed); git('merge', '--quiet', '--no-edit', '-s', 'ours', side);
    await rejects(controlPlaneSyncPush(withGitHub(item()), worker, 'GY-1098', describeSyncCommit(git, bytes, git('rev-parse', 'HEAD'), 1)), /does not merge origin\/main: its second parent .* is not in origin\/main/);
    assert.equal(remote(), pushed);
    assert.equal(github.calls.filter(call => call.startsWith('PATCH')).length, 1, 'only the allowed plannedFiles push moved a ref');

    // Only the lease holder may ask, for its own epoch's branch.
    await rejects(controlPlaneSyncPush(withGitHub(item()), { id: 'master', role: 'coordinator' } as Principal, 'GY-1098', request), /Only the worker holding the item's lease/);
    await rejects(controlPlaneSyncPush(withGitHub(item()), worker, 'GY-1098', { ...request, epoch: 2 }), /Lease missing, expired, or superseded/);
    await rejects(controlPlaneSyncPush(withGitHub(item({ lease: { owner: 'worker-b', epoch: 1, expiresAt: new Date(Date.now() + 600_000).toISOString() } as Work['lease'] })), worker, 'GY-1098', request), /Lease missing/);

    // The pure base sync: main's own workflow changes are carried and the branch fast-forwards to the named commit.
    const outcome = await controlPlaneSyncPush(withGitHub(item()), worker, 'GY-1098', request);
    assert.equal(remote(), merge, 'the branch now holds exactly the worker\'s merge commit');
    assert.deepEqual({ ...outcome }, { key: 'GY-1098', epoch: 1, worker: 'worker-a', branch, baseBranch: 'main', commit: merge, from: pushed, base: request.parents[1], workflowPaths: [], pushed: true });
  } finally { await cleanup(); }
});

test('unit:workflow-sync-push-attributed — the App declares workflows: write, worker credentials carry exactly workerPushPermissions, and the push lands in the item history under the worker and epoch', async () => {
  assert.equal(requiredPermissions(controlPlanePermissions).workflows, 'write');
  assert.deepEqual(controlPlanePermissions.filter(requirement => requirement.permission === 'workflows').map(requirement => requirement.feature), ['workflow-sync'], 'the base sync is the only reason for Workflows: write');
  assert.match(permissionTable(controlPlanePermissions), /\| Workflows \| Read and write \| push base syncs carrying/);
  assert.deepEqual({ ...workerPushPermissions }, { contents: 'write', pull_requests: 'write', workflows: 'write' }, 'a worker push credential carries contents, pull requests and workflows write');

  const { origin, git, bytes, cleanup } = await stranded();
  try {
    const { events, engine } = store(item());
    const request = describeSyncCommit(git, bytes, git('rev-parse', 'HEAD'), 1);
    await controlPlaneSyncPush({ engine, github: fakeGitHub(origin) }, worker, 'GY-1098', request);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, 'sync.workflow-push'); assert.equal(event.workId, 'work-1098'); assert.equal(event.actor, 'worker-a');
    assert.equal(event.payload.worker, 'worker-a'); assert.equal(event.payload.epoch, 1);
    assert.equal(event.payload.branch, branch); assert.equal(event.payload.commit, request.commit);
    assert.equal(event.payload.from, request.parents[0]); assert.equal(event.payload.base, request.parents[1]);
    assert.ok(Number.isFinite(Date.parse(event.payload.at)));
  } finally { await cleanup(); }
});

test('manual:review-followups-triaged GY-1203 — sync names the control-plane push when its merge carries the base\'s workflow changes, and an oversized sync-push is refused by size, not by a generic parse error', async () => {
  const { git, cleanup } = await stranded();
  try {
    const cwd = git('rev-parse', '--show-toplevel');
    const quietly = (...args: string[]) => { const result = spawnSync('git', args, { cwd, encoding: 'utf8' }); return { status: result.status, stdout: result.stdout }; };
    assert.deepEqual(baseWorkflowChanges(quietly, git('rev-parse', 'HEAD')), ['.github/workflows/ci.yml', '.github/workflows/rc.yml'], 'the merge takes both workflow files from main');
    assert.deepEqual(baseWorkflowChanges(quietly, git('rev-parse', 'HEAD^1')), [], 'a plain commit carries no base workflow changes');
  } finally { await cleanup(); }

  assert.match(syncPushTooLarge(), /exceeds the 64 MiB the control plane reads/);
  assert.match(syncPushTooLarge(syncPushBodyLimit + 1), /\(65 MiB\) exceeds the 64 MiB/);
  const route = workRoutes.routes.find(candidate => matchRoute(candidate, 'POST', '/api/work/GY-1098/sync-push'))!;
  let limit: number | undefined;
  const context = { actor: worker, body: async (bytes?: number) => { limit = bytes; throw new Refusal('Request exceeds size limit', 413); } } as unknown as RouteContext;
  await assert.rejects(route.handle(context, ['GY-1098']), (error: Refusal) => { assert.equal(error.status, 413); assert.equal(error.message, syncPushTooLarge()); return true; });
  assert.equal(limit, syncPushBodyLimit);
});
