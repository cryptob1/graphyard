import type { Dashboard } from './dashboard';
import { EmptyState, MoreDetails, PageHeader, PageSection } from '../components/page-layout';
import { monthDay } from '../agent-status';

/** Operator automation identities, read through the admin credential: name, state and last change at a glance; scope, capabilities and ids in each identity's Details (GY-978, GY-3482). */
export default function AutomationPage({ operatorAgents, operatorAgentsError }: Pick<Dashboard, 'operatorAgents' | 'operatorAgentsError'>) {
  const active = operatorAgents.filter(agent => !agent.revokedAt).length, count = operatorAgents.length;
  return <><PageHeader title="Operator automation" fact={operatorAgentsError ? 'What is configured is unknown: the read failed.' : count ? `${count} automation ${count === 1 ? 'identity' : 'identities'}, ${active} active.` : 'None set up.'}/>
    {!operatorAgentsError && !count ? <EmptyState title="No automation identities."/> : <PageSection title="Configured identities" count={operatorAgentsError ? '—' : count}>
      {operatorAgents.map(agent => <div className="criterion" key={agent.id} data-identity>
        <strong>{agent.displayName} · {agent.revokedAt ? 'revoked' : 'active'}</strong>
        <p>Changed {monthDay(agent.lastMutation.at)}</p>
        <MoreDetails summary="Details">
          <p>Capabilities: {agent.capabilities.join(', ')}</p>
          <p>Repositories: {agent.scope.repositories.join(', ')} · Work: {agent.scope.workItems.join(', ') || 'none (deny)'}</p>
          <p>Last change: {agent.lastMutation.kind} by {agent.lastMutation.actor} · {new Date(agent.lastMutation.at).toLocaleString()} · {agent.lastMutation.reason}</p>
          <p>Identity: {agent.id} · Revision {agent.revision}</p><p>Credential fingerprints: {agent.fingerprints.join(', ')}</p>
        </MoreDetails>
      </div>)}
      {operatorAgentsError && <div role="alert" className="notice danger">Operator automation could not be read, so what is configured is unknown: {operatorAgentsError}</div>}
    </PageSection>}
  </>;
}
