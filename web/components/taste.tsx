import { useEffect, useState } from 'react';
import { isDelivered, type Work } from '../../src/model';
import { mergedAt } from '../groups';
import { formatAge } from '../../src/model/duration';
import { Explained } from './term';
import type { Dashboard } from '../pages/dashboard';

/** How many delivered items the Taste feed offers at once, newest first. */
export const tasteFeedCount = 5;

/** The delivered items awaiting a taste, newest first (GY-3393). */
export function tasteFeed(work: readonly Work[]): Work[] {
  return work.filter(item => isDelivered(item) && !item.taste)
    .sort((a, b) => mergedAt(b) - mergedAt(a))
    .slice(0, tasteFeedCount);
}

/** The passing proofs a taste card shows as the item's evidence, newest first, one per proof. */
export function tasteEvidence(item: Work) {
  const proofs = new Map<string, { proof: string; executed: number }>();
  for (const entry of [...item.evidence].reverse()) {
    if (entry.result !== 'pass' || entry.revocation || proofs.has(entry.proof)) continue;
    proofs.set(entry.proof, { proof: entry.proof, executed: entry.executed });
  }
  return [...proofs.values()].slice(0, 3);
}

/** One kept screenshot of the delivery's merge trial, read with the session's token. */
function TasteShot({ item, name, token }: { item: Work; name: string; token: string }) {
  const [src, setSrc] = useState<string | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    let url: string | null = null, active = true;
    void fetch(`/api/work/${encodeURIComponent(item.id)}/trial-screenshots/${encodeURIComponent(name)}/after`, { headers: { Authorization: `Bearer ${token}` } })
      .then(response => { if (!response.ok) throw new Error(String(response.status)); return response.blob(); })
      .then(blob => { if (active) setSrc(url = URL.createObjectURL(blob)); }, () => { if (active) setFailed(true); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [item.id, name, token]);
  if (failed) return null;
  return src ? <img className="artifact-preview taste-shot" src={src} alt={`Screenshot of case ${name}`}/> : <small className="muted">Loading the screenshot…</small>;
}

/** One delivered item awaiting its taste: why it shipped, the evidence that ran, and the two actions. */
function TasteCard({ item, token, now, busy, action, setSelected, admin }: { item: Work; token: string; now: number; busy: boolean; admin: boolean } & Pick<Dashboard, 'action' | 'setSelected'>) {
  const [note, setNote] = useState('');
  // A settled delivery reaches the page as a summary whose `summary` marker stands in for the plain
  // sentence (model/work-summary.ts); `plainSummary` carries the sentence itself beside it.
  const sentence = typeof item.summary === 'string' ? item.summary.trim() : item.plainSummary?.trim();
  const why = sentence || item.title;
  const shot = item.trialScreenshots?.cases.find(entry => entry.after);
  return <li className="taste-card" data-taste-card={item.key}>
    <div className="taste-head">
      <button type="button" className="text-button" onClick={() => setSelected(item.id)}><span className="mono">{item.key}</span> <span data-title>{item.title}</span></button>
      <span className="muted">shipped {formatAge(new Date(mergedAt(item)).toISOString(), now)} ago</span>
    </div>
    <p className="taste-why" data-taste-why>{why}</p>
    <ul className="taste-evidence">{tasteEvidence(item).map(entry => <li key={entry.proof}><Explained sentence={`✓ ${entry.proof} · ${entry.executed} executed`}/></li>)}</ul>
    {shot && <TasteShot item={item} name={shot.case} token={token}/>}
    {admin && <div className="taste-actions">
      <button type="button" disabled={busy} aria-label={`Looks good ${item.key}`} onClick={() => void action(item.id, 'taste', { verdict: 'good' })}>Looks good</button>
      <input aria-label={`Send-back note for ${item.key}`} placeholder="What should change?" value={note} onChange={event => setNote(event.target.value)}/>
      <button type="button" className="send-back" disabled={busy || !note.trim()} aria-label={`Send back ${item.key}`} onClick={() => void action(item.id, 'taste', { verdict: 'send-back', note: note.trim() })}>Send back</button>
    </div>}
  </li>;
}

/**
 * GY-3393: the Taste feed on the Work page, folded like Backlog so the home screen keeps its word
 * budget (tests/dashboard-simplification.test.ts): one summary line, Taste and its count. Open, it
 * lists every delivered item the owner has not tasted yet, as a card with its why sentence and the
 * evidence that ran the real app — the proof's output, and the trial's screenshot when one was
 * kept. Two actions: Looks good records the taste and the card leaves; Send back with a note files
 * the note as a follow-up item's reason beside a proposed master lesson. Tasting gates nothing: a
 * delivery is complete without it.
 */
export default function TasteFeed({ work, status, token, observedAt, busy, action, setSelected }: Pick<Dashboard, 'work' | 'status' | 'token' | 'observedAt' | 'busy' | 'action' | 'setSelected'>) {
  const feed = tasteFeed(work);
  if (!feed.length) return null;
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  return <details className="panel taste-feed" aria-label="Taste" data-taste-section>
    <summary>Taste <span className="count">{feed.length}</span></summary>
    <ul className="taste-list">{feed.map(item => <TasteCard key={item.id} item={item} token={token} now={now} busy={busy} admin={status?.actor?.role === 'admin'} action={action} setSelected={setSelected}/>)}</ul>
  </details>;
}
