import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { defineCommands } from './registry.js';
import { commandFailure, localTransport } from '../install/transport.js';
import { buildImportPlan, type ImportPlan, type ImportSource, type MappingConflict, type PlannedPull, type RequiredCheck } from '../model/import-plan.js';

/**
 * `graphyard onboard inventory` (GY-1847): the read-only import plan for a repository that is
 * being brought under Graphyard. It lists every open and draft pull request with its number,
 * base, head branch, exact head sha, draft flag and URL, the release/deploy workflow triggers and
 * required checks it detects (each fact marked detected or unknown), and proposes exactly one
 * disposition per pull request. It never closes anything and writes nothing but an explicit
 * `--out FILE`; GitHub is read through the same client the installer uses (`gh api`).
 */

const usage = 'graphyard onboard inventory --repo OWNER/REPO [--mapping FILE] [--out FILE] [--json]';

/** Runs `gh api` as the installer's transport runs it; an `optional` read yields `null` when gh fails. */
export type GhApi = (args: string[], optional?: boolean) => Promise<string | null>;

export const ghApi = (exec: (program: string, args: string[], options?: { allowFailure?: boolean; timeout?: number }) => Promise<{ stdout: string; stderr: string; code: number }>): GhApi =>
  async (args, optional = false) => {
    const result = await exec('gh', ['api', ...args], { allowFailure: optional, timeout: 120_000 });
    if (result.code !== 0) {
      if (optional) return null;
      throw commandFailure('gh', result);
    }
    return result.stdout;
  };

/** The pages of a list endpoint, read until a short page ends the listing. */
async function listed(gh: GhApi, path: (page: number) => string): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; ; page++) {
    const answer = await gh([`${path(page)}`]);
    if (!answer) throw new Error(`gh api ${path(page)} failed`);
    const batch = JSON.parse(answer);
    if (!Array.isArray(batch)) throw new Error(`gh api ${path(page)} did not return a list`);
    out.push(...batch);
    if (batch.length < 100 || page >= 1_000) return out;
  }
}

