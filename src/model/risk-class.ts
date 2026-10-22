import type { Work } from './work.js';
import { compiledRules, repositoryPolicy, type CompiledRule, type RepositoryPolicy } from './repository-policy.js';

// ---- Risk class from the merge delta (GY-1521) ---------------------------------------------------

/**
 * The risk class of a change, judged from the files the merge would actually apply to the base
 * branch — the landing check's three-way result when it was computed against the live base tip —
 * naming, per file, the rule that made it sensitive. It is the one merge rule (model/gates.ts): a
 * sensitive delta waits for one independent approval before the merge writer merges it; any other
 * merges on its passing trial and is reviewed after the merge. It is computed on read and shown by
 * `graphyard status` and the item page.
 *
 * `sensitive` is whatever the repository's graphyard.json declares under `risk.sensitive`
 * (model/repository-policy.ts, GY-1843): each entry a glob and the rule a reason cites. A repository
 * that declares none gets the generic default — CI configuration, dependency manifests and
 * lockfiles, migrations, container, compose, deploy and infrastructure files, auth and secrets,
 * anywhere in the tree — never Graphyard's own layout, which Graphyard's graphyard.json declares for
 * itself. Everything else is `normal`. A delta nobody can see (no files at all) is sensitive: until
 * the class can see what a change touches, it is treated as the worst case.
 */
export const riskClasses = ['sensitive', 'normal'] as const;
export type RiskClass = typeof riskClasses[number];

const compiled = new WeakMap<RepositoryPolicy, CompiledRule[]>();
/** Every rule that makes a path sensitive under `policy` (the one in force by default), with the name a reason cites. */
export function riskRules(policy: RepositoryPolicy = repositoryPolicy()): readonly CompiledRule[] {
  let rules = compiled.get(policy);
  if (!rules) compiled.set(policy, rules = compiledRules(policy));
  return rules;
}
/** The rules in force when this module loaded; readers that must follow a replaced policy call `riskRules()`. */
export const sensitiveRules: readonly CompiledRule[] = riskRules();

/** Whether a change of this class is reviewed before it merges: only a sensitive one; a normal change merges on its trial and owes one post-merge review (GY-1525). */
export const reviewedBeforeMerge = (risk: RiskClass) => risk === 'sensitive';

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
 * The class of a delta under the repository's policy. Each sensitive path yields one reason per rule it matches, naming the
 * path and the rule; a normal delta has no reasons; an empty delta is sensitive with the one
 * reason `unknown change`.
 */
export function classifyRisk(files: readonly DeltaFile[], policy: RepositoryPolicy = repositoryPolicy()): RiskVerdict {
  const paths = deltaPaths(files);
  if (!paths.length) return { risk: 'sensitive', reasons: [unknownChangeReason] };
  const reasons = paths.flatMap(path => riskRules(policy).filter(({ pattern }) => pattern.test(path)).map(({ rule }) => sensitiveReason(path, rule)));
  return reasons.length ? { risk: 'sensitive', reasons } : { risk: 'normal', reasons: [] };
}

declare module './work.js' {
  interface Work {
    /** GY-1521: the risk class of the delta the merge would apply, computed on read; never stamped by an evaluation. */
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
export function riskOf(work: Pick<Work, 'candidate' | 'observation'>, policy: RepositoryPolicy = repositoryPolicy()): RiskVerdict & { source: DeltaSource } {
  const delta = riskDelta(work);
  return { ...classifyRisk(delta.files, policy), source: delta.source };
}

/**
 * The risk the item page shows (GY-1843): judged by the policy the control plane serves on
 * /api/status (`repositoryPolicy`), the one its gates use; only a status that carries none — an older
 * server — falls back to this process's own reading, marked `estimated` so the page labels it.
 */
export function shownRisk(work: Pick<Work, 'candidate' | 'observation'>, served?: RepositoryPolicy | null): RiskVerdict & { estimated: boolean } {
  const { risk, reasons } = served ? riskOf(work, served) : riskOf(work);
  return { risk, reasons, estimated: !served };
}

/** The item as a reader prints it: `risk`, its reasons and source right after `key`. */
export function withRisk<T extends Pick<Work, 'candidate' | 'observation'>>(work: T): T & { risk: RiskClass; riskReasons: string[]; riskSource: DeltaSource } {
  const { risk, reasons, source } = riskOf(work);
  const shown: Record<string, unknown> = {};
  const beside = () => { shown.risk = risk; shown.riskReasons = reasons; shown.riskSource = source; };
  for (const [key, value] of Object.entries(work)) { shown[key] = value; if (key === 'key') beside(); }
  if (!('risk' in shown)) beside();
  return shown as T & { risk: RiskClass; riskReasons: string[]; riskSource: DeltaSource };
}
