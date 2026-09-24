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
 * The pages of the current section, when it has more than one (Shipped, Insights, Settings).
 * It is not a second navigation: no page shares a label with a sidebar entry (a test holds the
 * registry to that), it lists only the pages under the entry the sidebar has selected, and a
 * section with a single page draws nothing here at all. The
 * repository and how fresh the data is live at the foot of the sidebar.
 */
export default function TopBar(dashboard: Dashboard) {
  const { view, setView } = dashboard;
  const section = viewFor(view).section;
  const tabs = section ? visibleViews(dashboard).filter(page => page.section === section) : [];
  if (tabs.length < 2) return null;
  return <nav className="tabs" aria-label="Pages in this section">{tabs.map(tab => { const term = meaning(tab.label); return <button key={tab.id} type="button" className={tab.id === view ? 'tab active' : 'tab'} aria-current={tab.id === view ? 'page' : undefined} onClick={() => setView(tab.id)}>{term ? <Term term={term} focusable={false}>{tab.label}</Term> : tab.label}</button>; })}</nav>;
}
