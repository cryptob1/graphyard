import { readFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';

export function bindingFor(config, env = process.env, cwd = process.cwd()) {
  if (!config.installs) return config; // A legacy flat binding remains readable during upgrade.
  const workspace = env.HERDR_WORKSPACE_ID || env.HERDR_PANE_ID?.split(':')[0];
  const entries = Object.values(config.installs);
  const scoped = entries.find(binding => binding.workspace === workspace && workspace);
  if (scoped) return scoped;
  return entries.filter(binding => {
    if (!binding.repositoryRoot) return false;
    const path = relative(binding.repositoryRoot, cwd);
    return !isAbsolute(path) && path !== '..' && !path.startsWith('../');
  }).sort((a, b) => b.repositoryRoot.length - a.repositoryRoot.length)[0] ?? {};
}
export async function readBinding() {
  const config = JSON.parse(await readFile(join(process.env.HERDR_PLUGIN_CONFIG_DIR || '.', 'config.json'), 'utf8'));
  return bindingFor(config);
}
