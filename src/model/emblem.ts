// Concern: the project's emblem (GY-3273) — one original SVG the install's master draws, shown in
// the dashboard's top bar beside the project name and as the favicon. It is an aggregate on the
// append-only event ledger like a connect-account (attributable history, every logical backup),
// with no table of its own: `master emblem set FILE` POSTs it, the control plane judges it here,
// and the dashboard reads the newest one wherever the control plane runs — the local provider and a
// deployed container alike.

/** The largest emblem, in bytes: a small flat drawing, never a document. */
export const emblemByteLimit = 8192;

/** The event kind that records one emblem: `emblem.set`, on the ledger with no work item. */
export const emblemEventKind = 'emblem.set';

export type EmblemValidation = { ok: true; svg: string } | { ok: false; reason: string };

/**
 * One emblem as the control plane accepts it: a single `<svg>` root element, at most 8 KB, that
 * carries no script, no foreignObject, no event attribute and no reference outside itself (only
 * same-document `#fragment` links), so the dashboard renders it as an image and nothing more. A
 * refusal names the reason; an acceptance carries the trimmed SVG exactly as it is stored and served.
 */
export function validateEmblem(input: string): EmblemValidation {
  const svg = input.trim();
  const refuse = (reason: string): EmblemValidation => ({ ok: false, reason });
  if (!svg) return refuse('The emblem is empty; draw one <svg> root element');
  const bytes = Buffer.byteLength(svg, 'utf8');
  if (bytes > emblemByteLimit) return refuse(`The emblem is ${bytes} bytes; an emblem is at most 8 KB (${emblemByteLimit} bytes)`);
  // One root: after an optional XML declaration the whole text is the <svg> element, and only one.
  const body = svg.replace(/^<\?xml[^>]*\?>\s*/i, '');
  if (!/^<svg(?:\s|>)/i.test(body)) return refuse('The emblem does not start with its single <svg> root element');
  const lower = body.toLowerCase();
  if (!/<\/svg\s*>$/i.test(body)) return refuse('The emblem does not end with its single <svg> root element');
  if (lower.indexOf('</svg>') !== lower.lastIndexOf('</svg>')) return refuse('The emblem is not a single <svg> root element');
  const opening = body.slice(0, body.indexOf('>') + 1);
  if (!/xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(opening)) return refuse('The emblem root is missing its namespace: xmlns="http://www.w3.org/2000/svg"');
  if (/<script[\s>]/i.test(body)) return refuse('The emblem contains a script element; an emblem is a static picture');
  if (/<foreignobject[\s>]/i.test(lower)) return refuse('The emblem contains a foreignObject element; an emblem is a static picture');
  const event = /[\s"'](on[a-z]+)\s*=/i.exec(body);
  if (event) return refuse(`The emblem carries the ${event[1]} event attribute; an emblem is a static picture`);
  for (const reference of body.matchAll(/(?:xlink\s*:\s*)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const value = reference[1] ?? reference[2] ?? reference[3];
    if (value && !value.startsWith('#')) return refuse(`The emblem references ${JSON.stringify(value)}; an emblem references nothing outside itself, only #fragment links`);
  }
  return { ok: true, svg };
}

/** Reads one emblem row: the newest emblem event's SVG, or null when none was drawn. */
export interface EmblemReader { query(text: string): Promise<unknown> }

/** The emblem in force, or null when the install has none: the newest `emblem.set` event's SVG. */
export async function readEmblem(db: EmblemReader): Promise<string | null> {
  const result = await db.query(`SELECT payload->'emblem'->>'svg' AS svg FROM events WHERE work_id IS NULL AND kind='${emblemEventKind}' ORDER BY seq DESC LIMIT 1`) as { rows?: Array<{ svg?: unknown }> };
  const row = result.rows?.[0];
  return row && typeof row.svg === 'string' ? row.svg : null;
}
