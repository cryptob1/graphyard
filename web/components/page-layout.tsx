import type { ReactNode, Ref } from 'react';

/**
 * The one page shell every dashboard page is built from (GY-3321, GY-3322): the page heading — the
 * title, the page's primary fact under it, its actions top right — cards (.panel) with a section
 * heading and a count, the shared empty state, and a disclosure for what an operator rarely needs
 * (internal ids, revisions, raw records) so the default view carries none of it. Each renders the
 * markup and classes web/style.css styles.
 */

export function PageHeader({ title, fact, actions, children }: { title: ReactNode; fact: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return <div className="page-heading"><div><h1>{title}</h1><p className="page-fact">{fact}</p>{children && <p className="summary">{children}</p>}</div>
    {actions && <div className="page-actions">{actions}</div>}</div>;
}

export function PageSection({ title, count, actions, label, className, children }: { title: ReactNode; count?: ReactNode; actions?: ReactNode; label?: string; className?: string; children?: ReactNode }) {
  return <section className={className ? `panel ${className}` : 'panel'} aria-label={label}>
    <h2>{title}{count !== undefined && <span className="count">{count}</span>}{actions && <span className="push">{actions}</span>}</h2>
    {children}
  </section>;
}

/** What a page shows when it has nothing to list: one plain heading, what fills it, and at most one action. */
export function EmptyState({ title, action, children }: { title: ReactNode; action?: ReactNode; children?: ReactNode }) {
  return <div className="panel empty"><h2>{title}</h2>{children && <p>{children}</p>}{action}</div>;
}

/** Collapsed by default: what the default view leaves out, one click away. */
export function MoreDetails({ summary, className, children, detailsRef }: { summary: ReactNode; className?: string; children?: ReactNode; detailsRef?: Ref<HTMLDetailsElement> }) {
  return <details className={className ? `${className} more-details` : 'more-details'} ref={detailsRef}><summary>{summary}</summary>{children}</details>;
}
