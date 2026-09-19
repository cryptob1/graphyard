import { readFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startGithubSetup } from '../github-setup.js';
import { resourceConflicts } from '../coordination.js';
import { assertMasterBinding, assessContainment, buildMasterStatus, continueMergeBatch, currentMergeCandidates, dispatchWork, inspectWorkerCredentials, listHerdrAgents, loadMasterConfig, masterHarness, mergeExecutor, observeHerdrAgents, readCredentialFile, readWorkerCredential, saveWorkerProfile, setupMaster, snapshotWithClock, startMaster, verifyContainmentDeath, workerProfileSchema } from '../master.js';
import { daemonEffects, daemonSummary, readDaemonState, runDaemon } from '../master-daemon.js';
import { verificationEffects, verifyDeployment } from '../master-verification.js';
import { bindReviewer, launchReview, readReviewLedger, reconcileReviews, reviewerCredentialDirectory, saveReviewerProfile, summarizeReviews, verifyReviewerInstallation } from '../reviewer.js';
import { applyProtection, protectionPlan, readProtection } from '../protection.js';
import { writeHarnessPermissions } from '../harness.js';
import { browserFlows, readAdministrationLedger, readSudoState, runBrowserFlow, summarizeAdministration, type BrowserFlow } from '../master-browser.js';
import { defineCommands } from './registry.js';
import { readSecretFromStdin } from './context.js';

/**
 * The master-agent operating mode. Every subcommand authenticates with the coordinator
 * credential the master keeps for itself, never with the repository connection file.
 */
