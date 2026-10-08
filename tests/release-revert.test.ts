import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { applyCandidateRevert, candidateRevertReason, candidateRevertsOf, failingRequiredCases, revertCandidateItem, revertLedgerKind, revertRecordKey, revertTarget, type CandidateItemDelta, type RevertPorts, type RevertRecordEvent } from '../src/release-revert.js';
import { revertRecordBodySchema, revertReopenedReason, unheldRevertRefusal, unrevertableRefusal } from '../src/server/merge-record.js';
import { classifyMainCommits, mainWatchInputs, mainWatchVerdict, type MainWatchCommit } from '../src/daemon/main-watch.js';
import { settleLocalPromotion, type LocalCandidate, type LocalReleasePorts, type LocalValidation } from '../src/daemon/promotion-local.js';
import { localReleasePorts } from '../src/daemon/release-ports.js';
import type { PromotionReads } from '../src/daemon/deployment.js';
import { cut, itemsFromCommits, readLedger, type E2eCaseRecord, type ReleaseCandidate, type UatRecord } from '../src/release-candidate.js';
import type { VerificationMap } from '../src/model/verification-maps.js';
import { masterConfigSchema } from '../src/master.js';
import type { Principal, Work } from '../src/model.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { defaultChildRun } from '../src/child-runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1526: a candidate that fails a required E2E case on UAT reverts the merge of the candidate
// item the failure implicates — chosen through the release contract and the verification maps —
// through the merge writer's own steps, records the revert on the item and reopens it for rework.

