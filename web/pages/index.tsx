import type { ReactNode } from 'react';
import type { Dashboard } from './dashboard';
import OverviewPage from './overview';
import AutomationPage from './automation';
import ScenarioLibrary from '../scenarios';
import ValidationView from '../validation';
import ReleasesView from '../releases';
import ProofGrantsView from '../grants';

/**
 * One sidebar entry and the page it opens. The sidebar and the main pane are generated
 * from this list, so a new page is one entry here plus its component under web/pages/.
 */
export interface View {
  id: string; icon: string; label: string;
  /** A count rendered beside the label. */
  count?(dashboard: Dashboard): number;
  adminOnly?: boolean;
  /** How the sidebar opens the view; defaults to selecting it. */
  open?(dashboard: Dashboard): void;
  render(dashboard: Dashboard): ReactNode;
}

export const views: readonly View[] = [
  { id: 'graph', icon: '⌘', label: 'Delivery graph', render: dashboard => <OverviewPage {...dashboard}/> },
  { id: 'board', icon: '▥', label: 'Work board', count: dashboard => dashboard.work.length, render: dashboard => <OverviewPage {...dashboard}/> },
  { id: 'scenarios', icon: '✓', label: 'Test cases', render: dashboard => <ScenarioLibrary api={dashboard.api} canEdit={dashboard.status?.actor?.role === 'admin'}/> },
  { id: 'validation', icon: '↻', label: 'Validation', render: dashboard => <ValidationView api={dashboard.api} work={dashboard.work}/> },
  { id: 'releases', icon: '⇈', label: 'Releases', render: dashboard => <ReleasesView api={dashboard.api} work={dashboard.work}/> },
  { id: 'grants', icon: '⚷', label: 'Proof authority', render: dashboard => <ProofGrantsView api={dashboard.api} work={dashboard.work} canEdit={dashboard.status?.actor?.role === 'admin'}/> },
  { id: 'automation', icon: '◇', label: 'Operator automation', adminOnly: true, open: dashboard => void dashboard.showAutomation(), render: dashboard => <AutomationPage operatorAgents={dashboard.operatorAgents}/> },
];

/** The page for a view id; unknown ids fall back to the delivery graph. */
export const viewFor = (id: string) => views.find(view => view.id === id) ?? views[0];
