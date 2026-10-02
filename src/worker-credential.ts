// Concern: the short-lived repository credential each worker session pushes with (GY-999).
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Work } from './model.js';
import { describePermission, type PermissionLevel } from './github-permissions.js';
import { roleSessionMaximumMs } from './model/sessions.js';

/**
 * Workers run confined (GY-888): under bubblewrap the session bus is bound to /dev/null, so `gh`
 * cannot reach the Secret Service keyring the operator's own login lives in, and git's credential
 * helper (`gh auth git-credential`) has nothing valid to give a push. On 2026-09-30 eleven finished
 * items blocked on "could not read Username for 'https://github.com'" and held every worker slot
 * for hours. So a worker never pushes with the host's login: the launcher mints each session its
 * own installation token of the Graphyard App — this repository only, `contents`, `pull_requests`
 * and `workflows` write (a sync that merges a base which changed a workflow is otherwise refused,
 * 2026-10-01; the planned-files guard still refuses a candidate that changes one itself) — and writes it into a session GH_CONFIG_DIR that `gh` and git read
 * directly, with every host credential helper switched off. The watch supervisor refreshes it
 * before GitHub's one-hour expiry while the attempt runs and withdraws it when the session ends.
 */
export const workerPushPermissions = { contents: 'write', pull_requests: 'write', workflows: 'write' } as const;

/** A permission a worker push credential wants that the installation does not grant at that level. */
export interface PushPermissionShortfall { permission: string; wanted: string; granted: string | null }
const pushLevels = ['read', 'write', 'admin'];
const pushRank = (level: unknown) => typeof level === 'string' ? pushLevels.indexOf(level) : -1;

/**
 * The permissions a worker push credential is minted with: each wanted permission at the level the
 * installation grants, never above what is wanted (GY-1100). GitHub refuses a whole mint (422) that
 * asks for one permission the installation lacks, so on 2026-10-02 adding `workflows` to the wanted
 * set stopped every worker launch until the installation accepted it. A missing permission is left
 * out instead and answered as a shortfall the operator's attention names; a token without
 * `workflows` still pushes everything that does not touch a workflow.
 */
export function grantedPushPermissions(granted: Record<string, unknown> | null | undefined, wanted: Record<string, string> = workerPushPermissions): { permissions: Record<string, string>; missing: PushPermissionShortfall[] } {
  const permissions: Record<string, string> = {}, missing: PushPermissionShortfall[] = [];
  for (const [permission, level] of Object.entries(wanted)) {
    const held = granted?.[permission], heldRank = pushRank(held);
    if (heldRank >= pushRank(level)) permissions[permission] = level;
    else {
      if (heldRank >= 0) permissions[permission] = held as string;
      missing.push({ permission, wanted: level, granted: heldRank >= 0 ? held as string : null });
    }
  }
  return { permissions, missing };
}

/** One attention line per shortfall: the permission, what minting without it costs, and the installation-accept step that restores it. */
export function describePushShortfall(shortfall: PushPermissionShortfall, app: string, installationUrl: string) {
  return `App ${app} installation lacks ${describePermission(shortfall.permission, shortfall.wanted as PermissionLevel)}${shortfall.granted ? ` (installed with ${shortfall.granted})` : ''}, which worker push credentials request; they are minted without it until it is granted, so a worker push that needs it is refused. Run graphyard master browser app-permissions, then graphyard master browser installation-accept, or accept the pending permission request at ${installationUrl}`;
}

/** What the control plane answers a lease holder's mint with; the token is the only secret in it. */
export interface MintedPushCredential {
  key: string; epoch: number; repository: string; token: string;
  /** GitHub's own expiry of the token. */
  tokenExpiresAt: string;
  /** When the credential stops being valid for this attempt: the earlier of the token's expiry and the lease bound. */
  expiresAt: string;
  /** The attempt's lease bound: its claim plus the implementation time box, past which the loop ends the attempt. */
  leaseBound: string;
  permissions: Record<string, string>;
}
/** The credential's record beside it in the session directory: everything but the token. */
export type WorkerCredentialRecord = Omit<MintedPushCredential, 'token'> & { mintedAt: string };

