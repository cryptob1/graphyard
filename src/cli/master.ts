import { readFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startGithubSetup } from '../github-setup.js';
import { resourceConflicts } from '../coordination.js';
import { agentToken, approvedMerges, assertMasterBinding, autonomySubcommands, continueMergeBatch, runAutonomyCommand, currentMergeCandidates, daemonExecutor, dispatchWork, listHerdrAgents, liveMasterConfig, loadMasterConfig, masterHarness, masterSettingsFromArgs, mergeExecutor, mergeProtocolSkew, producerCommand, readCredentialFile, readWorkerCredential, saveMasterSettings, saveWorkerProfile, setupMaster, snapshotWithClock, startMaster, verifyContainmentDeath, workerProfileSchema } from '../master.js';
import { cliCommit } from '../protocol-version.js';
import { daemonEffects, readDaemonState, runDaemon } from '../master-daemon.js';
import { verificationEffects, verifyDeployment } from '../master-verification.js';
import { bindReviewer, removeReviewerProfile, reviewCommand, reviewerCredentialDirectory, saveReviewerProfile, verifyReviewerInstallation } from '../reviewer.js';
import { dispatchEffects, dispatchReadTimeoutMs, readDispatchCursor, runAutoDispatch } from '../auto-dispatch.js';
import { applyProtection, protectionPlan, readProtection } from '../protection.js';
import { writeHarnessPermissions } from '../harness.js';
import { browserFlows, runBrowserFlow, type BrowserFlow } from '../master-browser.js';
import { defineCommands } from './registry.js';
import { approveScopeRequest, cycleBudget, masterStatusReport, sessionCommands } from './master-status.js';
import { coordinationViewHeader } from '../server/work-view.js';
import { readSecretFromStdin } from './context.js';

