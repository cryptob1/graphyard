import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal } from '../src/model.js';
import { cutAsync, gitIn, releaseFilingIdentity, type ReleaseCandidate } from '../src/release-candidate.js';
import { sealRefusalAttention, sealRefusalLine, sealCheckTagPrefix } from '../src/validation-import.js';
import { releaseCommands } from '../src/cli/release.js';
import { promotionReads } from '../src/daemon/deployment.js';
import { promotionStateSchema } from '../src/daemon/state.js';
import { masterConfigSchema } from '../src/master.js';
import { defaultChildRun } from '../src/child-runner.js';
import { deliveryPolicySchema } from '../src/model/delivery-policy.js';
import { renderPromotionWorkflow } from '../src/install/release-pipeline.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { releaseLedgerGit } from './helpers/release-ledger-git.js';

// GY-1882: the uat GRAPHYARD_RELEASE_TOKEN seals a candidate's imports only after soak and UAT have
// run, so a credential without the role failed promotion twenty minutes in. The plane answers whether
// a caller may seal without sealing (GET /api/validation/import/seal-authority); `release seal-check`
// runs it first in the uat imports job, records the answer on the candidate, and master status names
// the secret and the role it needs when the newest check was refused.

const admin: Principal = { id: 'install-admin', role: 'admin' };
const releaseFiler: Principal = { id: releaseFilingIdentity.id, role: 'operator-agent', capabilities: [...releaseFilingIdentity.capabilities], scope: { repositories: ['owner/project'], workItems: [] } };
/** Valid operator-agent for another repository: auth 403s before seal-authority runs (AC-2). */
const otherRepoFiler: Principal = { id: 'other-repo-release-filer', role: 'operator-agent', capabilities: [...releaseFilingIdentity.capabilities], scope: { repositories: ['other/repo'], workItems: [] } };
const reader: Principal = { id: 'stale-release-token', role: 'reader' };
/** Importing needs external-runs:import (GY-1879); proofs keep it off the import-only lane so seal-authority still answers mayseal:false. */
const producer: Principal = { id: 'huck-producer', role: 'producer', grants: ['external-runs:import'], proofs: ['unit:*'] };
const principals = [admin, releaseFiler, otherRepoFiler, reader, producer];
const tokens = new Map(principals.map(p => [p.id, `${p.id}-${'t'.repeat(40)}`]));
const needed = ['admin', 'operator-agent'];
const outOfScopeRole = 'operator-agent (other repository)';