/** The `on:` block of a workflow file, as far as an inventory needs it: trigger names, or null when none can be read. */
export function workflowTriggers(source: string): string[] | null {
  const lines = source.split('\n');
  const unquote = (value: string) => value.trim().replace(/^['"]|['"]$/g, '');
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^(?:["']?on["']?):(?:\s*(.*))?$/);
    if (!match) continue;
    const rest = (match[1] ?? '').trim();
    if (rest.startsWith('[')) return rest.includes(']') ? rest.slice(1, rest.indexOf(']')).split(',').map(unquote).filter(Boolean) : null;
    if (rest.startsWith('{')) return rest.includes('}') ? rest.slice(1, rest.indexOf('}')).split(',').map(item => unquote(item.split(':')[0] ?? '')).filter(Boolean) : null;
    if (rest) return [unquote(rest)];
    // Block style: the keys at the first indented line's indent are the triggers; deeper lines are
    // a trigger's own attributes, and a dedent (or a keyless line) ends the block.
    const triggers: string[] = [];
    let indent: number | null = null;
    for (const inner of lines.slice(index + 1)) {
      const stripped = inner.trim();
      if (!stripped || stripped.startsWith('#')) continue;
      const entry = inner.match(/^(\s+)([\w.-]+):/);
      if (!entry) break;
      if (indent === null) indent = entry[1].length;
      if (entry[1].length < indent) break;
      if (entry[1].length === indent) triggers.push(entry[2]);
    }
    return triggers.length ? triggers : null;
  }
  return null;
}

/**
 * The inventory's GitHub reads, on the client the installer uses. Only these endpoints are asked,
 * and every one is a GET: the model's `ImportSource` has no write to call, and this adapter gives
 * it none.
 */
export function ghImportSource(gh: GhApi): ImportSource {
  const decode = async (path: string): Promise<string | null> => {
    const text = await gh([path], true);
    if (!text) return null;
    const answer = JSON.parse(text);
    return answer?.encoding === 'base64' && typeof answer.content === 'string' ? Buffer.from(answer.content, 'base64').toString('utf8') : null;
  };
  const optional = async (path: string): Promise<any | null> => {
    const text = await gh([path], true);
    if (!text) return null;
    const answer = JSON.parse(text);
    return answer && typeof answer === 'object' ? answer : null;
  };
  // Every page of a listing, or null when any page cannot be read: a partial listing is unknown, never a short one.
  const paged = async (path: (page: number) => string, pick: (answer: any) => unknown): Promise<any[] | null> => {
    const out: any[] = [];
    for (let page = 1; ; page++) {
      const batch = pick(await optional(path(page)));
      if (!Array.isArray(batch)) return null;
      out.push(...batch);
      if (batch.length < 100 || page >= 1_000) return out;
    }
  };
  return {
    async openPulls(repository) {
      const raw = await listed(gh, page => `repos/${repository}/pulls?state=open&per_page=100&page=${page}`);
      // The list endpoint's shape carries no mergeability — GitHub computes it per pull request and
      // answers it on the single-pull read, and may still be computing it there. One read each,
      // before any disposition is proposed; a read that fails, or a value still unset, stays null
      // (unknown), and the model never proposes adoption without a definite no-conflict.
      // The detail's mergeability counts only while it describes the listed head and base: a push
      // between the two reads leaves it describing another revision, so it is unknown instead.
      return pooled(raw, async pull => {
        const detail = await optional(`repos/${repository}/pulls/${pull.number}`);
        const sameRevision = detail?.head?.sha === pull.head?.sha && detail?.base?.ref === pull.base?.ref;
        return {
          number: pull.number, base: pull.base?.ref, headBranch: pull.head?.ref, headSha: pull.head?.sha,
          draft: pull.draft === true, url: pull.html_url,
          mergeable: sameRevision && typeof detail?.mergeable === 'boolean' ? detail.mergeable : null,
        };
      });
    },
    async compareBaseHead(repository, base, head) {
      const answer = await optional(`repos/${repository}/compare/${encodeURIComponent(base)}...${head}`);
      if (!answer) return null;
      return { status: answer.status, aheadBy: answer.ahead_by, behindBy: answer.behind_by, mergeBaseSha: answer.merge_base_commit?.sha ?? null, files: Array.isArray(answer.files) ? answer.files : [] };
    },
    async workflows(repository) {
      const listedWorkflows: any[] = [];
      for (let page = 1; ; page++) {
        const answer = await optional(`repos/${repository}/actions/workflows?per_page=100&page=${page}`);
        const batch = answer?.workflows;
        if (!Array.isArray(batch)) return listedWorkflows.length ? await pooled(listedWorkflows, toWorkflow.bind(null, repository, decode)) : null;
        listedWorkflows.push(...batch);
        if (batch.length < 100 || page >= 1_000) break;
      }
      return pooled(listedWorkflows, toWorkflow.bind(null, repository, decode));
    },
    // Classic protection (from the branch read, which an unprotected branch answers too) and every
    // active repository or organization ruleset rule for the branch, combined with the App each
    // check is bound to. Either read failing leaves the requirements unknown, never partial.
    async requiredChecks(repository, branch) {
      const read = await optional(`repos/${repository}/branches/${encodeURIComponent(branch)}`);
      if (typeof read?.protected !== 'boolean' || (read.protected && !read.protection)) return null;
      const rules = await paged(page => `repos/${repository}/rules/branches/${encodeURIComponent(branch)}?per_page=100&page=${page}`, answer => answer);
      if (rules === null) return null;
      const found = new Map<string, RequiredCheck>();
      const add = (name: unknown, appId: number | null) => { if (typeof name === 'string' && name) found.set(`${name}\u0000${appId}`, { name, appId }); };
      const classic = read.protected ? read.protection.required_status_checks : null;
      if (classic && classic.enforcement_level !== 'off') {
        for (const check of Array.isArray(classic.checks) ? classic.checks : []) add(check?.context, appOf(check?.app_id));
        const bound = new Set((Array.isArray(classic.checks) ? classic.checks : []).map((check: any) => check?.context));
        for (const name of Array.isArray(classic.contexts) ? classic.contexts : []) if (!bound.has(name)) add(name, null);
      }
      for (const rule of rules) if (rule?.type === 'required_status_checks')
        for (const check of Array.isArray(rule.parameters?.required_status_checks) ? rule.parameters.required_status_checks : []) add(check?.context, appOf(check?.integration_id));
      return [...found.values()];
    },
    // Every page of check runs and of the combined status; any page that cannot be read leaves the head checks unknown.
    async headChecks(repository, sha) {
      const runs = await paged(page => `repos/${repository}/commits/${sha}/check-runs?per_page=100&page=${page}`, answer => answer?.check_runs);
      if (runs === null) return null;
      const statuses = await paged(page => `repos/${repository}/commits/${sha}/status?per_page=100&page=${page}`, answer => answer?.statuses);
      if (statuses === null) return null;
      return dedupeChecks(runs, statuses);
    },
  };
}
/** Maps every entry in order with at most eight reads in flight, so a large repository never starts one gh process per pull request at once. */
const pooled = async <T, R>(entries: readonly T[], map: (entry: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = new Array(entries.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, entries.length) }, async () => {
    while (next < entries.length) { const at = next++; results[at] = await map(entries[at]); }
  }));
  return results;
};
/** One listed workflow, with the triggers its file's `on:` block names, or unknown when the file cannot be read. */
const toWorkflow = async (repository: string, decode: (path: string) => Promise<string | null>, workflow: any) => ({
  name: String(workflow?.name ?? ''), path: String(workflow?.path ?? ''),
  triggers: typeof workflow?.path === 'string' && workflow.path
    ? workflowTriggers(await decode(`repos/${repository}/contents/${workflow.path.split('/').map(encodeURIComponent).join('/')}`) ?? '')
    : null,
});
/** A protection or ruleset App binding: a positive App id, or null for any provider (GitHub's -1 and an absent id). */
const appOf = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
/**
 * One result per check run name and App, and one per commit-status context (no App). Among runs of
 * one name and App, the latest reported activity decides: a re-run in progress, or a run still
 * queued, is that name's state until it concludes, so a pending required check is read as not yet
 * clean instead of silently absent. The combined status already holds each context's latest
 * state, so its first entry per context stands. Runs and statuses of one name are both kept: the
 * model holds a required check back when any result it accepts is unclean.
 */
const dedupeChecks = (runs: any[], statuses: any[]) => {
  const checks = new Map<string, { name: string; appId: number | null; at: string; result: string }>();
  for (const run of runs) {
    const result = typeof run?.conclusion === 'string' ? run.conclusion : typeof run?.status === 'string' ? run.status : null;
    if (typeof run?.name !== 'string' || result === null) continue;
    const appId = appOf(run.app?.id), key = `run\u0000${run.name}\u0000${appId}`;
    const at = typeof run.completed_at === 'string' && run.completed_at ? run.completed_at : typeof run.started_at === 'string' && run.started_at ? run.started_at : '';
    const prior = checks.get(key);
    if (!prior || at >= prior.at) checks.set(key, { name: run.name, appId, at, result });
  }
  for (const status of statuses) {
    const key = `status\u0000${status?.context}`;
    if (typeof status?.context === 'string' && typeof status.state === 'string' && !checks.has(key)) checks.set(key, { name: status.context, appId: null, at: '', result: status.state });
  }
  return [...checks.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : (a.appId ?? 0) - (b.appId ?? 0) || (a.result < b.result ? -1 : a.result > b.result ? 1 : 0)))
    .map(({ name, appId, result }) => ({ name, result, appId }));
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** The one-paragraph summary printed when the plan went to `--out` instead of stdout. */
export function summarize(plan: ImportPlan, written: string | null): string {
  const counts = (['continue', 'hold', 'adopt', 'superseded'] as const).map(disposition =>
    `${plan.pulls.filter(pull => pull.disposition === disposition).length} ${disposition}`).join(', ');
  const lines = [
    `${plan.repository}: ${plural(plan.pulls.length, 'open or draft pull request')} — ${counts}`,
    ...plan.workflows.items.filter(item => item.releaseDeploy).map(item => `release/deploy workflow ${item.path} (${item.triggers.join(', ')})`),
    ...plan.mapping.conflicts.map(conflict => `mapping conflict: ${describeConflict(conflict)}`),
    ...(written ? [`wrote ${written}`] : []),
  ];
  return lines.join('\n');
}
export const describeConflict = (conflict: MappingConflict): string =>
  conflict.kind === 'key-maps-two-prs' ? `key ${conflict.key} maps pull requests ${conflict.targets.map(target => `${target.repository}#${target.number}`).join(', ')}`
    : conflict.kind === 'pr-mapped-by-two-keys' ? `${conflict.repository}#${conflict.number} is mapped by keys ${conflict.keys.join(', ')}`
    : conflict.detail;
const dispositionLine = (pull: PlannedPull) => `#${pull.number} ${pull.disposition}${pull.containment ? ' (contained in base)' : ''}: ${pull.base} <- ${pull.headBranch} @ ${pull.headSha.slice(0, 12)}${pull.draft ? ' draft' : ''} ${pull.url}`;

export const onboardCommands = defineCommands([
  {
    name: 'onboard',
    help: [
      `  ${usage.replace(/^graphyard /, '')}`,
      '                                Read-only import plan for a repository being brought under Graphyard: every open and draft',
      '                                pull request with number, base, head branch, exact head sha, draft flag and URL; the',
      '                                release/deploy workflow triggers and required checks it detects (each fact detected',
      '                                or unknown); exactly one proposed disposition per pull request — continue (left with',
      '                                its existing controller), hold (a draft: refs preserved, nothing acts on it), adopt (not a',
      '                                draft, mergeable, every classic or ruleset required check known and clean from its bound App: same-PR',
      '                                adoption) or superseded (only when the compare shows the base branch holds every',
      '                                commit of the head, with that evidence). Writes nothing but an explicit --out FILE.',
      '                                --mapping FILE binds external source keys and URLs to repository and pull request',
      '                                number; the output is byte-identical on reruns, and a key mapped to two pull',
      '                                requests, or a pull request mapped by two keys, is reported as a named conflict.',
    ],
    // The inventory reads GitHub only; it never uses the repository's connection file.
    readsConnection: () => false,
    // `context.rest` holds every word after `graphyard onboard`, `inventory` included; runOnboard
    // owns the subcommand check, so the token is forwarded, never sliced off. The dependency
    // parameter exists for the test that runs the registered handler against a fake `gh`.
    async run(context, _work, deps: Parameters<typeof runOnboard>[1] = { exec: localTransport().exec, print: value => context.print(value), log: line => console.log(line) }) {
      await runOnboard(context.rest, deps);
    },
  },
]);

/** The command body, separated from the launcher so a fixture can run it against a fake `gh`. */
export async function runOnboard(argv: string[], deps: { exec: Parameters<typeof ghApi>[0]; print: (value: unknown) => void; log: (line: string) => void }) {
  const { values } = parseArgs({
    args: argv, options: { repo: { type: 'string' }, mapping: { type: 'string' }, out: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
  });
  if (argv[0] !== 'inventory') throw new Error(`onboard needs an inventory subcommand: ${usage}`);
  if (values.repo === undefined) throw new Error(`onboard inventory needs --repo OWNER/REPO: ${usage}`);
  if (!/^[^\s/]+\/[^\s/]+$/.test(values.repo)) throw new Error(`--repo must be OWNER/REPO, not "${values.repo}"`);
  const mappingText = values.mapping === undefined ? null : await readFile(values.mapping, 'utf8');
  const plan = await buildImportPlan(values.repo, ghImportSource(ghApi(deps.exec)), mappingText);
  const json = `${JSON.stringify(plan, null, 2)}\n`;
  if (values.out !== undefined) await writeFile(values.out, json);
  if (values.json || values.out === undefined) deps.print(JSON.parse(json));
  else deps.log(summarize(plan, values.out));
}
