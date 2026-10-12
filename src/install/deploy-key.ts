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
  detail: string;
}

/**
 * GY-1715: protect BASE (the repository's default branch unless named) so only the merge writer's
 * deploy key may push to it, through the `Graphyard merge writer only` ruleset (`mainWriteRuleset`).
 * GitHub's deploy-key bypass covers every deploy key on the repository, so Graphyard claims the
 * branch only while WRITER_KEY is the one read-write deploy key listed: any other read-write key,
 * a writer key that is missing or read-only, or a key list that cannot be read, refuses before
 * anything is written or reported as protected, the operator's own protection included.
 * Graphyard's own ruleset is rewritten only when it drifted, so a second run writes nothing; a
 * branch the operator already protects (classic protection or another active ruleset) is left as
 * is and reported. Github-mode installs never call this: GitHub executes their merges.
 */
export async function ensureMainWriteProtection(repository: string, gh: GitHubCli, options: { baseBranch?: string; writerKey: string }): Promise<MainWriteProtection> {
  const repo = options.baseBranch ? null : await ghJson(gh, ['api', `repos/${repository}`]) as any;
  const baseBranch = options.baseBranch ?? (typeof repo?.default_branch === 'string' ? repo.default_branch : null);
  if (!baseBranch) throw new Error(`The default branch of ${repository} could not be read, so its merge-writer protection was not applied`);
  const writer = publicKeyFingerprint(options.writerKey);
  if (!writer) throw new Error(`The merge writer's public key holds no OpenSSH key, so ${baseBranch} was not protected`);
  const keys = await ghJson(gh, ['repo', 'deploy-key', 'list', '-R', repository, '--json', 'id,key,title,readOnly']);
  if (!Array.isArray(keys)) throw new Error(`The deploy keys of ${repository} could not be read, so ${baseBranch} was not protected`);
  const writable = keys.filter((entry: any) => entry?.readOnly === false);
  const others = writable.filter((entry: any) => publicKeyFingerprint(String(entry?.key ?? '')) !== writer).map((entry: any) => String(entry?.title ?? entry?.id)).sort();
  const writerListed = writable.length > others.length;
  // The deploy-key bypass names no key, so exclusivity rests on the key list: refuse rather than claim
  // it, and check it before the operator's protection too, which setup accepts only for a key that can push.
  if (others.length) throw new Error(`Read-write deploy keys ${others.join(', ')} on ${repository} would share the merge writer's bypass, so ${baseBranch} was not protected; remove them (or make them read-only), then rerun`);
  if (!writerListed) throw new Error(`The merge writer's deploy key is not registered read-write on ${repository}, so ${baseBranch} was not protected`);

  const ours = (await repositoryRulesets(repository, gh, baseBranch)).find(ruleset => ruleset?.name === mainWriteRulesetName);
  if (!ours?.id) {
    const classic = await gh(['api', `repos/${repository}/branches/${baseBranch}/protection`], { allowFailure: true });
    const rules = await ghJson(gh, ['api', `repos/${repository}/rules/branches/${baseBranch}`], []) as any[];
    if (classic.code === 0 || (Array.isArray(rules) && rules.length > 0)) {
      return { state: 'operator-protected', baseBranch, detail: `${baseBranch} already carries the operator's ${classic.code === 0 ? 'branch protection' : 'rulesets'}; left as is, so confirm it refuses pushes from everyone but the merge-writer deploy key` };
    }
  }
  const body = { input: JSON.stringify(mainWriteRuleset(baseBranch)) };
  if (ours?.id) {
    if (mainWriteRulesetCurrent(await ghJson(gh, ['api', `repos/${repository}/rulesets/${ours.id}`]), baseBranch)) return { state: 'unchanged', baseBranch, detail: `${baseBranch} already refuses pushes from everyone but the merge-writer deploy key` };
    await gh(['api', '--method', 'PUT', `repos/${repository}/rulesets/${ours.id}`, '--input', '-'], body);
    return { state: 'updated', baseBranch, detail: `${mainWriteRulesetName} on ${baseBranch} rewritten so only the merge-writer deploy key may push` };
  }
  await gh(['api', '--method', 'POST', `repos/${repository}/rulesets`, '--input', '-'], body);
  return { state: 'created', baseBranch, detail: `${mainWriteRulesetName} on ${baseBranch}: only the merge-writer deploy key may push` };
}

/** Rulesets per page of GET repos/OWNER/REPO/rulesets: GitHub's maximum (its default is 30). */
export const rulesetPageSize = 100;
/**
 * Every ruleset on REPOSITORY itself, page by page until a short page, so Graphyard's own is never
 * taken for absent because it sits past the first page. An unreadable page refuses: a partial list
 * could misreport Graphyard's ruleset as the operator's protection or write a duplicate.
 */
async function repositoryRulesets(repository: string, gh: GitHubCli, baseBranch: string): Promise<any[]> {
  const rulesets: any[] = [];
  for (let page = 1; ; page++) {
    const batch = await ghJson(gh, ['api', `repos/${repository}/rulesets?includes_parents=false&per_page=${rulesetPageSize}&page=${page}`]);
    if (!Array.isArray(batch)) throw new Error(`The rulesets of ${repository} could not be read, so ${baseBranch} was not protected`);
    rulesets.push(...batch);
    if (batch.length < rulesetPageSize) return rulesets;
  }
}
