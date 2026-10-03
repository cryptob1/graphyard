import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyBlocker } from '../src/model/blocker-class.js';
import { credentialFailure } from '../src/worker-credential.js';
import { keepBlockedWork } from '../src/cli/lease.js';
import { blockerEscalateMs, blockerProbeConcurrency, blockerStep } from '../src/daemon/cycle-blockers.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1055: the follow-ups from the approved review of GY-1008 (PR #529), each pinned where it was fixed.

test('unit:blocker-followups-classifier — memory, permission and outside-scope texts land in the class that can act on them, every credential failure the engine ends is github-credential, and any commit abbreviation is read', () => {
  // A worker's own build or test running out of memory is about the item; the server's is the plane's.
  for (const text of ['npm run build failed: FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', 'graphyard verify GY-7 failed: the test runner hit ENOMEM'])
    assert.equal(classifyBlocker(text).class, 'genuine', text);
  for (const text of ['complete was refused: the Graphyard server ran out of memory', 'status failed: ENOMEM on the server'])
    assert.equal(classifyBlocker(text).class, 'control-plane-error', text);

  // A permission refusal is a sandbox path only when it names the path; a read-only file system always is.
  for (const text of ['The API returns Permission denied for the reviewer role, so the criterion cannot pass', 'EPERM from the payment sandbox when the test charges a card', 'the feature flag is sandbox-only'])
    assert.equal(classifyBlocker(text).class, 'genuine', text);
  assert.deepEqual(classifyBlocker("touch: cannot touch '/srv/wt/.cache/x': Permission denied").path, '/srv/wt/.cache/x');
  assert.equal(classifyBlocker("touch: cannot touch '/srv/wt/.cache/x': Permission denied").class, 'sandbox-path');
  assert.equal(classifyBlocker('git fetch: Read-only file system').class, 'sandbox-path');

  // A suite failing outside the item stays that, whatever its output says.
  for (const text of ['npm test failed outside plannedFiles: tests/upload.test.ts gets Permission denied writing /tmp/upload', 'npm test fails on main in tests/db.test.ts with ECONNREFUSED'])
    assert.equal(classifyBlocker(text).class, 'outside-scope-test-failure', text);

  // Every credential failure the engine ends an attempt on is classed so its credential probe runs.
  const credentials = ['git push failed: HTTP 401 from github.com', 'The token in /run/gy/hosts.yml is invalid', 'remote: Permission to cryptob1/graphyard.git denied to graphyard-worker.',
    'gh pr create: Bad credentials', 'git push origin: Permission denied (publickey)', 'You are not logged into any GitHub hosts. To log in, run: gh auth login'];
  for (const text of credentials) {
    assert.equal(credentialFailure(text), true, text);
    assert.equal(classifyBlocker(text).class, 'github-credential', text);
  }
  // A product's own 401, or an ssh refusal from a deployment host, is not GitHub's (GY-1066).
  for (const text of ['the integration test expects 200 but the API answers HTTP 401', 'ssh deploy@prod: Permission denied (publickey)']) {
    assert.equal(credentialFailure(text), false, text);
    assert.notEqual(classifyBlocker(text).class, 'github-credential', text);
  }

  // After the word "commit", an all-digit or all-letter abbreviation is a commit too.
  for (const commit of ['1234567', 'abcdefa', '8106499e9f']) {
    const scope = classifyBlocker(`SCOPE NEEDED: src/model/queue.ts for commit ${commit}`);
    assert.deepEqual([scope.class, scope.commit], ['planned-file-scope', commit]);
  }
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('unit:blocker-followups-keep-work — the WIP commit is made only in the registered worktree, is unsigned, and a commit that still fails leaves the next attempt pointed at the worktree', async () => {
  const root = await temporaryDirectory('blocker-followups-keep');
  const registered = join(root, 'registered'), other = join(root, 'other');
  for (const dir of [registered, other]) {
    await mkdir(dir);
    git(dir, 'init', '-q', '-b', 'graphyard/gy-9-1');
    await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n');
    git(dir, 'add', '-A'); git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first');
    // Signing is configured but no key can sign: the WIP commit must not depend on it.
    git(dir, 'config', 'commit.gpgsign', 'true'); git(dir, 'config', 'gpg.program', '/bin/false');
  }
  const work = { key: 'GY-9', workspaces: [{ epoch: 1, branch: 'graphyard/gy-9-1', path: registered }] };

  // Another checkout with the same branch checked out is not the attempt's: nothing is touched.
  await writeFile(join(other, 'a.ts'), 'export const a = 2;\n');
  assert.equal(keepBlockedWork(work, 1, other), null);
  assert.notEqual(git(other, 'status', '--porcelain'), '');

  await writeFile(join(registered, 'a.ts'), 'export const a = 2;\n');
  const kept = keepBlockedWork(work, 1, registered);
  assert.equal(kept?.state, 'committed', kept?.detail);
  assert.equal(git(registered, 'status', '--porcelain'), '');

  // A commit that cannot be made at all (a failing hook would be skipped, so break the index instead).
  await writeFile(join(registered, 'a.ts'), 'export const a = 3;\n');
  await writeFile(join(registered, '.git', 'index.lock'), '');
  const left = keepBlockedWork(work, 1, registered);
  assert.equal(left?.state, 'not-applicable');
  assert.equal(left?.commit, git(registered, 'rev-parse', 'HEAD'), 'the record names the head the changes sit on, so the next request points at them');
  assert.equal(left?.path, registered);
  assert.match(left!.detail, /left in the worktree/);
});

const config = () => masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:1', credentialFile: '/nonexistent/blocker-followups.token', cliPath: 'bin/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1, hostId: 'host', masterAgentName: 'master', workers: [] }) as MasterConfig;

