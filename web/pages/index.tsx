import type { ReactNode } from 'react';
import type { Dashboard } from './dashboard';
import OverviewPage from './overview';
import AutomationPage from './automation';
import ScenarioLibrary from '../scenarios';
import ValidationView from '../validation';
import ReleasesView from '../releases';
import ProofGrantsView from '../grants';
import ShippingPulse from '../shipping-pulse';
import FlowAnalytics from '../flow-analytics';

/**
 * One sidebar entry and the page it opens. The sidebar and the main pane are generated
 * from this list, so a new page is one entry here plus its component under web/pages/.
 */
export interface View {
  id: string; icon: string; label: string;
  /** A count rendered beside the label. */
  count?(dashboard: Dashboard): number;
  adminOnly?: boolean;
  /** Hides the entry for some sessions; every view is visible by default. */
  visible?(dashboard: Dashboard): boolean;
  /** How the sidebar opens the view; defaults to selecting it. */
  open?(dashboard: Dashboard): void;
  render(dashboard: Dashboard): ReactNode;
}

export const views: readonly View[] = [
  { id: 'graph', icon: '⌘', label: 'Delivery graph', render: dashboard => <OverviewPage {...dashboard}/> },
  { id: 'pulse', icon: '∿', label: 'Shipping pulse', visible: dashboard => dashboard.status?.actor?.role !== 'operator-agent', render: dashboard => <><header><div className="breadcrumb">Workspace <span>/</span> Shipping pulse</div></header><ShippingPulse token={dashboard.token} repository={dashboard.status?.repository}/></> },
  { id: 'board', icon: '▥', label: 'Work board', count: dashboard => dashboard.work.length, render: dashboard => <OverviewPage {...dashboard}/> },
  { id: 'flow', icon: '◷', label: 'Flow analytics', visible: dashboard => dashboard.status?.actor?.role !== 'operator-agent', render: dashboard => <FlowAnalytics request={dashboard.api} token={dashboard.token} canAudit={['admin', 'coordinator', 'producer'].includes(dashboard.status?.actor?.role)}/> },
  { id: 'scenarios', icon: '✓', label: 'Test cases', render: dashboard => <ScenarioLibrary api={dashboard.api} canEdit={dashboard.status?.actor?.role === 'admin'}/> },
  { id: 'validation', icon: '↻', label: 'Validation', render: dashboard => <ValidationView api={dashboard.api} work={dashboard.work}/> },
  { id: 'releases', icon: '⇈', label: 'Releases', render: dashboard => <ReleasesView api={dashboard.api} work={dashboard.work}/> },
  { id: 'grants', icon: '⚷', label: 'Proof authority', render: dashboard => <ProofGrantsView api={dashboard.api} work={dashboard.work} canEdit={dashboard.status?.actor?.role === 'admin'}/> },
  { id: 'automation', icon: '◇', label: 'Operator automation', adminOnly: true, open: dashboard => void dashboard.showAutomation(), render: dashboard => <AutomationPage operatorAgents={dashboard.operatorAgents}/> },
];

/** The page for a view id; unknown ids fall back to the delivery graph. */
export const viewFor = (id: string) => views.find(view => view.id === id) ?? views[0];
