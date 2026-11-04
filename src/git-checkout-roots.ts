import { execFileSync } from 'node:child_process';
export function connectionRoots(cwd: string) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const current = git('rev-parse', '--show-toplevel');
  const primary = git('worktree', 'list', '--porcelain', '-z').split('\0').find(line => line.startsWith('worktree '))?.slice(9);
  if (!primary) throw new Error('Cannot locate the primary checkout for shared worker configuration');
  // A bare repository has no primary checkout in which to keep ignored config.
  execFileSync('git', ['-C', primary, 'rev-parse', '--show-toplevel'], { stdio: 'ignore' });
  return [...new Set([primary, current])];
}
