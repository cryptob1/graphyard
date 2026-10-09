import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal } from '../src/model.js';
import { Store } from '../src/store.js';
import { cut, followUpFilingRefusal, followUpItem, followUpRequestId, gitIn, readLedger, releaseFilingIdentity, validateAndRecord, type Suite } from '../src/release-candidate.js';
import { releaseFilingCheck, setupFromZeroChecks, setupLine } from '../src/setup-from-zero.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1614: the uat job's validateAndRecord files a failed candidate's follow-up with the uat
// environment's GRAPHYARD_TOKEN. Before, that token named a principal the create path refused
// ("Operator permission required"), so no follow-up was filed. The identity it is provisioned with
// is an operator agent holding only intent:create, which files exactly once and can do nothing else.
const repository = 'owner/uat-filing';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator = { id: 'graphyard-coordinator', role: 'coordinator' as const, token: `uat-filing-coordinator-${'c'.repeat(32)}` };
const credentials = [{ ...operator, token: `uat-filing-operator-${'x'.repeat(32)}` }, coordinator];
const release = { id: releaseFilingIdentity.id, token: `release-follow-up-${'r'.repeat(32)}`, capabilities: [...releaseFilingIdentity.capabilities] };
const master = { id: 'master-operator', token: `master-operator-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready'] };
let database: EmbeddedPostgres, store: Store, http: ReturnType<typeof server>, url: string;

const call = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown, key: string = randomUUID()) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1614;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('uat-follow-up-filing'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('uat_filing_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/uat_filing_test`); await store.init();
  const engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  // The provisioning docs/delivery.md#release-filing-credential names: an admin issues each identity with operator-agent setup.
  for (const agent of [release, master]) {
    const provisioned = await call(credentials[0].token, 'POST', 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Provision the release filing identity' });
    assert.equal(provisioned.status, 200, JSON.stringify(provisioned.body));
  }
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** A bare origin and a clone whose main carries one merged item, cut as a candidate. */
async function candidateRepository() {
  const root = await temporaryDirectory('uat-filing-repo');
  const origin = join(root, 'origin.git'), work = join(root, 'work');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, work);
  for (const [key, value] of [['user.name', 'test'], ['user.email', 'test@example.test'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) git(work, 'config', key, value);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'initial');
  git(work, 'push', '-q', 'origin', 'HEAD:main');
  git(work, 'checkout', '-q', '-b', 'graphyard/gy-1-1');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'GY-1 change');
  git(work, 'checkout', '-q', '--detach', 'origin/main');
  git(work, 'merge', '-q', '--no-ff', 'graphyard/gy-1-1', '-m', 'Merge pull request #1 from owner/graphyard/gy-1-1', '-m', 'GY-1: the change');
  git(work, 'push', '-q', 'origin', 'HEAD:main');
  const repo = gitIn(work);
  const { candidate } = cut(repo, { base: 'main', trigger: 'manual', now: new Date('2026-10-09T12:00:00Z'), push: true }) as any;
  return { git: repo, candidate };
}

/** The CLI's filing (src/cli/release.ts `release validate`): POST /api/work as GRAPHYARD_TOKEN, keyed by the request id. */
const fileAs = (token: string) => async (item: object, requestId: string) => {
  const created = await call(token, 'POST', 'work', item, requestId);
  if (created.status !== 200) throw new Error(created.body.error);
  return String(created.body.key);
};
/** A UAT deployment serving the candidate's exact SHA at /healthz, as the server reports it. */
const serving = (sha: string) => (async () => new Response(JSON.stringify({ ok: true, commit: sha }))) as unknown as typeof fetch;
const failingChart: Suite = { name: 'chart', run: async () => ({ name: 'chart', passed: false, detail: 'helm lint failed' }) };
const listed = async () => (await call(credentials[0].token, 'GET', 'work')).body as any[];

