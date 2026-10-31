import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readServeRecord } from '../src/serve-app.js';
import { mergeWriterIdle, mergeWriterStateSchema, mergeWriterStep, mergeWriterSummary, emptyMergeWriterState, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { daemonEffects } from '../src/daemon/effects-production.js';
import { masterConfigSchema } from '../src/master.js';
import type { Cycle } from '../src/daemon/cycle.js';
import { relandItemFor, runServeRevert, selectServeCulprit, serveRangeCommits, type RelandInput, type ServeRevertPorts } from '../src/merge-writer/serve-revert.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { baseFailureHoldMs } from '../src/merge-writer/executor.js';
import { mergeWriterInFlight } from '../src/daemon/cycle-merge-writer.js';
import { TrialTimeoutError } from '../src/merge-writer/trial.js';
import { createSchema } from '../src/model/work.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2990: one failing item comes back out. With two merges since the last verified commit and a
// required case failing on the served commit, the merge writer pushes a revert of exactly the
// item that broke it (the one whose own e2e: proof names the failing case, else the newest
// merge), the other merge stays on main, and the loop files one Re-land item carrying the
// original criteria and the failing case. Each case below drives the flow on a temporary
// repository and a served.json fixture read through the serve record the deploy unit writes.

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't@t', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const gitEnv = (cwd: string, args: string[], extra: Record<string, string>) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, ...extra } }).trim();

const passTrial = { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {} } as unknown as MergeTrialRun;

function item(key: string, title: string, proofs: string[], mergeSha: string | null): Work {
  return { id: `work-${key}`, key, title, description: `${title} change`, type: 'feature', priority: 2,
    criteria: [{ id: 'AC-1', text: `${title} works`, proofs }],
    mergeLedger: { mergeSha } as unknown as Work['mergeLedger'],
  } as unknown as Work;
}

/** A temporary origin with a base commit and two merge commits on main, plus a coordinator checkout. */
async function fixture(label: string) {
  const base = await temporaryDirectory(label);
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), coordinator = join(base, 'coordinator');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, pusher);
  git(pusher, 'config', 'user.email', 't@t');
  git(pusher, 'config', 'user.name', 't');
  const write = async (files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) { await mkdir(join(pusher, name, '..'), { recursive: true }); await writeFile(join(pusher, name), text); }
    git(pusher, 'add', '.');
  };
  await write({ 'keep.txt': 'keep\n' });
  git(pusher, 'commit', '-q', '-m', 'base');
  git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  const verified = git(pusher, 'rev-parse', 'HEAD');
  git(pusher, 'checkout', '-q', '-b', 'item-a');
  await write({ 'a.txt': 'alpha\n' });
  git(pusher, 'commit', '-q', '-m', 'alpha');
  git(pusher, 'checkout', '-q', 'main');
  git(pusher, 'merge', '-q', '--no-ff', '-m', 'Merge GY-3001: alpha page', 'item-a');
  git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  const mergeA = git(pusher, 'rev-parse', 'HEAD');
  git(pusher, 'checkout', '-q', '-b', 'item-b');
  await write({ 'b.txt': 'beta\n' });
  git(pusher, 'commit', '-q', '-m', 'beta');
  git(pusher, 'checkout', '-q', 'main');
  git(pusher, 'merge', '-q', '--no-ff', '-m', 'Merge GY-3002: beta page', 'item-b');
  git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  const served = git(pusher, 'rev-parse', 'HEAD');
  git(base, 'clone', '-q', origin, coordinator);
  // Nothing lands after the second merge, so the served tip is its merge commit.
  const work = [
    item('GY-3001', 'alpha page', ['unit:alpha', 'e2e:case-alpha'], mergeA),
    item('GY-3002', 'beta page', ['unit:beta', 'e2e:case-beta'], served),
  ];
  return { base, origin, coordinator, verified, mergeA, served, work };
}

/** The served.json fixture the deploy unit's serve pass would have written for a passing serve: the baseline a later failure measures from. */
async function servedBaseline(coordinator: string, serve: string) {
  const file = join(coordinator, '.graphyard', 'served.json');
  await mkdir(join(coordinator, '.graphyard'), { recursive: true });
  await writeFile(file, JSON.stringify({ commit: serve, url: 'http://127.0.0.1:9', failed: null, reason: null, pid: null, started: null,
    check: { verified: true, case: null, step: null, reason: null } }));
}

/** The served.json fixture the deploy unit's serve pass would have written for a failing serve. */
async function servedFixture(coordinator: string, serve: string, failingCase: string) {
  const file = join(coordinator, '.graphyard', 'served.json');
  await mkdir(join(coordinator, '.graphyard'), { recursive: true });
  await writeFile(file, JSON.stringify({ commit: serve, url: 'http://127.0.0.1:9', failed: null, reason: null, pid: null, started: null,
    check: { verified: false, case: failingCase, step: 'step 1 ready', reason: 'wanted 200, got 404' } }));
  const record = readServeRecord(file);
  assert.ok(record?.commit === serve && record.check && !record.check.verified && record.check.case === failingCase);
  return { serve, failingCase, failingStep: record.check.step, failingReason: record.check.reason };
}

