// The isolated normal-onboarding fixture of the UAT e2e suite (GY-1910, release hold GY-1909; GY-1913).
//
// onboarding-delivery-defaults describes a repository onboarded the normal way: it reads the
// project's delivery defaults and the merger mode, then opens the Delivery view. The shared UAT
// installation is an existing install whose merger was explicitly set to github, and onboarding
// keeps that setting (GY-1901), so reading it there asserts against the wrong project. This script
// gives the case its own target instead: from the candidate checkout's exact HEAD it creates a fresh
// fixture repository and a fresh control plane (its own Postgres), runs normal onboarding with the
// candidate's own CLI (`init --scan`, then `init --scan --apply`), deploys the declaration init
// committed to that plane as the install does, and runs the case there. preview-serves-change runs
// there too (GY-1913): the shared install declares no application and runs no preview loop, so the
// fixture serves the loop's own item-preview step against its plane, previewing the site onboarding
// declared with its declared fixture-static-home case, and so does preview-isolation-cleanup (GY-1923):
// its two items preview the Compose application onboarding declared (tests/fixtures/goal-compose-preview's
// app) with its declared fixture-compose-app case, and settling one waits for the loop's cleanup. Every other uat case runs
// against UAT as before, in one report and one verdict, so the release holds read it unchanged.
// Nothing here reconfigures the shared install or writes the host's configuration (the fixture's
// configuration and data homes sit in its scratch directory), and every fixture resource is removed afterwards.
//
//   node --import tsx scripts/onboarding-delivery-fixture.mjs   (the uat job's `e2e` suite)
import { spawn, execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { loadCases } from '../src/e2e/case.ts';
import { candidatePendingOutcomes, checkoutContract, defaultStepTimeoutMs, failureDetail, releaseRetries, releaseVerdict, runCases, summarize } from '../src/e2e/runner.ts';
import { contractPendingCases } from '../src/release-candidate.ts';
import { checkoutRepositoryPolicy } from '../src/model/repository-policy.ts';
import { repositoryDelivery } from '../src/install/index.ts';
import { loadProjectDelivery, projectDeliveryAssignment } from '../src/project-applications.ts';
import { mergeRecordKey, mergeWriterReads } from '../src/daemon/cycle-merge-writer.ts';
import { itemPreviewStep } from '../src/merge-writer/preview.ts';
import { previewDemand, previewEnded } from '../src/project-previews.ts';
import { defaultChildRun } from '../src/child-runner.ts';

export const candidateRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The uat cases that describe a freshly onboarded project, and so run against the fixture, never the shared install. */
export const fixtureCases = ['onboarding-delivery-defaults', 'preview-serves-change', 'preview-isolation-cleanup'];
/** The candidate's own definition of a fixture case, tagged with the application it exercises so onboarding's scan binds it by evidence. */
const declaredCase = (root, id, application) => { const definition = JSON.parse(readFileSync(join(root, 'e2e/cases', `${id}.json`), 'utf8')); return JSON.stringify({ ...definition, tags: [...definition.tags, application] }); };
/** The candidate's own runnable Compose application (GY-1903's fixture): `web` serving its state and its own database `db`, from alpine:3 alone. */
const composeApplication = (root) => {
  const source = join(root, 'tests/fixtures/goal-compose-preview');
  return Object.fromEntries(['compose.yml', ...['banner.txt', 'db-start.sh', 'db.Dockerfile', 'heading.txt', 'web-start.sh', 'web.sh'].map(file => `app/${file}`)].map(path => [path, readFileSync(join(source, path), 'utf8')]));
};
/**
 * The fixture repository: a static site whose build shows the change it previews
 * (GRAPHYARD_PREVIEW_TITLE), a runnable Compose application, its own CI and the candidate's own fixture cases, as normal onboarding meets one.
 */
export const fixtureFiles = (root = candidateRoot) => ({
  'package.json': JSON.stringify({ name: 'fixture-project', scripts: { test: 'node --test', build: 'node build.mjs' } }),
  'build.mjs': 'import { appendFileSync } from "node:fs";\nconst title = process.env.GRAPHYARD_PREVIEW_TITLE;\nif (title) appendFileSync("public/index.html", `<p>${title.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)}</p>\\n`);\nconsole.log("built");\n',
  '.github/workflows/ci.yml': 'name: ci\non:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n',
  'public/index.html': '<!doctype html><title>Fixture static site</title>\n<h1>Fixture static site</h1>\n',
  ...composeApplication(root),
  'e2e/cases/fixture-static-home.json': declaredCase(root, 'fixture-static-home', 'site'),
  'e2e/cases/fixture-compose-app.json': declaredCase(root, 'fixture-compose-app', 'app'),
});
const fixtureRepository = 'owner/fixture';

const freePort = async () => {
  const probe = createServer();
  await new Promise(done => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address();
  await new Promise(done => probe.close(done));
  return port;
};
/** The environment a fixture process starts from: the host's basics, never a Graphyard, GitHub or gh, Railway or database setting of the job. */
const isolated = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => !/^(GRAPHYARD_|GITHUB_|GH_|RAILWAY_|DATABASE_URL$|PORT$|HOST$|SOURCE_COMMIT$)/.test(key)));
/**
 * The fixture-owned configuration, state and data homes under `scratch`: init writes worker profiles,
 * credentials and install records, and gh its state, under these, so none reaches, or is read from, the host's own.
 */
