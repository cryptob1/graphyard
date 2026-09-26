/**
 * A three-way text merge that resolves what a line-granular merge refuses only because two
 * independent edits share a line or sit on adjacent lines (GY-444).
 *
 * Git, and GitHub's merge API with it, conflicts on any two changes that overlap or touch at line
 * granularity. Graphyard's code keeps long lines — one import statement naming forty symbols, one
 * array of every decision action — and its docs keep one paragraph per line, so two items that each
 * add a name to the same import, or each trim a different clause of the same sentence, conflict
 * although neither touched the other's words. Every recurring merge fault of 2026-09-26 (GY-402
 * against GY-413 and GY-406, GY-406 against GY-413) was that shape.
 *
 * The merge is line-level first. Each region both sides changed is merged again at word
 * granularity (words, whitespace runs and single punctuation marks). A region resolves when:
 *
 * - every word-level edit of one side is separated from every edit of the other by at least one
 *   unchanged word, or
 * - both sides only inserted at the same point — two new imports, two new array entries, two new
 *   lines — which keeps both, the receiving branch's (ours) first, or
 * - in Markdown only, both sides shortened the same words and ours only deleted there: two items
 *   trimming one sentence to stay inside the docs word budget. The words the other side already
 *   landed are kept and ours' trim of them is dropped, and the merge says so in its notes.
 *
 * Anything else — both sides rewrote the same words — stays a conflict, named by file, exactly as
 * before. A resolved file always changes the candidate's own diff, so the carry rule
 * (model/carry.ts) re-requires its review and proofs; nothing resolved here is carried unread.
 */
export type TextMerge = { merged: string; resolved: number; notes: string[] } | { conflict: string };

interface Hunk { start: number; end: number; lines: number[]; side: 0 | 1 }
type Resolve = (region: number[], ours: number[], theirs: number[], group: Hunk[]) => number[] | null;

/** Past this many edits between two versions of one file, the merge refuses rather than search. */
export const maxEditDistance = 4000;

/** Myers' O(ND) diff: the edits turning `a` into `b`, as base ranges and their replacements. */
function diff(a: number[], b: number[], side: 0 | 1): Hunk[] | null {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const n = a.length - prefix - suffix, m = b.length - prefix - suffix;
  if (!n && !m) return [];
  const max = n + m, offset = max + 1, trace: Int32Array[] = [];
  const v = new Int32Array(2 * max + 3);
  let found = -1;
  for (let d = 0; d <= Math.min(max, maxEditDistance) && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || k !== d && v[offset + k - 1] < v[offset + k + 1] ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[prefix + x] === b[prefix + y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return null;
  // Walk the trace back from the end, folding consecutive single edits into hunks over the base.
  const hunks: Hunk[] = [];
  const push = (start: number, end: number, lines: number[]) => {
    const last = hunks[hunks.length - 1];
    if (last && last.start === end) { last.start = start; last.lines = [...lines, ...last.lines]; }
    else hunks.push({ start, end, lines, side });
  };
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d], k = x - y;
    const down = k === -d || k !== d && prev[offset + k - 1] < prev[offset + k + 1];
    const pk = down ? k + 1 : k - 1, px = prev[offset + pk], py = px - pk;
    if (down) push(prefix + px, prefix + px, [b[prefix + py]]);
    else push(prefix + px, prefix + px + 1, []);
    x = px; y = py;
  }
  return hunks.reverse();
}

/**
 * Merge two hunk lists over one base. `meets(end, start)` decides whether an edit starting at
 * `start` joins a group of edits ending at `end`; every group with edits from both sides that do not
 * agree goes to `resolve`, and the merge refuses when it returns null.
 */
