import { useState } from 'react';
import Dialog from '../dialog';
import Term from '../components/term';
import type { Dashboard } from './dashboard';

const proofPattern = '(unit|integration|e2e|manual):[a-zA-Z0-9._/-]+';
const split = (value: FormDataEntryValue | null) => String(value ?? '').split(',').map(s => s.trim()).filter(Boolean);

/** The new-work form: a goal, one or more criteria each with its proofs, and the delivery rules. */
export default function CreateWork({ work, error, busy, codexAvailable, setCreating, setBusy, setError, setSelected, api, refresh, sessionEpoch }: Dashboard) {
  const [rows, setRows] = useState([0]);
  return <Dialog onClose={() => setCreating(false)}><section className="modal" role="dialog" aria-modal="true" aria-label="New work item"><button className="close" aria-label="Close form" onClick={() => setCreating(false)}>×</button><h2>New work item</h2><form onSubmit={async e => {
    e.preventDefault(); const f = new FormData(e.currentTarget); const epoch = sessionEpoch.current; setBusy(true);
    try {
      const criteria = rows.map((row, i) => ({ id: `AC-${i + 1}`, text: String(f.get(`criterion-${row}`)), proofs: split(f.get(`proof-${row}`)) }));
      const created = await api('work', { title: f.get('title'), description: f.get('description'), criteria, dependencies: f.get('dependency') ? [f.get('dependency')] : [], plannedFiles: split(f.get('plannedFiles')), exclusiveResources: split(f.get('exclusiveResources')), policy: { review: true, reviewProvider: f.get('reviewProvider'), checks: split(f.get('checks')) } });
      if (epoch !== sessionEpoch.current) return; setCreating(false); await refresh(epoch); if (epoch === sessionEpoch.current) setSelected(created.id);
    } catch (e) { if (epoch === sessionEpoch.current) setError((e as Error).message); } finally { if (epoch === sessionEpoch.current) setBusy(false); }
  }}>
    <label>Title<input name="title" required maxLength={200} placeholder="What needs to change?"/></label>
    <label>Description<textarea name="description" rows={3}/></label>
    <fieldset className="criteria-fields"><legend>What must be true when it is done</legend>
      <p className="muted">Each <Term term="acceptance criterion">criterion</Term> is one thing someone can check. Give it one or more <Term term="proof"><strong>proofs</strong></Term>: the names of the tests that show it is true. A proof name starts with its kind — <Term term="unit test"><code>unit:</code></Term> a fast code test, <Term term="integration test"><code>integration:</code></Term> a test against a real database or service, <Term term="end-to-end test"><code>e2e:</code></Term> a test through the browser, <Term term="manual check"><code>manual:</code></Term> a person checks it. Examples: <Term term="unit test"><code>unit:login-rejects-bad-password</code></Term>, <Term term="integration test"><code>integration:claim-safety</code></Term>, <Term term="end-to-end test"><code>e2e:checkout</code></Term>, <Term term="manual check"><code>manual:copy-review</code></Term>. Someone who did not build the work must run it.</p>
      {rows.map((row, i) => <div className="criterion-row" key={row}>
        <label><span><Term term="acceptance criterion">Acceptance criterion</Term> {i + 1}</span><input name={`criterion-${row}`} required placeholder="What observable behavior proves success?"/></label>
        <label><span>Required <Term term="proof">proof</Term>{rows.length > 1 ? ` for criterion ${i + 1}` : ''} (comma separated)</span><input name={`proof-${row}`} required pattern={`${proofPattern}(\\s*,\\s*${proofPattern})*`} placeholder="integration:claim-safety"/></label>
        {rows.length > 1 && <button type="button" className="text-button" onClick={() => setRows(rows.filter(other => other !== row))}>Remove criterion {i + 1}</button>}
      </div>)}
      <button type="button" className="text-button" onClick={() => setRows([...rows, Math.max(...rows) + 1])}>＋ Add another criterion</button>
    </fieldset>
    <label><span><Term term="planned files">Planned files</Term> or directories (comma separated)</span><input name="plannedFiles" placeholder="src/booking/, src/sms/send.ts"/></label>
    <label><span><Term term="exclusive resource">Exclusive resources</Term> (comma separated)</span><input name="exclusiveResources" placeholder="staging:sms-test-account"/></label>
    <label><span>Code <Term term="review provider">review provider</Term></span><select name="reviewProvider" defaultValue="github"><option value="codex" disabled={!codexAvailable}>Codex cloud review{codexAvailable ? '' : ' (unavailable)'}</option><option value="github">Formal GitHub approval</option></select></label>{!codexAvailable && <p className="muted">Codex review is unavailable. Verify the GitHub App connection and accept its required permission updates.</p>}
    <label><span>Required <Term term="automated checks">CI checks</Term></span><input name="checks" defaultValue="test, typecheck" required/></label>
    <label><span><Term term="dependency">Depends on</Term></span><select name="dependency"><option value="">No dependency</option>{work.map(w => <option key={w.id} value={w.id}>{w.key} · {w.title}</option>)}</select></label>
    <p className="muted">Created as not started. Someone else must approve the code before it merges. More dependencies can be added through the CLI.</p>
    {error && <p role="alert" className="amber">{error}</p>}
    <button disabled={busy}>{busy ? 'Creating…' : 'Create work item'}</button>
  </form></section></Dialog>;
}
