import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer as netServer, type AddressInfo } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import { Store, save } from '../src/store.js';
import { lockedWork } from '../src/store/locked-read.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal } from '../src/model.js';
import type { ExactCandidate } from '../src/model/release.js';
import type { PromotedCandidate, PromotionRequest } from '../src/server/routes/candidates.js';
import { cutAsync, readLedgerAsync, serveStaticSite, syncLedgerAsync, promoteAsync, type AsyncGit, type ReleaseCandidate } from '../src/release-candidate.js';
import { buildStaticSite, projectCaseSuite, validateProjectCandidate } from '../src/release-project.js';
import * as releasePorts from '../src/daemon/release-ports.js';
import type { E2eLauncher, E2eReport } from '../src/e2e/runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { candidatePromotionKind, historyLimit } from '../src/delivery.js';

// GY-1905 (GOAL-1, candidate-gates-promotion): an exact candidate is selected for production only
// when its combined required cases — every required case its own checkout declares, run through the
// project case suite against that exact source — passed on exactly the source, membership and
// artifact being promoted. A failed candidate stays on record naming its failed case, never
// promotes, and production keeps the release it last selected.

const operator: Principal = { id: 'operator', role: 'admin' }, coordinator: Principal = { id: 'graphyard', role: 'coordinator' };
const reader: Principal = { id: 'reader-1', role: 'reader' };
const tokens = { operator: `operator-${'o'.repeat(40)}`, coordinator: `coordinator-${'c'.repeat(40)}`, reader: `reader-${'r'.repeat(40)}`, scoped: `scoped-${'s'.repeat(40)}` };
const credentials = [{ ...operator, token: tokens.operator }, { ...coordinator, token: tokens.coordinator }, { ...reader, token: tokens.reader }];

