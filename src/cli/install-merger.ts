// Concern: the merge writer `init --apply` threads into the AGENTS.md worker block (GY-1553).
// Split from src/cli/install.ts, which sits at its module budget.

/**
 * The merger `/api/status` reports (`mergeWriter.merger`, src/merger-mode.ts) for `init --apply`.
 * A failed or empty read returns null, which leaves the AGENTS.md worker block on the GitHub
 * pull-request text: a passive reader never invents control-plane.
 */
export async function mergerFromStatus(status: () => Promise<any>): Promise<string | null> {
  try { return (await status())?.mergeWriter?.merger ?? null; }
  catch { return null; }
}
