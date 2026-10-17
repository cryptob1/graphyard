// Concern: the read-only import plan behind `graphyard onboard inventory` — the inventory of a
// repository's open and draft pull requests, exactly one proposed disposition each, and the
// deterministic join of an external source-key mapping. Everything GitHub could change flows
// through `ImportSource`, whose methods are reads and nothing else, so the same plan is built
// from the real `gh` client and from a fixture, and building a plan writes nothing anywhere.

/** The disposition the inventory proposes for one open or draft pull request. Exactly one each. */
export type ImportDisposition = 'continue' | 'hold' | 'adopt' | 'superseded';
/** Every fact is marked with how it was learned: read from GitHub, or unknown because the read was not possible. */
export type FactState = 'detected' | 'unknown';
export interface ImportFact { fact: string; state: FactState; detail: string }

/** One open or draft pull request, as the listing reports it. */
export interface InventoryPull {
  number: number; base: string; headBranch: string; headSha: string; draft: boolean; url: string;
  /** GitHub's mergeability: false is a known conflict, true is clean, null is not computed yet. */
  mergeable: boolean | null;
}
/** One compare of the pull request's base branch against its exact head sha (three-dot). */
export interface InventoryCompare {
  status: string; aheadBy: number; behindBy: number; mergeBaseSha: string | null;
  files: { filename?: unknown; previous_filename?: unknown; status?: unknown; patch?: unknown; sha?: unknown }[];
}
/** One workflow of the repository, with the triggers its `on:` block names. */
export interface InventoryWorkflow { name: string; path: string; triggers: string[] | null }
/** One check result on one head commit: a check-run conclusion (with the App that ran it) or a commit-status state (no App). */
export interface InventoryCheck { name: string; result: string; appId?: number | null }
/** One required check of a base branch, from classic protection or an active ruleset: the App that must provide it, or null for any provider. */
export interface RequiredCheck { name: string; appId: number | null }

/**
 * Every read the inventory makes of GitHub — and the only thing it may ask for. There is no
 * write method to call, which is what makes a plan build provably read-only: a fixture records
 * each call and the unit tests hold the record against this list.
 */
export interface ImportSource {
  openPulls(repository: string): Promise<InventoryPull[]>;
  compareBaseHead(repository: string, base: string, head: string): Promise<InventoryCompare | null>;
  workflows(repository: string): Promise<InventoryWorkflow[] | null>;
  requiredChecks(repository: string, branch: string): Promise<RequiredCheck[] | null>;
  headChecks(repository: string, sha: string): Promise<InventoryCheck[] | null>;
}
/** The five read methods a source may be asked for; a recorded call outside them is a write. */
export const importReads = ['openPulls', 'compareBaseHead', 'workflows', 'requiredChecks', 'headChecks'] as const;

/** The triggers that make a workflow a release or deploy workflow. */
export const releaseDeployTriggers = ['release', 'deployment', 'deployment_status', 'registry_package'] as const;
export const isReleaseDeploy = (triggers: readonly string[]) => triggers.some(trigger => (releaseDeployTriggers as readonly string[]).includes(trigger));

/** The containment evidence a `superseded` proposal is required to show: the compare that proved it, for the pull's base branch and exact head sha. */
export interface ContainmentEvidence {
  evidence: 'compare';
  status: string; aheadBy: number; behindBy: number; mergeBaseSha: string | null;
}
/**
 * Whether the head's patch is contained in the base branch: GitHub's compare of `base...head`
 * reports the head ahead by zero commits (status `behind` or `identical`), so the base branch's
 * history holds every commit of the head. Any other status — `ahead`, `diverged` — or a compare
 * that could not be read is no evidence, and nothing is proposed superseded without it.
 */
export const patchContained = (compare: InventoryCompare | null): ContainmentEvidence | null =>
  compare && compare.aheadBy === 0 && (compare.status === 'behind' || compare.status === 'identical')
    ? { evidence: 'compare', status: compare.status, aheadBy: compare.aheadBy, behindBy: compare.behindBy, mergeBaseSha: compare.mergeBaseSha }
    : null;

