import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal } from '../src/model.js';
import { cutAsync, deployToUatAsync, gitIn, releaseFilingIdentity, validateAndRecord, type CandidateBuild, type ReleaseCandidate } from '../src/release-candidate.js';
import { handedImportsVariable } from '../src/validation-import.js';
import { releaseCommands } from '../src/cli/release.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { releaseLedgerGit } from './helpers/release-ledger-git.js';

// GY-1874: a direct promotion — `release promote` with a plane credential — reads the candidate's
// imported-run hold and then deploys. The read alone does not bind the deploy: before any deployer
// runs, the direct path seals the hold it read (an admin or an operator agent seals; the workflows'
// release-filing identity is one), so a required failure imported after the read is seen and
// refused, and once the seal stands no import can bind before the deploy. A held candidate is never
// sealed, so a passing import can still release it and promotion retries.

// Importing needs the external-runs:import grant (GY-1879) beside the producer role.
const producer: Principal = { id: 'huck-producer', role: 'producer', grants: ['external-runs:import'] };
const reader: Principal = { id: 'coordinator-reader', role: 'reader' };
// The identity GRAPHYARD_RELEASE_TOKEN is provisioned as (src/master/release-filing.ts): the credential a direct `release promote` holds in the uat environment.
const releaseFiler: Principal = { id: releaseFilingIdentity.id, role: 'operator-agent', capabilities: [...releaseFilingIdentity.capabilities], scope: { repositories: ['owner/project'], workItems: [] } };
// A producer without that grant: its import is refused 403 for the grant, before any seal is read.
const ungranted: Principal = { id: 'unit-producer', role: 'producer', proofs: ['unit:*'] };
const principals = [producer, ungranted, reader, releaseFiler];
const tokens = new Map(principals.map(p => [p.id, `${p.id}-${'t'.repeat(40)}`]));

let database: InstanceType<typeof EmbeddedPostgres>, store: Store, http: ReturnType<typeof server>, url: string, scratch: string, work: string;
// Instants derive from the run's own clock: candidates are cut minutes apart so their ids differ.
let start = 0;
const at = (minutes: number) => new Date(start + minutes * 60_000);

