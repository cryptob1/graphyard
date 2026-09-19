import { glossary } from '../glossary';
import { viewFor, visibleViews } from '../pages';
import type { Dashboard } from '../pages/dashboard';

/** A tab's hover definition from the shared glossary, by its label or the label's singular. */
const meaning = (label: string) => { const key = label.toLowerCase(); return glossary[key as keyof typeof glossary] ?? glossary[key.replace(/s$/, '') as keyof typeof glossary]; };

/**
 * The header above every page: the pages of the current section as tabs (only when there is
 * more than one), the link to the plain-language guide, and how fresh the data is.
 */
export default function TopBar(dashboard: Dashboard) {
  const { view, setView, connected, lastUpdated } = dashboard;
  const section = viewFor(view).section;
  const tabs = section ? visibleViews(dashboard).filter(page => page.section === section) : [];
  return <header className="top-bar">
    {tabs.length > 1 ? <nav className="tabs" aria-label="Pages in this section">{tabs.map(tab => <button key={tab.id} title={meaning(tab.label)} className={tab.id === view ? 'tab active' : 'tab'} aria-current={tab.id === view ? 'page' : undefined} onClick={() => setView(tab.id)}>{tab.label}</button>)}</nav> : <div className="breadcrumb">{dashboard.status?.repository ?? 'Graphyard'}</div>}
    <div className="top-bar-end"><button className="text-button guide-link" onClick={() => setView('guide')}>How Graphyard works</button><span className="live"><span className={`dot ${connected ? 'green' : ''}`}/>{connected ? `Updated ${lastUpdated}` : `Disconnected · last updated ${lastUpdated ?? 'never'}`}</span></div>
  </header>;
}