/** Where a worker profile's session credentials live: beside its Graphyard credential, outside every worktree. */
export const workerCredentialRoot = (credentialFile: string) => resolve(dirname(credentialFile), 'worker-sessions');
/** One attempt's session directory — its GH_CONFIG_DIR. An epoch is claimed once, so the name is unique to the attempt. */
export const workerCredentialDirectory = (credentialFile: string, key: string, epoch: number) => resolve(workerCredentialRoot(credentialFile), `${key}-${epoch}`);

/**
 * The attempt's lease bound: an implementation attempt older than its role's time box is ended by
 * the loop (GY-885), so no credential is minted to outlive it. Null when the item records no claim
 * for this owner and epoch — nothing is minted then.
 */
export function pushCredentialBound(work: Pick<Work, 'lastAssignment'>, owner: string, epoch: number): number | null {
  const claimed = work.lastAssignment?.owner === owner && work.lastAssignment.epoch === epoch ? Date.parse(work.lastAssignment.claimedAt ?? '') : NaN;
  return Number.isFinite(claimed) ? claimed + roleSessionMaximumMs.implementation : null;
}

const files = { hosts: 'hosts.yml', config: 'config.yml', token: 'token', record: 'credential.json' } as const;

/** Writes one file with mode 0600 in place of any earlier one, never leaving it half written. */
async function privateReplace(directory: string, name: string, content: string) {
  const target = resolve(directory, name), staged = resolve(directory, `.${name}.staged`);
  await rm(staged, { force: true });
  await writeFile(staged, content, { mode: 0o600, flag: 'wx' });
  await chmod(staged, 0o600);
  await rename(staged, target);
}

/**
 * Writes the minted credential into `directory` (mode 0700), each file 0600: `hosts.yml` and
 * `config.yml` for `gh` — the token as plain-text storage, so `gh` never consults a keyring and
 * never rewrites the directory to migrate it — the bare `token` git's helper reads, and the record.
 * A refresh rewrites them in place; a session reading mid-refresh sees the old or the new token.
 */
export async function writeWorkerCredential(directory: string, minted: MintedPushCredential, now = new Date()): Promise<WorkerCredentialRecord> {
  if (directory.includes("'")) throw new Error(`The worker credential directory ${directory} contains a quote, which git's credential helper line cannot carry`);
  if (!/^[\x21-\x7e]{20,}$/.test(minted.token)) throw new Error('The minted worker push token is malformed');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const { token, ...rest } = minted;
  const record: WorkerCredentialRecord = { ...rest, mintedAt: now.toISOString() };
  await privateReplace(directory, files.token, `${token}\n`);
  await privateReplace(directory, files.hosts, `github.com:\n    users:\n        x-access-token:\n            oauth_token: ${token}\n    git_protocol: https\n    oauth_token: ${token}\n    user: x-access-token\n`);
  await privateReplace(directory, files.config, 'version: "1"\ngit_protocol: https\nprompt: disabled\n');
  await privateReplace(directory, files.record, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export async function readWorkerCredentialRecord(directory: string): Promise<WorkerCredentialRecord | null> {
  try {
    const record = JSON.parse(await readFile(resolve(directory, files.record), 'utf8'));
    return typeof record?.key === 'string' && Number.isSafeInteger(record?.epoch) && Number.isFinite(Date.parse(record?.expiresAt)) ? record : null;
  } catch { return null; }
}

/**
 * The environment a worker session runs with. `gh` reads the session directory alone (GH_TOKEN and
 * GITHUB_TOKEN are emptied so a host variable cannot outrank it); git's credential helpers from
 * every config file are reset — so neither `gh auth git-credential` against the host login nor a
 * keyring helper is ever asked — and one helper answers github.com from the session's token file.
 * An ssh origin is pushed over https, since the ssh agent's socket sits in the same runtime
 * directory the confinement hides.
 */
export function workerCredentialEnvironment(directory: string): Record<string, string> {
  const helper = `!f() { test "$1" = get || exit 0; printf 'username=x-access-token\\npassword=%s\\n' "$(cat '${resolve(directory, files.token)}')"; }; f`;
  const config: [string, string][] = [
    ['credential.helper', ''],
    ['credential.https://github.com.helper', helper],
    ['url.https://github.com/.pushInsteadOf', 'git@github.com:'],
    ['url.https://github.com/.pushInsteadOf', 'ssh://git@github.com/'],
  ];
  return {
    GH_CONFIG_DIR: directory, GH_TOKEN: '', GITHUB_TOKEN: '', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(config.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value]])),
  };
}

