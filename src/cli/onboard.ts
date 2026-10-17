import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { defineCommands } from './registry.js';
import { commandFailure, localTransport } from '../install/transport.js';
import { buildImportPlan, type ImportPlan, type ImportSource, type MappingConflict, type PlannedPull } from '../model/import-plan.js';

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
  return {
    async openPulls(repository) {
      const raw = await listed(gh, page => `repos/${repository}/pulls?state=open&per_page=100&page=${page}`);
      return raw.map(pull => ({
        number: pull.number, base: pull.base?.ref, headBranch: pull.head?.ref, headSha: pull.head?.sha,
        draft: pull.draft === true, url: pull.html_url, mergeable: typeof pull.mergeable === 'boolean' ? pull.mergeable : null,
      }));
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
        if (!Array.isArray(batch)) return listedWorkflows.length ? await Promise.all(listedWorkflows.map(toWorkflow.bind(null, repository, decode))) : null;
        listedWorkflows.push(...batch);
        if (batch.length < 100 || page >= 1_000) break;
      }
      return Promise.all(listedWorkflows.map(toWorkflow.bind(null, repository, decode)));
    },
    async requiredChecks(repository, branch) {
      const answer = await optional(`repos/${repository}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`);
      if (!answer) return null;
      const checks = Array.isArray(answer.checks) ? answer.checks.map((check: any) => check?.context).filter((name: unknown): name is string => typeof name === 'string') : [];
      const contexts = Array.isArray(answer.contexts) ? answer.contexts.filter((name: unknown): name is string => typeof name === 'string') : [];
      return [...new Set([...checks, ...contexts])].sort();
    },
    async headChecks(repository, sha) {
      const runs: any[] = [];
      for (let page = 1; ; page++) {
        const answer = await optional(`repos/${repository}/commits/${sha}/check-runs?per_page=100&page=${page}`);
        if (!Array.isArray(answer?.check_runs)) return runs.length ? dedupeChecks(runs) : null;
        runs.push(...answer.check_runs);
        if (answer.check_runs.length < 100 || page >= 1_000) break;
      }
      const statuses = await optional(`repos/${repository}/commits/${sha}/status`);
      for (const status of Array.isArray(statuses?.statuses) ? statuses.statuses : []) runs.push(status);
      return dedupeChecks(runs);
    },
  };
}
/** One listed workflow, with the triggers its file's `on:` block names, or unknown when the file cannot be read. */
const toWorkflow = async (repository: string, decode: (path: string) => Promise<string | null>, workflow: any) => ({
  name: String(workflow?.name ?? ''), path: String(workflow?.path ?? ''),
  triggers: typeof workflow?.path === 'string' && workflow.path
    ? workflowTriggers(await decode(`repos/${repository}/contents/${workflow.path.split('/').map(encodeURIComponent).join('/')}`) ?? '')
    : null,
});
/** Check runs decide; a commit status of the same context fills only where no check run reported. */
const dedupeChecks = (raw: any[]) => {
  const checks = new Map<string, string>();
  for (const entry of raw) {
    if (typeof entry?.name !== 'string' && typeof entry?.context !== 'string') continue;
    const name = entry.name ?? entry.context;
    const result = entry.conclusion ?? entry.state;
    if (typeof name === 'string' && typeof result === 'string' && !checks.has(name)) checks.set(name, result);
  }
  return [...checks.entries()].map(([name, result]) => ({ name, result }));
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
      `  ${usage}`,
      '                                Read-only import plan for a repository being brought under Graphyard: every open and draft',
      '                                pull request with number, base, head branch, exact head sha, draft flag and URL; the',
      '                                release/deploy workflow triggers and required checks it detects (each fact detected',
      '                                or unknown); exactly one proposed disposition per pull request — continue (left with',
      '                                its existing controller), hold (a draft: refs preserved, nothing acts on it), adopt',
      '                                (not a draft, no failing required check, no reported conflict: eligible for same-PR',
      '                                adoption) or superseded (only when the compare shows the base branch holds every',
      '                                commit of the head, with that evidence). Writes nothing but an explicit --out FILE.',
      '                                --mapping FILE binds external source keys and URLs to repository and pull request',
      '                                number; the output is byte-identical on reruns, and a key mapped to two pull',
      '                                requests, or a pull request mapped by two keys, is reported as a named conflict.',
    ],
    // The inventory reads GitHub only; it never uses the repository's connection file.
    readsConnection: () => false,
    async run(context) {
      await runOnboard(context.rest.slice(1), { exec: localTransport().exec, print: value => context.print(value), log: line => console.log(line) });
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
