import { execFileSync } from 'node:child_process';

export type ProtectionRun = (command: string, args: string[], input?: string) => string;
export const protectionRun: ProtectionRun = (command, args, input) => execFileSync(command, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });

const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, '$2');
/** The lines of the block a `key:` line at `indent` opens, or its inline value. */
function yamlBlock(lines: string[], key: string, indent: number) {
  const start = lines.findIndex(line => line.startsWith(`${' '.repeat(indent)}${key}:`) && !line.startsWith(`${' '.repeat(indent + 1)}`));
  if (start < 0) return null;
  const inline = lines[start].slice(indent + key.length + 1).replace(/\s+#.*$/, '').trim();
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (line.length - line.trimStart().length <= indent) break;
    body.push(line);
  }
  return { inline, body };
}

/**
 * A line-level reading of the workflow shapes that decide run cancellation: whether pull requests
 * trigger it, its jobs (the check-run names a branch requires), and its concurrency settings, top
 * level and per job. It reads only these keys and is no general YAML parser.
 */
export function readWorkflow(text: string) {
  const lines = text.split(/\r?\n/);
  const trigger = yamlBlock(lines, 'on', 0) ?? yamlBlock(lines, '"on"', 0) ?? yamlBlock(lines, "'on'", 0);
  const triggers = trigger ? [...`${trigger.inline}\n${trigger.body.filter(line => /^ {2}[\w-]+:/.test(line) || /^ {2}- /.test(line)).join('\n')}`.matchAll(/[\w-]+/g)].map(match => match[0]) : [];
  const concurrencyOf = (block: string[], indent: number) => {
    const found = yamlBlock(block, 'concurrency', indent);
    if (!found) return null;
    const field = (name: string) => { const line = found.body.find(entry => entry.trimStart().startsWith(`${name}:`)); return line === undefined ? null : unquote(line.trimStart().slice(name.length + 1)); };
    return found.inline ? { group: unquote(found.inline), cancelInProgress: null } : { group: field('group'), cancelInProgress: field('cancel-in-progress') };
  };
  const jobsBlock = yamlBlock(lines, 'jobs', 0)?.body ?? [];
  const jobs = jobsBlock.flatMap((line, index) => {
    const id = line.match(/^ {2}([\w-]+):\s*$/)?.[1];
    if (!id) return [];
    const end = jobsBlock.findIndex((next, at) => at > index && /^ {2}\S/.test(next));
    const body = jobsBlock.slice(index + 1, end < 0 ? undefined : end);
    const name = body.find(entry => /^ {4}name:/.test(entry));
    return [{ id, name: name ? unquote(name.replace(/^ {4}name:/, '')) : id, concurrency: concurrencyOf(body, 4) }];
  });
  return { pullRequest: triggers.some(name => name === 'pull_request' || name === 'pull_request_target'), push: triggers.includes('push'), concurrency: concurrencyOf(lines, 0), jobs };
}

// The merge-queue ruleset earlier installs wrote by name (GY-258): restore reads it back, and never as the operator's.
export const mergeQueueRulesetName = 'Graphyard merge queue';

// ---- Operator rulesets (GY-1926) ---------------------------------------------------------------
// A base branch may be governed by the operator's own repository rulesets instead of classic
// protection. `install --restore-protection` reads them to name their route; Graphyard writes none.

/** One `gh` call, as the installer's GitHubCli makes it. */
export interface GhAnswer { stdout: string; stderr: string; code: number }
export type GhApi = (args: string[], options?: { input?: string; allowFailure?: boolean }) => Promise<GhAnswer>;
// The merge-writer ruleset is named so an install that still carries it never reads it as the operator's.
const graphyardRulesets: string[] = [mergeQueueRulesetName, 'Graphyard merge writer only'];
// Inherited rulesets are listed too: an organization ruleset governs the base exactly as a repository one does.
const rulesetsPage = (repository: string, page: number) => `repos/${repository}/rulesets?includes_parents=true&per_page=100&page=${page}`;

