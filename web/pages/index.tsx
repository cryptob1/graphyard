import type { ReactNode } from 'react';
import type { Dashboard } from './dashboard';
import OverviewPage from './overview';
import ShippedPage from './shipped';
import HumanRequestsPage from './human-requests';
import InterventionsPage from './interventions';
import GuidePage from './guide';
import AutomationPage from './automation';
import FleetPage from './fleet';
import ScenarioLibrary from '../scenarios';
import ValidationView from '../validation';
import ReleasesView from '../releases';
import ProofGrantsView from '../grants';
import ShippingPulse from '../shipping-pulse';
import FlowAnalytics from '../flow-analytics';

/**
 * The four primary sidebar entries. Every page belongs to one of them; a section with more
 * than one visible page shows its pages as tabs above the content (web/components/top-bar.tsx).
 */
export const sections = [
  { id: 'work', icon: '▥', label: 'Work' },
  { id: 'shipped', icon: '✓', label: 'Shipped' },
  { id: 'insights', icon: '◷', label: 'Insights' },
  { id: 'settings', icon: '≡', label: 'Settings' },
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
  // What waits on the human (GY-89): a tab beside the work list, never a count in the sidebar.
  { id: 'needs-you', icon: '☝', label: 'Needs you', section: 'work', render: dashboard => <HumanRequestsPage {...dashboard}/> },
  { id: 'shipped', icon: '✓', label: 'Shipped', section: 'shipped', render: dashboard => <ShippedPage {...dashboard}/> },
  // What shipping cost people (GY-98): every intervention, and the operator's judgement about what shipped, as a tab beside the delivered list.
  { id: 'interventions', icon: '☝', label: 'Interventions', section: 'shipped', visible: dashboard => role(dashboard) !== 'operator-agent', render: dashboard => <InterventionsPage {...dashboard}/> },
  { id: 'pulse', icon: '∿', label: 'Shipping pulse', section: 'insights', visible: dashboard => role(dashboard) !== 'operator-agent', render: dashboard => <ShippingPulse token={dashboard.token} repository={dashboard.status?.repository}/> },
  { id: 'flow', icon: '◷', label: 'Flow analytics', section: 'insights', visible: dashboard => role(dashboard) !== 'operator-agent', render: dashboard => <FlowAnalytics request={dashboard.api} token={dashboard.token} canAudit={['admin', 'coordinator', 'producer'].includes(role(dashboard))}/> },
  { id: 'validation', icon: '↻', label: 'Validation', section: 'insights', visible: dashboard => configured(dashboard.features.validation), render: dashboard => <ValidationView api={dashboard.api} work={dashboard.work}/> },
  { id: 'releases', icon: '⇈', label: 'Releases', section: 'insights', visible: dashboard => configured(dashboard.features.releases), render: dashboard => <ReleasesView api={dashboard.api} work={dashboard.work}/> },
  { id: 'scenarios', icon: '✓', label: 'Test cases', section: 'settings', render: dashboard => <ScenarioLibrary api={dashboard.api} canEdit={role(dashboard) === 'admin'}/> },
  { id: 'grants', icon: '⚷', label: 'Proof authority', section: 'settings', render: dashboard => <ProofGrantsView api={dashboard.api} work={dashboard.work} canEdit={role(dashboard) === 'admin'}/> },
  { id: 'automation', icon: '◇', label: 'Operator automation', section: 'settings', adminOnly: true, visible: dashboard => configured(dashboard.features.automation), render: dashboard => <AutomationPage operatorAgents={dashboard.operatorAgents} operatorAgentsError={dashboard.operatorAgentsError} setView={dashboard.setView}/> },
  // Opened from the Work page's fleet line and from Operator automation, like the guide: the
  // registry names hosts and login homes, so only the identities that may read it see it.
  { id: 'fleet', icon: '⛭', label: 'Agent fleet', visible: dashboard => ['admin', 'coordinator', 'reader', 'slice-lead'].includes(role(dashboard)), render: dashboard => <FleetPage api={dashboard.api} status={dashboard.status}/> },
  { id: 'guide', icon: '?', label: 'How Graphyard works', render: () => <GuidePage/> },
];

/** The pages this session may open, in registry order. */
export const visibleViews = (dashboard: Dashboard) => views.filter(view => (!view.adminOnly || role(dashboard) === 'admin') && (!view.visible || view.visible(dashboard)));
/**
 * The sidebar entry a page stands for: its section, when it is the first page of that section
 * this session may open. Mapping the registry through this yields at most the four sections.
 */
export function primaryEntry(dashboard: Dashboard, view: View) {
  if (!view.section) return null;
  const first = visibleViews(dashboard).find(page => page.section === view.section);
  return first === view ? { ...sections.find(section => section.id === view.section)!, view } : null;
}
export const primaryEntries = (dashboard: Dashboard) => views.map(view => primaryEntry(dashboard, view)).filter(entry => entry !== null);
/** The page for a view id; unknown ids fall back to the work page. */
export const viewFor = (id: string) => views.find(view => view.id === id) ?? views[0];
