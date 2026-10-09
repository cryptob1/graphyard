// GY-1585: the module resolve hooks the launcher registers while the self-upgrade holds a restart.
// The coordinator checkout already holds the merged tip, but production still serves an earlier
// release, so a CLI process the loop spawns must load that release's code or it sends a schema the
// serving plane refuses. Every module of the checkout resolves to the held snapshot of the served
// release instead; the entry the process was started with — and so `process.argv[1]`, from which
// the launcher derives the checkout it confines sessions against — stays the checkout's own path.
// Dependencies (node_modules) and Graphyard's own state (.graphyard) are the checkout's, unchanged.
let from = '', to = '';
const exempt = ['node_modules/', '.graphyard/'];

export function initialize(data) { ({ from, to } = data); }

export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  if (!from || !resolved.url.startsWith(from)) return resolved;
  const rest = resolved.url.slice(from.length);
  return exempt.some(prefix => rest.startsWith(prefix)) ? resolved : { ...resolved, url: `${to}${rest}` };
}
