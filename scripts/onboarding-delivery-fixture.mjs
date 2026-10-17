// The isolated normal-onboarding fixture of the UAT e2e suite (GY-1910, release hold GY-1909).
//
// onboarding-delivery-defaults describes a repository onboarded the normal way: it reads the
// project's delivery defaults and the merger mode, then opens the Delivery view. The shared UAT
// installation is an existing install whose merger was explicitly set to github, and onboarding
// keeps that setting (GY-1901), so reading it there asserts against the wrong project. This script
// gives the case its own target instead: from the candidate checkout's exact HEAD it creates a fresh
// fixture repository and a fresh control plane (its own Postgres), runs normal onboarding with the
// candidate's own CLI (`init --scan`, then `init --scan --apply`), deploys the declaration init
// committed to that plane as the install does, and runs the case there. Every other uat case runs
// against UAT as before, in one report and one verdict, so the release holds read it unchanged.
// Nothing here reconfigures the shared install or writes the host's configuration (the fixture's
// configuration and data homes sit in its scratch directory), and every fixture resource is removed afterwards.
//
//   node --import tsx scripts/onboarding-delivery-fixture.mjs   (the uat job's `e2e` suite)
import { spawn, execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { loadCases } from '../src/e2e/case.ts';
import { candidatePendingOutcomes, checkoutContract, failureDetail, releaseRetries, releaseVerdict, runCases, summarize } from '../src/e2e/runner.ts';
import { contractPendingCases } from '../src/release-candidate.ts';
import { checkoutRepositoryPolicy } from '../src/model/repository-policy.ts';
import { repositoryDelivery } from '../src/install/index.ts';
import { projectDeliveryAssignment } from '../src/project-applications.ts';

export const candidateRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The uat cases that describe a freshly onboarded project, and so run against the fixture, never the shared install. */
export const fixtureCases = ['onboarding-delivery-defaults'];
/** The fixture repository: a static site, a Compose application, its own CI and its own cases, as normal onboarding meets one. */
export const fixtureFiles = {
  'package.json': JSON.stringify({ name: 'fixture-project', scripts: { test: 'node --test', build: 'node build.mjs' } }),
  'build.mjs': 'console.log("built");\n',
  '.github/workflows/ci.yml': 'name: ci\non:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n',
  'public/index.html': '<!doctype html><title>Fixture static site</title>\n',
  'compose.yml': 'services:\n  web:\n    build: .\n    ports:\n      - "8080:3000"\n  db:\n    image: postgres:16\n',
  'e2e/cases/fixture-static-home.json': JSON.stringify({ id: 'fixture-static-home', title: 'Home', tags: ['fixture', 'site'], target: 'any', required: false, steps: [] }),
  'e2e/cases/fixture-compose-app.json': JSON.stringify({ id: 'fixture-compose-app', title: 'App', tags: ['fixture', 'app'], target: 'any', required: false, steps: [] }),
};
const fixtureRepository = 'owner/fixture';

const freePort = async () => {
  const probe = createServer();
  await new Promise(done => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address();
  await new Promise(done => probe.close(done));
  return port;
};
/** The environment a fixture process starts from: the host's basics, never a Graphyard, GitHub, Railway or database setting of the job. */
const isolated = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => !/^(GRAPHYARD_|GITHUB_|RAILWAY_|DATABASE_URL$|PORT$|HOST$|SOURCE_COMMIT$)/.test(key)));
/**
 * The fixture-owned configuration, state and data homes under `scratch`: init writes worker profiles,
 * credentials and install records, and gh its state, under these, so none reaches, or is read from, the host's own.
 */
export const confinedHomes = (scratch) => ({ GRAPHYARD_CONFIG_HOME: join(scratch, 'config/graphyard'), GRAPHYARD_DATA_HOME: join(scratch, 'data'),
  XDG_CONFIG_HOME: join(scratch, 'config'), XDG_STATE_HOME: join(scratch, 'state'), XDG_DATA_HOME: join(scratch, 'share'), XDG_CACHE_HOME: join(scratch, 'cache') });
export const checkoutHead = (root) => execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().toLowerCase();

