import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { homedir, hostname } from 'node:os';
import { z } from 'zod';
import { assertRepository, discover, localDirectory, saveDiscovery } from './onboarding.js';
import { managedInstructions, serverOrigin } from './repository-setup.js';
import { resourceConflicts } from './coordination.js';
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
  credentialFile: z.string(),
  cliPath: z.string(),
  repository: z.string().min(1),
  baseBranch: z.string().min(1).max(200),
  githubAppId: z.number().int().positive(),
  hostId: z.string().trim().min(1).max(200),
  masterAgentName: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
  autoMerge: z.boolean().default(true),
  mergeMethod: z.enum(['merge', 'squash', 'rebase']).default('merge'),
  workers: z.array(workerProfileSchema).max(100).default([]),
}).strict();
export type MasterConfig = z.infer<typeof masterConfigSchema>;

export function assertMasterBinding(config: MasterConfig, status: any) {
  if (status.actor?.role !== 'coordinator') throw new Error('Master commands require the configured coordinator identity');
  if (typeof status.repository !== 'string' || status.repository.toLowerCase() !== config.repository.toLowerCase() || status.baseBranch !== config.baseBranch || status.githubAppId !== config.githubAppId) throw new Error('The Graphyard repository, managed base branch, or GitHub App changed; rerun master init before continuing');
}

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
async function readMasterConfig(root: string): Promise<MasterConfig> {
  const file = resolve(root, '.graphyard/master.json'); await privateFile(file);
  const config = masterConfigSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  config.url = serverOrigin(config.url);
  const repositoryRoot = resolve(root), credentialFile = resolve(config.credentialFile);
  if (!isAbsolute(config.credentialFile) || credentialFile === repositoryRoot || credentialFile.startsWith(`${repositoryRoot}/`)) throw new Error('Master credential file must be outside the repository and use an absolute path');
  config.credentialFile = credentialFile;
  return config;
}
async function repositoryWorktrees(root: string) {
  let worktrees: string[];
  try {
    const records = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0');
    worktrees = records.filter(record => record.startsWith('worktree ')).map(record => resolve(record.slice('worktree '.length)));
  } catch { throw new Error('Cannot verify credential location because the complete Git worktree inventory is unavailable'); }
  if (!worktrees.length) throw new Error('Cannot verify credential location because Git returned an empty worktree inventory');
  return Promise.all(worktrees.map(worktree => realpath(worktree)));
}
async function assertOutsideWorktrees(root: string, target: string, label: string) {
  const canonicalTarget = await realpath(target);
  const worktrees = await repositoryWorktrees(root);
  for (const worktree of worktrees) {
    const fromRoot = relative(worktree, canonicalTarget);
    const inside = fromRoot === '' || fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
    if (inside) throw new Error(`${label} must be outside every worktree of the repository`);
  }
}
async function externalCredential(root: string, file: string, label: string) {
  if (!isAbsolute(file)) throw new Error(`${label} credential file must use an absolute path outside the repository`);
  await privateFile(file);
  await assertOutsideWorktrees(root, file, `${label} credential file`);
}
export async function loadMasterConfig(root: string): Promise<MasterConfig> {
  const config = await readMasterConfig(root);
  await externalCredential(root, config.credentialFile, 'Master');
  if (!isAbsolute(config.cliPath)) throw new Error('Master CLI path must be absolute');
  try { if (!(await lstat(config.cliPath)).isFile()) throw new Error(); } catch { throw new Error('Configured Graphyard CLI launcher is unavailable'); }
  return config;
}

export async function readWorkerCredential(root: string, file: string) {
  await externalCredential(root, file, 'Worker');
  return readCredentialFile(file);
}

export async function inspectWorkerCredentials(root: string, profiles: WorkerProfile[]) {
  const health: Record<string, { available: boolean; reason: string | null }> = {};
  for (const profile of profiles) {
    if (profile.mode === 'existing') health[profile.name] = { available: true, reason: null };
    else try { await readWorkerCredential(root, profile.credentialFile!); health[profile.name] = { available: true, reason: null }; }
    catch (error) { health[profile.name] = { available: false, reason: error instanceof Error ? error.message : 'Worker credential is unavailable' }; }
  }
  return health;
}

