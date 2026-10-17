import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * `package.json`'s version. It is no longer the release: every candidate production promotes is
 * tagged with a date version (GY-1959), and that tag is what the CLI, `/healthz` and the install
 * defaults report. It stays exported for builds that still stamp it.
 */
export const packageVersion = (() => {
  try { return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'); } catch { return '0.0.0'; }
})();

/** A date version: YYYY.M.D for a day's first promotion, YYYY.M.D.N for the next ones. */
export const datedVersionPattern = /^(\d{4})\.([1-9]\d?)\.([1-9]\d?)(?:\.([1-9]\d*))?$/;
/** The channel tag (git and image) that always names the latest promoted release. */
export const stableChannel = 'stable';
export const imageRepository = 'ghcr.io/cryptob1/graphyard';

/**
 * The version a promotion on `date` (its UTC calendar day) takes, given the tags that exist:
 * YYYY.M.D when none of that day exists, else one past the highest .N suffix of that day.
 */
export function nextDateVersion(date: Date, existing: readonly string[]) {
  const day = `${date.getUTCFullYear()}.${date.getUTCMonth() + 1}.${date.getUTCDate()}`;
  let highest = -1;
  for (const tag of existing) {
    const match = datedVersionPattern.exec(tag.trim());
    if (!match || `${match[1]}.${match[2]}.${match[3]}` !== day) continue;
    highest = Math.max(highest, match[4] ? Number(match[4]) : 0);
  }
  return highest < 0 ? day : `${day}.${highest + 1}`;
}

/** Orders date versions; the latest sorts last. */
export function compareDateVersions(a: string, b: string) {
  const parts = (v: string) => (datedVersionPattern.exec(v) ?? []).slice(1).map(p => Number(p ?? 0));
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 4; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

export interface Release { version: string; revision: string; released: boolean }

/**
 * The release a checkout is: the latest dated tag on its HEAD, else `unreleased <short sha>`.
 * Without a Git checkout (an image) it reads the revision the build stamped.
 */
export function checkoutRelease(cwd: string, fallbackRevision = 'unknown'): Release {
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
    return run.status === 0 ? run.stdout.trim() : null;
  };
  const revision = git('rev-parse', 'HEAD') ?? fallbackRevision;
  const tags = (git('tag', '--points-at', 'HEAD') ?? '').split('\n').filter(tag => datedVersionPattern.test(tag)).sort(compareDateVersions);
  const version = tags.at(-1);
  return version ? { version, revision, released: true } : { version: `unreleased ${revision.slice(0, 12)}`, revision, released: false };
}

/** The Graphyard installation this code runs from. */
export const installationRoot = fileURLToPath(new URL('..', import.meta.url));
let ownRelease: Release | undefined;
/** This code's own release, read once per process. */
export const cliRelease = () => ownRelease ??= checkoutRelease(installationRoot, process.env.GRAPHYARD_BUILD_REVISION || 'unknown');

/**
 * The version this process is running. An image the promotion published is stamped with its date
 * version through `GRAPHYARD_VERSION` (a candidate image under test with `unreleased <sha>`), with the
 * Git revision it was built from; any other stamp, such as package.json's, is ignored. A checkout reports its
 * own dated tag, or `unreleased <sha>`, exactly as `graphyard version` does, so `/healthz` and the CLI
 * name a release the same way.
 */
export const releaseInfo = () => {
  const stamped = process.env.GRAPHYARD_VERSION;
  if (stamped && (datedVersionPattern.test(stamped) || /^unreleased [0-9a-f]{7,40}$/.test(stamped))) return { version: stamped, revision: process.env.GRAPHYARD_BUILD_REVISION || cliRelease().revision };
  const own = cliRelease();
  return { version: own.version, revision: own.revision };
};

/** The image an install defaults to: the CLI's own release, else the stable channel. */
export const defaultImageFor = (release: Pick<Release, 'version' | 'released'>) => `${imageRepository}:${release.released ? release.version : stableChannel}`;
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
