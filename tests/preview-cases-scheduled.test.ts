// GY-3193: the three preview cases run in the daily diagnostics against the commit the install
// serves, master status shows each one's last run and verdict, and a case that did not run counts
// as not covered, never as passed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { bootstrapGate, gateSummary, runDiagnostics, type GateRecord } from '../src/batch-gate.js';
import { batchGatePorts } from '../src/daemon/cycle-batch-gate.js';
import { previewCaseRuns, runServedPreviewCases, servedPreviewCases, type PreviewCaseRun } from '../src/merge-writer/served-previews.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { defaultChildRun } from '../src/child-runner.js';

const own = 'unit:tests/preview-cases-scheduled.test.ts';
const commit = 'a'.repeat(40), at = '2026-11-07T00:00:00.000Z';
const run = (id: string, verdict: PreviewCaseRun['verdict'], detail: string | null = null): PreviewCaseRun => ({ case: id, at, commit, verdict, detail });

const diagnosed = async (previewCases: PreviewCaseRun[], record: GateRecord = bootstrapGate('o/r', commit)) => {
  const filed: string[] = [];
  const failed = await runDiagnostics({ now: () => Date.parse(at), file: async input => { filed.push(input.key); return { item: 'GY-9' }; },
    diagnose: async () => ({ failed: [], catalogMs: 1, previewCases }) }, record);
  return { record, failed, filed };
};

test(`${own} — the daily diagnostics of a repository holding the cases run exactly the three on the verified commit; a catalog without them runs none`, async () => {
  const asked: string[] = [];
  const reads = (held: string[]) => ({ now: () => Date.parse(at), fetch: async () => commit, baseBranch: 'main', trial: async () => ({ build: 'pass', tests: { failed: [] }, e2e: [] }),
    git: async (args: string[]) => args[0] === 'ls-tree' ? held.map(id => `${id}.json`).join('\n') : '',
    gate: { root: '/repo', repository: 'o/r', previews: async (sha: string) => { asked.push(sha); return servedPreviewCases.map(id => run(id, 'passed')); } } });
  const held = await batchGatePorts(reads([...servedPreviewCases, 'smoke']) as never, []).diagnose(commit);
  assert.deepEqual(asked, [commit]);
  assert.deepEqual(held.previewCases!.map(entry => entry.case), ['preview-isolation-cleanup', 'preview-serves-change', 'previews-for-declared-apps']);
  assert.deepEqual((await batchGatePorts(reads(['smoke']) as never, []).diagnose(commit)).previewCases, []);
  assert.deepEqual(asked, [commit], 'a repository without the cases runs none');
  const { gate: _gate, ...unwired } = reads([...servedPreviewCases]);
  const unrun = await batchGatePorts(unwired as never, []).diagnose(commit);
  assert.deepEqual(unrun.previewCases!.map(entry => entry.verdict), ['not covered', 'not covered', 'not covered'], 'no served run is not covered');
});

test(`${own} — a case the run left out, or could not start, is not covered; only one that executed has a verdict`, () => {
  const runs = previewCaseRuns([
    { proof: 'e2e:preview-serves-change', case: 'preview-serves-change', executed: 1, failed: 0 },
    { proof: 'e2e:previews-for-declared-apps', case: 'previews-for-declared-apps', executed: 0, failed: 1, hostFailure: true, failingStep: 'the case could not start' },
  ], commit, at);
  assert.deepEqual(runs.map(entry => [entry.case, entry.verdict, entry.detail]), [
    ['preview-isolation-cleanup', 'not covered', 'the run left it out'],
    ['preview-serves-change', 'passed', null],
    ['previews-for-declared-apps', 'not covered', 'the case could not start'],
  ]);
  assert.equal(previewCaseRuns([{ proof: 'e2e:preview-serves-change', case: 'preview-serves-change', executed: 1, failed: 1, failingStep: 'step 2' }], commit, at)[1]!.verdict, 'failed');
});

