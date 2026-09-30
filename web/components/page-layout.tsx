import { Fragment, type ReactNode, type Ref } from 'react';

/**
 * The one layout every Settings page is built from (GY-978): a header with the page's place and
 * its guide, a heading with one short description, sections with a title and a count, and a
 * disclosure for what an operator rarely needs — internal ids, revisions, raw records — so the
 * default view carries none of it. Each renders the markup and classes web/style.css already styles.
 */

export function PageHeader({ crumbs, guide, eyebrow, title, actions, children }: { crumbs?: ReactNode[]; guide?: string; eyebrow?: string; title: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return <>
    {(crumbs?.length || guide) && <header><div className="breadcrumb">{crumbs?.map((crumb, index) => <Fragment key={index}>{index > 0 && <> <span>/</span> </>}{crumb}</Fragment>)}</div>{guide && <a href={guide}>Read the guide ↗</a>}</header>}
    <div className="page-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{children && <p>{children}</p>}</div>{actions}</div>
  </>;
}

export function PageSection({ title, count, actions, label, children }: { title: ReactNode; count?: ReactNode; actions?: ReactNode; label?: string; children?: ReactNode }) {
  return <section aria-label={label}>
    <div className="section-title"><h2>{typeof title === 'string' ? `${title}${count !== undefined ? ' ' : ''}` : <>{title}{count !== undefined && ' '}</>}{count !== undefined && <span className="count">{count}</span>}</h2>{actions}</div>
    {children}
  </section>;
}

/** Collapsed by default: what the default view leaves out, one click away. */
export function MoreDetails({ summary, className, children, detailsRef }: { summary: ReactNode; className?: string; children?: ReactNode; detailsRef?: Ref<HTMLDetailsElement> }) {
  return <details className={className ? `${className} more-details` : 'more-details'} ref={detailsRef}><summary>{summary}</summary>{children}</details>;
}
