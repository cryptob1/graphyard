import { readFile } from 'node:fs/promises';
import { startGithubSetup } from '../github-setup.js';
import type { AppFacts } from './github.js';

export interface ManifestOptions { port?: number; reviewer?: string; timeoutMs?: number; poll?: number; announce?: (message: string) => void; wait?: (ms: number) => Promise<void>; detectEveryMs?: number; dependencies?: Parameters<typeof startGithubSetup>[4] }

/**
 * Drives the App-manifest browser flow to completion. The installer prints one URL, the
 * human confirms the App and picks the repository, and GitHub returns the credentials to
 * this machine. Nothing is copied by hand and no key is ever printed.
 */
export async function runManifestFlow(root: string, repository: string, origin: string, options: ManifestOptions = {}): Promise<AppFacts & { slug: string; botUserId?: number }> {
  const announce = options.announce ?? (message => console.log(message));
  const wait = options.wait ?? ((ms: number) => new Promise(accept => setTimeout(accept, ms)));
  const setup = await startGithubSetup(root, repository, origin, options.port ?? 4311, options.dependencies ?? {}, options.reviewer);
  // An App the operator already installed is recorded by setup itself, so no page is announced (GY-1476).
  if (!setup.installed) announce(`Open ${setup.url} in a browser on this machine and confirm the ${options.reviewer ? `reviewer App "${options.reviewer}"` : 'Graphyard App'}, then install it on ${repository}. Over SSH, forward port ${options.port ?? 4311} first. Credentials return to ${setup.file}; they are never printed.`);
  const timeoutMs = options.timeoutMs ?? APP_STEP_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const detectEveryMs = options.detectEveryMs ?? 10_000;
  let detectedAt = Date.now();
  try {
    for (;;) {
      const facts = await readAppFile(setup.file);
      if (facts) return facts;
      // An installation made outside the page (a phone cannot load its 127.0.0.1 redirect) is
      // looked up as the App every few seconds, so the step finishes without the page.
      if (Date.now() - detectedAt >= detectEveryMs) { detectedAt = Date.now(); if (await setup.detectInstallation()) continue; }
      if (Date.now() >= deadline) throw new AppStepPending(setup.file, await savedRegistration(setup.file), timeoutMs, options.reviewer);
      await wait(options.poll ?? 2_000);
    }
  } finally { await new Promise<void>(accept => setup.http.close(() => accept())); }
}

/** How long `install --apply` serves the App page before it stops and prints what it completed. */
export const APP_STEP_TIMEOUT_MS = 900_000;

/** Whether GitHub returned a registration to the file (created, not yet installed): only then is anything saved to resume from. */
async function savedRegistration(file: string) {
  try { return Number.isSafeInteger(JSON.parse(await readFile(file, 'utf8'))?.appId); } catch { return false; }
}

/**
 * The App step timed out with nobody confirming it (GY-1413). Everything the install did before it
 * is kept, so this is a pause, not a failure: the installer reports what it completed and how to
 * resume. `saved` is true only when GitHub actually returned a registration to `file` — the message
 * never claims credentials that were never written.
 */
export class AppStepPending extends Error {
  constructor(readonly file: string, readonly saved: boolean, readonly timeoutMs: number, readonly reviewer?: string) {
    super(`The ${reviewer ? `reviewer App "${reviewer}"` : 'GitHub App'} was not confirmed within ${Math.round(timeoutMs / 1000)} s. Rerun graphyard install --apply once the human confirms it; everything before the App step is kept.${saved ? ` GitHub returned the App registration to ${file}; the rerun resumes from it and only the installation on the repository remains.` : ' Nothing was confirmed, so no App credentials were saved.'}`);
  }
}

export async function readAppFile(file: string): Promise<(AppFacts & { slug: string; botUserId?: number }) | null> {
  let saved: any;
  try { saved = JSON.parse(await readFile(file, 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
  if (!Number.isSafeInteger(saved?.appId) || !Number.isSafeInteger(saved?.installationId)) return null;
  return { appId: saved.appId, slug: String(saved.slug), installationId: saved.installationId, privateKey: String(saved.privateKey), webhookSecret: String(saved.webhookSecret ?? ''), ...(saved.botUserId ? { botUserId: saved.botUserId } : {}) };
}

/**
 * A saved control-plane App registration and the repository it was registered for. `detected` marks
 * an installation found through the App's JWT that the file does not record yet (GY-1476).
 */
export interface SavedApp { file: string; repository: string | null; facts: AppFacts & { slug: string; botUserId?: number }; detected?: true }

/** A control-plane App GitHub returned to FILE whose installation the file does not record yet. */
export async function readUninstalledApp(file: string): Promise<{ repository: string | null; facts: Omit<AppFacts, 'installationId'> & { slug: string } } | null> {
  const saved = JSON.parse(await readFile(file, 'utf8'));
  if (!Number.isSafeInteger(saved?.appId) || Number.isSafeInteger(saved?.installationId) || saved.reviewer || typeof saved.privateKey !== 'string' || !saved.privateKey) return null;
  return { repository: typeof saved.repository === 'string' ? saved.repository : null, facts: { appId: saved.appId, slug: String(saved.slug), privateKey: saved.privateKey, webhookSecret: String(saved.webhookSecret ?? '') } };
}

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
