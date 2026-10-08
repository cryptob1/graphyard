// Per-area verification maps (GY-1495): which tests guard an area, how to drive it, which
// invariants bite. A map is checked in as verification/AREA.md; the sessions whose plannedFiles
// touch its paths get a bounded, role-scoped digest of it beside the project-memory digest.
import { documentationGlobMatches } from './documentation-glob.js';
import { docsWords } from './documentation.js';
import type { SessionRole } from './project-memory.js';

export const verificationMapSections = ['Tests', 'Drive', 'Invariants', 'Gotchas'] as const;
export type VerificationMapSection = typeof verificationMapSections[number];
export type VerificationMap = { path: string; paths: string[]; sections: Record<VerificationMapSection, string> };

/** A checked-in map's own cap, outside the docs budget (tests/verification-maps.test.ts). */
export const verificationMapWordLimit = 250;
export const verificationDigestWordBudget = 600;
export const verificationDigestMapLimit = 3;

/** What each role reads: a reviewer judges the diff, so it gets the invariants and gotchas, not how to run things. */
export const verificationRoleSections: Record<Exclude<SessionRole, 'producer'>, readonly VerificationMapSection[]> = {
  worker: verificationMapSections,
  reviewer: ['Invariants', 'Gotchas'],
};

/**
 * A map opens with `Paths:` and its globs (documentationGlobMatches syntax, separated by commas or
 * spaces), then holds one `## Tests`, `## Drive`, `## Invariants` and `## Gotchas` section each.
 * Anything else is malformed and yields null: a map nobody can read is never half-inlined.
 */
export function parseVerificationMap(path: string, text: string): VerificationMap | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const first = lines.findIndex(line => line.trim());
  const opening = first < 0 ? null : lines[first].match(/^Paths:\s*(.*)$/);
  if (!opening) return null;
  const paths = opening[1].split(/[\s,]+/).filter(Boolean);
  if (!paths.length) return null;
  const found = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of lines.slice(first + 1)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      if (found.has(heading[1])) return null;
      found.set(heading[1], current = []);
    } else if (current) current.push(line);
    else if (line.trim()) return null;
  }
  const sections = {} as Record<VerificationMapSection, string>;
  for (const name of verificationMapSections) {
    const body = found.get(name)?.join('\n').trim();
    if (!body) return null;
    sections[name] = body;
  }
  return found.size === verificationMapSections.length ? { path, paths, sections } : null;
}

/**
 * Whether a planned entry falls under a map's glob: a file the glob matches, or a directory scope
 * (`src/store/`) that the glob covers or that holds the glob beneath it.
 */
export function verificationGlobCovers(glob: string, planned: string) {
  const entry = planned.replace(/^\.\//, ''), pattern = glob.replace(/^\.\//, '');
  return documentationGlobMatches(pattern, entry) || entry.endsWith('/') && pattern.startsWith(entry);
}

/** The maps whose globs cover any planned entry, the most-touched first, then by path. */
export function selectVerificationMaps(maps: readonly VerificationMap[], plannedFiles: readonly string[]) {
  const touched = maps.map(map => ({ map, count: plannedFiles.filter(entry => map.paths.some(glob => verificationGlobCovers(glob, entry))).length }));
  return touched.filter(entry => entry.count > 0).sort((a, b) => b.count - a.count || a.map.path.localeCompare(b.map.path)).map(entry => entry.map);
}

const flat = (text: string) => text.split(/\s+/).filter(Boolean).join(' ');
const renderMap = (map: VerificationMap, sections: readonly VerificationMapSection[]) =>
  `${map.path}: ${sections.map(name => `${name}: ${flat(map.sections[name])}`).join(' ')}`;
function render(included: readonly VerificationMap[], omitted: readonly VerificationMap[], sections: readonly VerificationMapSection[]) {
  if (!included.length && !omitted.length) return '';
  const parts = ['Verification maps for the areas this item plans to change:', ...included.map(map => renderMap(map, sections))];
  if (omitted.length) parts.push(`Also relevant but not inlined, read them from the base: ${omitted.map(map => map.path).join(', ')}.`);
  return `${parts.join(' ')} `;
}

/**
 * The role's digest of the maps the plan touches: at most 3 maps whole within 600 words. A map
 * that does not fit is named by path instead of being cut mid-section. No touched map, no text.
 */
export function verificationMapDigest(maps: readonly VerificationMap[] | null | undefined, plannedFiles: readonly string[] | null | undefined, role: keyof typeof verificationRoleSections,
  options: { wordBudget?: number; mapLimit?: number } = {}): string {
  const selected = selectVerificationMaps(maps ?? [], plannedFiles ?? []);
  if (!selected.length) return '';
  const budget = options.wordBudget ?? verificationDigestWordBudget, limit = options.mapLimit ?? verificationDigestMapLimit;
  const sections = verificationRoleSections[role];
  const included: VerificationMap[] = [];
  for (const map of selected) {
    if (included.length >= limit) break;
    const tentative = [...included, map];
    // The omitted list only shrinks as maps are added, so the last accepted rendering bounds the result.
    if (docsWords(render(tentative, selected.filter(entry => !tentative.includes(entry)), sections)) <= budget) included.push(map);
  }
  return render(included, selected.filter(entry => !included.includes(entry)), sections);
}
