import { agentOwner, type AttentionItem } from '../master.js';
import { conflictHotspots, hotspotAttentionText, type ConflictOccurrence } from '../model/conflict-hotspots.js';

/**
 * What `master status` reports of the conflicts the loop routed (GY-566): the paths conflicting
 * most in the last day, from the loop's own log (`conflicts` in its state; none while the state is
 * unreadable), and an attention item for each one at the threshold, owned by the master: split the
 * page, or point the items at the guidance.
 */
export function hotspots(loop: { conflicts: readonly ConflictOccurrence[] } | { error: string }, now = Date.now()) {
  const report = conflictHotspots('conflicts' in loop ? loop.conflicts : [], now);
  const attention: AttentionItem[] = report.attention.map(hotspot => ({ subject: 'installation', text: hotspotAttentionText(hotspot, report.windowHours),
    ...agentOwner('master', `graphyard master create FILE to split ${hotspot.path}, or point the items touching it at the docs conflict guidance in docs/development.md`) }));
  return { report, attention };
}
