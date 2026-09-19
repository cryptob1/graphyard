import { execFileSync } from 'node:child_process';

/**
 * The master-merge exchange contract: the shapes of the merge-acquire, merge-verify,
 * merge-commit and merge-cancel replies the CLI broker reads. Bump it whenever a reply
 * gains a field the broker refuses without, so a CLI ahead of its server reports the skew
 * as skew instead of an "invalid final GitHub gate verification".
 *
 *   1 — the original merge-verify reply (executionId, sha, verifiedAt, providerDelayMs)
 *   2 — merge-verify carries the bounded GitHub/repository clockOffset and the broker
 *       commits through merge-commit (GY-4)
 *
 * A server that reports no protocol at all predates the exchange and is version 1.
 */
export const MERGE_PROTOCOL = 2;

/** How the running build identifies itself: the source commit it was built from, when the deployment says. */
export interface BuildIdentity { commit: string | null; protocol: number; source: 'GRAPHYARD_BUILD_SHA' | 'RAILWAY_GIT_COMMIT_SHA' | 'SOURCE_COMMIT' | null }
const commitPattern = /^[0-9a-f]{40}$/i;
/**
 * The deployed commit, read from the environment the deployment provides. Railway injects
 * RAILWAY_GIT_COMMIT_SHA into every service it builds from GitHub; other hosts set
 * GRAPHYARD_BUILD_SHA from their build step. Unknown stays unknown rather than guessed.
 */
export function buildIdentity(env: Record<string, string | undefined> = process.env): BuildIdentity {
  for (const source of ['GRAPHYARD_BUILD_SHA', 'RAILWAY_GIT_COMMIT_SHA', 'SOURCE_COMMIT'] as const) {
    const value = env[source]?.trim();
    if (value && commitPattern.test(value)) return { commit: value.toLowerCase(), protocol: MERGE_PROTOCOL, source };
  }
  return { commit: null, protocol: MERGE_PROTOCOL, source: null };
}

/** The commit the CLI itself runs from: the checkout that holds this source file. */
export function cliCommit(root: string, run: (command: string, args: string[]) => string = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })): string | null {
  try { const value = run('git', ['-C', root, 'rev-parse', 'HEAD']).trim(); return commitPattern.test(value) ? value.toLowerCase() : null; }
  catch { return null; }
}
