import { type RepositoryPolicy, type CompiledRule, compiledRules, compiledExclusion } from '../model/repository-policy.js';
import { repositoryPolicy } from './repository-policy.js';
import { compiled, type DeltaFile, type RiskVerdict, deltaPaths, unknownChangeReason, sensitiveReason, type DeltaSource, riskDelta, type RiskClass } from '../model/risk-class.js';
import type { Work } from '../model/work.js';
/** Every rule that makes a path sensitive under `policy` (the one in force by default), with the name a reason cites. */
export function riskRules(policy: RepositoryPolicy = repositoryPolicy()): readonly CompiledRule[] {
  let rules = compiled.get(policy);
  if (!rules) compiled.set(policy, rules = compiledRules(policy));
  return rules;
}
const exclusions = new WeakMap<RepositoryPolicy, RegExp | null>();
/** The one matcher over the policy's exclusions (`!glob`), null when it excludes nothing. */
const exclusionOf = (policy: RepositoryPolicy) => {
  if (!exclusions.has(policy)) exclusions.set(policy, compiledExclusion(policy));
  return exclusions.get(policy)!;
};
/** The rules in force when this module loaded; readers that must follow a replaced policy call `riskRules()`. */
export const sensitiveRules: readonly CompiledRule[] = riskRules();

/**
 * The class of a delta under the repository's policy. Each sensitive path yields one reason per rule it matches, naming the
 * path and the rule; a normal delta has no reasons; an empty delta is sensitive with the one
 * reason `unknown change`. A path an exclusion (`!glob`) matches yields no reason, whatever rule it matches.
 */
export function classifyRisk(files: readonly DeltaFile[], policy: RepositoryPolicy = repositoryPolicy()): RiskVerdict {
  const paths = deltaPaths(files);
  if (!paths.length) return { risk: 'sensitive', reasons: [unknownChangeReason] };
  const excluded = exclusionOf(policy);
  const reasons = paths.filter(path => !excluded?.test(path)).flatMap(path => riskRules(policy).filter(({ pattern }) => pattern.test(path)).map(({ rule }) => sensitiveReason(path, rule)));
  return reasons.length ? { risk: 'sensitive', reasons } : { risk: 'normal', reasons: [] };
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
