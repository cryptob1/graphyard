// Concern: the merge writer's deploy key (GY-1551) — one ed25519 key pair under the install
// directory, registered read-write on the repository through the operator's `gh` login, idempotently.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import { resolve } from 'node:path';
import { mainWriteRuleset, mainWriteRulesetCurrent, mainWriteRulesetName } from '../protection.js';
import { ghJson, type GitHubCli } from './github.js';
import { commandFailure, type CommandResult } from './transport.js';

/** The private key's name under the install directory; `merge-writer-settings.ts` reads it from the same place. */
export const DEPLOY_KEY_FILE = 'deploy-key';
/** The registered key's title names the host whose merge writer pushes with it. */
export const deployKeyTitle = (host: string) => `graphyard-merge-writer-${host}`;

export interface DeployKeyOptions {
  /** Runs `ssh-keygen` with ARGS; the default spawns the host's. Tests substitute a fake that writes the pair. */
  keygen?: (args: string[]) => Promise<CommandResult>;
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

  const publicKey = await readFile(publicKeyFile, 'utf8');
  const fingerprint = publicKeyFingerprint(publicKey);
  if (!fingerprint) throw new Error(`${publicKeyFile} holds no OpenSSH public key`);
  const listed = await gh(['repo', 'deploy-key', 'list', '-R', repository, '--json', 'id,key,title']);
  let registered: unknown;
  try { registered = JSON.parse(listed.stdout || '[]'); } catch { throw new Error(`gh repo deploy-key list returned no JSON for ${repository}`); }
  const keys = Array.isArray(registered) ? registered : [];
  const known = keys.some((entry: any) => publicKeyFingerprint(String(entry?.key ?? '')) === fingerprint);
  if (!known) await gh(['repo', 'deploy-key', 'add', publicKeyFile, '-R', repository, '--allow-write', '--title', title]);
  return privateKeyFile;
}

export interface MainWriteProtection {
  /** `created`/`updated`: Graphyard wrote its ruleset; `unchanged`: it already held; `operator-protected`: the operator's own protection was found and left as is. */
  state: 'created' | 'updated' | 'unchanged' | 'operator-protected';
  baseBranch: string;
  /** Read-write deploy keys other than the merge writer's: the deploy-key bypass covers them too, so the operator should remove them. */
  otherWriters: string[];
  detail: string;
}

/**
 * GY-1715: protect BASE (the repository's default branch unless named) so only the merge writer's
 * deploy key may push to it, through the `Graphyard merge writer only` ruleset (`mainWriteRuleset`).
 * Graphyard's own ruleset is rewritten only when it drifted, so a second run writes nothing; a
 * branch the operator already protects (classic protection or another active ruleset) is left as
 * is and reported. Github-mode installs never call this: GitHub executes their merges.
 */
export async function ensureMainWriteProtection(repository: string, gh: GitHubCli, options: { baseBranch?: string; writerKey?: string } = {}): Promise<MainWriteProtection> {
  const repo = options.baseBranch ? null : await ghJson(gh, ['api', `repos/${repository}`]) as any;
  const baseBranch = options.baseBranch ?? (typeof repo?.default_branch === 'string' ? repo.default_branch : null);
  if (!baseBranch) throw new Error(`The default branch of ${repository} could not be read, so its merge-writer protection was not applied`);
  const writer = options.writerKey ? publicKeyFingerprint(options.writerKey) : null;
  const keys = await ghJson(gh, ['repo', 'deploy-key', 'list', '-R', repository, '--json', 'id,key,title,readOnly'], []) as any[];
  const otherWriters = (Array.isArray(keys) ? keys : []).filter(entry => entry?.readOnly === false && publicKeyFingerprint(String(entry?.key ?? '')) !== writer).map(entry => String(entry?.title ?? entry?.id)).sort();
  const others = otherWriters.length ? `; read-write deploy keys ${otherWriters.join(', ')} also bypass it, remove them` : '';
  const done = (state: MainWriteProtection['state'], detail: string): MainWriteProtection => ({ state, baseBranch, otherWriters, detail: `${detail}${others}` });

  const rulesets = await ghJson(gh, ['api', `repos/${repository}/rulesets?includes_parents=false`], []) as any[];
  const ours = Array.isArray(rulesets) ? rulesets.find(ruleset => ruleset?.name === mainWriteRulesetName) : undefined;
  const body = { input: JSON.stringify(mainWriteRuleset(baseBranch)) };
  if (ours?.id) {
    if (mainWriteRulesetCurrent(await ghJson(gh, ['api', `repos/${repository}/rulesets/${ours.id}`]), baseBranch)) return done('unchanged', `${baseBranch} already refuses pushes from everyone but the merge-writer deploy key`);
    await gh(['api', '--method', 'PUT', `repos/${repository}/rulesets/${ours.id}`, '--input', '-'], body);
    return done('updated', `${mainWriteRulesetName} on ${baseBranch} rewritten so only the merge-writer deploy key may push`);
  }
  const classic = await gh(['api', `repos/${repository}/branches/${baseBranch}/protection`], { allowFailure: true });
  const rules = await ghJson(gh, ['api', `repos/${repository}/rules/branches/${baseBranch}`], []) as any[];
  const active = Array.isArray(rules) && rules.length > 0;
  if (classic.code === 0 || active) return done('operator-protected', `${baseBranch} already carries the operator's ${classic.code === 0 ? 'branch protection' : 'rulesets'}; left as is, so confirm it refuses pushes from everyone but the merge-writer deploy key`);
  await gh(['api', '--method', 'POST', `repos/${repository}/rulesets`, '--input', '-'], body);
  return done('created', `${mainWriteRulesetName} on ${baseBranch}: only the merge-writer deploy key may push`);
}
