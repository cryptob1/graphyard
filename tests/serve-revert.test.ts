import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readServeRecord } from '../src/serve-app.js';
import { mergeWriterSummary, emptyMergeWriterState } from '../src/daemon/cycle-merge-writer.js';
import { relandItemFor, runServeRevert, selectServeCulprit, serveRangeMerges, type RelandInput, type ServeRevertPorts } from '../src/merge-writer/serve-revert.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
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
  const range = await serveRangeMerges(async args => git(coordinator, ...args), verified, served);
  assert.deepEqual(range.map(merge => merge.sha), [mergeA, served]);
  assert.deepEqual(selectServeCulprit(range, work, 'case-beta'), { item: work[1], mergeSha: served });

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
  const range = await serveRangeMerges(async args => git(coordinator, ...args), verified, served);

  // The older item's proof names the failing case: the older merge is the culprit, not the newest.
  assert.deepEqual(selectServeCulprit(range, work, 'case-alpha'), { item: work[0], mergeSha: mergeA });
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
  const range = await serveRangeMerges(async args => git(coordinator, ...args), verified, served);
  assert.deepEqual(selectServeCulprit(range, work, 'case-gamma'), { item: work[1], mergeSha: served });

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
    state.serveRevert = { lastVerified: verified, reverts: [], held: { serve: served, culprit: held.culprit.key, reason: held.reason, at: new Date().toISOString() } };
    assert.equal(mergeWriterSummary(state, Date.now()).serveRevert?.held?.culprit, 'GY-3002');
  }
});