export const masterCommands = defineCommands([
  {
    name: 'master',
    readsConnection: () => false,
    help: [
      '  master init --token-stdin [--herdr-workspace ID] [--browser-profile PROFILE]',
      '                                Install the recommended master-agent operating mode;',
      "                                PROFILE is the operator's Chrome profile the master",
      '                                administers GitHub through',
      '  master start AGENT_KIND       Launch the dedicated visible Herdr master session',
      '  master worker add FILE        Add an existing or launchable Herdr worker profile',
      '  master reviewer setup [--name NAME]     Register the separate reviewer GitHub App in a',
      '                                browser flow; NAME defaults to reviewer and must keep the',
      "                                generated App name within GitHub's 34-character limit",
      '  master reviewer bind FILE --key-stdin   Bind an existing reviewer App (IDs in FILE, PEM on stdin)',
      '  master reviewer add FILE      Add a reviewer launch profile',
      '  master review GY-N [PROFILE]  Launch the bound reviewer on the exact current candidate',
      '  master protection [--apply]   Reconcile branch protection with every open review policy',
      '  master browser FLOW [--dry-run]',
      "                                Perform GitHub administration through the operator's browser",
      '                                profile: app-permissions, installation-accept, or protection.',
      '                                Recorded with screenshots, verified via the API, audited',
      "  master harness [KIND] [--apply]  Generate the master's own harness permissions",
      '  master status                 Join Graphyard work truth with Herdr session health',
      '  master dispatch GY-N PROFILE  Invite a worker to claim ready work in a visible tab',
      '  master settle-containment GY-N REASON',
      '                                Settle a containment quarantine whose supervisor this',
      '                                host verifies dead; unverifiable signals refuse',
      '  master merge GY-N|--all       Merge exact authorized candidates without bypasses',
      '  master verify-deployment GY-N Verify that the deployed release serves a delivery and',
      '                                emits the current instructions; refuse stale or local-only',
      '                                observations, record the exact release observed',
      '  master run [--once] [--interval SECONDS]',
      '                                Run the durable coordination loop as a supervised process',
      '  master guide                  Print the complete master-agent operating guide',
    ],
    async run(context) {
      const { id, args, base, print } = context;
      const root = context.repositoryRoot();
      // The guide's first line is its docs-index entry, not part of the guide.
      if (id === 'guide') return console.log((await readFile(fileURLToPath(new URL('../../docs/master-agent.md', import.meta.url)), 'utf8')).replace(/^<!-- page:[^\n]*\n/, ''));
      if (id === 'init') {
        const { values } = parseArgs({ args, options: { url: { type: 'string' }, 'token-stdin': { type: 'boolean' }, 'no-auto-merge': { type: 'boolean' }, 'merge-method': { type: 'string' }, 'cli-path': { type: 'string' }, 'host-id': { type: 'string' }, 'herdr-workspace': { type: 'string' }, interval: { type: 'string' }, 'proof-workflow': { type: 'string' }, 'deployment-url': { type: 'string' }, 'deployment-sha-field': { type: 'string' }, 'smoke-workflow': { type: 'string' }, 'browser-profile': { type: 'string' }, 'browser-executable': { type: 'string' } }, allowPositionals: false });
        if (!values['token-stdin']) throw new Error('Use master init --token-stdin so the coordinator credential is not stored in shell history');
        const masterToken = await readSecretFromStdin(10_000); if (!masterToken) throw new Error('Master coordinator credential is required; setup made no changes');
        const method = values['merge-method']; if (method && !['merge', 'squash', 'rebase'].includes(method)) throw new Error('Merge method must be merge, squash, or rebase');
        const run = { ...(values.interval ? { intervalSeconds: Number(values.interval) } : {}), ...(values['proof-workflow'] ? { proofWorkflow: values['proof-workflow'] } : {}), ...(values['deployment-url'] ? { deploymentUrl: values['deployment-url'] } : {}), ...(values['deployment-sha-field'] ? { deploymentShaField: values['deployment-sha-field'] } : {}), ...(values['smoke-workflow'] ? { smokeWorkflow: values['smoke-workflow'] } : {}) };
        if (values['browser-executable'] && !values['browser-profile']) throw new Error('--browser-executable requires --browser-profile');
        const browser = values['browser-profile'] ? { profile: values['browser-profile'], ...(values['browser-executable'] ? { executable: values['browser-executable'] } : {}) } : undefined;
        return print(await setupMaster(root, { url: values.url ?? base, token: masterToken, cliPath: resolve(values['cli-path'] ?? await context.activeCliPath()), hostId: values['host-id'] ?? context.individualHostId(), herdrWorkspace: values['herdr-workspace'], ...(values['no-auto-merge'] ? { autoMerge: false } : {}), ...(method ? { mergeMethod: method as 'merge' | 'squash' | 'rebase' } : {}), ...(Object.keys(run).length ? { run } : {}), ...(browser ? { browser } : {}) }));
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
          const input = await readSecretFromStdin(20_000, 'Reviewer key input is too large');
          const identity = JSON.parse(await readFile(positionals[0], 'utf8'));
          return print(await bindReviewer(root, { appId: Number(identity.appId), installationId: Number(identity.installationId), slug: String(identity.slug), privateKey: input }, verifyReviewerInstallation));
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
      if (id === 'browser') {
        const { values, positionals } = parseArgs({ args, options: { 'dry-run': { type: 'boolean' } }, allowPositionals: true });
        const flow = positionals[0] as BrowserFlow | undefined;
        if (!flow || !browserFlows.includes(flow)) throw new Error(`Use master browser ${browserFlows.join('|')} [--dry-run]`);
        const snapshot = await masterApi('work-snapshot');
        const result = await runBrowserFlow(root, master, flow, { work: snapshot.work, coordinator: coordinator.actor.id, dryRun: !!values['dry-run'] });
        if (result.outcome === 'refused') process.exitCode = 1;
        return print(result);
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
        // Browser administration is reported beside the work it unblocks: a pending sudo code is
        // the one thing the operator must act on, and the recent ledger entries say who changed what.
        const administration = { browser: master.browser ? { profile: master.browser.profile } : null, ...summarizeAdministration((await readAdministrationLedger(root)).entries, await readSudoState(root)) };
        return print({ ...buildMasterStatus(snapshot, master.workers, runtime.agents, credentials, containment, reviews, master.baseBranch, coordinator), autoMerge: master.autoMerge, mergeApproval: master.autoMerge ? 'routine merges permitted after gates pass' : 'explicit operator approval required for each merge',
          reviewer: master.reviewer ? { identity: `${master.reviewer.slug}[bot]`, appId: master.reviewer.appId, profiles: master.reviewers.map(profile => profile.name) } : null,
          administration, daemon, runtime: { herdr: { available: runtime.available, reason: runtime.reason }, reviews: reviewRuntime } });
      }
      if (id === 'settle-containment') {
        if (!args[0] || !args.slice(1).join(' ').trim()) throw new Error('Use master settle-containment GY-N REASON');
        const { snapshot, clockOffset } = await snapshotWithClock(() => masterApi('work-snapshot'));
        const work = snapshot.work.find((item: any) => item.id === args[0] || item.key === args[0]);
        if (!work) throw new Error(`Unknown work item ${args[0]}`);
        if (!work.containmentQuarantine) throw new Error(`${work.key} has no containment quarantine to settle`);
        const assessment = verifyContainmentDeath(work, { hostId: master.hostId, observedAt: snapshot.now, clockOffset });
        if (!assessment.settleable) {
          // Every process still holding the fence is printed with its command line and working
          // directory: the master verifies whose it is before stopping anything.
          const held = assessment.verification?.held ?? [];
          const processes = held.length ? `\nProcesses holding the fence (verify before stopping anything):\n${held.map(entry => `- pid ${entry.pid}${entry.unit ? ` in ${entry.unit}` : ''}: cmdline "${entry.command}" cwd ${entry.cwd ?? '<unreadable>'}`).join('\n')}` : '';
          const recorded = assessment.scope ? `\nRecorded launch scope: ${assessment.scope.unit} (supervisor pid ${assessment.scope.pid}); systemd reports it ${assessment.verification?.recordedScope?.activeState ?? 'unqueried'}` : '\nThis quarantine recorded no launch scope; every live graphyard-watch scope is judged by its members';
          console.error(`Automatic containment settlement refused for ${work.key}:\n- ${assessment.refusals.join('\n- ')}${recorded}${processes}\n${assessment.attestation}`);
          process.exitCode = 1; return;
        }
        const settled = await masterMutation(`work/${work.id}/autosettle`, { epoch: assessment.epoch, settlementHash: work.containmentQuarantine.settlementHash, reason: args.slice(1).join(' '), verification: assessment.verification });
        return print({ key: settled.key, epoch: assessment.epoch, scope: assessment.scope, containmentQuarantine: settled.containmentQuarantine, stage: settled.stage, verification: assessment.verification });
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
      if (id === 'verify-deployment') {
        if (!args[0]) throw new Error('Use master verify-deployment GY-N');
        const snapshot = await masterApi('work-snapshot');
        const work = snapshot.work.find((item: any) => item.id === args[0] || item.key === args[0]);
        if (!work) throw new Error(`Unknown work item ${args[0]}`);
        const result = await verifyDeployment(work, verificationEffects(master, { snapshot: () => masterApi('work-snapshot'), mutate: masterMutation }));
        if (result.result === 'refused') process.exitCode = 1;
        return print(result);
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
      throw new Error('Use master init, start, worker add, reviewer, review, protection, browser, harness, status, dispatch, settle-containment, run, merge, verify-deployment, or guide');
    },
  },
]);
