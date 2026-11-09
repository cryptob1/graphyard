import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';

export function bindingFor(config, env = process.env, cwd = process.cwd(), workspaces = []) {
  if (!config.installs) return config; // A legacy flat binding remains readable during upgrade.
  const workspace = env.HERDR_WORKSPACE_ID || env.HERDR_PANE_ID?.split(':')[0];
  const entries = Object.values(config.installs);
  const scoped = entries.find(binding => binding.workspace === workspace && workspace);
  if (scoped) return scoped;
  const label = workspaces.find(entry => entry.workspace_id === workspace)?.label;
  const named = label?.startsWith('graphyard-') ? config.installs[label.slice('graphyard-'.length)] : null;
  if (named) return { ...named, workspace };
  return entries.filter(binding => {
    if (!binding.repositoryRoot) return false;
    const path = relative(binding.repositoryRoot, cwd);
    return !isAbsolute(path) && path !== '..' && !path.startsWith('../');
  }).sort((a, b) => b.repositoryRoot.length - a.repositoryRoot.length)[0] ?? {};
}
export async function readBinding() {
  let config = {};
  try { config = JSON.parse(await readFile(join(process.env.HERDR_PLUGIN_CONFIG_DIR || '.', 'config.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const binding = bindingFor(config);
  if (binding.url || !process.env.HERDR_PANE_ID) return binding;
  const workspaces = JSON.parse(execFileSync(process.env.HERDR_BIN_PATH || 'herdr', ['workspace', 'list'], { encoding: 'utf8' }));
  const named = bindingFor(config, process.env, process.cwd(), (workspaces.result ?? workspaces).workspaces ?? []);
  if (named.url) return named;
  // Herdr runs scripts in the plugin directory, not the invoking pane's cwd.
  const listed = JSON.parse(execFileSync(process.env.HERDR_BIN_PATH || 'herdr', ['pane', 'list'], { encoding: 'utf8' }));
  const pane = (listed.result ?? listed).panes?.find(entry => entry.pane_id === process.env.HERDR_PANE_ID);
  const fallback = bindingFor(config, process.env, pane?.foreground_cwd || pane?.cwd || process.cwd());
  return fallback.url ? fallback : config.installs?.legacy ?? {};
}
