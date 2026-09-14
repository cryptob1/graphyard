import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export function repositoryFromRemote(remote: string) {
  const value = remote.trim();
  let path = /^git@github\.com:(.+)$/i.exec(value)?.[1];
  if (!path) {
    try {
      const url = new URL(value); const host = url.hostname.toLowerCase();
      const https = url.protocol === 'https:' && host === 'github.com' && !url.port;
      const ssh = url.protocol === 'ssh:' && url.username === 'git' && !url.password &&
        (host === 'github.com' && ['', '22'].includes(url.port) || host === 'ssh.github.com' && url.port === '443');
      if ((!https && !ssh) || url.search || url.hash) return null;
      path = url.pathname.slice(1);
    } catch { return null; }
  }
  return /^([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(path)?.[1] ?? null;
}
export function assertRepository(repository: string | null, configured: unknown) {
  if (typeof configured !== 'string' || !configured) return;
  if (!repository) throw new Error('Cannot verify this checkout against the configured server repository; configure its GitHub origin first');
  if (repository.toLowerCase() !== configured.toLowerCase()) throw new Error('This checkout and Graphyard server are configured for different repositories');
}
export async function discover(root: string) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let repository: string | null = null;
  try { repository = repositoryFromRemote(git('remote', 'get-url', 'origin')); } catch { /* no remote */ }
  let pkg: any = {};
  try { pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')); } catch { /* non-Node repository */ }
  let workflows: string[] = [];
  try { workflows = (await readdir(resolve(root, '.github/workflows'))).filter(f => /\.ya?ml$/.test(f)); } catch { /* no CI */ }
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  const frameworks = ['vitest', 'jest', '@playwright/test', 'cypress'].filter(name => dependencies[name]);
  return { repository, scripts: Object.keys(pkg.scripts ?? {}), frameworks, workflows,
    proposedChecks: ['test', 'typecheck'].filter(name => pkg.scripts?.[name]),
    lifecycle: ['ready', 'build', 'review', 'test', 'acceptance', 'merge', 'done'] };
}
export async function saveDiscovery(root: string) {
  const discovery = await discover(root);
  const directory = await localDirectory(root);
  await writeFile(resolve(directory, 'project.json'), JSON.stringify(discovery, null, 2), { mode: 0o600 });
  return discovery;
}
export async function localDirectory(root: string) {
  const tracked = execFileSync('git', ['ls-files', '--', '.graphyard'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (tracked.trim()) throw new Error('.graphyard contains tracked files; untrack and inspect them before saving credentials');
  const ignorePath = resolve(root, '.gitignore');
  let ignore = ''; try { ignore = await readFile(ignorePath, 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const ignored = (path: string) => {
    try { execFileSync('git', ['check-ignore', '--quiet', '--', path], { cwd: root, stdio: 'ignore' }); return true; }
    catch (error: any) { if (error.status === 1) return false; throw new Error('Cannot verify Git ignores local Graphyard credentials'); }
  };
  // An earlier matching line can be overridden by later negations. Ignore the
  // directory itself so nested rules cannot re-include credentials or temp files.
  const directory = resolve(root, '.graphyard'); await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!ignored('.graphyard')) await writeFile(ignorePath, `${ignore}${ignore.endsWith('\n') || !ignore ? '' : '\n'}.graphyard/\n`);
  if (!ignored('.graphyard') || !ignored('.graphyard/connection.json')) throw new Error('Local Graphyard credentials must be ignored by Git before saving');
  return directory;
}
