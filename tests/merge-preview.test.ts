import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeOne, type MergePorts, type MergeRecordEvent, type MergeTrialRun } from '../src/merge-writer/executor.js';
import { previewCheckoutPrefix, previewConcurrency, previewFailureReason, previewSkip, previewSlots, runPreview, sweepPreviewCheckouts, type PreviewSite, type PreviewVerdict } from '../src/merge-writer/preview.js';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { foldMergeLedger, mergeLedgerKinds, mergeTrialKind } from '../src/model/merge-ledger.js';
import { mergeRecordBodySchema } from '../src/server/merge-record.js';
import { trialFailedGround, trialFailurePrefix } from '../src/model/rework-ground.js';
import { masterConfigSchema } from '../src/master.js';
import { tempOwnerMarker, writeTempOwner } from '../src/tmp-reclaim.js';
import type { Work } from '../src/model.js';
import type { StaticBuildShell } from '../src/release-project.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1718: a passing trial merge of a static-site repository is built, served and run against its
// required and uat E2E cases before it lands; a failing required case refuses the merge alone.

const made: string[] = [];
after(async () => { for (const directory of made) await rm(directory, { recursive: true, force: true }); });
const scratch = async (label: string) => { const directory = await realpath(await temporaryDirectory(label)); made.push(directory); return directory; };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const site: PreviewSite = { directory: 'dist', build: 'mkdir -p dist && cp -R site/. dist/' };
const copySite: StaticBuildShell = async (_command, cwd) => { execFileSync('sh', ['-c', 'mkdir -p dist && cp -R site/. dist/'], { cwd }); return { ok: true, output: '' }; };

