import { useEffect, useRef, useState } from 'react';
import type { ValidationRequest, ValidationCandidate } from '../src/validation';
import type { Work } from '../src/model';

export default function ValidationView({ api, work }: { api: (path: string) => Promise<any>; work: Work[] }) {
  const [requests, setRequests] = useState<ValidationRequest[]>([]);
  const [candidates, setCandidates] = useState<ValidationCandidate[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [retry, setRetry] = useState(0);
  const [following, setFollowing] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const alive = useRef(true), viewEpoch = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!following) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const epoch = viewEpoch.current;
      try {
        const data = await api('validation');
        if (!stopped && epoch === viewEpoch.current) { setRequests(data.requests); setCandidates(data.candidates); setNextCursor(data.nextCursor ?? null); setError(''); setLoaded(true); }
      } catch (e) { if (!stopped && epoch === viewEpoch.current) setError((e as Error).message); }
      finally { if (!stopped && epoch === viewEpoch.current) timer = setTimeout(() => void load(), 5000); }
    };
    void load(); return () => { stopped = true; clearTimeout(timer); };
  }, [retry, following]);
  async function older() {
    if (!nextCursor || loadingOlder) return;
    const epoch = ++viewEpoch.current;
    setFollowing(false); setLoadingOlder(true); setError('');
    try {
      const data = await api(`validation?cursor=${encodeURIComponent(nextCursor)}`);
      if (alive.current && epoch === viewEpoch.current) {
        setRequests(old => [...new Map([...old, ...data.requests].map((r: ValidationRequest) => [r.id, r])).values()]);
        setCandidates(old => [...new Map([...old, ...data.candidates].map((c: ValidationCandidate) => [c.id, c])).values()]);
        setNextCursor(data.nextCursor ?? null);
      }
    } catch (e) { if (alive.current && epoch === viewEpoch.current) setError((e as Error).message); }
    finally { if (alive.current && epoch === viewEpoch.current) setLoadingOlder(false); }
  }
  const recent = [...requests].sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return <><header><div className="breadcrumb">Verification <span>/</span> Validation requests</div><a href="/docs/validation">Protocol guide ↗</a></header>
    <div className="page-heading"><div><div className="eyebrow">FROM REQUIREMENT TO PROOF</div><h1>Validation requests</h1><p>See which candidate is queued, running, or waiting for a verified result.</p></div></div>
    <div className="notice">The packaged Playwright runner and separate collector ship in this release. Rich captures (traces, screenshots, videos) stay disabled until their protection policy is implemented, and the runner still needs an independently approved bundle and runner image.</div>
    {!following && <div className="notice">Browsing history; live updates paused. <button onClick={() => { viewEpoch.current++; setLoadingOlder(false); setFollowing(true); setRetry(n => n + 1); setLoaded(false); setRequests([]); setNextCursor(null); setError(''); }}>Return to latest</button></div>}
    {error && <div role="alert" className="notice danger">{error} {loaded && 'Previously loaded data may be stale.'} <button disabled={loadingOlder} onClick={() => following ? setRetry(n => n + 1) : void older()}>Retry validation requests</button></div>}
    {!loaded && !error && <p role="status">Loading validation requests…</p>}
    {loaded && !error && !requests.length && <div className="empty"><h2>No validation requested yet.</h2><p>Configure an approved environment, test bundle and separate runner/collector identities, then create a pinned request.</p><a href="/docs/validation">Set up the validation protocol ↗</a></div>}
    <div className="scenario-list">{recent.map(r => {
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
    {nextCursor && <button disabled={loadingOlder} onClick={() => void older()}>{loadingOlder ? 'Loading older requests…' : 'Load older requests'}</button>}
  </>;
}
