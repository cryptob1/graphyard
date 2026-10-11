import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { cut, ledgerStatus, readLedger, refusedFiling, refusedFilingFault, releaseFilingRepair, releaseFilingSecret, releaseFilingSetupFile, runUrlFromEnv, validateAndRecord, type Suite } from '../src/release-candidate.js';
import { promotionCycle, promotionReads, promotionStatus, refusedFilingKey, refusedFilings, type PromotionLedger, type PromotionReads } from '../src/daemon/deployment.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { promotionStateSchema } from '../src/daemon/state.js';
import { refusedFilingAttention } from '../src/master-status.js';

// GY-1691: on 2026-10-10 two release candidates failed their chart job and the uat job's filing
// ended with "Operator permission required" — the uat environment's GRAPHYARD_RELEASE_TOKEN predated
// the graphyard-release-follow-up identity GY-1614 made the filing run as — so no follow-up and no
// hold existed for either, and master status read only 'did not promote it'. A refused filing is
// now part of the recorded verdict, a fault the loop's deployment step raises naming the candidate,
// its run, the refusal and the doctor line, and an attention line in master status.
const refusal = 'Operator permission required';
const runUrl = 'https://github.com/owner/repo/actions/runs/38110971751';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const childRun = (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A bare origin and a clone whose main carries one merged item. */
async function repository() {
  const root = await temporaryDirectory('release-candidate-filing');
  const origin = join(root, 'origin.git'), work = join(root, 'work');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, work);
  for (const [key, value] of [['user.name', 'test'], ['user.email', 'test@example.test'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) git(work, 'config', key, value);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'initial');
  git(work, 'push', '-q', 'origin', 'HEAD:main');
  const merge = (key: string, pr: number) => {
    const branch = `graphyard/${key.toLowerCase()}-1`;
    git(work, 'checkout', '-q', '-b', branch, 'origin/main');
    git(work, 'commit', '-q', '--allow-empty', '-m', `${key} change`);
    git(work, 'checkout', '-q', '--detach', 'origin/main');
    git(work, 'merge', '-q', '--no-ff', branch, '-m', `Merge pull request #${pr} from owner/${branch}`, '-m', `${key}: the change`);
    git(work, 'push', '-q', 'origin', 'HEAD:main');
    git(work, 'fetch', '-q', 'origin');
    return git(work, 'rev-parse', 'HEAD');
  };
  return { origin, work, git: (args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), merge };
}
/** A UAT that serves `sha` at /healthz, as the real server answers. */
const serving = (sha: string) => (async (url: URL | string) => new URL(String(url)).pathname === '/healthz'
  ? new Response(JSON.stringify({ ok: true, version: '0.1.0', revision: 'unknown', schema: 3, commit: sha })) : new Response('ok')) as typeof fetch;
const suite = (name: string, passed: boolean): Suite => ({ name, run: async () => ({ name, passed, detail: passed ? 'ok' : `${name} job failed` }) });
const config = (repositoryName: string): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/outside/graphyard.mjs',
  repository: repositoryName, baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
const effects = (promotion: PromotionReads, now: () => number): DaemonEffects => ({
  agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
  snapshot: async () => ({ work: [], now: new Date(now()).toISOString() }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
  observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(now()).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
  recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {}, promotion,
});

test('unit:refused-release-filing-raises-fault — a failed candidate whose filing is refused records the refusal and its run on the UAT verdict; the loop reads it, its deployment step raises one deployment fault naming the candidate, the run URL, the refusal and the doctor line, settled once the follow-up is filed; master status lists the candidate under attention and in the promotion section', async () => {
  const repo = await repository();
  const sha = repo.merge('GY-1682', 1115);
  const { candidate } = cut(repo.git as any, { base: 'main', trigger: 'manual', now: new Date('2026-10-10T18:00:00Z'), push: true }) as any;
  assert.equal(candidate.sha, sha);

  // The uat job's filing meets the pre-GY-1614 credential: the create path refuses it. The verdict is still recorded, with the refusal and the run.
  const filed: string[] = [];
  const result = await validateAndRecord(repo.git, candidate.id, 'https://uat.example.test', [suite('chart', false)],
    { base: 'main', push: true, timeoutMs: 0, fetcher: serving(sha), run: runUrl, file: async (_item, requestId) => { filed.push(requestId); throw new Error(refusal); } });
  assert.deepEqual([result.record.result, result.followUp, result.filingError], ['failed', null, refusal]);
  assert.equal(filed.length, 1);
  const ledger = readLedger(repo.git as any);
  const record = ledger.uat.find(entry => entry.id === candidate.id)!;
  assert.deepEqual([record.filingError, record.run, record.followUp], [refusal, runUrl, null], 'the recorded UAT verdict carries the refusal and the run');
  assert.deepEqual(refusedFiling(record), { id: candidate.id, sha, run: runUrl, refusal });
  const listed = ledgerStatus(ledger)[0].uat!;
  assert.deepEqual([listed.filingError, listed.run], [refusal, runUrl], 'release status shows the refusal');
  // A passed candidate, or a failed one that filed, is no refusal.
  assert.equal(refusedFiling({ ...record, result: 'passed' }), null);
  assert.equal(refusedFiling({ ...record, followUp: 'GY-1700' }), null);
  assert.equal(refusedFiling({ ...record, filingError: null }), null);
  // Outside GitHub Actions no run is recorded; inside, the run's own URL is.
  assert.equal(runUrlFromEnv({}), null);
  assert.equal(runUrlFromEnv({ GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '38110971751' }), runUrl);

  // The fault names the candidate, its run, the refusal and the doctor line, with the FILE shape and the secret name.
  const fault = refusedFilingFault(refusedFiling(record)!, 'owner/repo');
  assert.match(fault.text, new RegExp(`Release candidate ${candidate.id} \\(${sha.slice(0, 12)}\\) failed validation in ${runUrl.replace(/[.]/g, '\\.')} and its filing was refused`));
  assert.ok(fault.text.endsWith(`: ${refusal}`), fault.text);
  assert.equal(fault.next, `${releaseFilingRepair('owner/repo')}; then graphyard release follow-up ${candidate.id} files the missed follow-up`);
  assert.match(fault.next, /graphyard doctor prints FAIL release-filing until an administrator issues graphyard-release-follow-up with `graphyard operator-agent setup FILE --token-stdin`/);
  assert.match(fault.next, /PASS release-filing once the served release accepts that token/);
  assert.ok(fault.next.includes(`the uat environment secret ${releaseFilingSecret}`));
  assert.equal(releaseFilingSecret, 'GRAPHYARD_RELEASE_TOKEN');
  assert.deepEqual(JSON.parse(releaseFilingSetupFile('owner/repo')), { id: 'graphyard-release-follow-up', displayName: 'Release follow-up', capabilities: ['intent:create'], scope: { repositories: ['owner/repo'], workItems: ['*'] }, reason: 'A failed release candidate files its follow-up' });

  // The loop's ledger read carries the verdict on the listed candidate.
  const reads = promotionReads(config('owner/repo'), repo.work, childRun, true)!;
  const read = await reads.ledger();
  assert.deepEqual(read.candidates![0].uat, { result: 'failed', at: record.at, run: runUrl, followUp: null, filingError: refusal });
  const T = Date.parse('2026-10-10T18:30:00Z');
  const cycled = await promotionCycle(null, { ...reads, runs: async () => [], dispatch: async () => {} }, { now: T, everyMinutes: 10, intervalMs: 20_000 });
  const state = promotionStateSchema.parse(cycled.state);
  assert.deepEqual(refusedFilings(state), [{ id: candidate.id, sha, run: runUrl, refusal }]);
  const status = promotionStatus(state);
  assert.deepEqual(status.refusedFilings, [{ id: candidate.id, sha, run: runUrl, refusal }], 'the promotion section names the candidate with its run URL');
  assert.equal(status.candidates[0].uat?.filingError, refusal);

  // The deployment step raises the fault once, keeps it while the refusal stands, and settles it once the candidate filed.
  const master = config('owner/repo');
  const daemon = emptyDaemonState(master);
  daemon.lock = { id: 'lock', pid: process.pid, host: master.hostId, startedAt: new Date(T).toISOString(), heartbeatAt: new Date(T).toISOString() };
  let clock = T;
  const stub: { ledger: PromotionLedger } = { ledger: read };
  const loop = effects({ ledger: async () => stub.ledger, runs: async () => [], dispatch: async () => {} }, () => clock);
  await runCycle(master, daemon, loop, () => clock);
  const key = refusedFilingKey(candidate.id);
  const raised = daemon.actions[key];
  assert.ok(raised, `the deployment step records ${key}`);
  assert.deepEqual([raised.kind, raised.state, raised.faultClass, raised.attempts], ['deployment', 'failed', 'deployment', 1]);
  assert.equal(raised.detail, `${fault.text}. ${fault.next}`);
  assert.ok(daemon.faults.instances.some(entry => entry.faultClass === 'deployment' && entry.subject === key && entry.text.includes(candidate.id) && entry.text.includes(runUrl)), 'the fault is an instance of the deployment class naming the candidate and its run');
  clock += 20 * 60_000;
  await runCycle(master, daemon, loop, () => clock);
  assert.equal(daemon.actions[key].attempts, 1, 'an unchanged refusal is not recorded again');
  assert.equal(daemon.actions[key].state, 'failed');
  // master status lists it under attention, owned by the master with the doctor line as the next step.
  const attention = refusedFilingAttention(daemon.promotion, 'owner/repo');
  assert.equal(attention.length, 1);
  assert.deepEqual([attention[0].subject, attention[0].text, attention[0].next, attention[0].role, attention[0].faultClass], ['release', fault.text, fault.next, 'master', 'deployment']);
  assert.deepEqual(refusedFilingAttention(null, 'owner/repo'), []);
  // The identity restored, the candidate's follow-up is filed: the fault settles.
  stub.ledger = { ...read, candidates: [{ ...read.candidates![0], uat: { ...read.candidates![0].uat!, followUp: 'GY-1700' } }] };
  clock += 20 * 60_000;
  await runCycle(master, daemon, loop, () => clock);
  assert.equal(daemon.actions[key].state, 'done');
  assert.match(daemon.actions[key].detail, /filed its follow-up or is no longer among the listed candidates/);
  assert.deepEqual(refusedFilingAttention(daemon.promotion, 'owner/repo'), []);
});
