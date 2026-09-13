import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { supervise } from './supervisor.js';
import { discover, saveDiscovery } from './onboarding.js';
import { startGithubSetup } from './github-setup.js';

try { process.loadEnvFile(); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
const [command, id, ...args] = process.argv.slice(2);
const base = process.env.GRAPHYARD_URL ?? 'http://127.0.0.1:4310';
const token = process.env.GRAPHYARD_TOKEN;
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
  init                         Scan repository and append agent instructions
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
  claim GY-N                   Acquire a two-minute lease; returns epoch
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
    let existing = ''; try { existing = await readFile(resolve(root, 'AGENTS.md'), 'utf8'); } catch { /* new file */ }
    if (!existing.includes('<!-- graphyard -->')) await writeFile(resolve(root, 'AGENTS.md'), `${existing}\n<!-- graphyard -->\n## Graphyard coordination\n\nClaim an authorized Graphyard work item before editing. Use the assigned worktree.\nRun the worker through \`graphyard watch\` or heartbeat at least every 30 seconds.\nStop on lease loss; do not continue writing or pushing. Check dependencies and blockers.\nSubmit the PR through \`graphyard complete\`; only Graphyard gates can mark work done.\nNever use an operator/producer token for implementation. Never weaken task proof requirements.\n<!-- /graphyard -->\n`);
    print({ root, ...await saveDiscovery(root), instructions: 'AGENTS.md', next: 'Run github-setup HTTPS_URL to register the App, then doctor to inspect readiness. Discovered checks are proposals; confirm their actual CI job names.' }); return;
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
    return print({ discovered, server: base, connected: !!live, githubConfigured: !!live?.github, role: live?.actor?.role, failure,
      next: !live ? 'Configure GRAPHYARD_URL and an individual token' : !live.github ? 'Complete github-setup and configure the server App credentials' : 'Submit a real PR and inspect every gate; configured is not proof of enforcement',
      limits: ['CI discovery is a proposal, not executed-test inventory', 'Herdr two-host recovery and GitHub refusal-to-acceptance must be demonstrated'] });
  }
  if (command === 'status' && !id) return print(await api('status'));
  if (command === 'scenarios') return print(await api('scenarios'));
  if (command === 'scenario') return print(await api('scenarios', JSON.parse(await readFile(id, 'utf8'))));
  if (command === 'list' || command === 'next') {
    const items = await api('work');
    return print(command === 'list' ? items : items.filter((w: any) => w.stage !== 'done' && w.ready && !w.blocker && (!w.submission || w.reworkRequested) && (!w.lease || Date.parse(w.lease.expiresAt) <= Date.now()) && w.dependencies.every((d: string) => items.some((x: any) => x.id === d && x.stage === 'done'))).sort((a: any, b: any) => a.priority - b.priority));
  }
  if (command === 'create') return print(await api('work', JSON.parse(await readFile(id, 'utf8'))));
  const items = await api('work'); const work = items.find((w: any) => w.id === id || w.key === id);
  if (command === 'events' && !id) return print(await api('events'));
  if (!work) throw new Error(`Unknown work item ${id}`);
  const mutate = (name: string, data: unknown) => api(`work/${work.id}/${name}`, data);
  if (command === 'status') return print(work);
  if (command === 'events') return print(await api(`events?work=${work.id}`));
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
    await mutate('workspace', { epoch, host: process.env.GRAPHYARD_HOST_ID ?? hostname(), path, branch });
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
    if (!workspace || workspace.host !== (process.env.GRAPHYARD_HOST_ID ?? hostname()) || await realpath(process.cwd()) !== await realpath(workspace.path)) throw new Error('Run watch from the assigned workspace on its registered host');
    if ((await api('status')).actor?.role !== 'worker') throw new Error('watch requires a worker credential; never pass operator or producer credentials to implementation processes');
    process.exitCode = await supervise(args[separator + 1], args.slice(separator + 2), epoch,
      () => api(`work/${work.id}/heartbeat`, { epoch }, randomUUID()));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
