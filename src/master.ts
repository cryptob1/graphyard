import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { hostname } from 'node:os';
import { z } from 'zod';
import { assertRepository, discover, localDirectory, saveDiscovery } from './onboarding.js';
import { managedInstructions, serverOrigin } from './repository-setup.js';
import type { Work } from './model.js';

const safeEnvironment = z.record(
  z.string().regex(/^[A-Z_][A-Z0-9_]*$/).refine(name => !/(TOKEN|SECRET|PASSWORD|PRIVATE|API_KEY|CREDENTIAL)/.test(name), 'Put secrets in the worker credential file or the agent runtime login, not master profile environment'),
  z.string().min(1).max(1000).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Profile environment values cannot contain control characters'),
).default({});

export const workerProfileSchema = z.object({
  name: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
  principal: z.string().trim().min(1).max(200),
  agentName: z.string().trim().min(1).max(100),
  mode: z.enum(['existing', 'launch']),
  kind: z.enum(['pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline', 'omp', 'mastracode', 'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp', 'grok', 'hermes', 'kilo', 'qodercli', 'qwen', 'maki']).optional(),
  credentialFile: z.string().optional(),
  agentArgs: z.array(z.string().max(1000)).max(30).default([]),
  environment: safeEnvironment,
}).strict().superRefine((profile, context) => {
  if (profile.mode === 'launch' && !profile.kind) context.addIssue({ code: 'custom', message: 'A launched worker requires kind', path: ['kind'] });
  if (profile.mode === 'launch' && !profile.credentialFile) context.addIssue({ code: 'custom', message: 'A launched worker requires credentialFile', path: ['credentialFile'] });
  if (profile.credentialFile && !isAbsolute(profile.credentialFile)) context.addIssue({ code: 'custom', message: 'credentialFile must be absolute', path: ['credentialFile'] });
});
export type WorkerProfile = z.infer<typeof workerProfileSchema>;

export const masterConfigSchema = z.object({
  version: z.literal(1),
  url: z.string(),
  token: z.string().min(32),
  cliPath: z.string(),
  repository: z.string().min(1),
  hostId: z.string().trim().min(1).max(200),
  masterAgentName: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
  autoMerge: z.boolean().default(true),
  mergeMethod: z.enum(['merge', 'squash', 'rebase']).default('merge'),
  workers: z.array(workerProfileSchema).max(100).default([]),
}).strict();
export type MasterConfig = z.infer<typeof masterConfigSchema>;

const masterStart = '<!-- graphyard-master -->', masterEnd = '<!-- /graphyard-master -->';
export function managedMasterInstructions(existing: string) {
  const starts = existing.split(masterStart).length - 1, ends = existing.split(masterEnd).length - 1;
  if (starts !== ends || starts > 1 || starts === 1 && existing.indexOf(masterEnd) < existing.indexOf(masterStart)) throw new Error('Malformed or duplicate Graphyard master markers; resolve them before updating AGENTS.md');
  const section = `${masterStart}
## Graphyard master agent

The recommended coordinator is a dedicated, visible master-agent session. It does
not implement work, hold worker leases, submit evidence, or bypass gates. Run
\`graphyard master status\` at startup and after every material event. Graphyard is
the source of assignment and progression truth; Herdr supplies live session health.

Dispatch only ready work with \`graphyard master dispatch GY-N PROFILE\`. The
worker must claim the item under its own identity and use the assigned worktree.
Treat prompt delivery as an invitation, never as ownership. Use durable handoffs
when an agent, provider account, machine, or context window changes.

Routine merges may use \`graphyard master merge --all\`. The command rechecks the
exact current candidate, every configured gate, and GitHub state immediately before
merging. Human gates, stale observations, failures, and changed commits remain
blocking. Never use an administrative merge bypass. Read \`docs/master-agent.md\`
in Graphyard or run \`graphyard master guide\` for the complete operating loop.
${masterEnd}`;
  return starts ? existing.slice(0, existing.indexOf(masterStart)) + section + existing.slice(existing.indexOf(masterEnd) + masterEnd.length) : `${existing}${existing.endsWith('\n') || !existing ? '' : '\n'}\n${section}\n`;
}

async function privateFile(file: string) {
  const info = await lstat(file);
  if (!info.isFile() || info.mode & 0o077) throw new Error(`${file} must be a regular file with mode 0600`);
  return info;
}
export async function readCredentialFile(file: string) {
  await privateFile(file);
  const value = (await readFile(file, 'utf8')).trim();
  if (value.length < 32 || value.length > 10_000) throw new Error('Worker credential file must contain one valid token');
  return value;
}
export async function loadMasterConfig(root: string): Promise<MasterConfig> {
  const file = resolve(root, '.graphyard/master.json'); await privateFile(file);
  const config = masterConfigSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  config.url = serverOrigin(config.url);
  if (!isAbsolute(config.cliPath)) throw new Error('Master CLI path must be absolute');
  try { if (!(await lstat(config.cliPath)).isFile()) throw new Error(); } catch { throw new Error('Configured Graphyard CLI launcher is unavailable'); }
  return config;
}

