import type { Dashboard } from './dashboard';
import LiveTerminal from '../components/live-terminal';

/** The Master page (GY-3211): the master agent's live Herdr pane, typed into by the operator and watched by everyone else. */
export default function MasterPage({ token }: Pick<Dashboard, 'token'>) {
  return <>
    <div className="master-heading"><h1>Master</h1></div>
    <LiveTerminal token={token} label="Master terminal"/>
  </>;
}
