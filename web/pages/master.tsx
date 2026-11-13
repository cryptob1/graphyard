import type { Dashboard } from './dashboard';
import LiveTerminal from '../components/live-terminal';
import { Playful } from '../fun';

/** The Master page (GY-3211): the master agent's live Herdr pane, typed into by the operator and watched by everyone else. Its title is Fun's 'The Chief', and plain 'Master' with Fun off. */
export default function MasterPage({ token }: Pick<Dashboard, 'token'>) {
  return <>
    <div className="master-heading"><h1><Playful plain="Master" fun="The Chief"/></h1></div>
    <LiveTerminal token={token} label="Master terminal"/>
  </>;
}
