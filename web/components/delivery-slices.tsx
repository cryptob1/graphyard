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
    <p>{(slice.engineers ?? slice.workers).length}/{status.delegation.limits.maxEngineersPerLead} active engineers · {slice.workers.length} {slice.workers.length === 1 ? 'claimed item' : 'claimed items'} · {slice.bottlenecks.length} {slice.bottlenecks.length === 1 ? 'bottleneck' : 'bottlenecks'}</p>
    <p className="muted">Workers: {slice.workers.length ? slice.workers.map((worker: any) => <span className="session" key={worker.key}>{worker.key} · {worker.displayName ?? worker.id} <SessionBadge kind={worker.sessionKind}/></span>) : 'none'}</p>
    <p className="muted">Bottlenecks: {slice.bottlenecks.length ? slice.bottlenecks.map((bottleneck: any) => `${bottleneck.key} — ${bottleneck.reason}`).join(' · ') : 'none'}</p>
  </div>)}</div><p className="muted">Independent review/proof sessions ({status.delegation.reviewers.length}): {status.delegation.reviewers.length ? status.delegation.reviewers.map((agent: any) => <span className="session" key={agent.id}>{agent.displayName ?? agent.id} <SessionBadge kind={agent.sessionKind}/></span>) : 'none configured'}</p></section>;
}
