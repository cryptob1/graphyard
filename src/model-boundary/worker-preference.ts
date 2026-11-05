import { type RepositoryPolicy, globSurface } from '../model/repository-policy.js';
import { repositoryPolicy } from './repository-policy.js';
import { riskRules, classifyRisk } from './risk-class.js';
import { pathScope, namedPaths } from '../model/documentation-glob.js';
import { surfaceOverlaps, type PreferenceWork, piAttempts } from '../model/worker-preference.js';
/**
 * The surface each sensitive rule guards (`riskRules`, the repository's policy), as the literal head
 * of each of its globs: the directory (ending `/`) or the file itself, and for a rule over several
 * globs each of them. A path an item names is a scope, not always a concrete path (`pathScope`):
 * `src/`, `src/**` or `src/server/` admit every file beneath them, among them these surfaces, while
 * matching no rule literally. A directory scope is therefore sensitive when it overlaps any surface
 * here, so an item that may change a sensitive file never gets a cheap attempt because it named the
 * directory instead of the file. A glob that may match anywhere (`**\/migrations/**`) has the empty surface,
 * which every directory scope overlaps. Every surface matches its own rule's pattern, and every rule
 * has a surface (tests/worker-preference-risk.test.ts).
 */
export const surfacesOf = (policy: RepositoryPolicy = repositoryPolicy()): Readonly<Record<string, readonly string[]>> =>
  Object.fromEntries(riskRules(policy).map(({ rule, globs }) => [rule, [...new Set(globs.map(globSurface))]]));
/** The surfaces of the policy in force when this module loaded. */
export const sensitiveSurfaces = surfacesOf();

/**
 * Whether one named path may change a sensitive file: an exact path when a sensitive rule matches
 * it (`classifyRisk`), a directory scope when it overlaps a rule's surface as well (`surfaceOverlaps`). The literal test
 * runs for a directory scope too, so a scope inside a sensitive tree (`src/store/x/`) is sensitive by
 * the rule itself.
 */
export const entrySensitive = (entry: string, policy: RepositoryPolicy = repositoryPolicy()): boolean =>
  classifyRisk([{ path: entry }], policy).risk === 'sensitive'
    || !!pathScope(entry).prefix && riskRules(policy).some(({ globs }) => globs.some(glob => surfaceOverlaps(entry, glob)));
/**
 * Which runtimes dispatch tries a worker on first (GY-1746, GY-1772): Pi for an item whose named
 * change is normal risk — no path its criteria or description name matches a sensitive rule of the
 * repository's policy nor, as a directory scope, covers a rule's surface (`sensitiveSurfaces`) — on its
 * first attempts; the strong runtimes for a sensitive named path, for an item that names no path (a
 * change nobody can see is the worst case, as `classifyRisk` judges it) and from the third attempt on. The
 * item's path lane is not read: the lane classifies the pull request's observed paths once there is
 * one, while the class judges the change before any launch, so a sensitive change never gets a
 * cheap first attempt because its lane was not yet raised, and a normal change in a high lane still
 * does. `startFailures` counts the launches this dispatch has already spent on accounts that failed
 * to start.
 */
export const workerPreference = (work: PreferenceWork, startFailures = 0): 'fast' | 'strong' => {
  const text = [work.description ?? '', ...(work.criteria ?? []).map(criterion => criterion.text)].join('\n'), named = namedPaths(text);
  // A root file prose names without a dot or a slash (`Dockerfile`) is judged as a word.
  const words = text.match(/[A-Za-z][\w.-]*/g) ?? [];
  // Attempts already made count whether they ended in a rework round or in an expired or blocked epoch.
  return !named.length || [...named, ...words].some(entry => entrySensitive(entry))
    || Math.max(work.pipeline?.reworkRounds ?? work.reworkRounds ?? 0, work.pipeline?.attempts?.length ?? work.attemptCount ?? 0) + startFailures >= piAttempts ? 'strong' : 'fast';
};
