import { useEffect, useState } from 'react';
import type { ValidationRequest, ValidationCandidate } from '../src/validation';
import type { Work } from '../src/model';

export default function ValidationView({ api, work }: { api: (path: string) => Promise<any>; work: Work[] }) {
  const [requests, setRequests] = useState<ValidationRequest[]>([]);
  const [candidates, setCandidates] = useState<ValidationCandidate[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [retry, setRetry] = useState(0);
  const [limit, setLimit] = useState(20);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const data = await api('validation');
        if (!stopped) { setRequests(data.requests); setCandidates(data.candidates); setError(''); setLoaded(true); }
      } catch (e) { if (!stopped) setError((e as Error).message); }
      finally { if (!stopped) timer = setTimeout(() => void load(), 5000); }
    };
    void load(); return () => { stopped = true; clearTimeout(timer); };
  }, [retry]);
  const recent = [...requests].sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  return <><header><div className="breadcrumb">Verification <span>/</span> Validation requests</div><a href="/docs/validation">Protocol guide ↗</a></header>
    <div className="page-heading"><div><div className="eyebrow">FROM REQUIREMENT TO PROOF</div><h1>Validation requests</h1><p>See which candidate is queued, running, or waiting for a verified result.</p></div></div>
    <div className="notice">This release coordinates external runners. The packaged Playwright runner and guided execution setup are still planned.</div>
    {error && <div role="alert" className="notice danger">{error} {loaded && 'Previously loaded data may be stale.'} <button onClick={() => setRetry(n => n + 1)}>Retry validation requests</button></div>}
    {!loaded && !error && <p role="status">Loading validation requests…</p>}
    {loaded && !error && !requests.length && <div className="empty"><h2>No validation requested yet.</h2><p>Configure an approved environment, test bundle and separate runner/collector identities, then create a pinned request.</p><a href="/docs/validation">Set up the validation protocol ↗</a></div>}
    <div className="scenario-list">{recent.slice(0,limit).map(r => {
      const c = candidates.find(c => c.id === r.candidateId), attempt = r.attempts.at(-1), item = work.find(w => w.id === r.workId);
      const waitingSettlement = attempt && !attempt.settled && !['queued', 'dispatched', 'running'].includes(r.state);
      return <article className="scenario-card" key={r.id}><div className="card-top"><span>{item?.key ?? r.workId} · {r.proof}</span><strong>{r.state}</strong></div><h2>{item?.title ?? 'Validation request'}</h2>
        <p>{c ? `${c.environment.id} · source ${c.sourceSha.slice(0,10)} · policy ${c.policyRevision}` : `Candidate ${r.candidateId}`}</p>
        <p>Runner: {r.runner.id} · collector: {r.collector.id}</p><p>{attempt ? `Attempt ${attempt.epoch} of ${r.maxAttempts}` : 'Not dispatched'} · deadline {new Date(r.deadline).toLocaleString()}</p>
        {waitingSettlement && <p className="amber">Resources remain reserved. Verify execution has stopped before recovery.</p>}
        {r.result && <p>{r.result.passed ? 'Required dimensions passed.' : r.result.reasons.join('; ')}</p>}
        <details><summary>Attempt history ({r.attempts.length})</summary>{r.attempts.map(a => <p key={a.id}>Attempt {a.epoch} · {a.state} · {a.settled ? 'settled' : 'settlement not verified'} · {new Date(a.dispatchedAt).toLocaleString()}</p>)}<code>{r.id}</code></details>
      </article>;
    })}</div>
    {recent.length > limit && <button onClick={() => setLimit(n => n + 20)}>Show 20 older requests ({recent.length - limit} remaining)</button>}
  </>;
}
