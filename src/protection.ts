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