async function atomicPrivateWrite(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const { writeFile, rename } = await import('node:fs/promises');
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temporary, file); await chmod(file, 0o600);
}
async function atomicPrivateText(file: string, value: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const { writeFile, rename } = await import('node:fs/promises');
  await writeFile(temporary, value, { mode: 0o600, flag: 'wx' }); await rename(temporary, file); await chmod(file, 0o600);
}

export async function setupMaster(root: string, input: { url: string; token: string; cliPath: string; hostId?: string; credentialDirectory?: string; autoMerge?: boolean; mergeMethod?: 'merge' | 'squash' | 'rebase' }, fetcher: typeof fetch = fetch) {
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
  if (typeof status.baseBranch !== 'string' || !status.baseBranch) throw new Error('Master setup requires the control plane to identify its managed base branch');
  if (!Number.isSafeInteger(status.githubAppId) || status.githubAppId <= 0) throw new Error('Master setup requires the control plane to identify its GitHub App');
  assertRepository(detected.repository, status.repository);
  if (!detected.repository) throw new Error('Master setup requires a recognized GitHub origin');
  try { if (!(await lstat(resolve(input.cliPath))).isFile()) throw new Error(); } catch { throw new Error('Master setup requires an existing Graphyard CLI launcher'); }
  let previous: MasterConfig | undefined;
  try { previous = await readMasterConfig(root); } catch (error: any) { if (error.code !== 'ENOENT' && !/ENOENT/.test(error.message)) throw error; }
  if (previous && (previous.url !== url || previous.repository.toLowerCase() !== detected.repository.toLowerCase())) throw new Error('Existing master configuration belongs to another server or repository');
  const repositoryName = detected.repository.split('/').at(-1)!.replace(/[^a-zA-Z0-9._-]/g, '-');
  const requestedCredentialDirectory = resolve(input.credentialDirectory ?? process.env.GRAPHYARD_CONFIG_HOME ?? resolve(homedir(), '.config/graphyard'), 'masters');
  if (requestedCredentialDirectory === resolve(root) || requestedCredentialDirectory.startsWith(`${resolve(root)}/`)) throw new Error('Coordinator credentials must be stored outside the managed repository');
  await mkdir(requestedCredentialDirectory, { recursive: true, mode: 0o700 });
  const credentialDirectory = await realpath(requestedCredentialDirectory);
  await assertOutsideWorktrees(root, credentialDirectory, 'Coordinator credential directory');
  const identity = createHash('sha256').update(`${url}\0${detected.repository}`).digest('hex').slice(0, 20);
  const credentialFile = resolve(credentialDirectory, `${identity}.token`);
  const config = masterConfigSchema.parse({ version: 1, url, credentialFile, cliPath: resolve(input.cliPath), repository: detected.repository, baseBranch: status.baseBranch, githubAppId: status.githubAppId, hostId: input.hostId ?? previous?.hostId ?? hostname(), masterAgentName: previous?.masterAgentName ?? `graphyard-master-${repositoryName}`, autoMerge: input.autoMerge ?? previous?.autoMerge ?? true, mergeMethod: input.mergeMethod ?? previous?.mergeMethod ?? 'merge', workers: previous?.workers ?? [] });
  const instructionsFile = resolve(root, 'AGENTS.md');
  let existing = ''; let mode = 0o644;
  try { const info = await lstat(instructionsFile); if (!info.isFile()) throw new Error('Refusing to replace a non-regular AGENTS.md'); mode = info.mode & 0o777; existing = await readFile(instructionsFile, 'utf8'); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const instructions = managedMasterInstructions(managedInstructions(existing, url));
  const directory = await localDirectory(root);
  await atomicPrivateText(credentialFile, token);
  await atomicPrivateWrite(resolve(directory, 'master.json'), config);
  const temporary = `${instructionsFile}.${randomUUID()}.tmp`;
  const { writeFile, rename } = await import('node:fs/promises');
  await writeFile(temporary, instructions, { mode, flag: 'wx' }); await rename(temporary, instructionsFile); await chmod(instructionsFile, mode);
  await saveDiscovery(root);
  return { repository: config.repository, server: config.url, role: status.actor.role, autoMerge: config.autoMerge, workers: config.workers.length, config: '.graphyard/master.json', next: `Run graphyard master start codex (or another supported agent kind), then add worker profiles` };
}

export async function saveWorkerProfile(root: string, profileInput: unknown, verify: (token: string) => Promise<any>) {
  const profile = workerProfileSchema.parse(profileInput);
  const config = await loadMasterConfig(root);
  if (profile.credentialFile) {
    await externalCredential(root, profile.credentialFile, 'Worker');
    const status = await verify(await readCredentialFile(profile.credentialFile));
    if (status.actor?.role !== 'worker' || status.actor.id !== profile.principal) throw new Error('Worker credential does not match the profile principal and worker role');
  }
  if (config.workers.some(worker => worker.name === profile.name || worker.agentName === profile.agentName || worker.principal === profile.principal)) throw new Error('Worker profile name, agent name, and principal must be unique');
  config.workers.push(profile); await atomicPrivateWrite(resolve(root, '.graphyard/master.json'), config);
  return { added: profile.name, principal: profile.principal, mode: profile.mode, workers: config.workers.length };
}

type HerdrAgent = { name?: string; pane_id?: string; agent?: string; agent_status?: string; cwd?: string; foreground_cwd?: string; tokens?: Record<string, string> };
export function buildMasterStatus(snapshot: { work: Work[]; now: string }, profiles: WorkerProfile[], agents: HerdrAgent[], credentialHealth: Record<string, { available: boolean; reason: string | null }> = {}) {
  const now = Date.parse(snapshot.now);
  const sessions = profiles.map(profile => {
    const agent = agents.find(candidate => candidate.name === profile.agentName);
    const credential = credentialHealth[profile.name] ?? { available: true, reason: null };
    return { profile: profile.name, principal: profile.principal, agentName: profile.agentName, mode: profile.mode, state: agent?.agent_status ?? 'offline', pane: agent?.pane_id ?? null, cwd: agent?.foreground_cwd ?? agent?.cwd ?? null, contextPercent: agent?.tokens?.agent_watcher_context_pct ? Number(agent.tokens.agent_watcher_context_pct) : null, credential };
  });
  const rows = snapshot.work.filter(work => work.stage !== 'done').map(work => {
    const active = !!work.lease && Date.parse(work.lease.expiresAt) > now;
    const profile = active ? profiles.find(item => item.principal === work.lease!.owner) : undefined;
    const session = profile ? sessions.find(item => item.profile === profile.name) : undefined;
    const first = work.gates.find(gate => !gate.passed);
    const freshObservation = !!work.observation && now - Date.parse(work.observation.at) >= 0 && now - Date.parse(work.observation.at) < 120_000;
    const activeMerge = !!work.mergeExecution && Date.parse(work.mergeExecution.expiresAt) > now;
    const mergeable = !activeMerge && freshObservation && work.stage === 'merge' && !!work.candidate && !!work.mergeAuthorization
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
export function observeHerdrAgents(run?: (command: string, args: string[]) => string) {
  try { return { agents: listHerdrAgents(run), available: true, reason: null }; }
  catch { return { agents: [] as HerdrAgent[], available: false, reason: 'Herdr session health is unavailable; Graphyard work state remains authoritative' }; }
}

function waitForHerdrAgent(target: string, run?: (command: string, args: string[]) => string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const agent = herdrJson(['agent', 'get', target], run);
      if (agent?.pane_id || agent?.name || agent?.agent_status) return agent as HerdrAgent;
    } catch (error) { lastError = error; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`Launched worker did not become visible in Herdr within ${timeoutMs}ms${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

function stopHerdrPane(pane: string, run?: (command: string, args: string[]) => string, timeoutMs = 5_000) {
  herdrJson(['pane', 'close', pane], run);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = herdrJson(['pane', 'list'], run);
    if (!Array.isArray(result.panes)) throw new Error('Herdr did not return a pane inventory after close');
    if (!result.panes.some((candidate: any) => candidate.pane_id === pane)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error(`Herdr still reports pane ${pane} after close`);
}

export async function startMaster(root: string, kind: WorkerProfile['kind'], agentArgs: string[], agents: HerdrAgent[], run?: (command: string, args: string[]) => string) {
  if (!kind) throw new Error('Choose a supported master agent kind');
  const config = await loadMasterConfig(root);
  if (agents.some(agent => agent.name === config.masterAgentName)) throw new Error(`Master agent ${config.masterAgentName} is already visible in Herdr`);
  const tab = herdrJson(['tab', 'create', '--cwd', root, '--label', `Graphyard master · ${config.repository}`, '--env', 'GRAPHYARD_MASTER=1', '--no-focus'], run);
  const pane = tab.pane_id ?? tab.pane?.id ?? tab.tab?.pane_id;
  if (!pane) throw new Error('Herdr did not return the new master pane');
  try {
    herdrJson(['agent', 'start', config.masterAgentName, '--kind', kind, '--pane', pane, '--', ...agentArgs], run);
    const prompt = `You are the dedicated Graphyard master agent for ${config.repository}. Do not implement product work, claim worker leases, submit evidence, weaken requirements, or bypass gates. Read AGENTS.md, run node ${config.cliPath} master guide, then run node ${config.cliPath} master status. Use Graphyard as assignment and progression truth and Herdr only for session health and control. Route ready work to configured worker profiles, require workers to claim for themselves, preserve handoffs, surface decisions that need the operator, and invoke routine merge only through graphyard master merge after every exact-candidate gate passes.`;
    herdrJson(['agent', 'prompt', config.masterAgentName, prompt], run);
  } catch (error) {
    try { stopHerdrPane(pane, run); }
    catch { throw new Error(`${error instanceof Error ? error.message : 'Master startup failed'}; Herdr could not confirm cleanup of pane ${pane}`); }
    throw error;
  }
  return { agentName: config.masterAgentName, kind, pane, status: 'started and prompted', focusChanged: false };
}

type WorkerCommand = (command: string, args: string[], options?: any) => string | Buffer;
type PreparedWorker = { epoch: number; path: string; base: string };

export function assertDispatchable(work: Work, allWork: Work[], observedAt: string) {
  const now = Date.parse(observedAt);
  if (!Number.isFinite(now)) throw new Error('Dispatch requires a valid Graphyard snapshot clock');
  if (!work.ready || work.blocker) throw new Error('Dispatch requires released work without a blocker');
  const unfinished = work.dependencies.map(id => allWork.find(item => item.id === id)).filter(dependency => !dependency || dependency.stage !== 'done');
  if (unfinished.length) throw new Error(`Dispatch blocked by unfinished dependencies: ${unfinished.map(dependency => dependency?.key ?? 'unknown').join(', ')}`);
  if (work.lease && Date.parse(work.lease.expiresAt) > now) throw new Error(`Dispatch blocked by active owner ${work.lease.owner}`);
  if (work.submission && !work.reworkRequested) throw new Error('Dispatch requires operator-authorized rework for a submitted item');
  const conflicts = resourceConflicts(work, allWork, now);
  if (conflicts.length) throw new Error(`Dispatch blocked by exclusive resources: ${conflicts.map(conflict => `${conflict.resource} held by ${conflict.key}`).join(', ')}`);
}

export async function dispatchWork(root: string, work: Work, profile: WorkerProfile, agents: HerdrAgent[], run?: (command: string, args: string[]) => string, allWork: Work[] = [work], prepare: (root: string, key: string, profileName: string) => Promise<PreparedWorker> = prepareWorkerLaunch, release: (root: string, key: string, epoch: number, profileName: string) => Promise<void> = releaseWorkerLaunch, agentTimeoutMs = 30_000, observedAt = new Date().toISOString()) {
  assertDispatchable(work, allWork, observedAt);
  const config = await loadMasterConfig(root);
  let target = agents.find(agent => agent.name === profile.agentName);
  if (profile.mode === 'existing') {
    if (!target) throw new Error('Existing worker is not visible in Herdr');
    throw new Error('Existing sessions are observable but cannot be safely adopted for new work; use a launch profile so Graphyard supervises the agent process');
  } else {
    await readCredentialFile(profile.credentialFile!);
    if (target) throw new Error('Launch profile agent name is already visible in Herdr');
    const prepared = await prepare(root, work.key, profile.name);
    const prompt = `Implement ${work.key}: ${work.title}. The Graphyard worker launcher has claimed this item under principal ${profile.principal}, created its assigned worktree, and placed this agent under lease supervision. Run node ${config.cliPath} status ${work.key} before editing. Work only in the current assigned worktree, satisfy the stated criteria without weakening them, open a PR, and submit it with complete. Stop immediately if the supervisor reports lease loss. Do not submit trusted evidence or merge the PR.`;
    let pane: string | undefined;
    try {
      const tabArgs = ['tab', 'create', '--cwd', prepared.path, '--label', `${work.key} · ${profile.agentName}`, '--env', `GRAPHYARD_URL=${config.url}`, '--env', `GRAPHYARD_TOKEN_FILE=${profile.credentialFile}`, '--env', `GRAPHYARD_HOST_ID=${config.hostId}`, ...Object.entries(profile.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--no-focus'];
      const tab = herdrJson(tabArgs, run); pane = tab.pane_id ?? tab.pane?.id ?? tab.tab?.pane_id;
      if (!pane) throw new Error('Herdr did not return the new worker pane');
      const supervised = [process.execPath, config.cliPath, 'watch', work.key, String(prepared.epoch), '--', profile.kind!, ...profile.agentArgs].map(shellQuote).join(' ');
      herdrJson(['pane', 'run', pane, supervised], run);
      waitForHerdrAgent(pane, run, agentTimeoutMs);
      herdrJson(['agent', 'rename', pane, profile.agentName], run);
      herdrJson(['agent', 'prompt', profile.agentName, prompt], run);
      target = { name: profile.agentName, pane_id: pane, agent_status: 'idle', cwd: prepared.path };
    } catch (error) {
      if (pane) {
        try { stopHerdrPane(pane, run); }
        catch { throw new Error(`${error instanceof Error ? error.message : 'Worker launch failed'}; Herdr could not confirm pane shutdown, so Graphyard retained epoch ${prepared.epoch}`); }
      }
      try { await release(root, work.key, prepared.epoch, profile.name); }
      catch { throw new Error(`${error instanceof Error ? error.message : 'Worker launch failed'}; the pane was stopped but Graphyard could not release epoch ${prepared.epoch}`); }
      throw error;
    }
  }
  return { work: work.key, profile: profile.name, principal: profile.principal, agentName: profile.agentName, pane: target.pane_id ?? null, ownership: 'worker launcher claimed and is supervising the agent process' };
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function workerEnvironment(config: MasterConfig, profile: WorkerProfile) {
  const env: NodeJS.ProcessEnv = { ...process.env, GRAPHYARD_URL: config.url, GRAPHYARD_TOKEN_FILE: profile.credentialFile, GRAPHYARD_HOST_ID: config.hostId };
  delete env.GRAPHYARD_TOKEN; delete env.GRAPHYARD_MASTER_TOKEN; delete env.GRAPHYARD_REQUEST_ID;
  return env;
}
const workerCommand: WorkerCommand = (command, args, options = {}) => execFileSync(command, args, { ...options, encoding: 'utf8', stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'] });

export async function releaseWorkerLaunch(root: string, key: string, epoch: number, profileName: string, run: WorkerCommand = workerCommand) {
  const config = await loadMasterConfig(root); const profile = config.workers.find(worker => worker.name === profileName);
  if (!profile || profile.mode !== 'launch' || !profile.kind || !profile.credentialFile) throw new Error('A complete launch profile is required');
  await readWorkerCredential(root, profile.credentialFile);
  run(process.execPath, [config.cliPath, 'release', key, String(epoch)], { cwd: root, env: workerEnvironment(config, profile) });
}

export async function prepareWorkerLaunch(root: string, key: string, profileName: string, run: WorkerCommand = workerCommand): Promise<PreparedWorker> {
  const config = await loadMasterConfig(root); const profile = config.workers.find(worker => worker.name === profileName);
  if (!profile || profile.mode !== 'launch' || !profile.kind || !profile.credentialFile) throw new Error('A complete launch profile is required');
  await readWorkerCredential(root, profile.credentialFile);
  const detected = await discover(root);
  if (!detected.repository) throw new Error('Worker launcher requires a recognized GitHub origin');
  assertRepository(detected.repository, config.repository);
  const env = workerEnvironment(config, profile);
  run('git', ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${config.baseBranch}:refs/remotes/origin/${config.baseBranch}`], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] });
  const base = String(run('git', ['rev-parse', '--verify', `refs/remotes/origin/${config.baseBranch}`], { cwd: root, env })).trim();
  if (!/^[0-9a-f]{40}$/i.test(base)) throw new Error('Worker launcher could not resolve the current managed base branch');
  const claim = JSON.parse(String(run(process.execPath, [config.cliPath, 'claim', key], { cwd: root, env })));
  const claimedEpoch = Number.isSafeInteger(claim.epoch) && claim.epoch > 0 ? claim.epoch as number : null;
  try {
    if (claim.lease?.owner !== profile.principal || claimedEpoch === null) throw new Error('Worker launcher acquired an unexpected assignment identity');
    const workspace = JSON.parse(String(run(process.execPath, [config.cliPath, 'worktree', key, String(claimedEpoch), base], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] })));
    if (!workspace.path || !isAbsolute(workspace.path)) throw new Error('Worker launcher did not receive an assigned workspace');
    return { epoch: claimedEpoch, path: workspace.path, base };
  } catch (error) {
    if (claimedEpoch !== null) try { run(process.execPath, [config.cliPath, 'release', key, String(claimedEpoch)], { cwd: root, env }); }
    catch { throw new Error(`${error instanceof Error ? error.message : 'Workspace preparation failed'}; Graphyard could not release epoch ${claimedEpoch}`); }
    throw error;
  }
}

