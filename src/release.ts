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
 * The digest of every generation's table definitions, oldest first (GY-1961): generation N's
 * migration had digest `schemaGenerations[N]`; generations recorded before the lineage are null.
 * Every change to a table's DDL appends its digest here, so any DDL change is a newer generation
 * and a release refuses a database a newer definition migrated instead of re-applying its own
 * older DDL. `tests/schema-generation-guard.test.ts` fails, naming the digest to append, when
 * the code's definitions are not the newest entry. A generation also covers what a backup must
 * carry: backups record the generation they were taken at, so a restore into older code refuses.
 */
export const schemaGenerations: readonly (string | null)[] = [
  null, null, null, null,
  'sha256:59c9d79237ce1c121a492cbe90295cf29ccc925aa0e5b22e327b5503a4ac6e11',
];
/** The schema generation the code in this process expects: its table definitions' place in the lineage. */
export const schemaVersion = schemaGenerations.length - 1;