export type TokenRevoker = (token: string) => Promise<void>;
/** Revokes an installation token with itself (DELETE /installation/token), so a withdrawn credential stops working at once. */
export const revokeInstallationToken: TokenRevoker = async token => {
  await fetch('https://api.github.com/installation/token', { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(10_000) });
};

/**
 * Withdraws a session's credential: its token is revoked (best effort — GitHub's expiry bounds it
 * anyway) and the session directory removed. Answers whether a directory was there to remove.
 */
export async function withdrawWorkerCredential(directory: string, revoke: TokenRevoker | null = revokeInstallationToken): Promise<boolean> {
  let token: string | null = null;
  try { token = (await readFile(resolve(directory, files.token), 'utf8')).trim() || null; } catch { token = null; }
  const existed = token !== null || !!await readWorkerCredentialRecord(directory);
  await rm(directory, { recursive: true, force: true });
  if (token && revoke) await revoke(token).catch(() => {});
  return existed;
}

/** How long before its expiry a running session's credential is replaced. */
export const credentialRefreshMs = 15 * 60_000;

/**
 * The supervisor's refresh (GY-999), run with each lease renewal: a credential within
 * `credentialRefreshMs` of its expiry is minted afresh and rewritten in place; one past the lease
 * bound is withdrawn, since the attempt it belonged to has outrun its time box. Answers what it did.
 */
export async function refreshWorkerCredential(directory: string, mint: () => Promise<MintedPushCredential>, options: { now?: Date; revoke?: TokenRevoker | null } = {}): Promise<'absent' | 'current' | 'refreshed' | 'withdrawn'> {
  const now = options.now ?? new Date();
  const record = await readWorkerCredentialRecord(directory);
  if (!record) return 'absent';
  if (Date.parse(record.leaseBound) <= now.getTime()) { await withdrawWorkerCredential(directory, options.revoke); return 'withdrawn'; }
  if (Date.parse(record.expiresAt) - now.getTime() > credentialRefreshMs) return 'current';
  let previous: string | null = null;
  try { previous = (await readFile(resolve(directory, files.token), 'utf8')).trim() || null; } catch { previous = null; }
  const revoke = options.revoke === undefined ? revokeInstallationToken : options.revoke;
  const minted = await mint();
  if (minted.key !== record.key || minted.epoch !== record.epoch) throw new Error(`The refreshed push credential is for ${minted.key} epoch ${minted.epoch}, not ${record.key} epoch ${record.epoch}`);
  await writeWorkerCredential(directory, minted, now);
  if (previous && revoke && previous !== minted.token) await revoke(previous).catch(() => {});
  return 'refreshed';
}

/**
 * Withdraws the session directories a profile's earlier attempts left behind once their credentials
 * have expired — a supervisor killed outright never withdraws its own. Each token is revoked and
 * its directory removed by its exact path.
 */
export async function sweepExpiredWorkerCredentials(root: string, now = new Date(), revoke: TokenRevoker | null = revokeInstallationToken): Promise<string[]> {
  let names: string[];
  try { names = await readdir(root); } catch { return []; }
  const removed: string[] = [];
  for (const name of names) {
    const directory = resolve(root, name);
    const record = await readWorkerCredentialRecord(directory);
    // Withdrawn, not merely deleted: a lease bound earlier than GitHub's own expiry leaves the
    // token valid at GitHub, so it is revoked before its only local copy goes.
    if (record && Date.parse(record.expiresAt) <= now.getTime()) { await withdrawWorkerCredential(directory, revoke); removed.push(directory); }
  }
  return removed;
}