/** The release candidates cut so far, served as `rc/` tags in the checkout an import reads. */
const cutCandidates: ReleaseCandidate[] = [];
const tagObject = (index: number) => String(41 + index).repeat(40);
const github = releaseLedgerGit(() => cutCandidates, tagObject);

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1874;
  scratch = await temporaryDirectory('promotion-hold-seal');
  database = new EmbeddedPostgres({ databaseDir: join(scratch, 'pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('promotion_hold_seal_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/promotion_hold_seal_test`); await store.init();
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = github.run;
  http = server(engine, principals.map(p => ({ ...p, token: tokens.get(p.id)! })), null);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
  start = Date.now();

  // A bare origin and a clone: the real release ledger the CLI and the local ports promote from.
  const origin = join(scratch, 'origin.git');
  work = join(scratch, 'work');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(scratch, 'init', '-q', '--bare', '-b', 'main', origin);
  git(scratch, 'clone', '-q', origin, work);
  for (const [key, value] of [['user.name', 'test'], ['user.email', 'test@example.test'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) git(work, 'config', key, value);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'initial');
  git(work, 'push', '-q', 'origin', 'HEAD:main');
});

after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); if (scratch) await rm(scratch, { recursive: true, force: true }); });

async function call(path: string, actor: Principal, data?: unknown) {
  const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${tokens.get(actor.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { status: response.status, body: await response.json() as any };
}
/** `GET /api/PATH` (or POST with `data`) as the CLI's api calls it: a refusal throws with its status. */
const readAs = (actor: Principal) => async (path: string, data?: unknown) => {
  const { status, body } = await call(path, actor, data);
  if (status >= 400) throw Object.assign(new Error(JSON.stringify(body)), { status });
  return body;
};
const imported = async (document: unknown) => { const result = await call('validation/import', producer, document); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
const run = (sha: string, runId: string, cases: readonly Record<string, unknown>[]) => ({ format: 'graphyard-external-run-v1', producer: 'huck-engineer', runId, sha, cases });
/** A required failed case: the import that must be seen between the hold read and the deploy. */
const requiredFailure = (sha: string, runId: string) => run(sha, runId, [{ id: 'pay', verdict: 'failed', attempts: 1, durationMs: 100, required: true }]);
const passingRun = (sha: string, runId: string) => run(sha, runId, [{ id: 'pay', verdict: 'passed', attempts: 1, durationMs: 100, required: true }]);

// The recording deployer: the digest deploy command appends each candidate SHA it is called with.
const deployLog = (name: string) => join(scratch, `${name}-deploy.log`);
const deployCommand = (log: string) => `printf '%s\\n' "$GRAPHYARD_CANDIDATE_SHA" >> ${log}`;

/** A candidate cut at its own commit with one recorded build, deployed to UAT by digest and passed there, so promotion deploys by digest. */
async function cutCandidate(n: number) {
  const git = gitIn(work);
  const file = join(work, `change-${n}.txt`);
  writeFileSync(file, `${n}\n`);
  git(['add', file]); git(['commit', '-q', '-m', `change ${n}`]); git(['push', '-q', 'origin', 'HEAD:main']);
  const asyncGit = async (args: string[]) => git(args);
  const build = (cut: { id: string; sha: string }): CandidateBuild => ({ registration: { id: 'graphyard-builder', revision: 1 }, sourceSha: cut.sha, buildInputsDigest: `sha256:${'b'.repeat(64)}`, artifacts: [{ service: 'app', digest: `sha256:${String(n).repeat(64)}` }], provenanceUrl: `https://ci.example.test/builds/${n}` });
  const result = await cutAsync(asyncGit, { base: 'main', trigger: 'manual', now: at(n * 10), push: true, build });
  assert.ok(result.cut, `candidate ${n} is cut`);
  const candidate = result.candidate;
  cutCandidates.push(candidate);
  await deployToUatAsync(asyncGit, candidate.id, 'main', at(n * 10 + 1), async () => {});
  const serving = (async () => new Response(JSON.stringify({ ok: true, commit: candidate.sha }))) as unknown as typeof fetch;
  const validated = await validateAndRecord(asyncGit, candidate.id, 'https://uat.example.test', [{ name: 'smoke', run: async () => ({ name: 'smoke', passed: true, detail: 'ok' }) }],
    { base: 'main', push: true, timeoutMs: 60_000, fetcher: serving, sleep: async () => {}, now: () => at(n * 10 + 2), digests: candidate.build!.artifacts });
  assert.equal(validated.record.result, 'passed', `candidate ${candidate.id} passed UAT`);
  return candidate;
}

test('unit:promotion-hold-sealed-before-production — a required failure imported after a direct promotion read its hold and before the deployer is called refuses promotion through the CLI, naming the failure, with the deployer uncalled; without the import an all-passing candidate deploys once', async () => {
  delete process.env[handedImportsVariable];

  // ——— The CLI path (`release promote` with a plane credential): ———
  let interleave: (() => Promise<void>) | null = null;
  const cliApi = async (path: string, data?: unknown) => {
    if (data !== undefined && String(path).endsWith('/seal') && interleave) { const hook = interleave; interleave = null; await hook(); }
    return readAs(releaseFiler)(path, data);
  };
  const promoteByCli = async (candidate: ReleaseCandidate) => {
    let printed: any;
    const context = { command: 'release', id: 'promote', args: [candidate.id, '--base', 'main'], rest: [], base: url, connection: null, api: cliApi,
      print: (value: unknown) => { printed = value; }, repositoryRoot: () => work } as any;
    await releaseCommands[0].run(context, undefined);
    return printed;
  };
  const savedDeploy = process.env.GRAPHYARD_DEPLOY_DIGESTS;
  process.env.GRAPHYARD_DEPLOY_DIGESTS = deployCommand(deployLog('cli'));
  try {
    // No interleaved import: the all-passing candidate promotes, the recording deployer runs once, and the seal stands.
    const w = await cutCandidate(1);
    const promoted = await promoteByCli(w);
    assert.equal(promoted.promoted, true, JSON.stringify(promoted));
    assert.equal(await readFile(deployLog('cli'), 'utf8'), `${w.sha}\n`, 'the deployer was called exactly once');
    const late = await call('validation/import', producer, requiredFailure(w.sha, 'cli-late-1'));
    assert.equal(late.status, 409, 'an import against the promoted candidate is refused: its hold was sealed at promotion');
    assert.match(late.body.error, /sealed for promotion/);

    // The interleaving under test: the import lands after promotion read a released hold and before the deployer is called.
    const x = await cutCandidate(2);
    interleave = () => imported(requiredFailure(x.sha, 'cli-late-2'));
    const refused = await promoteByCli(x);
    assert.equal(refused.promoted, false, 'the interleaved required failure holds the candidate out of production');
    assert.match((refused.refusals ?? []).join('\n'), new RegExp(`held by imported external runs at ${x.sha}: pay \\(failed in run cli-late-2\\)`));
    assert.equal(await readFile(deployLog('cli'), 'utf8'), `${w.sha}\n`, 'the recording deployer received no call');
    assert.equal(process.exitCode, 1); process.exitCode = 0;

    // Once a passing import releases the hold, promotion retries and deploys, sealing as it goes.
    await imported(passingRun(x.sha, 'cli-fix'));
    const retried = await promoteByCli(x);
    assert.equal(retried.promoted, true, JSON.stringify(retried));
    assert.equal(await readFile(deployLog('cli'), 'utf8'), `${w.sha}\n${x.sha}\n`, 'the retry deployed once');
    const afterSeal = await call('validation/import', producer, requiredFailure(x.sha, 'cli-late-3'));
    assert.equal(afterSeal.status, 409, 'the retried promotion sealed the candidate too');
  } finally { savedDeploy === undefined ? delete process.env.GRAPHYARD_DEPLOY_DIGESTS : process.env.GRAPHYARD_DEPLOY_DIGESTS = savedDeploy; }
});

test('unit:sealed-import-grant-and-seal-refusals-distinct — against the promoted candidate a producer holding external-runs:import is refused 409 because its hold was sealed at promotion, and a producer without the grant importing the same run is refused 403 for the grant before the seal is consulted', async () => {
  const savedDeploy = process.env.GRAPHYARD_DEPLOY_DIGESTS;
  process.env.GRAPHYARD_DEPLOY_DIGESTS = deployCommand(deployLog('distinct'));
  try {
    const v = await cutCandidate(5);
    // Before promotion nothing is sealed, and the ungranted producer is refused for the grant all the same.
    const unsealed = await call('validation/import', ungranted, requiredFailure(v.sha, 'distinct-early'));
    assert.equal(unsealed.status, 403);
    assert.match(unsealed.body.error, /requires the external-runs:import grant/);
    let printed: any;
    await releaseCommands[0].run({ command: 'release', id: 'promote', args: [v.id, '--base', 'main'], rest: [], base: url, connection: null, api: readAs(releaseFiler),
      print: (value: unknown) => { printed = value; }, repositoryRoot: () => work } as any, undefined);
    assert.equal(printed.promoted, true, JSON.stringify(printed));
    // The sealed-hold control: the granted producer reaches the import and is refused for the seal, never for the grant.
    const sealed = await call('validation/import', producer, requiredFailure(v.sha, 'distinct-run'));
    assert.equal(sealed.status, 409, 'the granted import against the promoted candidate is refused 409: its hold was sealed at promotion');
    assert.match(sealed.body.error, /sealed for promotion/);
    // The grant control: the same run from a producer without the grant is refused 403 naming the grant, not the seal.
    const refused = await call('validation/import', ungranted, requiredFailure(v.sha, 'distinct-run'));
    assert.equal(refused.status, 403, 'the ungranted import is refused 403 before the seal is consulted');
    assert.match(refused.body.error, /requires the external-runs:import grant; producer unit-producer holds no grant/);
    assert.doesNotMatch(refused.body.error, /sealed/);
  } finally { savedDeploy === undefined ? delete process.env.GRAPHYARD_DEPLOY_DIGESTS : process.env.GRAPHYARD_DEPLOY_DIGESTS = savedDeploy; }
});
