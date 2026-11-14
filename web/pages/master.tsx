import type { Dashboard } from './dashboard';
import LiveTerminal from '../components/live-terminal';

/** The Master page (GY-3211): the master agent's live Herdr pane, typed into by the operator and watched by everyone else. Its title reads Master with Fun on and off (GY-3307). */
export default function MasterPage({ token }: Pick<Dashboard, 'token'>) {
  return <>
    <div className="master-heading"><h1>Master</h1></div>
    <LiveTerminal token={token} label="Master terminal"/>
  </>;
}
