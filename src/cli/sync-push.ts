import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { CliContext } from './context.js';
import type { SyncPushOutcome, SyncPushRequest } from '../sync.js';

type Git = (...args: string[]) => string;
type GitBytes = (...args: string[]) => Buffer;

/** A git identity line's time, `SECONDS ±HHMM`, as the ISO 8601 date in that zone GitHub's commit API takes. */
export function gitDateToIso(seconds: string, zone: string): string {
  const sign = zone.startsWith('-') ? -1 : 1, hours = Number(zone.slice(1, 3)), minutes = Number(zone.slice(3, 5));
  const local = new Date((Number(seconds) + sign * (hours * 60 + minutes) * 60) * 1000).toISOString().slice(0, 19);
  return `${local}${sign < 0 ? '-' : '+'}${zone.slice(1, 3)}:${zone.slice(3, 5)}`;
}
const identity = (line: string) => {
  const match = line.match(/^(.*) <(.*)> (\d+) ([+-]\d{4})$/);
  if (!match) throw new Error(`Cannot read the commit identity "${line}"`);
  return { name: match[1], email: match[2], date: gitDateToIso(match[3], match[4]) };
};

/**
 * Everything the control plane needs to rebuild COMMIT exactly through GitHub's Git Data API
 * (GY-1098): its raw headers and message, every path that differs from the base it merged (its
 * second parent), and the content of each blob GitHub cannot already hold — one in neither parent.
 * A commit carrying headers GitHub's API cannot reproduce (an encoding, a mergetag) is refused here.
 */
export function describeSyncCommit(git: Git, bytes: GitBytes, commit: string, epoch: number): SyncPushRequest {
  const raw = bytes('cat-file', 'commit', commit).toString('utf8');
  const split = raw.indexOf('\n\n');
  const headerText = split < 0 ? raw : raw.slice(0, split), message = split < 0 ? '' : raw.slice(split + 2);
  const headers: [string, string][] = [];
  for (const line of headerText.split('\n')) {
    if (line.startsWith(' ') && headers.length) headers[headers.length - 1][1] += `\n${line.slice(1)}`;
    else { const space = line.indexOf(' '); headers.push([line.slice(0, space), line.slice(space + 1)]); }
  }
  const unknown = headers.filter(([name]) => !['tree', 'parent', 'author', 'committer', 'gpgsig'].includes(name)).map(([name]) => name);
  if (unknown.length) throw new Error(`${commit.slice(0, 12)} carries ${unknown.join(', ')} headers the control plane cannot reproduce; make the base sync again with a plain git merge`);
  const value = (name: string) => headers.find(([key]) => key === name)?.[1];
  const parents = headers.filter(([name]) => name === 'parent').map(([, sha]) => sha);
  const signature = value('gpgsig');
  const request: SyncPushRequest = { epoch, commit, tree: value('tree')!, parents, message, author: identity(value('author')!), committer: identity(value('committer')!), ...(signature ? { signature } : {}), entries: [], blobs: [] };
  if (parents.length !== 2) return request;
  // Every path the commit changes against the base it merged; a deletion keeps the mode it had.
  const tokens = git('diff-tree', '-r', '-z', '--no-renames', '--no-abbrev', parents[1], commit).split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const header = tokens[i].match(/^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])$/);
    if (!header) continue;
    const [, oldMode, newMode, , newSha, status] = header;
    const deleted = status === 'D', mode = (deleted ? oldMode : newMode) as SyncPushRequest['entries'][number]['mode'];
    request.entries.push({ path: tokens[++i], mode, type: mode === '160000' ? 'commit' : 'blob', sha: deleted ? null : newSha });
  }
  const held = new Set(parents.flatMap(parent => git('ls-tree', '-r', '-z', parent).split('\0').map(line => line.split(/\s/)[2]).filter(Boolean)));
  const wanted = [...new Set(request.entries.filter(entry => entry.type === 'blob' && entry.sha && !held.has(entry.sha)).map(entry => entry.sha!))];
  request.blobs = wanted.map(sha => ({ sha, content: bytes('cat-file', 'blob', sha).toString('base64') }));
  return request;
}

/**
 * `graphyard sync GY-N --push-via-control-plane COMMIT`: the worker's own push of a base sync is
 * refused for want of the `workflows` permission (the installation has not granted it), so the
 * control plane pushes COMMIT to the worker's assigned branch with its own App — only when the
 * commit fast-forwards the branch, merges origin/BASE, and leaves every workflow file as the base
 * has it (except paths in plannedFiles). Any other commit is refused naming the differing paths.
 */
export async function pushViaControlPlane({ api, print, args }: CliContext, work: any): Promise<void> {
  const flag = args.indexOf('--push-via-control-plane'), named = args[flag + 1];
  if (!named || named.startsWith('-')) throw new Error(`Use sync ${work.key} --push-via-control-plane COMMIT, naming the base-sync merge commit`);
  const run = (gitArgs: string[]) => {
    const result = spawnSync('git', gitArgs, { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error || result.status !== 0) throw new Error(`git ${gitArgs.join(' ')} failed: ${result.stderr?.toString().trim() || result.error?.message || `exit ${result.status}`}`);
    return result.stdout;
  };
  const git: Git = (...gitArgs) => run(gitArgs).toString('utf8').trim();
  const branch = git('symbolic-ref', '--short', 'HEAD');
  const workspace = work.workspaces.find((entry: any) => entry.branch === branch);
  if (!workspace) throw new Error(`Run sync ${work.key} --push-via-control-plane from the workspace branch registered for ${work.key}; ${branch} is not one`);
  const commit = git('rev-parse', '--verify', `${named}^{commit}`);
  const request = describeSyncCommit(git, (...gitArgs) => run(gitArgs), commit, workspace.epoch);
  const outcome = await api(`work/${work.id}/sync-push`, request, randomUUID()) as SyncPushOutcome;
  // The local remote-tracking ref follows the push the control plane made, so the next plain push fast-forwards.
  try { run(['fetch', '--quiet', '--no-tags', 'origin', `refs/heads/${outcome.branch}:refs/remotes/origin/${outcome.branch}`]); }
  catch { /* A failure of the local remote-tracking fetch does not mask the successful push on the control plane */ }
  print({ ...outcome, next: `The control plane pushed ${commit.slice(0, 12)} to ${outcome.branch}. Later commits that leave .github/workflows alone push plainly; then complete ${work.key} ${outcome.epoch} PR.` });
}