const tipOf = (origin: string) => git(origin, 'rev-parse', 'main');
const show = (origin: string, rev: string, path: string) => { try { return execFileSync('git', ['--git-dir', origin, 'show', `${rev}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return null; } };

/** Ports over the fixture: real git in the coordinator checkout, a stub trial, a leased push to the temp origin, a capturing file. */
function ports(coordinator: string, origin: string, trial: MergeTrialRun | null, filed: RelandInput[]): ServeRevertPorts {
  return {
    git: async (args, extra) => gitEnv(coordinator, ['-C', coordinator, ...args], extra ?? {}),
    trial: async () => { if (!trial) throw new Error('no verdict'); return trial; },
    push: async (revertSha, baseTip) => {
      if (tipOf(origin) !== baseTip) return 'rejected';
      git(coordinator, 'push', '-q', 'origin', `${revertSha}:main`);
      return 'pushed';
    },
    file: async input => { filed.push(input); return { key: 'GY-3003' }; },
  };
}

test('unit:revert-only-the-failing-item — the served commit fails the case one item names: only its merge is reverted, the other stays, and the re-land carries its criteria and the case', async t => {
  const { base, origin, coordinator, verified, mergeA, served, work } = await fixture('serve-revert-culprit');
  t.after(() => rm(base, { recursive: true, force: true }));
  const failing = await servedFixture(coordinator, served, 'case-beta');

  // The range holds both merges, oldest first; the culprit is the item whose e2e: proof names the failing case.
  const range = await serveRangeCommits(async args => git(coordinator, ...args), verified, served);
  assert.deepEqual(range.map(commit => commit.sha), [mergeA, served]);
  assert.deepEqual(selectServeCulprit(range, work, 'case-beta'), { item: work[1], mergeSha: served, before: mergeA, subject: 'Merge GY-3002: beta page' });

  const filed: RelandInput[] = [];
  const result = await runServeRevert(ports(coordinator, origin, passTrial, filed),
    { ...failing, lastVerified: verified, baseTip: served, baseBranch: 'main', work });
  assert.equal(result.outcome, 'reverted');
  assert.equal(result.outcome === 'reverted' && result.culprit.key, 'GY-3002');
  const revertSha = result.outcome === 'reverted' ? result.revertSha : '';

  // The revert was pushed: main is the revert, whose message names the reverted merge.
  assert.equal(tipOf(origin), revertSha);
  assert.match(git(origin, 'log', '-1', '--format=%s', revertSha), /^Revert "Merge GY-3002: beta page"$/);
  // Exactly that item's merge came back out: its file is gone, the other merge's file stays.
  assert.equal(show(origin, revertSha, 'b.txt'), null);
  assert.equal(show(origin, revertSha, 'a.txt'), 'alpha\n');
  assert.equal(show(origin, revertSha, 'keep.txt'), 'keep\n');

  // The loop filed one Re-land item carrying the original criteria plus the failing case, linked to GY-3002 and the failing serve.
  assert.equal(filed.length, 1);
  const reland = filed[0]!;
  assert.equal(reland.title, 'Re-land GY-3002: beta page');
  assert.deepEqual(reland.dependencies, [work[1]!.id]);
  assert.deepEqual(reland.criteria.map(criterion => criterion.id), ['AC-1', 'AC-2']);
  assert.deepEqual(reland.criteria[0], { id: 'AC-1', text: 'beta page works', proofs: ['unit:beta', 'e2e:case-beta'] });
  assert.deepEqual(reland.criteria[1]!.proofs, ['e2e:case-beta']);
  assert.match(reland.criteria[1]!.text, /case-beta/);
  assert.match(reland.description, /GY-3002/);
  assert.match(reland.description, new RegExp(served.slice(0, 12)));
  assert.equal(result.outcome === 'reverted' && result.reland, 'GY-3003');
  assert.deepEqual(relandItemFor(work[1]!, { ...failing, mergeSha: served, baseBranch: 'main' }).title, reland.title);
});

test('unit:revert-only-the-failing-item — the failing case names the older item, and an unnamed case falls back to the newest merge', async t => {
  const { base, origin, coordinator, verified, mergeA, served, work } = await fixture('serve-revert-selection');
  t.after(() => rm(base, { recursive: true, force: true }));
  const range = await serveRangeCommits(async args => git(coordinator, ...args), verified, served);

  // The older item's proof names the failing case: the older merge is the culprit, not the newest.
  assert.deepEqual(selectServeCulprit(range, work, 'case-alpha'), { item: work[0], mergeSha: mergeA, before: verified, subject: 'Merge GY-3001: alpha page' });
  const filed: RelandInput[] = [];
  const older = await runServeRevert(ports(coordinator, origin, passTrial, filed),
    { ...(await servedFixture(coordinator, served, 'case-alpha')), lastVerified: verified, baseTip: served, baseBranch: 'main', work });
  assert.equal(older.outcome, 'reverted');
  const olderSha = older.outcome === 'reverted' ? older.revertSha : '';
  assert.equal(show(origin, olderSha, 'a.txt'), null);
  assert.equal(show(origin, olderSha, 'b.txt'), 'beta\n');
  assert.equal(filed.length, 1);
  assert.equal(filed[0]!.title, 'Re-land GY-3001: alpha page');
});

test('unit:revert-only-the-failing-item — an item main fast-forwarded to behind an earlier merge commit is the culprit its case names, and only its commits come back out', async t => {
  const { base, origin, coordinator, verified, work } = await fixture('serve-revert-fast-forward');
  t.after(() => rm(base, { recursive: true, force: true }));
  // GY-3004's head holds main's tip on its first-parent chain, so the writer lands it by fast-forward: two commits, no merge commit.
  const pusher = join(base, 'pusher');
  git(pusher, 'reset', '-q', '--hard', 'origin/main');
  await writeFile(join(pusher, 'c.txt'), 'gamma\n');
  git(pusher, 'add', '.');
  git(pusher, 'commit', '-q', '-m', 'gamma one');
  await writeFile(join(pusher, 'd.txt'), 'delta\n');
  git(pusher, 'add', '.');
  git(pusher, 'commit', '-q', '-m', 'gamma two');
  git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  const served = git(pusher, 'rev-parse', 'HEAD'), mergeB = git(pusher, 'rev-parse', 'HEAD~2');
  git(coordinator, 'fetch', '-q', 'origin');
  const all = [...work, item('GY-3004', 'gamma page', ['unit:gamma', 'e2e:case-gamma'], served)];
  const range = await serveRangeCommits(async args => git(coordinator, ...args), verified, served);
  assert.equal(range.length, 4);
  assert.deepEqual(selectServeCulprit(range, all, 'case-gamma'), { item: all[2], mergeSha: served, before: mergeB, subject: 'gamma two' });
  // A landing nothing names never lets an unnamed case fall back to a bystander.
  assert.equal(selectServeCulprit(range, work, 'case-unknown'), null);
  assert.equal(selectServeCulprit(range, all, 'case-unknown')?.item.key, 'GY-3004');

  const filed: RelandInput[] = [];
  const result = await runServeRevert(ports(coordinator, origin, passTrial, filed),
    { ...(await servedFixture(coordinator, served, 'case-gamma')), lastVerified: verified, baseTip: served, baseBranch: 'main', work: all });
  assert.equal(result.outcome === 'reverted' && result.culprit.key, 'GY-3004');
  const revertSha = result.outcome === 'reverted' ? result.revertSha : '';
  assert.equal(tipOf(origin), revertSha);
  assert.equal(show(origin, revertSha, 'c.txt'), null);
  assert.equal(show(origin, revertSha, 'd.txt'), null);
  assert.equal(show(origin, revertSha, 'a.txt'), 'alpha\n');
  assert.equal(show(origin, revertSha, 'b.txt'), 'beta\n');
  assert.equal(git(origin, 'rev-parse', 'main~1'), served);
  assert.equal(filed[0]!.title, 'Re-land GY-3004: gamma page');
});

test('unit:revert-only-the-failing-item — a merge already reverted is never reverted twice: the serve still failing re-applies nothing', async t => {
  const { base, origin, coordinator, verified, served, work } = await fixture('serve-revert-once');
  t.after(() => rm(base, { recursive: true, force: true }));
  const failing = await servedFixture(coordinator, served, 'case-beta');
  const filed: RelandInput[] = [];
  const first = await runServeRevert(ports(coordinator, origin, passTrial, filed),
    { ...failing, lastVerified: verified, baseTip: served, baseBranch: 'main', work });
  assert.equal(first.outcome, 'reverted');
  const revertSha = first.outcome === 'reverted' ? first.revertSha : '';

  // The serve still fails on the revert commit: without the guard the loop would revert the
  // same merge again — re-applying its change onto its own revert and oscillating main.
  const again = await runServeRevert(ports(coordinator, origin, passTrial, filed),
    { ...failing, serve: revertSha, lastVerified: verified, baseTip: revertSha, baseBranch: 'main', work, alreadyReverted: [served] });
  assert.equal(again.outcome, 'already-reverted');
  if (again.outcome === 'already-reverted') assert.equal(again.mergeSha, served);
  assert.equal(tipOf(origin), revertSha);
  assert.equal(show(origin, revertSha, 'b.txt'), null);
  assert.equal(filed.length, 1);
});

test('unit:revert-only-the-failing-item — a failing case no item names reverts the newest merge, and a failing trial holds the revert', async t => {
  const { base, origin, coordinator, verified, served, work } = await fixture('serve-revert-fallback');
  t.after(() => rm(base, { recursive: true, force: true }));
  const range = await serveRangeCommits(async args => git(coordinator, ...args), verified, served);
  assert.equal(selectServeCulprit(range, work, 'case-gamma')?.mergeSha, served);

  // A revert whose own trial fails is held: nothing is pushed and no re-land is filed.
  const filed: RelandInput[] = [];
  const failingTrial = { ...passTrial, build: 'fail' } as unknown as MergeTrialRun;
  const held = await runServeRevert(ports(coordinator, origin, failingTrial, filed),
    { ...(await servedFixture(coordinator, served, 'case-gamma')), lastVerified: verified, baseTip: served, baseBranch: 'main', work });
  assert.equal(held.outcome, 'held');
  if (held.outcome === 'held') {
    assert.equal(held.culprit.key, 'GY-3002');
    assert.match(held.reason, /failed its trial/);
  }
  assert.equal(tipOf(origin), served);
  assert.deepEqual(filed, []);

  // The held revert is named in the merge writer's status.
  if (held.outcome === 'held') {
    const state = emptyMergeWriterState();
    state.serveRevert = { lastVerified: verified, reverts: [], held: { serve: served, culprit: held.culprit.key, reason: held.reason, at: new Date().toISOString() }, retry: null, answered: null };
    assert.equal(mergeWriterSummary(state, Date.now()).serveRevert?.held?.culprit, 'GY-3002');
  }
});

test('unit:revert-only-the-failing-item — the loop step drives the production path: the served commit fails the case one item names, the writer pushes the revert and files one re-land', async t => {
  const { base, origin, coordinator, verified, served, work } = await fixture('serve-revert-loop');
  t.after(() => rm(base, { recursive: true, force: true }));
  const start = Date.parse('2030-06-01T00:00:00Z');
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  const servedFile = join(coordinator, '.graphyard', 'served.json');
  const tried: unknown[] = [], filed: RelandInput[] = [];
  // The loop's own ports over the temporary origin: real git and the served.json fixture through
  // the serve record the deploy unit writes, a capturing trial, and a leased push to the origin.
  const reads: MergeWriterReads = {
    baseBranch: 'main', retrials: 1, now: () => start,
    git: async (args, extra) => gitEnv(coordinator, ['-C', coordinator, ...args], extra ?? {}),
    fetch: async () => { git(coordinator, 'fetch', '-q', '--no-tags', 'origin', 'main'); return git(coordinator, 'rev-parse', 'origin/main'); },
    merge: async () => { throw new Error('no merge in the serve-revert loop test'); },
    trial: async (_sha, _files, trialItem) => { tried.push(trialItem); return passTrial; },
    push: async (revertSha, baseTip) => {
      if (tipOf(origin) !== baseTip) return 'rejected';
      git(coordinator, 'push', '-q', 'origin', `${revertSha}:main`);
      return 'pushed';
    },
    holds: async () => false,
    record: async () => {},
    merger: async () => 'control-plane',
    serveRecord: async () => { const record = readServeRecord(servedFile); return record?.commit ? { commit: record.commit, check: record.check ?? null } : null; },
    createWork: async input => { filed.push(input); return { key: 'GY-3003' }; },
  };
  const effects = { mergeWriter: reads, persist: async () => {} } as unknown as DaemonEffects;
  const state = emptyDaemonState(config);
  const cycle = () => ({ state, effects, now: () => start, snapshot: { work, now: new Date(start).toISOString() }, performed: [] as never[] }) as unknown as Cycle;

  // The passing serve sets the baseline the failure measures from.
  await servedBaseline(coordinator, verified);
  await mergeWriterStep(cycle());
  assert.equal(state.mergeWriter.serveRevert?.lastVerified, verified);

  // The served commit fails the case GY-3002's own e2e: proof names: the loop trials the revert
  // beside the cycle, pushes it, and files one re-land.
  await servedFixture(coordinator, served, 'case-beta');
  await mergeWriterStep(cycle());
  await mergeWriterIdle(state);
  await mergeWriterStep(cycle());

  // The revert went through the writer's normal trial — but as a proofless pseudo-item under the
  // culprit's key, never the culprit's own head with its failing bound case.
  assert.equal(tried.length, 1);
  assert.deepEqual(tried[0], { key: 'GY-3002', criteria: [] });

  // Exactly the failing item's merge came back out of main.
  const reverts = state.mergeWriter.serveRevert?.reverts ?? [];
  assert.equal(reverts.length, 1);
  const revertSha = reverts[0]!.revertSha;
  assert.equal(tipOf(origin), revertSha);
  assert.equal(show(origin, revertSha, 'b.txt'), null);
  assert.equal(show(origin, revertSha, 'a.txt'), 'alpha\n');
  assert.equal(reverts[0]!.reland, 'GY-3003');
  assert.equal(filed.length, 1);
  assert.equal(filed[0]!.title, 'Re-land GY-3002: beta page');
  assert.deepEqual(filed[0]!.criteria.map(criterion => criterion.id), ['AC-1', 'AC-2']);
  assert.deepEqual(filed[0]!.dependencies, [work[1]!.id]);

  // One serve reverts once: the next cycle pushes and files nothing more.
  await mergeWriterStep(cycle());
  assert.equal(tipOf(origin), revertSha);
  assert.equal(filed.length, 1);
  assert.equal(tried.length, 1);
});

/** The loop's ports over a fixture with a mutable clock, a counted fetch and a stubbed trial. */
function loopReads(coordinator: string, origin: string, servedFile: string, state: { nowMs: number; fetches: number },
  trial: (item: unknown) => Promise<MergeTrialRun> | MergeTrialRun, tried: unknown[], filed: RelandInput[]): MergeWriterReads {
  return {
    baseBranch: 'main', retrials: 1, now: () => state.nowMs,
    git: async (args, extra) => gitEnv(coordinator, ['-C', coordinator, ...args], extra ?? {}),
    fetch: async () => { state.fetches++; git(coordinator, 'fetch', '-q', '--no-tags', 'origin', 'main'); return git(coordinator, 'rev-parse', 'origin/main'); },
    merge: async () => { throw new Error('no merge in the serve-revert retry test'); },
    trial: async (_sha, _files, trialItem) => { tried.push(trialItem); return trial(trialItem); },
    push: async (revertSha, baseTip) => {
      if (tipOf(origin) !== baseTip) return 'rejected';
      git(coordinator, 'push', '-q', 'origin', `${revertSha}:main`);
      return 'pushed';
    },
    holds: async () => false,
    record: async () => {},
    merger: async () => 'control-plane',
    serveRecord: async () => { const record = readServeRecord(servedFile); return record?.commit ? { commit: record.commit, check: record.check ?? null } : null; },
    createWork: async input => { filed.push(input); return { key: 'GY-3003' }; },
  };
}

function loopState(config: ReturnType<typeof masterConfigSchema.parse>, clock: { nowMs: number }) {
  const state = emptyDaemonState(config);
  const cycle = (work: Work[]) => ({ state, effects: null as never, now: () => clock.nowMs,
    snapshot: { work, now: new Date(clock.nowMs).toISOString() }, performed: [] as never[] }) as unknown as Cycle;
  return { state, cycle };
}

test('unit:revert-only-the-failing-item — a revert whose trial fails only where the base fails backs off: the next cycle starts no trial and leaves the queue free', async t => {
  const { base, origin, coordinator, verified, served, work } = await fixture('serve-revert-backoff');
  t.after(() => rm(base, { recursive: true, force: true }));
  const clock = { nowMs: Date.parse('2030-06-01T00:00:00Z'), fetches: 0 };
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  const servedFile = join(coordinator, '.graphyard', 'served.json');
  const tried: unknown[] = [], filed: RelandInput[] = [];
  // The revert's trial fails only a repository check the base tip fails too: the revert proves nothing yet.
  const baseFailTrial = { ...passTrial, tests: { passed: 0, failed: ['tests/repo-check.test.ts'], files: 1 },
    base: { tip: served, files: ['tests/repo-check.test.ts'], tests: ['repo check names cases'], cases: ['repo check names cases'] } } as unknown as MergeTrialRun;
  const reads = loopReads(coordinator, origin, servedFile, clock, () => baseFailTrial, tried, filed);
  const effects = { mergeWriter: reads, persist: async () => {} } as unknown as DaemonEffects;
  const { state, cycle } = loopState(config, clock);
  const step = () => mergeWriterStep({ ...cycle(work), effects });

  await servedBaseline(coordinator, verified);
  await step();
  assert.equal(state.mergeWriter.serveRevert?.lastVerified, verified);

  await servedFixture(coordinator, served, 'case-beta');
  await step();
  await mergeWriterIdle(state);
  await step();

  // The base-failing trial settles as a retry with its serve and tip recorded: nothing pushed, nothing filed.
  const retry = state.mergeWriter.serveRevert?.retry;
  assert.ok(retry && retry.serve === served);
  assert.equal(retry.mergeSha, served);
  assert.equal(tried.length, 1);
  assert.equal(tipOf(origin), served);
  assert.deepEqual(filed, []);
  assert.equal(state.mergeWriter.inFlight, null);
  assert.equal(mergeWriterInFlight(state), false);

  // The very next cycle starts no new trial: the flight would block the queue's base-failure
  // repair, the very fix that would let the revert pass.
  await step();
  assert.equal(tried.length, 1);
  assert.equal(mergeWriterInFlight(state), false);
  assert.equal(tipOf(origin), served);

  // The hold elapsing tries again — once per hold, not once per cycle.
  clock.nowMs += baseFailureHoldMs + 1;
  await step();
  await mergeWriterIdle(state);
  assert.equal(tried.length, 2);
  await step();
  assert.equal(tipOf(origin), served);
  assert.deepEqual(filed, []);
  assert.ok(state.mergeWriter.serveRevert?.retry);
});

test('unit:revert-only-the-failing-item — a revert trial that throws settles as a retry, not as the culprit’s merge failure', async t => {
  const { base, origin, coordinator, verified, served, work } = await fixture('serve-revert-throw');
  t.after(() => rm(base, { recursive: true, force: true }));
  const clock = { nowMs: Date.parse('2030-06-01T00:00:00Z'), fetches: 0 };
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  const servedFile = join(coordinator, '.graphyard', 'served.json');
  const tried: unknown[] = [], filed: RelandInput[] = [];
  const reads = loopReads(coordinator, origin, servedFile, clock, () => {
    throw new TrialTimeoutError('tests', 1_000, 'tests/slow.test.ts slow');
  }, tried, filed);
  const effects = { mergeWriter: reads, persist: async () => {} } as unknown as DaemonEffects;
  const { state, cycle } = loopState(config, clock);
  const step = () => mergeWriterStep({ ...cycle(work), effects });

  await servedBaseline(coordinator, verified);
  await step();
  await servedFixture(coordinator, served, 'case-beta');
  await step();
  await mergeWriterIdle(state);
  await step();

  // The thrown trial is a revert retry: the culprit keeps no timeout record and no merge verdict under the revert sha.
  assert.ok(state.mergeWriter.serveRevert?.retry);
  assert.equal((state.mergeWriter.timeouts ?? []).filter(entry => entry.key === 'GY-3002').length, 0);
  assert.equal(tried.length, 1);
  assert.equal(tipOf(origin), served);
  await step();
  assert.equal(tried.length, 1);
});

test('unit:revert-only-the-failing-item — a serve still failing on its answered revert reads nothing: the guard hit once names it', async t => {
  const { base, origin, coordinator, verified, served, work } = await fixture('serve-revert-answered');
  t.after(() => rm(base, { recursive: true, force: true }));
  const failing = await servedFixture(coordinator, served, 'case-beta');
  const filed: RelandInput[] = [];
  const first = await runServeRevert(ports(coordinator, origin, passTrial, filed),
    { ...failing, lastVerified: verified, baseTip: served, baseBranch: 'main', work });
  assert.equal(first.outcome, 'reverted');
  const revertSha = first.outcome === 'reverted' ? first.revertSha : '';

  const clock = { nowMs: Date.parse('2030-06-01T00:00:00Z'), fetches: 0 };
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  const servedFile = join(coordinator, '.graphyard', 'served.json');
  const tried: unknown[] = [], relands: RelandInput[] = [];
  const reads = loopReads(coordinator, origin, servedFile, clock, () => passTrial, tried, relands);
  const effects = { mergeWriter: reads, persist: async () => {} } as unknown as DaemonEffects;
  const { state, cycle } = loopState(config, clock);
  state.mergeWriter.serveRevert = { lastVerified: verified,
    reverts: [{ serve: served, culprit: 'GY-3002', mergeSha: served, revertSha, reland: 'GY-3003', failingCase: 'case-beta', failingStep: null, failingReason: null, at: new Date(clock.nowMs).toISOString() }],
    held: null, retry: null, answered: null };
  const step = () => mergeWriterStep({ ...cycle(work), effects });

  // The serve stays failing on the revert commit, whose merge is already reverted: the guard
  // answers it once, and the next cycle reads nothing.
  await servedFixture(coordinator, revertSha, 'case-beta');
  await step();
  assert.equal(tried.length, 0);
  assert.equal(tipOf(origin), revertSha);
  const fetches = clock.fetches;
  await step();
  assert.equal(clock.fetches, fetches);
  assert.equal(tried.length, 0);
  assert.equal(tipOf(origin), revertSha);
});

test('unit:revert-only-the-failing-item — a re-land whose filing failed is filed once the pushed revert serves and passes', async t => {
  const { base, origin, coordinator, verified, served, work } = await fixture('serve-revert-owed-reland');
  t.after(() => rm(base, { recursive: true, force: true }));
  const clock = { nowMs: Date.parse('2030-06-01T00:00:00Z'), fetches: 0 };
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  const servedFile = join(coordinator, '.graphyard', 'served.json');
  const tried: unknown[] = [], filed: RelandInput[] = [];
  const reads = loopReads(coordinator, origin, servedFile, clock, () => passTrial, tried, filed);
  let down = true;
  const createWork = reads.createWork!;
  reads.createWork = async (input, key) => { if (down) throw new Error('control plane unavailable'); return createWork(input, key); };
  const effects = { mergeWriter: reads, persist: async () => {} } as unknown as DaemonEffects;
  const { state, cycle } = loopState(config, clock);
  const step = () => mergeWriterStep({ ...cycle(work), effects });

  await servedBaseline(coordinator, verified);
  await step();
  await servedFixture(coordinator, served, 'case-beta');
  await step();
  await mergeWriterIdle(state);
  await step();
  const revert = state.mergeWriter.serveRevert!.reverts[0]!;
  assert.equal(tipOf(origin), revert.revertSha);
  assert.equal(revert.reland, null);
  assert.equal(filed.length, 0);

  // The deploy unit serves the pushed revert and it passes; the owed filing still goes through, once.
  await servedBaseline(coordinator, revert.revertSha);
  down = false;
  await step();
  await step();
  assert.equal(state.mergeWriter.serveRevert!.lastVerified, revert.revertSha);
  assert.equal(revert.reland, 'GY-3003');
  assert.equal(filed.length, 1);
  assert.equal(filed[0]!.title, 'Re-land GY-3002: beta page');
  assert.deepEqual(filed[0]!.criteria.at(-1)!.proofs, ['e2e:case-beta']);
});

test('unit:revert-only-the-failing-item — a re-land filing whose reply is lost files one item: every retry carries the same idempotency key', async t => {
  const { base, origin, coordinator, verified, served, work } = await fixture('serve-revert-lost-reply');
  t.after(() => rm(base, { recursive: true, force: true }));
  const clock = { nowMs: Date.parse('2030-06-01T00:00:00Z'), fetches: 0 };
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  const reads = loopReads(coordinator, origin, join(coordinator, '.graphyard', 'served.json'), clock, () => passTrial, [], []);
  // The control plane's receipts: a key it holds answers its stored item; the first reply is lost after the commit.
  const receipts = new Map<string, { key: string }>(), posts: string[] = [];
  reads.createWork = async (_input, key) => {
    posts.push(key);
    const first = !receipts.has(key);
    if (first) receipts.set(key, { key: `GY-${3003 + receipts.size}` });
    if (first) throw new Error('socket hang up');
    return receipts.get(key)!;
  };
  const { state, cycle } = loopState(config, clock);
  const step = () => mergeWriterStep({ ...cycle(work), effects: { mergeWriter: reads, persist: async () => {} } as unknown as DaemonEffects });

  await servedBaseline(coordinator, verified);
  await step();
  await servedFixture(coordinator, served, 'case-beta');
  await step();
  await mergeWriterIdle(state);
  await step();
  // The settling cycle asks once, and the snapshot does not show the item it filed.
  assert.equal(posts.length, 1);
  assert.equal(state.mergeWriter.serveRevert!.reverts[0]!.reland, null);
  await step();
  assert.equal(posts.length, 2);
  assert.equal(posts[1], posts[0]);
  assert.equal(receipts.size, 1);
  assert.equal(state.mergeWriter.serveRevert!.reverts[0]!.reland, 'GY-3003');
});

/** The loop's ports with a real read of what the base holds, for the restart cases. */
function restartReads(coordinator: string, origin: string, clock: { nowMs: number; fetches: number }, trial: () => Promise<MergeTrialRun> | MergeTrialRun, tried: unknown[], filed: RelandInput[]) {
  const reads = loopReads(coordinator, origin, join(coordinator, '.graphyard', 'served.json'), clock, trial, tried, filed);
  reads.holds = async sha => { try { git(coordinator, 'merge-base', '--is-ancestor', sha, 'origin/main'); return true; } catch { return false; } };
  return reads;
}
/** The state a restarted loop reads back: what was persisted, with nothing of the old process's flight. */
const restarted = (state: DaemonState) => ({ ...state, mergeWriter: mergeWriterStateSchema.parse(JSON.parse(JSON.stringify(state.mergeWriter))) });

test('unit:revert-only-the-failing-item — a restart after the push settles the revert from its persisted entry: one re-land, and no second revert, even once the revert serves and passes', async t => {
  const { base, origin, coordinator, verified, served, work } = await fixture('serve-revert-restart-pushed');
  t.after(() => rm(base, { recursive: true, force: true }));
  const clock = { nowMs: Date.parse('2030-06-01T00:00:00Z'), fetches: 0 };
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  const tried: unknown[] = [], filed: RelandInput[] = [];
  const effects = { mergeWriter: restartReads(coordinator, origin, clock, () => passTrial, tried, filed), persist: async () => {} } as unknown as DaemonEffects;
  const { state, cycle } = loopState(config, clock);

  await servedBaseline(coordinator, verified);
  await mergeWriterStep({ ...cycle(work), effects });
  await servedFixture(coordinator, served, 'case-beta');
  await mergeWriterStep({ ...cycle(work), effects });
  await mergeWriterIdle(state);
  // The push landed; the loop dies before the cycle that would settle it, and the revert serves and passes meanwhile.
  const revertSha = tipOf(origin);
  assert.equal(state.mergeWriter.inFlight?.revert?.revertSha, revertSha);
  assert.deepEqual(state.mergeWriter.serveRevert!.reverts, []);
  await servedBaseline(coordinator, revertSha);

  const after = restarted(state);
  await mergeWriterStep({ ...cycle(work), state: after, effects });
  await mergeWriterStep({ ...cycle(work), state: after, effects });
  assert.equal(after.mergeWriter.inFlight, null);
  assert.equal(after.mergeWriter.serveRevert!.lastVerified, revertSha);
  const reverts = after.mergeWriter.serveRevert!.reverts;
  assert.deepEqual(reverts.map(entry => [entry.culprit, entry.revertSha, entry.reland]), [['GY-3002', revertSha, 'GY-3003']]);
  assert.equal(filed.length, 1);
  assert.deepEqual(filed[0]!.criteria.at(-1)!.proofs, ['e2e:case-beta']);
  assert.equal(tried.length, 1);
  assert.equal(tipOf(origin), revertSha);
});

test('unit:revert-only-the-failing-item — a restart before the push starts the revert afresh, and an unreadable base starts nothing until it reads', async t => {
  const { base, origin, coordinator, verified, served, work } = await fixture('serve-revert-restart-unpushed');
  t.after(() => rm(base, { recursive: true, force: true }));
  const clock = { nowMs: Date.parse('2030-06-01T00:00:00Z'), fetches: 0 };
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  const tried: unknown[] = [], filed: RelandInput[] = [];
  // The first process's trial never ends: the loop dies inside it.
  let dying = true;
  const reads = restartReads(coordinator, origin, clock, () => dying ? new Promise<MergeTrialRun>(() => {}) : passTrial, tried, filed);
  const effects = { mergeWriter: reads, persist: async () => {} } as unknown as DaemonEffects;
  const { state, cycle } = loopState(config, clock);

  await servedBaseline(coordinator, verified);
  await mergeWriterStep({ ...cycle(work), effects });
  await servedFixture(coordinator, served, 'case-beta');
  await mergeWriterStep({ ...cycle(work), effects });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(tried.length, 1);
  assert.equal(tipOf(origin), served);

  dying = false;
  const after = restarted(state);
  const persisted = after.mergeWriter.inFlight;
  const fetch = reads.fetch;
  reads.fetch = async () => { throw new Error('origin unreachable'); };
  await mergeWriterStep({ ...cycle(work), state: after, effects });
  assert.deepEqual(after.mergeWriter.inFlight, persisted, 'the entry stands while the base cannot be read');
  assert.equal(tried.length, 1);

  reads.fetch = fetch;
  await mergeWriterStep({ ...cycle(work), state: after, effects });
  await mergeWriterIdle(after);
  await mergeWriterStep({ ...cycle(work), state: after, effects });
  assert.equal(tried.length, 2);
  const reverts = after.mergeWriter.serveRevert!.reverts;
  assert.equal(reverts.length, 1);
  assert.equal(tipOf(origin), reverts[0]!.revertSha);
  assert.equal(filed.length, 1);
});

test('unit:revert-only-the-failing-item — the production filing route sends the idempotency key it is given', async t => {
  const root = await temporaryDirectory('serve-revert-filing-root'), outside = await temporaryDirectory('serve-revert-filing-token');
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  git(root, 'init', '-q');
  const credentialFile = join(outside, 'operator.token');
  await writeFile(credentialFile, `${'o'.repeat(40)}\n`, { mode: 0o600 });
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(outside, 'coordinator.token'), cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [],
    operatorAgent: { id: 'graphyard-master-operator', credentialFile } });
  const sent: (string | null)[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => { sent.push(new Headers(init.headers).get('Idempotency-Key')); return new Response(JSON.stringify({ key: 'GY-3003' })); }) as unknown as typeof fetch;
  const effects = daemonEffects(root, config, { snapshot: async () => ({ work: [], now: '' }), mutate: async () => ({}), fetcher });
  const input = { title: 'Re-land GY-1', type: 'feature', priority: 1, description: 'd', criteria: [], dependencies: [], reason: 'r' } as RelandInput;
  const answers = [await effects.mergeWriter!.createWork!(input, 'serve-reland:abc'), await effects.mergeWriter!.createWork!(input, 'serve-reland:abc')];
  assert.deepEqual(sent, ['serve-reland:abc', 'serve-reland:abc']);
  assert.deepEqual(answers, [{ key: 'GY-3003' }, { key: 'GY-3003' }]);
});

test('unit:revert-only-the-failing-item — an original at the 50-criterion limit still files a re-land the create route accepts, carrying every criterion and the case', () => {
  const failure = { serve: 'a'.repeat(40), failingCase: 'case-full', failingStep: 'step 1 ready', failingReason: 'wanted 200, got 404', mergeSha: 'b'.repeat(40), baseBranch: 'main' };
  const criteria = Array.from({ length: 50 }, (_, index) => ({ id: `AC-${index + 1}`, text: `criterion ${index + 1}`, proofs: [`unit:proof-${index + 1}`] }));
  const original = (filled: typeof criteria) => ({ ...item('GY-3009', 'full page', [], null), id: '53c1ac2f-8949-47fc-9be3-b4d9490b1ae9', criteria: filled }) as Work;

  // The route's own schema, whose command adds only the reason (engine.ts `commands.create`).
  const accepted = (filled: typeof criteria) => { const { reason: _reason, ...input } = relandItemFor(original(filled), failure); return createSchema.parse(input); };

  const reland = accepted(criteria);
  assert.equal(reland.criteria.length, 50);
  assert.deepEqual(reland.criteria.map(criterion => criterion.id), criteria.map(criterion => criterion.id));
  assert.deepEqual(reland.criteria[0]!.proofs, ['unit:proof-1', 'e2e:case-full']);
  assert.match(reland.criteria[0]!.text, /^criterion 1 .*"case-full"/);
  assert.deepEqual(reland.criteria.slice(1).map(criterion => criterion.text), criteria.slice(1).map(criterion => criterion.text));

  // The criterion already proving the case takes it, with no second copy of the proof.
  const named = criteria.map((criterion, index) => index === 7 ? { ...criterion, proofs: ['e2e:case-full'] } : criterion);
  assert.deepEqual(accepted(named).criteria[7]!.proofs, ['e2e:case-full']);

  // Every proof list full: the payload stays valid and the description still names the case.
  const full = criteria.map(criterion => ({ ...criterion, proofs: Array.from({ length: 20 }, (_, index) => `unit:p-${index}`) }));
  const crowded = accepted(full);
  assert.deepEqual(crowded.criteria, full);
  assert.match(crowded.description, /"case-full"/);
});