/** A repository whose site serves a score, with a required case reading it and an optional uat case; `best` is the score the merge serves. */
async function repository(label: string, best: unknown) {
  const root = await scratch(label), repo = join(root, 'repo'), base = join(root, 'worktrees');
  await mkdir(base);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 't@example.com'); git(repo, 'config', 'user.name', 'T');
  const write = async (path: string, content: unknown) => { await mkdir(join(repo, path, '..'), { recursive: true }); await writeFile(join(repo, path), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`); };
  const http = (path: string, expect: unknown[] = []) => ({ kind: 'http', name: `read ${path}`, method: 'GET', path, status: 200, expect });
  await write('site/index.html', '<h1>Play</h1>');
  await write('site/scores.json', { best });
  await write('e2e/cases/scores.json', { id: 'scores', title: 'A player sees the best score', tags: ['api'], target: 'any', required: true, steps: [http('/scores.json', [{ path: 'best', type: 'number' }])] });
  await write('e2e/cases/home.json', { id: 'home', title: 'The home page answers', tags: ['api'], target: 'uat', required: false, steps: [http('/')] });
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'site and its cases');
  return { repo, base, mergeSha: git(repo, 'rev-parse', 'HEAD') };
}
const previewDirectories = async (base: string) => (await readdir(base)).filter(name => name.startsWith(previewCheckoutPrefix));

// ---- mergeOne against fake ports -----------------------------------------------------------------

const tip = sha('tip'), head = sha('head'), mergeSha = sha('merge');
const work = (files: string[] = ['src/game.ts']) => ({
  id: 'w1', key: 'GY-1', description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
  policy: { checks: ['test'], review: true }, plannedFiles: [], revision: 1, policyRevision: 1, stage: 'build', ready: true, epoch: 1, lease: null, workspaces: [],
  submission: { epoch: 1, pr: 1 }, candidate: { sha: head, baseSha: tip, pr: 1, branch: 'graphyard/gy-1-1', author: 'worker' }, reworkRequested: false, scenarioRequirements: [], evidence: [],
  observation: { source: 'control-plane', candidate: { sha: head, baseSha: tip, pr: 1 }, files, checks: [], reviews: [], merged: false }, blocker: null, violations: [], gates: [], mergeLedger: null,
}) as unknown as Work;
const passingTrial: MergeTrialRun = { build: 'pass', tests: { passed: 3, failed: [], files: 1 }, durationMs: 10, files: ['tests/game.test.ts'], proofs: { 'unit:works': { executed: 1, failed: 0 } } } as MergeTrialRun;
function ports(preview?: MergePorts['preview']) {
  const events: MergeRecordEvent[] = [], pushes: string[] = [];
  const value: MergePorts = {
    baseBranch: 'main', retrials: 1, now: () => Date.parse('2030-01-01T00:00:00Z'),
    fetch: async () => pushes.length ? mergeSha : tip,
    merge: async () => ({ mergeSha, files: ['src/game.ts'] }),
    trial: async () => passingTrial,
    push: async sha => { pushes.push(sha); return 'pushed'; },
    holds: async () => false,
    record: async (_item, event) => { events.push(event); return {}; },
    ...(preview ? { preview } : {}),
  };
  return { value, events, pushes };
}

test('unit:preview-failing-case-refuses-merge — a static-site repository\'s passing trial merge is built and served, every required and uat case runs against it, and a failing required case refuses the merge naming the case as a failed trial does', { timeout: 60_000 }, async () => {
  // The real preview: a checkout of the merge, the site built and served, the cases run over HTTP.
  const broken = await repository('preview-broken', 'none');
  const failed = await runPreview({ root: broken.repo, base: broken.base, mergeSha: broken.mergeSha, site, token: '', timeoutMs: 30_000, stepTimeoutMs: 5_000 });
  assert.equal(failed.result, 'fail', failed.detail);
  assert.deepEqual(failed.failed, ['scores'], 'the failing required case is named');
  assert.deepEqual(failed.cases.map(entry => [entry.case, entry.verdict, entry.required]).sort(), [['home', 'passed', false], ['scores', 'failed', true]], 'every required and uat case ran');
  assert.equal(failed.mergeSha, broken.mergeSha);
  const fine = await repository('preview-fine', 42);
  const passed = await runPreview({ root: fine.repo, base: fine.base, mergeSha: fine.mergeSha, site, token: '', timeoutMs: 30_000, stepTimeoutMs: 5_000 });
  assert.equal(passed.result, 'pass', passed.detail);
  assert.deepEqual(passed.failed, []);

  // The executor: the failing preview refuses the merge, naming the case, under the trial-failure ground; nothing is pushed.
  const refusing = ports(async () => failed);
  const outcome = await mergeOne(refusing.value, work());
  assert.equal(outcome.outcome, 'refused');
  const reason = (outcome as { reason: string }).reason;
  assert.ok(reason.startsWith(`${trialFailurePrefix}: `), reason);
  assert.match(reason, /E2E case scores failed on the preview/);
  assert.deepEqual(refusing.pushes, [], 'a refused merge is never pushed');
  assert.deepEqual(refusing.events.map(event => event.kind), ['intent', 'trial', 'refused']);
  const refusedItem = { ...work(), mergeLedger: { key: 'GY-1', state: 'refused', head, baseTip: tip, mergeSha, risk: 'normal', intentAt: null, pushedAt: null, observedTip: null, refusal: { kind: 'merge', reason }, events: 3 } } as unknown as Work;
  assert.ok(trialFailedGround(refusedItem), 'the refusal grounds the rework a failed trial does');
  // A passing preview lets the merge land; a failing trial is never previewed.
  const landing = ports(async () => passed);
  assert.equal((await mergeOne(landing.value, work())).outcome, 'merged');
  assert.deepEqual(landing.pushes, [mergeSha]);
  let previewed = 0;
  const failingTrial = ports(async () => { previewed++; return passed; });
  failingTrial.value.trial = async () => ({ ...passingTrial, tests: { passed: 0, failed: ['tests/game.test.ts'], files: 1 } });
  assert.equal((await mergeOne(failingTrial.value, work())).outcome, 'refused');
  assert.equal(previewed, 0, 'only a passing trial is previewed');
  assert.match(previewFailureReason({ ...failed, failed: ['build'], detail: 'the static site\'s build `x` failed' }, trialFailurePrefix)!, /^trial failed: preview build/);
});

test('unit:preview-skipped-when-not-applicable — a merge of only docs or tests, and a repository naming no static UAT, skip the preview and merge exactly as before', async () => {
  assert.equal(previewSkip(['src/game.ts'], null), 'the repository names no static UAT');
  assert.equal(previewSkip(['docs/play.md', 'README.md', 'tests/game.test.ts', 'src/game.spec.ts'], site), 'the merge changes only docs or tests');
  assert.equal(previewSkip(['docs/play.md', 'src/game.ts'], site), null, 'one source file needs the preview');
  assert.equal(previewSkip(['e2e/cases/scores.json'], site), null, 'a changed case runs on the preview');

  // The loop's port: the environment decides, and a skipped merge never reaches runPreview.
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  const called: string[][] = [];
  const reads = (environment: NodeJS.ProcessEnv) => mergeWriterReads(config, '/repo', async () => '', { base: '/worktrees', record: async () => ({}), merger: async () => 'control-plane', environment,
    preview: async input => { called.push([input.mergeSha, input.site.directory, String(input.site.build), input.token]); return { result: 'pass', mergeSha: input.mergeSha, cases: [], failed: [], detail: '', durationMs: 0 }; } });
  assert.equal(await reads({}).preview!(mergeSha, ['src/game.ts'], work()), null, 'no static UAT, no preview');
  const staticSite = { GRAPHYARD_UAT_STATIC: 'dist', GRAPHYARD_UAT_BUILD: 'npm run build:site', GRAPHYARD_UAT_TOKEN: 'uat-token' };
  assert.equal(await reads(staticSite).preview!(mergeSha, ['docs/play.md', 'tests/game.test.ts'], work()), null, 'docs and tests only, no preview');
  assert.deepEqual(called, []);
  assert.equal((await reads(staticSite).preview!(mergeSha, ['src/game.ts'], work()))?.result, 'pass');
  assert.deepEqual(called, [[mergeSha, 'dist', 'npm run build:site', 'uat-token']]);

  // The executor with a skipping preview records and pushes exactly what it did without one.
  const without = ports(), skipped = ports(async () => null);
  assert.deepEqual(await mergeOne(skipped.value, work()), await mergeOne(without.value, work()));
  assert.deepEqual(skipped.events, without.events, 'the same records, with no preview field');
  assert.ok(skipped.events.every(event => !('preview' in event)));
  assert.deepEqual(skipped.pushes, [mergeSha]);
});

test('unit:preview-capped-and-cleaned-up — at most two previews run at once; each is closed and its checkout removed on pass, fail and timeout; the startup sweep removes a preview checkout whose owner process is gone', { timeout: 60_000 }, async () => {
  assert.equal(previewConcurrency, 2);
  const fixture = await repository('preview-cap', 42);
  // Three previews at once on one slot pool: the third builds only after one of the first two ends.
  const slots = previewSlots();
  let active = 0, most = 0;
  const gates: (() => void)[] = [];
  const blockingShell: StaticBuildShell = async (command, cwd) => {
    active++; most = Math.max(most, active);
    await new Promise<void>(accept => gates.push(accept));
    await copySite(command, cwd); active--;
    return { ok: true, output: '' };
  };
  const runs = [0, 1, 2].map(() => runPreview({ root: fixture.repo, base: fixture.base, mergeSha: fixture.mergeSha, site, token: '', timeoutMs: 30_000, stepTimeoutMs: 5_000, shell: blockingShell, slots }));
  const until = async (done: () => boolean) => { for (let index = 0; index < 400 && !done(); index++) await new Promise(accept => setTimeout(accept, 25)); assert.ok(done()); };
  await until(() => gates.length === 2);
  await new Promise(accept => setTimeout(accept, 200));
  assert.equal(gates.length, 2, 'the third preview waits for a slot');
  gates.shift()!();
  await until(() => gates.length === 2);
  while (gates.length) gates.shift()!();
  await until(() => !gates.length && active === 0);
  for (const verdict of await Promise.all(runs)) assert.equal(verdict.result, 'pass', verdict.detail);
  assert.equal(most, 2, 'never more than two previews at once');
  assert.equal(slots.running, 0, 'every slot freed');
  assert.deepEqual(await previewDirectories(fixture.base), [], 'every passing preview\'s checkout removed');

  // Fail: the build fails; timeout: the build never ends within the budget. Either way the checkout goes.
  const failedBuild = await runPreview({ root: fixture.repo, base: fixture.base, mergeSha: fixture.mergeSha, site, token: '', timeoutMs: 30_000, shell: async () => ({ ok: false, output: 'boom' }) });
  assert.equal(failedBuild.result, 'fail'); assert.deepEqual(failedBuild.failed, ['build']);
  assert.deepEqual(await previewDirectories(fixture.base), []);
  let hung: (() => void) | null = null;
  const timedOut = await runPreview({ root: fixture.repo, base: fixture.base, mergeSha: fixture.mergeSha, site, token: '', timeoutMs: 1_500,
    shell: async () => { await new Promise<void>(accept => { hung = accept; }); return { ok: true, output: '' }; } });
  assert.equal(timedOut.result, 'timeout');
  assert.deepEqual(await previewDirectories(fixture.base), [], 'a timed-out preview\'s checkout is removed');
  (hung as (() => void) | null)?.();
  assert.equal(previewFailureReason(timedOut, trialFailurePrefix)!.startsWith(trialFailurePrefix), false, 'a timeout grounds no rework: the head stays queued');
  const requeue = ports(async () => timedOut);
  assert.equal((await mergeOne(requeue.value, work())).outcome, 'requeued');
  assert.equal(git(fixture.repo, 'worktree', 'list').split('\n').length, 1, 'git keeps no record of any preview checkout');

  // The startup sweep: a fabricated leftover whose owner is gone goes; a live owner's and an unmarked one stay.
  const base = await scratch('preview-sweep'), proc = await scratch('preview-proc');
  const dead = join(base, `${previewCheckoutPrefix}dead`), live = join(base, `${previewCheckoutPrefix}live`), unmarked = join(base, `${previewCheckoutPrefix}unmarked`), other = join(base, 'trial-other');
  for (const directory of [dead, live, unmarked, other]) { await mkdir(join(directory, 'checkout'), { recursive: true }); await writeFile(join(directory, 'checkout', 'index.html'), 'left behind'); }
  await writeFile(tempOwnerMarker(dead), `${JSON.stringify({ pid: 4_194_000, startedAt: 1, at: '2030-01-01T00:00:00Z' })}\n`);
  await writeFile(tempOwnerMarker(other), `${JSON.stringify({ pid: 4_194_000, startedAt: 1, at: '2030-01-01T00:00:00Z' })}\n`);
  await writeTempOwner(live);
  await mkdir(join(proc, String(process.pid)));
  await writeFile(join(proc, String(process.pid), 'stat'), (await import('node:fs')).readFileSync(`/proc/${process.pid}/stat`, 'utf8'));
  assert.deepEqual(await sweepPreviewCheckouts(base, { procRoot: proc }), [dead]);
  assert.equal(existsSync(dead), false); assert.equal(existsSync(tempOwnerMarker(dead)), false, 'the marker goes with it');
  for (const kept of [live, unmarked, other]) assert.ok(existsSync(kept), `${kept} is kept`);
});

test('unit:preview-verdict-recorded — the preview verdict is recorded with the merge\'s trial record, kept by the ledger fold, and so shown by status', async () => {
  const verdict: PreviewVerdict = { result: 'fail', mergeSha, cases: [{ case: 'scores', verdict: 'failed', required: true }, { case: 'home', verdict: 'passed', required: false }], failed: ['scores'], detail: '1 of 2 E2E cases failed', durationMs: 1200 };
  const recorded = ports(async () => verdict);
  await mergeOne(recorded.value, work());
  const trial = recorded.events.find(event => event.kind === 'trial')!;
  assert.deepEqual((trial as { preview?: PreviewVerdict }).preview, verdict, 'the trial record carries the preview');
  // The coordinator's merge-record route accepts it.
  const body = mergeRecordBodySchema.parse(trial);
  assert.deepEqual((body as { preview?: unknown }).preview, verdict);
  // The fold keeps it on work.mergeLedger.trial, which `graphyard status` prints with the item.
  const { kind: _kind, ...payload } = trial;
  const ledger = foldMergeLedger([
    { kind: mergeLedgerKinds.intent, payload: { key: 'GY-1', head, baseTip: tip, mergeSha, risk: 'normal', at: '2030-01-01T00:00:00Z' } },
    { kind: mergeTrialKind, payload },
    { kind: mergeLedgerKinds.refused, payload: { head, reason: previewFailureReason(verdict, trialFailurePrefix), kind: 'merge' } },
  ]);
  assert.deepEqual(ledger['GY-1']!.trial?.preview, verdict);
  assert.equal(ledger['GY-1']!.state, 'refused');
  // A trial without a preview folds as it always did.
  const { preview: _preview, ...plain } = payload as typeof payload & { preview?: unknown };
  const bare = foldMergeLedger([{ kind: mergeLedgerKinds.intent, payload: { key: 'GY-1', head, baseTip: tip, mergeSha, risk: 'normal', at: '2030-01-01T00:00:00Z' } }, { kind: mergeTrialKind, payload: plain }]);
  assert.equal('preview' in bare['GY-1']!.trial!, false);
});