let database: EmbeddedPostgres, connection: string, store: Store, http: ReturnType<typeof server>, url: string, origin: string, checkout: string, root: string;
const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const asyncGit: AsyncGit = async args => git(...args);
// A namespace import, so a checkout without the gate still loads this file and fails in its cases.
const { exactCandidatePorts, exactValidation } = releasePorts;
const candidateArtifact: typeof releasePorts.candidateArtifact = (...args) => releasePorts.candidateArtifact(...args);
const requiredCaseIds: typeof releasePorts.requiredCaseIds = (...args) => releasePorts.requiredCaseIds(...args);
const exactPromotionGate: typeof releasePorts.exactPromotionGate = (...args) => releasePorts.exactPromotionGate(...args);
const freePort = async () => { const probe = netServer(); await new Promise<void>(done => probe.listen(0, '127.0.0.1', done)); const { port } = probe.address() as AddressInfo; await new Promise<void>(done => probe.close(() => done())); return port; };
async function start() {
  store = new Store(connection); await store.init();
  http = server(new Engine(store, 120, 'owner/fixture'), credentials);
  await new Promise<void>(done => http.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}
async function stop() { await new Promise<void>(done => http.close(() => done())); await store.close(); }

let keys = 0;
const call = async (method: string, path: string, as: keyof typeof tokens, body?: unknown, key: string | null = `key-${++keys}`) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${tokens[as]}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
/** The loop's own candidate ports over this plane, as the coordinator: a refusal throws carrying its status, as the master's client does. */
const ports = exactCandidatePorts(async (path, data, requestId) => {
  const answer = await call('POST', path, 'coordinator', data, requestId ?? `port-${++keys}`);
  if (answer.status >= 300) throw Object.assign(new Error(JSON.stringify(answer.body)), { status: answer.status });
  return answer.body;
}, async path => (await call('GET', path, 'reader')).body);

/** A browser double that drives the loopback UAT over HTTP: `open` loads the page, `expectText` finds text in what it loaded. */
const httpBrowser: E2eLauncher = { launch: async () => ({ close: async () => {}, newPage: async () => {
  let body = '';
  const locator = (text: string): any => ({ first: () => locator(text), click: async () => {}, fill: async () => {},
    waitFor: async () => { if (!body.includes(text)) throw new Error(`"${text}" is not on the page`); } });
  return { on: () => {}, close: async () => {}, getByText: (text: string) => locator(text), getByRole: (_role: string, options: { name: string }) => locator(options.name), getByLabel: () => locator(''),
    goto: async (target: string) => { const response = await fetch(target); if (!response.ok) throw new Error(`${target} answered ${response.status}`); body = await response.text(); } };
} }) } as unknown as E2eLauncher;
const build = 'mkdir -p dist && cp -R site/. dist/';

const write = async (path: string, content: unknown) => { await mkdir(join(checkout, path, '..'), { recursive: true }); await writeFile(join(checkout, path), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`); };
const home = (line: string) => `<h1>Fixture static site</h1><p>${line}</p>\n`;
const app = (greeting: string) => `<h1>Fixture compose app</h1><p>${greeting}</p>\n`;
const openCase = (id: string, path: string, text: string) => ({ id, title: `${id} shows its page`, tags: ['fixture'], target: 'uat', required: true,
  steps: [{ kind: 'browser', action: 'open', path }, { kind: 'browser', action: 'expectText', text }] });

before(async () => {
  const port = await freePort();
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('goal-candidate-promotion-pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('promotion_test');
  connection = `postgres://graphyard:testing-only@127.0.0.1:${port}/promotion_test`;
  await start();
  root = await temporaryDirectory('goal-candidate-promotion-git');
  origin = join(root, 'origin.git'); checkout = join(root, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  for (const [key, value] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) git('config', key, value);
  // The fixture project: a static site and an app page, and the two combined required cases that read them.
  await write('site/index.html', home('base'));
  await write('site/app.html', app('Hello'));
  await write('e2e/cases/fixture-static-home.json', openCase('fixture-static-home', '/', 'Fixture static site'));
  await write('e2e/cases/fixture-compose-app.json', openCase('fixture-compose-app', '/app.html', 'Fixture compose app'));
  git('add', '-A'); git('commit', '-q', '-m', 'fixture project'); git('push', '-q', 'origin', 'main'); git('fetch', '-q', 'origin');
});
after(async () => { if (http) await new Promise<void>(done => http.close(() => done())); if (store) await store.close().catch(() => {}); if (database) await database.stop(); });

let merges = 0;
/** A change Graphyard delivered: an item created through the API, its files merged on main, then recorded done with that merge commit. */
async function delivered(title: string, files: Record<string, string>) {
  const answer = await call('POST', 'work', 'operator', { title, description: 'A change delivered to main, waiting for its candidate.', type: 'feature', priority: 3,
    policy: { checks: ['test'], review: true }, criteria: [{ id: 'AC-1', text: 'The change is delivered', proofs: ['unit:delivered'] }] });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const branch = `graphyard/promotion-${++merges}`;
  git('checkout', '-q', '-b', branch, 'refs/remotes/origin/main');
  for (const [path, content] of Object.entries(files)) await write(path, content);
  git('add', '-A'); git('commit', '-q', '-m', title);
  git('checkout', '-q', '--detach', 'refs/remotes/origin/main');
  git('merge', '-q', '--no-ff', branch, '-m', `Merge pull request #${merges} from owner/${branch}`);
  git('push', '-q', 'origin', 'HEAD:main'); git('fetch', '-q', 'origin');
  const mergeSha = git('rev-parse', 'HEAD');
  await store.transaction(async (db, now) => {
    const work = structuredClone((await lockedWork(db, [answer.body.id])).find(entry => entry.id === answer.body.id)!);
    work.stage = 'done';
    work.delivery = { mergedAt: new Date(now.getTime() - 60_000).toISOString(), mergeSha, authorizationRevision: work.revision };
    await save(db, work, 'graphyard', 'merge-writer.reconciled', now, { mergeSha });
  });
  return { id: answer.body.id as string, key: answer.body.key as string, mergeSha };
}
let clock = Date.now();
/** The plane cuts the next exact candidate and the loop tags `rc/ID` at its source, as the release drive does. */
async function cutAndTag(): Promise<{ candidate: ExactCandidate; record: ReleaseCandidate }> {
  const answer = await call('POST', 'candidates', 'coordinator', { trigger: 'manual' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const candidate = answer.body as ExactCandidate;
  const result = await cutAsync(asyncGit, { base: 'main', trigger: 'manual', now: new Date(clock += 60_000), push: true,
    exact: { id: candidate.id, identity: candidate.identity, sourceSha: candidate.sourceSha, members: candidate.members.map(member => ({ key: member.key, mergeSha: member.mergeSha, pr: member.pr })) } });
  assert.equal(result.cut, true, JSON.stringify(result));
  const record = (await readLedgerAsync(asyncGit)).candidates.find(entry => entry.exact?.id === candidate.id)!;
  assert.equal(record.sha, candidate.sourceSha);
  return { candidate, record };
}
/** The existing combined suite over the candidate's own checkout at its exact source: every required case, on the static build served on loopback. */
async function combined(record: ReleaseCandidate) {
  const tree = join(root, `candidate-${record.id.replace(/[^A-Za-z0-9-]/g, '-')}`);
  git('worktree', 'add', '-q', '--detach', tree, record.sha);
  return validateProjectCandidate(asyncGit, record.id, { checkout: tree, uat: { static: { directory: 'dist', build } }, token: '', base: 'main', push: true, timeoutMs: 30_000,
    launcher: httpBrowser, stepTimeoutMs: 5_000, file: async () => 'GY-900' });
}
/** The candidate as the plane reads it back. */
const read = async (id: string) => { const answer = await call('GET', `candidates/${id}`, 'reader'); assert.equal(answer.status, 200); return answer.body as PromotedCandidate; };
/** What the loop's promoter asks the plane for this record: its exact source, identity, artifact and the required cases its commit declares. */
const ask = async (record: ReleaseCandidate): Promise<PromotionRequest> => ({ environment: 'production', release: record.id, sha: record.sha, identity: record.exact!.identity,
  artifact: await candidateArtifact(asyncGit, record), required: await requiredCaseIds(asyncGit, record.sha) });
const promote = (id: string, body: PromotionRequest, key?: string) => call('POST', `candidates/${id}/promotion`, 'coordinator', body, key);
/** The loop's promotion of `rc/ID`: the git ledger's own assessment, then the plane's exact-candidate gate, then the production branch. */
const promoteRecord = (record: ReleaseCandidate) => promoteAsync(asyncGit, record.id, { base: 'main', push: true, now: new Date(clock += 60_000), gate: candidate => exactPromotionGate(ports, asyncGit, candidate) });
const production = async () => { await syncLedgerAsync(asyncGit, 'main'); return execFileSync('git', ['-C', origin, 'rev-parse', '--verify', '--quiet', 'refs/heads/release/production'], { encoding: 'utf8' }).trim(); };
const selected = async () => (await call('GET', 'candidates', 'reader')).body.production as { candidate: string; releaseId: string; sourceSha: string } | null;
/** What the delivery view expects production to run: the release id and the source it is bound to. */
const expectedProduction = async () => {
  const answer = await call('GET', 'delivery', 'reader');
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const environment = answer.body.environments.find((entry: { id: string }) => entry.id === 'production');
  return environment && { id: environment.id, releaseId: environment.expected?.releaseId, sourceSha: environment.expected?.sourceSha };
};

test('integration:goal-combined-candidate-gates — the combined required case suite runs against each pinned candidate; only an all-passing exact source and artifact is selected for promotion, and a changed source, artifact, stale validation or missing required case fails closed', { timeout: 120_000 }, async () => {
  assert.deepEqual(await requiredCaseIds(asyncGit, git('rev-parse', 'refs/remotes/origin/main')), ['fixture-compose-app', 'fixture-static-home'], 'the checkout declares both combined required cases');

  // A candidate with no validation, or none yet recorded on the plane, is never selected.
  await delivered('Home line A', { 'site/index.html': home('change A') });
  const first = await cutAndTag();
  const unvalidated = await promote(first.candidate.id, await ask(first.record));
  assert.equal(unvalidated.status, 409); assert.match(unvalidated.body.error, /holds no validation/);

  // The combined suite runs on the pinned source and passes every required case; its verdict is recorded with the artifact it ran against.
  const run = await combined(first.record);
  assert.equal(run.record.result, 'passed', JSON.stringify(run.record.suites));
  assert.deepEqual(Object.fromEntries(run.record.e2e!.cases.map(entry => [entry.case, entry.verdict])), { 'fixture-compose-app': 'passed', 'fixture-static-home': 'passed' });
  const verdict = exactValidation({ ...first.record, exact: first.record.exact! }, run.record, await candidateArtifact(asyncGit, first.record));
  assert.deepEqual(verdict.required, ['fixture-compose-app', 'fixture-static-home']);
  assert.match(verdict.artifact!, /^tree:[0-9a-f]{40}$/);
  await ports.validated(first.candidate.id, verdict);

  // Every promotion that names anything other than exactly what was validated fails closed and records nothing.
  const exact = await ask(first.record);
  const other = git('rev-parse', `${first.record.sha}^1`);
  const refusals: [string, PromotionRequest, RegExp][] = [
    ['changed source', { ...exact, sha: other }, /is not candidate C-\d+'s/],
    ['changed artifact', { ...exact, artifact: `tree:${git('rev-parse', `${other}^{tree}`)}` }, /is not the tree:[0-9a-f]{40} the validation of C-\d+ tested/],
    ['changed membership', { ...exact, identity: `sha256:${'0'.repeat(64)}` }, /is not candidate C-\d+'s membership/],
    ['another release record', { ...exact, release: 'rc-other' }, /was run as .*, not rc-other/],
    ['a required case the run never ran', { ...exact, required: [...exact.required, 'fixture-checkout'] }, /required case fixture-checkout never ran/],
  ];
  for (const [label, body, pattern] of refusals) {
    const answer = await promote(first.candidate.id, body);
    assert.equal(answer.status, 409, label); assert.match(answer.body.error, pattern, label);
    assert.equal((await read(first.candidate.id)).promotion, null, `${label} selected nothing`);
  }
  // The exact ask is selected and recorded once: a retry answers it, the loop's gate agrees, and production moves to its source.
  assert.equal((await promote(first.candidate.id, exact)).status, 200);
  const promoted = await read(first.candidate.id);
  assert.deepEqual({ environment: promoted.promotion!.environment, releaseId: promoted.promotion!.releaseId, sourceSha: promoted.promotion!.sourceSha, artifact: promoted.promotion!.artifact, required: promoted.promotion!.required },
    { environment: 'production', releaseId: first.record.id, sourceSha: first.candidate.sourceSha, artifact: exact.artifact, required: ['fixture-compose-app', 'fixture-static-home'] });
  assert.equal((await promote(first.candidate.id, exact)).status, 200, 'the same exact request again answers the recorded selection');
  const moved = await promoteRecord(first.record);
  assert.equal(moved.promoted, true, JSON.stringify(moved));
  assert.equal(await production(), first.candidate.sourceSha, 'production is the selected candidate\'s exact source');
  assert.equal((await selected())!.candidate, first.candidate.id);
  assert.deepEqual(await expectedProduction(), { id: 'production', releaseId: first.record.id, sourceSha: first.candidate.members[0].mergeSha }, 'the delivery view expects the promoted release, bound to its member\'s merge commit');
  const otherArtifact = await promote(first.candidate.id, { ...exact, artifact: `tree:${git('rev-parse', `${other}^{tree}`)}` });
  assert.equal(otherArtifact.status, 409); assert.match(otherArtifact.body.error, /already promoted to production/);

  // A validation that passed but never ran a required case its checkout declares (the suite skipped it) fails closed at the promoter's gate, before any deploy.
  await delivered('Home line B', { 'site/index.html': home('change B') });
  const skipped = await cutAndTag();
  const skippedRun = await combined(skipped.record);
  assert.equal(skippedRun.record.result, 'passed');
  const partial = { ...skippedRun.record, e2e: { ...skippedRun.record.e2e!, cases: skippedRun.record.e2e!.cases.filter(entry => entry.case !== 'fixture-compose-app') } };
  await ports.validated(skipped.candidate.id, exactValidation({ ...skipped.record, exact: skipped.record.exact! }, partial, await candidateArtifact(asyncGit, skipped.record)));
  const gated = await promoteRecord(skipped.record);
  assert.equal(gated.promoted, false);
  assert.match((gated as { refusals: string[] }).refusals.join(' '), /required case fixture-compose-app never ran/);
  assert.equal(await production(), first.candidate.sourceSha, 'the gate refused before the production branch moved');
  assert.equal((await read(skipped.candidate.id)).promotion, null);

  // A required case that failed under its outcome's pending contract did not block the run, but it did not pass: the gate refuses it.
  await delivered('Home line P', { 'site/index.html': home('change P') });
  const pending = await cutAndTag();
  const pendingRun = await combined(pending.record);
  const pendingRecord = { ...pendingRun.record, e2e: { ...pendingRun.record.e2e!, cases: pendingRun.record.e2e!.cases.map(entry => entry.case === 'fixture-static-home' ? { ...entry, verdict: 'failed' as const, pending: true as const } : entry) } };
  const pendingVerdict = exactValidation({ ...pending.record, exact: pending.record.exact! }, pendingRecord, await candidateArtifact(asyncGit, pending.record));
  assert.equal(pendingVerdict.result, 'pass', 'the run itself passed: the pending case did not block it');
  assert.deepEqual(pendingVerdict.cases, [{ id: 'fixture-compose-app', result: 'pass' }, { id: 'fixture-static-home', result: 'pending' }]);
  await ports.validated(pending.candidate.id, pendingVerdict);
  const pendingAnswer = await promote(pending.candidate.id, await ask(pending.record));
  assert.equal(pendingAnswer.status, 409); assert.match(pendingAnswer.body.error, /required case fixture-static-home \(pending\) did not pass/);
  assert.equal((await read(pending.candidate.id)).promotion, null);
  assert.equal(await production(), first.candidate.sourceSha);

  // A validation recorded with no artifact binds nothing to what would deploy; a stale one ran longer ago than the UAT window,
  // even when the plane records it late, as a verdict recovered after a restart is.
  await delivered('Home line C', { 'site/index.html': home('change C') });
  const unbound = await cutAndTag();
  const unboundRun = await combined(unbound.record);
  await ports.validated(unbound.candidate.id, exactValidation({ ...unbound.record, exact: unbound.record.exact! }, unboundRun.record));
  const noArtifact = await promote(unbound.candidate.id, await ask(unbound.record));
  assert.equal(noArtifact.status, 409); assert.match(noArtifact.body.error, /names no artifact/);
  await delivered('Home line D', { 'site/index.html': home('change D') });
  const stale = await cutAndTag();
  const staleRun = await combined(stale.record);
  const ranAt = new Date(Date.now() - 5 * 3_600_000).toISOString();
  await ports.validated(stale.candidate.id, exactValidation({ ...stale.record, exact: stale.record.exact! }, { ...staleRun.record, at: ranAt }, await candidateArtifact(asyncGit, stale.record)));
  const recovered = await read(stale.candidate.id);
  assert.equal(recovered.validation!.ranAt, ranAt); assert.ok(Date.parse(recovered.validation!.at) - Date.parse(ranAt) > 4 * 3_600_000, 'the plane recorded it hours after the run');
  const staleAnswer = await promote(stale.candidate.id, await ask(stale.record));
  assert.equal(staleAnswer.status, 409); assert.match(staleAnswer.body.error, new RegExp(`ran at ${ranAt.replace(/[.]/g, '\\.')} and is stale: older than 4 hours`));

  // A newer candidate that passes is selected; the older passing one is then superseded, never a promotion back.
  await delivered('Home line E', { 'site/index.html': home('change E') });
  const newer = await cutAndTag();
  const newerRun = await combined(newer.record);
  await ports.validated(newer.candidate.id, exactValidation({ ...newer.record, exact: newer.record.exact! }, newerRun.record, await candidateArtifact(asyncGit, newer.record)));
  const newerMoved = await promoteRecord(newer.record);
  assert.equal(newerMoved.promoted, true, JSON.stringify(newerMoved));
  assert.equal(await production(), newer.candidate.sourceSha);
  const freshUnbound = await promote(unbound.candidate.id, await ask(unbound.record));
  assert.equal(freshUnbound.status, 409); assert.match(freshUnbound.body.error, new RegExp(`superseded: the later ${newer.candidate.id} is already promoted`));
  assert.deepEqual(await expectedProduction(), { id: 'production', releaseId: newer.record.id, sourceSha: newer.candidate.members[0].mergeSha });
  // A recorded build is the artifact only under the digest adapter; a commit deployment's artifact is its source tree.
  const built = { ...newer.record, build: { artifacts: [{ service: 'web', digest: `sha256:${'a'.repeat(64)}` }] } } as unknown as ReleaseCandidate;
  assert.equal(await candidateArtifact(asyncGit, built), `tree:${git('rev-parse', `${newer.record.sha}^{tree}`)}`);
  assert.match(await candidateArtifact(asyncGit, built, true), /^sha256:[0-9a-f]{64}$/);
  // A release record the plane never cut is refused by the promoter's gate.
  assert.match((await exactPromotionGate(ports, asyncGit, { ...newer.record, exact: undefined })).join(' '), /not an exact candidate the plane cut/);
  const events = await store.pool.query("SELECT payload->>'candidate' AS id FROM events WHERE kind='release.candidate.promotion' ORDER BY seq");
  assert.deepEqual(events.rows.map(row => row.id), [first.candidate.id, newer.candidate.id], 'only the two exact passing candidates were ever selected');
});

test('integration:goal-failed-candidate-retained — a change that passes its own preview but breaks another combined required case leaves a durable failed candidate naming that case, which never promotes; production keeps the previous selected release through restart and retries', { timeout: 120_000 }, async () => {
  // The previous selected release: a passing candidate, promoted.
  await delivered('App greeting Hi', { 'site/app.html': app('Hi') });
  const previous = await cutAndTag();
  const previousRun = await combined(previous.record);
  await ports.validated(previous.candidate.id, exactValidation({ ...previous.record, exact: previous.record.exact! }, previousRun.record, await candidateArtifact(asyncGit, previous.record)));
  assert.equal((await promoteRecord(previous.record)).promoted, true);
  assert.equal(await production(), previous.candidate.sourceSha);

  // The change: a new app greeting, which its own declared case judges, and the static home's heading removed.
  const breaking = await delivered('App greeting Welcome; home heading dropped', { 'site/app.html': app('Welcome'), 'site/index.html': '<p>A page with no heading</p>\n' });
  // Its individual preview: its declared case alone, on its own merge built and served on loopback, passes.
  const preview = join(root, 'preview-breaking');
  git('worktree', 'add', '-q', '--detach', preview, breaking.mergeSha);
  assert.equal(await buildStaticSite(build, preview, 30_000), null);
  const served = await serveStaticSite(join(preview, 'dist'), breaking.mergeSha);
  let own: E2eReport | null = null;
  try {
    const result = await projectCaseSuite(preview, '', { launcher: httpBrowser, stepTimeoutMs: 5_000, select: entry => entry.definition.id === 'fixture-compose-app', report: value => { own = value; } }).run(served.url, { id: 'preview' } as never);
    assert.equal(result.passed, true, result.detail);
  } finally { await served.close(); }
  assert.deepEqual(own!.cases.map(entry => [entry.id, entry.verdict]), [['fixture-compose-app', 'passed']], 'the change passes its own preview');

  // Its candidate runs every combined required case and fails on the other one.
  const failing = await cutAndTag();
  assert.deepEqual(failing.candidate.members.map(member => member.workId), [breaking.id]);
  const run = await combined(failing.record);
  assert.equal(run.record.result, 'failed');
  assert.deepEqual(Object.fromEntries(run.record.e2e!.cases.map(entry => [entry.case, entry.verdict])), { 'fixture-compose-app': 'passed', 'fixture-static-home': 'failed' });
  const verdict = exactValidation({ ...failing.record, exact: failing.record.exact! }, run.record, await candidateArtifact(asyncGit, failing.record));
  await ports.validated(failing.candidate.id, verdict);

  const retained = async (label: string) => {
    const record = await read(failing.candidate.id);
    assert.equal(record.validation?.result, 'fail', label);
    assert.ok(record.validation!.failed.includes('fixture-static-home'), `${label}: ${JSON.stringify(record.validation!.failed)}`);
    assert.deepEqual(record.validation!.cases, [{ id: 'fixture-compose-app', result: 'pass' }, { id: 'fixture-static-home', result: 'fail' }], label);
    assert.equal(record.promotion, null, `${label}: never promoted`);
    assert.equal(record.sourceSha, breaking.mergeSha);
    assert.equal(await production(), previous.candidate.sourceSha, `${label}: the production branch keeps the previous release`);
    assert.deepEqual(await selected(), { candidate: previous.candidate.id, ...(await read(previous.candidate.id)).promotion }, `${label}: the plane's selected release is still the previous candidate`);
    assert.deepEqual(await expectedProduction(), { id: 'production', releaseId: previous.record.id, sourceSha: previous.candidate.members[0].mergeSha }, `${label}: the delivery view still expects the previous release`);
  };
  const attempt = async (label: string) => {
    const loop = await promoteRecord(failing.record);
    assert.equal(loop.promoted, false, label);
    assert.match((loop as { refusals: string[] }).refusals.join(' '), /failed UAT/, label);
    const direct = await promote(failing.candidate.id, await ask(failing.record), `direct-${label}`);
    assert.equal(direct.status, 409, label); assert.match(direct.body.error, /failed its combined required cases: .*fixture-static-home/, label);
    assert.match(direct.body.error, /required case fixture-static-home \(fail\) did not pass/, label);
    const contradicting = await call('POST', `candidates/${failing.candidate.id}/validation`, 'coordinator', { ...verdict, result: 'pass', failed: [] }, `contradicting-${label}`);
    assert.equal(contradicting.status, 409, label); assert.match(contradicting.body.error, /a validation is recorded once/);
    assert.equal((await call('POST', `candidates/${failing.candidate.id}/validation`, 'coordinator', verdict, `replay-${label}`)).status, 200, `${label}: the same verdict replays`);
  };
  await retained('after the verdict');
  await attempt('first retry'); await attempt('second retry');
  await retained('after the retries');

  // Through a restart the failed record and the previous selection stand unchanged, and retries still refuse.
  await stop(); await start();
  await retained('after the restart');
  await attempt('retry after the restart');
  await retained('after the retry after the restart');
  const promotions = await store.pool.query("SELECT count(*) AS n FROM events WHERE kind='release.candidate.promotion' AND payload->>'candidate' = $1", [failing.candidate.id]);
  assert.equal(Number(promotions.rows[0].n), 0, 'no promotion was ever recorded for the failed candidate');
});

test('integration:goal-candidate-selection-retained — the delivery view keeps each environment\'s current candidate selection past the history window and over an unselected recorded state, and a scoped reader sees no production summary for a candidate outside its scope', { timeout: 120_000 }, async () => {
  const current = await selected();
  assert.ok(current, 'an earlier case selected a production candidate');
  const productionGeneration = async () => (await call('GET', 'delivery', 'reader')).body.environments.find((entry: { id: string }) => entry.id === 'production').generation as number;
  const generation = await productionGeneration();
  // More promotions to other environments than the history window holds, interleaved: production's selection and generation stand.
  for (let index = 0; index < historyLimit + 20; index++) {
    const environment = index % 2 ? 'canary' : 'staging';
    await store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', ['graphyard', candidatePromotionKind,
      JSON.stringify({ candidate: current!.candidate, sequence: 1, promotion: { environment, releaseId: `rc-${environment}-${index}`, sourceSha: current!.sourceSha, artifact: `tree:${index}`, at: new Date(clock += 1000).toISOString(), by: 'graphyard' } })]);
  }
  const view = (await call('GET', 'delivery', 'reader')).body;
  assert.deepEqual(view.environments.map((entry: { id: string }) => entry.id), ['canary', 'production', 'staging']);
  assert.equal((await expectedProduction())?.releaseId, current!.releaseId, 'production is still expected to run its selected candidate');
  assert.equal(await productionGeneration(), generation, 'production\'s generation counts its own selections only');
  const staging = view.environments.find((entry: { id: string }) => entry.id === 'staging');
  assert.equal(staging.generation, (historyLimit + 20) / 2, 'a generation counts every selection, not only the window');
  assert.equal(staging.history.length, (historyLimit + 20) / 2);
  assert.equal(staging.history.at(-1).generation, staging.generation);
  // A recorded state with nothing selected (a provider notification before any selection) does not hide the candidate selection.
  await store.pool.query('INSERT INTO delivery_environments(environment_id,document) VALUES($1,$2)', ['production', JSON.stringify({ environmentId: 'production', generation: 0, expected: null, history: [], coverage: {}, incidents: [], cursor: 0,
    verification: { generation: 0, status: 'unobserved', reasons: [], interval: null, evaluatedAt: null, verifiedAt: null } })]);
  assert.equal((await expectedProduction())?.releaseId, current!.releaseId, 'an unselected recorded state yields to the candidate selection');
  // An operator agent scoped away from the promoted candidate's members gets no production summary naming it.
  const created = await call('POST', 'operator-agents', 'operator', { id: 'scoped-agent', displayName: 'scoped-agent', capabilities: ['intent:create'], scope: { repositories: ['owner/fixture'], workItems: ['GY-99999'] }, token: tokens.scoped, reason: 'A scoped agent' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const scoped = await call('GET', 'candidates', 'scoped');
  assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
  assert.equal(scoped.body.production, null, 'the summary is withheld from a reader that may not read the candidate');
  assert.equal((await call('GET', `candidates/${current!.candidate}`, 'scoped')).status, 403);
  assert.deepEqual(await selected(), current, 'an unscoped reader still sees it');
});