/** An fnmatch glob as a regular expression source: `*` within one segment, `**` then a slash zero or more directories, a bare `**` across them, `?`, `[set]`, `[!set]`/`[^set]` and `\\` escapes. */
function fnmatchSource(glob: string) {
  const literal = (char: string) => char.replace(/[.+^${}()|[\]\\*?\/-]/g, '\\$&');
  let source = '';
  for (let at = 0; at < glob.length; at++) {
    const char = glob[at];
    if (char === '\\' && at + 1 < glob.length) source += literal(glob[++at]);
    // `**/` spans zero or more whole directories (File::FNM_PATHNAME), so `qa/**/*` matches `qa/foo` too.
    else if (char === '*' && glob[at + 1] === '*' && glob[at + 2] === '/') { source += '(?:[^/]*/)*'; at += 2; }
    else if (char === '*') { if (glob[at + 1] === '*') { source += '.*'; at++; } else source += '[^/]*'; }
    else if (char === '?') source += '[^/]';
    else if (char === '[') {
      let end = at + 1;
      if (glob[end] === '!' || glob[end] === '^') end++;
      if (glob[end] === ']') end++;
      while (end < glob.length && glob[end] !== ']') end++;
      // An unclosed bracket is a literal, as fnmatch reads it.
      if (end >= glob.length) { source += literal(char); continue; }
      let body = glob.slice(at + 1, end), negated = false;
      if (body[0] === '!' || body[0] === '^') { negated = true; body = body.slice(1); }
      let set = '';
      for (let index = 0; index < body.length; index++) {
        if (body[index + 1] === '-' && index + 2 < body.length) { set += `${literal(body[index])}-${literal(body[index + 2])}`; index += 2; }
        else set += literal(body[index]);
      }
      source += negated ? `[^/${set}]` : `[${set}]`;
      at = end;
    } else source += literal(char);
  }
  return source;
}
/** A ref_name pattern as GitHub matches it: `~ALL`, `~DEFAULT_BRANCH`, or an fnmatch glob over `refs/heads/…`. */
export function refPatternMatches(pattern: string, branch: string, defaultBranch: string | null) {
  if (pattern === '~ALL') return true;
  if (pattern === '~DEFAULT_BRANCH') return !!defaultBranch && branch === defaultBranch;
  return new RegExp(`^${fnmatchSource(pattern.replace(/^refs\/heads\//, ''))}$`).test(branch);
}
/** Whether an active branch ruleset document's conditions include BRANCH. */
export function rulesetGovernsBranch(ruleset: any, branch: string, defaultBranch: string | null) {
  const ref = ruleset?.conditions?.ref_name;
  if ((ruleset?.target ?? 'branch') !== 'branch' || ruleset?.enforcement !== 'active' || !ref) return false;
  const matches = (list: unknown) => (Array.isArray(list) ? list : []).some(pattern => refPatternMatches(String(pattern), branch, defaultBranch));
  return matches(ref.include) && !matches(ref.exclude);
}
export interface OperatorRulesets { rulesets: any[]; effectiveRules: unknown }
const operatorListed = (listed: any) => !graphyardRulesets.includes(listed?.name) && (listed?.target ?? 'branch') === 'branch' && (listed?.enforcement ?? 'active') === 'active';
/** The operator rulesets governing BRANCH, as full documents, from the listing pages and documents a reader fetched. */
const governing = (documents: any[], branch: string, defaultBranch: string | null) => documents.filter(document => !graphyardRulesets.includes(document?.name) && rulesetGovernsBranch(document, branch, defaultBranch));

/** A GET that must answer: its JSON (null for a 2xx without a document), or a refusal naming WHAT and GitHub's answer. */
async function confirmedGet(api: GhApi, path: string, what: string) {
  const answer = await api(['api', path], { allowFailure: true });
  if (answer.code !== 0) throw new Error(`GitHub did not answer ${what} (gh api ${path} exited ${answer.code}: ${`${answer.stderr}\n${answer.stdout}`.trim().split('\n')[0]}); confirm the gh login administers the repository, then rerun`);
  try { return JSON.parse(answer.stdout); } catch { return null; }
}
/**
 * Every active repository ruleset whose conditions include BRANCH, as full documents, and the branch's
 * effective rules. Any failed read refuses, naming it: an unknown ruleset set must never read as none.
 */
export async function readOperatorRulesets(api: GhApi, repository: string, branch: string): Promise<OperatorRulesets> {
  const listed: any[] = [];
  for (let page = 1; ; page++) {
    const rulesets = await confirmedGet(api, rulesetsPage(repository, page), `page ${page} of the rulesets of ${repository}`);
    const entries = Array.isArray(rulesets) ? rulesets : [];
    listed.push(...entries);
    if (entries.length < 100) break;
  }
  const candidates = listed.filter(operatorListed);
  const defaultBranch = candidates.length ? (await confirmedGet(api, `repos/${repository}`, `the repository ${repository}`))?.default_branch ?? null : null;
  const documents = [];
  for (const entry of candidates) documents.push(await confirmedGet(api, `repos/${repository}/rulesets/${entry.id}`, `ruleset ${entry.id} of ${repository}`));
  const rulesets = governing(documents, branch, defaultBranch);
  const effectiveRules = rulesets.length ? await confirmedGet(api, `repos/${repository}/rules/branches/${encodeURIComponent(branch)}`, `the effective rules of ${repository}@${branch}`) : null;
  return { rulesets, effectiveRules };
}
