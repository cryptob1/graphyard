import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertRepository, buildProposal, canonicalJson, collectScanInput, discover, localDirectory, saveDiscovery, setupProposalSchema, type SetupProposal } from './onboarding.js';

export const hostIdSchema = z.string().trim().min(1).max(200);
export const connectionSchema = z.object({ url: z.string(), cliPath: z.string(), hostId: hostIdSchema, token: z.string().min(32).optional(), principal: z.string().optional() }).strict();
export type Connection = z.infer<typeof connectionSchema>;
export function serverOrigin(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Use an HTTPS server origin, or HTTP on loopback; no credentials, query, or path');
  return url.origin;
}
function connectionRoots(cwd: string) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const current = git('rev-parse', '--show-toplevel');
  const primary = git('worktree', 'list', '--porcelain', '-z').split('\0').find(line => line.startsWith('worktree '))?.slice(9);
  if (!primary) throw new Error('Cannot locate the primary checkout for shared worker configuration');
  // A bare repository has no primary checkout in which to keep ignored config.
  execFileSync('git', ['-C', primary, 'rev-parse', '--show-toplevel'], { stdio: 'ignore' });
  return [...new Set([primary, current])];
}
export async function loadConnection(cwd: string): Promise<Connection | null> {
  let roots: string[];
  try { roots = connectionRoots(cwd); } catch { return null; }
  for (const root of roots) {
    try {
      const file = resolve(root, '.graphyard/connection.json'); const info = await lstat(file);
      if (!info.isFile() || info.mode & 0o077) throw new Error('Connection credentials must be a regular file with mode 0600');
      const connection = connectionSchema.parse(JSON.parse(await readFile(file, 'utf8')));
      connection.url = serverOrigin(connection.url); return connection;
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  return null;
}
const start = '<!-- graphyard -->', end = '<!-- /graphyard -->';
export function managedInstructions(existing: string, url: string) {
  const starts = existing.split(start).length - 1, ends = existing.split(end).length - 1;
  if (starts !== ends || starts > 1 || starts === 1 && existing.indexOf(end) < existing.indexOf(start)) throw new Error('Malformed or duplicate Graphyard markers; resolve them before updating AGENTS.md');
  const section = `${start}
## Graphyard coordination

This repository uses Graphyard at ${serverOrigin(url)} for ownership and delivery gates.
Repository setup stores machine-specific CLI and connection settings in ignored
\`.graphyard/connection.json\`. Never put credentials in AGENTS.md or Git.

Before editing, claim an authorized work item and use its assigned worktree.
Check dependencies, blockers, current owner, and lease epoch. Use \`handoff GY-N\`
to obtain the workspace and launch command for this machine.

Run agents through \`watch GY-N EPOCH -- YOUR_AGENT_COMMAND\`. The supervisor supplies
\`GRAPHYARD_CLI\`, \`GRAPHYARD_URL\`, and worker identity to the child. Inside that
session, invoke the CLI as \`node "$GRAPHYARD_CLI" status GY-N\` (or other commands).
For manual startup, use the CLI path printed by \`init\` or Herdr's handoff command.

Renew ownership at least every 30 seconds while actively working. Stop editing and
pushing on lease loss; an expired or superseded epoch does not authorize more work.
Register the assigned host/path/branch before submission. Do not reuse another
assignment's worktree or quietly remove historical reservations.

Run \`sync GY-N\` before every push. It merges the base branch (\`git fetch origin &&
git merge origin/BASE\`; never rebase) and lists every file outside the item's
plannedFiles that no longer matches origin/BASE. Files outside plannedFiles must match
origin/BASE byte-for-byte: restore them, never re-resolve a merge in favour of your
branch. Only an operator can widen plannedFiles, through an audited requirements revision.

Submit the PR with \`complete GY-N EPOCH PR_NUMBER\`. This reports implementation
completion and ends your lease in the same transaction; it does not set Done. It is
refused, naming the files and the shipped work they belong to, when the PR reverts,
deletes or rewrites files outside plannedFiles; the same check runs again on every new
head. Make \`complete\` your last action: do not heartbeat, edit, or push after it. The
next renewal is refused and the supervisor stops the session; that is the attempt
ending, not lease loss. CI, trusted evidence, independent review, and Graphyard's
merge gate decide progression. Report blockers explicitly.
Never use an operator/producer token for implementation or weaken proof requirements.
Herdr runs sessions; Graphyard remains the source of ownership truth.

A dedicated master coordinator must keep cycling: status, dispatch ready work,
shepherd review and proof collection, guarded merge, then deployment verification.
Repeat until both conditions hold: (1) every in-scope item is Done or has a genuinely
external blocker recorded in Graphyard; and (2) every merged change is deployed and
live-verified against the exact deployed release, or a genuinely external deployment
blocker is recorded in Graphyard. Delivered work is immutable, so a deployment
blocker is recorded as a follow-up work item naming the delivered item, its merge
commit, and the external cause; the delivery stays pending until the release serves it.
An observed merge alone does not end the loop. Ordinary review findings, rework,
idle workers, and proof setup are not stopping conditions. Close finished agent
sessions as part of the cycle.
${end}`;
  return starts ? existing.slice(0, existing.indexOf(start)) + section + existing.slice(existing.indexOf(end) + end.length) : `${existing}${existing.endsWith('\n') || !existing ? '' : '\n'}\n${section}\n`;
}
async function regularOrMissing(file: string) {
  try { if (!(await lstat(file)).isFile()) throw new Error('Refusing to replace a non-regular setup file'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
}
async function atomicWrite(file: string, content: string, mode: number) {
  await regularOrMissing(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode, flag: 'wx' }); await rename(temporary, file); await chmod(file, mode);
}
export async function setupRepository(root: string, input: Connection, options: { herdr?: boolean; runHerdr?: (args: string[]) => string; fetcher?: typeof fetch } = {}) {
  const connection = connectionSchema.parse(input); connection.url = serverOrigin(connection.url);
  delete connection.principal; // Identity is established only by the authenticated server response.
  if (!isAbsolute(connection.cliPath) || !(await lstat(connection.cliPath)).isFile()) throw new Error('CLI path must be an existing absolute launcher path');
  if (options.herdr && !connection.token) throw new Error('Herdr setup requires an individual worker credential via GRAPHYARD_TOKEN or --token-stdin');
  const detected = await discover(root);
  if (connection.token) {
    let response: Response;
    try { response = await (options.fetcher ?? fetch)(`${connection.url}/api/status`, { headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(15000) }); } catch { throw new Error('Cannot reach Graphyard; setup has not saved credentials'); }
    if (!response.ok) throw new Error(`Graphyard rejected the credential (${response.status}); setup has not saved it`);
    const status = await response.json();
    if (status.actor?.role !== 'worker') throw new Error('Repository worker setup requires a worker credential; operator, coordinator, producer, and reader tokens are not suitable for launching workers');
    assertRepository(detected.repository, status.repository);
    connection.principal = status.actor.id;
  }
  const instructionsFile = resolve(root, 'AGENTS.md'); await regularOrMissing(instructionsFile);
  let existing = ''; try { existing = await readFile(instructionsFile, 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const instructions = managedInstructions(existing, connection.url);
  const runHerdr = options.runHerdr ?? ((args: string[]) => {
    try { return execFileSync('herdr', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { throw new Error('Herdr setup command failed; check installation and rerun init. No credentials were printed.'); }
  });
  if (options.herdr) runHerdr(['plugin', '--help']);
  const directory = await localDirectory(connectionRoots(root)[0]);
  await atomicWrite(resolve(directory, 'connection.json'), JSON.stringify(connection, null, 2), 0o600);
  let instructionsMode = 0o644; try { instructionsMode = (await lstat(instructionsFile)).mode & 0o777; } catch { /* new instructions */ }
  await atomicWrite(instructionsFile, instructions, instructionsMode);
  const discovery = await saveDiscovery(root);
  let pluginConfigured = false;
  if (options.herdr) {
    // Configure while disabled, then enable only after private credential persistence succeeds.
    runHerdr(['plugin', 'link', dirname(dirname(connection.cliPath)), '--disabled']);
    const configDirectory = runHerdr(['plugin', 'config-dir', 'graphyard']).trim();
    if (!isAbsolute(configDirectory) || /[\r\n\0]/.test(configDirectory)) throw new Error('Herdr returned an invalid configuration directory');
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    await atomicWrite(resolve(configDirectory, 'config.json'), JSON.stringify({ url: connection.url, token: connection.token, cliPath: connection.cliPath, hostId: connection.hostId }, null, 2), 0o600);
    runHerdr(['plugin', 'enable', 'graphyard']); pluginConfigured = true;
  }
  return { discovery, server: connection.url, cliPath: connection.cliPath, principal: connection.principal ?? null, connected: !!connection.principal,
    instructions: 'AGENTS.md', pluginConfigured, next: connection.principal ? 'Use Herdr or the CLI to claim work, then handoff GY-N for the assigned workspace and supervisor command' : 'Supply an individual worker credential and rerun init to verify the connection' };
}
export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function handoff(work: any, status: any, hostId: string, cliPath: string) {
  const lease = work.lease;
  if (status.actor?.role !== 'worker' || !lease || lease.owner !== status.actor.id || !Number.isFinite(Date.parse(lease.expiresAt)) || !Number.isFinite(Date.parse(status.now)) || Date.parse(lease.expiresAt) <= Date.parse(status.now)) throw new Error('A current worker-owned lease is required for handoff');
  const workspace = work.workspaces.find((w: any) => w.epoch === lease.epoch);
  if (workspace && workspace.host !== hostId) throw new Error('This assignment belongs to another host; use its registered machine');
  const cli = `node ${shellQuote(cliPath)}`;
  return { work: work.key, epoch: lease.epoch, owner: lease.owner, workspace: workspace ?? null,
    commands: workspace ? [`cd ${shellQuote(workspace.path)}`, `${cli} watch ${shellQuote(work.key)} ${lease.epoch} -- YOUR_AGENT_COMMAND`] : [`${cli} worktree ${shellQuote(work.key)} ${lease.epoch}`, `${cli} handoff ${shellQuote(work.key)}`],
    note: `${!workspace ? 'Run worktree from the managed repository checkout; its origin is verified before reservation. ' : ''}Handoff does not start a worker or renew ownership. Keep the lease alive while preparing, then start the supervisor.` };
}

// --- Drop-in setup: scan proposal storage, apply, and drift -------------------

export const proposalFileName = 'setup-proposal.json', appliedFileName = 'repository-setup.json';

/** Read-only scan plus the proposal it produces. Nothing is written here. */
export async function scanProposal(root: string, options: { url?: string | null; runtimes?: string[] } = {}) {
  const [input, detected] = await Promise.all([collectScanInput(root), discover(root)]);
  return buildProposal(input, { repository: detected.repository, server: options.url ?? null, runtimes: options.runtimes });
}

export async function saveProposal(root: string, proposal: SetupProposal) {
  const file = resolve(await localDirectory(root), proposalFileName);
  await atomicWrite(file, JSON.stringify(proposal, null, 2), 0o600);
  return { file, proposal };
}

export async function loadProposal(root: string): Promise<{ file: string; proposal: SetupProposal } | null> {
  const file = resolve(await localDirectory(root), proposalFileName);
  try {
    if (!(await lstat(file)).isFile()) throw new Error('The stored setup proposal must be a regular file');
    return { file, proposal: setupProposalSchema.parse(JSON.parse(await readFile(file, 'utf8'))) };
  } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}

export const proposalDigest = (proposal: SetupProposal) => `sha256:${createHash('sha256').update(canonicalJson(setupProposalSchema.parse(proposal))).digest('hex')}`;

const appliedStateSchema = z.object({
  version: z.literal(1),
  appliedAt: z.string(),
  proposalDigest: z.string(),
  server: z.string(),
  artifacts: z.object({
    instructions: z.string(),
    principals: z.string(),
    profiles: z.array(z.string()),
    githubApp: z.object({ appId: z.number().int().positive(), slug: z.string() }).nullable(),
  }).strict(),
}).strict();
export type AppliedSetup = z.infer<typeof appliedStateSchema>;

export async function loadAppliedSetup(root: string): Promise<AppliedSetup | null> {
  const directory = await localDirectory(root);
  const file = resolve(directory, appliedFileName);
  try {
    if (!(await lstat(file)).isFile()) throw new Error('The applied setup record must be a regular file');
    return appliedStateSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Drift between a stored proposal and the setup recorded as applied. */
export function setupDrift(applied: AppliedSetup | null, proposal: SetupProposal): string[] {
  if (!applied) return [];
  const drift: string[] = [];
  if (applied.proposalDigest !== proposalDigest(proposal)) drift.push('Repository scan changed after setup was applied; review init --scan output and reapply only if the change is intended');
  return drift;
}

/** Non-mutating status of the local proposal and applied setup, for read-only commands. */
export async function readSetupStatus(root: string) {
  const directory = resolve(root, '.graphyard');
  const read = async (name: string, schema: z.ZodType<any>) => {
    let value: any = null;
    try { value = JSON.parse(await readFile(resolve(directory, name), 'utf8')); } catch (error: any) { if (error.code !== 'ENOENT') return { error: 'unreadable' }; }
    try { return { value: value === null ? null : schema.parse(value) }; } catch { return { error: 'invalid' }; }
  };
  const proposal = await read(proposalFileName, setupProposalSchema);
  const applied = await read(appliedFileName, appliedStateSchema);
  const drift = proposal.value && applied.value ? setupDrift(applied.value, proposal.value)
    : applied.value ? ['Applied setup record exists without a stored proposal; run init --scan'] : [];
  return {
    proposal: proposal.value ? `.graphyard/${proposalFileName}` : null,
    appliedAt: applied.value?.appliedAt ?? null,
    githubApp: applied.value?.artifacts.githubApp ?? null,
    unreadable: [proposal.error && `.graphyard/${proposalFileName} ${proposal.error}`, applied.error && `.graphyard/${appliedFileName} ${applied.error}`].filter(Boolean),
    drift,
  };
}

/** Repository-derived drift between a fresh scan and the stored proposal, ignoring machine-specific profile and server choices. */
export function repositoryScanDifference(fresh: SetupProposal, stored: SetupProposal): string[] {
  const repositoryPart = (proposal: SetupProposal) => canonicalJson({ ...proposal, server: null, profiles: { ...proposal.profiles, workers: [] } });
  return repositoryPart(fresh) === repositoryPart(stored) ? [] : ['The repository scan no longer matches the stored proposal'];
}

async function readGithubApp(directory: string, repository: string) {
  const file = resolve(directory, 'github-app.json');
  let app: any;
  try { app = JSON.parse(await readFile(file, 'utf8')); } catch (error: any) { if (error.code !== 'ENOENT') throw error; return null; }
  if (app.repository !== repository) throw new Error('Saved App belongs to a different repository');
  return app;
}

const principalsDocumentSchema = z.object({
  version: z.literal(1), server: z.string(), repository: z.string(), note: z.string(),
  principals: z.array(z.object({
    id: z.string().min(1), role: z.enum(['admin', 'coordinator', 'worker', 'producer']),
    token: z.string().min(32), proofs: z.array(z.string()).optional(),
  }).strict()).min(1),
}).strict();

export interface ApplyDependencies {
  url: string;
  githubSetup?: (repository: string, deployment: string) => Promise<{ appId: number; slug: string }>;
  now?: () => Date;
  token?: () => string;
}

/**
 * Apply an operator-reviewed proposal. Every artifact is written idempotently:
 * unchanged content is left alone, operator-edited files are reported as drift
 * instead of being overwritten, and principal tokens are preserved across runs.
 */
export async function applyProposal(root: string, proposalInput: unknown, dependencies: ApplyDependencies) {
  const proposal = setupProposalSchema.parse(proposalInput);
  const server = serverOrigin(dependencies.url);
  const directory = await localDirectory(root);
  const applied: string[] = [], unchanged: string[] = [], drift: string[] = [];

  const instructionsFile = resolve(root, 'AGENTS.md');
  await regularOrMissing(instructionsFile);
  let existing = ''; try { existing = await readFile(instructionsFile, 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const instructions = managedInstructions(existing, server);
  if (instructions === existing) unchanged.push('AGENTS.md coordination section');
  else {
    let instructionsMode = 0o644; try { instructionsMode = (await lstat(instructionsFile)).mode & 0o777; } catch { /* new instructions */ }
    await atomicWrite(instructionsFile, instructions, instructionsMode);
    applied.push('AGENTS.md coordination section');
  }

  const randomToken = dependencies.token ?? (() => randomBytes(32).toString('base64url'));
  const grants = proposal.proofs.filter(proof => proof.command).map(proof => proof.name);
  // Only principals the operator reviewed in the proposal are registered; apply
  // never mints a credential the proposal does not declare, so a machine without
  // an agent runtime gets no worker principal rather than an unreviewed one.
  const workerPrincipals = [...new Set(proposal.profiles.workers.map(profile => profile.principal))];
  const desired = [
    { id: 'operator', role: 'admin' as const },
    { id: 'master', role: 'coordinator' as const },
    ...workerPrincipals.map(id => ({ id, role: 'worker' as const })),
    { id: 'evidence', role: 'producer' as const, proofs: grants },
  ];
  let previous: unknown = null;
  const principalsPath = resolve(directory, 'principals.json');
  try {
    const info = await lstat(principalsPath);
    if (!info.isFile() || info.mode & 0o077) throw new Error('Saved principals must be a regular file with mode 0600');
    previous = JSON.parse(await readFile(principalsPath, 'utf8'));
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const saved = (previous as any)?.principals ?? [];
  const merged = desired.map(entry => ({ ...entry, token: saved.find((candidate: any) => candidate.id === entry.id)?.token ?? randomToken() }));
  const document = { version: 1 as const, server, repository: proposal.repository,
    note: 'Install this array as GRAPHYARD_PRINCIPALS on the Graphyard deployment before workers connect. One secret per principal. Never give implementation workers the producer or admin entries; the producer holds only the listed proof grants.',
    principals: merged };
  if (previous && canonicalJson(previous) === canonicalJson(document)) unchanged.push('principal and grant registry');
  else { await atomicWrite(principalsPath, JSON.stringify(document, null, 2), 0o600); applied.push(`principal and grant registry (${merged.map(entry => `${entry.id}:${entry.role}`).join(', ')})`); }
  principalsDocumentSchema.parse(document);

  const profilesDirectory = resolve(directory, 'profiles');
  await mkdir(profilesDirectory, { recursive: true, mode: 0o700 });
  const profileNames: string[] = [];
  const writeProfile = async (name: string, value: unknown) => {
    profileNames.push(name);
    const file = resolve(profilesDirectory, `${name}.json`);
    let current: string | null = null;
    try { current = await readFile(file, 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    if (current === null) { await atomicWrite(file, JSON.stringify(value, null, 2), 0o600); applied.push(`${name} profile`); }
    else if (canonicalJson(JSON.parse(current)) === canonicalJson(value)) unchanged.push(`${name} profile`);
    else drift.push(`${name} profile differs from the proposal; the local file was kept`);
  };
  for (const profile of proposal.profiles.workers) await writeProfile(profile.name, profile);
  await writeProfile('reviewer', { provider: proposal.policy.reviewProvider, note: proposal.profiles.reviewer.note });

  const previousState = await loadAppliedSetup(root);
  const savedApp = await readGithubApp(directory, proposal.repository);
  let githubApp: { appId: number; slug: string } | null = savedApp ? { appId: savedApp.appId, slug: savedApp.slug } : previousState?.artifacts.githubApp ?? null;
  if (!githubApp && dependencies.githubSetup) {
    const registration = await dependencies.githubSetup(proposal.repository, server);
    if (!Number.isSafeInteger(registration?.appId) || !registration?.slug) throw new Error('The GitHub App flow returned an incomplete registration');
    githubApp = { appId: registration.appId, slug: registration.slug };
    applied.push(`GitHub App registration ${githubApp.slug}`);
  }

  const state = appliedStateSchema.parse({ version: 1, appliedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    proposalDigest: proposalDigest(proposal), server,
    artifacts: { instructions: 'AGENTS.md', principals: '.graphyard/principals.json', profiles: profileNames, githubApp } });
  const appliedPath = resolve(directory, appliedFileName);
  const sameState = previousState && canonicalJson({ ...previousState, appliedAt: '' }) === canonicalJson({ ...state, appliedAt: '' });
  if (sameState) unchanged.push('applied setup record');
  else { await atomicWrite(appliedPath, JSON.stringify(state, null, 2), 0o600); applied.push('applied setup record'); }

  const workerStep = workerPrincipals.length
    ? 'place each worker credential at its profile credentialFile path, then claim work'
    : 'no agent runtime was detected on this machine, so the proposal declared no worker profile and no worker principal was registered; install an agent CLI and rerun init --scan --apply to add one';
  return { server, applied, unchanged, drift, githubApp,
    githubPending: !githubApp,
    workerPrincipals,
    principalsFile: resolve(directory, 'principals.json'),
    next: githubApp
      ? `Install the principals array as GRAPHYARD_PRINCIPALS on the Graphyard deployment, ${workerStep}`
      : 'Run graphyard github-setup SERVER_URL to register the GitHub App, then rerun init --scan --apply to finish idempotently' };
}
