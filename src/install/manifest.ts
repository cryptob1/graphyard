import { readFile } from 'node:fs/promises';
import { startGithubSetup } from '../github-setup.js';
import type { AppFacts } from './github.js';

export interface ManifestOptions { port?: number; reviewer?: string; timeoutMs?: number; poll?: number; announce?: (message: string) => void; wait?: (ms: number) => Promise<void>; dependencies?: Parameters<typeof startGithubSetup>[4] }

/**
 * Drives the App-manifest browser flow to completion. The installer prints one URL, the
 * human confirms the App and picks the repository, and GitHub returns the credentials to
 * this machine. Nothing is copied by hand and no key is ever printed.
 */
export async function runManifestFlow(root: string, repository: string, origin: string, options: ManifestOptions = {}): Promise<AppFacts & { slug: string; botUserId?: number }> {
  const announce = options.announce ?? (message => console.log(message));
  const wait = options.wait ?? ((ms: number) => new Promise(accept => setTimeout(accept, ms)));
  const setup = await startGithubSetup(root, repository, origin, options.port ?? 4311, options.dependencies ?? {}, options.reviewer);
  announce(`Open ${setup.url} in a browser on this machine and confirm the ${options.reviewer ? `reviewer App "${options.reviewer}"` : 'Graphyard App'}, then install it on ${repository}. Over SSH, forward port ${options.port ?? 4311} first. Credentials return to ${setup.file}; they are never printed.`);
  const deadline = Date.now() + (options.timeoutMs ?? 900_000);
  try {
    for (;;) {
      const facts = await readAppFile(setup.file);
      if (facts) return facts;
      if (Date.now() >= deadline) throw new Error('The GitHub App confirmation did not complete in time; rerun --apply to resume from the saved credentials');
      await wait(options.poll ?? 2_000);
    }
  } finally { await new Promise<void>(accept => setup.http.close(() => accept())); }
}

export async function readAppFile(file: string): Promise<(AppFacts & { slug: string; botUserId?: number }) | null> {
  let saved: any;
  try { saved = JSON.parse(await readFile(file, 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
  if (!Number.isSafeInteger(saved?.appId) || !Number.isSafeInteger(saved?.installationId)) return null;
  return { appId: saved.appId, slug: String(saved.slug), installationId: saved.installationId, privateKey: String(saved.privateKey), webhookSecret: String(saved.webhookSecret ?? ''), ...(saved.botUserId ? { botUserId: saved.botUserId } : {}) };
}

/** A saved control-plane App registration and the repository it was registered for. */
export interface SavedApp { file: string; repository: string | null; facts: AppFacts & { slug: string; botUserId?: number } }

/**
 * Reads an App registration saved by the manifest flow (`graphyard github-setup`, `init`, or an
 * earlier install), refusing a reviewer App: only the control-plane App can be reused as Graphyard's.
 */
export async function readSavedApp(file: string): Promise<SavedApp | null> {
  const facts = await readAppFile(file);
  if (!facts || !facts.privateKey || facts.privateKey === 'undefined') return null;
  const saved = JSON.parse(await readFile(file, 'utf8'));
  if (saved.reviewer) return null;
  return { file, repository: typeof saved.repository === 'string' ? saved.repository : null, facts };
}
