// Concern: the browser tool a product review walks the app with — where the install keeps it, how it is found, and its one-time install (GY-3331, GY-3370).
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

/** GY-3331: the browser tool a product review walks the app with, as the E2E runner drives it. */
export const browserToolName = 'agent-browser';
/** GY-3370: the pinned version the install provisions. */
export const browserToolVersion = '0.43.0';

/** Resolves the browser tool on a PATH, or null when no directory of it holds an executable one. */
export function browserToolOnPath(environment: { PATH?: string } = process.env): string | null {
  for (const directory of (environment.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    try {
      const tool = resolve(directory, browserToolName);
      if (existsSync(tool) && statSync(tool).isFile() && statSync(tool).mode & 0o111) return tool;
    } catch { /* an unreadable directory holds nothing to find */ }
  }
  return null;
}

/**
 * GY-3370: the install's own tool directory. It sits outside the operator config home, which every
 * session's credential mask hides, so the reviewer session reads it like any host path.
 */
export const browserToolDirectory = () => resolve(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'graphyard', 'tools');
const toolBin = (directory: string) => join(directory, 'node_modules', '.bin');
/** The one command that installs the pinned tool and the browser it drives into the tool directory. */
export const browserInstallCommand = (directory = browserToolDirectory()) =>
  `npm install --prefix ${directory} --no-save ${browserToolName}@${browserToolVersion} && ${join(toolBin(directory), browserToolName)} install`;

/** The tool on the host's PATH or in the install's tool directory, or null. */
export const findBrowserTool = (environment: { PATH?: string } = process.env) =>
  browserToolOnPath({ PATH: [toolBin(browserToolDirectory()), environment.PATH ?? ''].join(delimiter) });

/** What `graphyard doctor` reports: whether the tool is there, and the one command that installs it. */
export function browserToolStatus() {
  const path = findBrowserTool();
  return { tool: browserToolName, present: !!path, path, ...(path ? {} : { install: browserInstallCommand() }) };
}

/** A failed install is not rerun on every loop cycle: the next attempt waits this long. */
const retryAfterMs = 15 * 60_000;
const installs = new Map<string, { done: Promise<string>; failedAt?: number }>();

/**
 * GY-3370: the tool, installing it once when the host lacks it. Launches that need it at the same
 * time share one install; a failure is raised with the installer's own error and is not retried
 * for 15 minutes.
 */
export async function provisionBrowserTool(environment: { PATH?: string } = process.env): Promise<string> {
  const found = findBrowserTool(environment);
  if (found) return found;
  const directory = browserToolDirectory();
  const current = installs.get(directory);
  if (current && (current.failedAt === undefined || Date.now() - current.failedAt < retryAfterMs)) return current.done;
  const entry: { done: Promise<string>; failedAt?: number } = { done: new Promise<string>((done, fail) => {
    execFile('sh', ['-c', browserInstallCommand(directory)], { env: process.env, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
      const tool = findBrowserTool(environment);
      if (!error && tool) return done(tool);
      const said = (String(stderr).trim().split('\n').filter(Boolean).at(-1) ?? error?.message ?? 'the installer left no executable behind').replace(/\s+/g, ' ').slice(0, 240);
      fail(new Error(`installing ${browserToolName}@${browserToolVersion} failed: ${said}`));
    });
  }) };
  entry.done.catch(() => { entry.failedAt = Date.now(); });
  installs.set(directory, entry);
  return entry.done;
}