export const confinedHomes = (scratch) => ({ GRAPHYARD_CONFIG_HOME: join(scratch, 'config/graphyard'), GRAPHYARD_DATA_HOME: join(scratch, 'data'),
  XDG_CONFIG_HOME: join(scratch, 'config'), XDG_STATE_HOME: join(scratch, 'state'), XDG_DATA_HOME: join(scratch, 'share'), XDG_CACHE_HOME: join(scratch, 'cache') });
export const checkoutHead = (root) => execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().toLowerCase();

/**
 * A control plane started from the checkout's own source with its own Postgres, serving `sha` as
 * its build: `GRAPHYARD_PROJECT_DELIVERY` and the rest of `env` are what the install deploys. Its
 * admin answers `token` and the loop's coordinator identity `coordinatorToken`.
 * `restart(env)` redeploys it on the same database. A setup that fails stops whatever of it started.
 */
export async function startControlPlane({ root = candidateRoot, sha, scratch, env = {}, host = process.env, timeoutMs = 120_000, Postgres }) {
  const port = await freePort();
  Postgres ??= (await import('embedded-postgres')).default;
  const database = new Postgres({ databaseDir: join(scratch, 'pg'), user: 'graphyard', password: 'fixture-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  const token = randomBytes(32).toString('hex'), coordinatorToken = randomBytes(32).toString('hex');
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
      GRAPHYARD_PRINCIPALS: JSON.stringify([{ id: 'fixture-operator', role: 'admin', token }, { id: 'graphyard', role: 'coordinator', token: coordinatorToken }]), GRAPHYARD_BUILD_SHA: sha, GRAPHYARD_BUILD_REVISION: sha, GITHUB_CI_APP_IDS: '15368' } });
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
  try { await database.initialise(); await database.start(); await database.createDatabase('fixture'); await start(env); }
  catch (error) { await stop(); await Promise.resolve().then(() => database.stop()).catch(() => {}); throw error; }
  return {
    get url() { return url; }, token, coordinatorToken, sha,
    restart: async (deployed) => { await stop(); await start(deployed); },
    close: async () => { await stop(); await database.stop().catch(() => {}); },
  };
}

/**
 * The isolated fixture: a fresh repository and control plane created through normal onboarding
 * from the candidate checkout's exact HEAD. `sha`, when given, must be that HEAD, so the fixture
 * never serves another source than the candidate it is attributed to. `allocate()` makes its scratch
 * directory (a test passes its tracked temporaryDirectory). Once onboarded, the operator commits and
 * pushes what init wrote, and the loop's preview step serves the plane (`loop`); `settle(item)` waits
 * for an item's automatic preview, and `settle(item, { ended: true })` for its automatic cleanup. `close()` stops the loop and its previews, the plane and its
 * database, and removes every file the fixture made. `launcher`, when given, opens the browser of
 * the declared cases each preview runs, as the item-preview port of the same name.
 */