const byText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** A check result that holds a required check back: anything but a clean conclusion. */
export const checkFailed = (result: string | undefined) => result !== undefined && !['success', 'neutral', 'skipped'].includes(result);
const describeRequired = (check: RequiredCheck) => check.appId === null ? check.name : `${check.name} (app ${check.appId})`;

/**
 * The required checks a head does not satisfy, or null when the requirements themselves are
 * unknown. A required check bound to an App is answered only by that App's results; an unbound
 * one by every result of its name. It is satisfied only when it has at least one result and none
 * of them is unclean, so a same-named success from another provider never masks a failure, and a
 * check with no result — not yet run, or head checks that could not be read — is not clean.
 */
export function failingRequired(required: readonly RequiredCheck[] | null, checks: readonly InventoryCheck[] | null): string[] | null {
  if (required === null) return null;
  return required.filter(want => {
    const answers = (checks ?? []).filter(check => check.name === want.name && (want.appId === null || (check.appId ?? null) === want.appId));
    return answers.length === 0 || answers.some(check => checkFailed(check.result));
  }).map(describeRequired);
}

/**
 * Why one pull request is proposed one disposition, in priority order: a contained patch is
 * superseded; a ready, conflict-free, non-draft request is eligible for same-PR adoption; a draft
 * is held (its refs preserved, nothing acts on it); everything else continues with its existing
 * controller. A failed required check keeps a ready request from adoption, and so do required
 * checks that could not be established (`failing` null): adoption needs an established, satisfied
 * requirement set. It also needs a definite no-conflict: mergeability GitHub reports as a conflict
 * — or has not computed at all — is no evidence of a clean merge, so the request continues instead.
 */
export function proposeDisposition(pull: InventoryPull, contained: ContainmentEvidence | null, failing: readonly string[] | null): ImportDisposition {
  if (contained) return 'superseded';
  if (!pull.draft && pull.mergeable === true && failing !== null && failing.length === 0) return 'adopt';
  if (pull.draft) return 'hold';
  return 'continue';
}

/** One pull request of the finished plan. */
export interface PlannedPull {
  repository: string; number: number; base: string; headBranch: string; headSha: string; draft: boolean; url: string;
  disposition: ImportDisposition;
  facts: ImportFact[];
  /** Present exactly when the disposition is `superseded`: the compare evidence that showed containment. */
  containment?: ContainmentEvidence;
}
/** One workflow of the finished plan. */
export interface PlannedWorkflow { name: string; path: string; state: FactState; triggers: string[]; releaseDeploy: boolean }
/** One mapped external source key, joined with its pull request when the inventory holds it. */
export interface PlannedMappingEntry {
  key: string; url: string | null; repository: string; number: number;
  /** The pull request this key binds, when the inventory lists it; null names an entry whose PR is not open. */
  pull: { disposition: ImportDisposition; headSha: string; url: string } | null;
}
/** A mapping the inventory could not resolve, named rather than silently applied. */
export type MappingConflict =
  | { kind: 'key-maps-two-prs'; key: string; targets: { repository: string; number: number }[] }
  | { kind: 'pr-mapped-by-two-keys'; repository: string; number: number; keys: string[] }
  | { kind: 'unreadable-entry'; index: number; detail: string };
/** The finished plan. Its JSON is byte-identical for the same inputs: fixed field order, sorted arrays, no clock. */
export interface ImportPlan {
  repository: string;
  mode: 'read-only inventory';
  pulls: PlannedPull[];
  workflows: { state: FactState; items: PlannedWorkflow[] };
  requiredChecks: { branch: string; state: FactState; checks: RequiredCheck[] }[];
  mapping: { entries: PlannedMappingEntry[]; conflicts: MappingConflict[] };
}

const repositoryPattern = /^[^\s/]+\/[^\s/]+$/;
const demand: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) throw new Error(message); };
const isSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

