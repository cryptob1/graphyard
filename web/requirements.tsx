import { useEffect, useRef, useState } from 'react';
import type { Work } from '../src/model';
import type { Scenario } from '../src/scenarios';

export default function RequirementsEditor({ item, all, api, onSaved }: {
  item: Work; all: Work[]; api: (path: string, data?: unknown) => Promise<any>; onSaved: () => Promise<void>;
}) {
  const [criteria, setCriteria] = useState(item.criteria.map(ac => ({ ...ac, proofs: ac.proofs.join(', ') })));
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void api('scenarios').then(rows => { if (alive.current) setScenarios(rows); }).catch(() => { if (alive.current) setError('Scenario suggestions are unavailable. Existing proof names can still be entered.'); });
    return () => { alive.current = false; };
  }, []);
  const lines = (value: FormDataEntryValue | null) => String(value ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return <form aria-label="Revise requirements" onSubmit={async e => {
    e.preventDefault(); const form = new FormData(e.currentTarget); setBusy(true); setError('');
    try {
      await api(`work/${item.id}/requirements`, { expectedPolicyRevision: item.policyRevision, reason: form.get('reason'), criteria: criteria.map(ac => ({ ...ac, proofs: lines(ac.proofs) })), dependencies: form.getAll('dependencies'), plannedFiles: lines(form.get('plannedFiles')), exclusiveResources: lines(form.get('exclusiveResources')) });
      if (alive.current) await onSaved();
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setBusy(false); }
  }}>
    <p className="notice">This creates a new policy revision. All acceptance evidence and review authorization must be refreshed. A submitted implementation requires a new attempt. Release the worker before saving.</p>
    {criteria.map((ac, index) => <fieldset key={ac.id}><legend>{ac.id}</legend><label>Observable outcome<input required value={ac.text} onChange={e => setCriteria(rows => rows.map((r, i) => i === index ? { ...r, text: e.target.value } : r))}/></label><label>Required proofs (comma separated)<input required list="proof-suggestions" value={ac.proofs} onChange={e => setCriteria(rows => rows.map((r, i) => i === index ? { ...r, proofs: e.target.value } : r))}/></label><button type="button" className="text-button" disabled={criteria.length === 1} onClick={() => setCriteria(rows => rows.filter((_, i) => i !== index))}>Remove {ac.id}</button></fieldset>)}
    <datalist id="proof-suggestions">{[...new Set([...item.criteria.flatMap(ac => ac.proofs), ...scenarios.map(s => `e2e:${s.id}`)])].map(proof => <option key={proof} value={proof}/>)}</datalist>
    <button type="button" disabled={criteria.length >= 50} onClick={() => {
      const maximum = Math.max(0, ...[...item.criteria.map(ac => ac.id), ...(item.retiredCriterionIds ?? []), ...criteria.map(ac => ac.id)].map(id => Number(id.slice(3))));
      setCriteria(rows => [...rows, { id: `AC-${maximum + 1}`, text: '', proofs: '' }]);
    }}>Add criterion</button>
    <label>Dependencies (select all prerequisites)<select name="dependencies" multiple defaultValue={item.dependencies}>{all.filter(w => w.id !== item.id).map(w => <option value={w.id} key={w.id}>{w.key} · {w.title}</option>)}</select></label>
    <label>Planned files or directory prefixes<input name="plannedFiles" defaultValue={item.plannedFiles.join(', ')}/></label>
    <label>Exclusive resources<input name="exclusiveResources" defaultValue={(item.exclusiveResources ?? []).join(', ')}/></label>
    <label>Reason for revision<textarea name="reason" required maxLength={2000}/></label>
    {error && <p role="alert">{error}</p>}<button disabled={busy}>{busy ? 'Saving revision…' : 'Save requirement revision'}</button>
  </form>;
}
