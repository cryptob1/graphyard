import { useState, type ChangeEvent } from 'react';
import Dialog from '../dialog';
import Term from '../components/term';
import type { Dashboard } from './dashboard';

const proofPattern = '(unit|integration|e2e|manual):[a-zA-Z0-9._/-]+';
const split = (value: FormDataEntryValue | null) => String(value ?? '').split(',').map(s => s.trim()).filter(Boolean);

/** File a goal; Advanced keeps explicit criteria and delivery rules available. */
export default function CreateWork({ work, error, busy, setCreating, setBusy, setError, setSelected, api, refresh, sessionEpoch }: Dashboard) {
  const [advanced, setAdvanced] = useState(false);
  const [rows, setRows] = useState([0]);
  // Criteria stay optional inside Advanced (the master writes them otherwise); within a row,
  // one filled field requires its pair, and an untouched row files no criterion.
  const [typed, setTyped] = useState<Record<number, { criterion: string; proof: string }>>({});
  const track = (row: number, field: 'criterion' | 'proof') => (e: ChangeEvent<HTMLInputElement>) => {
    // Read before the updater: React nulls a synthetic event's currentTarget before it runs one.
    const value = e.currentTarget.value;
    setTyped(current => { const base = current[row] ?? { criterion: '', proof: '' }; return { ...current, [row]: { ...base, [field]: value } }; });
  };
  const drop = (row: number) => { setRows(rows.filter(other => other !== row)); setTyped(current => { const rest = { ...current }; delete rest[row]; return rest; }); };
  return <Dialog onClose={() => setCreating(false)}><section className="modal" role="dialog" aria-modal="true" aria-label="New work item"><button className="close" aria-label="Close form" onClick={() => setCreating(false)}>×</button><h2>New work item</h2><form onSubmit={async e => {
    e.preventDefault(); const f = new FormData(e.currentTarget); const epoch = sessionEpoch.current; setBusy(true);
    try {
      const filled = rows.map(row => ({ text: String(f.get(`criterion-${row}`) ?? '').trim(), proofs: split(f.get(`proof-${row}`)) })).filter(row => row.text.length || row.proofs.length);
      const criteria = filled.map((row, i) => ({ id: `AC-${i + 1}`, ...row }));
      const created = await api('work', { title: f.get('title'), description: f.get('description'), hold: f.get('hold') === 'on' || undefined, criteria, dependencies: f.get('dependency') ? [f.get('dependency')] : [], exclusiveResources: split(f.get('exclusiveResources')), policy: { review: true, checks: split(f.get('checks')) } });
      if (epoch !== sessionEpoch.current) return; setCreating(false); await refresh(epoch); if (epoch === sessionEpoch.current) setSelected(created.id);
    } catch (e) { if (epoch === sessionEpoch.current) setError((e as Error).message); } finally { if (epoch === sessionEpoch.current) setBusy(false); }
  }}>
    <label>Title<input name="title" required maxLength={200} placeholder="What needs to change?"/></label>
    <label>Description (optional)<textarea name="description" rows={3}/></label>
    <label><input type="checkbox" name="hold"/> Hold (keep it out of dispatch until released)</label>
    <p className="muted">Describe the change. The master writes the criteria and proofs.</p>
    <details open={advanced} onToggle={e => setAdvanced(e.currentTarget.open)}><summary>Advanced</summary>
    <fieldset className="criteria-fields"><legend>What must be true when it is done</legend>
      <p className="muted">Each <Term term="acceptance criterion">criterion</Term> is one thing someone can check. Give it one or more <Term term="proof"><strong>proofs</strong></Term>: the names of the tests that show it is true. A proof name starts with its kind — <Term term="unit test"><code>unit:</code></Term> a fast code test, <Term term="integration test"><code>integration:</code></Term> a test against a real database or service, <Term term="end-to-end test"><code>e2e:</code></Term> a test through the browser, <Term term="manual check"><code>manual:</code></Term> a person checks it. Examples: <Term term="unit test"><code>unit:login-rejects-bad-password</code></Term>, <Term term="integration test"><code>integration:claim-safety</code></Term>, <Term term="end-to-end test"><code>e2e:checkout</code></Term>, <Term term="manual check"><code>manual:copy-review</code></Term>. Someone who did not build the work must run it.</p>
      {rows.map((row, i) => <div className="criterion-row" key={row}>
        <label><span><Term term="acceptance criterion">Acceptance criterion</Term> {i + 1}</span><input name={`criterion-${row}`} required={!!typed[row]?.proof} onChange={track(row, 'criterion')} placeholder="What observable behavior proves success?"/></label>
        <label><span>Required <Term term="proof">proof</Term>{rows.length > 1 ? ` for criterion ${i + 1}` : ''} (comma separated)</span><input name={`proof-${row}`} required={!!typed[row]?.criterion} onChange={track(row, 'proof')} pattern={`${proofPattern}(\\s*,\\s*${proofPattern})*`} placeholder="integration:claim-safety"/></label>
        {rows.length > 1 && <button type="button" className="text-button" onClick={() => drop(row)}>Remove criterion {i + 1}</button>}
      </div>)}
      <button type="button" className="text-button" onClick={() => setRows([...rows, Math.max(...rows) + 1])}>＋ Add another criterion</button>
    </fieldset>
    <label><span><Term term="exclusive resource">Exclusive resources</Term> (comma separated)</span><input name="exclusiveResources" placeholder="staging:sms-test-account"/></label>
    <label><span>Required <Term term="automated checks">CI checks</Term></span><input name="checks" defaultValue="test, typecheck" required/></label>
    <label><span><Term term="dependency">Depends on</Term></span><select name="dependency"><option value="">No dependency</option>{work.map(w => <option key={w.id} value={w.id}>{w.key} · {w.title}</option>)}</select></label>
    <p className="muted">Created as not started. Someone else must approve the code before it merges. More dependencies can be added through the CLI.</p>
    </details>
    {error && <p role="alert" className="amber">{error}</p>}
    <button disabled={busy}>{busy ? 'Creating…' : 'Create work item'}</button>
  </form></section></Dialog>;
}