function merge3(base: number[], ours: Hunk[], theirs: Hunk[], meets: (end: number, start: number) => boolean, resolve: Resolve): { out: number[]; resolved: number } | null {
  const hunks = [...ours, ...theirs].sort((l, r) => l.start - r.start || l.end - r.end || l.side - r.side);
  const out: number[] = [];
  let at = 0, resolved = 0;
  for (let i = 0; i < hunks.length;) {
    const group = [hunks[i]];
    let end = hunks[i].end, j = i + 1;
    for (; j < hunks.length && (hunks[j].start < end || meets(end, hunks[j].start)); j++) { group.push(hunks[j]); end = Math.max(end, hunks[j].end); }
    const start = group[0].start;
    out.push(...base.slice(at, start));
    const sideOf = (side: 0 | 1) => {
      const own = group.filter(h => h.side === side);
      if (!own.length) return null;
      const lines: number[] = [];
      let cursor = start;
      for (const h of own) { lines.push(...base.slice(cursor, h.start), ...h.lines); cursor = h.end; }
      return [...lines, ...base.slice(cursor, end)];
    };
    const left = sideOf(0), right = sideOf(1);
    if (!left || !right) out.push(...(left ?? right)!);
    else if (left.length === right.length && left.every((line, index) => line === right[index])) out.push(...left);
    else {
      const merged = resolve(base.slice(start, end), left, right, group);
      if (!merged) return null;
      out.push(...merged); resolved++;
    }
    at = end; i = j;
  }
  out.push(...base.slice(at));
  return { out, resolved };
}

class Interner {
  private ids = new Map<string, number>();
  readonly values: string[] = [];
  id(value: string) {
    let id = this.ids.get(value);
    if (id === undefined) { id = this.values.length; this.ids.set(value, id); this.values.push(value); }
    return id;
  }
}

const splitLines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const splitWords = (text: string) => text.match(/\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) ?? [];

/** The word-level merge of one region both sides changed, or null when their words collide. */
function mergeWords(base: string, ours: string, theirs: string, prose: boolean, notes: string[]): string | null {
  const words = new Interner();
  const [b, o, t] = [base, ours, theirs].map(text => splitWords(text).map(word => words.id(word)));
  const left = diff(b, o, 0), right = diff(b, t, 1);
  if (!left || !right) return null;
  const text = (ids: number[]) => ids.map(id => words.values[id]).join('');
  // Edits with only whitespace between them are one edit of one phrase: they meet.
  const meets = (end: number, start: number) => b.slice(end, start).every(id => !words.values[id].trim());
  const merged = merge3(b, left, right, meets, (region, l, r, group) => {
    if (!region.length) return [...l, ...r];
    if (prose && group.every(h => h.side === 1 || !h.lines.length) && r.length <= region.length) {
      notes.push(`kept the base branch's "${text(r).trim()}" over this side's trim of "${text(region).trim()}" to "${text(l).trim()}"`);
      return r;
    }
    return null;
  });
  return merged ? text(merged.out) : null;
}

/**
 * Three-way merge of `ours` and `theirs` from their common `base`. `prose` admits the Markdown
 * trim rule. Returns the merged text, how many regions needed the word-level pass and what it
 * kept of the base's words, or the reason the file stays a conflict.
 */
export function mergeText(base: string, ours: string, theirs: string, options: { prose?: boolean } = {}): TextMerge {
  if (ours === theirs || base === theirs) return { merged: ours, resolved: 0, notes: [] };
  if (base === ours) return { merged: theirs, resolved: 0, notes: [] };
  if ([base, ours, theirs].some(text => text.includes('\0'))) return { conflict: 'binary content' };
  const lines = new Interner();
  const [b, o, t] = [base, ours, theirs].map(text => splitLines(text).map(line => lines.id(line)));
  const left = diff(b, o, 0), right = diff(b, t, 1);
  if (!left || !right) return { conflict: `more than ${maxEditDistance} line edits` };
  const text = (ids: number[]) => ids.map(id => lines.values[id]).join('');
  const notes: string[] = [];
  let collision = '';
  // At line granularity edits that touch meet, as in git.
  const merged = merge3(b, left, right, (end, start) => start <= end, (region, l, r) => {
    const words = mergeWords(text(region), text(l), text(r), !!options.prose, notes);
    if (words === null) { collision ||= (text(l).split('\n').find(line => line.trim()) ?? '').trim().slice(0, 120); return null; }
    return splitLines(words).map(line => lines.id(line));
  });
  if (!merged) return { conflict: `both sides changed the same words: ${collision}` };
  return { merged: text(merged.out), resolved: merged.resolved, notes };
}