let database: InstanceType<typeof EmbeddedPostgres>, store: Store, http: ReturnType<typeof server>, url: string, scratch: string, work: string;
const cutCandidates: ReleaseCandidate[] = [];
const tagObject = (index: number) => String(51 + index).repeat(40);
const github = releaseLedgerGit(() => cutCandidates, tagObject);

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1882;
  scratch = await temporaryDirectory('seal-authority-check');
  database = new EmbeddedPostgres({ databaseDir: join(scratch, 'pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('seal_authority_check_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/seal_authority_check_test`); await store.init();
  const engine = new Engine(store, [15368], 120, 'owner/project'); engine.gitRunner = github.run;
  http = server(engine, principals.map(p => ({ ...p, token: tokens.get(p.id)! })), null);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;

  const origin = join(scratch, 'origin.git');
  work = join(scratch, 'work');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(scratch, 'init', '-q', '--bare', '-b', 'main', origin);
  git(scratch, 'clone', '-q', origin, work);
  for (const [key, value] of [['user.name', 'test'], ['user.email', 'test@example.test'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) git(work, 'config', key, value);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'initial');
  git(work, 'push', '-q', 'origin', 'HEAD:main');
  const asyncGit = async (args: string[]) => gitIn(work)(args);
  const result = await cutAsync(asyncGit, { base: 'main', trigger: 'manual', now: new Date(), push: true });
  assert.ok(result.cut, 'a candidate is cut');
  cutCandidates.push(result.candidate);
});

after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); if (scratch) await rm(scratch, { recursive: true, force: true }); });

async function call(path: string, actor: Principal, data?: unknown) {
  const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${tokens.get(actor.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { status: response.status, body: await response.json() as any };
}
/** The CLI's api as a credential holds it: a refusal throws with its status. */
const apiAs = (actor: Principal) => async (path: string, data?: unknown) => {
  const { status, body } = await call(path, actor, data);
  if (status >= 400) throw Object.assign(new Error(JSON.stringify(body)), { status });
  return body;
};
const events = async () => Number((await store.pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n);
async function sealCheck(api: (path: string, data?: unknown) => Promise<any>, args: string[]) {
  let printed: any;
  const context = { command: 'release', id: 'seal-check', args, rest: [], base: url, connection: null, api, print: (value: unknown) => { printed = value; }, repositoryRoot: () => work } as any;
  process.exitCode = 0;
  await releaseCommands[0].run(context, undefined);
  const exitCode = process.exitCode; process.exitCode = 0;
  return { printed, exitCode };
}

test('unit:seal-authority-check-read-only — the route answers who may seal, writes no event and never seals or changes a hold; release seal-check prints the answer and exits non-zero when sealing is not allowed', async () => {
  const candidate = cutCandidates[0];
  const passing = { format: 'graphyard-external-run-v1', producer: 'huck-engineer', runId: 'run-1', sha: candidate.sha, cases: [{ id: 'pay', verdict: 'passed', attempts: 1, durationMs: 100, required: true }] };
  assert.equal((await call('validation/import', producer, passing)).status, 200);
  const holdBefore = (await call(`validation/import/${candidate.sha}?candidate=${candidate.id}`, reader)).body;
  assert.equal(holdBefore.sealed, false);
  const before = await events();

  for (const actor of [admin, releaseFiler]) assert.deepEqual((await call('validation/import/seal-authority', actor)).body, { mayseal: true, role: actor.role });
  for (const actor of [reader, producer]) assert.deepEqual((await call('validation/import/seal-authority', actor)).body, { mayseal: false, role: actor.role, needed });

  assert.equal(await events(), before, 'the check writes no event');
  assert.deepEqual((await call(`validation/import/${candidate.sha}?candidate=${candidate.id}`, reader)).body, holdBefore, 'the hold is unchanged and still unsealed');

  // The command, without a candidate, prints the answer and records nothing.
  const refused = await sealCheck(apiAs(reader), []);
  assert.deepEqual(refused.printed, { mayseal: false, role: 'reader', needed });
  assert.equal(refused.exitCode, 1, 'a credential that may not seal fails the step');
  const allowed = await sealCheck(apiAs(releaseFiler), []);
  assert.deepEqual(allowed.printed, { mayseal: true, role: 'operator-agent' });
  assert.equal(allowed.exitCode, 0);
  assert.equal(gitIn(work)(['tag', '--list', `${sealCheckTagPrefix}*`]).trim(), '', 'no candidate named, nothing recorded');
  assert.equal(await events(), before);
});

test('unit:seal-authority-preflight-and-attention — both workflows run release seal-check first in the uat imports job, and a refused check on the candidate raises one master status line naming GRAPHYARD_RELEASE_TOKEN in uat and the role it needs', async () => {
  // The rendered promotion workflow and Graphyard's own: the check precedes the step that seals.
  const policy = deliveryPolicySchema.parse({ mode: 'release-candidate', candidateSchedule: '0 */6 * * *',
    mergeGate: { preMerge: [{ check: 'test', command: 'npm run test', source: 'script', reason: 'fast' }], perCandidate: [{ check: 'test:e2e', command: 'npm run test:e2e', source: 'script', reason: 'long' }] },
    deploy: { adapter: 'railway', project: 'orders', uat: null, production: null } });
  const own = await readFile(fileURLToPath(new URL('../.github/workflows/release-candidate.yml', import.meta.url)), 'utf8');
  for (const [name, workflow] of [['rendered', renderPromotionWorkflow(policy, { cli: 'graphyard' })], ['own', own]] as const) {
    const job = workflow.slice(workflow.indexOf('\n  imports:\n'), workflow.indexOf('\n  promote:\n'));
    assert.match(job, /environment: uat/, `${name}: the imports job runs in the uat environment`);
    const steps = job.slice(job.indexOf('steps:')).split('\n      - ').slice(1);
    const named = steps.filter(step => /release (seal-check|imports)/.test(step));
    assert.match(named[0] ?? '', /release seal-check/, `${name}: release seal-check is the first Graphyard step of the uat imports job`);
    assert.match(named[0], /GRAPHYARD_TOKEN: \$\{\{ secrets\.GRAPHYARD_RELEASE_TOKEN \}\}/, `${name}: it checks the credential the seal uses`);
    assert.match(named[1] ?? '', /release imports/, `${name}: the seal follows the check`);
    assert.match(job, /contents: write/, `${name}: the check can record its answer on the candidate`);
  }

  const candidate = cutCandidates[0];
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  const ledger = () => promotionReads(config, work, defaultChildRun, true, false)!.ledger();

  // A stale token the plane does not accept at all, and one with the wrong role, are both refused and recorded.
  const revoked = await sealCheck(async () => { throw Object.assign(new Error('{"error":"Unauthorized"}'), { status: 401 }); }, [candidate.id, '--base', 'main']);
  assert.equal(revoked.exitCode, 1);
  assert.equal(revoked.printed.mayseal, false);
  const stale = await sealCheck(apiAs(reader), [candidate.id, '--base', 'main']);
  assert.equal(stale.exitCode, 1);
  let read = await ledger();
  assert.equal(read.candidates![0].id, candidate.id);
  assert.equal(read.candidates![0].sealCheck?.mayseal, false);
  assert.equal(read.candidates![0].sealCheck?.role, 'reader', 'the newest check of the candidate is the one read');
  // The loop's cursor keeps the check (its promotion candidates schema is strict).
  const state = promotionStateSchema.parse({ checkedAt: new Date().toISOString(), mainSha: null, promotedSha: null, promotedAt: null, behind: null, inFlight: false, runsReadAt: null, dispatchedAt: null, lastDispatchAt: null,
    candidates: read.candidates, nextDueAt: null, reason: null });
  const line = sealRefusalLine(state.candidates!);
  assert.ok(line, 'a refused check raises an attention line');
  assert.match(line.text, new RegExp(`Promotion of candidate ${candidate.id} was refused for seal authority`));
  assert.match(line.text, /GRAPHYARD_RELEASE_TOKEN in the uat environment authenticates as reader/);
  assert.match(line.text, /needs admin or operator-agent/);
  const owned = sealRefusalLine(state.candidates!, 'owner/project')!;
  assert.match(owned.next, /graphyard operator-agent rotate graphyard-release-follow-up \d+ .* --token-stdin; .*gh secret set GRAPHYARD_RELEASE_TOKEN --repo owner\/project --env uat/, 'the remedy replaces the secret outright, whatever its stored time');
  assert.equal(line.role, 'master'); assert.equal(line.human, false);

  // Once the secret holds the release-filing identity, the next check passes and the line clears.
  const fixed = await sealCheck(apiAs(releaseFiler), [candidate.id, '--base', 'main']);
  assert.equal(fixed.exitCode, 0);
  read = await ledger();
  assert.equal(read.candidates![0].sealCheck?.mayseal, true);
  assert.equal(sealRefusalLine(read.candidates!), null);
  assert.equal(sealRefusalLine([{ id: candidate.id }]), null, 'a candidate never checked raises nothing');
  // The newest check by time decides across candidates: an older candidate re-checked after a newer one passed.
  const check = (mayseal: boolean, hour: number) => ({ mayseal, role: mayseal ? 'operator-agent' : 'reader', needed: mayseal ? [] : needed, at: new Date(1_760_000_000_000 + hour * 3_600_000).toISOString(), secret: 'GRAPHYARD_RELEASE_TOKEN', environment: 'uat' });
  const later = [{ id: 'rc-B', sealCheck: check(true, 9) }, { id: 'rc-A', sealCheck: check(false, 10) }];
  assert.match(sealRefusalLine(later)?.text ?? '', /candidate rc-A was refused/, 'the later refusal of the older candidate stands');
  assert.equal(sealRefusalLine([later[0], { id: 'rc-A', sealCheck: check(false, 8) }]), null, 'a refusal a later check passed is cleared');

  // A plane that predates the route: 404, or the operator-agent guard's 403; nothing is checked, recorded or failed.
  const tagsBefore = gitIn(work)(['tag', '--list', `${sealCheckTagPrefix}*`]);
  for (const refusal of [{ status: 404, message: '{"error":"Route not found"}' }, { status: 403, message: '{"error":"Route is not available to operator agents"}' }]) {
    const unserved = await sealCheck(async () => { throw Object.assign(new Error(refusal.message), { status: refusal.status }); }, [candidate.id, '--base', 'main']);
    assert.deepEqual(unserved.printed, { checked: false }); assert.equal(unserved.exitCode, 0);
  }
  assert.equal(gitIn(work)(['tag', '--list', `${sealCheckTagPrefix}*`]), tagsBefore, 'an unserved check records nothing');
  await assert.rejects(sealCheck(async () => { throw Object.assign(new Error('{"error":"Forbidden"}'), { status: 403 }); }, [candidate.id, '--base', 'main']), 'any other refusal still fails the step');

  // A valid operator-agent scoped to another repository: auth 403s before the route; seal-check records the denial and attention names the uat secret.
  const scoped = await call('validation/import/seal-authority', otherRepoFiler);
  assert.equal(scoped.status, 403);
  assert.match(JSON.stringify(scoped.body), /Repository is outside operator-agent scope/, 'the server still enforces repository scope');
  const outOfScope = await sealCheck(apiAs(otherRepoFiler), [candidate.id, '--base', 'main']);
  assert.equal(outOfScope.exitCode, 1);
  assert.deepEqual(outOfScope.printed, { mayseal: false, role: outOfScopeRole, needed });
  read = await ledger();
  assert.equal(read.candidates![0].sealCheck?.mayseal, false);
  assert.equal(read.candidates![0].sealCheck?.role, outOfScopeRole);
  const scopeLine = sealRefusalLine(read.candidates!)!;
  assert.match(scopeLine.text, /GRAPHYARD_RELEASE_TOKEN in the uat environment authenticates as operator-agent \(other repository\)/);
  assert.match(scopeLine.text, /needs admin or operator-agent/);
  assert.deepEqual(sealRefusalAttention({ candidates: read.candidates }), [scopeLine]);

  // master status adds exactly that one line to its attention list.
  const status = await readFile(fileURLToPath(new URL('../src/cli/master-status.ts', import.meta.url)), 'utf8');
  assert.match(status, /lag\.attention\.push\(.*\.\.\.sealRefusalAttention\(cursor\?\.promotion, master\.repository\)\)/);
  assert.deepEqual(sealRefusalAttention({ candidates: state.candidates }), [line], 'one item from the cursor, owned by the master');
});
