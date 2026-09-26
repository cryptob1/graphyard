/**
 * GY-566. Where merge-queue conflicts come from. Every confirmed conflict of a candidate with the
 * base names the paths it touched; the paths that conflict most often in the last day are the
 * hotspots, with how many conflicts each caused and the items they sent back to a worker (a
 * docs-sync resolved the others). One path causing five or more in a day is raised for attention:
 * the page is shared by too many items at once and wants splitting, or the items touching it want
 * the self-contained-paragraph convention docs/development.md describes.
 */
export interface ConflictOccurrence {
  work: string; at: string; paths: readonly string[];
  /** Where the conflict went: a docs-sync session, or back to a worker. */
  route: 'docs-sync' | 'rework';
}
export interface ConflictHotspot { path: string; conflicts: number; items: string[]; sentBack: string[] }
export interface ConflictHotspots { windowHours: number; threshold: number; conflicts: number; sentBack: number; docsSynced: number; hotspots: ConflictHotspot[]; attention: ConflictHotspot[] }

export const conflictHotspotWindowMs = 24 * 3_600_000;
/** Conflicts one path may cause in the window before it is raised for attention. */
export const conflictHotspotThreshold = 5;
const listed = 10;

export function conflictHotspots(occurrences: readonly ConflictOccurrence[], now: number, windowMs = conflictHotspotWindowMs, threshold = conflictHotspotThreshold): ConflictHotspots {
  const recent = occurrences.filter(entry => { const at = Date.parse(entry.at); return Number.isFinite(at) && at <= now && now - at < windowMs; });
  const byPath = new Map<string, { conflicts: number; items: Set<string>; sentBack: Set<string> }>();
  for (const entry of recent) for (const path of new Set(entry.paths)) {
    const hotspot = byPath.get(path) ?? byPath.set(path, { conflicts: 0, items: new Set(), sentBack: new Set() }).get(path)!;
    hotspot.conflicts++; hotspot.items.add(entry.work);
    if (entry.route === 'rework') hotspot.sentBack.add(entry.work);
  }
  const hotspots = [...byPath].map(([path, entry]) => ({ path, conflicts: entry.conflicts, items: [...entry.items].sort(), sentBack: [...entry.sentBack].sort() }))
    .sort((a, b) => b.conflicts - a.conflicts || a.path.localeCompare(b.path));
  return { windowHours: windowMs / 3_600_000, threshold, conflicts: recent.length, sentBack: recent.filter(entry => entry.route === 'rework').length, docsSynced: recent.filter(entry => entry.route === 'docs-sync').length,
    hotspots: hotspots.slice(0, listed), attention: hotspots.filter(entry => entry.conflicts >= threshold) };
}

/** The attention line for one hotspot, as master status names it. */
export function hotspotAttentionText(hotspot: ConflictHotspot, windowHours: number) {
  const items = hotspot.items.length > 8 ? `${hotspot.items.slice(0, 8).join(', ')} and ${hotspot.items.length - 8} more` : hotspot.items.join(', ');
  return `${hotspot.path} caused ${hotspot.conflicts} merge conflicts in the last ${windowHours} hours (${items}; ${hotspot.sentBack.length} sent back to a worker). Split the page, or have items document their change as a self-contained paragraph rather than rewording shared sentences (docs/development.md)`;
}

/** A ledger row the Insights report reads: a confirmed conflict (`base.conflict`) or a refresh (`base.refreshed`). */
export interface ConflictLedgerRow { key: string; kind: string; at: string; details: any }
/**
 * The conflicts the ledger records, for the Insights report: each `base.conflict` with the paths it
 * recorded, counted as docs-synced when a `base.refreshed` with trigger `docs sync` later adopted a
 * head for the same reviewed head, and as sent back otherwise.
 */
export function ledgerConflicts(rows: readonly ConflictLedgerRow[]): ConflictOccurrence[] {
  const synced = new Set(rows.filter(row => row.kind === 'base.refreshed' && row.details?.trigger === 'docs sync' && typeof row.details?.from?.sha === 'string').map(row => `${row.key}:${row.details.from.sha}`));
  return rows.filter(row => row.kind === 'base.conflict' && Array.isArray(row.details?.conflictPaths))
    .map(row => ({ work: row.key, at: row.at, paths: (row.details.conflictPaths as unknown[]).filter((path): path is string => typeof path === 'string'),
      route: synced.has(`${row.key}:${row.details?.from?.sha}`) ? 'docs-sync' as const : 'rework' as const }));
}