/**
 * A control plane started from the checkout's own source with its own Postgres, serving `sha` as
 * its build: `GRAPHYARD_PROJECT_DELIVERY` and the rest of `env` are what the install deploys.
 * `restart(env)` redeploys it on the same database.
 */
export async function startControlPlane({ root = candidateRoot, sha, scratch, env = {}, host = process.env, timeoutMs = 120_000 }) {
  const port = await freePort();
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const database = new EmbeddedPostgres({ databaseDir: join(scratch, 'pg'), user: 'graphyard', password: 'fixture-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('fixture');
  const token = randomBytes(32).toString('hex');
  let child = null, url = null, output = '';
  const stop = async () => {
    if (!child) return;
    const running = child; child = null;
    if (running.exitCode === null && running.signalCode === null) { const exited = new Promise(done => running.once('exit', done)); running.kill('SIGTERM'); await exited; }
  };
  const start = async (deployed) => {
    const listen = await freePort();
    output = '';
    child = spawn(process.execPath, ['--import', 'tsx', join(root, 'src/server.ts')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...isolated(host), ...confinedHomes(scratch), ...deployed, DATABASE_URL: `postgres://graphyard:fixture-only@127.0.0.1:${port}/fixture`, PORT: String(listen), HOST: '127.0.0.1',
      GRAPHYARD_PRINCIPALS: JSON.stringify([{ id: 'fixture-operator', role: 'admin', token }]), GRAPHYARD_BUILD_SHA: sha, GRAPHYARD_BUILD_REVISION: sha, GITHUB_CI_APP_IDS: '15368' } });
    const keep = chunk => { output = `${output}${chunk}`.slice(-4000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    url = `http://127.0.0.1:${listen}`;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!child || child.exitCode !== null) throw new Error(`the fixture control plane exited before it was ready: ${output.trim().split('\n').slice(-5).join(' | ')}`);
      try { if ((await fetch(`${url}/healthz?ready`, { signal: AbortSignal.timeout(5_000) })).status === 200) return; } catch { /* not listening yet */ }
      if (Date.now() >= deadline) { await stop(); throw new Error(`the fixture control plane was not ready within ${timeoutMs} ms: ${output.trim().split('\n').slice(-5).join(' | ')}`); }
      await new Promise(done => setTimeout(done, 250));
    }
  };
  try { await start(env); } catch (error) { await database.stop().catch(() => {}); throw error; }
  return {
    get url() { return url; }, token, sha,
    restart: async (deployed) => { await stop(); await start(deployed); },
    close: async () => { await stop(); await database.stop().catch(() => {}); },
  };
}

/**
 * The isolated fixture: a fresh repository and control plane created through normal onboarding
 * from the candidate checkout's exact HEAD. `sha`, when given, must be that HEAD, so the fixture
 * never serves another source than the candidate it is attributed to. `close()` stops the plane
 * and its database and removes every file the fixture made.
 */
export async function createOnboardingFixture({ root = candidateRoot, sha, dashboard = false, host = process.env } = {}) {
  const head = checkoutHead(root);
  if (sha && sha.toLowerCase() !== head) throw new Error(`the onboarding fixture builds from the checkout's HEAD ${head}, not the candidate ${sha}; check out the candidate's exact SHA`);
  if (dashboard && !existsSync(join(root, 'dist/index.html'))) throw new Error('the onboarding fixture serves the dashboard from dist/, which the checkout has not built: run npx vite build --configLoader runner first');
  const scratch = await mkdtemp(join(tmpdir(), 'graphyard-onboarding-fixture-'));
  let plane = null;
  const close = async () => { await plane?.close(); plane = null; await rm(scratch, { recursive: true, force: true }); };
  try {
    const repository = join(scratch, 'repo');
    for (const [path, text] of Object.entries(fixtureFiles)) { await mkdir(join(repository, path, '..'), { recursive: true }); await writeFile(join(repository, path), text); }
    const git = (...args) => execFileSync('git', args, { cwd: repository, stdio: 'ignore' });
    git('init', '-q', '-b', 'main'); git('remote', 'add', 'origin', `git@github.com:${fixtureRepository}.git`);
    // A new install: a fresh database, nothing recorded, and no delivery declaration deployed yet.
    plane = await startControlPlane({ root, sha: head, scratch, host });
    const cli = join(root, 'bin/graphyard.mjs');
    const run = args => promisify(execFile)(process.execPath, [cli, ...args], { cwd: repository, env: { ...isolated(host), ...confinedHomes(scratch), GRAPHYARD_URL: plane.url, GRAPHYARD_TOKEN: plane.token }, maxBuffer: 16 * 1024 * 1024 })
      .then(result => JSON.parse(result.stdout), error => { throw new Error(`graphyard ${args.join(' ')} failed in the fixture repository: ${String(error.stderr || error.message).trim().slice(0, 1500)}`); });
    // Normal onboarding: init --scan, the App the operator approves once, then init --scan --apply of the reviewed proposal.
    const scanned = await run(['init', '--scan']);
    await writeFile(join(repository, '.graphyard/github-app.json'), JSON.stringify({ appId: 99, slug: 'graphyard-owner-fixture', repository: fixtureRepository, privateKey: 'fixture-only', webhookSecret: 'fixture-only', installationId: 7 }), { mode: 0o600 });
    const applied = await run(['init', '--scan', '--apply', '--url', plane.url]);
    const config = JSON.parse(await readFile(join(repository, 'graphyard.json'), 'utf8'));
    // The install deploys the committed declaration to the plane it serves.
    const { variable, value } = projectDeliveryAssignment((await repositoryDelivery(repository)).policy);
    await plane.restart({ [variable]: value });
    return { url: plane.url, token: plane.token, sha: head, cli, scratch, repository, config, onboarding: { scanned, applied }, close };
  } catch (error) { await close(); throw error; }
}

/**
 * The uat cases in id order, each fixture case against a fresh `fixture()` and every other one
 * against `url` with `token`, as one report under the candidate's run id. A run retries a failing
 * case once and stops at the first required case that fails outside a pending outcome, as the e2e
 * suite does. The report names a served SHA only when every case's target served the same one, so
 * a fixture that served another source than UAT is never attributed to the candidate.
 */
export async function runOnboardingE2e(cases, { url, token, fixture, candidate = null, contract = null, policy, root = candidateRoot, launcher, fetcher, stepTimeoutMs, now = Date.now }) {
  const selected = cases.filter(entry => entry.definition.target === 'uat');
  const runId = candidate ? `rc-${candidate.id}` : `onboarding-${randomBytes(6).toString('hex')}`;
  const pending = contractPendingCases(contract, candidate?.pendingOutcomes);
  const pendingCases = policy.e2e.pendingOutcomes === 'blocking' ? [] : pending;
  const startedAt = new Date(now()).toISOString();
  const outcomes = [], served = new Set();
  let stoppedBy = null, open = null;
  try {
    for (const entry of selected) {
      const { id, title, required } = entry.definition;
      if (stoppedBy) { outcomes.push({ id, title, file: entry.file, outcome: null, verdict: 'unrun', required, stoppedBy, durationMs: 0, attempts: 0, attemptResults: [], executed: 0, failingStep: null }); continue; }
      let target = { url, token };
      if (fixtureCases.includes(id)) {
        try { open ??= await fixture(); target = open; }
        catch (error) {
          const failingStep = { index: 0, name: 'isolated onboarding fixture', reason: String(error instanceof Error ? error.message : error).split('\n')[0].slice(0, 900) };
          outcomes.push({ id, title, file: entry.file, outcome: 'fail', verdict: 'failed', required, durationMs: 0, attempts: 1, attemptResults: [{ attempt: 1, outcome: 'fail', durationMs: 0, executed: 0, failingStep }], executed: 0, failingStep,
            ...(required && pendingCases.includes(id) ? { pending: true } : {}) });
          if (required && !pendingCases.includes(id)) stoppedBy = id;
          continue;
        }
      }
      const report = await runCases([entry], { url: target.url, token: target.token, environment: 'uat', runId, retries: releaseRetries, root, pendingCases: pending, policy, launcher, fetcher, stepTimeoutMs, now });
      served.add(report.sha);
      const outcome = report.cases[0];
      outcomes.push(outcome);
      if (outcome.verdict === 'failed' && required && !pendingCases.includes(id)) stoppedBy = id;
    }
  } finally { await open?.close(); }
  const sha = served.size === 1 ? [...served][0] : null;
  const tally = verdict => outcomes.filter(outcome => outcome.verdict === verdict).length;
  return { runId, url, environment: 'uat', sha, startedAt, finishedAt: new Date(now()).toISOString(),
    passed: tally('passed'), failed: tally('failed'), flaky: tally('flaky'), unrun: tally('unrun'), cases: outcomes, pendingOutcomes: policy.e2e.pendingOutcomes };
}

/** The suite's verdict over a report, in the e2e suite's own words. */
export function suiteResult(report, pendingCases, policy) {
  if (!report.cases.length) return { name: 'e2e', passed: false, detail: 'no E2E case targets uat, so the suite exercised nothing' };
  const verdict = releaseVerdict(report, [], pendingCases, policy), detail = failureDetail(report, pendingCases, policy);
  const executed = report.cases.length - verdict.unrun.length;
  return !verdict.passed
    ? { name: 'e2e', passed: false, detail: `${verdict.blocking.length} of ${executed} E2E cases ${verdict.blocking.every(outcome => outcome.verdict === 'flaky') ? 'were flaky' : 'failed'}: ${detail}` }
    : { name: 'e2e', passed: true, detail: `${report.passed} E2E case${report.passed === 1 ? '' : 's'} passed against UAT serving ${report.sha ?? 'an unreported commit'}, ${fixtureCases.join(', ')} on an isolated normally onboarded project${detail ? `; ${detail}` : ''}` };
}

/**
 * The `e2e` suite of `release validate`, as runE2eSuite runs it (GRAPHYARD_UAT_URL, GRAPHYARD_UAT_TOKEN,
 * GRAPHYARD_CANDIDATE_ID, GRAPHYARD_E2E_REPORT, GRAPHYARD_SUITE_DETAIL), with the fixture cases on
 * the isolated fixture built from this script's own checkout, whose HEAD must be CANDIDATE_SHA when set.
 */
export async function main(env = process.env, root = env.GRAPHYARD_E2E_ROOT ?? process.cwd()) {
  const writeDetail = async text => { if (env.GRAPHYARD_SUITE_DETAIL) await writeFile(env.GRAPHYARD_SUITE_DETAIL, `${text}\n`); };
  try {
    const url = env.GRAPHYARD_UAT_URL, token = env.GRAPHYARD_UAT_TOKEN;
    if (!url || !token) throw new Error('The e2e suite needs GRAPHYARD_UAT_URL and GRAPHYARD_UAT_TOKEN');
    const contract = await checkoutContract(root), policy = checkoutRepositoryPolicy(root);
    const candidate = env.GRAPHYARD_CANDIDATE_ID ? { id: env.GRAPHYARD_CANDIDATE_ID, pendingOutcomes: candidatePendingOutcomes(root, env.GRAPHYARD_CANDIDATE_ID) } : null;
    const report = await runOnboardingE2e(await loadCases(root), { url, token, candidate, contract, policy, root,
      fixture: () => createOnboardingFixture({ sha: env.CANDIDATE_SHA || undefined, dashboard: true, host: env }) });
    console.log(summarize(report));
    if (env.GRAPHYARD_E2E_REPORT) await writeFile(env.GRAPHYARD_E2E_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    const pending = policy.e2e.pendingOutcomes === 'blocking' ? [] : contractPendingCases(contract, candidate?.pendingOutcomes);
    const result = suiteResult(report, pending, policy);
    console.log(result.detail);
    await writeDetail(result.detail);
    return result;
  } catch (error) {
    await writeDetail(`the e2e suite could not run: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

// embedded-postgres's exit hook ends the process with status 0 whatever exitCode says, so the entry exits with the verdict itself, once its output is written.
const exit = code => process.stdout.write('', () => process.exit(code));
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then(result => exit(result.passed ? 0 : 1), error => { console.error(error instanceof Error ? error.message : error); exit(1); });
