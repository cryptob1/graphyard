import { glossary, type GlossaryTerm } from '../glossary';
import Term from './term';
import { viewFor, visibleViews } from '../pages';
import type { Dashboard } from '../pages/dashboard';

/** The commit as the release line shows it: the first 8 characters, the whole SHA in the title. */
const shortSha = (sha: string) => <span className="mono" title={sha}>{sha.slice(0, 8)}</span>;

/**
 * The board's one release line (GY-1979). For an install managing a repository other than
 * Graphyard's own (GY-2964) it names that repository's own serving, which only a deploy record
 * naming it can: "Serving <commit>" with the merged changes main holds since it, or "No deploy
 * configured · main <tip>" — never the control plane's own commit, which serves Graphyard's
 * code, not the managed repository's. Elsewhere it reads the production watch's report on status
 * (`production`), the same view the board reads (src/model/release.ts): the commit production
 * serves, whether it is healthy, and how many merged changes it does not carry yet. Health is the
 * watch's own: an open deployment incident is an unhealthy release; a pending count is lag, not
 * ill health. Where nothing has observed production (no watch configured, a failed provider read,
 * an unknown serving commit) the line says so rather than claiming either way — "Release: not
 * watched", never a serving sha or health claim without an observation. It is plain text, not a
 * live region: it refreshes with every poll, and the page's own `role="status"` regions (loading
 * notices) stay unique for readers and tests.
 */
export function ReleaseLine({ status }: { status?: Dashboard['status'] }) {
  const deploy = status?.deploy as { configured?: unknown; tip?: unknown; main?: unknown; pending?: unknown } | null | undefined;
  if (deploy && typeof deploy === 'object') {
    const configured = deploy.configured === true && typeof deploy.tip === 'string' && !!deploy.tip;
    const pending = typeof deploy.pending === 'number' ? deploy.pending : null;
    const main = typeof deploy.main === 'string' && deploy.main ? deploy.main : null;
    return <p className="release-line" data-release-line={configured ? 'serving' : 'undeployed'}>
      {configured
        ? <>Serving {shortSha(deploy.tip as string)}{pending !== null && <> · {pending} merged {pending === 1 ? 'change' : 'changes'} not carried yet</>}</>
        : <>No deploy configured{main && <> · main {shortSha(main)}</>}</>}
    </p>;
  }
  const watch = status?.production as { observedAt?: unknown; serving?: unknown; error?: unknown; pending?: unknown; incidents?: unknown } | null | undefined;
  const observed = !!watch?.observedAt && typeof watch.serving === 'string' && !!watch.serving && !watch.error;
  const incidents = Array.isArray(watch?.incidents) ? watch.incidents.length : 0;
  const pending = Array.isArray(watch?.pending) ? watch.pending.filter(entry => typeof entry === 'string').length : 0;
  return <p className="release-line" data-release-line={observed ? 'serving' : 'unobserved'} data-healthy={observed ? incidents === 0 : undefined} data-pending={observed ? pending : undefined}>
    {observed
      ? <>Serving {shortSha(watch!.serving as string)} · <strong>{incidents ? `unhealthy: ${incidents} open deployment ${incidents === 1 ? 'incident' : 'incidents'}` : 'healthy'}</strong> · {pending} merged {pending === 1 ? 'change' : 'changes'} not carried yet</>
      : <>Release: not watched</>}
  </p>;
}

/** The glossary entry a tab's label names, by the label itself or by its singular. */
const meaning = (label: string): GlossaryTerm | null => {
  const key = label.toLowerCase(), singular = key.replace(/s$/, '');
  return key in glossary ? key as GlossaryTerm : singular in glossary ? singular as GlossaryTerm : null;
};

/**
 * The board's top bar (GY-1979): the one speed number, then the one release line, then the pages
 * of the current section, when it has more than one (Shipped, Insights, Settings). The tabs are
 * not a second navigation:
 * no page shares a label with a sidebar entry (a test holds the registry to that), they list only
 * the pages under the entry the sidebar has selected, and a section with a single page draws none
 * at all. The repository and how fresh the data is live at the foot of the sidebar.
 */
export default function TopBar(dashboard: Dashboard) {
  const { view, setView, status } = dashboard;
  const section = viewFor(view).section;
  const tabs = section ? visibleViews(dashboard).filter(page => page.section === section) : [];
  return <div className="top-bar">
    {status && <ReleaseLine status={status}/>}
    {tabs.length >= 2 && <nav className="tabs" aria-label="Pages in this section">{tabs.map(tab => { const term = meaning(tab.label); return <button key={tab.id} type="button" className={tab.id === view ? 'tab active' : 'tab'} aria-current={tab.id === view ? 'page' : undefined} onClick={() => setView(tab.id)}>{term ? <Term term={term} focusable={false}>{tab.label}</Term> : tab.label}</button>; })}</nav>}
  </div>;
}
