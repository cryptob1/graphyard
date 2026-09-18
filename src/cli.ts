import { readFile, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { supervise } from './supervisor.js';
import { inspectRunnerRepository, oracleBundleDigest, snapshotRunnerSources } from './runner-setup.js';
import { accountFileDigest, assertRunnerCredentialScope, attemptGrantSchema, authorityWatch, containerNames, executionRecordSchema, observeContainers, runnerPlanSchema } from './runner-executor.js';
import { assembleResult, collectArtifacts, collectionBinding, collectionInputs, collectorInputSchema, verifyExecutionAttestation } from './runner-collector.js';
import { superviseAttempt, supervisionRequestSchema } from './runner-attestor.js';
import { inheritedObligations } from './model.js';
import { assertRepository, availableRuntimes, discover } from './onboarding.js';
import { startGithubSetup } from './github-setup.js';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { z } from 'zod';
import { diagnose, fileConflicts, obligationLedger, proofPreview, resourceConflicts } from './coordination.js';
import { applyProposal, loadAppliedSetup, loadProposal, loadConnection, readSetupStatus, repositoryScanDifference, saveProposal, scanProposal, setupDrift, setupRepository, handoff, hostIdSchema } from './repository-setup.js';
import { assertMasterBinding, assessContainment, buildMasterStatus, continueMergeBatch, currentMergeCandidates, dispatchWork, inspectWorkerCredentials, listHerdrAgents, loadMasterConfig, masterHarness, mergeExecutor, observeHerdrAgents, readCredentialFile, readWorkerCredential, saveWorkerProfile, setupMaster, snapshotWithClock, startMaster, verifyContainmentDeath, workerProfileSchema } from './master.js';
import { daemonEffects, daemonSummary, readDaemonState, runDaemon } from './master-daemon.js';
import { bindReviewer, launchReview, readReviewLedger, reconcileReviews, reviewerCredentialDirectory, saveReviewerProfile, summarizeReviews, verifyReviewerInstallation } from './reviewer.js';
import { applyProtection, protectionPlan, readProtection } from './protection.js';
import { writeHarnessPermissions } from './harness.js';
import { acknowledgeContainment, containmentCredentials, establishContainment, isConfirmedCoordinationRefusal, revalidateContainment, settleContainment } from './quarantine.js';

try { process.loadEnvFile(); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
const [command, id, ...args] = process.argv.slice(2);
let connection: Awaited<ReturnType<typeof loadConnection>>;
// The host attestor never uses the repository's connection file. It has a Graphyard
// credential of its own — read-only, and named by an environment variable its own sudo
// rule sets — precisely so the identity that invokes it cannot choose which credential,
// or which server, it verifies attempt authority against.
if (command === 'master' || (command === 'runner' && id === 'supervise')) connection = null;
else try { connection = await loadConnection(process.cwd()); } catch { console.error('Invalid or insecure Graphyard connection file. Inspect local configuration; credential values are omitted.'); process.exit(1); }
const base = process.env.GRAPHYARD_URL ?? connection?.url ?? 'http://127.0.0.1:4310';
let savedToken: string | undefined;
try { if (connection && new URL(base).origin === connection.url) savedToken = connection.token; } catch { /* request validation reports an invalid URL */ }
let resolvedToken: string | undefined; let tokenResolved = false;
async function individualToken() {
  if (!tokenResolved) {
    resolvedToken = process.env.GRAPHYARD_TOKEN_FILE ? await readCredentialFile(resolve(process.env.GRAPHYARD_TOKEN_FILE)) : process.env.GRAPHYARD_TOKEN ?? savedToken;
    tokenResolved = true;
  }
  return resolvedToken;
}
const individualHostId = () => hostIdSchema.parse(process.env.GRAPHYARD_HOST_ID ?? connection?.hostId ?? hostname());
const cliPath = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
async function activeCliPath() {
  const selected = process.env.GRAPHYARD_CLI ?? cliPath;
  if (!selected.trim()) throw new Error('GRAPHYARD_CLI must name an existing launcher');
  try {
    const path = await realpath(resolve(selected));
    if (!(await stat(path)).isFile()) throw new Error();
    return path;
  } catch { throw new Error('The active Graphyard CLI launcher is unavailable; select an existing launcher'); }
}
async function api(path: string, data?: unknown, requestId = process.env.GRAPHYARD_REQUEST_ID ?? randomUUID()) {
  const token = await individualToken();
  if (!token) throw new Error('Set GRAPHYARD_TOKEN to your individual credential');
  const response = await fetch(`${base}/api/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': requestId }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(30_000) });
  const body = await response.json();
  if (!response.ok) { const error = new Error(JSON.stringify(body)); (error as any).confirmedRefusal = isConfirmedCoordinationRefusal(response.status, body); throw error; }
  return body;
}
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

/**
 * Hand one attempt to the operator's host attestor and wait for the record it signed.
 *
 * The runner writes the plan, acknowledges the attempt once the attestor reports a clean
 * preflight, and reads back the execution record and attestation. It observes nothing
 * about the run itself, so there is no execution fact here for it to author: a runner
 * that rewrote the record it forwards would only invalidate the signature over it.
 * Losing attempt authority terminates the attestor, which aborts and settles.
 */
function superviseThroughAttestor(supervisor: { command: string; args: string[] }, request: unknown, acknowledge: () => Promise<void>, signal: AbortSignal, timeoutMs: number) {
  return new Promise<{ record: unknown; attestation: unknown; collection: unknown }>((settled, refused) => {
    const child = spawn(supervisor.command, supervisor.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', diagnostics = '', done = false, acknowledged = false;
    const stop = () => child.kill('SIGTERM');
    const finish = (report: () => void) => { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', stop); report(); };
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { if (diagnostics.length < 4096) diagnostics += chunk; });
    child.stdout.on('data', chunk => {
      if (out.length > 16_777_216) return;
      out += chunk;
      const end = out.indexOf('\n');
      if (acknowledged || end === -1) return;
      acknowledged = true;
      let ready: any; try { ready = JSON.parse(out.slice(0, end)); } catch { /* reported below */ }
      out = out.slice(end + 1);
      if (ready?.preflight !== 'ready') { child.kill('SIGTERM'); finish(() => refused(new Error('The host attestor did not report a clean preflight; no container was started'))); return; }
      void acknowledge().then(() => child.stdin.end(`${JSON.stringify({ proceed: true })}\n`),
        (error: any) => { child.kill('SIGTERM'); finish(() => refused(error)); });
    });
    child.on('error', () => finish(() => refused(new Error(`The host attestor could not be started, so nothing was executed or acknowledged: ${supervisor.command}`))));
    child.on('close', code => finish(() => {
      const detail = diagnostics.trim() || `exit ${code}`;
      if (!acknowledged) return refused(new Error(`The execution boundary refused before acknowledgement; this attempt was never acknowledged and expires without holding protected resources: ${detail}`));
      try { settled(z.object({ record: executionRecordSchema, attestation: z.unknown(), collection: z.unknown() }).parse(JSON.parse(out))); }
      catch { refused(new Error(`The host attestor returned no signed execution record: ${detail}`)); }
    }));
    // The attestor may refuse and exit before reading the whole request; that is reported
    // through its exit, not as an unhandled pipe error here.
    child.stdin.on('error', () => {});
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}
const interactiveGithubSetup = (root: string) => async (repository: string, deployment: string) => {
  const setup = await startGithubSetup(root, repository, deployment);
  console.log(`Open ${setup.url} in your browser. On SSH, forward port 4311 to this machine first. Credentials stay in .graphyard/github-app.json; do not share that file. Setup finishes automatically once the App is installed; press Ctrl+C to finish later and rerun init --scan --apply.`);
  for (;;) {
    await new Promise(accept => setTimeout(accept, 1000));
    try {
      const app = JSON.parse(await readFile(resolve(root, '.graphyard/github-app.json'), 'utf8'));
      if (Number.isSafeInteger(app.appId) && app.appId > 0 && typeof app.slug === 'string' && app.slug && Number.isSafeInteger(app.installationId) && app.installationId > 0) {
        await new Promise<void>(accept => setup.http.close(() => accept()));
        return { appId: app.appId, slug: app.slug };
      }
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
};
async function main() {
  if (!command || command === 'help' || command === '--help') {
    console.log(`Graphyard 0.1 — distributed work, explicit proof

Environment: GRAPHYARD_URL, GRAPHYARD_TOKEN (individual role-scoped credential)
  init [--scan] [--apply] [--url URL] [--herdr] [--token-stdin]
                                Scan and propose the delivery workflow (--scan), or apply the reviewed proposal (--apply)
  master init --token-stdin [--herdr-workspace ID]
                                Install the recommended master-agent operating mode
  master start AGENT_KIND       Launch the dedicated visible Herdr master session
  master worker add FILE        Add an existing or launchable Herdr worker profile
  master reviewer setup [--name NAME]     Register the separate reviewer GitHub App in a
                                browser flow; NAME defaults to reviewer and must keep the
                                generated App name within GitHub's 34-character limit
  master reviewer bind FILE --key-stdin   Bind an existing reviewer App (IDs in FILE, PEM on stdin)
  master reviewer add FILE      Add a reviewer launch profile
  master review GY-N [PROFILE]  Launch the bound reviewer on the exact current candidate
  master protection [--apply]   Reconcile branch protection with every open review policy
  master harness [KIND] [--apply]  Generate the master's own harness permissions
  master status                 Join Graphyard work truth with Herdr session health
  master dispatch GY-N PROFILE  Invite a worker to claim ready work in a visible tab
  master settle-containment GY-N REASON
                                Settle a containment quarantine whose supervisor this
                                host verifies dead; unverifiable signals refuse
  master merge GY-N|--all       Merge exact authorized candidates without bypasses
  master run [--once] [--interval SECONDS]
                                Run the durable coordination loop as a supervised process
  master guide                  Print the complete master-agent operating guide
  doctor                       Inspect local discovery and live integration readiness
  github-setup HTTPS_URL [--reviewer NAME]
                                Register the control-plane or a reviewer GitHub App
                                through the local App-manifest browser flow
  status [GY-N]                Control-plane or work status
  diagnose GY-N                Explain blockers, overlap and required proof
  requirements GY-N file.json  Revise requirements with an audit reason (operator);
                                a criterion may carry "bootstrap": {reason, contractPaths}
                                to defer its proofs onto the named contract (operator with
                                policy:bootstrap). Deferred proofs are never dropped.
  obligations                  List every deferred bootstrap proof still owed and who inherits it
  list | next                  List all work / claimable work
  create path/to/work.json      Create work with acceptance criteria (operator)
  validation [ACTION file.json] List validation state or submit a protocol command
  delivery [ACTION file.json]  Show releases and observed delivery, or submit a
                                release/observation command (build|release|approve|
                                select|lease|observe|notify|sweep)
  delivery observations ENV [CURSOR]
                                Page through an environment's deployment observations
  runner inspect [DIRECTORY]   Discover Playwright inputs without executing repository code
  runner snapshot file.json    Snapshot an explicit source-file list for review (not approval)
  runner bundle-digest DIR      Content identity of an executable oracle bundle for approval
  runner account-digest FILE    Measure an approved test-account env file for registration
  runner attempt file.json      Hold one dispatched attempt while the host attestor runs it
  runner supervise              Host attestor: run one attempt and attest what it observed
  runner collect file.json      Verify one attempt and publish a trusted result (collector)
  scenarios                    List versioned E2E test-case definitions
  scenario file.json           Publish a scenario version (operator)
  ready GY-N REASON            Release backlog item with an audit reason (operator)
  unblock GY-N REASON           Clear a blocker with an audit reason (operator)
  rework GY-N --previous-worker-stopped REASON  Authorize reassignment (operator)
  recover-containment GY-N --previous-worker-stopped REASON
                                Release delivered work's stopped-worker quarantine (operator)
  rereview GY-N [EPOCH]         Request a fresh provider review (operator or current worker)
  reviewpolicy GY-N github|codex|agent POLICY_REVISION REASON [--profiles FILE]
                                Revise reviewer source; agent review reads its ordered
                                reviewer profiles from FILE (operator)
  operator-agent list          Inspect configured identities, scopes and redacted fingerprints (admin)
  operator-agent setup FILE --token-stdin  Create a scoped identity; FILE contains no secret (admin)
  operator-agent configure ID FILE          Revise capabilities/scope with expectedRevision (admin)
  operator-agent rotate ID SECONDS REASON --token-stdin  Rotate with a bounded overlap (admin)
  operator-agent revoke ID REASON            Revoke immediately and fail closed (admin)
  claim GY-N                   Acquire a two-minute lease; returns epoch
  handoff GY-N                 Show assigned workspace and supervisor command
  heartbeat GY-N EPOCH          Extend current lease
  release GY-N EPOCH            Release current lease
  worktree GY-N EPOCH [BASE]    Reserve and create a local isolated worktree
  register GY-N file.json       Register a Herdr/external workspace
  blocked GY-N EPOCH REASON     Set blocker; use '-' to clear
  complete GY-N EPOCH PR        Submit implementation; gates decide completion
  evidence GY-N file.json       Submit evidence (trust follows credential)
  watch GY-N EPOCH -- COMMAND   Run a worker, heartbeat, stop on lease loss
  events [GY-N]                Read immutable history

Use GRAPHYARD_REQUEST_ID to safely retry an identical command after a network timeout.
Never share an operator or producer credential with an implementation agent.`); return;
  }
  if (command === 'master') {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    if (id === 'guide') return console.log(await readFile(fileURLToPath(new URL('../docs/master-agent.md', import.meta.url)), 'utf8'));
    if (id === 'init') {
      const { values } = parseArgs({ args, options: { url: { type: 'string' }, 'token-stdin': { type: 'boolean' }, 'no-auto-merge': { type: 'boolean' }, 'merge-method': { type: 'string' }, 'cli-path': { type: 'string' }, 'host-id': { type: 'string' }, 'herdr-workspace': { type: 'string' }, interval: { type: 'string' }, 'proof-workflow': { type: 'string' }, 'deployment-url': { type: 'string' }, 'deployment-sha-field': { type: 'string' } }, allowPositionals: false });
      if (!values['token-stdin']) throw new Error('Use master init --token-stdin so the coordinator credential is not stored in shell history');
      let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 10_000) throw new Error('Token input is too large'); }
      const masterToken = input.trim(); if (!masterToken) throw new Error('Master coordinator credential is required; setup made no changes');
      const method = values['merge-method']; if (method && !['merge', 'squash', 'rebase'].includes(method)) throw new Error('Merge method must be merge, squash, or rebase');
      const run = { ...(values.interval ? { intervalSeconds: Number(values.interval) } : {}), ...(values['proof-workflow'] ? { proofWorkflow: values['proof-workflow'] } : {}), ...(values['deployment-url'] ? { deploymentUrl: values['deployment-url'] } : {}), ...(values['deployment-sha-field'] ? { deploymentShaField: values['deployment-sha-field'] } : {}) };
      return print(await setupMaster(root, { url: values.url ?? base, token: masterToken, cliPath: resolve(values['cli-path'] ?? await activeCliPath()), hostId: values['host-id'] ?? individualHostId(), herdrWorkspace: values['herdr-workspace'], ...(values['no-auto-merge'] ? { autoMerge: false } : {}), ...(method ? { mergeMethod: method as 'merge' | 'squash' | 'rebase' } : {}), ...(Object.keys(run).length ? { run } : {}) }));
    }
    const master = await loadMasterConfig(root);
    const masterToken = await readCredentialFile(master.credentialFile);
    const masterApi = async (path: string, credential = masterToken) => {
      const response = await fetch(`${master.url}/api/${path}`, { headers: { Authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(30_000) });
      const body = await response.json(); if (!response.ok) throw new Error(JSON.stringify(body)); return body;
    };
    const masterMutation = async (path: string, data: unknown, requestId: string = randomUUID()) => {
      const response = await fetch(`${master.url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${masterToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': requestId }, body: JSON.stringify(data), signal: AbortSignal.timeout(30_000) });
      const result = await response.json(); if (!response.ok) { const error = new Error(JSON.stringify(result)); (error as any).confirmedRefusal = response.status >= 400 && response.status < 500; throw error; } return result;
    };
    const coordinator = await masterApi('status'); assertMasterBinding(master, coordinator);
    if (id === 'start') {
      const kind = workerProfileSchema.shape.kind.safeParse(args[0]); if (!kind.success) throw new Error('Use master start with a supported agent kind such as codex or claude');
      const separator = args.indexOf('--'); const agentArgs = separator < 0 ? [] : args.slice(separator + 1);
      if (separator > 1 || separator < 0 && args.length > 1) throw new Error('Put agent-specific arguments after --');
      return print(await startMaster(root, kind.data, agentArgs, listHerdrAgents()));
    }
    if (id === 'worker' && args[0] === 'add' && args[1]) return print(await saveWorkerProfile(root, JSON.parse(await readFile(args[1], 'utf8')), credential => masterApi('status', credential)));
    if (id === 'reviewer') {
      if (args[0] === 'add' && args[1]) return print(await saveReviewerProfile(root, JSON.parse(await readFile(args[1], 'utf8'))));
      if (args[0] === 'bind' && args[1]) {
        const { values, positionals } = parseArgs({ args: args.slice(1), options: { 'key-stdin': { type: 'boolean' } }, allowPositionals: true });
        if (!values['key-stdin']) throw new Error('Use master reviewer bind FILE --key-stdin so the reviewer private key is not stored in shell history');
        let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 20_000) throw new Error('Reviewer key input is too large'); }
        const identity = JSON.parse(await readFile(positionals[0], 'utf8'));
        return print(await bindReviewer(root, { appId: Number(identity.appId), installationId: Number(identity.installationId), slug: String(identity.slug), privateKey: input.trim() }, verifyReviewerInstallation));
      }
      if (args[0] === 'setup') {
        const { values } = parseArgs({ args: args.slice(1), options: { deployment: { type: 'string' }, port: { type: 'string' }, name: { type: 'string' } }, allowPositionals: false });
        const deployment = values.deployment ?? master.url;
        if (!deployment.startsWith('https://')) throw new Error('Reviewer App registration needs the deployed HTTPS origin; pass --deployment https://YOUR-GRAPHYARD-HOST');
        const registrations = reviewerCredentialDirectory(master);
        await mkdir(registrations, { recursive: true, mode: 0o700 });
        const setup = await startGithubSetup(root, master.repository, deployment, Number(values.port ?? 4312), {
          file: resolve(registrations, `${master.repository.replace('/', '-')}-registration.json`),
          record: async app => { await bindReviewer(root, { appId: app.appId, installationId: app.installationId, slug: app.slug, privateKey: app.privateKey }, verifyReviewerInstallation); },
        }, values.name ?? 'reviewer');
        console.log(`Open ${setup.url} in your browser and register the reviewer App. It is a second App, separate from the Graphyard control-plane App, and it cannot write code. Credentials stay outside this repository with mode 0600. Press Ctrl+C when the page reports the installation is verified.`);
        const stop = () => setup.http.close(); process.once('SIGINT', stop); process.once('SIGTERM', stop); return;
      }
      throw new Error('Use master reviewer setup, master reviewer bind FILE --key-stdin, or master reviewer add FILE');
    }
    if (id === 'review') {
      if (!args[0]) throw new Error('Use master review GY-N [PROFILE]');
      const snapshot = await masterApi('work-snapshot');
      const work = snapshot.work.find((item: any) => item.id === args[0] || item.key === args[0]);
      if (!work) throw new Error(`Unknown work item ${args[0]}`);
      return print(await launchReview(root, work, args[1], listHerdrAgents(), snapshot.now));
    }
    if (id === 'protection') {
      const { values } = parseArgs({ args, options: { apply: { type: 'boolean' } }, allowPositionals: false });
      const snapshot = await masterApi('work-snapshot');
      if (values.apply) return print(await applyProtection(master, snapshot.work));
      return print({ ...protectionPlan(readProtection(master), master, snapshot.work), apply: false, next: 'Rerun with --apply to reconcile branch protection with these policies' });
    }
    if (id === 'harness') {
      const { values, positionals } = parseArgs({ args, options: { apply: { type: 'boolean' } }, allowPositionals: true });
      const kind = workerProfileSchema.shape.kind.safeParse(positionals[0] ?? 'claude');
      if (!kind.success) throw new Error('Use master harness with a supported agent kind such as claude or codex');
      return print(await writeHarnessPermissions(root, masterHarness(root, master, kind.data!), !!values.apply));
    }
    if (id === 'status') {
      const runtime = observeHerdrAgents();
      const credentials = await inspectWorkerCredentials(root, master.workers);
      let reviews = summarizeReviews((await readReviewLedger(root)).reviews), reviewRuntime = { available: true, reason: null as string | null };
      try { reviews = summarizeReviews((await reconcileReviews(root, master)).reviews); }
      catch (error) { reviewRuntime = { available: false, reason: `Reviewer verdicts could not be reconciled with GitHub: ${error instanceof Error ? error.message : 'unknown reason'}` }; }
      const { snapshot, clockOffset } = await snapshotWithClock(() => masterApi('work-snapshot'));
      const containment = assessContainment(snapshot.work, { hostId: master.hostId, observedAt: snapshot.now, clockOffset });
      const daemonState = await readDaemonState(root, master).catch(error => ({ error: error instanceof Error ? error.message : 'Master daemon state is unreadable' }));
      const daemon = 'error' in daemonState ? { running: false, error: daemonState.error } : daemonSummary(daemonState, Date.now(), master.run.intervalSeconds * 1000);
      return print({ ...buildMasterStatus(snapshot, master.workers, runtime.agents, credentials, containment, reviews), autoMerge: master.autoMerge, mergeApproval: master.autoMerge ? 'routine merges permitted after gates pass' : 'explicit operator approval required for each merge',
        reviewer: master.reviewer ? { identity: `${master.reviewer.slug}[bot]`, appId: master.reviewer.appId, profiles: master.reviewers.map(profile => profile.name) } : null,
        daemon, runtime: { herdr: { available: runtime.available, reason: runtime.reason }, reviews: reviewRuntime } });
    }
    if (id === 'settle-containment') {
      if (!args[0] || !args.slice(1).join(' ').trim()) throw new Error('Use master settle-containment GY-N REASON');
      const { snapshot, clockOffset } = await snapshotWithClock(() => masterApi('work-snapshot'));
      const work = snapshot.work.find((item: any) => item.id === args[0] || item.key === args[0]);
      if (!work) throw new Error(`Unknown work item ${args[0]}`);
      if (!work.containmentQuarantine) throw new Error(`${work.key} has no containment quarantine to settle`);
      const assessment = verifyContainmentDeath(work, { hostId: master.hostId, observedAt: snapshot.now, clockOffset });
      if (!assessment.settleable) {
        console.error(`Automatic containment settlement refused for ${work.key}:\n- ${assessment.refusals.join('\n- ')}\n${assessment.attestation}`);
        process.exitCode = 1; return;
      }
      const settled = await masterMutation(`work/${work.id}/autosettle`, { epoch: assessment.epoch, settlementHash: work.containmentQuarantine.settlementHash, reason: args.slice(1).join(' '), verification: assessment.verification });
      return print({ key: settled.key, epoch: assessment.epoch, containmentQuarantine: settled.containmentQuarantine, stage: settled.stage, verification: assessment.verification });
    }
    if (id === 'dispatch') {
      if (!args[0]) throw new Error('Use master dispatch GY-N PROFILE');
      const snapshot = await masterApi('work-snapshot');
      const work = snapshot.work.find((item: any) => item.id === args[0] || item.key === args[0]);
      const profile = master.workers.find(item => item.name === args[1]);
      if (!work) throw new Error(`Unknown work item ${args[0]}`); if (!profile) throw new Error(`Unknown worker profile ${args[1]}`);
      const conflicts = resourceConflicts(work, snapshot.work, Date.parse(snapshot.now)); if (conflicts.length) throw new Error(`Dispatch blocked by exclusive resources: ${conflicts.map((conflict: any) => `${conflict.resource} held by ${conflict.key}`).join(', ')}`);
      if (profile.credentialFile) {
        const workerStatus = await masterApi('status', await readWorkerCredential(root, profile.credentialFile));
        if (workerStatus.actor?.role !== 'worker' || workerStatus.actor.id !== profile.principal) throw new Error('Worker credential no longer matches the configured principal; update the profile before dispatch');
      }
      return print(await dispatchWork(root, work, profile, listHerdrAgents(), undefined, snapshot.work, undefined, undefined, undefined, snapshot.now));
    }
    if (id === 'merge') {
      if (!args[0]) throw new Error('Use master merge GY-N or master merge --all');
      const snapshot = await masterApi('work-snapshot');
      const selected = args[0] === '--all' ? currentMergeCandidates(snapshot.work, snapshot.now, coordinator.actor.id) : snapshot.work.filter((item: any) => item.id === args[0] || item.key === args[0]);
      if (!selected.length) throw new Error(args[0] === '--all' ? 'No work has a current all-gates-passing merge authorization' : `Unknown work item ${args[0]}`);
      const outerRequest = process.env.GRAPHYARD_REQUEST_ID ?? randomUUID();
      const mergeOne = mergeExecutor(master, () => masterApi('work-snapshot'), masterMutation, coordinator.actor.id, outerRequest);
      const results = args[0] === '--all' ? await continueMergeBatch(selected, mergeOne) : [await mergeOne(selected[0])];
      return print({ requestId: outerRequest, results });
    }
    if (id === 'run') {
      const { values } = parseArgs({ args, options: { once: { type: 'boolean' }, interval: { type: 'string' } }, allowPositionals: false });
      const intervalSeconds = values.interval ? Number(values.interval) : master.run.intervalSeconds;
      if (!Number.isInteger(intervalSeconds) || intervalSeconds < 5 || intervalSeconds > 900) throw new Error('Use master run --interval with whole seconds between 5 and 900');
      // A coordinator credential is the daemon's entire authority. Anything broader would let the
      // loop satisfy a gate it is supposed to be waiting on.
      if (coordinator.actor.role !== 'coordinator') throw new Error('The durable master loop requires a coordinator credential; operator, producer, and worker credentials are refused');
      if (coordinator.actor.proofs?.length) throw new Error('The durable master loop refuses a credential that is also allowed to produce evidence');
      const state = await readDaemonState(root, master);
      const effects = daemonEffects(root, master, { snapshot: () => masterApi('work-snapshot'), mutate: masterMutation, executionOwner: coordinator.actor.id });
      const result = await runDaemon(master, state, effects, { once: values.once, intervalMs: intervalSeconds * 1000, identity: { pid: process.pid, host: master.hostId } });
      return print({ repository: master.repository, coordinator: coordinator.actor.id, intervalSeconds, cycles: result.cycles.length, stopped: result.stopped ? 'signal' : 'completed', last: result.cycles.at(-1) ?? null });
    }
    throw new Error('Use master init, start, worker add, reviewer, review, protection, harness, status, dispatch, settle-containment, run, merge, or guide');
  }
  if (command === 'runner') {
    if (id === 'inspect' && args.length <= 1) return print(await inspectRunnerRepository(resolve(args[0] ?? '.')));
    if (id === 'snapshot' && args.length === 1) return print(await snapshotRunnerSources(process.cwd(), JSON.parse(await readFile(args[0], 'utf8'))));
    if (id === 'bundle-digest' && args.length === 1) return print(await oracleBundleDigest(resolve(args[0])));
    // What an operator registers as `testAccountDigest` on the runner registration. It is
    // read here only to be measured: the entries never leave this process, and approving
    // them is a separate operator action against Graphyard.
    if (id === 'account-digest' && args.length === 1) return print({ testAccountDigest: await accountFileDigest(resolve(args[0])) });
    if (id === 'attempt' && args.length === 1) {
      // Runner path. This credential is a worker registration: it can acknowledge and
      // hold attempt authority, but it neither executes nor authors any execution fact.
      const { registration, supervisor, ...plan } = runnerPlanSchema.parse(JSON.parse(await readFile(args[0], 'utf8')));
      assertRunnerCredentialScope(await api('status'));
      const dispatched = await api('validation/dispatch', { registration });
      if (!dispatched.request) return print({ dispatched: false, reason: dispatched.reason });
      const grant = attemptGrantSchema.parse({ requestId: dispatched.request.id, attemptId: dispatched.attempt.id, epoch: dispatched.attempt.epoch,
        runner: registration, bundleDigest: dispatched.bundle.digest, runnerImageDigest: dispatched.bundle.runnerImageDigest,
        executionHost: dispatched.executionAuthority.host, attestationPublicKey: dispatched.executionAuthority.attestationPublicKey,
        executionNetwork: dispatched.executionAuthority.network,
        // Never the runner's own configuration: which approved account material this
        // attempt may run with is operator-versioned authority like the target and network.
        testAccountDigest: dispatched.executionAuthority.testAccountDigest ?? null,
        targetUrl: dispatched.environment.url, deadline: dispatched.request.deadline });
      const attemptCommand = { requestId: grant.requestId, attemptId: grant.attemptId, epoch: grant.epoch };
      // A rejected heartbeat is the server saying this epoch may no longer act. The
      // container boundary fences the host, not the target, so the supervised execution
      // is aborted rather than left exercising the target until the request deadline.
      const authority = new AbortController();
      let beat = 0;
      const attemptAuthority = authorityWatch();
      let heartbeat: NodeJS.Timeout | undefined, authorityDeadline: NodeJS.Timeout | undefined;
      // Acknowledgement happens between the attestor's preflight and its first container.
      // Every local refusal therefore still precedes the ACK: an unacknowledged attempt
      // expires and releases its runner, environment and external reservations, while an
      // acknowledged one holds them until an operator settles it by hand.
      const acknowledge = async () => {
        await api('validation/ack', attemptCommand, `${grant.attemptId}-ack`);
        attemptAuthority.renewed();
        heartbeat = setInterval(() => { void api('validation/heartbeat', attemptCommand, `${grant.attemptId}-beat-${++beat}`)
          .then(() => attemptAuthority.renewed())
          .catch((error: unknown) => { attemptAuthority.failed(error); if (attemptAuthority.lost) authority.abort(); }); }, 20_000);
        authorityDeadline = setInterval(() => { if (attemptAuthority.lost) authority.abort(); }, 1_000);
      };
      try {
        const supervised = await superviseThroughAttestor(supervisor, { plan: { ...plan, grant } }, acknowledge, authority.signal, plan.timeoutMs * 2 + 120_000);
        return print({ dispatched: true, environment: { instance: dispatched.environment.instance, url: dispatched.environment.url },
          expected: { instance: dispatched.environment.instance, artifacts: dispatched.build.artifacts }, ...supervised });
      } finally { clearInterval(heartbeat); clearInterval(authorityDeadline); }
    }
    if (id === 'supervise' && args.length === 0) {
      // The operator-controlled host attestor. It runs under an OS identity the worker
      // cannot act as, owns the approved bytes and the signing key, and is reachable from
      // the runner only through this pipe. It signs the attempt it supervised itself; no
      // command anywhere signs an execution record that arrived from somewhere else.
      const keyFile = process.env.GRAPHYARD_ATTESTOR_KEY;
      if (!keyFile) throw new Error('The host attestor requires GRAPHYARD_ATTESTOR_KEY to name its Ed25519 private key; the signing key is never taken from the supervision request');
      const privateFile = async (path: string, subject: string) => {
        const info = await stat(path);
        if (!info.isFile() || info.mode & 0o077) throw new Error(`Host-attestor ${subject} must be a private regular file (mode 0600)`);
        if (info.uid !== (process.getuid?.() ?? -1)) throw new Error(`Host-attestor ${subject} must belong to the supervising identity`);
        return (await readFile(path, 'utf8'));
      };
      const key = await privateFile(keyFile, 'private key');
      // The attestor's own read-only credential and server. Both are named by environment
      // variables the attestor's sudo rule supplies, never by the supervision request: a
      // runner that could choose either would be choosing what "current authority" means.
      const authorityUrl = process.env.GRAPHYARD_ATTESTOR_URL, tokenFile = process.env.GRAPHYARD_ATTESTOR_TOKEN_FILE;
      if (!authorityUrl || !tokenFile) throw new Error('The host attestor requires GRAPHYARD_ATTESTOR_URL and GRAPHYARD_ATTESTOR_TOKEN_FILE; it verifies attempt authority against Graphyard itself rather than trusting the process that invoked it');
      const attestorToken = (await privateFile(tokenFile, 'Graphyard credential')).trim();
      if (!attestorToken) throw new Error('Host-attestor Graphyard credential file is empty');
      const authorityOrigin = new URL(authorityUrl).origin;
      /** What Graphyard currently holds for this attempt. Never what the caller says. */
      const readAttemptAuthority = async (requestId: string) => {
        const response = await fetch(`${authorityOrigin}/api/validation/attempt/${encodeURIComponent(requestId)}`,
          { headers: { Authorization: `Bearer ${attestorToken}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
        const body = await response.json();
        if (!response.ok) throw new Error(`Attempt authority could not be read independently, so no container was started: ${JSON.stringify(body)}`);
        return z.object({ grant: attemptGrantSchema, state: z.string().min(1).max(50), acknowledged: z.boolean(),
          expiresAt: z.iso.datetime(), now: z.iso.datetime() }).parse(body);
      };
      const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
      const nextLine = async () => { const { value, done } = await lines.next(); if (done) throw new Error('The supervision channel closed before the attempt could proceed'); return String(value); };
      const request = supervisionRequestSchema.parse(JSON.parse(await nextLine()));
      // Before anything is provisioned: the plan must carry exactly the authority Graphyard
      // dispatched. A schema-valid plan naming another target, network, bundle or image is
      // a fabrication regardless of who put it on the pipe.
      const dispatched = await readAttemptAuthority(request.plan.grant.requestId);
      if (!isDeepStrictEqual(dispatched.grant, request.plan.grant)) throw new Error('The supervision request does not carry the attempt authority Graphyard dispatched; nothing was provisioned');
      const authority = new AbortController();
      const abort = () => authority.abort();
      process.on('SIGTERM', abort); process.on('SIGINT', abort);
      // Preflight has passed and no container has started yet. The runner acknowledges
      // now; without its confirmation nothing is executed.
      const ready = async () => {
        process.stdout.write(`${JSON.stringify({ preflight: 'ready' })}\n`);
        if (JSON.parse(await nextLine())?.proceed !== true) throw new Error('The attempt was not acknowledged; no container was started');
        // The caller's `proceed` only says it has finished trying; it is a sequencing
        // signal and never the authority to execute. What starts containers is this
        // process's own re-read: the attempt must still be the current one, carry the same
        // authority, have been acknowledged by the runner under its own credential, and
        // hold an unexpired lease. `collecting` fails here too, so an attempt cannot start
        // a container after the collector has observed settlement.
        const current = await readAttemptAuthority(request.plan.grant.requestId);
        if (!isDeepStrictEqual(current.grant, request.plan.grant)) throw new Error('Attempt authority changed between preflight and execution; no container was started');
        if (current.state !== 'running' || !current.acknowledged) throw new Error(`Graphyard does not hold this attempt as acknowledged and executing (state ${current.state}); no container was started`);
        if (Date.parse(current.expiresAt) <= Date.parse(current.now)) throw new Error('The attempt lease has expired; no container was started');
      };
      // Under the documented `sudo` rule the runner's own identity is knowable, and the
      // container must not run as it: the output boundary is private to the container user.
      const callerUid = /^[0-9]{1,10}$/.test(process.env.SUDO_UID ?? '') ? Number(process.env.SUDO_UID) : undefined;
      try { process.stdout.write(`${JSON.stringify(await superviseAttempt(request, { privateKey: key, ready, signal: authority.signal, callerUid }))}\n`); return; }
      finally { process.off('SIGTERM', abort); process.off('SIGINT', abort); }
    }
    if (id === 'collect' && args.length === 1) {
      // Collector path. Separate credential, separate host: it re-reads the authority,
      // measures the target itself and never trusts candidate-authored JSON.
      const input = collectorInputSchema.parse(JSON.parse(await readFile(args[0], 'utf8')));
      const attemptCommand = { requestId: input.grant.requestId, attemptId: input.grant.attemptId, epoch: input.grant.epoch };
      let collectionBeat = 0, renewCollection: NodeJS.Timeout | undefined;
      const collectionAuthority = authorityWatch();
      try {
      // A local mistake must not spend the attempt's one collection transition. Taking
      // collection authority moves the live request to `collecting` and revokes the
      // runner's heartbeats, and neither can be undone: a configuration whose record does
      // not even bind to the grant and output path it was written with is refused here,
      // while the attempt can still be collected again from a corrected configuration.
      // This check is on caller-supplied values and so decides nothing; the binding that
      // matters is the one below, against the authority the collector re-read itself.
      const collectedFrom = await realpath(resolve(input.outputPath));
      const local = collectionBinding({ grant: input.grant, execution: input.record, collectedFrom });
      if (local.reasons.length) throw new Error(`Collection refused before taking collection authority: ${local.reasons.join('; ')}`);
      // Bind authority, record and boundary before anything is read or published: an
      // immutable artifact name published for the wrong bytes cannot be taken back.
      // Taking collection authority also revokes the runner's, so nothing this collector
      // observes — settlement above all — can be invalidated by a container started next.
      const grant = attemptGrantSchema.parse(await api('validation/collection-authority', attemptCommand));
      const binding = collectionBinding({ grant, execution: input.record, collectedFrom });
      if (binding.reasons.length) throw new Error(`Collection refused before reading the execution boundary: ${binding.reasons.join('; ')}`);
      await api('validation/collection-heartbeat', attemptCommand, `${input.grant.attemptId}-collection-beat-${++collectionBeat}`);
      collectionAuthority.renewed();
      // Renewed under exactly the rule the executing runner follows: a confirmed refusal
      // ends this collection for good, while one lost packet does not abandon the only
      // path that publishes this attempt's result.
      renewCollection = setInterval(() => { void api('validation/collection-heartbeat', attemptCommand, `${input.grant.attemptId}-collection-beat-${++collectionBeat}`)
        .then(() => collectionAuthority.renewed()).catch((error: unknown) => collectionAuthority.failed(error)); }, 20_000);
      // Settlement is the collector's own observation of the execution host, never the
      // runner's claim about itself.
      const settlementObservations = await observeContainers(containerNames(grant.attemptId), { dockerHost: grant.executionHost });
      // Read every approved kind the boundary holds, whatever this collector publishes:
      // behaviour cannot be verified from the execution report alone, and a kind left
      // unread would look like output the approved reporter never wrote. Only the upload
      // below is narrowed to the configured subset.
      const collected = await collectArtifacts(collectedFrom, collectionInputs(input.requiredArtifacts));
      // Verify the host attestation, and the digests of the bytes just read, *before* the
      // first upload. An artifact name is published once per attempt and cannot be taken
      // back: a live grant plus schema-valid forged boundary files would otherwise consume
      // the names this attempt's real evidence needs, and no later correct collection could
      // republish them. Unattested bytes are therefore never uploaded — but the attempt
      // still publishes its refusal below, because a blocked attempt is a visible state
      // rather than a collection that quietly disappears.
      const attested = verifyExecutionAttestation(grant, input.record, collected, input.executionAttestation);
      const publish = attested.reasons.length ? new Set<string>() : new Set(input.requiredArtifacts);
      const uploaded: { name: string; digest: string; url: string }[] = [];
      const failures: string[] = [];
      for (const artifact of collected.artifacts.filter(a => publish.has(a.name))) {
        if (collectionAuthority.lost) throw new Error('Collection authority could not be renewed; no artifact or result was published');
        try {
          const body = { requestId: grant.requestId, attemptId: grant.attemptId, epoch: grant.epoch,
            name: artifact.name, mediaType: artifact.mediaType, bytes: artifact.bytes.toString('base64'), capturePolicy: 'approved-test-data-only' };
          let stored: any, error: unknown;
          for (let retry = 0; retry < 3 && !stored; retry++) try { stored = await api('validation/artifacts', body, `${grant.attemptId}-artifact-${artifact.name}`); } catch (caught) { error = caught; }
          if (!stored) throw error;
          uploaded.push({ name: artifact.name, digest: stored.digest, url: stored.url });
        } catch { failures.push(`Private storage rejected required artifact ${artifact.name}`); }
      }
      const assembled = assembleResult({ grant, execution: input.record, collectedFrom, expected: input.expected, observations: input.observations,
        maxGapMs: input.maxGapMs, requiredArtifacts: input.requiredArtifacts, cancelled: input.cancelled, settlementObservations,
        collected: { artifacts: collected.artifacts, reasons: [...collected.reasons, ...failures] }, uploaded, executionAttestation: input.executionAttestation });
      if (!assembled.report) throw new Error(`Collection refused: ${assembled.refusals.join('; ')}`);
      if (collectionAuthority.lost) throw new Error('Collection authority could not be renewed; no result was published');
      return print({ refusals: assembled.refusals, report: assembled.report, result: await api('validation/result', assembled.report, `${grant.attemptId}-result`) });
      } finally { if (renewCollection) clearInterval(renewCollection); }
    }
    throw new Error('Use runner inspect|snapshot|bundle-digest|attempt|supervise|collect');
  }
  if (command === 'validation') {
    if (!id || id === 'requests') return print(await api('validation' + (args[0] ? `?cursor=${encodeURIComponent(args[0])}` : '')));
    if (id === 'artifact-upload' && args.length === 1) return print(await api('validation/artifacts', JSON.parse(await readFile(args[0], 'utf8'))));
    if (id === 'artifact-download' && args.length === 3) {
      const token = await individualToken(); if (!token) throw new Error('An individual Graphyard credential is required');
      const response = await fetch(`${base}/api/validation/artifacts/${encodeURIComponent(args[0])}/${encodeURIComponent(args[1])}`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Artifact download refused (${response.status})`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 8_388_608) throw new Error('Artifact exceeds the supported size limit');
      await writeFile(args[2], bytes, { flag: 'wx', mode: 0o600 });
      return print({ saved: args[2], bytes: bytes.length });
    }
    if (id === 'definitions') return print(await api('validation/definitions' + (args[0] ? `?cursor=${encodeURIComponent(args[0])}` : '')));
    if (id === 'show-candidate' && args[0]) return print(await api(`validation/candidate/${encodeURIComponent(args[0])}`));
    if (!['define','build','candidate','request','dispatch','ack','heartbeat','result','cancel','settle','retry'].includes(id) || !args[0]) throw new Error('Use validation ACTION file.json');
    return print(await api(`validation/${id}`, JSON.parse(await readFile(args[0], 'utf8'))));
  }
  if (command === 'delivery') {
    if (!id || id === 'status') return print(await api('delivery'));
    if (id === 'observations' && args[0]) return print(await api(`delivery/observations?environment=${encodeURIComponent(args[0])}${args[1] ? `&cursor=${encodeURIComponent(args[1])}` : ''}`));
    if (id === 'sweep') return print(await api('delivery/sweep', {}));
    if (!['build', 'release', 'approve', 'select', 'lease', 'observe', 'notify'].includes(id) || !args[0]) throw new Error('Use delivery [status] | delivery observations ENV [CURSOR] | delivery sweep | delivery ACTION file.json');
    return print(await api(`delivery/${id}`, JSON.parse(await readFile(args[0], 'utf8'))));
  }
  if (command === 'operator-agent') {
    if (!id || id === 'list') return print(await api('operator-agents'));
    if (id === 'setup') {
      if (!args[0] || args[1] !== '--token-stdin') throw new Error('Use operator-agent setup FILE --token-stdin');
      let secret = ''; for await (const chunk of process.stdin) { secret += chunk; if (secret.length > 10000) throw new Error('Token input is too large'); }
      secret = secret.trim(); if (!secret) throw new Error('Operator-agent credential is required; setup made no changes');
      return print(await api('operator-agents', { ...JSON.parse(await readFile(args[0], 'utf8')), token: secret }));
    }
    if (id === 'configure') {
      if (!args[0] || !args[1]) throw new Error('Use operator-agent configure ID FILE');
      return print(await api(`operator-agents/${encodeURIComponent(args[0])}/configure`, JSON.parse(await readFile(args[1], 'utf8'))));
    }
    if (id === 'rotate') {
      const marker = args.indexOf('--token-stdin'); if (!args[0] || marker < 0 || marker < 2) throw new Error('Use operator-agent rotate ID SECONDS REASON --token-stdin');
      let secret = ''; for await (const chunk of process.stdin) { secret += chunk; if (secret.length > 10000) throw new Error('Token input is too large'); }
      secret = secret.trim(); if (!secret) throw new Error('New operator-agent credential is required; rotation made no changes');
      return print(await api(`operator-agents/${encodeURIComponent(args[0])}/rotate`, { token: secret, transitionSeconds: Number(args[1]), reason: args.slice(2, marker).join(' ') }));
    }
    if (id === 'revoke') {
      if (!args[0]) throw new Error('Use operator-agent revoke ID REASON');
      return print(await api(`operator-agents/${encodeURIComponent(args[0])}/revoke`, { reason: args.slice(1).join(' ') }));
    }
    throw new Error('Use operator-agent list, setup, configure, rotate, or revoke');
  }
  if (command === 'init') {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const { values } = parseArgs({ args: process.argv.slice(3), options: { url: { type: 'string' }, herdr: { type: 'boolean' }, 'token-stdin': { type: 'boolean' }, 'host-id': { type: 'string' }, 'cli-path': { type: 'string' }, scan: { type: 'boolean' }, apply: { type: 'boolean' } }, allowPositionals: false });
    if (values.scan || values.apply) {
      if (values.herdr || values['token-stdin']) throw new Error('--scan/--apply propose and apply the delivery workflow; run them as the operator before any worker credential setup');
      const fresh = await scanProposal(root, { url: values.url ?? null, runtimes: availableRuntimes() });
      if (values.apply) {
        const stored = await loadProposal(root);
        if (!stored) throw new Error('No stored setup proposal to apply. Run init --scan, review .graphyard/setup-proposal.json, then rerun with --apply');
        const differences = repositoryScanDifference(fresh, stored.proposal);
        if (differences.length) throw new Error(`${differences.join('; ')}. Rerun init --scan, review the refreshed proposal, then apply it again. The stored proposal was left unchanged.`);
        const url = values.url ?? stored.proposal.server;
        if (!url) throw new Error('Applying requires the Graphyard server URL; pass --url');
        const result = await applyProposal(root, stored.proposal, { url, githubSetup: interactiveGithubSetup(root) });
        return print({ proposal: stored.file, ...result });
      }
      await saveProposal(root, fresh);
      const applied = await loadAppliedSetup(root);
      return print({ proposalFile: '.graphyard/setup-proposal.json', proposal: fresh,
        applied: applied ? { at: applied.appliedAt, githubApp: applied.artifacts.githubApp } : null,
        drift: setupDrift(applied, fresh),
        appliedNothingElse: true,
        next: 'Review .graphyard/setup-proposal.json, then rerun init --scan --apply --url SERVER_URL to apply the reviewed proposal' });
    }
    let workerToken = await individualToken();
    if (values['token-stdin']) {
      let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 10000) throw new Error('Token input is too large'); }
      workerToken = input.trim();
      if (!workerToken) throw new Error("--token-stdin requires a nonempty worker credential; setup has not changed local configuration");
    }
    if (workerToken !== undefined && !workerToken.trim()) throw new Error('Worker credential must be nonempty; setup has not changed local configuration');
    const selectedUrl = values.url ?? base;
    // Never silently send a saved credential to a newly selected server.
    if (values.url && connection && new URL(values.url).origin !== connection.url && !process.env.GRAPHYARD_TOKEN && !values['token-stdin']) workerToken = undefined;
    return print(await setupRepository(root, { url: selectedUrl, cliPath: resolve(values['cli-path'] ?? await activeCliPath()), hostId: values['host-id'] ?? individualHostId(), ...(workerToken ? { token: workerToken } : {}) }, { herdr: values.herdr }));
  }
  if (command === 'github-setup' || command === 'doctor') {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const discovered = await discover(root);
    if (command === 'github-setup') {
      if (!discovered.repository) throw new Error('Set origin to the GitHub repository being managed first');
      const { values } = parseArgs({ args, options: { reviewer: { type: 'string' } }, allowPositionals: false });
      const setup = await startGithubSetup(root, discovered.repository, id, 4311, {}, values.reviewer);
      console.log(`Open ${setup.url} in your browser. On SSH, forward port 4311 to this machine first. Credentials stay in ${setup.file}; do not share that file. Press Ctrl+C when finished.`);
      const stop = () => setup.http.close(); process.once('SIGINT', stop); process.once('SIGTERM', stop); return;
    }
    let live: any = null, failure: string | undefined;
    try { live = await api('status'); } catch (error: any) { failure = error.message; }
    return print({ discovered, server: base, cliPath: await activeCliPath(), hostId: individualHostId(), connected: !!live, githubConfigured: !!live?.github, role: live?.actor?.role, failure,
      setup: await readSetupStatus(root).catch((error: any) => ({ error: error.message })),
      next: !live ? 'Configure GRAPHYARD_URL and an individual token' : !live.github ? 'Complete github-setup and configure the server App credentials' : 'Submit a real PR and inspect every gate; configured is not proof of enforcement',
      limits: ['CI discovery is a proposal, not executed-test inventory', 'Herdr two-host recovery and GitHub refusal-to-acceptance must be demonstrated'] });
  }
  if (command === 'status' && !id) return print(await api('status'));
  if (command === 'obligations') return print(obligationLedger((await api('work-snapshot')).work));
  if (command === 'scenarios') return print(await api('scenarios'));
  if (command === 'scenario') return print(await api('scenarios', JSON.parse(await readFile(id, 'utf8'))));
  if (command === 'list' || command === 'next') {
    const snapshot = await api('work-snapshot'); const items = snapshot.work;
    return print(command === 'list' ? items : items.filter((w: any) => w.stage !== 'done' && w.ready && !w.blocker && !w.containmentQuarantine && (!w.submission || w.reworkRequested) && (!w.lease || Date.parse(w.lease.expiresAt) <= Date.parse(snapshot.now)) && !resourceConflicts(w, items, Date.parse(snapshot.now)).length && w.dependencies.every((d: string) => items.some((x: any) => x.id === d && x.stage === 'done'))).sort((a: any, b: any) => a.priority - b.priority));
  }
  if (command === 'create') return print(await api('work', JSON.parse(await readFile(id, 'utf8'))));
  if (command === 'diagnose') {
    const snapshot = await api('work-snapshot'); const item = snapshot.work.find((w: any) => w.id === id || w.key === id);
    if (!item) throw new Error(`Unknown work item ${id}`);
    return print({ key: item.key, observedAt: snapshot.now, diagnostics: diagnose(item, snapshot.work, Date.parse(snapshot.now), snapshot.jobs), overlaps: fileConflicts(item, snapshot.work), proofs: proofPreview(item, snapshot.work), obligations: inheritedObligations(item, snapshot.work) });
  }
  if (command === 'handoff') {
    const [snapshot, status] = await Promise.all([api('work-snapshot'), api('status')]);
    const work = snapshot.work.find((w: any) => w.id === id || w.key === id);
    if (!work) throw new Error(`Unknown work item ${id}`);
    return print(handoff(work, { ...status, now: snapshot.now }, individualHostId(), await activeCliPath()));
  }
  const items = await api('work'); const work = items.find((w: any) => w.id === id || w.key === id);
  if (command === 'events' && !id) return print(await api('events'));
  if (!work) throw new Error(`Unknown work item ${id}`);
  const mutate = (name: string, data: unknown) => api(`work/${work.id}/${name}`, data);
  if (command === 'status') return print(work);
  if (command === 'requirements') return print(await mutate(command, JSON.parse(await readFile(args[0], 'utf8'))));
  if (command === 'events') return print(await api(`events?work=${work.id}`));
  if (command === 'rereview') return print(await mutate(command, args[0] ? { epoch: Number(args[0]) } : {}));
  if (command === 'reviewpolicy') {
    const flag = args.indexOf('--profiles');
    const profilesFile = flag < 0 ? undefined : args[flag + 1];
    if (flag >= 0 && !profilesFile) throw new Error('Pass the reviewer profile file after --profiles');
    const positional = flag < 0 ? args : [...args.slice(0, flag), ...args.slice(flag + 2)];
    return print(await mutate(command, { provider: positional[0], expectedPolicyRevision: Number(positional[1]), reason: positional.slice(2).join(' '),
      ...(profilesFile ? { reviewerProfiles: JSON.parse(await readFile(profilesFile, 'utf8')) } : {}) }));
  }
  if (command === 'ready') return print(await mutate(command, args.length ? { expectedRevision: work.revision, reason: args.join(' ') } : {}));
  if (command === 'claim') return print(await mutate(command, {}));
  if (command === 'unblock') return print(await mutate('unblock', { expectedRevision: work.revision, reason: args.join(' ') }));
  if (command === 'rework') {
    if (args[0] !== '--previous-worker-stopped') throw new Error('Stop the previous worker first, then pass --previous-worker-stopped and an audit reason');
    return print(await mutate('rework', { reason: args.slice(1).join(' '), previousWorkerStopped: true }));
  }
  if (command === 'recover-containment') {
    if (args[0] !== '--previous-worker-stopped') throw new Error('Stop the previous worker first, then pass --previous-worker-stopped and an audit reason');
    return print(await mutate('recover', { reason: args.slice(1).join(' '), previousWorkerStopped: true }));
  }
  if (command === 'heartbeat' || command === 'release') return print(await mutate(command, { epoch: Number(args[0]) }));
  if (command === 'blocked') return print(await mutate('blocked', { epoch: Number(args[0]), reason: args[1] === '-' ? null : args.slice(1).join(' ') }));
  if (command === 'complete') return print(await mutate('submit', { epoch: Number(args[0]), pr: Number(args[1]) }));
  if (command === 'evidence' || command === 'register') return print(await mutate(command === 'register' ? 'workspace' : 'evidence', JSON.parse(await readFile(args[0], 'utf8'))));
  if (command === 'worktree') {
    const epoch = Number(args[0]); const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const status = await api('status');
    assertRepository((await discover(root)).repository, status.repository);
    const branch = work.submission ? work.workspaces.find((w: any) => w.epoch === work.submission.epoch)?.branch : `graphyard/${work.key.toLowerCase()}-${epoch}`;
    if (!branch) throw new Error('Submitted workspace branch is missing');
    const path = resolve(root, '.graphyard/worktrees', `${work.key}-${epoch}`);
    let startPoint = args[1] ?? 'HEAD';
    if (work.submission) {
      const remoteBranch = `refs/remotes/origin/${branch}`;
      execFileSync('git', ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:${remoteBranch}`], { stdio: ['ignore', 'ignore', 'inherit'] });
      const remoteSha = execFileSync('git', ['rev-parse', '--verify', remoteBranch], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
      if (!work.candidate?.sha || remoteSha !== work.candidate.sha) throw new Error('Submitted PR branch changed; wait for Graphyard to observe its current head before creating the rework workspace');
      startPoint = remoteBranch;
    }
    const hostId = individualHostId();
    await mutate('workspace', { epoch, host: hostId, path, branch });
    await mkdir(resolve(root, '.graphyard/worktrees'), { recursive: true });
    const exists = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
    try {
      if (work.submission && exists) {
        const records = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).split('\0\0');
        for (const record of records) {
          const fields = record.split('\0'); const priorPath = fields.find(field => field.startsWith('worktree '))?.slice(9);
          if (priorPath && fields.includes(`branch refs/heads/${branch}`)) execFileSync('git', ['-C', priorPath, 'checkout', '--detach', '--quiet'], { stdio: ['ignore', 'ignore', 'inherit'] });
        }
      }
      execFileSync('git', exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, startPoint], { stdio: ['ignore', 'ignore', 'inherit'] });
      if (work.submission) execFileSync('git', ['-C', path, 'reset', '--hard', startPoint], { stdio: ['ignore', 'ignore', 'inherit'] });
    }
    catch { throw new Error('Git worktree creation failed. Reservation remains for safety; inspect the event and repair locally. Do not reuse the branch for another task.'); }
    return print({ path, branch, epoch });
  }
  if (command === 'watch') {
    const epoch = Number(args[0]); const separator = args.indexOf('--');
    if (separator < 0 || !args[separator + 1]) throw new Error('Usage: watch GY-N EPOCH -- command args');
    const workspace = work.workspaces.find((w: any) => w.epoch === epoch);
    const hostId = individualHostId();
    if (!workspace || workspace.host !== hostId || await realpath(process.cwd()) !== await realpath(workspace.path)) throw new Error('Run watch from the assigned workspace on its registered host');
    const workerStatus = await api('status');
    if (workerStatus.actor?.role !== 'worker') throw new Error('watch requires a worker credential; never pass operator or producer credentials to implementation processes');
    const watchToken = await individualToken();
    process.env.GRAPHYARD_URL = base; process.env.GRAPHYARD_TOKEN = watchToken;
    process.env.GRAPHYARD_CLI = await activeCliPath(); process.env.GRAPHYARD_HOST_ID = hostId;
    const foreground = !!(process.env.HERDR_ENV === '1' && process.env.GRAPHYARD_HERDR_AGENT_KIND);
    // This random capability remains only in the supervisor process. It is never
    // placed in the child environment, request history, or quarantine document.
    const containment = foreground ? containmentCredentials() : null;
    const exclusiveResources = [...(work.exclusiveResources ?? [])];
    const settlementRequestId = foreground ? randomUUID() : '';
    const launchRequestId = foreground ? randomUUID() : '';
    process.exitCode = await supervise(args[separator + 1], args.slice(separator + 2), epoch,
      () => api(`work/${work.id}/heartbeat`, { epoch }, randomUUID()), {
        detached: !foreground,
        quarantine: foreground ? {
          establish: () => establishContainment(
            requestId => api(`work/${work.id}/quarantine`, { epoch, settlementHash: containment!.settlementHash }, requestId),
            { epoch, settlementHash: containment!.settlementHash, exclusiveResources, requestId: containment!.requestId },
          ),
          revalidate: async () => revalidateContainment(await api('work-snapshot'), {
            workId: work.id, principal: workerStatus.actor.id, epoch, settlementHash: containment!.settlementHash,
            exclusiveResources, workspace,
          }),
          acknowledge: () => acknowledgeContainment(
            requestId => api(`work/${work.id}/launch`, { epoch, settlementHash: containment!.settlementHash }, requestId),
            { principal: workerStatus.actor.id, epoch, settlementHash: containment!.settlementHash, exclusiveResources, requestId: launchRequestId },
          ),
          settle: () => settleContainment(
            (requestId, body) => api(`work/${work.id}/settle`, body, requestId),
            { epoch, settlementToken: containment!.settlementToken, settlementHash: containment!.settlementHash, exclusiveResources, requestId: settlementRequestId },
          ),
        } : undefined,
      });
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