test('integration:uat-follow-up-filing — a failed candidate files its follow-up once as the uat filing identity, a retry with the same request id files nothing, and that identity cannot claim, complete, record evidence or approve', async () => {
  // A principal the create path does not admit, as the uat token was: refused, and the verdict is still recorded.
  const refusedRepo = await candidateRepository();
  const refused = await validateAndRecord(refusedRepo.git, refusedRepo.candidate.id, 'https://uat.example.test', [failingChart], { base: 'main', push: true, timeoutMs: 0, fetcher: serving(refusedRepo.candidate.sha), file: fileAs(coordinator.token) });
  assert.equal(refused.record.result, 'failed');
  assert.equal(refused.followUp, null);
  assert.match(refused.filingError ?? '', /Operator permission required/);

  // AC-1: the provisioned identity is admitted, and the item is created once.
  const repo = await candidateRepository();
  const before = (await listed()).length;
  const result = await validateAndRecord(repo.git, repo.candidate.id, 'https://uat.example.test', [failingChart], { base: 'main', push: true, timeoutMs: 0, fetcher: serving(repo.candidate.sha), file: fileAs(release.token) });
  assert.equal(result.filingError, null, `the filing is accepted: ${result.filingError}`);
  assert.ok(result.followUp, 'the follow-up key is recorded on the candidate');
  assert.equal(readLedger(repo.git).uat.find(record => record.id === repo.candidate.id)?.followUp, result.followUp);
  let items = await listed();
  assert.equal(items.length, before + 1);
  const filed = items.find(item => item.key === result.followUp)!;
  assert.match(filed.title, new RegExp(`Release candidate ${repo.candidate.id} failed UAT suite chart`));
  assert.equal(filed.policy.review, true, 'the follow-up requires independent review');
  // A retry (release follow-up, or a rerun job) with the same request id replays the same item and creates nothing.
  const record = readLedger(repo.git).uat.find(entry => entry.id === repo.candidate.id)!;
  const again = await fileAs(release.token)(followUpItem(repo.candidate, record), followUpRequestId(repo.candidate.id));
  assert.equal(again, result.followUp);
  items = await listed();
  assert.equal(items.length, before + 1, 'a retry with the same request id files nothing');

  // AC-2: the filing identity cannot do work. Each mutation is refused with 403.
  const id = filed.key;
  const claim = await call(release.token, 'POST', `work/${id}/claim`, {});
  // `graphyard complete` posts the engine's submit command.
  const complete = await call(release.token, 'POST', `work/${id}/submit`, { epoch: 1, pr: 1 });
  const sha = 'a'.repeat(40);
  const evidence = await call(release.token, 'POST', `work/${id}/evidence`, { proof: 'manual:release-candidate-uat-pass', sha, baseSha: sha, policyRevision: 1, result: 'pass', executed: 1, skipped: 0 });
  const ready = await call(master.token, 'POST', `work/${id}/decide`, { action: 'release', input: { expectedRevision: filed.revision }, reason: 'Next by priority' });
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  const approve = await call(release.token, 'POST', `work/${id}/approve`, { decision: ready.body.id, reason: 'Approve it' });
  for (const [name, answer] of Object.entries({ claim, complete, evidence, approve })) assert.equal(answer.status, 403, `${name} is refused: ${JSON.stringify(answer.body)}`);
  for (const answer of [claim, complete, evidence]) assert.equal(answer.body.error, 'This operation is not available to operator agents');
  assert.equal(approve.body.error, 'Capability decision:approve is required');
  const after = (await call(credentials[0].token, 'GET', `work/${id}`)).body;
  assert.equal(after.lease, null, 'nothing was claimed');
  assert.deepEqual(after.evidence, [], 'no evidence was recorded');

  // AC-3: doctor judges the configured filing credential from the principal it authenticates as.
  const status = (await call(release.token, 'GET', 'status')).body;
  assert.equal(followUpFilingRefusal(status.actor, status.repository), null);
  assert.equal(releaseFilingCheck({ status }, repository).status, 'pass');
  const masterStatus = (await call(master.token, 'GET', 'status')).body;
  const broad = releaseFilingCheck({ status: masterStatus }, repository);
  assert.equal(broad.status, 'fail', 'an operator agent holding more than intent:create is reported');
  assert.match(broad.detail, /broader than filing needs: operator agent master-operator also holds intent:ready;/);
  const admin = releaseFilingCheck({ status: (await call(credentials[0].token, 'GET', 'status')).body }, repository);
  assert.equal(admin.status, 'fail', 'an admin credential is reported');
  assert.match(admin.detail, /broader than filing needs: .* is an admin/);
  const refusedLine = releaseFilingCheck({ status: (await call(coordinator.token, 'GET', 'status')).body }, repository);
  assert.equal(refusedLine.status, 'fail');
  assert.match(refusedLine.detail, /graphyard-coordinator has role coordinator, which cannot create work/);
  assert.match(releaseFilingCheck({ status: { actor: { id: 'narrow', role: 'operator-agent', capabilities: ['intent:create'], scope: { repositories: [repository], workItems: ['GY-1'] } } } }, repository).detail, /wildcard work scope/);
  assert.match(releaseFilingCheck({ status: { actor: { id: 'other', role: 'operator-agent', capabilities: ['intent:create'], scope: { repositories: ['owner/other'], workItems: ['*'] } } } }, repository).detail, /does not include owner\/uat-filing/);
  assert.match(releaseFilingCheck({ status: { actor: { id: 'reader', role: 'operator-agent', capabilities: ['intent:ready'], scope: { repositories: [repository], workItems: ['*'] } } } }, repository).detail, /lacks intent:create/);
  const multiRepository = releaseFilingCheck({ status: { actor: { id: 'wide', role: 'operator-agent', capabilities: ['intent:create'], scope: { repositories: [repository, 'owner/other'], workItems: ['*'] } } } }, repository);
  assert.equal(multiRepository.status, 'fail');
  assert.match(multiRepository.detail, /broader than filing needs: operator agent wide can also create work in owner\/other/);
  assert.match(releaseFilingCheck({ status: null, failure: '{"error":"Unauthorized"}' }, repository).detail, /did not accept the credential/);
  // Doctor's own lines read GRAPHYARD_RELEASE_TOKEN from the environment and ask the plane it addresses.
  const doctor = async (token?: string) => (await setupFromZeroChecks({ root: await temporaryDirectory('uat-filing-doctor'), status: null, environments: await temporaryDirectory('uat-filing-environments'), sandbox: () => null,
    env: { GRAPHYARD_URL: url, ...(token ? { GRAPHYARD_RELEASE_TOKEN: token } : {}) } })).filter(check => check.id === 'release-filing').map(setupLine);
  assert.deepEqual(await doctor(), [], 'no line when this environment carries no filing credential');
  assert.deepEqual(await doctor(release.token), [`PASS release-filing: GRAPHYARD_RELEASE_TOKEN files follow-ups as ${release.id}`]);
  assert.deepEqual(await doctor(coordinator.token), ["FAIL release-filing: GRAPHYARD_RELEASE_TOKEN would be refused filing a failed candidate's follow-up: graphyard-coordinator has role coordinator, which cannot create work (Operator permission required) (fix: docs/delivery.md#release-filing-credential)"]);
});
