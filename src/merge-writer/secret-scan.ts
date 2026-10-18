// Concern: the merge writer's secret scan (GY-2009) — the same pinned gitleaks check the former
// Actions secrets job ran, now part of the trial that gates every merge.
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { ChildRun } from '../child-runner.js';

/** Pinned gitleaks release the former `.github/workflows/ci.yml` secrets job used. */
export const gitleaksVersion = '8.30.1';
export const gitleaksArchive = `gitleaks_${gitleaksVersion}_linux_x64.tar.gz`;
export const gitleaksUrl = `https://github.com/gitleaks/gitleaks/releases/download/v${gitleaksVersion}/${gitleaksArchive}`;
export const gitleaksSha256 = '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb';
export const gitleaksIgnorePath = '.github/gitleaksignore.txt';

/** Where the pinned binary is kept across trials: under the managed worktree root, keyed by version and archive digest. */
export const secretScanCacheDirectory = (managedRoot: string) => resolve(managedRoot, '.secret-scan', `gitleaks-${gitleaksVersion}-${gitleaksSha256.slice(0, 12)}`);

/** How a gitleaks run that reported no findings ended: its status or signal, the runner's own reason, and whether the deadline killed it. */
export interface SecretScanExecution { status: number | null; signal: string | null; cause?: unknown; timedOut?: boolean }

/** gitleaks' exit status when it found leaks (its default `--exit-code`). Any other ending is no verdict. */
export const gitleaksFindingsStatus = 1;

/**
 * The scan's answer: a pass, the merge's failure (`detail` holds gitleaks' report), or no verdict —
 * `unavailable` when the binary could not be had, `execution` when gitleaks ran but did not end with
 * its findings status (a deadline kill, a signal, a spawn or capture failure, an error exit).
 */
export type SecretScanResult = { ok: true } | { ok: false; detail: string; unavailable?: true; execution?: SecretScanExecution };

export interface SecretScanInput {
  /** The trial checkout whose HEAD history is scanned. */
  worktree: string;
  /** Where to cache the pinned binary: a durable directory (`secretScanCacheDirectory`) that outlives the trial. */
  cacheDirectory: string;
  run: ChildRun;
  /** Download the archive; tests substitute a fake. */
  download?: (url: string) => Promise<Buffer>;
  timeoutMs?: number;
  /** The host platform and architecture; `process.platform`/`process.arch` unless a test names others. */
  platform?: string;
  arch?: string;
  /** The archive digest the download must match; `gitleaksSha256` unless a test's fake archive names its own. */
  sha256?: string;
}

/** The argv the trial runs the scan with: HEAD's history, redacted, with the repository's ignore file when it has one. */
export const secretScanArgv = (worktree: string, binary = 'gitleaks', ignore = existsSync(join(worktree, gitleaksIgnorePath))) =>
  [binary, 'git', '--redact', '--log-opts=HEAD', ...(ignore ? ['--gitleaks-ignore-path', join(worktree, gitleaksIgnorePath)] : []), worktree];

/** Obtain the pinned binary in `cacheDirectory` once: a later trial finds it there and downloads nothing. */
async function pinnedBinary(input: SecretScanInput, timeoutMs: number): Promise<string> {
  const binary = join(input.cacheDirectory, 'gitleaks');
  if (existsSync(binary)) return binary;
  const platform = input.platform ?? process.platform, arch = input.arch ?? process.arch;
  if (platform !== 'linux' || arch !== 'x64') throw new Error(`the pinned gitleaks archive ${gitleaksArchive} is linux x64 only; this host is ${platform} ${arch}`);
  await mkdir(input.cacheDirectory, { recursive: true });
  const download = input.download ?? (async (url: string) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`gitleaks download failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  });
  const archive = await download(gitleaksUrl);
  const digest = createHash('sha256').update(archive).digest('hex');
  const pinned = input.sha256 ?? gitleaksSha256;
  if (digest !== pinned) throw new Error(`gitleaks archive sha256 ${digest} does not match ${pinned}`);
  // Extracted beside the cache and renamed into place, so a concurrent trial never runs a half-written binary.
  const staging = await mkdtemp(join(input.cacheDirectory, 'staging-'));
  try {
    const archivePath = join(staging, gitleaksArchive);
    await writeFile(archivePath, archive, { mode: 0o600 });
    await input.run('tar', ['-xzf', archivePath, '-C', staging, 'gitleaks'], { timeoutMs });
    await chmod(join(staging, 'gitleaks'), 0o700);
    await rename(join(staging, 'gitleaks'), binary);
  } finally { await rm(staging, { recursive: true, force: true }); }
  return binary;
}

/**
 * Obtain (once, cached) the pinned gitleaks binary and scan `worktree` at HEAD with the repository's
 * ignore file. Only gitleaks' findings status fails the scan; a binary that cannot be had (download,
 * digest or platform) is `unavailable`, and a run that ended any other way carries its `execution`:
 * the trial treats both as no verdict (a timeout or runner failure) rather than the merge's failure.
 */
export async function runSecretScan(input: SecretScanInput): Promise<SecretScanResult> {
  const timeoutMs = input.timeoutMs ?? 120_000;
  let binary: string;
  try { binary = await pinnedBinary(input, timeoutMs); }
  catch (error) { return { ok: false, unavailable: true, detail: `secret scan unavailable: ${error instanceof Error ? error.message : String(error)}` }; }
  const [command, ...args] = secretScanArgv(input.worktree, binary);
  try {
    await input.run(command!, args, { cwd: input.worktree, timeoutMs });
    return { ok: true };
  } catch (error) {
    const failed = error as { status?: number | null; signal?: string | null; cause?: unknown; timedOut?: boolean; stdout?: unknown; stderr?: unknown; message?: string };
    const out = `${typeof failed.stdout === 'string' ? failed.stdout : ''}${typeof failed.stderr === 'string' ? failed.stderr : ''}` || String(failed.message ?? error);
    const detail = out.slice(0, 4000);
    const status = typeof failed.status === 'number' ? failed.status : null, signal = failed.signal ?? null;
    if (status === gitleaksFindingsStatus && signal === null && failed.cause === undefined && !failed.timedOut) return { ok: false, detail };
    return { ok: false, detail, execution: { status, signal, ...(failed.cause !== undefined ? { cause: failed.cause } : {}), ...(failed.timedOut ? { timedOut: true } : {}) } };
  }
}
