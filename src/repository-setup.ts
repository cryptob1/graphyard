import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { localDirectory, saveDiscovery } from './onboarding.js';

export const hostIdSchema = z.string().trim().min(1).max(200);
export const connectionSchema = z.object({ url: z.string(), cliPath: z.string(), hostId: hostIdSchema, token: z.string().min(32).optional(), principal: z.string().optional() }).strict();
export type Connection = z.infer<typeof connectionSchema>;
export function serverOrigin(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Use an HTTPS server origin, or HTTP on loopback; no credentials, query, or path');
  return url.origin;
}
export async function loadConnection(cwd: string): Promise<Connection | null> {
  let roots: string[];
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    roots = [...new Set([git('rev-parse', '--show-toplevel'), dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir'))])];
  } catch { return null; }
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

Submit the PR with \`complete GY-N EPOCH PR_NUMBER\`. This reports implementation
completion; it does not set Done. CI, trusted evidence, independent review, and
Graphyard's merge gate decide progression. Report blockers explicitly.
Never use an operator/producer token for implementation or weaken proof requirements.
Herdr runs sessions; Graphyard remains the source of ownership truth.
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
  if (connection.token) {
    let response: Response;
    try { response = await (options.fetcher ?? fetch)(`${connection.url}/api/status`, { headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(15000) }); } catch { throw new Error('Cannot reach Graphyard; setup has not saved credentials'); }
    if (!response.ok) throw new Error(`Graphyard rejected the credential (${response.status}); setup has not saved it`);
    const status = await response.json();
    if (status.actor?.role !== 'worker') throw new Error('Repository worker setup requires a worker credential; operator, producer, and reader tokens are not suitable for launching workers');
    connection.principal = status.actor.id;
  }
  const instructionsFile = resolve(root, 'AGENTS.md'); await regularOrMissing(instructionsFile);
  let existing = ''; try { existing = await readFile(instructionsFile, 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const instructions = managedInstructions(existing, connection.url);
  const runHerdr = options.runHerdr ?? ((args: string[]) => {
    try { return execFileSync('herdr', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { throw new Error('Herdr setup command failed; check installation and rerun init. No credentials were printed.'); }
  });
  if (options.herdr) runHerdr(['plugin', '--help']);
  const directory = await localDirectory(root);
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
    note: 'Handoff does not start a worker or renew ownership. Keep the lease alive while preparing, then start the supervisor.' };
}
