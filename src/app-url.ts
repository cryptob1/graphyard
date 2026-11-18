// Concern: GY-3434 — where the managed repository's app runs, so owners and teammates open and share
// it without asking an agent. The repository declares one field in graphyard.json on main,
// `app.url`: the address anyone on the tailnet or the internet opens. Master status and
// /api/status report it beside what the serving report already knows — the served commit, when it
// was deployed — and the machine it runs on. A loopback address opens only on that machine, so it
// is refused with the reason.
import type { GitRead, ServingReport } from './deploy-watch.js';

/** What master status and the dashboard say while main declares no app.url. */
export const appUrlMissing = 'No app address set: add "app": { "url": "https://..." } to graphyard.json with the tailnet or public address teammates open';

/** Why a declared app.url cannot be shared, or null when it can. */
export function appUrlRefusal(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return `app.url "${url}" is not a web address`; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return `app.url "${url}" must start with http:// or https://`;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.startsWith('127.') || host === '::1' || host === '0.0.0.0')
    return `app.url "${url}" opens only on the machine it runs on; use its tailnet or public address so others can open it`;
  return null;
}

export interface AppRelease {
  /** The shareable address main declares; null while none is declared or it is refused. */
  url: string | null;
  /** Why the declared address was refused. */
  refused: string | null;
  /** The setting to add, while main declares none. */
  missing: string | null;
  /** The machine the app runs on, the commit it serves and when that commit was deployed. */
  machine: string;
  commit: string | null;
  deployedAt: string | null;
}

/** app.url from graphyard.json at main's tip, with the serving report's commit and deploy time. */
export async function appRelease(git: GitRead | null, serving: ServingReport, machine: string): Promise<AppRelease> {
  let declared: unknown = null;
  if (git && serving.main) {
    try { declared = (JSON.parse(await git(['show', `${serving.main}:graphyard.json`])) as { app?: { url?: unknown } } | null)?.app?.url ?? null; } catch { /* main holds no parseable graphyard.json: nothing declared */ }
  }
  const text = typeof declared === 'string' ? declared.trim() : '';
  const refused = text ? appUrlRefusal(text) : null;
  return { url: text && !refused ? text : null, refused, missing: text ? null : appUrlMissing, machine, commit: serving.commit, deployedAt: serving.deployedAt };
}
