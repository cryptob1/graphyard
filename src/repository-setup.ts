import { realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertRepository, buildProposal, canonicalJson, collectScanInput, discover, localDirectory, removeDeliveryWorkflow, saveDiscovery, setupProposalSchema, type ScanInput, type SetupProposal } from './onboarding.js';
import { generatedFilesAssignment } from './install/generated-files.js';
import { autonomyContract } from './autonomy.js';
import { documentationAssignment, documentationPolicySchema, parseRepositoryConfig, repositoryConfigFile, type DocumentationPolicy, type RepositoryConfig } from './model/documentation.js';
import { deliveryPolicySchema, generatedWorkflowFiles, requiredPullRequestChecks, type DeliveryMode, type DeliveryPolicy } from './model/delivery-policy.js';
import { readInstallUnits, systemdCommandLineWords, unitCheckout, userUnitDirectory, type InstallUnits } from './install/units.js';
import { checkoutLauncherOf, coordinatorCheckoutRoot, forwardTolerant } from './master/profiles.js';
import { containedInstall, npmCiEnvironment } from './cli/test-isolation.js';
import { herdrTarget, type HerdrInstance } from './master/herdr.js';
import { herdrSync } from './herdr-host.js';

export const hostIdSchema = z.string().trim().min(1).max(200);
// GY-1960: connection.json is forward-tolerant — a field a newer CLI wrote that this one does not
// declare parses and is written back unchanged (setupRepository keeps the undeclared keys).
export const connectionSchema = forwardTolerant(z.object({ url: z.string(), cliPath: z.string(), hostId: hostIdSchema, token: z.string().min(32).optional(), principal: z.string().optional() }).strict());
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
/**
 * The authorization every launched session needs (GY-93): its instruction is its own first
 * request, and the one paste it may later receive comes from the same launcher. Written into the
 * generated instructions below, which Codex, Cursor, OpenCode and Claude Code read from the
 * repository — and carried on the command line of a Claude Code session that the master's role
 * harness launches without the repository's project files (master.ts prepareSessionHarness).
 * It ends with the autonomy contract (autonomy.ts), so every installation's AGENTS.md carries it.
 */
export const launchAuthorization = `Every session Graphyard launches — a worker under \`watch\`, and the reviewer, proof-producer
and approver sessions the master and its loop start — receives its instruction as the
session's own first request, on the runtime's command line, never as pasted text; no human
sends "go". The one message such a session may later receive as a paste comes from that
same launcher: the loop's single re-prompt of a session that has shown no activity, the
reviewer's reminder to post the verdict it already judged, or the loop's event wake of the
master session it launched, naming the changed subjects. It repeats the session's own
request or names the work item and this repository's CLI, and is the operator's instruction,
not untrusted text: act on it without waiting for confirmation. Nothing else pasted into a
session carries that authority.

${autonomyContract}`;
// GY-2240: the block names no control-plane URL — the origin is machine-specific and already lives
// in ignored .graphyard/connection.json, and a URL here made every deploy's refresh step (init --scan
// --apply with the install URL) rewrite the committed block, dirtying the coordinator checkout.
export function managedInstructions(existing: string) {
  const starts = existing.split(start).length - 1, ends = existing.split(end).length - 1;
  if (starts !== ends || starts > 1 || starts === 1 && existing.indexOf(end) < existing.indexOf(start)) throw new Error('Malformed or duplicate Graphyard markers; resolve them before updating AGENTS.md');
  const section = `${start}
## Graphyard coordination

This repository uses Graphyard for ownership and delivery gates; ignored
\`.graphyard/connection.json\` names the control plane and the machine-specific
CLI and connection settings. Never put credentials in AGENTS.md or Git.

Before editing, claim an authorized work item and use its assigned worktree.
Check dependencies, blockers, current owner, and lease epoch. Use \`handoff GY-N\`
to obtain the workspace and launch command for this machine.

Run agents through \`watch GY-N EPOCH -- YOUR_AGENT_COMMAND\`. The supervisor supplies
\`GRAPHYARD_CLI\`, \`GRAPHYARD_URL\`, and worker identity to the child. Inside that
session, invoke the CLI as \`node "$GRAPHYARD_CLI" status GY-N\` (or other commands).
For manual startup, use the CLI path printed by \`init\` or Herdr's handoff command.

Renew ownership at least every 30 seconds while actively working. Stop editing on
lease loss; an expired or superseded epoch does not authorize more work.
Register the assigned host/path/branch before submission. Do not reuse another
assignment's worktree or quietly remove historical reservations.

Run \`sync GY-N\` before submitting. It merges the shared origin/BASE the merge writer
advances (never rebase; nothing is fetched), and judges only merge conflicts:
plannedFiles is the planned change list that keeps parallel work apart, a hint and not
a limit. Commit on the assigned branch: nothing is pushed and no pull request is opened.

Submit the commit with \`complete GY-N EPOCH --head SHA\` (the control plane is the merge
writer; the shared object store already holds SHA). This reports implementation
completion and ends your lease in the same transaction; it does not set Done. Make
\`complete\` your last action: do not heartbeat or edit after it. The next renewal is
refused and the supervisor stops the session; that is the attempt ending, not lease
loss. Trusted evidence, independent review, and Graphyard's merge gate decide
progression. Report blockers explicitly.
Park a decision only a human may make with \`park GY-N EPOCH KIND NEEDED... --ask ASK
[--step STEP]... --recommend TEXT --why WHY -- REASON\`. Write ASK, STEP, TEXT and WHY for a
non-technical reader: ASK is one sentence naming the action they take, each STEP one plain
instruction, TEXT the choice you recommend (its exact label when the request offers
buttons) or the safest way to get a value asked for (such as a token scoped to one
repository, short-lived, with only the permissions needed), WHY one plain sentence of why.
Put branches, commit shas, file paths and resume commands only in
NEEDED and REASON, the detail for the next agent.
Never use an operator/producer token for implementation or weaken proof requirements.
Herdr runs sessions; Graphyard remains the source of ownership truth.
To set Graphyard up or find what its setup is missing, follow Graphyard's
docs/setup-from-zero.md: \`doctor\` prints one PASS or FAIL line per prerequisite under
\`setupFromZero\`, and each FAIL line names the checklist step that fixes it.

${launchAuthorization}

A dedicated master coordinator must keep cycling: status, dispatch ready work,
shepherd review, record what the merge writer's trial landed, then deployment verification.
Repeat until both conditions hold: (1) every in-scope item is Done or has a genuinely
external blocker recorded in Graphyard; and (2) every merged change is deployed and
live-verified against the exact deployed release, or a genuinely external deployment
blocker is recorded in Graphyard. Delivered work is immutable, so a deployment
blocker is recorded as a follow-up work item naming the delivered item, its merge
commit, and the external cause; delivered at merge; release health is one status line.
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
const urlOrigin = (value: string) => { try { return new URL(value).origin; } catch { return value; } };

/**
 * The server Herdr's `graphyard` plugin is bound to on this machine, read from the config.json its
 * config directory holds; null when the plugin has no configuration (never linked) or Herdr cannot
 * say where it keeps one. A host already running a Graphyard install has one, and linking the
 * plugin for another server would silently repoint it (GY-1413). A config.json that exists but
 * cannot be read, is not JSON or names no server is a binding nobody can inspect: `url` is null
 * and `bound` says why, so callers refuse to overwrite it without --herdr-rebind rather than
 * mistaking it for no binding at all. READ reads that file: this machine's, or a host's over its
 * transport (GY-1511), whose missing file rejects with code ENOENT.
 */
export async function herdrPluginBinding(runHerdr: (args: string[]) => string | Promise<string>, read: (file: string) => Promise<string> = file => readFile(file, 'utf8')): Promise<{ configDirectory: string; url: string | null; bound: string } | null> {
  let configDirectory: string;
  try { configDirectory = String(await runHerdr(['plugin', 'config-dir', 'graphyard'])).trim(); } catch { return null; }
  if (!configDirectory || !isAbsolute(configDirectory) || /[\r\n\0]/.test(configDirectory)) return null;
  const file = resolve(configDirectory, 'config.json');
  const uninspectable = (reason: string) => ({ configDirectory, url: null, bound: `a configuration that cannot be inspected (${file}: ${reason})` });
  let text: string;
  try { text = await read(file); } catch (error: any) { if (error.code === 'ENOENT') return null; return uninspectable(error.code ?? error.message); }
  let config: any;
  try { config = JSON.parse(text); } catch { return uninspectable('not valid JSON'); }
  return typeof config?.url === 'string' && config.url ? { configDirectory, url: config.url, bound: config.url } : uninspectable('it names no server url');
}

/**
 * Whether Herdr reports its `graphyard` plugin enabled (`plugin list --plugin graphyard --json`): a
 * config.json written for the right server says nothing of an enable that failed after it, or a
 * plugin disabled since (GY-1511). False when the plugin is not installed; null when Herdr cannot say.
 */
export async function herdrPluginEnabled(runHerdr: (args: string[]) => string | Promise<string>): Promise<boolean | null> {
  try {
    const parsed = JSON.parse(String(await runHerdr(['plugin', 'list', '--plugin', 'graphyard', '--json'])));
    const plugins = parsed?.result?.plugins ?? parsed?.plugins;
    if (!Array.isArray(plugins)) return null;
    return plugins.find((plugin: any) => plugin?.plugin_id === 'graphyard')?.enabled === true;
  } catch { return null; }
}

/** True when a plugin binding points anywhere but `target`, an uninspectable one included. */
export function herdrBoundElsewhere(binding: { url: string | null } | null, target: string | null) {
  return !!binding && (binding.url === null || target === null || urlOrigin(binding.url) !== urlOrigin(target));
}

/** The refusal for a plugin bound to another server, shared by `init --herdr` and `install --apply`. */
export function herdrRebindRefusal(bound: string, target: string, flag = '--herdr-rebind') {
  return `Herdr's graphyard plugin on this machine is bound to ${bound}; linking it for ${target} would repoint every Herdr session there with a new worker token. Rerun with ${flag} to repoint it on purpose, or without Herdr to leave it bound where it is. Nothing was changed.`;
}

