import { execFileSync } from 'node:child_process';
import { accessSync, constants, readdirSync, realpathSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';

const executable = (path: string) => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } };

/** Where `program` resolves on `path`, as the shell would find it; null when it is not there. */
export function onSearchPath(program: string, path = process.env.PATH ?? '') {
  if (isAbsolute(program)) return executable(program) ? program : null;
  for (const directory of path.split(delimiter)) if (directory && executable(join(directory, program))) return join(directory, program);
  return null;
}

/** A mise shim: anything in mise's `shims` directory, or a link to mise itself (GY-3090). */
export const isMiseShim = (found: string) => {
  if (basename(dirname(found)) === 'shims') return true;
  try { return basename(realpathSync(found)) === 'mise'; } catch { return false; }
};

/**
 * The installed binary a launch of `program` runs (GY-3236). A mise shim fails "No version is set
 * for shim" wherever the launch environment carries no mise config — MISE_NO_CONFIG, another
 * working directory, a confined home — so a shim is resolved to the real install: `mise which`
 * when it answers, otherwise the newest version under mise's installs directory beside the shim.
 * Anything else, or a shim with no install found, launches as named.
 */
export function realRuntimeBinary(program: string, environment: NodeJS.ProcessEnv = process.env): string {
  const found = onSearchPath(program, environment.PATH);
  if (!found || !isMiseShim(found)) return program;
  try {
    const which = execFileSync('mise', ['which', program], { encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim().split('\n')[0];
    if (which && !isMiseShim(which) && executable(which)) return which;
  } catch { /* no configured version here: read the installs directory */ }
  const data = basename(dirname(found)) === 'shims' ? dirname(dirname(found)) : environment.MISE_DATA_DIR ?? join(environment.XDG_DATA_HOME ?? join(environment.HOME ?? '', '.local/share'), 'mise');
  const installs = join(data, 'installs'), candidates: string[] = [];
  const list = (directory: string) => { try { return readdirSync(directory); } catch { return []; } };
  for (const tool of list(installs)) for (const version of list(join(installs, tool))) {
    for (const path of [join(installs, tool, version, 'bin', program), join(installs, tool, version, program)]) if (executable(path)) candidates.push(path);
  }
  const version = (path: string) => basename(dirname(path)) === 'bin' ? basename(dirname(dirname(path))) : basename(dirname(path));
  return candidates.sort((a, b) => version(a).localeCompare(version(b), undefined, { numeric: true })).at(-1) ?? program;
}