export async function createOnboardingFixture({ root = candidateRoot, sha, dashboard = false, host = process.env, launcher, allocate = () => mkdtemp(join(tmpdir(), 'graphyard-onboarding-fixture-')) } = {}) {
  const head = checkoutHead(root);
  if (sha && sha.toLowerCase() !== head) throw new Error(`the onboarding fixture builds from the checkout's HEAD ${head}, not the candidate ${sha}; check out the candidate's exact SHA`);
  if (dashboard && !existsSync(join(root, 'dist/index.html'))) throw new Error('the onboarding fixture serves the dashboard from dist/, which the checkout has not built: run npx vite build --configLoader runner first');
  const scratch = await allocate();
  let plane = null, loop = null;
  const close = async () => { await loop?.stop(); loop = null; await plane?.close(); plane = null; await rm(scratch, { recursive: true, force: true }); };
  try {
    const repository = join(scratch, 'repo');
    for (const [path, text] of Object.entries(fixtureFiles(root))) { await mkdir(join(repository, path, '..'), { recursive: true }); await writeFile(join(repository, path), text); }
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
    // The operator commits what init wrote and pushes it, so the loop's checkout holds the base it previews:
    // the push goes to a bare repository in scratch standing in for origin, whose main the checkout then tracks.
    const origin = join(scratch, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', origin], { stdio: 'ignore' });
    git('add', '-A'); git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'Onboard with graphyard init');
    git('push', '-q', origin, 'main'); git('fetch', '-q', origin, 'main:refs/remotes/origin/main');
    const delivery = loadProjectDelivery({}, repository);
    loop = startPreviewLoop({ url: plane.url, token: plane.coordinatorToken, root: repository, base: join(scratch, 'worktrees'), environment: { ...isolated(host), ...confinedHomes(scratch) }, launcher });
    const settle = (item, options = {}) => settlePreview({ url: plane.url, token: plane.token, item, delivery, ...options });
    return { url: plane.url, token: plane.token, sha: head, cli, scratch, repository, config, delivery, onboarding: { scanned, applied }, loop, settle, close };
  } catch (error) { await close(); throw error; }
}

/**
 * The loop's own item-preview step (merge-writer/preview.ts `itemPreviewStep`) over the ports the
 * daemon wires (`mergeWriterReads`), run against the plane at `url` as its coordinator identity every
 * `intervalMs`: it reads the coordination snapshot and previews every item whose criteria cite a case
 * bound to a declared application from the checkout `root`, recording each preview through
 * the plane's merge-record route, opening their browsers with `launcher` when given. `stop()` ends the loop, then every preview it started.
 */
