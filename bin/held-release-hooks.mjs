// GY-1585: the module resolve hooks the launcher registers while the self-upgrade holds a restart.
// The coordinator checkout already holds the merged tip, but production still serves an earlier
// release, so a CLI process the loop spawns must load that release's code or it sends a schema the
// serving plane refuses. Every module of the checkout resolves to the held snapshot of the served
// release instead; the entry the process was started with — and so `process.argv[1]`, from which
// the launcher derives the checkout it confines sessions against — stays the checkout's own path.
// Dependencies (node_modules) and Graphyard's own state (.graphyard) are the checkout's, unchanged.
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

let from = '', to = '';
const exempt = ['node_modules/', '.graphyard/'];

export function initialize(data) { ({ from, to } = data); }

export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  if (!from || !resolved.url.startsWith(from)) return resolved;
  const rest = resolved.url.slice(from.length);
  return exempt.some(prefix => rest.startsWith(prefix)) ? resolved : { ...resolved, url: `${to}${rest}` };
}

/**
 * The pin standing on the checkout at `checkout` (a directory URL), or null: the served release's
 * commit, the snapshot's directory URL, and whether that snapshot's loop reads the hold's cursor
 * (`loop`). The launcher and the executor entry read it before loading any module.
 */
export function heldRelease(checkout) {
  try {
    const pin = JSON.parse(readFileSync(new URL('.graphyard/held-cli.json', checkout), 'utf8'));
    if (typeof pin?.root !== 'string' || typeof pin.commit !== 'string') return null;
    const snapshot = pathToFileURL(`${pin.root}/`).href;
    return existsSync(new URL('src/cli.ts', snapshot)) ? { commit: pin.commit, to: snapshot, loop: pin.loop === true } : null;
  } catch { return null; }
}
