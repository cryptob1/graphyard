import { glossary, type GlossaryTerm } from '../glossary';
import Term from './term';
import { viewFor, visibleViews } from '../pages';
import type { Dashboard } from '../pages/dashboard';

/** The glossary entry a tab's label names, by the label itself or by its singular. */
const meaning = (label: string): GlossaryTerm | null => {
  const key = label.toLowerCase(), singular = key.replace(/s$/, '');
  return key in glossary ? key as GlossaryTerm : singular in glossary ? singular as GlossaryTerm : null;
};

/**
 * The header above every page: the repository this session is connected to, the pages of the
 * current section as tabs (only when there is more than one), the link to the plain-language
 * guide, and how fresh the data is. The repository is named in every section: a section that
 * gained a second page must not be the reason the dashboard stops saying where it is pointed.
 */
export default function TopBar(dashboard: Dashboard) {
  const { view, setView, connected, lastUpdated } = dashboard;
  const section = viewFor(view).section;
  const tabs = section ? visibleViews(dashboard).filter(page => page.section === section) : [];
  return <header className="top-bar">
    <div className="breadcrumb">{dashboard.status?.repository ?? 'Graphyard'}</div>
    {tabs.length > 1 && <nav className="tabs" aria-label="Pages in this section">{tabs.map(tab => { const term = meaning(tab.label); return <button key={tab.id} className={tab.id === view ? 'tab active' : 'tab'} aria-current={tab.id === view ? 'page' : undefined} onClick={() => setView(tab.id)}>{term ? <Term term={term} focusable={false}>{tab.label}</Term> : tab.label}</button>; })}</nav>}
    <div className="top-bar-end"><button className="text-button guide-link" onClick={() => setView('guide')}>How Graphyard works</button><span className="live"><span className={`dot ${connected ? 'green' : ''}`}/>{connected ? `Updated ${lastUpdated}` : `Disconnected · last updated ${lastUpdated ?? 'never'}`}</span></div>
  </header>;
}