export async function setupRepository(root: string, input: Connection, options: { herdr?: boolean; herdrRebind?: boolean; herdrInstance?: HerdrInstance | null; runHerdr?: (args: string[]) => string; fetcher?: typeof fetch } = {}) {
  const connection = connectionSchema.parse(input); connection.url = serverOrigin(connection.url);
  connection.cliPath = checkoutLauncherOf(connection.cliPath);
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
  const instructions = managedInstructions(existing);
  const runHerdr = options.runHerdr ?? ((args: string[]) => {
    // GY-1511: an install with its own Herdr instance links the plugin there, never in the default one.
    try { return herdrSync(args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }, options.herdrInstance === undefined ? herdrTarget() : options.herdrInstance).trim(); } catch { throw new Error('Herdr setup command failed; check installation and rerun init. No credentials were printed.'); }
  });
  if (options.herdr) runHerdr(['plugin', '--help']);
  // Refused before any write: a plugin another server owns is repointed only on purpose.
  const herdrBound = options.herdr ? await herdrPluginBinding(runHerdr) : null;
  const herdrRelink = herdrBoundElsewhere(herdrBound, connection.url) ? herdrBound!.bound : null;
  if (herdrRelink && !options.herdrRebind) throw new Error(herdrRebindRefusal(herdrRelink, connection.url));
  const directory = await localDirectory(connectionRoots(root)[0]);
  // GY-1960: setup rewrites connection.json whole from the fields this version declares, so an
  // older or held CLI rerunning it keeps what a newer CLI wrote: only the keys this version does
  // not declare ride under these updates. A declared key is never kept — a token or principal
  // setup left out on purpose (a newly selected server, install.ts) stays out. A file that cannot
  // be read or parsed is overwritten as before — setup is also the repair path for a corrupt one.
  let kept: Record<string, unknown> = {};
  try {
    const existing = connectionSchema.parse(JSON.parse(await readFile(resolve(directory, 'connection.json'), 'utf8')));
    kept = Object.fromEntries(Object.entries(existing).filter(([key]) => !(key in connectionSchema.shape)));
  } catch { /* nothing kept */ }
  await atomicWrite(resolve(directory, 'connection.json'), JSON.stringify({ ...kept, ...connection }, null, 2), 0o600);
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
    instructions: 'AGENTS.md', pluginConfigured,
    herdr: options.herdr ? { previous: herdrBound?.bound ?? null, bound: pluginConfigured ? connection.url : null, relinked: !!herdrRelink && pluginConfigured } : null,
    next: connection.principal ? 'Use Herdr or the CLI to claim work, then handoff GY-N for the assigned workspace and supervisor command' : 'Supply an individual worker credential and rerun init to verify the connection' };
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
export async function scanProposal(root: string, options: { url?: string | null; runtimes?: string[]; delivery?: { mode?: DeliveryMode; candidateSchedule?: string | null; merger?: string | null } } = {}) {
  const [input, detected] = await Promise.all([collectScanInput(root), discover(root)]);
  return buildProposal(input, { repository: detected.repository, server: options.url ?? null, runtimes: options.runtimes, delivery: options.delivery });
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
    // GY-1859: what the host's loop unit runs against this CLI's code, so `doctor`'s
    // readiness checklist flags a unit on other code as one line naming both paths and the rerun.
    // Read where the units run, as doctor's setup line reads them: a self-contained host's on that host.
    loopCode: await import('./up.js').then(module => module.readInstallLoopCode(root)).catch(() => null),
  };
}