const blocked = (n: number, blocker: string, extra: Partial<Work> = {}) => ({ id: `id-${n}`, key: `GY-${n}`, epoch: 1, stage: 'build', blocker, humanRequest: null, blockerProbe: null,
  lease: null, lastAssignment: { epoch: 1, owner: `worker-${n}` }, workspaces: [{ epoch: 1, host: 'host', path: `/srv/wt/gy-${n}`, branch: `graphyard/gy-${n}-1`, owner: `worker-${n}` }], plannedFiles: [], criteria: [], ...extra }) as unknown as Work;

function cycleOf(open: Work[], effects: Record<string, unknown>, clock: number, state = emptyDaemonState(config())) {
  const performed: any[] = [];
  const cycle = { config: config(), state, effects: { persist: async () => {}, ...effects }, now: () => clock, clock, performed, open, agents: [],
    isolate: async (_kind: string, _item: unknown, _name: string, body: () => Promise<unknown>) => body(), launcher: { busy: () => false } } as unknown as Cycle;
  return { cycle, performed, state };
}

test('unit:blocker-followups-probe-loop — probes run concurrently under a bound and per launch, a probe failing for two hours is reported to the master once, and decision prose with no decision is not cleared', async () => {
  // Five sandbox blockers in distinct worktrees: their probes overlap, never more than the bound at once.
  let active = 0, peak = 0;
  const recorded: { key: string; result: string }[] = [];
  const items = [1, 2, 3, 4, 5].map(n => blocked(n, `git fetch: unable to append to '/srv/wt/gy-${n}/.git/FETCH_HEAD': Read-only file system`));
  const slow = async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 20)); active--; return { probe: 'write', passed: false, detail: 'EROFS' }; };
  await blockerStep(cycleOf(items, { probeBlocker: slow, recordBlockerProbe: async (item: Work, probe: { result: string }) => { recorded.push({ key: item.key, result: probe.result }); } }, Date.now()).cycle);
  assert.equal(recorded.length, 5);
  assert.ok(peak > 1, `independent probes overlap (peak ${peak})`);
  assert.ok(peak <= blockerProbeConcurrency, `at most ${blockerProbeConcurrency} at once (peak ${peak})`);

  // Two items with no workspace on this host, under different principals, are two launches: two probes.
  const probed: string[] = [];
  const homeless = [6, 7].map(n => blocked(n, 'git push failed: HTTP 401 from github.com', { workspaces: [] }));
  await blockerStep(cycleOf(homeless, { probeBlocker: async (item: Work) => { probed.push(item.key); return { probe: 'gh auth status', passed: false, detail: 'no' }; }, recordBlockerProbe: async () => {} }, Date.now()).cycle);
  assert.deepEqual(probed.sort(), ['GY-6', 'GY-7']);

  // A probe that keeps failing is reported to the master once it has failed for two hours, and only once.
  const stuck = blocked(8, 'git push failed: HTTP 401 from github.com');
  const failing = { probeBlocker: async () => ({ probe: 'gh auth status', passed: false, detail: 'token invalid' }), recordBlockerProbe: async () => {} };
  const start = Date.parse('2026-10-03T00:00:00Z');
  const first = cycleOf([stuck], failing, start);
  await blockerStep(first.cycle);
  const reports = (performed: any[]) => performed.filter(action => /reported to the master/.test(action.detail));
  assert.deepEqual(reports(first.performed), []);
  const later = cycleOf([stuck], failing, start + blockerEscalateMs, first.state);
  await blockerStep(later.cycle);
  assert.equal(reports(later.performed).length, 1, 'reported once the probe has failed for the escalation window');
  const again = cycleOf([stuck], failing, start + blockerEscalateMs + 60_000, later.state);
  await blockerStep(again.cycle);
  assert.deepEqual(reports(again.performed), [], 'and not again');

  // "Waiting for approval" on an item with no decision is the master's, never cleared by the loop.
  const prose = blocked(9, 'Waiting for approval from the product owner before I continue');
  assert.equal(classifyBlocker(prose.blocker).class, 'needs-decision');
  const clears: string[] = [];
  const noDecisions = cycleOf([prose], { decisions: async () => ({ decisions: [] }), recordBlockerProbe: async (item: Work, probe: { result: string }) => { clears.push(probe.result); } }, Date.now());
  await blockerStep(noDecisions.cycle);
  assert.equal(clears.length, 0, 'nothing is recorded as passing');
  assert.ok(noDecisions.performed.some(action => /needs the master/.test(action.detail)), 'handed to the master');

  // The same prose clears once a decision it was seen waiting on is judged.
  const decision = { id: '5b1e7c3a-9d2f-4e61-8a0b-2c4d6e8f0a1b', action: 'requirements', input: {}, approvedBy: null };
  let state = 'requested';
  const watched = cycleOf([prose], { decisions: async () => ({ decisions: [{ ...decision, state }] }), recordBlockerProbe: async (_item: Work, probe: { result: string }) => { clears.push(probe.result); } }, Date.now());
  (watched.state.approvals as any)[`watch:${decision.id}`] = { decision: decision.id, settledAt: null };
  await blockerStep(watched.cycle);
  assert.deepEqual(clears, ['fail']);
  state = 'approved';
  await blockerStep(cycleOf([prose], { decisions: async () => ({ decisions: [{ ...decision, state }] }), recordBlockerProbe: async (_item: Work, probe: { result: string }) => { clears.push(probe.result); } }, Date.now(), watched.state).cycle);
  assert.deepEqual(clears, ['fail', 'pass']);
});
