/**
 * Generated files: paths whose content is derived from other files by a script (the docs
 * indexes `scripts/check-docs.mjs --write` renders) and verified current by CI, never hand-merged.
 * No work item owns them, so the regression guard classifies a candidate that regenerates one as
 * `generated` rather than as an out-of-scope rewrite, and `graphyard sync` resolves a merge
 * conflict in one by regenerating it.
 *
 * The control plane learns the set from `GRAPHYARD_GENERATED_FILES`, a comma-separated list of
 * exact repository-relative paths; a managed repository whose docs are hand-written leaves it
 * unset and the guard is unchanged. The worker side reads the same set from the repository's own
 * manifest (`node scripts/check-docs.mjs --manifest`), which the deployment variable must match.
 */
const invalidSegment = (segment: string) => segment === '' || segment === '.' || segment === '..';

export function parseGeneratedFiles(value: string | undefined): string[] {
  const entries = (value ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.includes('\\') || /[*?\[\]]/.test(entry) || entry.split('/').some(invalidSegment)) {
      throw new Error(`GRAPHYARD_GENERATED_FILES names exact repository-relative files, not ${JSON.stringify(entry)}`);
    }
  }
  return [...new Set(entries)];
}

/**
 * The deployment's declared generated files; a malformed declaration refuses start-up. The
 * regression guard is also bundled into the dashboard (through the model's gate evaluation),
 * where no process environment exists and no file is generated.
 */
export const configuredGeneratedFiles = (env: NodeJS.ProcessEnv = typeof process === 'undefined' ? {} : process.env) => parseGeneratedFiles(env.GRAPHYARD_GENERATED_FILES);

export const isGeneratedFile = (generated: readonly string[], path: string) => generated.includes(path);
