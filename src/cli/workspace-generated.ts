// Concern: generated files manifest and AGENTS.md template resolution during workspace sync.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { managedMasterInstructions } from '../master.js';
import { managedInstructions } from '../repository-setup.js';
import { parseGeneratedManifest, type GeneratedManifest } from '../sync.js';

/**
 * The generated files a repository declares for sync: `scripts/check-docs.mjs --manifest` names
 * the paths its `--write` renders in full. A repository without the script declares none.
 */
export const generatedManifestScript = 'scripts/check-docs.mjs';

export async function localGeneratedManifest(cwd: string): Promise<GeneratedManifest | null> {
  if (!existsSync(resolve(cwd, generatedManifestScript))) return null;
  const result = spawnSync(process.execPath, [generatedManifestScript, '--manifest'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return result.status === 0 ? parseGeneratedManifest(result.stdout) : null;
}

// The renderer's own exit status is not consulted: with other files still conflicted its link
// check fails, but the generated files are written first, and each is judged by its content.
export function regenerateGenerated(cwd: string, manifest: GeneratedManifest) {
  const [command, ...args] = manifest.regenerate;
  spawnSync(command === 'node' ? process.execPath : command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Graphyard's own repository renders the AGENTS.md blocks with the templates the merged tree
 * carries, so the result matches what its drift test expects; any other repository, and a tree
 * whose sources will not load, use the templates this CLI ships.
 */
export const agentsTemplateSources = ['src/repository-setup.ts', 'src/master.ts'];

export async function agentsRenderers(cwd: string) {
  const [setupFile, masterFile] = agentsTemplateSources.map(file => resolve(cwd, file));
  if (existsSync(setupFile) && existsSync(masterFile)) try {
    const [setup, master] = await Promise.all([import(pathToFileURL(setupFile).href), import(pathToFileURL(masterFile).href)]);
    if (typeof setup.managedInstructions === 'function' && typeof master.managedMasterInstructions === 'function') return { managedInstructions: setup.managedInstructions as typeof managedInstructions, managedMasterInstructions: master.managedMasterInstructions as typeof managedMasterInstructions, source: 'worktree' };
  } catch {}
  return { managedInstructions, managedMasterInstructions, source: 'cli' };
}
