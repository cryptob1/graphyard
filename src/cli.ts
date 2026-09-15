import { readFile, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
import { assertMasterBinding, buildMasterStatus, dispatchWork, listHerdrAgents, loadMasterConfig, mergeWork, observeHerdrAgents, readCredentialFile, saveWorkerProfile, setupMaster, startMaster, workerProfileSchema } from './master.js';

try { process.loadEnvFile(); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
const [command, id, ...args] = process.argv.slice(2);
let connection: Awaited<ReturnType<typeof loadConnection>>;
try { connection = await loadConnection(process.cwd()); } catch { console.error('Invalid or insecure Graphyard connection file. Inspect local configuration; credential values are omitted.'); process.exit(1); }
const base = process.env.GRAPHYARD_URL ?? connection?.url ?? 'http://127.0.0.1:4310';
let savedToken: string | undefined;
try { if (connection && new URL(base).origin === connection.url) savedToken = connection.token; } catch { /* request validation reports an invalid URL */ }
const token = process.env.GRAPHYARD_TOKEN_FILE ? await readCredentialFile(resolve(process.env.GRAPHYARD_TOKEN_FILE)) : process.env.GRAPHYARD_TOKEN ?? savedToken;
const hostId = hostIdSchema.parse(process.env.GRAPHYARD_HOST_ID ?? connection?.hostId ?? hostname());
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
  if (!token) throw new Error('Set GRAPHYARD_TOKEN to your individual credential');
  const response = await fetch(`${base}/api/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': requestId }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(30_000) });
  const body = await response.json(); if (!response.ok) throw new Error(JSON.stringify(body)); return body;
}
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
async function main() {
  if (!command || command === 'help' || command === '--help') {
    console.log(`Graphyard 0.1 — distributed work, explicit proof

Environment: GRAPHYARD_URL, GRAPHYARD_TOKEN (individual role-scoped credential)
  init [--url URL] [--herdr] [--token-stdin]  Configure repository instructions and Herdr
  master init --token-stdin     Install the recommended master-agent operating mode
  master start AGENT_KIND       Launch the dedicated visible Herdr master session
  master worker add FILE        Add an existing or launchable Herdr worker profile
  master status                 Join Graphyard work truth with Herdr session health
  master dispatch GY-N PROFILE  Invite a worker to claim ready work in a visible tab
  master merge GY-N|--all       Merge exact authorized candidates without bypasses
  master guide                  Print the complete master-agent operating guide
  doctor                       Inspect local discovery and live integration readiness
  github-setup HTTPS_URL        Register a GitHub App through a local browser flow
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
  ready GY-N                   Release backlog item (operator)
  unblock GY-N REASON           Clear a blocker with an audit reason (operator)
  rework GY-N --previous-worker-stopped REASON  Authorize reassignment (operator)
  rereview GY-N [EPOCH]         Request a fresh Codex review (operator or current worker)
  reviewpolicy GY-N github|codex POLICY_REVISION REASON  Revise reviewer source (operator)
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
      const { values } = parseArgs({ args, options: { url: { type: 'string' }, 'token-stdin': { type: 'boolean' }, 'no-auto-merge': { type: 'boolean' }, 'merge-method': { type: 'string' }, 'cli-path': { type: 'string' }, 'host-id': { type: 'string' } }, allowPositionals: false });
      if (!values['token-stdin']) throw new Error('Use master init --token-stdin so the coordinator credential is not stored in shell history');
      let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 10_000) throw new Error('Token input is too large'); }
      const masterToken = input.trim(); if (!masterToken) throw new Error('Master coordinator credential is required; setup made no changes');
      const method = values['merge-method']; if (method && !['merge', 'squash', 'rebase'].includes(method)) throw new Error('Merge method must be merge, squash, or rebase');
      return print(await setupMaster(root, { url: values.url ?? base, token: masterToken, cliPath: resolve(values['cli-path'] ?? await activeCliPath()), hostId: values['host-id'] ?? hostId, ...(values['no-auto-merge'] ? { autoMerge: false } : {}), ...(method ? { mergeMethod: method as 'merge' | 'squash' | 'rebase' } : {}) }));
    }
    const master = await loadMasterConfig(root);
    const masterToken = await readCredentialFile(master.credentialFile);
    const masterApi = async (path: string, credential = masterToken) => {
      const response = await fetch(`${master.url}/api/${path}`, { headers: { Authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(30_000) });
      const body = await response.json(); if (!response.ok) throw new Error(JSON.stringify(body)); return body;
    };
    const masterMutation = async (path: string, data: unknown) => {
      const response = await fetch(`${master.url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${masterToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(data), signal: AbortSignal.timeout(30_000) });
      const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
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
      return print({ ...buildMasterStatus(await masterApi('work-snapshot'), master.workers, runtime.agents), runtime: { herdr: { available: runtime.available, reason: runtime.reason } } });
    }
    if (id === 'dispatch') {
      if (!args[0]) throw new Error('Use master dispatch GY-N PROFILE');
      const snapshot = await masterApi('work-snapshot');
      const work = snapshot.work.find((item: any) => item.id === args[0] || item.key === args[0]);
      const profile = master.workers.find(item => item.name === args[1]);
      if (!work) throw new Error(`Unknown work item ${args[0]}`); if (!profile) throw new Error(`Unknown worker profile ${args[1]}`);
      const conflicts = resourceConflicts(work, snapshot.work, Date.parse(snapshot.now)); if (conflicts.length) throw new Error(`Dispatch blocked by exclusive resources: ${conflicts.map((conflict: any) => `${conflict.resource} held by ${conflict.key}`).join(', ')}`);
      if (profile.credentialFile) {
        const workerStatus = await masterApi('status', await readCredentialFile(profile.credentialFile));
        if (workerStatus.actor?.role !== 'worker' || workerStatus.actor.id !== profile.principal) throw new Error('Worker credential no longer matches the configured principal; update the profile before dispatch');
      }
      return print(await dispatchWork(root, work, profile, listHerdrAgents(), undefined, snapshot.work));
    }
    if (id === 'merge') {
      if (!args[0]) throw new Error('Use master merge GY-N or master merge --all');
      const snapshot = await masterApi('work-snapshot');
      const selected = args[0] === '--all' ? snapshot.work.filter((item: any) => item.stage === 'merge') : snapshot.work.filter((item: any) => item.id === args[0] || item.key === args[0]);
      if (!selected.length) throw new Error(args[0] === '--all' ? 'No work is at the merge gate' : `Unknown work item ${args[0]}`);
      const results = []; for (const item of selected) results.push(await mergeWork(master, item, () => masterApi('work-snapshot'),
        (latest, authorization) => masterMutation(`work/${latest.id}/merge-acquire`, { expectedRevision: authorization.revision, sha: authorization.sha, baseSha: authorization.baseSha, policyRevision: authorization.policyRevision }),
        (latest, execution, reason) => masterMutation(`work/${latest.id}/merge-cancel`, { executionId: execution.id, reason })));
      return print(results);
    }
    throw new Error('Use master init, start, worker add, status, dispatch, merge, or guide');
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
      if (!token) throw new Error('An individual Graphyard credential is required');
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
  if (command === 'init') {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const { values } = parseArgs({ args: process.argv.slice(3), options: { url: { type: 'string' }, herdr: { type: 'boolean' }, 'token-stdin': { type: 'boolean' }, 'host-id': { type: 'string' }, 'cli-path': { type: 'string' } }, allowPositionals: false });
    let workerToken = token;
    if (values['token-stdin']) {
      let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 10000) throw new Error('Token input is too large'); }
      workerToken = input.trim();
      if (!workerToken) throw new Error("--token-stdin requires a nonempty worker credential; setup has not changed local configuration");
    }
    if (workerToken !== undefined && !workerToken.trim()) throw new Error('Worker credential must be nonempty; setup has not changed local configuration');
    const selectedUrl = values.url ?? base;
    // Never silently send a saved credential to a newly selected server.
    if (values.url && connection && new URL(values.url).origin !== connection.url && !process.env.GRAPHYARD_TOKEN && !values['token-stdin']) workerToken = undefined;
    return print(await setupRepository(root, { url: selectedUrl, cliPath: resolve(values['cli-path'] ?? await activeCliPath()), hostId: values['host-id'] ?? hostId, ...(workerToken ? { token: workerToken } : {}) }, { herdr: values.herdr }));
  }
  if (command === 'github-setup' || command === 'doctor') {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const discovered = await discover(root);
    if (command === 'github-setup') {
      if (!discovered.repository) throw new Error('Set origin to the GitHub repository being managed first');
      const setup = await startGithubSetup(root, discovered.repository, id);
      console.log(`Open ${setup.url} in your browser. On SSH, forward port 4311 to this machine first. Credentials stay in .graphyard/github-app.json; do not share that file. Press Ctrl+C when finished.`);
      const stop = () => setup.http.close(); process.once('SIGINT', stop); process.once('SIGTERM', stop); return;
    }
    let live: any = null, failure: string | undefined;
    try { live = await api('status'); } catch (error: any) { failure = error.message; }
    return print({ discovered, server: base, cliPath: await activeCliPath(), hostId, connected: !!live, githubConfigured: !!live?.github, role: live?.actor?.role, failure,
      next: !live ? 'Configure GRAPHYARD_URL and an individual token' : !live.github ? 'Complete github-setup and configure the server App credentials' : 'Submit a real PR and inspect every gate; configured is not proof of enforcement',
      limits: ['CI discovery is a proposal, not executed-test inventory', 'Herdr two-host recovery and GitHub refusal-to-acceptance must be demonstrated'] });
  }
  if (command === 'status' && !id) return print(await api('status'));
  if (command === 'scenarios') return print(await api('scenarios'));
  if (command === 'scenario') return print(await api('scenarios', JSON.parse(await readFile(id, 'utf8'))));
  if (command === 'list' || command === 'next') {
    const snapshot = await api('work-snapshot'); const items = snapshot.work;
    return print(command === 'list' ? items : items.filter((w: any) => w.stage !== 'done' && w.ready && !w.blocker && (!w.submission || w.reworkRequested) && (!w.lease || Date.parse(w.lease.expiresAt) <= Date.parse(snapshot.now)) && !resourceConflicts(w, items, Date.parse(snapshot.now)).length && w.dependencies.every((d: string) => items.some((x: any) => x.id === d && x.stage === 'done'))).sort((a: any, b: any) => a.priority - b.priority));
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
    return print(handoff(work, { ...status, now: snapshot.now }, hostId, await activeCliPath()));
  }
  const items = await api('work'); const work = items.find((w: any) => w.id === id || w.key === id);
  if (command === 'events' && !id) return print(await api('events'));
  if (!work) throw new Error(`Unknown work item ${id}`);
  const mutate = (name: string, data: unknown) => api(`work/${work.id}/${name}`, data);
  if (command === 'status') return print(work);
  if (command === 'requirements') return print(await mutate(command, JSON.parse(await readFile(args[0], 'utf8'))));
  if (command === 'events') return print(await api(`events?work=${work.id}`));
  if (command === 'rereview') return print(await mutate(command, args[0] ? { epoch: Number(args[0]) } : {}));
  if (command === 'reviewpolicy') return print(await mutate(command, { provider: args[0], expectedPolicyRevision: Number(args[1]), reason: args.slice(2).join(' ') }));
  if (command === 'ready' || command === 'claim') return print(await mutate(command, {}));
  if (command === 'unblock') return print(await mutate('unblock', { reason: args.join(' ') }));
  if (command === 'rework') {
    if (args[0] !== '--previous-worker-stopped') throw new Error('Stop the previous worker first, then pass --previous-worker-stopped and an audit reason');
    return print(await mutate('rework', { reason: args.slice(1).join(' '), previousWorkerStopped: true }));
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
    await mutate('workspace', { epoch, host: hostId, path, branch });
    await mkdir(resolve(root, '.graphyard/worktrees'), { recursive: true });
    const exists = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
    try { execFileSync('git', exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, args[1] ?? (work.submission ? `origin/${branch}` : 'HEAD')], { stdio: ['ignore', 'ignore', 'inherit'] }); }
    catch { throw new Error('Git worktree creation failed. Reservation remains for safety; inspect the event and repair locally. Do not reuse the branch for another task.'); }
    return print({ path, branch, epoch });
  }
  if (command === 'watch') {
    const epoch = Number(args[0]); const separator = args.indexOf('--');
    if (separator < 0 || !args[separator + 1]) throw new Error('Usage: watch GY-N EPOCH -- command args');
    const workspace = work.workspaces.find((w: any) => w.epoch === epoch);
    if (!workspace || workspace.host !== hostId || await realpath(process.cwd()) !== await realpath(workspace.path)) throw new Error('Run watch from the assigned workspace on its registered host');
    if ((await api('status')).actor?.role !== 'worker') throw new Error('watch requires a worker credential; never pass operator or producer credentials to implementation processes');
    process.env.GRAPHYARD_URL = base; process.env.GRAPHYARD_TOKEN = token;
    process.env.GRAPHYARD_CLI = await activeCliPath(); process.env.GRAPHYARD_HOST_ID = hostId;
    process.exitCode = await supervise(args[separator + 1], args.slice(separator + 2), epoch,
      () => api(`work/${work.id}/heartbeat`, { epoch }, randomUUID()));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
