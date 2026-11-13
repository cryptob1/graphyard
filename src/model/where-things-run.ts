// Concern: GY-3277 — where every part of one installation runs, as its loop reports the install
// and the Setup page shows it. The loop is the one process that knows all of it — the units the
// host runs for it, the containers its provider started, the checkout it works from, the install
// directory holding its credentials and CLI releases — so it names them beside its presence
// (model/loop-presence.ts) on its coordination reads, and the control plane keeps the latest for
// /api/status, exactly as it keeps the pane server.

/** Where one install's parts run: the values the Setup page's 'Where things run' panel shows. */
export interface WhereThingsRun {
  /** The systemd user unit that runs the loop: dispatch, the merge writer and the batch gate. */
  loopUnit: string;
  /** The systemd user unit that runs the deploy watch beside it. */
  deployUnit: string;
  /** What runs the control-plane server and its database: Compose container names, or the local provider's unit and embedded cluster. */
  server: string;
  database: string;
  /** The port and URL the dashboard is served on. */
  port: number;
  url: string;
  /** The checkout the loop runs from, and the install's own directory under ~/.config/graphyard. */
  checkout: string;
  installDirectory: string;
  /** The CLI release every session of this install runs. */
  cliPath: string;
}

/**
 * The header on the loop's coordination reads carrying those facts, URI-encoded JSON like the
 * panes header beside it. The control plane keeps the latest for /api/status.
 */
export const loopWhereHeader = 'X-Graphyard-Loop-Where';
export const encodeLoopWhere = (where: WhereThingsRun) => encodeURIComponent(JSON.stringify(where));

const name = (value: unknown) => typeof value === 'string' && value.trim() && value.length <= 500 ? value.trim() : null;

/** The where-facts a loop read names, or null when it names none or one that does not parse. */
export function loopWhere(header: string | string[] | undefined): WhereThingsRun | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || value.length > 2_000) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value));
    const port = Number(parsed?.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    const facts: WhereThingsRun = { loopUnit: '', deployUnit: '', server: '', database: '', port, url: '', checkout: '', installDirectory: '', cliPath: '' };
    for (const field of ['loopUnit', 'deployUnit', 'server', 'database', 'url', 'checkout', 'installDirectory', 'cliPath'] as const) {
      const text = name(parsed?.[field]);
      if (!text) return null;
      facts[field] = text;
    }
    return facts;
  } catch { return null; }
}

/** The where-facts the loop last named, kept per engine like its presence and pane server. */
export class LoopWhereRegistry {
  latest: WhereThingsRun | null = null;
  observe(where: WhereThingsRun | null) { if (where) this.latest = where; }
}
const registries = new WeakMap<object, LoopWhereRegistry>();
export function loopWhereRegistry(owner: object): LoopWhereRegistry {
  let registry = registries.get(owner);
  if (!registry) { registry = new LoopWhereRegistry(); registries.set(owner, registry); }
  return registry;
}

/** How to read one named part's logs: a systemd user unit from journald, a Compose container from Docker, anything else (the local provider's embedded cluster) none. */
export const whereLogs = (part: string): string | null =>
  part.endsWith('.service') ? `journalctl --user -u ${part}` : /^graphyard-[a-z0-9._-]+-(?:server|db)-1$/.test(part) ? `docker logs ${part}` : null;