export function startPreviewLoop({ url, token, root, base, environment, launcher, intervalMs = 1_000 }) {
  const call = async (method, path, body, key) => {
    const response = await fetch(`${url}/api/${path}`, { method, signal: AbortSignal.timeout(60_000), body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) } });
    const text = await response.text();
    if (response.status !== 200) throw new Error(`${method} /api/${path} answered ${response.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };
  const config = { baseBranch: 'main', repository: fixtureRepository, run: { mergeWriter: { deployKeyFile: join(base, 'no-deploy-key') } } };
  const ports = mergeWriterReads(config, root, defaultChildRun, { base, environment, merger: async () => (await call('GET', 'merger')).mode,
    record: (work, event) => call('POST', `work/${work.id}/merge-record`, event, mergeRecordKey(work, event)), itemPreviews: launcher ? { launcher } : {} }).itemPreviews;
  const live = new Map(), notes = [];
  let stopped = false, wake = () => {};
  const running = (async () => {
    await mkdir(base, { recursive: true });
    while (!stopped) {
      try { notes.push(...await itemPreviewStep(live, (await call('GET', 'work-snapshot?view=coordination')).work, ports)); }
      catch (error) { notes.push(`The preview step failed: ${error instanceof Error ? error.message : String(error)}`); }
      await new Promise(done => { const timer = setTimeout(done, intervalMs); wake = () => { clearTimeout(timer); done(); }; });
    }
  })();
  return {
    live, notes,
    stop: async () => {
      stopped = true; wake(); await running;
      // A preview still starting settles once cancelled; every one is then closed, its server ended and checkout removed.
      for (const entry of live.values()) entry.stop.abort();
      for (let waited = 0; [...live.values()].some(entry => !entry.opened) && waited < 60_000; waited += 100) await new Promise(done => setTimeout(done, 100));
      await Promise.all([...live.values()].map(entry => entry.opened?.close()));
    },
  };
}

/** How long a case waits for an item's automatic preview to settle before it reads the item. */
export const previewSettleMs = 300_000;
/**
 * Waits until `item`'s automatic preview has settled — recorded and no longer `starting`, or with
 * `ended`, recorded cleaned or failed once the item settled — read through the plane's own API, when
 * the item's cases need one under `delivery`; at once otherwise. It writes nothing: a preview that
 * never settles leaves the case's next step to read what is there.
 */
export async function settlePreview({ url, token, item, delivery, ended = false, timeoutMs = previewSettleMs, intervalMs = 500 }) {
  if (!item?.id || !previewDemand(item, delivery)) return null;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await fetch(`${url}/api/work/${encodeURIComponent(item.id)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
    const preview = response?.status === 200 ? (await response.json()).preview : null;
    if (preview && (ended ? previewEnded(preview) : preview.state !== 'starting')) return preview;
    if (Date.now() >= deadline) return preview ?? null;
    await new Promise(done => setTimeout(done, intervalMs));
  }
}

/**
 * `fetcher` for a case on `target`: an item the case creates there (POST /api/work) is answered only
 * once `target.settle` saw its automatic preview settle, and an item it closes (POST /api/work/:id/close)
 * only once it saw that preview cleaned up, so the case's next step reads the preview the loop
 * recorded, as an operator opening the item later would. Every response is the plane's own.
 */
export const settlingFetcher = (fetcher, target) => async (input, init) => {
  const response = await fetcher(input, init);
  const url = new URL(input instanceof Request ? input.url : String(input));
  const ended = /^\/api\/work\/[^/]+\/close$/.test(url.pathname);
  if (!target.settle || (init?.method ?? 'GET').toUpperCase() !== 'POST' || url.origin !== new URL(target.url).origin || response.status !== 200 || (url.pathname !== '/api/work' && !ended)) return response;
  // The body is read once and answered as received: a clone left unread through a long settle can lose the original's body.
  const body = await response.text();
  let item = null;
  try { item = JSON.parse(body); } catch { /* no item to settle */ }
  await target.settle(item, { ended });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};

/**
 * The uat cases in id order, each fixture case against a fresh `fixture()` and every other one
 * against `url` with `token`, as one report under the candidate's run id. A run retries a failing
 * case once and stops at the first required case that fails outside a pending outcome, as the e2e
 * suite does. The report names a served SHA only when every case's target served the same one, so
 * a fixture that served another source than UAT is never attributed to the candidate. `targets`
 * names each executed case's own target URL and served SHA, so its recorded runs say where it ran.
 */
export async function runOnboardingE2e(cases, { url, token, fixture, candidate = null, contract = null, policy, root = candidateRoot, launcher, fetcher, stepTimeoutMs, now = Date.now }) {
  const selected = cases.filter(entry => entry.definition.target === 'uat');
  const runId = candidate ? `rc-${candidate.id}` : `onboarding-${randomBytes(6).toString('hex')}`;
  const pending = contractPendingCases(contract, candidate?.pendingOutcomes);
  const pendingCases = policy.e2e.pendingOutcomes === 'blocking' ? [] : pending;
  const startedAt = new Date(now()).toISOString();
  const outcomes = [], served = new Set(), targets = [];
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
      // The step that creates an item on the fixture waits for its preview to settle, so each step there has the settling budget besides its own.
      const report = await runCases([entry], { url: target.url, token: target.token, environment: 'uat', runId, retries: releaseRetries, root, pendingCases: pending, policy, launcher,
        fetcher: target.settle ? settlingFetcher(fetcher ?? fetch, target) : fetcher, stepTimeoutMs: target.settle ? (stepTimeoutMs ?? defaultStepTimeoutMs) + previewSettleMs : stepTimeoutMs, now });
      served.add(report.sha);
      const known = targets.find(entry => entry.url === target.url && entry.sha === report.sha);
      if (known) known.cases.push(id); else targets.push({ url: target.url, sha: report.sha, cases: [id] });
      const outcome = report.cases[0];
      outcomes.push(outcome);
      if (outcome.verdict === 'failed' && required && !pendingCases.includes(id)) stoppedBy = id;
    }
  } finally { await open?.close(); }
  const sha = served.size === 1 ? [...served][0] : null;
  const tally = verdict => outcomes.filter(outcome => outcome.verdict === verdict).length;
  return { runId, url, environment: 'uat', sha, startedAt, finishedAt: new Date(now()).toISOString(),
    passed: tally('passed'), failed: tally('failed'), flaky: tally('flaky'), unrun: tally('unrun'), cases: outcomes, pendingOutcomes: policy.e2e.pendingOutcomes, targets };
}

