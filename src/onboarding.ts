import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export function repositoryFromRemote(remote: string) {
  const match = remote.trim().match(/^(?:git@github\.com:|https:\/\/(?:[^/@]+@)?github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  return match?.[1] ?? null;
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
  if (!ignore.split('\n').includes('.graphyard/')) await writeFile(ignorePath, `${ignore}${ignore.endsWith('\n') || !ignore ? '' : '\n'}.graphyard/\n`);
  const directory = resolve(root, '.graphyard'); await mkdir(directory, { recursive: true, mode: 0o700 }); return directory;
}