async function atomicPrivateWrite(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const { writeFile, rename } = await import('node:fs/promises');
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temporary, file); await chmod(file, 0o600);
}

export async function setupMaster(root: string, input: { url: string; token: string; cliPath: string; hostId?: string; autoMerge?: boolean; mergeMethod?: 'merge' | 'squash' | 'rebase' }, fetcher: typeof fetch = fetch) {
  const url = serverOrigin(input.url); const token = input.token.trim();
  if (token.length < 32) throw new Error('Master initialization requires a coordinator credential over stdin');
  const detected = await discover(root);
  let response: Response;
  try { response = await fetcher(`${url}/api/status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }); }
  catch { throw new Error('Cannot reach Graphyard; master setup made no changes'); }
  if (!response.ok) throw new Error(`Graphyard rejected the coordinator credential (${response.status}); master setup made no changes`);
  const status = await response.json();
  if (status.actor?.role !== 'coordinator') throw new Error('Master setup requires a coordinator credential; worker, operator, producer, and reader credentials are not suitable');
  if (typeof status.repository !== 'string' || !status.repository) throw new Error('Master setup requires the control plane to be bound to a GitHub repository');
  assertRepository(detected.repository, status.repository);
  if (!detected.repository) throw new Error('Master setup requires a recognized GitHub origin');
  try { if (!(await lstat(resolve(input.cliPath))).isFile()) throw new Error(); } catch { throw new Error('Master setup requires an existing Graphyard CLI launcher'); }
  let previous: MasterConfig | undefined;
  try { previous = await loadMasterConfig(root); } catch (error: any) { if (error.code !== 'ENOENT' && !/ENOENT/.test(error.message)) throw error; }
  if (previous && (previous.url !== url || previous.repository.toLowerCase() !== detected.repository.toLowerCase())) throw new Error('Existing master configuration belongs to another server or repository');
  const repositoryName = detected.repository.split('/').at(-1)!.replace(/[^a-zA-Z0-9._-]/g, '-');
  const config = masterConfigSchema.parse({ version: 1, url, token, cliPath: resolve(input.cliPath), repository: detected.repository, hostId: input.hostId ?? previous?.hostId ?? hostname(), masterAgentName: previous?.masterAgentName ?? `graphyard-master-${repositoryName}`, autoMerge: input.autoMerge ?? previous?.autoMerge ?? true, mergeMethod: input.mergeMethod ?? previous?.mergeMethod ?? 'merge', workers: previous?.workers ?? [] });
  const instructionsFile = resolve(root, 'AGENTS.md');
  let existing = ''; let mode = 0o644;
  try { const info = await lstat(instructionsFile); if (!info.isFile()) throw new Error('Refusing to replace a non-regular AGENTS.md'); mode = info.mode & 0o777; existing = await readFile(instructionsFile, 'utf8'); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const instructions = managedMasterInstructions(managedInstructions(existing, url));
  const directory = await localDirectory(root);
  await atomicPrivateWrite(resolve(directory, 'master.json'), config);
  const temporary = `${instructionsFile}.${randomUUID()}.tmp`;
  const { writeFile, rename } = await import('node:fs/promises');
  await writeFile(temporary, instructions, { mode, flag: 'wx' }); await rename(temporary, instructionsFile); await chmod(instructionsFile, mode);
  await saveDiscovery(root);
  return { repository: config.repository, server: config.url, role: status.actor.role, autoMerge: config.autoMerge, workers: config.workers.length, config: '.graphyard/master.json', next: `Run graphyard master start codex (or another supported agent kind), then add worker profiles` };
}

export async function saveWorkerProfile(root: string, profileInput: unknown, verify: (token: string) => Promise<any>) {
  const profile = workerProfileSchema.parse(profileInput);
  if (profile.credentialFile) {
    const status = await verify(await readCredentialFile(profile.credentialFile));
    if (status.actor?.role !== 'worker' || status.actor.id !== profile.principal) throw new Error('Worker credential does not match the profile principal and worker role');
  }
  const config = await loadMasterConfig(root);
  if (config.workers.some(worker => worker.name === profile.name || worker.agentName === profile.agentName || worker.principal === profile.principal)) throw new Error('Worker profile name, agent name, and principal must be unique');
  config.workers.push(profile); await atomicPrivateWrite(resolve(root, '.graphyard/master.json'), config);
  return { added: profile.name, principal: profile.principal, mode: profile.mode, workers: config.workers.length };
}

type HerdrAgent = { name?: string; pane_id?: string; agent?: string; agent_status?: string; cwd?: string; foreground_cwd?: string; tokens?: Record<string, string> };
export function buildMasterStatus(snapshot: { work: Work[]; now: string }, profiles: WorkerProfile[], agents: HerdrAgent[]) {
  const now = Date.parse(snapshot.now);
  const sessions = profiles.map(profile => {
    const agent = agents.find(candidate => candidate.name === profile.agentName);
    return { profile: profile.name, principal: profile.principal, agentName: profile.agentName, mode: profile.mode, state: agent?.agent_status ?? 'offline', pane: agent?.pane_id ?? null, cwd: agent?.foreground_cwd ?? agent?.cwd ?? null, contextPercent: agent?.tokens?.agent_watcher_context_pct ? Number(agent.tokens.agent_watcher_context_pct) : null };
  });
  const rows = snapshot.work.filter(work => work.stage !== 'done').map(work => {
    const active = !!work.lease && Date.parse(work.lease.expiresAt) > now;
    const profile = active ? profiles.find(item => item.principal === work.lease!.owner) : undefined;
    const session = profile ? sessions.find(item => item.profile === profile.name) : undefined;
    const first = work.gates.find(gate => !gate.passed);
    const mergeable = work.stage === 'merge' && !!work.candidate && !!work.mergeAuthorization
      && work.mergeAuthorization.sha === work.candidate.sha && work.mergeAuthorization.baseSha === work.candidate.baseSha
      && work.mergeAuthorization.policyRevision === work.policyRevision
      && work.gates.every(gate => gate.passed) && !work.violations.length;
    const dwellMs = now - Date.parse(work.stageEnteredAt);
    const attention = active && (!session || !['working', 'idle'].includes(session.state)) ? `Assigned worker session is ${session?.state ?? 'offline'}`
      : work.blocker || dwellMs > 3_600_000 ? first?.reasons[0] ?? `Work has remained at ${work.stage} for more than one hour` : null;
    return { key: work.key, title: work.title, stage: work.stage, owner: active ? work.lease!.owner : null, profile: profile?.name ?? null, session: session?.state ?? null, refusal: first ? { gate: first.name, reason: first.reasons[0] } : null, mergeable, attention };
  });
  return { observedAt: snapshot.now, counts: { open: rows.length, ready: rows.filter(row => row.stage === 'ready').length, active: rows.filter(row => row.owner).length, attention: rows.filter(row => row.attention).length, mergeable: rows.filter(row => row.mergeable).length }, workers: sessions, work: rows };
}

function herdrJson(args: string[], run: (command: string, args: string[]) => string = (command, commandArgs) => execFileSync(command, commandArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) {
  const parsed = JSON.parse(run('herdr', args));
  if (parsed.error) throw new Error(`Herdr refused the operation: ${parsed.error.message ?? parsed.error}`);
  return parsed.result ?? parsed;
}
export function listHerdrAgents(run?: (command: string, args: string[]) => string): HerdrAgent[] { return herdrJson(['agent', 'list'], run).agents ?? []; }

export async function startMaster(root: string, kind: WorkerProfile['kind'], agentArgs: string[], agents: HerdrAgent[], run?: (command: string, args: string[]) => string) {
  if (!kind) throw new Error('Choose a supported master agent kind');
  const config = await loadMasterConfig(root);
  if (agents.some(agent => agent.name === config.masterAgentName)) throw new Error(`Master agent ${config.masterAgentName} is already visible in Herdr`);
  const tab = herdrJson(['tab', 'create', '--cwd', root, '--label', `Graphyard master · ${config.repository}`, '--env', 'GRAPHYARD_MASTER=1', '--no-focus'], run);
  const pane = tab.pane_id ?? tab.pane?.id ?? tab.tab?.pane_id;
  if (!pane) throw new Error('Herdr did not return the new master pane');
  herdrJson(['agent', 'start', config.masterAgentName, '--kind', kind, '--pane', pane, '--', ...agentArgs], run);
  const prompt = `You are the dedicated Graphyard master agent for ${config.repository}. Do not implement product work, claim worker leases, submit evidence, weaken requirements, or bypass gates. Read AGENTS.md, run node ${config.cliPath} master guide, then run node ${config.cliPath} master status. Use Graphyard as assignment and progression truth and Herdr only for session health and control. Route ready work to configured worker profiles, require workers to claim for themselves, preserve handoffs, surface decisions that need the operator, and invoke routine merge only through graphyard master merge after every exact-candidate gate passes.`;
  herdrJson(['agent', 'prompt', config.masterAgentName, prompt], run);
  return { agentName: config.masterAgentName, kind, pane, status: 'started and prompted', focusChanged: false };
}

export async function dispatchWork(root: string, work: Work, profile: WorkerProfile, agents: HerdrAgent[], run?: (command: string, args: string[]) => string, allWork: Work[] = [work]) {
  if (work.stage !== 'ready' || !work.ready || work.blocker) throw new Error('Dispatch requires an unassigned work item at Ready');
  const unfinished = work.dependencies.map(id => allWork.find(item => item.id === id)).filter(dependency => !dependency || dependency.stage !== 'done');
  if (unfinished.length) throw new Error(`Dispatch blocked by unfinished dependencies: ${unfinished.map(dependency => dependency?.key ?? 'unknown').join(', ')}`);
  const config = await loadMasterConfig(root);
  let target = agents.find(agent => agent.name === profile.agentName);
  if (profile.mode === 'existing') {
    if (!target || !['idle', 'done'].includes(target.agent_status ?? '')) throw new Error('Existing worker must be visible and idle in Herdr');
    const cwd = resolve(target.foreground_cwd ?? target.cwd ?? '/');
    if (cwd !== root && !cwd.startsWith(`${root}/`)) throw new Error('Existing worker is visible in a different repository');
  } else {
    await readCredentialFile(profile.credentialFile!);
    if (target) throw new Error('Launch profile agent name is already visible in Herdr');
    const tabArgs = ['tab', 'create', '--cwd', root, '--label', `${work.key} · ${profile.agentName}`, '--env', `GRAPHYARD_URL=${config.url}`, '--env', `GRAPHYARD_TOKEN_FILE=${profile.credentialFile}`, '--env', `GRAPHYARD_HOST_ID=${config.hostId}`, ...Object.entries(profile.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--no-focus'];
    const tab = herdrJson(tabArgs, run); const pane = tab.pane_id ?? tab.pane?.id ?? tab.tab?.pane_id;
    if (!pane) throw new Error('Herdr did not return the new worker pane');
    herdrJson(['agent', 'start', profile.agentName, '--kind', profile.kind!, '--pane', pane, '--', ...profile.agentArgs], run);
    target = { name: profile.agentName, pane_id: pane, agent_status: 'idle', cwd: root };
  }
  const prompt = `Implement ${work.key}: ${work.title}. Graphyard owns the assignment. First run node ${config.cliPath} claim ${work.key}; only continue if the claim succeeds under principal ${profile.principal}. Then run worktree and handoff as instructed, work only in the assigned worktree, keep the lease alive with watch, satisfy the stated criteria without weakening them, open a PR, and submit it with complete. Stop immediately if the lease is lost. Do not submit trusted evidence or merge the PR.`;
  herdrJson(['agent', 'prompt', profile.agentName, prompt], run);
  return { work: work.key, profile: profile.name, principal: profile.principal, agentName: profile.agentName, pane: target.pane_id ?? null, ownership: 'pending worker claim' };
}

export function assertMergeCandidate(work: Work) {
  if (work.stage !== 'merge' || !work.candidate || !work.mergeAuthorization || work.mergeAuthorization.sha !== work.candidate.sha || work.mergeAuthorization.baseSha !== work.candidate.baseSha || work.mergeAuthorization.policyRevision !== work.policyRevision || work.gates.some(gate => !gate.passed) || work.violations.length) throw new Error(`${work.key} does not have a current all-gates-passing merge authorization`);
  return { key: work.key, revision: work.revision, pr: work.candidate.pr, sha: work.candidate.sha, baseSha: work.candidate.baseSha, policyRevision: work.policyRevision };
}
export async function mergeWork(config: MasterConfig, work: Work, freshSnapshot: () => Promise<{ work: Work[]; now: string }>, run: (command: string, args: string[]) => string = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) {
  if (!config.autoMerge) throw new Error('Automatic routine merge is disabled in master configuration');
  const authorization = assertMergeCandidate(work);
  const pr = JSON.parse(run('gh', ['pr', 'view', String(authorization.pr), '--repo', config.repository, '--json', 'headRefOid,baseRefOid,state,isDraft']));
  if (pr.headRefOid !== authorization.sha || pr.baseRefOid !== authorization.baseSha || pr.state !== 'OPEN' || pr.isDraft) throw new Error(`${work.key} changed on GitHub before merge`);
  const latest = (await freshSnapshot()).work.find(item => item.id === work.id);
  if (!latest || latest.revision !== authorization.revision) throw new Error(`${work.key} changed after GitHub verification; retry`);
  assertMergeCandidate(latest);
  const method = `--${config.mergeMethod}`;
  run('gh', ['pr', 'merge', String(authorization.pr), '--repo', config.repository, method, '--match-head-commit', authorization.sha]);
  return { key: authorization.key, pr: authorization.pr, sha: authorization.sha, method: config.mergeMethod, result: 'merge requested; Graphyard will mark Done only after observing the merge' };
}