test(`${own} — master status shows each case's last run and verdict, and a failed or uncovered case files an owned item once`, async () => {
  const { record, failed, filed } = await diagnosed([run('preview-isolation-cleanup', 'not covered', 'no docker'), run('preview-serves-change', 'passed'), run('previews-for-declared-apps', 'failed', 'step 3')]);
  assert.deepEqual(failed, ['e2e:preview-isolation-cleanup', 'e2e:previews-for-declared-apps']);
  assert.deepEqual(filed, ['diagnostic:e2e:preview-isolation-cleanup', 'diagnostic:e2e:previews-for-declared-apps']);
  assert.deepEqual(gateSummary(record)!.previewCases.map(entry => [entry.case, entry.at, entry.commit, entry.verdict, entry.detail]), [
    ['preview-isolation-cleanup', at, commit.slice(0, 12), 'not covered', 'no docker'],
    ['preview-serves-change', at, commit.slice(0, 12), 'passed', null],
    ['previews-for-declared-apps', at, commit.slice(0, 12), 'failed', 'step 3'],
  ]);
  record.diagnosticsAt = null;
  const again = await diagnosed([run('previews-for-declared-apps', 'failed', 'step 3')], record);
  assert.deepEqual(again.filed, [], 'a case with its item is not filed again');
});

test(`${own} — the served run checks the commit out and hands every case to e2e.serve; a commit it cannot serve is not covered`, async () => {
  const root = await temporaryDirectory('preview-cases');
  const git = (...args: string[]) => defaultChildRun('git', ['-C', root, ...args]);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(root, 'graphyard.json'), JSON.stringify({ e2e: { serve: { command: 'node serve.mjs', url: 'http://127.0.0.1:4391', readySeconds: 1 } } }));
  await git('add', '.'); await git('commit', '-q', '-m', 'served');
  const served = (await git('rev-parse', 'HEAD')).trim();
  await writeFile(join(root, 'graphyard.json'), '{}');
  await git('add', '.'); await git('commit', '-q', '-m', 'no serve');
  const bare = (await git('rev-parse', 'HEAD')).trim();
  const handed: string[][] = [];
  const runs = await runServedPreviewCases({ root, commit: served, hostEnvironment: { PATH: process.env.PATH, HOME: root }, runGroup: async (_target, proofs) => { handed.push([...proofs]); return proofs.map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: 0 })); } });
  assert.deepEqual(handed, [servedPreviewCases.map(id => `e2e:${id}`)]);
  assert.deepEqual(runs.map(entry => [entry.verdict, entry.commit]), servedPreviewCases.map(() => ['passed', served]));
  assert.deepEqual((await runServedPreviewCases({ root, commit: bare, hostEnvironment: { PATH: process.env.PATH, HOME: root } })).map(entry => entry.verdict), ['not covered', 'not covered', 'not covered']);
  assert.deepEqual((await runServedPreviewCases({ root, commit: 'b'.repeat(40), hostEnvironment: { PATH: process.env.PATH, HOME: root } })).map(entry => entry.verdict), ['not covered', 'not covered', 'not covered'], 'a checkout that fails is not covered');
  assert.equal((await git('worktree', 'list')).trim().split('\n').length, 1, 'no checkout is left behind');
});

test(`${own} — the Compose cases are tagged so the trial leaves them out, and every preview read waits for the loop`, () => {
  const definition = (id: string) => JSON.parse(readFileSync(`e2e/cases/${id}.json`, 'utf8'));
  assert.ok(!definition('preview-serves-change').tags.includes('compose'), 'preview-serves-change runs in the trial');
  for (const id of ['preview-isolation-cleanup', 'previews-for-declared-apps']) assert.ok(definition(id).tags.includes('compose'));
  for (const id of servedPreviewCases) {
    const reads = definition(id).steps.filter((step: any) => step.expect?.some((entry: any) => entry.path === 'preview.state'));
    assert.ok(reads.length && reads.every((step: any) => step.waitSeconds > 0), `${id} waits for the loop's preview`);
  }
});
