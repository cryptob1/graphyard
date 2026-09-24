import { groupLabel, type Group } from '../groups';

/**
 * The one status badge (GY-161): a group's colour dot and its name, drawn from the shared tokens
 * in web/style.css (`.badge-<group>`). Every page that shows an item's status renders this
 * component, so no page defines a status colour of its own; tests/dashboard-design-system.test.ts
 * keeps it that way.
 */
export default function StatusBadge({ group, children }: { group: Group; children?: string }) {
  return <span className={`badge badge-${group}`} data-status-badge={group}><span className="badge-dot" aria-hidden="true"/>{children ?? groupLabel[group]}</span>;
}

/** The group's dot alone, for a tile or a section heading beside its written name. */
export function GroupDot({ group }: { group: Group }) {
  return <span className={`group-dot dot-${group}`} aria-hidden="true"/>;
}
