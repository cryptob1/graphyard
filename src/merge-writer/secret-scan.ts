// Concern: the merge writer's secret scan (GY-2009) — the same pinned gitleaks check the former
// Actions secrets job ran, now part of the trial that gates every merge.
import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { ChildRun } from '../child-runner.js';

/** Pinned gitleaks release the former `.github/workflows/ci.yml` secrets job used. */
export const gitleaksVersion = '8.30.1';
export const gitleaksArchive = `gitleaks_${gitleaksVersion}_linux_x64.tar.gz`;
export const gitleaksUrl = `https://github.com/gitleaks/gitleaks/releases/download/v${gitleaksVersion}/${gitleaksArchive}`;
export const gitleaksSha256 = '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb';
export const gitleaksIgnorePath = '.github/gitleaksignore.txt';

export interface SecretScanInput {
  /** The trial checkout whose HEAD history is scanned. */
  worktree: string;
  /** Where to cache the pinned binary (a durable directory the trial may write). */
  cacheDirectory: string;
  run: ChildRun;
  /** Download the archive; tests substitute a fake. */
  download?: (url: string) => Promise<Buffer>;
  timeoutMs?: number;
}

/**
 * Download (or reuse) the pinned gitleaks binary and scan `worktree` at HEAD with the repository's
 * ignore file. Throws when the scan finds secrets or the binary cannot be obtained.
 */
export async function runSecretScan(input: SecretScanInput): Promise<{ ok: true } | { ok: false; detail: string }> {
  const run = input.run;
  const timeoutMs = input.timeoutMs ?? 120_000;
  const binDir = join(input.cacheDirectory, 'gitleaks', gitleaksVersion);
  const binary = join(binDir, 'gitleaks');
  if (!existsSync(binary)) {
    await mkdir(binDir, { recursive: true });
    const download = input.download ?? (async (url: string) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`gitleaks download failed (${response.status})`);
      return Buffer.from(await response.arrayBuffer());
    });
    const archive = await download(gitleaksUrl);
    const digest = createHash('sha256').update(archive).digest('hex');
    if (digest !== gitleaksSha256) throw new Error(`gitleaks archive sha256 ${digest} does not match ${gitleaksSha256}`);
    const archivePath = join(binDir, gitleaksArchive);
    await writeFile(archivePath, archive, { mode: 0o600 });
    await run('tar', ['-xzf', archivePath, '-C', binDir, 'gitleaks'], { timeoutMs });
    await chmod(binary, 0o700);
  }
  const ignore = join(input.worktree, gitleaksIgnorePath);
  const args = ['git', '--redact', '--log-opts=HEAD', ...(existsSync(ignore) ? ['--gitleaks-ignore-path', ignore] : []), input.worktree];
  try {
    await run(binary, args, { cwd: input.worktree, timeoutMs });
    return { ok: true };
  } catch (error) {
    const failed = error as { status?: number | null; stdout?: unknown; stderr?: unknown; message?: string };
    const out = `${typeof failed.stdout === 'string' ? failed.stdout : ''}${typeof failed.stderr === 'string' ? failed.stderr : ''}` || String(failed.message ?? error);
    return { ok: false, detail: out.slice(0, 4000) };
  }
}

/** The argv a trial records for the secret scan (tests assert these options). */
export const secretScanArgv = (worktree: string, binary = 'gitleaks') =>
  [binary, 'git', '--redact', '--log-opts=HEAD', '--gitleaks-ignore-path', join(worktree, gitleaksIgnorePath), worktree];
