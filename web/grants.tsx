import { useEffect, useRef, useState } from 'react';
import { grantsAuthorize, type ProofAuthority, type ProofGrant, type Work } from '../src/model';

type GrantSet = { authorities: ProofAuthority[]; grants: ProofGrant[] };

export default function ProofGrantsView({ api, work, canEdit }: { api: (path: string, data?: unknown) => Promise<any>; work: Work[]; canEdit: boolean }) {
  const [data, setData] = useState<GrantSet | null>(null);
  const [loadError, setLoadError] = useState('');
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<{ id: string; rows: any[] } | null>(null);
  const request = useRef(0);
  const load = async () => {
    const version = ++request.current; setLoading(true); setLoadError('');
    try { const next = await api('proof-grants'); if (version === request.current) setData(next); }
    catch (e) { if (version === request.current) setLoadError((e as Error).message); }
    finally { if (version === request.current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { request.current++; }; }, []);
  async function mutate(event: React.FormEvent<HTMLFormElement>, action: 'grant' | 'revoke') {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const patterns = String(form.get('patterns')).split(',').map(value => value.trim()).filter(Boolean);
    setBusy(true); setFormError('');
    try { await api(`proof-grants/${encodeURIComponent(String(form.get('principalId')))}/${action}`, { patterns, reason: form.get('reason') }); (event.target as HTMLFormElement).reset(); await load(); }
    catch (e) { setFormError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function showHistory(id: string) {
    setFormError('');
    try { setHistory({ id, rows: await api(`proof-grants/${encodeURIComponent(id)}/history`) }); }
    catch (e) { setFormError((e as Error).message); }
  }
  const authorities = data?.authorities ?? [];
  const producers = authorities.filter(authority => authority.role === 'producer');
  // Every required proof name across live work, with whoever may currently produce it.
  const required = [...new Set(work.filter(w => w.stage !== 'done').flatMap(w => w.criteria.flatMap(ac => ac.proofs)))].sort();
  const coverage = required.map(proof => ({ proof, producers: authorities.filter(a => grantsAuthorize(a.patterns, proof)).map(a => a.principalId), items: work.filter(w => w.stage !== 'done' && w.criteria.some(ac => ac.proofs.includes(proof))).map(w => w.key) }));
  const gaps = coverage.filter(entry => !entry.producers.length);
  return <><header><div className="breadcrumb">Authority <span>/</span> Proof grants</div><a href="/docs/operations#proof-authority-grants">Read the guide ↗</a></header>
    <div className="page-heading"><div><div className="eyebrow">AUTHORITY LIVES HERE</div><h1>Proof authority</h1><p>Who may produce trusted evidence, for which proof names. Changes take effect immediately, without a redeploy.</p></div></div>
    {loadError && <div role="alert" className="notice danger">{loadError} <button disabled={loading} onClick={() => void load()}>Retry loading proof grants</button></div>}
    <div className="notice">Trust still follows the credential. Worker, reader, and coordinator principals can never hold a grant. The deployment environment allowlist is a bootstrap seed only: once a principal has a grant record, editing the environment changes nothing.</div>
    {loading && <p role="status">Loading proof authority…</p>}
    <section><div className="section-title"><h2>Unproducible required proof <span className="count">{gaps.length}</span></h2></div>
      {gaps.length
        ? gaps.map(entry => <div className="criterion" key={entry.proof}><strong className="amber">{entry.proof} · no authorized producer</strong><p>Required by {entry.items.join(', ') || 'no live work'}. Grant this name to a producer principal, or the acceptance gate can never be satisfied.</p></div>)
        : <p>{required.length ? 'Every required proof name has at least one authorized producer.' : 'No live work requires proof yet.'}</p>}
    </section>
    <section><div className="section-title"><h2>Producer authority <span className="count">{producers.length}</span></h2></div>
      {producers.map(authority => <div className="criterion" key={authority.principalId}><strong>{authority.principalId} · {authority.patterns.length ? authority.patterns.join(', ') : 'no authority'}</strong>
        <p>Source: {authority.source === 'grant' ? 'Graphyard grant record' : 'environment bootstrap seed, not yet materialized'}{(() => { const record = data?.grants.find(g => g.principalId === authority.principalId); return record ? ` · revision ${record.revision} · last ${record.lastMutation.kind} by ${record.lastMutation.actor} · ${record.lastMutation.reason}` : ''; })()}</p>
        <button className="text-button" onClick={() => void showHistory(authority.principalId)}>Read grant history ↗</button></div>)}
      {!producers.length && !loading && <p>No producer principal is configured. Evidence cannot be trusted until one exists.</p>}
    </section>
    {history && <section><div className="section-title"><h2>History · {history.id} <span className="count">{history.rows.length}</span></h2><button className="text-button" onClick={() => setHistory(null)}>Close</button></div>
      {history.rows.map(row => <div className="criterion" key={row.seq}><strong>v{row.revision} · {row.kind} · {row.actor} · {new Date(row.at).toLocaleString()}</strong><p>{row.reason}</p><p>Applied: {row.patterns.join(', ') || 'none'} · Effective: {row.effective.join(', ') || 'none'}</p></div>)}
      {!history.rows.length && <p>No recorded grant history for this principal.</p>}
    </section>}
    {canEdit && <section><div className="section-title"><h2>Change authority</h2></div>
      <p className="muted">Patterns are comma separated. Use an exact proof name, a whole kind such as <code>integration:*</code>, or a bounded prefix such as <code>manual:gy-43/*</code>. Every change appends an audited history entry.</p>
      {formError && <p role="alert" className="amber">{formError}</p>}
      <form className="grant-form" onSubmit={e => void mutate(e, 'grant')}>
        <label>Producer principal<input name="principalId" required list="grant-principals" placeholder="ci"/></label>
        <label>Patterns<input name="patterns" required placeholder="integration:*, unit:*"/></label>
        <label>Audit reason<input name="reason" required placeholder="CI runner produces integration and unit proof"/></label>
        <button disabled={busy}>{busy ? 'Applying…' : 'Grant authority'}</button>
      </form>
      <form className="grant-form" onSubmit={e => void mutate(e, 'revoke')}>
        <label>Producer principal<input name="principalId" required list="grant-principals" placeholder="ci"/></label>
        <label>Patterns to revoke<input name="patterns" required placeholder="integration:claim-safety"/></label>
        <label>Audit reason<input name="reason" required placeholder="Runner decommissioned"/></label>
        <button disabled={busy}>{busy ? 'Applying…' : 'Revoke authority'}</button>
      </form>
      <datalist id="grant-principals">{producers.map(authority => <option key={authority.principalId} value={authority.principalId}/>)}</datalist>
    </section>}
  </>;
}
