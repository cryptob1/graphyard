import { readFile, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { supervise } from './supervisor.js';
import { inspectRunnerRepository, snapshotRunnerSources } from './runner-setup.js';
import { assertRepository, discover } from './onboarding.js';
import { startGithubSetup } from './github-setup.js';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { diagnose, fileConflicts, proofPreview, resourceConflicts } from './coordination.js';
import { loadConnection, setupRepository, handoff, hostIdSchema } from './repository-setup.js';
import { assertMasterBinding, buildMasterStatus, continueMergeBatch, currentMergeCandidates, dispatchWork, inspectWorkerCredentials, listHerdrAgents, loadMasterConfig, mergeExecutor, observeHerdrAgents, readCredentialFile, readWorkerCredential, saveWorkerProfile, setupMaster, startMaster, workerProfileSchema } from './master.js';
import { daemonEffects, daemonSummary, readDaemonState, runDaemon } from './master-daemon.js';
import { acknowledgeContainment, containmentCredentials, establishContainment, isConfirmedCoordinationRefusal, revalidateContainment, settleContainment } from './quarantine.js';

try { process.loadEnvFile(); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
const [command, id, ...args] = process.argv.slice(2);
let connection: Awaited<ReturnType<typeof loadConnection>>;
if (command === 'master') connection = null;
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
async function main() {
  if (!command || command === 'help' || command === '--help') {
    console.log(`Graphyard 0.1 — distributed work, explicit proof

Environment: GRAPHYARD_URL, GRAPHYARD_TOKEN (individual role-scoped credential)
  init [--url URL] [--herdr] [--token-stdin]  Configure repository instructions and Herdr
  master init --token-stdin [--herdr-workspace ID]
                                Install the recommended master-agent operating mode
  master start AGENT_KIND       Launch the dedicated visible Herdr master session
  master worker add FILE        Add an existing or launchable Herdr worker profile
  master status                 Join Graphyard work truth with Herdr session health
  master dispatch GY-N PROFILE  Invite a worker to claim ready work in a visible tab
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
  requirements GY-N file.json  Revise requirements with an audit reason (operator)
  list | next                  List all work / claimable work
  create path/to/work.json      Create work with acceptance criteria (operator)
  validation [ACTION file.json] List validation state or submit a protocol command
  runner inspect [DIRECTORY]   Discover Playwright inputs without executing repository code
  runner snapshot file.json    Snapshot an explicit source-file list for review (not approval)
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
    if (id === 'status') {
      const runtime = observeHerdrAgents();
      const credentials = await inspectWorkerCredentials(root, master.workers);
      const daemonState = await readDaemonState(root, master).catch(error => ({ error: error instanceof Error ? error.message : 'Master daemon state is unreadable' }));
      const daemon = 'error' in daemonState ? { running: false, error: daemonState.error } : daemonSummary(daemonState, Date.now(), master.run.intervalSeconds * 1000);
      return print({ ...buildMasterStatus(await masterApi('work-snapshot'), master.workers, runtime.agents, credentials), autoMerge: master.autoMerge, mergeApproval: master.autoMerge ? 'routine merges permitted after gates pass' : 'explicit operator approval required for each merge', daemon, runtime: { herdr: { available: runtime.available, reason: runtime.reason } } });
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
    throw new Error('Use master init, start, worker add, status, dispatch, run, merge, or guide');
  }
  if (command === 'runner') {
    if (id === 'inspect' && args.length <= 1) return print(await inspectRunnerRepository(resolve(args[0] ?? '.')));
    if (id === 'snapshot' && args.length === 1) return print(await snapshotRunnerSources(process.cwd(), JSON.parse(await readFile(args[0], 'utf8'))));
    throw new Error('Use runner inspect [DIRECTORY] or runner snapshot file.json');
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
    const { values } = parseArgs({ args: process.argv.slice(3), options: { url: { type: 'string' }, herdr: { type: 'boolean' }, 'token-stdin': { type: 'boolean' }, 'host-id': { type: 'string' }, 'cli-path': { type: 'string' } }, allowPositionals: false });
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
      next: !live ? 'Configure GRAPHYARD_URL and an individual token' : !live.github ? 'Complete github-setup and configure the server App credentials' : 'Submit a real PR and inspect every gate; configured is not proof of enforcement',
      limits: ['CI discovery is a proposal, not executed-test inventory', 'Herdr two-host recovery and GitHub refusal-to-acceptance must be demonstrated'] });
  }
  if (command === 'status' && !id) return print(await api('status'));
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
    return print({ key: item.key, observedAt: snapshot.now, diagnostics: diagnose(item, snapshot.work, Date.parse(snapshot.now), snapshot.jobs), overlaps: fileConflicts(item, snapshot.work), proofs: proofPreview(item) });
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