const start = Date.parse('2030-05-01T12:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const map = (path: string, paths: string[]): VerificationMap => ({ path, paths, sections: { Tests: 't', Drive: 'd', Invariants: 'i', Gotchas: 'g' } });
const maps = [map('verification/server.md', ['src/server/**', 'src/engine.ts']), map('verification/store.md', ['src/store/**', 'src/store.ts']), map('verification/master.md', ['src/master/**', 'src/master.ts'])];
const contract = { outcomes: [{ id: 'sign-in', cases: ['sign-in'] }, { id: 'work-intake', cases: ['create-work-item', 'board'] }], cases: [{ id: 'sign-in', tags: ['browser'] }, { id: 'board', tags: ['api', 'board'] }, { id: 'create-work-item', tags: ['api', 'store'] }] };
const candidate: Pick<ReleaseCandidate, 'id' | 'sha' | 'items'> = { id: '20300501T120000Z', sha: sha('candidate'), items: [{ key: 'GY-3', mergeSha: sha('merge-3'), pr: 3 }, { key: 'GY-2', mergeSha: sha('merge-2'), pr: 2 }, { key: 'GY-1', mergeSha: sha('merge-1'), pr: 1 }] };
const deltas: CandidateItemDelta[] = [{ key: 'GY-1', mergeSha: sha('merge-1'), files: ['src/server/routes/work.ts', 'tests/work.test.ts'] }, { key: 'GY-2', mergeSha: sha('merge-2'), files: ['src/store/schema.ts'] }, { key: 'GY-3', mergeSha: sha('merge-3'), files: ['web/app.tsx'] }];
const uatWith = (cases: E2eCaseRecord[], blocking = cases.filter(entry => entry.verdict !== 'passed').map(entry => entry.case)): Pick<UatRecord, 'e2e'> =>
  ({ e2e: { runId: 'rc-20300501T120000Z', sha: candidate.sha, blocking, cases } });
const failedCase = (id: string, step = 'open the Work view') => ({ case: id, verdict: 'failed' as const, required: true, attempts: 2, failingStep: { index: 2, name: step, reason: 'no heading' } });

test('unit:release-revert-area-match — revertTarget takes the failing required cases, their outcomes and tags, selects the maps whose file name or Paths name them, and returns the newest candidate item whose merge delta a selected map\'s globs cover, naming the case, step and map', () => {
  // The `board` case fails: its outcome is work-intake, its tags api and board; the store map matches by the `store` tag of create-work-item? No — only the failing case's own tags count.
  const uat = uatWith([failedCase('board', 'read the board'), { case: 'sign-in', verdict: 'passed', required: true, attempts: 1, failingStep: null }]);
  assert.deepEqual(failingRequiredCases(uat), [{ case: 'board', step: 'read the board', verdict: 'failed' }]);
  // No map is named board, api or work-intake: the newest candidate item is the fallback (tested below). A Paths segment naming the tag selects the map.
  const byPath = revertTarget(candidate, uat, deltas, [...maps, map('verification/intake.md', ['src/board/**', 'src/store/schema.ts'])], contract)!;
  assert.deepEqual([byPath.key, byPath.mergeSha, byPath.map, byPath.case, byPath.step, byPath.candidate], ['GY-2', sha('merge-2'), 'verification/intake.md', 'board', 'read the board', candidate.id]);
  assert.match(byPath.reason, /^Release candidate 20300501T120000Z \([0-9a-f]{12}\) failed required E2E case board at step "read the board" \(outcome work-intake\); verification map verification\/intake\.md matches it and its globs cover GY-2's merge delta \(src\/store\/schema\.ts\), so GY-2's merge [0-9a-f]{12} is reverted$/);
  // A map named for the tag (verification/api.md) covering an older item still loses to a newer covered item, but wins over an uncovered newest item.
  const byStem = revertTarget(candidate, uat, deltas, [...maps, map('verification/api.md', ['src/server/**'])], contract)!;
  assert.deepEqual([byStem.key, byStem.map], ['GY-1', 'verification/api.md'], 'GY-3 (web/) and GY-2 (store) are not covered by the api map; GY-1 is');
  // The outcome id names the map too, and the case id does.
  assert.equal(revertTarget(candidate, uat, deltas, [map('verification/work-intake.md', ['src/store/**'])], contract)!.key, 'GY-2');
  assert.equal(revertTarget(candidate, uat, deltas, [map('verification/board.md', ['src/server/**'])], contract)!.key, 'GY-1');
  // The newest covered item wins when two are covered: GY-2 is newer than GY-1.
  const both = revertTarget(candidate, uat, deltas, [map('verification/api.md', ['src/server/**', 'src/store/**'])], contract)!;
  assert.deepEqual([both.key, both.map], ['GY-2', 'verification/api.md']);
  // Only outright failures select: a flaky required case stays on the holds and evidence-decision path, and an optional failure is nothing.
  assert.equal(revertTarget(candidate, uatWith([{ ...failedCase('board'), verdict: 'flaky' }]), deltas, maps, contract), null, 'a flaky case reverts nothing');
  assert.equal(revertTarget(candidate, uatWith([{ ...failedCase('board'), required: false }], []), deltas, maps, contract), null, 'an optional failure reverts nothing');
  assert.equal(revertTarget(candidate, { e2e: null }, deltas, maps, contract), null, 'no release run, nothing to attribute');
  assert.equal(revertTarget({ ...candidate, items: [] }, uat, deltas, maps, contract), null, 'a candidate without items has nothing to revert');
  // The first failing case names the target; a second failing case's areas still select maps.
  const two = revertTarget(candidate, uatWith([failedCase('sign-in', 'sign in'), failedCase('create-work-item', 'create')]), deltas, maps, contract)!;
  assert.deepEqual([two.key, two.map, two.case, two.step], ['GY-2', 'verification/store.md', 'sign-in', 'sign in'], 'the store map is selected by create-work-item\'s store tag and covers GY-2');
});

test('unit:release-revert-newest-fallback — with no selected map, or none whose globs cover a candidate item\'s merge delta, revertTarget returns the newest candidate item and says why', () => {
  const uat = uatWith([failedCase('sign-in')]);
  // sign-in's tag is browser and its outcome sign-in: no map in the set is named for them or paths them.
  const none = revertTarget(candidate, uat, deltas, maps, contract)!;
  assert.deepEqual([none.key, none.mergeSha, none.map, none.case, none.step], ['GY-3', sha('merge-3'), null, 'sign-in', 'open the Work view']);
  assert.match(none.reason, /\(outcome sign-in\); no verification map names the case, its outcome or its tags, so the newest candidate item GY-3's merge [0-9a-f]{12} is reverted$/);
  // A selected map that covers no candidate item's delta still falls back, naming the map.
  const uncovered = revertTarget(candidate, uat, deltas, [map('verification/browser.md', ['web/vendor/**'])], contract)!;
  assert.deepEqual([uncovered.key, uncovered.map], ['GY-3', null]);
  assert.match(uncovered.reason, /the matching verification map verification\/browser\.md covers no candidate item's merge delta, so the newest candidate item GY-3's merge/);
  // An item without a delta is never covered, and the newest item is the candidate's first.
  assert.equal(revertTarget(candidate, uat, [], [map('verification/browser.md', ['**'])], contract)!.key, 'GY-3');
  assert.equal(revertTarget(candidate, uat, [], [], { outcomes: [] })!.key, 'GY-3', 'no contract at all still reverts the newest item');
});

test('unit:main-watch-candidate-revert — a revert the writer pushed is classified candidate-revert from the item\'s candidateReverts record, named by its candidate, and freezes nothing', () => {
  const revert: MainWatchCommit = { sha: sha('revert-2'), parents: [sha('merge-2')], subject: 'Revert "Merge pull request #2 from owner/graphyard/gy-2-1"', author: 'graphyard-merge-writer', at: iso(start - 3_600_000) };
  const item = { key: 'GY-2', candidateReverts: [{ mergeSha: sha('merge-2'), revertSha: sha('revert-2'), candidate: '20300501T120000Z', case: 'sign-in', step: 'open the Work view', at: iso(start) }] } as unknown as Work;
  const inputs = mainWatchInputs([item, { key: 'GY-1' } as unknown as Work], []);
  assert.deepEqual(inputs.candidateReverts, [{ sha: sha('revert-2'), id: '20300501T120000Z' }]);
  assert.deepEqual(candidateRevertsOf([item]), [{ sha: sha('revert-2'), id: '20300501T120000Z' }]);
  const [classified] = classifyMainCommits([revert], inputs);
  assert.deepEqual([classified.label, classified.by], ['candidate-revert', '20300501T120000Z']);
  assert.equal(classifyMainCommits([revert], mainWatchInputs([], []))[0].label, 'unknown', 'without the record the same commit is unknown');
  const verdict = mainWatchVerdict({ tip: revert.sha, since: null, commits: [revert] }, [], inputs, new Set(), start);
  assert.deepEqual([verdict.unknown, verdict.tip], [[], revert.sha], 'the revert is explained: nothing to report and nothing freezes');
});

// ---- The revert through the merge writer, against the real route ------------------------------------

const admin: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const credentials = [admin, coordinator].map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let pg: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
let fixtureRoot: string, origin: string, checkout: string, managed: string;
const merges: Record<string, string> = {};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function commit(cwd: string, path: string, text: string, message: string) {
  await mkdir(join(cwd, path, '..'), { recursive: true });
  await writeFile(join(cwd, path), text); git(cwd, 'add', '--', path); git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}
/** An item's branch merged into main the way the writer lands it, pushed to origin. */
async function mergeItem(key: string, pr: number, path: string, text: string) {
  const branch = `graphyard/${key.toLowerCase()}-1`;
  git(checkout, 'checkout', '-q', '-b', branch, 'refs/remotes/origin/main');
  await commit(checkout, path, text, `${key} change`);
  git(checkout, 'checkout', '-q', '--detach', 'refs/remotes/origin/main');
  git(checkout, 'merge', '-q', '--no-ff', branch, '-m', `Merge pull request #${pr} from owner/${branch}`, '-m', `${key}: the change`);
  git(checkout, 'push', '-q', 'origin', 'HEAD:main');
  git(checkout, 'fetch', '-q', 'origin');
  return (merges[key] = git(checkout, 'rev-parse', 'HEAD'));
}
before(async () => {
  fixtureRoot = await realpath(await temporaryDirectory('release-revert'));
  origin = join(fixtureRoot, 'origin.git'); checkout = join(fixtureRoot, 'checkout'); managed = join(fixtureRoot, 'managed');
  await mkdir(managed, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  for (const [key, value] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) git(checkout, 'config', key, value);
  await commit(checkout, 'README.md', '# Fixture\n', 'base');
  await commit(checkout, 'src/server/routes/work.ts', 'export const routes = 1;\n', 'routes');
  git(checkout, 'push', '-q', 'origin', 'main'); git(checkout, 'fetch', '-q', 'origin');
  await mergeItem('GY-1', 1, 'web/app.ts', 'export const app = 1;\n');
  await mergeItem('GY-2', 2, 'src/server/routes/work.ts', 'export const routes = 2;\n');
  // The checkout carries the maps and the contract the revert target is chosen from, as the coordinator checkout does.
  await mkdir(join(checkout, 'verification'), { recursive: true }); await mkdir(join(checkout, 'e2e', 'cases'), { recursive: true });
  await writeFile(join(checkout, 'verification', 'server.md'), 'Paths: src/server/**\n\n## Tests\n\n- tests/server.test.ts\n\n## Drive\n\nrun it\n\n## Invariants\n\n- none\n\n## Gotchas\n\n- none\n');
  await writeFile(join(checkout, 'e2e', 'contract.json'), JSON.stringify({ outcomes: [{ id: 'sign-in', title: 'An operator signs in', criteria: [], cases: ['sign-in'] }] }));
  await writeFile(join(checkout, 'e2e', 'cases', 'sign-in.json'), JSON.stringify({ id: 'sign-in', title: 'Sign in', tags: ['browser', 'server'], target: 'uat', required: true, steps: [] }));
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1526;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('release-revert-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('release_revert_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/release_revert_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.submissionObserver = null; engine.directMergeEnvironment = null;
  engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pg) await pg.stop(); if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });

async function request(credential: string, path: string, body?: unknown, key: string = randomUUID(), method = 'POST') {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
/** A delivered item, as the merge writer leaves one: done, with the delivery naming the merge commit on main. */
async function deliveredItem(mergeSha: string) {
  let created = await engine.execute(admin, 'create', null, { title: `Delivered ${mergeSha.slice(0, 8)}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['unit:app-works'] }] }, randomUUID());
  created = await engine.execute(admin, 'ready', created.id, {}, randomUUID());
  await store.transaction(async db => {
    const work: Work = (await db.query('SELECT document FROM work_items WHERE id=$1 FOR UPDATE', [created.id])).rows[0].document;
    work.stage = 'done'; work.delivery = { mergedAt: iso(start), mergeSha, authorizationRevision: work.revision };
    await db.query('UPDATE work_items SET document=$2 WHERE id=$1', [work.id, JSON.stringify(work)]);
  });
  return (await store.workDocument(created.id))!;
}
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: join('/keys', 'deploy'), retrials: 2 } } });
/** The coordinator's record port: the route, under the phase's own key, as effects.ts posts it. */
const recordThroughRoute: RevertPorts['record'] = async (work, event) => {
  const answer = await request(token(coordinator), `work/${work.key}/merge-record`, event, revertRecordKey(work, event));
  if (answer.status !== 200) throw new Error(`merge-record revert ${event.phase} refused (${answer.status}): ${JSON.stringify(answer.body)}`);
  return answer.body;
};

test('integration:candidate-revert-reopens-item — a failed required case makes the loop build `git revert -m 1 <mergeSha>` in a trial checkout, land it through the merge writer as ledger kind revert (intent, trial, pushed, reconciled), record candidateReverts on the item and reopen it with a rework naming the case and step; production is never promoted and the next cut starts after the revert', async () => {
  // GY-2 (routes) and GY-1 (web) delivered; the candidate that carries them was cut at GY-2's merge.
  const one = await deliveredItem(merges['GY-1']!), two = await deliveredItem(merges['GY-2']!);
  assert.deepEqual([one.key, two.key], ['GY-1', 'GY-2'], 'the fixture items carry the keys the merges name');
  const failed = cut(args => git(checkout, ...args), { base: 'main', trigger: 'manual', now: new Date(start - 600_000), push: true });
  assert.ok(failed.cut && failed.candidate.sha === merges['GY-2'], 'the candidate is main\'s tip, GY-2\'s merge');
  const cutCandidate = (failed as { cut: true; candidate: ReleaseCandidate }).candidate;
  assert.deepEqual(cutCandidate.items.map(item => item.key), [two.key, one.key]);
  const tipBefore = git(checkout, 'rev-parse', 'refs/remotes/origin/main');
  const localCandidate: LocalCandidate = { id: cutCandidate.id, sha: cutCandidate.sha, cutAt: cutCandidate.cutAt, items: cutCandidate.items.map(item => ({ key: item.key, mergeSha: item.mergeSha, pr: item.pr })) };
  // The real revert ports over the checkout (the trial stubbed to pass; a fixture has no build), the record going through the route.
  const trials: { revertSha: string; files: readonly string[] }[] = [];
  const real = localReleasePorts(config, checkout, defaultChildRun, { base: managed, record: recordThroughRoute, environment: { ...process.env, GRAPHYARD_UAT_URL: 'https://uat.example.test' }, now: () => start,
    trial: async (revertSha, files) => { trials.push({ revertSha, files }); return { build: 'pass', tests: { passed: 3, failed: [], files: 2 }, durationMs: 1 }; } })!;
  const calls: string[] = [];
  const validation: LocalValidation = { record: { result: 'failed', suites: [{ name: 'e2e', passed: false, detail: 'sign-in failed' }], followUp: 'GY-900', deployedSha: cutCandidate.sha,
    e2e: { runId: `rc-${cutCandidate.id}`, sha: cutCandidate.sha, blocking: ['sign-in'], cases: [{ case: 'sign-in', verdict: 'failed', required: true, attempts: 2, failingStep: { index: 2, name: 'open the Work view', reason: 'no heading' } }] } }, followUp: 'GY-900' };
  const local: LocalReleasePorts = { ...real,
    history: async () => [{ sha: merges['GY-2']!, at: iso(start - 1_200_000) }, { sha: merges['GY-1']!, at: iso(start - 1_500_000) }],
    cut: async () => { calls.push('cut'); return { cut: false, resume: localCandidate }; },
    uat: async id => { calls.push(`uat:${id}`); return { sha: cutCandidate.sha }; },
    validate: async id => { calls.push(`validate:${id}`); return validation; },
    promote: async id => { calls.push(`promote:${id}`); throw new Error('production must not move'); },
    verify: async () => { calls.push('verify'); throw new Error('nothing to verify'); },
  };
  const reads: PromotionReads & { local: LocalReleasePorts } = { ledger: async () => ({ mainSha: tipBefore, promotedSha: null, promotedAt: null, behind: null, candidates: [{ id: cutCandidate.id, sha: cutCandidate.sha, cutAt: cutCandidate.cutAt, prs: 2, queued: 0 }] }), runs: async () => [], dispatch: async () => { throw new Error('no dispatch in control-plane mode'); }, local };
  const result = await settleLocalPromotion(null, reads, { now: start, everyMinutes: 10, intervalMs: 20_000, frozen: null, watchedTip: tipBefore });
  assert.equal(result.failure, null, result.state.reason ?? '');
  assert.equal(result.state.inFlight, false);
  assert.deepEqual(calls, ['cut', `uat:${cutCandidate.id}`, `validate:${cutCandidate.id}`], 'promote and verify never run: production stays on the previous release');
  const revert = result.run!.revert!;
  assert.deepEqual([revert.target.key, revert.target.map, revert.target.case, revert.target.step], ['GY-2', 'verification/server.md', 'sign-in', 'open the Work view'], 'the server map, named by the case\'s server tag, covers GY-2\'s routes delta');
  assert.equal(revert.outcome.outcome, 'reverted', JSON.stringify(revert.outcome));
  const revertSha = (revert.outcome as { revertSha: string }).revertSha;
  // The revert commit is `git revert -m 1` of GY-2's merge: its parent is the tip, and its tree is the tree before that merge.
  assert.equal(git(origin, 'rev-parse', 'refs/heads/main'), revertSha, 'origin main is the revert commit');
  assert.equal(git(checkout, 'rev-parse', `${revertSha}^`), tipBefore);
  assert.equal(git(checkout, 'rev-parse', `${revertSha}^{tree}`), git(checkout, 'rev-parse', `${merges['GY-2']}^1^{tree}`), 'the tree is exactly the tree before GY-2 merged');
  assert.match(git(checkout, 'log', '-1', '--format=%s', revertSha), /^Revert "Merge pull request #2 from owner\/graphyard\/gy-2-1"/);
  assert.deepEqual(trials, [{ revertSha, files: ['src/server/routes/work.ts'] }], 'the trial ran on the exact revert commit with the files it changes');
  assert.equal(git(checkout, 'worktree', 'list').split('\n').length, 1, 'the trial checkout is removed');
  // The ledger holds the four phases under kind revert, in order, and the item records the revert and is reopened with the rework.
  const kinds = (await store.pool.query("SELECT kind, payload FROM events WHERE work_id=$1 AND kind LIKE 'merge.%' ORDER BY seq", [two.id])).rows as { kind: string; payload: { phase?: string } }[];
  assert.deepEqual(kinds.map(row => [row.kind, row.payload.phase]), [[revertLedgerKind, 'intent'], [revertLedgerKind, 'trial'], [revertLedgerKind, 'pushed'], [revertLedgerKind, 'reconciled']]);
  const reopened = (await store.workDocument(two.id))!;
  assert.deepEqual(reopened.candidateReverts, [{ mergeSha: merges['GY-2'], revertSha, candidate: cutCandidate.id, case: 'sign-in', step: 'open the Work view', at: iso(start) }]);
  assert.deepEqual([reopened.stage, reopened.delivery, reopened.submission, reopened.candidate, reopened.reworkRequested], ['ready', undefined, null, null, false], 'the item is back in ready for a fresh pull request');
  const saved = (await store.pool.query('SELECT kind, payload FROM events WHERE work_id=$1 AND kind=$2', [two.id, revertReopenedReason])).rows[0] as { payload: { details?: { rework?: string; reopened?: boolean } } & { rework?: string } };
  const rework = saved.payload.details?.rework ?? saved.payload.rework;
  assert.equal(rework, candidateRevertReason(reopened, reopened.candidateReverts![0]));
  assert.match(rework!, /failed required E2E case sign-in at step "open the Work view" on UAT\. Production stays on the previous release/);
  assert.equal((await store.workDocument(one.id))!.stage, 'done', 'the other candidate item stays delivered');
  assert.match(result.state.reason!, /reverted as [0-9a-f]{12} on [0-9a-f]{12} and GY-2 reopened for rework; production stays on the previous release; the next cut starts after the revert/);
  // The next cut starts after the revert: it is main's tip, lists GY-1 and not the reverted GY-2, and the main watch explains the revert commit.
  const next = cut(args => git(checkout, ...args), { base: 'main', trigger: 'manual', now: new Date(start + 60_000), push: true });
  assert.ok(next.cut, JSON.stringify(next));
  const following = (next as { cut: true; candidate: ReleaseCandidate }).candidate;
  assert.deepEqual([following.sha, following.from?.id, following.items.map(item => item.key)], [revertSha, cutCandidate.id, ['GY-1']]);
  assert.deepEqual(itemsFromCommits([{ sha: revertSha, subject: 'Revert "Merge pull request #2 from owner/graphyard/gy-2-1"', body: '' }, { sha: merges['GY-2']!, subject: 'Merge pull request #2 from owner/graphyard/gy-2-1', body: '' }]), []);
  assert.equal(readLedger(args => git(checkout, ...args)).production.length, 0, 'nothing was promoted');
  const watched = classifyMainCommits([{ sha: revertSha, parents: [tipBefore], subject: 'Revert "Merge pull request #2 from owner/graphyard/gy-2-1"', author: 'graphyard-merge-writer', at: iso(start) }], mainWatchInputs([reopened], []));
  assert.deepEqual([watched[0].label, watched[0].by], ['candidate-revert', cutCandidate.id]);
  // Replaying a phase under its key answers the same; the route refuses a revert of a merge the item did not deliver and a reconcile main does not hold.
  const replay = await request(token(coordinator), `work/${two.key}/merge-record`, { kind: 'revert', phase: 'reconciled', mergeSha: merges['GY-2'], revertSha, observedTip: revertSha, candidate: cutCandidate.id, case: 'sign-in', step: 'open the Work view', at: iso(start) }, revertRecordKey(two, { kind: 'revert', phase: 'reconciled', mergeSha: merges['GY-2']!, revertSha, observedTip: revertSha, candidate: cutCandidate.id, case: 'sign-in', step: 'open the Work view', at: iso(start) }));
  assert.equal(replay.status, 200); assert.equal(replay.body.candidateReverts.length, 1);
  const wrong = await request(token(coordinator), `work/${one.key}/merge-record`, { kind: 'revert', phase: 'intent', mergeSha: merges['GY-2'], revertSha: sha('x'), baseTip: tipBefore, candidate: cutCandidate.id, case: 'sign-in', step: 's', at: iso(start) });
  assert.equal(wrong.status, 409); assert.equal(wrong.body.error ?? wrong.body.message, unrevertableRefusal('GY-1', merges['GY-2']!, merges['GY-1']!));
  const unheld = await request(token(coordinator), `work/${one.key}/merge-record`, { kind: 'revert', phase: 'reconciled', mergeSha: merges['GY-1'], revertSha: sha('never-pushed'), observedTip: revertSha, candidate: cutCandidate.id, case: 'sign-in', step: 's', at: iso(start) });
  assert.equal(unheld.status, 409); assert.equal(unheld.body.error ?? unheld.body.message, unheldRevertRefusal(sha('never-pushed'), 'main'));
  assert.equal((await request(token(admin), `work/${one.key}/merge-record`, { kind: 'revert', phase: 'intent', mergeSha: merges['GY-1'], revertSha: sha('x'), baseTip: tipBefore, candidate: 'c', case: 'sign-in', step: 's', at: iso(start) })).status, 403, 'only the coordinator records');
  assert.throws(() => revertRecordBodySchema.parse({ kind: 'revert', phase: 'intent', mergeSha: merges['GY-1'], candidate: 'c', case: 'sign-in', step: 's', at: iso(start) }), 'an intent without the revert commit is malformed');
});

test('unit:release-revert-newest-fallback — revertCandidateItem refuses a conflicting revert, a failed trial or a merge main no longer holds without pushing, re-trials a push the tip moved under at most retrials times, and applyCandidateRevert reopens only the item still holding the delivery', async () => {
  const target = { mergeSha: sha('merge-9'), candidate: '20300501T120000Z', case: 'sign-in', step: 'open the Work view' };
  const item = { id: 'w9', key: 'GY-9' };
  function ports(options: { holds?: boolean; conflict?: string[]; build?: 'pass' | 'fail'; failedTests?: string[]; pushes?: ('pushed' | 'rejected')[]; tips?: string[] } = {}) {
    const calls: string[] = [], events: RevertRecordEvent[] = [];
    let fetches = 0, pushed = 0;
    const port: RevertPorts = {
      baseBranch: 'main', retrials: 2, now: () => start,
      fetch: async () => { calls.push('fetch'); const tips = options.tips ?? [sha('tip')]; return tips[Math.min(fetches++, tips.length - 1)]!; },
      holds: async () => { calls.push('holds'); return options.holds ?? true; },
      revert: async (mergeSha, baseTip) => { calls.push(`revert:${baseTip.slice(0, 6)}`); return options.conflict ? { conflict: options.conflict } : { revertSha: sha(`revert:${mergeSha}:${baseTip}`), files: ['src/a.ts'] }; },
      trial: async revertSha => { calls.push(`trial:${revertSha.slice(0, 6)}`); return { build: options.build ?? 'pass', tests: { passed: 1, failed: options.failedTests ?? [], files: 1 }, durationMs: 5 }; },
      push: async () => { calls.push('push'); const pushes = options.pushes ?? ['pushed']; return pushes[Math.min(pushed++, pushes.length - 1)]!; },
      record: async (_work, event) => { calls.push(`record:${event.phase}`); events.push(event); },
    };
    return { port, calls, events };
  }
  const clean = ports();
  const landed = await revertCandidateItem(clean.port, item, target);
  const revertSha = sha(`revert:${target.mergeSha}:${sha('tip')}`);
  assert.deepEqual(landed, { outcome: 'reverted', revertSha, baseTip: sha('tip'), observedTip: sha('tip'), pushes: 1 });
  assert.deepEqual(clean.calls, ['fetch', 'holds', `revert:${sha('tip').slice(0, 6)}`, 'record:intent', `trial:${revertSha.slice(0, 6)}`, 'record:trial', 'push', 'record:pushed', 'fetch', 'record:reconciled']);
  assert.ok(clean.calls.indexOf('record:intent') < clean.calls.indexOf('push'), 'the intent is on the ledger before the push');
  assert.deepEqual(clean.events[0], { kind: 'revert', phase: 'intent', mergeSha: target.mergeSha, revertSha, baseTip: sha('tip'), candidate: target.candidate, case: 'sign-in', step: 'open the Work view', at: iso(start) });
  assert.deepEqual(clean.events[3], { kind: 'revert', phase: 'reconciled', mergeSha: target.mergeSha, revertSha, observedTip: sha('tip'), candidate: target.candidate, case: 'sign-in', step: 'open the Work view', at: iso(start) });
  assert.equal(revertRecordKey(item, clean.events[0]), `revert-record:w9:intent:${target.mergeSha}:${revertSha}:${sha('tip')}`);
  const refusals: [string, Parameters<typeof ports>[0], RegExp][] = [
    ['conflict', { conflict: ['src/a.ts'] }, /revert refused: the revert conflicts in src\/a\.ts/],
    ['failed build', { build: 'fail' }, /revert refused: the trial of [0-9a-f]{12} failed build step npm run build/],
    ['failed tests', { failedTests: ['tests/a.test.ts'] }, /revert refused: the trial of [0-9a-f]{12} failed tests tests\/a\.test\.ts/],
    ['unheld merge', { holds: false }, /revert refused: main no longer holds [0-9a-f]{12} in its first-parent history/],
  ];
  for (const [name, options, expected] of refusals) {
    const refused = ports(options);
    const outcome = await revertCandidateItem(refused.port, item, target);
    assert.equal(outcome.outcome, 'refused', name); assert.match((outcome as { reason: string }).reason, expected, name);
    assert.ok(!refused.calls.includes('push'), `${name}: nothing is pushed`);
    assert.equal(refused.events.at(-1)?.phase, 'refused', `${name}: the refusal is recorded`);
  }
  // A push the tip moved under rebuilds on the new tip; past the bound the revert is left queued.
  const moved = ports({ pushes: ['rejected', 'pushed'], tips: [sha('tip'), sha('tip2')] });
  const second = await revertCandidateItem(moved.port, item, target);
  assert.deepEqual([second.outcome, (second as { pushes: number }).pushes, (second as { baseTip: string }).baseTip], ['reverted', 2, sha('tip2')]);
  const stuck = ports({ pushes: ['rejected'] });
  const queued = await revertCandidateItem(stuck.port, item, target);
  assert.deepEqual([queued.outcome, (queued as { pushes: number }).pushes], ['requeued', 3]);
  assert.match((queued as { reason: string }).reason, /base moved 3 times/);
  // The item's record: replace by merge, reopen only while the delivery stands.
  const work = { key: 'GY-9', stage: 'done', revision: 3, delivery: { mergedAt: iso(start), mergeSha: target.mergeSha, authorizationRevision: 1 }, submission: { epoch: 1, pr: 9 }, candidate: { sha: sha('h') }, lease: null, pipeline: { attempts: [], reworkRounds: 0 } } as unknown as Work;
  const revert = { mergeSha: target.mergeSha, revertSha, candidate: target.candidate, case: 'sign-in', step: 'open the Work view', at: iso(start) };
  assert.deepEqual(applyCandidateRevert(work, revert, new Date(start)), { reopened: true });
  assert.deepEqual([work.stage, work.delivery, work.submission, work.candidate, work.candidateReverts], ['ready', undefined, null, null, [revert]]);
  assert.deepEqual(applyCandidateRevert(work, { ...revert, revertSha: sha('again') }, new Date(start)), { reopened: false }, 'reopened once');
  assert.deepEqual(work.candidateReverts!.map(entry => entry.revertSha), [sha('again')], 'the entry for the same merge is replaced');
  assert.match(candidateRevertReason(work, revert), /^GY-9's merge [0-9a-f]{12} was reverted \([0-9a-f]{12}\): release candidate 20300501T120000Z failed required E2E case sign-in at step "open the Work view" on UAT\./);
});
