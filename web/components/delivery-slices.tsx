import SessionBadge from './session-badge';
import Term from './term';

/**
 * Delivery slices (GY-31), once a slice has a lead: who leads each slice, its engineers, what they
 * hold and what holds them up, and the independent review sessions. It is about who works on
 * what, so it lives on the Workers page (GY-161), not on the Work page.
 */
export default function DeliverySlices({ status }: { status: any }) {
  const slices = (status?.delegation?.slices ?? []).filter((slice: any) => slice.lead);
  if (!slices.length) return null;
  return <section aria-label="Delivery slices"><h2><Term term="delivery slice">Delivery slices</Term></h2><div className="cards">{status.delegation.slices.map((slice: any) => <div className="slice-card" key={slice.id}>
    <div className="card-top"><span>{slice.name}</span>{slice.lead ? <SessionBadge kind={slice.lead.sessionKind} suffix="lead"/> : <span className="identity none">No lead assigned</span>}</div>
    <h3>{slice.lead ? slice.lead.displayName ?? slice.lead.id : 'Unassigned'}</h3>
    <p>{(slice.engineers ?? slice.workers).length} active engineers · {slice.workers.length} {slice.workers.length === 1 ? 'claimed item' : 'claimed items'} · {slice.bottlenecks.length} {slice.bottlenecks.length === 1 ? 'bottleneck' : 'bottlenecks'}</p>
    <p className="muted">Workers: {slice.workers.length ? slice.workers.map((worker: any) => <span className="session" key={worker.key}>{worker.key} · {worker.displayName ?? worker.id} <SessionBadge kind={worker.sessionKind}/></span>) : 'none'}</p>
    <p className="muted">Bottlenecks: {slice.bottlenecks.length ? slice.bottlenecks.map((bottleneck: any) => `${bottleneck.key} — ${bottleneck.reason}`).join(' · ') : 'none'}</p>
  </div>)}</div><p className="muted">Independent review/proof sessions ({status.delegation.reviewers.length}): {status.delegation.reviewers.length ? status.delegation.reviewers.map((agent: any) => <span className="session" key={agent.id}>{agent.displayName ?? agent.id} <SessionBadge kind={agent.sessionKind}/></span>) : 'none configured'}</p></section>;
}

const previewLabel: Record<string, string> = { local: 'Local preview', off: 'No previews' };

/**
 * The Delivery view (GY-1901): the project's effective delivery defaults as /api/status reports them
 * from the stored policy — previews, candidate size, production verification and the merge writer —
 * then each declared application with the cases bound to it. A refused declaration shows its reason.
 */
export function DeliveryDefaults({ status }: { status: any }) {
  const project = status?.project;
  const delivery = project?.delivery;
  const merger = status?.mergeWriter?.merger;
  return <><header><div className="breadcrumb">Delivery</div><a href="/docs/delivery">Delivery guide ↗</a></header>
    <section className="panel" aria-label="Delivery defaults"><h2>Delivery defaults</h2>
      {project?.error && <p className="error" role="alert">The project's delivery declaration is refused: {project.error}</p>}
      {!delivery && !project?.error && <p className="muted">Loading the project's delivery settings…</p>}
      {delivery && <dl className="facts">
        <dt>Previews</dt><dd>{previewLabel[delivery.previews] ?? delivery.previews}</dd>
        <dt>Candidate size</dt><dd>{delivery.candidateMaxChanges ? `At most ${delivery.candidateMaxChanges} changes per candidate` : 'Any number of changes'}</dd>
        <dt>Production verification</dt><dd>{delivery.productionVerification ? 'Required: the exact live release is verified' : 'Not required'}</dd>
        <dt>Merge writer</dt><dd>{merger === 'control-plane' ? 'The control plane (GitHub only a mirror)' : merger === 'github' ? 'GitHub' : 'Unknown'}</dd>
        <dt>Mode</dt><dd className="mono">{delivery.mode}</dd>
      </dl>}
    </section>
    {delivery && <section className="panel" aria-label="Applications"><h2>Applications</h2>
      {delivery.applications.length ? <ul>{delivery.applications.map((application: any) => {
        const cases = Object.entries(delivery.cases ?? {}).filter(([, id]) => id === application.id).map(([id]) => id);
        return <li key={application.id}><strong>{application.id}</strong> · {application.kind === 'static' ? `static site in ${application.directory}` : `Compose ${application.file}, service ${application.service}:${application.port}`} · cases: {cases.length ? cases.join(', ') : 'none bound'}</li>;
      })}</ul> : <p className="muted">No application is declared; declare them under delivery.applications in graphyard.json.</p>}
    </section>}</>;
}
