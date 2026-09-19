import { readFileSync } from 'node:fs';

/**
 * The version this process is running, as the release process stamps it.
 *
 * `package.json` is the source of the semantic version; the container build passes the
 * same value through `GRAPHYARD_VERSION` together with the Git revision it was built from,
 * so a running deployment can be matched to the tagged image that produced it. A build
 * without a revision reports `unknown` rather than guessing.
 */
export const packageVersion = (() => {
  try { return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'); } catch { return '0.0.0'; }
})();
export const releaseInfo = () => ({
  version: process.env.GRAPHYARD_VERSION || packageVersion,
  revision: process.env.GRAPHYARD_BUILD_REVISION || 'unknown',
});
/**
 * The schema generation the code in this process expects. Every migration that changes
 * what a backup must carry — a table, a column a restore has to fill, a sequence — bumps
 * it, and the migration records the generation it reached. Backups carry the generation
 * they were taken at, so a restore into older code refuses instead of dropping columns.
 */
export const schemaVersion = 3;
