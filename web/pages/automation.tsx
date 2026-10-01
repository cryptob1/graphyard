import type { Dashboard } from './dashboard';
import { MoreDetails, PageHeader, PageSection } from '../components/page-layout';

/** Scoped operator automation identities, read through the admin credential. Ids, fingerprints and revisions wait behind each identity's details (GY-978). */
export default function AutomationPage({ operatorAgents, operatorAgentsError, setView }: Pick<Dashboard, 'operatorAgents' | 'operatorAgentsError'> & Partial<Pick<Dashboard, 'setView'>>) {
  return <><PageHeader crumbs={['Settings', 'Operator automation']} guide="/docs/master-agent" eyebrow="SCOPED COORDINATION" title="Operator automation">
      Scoped coordination after bootstrap. Credentials are created, rotated, and revoked through the secret-safe CLI.
    </PageHeader>
    {setView && <p>The runtimes, accounts, models and roles these identities' sessions launch on are configured in the <button className="text-button" onClick={() => setView('agents')}>Agents ↗</button>.</p>}
    <div className="notice">Bootstrap remains one implementation agent under direct human supervision. After repository gates are active, Operator, Master, Worker, and Reviewer/proof-producer must run as distinct sessions. Humans retain goals, approvals, exceptions, and oversight.</div>
    <PageSection title="Configured identities" count={operatorAgentsError ? '—' : operatorAgents.length}>
      {operatorAgents.map(agent => <div className="criterion" key={agent.id} data-identity>
        <strong>{agent.displayName} · {agent.revokedAt ? 'revoked' : 'active'}</strong>
        <p>Capabilities: {agent.capabilities.join(', ')}</p>
        <p>Repositories: {agent.scope.repositories.join(', ')} · Work: {agent.scope.workItems.join(', ') || 'none (deny)'}</p>
        <p>Last change: {agent.lastMutation.kind} by {agent.lastMutation.actor} · {new Date(agent.lastMutation.at).toLocaleString()} · {agent.lastMutation.reason}</p>
        <MoreDetails summary="Identifiers"><p>Identity: {agent.id} · Revision {agent.revision}</p><p>Credential fingerprints: {agent.fingerprints.join(', ')}</p></MoreDetails>
      </div>)}
      {operatorAgentsError ? <div role="alert" className="notice danger">Operator automation could not be read, so what is configured is unknown: {operatorAgentsError}</div>
        : !operatorAgents.length && <p>No scoped operator automation is configured. This is the safe bootstrap default.</p>}
      <p className="muted">A denial means the server rejected the identity, capability, target scope, revision, or non-weakening rule. Inspect the identity here, correct the human-approved scope, or revoke and recover with an admin credential. Never share an admin token or weaken gates.</p>
    </PageSection>
  </>;
}
