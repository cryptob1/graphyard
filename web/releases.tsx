import { useEffect, useState } from 'react';
import type { EnvironmentDelivery, Release, RollbackRequest } from '../src/delivery';
import type { Work } from '../src/model';

/** Precise labels: a verified release is a common interval over the whole manifest, never a green deploy job. */
export const verificationLabel: Record<EnvironmentDelivery['verification']['status'], string> = {
  unselected: 'No expected release selected', unobserved: 'Awaiting observation of every required service', incomplete: 'Instance listing incomplete',
  unknown: 'Runtime identity unknown — not verified', mismatched: 'Running artifacts differ from the expected release', unhealthy: 'Deployment failed or instances unhealthy',
  'no-common-interval': 'Services never observed matching at once', stale: 'Verified interval older than the freshness bound', verified: 'Verified in production', degraded: 'Verified, then a later observation failed',
};

export default function ReleasesView({ api, work }: { api: (path: string) => Promise<any>; work: Work[] }) {
  const [environments, setEnvironments] = useState<EnvironmentDelivery[]>([]);
  const [releases, setReleases] = useState<Release[]>([]);
  const [rollbacks, setRollbacks] = useState<RollbackRequest[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const data = await api('delivery'); if (!stopped) { setEnvironments(data.environments); setReleases(data.releases); setRollbacks(Array.isArray(data.rollbacks) ? data.rollbacks : []); setError(''); setLoaded(true); } }
      catch (e) { if (!stopped) setError((e as Error).message); }
      finally { if (!stopped) timer = setTimeout(() => void load(), 5000); }
    };
    void load(); return () => { stopped = true; clearTimeout(timer); };
  }, [retry]);
  const release = (id: string, revision: number) => releases.find(r => r.id === id && r.revision === revision);
  const keyOf = (workId: string) => work.find(w => w.id === workId)?.key ?? workId;
  return <><header><div className="breadcrumb">Verification <span>/</span> Releases</div><a href="/docs/delivery">Delivery guide ↗</a></header>
    <div className="page-heading"><div><div className="eyebrow">OBSERVED, NOT ASSUMED</div><h1>Releases</h1><p>Which release each environment expects, and whether independently observed runtime identity has verified it.</p></div></div>
    <div className="notice">Desired state changes only through an operator or a registered promoter. Runtime state comes only from service-scoped observers with measured instance identity; a provider webhook, a green deploy job or an application's own version report never verifies a release.</div>
    {error && <div role="alert" className="notice danger">{error} {loaded && 'Previously loaded data may be stale.'} <button onClick={() => setRetry(n => n + 1)}>Retry loading releases</button></div>}
    {!loaded && !error && <p role="status">Loading releases…</p>}
    {loaded && !error && !environments.length && <div className="empty"><h2>No release selected yet.</h2><p>Attest a build, define a release with its explicit membership, approve it and select it as an environment's expected release.</p><a href="/docs/delivery">Set up observed delivery ↗</a></div>}
    <div className="scenario-list">{environments.map(env => {
      const expected = env.expected && release(env.expected.releaseId, env.expected.releaseRevision);
      const v = env.verification;
      return <article className="scenario-card" key={env.environmentId}><div className="card-top"><span>{env.environmentId} · generation {env.generation}</span><strong>{v.status}</strong></div>
        <h2>{env.expected ? `${env.expected.releaseId} r${env.expected.releaseRevision}` : 'No expected release'}</h2>
        <p className={v.status === 'verified' ? '' : 'amber'}>{verificationLabel[v.status]}</p>
        {v.interval && <p className="muted">Common verified interval {new Date(v.interval.from).toLocaleString()} → {new Date(v.interval.to).toLocaleString()}{v.verifiedAt ? ` · verified ${new Date(v.verifiedAt).toLocaleString()}` : ''}</p>}
        {v.reasons.map(reason => <p className="reason" key={reason}>{reason}</p>)}
        {expected && <details open><summary>Membership ({expected.members.length})</summary>{expected.members.map(m => <p key={m.workId}>{m.included ? '✓' : '×'} {m.key || keyOf(m.workId)} · merge <code>{m.mergeSha.slice(0, 12)}</code>{m.included ? '' : ' · excluded (reverted)'}{m.note ? ` · ${m.note}` : ''}</p>)}{!expected.members.length && <p>No work items are attributed to this release.</p>}<p className="muted">Manifest: {expected.manifest.map(a => `${a.service} ${a.digest.slice(7, 19)}`).join(' · ')} · source <code>{expected.sourceSha.slice(0, 12)}</code></p></details>}
        {rollbacks.filter(r => r.environmentId === env.environmentId).length > 0 && <details open><summary>Rollbacks ({rollbacks.filter(r => r.environmentId === env.environmentId).length})</summary>{rollbacks.filter(r => r.environmentId === env.environmentId).map(r => <p key={r.id} className={r.state === 'verified' ? '' : 'amber'}>{new Date(r.requestedAt).toLocaleString()} · {r.failed.releaseId} r{r.failed.releaseRevision} → {r.target.releaseId} r{r.target.releaseRevision} · <strong>{r.state}</strong>{r.automatic ? ' · automatic' : ''}{r.operation ? ` · operation ${r.operation.id.slice(0, 8)} by ${r.operation.principal} (${r.operation.fencing} fencing${r.operation.outcome ? `, ${r.operation.outcome}` : ''})` : ' · awaiting an executor'}{r.state === 'applied' ? ' · provider applied it; not complete until the target is observed and verified' : ''}{r.repairWorkId ? ` · repair ${keyOf(r.repairWorkId)}` : ''}</p>)}</details>}
        {env.automaticRollbackRefusal && <p className="amber">{env.automaticRollbackRefusal.reasons.join('; ')}</p>}
        {!!env.incidents.length && <details><summary className="amber">Incidents ({env.incidents.length})</summary>{env.incidents.map(i => <p key={i.id} className="amber">{new Date(i.at).toLocaleString()} · {i.releaseId} r{i.releaseRevision} · {i.reasons.join('; ')}</p>)}</details>}
        <details><summary>Selection history ({env.history.length})</summary>{env.history.map(h => <p key={h.generation}>Generation {h.generation} · {h.releaseId} r{h.releaseRevision} · {h.outcome}{h.verifiedAt ? ` at ${new Date(h.verifiedAt).toLocaleString()}` : ''}{h.supersededAt ? ` · superseded ${new Date(h.supersededAt).toLocaleString()}` : ''}</p>)}</details>
        {env.lastNotification && <p className="muted">Last provider notification {new Date(env.lastNotification.at).toLocaleString()} via {env.lastNotification.provider} — a hint to observe again, not proof.</p>}
      </article>;
    })}</div>
  </>;
}