/** The listing's one entry, strictly shaped: the inventory reports every field it promises or refuses to guess. */
export function normalizePull(raw: unknown, repository: string): InventoryPull {
  const pull = raw as any, where = `a pull request of ${repository}`;
  demand(pull && typeof pull === 'object', `${where} is missing`);
  demand(Number.isSafeInteger(pull.number) && pull.number > 0, `${where} has no number`);
  demand(typeof pull.base === 'string' && pull.base, `${where} #${pull.number} has no base branch`);
  demand(typeof pull.headBranch === 'string' && !!pull.headBranch && isSha(pull.headSha), `${where} #${pull.number} has no head branch and exact head sha`);
  demand(typeof pull.url === 'string' && pull.url, `${where} #${pull.number} has no URL`);
  return { number: pull.number, base: pull.base, headBranch: pull.headBranch, headSha: pull.headSha,
    draft: pull.draft === true, url: pull.url, mergeable: typeof pull.mergeable === 'boolean' ? pull.mergeable : null };
}

/** One entry of a mapping file: an external source key and its URL, bound to a repository and pull request. */
export interface MappingEntry { key: string; url: string | null; repository: string; number: number }
export interface ParsedMapping { entries: MappingEntry[]; conflicts: MappingConflict[] }
/**
 * A mapping file as `--mapping FILE` reads it: `{"entries":[...]}` or a bare array, each entry
 * `{"key":...,"url":...,"repository":"OWNER/REPO","number":N}`. Repositories are normalized to
 * lowercase (GitHub's own matching is case-insensitive), and the entries are deduplicated and
 * sorted by key, so the same file always parses to the same mapping. An entry that is not well
 * formed is a named `unreadable-entry` conflict, never a silent drop.
 */
export function parseMapping(text: string): ParsedMapping {
  let document: unknown;
  try { document = JSON.parse(text); } catch (error) { throw new Error(`The mapping file does not parse as JSON: ${(error as Error).message}`); }
  const list = Array.isArray(document) ? document : (document as any)?.entries;
  demand(Array.isArray(list), 'The mapping file holds {"entries":[...]} or a bare array of entries');
  const entries = new Map<string, MappingEntry>();
  const conflicts: MappingConflict[] = [];
  for (const [index, raw] of list.entries()) {
    const entry = raw as any;
    const key = typeof entry?.key === 'string' ? entry.key.trim() : '';
    const url = typeof entry?.url === 'string' && entry.url.trim() ? entry.url.trim() : null;
    const repository = typeof entry?.repository === 'string' ? entry.repository.trim().toLowerCase() : '';
    const number = entry?.number;
    if (!key || !repositoryPattern.test(repository) || !Number.isSafeInteger(number) || number <= 0) {
      conflicts.push({ kind: 'unreadable-entry', index, detail: `entry ${index} of the mapping file is not {key, url?, repository OWNER/REPO, number}` });
      continue;
    }
    entries.set(`${key}\u0000${repository}\u0000${number}`, { key, url, repository, number });
  }
  // A key bound to two pull requests, or a pull request bound by two keys, is a conflict named
  // for what it binds: the mapping is reported, never resolved by picking one side.
  const byKey = new Map<string, { repository: string; number: number }[]>();
  for (const entry of entries.values()) {
    const targets = byKey.get(entry.key) ?? [];
    if (!targets.some(target => target.repository === entry.repository && target.number === entry.number)) targets.push({ repository: entry.repository, number: entry.number });
    byKey.set(entry.key, targets);
  }
  for (const [key, targets] of [...byKey].sort(([a], [b]) => byText(a, b)))
    if (targets.length > 1) conflicts.push({ kind: 'key-maps-two-prs', key, targets: targets.sort((a, b) => byText(a.repository, b.repository) || a.number - b.number) });
  const byPull = new Map<string, string[]>();
  for (const entry of entries.values()) {
    const pull = `${entry.repository}#${entry.number}`, keys = byPull.get(pull) ?? [];
    if (!keys.includes(entry.key)) keys.push(entry.key);
    byPull.set(pull, keys);
  }
  for (const [pull, keys] of [...byPull].sort(([a], [b]) => byText(a, b)))
    if (keys.length > 1) {
      const [repository, number] = [pull.slice(0, pull.lastIndexOf('#')), Number(pull.slice(pull.lastIndexOf('#') + 1))];
      conflicts.push({ kind: 'pr-mapped-by-two-keys', repository, number, keys: keys.sort(byText) });
    }
  return { entries: [...entries.values()].sort((a, b) => byText(a.key, b.key) || byText(a.repository, b.repository) || a.number - b.number), conflicts };
}

