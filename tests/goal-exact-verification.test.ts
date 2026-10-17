import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { createServer as netServer, type AddressInfo } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import { Store, save } from '../src/store.js';
import { lockedWork } from '../src/store/locked-read.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal } from '../src/model.js';
import type { ExactCandidate } from '../src/model/release.js';
import { cutAsync, readLedgerAsync, promoteAsync, type AsyncGit, type ReleaseCandidate } from '../src/release-candidate.js';
import { validateProjectCandidate } from '../src/release-project.js';
import { candidateArtifact, exactCandidatePorts, exactPromotionGate, exactValidation } from '../src/daemon/release-ports.js';
// A namespace import, so a checkout without the identity reader still loads this file and fails in its cases.
import * as delivery from '../src/delivery.js';
import type { EnvironmentDelivery } from '../src/delivery.js';
import type { E2eLauncher } from '../src/e2e/runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1906 (GOAL-1, production-verified-exact): a promoted exact candidate is verified only against
// what production is independently observed running — its release record, source commit and
// artifact, read by the plane from production's own identity endpoint on every sweep or reported by
// an observe-sha producer. An exact match verifies; any difference is mismatched with a reason per
// difference while the delivery view keeps expecting the promoted candidate.

const operator: Principal = { id: 'operator', role: 'admin' }, coordinator: Principal = { id: 'graphyard', role: 'coordinator' };
const reader: Principal = { id: 'reader-1', role: 'reader' }, observer: Principal = { id: 'production-observer', role: 'producer' };
const tokens = { operator: `operator-${'o'.repeat(40)}`, coordinator: `coordinator-${'c'.repeat(40)}`, reader: `reader-${'r'.repeat(40)}`, observer: `observer-${'b'.repeat(40)}` };
const credentials = [{ ...operator, token: tokens.operator }, { ...coordinator, token: tokens.coordinator }, { ...reader, token: tokens.reader }, { ...observer, token: tokens.observer }];

let database: EmbeddedPostgres, store: Store, http: ReturnType<typeof server>, url: string, checkout: string, root: string, production: Server, identityUrl: string;
/** What the production stand-in answers on its identity endpoint: a status, or the identity it runs. */
let serving: { status: number; body?: unknown } = { status: 503 };
const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const asyncGit: AsyncGit = async args => git(...args);
const freePort = async () => { const probe = netServer(); await new Promise<void>(done => probe.listen(0, '127.0.0.1', done)); const { port } = probe.address() as AddressInfo; await new Promise<void>(done => probe.close(() => done())); return port; };