/**
 * The report split into one report per executed target, each with that target's own `url` and
 * served `sha`, for `e2e record`, which records every run of a report at its `url`: a fixture case's
 * runs name the isolated plane it ran on, never the shared install. A fixture case whose fixture
 * could not be built ran nowhere, so no target records it; its failure still holds the candidate.
 */
export function recordingReports(report) {
  return (report.targets ?? []).map(({ url, sha, cases }) => {
    const { targets: _targets, ...rest } = report, outcomes = report.cases.filter(outcome => cases.includes(outcome.id));
    const tally = verdict => outcomes.filter(outcome => outcome.verdict === verdict).length;
    return { ...rest, url, sha, passed: tally('passed'), failed: tally('failed'), flaky: tally('flaky'), unrun: 0, cases: outcomes };
  });
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

/** The suite's fixture factory: the fixture built from the selected checkout `root`, whose HEAD must be CANDIDATE_SHA when set. */
export const suiteFixture = (env, root) => () => createOnboardingFixture({ root, sha: env.CANDIDATE_SHA || undefined, dashboard: true, host: env });

/**
 * The `e2e` suite of `release validate`, as runE2eSuite runs it (GRAPHYARD_UAT_URL, GRAPHYARD_UAT_TOKEN,
 * GRAPHYARD_CANDIDATE_ID, GRAPHYARD_E2E_REPORT, GRAPHYARD_SUITE_DETAIL), with the fixture cases on
 * the isolated fixture built from the same selected checkout as the cases, policy and contract.
 */
export async function main(env = process.env, root = env.GRAPHYARD_E2E_ROOT ?? process.cwd()) {
  const writeDetail = async text => { if (env.GRAPHYARD_SUITE_DETAIL) await writeFile(env.GRAPHYARD_SUITE_DETAIL, `${text}\n`); };
  try {
    const url = env.GRAPHYARD_UAT_URL, token = env.GRAPHYARD_UAT_TOKEN;
    if (!url || !token) throw new Error('The e2e suite needs GRAPHYARD_UAT_URL and GRAPHYARD_UAT_TOKEN');
    const contract = await checkoutContract(root), policy = checkoutRepositoryPolicy(root);
    const candidate = env.GRAPHYARD_CANDIDATE_ID ? { id: env.GRAPHYARD_CANDIDATE_ID, pendingOutcomes: candidatePendingOutcomes(root, env.GRAPHYARD_CANDIDATE_ID) } : null;
    const report = await runOnboardingE2e(await loadCases(root), { url, token, candidate, contract, policy, root,
      fixture: suiteFixture(env, root) });
    console.log(summarize(report));
    if (env.GRAPHYARD_E2E_REPORT) {
      await writeFile(env.GRAPHYARD_E2E_REPORT, `${JSON.stringify(report, null, 2)}\n`);
      // The reports the workflow records, one per target, beside the combined one release validate reads.
      for (const [index, part] of recordingReports(report).entries()) await writeFile(env.GRAPHYARD_E2E_REPORT.replace(/(\.json)?$/, `.target-${index + 1}.json`), `${JSON.stringify(part, null, 2)}\n`);
    }
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