const factOf = (fact: string, state: FactState, detail: string): ImportFact => ({ fact, state, detail });

/**
 * Builds the plan. Every GitHub read goes through `source`; nothing is written anywhere; and the
 * output is deterministic: pulls in number order, workflows and base branches in text order, the
 * mapping sorted by key, facts in a fixed order, and no reading of the clock at all.
 */
export async function buildImportPlan(repository: string, source: ImportSource, mappingText: string | null): Promise<ImportPlan> {
  const pulls = (await source.openPulls(repository)).map(raw => normalizePull(raw, repository)).sort((a, b) => a.number - b.number);
  const branches = [...new Set(pulls.map(pull => pull.base))].sort(byText);
  const required = new Map<string, RequiredCheck[] | null>();
  for (const branch of branches) {
    const checks = await source.requiredChecks(repository, branch);
    required.set(branch, checks === null ? null : [...checks].sort((a, b) => byText(a.name, b.name) || (a.appId ?? 0) - (b.appId ?? 0)));
  }
  const planned: PlannedPull[] = [];
  for (const pull of pulls) {
    const [compare, checks] = await Promise.all([
      source.compareBaseHead(repository, pull.base, pull.headSha),
      source.headChecks(repository, pull.headSha),
    ]);
    const names = required.get(pull.base) ?? null;
    const failing = failingRequired(names, checks);
    const contained = patchContained(compare);
    const facts = [
      factOf('mergeability', pull.mergeable === null ? 'unknown' : 'detected',
        pull.mergeable === null ? 'GitHub has not computed mergeability' : pull.mergeable ? 'no conflict reported' : 'GitHub reports a conflict with the base branch'),
      factOf('required-checks', names === null ? 'unknown' : 'detected', names === null ? 'the base branch protection or rulesets could not be read' : names.length ? names.map(describeRequired).join(', ') : 'none required'),
      factOf('head-checks', checks === null ? 'unknown' : 'detected', checks === null ? 'the head checks could not be read'
        : checks.length ? checks.map(check => `${check.name}${check.appId ? ` (app ${check.appId})` : ''}=${check.result}`).sort(byText).join(', ') : 'none reported'),
    ];
    planned.push({ repository, ...pull, disposition: proposeDisposition(pull, contained, failing), facts, ...(contained ? { containment: contained } : {}) });
  }
  const listed = await source.workflows(repository);
  const items: PlannedWorkflow[] = (listed ?? []).map(workflow => ({
    name: workflow.name, path: workflow.path,
    state: (workflow.triggers === null ? 'unknown' : 'detected') as FactState,
    triggers: workflow.triggers ?? [],
    releaseDeploy: workflow.triggers !== null && isReleaseDeploy(workflow.triggers),
  })).sort((a, b) => byText(a.path, b.path) || byText(a.name, b.name));
  const parsed = mappingText === null ? { entries: [] as MappingEntry[], conflicts: [] as MappingConflict[] } : parseMapping(mappingText);
  // The join is case-insensitive: GitHub matches owner/repo names case-insensitively, so a mapping
  // entry names its pull request whatever case the operator typed either name in. The plan itself
  // keeps reporting the repository exactly as it was given.
  const index = new Map(planned.map(pull => [`${pull.repository.toLowerCase()}#${pull.number}`, pull]));
  return {
    repository,
    mode: 'read-only inventory',
    pulls: planned,
    workflows: { state: listed === null ? 'unknown' : 'detected', items },
    requiredChecks: branches.map(branch => {
      const checks = required.get(branch)!;
      return { branch, state: checks === null ? 'unknown' as const : 'detected' as const, checks: checks ?? [] };
    }),
    mapping: {
      entries: parsed.entries.map(entry => {
        const pull = index.get(`${entry.repository.toLowerCase()}#${entry.number}`);
        return { ...entry, pull: pull ? { disposition: pull.disposition, headSha: pull.headSha, url: pull.url } : null };
      }),
      conflicts: parsed.conflicts,
    },
  };
}
