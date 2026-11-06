// Concern: the merge writer's deploy key (GY-1551) — one ed25519 key pair under the install
// directory, registered read-write on the repository through the operator's `gh` login, idempotently.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import { resolve } from 'node:path';
import type { GitHubCli } from './github.js';
import { commandFailure, type CommandResult } from './transport.js';

/** The private key's name under the install directory; `merge-writer-settings.ts` reads it from the same place. */
export const DEPLOY_KEY_FILE = 'deploy-key';
/** The registered key's title names the host whose merge writer pushes with it. */
export const deployKeyTitle = (host: string) => `graphyard-merge-writer-${host}`;

export interface DeployKeyOptions {
  /** Runs `ssh-keygen` with ARGS; the default spawns the host's. Tests substitute a fake that writes the pair. */
  keygen?: (args: string[]) => Promise<CommandResult>;
  /** Runs `ssh` with ARGS (the push probe of a login that cannot list keys); the default spawns the host's. */
  ssh?: (args: string[]) => Promise<CommandResult>;
  /** The host named in the key's title; the machine's hostname by default. */
  hostname?: string;
}

function sshKeygen(args: string[]): Promise<CommandResult> {
  return new Promise((accept, reject) => {
    execFile('ssh-keygen', args, { encoding: 'utf8', timeout: 60_000, windowsHide: true }, (error: any, stdout, stderr) => {
      if (!error) return accept({ stdout: String(stdout), stderr: String(stderr), code: 0 });
      reject(commandFailure('ssh-keygen', { stdout: String(stdout ?? ''), stderr: String(stderr ?? error.message ?? ''), code: Number.isInteger(error.code) ? error.code : 1 }));
    });
  });
}

/**
 * An `ssh` run whose failure is an answer, not an exception: the push probe reads its exit code
 * (0 is the ref advertisement a write key receives). Standard input is closed, so the probe sends
 * nothing after the advertisement — no push is ever made.
 */
function sshProbeRun(args: string[]): Promise<CommandResult> {
  return new Promise(accept => {
    const child = execFile('ssh', args, { encoding: 'utf8', timeout: 60_000, windowsHide: true }, (error: any, stdout, stderr) => {
      accept({ stdout: String(stdout ?? ''), stderr: String(stderr ?? error?.message ?? ''), code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0 });
    });
    child.stdin?.end();
  });
}

/**
 * The `SHA256:` fingerprint of an OpenSSH public key line, as `ssh-keygen -lf` prints it and as
 * GitHub shows a registered key, or null for a line that holds no key. Two keys with one
 * fingerprint are one key whatever their comments, so registration compares these, not lines.
 */
export function publicKeyFingerprint(publicKey: string): string | null {
  const body = publicKey.trim().split(/\s+/)[1];
  if (!body || !/^[A-Za-z0-9+/]+=*$/.test(body)) return null;
  const blob = Buffer.from(body, 'base64');
  return blob.length ? `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}` : null;
}

const present = async (file: string) => { try { return (await stat(file)).isFile(); } catch (error: any) { if (error?.code === 'ENOENT') return false; throw error; } };

/**
 * The install's deploy key: `INSTALL_DIR/deploy-key` and its `.pub`, generated with
 * `ssh-keygen -t ed25519` when absent (the directory 0700, both files 0600), registered on
 * REPOSITORY read-write under `graphyard-merge-writer-<hostname>` unless a deploy key with its
 * fingerprint is already listed, and returned by its private path. The private key is never read,
 * printed or logged here: only the public file's content and path leave this module, and `gh`
 * receives the public file alone.
 */
export async function ensureDeployKey(installDir: string, repository: string, gh: GitHubCli, options: DeployKeyOptions = {}): Promise<string> {
  const keygen = options.keygen ?? sshKeygen;
  const title = deployKeyTitle(options.hostname ?? osHostname());
  const privateKeyFile = resolve(installDir, DEPLOY_KEY_FILE);
  const publicKeyFile = `${privateKeyFile}.pub`;
  await mkdir(installDir, { recursive: true, mode: 0o700 });
  await chmod(installDir, 0o700);
  if (!(await present(privateKeyFile))) {
    await keygen(['-q', '-t', 'ed25519', '-N', '', '-C', title, '-f', privateKeyFile]);
  } else if (!(await present(publicKeyFile))) {
    // The public half is derived from the private one, never the other way round.
    const derived = await keygen(['-y', '-f', privateKeyFile]);
    await writeFile(publicKeyFile, `${derived.stdout.trim()}\n`, { mode: 0o600 });
  }
  await chmod(privateKeyFile, 0o600);
  await chmod(publicKeyFile, 0o600);

  await registerDeployKey(publicKeyFile, repository, gh, title, { ssh: options.ssh });
  return privateKeyFile;
}

/**
 * Registers the OpenSSH public key in PUBLIC_KEY_FILE read-write on REPOSITORY under TITLE, unless a
 * deploy key with its fingerprint is already listed. A self-contained host's key is generated on the
 * host and only its public half reaches this machine for this (GY-2010).
 *
 * Listing deploy keys takes repository admin (GY-3174), so GitHub answers 403/404 to a push-only
 * operator even after an admin registered this key. That answer probes the key over ssh instead:
 * the ref advertisement `git-receive-pack` gives a write key proves it pushes (nothing is sent), and
 * a refusal stops with the one command an admin must run. Every other list failure still fails as
 * the gh error it is.
 */
export async function registerDeployKey(publicKeyFile: string, repository: string, gh: GitHubCli, title: string, options: Pick<DeployKeyOptions, 'ssh'> = {}) {
  const fingerprint = publicKeyFingerprint(await readFile(publicKeyFile, 'utf8'));
  if (!fingerprint) throw new Error(`${publicKeyFile} holds no OpenSSH public key`);
  const listed = await gh(['repo', 'deploy-key', 'list', '-R', repository, '--json', 'id,key,title'], { allowFailure: true });
  if (listed.code !== 0) {
    if (!/HTTP 40[34]/.test(`${listed.stderr}\n${listed.stdout}`)) throw commandFailure('gh', listed);
    const privateKeyFile = publicKeyFile.endsWith('.pub') ? publicKeyFile.slice(0, -'.pub'.length) : publicKeyFile;
    const probed = await (options.ssh ?? sshProbeRun)(['-i', privateKeyFile, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', 'git@github.com', `git-receive-pack '${repository}.git'`]);
    if (probed.code === 0) return;
    throw new Error(`The deploy key at ${privateKeyFile} cannot push to ${repository} (${probed.stderr.trim() || `ssh exited with ${probed.code}`}), and this gh login cannot register it: gh repo deploy-key list needs a repository admin. Ask an admin to run:

gh api -X POST repos/${repository}/keys -f title=${title} -f key="$(cat ${publicKeyFile})" -F read_only=false`);
  }
  let registered: unknown;
  try { registered = JSON.parse(listed.stdout || '[]'); } catch { throw new Error(`gh repo deploy-key list returned no JSON for ${repository}`); }
  const keys = Array.isArray(registered) ? registered : [];
  const known = keys.some((entry: any) => publicKeyFingerprint(String(entry?.key ?? '')) === fingerprint);
  if (!known) await gh(['repo', 'deploy-key', 'add', publicKeyFile, '-R', repository, '--allow-write', '--title', title]);
}
