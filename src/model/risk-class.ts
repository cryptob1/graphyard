import type { Work } from './work.js';

// ---- Risk class from the merge delta (GY-1521) ---------------------------------------------------

/**
 * The risk class of a change, judged from the files the merge would actually apply to the base
 * branch, beside the path-glob lane (`policy.ts determineLane`) that still gates github mode. The
 * lane classifies the pull request's observed paths; the class classifies the delta the merge
 * applies — the landing check's three-way result when it was computed against the live base tip —
 * and names, per file, the rule that made it sensitive. Nothing gates on the class yet: it is
 * computed on read and shown beside the lane by `graphyard status` and the item page.
 *
 * `sensitive` is the surface whose change wants the full ceremony: persistence and schema
 * (`src/store/`, `migrations/`), authentication, principals, the public API and its assembler and
 * bootstrap (`src/server/`), the operator agent and proof grants, installation and deployment
 * (`src/install/`, `deploy/`, Dockerfile, compose), CI configuration (`.github/`), dependencies
 * (`package.json`, `package-lock.json`) and the merge path itself (`src/merge-queue.ts`,
 * `src/direct-merge.ts`, `src/merger-mode.ts`, `src/main-guard.ts`, `src/regression-guard.ts`,
 * `src/merge-writer/`). Everything else is `normal`. A delta nobody can see (no files at all) is
 * sensitive: until the class can see what a change touches, it is treated as the worst case.
 */
export const riskClasses = ['sensitive', 'normal'] as const;
export type RiskClass = typeof riskClasses[number];

/** Every rule that makes a path sensitive, with the name a reason cites. */
export const sensitiveRules: readonly { rule: string; pattern: RegExp }[] = [
  { rule: 'persistence layer', pattern: /^src\/store\// },
  { rule: 'server auth, principals, API assembler, bootstrap or routes', pattern: /^src\/server\/(auth|principals|index|main|routes)/ },
  { rule: 'operator agent', pattern: /^src\/operator-agent\.ts$/ },
  { rule: 'proof grants', pattern: /^src\/proof-grants\.ts$/ },
  { rule: 'installation', pattern: /^src\/install\// },
  { rule: 'deployment', pattern: /^deploy\// },
  { rule: 'Dockerfile', pattern: /^Dockerfile/ },
  { rule: 'compose file', pattern: /^compose\.ya?ml$/ },
  { rule: 'CI configuration', pattern: /^\.github\// },
  { rule: 'dependencies', pattern: /^package(-lock)?\.json$/ },
  { rule: 'merge path', pattern: /^src\/(merge-queue|direct-merge|merger-mode|main-guard|regression-guard)\.ts$/ },
  { rule: 'merge writer', pattern: /^src\/merge-writer\// },
  { rule: 'migrations', pattern: /^migrations\// },
];

/** One file of a delta: its path and, for a rename, where it came from. */
export interface DeltaFile { path: string; previousPath?: string }
export interface RiskVerdict { risk: RiskClass; reasons: string[] }

/** The reason for one sensitive path: the path and the rule it matched, so a reader can check both. */
export const sensitiveReason = (path: string, rule: string) => `${path}: ${rule}`;
/** The reason an unseen delta is sensitive. */
export const unknownChangeReason = 'unknown change';

/** Both ends of each file: a rename out of a sensitive tree is a change to that tree whatever its destination. */
export function deltaPaths(files: readonly DeltaFile[]): string[] {
  return [...new Set(files.flatMap(file => file.previousPath && file.previousPath !== file.path ? [file.path, file.previousPath] : [file.path]))];
}

/**
 * The class of a delta. Each sensitive path yields one reason per rule it matches, naming the
 * path and the rule; a normal delta has no reasons; an empty delta is sensitive with the one
 * reason `unknown change`.
 */
export function classifyRisk(files: readonly DeltaFile[]): RiskVerdict {
  const paths = deltaPaths(files);
  if (!paths.length) return { risk: 'sensitive', reasons: [unknownChangeReason] };
  const reasons = paths.flatMap(path => sensitiveRules.filter(({ pattern }) => pattern.test(path)).map(({ rule }) => sensitiveReason(path, rule)));
  return reasons.length ? { risk: 'sensitive', reasons } : { risk: 'normal', reasons: [] };
}

declare module './work.js' {
  interface Work {
    /** GY-1521: the risk class of the delta the merge would apply, computed on read beside `lane`; never stamped by an evaluation. */
    risk?: RiskClass;
  }
}

/** What the delta was read from, so a reader knows which comparison the class judged. */
export type DeltaSource = 'landing' | 'scope' | 'files' | 'none';

/**
 * The delta an item's class is judged from: the landing check's files when that check compared
 * the current head against the live base tip (`observation.landing.base === observation.baseTip`),
 * else the candidate's scope files against its bound base, else the observation's plain file list.
 * No observation is no delta.
 */
export function riskDelta(work: Pick<Work, 'candidate' | 'observation'>): { files: DeltaFile[]; source: DeltaSource } {
  const obs = work.observation;
  if (!obs) return { files: [], source: 'none' };
  const currentHead = !work.candidate || obs.candidate.sha === work.candidate.sha;
  if (currentHead && obs.landing?.files && obs.baseTip && obs.landing.base === obs.baseTip) return { files: obs.landing.files, source: 'landing' };
  if (obs.scopeFiles) return { files: obs.scopeFiles, source: 'scope' };
  return { files: (obs.files ?? []).map(path => ({ path })), source: 'files' };
}

/** The item's risk class and its reasons, from the delta `riskDelta` selects. */
export function riskOf(work: Pick<Work, 'candidate' | 'observation'>): RiskVerdict & { source: DeltaSource } {
  const delta = riskDelta(work);
  return { ...classifyRisk(delta.files), source: delta.source };
}

/**
 * The item as a reader prints it: `risk` and its reasons placed right after `lane`, so the two
 * classifications of the same change read side by side, whatever order the record's keys came in.
 */
export function withRisk<T extends Pick<Work, 'candidate' | 'observation'>>(work: T): T & { risk: RiskClass; riskReasons: string[]; riskSource: DeltaSource } {
  const { risk, reasons, source } = riskOf(work);
  const shown: Record<string, unknown> = {};
  const beside = () => { shown.risk = risk; shown.riskReasons = reasons; shown.riskSource = source; };
  for (const [key, value] of Object.entries(work)) { shown[key] = value; if (key === 'lane') beside(); }
  if (!('risk' in shown)) beside();
  return shown as T & { risk: RiskClass; riskReasons: string[]; riskSource: DeltaSource };
}
