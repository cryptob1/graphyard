import type { Dashboard } from './dashboard';
import LiveTerminal from '../components/live-terminal';
import { useFun } from '../fun';

/** The Master page (GY-3211): the master agent's live Herdr pane, typed into by the operator and watched by everyone else. */
export default function MasterPage({ token }: Pick<Dashboard, 'token'>) {
  const fun = useFun();
  return <>
    <div className="master-heading"><h1>Master</h1>{fun && <p className="summary">The Foreman runs the yard.</p>}</div>
    <LiveTerminal token={token} label="Master terminal"/>
  </>;
}