let keys = 0;
const call = async (method: string, path: string, as: keyof typeof tokens, body?: unknown, key: string | null = `key-${++keys}`) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${tokens[as]}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const ports = exactCandidatePorts(async (path, data, requestId) => {
  const answer = await call('POST', path, 'coordinator', data, requestId ?? `port-${++keys}`);
  if (answer.status >= 300) throw Object.assign(new Error(JSON.stringify(answer.body)), { status: answer.status });
  return answer.body;
}, async path => (await call('GET', path, 'reader')).body);
/** A browser double that drives the loopback UAT over HTTP. */
const httpBrowser: E2eLauncher = { launch: async () => ({ close: async () => {}, newPage: async () => {
  let body = '';
  const locator = (text: string): any => ({ first: () => locator(text), click: async () => {}, fill: async () => {}, waitFor: async () => { if (!body.includes(text)) throw new Error(`"${text}" is not on the page`); } });
  return { on: () => {}, close: async () => {}, getByText: (text: string) => locator(text), getByRole: (_role: string, options: { name: string }) => locator(options.name), getByLabel: () => locator(''),
    goto: async (target: string) => { const response = await fetch(target); if (!response.ok) throw new Error(`${target} answered ${response.status}`); body = await response.text(); } };
} }) } as unknown as E2eLauncher;
const write = async (path: string, content: unknown) => { await mkdir(join(checkout, path, '..'), { recursive: true }); await writeFile(join(checkout, path), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`); };
const openCase = (id: string, path: string, text: string) => ({ id, title: `${id} shows its page`, tags: ['fixture'], target: 'uat', required: true,
  steps: [{ kind: 'browser', action: 'open', path }, { kind: 'browser', action: 'expectText', text }] });

before(async () => {
  const port = await freePort();
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('goal-exact-verification-pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('exact_verification');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/exact_verification`); await store.init();
  http = server(new Engine(store, [15368], 120, 'owner/fixture'), credentials);
  await new Promise<void>(done => http.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  production = createServer((request, response) => {
    response.writeHead(serving.status, { 'content-type': 'application/json' }); response.end(JSON.stringify(serving.body ?? { error: 'unavailable' }));
  });
  await new Promise<void>(done => production.listen(0, '127.0.0.1', done));
  identityUrl = `http://127.0.0.1:${(production.address() as AddressInfo).port}/identity`;
  // The plane reads production's identity endpoint as GRAPHYARD_PRODUCTION_IDENTITY_URL configures it.
  (http.services.delivery as { live: unknown }).live = (delivery as { liveIdentityReader?: (env: Record<string, string>) => unknown }).liveIdentityReader?.({ GRAPHYARD_PRODUCTION_IDENTITY_URL: identityUrl });
  await http.services.validation.define(operator, { kind: 'environment', id: 'production', expectedRevision: 0, repository: 'owner/fixture', url: 'https://production.example.test', instance: 'instance-production', immutable: true, services: ['web'], resources: ['account-production'] }, 'define-production');
  root = await temporaryDirectory('goal-exact-verification-git');
  const origin = join(root, 'origin.git'); checkout = join(root, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  for (const [key, value] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) git('config', key, value);
  await write('site/index.html', '<h1>Fixture static site</h1>\n');
  await write('e2e/cases/fixture-static-home.json', openCase('fixture-static-home', '/', 'Fixture static site'));
  git('add', '-A'); git('commit', '-q', '-m', 'fixture project'); git('push', '-q', 'origin', 'main'); git('fetch', '-q', 'origin');
});
after(async () => {
  if (production) await new Promise<void>(done => production.close(() => done()));
  if (http) await new Promise<void>(done => http.close(() => done()));
  if (store) await store.close().catch(() => {});
  if (database) await database.stop();
});

let merges = 0, clock = Date.now();
/** A change delivered to main: created through the API, merged with --no-ff and recorded done with its merge commit, as the merge writer reconciles it. */
async function delivered(title: string, line: string) {
  const answer = await call('POST', 'work', 'operator', { title, description: 'A change delivered to main.', type: 'feature', priority: 3, policy: { checks: ['test'], review: true }, criteria: [{ id: 'AC-1', text: 'The change is delivered', proofs: ['unit:delivered'] }] });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const branch = `graphyard/exact-${++merges}`;
  git('checkout', '-q', '-b', branch, 'refs/remotes/origin/main');
  await write('site/index.html', `<h1>Fixture static site</h1>\n<p>${line}</p>\n`); git('add', '-A'); git('commit', '-q', '-m', title);
  git('checkout', '-q', '--detach', 'refs/remotes/origin/main');
  git('merge', '-q', '--no-ff', branch, '-m', `Merge pull request #${merges} from owner/${branch}`);
  git('push', '-q', 'origin', 'HEAD:main'); git('fetch', '-q', 'origin');
  const mergeSha = git('rev-parse', 'HEAD');
  await store.transaction(async (db, now) => {
    const work = structuredClone((await lockedWork(db, [answer.body.id])).find(entry => entry.id === answer.body.id)!);
    work.stage = 'done'; work.delivery = { mergedAt: new Date(now.getTime() - 60_000).toISOString(), mergeSha, authorizationRevision: work.revision };
    await save(db, work, 'graphyard', 'merge-writer.reconciled', now, { mergeSha });
  });
  return mergeSha;
}
/** The loop's path for one change: the plane cuts it, `rc/ID` is tagged, the combined required cases pass on its source, and the promoter's gate selects it for production. */
async function promoted(title: string, line: string, beforePromotion?: (exact: { record: ReleaseCandidate; artifact: string }) => Promise<void>): Promise<{ candidate: ExactCandidate; record: ReleaseCandidate; artifact: string }> {
  await delivered(title, line);
  const answer = await call('POST', 'candidates', 'coordinator', { trigger: 'manual' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const candidate = answer.body as ExactCandidate;
  const cut = await cutAsync(asyncGit, { base: 'main', trigger: 'manual', now: new Date(clock += 60_000), push: true,
    exact: { id: candidate.id, identity: candidate.identity, sourceSha: candidate.sourceSha, members: candidate.members.map(member => ({ key: member.key, mergeSha: member.mergeSha, pr: member.pr })) } });
  assert.equal(cut.cut, true, JSON.stringify(cut));
  const record = (await readLedgerAsync(asyncGit)).candidates.find(entry => entry.exact?.id === candidate.id)!;
  const tree = join(root, `candidate-${record.id.replace(/[^A-Za-z0-9-]/g, '-')}`);
  git('worktree', 'add', '-q', '--detach', tree, record.sha);
  const run = await validateProjectCandidate(asyncGit, record.id, { checkout: tree, uat: { static: { directory: 'site' } }, token: '', base: 'main', push: true, timeoutMs: 30_000, launcher: httpBrowser, stepTimeoutMs: 5_000, file: async () => 'GY-900' });
  assert.equal(run.record.result, 'passed', JSON.stringify(run.record.suites));
  const artifact = await candidateArtifact(asyncGit, record);
  await ports.validated(candidate.id, exactValidation({ ...record, exact: record.exact! }, run.record, artifact));
  await beforePromotion?.({ record, artifact });
  const moved = await promoteAsync(asyncGit, record.id, { base: 'main', push: true, now: new Date(clock += 60_000), gate: entry => exactPromotionGate(ports, asyncGit, entry) });
  assert.equal(moved.promoted, true, JSON.stringify(moved));
  return { candidate, record, artifact };
}
/** The production environment as the delivery view reads it. */
const view = async (): Promise<EnvironmentDelivery> => {
  const answer = await call('GET', 'delivery', 'reader');
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body.environments.find((entry: EnvironmentDelivery) => entry.environmentId === 'production');
};
const sweep = async () => { const answer = await call('POST', 'delivery/sweep', 'operator', {}); assert.equal(answer.status, 200, JSON.stringify(answer.body)); return answer.body; };
const observeSha = (sha: string, extra: Record<string, unknown>) => call('POST', 'delivery/observe-sha', 'observer', { environment: { id: 'production', revision: 1 }, sha, services: ['web'], observedAt: new Date().toISOString(), ...extra });

test('integration:goal-exact-live-verification — production observed through the delivery observers is verified only on the promoted candidate\'s exact release, source and artifact; drift is mismatched, keeping the expected candidate and naming each difference', { timeout: 120_000 }, async () => {
  const before = git('rev-parse', 'refs/remotes/origin/main');
  const first = await promoted('Home line A', 'change A');
  const expect = (environment: EnvironmentDelivery, label: string) => {
    assert.equal(environment.source, 'candidate', label);
    assert.deepEqual({ candidate: environment.expected!.candidate, releaseId: environment.expected!.releaseId, sourceSha: environment.expected!.sourceSha, artifact: environment.expected!.artifact },
      { candidate: first.candidate.id, releaseId: first.record.id, sourceSha: first.record.sha, artifact: first.artifact }, `${label}: the promoted candidate stays expected`);
  };

  // Promoted but never observed since: not verified, whatever the promotion says.
  let production = await view();
  expect(production, 'unobserved');
  assert.equal(production.verification.status, 'unobserved');
  assert.match(production.verification.reasons.join(' '), new RegExp(`has not been observed since candidate ${first.candidate.id}'s release ${first.record.id}`));

  // The deploy has not landed: production still runs the previous source. The sweep reads it and names each difference.
  serving = { status: 200, body: { release: 'rc-previous', sourceSha: before, artifact: `tree:${git('rev-parse', `${before}^{tree}`)}` } };
  const stale = await sweep();
  assert.equal(stale.live.recorded, true); assert.equal(stale.live.error, null);
  production = await view();
  expect(production, 'stale deploy');
  assert.equal(production.verification.status, 'mismatched');
  assert.deepEqual({ releaseId: production.observed!.releaseId, sourceSha: production.observed!.sourceSha, source: production.observed!.source }, { releaseId: 'rc-previous', sourceSha: before, source: 'endpoint' });
  const staleReasons = production.verification.reasons.join(' | ');
  assert.match(staleReasons, new RegExp(`Production serves source ${before}, not ${first.record.sha}`));
  assert.match(staleReasons, new RegExp(`Production runs release rc-previous, not ${first.record.id}`));
  assert.match(staleReasons, /Production runs artifact tree:[0-9a-f]{40}, not tree:/);
  assert.match(staleReasons, /The expected release is still candidate .*: redeploy it, or promote a newer candidate/);

  // Production runs exactly the candidate: verified, with the observation it stands on.
  serving = { status: 200, body: { release: first.record.id, sourceSha: first.record.sha, artifact: first.artifact } };
  await sweep();
  production = await view();
  expect(production, 'exact');
  assert.equal(production.verification.status, 'verified', production.verification.reasons.join('; '));
  assert.deepEqual({ releaseId: production.observed!.releaseId, sourceSha: production.observed!.sourceSha, artifact: production.observed!.artifact, observer: production.observed!.observer },
    { releaseId: first.record.id, sourceSha: first.record.sha, artifact: first.artifact, observer: 'graphyard' });
  assert.equal(production.verification.verifiedAt, production.observed!.observedAt);
  assert.equal(production.history.at(-1)!.outcome, 'verified');
  // An unchanged reading appends nothing: the identity history holds changes only.
  assert.equal((await sweep()).live.recorded, false);

  // The same release and source redeployed with a different build: drift on the artifact alone is mismatched.
  serving = { status: 200, body: { release: first.record.id, sourceSha: first.record.sha, artifact: `sha256:${'d'.repeat(64)}` } };
  await sweep();
  production = await view();
  expect(production, 'artifact drift');
  assert.equal(production.verification.status, 'mismatched');
  assert.match(production.verification.reasons[0], new RegExp(`^Production runs artifact sha256:d{64}, not ${first.artifact} \\(observed by graphyard from the production identity endpoint at `));
  assert.equal(production.verification.verifiedAt, null);

  // A source that matches proves nothing alone: a reading without the release or artifact is unknown, never verified.
  serving = { status: 200, body: { sourceSha: first.record.sha } };
  await sweep();
  production = await view();
  assert.equal(production.verification.status, 'unknown');
  assert.match(production.verification.reasons.join(' '), /release and artifact went unreported/);
  // An endpoint that cannot answer records nothing and says why; the last observation stands.
  serving = { status: 500 };
  const failed = await sweep();
  assert.match(failed.live.error, /answered 500/);
  assert.equal((await view()).verification.status, 'unknown');

  // The existing observe-sha observer reports the identity too: an exact report verifies, another commit is mismatched,
  // and the exact commit read again after that drift verifies again, though its sha observation was recorded once.
  assert.equal((await observeSha(first.record.sha, { release: first.record.id, artifact: first.artifact })).status, 200);
  production = await view();
  assert.equal(production.verification.status, 'verified');
  assert.deepEqual({ observer: production.observed!.observer, source: production.observed!.source }, { observer: observer.id, source: 'producer' });
  assert.equal((await observeSha(before, { release: 'rc-previous' })).status, 200);
  assert.equal((await view()).verification.status, 'mismatched');
  const again = await observeSha(first.record.sha, { release: first.record.id, artifact: first.artifact });
  assert.equal(again.status, 200); assert.equal(again.body.duplicate, true, 'the sha observation itself is recorded once');
  assert.equal((await view()).verification.status, 'verified');
  // A delayed exact reading older than newer drift never erases it: the view reads the latest observed, not the latest written.
  const tick = () => new Promise(resolve => setTimeout(resolve, 5));
  await tick(); const delayedAt = new Date(); await tick(); const driftAt = new Date(); await tick();
  assert.equal((await observeSha(before, { release: 'rc-previous', observedAt: driftAt.toISOString() })).status, 200);
  assert.equal((await observeSha(first.record.sha, { release: first.record.id, artifact: first.artifact, observedAt: delayedAt.toISOString() })).status, 200);
  production = await view();
  assert.equal(production.verification.status, 'mismatched', 'the older exact match does not displace the newer drift');
  assert.equal(production.observed!.observedAt, driftAt.toISOString());
  assert.match(production.verification.reasons.join(' '), new RegExp(`Production serves source ${before}, not ${first.record.sha}.*The expected release is still candidate`));
  assert.equal((await observeSha(first.record.sha, { release: first.record.id, artifact: first.artifact })).status, 200);
  assert.equal((await view()).verification.status, 'verified');
  const malformed = await observeSha(first.record.sha, { artifact: 'built-somehow' });
  assert.equal(malformed.status, 400, 'an artifact that names no digest or tree is refused');

  // A newer promotion is not verified by what production ran before it: the reading must follow the selection.
  // That holds against a producer clock running ahead too: the candidate's exact identity reported before its
  // promotion, dated 50 s on (within the accepted skew), counts from when the plane received it, so it neither
  // verifies the selection nor outranks the honest reading that follows it.
  serving = { status: 200, body: { release: first.record.id, sourceSha: first.record.sha, artifact: first.artifact } };
  const second = await promoted('Home line B', 'change B', async exact => {
    const early = await observeSha(exact.record.sha, { release: exact.record.id, artifact: exact.artifact, observedAt: new Date(Date.now() + 50_000).toISOString() });
    assert.equal(early.status, 200, JSON.stringify(early.body));
  });
  production = await view();
  assert.equal(production.expected!.candidate, second.candidate.id);
  assert.equal(production.observed!.sourceSha, second.record.sha, 'the early reading is the newest observed');
  assert.equal(production.verification.status, 'unobserved', 'a reading received before the selection never verifies it, whatever its producer dated it');
  await sweep();
  production = await view();
  assert.equal(production.verification.status, 'mismatched', 'production still runs the first candidate after the second was selected');
  assert.match(production.verification.reasons.join(' '), new RegExp(`Production serves source ${first.record.sha}, not ${second.record.sha}`));
  serving = { status: 200, body: { release: second.record.id, sourceSha: second.record.sha, artifact: second.artifact } };
  await sweep();
  production = await view();
  assert.equal(production.verification.status, 'verified');
  assert.deepEqual(production.history.map(entry => [entry.releaseId, entry.outcome]), [[first.record.id, 'skipped'], [second.record.id, 'verified']]);
});

// GY-1906 AC-4: the loop's reader of manual:post-deploy/onboarding-default-target (GY-1910 AC-2, owed by
// GY-1911) over the release ledger the release jobs write: the onboarding-default-path hold's clear record,
// its passing UAT execution bound to the clearing candidate's exact SHA, and the serving release's own pass.
const onboardingCriterion = { id: 'AC-2', text: 'On the serving release, onboarding-delivery-defaults passes through the repaired normal-onboarding fixture path on a newer UAT candidate served at its exact SHA and the onboarding-default-path release hold GY-1909 clears under its original rule.', proofs: ['manual:post-deploy/onboarding-default-target'] };

test('integration:goal-loop-verifies-onboarding-hold-clearance — the loop reads onboarding-default-target from independently recorded UAT executions, the hold-clear record and the exact serving release: it passes only on the clearing candidate or a verified descendant with its own pass, and stays unproven on anything missing, misattributed or not contained', { timeout: 120_000 }, async () => {
  const { loadContract } = await import('../src/e2e/case.js');
  const { releaseHolds } = await import('../src/release-holds.js');
  const { writeRecord, gitIn } = await import('../src/release-candidate.js');
  const { onboardingTargetReading, ledgerPorts, onboardingTargetProof } = await import('../src/cli/master-deployment.js');
  const { readingEffects } = await import('../src/daemon/reading-effect.js');
  const { defaultChildRun } = await import('../src/child-runner.js');
  const ledger = await temporaryDirectory('goal-onboarding-ledger');
  const sync = gitIn(ledger), run = (...args: string[]) => sync(args).trim();
  run('init', '-q', '-b', 'main');
  for (const [key, value] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) run('config', key, value);
  const commit = async (file: string) => { await writeFile(join(ledger, file), `${file}\n`); run('add', '-A'); run('commit', '-q', '-m', file); return run('rev-parse', 'HEAD'); };
  const contract = await loadContract(join(import.meta.dirname, '..'));
  // The release jobs' own writers: release validate's UAT record and its holds step, against the repository's contract.
  const validated = async (id: string, sha: string, verdict: 'passed' | 'failed', options: { deployedSha?: string; runId?: string } = {}) => {
    const runId = options.runId ?? `rc-${id}`;
    // The run's instants are the candidate id's own: the reader binds SHAs and candidates, never times.
    const at = `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(9, 11)}:${id.slice(11, 13)}:00.000Z`;
    const report = { runId, url: 'https://uat.example.test', environment: 'uat', sha, startedAt: at, finishedAt: at, passed: verdict === 'passed' ? 1 : 0, failed: verdict === 'failed' ? 1 : 0,
      cases: [{ id: 'onboarding-delivery-defaults', title: 'onboarding', file: 'e2e/cases/onboarding-delivery-defaults.json', outcome: verdict === 'passed' ? 'pass' as const : 'fail' as const, verdict, required: true, durationMs: 1, attempts: verdict === 'passed' ? 1 : 2,
        attemptResults: [], executed: 3, failingStep: verdict === 'passed' ? null : { index: 1, name: 'read the merger mode', reason: 'mode is "github", expected "control-plane"' } }] };
    const candidate = { id, sha, cutAt: at, trigger: 'manual' as const, since: null, items: [] };
    const record = { id, sha, result: verdict, deployedSha: options.deployedSha ?? sha, at, suites: [], followUp: null };
    const holds = await releaseHolds(sync, { contract, report: async () => report, push: false, now: () => new Date(record.at), file: async (_item, requestId) => requestId === 'release-hold:onboarding-default-path:20261017T132854Z' ? 'GY-1909' : 'GY-1950' })(candidate as never, record as never);
    writeRecord(sync, `rc-uat/${id}`, sha, { ...record, e2e: holds.e2e, holds: holds.holds }, false);
    holds.write();
    return holds.holds;
  };
  const ports = ledgerPorts(async args => sync(args));
  const parent = { key: 'GY-1910', delivery: { mergeSha: '' } } as never as import('../src/model.js').Work;
  const read = (release: string, using = ports) => onboardingTargetReading({ proof: onboardingTargetProof, parent, item: { key: 'GY-1911' } as never, criterion: onboardingCriterion, release, now: new Date() }, using);
  const unavailable = async (release: string, pattern: RegExp, using = ports) => { const reading = await read(release, using); assert.ok(reading && 'unavailable' in reading, JSON.stringify(reading)); assert.match(reading.unavailable, pattern); };

  const failedSha = await commit('before-repair');
  // Any other proof is not this reader's.
  assert.equal(await onboardingTargetReading({ proof: 'manual:post-deploy/other', parent, item: {} as never, criterion: null, release: failedSha, now: new Date() }, ports), null);
  Object.assign(parent, { delivery: { mergeSha: failedSha } });
  await unavailable(failedSha, /holds no onboarding-default-path release hold/);
  // The shared-install target failed onboarding-delivery-defaults: the outcome's hold opens (GY-1909).
  assert.deepEqual(await validated('20261017T132854Z', failedSha, 'failed'), [{ kind: 'open', outcome: 'onboarding-default-path', hold: 'onboarding-default-path', item: 'GY-1909' }]);
  const repair = await commit('repair');
  Object.assign(parent, { delivery: { mergeSha: repair } });
  await unavailable(repair, /hold GY-1909 has no clear record \(it is open\)/);

  // A newer candidate at the repair passes at its exact SHA: the hold clears under its rule.
  assert.deepEqual(await validated('20261017T153000Z', repair, 'passed'), [{ kind: 'clear', outcome: 'onboarding-default-path', hold: 'onboarding-default-path', item: 'GY-1909' }]);
  const cleared = await read(repair);
  assert.equal((cleared as { result?: string } | null)?.result, 'pass', JSON.stringify(cleared));
  assert.match((cleared as { detail: string }).detail, new RegExp(`onboarding-delivery-defaults passed in the clearing candidate's own execution rc-20261017T153000Z deployed at the release's exact SHA ${repair.slice(0, 12)}; the onboarding-default-path hold GY-1909 cleared on candidate 20261017T153000Z`));

  // A descendant release needs its own pass at its exact SHA: none recorded is unproven; a failed one is a failed reading; its own pass verifies it.
  const descendant = await commit('later-change');
  await unavailable(descendant, /no UAT execution is recorded deployed and run at the release's exact SHA/);
  // Its failure opens a new hold, filed as its own item; the repaired hold GY-1909 stays cleared.
  assert.deepEqual(await validated('20261017T170000Z', descendant, 'failed'), [{ kind: 'open', outcome: 'onboarding-default-path', hold: 'onboarding-default-path', item: 'GY-1950' }]);
  const failing = await read(descendant);
  assert.equal((failing as { result?: string } | null)?.result, 'fail', JSON.stringify(failing));
  assert.match((failing as { detail: string }).detail, /onboarding-delivery-defaults failed in descendant candidate 20261017T170000Z's own execution rc-20261017T170000Z/);
  const next = await commit('next-change');
  // A UAT that served another SHA is never this release's execution.
  await validated('20261017T180000Z', next, 'passed', { deployedSha: descendant });
  await unavailable(next, /no UAT execution is recorded deployed and run at the release's exact SHA/);
  await validated('20261017T190000Z', next, 'passed');
  assert.equal(((await read(next)) as { result?: string } | null)?.result, 'pass');

  // A release that does not carry the repair and the clearing candidate is unproven, as is one this checkout cannot place.
  run('checkout', '-q', '-b', 'elsewhere', failedSha);
  const sibling = await commit('sibling');
  await validated('20261017T200000Z', sibling, 'passed');
  await unavailable(sibling, new RegExp(`not a descendant of GY-1910's repair merge ${repair.slice(0, 12)}`));
  await unavailable('f'.repeat(40), /not verifiably a descendant of GY-1910's repair merge/);

  // The clear record's own execution must bind the clearing candidate's exact SHA: with it missing or attributed elsewhere, nothing is proven.
  const records = await ports.uatRecords();
  const without = { ...ports, uatRecords: async () => records.filter(record => record.id !== '20261017T153000Z') };
  await unavailable(repair, /no UAT execution of the clearing candidate 20261017T153000Z is recorded deployed and run at its exact SHA/, without);
  const misattributed = { ...ports, uatRecords: async () => records.map(record => record.id === '20261017T153000Z' ? { ...record, e2e: { ...record.e2e!, sha: failedSha } } : record) };
  await unavailable(repair, /no UAT execution of the clearing candidate/, misattributed);
  const unclear = { ...ports, holdRecords: async () => (await ports.holdRecords()).filter(record => record.kind !== 'clear') };
  await unavailable(repair, /has no clear record \(it is open\)/, unclear);
  // The criterion names GY-1909: with its hold absent, a later cleared hold (GY-1950, cleared at next with exact executions and ancestry) never stands in for it.
  const substitute = { ...ports, holdRecords: async () => (await ports.holdRecords()).filter(record => !['20261017T132854Z', '20261017T153000Z'].includes(record.candidate ?? '')) };
  const unnamed = await onboardingTargetReading({ proof: onboardingTargetProof, parent, item: { key: 'GY-1911' } as never, criterion: { ...onboardingCriterion, text: 'onboarding-delivery-defaults passes on the serving release.' }, release: next, now: new Date() }, substitute);
  assert.equal((unnamed as { result?: string } | null)?.result, 'pass', JSON.stringify(unnamed));
  await unavailable(next, /holds no onboarding-default-path release hold of GY-1909, the hold the criterion names, so no clear record of it exists/, substitute);

  // Registered on the loop: the production reading effects read this checkout's ledger, so the loop's reading of GY-1911 passes on the exact release.
  const effects = readingEffects(() => ({ cliPath: 'graphyard' }) as never, async () => ({}), async () => ({}), { root: ledger, run: defaultChildRun });
  const loopReading = await effects.readPostDeploy({ proof: onboardingTargetProof, parent, item: { key: 'GY-1911' } as never, criterion: onboardingCriterion, release: repair, now: new Date() });
  assert.equal((loopReading as { result?: string }).result, 'pass', JSON.stringify(loopReading));
  const other = await effects.readPostDeploy({ proof: 'manual:post-deploy/other', parent, item: { key: 'GY-1911' } as never, criterion: onboardingCriterion, release: repair, now: new Date() });
  assert.match((other as { unavailable: string }).unavailable, /no reader of manual:post-deploy\/other runs on this host/);
});