/**
 * Whether a worker's blocker is a GitHub credential failure — a push or `gh` call refused for want
 * of a valid login — rather than anything about the item. Such an attempt is ended by the loop and
 * relaunched with a freshly minted credential instead of holding its lease on the blocker (GY-999).
 * The messages git and `gh` print themselves count alone; a generic authentication refusal (an
 * HTTP 401, "Requires authentication", "Bad credentials") counts only when the blocker also names
 * GitHub, git or `gh`, so a product's own 401 in an integration test is an item blocker that waits
 * for its clearance like any other.
 */
const credentialFailures = [
  /could not read (Username|Password) for '?https:\/\/github\.com/i,
  /The token in \S+ is invalid/i,
  /Authentication failed for '?https:\/\/github\.com/i,
  /Invalid username or (password|token)/i,
  /Permission denied \(publickey\)/i,
  /You are not logged into any GitHub hosts/i,
  /To get started with GitHub CLI, please run:? +gh auth login/i,
  /Permission to \S+ denied to \S+/i,
];
const genericAuthenticationFailures = [/HTTP 401\b/i, /\bBad credentials\b/i, /Requires authentication/i];
const githubContext = /github\.com|api\.github|\bgh (?:pr|api|auth|repo|run|release)\b|\bgit (?:push|fetch|pull|clone|ls-remote)\b/i;
export const credentialFailure = (text: string | null | undefined) => !!text && (credentialFailures.some(pattern => pattern.test(text))
  || (genericAuthenticationFailures.some(pattern => pattern.test(text)) && githubContext.test(text)));

/** The session directory the supervisor of `key` epoch `epoch` looks after: GH_CONFIG_DIR when it holds this attempt's credential, else null. */
export async function attemptCredentialDirectory(directory: string | undefined, key: string, epoch: number): Promise<string | null> {
  if (!directory) return null;
  const record = await readWorkerCredentialRecord(directory);
  return record?.key === key && record.epoch === epoch ? directory : null;
}

/** The loop's record of ending an attempt blocked on a credential failure (GY-999), once per epoch. */
export const credentialBlockedKey = (item: Pick<Work, 'id'>, epoch: number) => `resume:credential:${item.id}:${epoch}`;
/**
 * The marker a credential-blocked attempt's end carries in its capacity record. The retry ladder
 * (GY-885) reads it back: such an end counts as a failed attempt, so a failure a fresh mint does
 * not cure — an App permission the push needs and lacks, say — is relaunched after a backoff and
 * held at the cap for an approver's decision instead of ending and relaunching for ever.
 */
export const credentialBlockedMarker = 'credential-blocked attempt';
/** Why the attempt is ended: the blocker it reported, and that the next attempt gets a freshly minted credential. */
export function credentialBlockedReason(item: Pick<Work, 'key'>, epoch: number, blocker: string) {
  return `${credentialBlockedMarker} on epoch ${epoch}: a GitHub credential failure ("${blocker.length > 300 ? `${blocker.slice(0, 299)}…` : blocker}") lives in its session's credential rather than in the item, so the attempt ends with its committed work kept and ${item.key} is launched again with a freshly minted push credential`;
}

/**
 * The watch supervisor's part (GY-999): when GH_CONFIG_DIR holds this attempt's credential, the
 * `refresh` handed to `supervise` renews it before its expiry (a failed refresh is reported and
 * tried again at the next renewal), and however the session ends the credential is withdrawn —
 * the token revoked and the session directory removed.
 */
export async function superviseSessionCredential<T>(directory: string | undefined, key: string, epoch: number, mint: () => Promise<MintedPushCredential>,
  supervise: (refresh: () => Promise<void>) => Promise<T>, options: { revoke?: TokenRevoker | null; now?: () => Date; log?: (line: string) => void } = {}): Promise<T> {
  const credential = await attemptCredentialDirectory(directory, key, epoch);
  const log = options.log ?? (line => console.error(line));
  const refresh = async () => {
    if (!credential) return;
    await refreshWorkerCredential(credential, mint, { revoke: options.revoke, now: options.now?.() })
      .catch(error => log(`${key} epoch ${epoch}: the session's push credential could not be refreshed (${error instanceof Error ? error.message : String(error)}); the next renewal tries again.`));
  };
  try { return await supervise(refresh); }
  finally { if (credential) await withdrawWorkerCredential(credential, options.revoke); }
}
