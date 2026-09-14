import { readFile, mkdir, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { supervise } from './supervisor.js';
import { discover } from './onboarding.js';
import { startGithubSetup } from './github-setup.js';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConnection, setupRepository, handoff, hostIdSchema } from './repository-setup.js';

try { process.loadEnvFile(); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
const [command, id, ...args] = process.argv.slice(2);
let connection: Awaited<ReturnType<typeof loadConnection>>;
try { connection = await loadConnection(process.cwd()); } catch { console.error('Invalid or insecure Graphyard connection file. Inspect local configuration; credential values are omitted.'); process.exit(1); }
const base = process.env.GRAPHYARD_URL ?? connection?.url ?? 'http://127.0.0.1:4310';
let savedToken: string | undefined;
try { if (connection && new URL(base).origin === connection.url) savedToken = connection.token; } catch { /* request validation reports an invalid URL */ }
const token = process.env.GRAPHYARD_TOKEN ?? savedToken;
const hostId = hostIdSchema.parse(process.env.GRAPHYARD_HOST_ID ?? connection?.hostId ?? hostname());
const cliPath = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
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
  doctor                       Inspect local discovery and live integration readiness
  github-setup HTTPS_URL        Register a GitHub App through a local browser flow
  status [GY-N]                Control-plane or work status
  list | next                  List all work / claimable work
  create path/to/work.json      Create work with acceptance criteria (operator)
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
    return print(await setupRepository(root, { url: selectedUrl, cliPath: resolve(values['cli-path'] ?? cliPath), hostId: values['host-id'] ?? hostId, ...(workerToken ? { token: workerToken } : {}) }, { herdr: values.herdr }));
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
    return print({ discovered, server: base, cliPath: connection?.cliPath ?? cliPath, hostId, connected: !!live, githubConfigured: !!live?.github, role: live?.actor?.role, failure,
      next: !live ? 'Configure GRAPHYARD_URL and an individual token' : !live.github ? 'Complete github-setup and configure the server App credentials' : 'Submit a real PR and inspect every gate; configured is not proof of enforcement',
      limits: ['CI discovery is a proposal, not executed-test inventory', 'Herdr two-host recovery and GitHub refusal-to-acceptance must be demonstrated'] });
  }
  if (command === 'status' && !id) return print(await api('status'));
  if (command === 'scenarios') return print(await api('scenarios'));
  if (command === 'scenario') return print(await api('scenarios', JSON.parse(await readFile(id, 'utf8'))));
  if (command === 'list' || command === 'next') {
    const snapshot = await api('work-snapshot'); const items = snapshot.work;
    return print(command === 'list' ? items : items.filter((w: any) => w.stage !== 'done' && w.ready && !w.blocker && (!w.submission || w.reworkRequested) && (!w.lease || Date.parse(w.lease.expiresAt) <= Date.parse(snapshot.now)) && w.dependencies.every((d: string) => items.some((x: any) => x.id === d && x.stage === 'done'))).sort((a: any, b: any) => a.priority - b.priority));
  }
  if (command === 'create') return print(await api('work', JSON.parse(await readFile(id, 'utf8'))));
  if (command === 'handoff') {
    const [snapshot, status] = await Promise.all([api('work-snapshot'), api('status')]);
    const work = snapshot.work.find((w: any) => w.id === id || w.key === id);
    if (!work) throw new Error(`Unknown work item ${id}`);
    return print(handoff(work, { ...status, now: snapshot.now }, hostId, connection?.cliPath ?? cliPath));
  }
  const items = await api('work'); const work = items.find((w: any) => w.id === id || w.key === id);
  if (command === 'events' && !id) return print(await api('events'));
  if (!work) throw new Error(`Unknown work item ${id}`);
  const mutate = (name: string, data: unknown) => api(`work/${work.id}/${name}`, data);
  if (command === 'status') return print(work);
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
    const branch = work.submission ? work.workspaces.find((w: any) => w.epoch === work.submission.epoch)?.branch : `graphyard/${work.key.toLowerCase()}-${epoch}`;
    if (!branch) throw new Error('Submitted workspace branch is missing');
    const path = resolve(root, '.graphyard/worktrees', `${work.key}-${epoch}`);
    await mutate('workspace', { epoch, host: hostId, path, branch });
    await mkdir(resolve(root, '.graphyard/worktrees'), { recursive: true });
    const exists = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
    try { execFileSync('git', exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, args[1] ?? (work.submission ? `origin/${branch}` : 'HEAD')], { stdio: 'inherit' }); }
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
    process.env.GRAPHYARD_CLI = connection?.cliPath ?? cliPath; process.env.GRAPHYARD_HOST_ID = hostId;
    process.exitCode = await supervise(args[separator + 1], args.slice(separator + 2), epoch,
      () => api(`work/${work.id}/heartbeat`, { epoch }, randomUUID()));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