export function assertMergeCandidate(work: Work, observedAt?: string) {
  const age = observedAt && work.observation ? Date.parse(observedAt) - Date.parse(work.observation.at) : 0;
  const fresh = !observedAt || !!work.observation && Number.isFinite(age) && age >= 0 && age < 120_000;
  const activeMerge = !!observedAt && !!work.mergeExecution && Date.parse(work.mergeExecution.expiresAt) > Date.parse(observedAt);
  if (activeMerge || !fresh || work.stage !== 'merge' || !work.candidate || !work.mergeAuthorization || work.mergeAuthorization.sha !== work.candidate.sha || work.mergeAuthorization.baseSha !== work.candidate.baseSha || work.mergeAuthorization.policyRevision !== work.policyRevision || work.gates.some(gate => !gate.passed) || work.violations.length) throw new Error(`${work.key} does not have a current all-gates-passing merge authorization`);
  return { key: work.key, revision: work.revision, pr: work.candidate.pr, sha: work.candidate.sha, baseSha: work.candidate.baseSha, policyRevision: work.policyRevision };
}
export function currentMergeCandidates(work: Work[], observedAt: string) {
  return work.filter(item => {
    try { assertMergeCandidate(item, observedAt); return true; }
    catch { return false; }
  });
}
export async function continueMergeBatch<T extends { key: string }, R>(items: T[], action: (item: T) => Promise<R>) {
  const results: (R | { key: string; result: 'refused'; reason: string })[] = [];
  for (const item of items) {
    try { results.push(await action(item)); }
    catch (error) { results.push({ key: item.key, result: 'refused', reason: error instanceof Error ? error.message : 'Merge attempt failed' }); }
  }
  return results;
}
type MergeExecution = { id: string; owner: string; sha: string; baseSha: string; policyRevision: number; authorizationRevision: number; issuedAt: string; expiresAt: string };
export function assertMergeProtection(protection: any, config: MasterConfig, work: Work) {
  const nativeReview = !!work.policy.review && (work.policy.reviewProvider ?? 'github') !== 'codex';
  const reviews = protection?.required_pull_request_reviews;
  const checks = protection?.required_status_checks;
  const protectedBranch = (!nativeReview || reviews?.required_approving_review_count >= 1 && reviews?.dismiss_stale_reviews === true && reviews?.require_last_push_approval === true)
    && checks?.strict === true && protection?.enforce_admins?.enabled === true && protection?.allow_force_pushes?.enabled !== true && protection?.allow_deletions?.enabled !== true
    && Array.isArray(checks?.checks) && checks.checks.some((check: any) => check?.context === 'Graphyard / merge' && check?.app_id === config.githubAppId);
  if (!protectedBranch) throw new Error(`${work.key} managed-branch protection changed after merge authorization; Graphyard refused the merge`);
}
export async function mergeWork(config: MasterConfig, work: Work, freshSnapshot: () => Promise<{ work: Work[]; now: string }>, acquire: (work: Work, authorization: ReturnType<typeof assertMergeCandidate>) => Promise<{ execution: MergeExecution }>, cancel: (work: Work, execution: MergeExecution, reason: string) => Promise<unknown>, verify: (work: Work, execution: MergeExecution) => Promise<{ executionId: string; sha: string }>, run: (command: string, args: string[]) => string = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 })) {
  if (!config.autoMerge) throw new Error('Automatic routine merge is disabled in master configuration');
  const before = await freshSnapshot(); const current = before.work.find(item => item.id === work.id);
  if (!current || current.revision !== work.revision) throw new Error(`${work.key} changed before GitHub verification; retry`);
  const authorization = assertMergeCandidate(current, before.now);
  const pr = JSON.parse(run('gh', ['pr', 'view', String(authorization.pr), '--repo', config.repository, '--json', 'headRefOid,baseRefOid,baseRefName,state,isDraft']));
  if (pr.headRefOid !== authorization.sha || pr.baseRefOid !== authorization.baseSha || pr.baseRefName !== config.baseBranch || pr.state !== 'OPEN' || pr.isDraft) throw new Error(`${work.key} changed on GitHub before merge`);
  const after = await freshSnapshot(); const latest = after.work.find(item => item.id === work.id);
  if (!latest || latest.revision !== authorization.revision) throw new Error(`${work.key} changed after GitHub verification; retry`);
  const latestAuthorization = assertMergeCandidate(latest, after.now);
  const acquireStartedAt = Date.now();
  const granted = await acquire(latest, latestAuthorization);
  if (!granted.execution || granted.execution.sha !== authorization.sha || granted.execution.baseSha !== authorization.baseSha || granted.execution.policyRevision !== authorization.policyRevision || granted.execution.authorizationRevision !== authorization.revision) throw new Error(`${work.key} received an invalid merge execution authority`);
  let providerStarted = false; let cancelled = false;
  try {
    const lockedPr = JSON.parse(run('gh', ['pr', 'view', String(authorization.pr), '--repo', config.repository, '--json', 'headRefOid,baseRefOid,baseRefName,state,isDraft']));
    if (lockedPr.headRefOid !== authorization.sha || lockedPr.baseRefOid !== authorization.baseSha || lockedPr.baseRefName !== config.baseBranch || lockedPr.state !== 'OPEN' || lockedPr.isDraft) throw new Error(`${work.key} changed on GitHub after merge authority was acquired`);
    const authorityDuration = Date.parse(granted.execution.expiresAt) - Date.parse(granted.execution.issuedAt);
    const remaining = authorityDuration - (Date.now() - acquireStartedAt);
    if (!Number.isFinite(remaining) || remaining <= 90_000) throw new Error(`${work.key} merge execution does not remain valid for the provider timeout; refresh gate inputs and retry`);
    const protection = JSON.parse(run('gh', ['api', `repos/${config.repository}/branches/${encodeURIComponent(config.baseBranch)}/protection`]));
    assertMergeProtection(protection, config, latest);
    const verified = await verify(latest, granted.execution);
    if (verified.executionId !== granted.execution.id || verified.sha !== authorization.sha) throw new Error(`${work.key} received an invalid final GitHub gate verification`);
    const remainingAfterProtection = authorityDuration - (Date.now() - acquireStartedAt);
    if (!Number.isFinite(remainingAfterProtection) || remainingAfterProtection <= 90_000) throw new Error(`${work.key} merge execution no longer has enough time for the provider call after verifying branch protection; retry`);
    providerStarted = true;
    const provider = JSON.parse(run('gh', ['api', '--method', 'PUT', `repos/${config.repository}/pulls/${authorization.pr}/merge`, '-f', `sha=${authorization.sha}`, '-f', `merge_method=${config.mergeMethod}`]));
    if (provider.merged !== true || typeof provider.sha !== 'string') {
      await cancel(latest, granted.execution, provider.message || 'GitHub confirmed that it did not merge the candidate'); cancelled = true;
      throw new Error(provider.message || 'GitHub did not merge the candidate');
    }
  }
  catch (error) {
    if (!providerStarted) try { await cancel(latest, granted.execution, error instanceof Error ? error.message : 'GitHub merge failed before provider invocation'); }
    catch { throw new Error(`${work.key} GitHub merge failed before provider invocation and Graphyard could not cancel execution ${granted.execution.id}`); }
    if (providerStarted && !cancelled) throw new Error(`${error instanceof Error ? error.message : 'GitHub merge call failed'}; the merge outcome is unknown, so Graphyard retained execution ${granted.execution.id} until observation or expiry`);
    throw error;
  }
  return { key: authorization.key, pr: authorization.pr, sha: authorization.sha, method: config.mergeMethod, result: 'merge requested; Graphyard will mark Done only after observing the merge' };
}
