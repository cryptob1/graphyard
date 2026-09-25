import type { ReactNode } from 'react';
import type { Dashboard } from './dashboard';
import OverviewPage from './overview';
import ShippedPage from './shipped';
import HumanRequestsPage from './human-requests';
import InterventionsPage from './interventions';
import GuidePage from './guide';
import AutomationPage from './automation';
import FleetPage from './fleet';
import WorkersPage from './workers';
import ScenarioLibrary from '../scenarios';
import ValidationView from '../validation';
import ReleasesView from '../releases';
import ProofGrantsView from '../grants';
import InsightsPage from './insights-flow';
import { readsFlowAnalytics } from '../step-moves';

/**
 * The one navigation (GY-161): the sidebar and nothing beside it. Every page belongs to one of
 * these entries; a section with more than one visible page shows its pages as a row of sub-page
 * links above the content (web/components/top-bar.tsx), never repeating a sidebar entry. Tests is
 * planned (GY-162): it is listed so the navigation matches the approved design, and opens nothing
 * until it ships.
 */
export const sections = [
  { id: 'work', icon: 'work', label: 'Work' },
  { id: 'workers', icon: 'workers', label: 'Workers' },
  { id: 'shipped', icon: 'shipped', label: 'Shipped' },
  { id: 'tests', icon: 'tests', label: 'Tests', planned: 'GY-162' },
  { id: 'insights', icon: 'insights', label: 'Insights' },
  { id: 'settings', icon: 'settings', label: 'Settings' },
] as const;
export type Section = typeof sections[number]['id'];

/**
 * One page. The sidebar, the tabs and the main pane are generated from this list, so a new page
 * is one entry here plus its component under web/pages/. An entry carries no count: a number
 * has one home, on its page (the open total is the Work heading's, GY-81).
 */
export interface View {
  id: string; icon: string; label: string;
  /** The primary entry it lives under; a page without one is opened by a link (the guide). */
  section?: Section;
  adminOnly?: boolean;
  /** Hides the page for some sessions, or while nothing is configured for it. */
  visible?(dashboard: Dashboard): boolean;
  render(dashboard: Dashboard): ReactNode;
}

const role = (dashboard: Dashboard) => dashboard.status?.actor?.role;
// A feature is hidden only once a read has shown it has nothing configured; an unknown or
// failed read keeps it visible so an outage never hides a page.
const configured = (value: boolean | null | undefined) => value !== false;

export const views: readonly View[] = [
  { id: 'work', icon: '▥', label: 'Work', section: 'work', render: dashboard => <OverviewPage {...dashboard}/> },
  // What waits on the human (GY-89) is the Work page's Needs you group (GY-161): one place, answered on the item page.
  // This page, the full list with recently answered requests, is opened from that group, not from the navigation.
  { id: 'needs-you', icon: '☝', label: 'Needs you', render: dashboard => <HumanRequestsPage {...dashboard}/> },
  { id: 'shipped', icon: '✓', label: 'Delivered', section: 'shipped', render: dashboard => <ShippedPage {...dashboard}/> },
  // Every agent session across every item (GY-116), its own sidebar entry (GY-161).
  { id: 'workers', icon: '⚙', label: 'Workers', section: 'workers', render: dashboard => <WorkersPage {...dashboard}/> },
  // What shipping cost people (GY-98): every intervention, and the operator's judgement about what shipped, as a tab beside the delivered list.
  { id: 'interventions', icon: '☝', label: 'Interventions', section: 'shipped', visible: dashboard => role(dashboard) !== 'operator-agent', render: dashboard => <InterventionsPage {...dashboard}/> },
  // What waits on a release, beside what shipped: under Shipped since Insights became one page (GY-168).
  { id: 'validation', icon: '↻', label: 'Validation', section: 'shipped', visible: dashboard => configured(dashboard.features.validation), render: dashboard => <ValidationView api={dashboard.api} work={dashboard.work}/> },
  { id: 'releases', icon: '⇈', label: 'Releases', section: 'shipped', visible: dashboard => configured(dashboard.features.releases), render: dashboard => <ReleasesView api={dashboard.api} work={dashboard.work}/> },
  // Insights is one page with no tabs (GY-168, design/dashboard/Insights.dc.html): headline numbers,
  // the Flow panel, landed per day beside where the time goes, and the shipping pulse and flow
  // analytics detail behind one Show details toggle. It reads the flow analytics routes, which an
  // operator agent's scoped API refuses, so that role is not offered it.
  { id: 'insights', icon: '◷', label: 'Insights', section: 'insights', visible: dashboard => readsFlowAnalytics(role(dashboard)), render: dashboard => <InsightsPage {...dashboard}/> },
  { id: 'scenarios', icon: '✓', label: 'Test cases', section: 'settings', render: dashboard => <ScenarioLibrary api={dashboard.api} canEdit={role(dashboard) === 'admin'}/> },
  { id: 'grants', icon: '⚷', label: 'Proof authority', section: 'settings', render: dashboard => <ProofGrantsView api={dashboard.api} work={dashboard.work} canEdit={role(dashboard) === 'admin'}/> },
  { id: 'automation', icon: '◇', label: 'Operator automation', section: 'settings', adminOnly: true, visible: dashboard => configured(dashboard.features.automation), render: dashboard => <AutomationPage operatorAgents={dashboard.operatorAgents} operatorAgentsError={dashboard.operatorAgentsError} setView={dashboard.setView}/> },
  // The agent registry: a Settings page for the identities that may read it, since it names hosts and login homes.
  { id: 'fleet', icon: '⛭', label: 'Agent fleet', section: 'settings', visible: dashboard => ['admin', 'coordinator', 'reader', 'slice-lead'].includes(role(dashboard)), render: dashboard => <FleetPage api={dashboard.api} status={dashboard.status}/> },
  { id: 'guide', icon: '?', label: 'How Graphyard works', render: () => <GuidePage/> },
];

/** The pages this session may open, in registry order. */
export const visibleViews = (dashboard: Dashboard) => views.filter(view => (!view.adminOnly || role(dashboard) === 'admin') && (!view.visible || view.visible(dashboard)));
/**
 * The sidebar entry a page stands for: its section, when it is the first page of that section
 * this session may open. Mapping the registry through this yields at most the sections above.
 */
export function primaryEntry(dashboard: Dashboard, view: View) {
  if (!view.section) return null;
  const first = visibleViews(dashboard).find(page => page.section === view.section);
  return first === view ? { ...sections.find(section => section.id === view.section)!, view } : null;
}
/** The sidebar's entries this session may open, in the sidebar's order. */
export const primaryEntries = (dashboard: Dashboard) => sections.flatMap(section => views.map(view => primaryEntry(dashboard, view)).filter(entry => entry?.id === section.id));
/** The page for a view id; unknown ids fall back to the work page. */
export const viewFor = (id: string) => views.find(view => view.id === id) ?? views[0];
