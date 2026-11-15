import type { Dashboard } from './dashboard';
import LiveTerminal from '../components/live-terminal';
import { PageHeader } from '../components/page-layout';

/** The Master page (GY-3211): the master agent's live Herdr pane, typed into by the operator and watched by everyone else. Its title reads Master (GY-3307). */
export default function MasterPage({ token }: Pick<Dashboard, 'token'>) {
  return <>
    <PageHeader title="Master" fact="Files, routes and unsticks the work."/>
    <LiveTerminal token={token} label="Master terminal"/>
  </>;
}