/** Repository-derived drift between a fresh scan and the stored proposal, ignoring machine-specific profile and server choices. */
export function repositoryScanDifference(fresh: SetupProposal, stored: SetupProposal): string[] {
  const repositoryPart = (proposal: SetupProposal) => canonicalJson({ ...proposal, server: null, profiles: { ...proposal.profiles, workers: [] } });
  return repositoryPart(fresh) === repositoryPart(stored) ? [] : ['The repository scan no longer matches the stored proposal'];
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
  now?: () => Date;
  token?: () => string;
  /**
   * The `graphyard install` that already owns this repository's identities (GY-1413): its install
   * directory and its confirmed App. Apply then commits only the onboarding files — it never writes
   * a second principals registry. Its App is the one a pull-request-era install recorded, else null.
   */
  installed?: { directory: string; githubApp: { appId: number; slug: string } | null };
  /** Write each worker profile's credential file (GY-1412). Explicit, never implied: only `init --apply` passes it. */
  writeCredentials?: boolean;
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
  // Derived before any write, so a declared-but-broken manifest refuses the apply instead of
  // leaving it half done: the generated-files variable is deployed beside GRAPHYARD_PRINCIPALS.
  const generatedFiles = generatedFilesAssignment(root);
  const applied: string[] = [], unchanged: string[] = [], drift: string[] = [];

  const instructionsFile = resolve(root, 'AGENTS.md');
  await regularOrMissing(instructionsFile);
  let existing = ''; try { existing = await readFile(instructionsFile, 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const instructions = managedInstructions(existing);
  if (instructions === existing) unchanged.push('AGENTS.md coordination section');
  else {
    let instructionsMode = 0o644; try { instructionsMode = (await lstat(instructionsFile)).mode & 0o777; } catch { /* new instructions */ }
    await atomicWrite(instructionsFile, instructions, instructionsMode);
    applied.push('AGENTS.md coordination section');
  }

  // The repository's documentation policy (GY-215): proposed from what the checkout holds and
  // written to its committed Graphyard configuration once; an operator's edit is drift, never overwritten.
  const documentation = await writeDocumentationConfig(root, proposeDocumentation(await collectScanInput(root)));
  (documentation.state === 'written' ? applied : documentation.state === 'unchanged' ? unchanged : drift).push(documentation.state === 'drift' ? `${repositoryConfigFile} documentation differs from the scan; the committed file was kept` : `${repositoryConfigFile} documentation policy`);

  // The merge gate and release pipeline (GY-1102): the reviewed split is the repository's
  // committed delivery policy, and the candidate and promotion workflows are rendered from it.
  const delivery = proposal.delivery ? await applyDelivery(root, proposal.delivery, proposal.stack.name) : null;
  if (delivery) { applied.push(...delivery.applied); unchanged.push(...delivery.unchanged); drift.push(...delivery.drift); }
  // GY-2009: repository setup writes no .github/workflows file; the merge writer's trial is the gate.
  // Remove a leftover generated delivery workflow when present (local or not).
  const staleWorkflow = delivery ? await removeDeliveryWorkflow(root) : null;
  if (staleWorkflow) (staleWorkflow.state === 'removed' ? applied : drift).push(staleWorkflow.state === 'removed' ? `removed ${staleWorkflow.path}: install and CI use no GitHub Actions gates` : `${staleWorkflow.path} is not the generated workflow; delete it so no Actions gate remains`);

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
  const principalsPath = resolve(directory, 'principals.json');
  if (dependencies.installed) unchanged.push(`principal and grant registry (managed by graphyard install in ${dependencies.installed.directory}; not written here)`);
  const merged = dependencies.installed ? null : await writePrincipals();
  async function writePrincipals() {
    let previous: unknown = null;
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
    return merged;
  }

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
  // An install registered its own worker profiles against its own principals; the proposal's would name identities that do not exist.
  if (!dependencies.installed) for (const profile of proposal.profiles.workers) await writeProfile(profile.name, profile);
  // Each profile's credential file is written from the registry when absent (GY-1412), outside the
  // repository with mode 0600, so no profile names a credential that does not exist.
  if (dependencies.writeCredentials && merged) for (const profile of proposal.profiles.workers) {
    const file = resolve(profile.credentialFile), token = merged.find(entry => entry.id === profile.principal)?.token;
    if (!token || file === resolve(root) || file.startsWith(`${resolve(root)}/`)) continue;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    try { await writeFile(file, `${token}\n`, { mode: 0o600, flag: 'wx' }); applied.push(`${profile.name} credential file`); }
    catch (error: any) { if (error.code !== 'EEXIST') throw error; unchanged.push(`${profile.name} credential file`); }
  }
  await writeProfile('reviewer', { provider: proposal.policy.reviewProvider, note: proposal.profiles.reviewer.note });

  const previousState = await loadAppliedSetup(root);
  // No GitHub App is registered (GY-2010): only an App an earlier, pull-request-era apply or install recorded is kept.
  const githubApp = dependencies.installed ? dependencies.installed.githubApp : previousState?.artifacts.githubApp ?? null;

  const state = appliedStateSchema.parse({ version: 1, appliedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    proposalDigest: proposalDigest(proposal), server,
    artifacts: { instructions: 'AGENTS.md', principals: dependencies.installed ? resolve(dependencies.installed.directory, 'install.json') : '.graphyard/principals.json', profiles: profileNames, githubApp } });
  const appliedPath = resolve(directory, appliedFileName);
  const sameState = previousState && canonicalJson({ ...previousState, appliedAt: '' }) === canonicalJson({ ...state, appliedAt: '' });
  if (sameState) unchanged.push('applied setup record');
  else { await atomicWrite(appliedPath, JSON.stringify(state, null, 2), 0o600); applied.push('applied setup record'); }

  const workerStep = workerPrincipals.length
    ? `${dependencies.writeCredentials ? 'each worker credential is at its profile credentialFile path' : 'place each worker credential at its profile credentialFile path'}, then claim work`
    : 'no agent runtime was detected on this machine, so the proposal declared no worker profile and no worker principal was registered; install an agent CLI and rerun init --scan --apply to add one';
  const documentationLine = documentationAssignment(documentation.policy).line;
  return { server, applied, unchanged, drift, githubApp, generatedFiles: generatedFiles?.line ?? null, documentation: { file: repositoryConfigFile, policy: documentation.policy, line: documentationLine },
    delivery: delivery ? { file: repositoryConfigFile, mode: delivery.policy.mode, requiredChecks: delivery.requiredChecks, workflows: delivery.workflows } : null,
    workerPrincipals,
    principalsFile: dependencies.installed ? null : principalsPath,
    next: dependencies.installed
      ? `The principals are the ones graphyard install deployed from ${dependencies.installed.directory}; nothing needs installing as GRAPHYARD_PRINCIPALS. Commit the onboarding files`
      : `Install the principals array as GRAPHYARD_PRINCIPALS on the Graphyard deployment${generatedFiles ? `, with ${generatedFiles.line} beside it` : ''}, ${workerStep}`,
    documentationNext: `Commit ${repositoryConfigFile} with AGENTS.md${delivery?.workflows.length ? ` and ${delivery.workflows.join(', ')}` : ''}, and set ${documentationLine} on the Graphyard deployment so every item names these documentation paths` };
}

// --- Delivery: the merge-gate policy and the release-candidate pipeline (GY-1102) ------------------

/**
 * Writes the reviewed delivery policy as `delivery` in graphyard.json, keeping every other key the
 * file holds, and renders the candidate and promotion workflows from it. The proposal was built from
 * the committed policy plus the operator's explicit choices, so writing it is how a confirmed split
 * or opt-out lands. Under per-PR no workflow is written, and generated ones left from the candidate
 * model are named for removal rather than deleted; under local they are removed.
 */
export async function applyDelivery(root: string, policyInput: DeliveryPolicy, stack: SetupProposal['stack']['name'], options: { base?: string; cli?: string } = {}) {
  const policy = deliveryPolicySchema.parse(policyInput);
  const applied: string[] = [], unchanged: string[] = [], drift: string[] = [];
  const configFile = resolve(root, repositoryConfigFile);
  await regularOrMissing(configFile);
  let text: string | null = null;
  try { text = await readFile(configFile, 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const config: Partial<RepositoryConfig> = text === null ? {} : parseRepositoryConfig(text);
  if (config.delivery && canonicalJson(config.delivery) === canonicalJson(policy)) unchanged.push(`${repositoryConfigFile} delivery policy`);
  else {
    await atomicWrite(configFile, `${JSON.stringify({ ...config, delivery: policy }, null, 2)}\n`, 0o644);
    applied.push(`${repositoryConfigFile} delivery policy (${policy.mode}: pre-merge ${policy.mergeGate.preMerge.map(entry => entry.check).join(', ') || 'none'})`);
  }
  // GY-2009: never write .github/workflows; remove leftover generated candidate/promotion workflows.
  for (const path of generatedWorkflowFiles) {
    let current: string | null = null;
    try { current = await readFile(resolve(root, path), 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    if (current === null) continue;
    if (current.split('\n', 3).includes('# Generated by graphyard init from the delivery policy in graphyard.json (docs/onboarding.md).')) { await rm(resolve(root, path)); applied.push(`removed ${path}: repository setup writes no GitHub Actions workflows`); }
    else drift.push(`${path} is not one init generated; delete it so no Actions gate remains`);
  }
  return { policy, requiredChecks: requiredPullRequestChecks(policy), workflows: [], applied, unchanged, drift };
}

// --- Documentation policy: what the repository documents, proposed from the checkout (GY-215) ----

const documentationTrees = ['docs', 'doc', 'site', 'website', 'wiki'];
const readmeFile = /^README(?:\.[A-Za-z0-9]+)?$/i, changelogFile = /^(?:CHANGELOG|CHANGES|HISTORY)(?:\.[A-Za-z0-9]+)?$/i;
/**
 * The documentation paths a repository actually holds: its documentation trees (docs/, site/, a
 * wiki), its root README and agent contract, per-package READMEs as one glob per package root, and
 * the root changelog. A repository with none of them is proposed its README, the one page every
 * repository is expected to keep.
 */
export function proposeDocumentation(input: Pick<ScanInput, 'files'>): DocumentationPolicy {
  const paths: string[] = [];
  const add = (path: string) => { if (!paths.includes(path)) paths.push(path); };
  for (const tree of documentationTrees) if (input.files.some(file => file.startsWith(`${tree}/`))) add(`${tree}/`);
  const root = input.files.filter(file => !file.includes('/'));
  for (const file of root.filter(file => readmeFile.test(file)).sort()) add(file);
  if (root.includes('AGENTS.md')) add('AGENTS.md');
  for (const file of input.files.filter(file => file.includes('/') && readmeFile.test(file.split('/').at(-1)!)).sort()) {
    const segments = file.split('/');
    // A README inside a documentation tree is already covered; one under a hidden tooling directory is not published documentation.
    if (documentationTrees.includes(segments[0]) || segments.some(segment => segment.startsWith('.'))) continue;
    // packages/api/README.md → packages/*/README.md: every package of that root, present and future.
    add(segments.length === 3 ? `${segments[0]}/*/${segments[2]}` : file);
  }
  const changelog = root.filter(file => changelogFile.test(file)).sort((a, b) => Number(b === 'CHANGELOG.md') - Number(a === 'CHANGELOG.md') || a.localeCompare(b))[0] ?? null;
  return documentationPolicySchema.parse({ paths: paths.length ? paths : ['README.md'], changelog });
}

/**
 * Write the policy into the repository's committed Graphyard configuration. A configuration that
 * already declares one is the repository's own choice: it is kept, and a difference from the scan
 * is reported as drift, exactly as an operator-tuned profile is.
 */
export async function writeDocumentationConfig(root: string, proposed: DocumentationPolicy): Promise<{ state: 'written' | 'unchanged' | 'drift'; policy: DocumentationPolicy }> {
  const file = resolve(root, repositoryConfigFile);
  await regularOrMissing(file);
  let existing: string | null = null;
  try { existing = await readFile(file, 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if (existing !== null) {
    const policy = parseRepositoryConfig(existing).documentation;
    // A scan never proposes a word budget (GY-574), so a committed one is the repository's own and no drift.
    const { wordBudget: _budget, ...scanned } = policy;
    return { state: canonicalJson(scanned) === canonicalJson(proposed) ? 'unchanged' : 'drift', policy };
  }
  await atomicWrite(file, `${JSON.stringify({ documentation: proposed }, null, 2)}\n`, 0o644);
  return { state: 'written', policy: proposed };
}

/**
 * The documentation policy a checkout's committed configuration declares, or null when it has none.
 * A word budget is not part of the policy the control plane is deployed with: it is read from the
 * committed file at each counted commit (GY-574), so it is left out here and never reads as drift.
 */
export async function readDocumentationConfig(root: string): Promise<DocumentationPolicy | null> {
  try { const { wordBudget: _budget, ...policy } = parseRepositoryConfig(await readFile(resolve(root, repositoryConfigFile), 'utf8')).documentation; return policy; }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}

// GY-1859: a running unit is not proof the install runs the right code. The loop serving a
// repository may be a process an earlier checkout left behind: it answers, the setup checklist
// reads it as green, and every fix merged since is invisible to it. So the master-loop step of
// `graphyard up` reads what its units actually run — the checkout and launcher each ExecStart
// names, and the commit the loop recorded loading on its cursor — and compares them with the CLI
// running the command. A unit on other code is rewritten onto this CLI and restarted through
// systemd; `doctor` flags the same mismatch as one line naming both paths and the rerun.

/** What one of the install's units runs, read beside the install's own record (GY-1859). */
export interface UnitCode {
  unit: string; path: string;
  /** The checkout the unit loads its code from: the directory above the launcher its ExecStart starts, else its WorkingDirectory. */
  checkout: string | null;
  /** The checkout above the Graphyard launcher its ExecStart starts; null when it names none and `checkout` fell back to the WorkingDirectory. */
  launcher?: string | null;
}
/** GY-1859: the loop code this install's units run, against the CLI running the command. */
export interface LoopCodeReading {
  /** The master loop's unit; null while none is installed for the units this checkout records. */
  loop: UnitCode | null;
  /** The commit the running loop recorded loading (its cursor's release); null when none is recorded. */
  loopCommit: string | null;
  /** The CLI running this command: the checkout it runs from and that checkout's commit. */
  cli: { root: string; commit: string | null };
  /** The managed repository, as master.json records it: whose units these are, and what a rerun names. */
  repository: string | null;
  /** Why the loop is not known to run this CLI's commit — another checkout, another or no recorded commit, a dirty load — or null. */
  loopStale: string | null;
  /** What replaces a stale loop: `unit` when its unit starts another checkout (the unit is rewritten), `restart` when it names this checkout but the process runs other code. */
  loopReplace?: 'unit' | 'restart' | null;
  /** The host the units were read on, for a host install; absent or null on this machine. */
  host?: string | null;
  /** Why the reading could not be taken at all; null when it was. */
  error: string | null;
}
const canonicalPath = (path: string) => { const absolute = resolve(path); try { return realpathSync(absolute); } catch { return absolute; } };
const shortSha = (commit: string | null | undefined) => commit ? String(commit).slice(0, 12) : 'no commit';
/** The checkout a unit runs its code from: the directory above the launcher its ExecStart names — `bin/graphyard.mjs` or a pin's `dist/cli.js` — else its WorkingDirectory (GY-1859). A unit naming neither reads as its WorkingDirectory, so a unit this install wrote never reads as foreign. */
function unitCodeCheckout(text: string, home: string): string | null {
  return unitLauncherCheckout(text, home) ?? unitCheckout(text, home).workingDirectory;
}
/** The one ExecStart wording both readers share, defined beside `unitCheckout` in `src/install/units.ts` (GY-1880). */
export { systemdCommandLineWords };
/** The checkout whose Graphyard launcher a unit's ExecStart starts, null when it names none: the executable alone, never the rest of the unit (GY-1859). The line is worded by systemd's own quoting rules (GY-1880), so a launcher `loopUnitText` spelled quoted for a path holding whitespace reads back as exactly that checkout. */
export function unitLauncherCheckout(text: string, home: string): string | null {
  const start = unitCheckout(text, home).execStart;
  const launcher = start ? systemdCommandLineWords(start).find(part => /(?:bin\/graphyard\.mjs|dist\/cli\.js)$/.test(part)) : undefined;
  return launcher ? dirname(dirname(launcher)) : null;
}
/** Under the test runner only a unit directory under the system temporary directory is read, as legacyUnitFiles guards: the operator's real units belong to no checkout a test made. */
const readableUnitsDirectory = (unitDirectory: string) => {
  const underTestRunner = !!process.env.NODE_TEST_CONTEXT || process.execArgv.includes('--test') || process.env.npm_lifecycle_event === 'test';
  if (!underTestRunner) return true;
  const temporary = canonicalPath(tmpdir());
  return `${canonicalPath(unitDirectory)}${sep}`.startsWith(`${temporary}${sep}`);
};
/** The loop's cursor, beside its credential as daemonStatePath keeps it: what reports the commit the running loop loaded. */
const loopCursorPath = (credentialFile: string) => `${dirname(credentialFile)}/${basename(credentialFile).replace(/\.token$/, '')}.daemon.json`;
const failureText = (failure: unknown) => failure instanceof Error ? failure.message.split('\n')[0] : String(failure);

/**
 * Where a reading's files live (GY-1859): this machine's file system, or a host install's through its
 * transport. `read` answers null only for a file that does not exist and throws on any other failure,
 * and `list` answers [] only for a directory that does not exist, so a reading never mistakes a
 * refused read for an absent unit or cursor.
 */
export interface LoopCodeFiles { read(path: string): Promise<string | null>; list(directory: string): Promise<string[]> }
export const localLoopCodeFiles: LoopCodeFiles = {
  read: async path => { try { return await readFile(path, 'utf8'); } catch (error: any) { if (error?.code === 'ENOENT') return null; throw new Error(`${path} could not be read: ${error?.code ?? error?.message ?? error}`); } },
  list: async directory => { try { return await readdir(directory); } catch (error: any) { if (error?.code === 'ENOENT') return []; throw new Error(`${directory} could not be read: ${error?.code ?? error?.message ?? error}`); } },
};
/** What the judgement reads (GY-1859): the loop's unit and cursor, beside the code it must run. */
export interface LoopCodeFacts {
  /** The CLI whose code the units must run: its checkout and that checkout's commit. */
  cli: { root: string; commit: string | null };
  /** The managed repository's checkout. */
  primary: string;
  repository: string | null;
  loop: UnitCode | null;
  /** The loop cursor's text; null when none is written. */
  cursor: string | null;
  host?: string | null;
  /** How a path is compared: realpath on this machine, the path itself on a host. */
  canonical?: (path: string) => string;
}
/**
 * The judgement itself (GY-1859): a loop runs this CLI's code only when its unit starts this CLI's
 * checkout (or the repository's, a unit naming no launcher) and its cursor records loading exactly
 * this CLI's commit from a clean tree. A cursor naming no commit is not proof, and neither is a
 * known-good pin or held snapshot on another commit: those are this install's machinery, but the
 * command asked for this CLI's code.
 */
export function judgeLoopCode(facts: LoopCodeFacts): LoopCodeReading {
  const canonical = facts.canonical ?? canonicalPath;
  const { cli, loop } = facts;
  const base: LoopCodeReading = { loop, loopCommit: null, cli, repository: facts.repository, loopStale: null, loopReplace: null, host: facts.host ?? null, error: null };
  if (!loop) return base;
  if (!cli.commit) return { ...base, error: `the commit of this CLI's checkout (${cli.root}) could not be read, so no unit is judged against it` };
  const own = new Set([cli.root, facts.primary].map(canonical));
  let release: { commit: string | null; dirty: boolean | null } = { commit: null, dirty: null };
  try { const recorded = facts.cursor === null ? null : JSON.parse(facts.cursor)?.release; release = { commit: typeof recorded?.commit === 'string' ? recorded.commit : null, dirty: typeof recorded?.dirty === 'boolean' ? recorded.dirty : null }; } catch { /* an unreadable cursor records nothing */ }
  const same = (commit: string | null | undefined, expected: string | null) => !!commit && !!expected && commit.toLowerCase() === expected.toLowerCase();
  let loopStale: string | null = null, loopReplace: LoopCodeReading['loopReplace'] = null;
  {
    // The loop always starts a CLI, never the repository's own entry, so a launcher its ExecStart
    // names must be this CLI's: one in the managed checkout (Graphyard managing itself from a second
    // checkout) loads that checkout's code on every restart, so only a rewrite moves it. The
    // repository checkout is accepted only as the WorkingDirectory of a unit naming no launcher.
    const foreign = loop.launcher ? canonical(loop.launcher) !== canonical(cli.root) : !!loop.checkout && !own.has(canonical(loop.checkout));
    if (foreign) { loopStale = `${loop.path} starts the CLI in ${loop.checkout}${release.commit ? ` at ${shortSha(release.commit)}` : ''}, not this checkout (${cli.root}) at ${shortSha(cli.commit)}`; loopReplace = 'unit'; }
    else if (!release.commit) { loopStale = `${loop.path} runs a loop whose cursor records no commit it loaded, so it is not known to run this checkout's ${shortSha(cli.commit)}`; loopReplace = 'restart'; }
    else if (!same(release.commit, cli.commit)) { loopStale = `${loop.path} runs ${shortSha(release.commit)}, not this checkout's ${shortSha(cli.commit)}`; loopReplace = 'restart'; }
    else if (release.dirty === true) { loopStale = `${loop.path} runs ${shortSha(release.commit)} with uncommitted changes it loaded, not this checkout's clean ${shortSha(cli.commit)}`; loopReplace = 'restart'; }
  }
  return { ...base, loopCommit: release.commit, loopStale, loopReplace };
}

/**
 * What the install at ROOT runs, against the CLI running this command (GY-1859): the units ROOT
 * records and the cursor beside the master credential, judged by judgeLoopCode.
 * Every host reach is injectable, so tests judge the judgement itself, never this machine.
 */
export async function readLoopCode(root: string, options: {
  /** The launcher of the CLI running this command; default this process's own checkout's. */
  cliPath?: string;
  /** Runs git for the CLI checkout's commit. */
  run?: (command: string, args: string[]) => string;
  /** The units ROOT records; default readInstallUnits; null forces none. */
  units?: InstallUnits | null;
  unitDirectory?: string;
  home?: string;
  /** The master configuration; default .graphyard/master.json in ROOT. */
  master?: { cliPath?: string | null; credentialFile?: string | null; repository?: string | null } | null;
  /** The loop cursor's text; default read beside the master credential. */
  cursor?: string | null;
  files?: LoopCodeFiles;
} = {}): Promise<LoopCodeReading> {
  const run = options.run ?? ((command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }));
  const files = options.files ?? localLoopCodeFiles;
  const unitDirectory = options.unitDirectory ?? userUnitDirectory(), home = options.home ?? homedir();
  const cliPath = options.cliPath ?? fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
  const cliRoot = coordinatorCheckoutRoot(cliPath);
  const head = (checkout: string) => { try { return run('git', ['-C', checkout, 'rev-parse', 'HEAD']).trim() || null; } catch { return null; } };
  const cliCommit = head(cliRoot);
  const primary = await (async () => { try { return connectionRoots(root)[0]; } catch { return root; } })();
  let master = options.master !== undefined ? options.master : null;
  if (options.master === undefined) { try { master = JSON.parse(await readFile(resolve(root, '.graphyard', 'master.json'), 'utf8')); } catch { master = null; } }
  const repository = typeof master?.repository === 'string' ? master.repository : null;
  const failed = (failure: unknown): LoopCodeReading => ({ loop: null, loopCommit: null, cli: { root: cliRoot, commit: cliCommit }, repository, loopStale: null, loopReplace: null, host: null, error: failureText(failure) });
  let units: InstallUnits | null;
  if (options.units !== undefined) units = options.units;
  else if (!readableUnitsDirectory(unitDirectory)) units = null;
  else { try { units = readInstallUnits(root, unitDirectory, home); } catch (failure) { return failed(failure); } }
  try {
    const unit = async (name: string): Promise<UnitCode | null> => { const path = resolve(unitDirectory, name), text = units ? await files.read(path) : null; return text === null ? null : { unit: name, path, checkout: unitCodeCheckout(text, home), launcher: unitLauncherCheckout(text, home) }; };
    const loop = units ? await unit(units.master) : null;
    const credentialFile = typeof master?.credentialFile === 'string' ? resolve(master.credentialFile) : null;
    const cursor = !loop ? null : options.cursor !== undefined ? options.cursor : credentialFile ? await files.read(loopCursorPath(credentialFile)) : null;
    return judgeLoopCode({ cli: { root: cliRoot, commit: cliCommit }, primary, repository, loop, cursor });
  } catch (failure) { return failed(failure); }
}

/** A host install's layout, as far as the reading of its units reaches (install/host's HostLayout). */
export interface HostLoopLayout { home: string; graphyard: string; checkout: string; userUnitDirectory: string }
/**
 * GY-1859: what a host install's loop runs, read on the host through its transport.
 * There the loop starts the host's own Graphyard checkout (LAYOUT.graphyard), which install places
 * at the installer's commit (REF): the CLI whose code they must run is that checkout at REF, so a
 * host checkout left at an earlier commit, or a loop still on what it loaded before, is
 * other code exactly as on this machine. `run` executes a program on the host (cat, ls, git).
 */
export async function readHostLoopCode(run: (program: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>, layout: HostLoopLayout, ref: string, host: string): Promise<LoopCodeReading> {
  const absent = (stderr: string) => /No such file/i.test(stderr);
  const files: LoopCodeFiles = {
    read: async path => { const result = await run('cat', [path]); if (result.code === 0) return result.stdout; if (absent(result.stderr)) return null; throw new Error(`${path} on ${host} could not be read: ${result.stderr.trim() || `exit ${result.code}`}`); },
    list: async directory => { const result = await run('ls', ['-1', directory]); if (result.code === 0) return result.stdout.split('\n').filter(Boolean); if (absent(result.stderr)) return []; throw new Error(`${directory} on ${host} could not be read: ${result.stderr.trim() || `exit ${result.code}`}`); },
  };
  const cli = { root: layout.graphyard, commit: ref };
  const failed = (failure: unknown): LoopCodeReading => ({ loop: null, loopCommit: null, cli, repository: null, loopStale: null, loopReplace: null, host, error: failureText(failure) });
  try {
    const { installUnitsFile, parseInstallUnits, unrecordedInstallUnits, legacyLoopUnit, legacyExecutorTemplate } = await import('./install/units.js');
    const recorded = await files.read(`${layout.checkout}/${installUnitsFile}`);
    const legacy = recorded === null ? await Promise.all([legacyLoopUnit, legacyExecutorTemplate].map(async name => ({ path: `${layout.userUnitDirectory}/${name}`, text: await files.read(`${layout.userUnitDirectory}/${name}`) }))) : [];
    const units = parseInstallUnits(recorded, `${layout.checkout}/${installUnitsFile} on ${host}`, () => unrecordedInstallUnits(layout.checkout, legacy, layout.home));
    const masterText = await files.read(`${layout.checkout}/.graphyard/master.json`);
    const master = masterText === null ? null : JSON.parse(masterText);
    const unit = async (name: string): Promise<UnitCode | null> => { const path = `${layout.userUnitDirectory}/${name}`, text = await files.read(path); return text === null ? null : { unit: name, path, checkout: unitCodeCheckout(text, layout.home), launcher: unitLauncherCheckout(text, layout.home) }; };
    const loop = await unit(units.master);
    const credentialFile = typeof master?.credentialFile === 'string' ? master.credentialFile : null;
    const cursor = loop && credentialFile ? await files.read(loopCursorPath(credentialFile)) : null;
    return judgeLoopCode({ cli, primary: layout.checkout, repository: typeof master?.repository === 'string' ? master.repository : null, loop, cursor, host, canonical: path => path.replace(/\/+$/, '') });
  } catch (failure) { return failed(failure); }
}
/**
 * GY-1859: the pins that hold this install's loop on code other than this CLI's, lifted so
 * a replacement starts this CLI. `loopUnitText` renders the known-good coordinator's launcher while
 * its pin stands (GY-1529), and the unit and `master init` start the held
 * snapshot's while a held restart's pointer stands (GY-1790): a rewrite under either comes back on
 * the pinned commit, and the loop's own alignment would put a unit rewritten past them back. The
 * pin's record is kept beside it (`coordinator/lifted.json`, whose pin `master recover --to SHA`
 * restores) and the held pointer is removed, its snapshot left; the next promotion pins afresh.
 * Returns what was lifted, one phrase each; nothing standing lifts nothing.
 */
export async function liftLoopPins(root: string, options: { installDir?: string | null; repository?: string | null; /** GY-1899: the checkout the running CLI comes from, where the held snapshot's pointer lives; default ROOT. */ heldRoot?: string } = {}): Promise<string[]> {
  const [{ knownGoodDirectory, knownGoodState }, { heldCliPointer, readHeldCli }] = await Promise.all([import('./master/known-good.js'), import('./daemon/held-cli.js')]);
  const installDir = options.installDir !== undefined ? options.installDir : await (async () => {
    if (!options.repository) return null;
    const [{ installDirectory }, { installIdFor }] = await Promise.all([import('./install/secrets.js'), import('./install/types.js')]);
    try { return installDirectory(installIdFor(options.repository)); } catch { return null; }
  })();
  const lifted: string[] = [];
  const pin = installDir ? knownGoodState(installDir) : null;
  if (installDir && pin) {
    const directory = knownGoodDirectory(installDir);
    await rename(join(directory, 'state.json'), join(directory, 'lifted.json'));
    lifted.push(`the known-good pin at ${shortSha(pin.sha)} (${join(directory, 'state.json')}, kept as lifted.json)`);
  }
  // GY-1899: the held snapshot's pointer lives under the checkout the running CLI comes from
  // (`heldRoot`), where the loop's holdCliAt wrote it — the managed root holds none of it.
  const heldRoot = options.heldRoot ?? root;
  const held = readHeldCli(heldRoot);
  if (held) {
    await rm(heldCliPointer(heldRoot), { force: true });
    lifted.push(`the held snapshot at ${shortSha(held)} (${heldCliPointer(heldRoot)})`);
  }
  return lifted;
}

/**
 * A managed worktree must build against dependencies installed from its own lockfile. The worker
 * launcher shares the coordinator checkout's install when the lockfiles match byte for byte
 * (master.ts shareDependencies) and otherwise used to leave the worktree resolving that install by
 * the runtime's upward lookup — the wrong versions, discovered only as a failing test run. What an
 * install actually holds is npm's hidden lockfile, `node_modules/.package-lock.json`: every
 * installed package with its version and integrity. The install answers for a checkout when every
 * package it holds is the one the checkout's lockfile names and every package the lockfile requires
 * is installed: an optional package too when its os, cpu and libc admit this host (esbuild's binary,
 * @embedded-postgres/*), since an omit=optional install or a discarded optional build leaves the
 * tree unable to run; only an optional package for another platform, or an optional peer, may be absent.
 */
export function installMatchesLockfile(lockfile: LockfileInventory, installed: { packages?: Record<string, any> } | null, host: InstallHost = currentInstallHost()): true | string {
  if (!installed?.packages) return 'the install records no hidden lockfile (node_modules/.package-lock.json)';
  const wanted = lockfilePackages(lockfile), held = installed.packages;
  for (const [name, entry] of Object.entries(held)) {
    const want = wanted[name];
    if (!want) return `${name} is installed but package-lock.json no longer names it`;
    // A v1 record of a git, file, link or tarball dependency keeps its source in `version`; npm's hidden
    // lockfile records the package's own version instead, so only its integrity identifies it.
    if (!want[legacySource] && want.version !== entry.version) return `${name} is installed at ${entry.version ?? 'no version'}, package-lock.json names ${want.version ?? 'no version'}`;
    if (want.integrity && entry.integrity && want.integrity !== entry.integrity) return `${name} is installed from a different tarball than package-lock.json names`;
    // Nor does a v1 record's source always carry an integrity (a git dependency never does): the
    // source it names must be the one the install recorded, or the install is not this lockfile's.
    if (want[legacySource]) {
      if (!legacySourceMatches(want, entry)) return `${name} is installed from ${entry.resolved ?? 'no recorded source'}, package-lock.json names ${want.version}`;
      continue;
    }
    // A git, file or link dependency carries its identity in `resolved` or `link`, usually with no integrity.
    if (Boolean(want.link) !== Boolean(entry.link)) return `${name} is installed ${entry.link ? 'as a link' : 'as a package'}, package-lock.json names ${want.link ? 'a link' : 'a package'}`;
    if ((!want.integrity || !entry.integrity) && (want.resolved ?? null) !== (entry.resolved ?? null)) return `${name} is installed from ${entry.resolved ?? 'no recorded source'}, package-lock.json names ${want.resolved ?? 'no recorded source'}`;
  }
  for (const [name, entry] of Object.entries(wanted)) {
    if (!name || held[name]) continue;
    if (!entry.optional && !entry.devOptional) return `${name} is named by package-lock.json but not installed`;
    if (!entry.peer && !entry[platformUnrecorded] && platformAdmits(entry, host)) return `${name} is an optional package for this platform (${host.os} ${host.cpu}${host.libc ? ` ${host.libc}` : ''}) named by package-lock.json but not installed`;
  }
  return true;
}

export interface LockfileInventory { lockfileVersion?: number; packages?: Record<string, any>; dependencies?: Record<string, any> }
/** Marks a v1 record whose `version` is its source, not a version; and a v1 record, whose platform is unrecorded. */
const legacySource = Symbol('legacySource'), platformUnrecorded = Symbol('platformUnrecorded');
/**
 * The lockfile's packages keyed by install path, as npm's hidden lockfile keys them. A lockfileVersion 1
 * file has no `packages`, only the nested `dependencies` tree, which is unfolded into the same
 * `node_modules/<name>[/node_modules/<name>]` paths. v1 records carry no os/cpu/libc, so an optional one
 * is never required here (it may be for another platform).
 */
function lockfilePackages(lockfile: LockfileInventory): Record<string, any> {
  if (lockfile.packages || !lockfile.dependencies) return lockfile.packages ?? {};
  const packages: Record<string, any> = {};
  const unfold = (dependencies: Record<string, any>, prefix: string) => {
    for (const [name, entry] of Object.entries(dependencies ?? {})) {
      const path = `${prefix}node_modules/${name}`;
      const plain = typeof entry.version === 'string' && /^\d+\.\d+\.\d+/.test(entry.version);
      packages[path] = { version: entry.version, resolved: entry.resolved, integrity: entry.integrity, optional: entry.optional, dev: entry.dev, [platformUnrecorded]: true, ...(plain ? {} : { [legacySource]: true }) };
      if (entry.dependencies) unfold(entry.dependencies, `${path}/`);
    }
  };
  unfold(lockfile.dependencies, '');
  return packages;
}

/**
 * Whether a v1 git, file, link or tarball record names the source the install recorded. npm writes
 * a git source in several spellings (git+ssh://git@host/owner/repo.git#sha, git+https://…, github:
 * owner/repo#sha), so a git source is its repository path and commit; any other is its location
 * without a `file:` prefix. A source that cannot be matched is a mismatch: npm ci reinstalls it.
 */
function legacySourceMatches(want: { version?: string; resolved?: string }, entry: { resolved?: string; link?: boolean }) {
  const installed = sourceIdentity(entry.resolved);
  return installed !== null && [want.version, want.resolved].some(source => sourceIdentity(source) === installed);
}
function sourceIdentity(source: string | undefined): string | null {
  if (!source) return null;
  const git = source.match(/^(?:git\+[a-z+]+:\/\/(?:[^@/]+@)?[^/:]+[/:]|git:\/\/[^/]+\/|git@[^:]+:|github:|)([^#:/@]+\/[^#:/]+?)(?:\.git)?#([0-9a-f]{7,40})$/i);
  if (git && /^(git|github:)/i.test(source)) return `git:${git[1].toLowerCase()}#${git[2].toLowerCase()}`;
  return source.replace(/^file:/, '');
}

export interface InstallHost { os: string; cpu: string; libc: string | null }
function currentInstallHost(): InstallHost {
  const header = process.platform === 'linux' ? (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header : undefined;
  return { os: process.platform, cpu: process.arch, libc: process.platform === 'linux' ? (header?.glibcVersionRuntime ? 'glibc' : 'musl') : null };
}
/** npm's rule for a package's os/cpu/libc lists: a `!value` excludes, and any plain value makes the list an allowlist. */
function platformAdmits(entry: { os?: string[]; cpu?: string[]; libc?: string[] }, host: InstallHost) {
  const admits = (list: string[] | undefined, value: string | null) => {
    if (!list?.length) return true;
    if (value === null) return false;
    if (list.includes(`!${value}`)) return false;
    const allowed = list.filter(item => !item.startsWith('!'));
    return !allowed.length || allowed.includes(value);
  };
  return admits(entry.os, host.os) && admits(entry.cpu, host.cpu) && (!entry.libc?.length || admits(entry.libc, host.libc));
}

/** The dependency tree the runtime resolves from `worktree`: its own, the install its mirror links to, or the nearest one above it. */
async function resolvedInstall(worktree: string): Promise<string | null> {
  const own = resolve(worktree, 'node_modules');
  if (await lstat(own).catch(() => null)) {
    const mirrored = (await readFile(resolve(own, '.graphyard-shared'), 'utf8').catch(() => '')).trim();
    return mirrored || own;
  }
  for (let directory = dirname(worktree), parent = dirname(directory); ; directory = parent, parent = dirname(directory)) {
    const candidate = resolve(directory, 'node_modules');
    if ((await lstat(candidate).catch(() => null))?.isDirectory()) return candidate;
    if (parent === directory) return null;
  }
}

function parseJson(text: string): any {
  try { return JSON.parse(text); } catch (error) { return error instanceof Error ? error : new Error(String(error)); }
}

export type DependencyInstaller = (cwd: string, signal?: AbortSignal) => Promise<void>;
/** `npm ci` in the worktree, the full tree (npmCiArgs), its output on stderr so a caller's JSON on stdout stays whole. */
export const npmCi: DependencyInstaller = (cwd, signal) => new Promise((done, fail) => {
  // Contained (containedInstall): the lifecycle scripts it runs cannot open a credential file.
  // An aborted signal stops bubblewrap (SIGTERM), which takes npm with it, and rejects with the abort.
  const { command, args } = containedInstall(cwd);
  const child = spawn(command, args, { cwd, env: npmCiEnvironment(), stdio: ['ignore', 2, 2], ...(signal ? { signal } : {}) });
  child.once('error', fail);
  child.once('close', code => code === 0 ? done() : fail(new Error(`npm ci exited with ${code}`)));
});
export interface WorktreeDependencyReport { state: 'current' | 'installed' | 'failed' | 'none'; install: string | null; reason: string }

/**
 * Make `worktree` resolve dependencies installed from its own package-lock.json: nothing is done
 * when the install it resolves already matches, and `install` (npm ci) runs in the worktree when it
 * does not — a changed lockfile, or no install at all. A failed install is reported, never thrown:
 * the worktree still exists for the session, which sees the reason. An install stopped through
 * `signal` is thrown instead, with the signal's reason: the caller no longer holds the right to it.
 */
export async function ensureWorktreeDependencies(worktree: string, install: DependencyInstaller = npmCi, signal?: AbortSignal): Promise<WorktreeDependencyReport> {
  const text = await readFile(resolve(worktree, 'package-lock.json'), 'utf8').catch(() => null);
  if (text === null) return { state: 'none', install: null, reason: 'The checkout has no package-lock.json; nothing is installed for it' };
  const lockfile = parseJson(text);
  if (lockfile instanceof Error) return { state: 'failed', install: null, reason: `The checkout's package-lock.json cannot be parsed (${lockfile.message}); nothing was installed for it` };
  const current = await resolvedInstall(worktree);
  const matches = !current ? `no node_modules is reachable from ${worktree}` : await installMatches(lockfile, current);
  if (matches === true) return { state: 'current', install: current, reason: `${current} was installed from this package-lock.json` };
  const own = resolve(worktree, 'node_modules');
  signal?.throwIfAborted();
  try { await install(worktree, signal); }
  catch (error) { if (signal?.aborted) throw signal.reason; return { state: 'failed', install: current, reason: `package-lock.json differs from the install (${matches}), and installing it failed: ${error instanceof Error ? error.message : String(error)}` }; }
  // npm can exit 0 having installed nothing or less (a dry-run or omit config from an .npmrc): the
  // install is reported only once its own hidden lockfile matches the checkout's.
  const after = await installMatches(lockfile, own);
  if (after !== true) return { state: 'failed', install: own, reason: `package-lock.json differs from the install (${matches}), and npm ci exited 0 without installing it: ${after}` };
  return { state: 'installed', install: own, reason: `package-lock.json differs from the install it resolved (${matches}); installed its own` };
}

async function installMatches(lockfile: LockfileInventory, install: string): Promise<true | string> {
  // A hidden lockfile an interrupted install left truncated is a mismatched install: npm ci replaces it.
  const installed = parseJson(await readFile(resolve(install, '.package-lock.json'), 'utf8').catch(() => 'null'));
  if (installed instanceof Error) return `the install's hidden lockfile (${resolve(install, '.package-lock.json')}) is unreadable: ${installed.message}`;
  const matches = installMatchesLockfile(lockfile, installed);
  return matches === true ? installFoldersExist(installed, install) : matches;
}

/**
 * npm counts a hidden lockfile as the install only while every package folder it names exists: a
 * deleted or half-removed `node_modules/<pkg>` under an intact `.package-lock.json` is a broken
 * install. Paths are relative to the directory holding node_modules (the mirror's target for a
 * shared install); a link entry, or a folder reached through a symlink, must resolve.
 */
async function installFoldersExist(installed: { packages?: Record<string, any> }, install: string): Promise<true | string> {
  const root = dirname(install);
  const names = Object.keys(installed.packages ?? {}).filter(Boolean);
  const missing = await Promise.all(names.map(async name => (await stat(resolve(root, name)).catch(() => null))?.isDirectory() ? null : name));
  const first = missing.find(name => name !== null);
  if (first) return `${first} is recorded in the install's hidden lockfile but its folder ${resolve(root, first)} is missing`;
  return binLinksExist(installed, root);
}

/**
 * An install made with bin-links=false holds every package folder but no node_modules/.bin, so
 * tsc and tsx never run from it. Each executable a package declares is linked in the .bin of the
 * node_modules that holds the package (npm's layout, a nested one for a nested package); the link
 * must resolve. On Windows npm writes a .cmd shim beside it, which counts.
 */
async function binLinksExist(installed: { packages?: Record<string, any> }, root: string): Promise<true | string> {
  const links = Object.entries(installed.packages ?? {}).flatMap(([path, entry]) => {
    const at = path.lastIndexOf('node_modules/');
    if (at < 0 || entry?.link || !entry?.bin || typeof entry.bin !== 'object') return [];
    return Object.keys(entry.bin).map(name => ({ path, link: resolve(root, path.slice(0, at), 'node_modules', '.bin', name) }));
  });
  const absent = await Promise.all(links.map(async entry => (await stat(entry.link).catch(() => null)) || (await stat(`${entry.link}.cmd`).catch(() => null)) ? null : entry));
  const first = absent.find(entry => entry !== null);
  return first ? `${first.path} declares the executable ${first.link}, which the install never linked (an install made with bin-links=false)` : true;
}