/** Every master subcommand authenticates with the coordinator credential the master keeps for itself, never the repository connection file. */
export const masterCommands = defineCommands([
  {
    name: 'master',
    readsConnection: () => false,
    help: [
      '  master init --token-stdin [--herdr-workspace ID] [--browser-profile PROFILE]',
      '              [--dispatch-interval SECONDS] [--reviewer-profile NAME] [--producer-timeout MINUTES]',
      '                                Install the recommended master-agent operating mode; PROFILE is',
      "                                the operator's Chrome profile the master administers GitHub",
      '  master start AGENT_KIND       Launch the dedicated visible Herdr master session',
      '  master worker add FILE        Add an existing or launchable Herdr worker profile',
      '  master reviewer setup [--name NAME]     Register the separate reviewer GitHub App; NAME',
      "                                defaults to reviewer, within GitHub's 34-character limit",
      '  master reviewer bind FILE --key-stdin   Bind an existing reviewer App (IDs in FILE, PEM on stdin)',
      '  master reviewer add FILE | remove NAME   Add or remove a reviewer launch profile',
      '  master producer add FILE | replace FILE | remove NAME  Manage proof-producer profiles',
      '  master review GY-N [PROFILE]  Launch the bound reviewer on the exact current candidate as the',
      '                                open request\'s next attempt; master run does this on its own,',
      '                                so it is the recovery path for a request nothing else answers',
      '  master protection [--apply]   Reconcile branch protection with every open review policy',
      '  master browser FLOW [--dry-run]',
      "                                Perform GitHub administration through the operator's browser",
      '                                profile: app-permissions, installation-accept, or protection;',
      '                                recorded, API-verified, audited',
      '  master harness [KIND] [--apply]  Generate the master\'s own harness permissions',
      '  master status                 Graphyard work truth joined with Herdr session health, the',
      '                                dispatch order, overlaps and merge conflicts',
      '  master dispatch GY-N PROFILE [--allow-overlap]',
      '                                Invite a worker to claim ready work in a visible tab; an',
      '                                item whose planned files overlap a claimed or unmerged item',
      '                                is held unless --allow-overlap is passed',
      '  master settle-containment GY-N REASON',
      '                                Settle a containment quarantine whose supervisor this host',
      '                                verifies dead; unverifiable signals refuse',
      '  master merge GY-N|--all       Merge exact authorized candidates without bypasses',
      '  master config FIELD=VALUE…   Tune owned run settings and profile accounts',
      '                                (accounts:PROFILE=a,b); autoMerge and credential paths stay operator-only',
      '  master verify-deployment GY-N Verify that the deployed release serves a delivery and',
      '                                emits the current instructions; refuse stale or local-only',
      '                                observations, record the exact release observed',
      '  master run [--once] [--interval SECONDS]',
      '                                Run the durable coordination loop as a supervised process; it',
      '                                launches the reviewer and proof producers for every submitted',
      '                                head within 30 seconds of the request, and decides every open',
      '                                worker scope request on the cycle it appears',
      '  master autonomy [--admin-token-stdin --apply]  Provision the master and approver identities',
      '  master create FILE|release GY-N|unblock GY-N|requirements GY-N FILE REASON  Own intent',
      '  master scope GY-N [REASON]    Approve a worker scope request the loop refused: add its',
      '                                requested paths to plannedFiles while the attempt keeps its',
      '                                lease. master run decides every request the item itself',
      '                                already implies, so this is the override for the rest',
      '  master decide GY-N ACTION [JSON|@FILE] REASON  Request a two-party decision',
      '  master withdraw GY-N DECISION REASON  Take back the master\'s own requested decision',
      '  master decisions GY-N | approver GY-N DECISION [KIND] | approve GY-N DECISION REASON',
      '  master principals [--apply]   Preview or apply a roster rotation keeping live principals',
      '  master restart                Restart this host\'s master loop detached',
      '  master environments [--create KIND,…] [--apply]  Agent accounts, quota, profiles',
      '  master guide                  Print the complete master-agent operating guide',
    ],
    async run(context) {
      const { id, args, base, print } = context;
      const root = context.repositoryRoot();
      // The guide's first line is its docs-index entry, not guide body.
      if (id === 'guide') return console.log((await readFile(fileURLToPath(new URL('../../docs/master-agent.md', import.meta.url)), 'utf8')).replace(/^<!-- page:[^\n]*\n/, ''));
      if (id === 'init') {
        const { values } = parseArgs({ args, options: { url: { type: 'string' }, 'token-stdin': { type: 'boolean' }, 'no-auto-merge': { type: 'boolean' }, 'merge-method': { type: 'string' }, 'cli-path': { type: 'string' }, 'host-id': { type: 'string' }, 'herdr-workspace': { type: 'string' }, interval: { type: 'string' }, 'proof-workflow': { type: 'string' }, 'deployment-url': { type: 'string' }, 'deployment-sha-field': { type: 'string' }, 'smoke-workflow': { type: 'string' }, 'dispatch-interval': { type: 'string' }, 'reviewer-profile': { type: 'string' }, 'producer-timeout': { type: 'string' }, 'browser-profile': { type: 'string' }, 'browser-executable': { type: 'string' } }, allowPositionals: false });
        if (!values['token-stdin']) throw new Error('Use master init --token-stdin so the coordinator credential is not stored in shell history');
        const masterToken = await readSecretFromStdin(10_000); if (!masterToken) throw new Error('Master coordinator credential is required; setup made no changes');
        const method = values['merge-method']; if (method && !['merge', 'squash', 'rebase'].includes(method)) throw new Error('Merge method must be merge, squash, or rebase');
        const run = { ...(values.interval ? { intervalSeconds: Number(values.interval) } : {}), ...(values['proof-workflow'] ? { proofWorkflow: values['proof-workflow'] } : {}), ...(values['deployment-url'] ? { deploymentUrl: values['deployment-url'] } : {}), ...(values['deployment-sha-field'] ? { deploymentShaField: values['deployment-sha-field'] } : {}), ...(values['smoke-workflow'] ? { smokeWorkflow: values['smoke-workflow'] } : {}),
          ...(values['dispatch-interval'] ? { dispatchIntervalSeconds: Number(values['dispatch-interval']) } : {}), ...(values['reviewer-profile'] ? { reviewerProfile: values['reviewer-profile'] } : {}), ...(values['producer-timeout'] ? { producerTimeoutMinutes: Number(values['producer-timeout']) } : {}) };
        if (values['browser-executable'] && !values['browser-profile']) throw new Error('--browser-executable requires --browser-profile');
        const browser = values['browser-profile'] ? { profile: values['browser-profile'], ...(values['browser-executable'] ? { executable: values['browser-executable'] } : {}) } : undefined;
        return print(await setupMaster(root, { url: values.url ?? base, token: masterToken, cliPath: resolve(values['cli-path'] ?? await context.activeCliPath()), hostId: values['host-id'] ?? context.individualHostId(), herdrWorkspace: values['herdr-workspace'], ...(values['no-auto-merge'] ? { autoMerge: false } : {}), ...(method ? { mergeMethod: method as 'merge' | 'squash' | 'rebase' } : {}), ...(Object.keys(run).length ? { run } : {}), ...(browser ? { browser } : {}) }));
      }
      const master = await loadMasterConfig(root);
      const masterToken = await readCredentialFile(master.credentialFile);
      const masterApi = async (path: string, credential = masterToken, timeoutMs = 30_000, headers: Record<string, string> = {}) => {
        const response = await fetch(`${master.url}/api/${path}`, { headers: { ...headers, Authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(timeoutMs) });
        const body = await response.json(); if (!response.ok) throw new Error(JSON.stringify(body)); return body;
      };
      const masterMutation = async (path: string, data: unknown, requestId: string = randomUUID(), credential: string = masterToken) => {
        const response = await fetch(`${master.url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': requestId }, body: JSON.stringify(data), signal: AbortSignal.timeout(30_000) });
        const result = await response.json(); if (!response.ok) { const error = new Error(JSON.stringify(result)); (error as any).confirmedRefusal = response.status >= 400 && response.status < 500; throw error; } return result;
      };
      const coordinator = await masterApi('status'); assertMasterBinding(master, coordinator);
      // The CLI's own commit, for the version-skew guard.
      const cli = { commit: cliCommit(fileURLToPath(new URL('../..', import.meta.url))) };
      const assertProtocol = (status: any) => { const skew = mergeProtocolSkew(status, cli); if (skew) throw new Error(skew); };
      if ((autonomySubcommands as readonly string[]).includes(id ?? '')) return print(await runAutonomyCommand(root, master, id!, args,
        { coordinator: masterApi, readSecret: () => readSecretFromStdin(10_000), agents: listHerdrAgents, daemonLock: async () => (await readDaemonState(root, master)).lock }));
      if (id === 'scope') return print(await approveScopeRequest(root, master, args, { coordinator: masterApi }));
      if (id === 'start') {
        const kind = workerProfileSchema.shape.kind.safeParse(args[0]); if (!kind.success) throw new Error('Use master start with a supported agent kind such as codex or claude');
        const separator = args.indexOf('--'); const agentArgs = separator < 0 ? [] : args.slice(separator + 1);
        if (separator > 1 || separator < 0 && args.length > 1) throw new Error('Put agent-specific arguments after --');
        return print(await startMaster(root, kind.data, agentArgs, listHerdrAgents()));
      }
      if (id === 'worker' && args[0] === 'add' && args[1]) return print(await saveWorkerProfile(root, JSON.parse(await readFile(args[1], 'utf8')), credential => masterApi('status', credential)));
      if (id === 'producer') return print(await producerCommand(root, args, credential => masterApi('status', credential)));
      if (id === 'config') return print(await saveMasterSettings(root, masterSettingsFromArgs(args)));
      if (id === 'reviewer') {
        if (args[0] === 'add' && args[1]) return print(await saveReviewerProfile(root, JSON.parse(await readFile(args[1], 'utf8'))));
        if (args[0] === 'remove' && args[1]) return print(await removeReviewerProfile(root, args[1]));
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
      if (id === 'review') return print(await reviewCommand(root, args, await masterApi('work-snapshot'), listHerdrAgents()));
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
        const report = await masterStatusReport(root, master, masterApi, coordinator, cli);
        const state = await readDaemonState(root, master).catch(() => null);
        return print({ ...report, daemon: { ...report.daemon, cycleBudget: state ? cycleBudget(state, master.run.intervalSeconds * 1000) : null } });
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
        const { values, positionals } = parseArgs({ args, options: { 'allow-overlap': { type: 'boolean' } }, allowPositionals: true });
        if (!positionals[0]) throw new Error('Use master dispatch GY-N PROFILE [--allow-overlap]');
        const snapshot = await masterApi('work-snapshot');
        const work = snapshot.work.find((item: any) => item.id === positionals[0] || item.key === positionals[0]);
        const profile = master.workers.find(item => item.name === positionals[1]);
        if (!work) throw new Error(`Unknown work item ${positionals[0]}`); if (!profile) throw new Error(`Unknown worker profile ${positionals[1]}`);
        const conflicts = resourceConflicts(work, snapshot.work, Date.parse(snapshot.now)); if (conflicts.length) throw new Error(`Dispatch blocked by exclusive resources: ${conflicts.map((conflict: any) => `${conflict.resource} held by ${conflict.key}`).join(', ')}`);
        if (profile.credentialFile) {
          const workerStatus = await masterApi('status', await readWorkerCredential(root, profile.credentialFile));
          if (workerStatus.actor?.role !== 'worker' || workerStatus.actor.id !== profile.principal) throw new Error('Worker credential no longer matches the configured principal; update the profile before dispatch');
        }
        return print(await dispatchWork(root, work, profile, listHerdrAgents(), undefined, snapshot.work, undefined, undefined, undefined, snapshot.now, { allowOverlap: !!values['allow-overlap'] }));
      }
      if (id === 'merge') {
        if (!args[0]) throw new Error('Use master merge GY-N or master merge --all');
        // Skew is refused before any candidate is read: an undeployed server is protocol skew, not a failed gate.
        assertProtocol(coordinator);
        const snapshot = await masterApi('work-snapshot');
        const selected = args[0] === '--all' ? currentMergeCandidates(snapshot.work, snapshot.now, coordinator.actor.id) : snapshot.work.filter((item: any) => item.id === args[0] || item.key === args[0]);
        if (!selected.length) throw new Error(args[0] === '--all' ? 'No work has a current all-gates-passing merge authorization' : `Unknown work item ${args[0]}`);
        if (!master.autoMerge) selected.splice(0, selected.length, ...await approvedMerges(selected, item => masterApi(`work/${item.id}/decisions`), args[0] !== '--all'));
        // One executor instance per request id (see MergeExecutor in master.ts).
        const outerRequest = process.env.GRAPHYARD_REQUEST_ID ?? randomUUID();
        const mergeOne = mergeExecutor(master, () => masterApi('work-snapshot'), masterMutation, { principal: coordinator.actor.id, instance: outerRequest }, outerRequest);
        const results = args[0] === '--all' ? await continueMergeBatch(selected, mergeOne) : [await mergeOne(selected[0])];
        return print({ requestId: outerRequest, results });
      }
      if (id === 'withdraw') {
        // Runs under the operator-agent identity that made the request; the server resolves GY-N.
        if (!args[0] || !args[1] || !args.slice(2).join(' ').trim()) throw new Error('Use master withdraw GY-N DECISION REASON');
        return print(await masterMutation(`work/${encodeURIComponent(args[0])}/decide`, { action: 'withdraw', decision: args[1], reason: args.slice(2).join(' ') }, randomUUID(), await agentToken(root, master, 'operatorAgent')));
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
        // A coordinator credential is the daemon's entire authority; anything broader could satisfy a gate the loop must wait on.
        if (coordinator.actor.role !== 'coordinator') throw new Error('The durable master loop requires a coordinator credential; operator, producer, and worker credentials are refused');
        if (coordinator.actor.proofs?.length) throw new Error('The durable master loop refuses a credential that is also allowed to produce evidence');
        assertProtocol(coordinator);
        const state = await readDaemonState(root, master);
        // The cycle and the dispatcher poll the bounded coordination view (by header, so an older
        // server answers with whole documents); the guarded merge re-reads the full documents.
        const live = liveMasterConfig(root, master), current = () => live.current, reload = () => live.reload();
        const coordinationSnapshot = (timeoutMs?: number) => masterApi('work-snapshot', masterToken, timeoutMs, { [coordinationViewHeader]: 'coordination' });
        const executor = daemonExecutor(coordinator.actor.id);
        const effects = daemonEffects(root, current, { snapshot: () => coordinationSnapshot(), mutate: masterMutation, executor });
        const guardedMerge: typeof effects.merge = work => mergeExecutor(current(), () => masterApi('work-snapshot'), masterMutation, executor, randomUUID())(work);
        // The loop outlives deployments: every guarded merge re-reads the server's protocol first.
        effects.merge = async work => { assertProtocol(await masterApi('status')); return guardedMerge(work); };
        // Automatic dispatch runs beside the cycle on a shorter cadence; it stops with the daemon.
        const dispatchCursor = await readDispatchCursor(root, master);
        const stopping = new AbortController();
        const daemonRun = runDaemon(master, state, effects, { once: values.once, intervalMs: values.interval ? intervalSeconds * 1000 : () => current().run.intervalSeconds * 1000, identity: { pid: process.pid, host: master.hostId }, reload }).finally(() => stopping.abort());
        const dispatchRun = runAutoDispatch(master, dispatchCursor, dispatchEffects(root, current, { snapshot: () => coordinationSnapshot(dispatchReadTimeoutMs) }), { once: values.once, intervalMs: () => current().run.dispatchIntervalSeconds * 1000, signal: stopping.signal, reload });
        const [result, dispatched] = await Promise.all([daemonRun, dispatchRun]);
        return print({ repository: master.repository, coordinator: coordinator.actor.id, intervalSeconds, dispatchIntervalSeconds: master.run.dispatchIntervalSeconds, cycles: result.cycles.length, stopped: result.stopped ? 'signal' : 'completed', last: result.cycles.at(-1) ?? null,
          dispatch: { ticks: dispatched.ticks.length, launched: dispatched.ticks.reduce((total, tick) => total + tick.launched.length, 0), refused: dispatched.ticks.reduce((total, tick) => total + tick.refused.length, 0), last: dispatched.ticks.at(-1) ?? null } });
      }
      throw new Error(`There is no master ${id}; use master guide for the subcommands`);
    },
  },
  ...sessionCommands,
]);

export { cycleBudget };
