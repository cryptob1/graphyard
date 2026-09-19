import { useEffect, useRef, useState } from 'react';
import type { ValidationRequest, ValidationCandidate, RequestDiagnosis, RunnerCapacity, ArtifactCapacity } from '../src/validation';
import type { AnalyticsGroup, DurationSummary } from '../src/evidence-replay';
import type { Work } from '../src/model';

/** The operator-facing name of each diagnosed condition; the next step itself comes from the server with the request. */
const conditionLabel: Record<RequestDiagnosis['condition'], string> = {
  'queued-starved': 'Queue starved — no runner is polling', 'queued-waiting-for-slot': 'Queued behind a running attempt', 'queued-resource-held': 'Blocked by an unsettled reservation',
  unacknowledged: 'Dispatched, not acknowledged', running: 'Running', 'heartbeat-missing': 'Runner heartbeat missing', collecting: 'Collecting', 'collection-stalled': 'Collector stalled',
  'awaiting-settlement': 'Awaiting verified settlement', retryable: 'Settled — retry available', settled: 'Settled',
};

type Analytics = { groups: AnalyticsGroup[]; reuse: { decisions: number; granted: number; refused: number; supersededByLiveRun: number; contradictedByLaterFailure: number; avoidedExecutions: number }; replays: { total: number; outcomes: Record<string, number>; durationMs: DurationSummary; bytesRead: number }; caveat: string };
const seconds = (d: DurationSummary) => d.samples ? `${(d.p50Ms! / 1000).toFixed(1)}s median, ${(d.maxMs! / 1000).toFixed(1)}s max over ${d.samples}` : 'no samples';
const money = (amounts: Record<string, number>) => Object.entries(amounts).map(([currency, amount]) => `${amount} ${currency}`).join(', ') || 'none';

export default function ValidationView({ api, work }: { api: (path: string) => Promise<any>; work: Work[] }) {
  const [requests, setRequests] = useState<ValidationRequest[]>([]);
  const [candidates, setCandidates] = useState<ValidationCandidate[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [retry, setRetry] = useState(0);
  const [following, setFollowing] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [capacity, setCapacity] = useState<{ runners: RunnerCapacity[]; requests: RequestDiagnosis[]; artifacts: ArtifactCapacity; resources: { resource: string; requestId: string; live: boolean }[] } | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const alive = useRef(true), viewEpoch = useRef(0);
  // Analytics are a slow read over the whole attempt ledger: refreshed every 30 seconds, never blocking the request list.
  useEffect(() => {
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const data = await api('validation/analytics'); if (!stopped && Array.isArray(data?.groups) && data.reuse && data.replays) setAnalytics(data); }
      catch { /* the request list reports its own failures */ }
      finally { if (!stopped) timer = setTimeout(() => void load(), 30_000); }
    };
    void load(); return () => { stopped = true; clearTimeout(timer); };
  }, []);
  // Capacity and diagnoses are a separate read: a failed one leaves the request list intact and simply shows no diagnosis.
  useEffect(() => {
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const data = await api('validation/capacity'); if (!stopped && Array.isArray(data?.runners) && Array.isArray(data?.requests) && data.artifacts) setCapacity(data); }
      catch { /* the request list reports its own failures */ }
      finally { if (!stopped) timer = setTimeout(() => void load(), 5000); }
    };
    void load(); return () => { stopped = true; clearTimeout(timer); };
  }, []);
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
    {capacity && (capacity.runners.length > 0 || capacity.artifacts.retained > 0) && <section><div className="section-title"><h2>Runner capacity <span className="count">{capacity.runners.length}</span></h2><span>POLLS, DWELL AND RESERVATIONS</span></div>
      {capacity.runners.map(runner => <div className="criterion" key={runner.registration.id}><strong>{runner.registration.id} · {runner.principalId} · {runner.enabled ? (runner.executing ? 'executing' : 'idle') : 'disabled'}</strong>
        <p>{runner.lastPollAt ? `Last poll ${new Date(runner.lastPollAt).toLocaleString()}` : 'Never polled'} · queued {runner.queued} of {runner.queueLimit}{runner.oldestQueuedSeconds !== null ? ` · oldest waiting ${runner.oldestQueuedSeconds}s` : ''}{runner.executing ? ` · executing ${runner.executing}` : ''}</p></div>)}
      <p className="muted">Artifacts: {capacity.artifacts.backend} · {Math.round(capacity.artifacts.usedBytes / 1_048_576)} of {Math.round(capacity.artifacts.capacityBytes / 1_048_576)} MiB retained across {capacity.artifacts.retained} artifacts · {capacity.artifacts.expiringWithin24h} expiring within 24h{capacity.artifacts.uploadFailed ? ` · ${capacity.artifacts.uploadFailed} upload failures` : ''}{capacity.artifacts.awaitingDeletion ? ` · ${capacity.artifacts.awaitingDeletion} awaiting verified deletion` : ''}</p>
      {capacity.resources.filter(r => !r.live).length > 0 && <p className="amber">{capacity.resources.filter(r => !r.live).length} protected resource reservation(s) are held by attempts whose settlement is not verified.</p>}</section>}
    {analytics && (analytics.groups.length > 0 || analytics.reuse.decisions > 0 || analytics.replays.total > 0) && <section><div className="section-title"><h2>Execution analytics <span className="count">{analytics.groups.length}</span></h2><span>OBSERVED DURATIONS, REPORTED COST, REUSE AND REPLAY</span></div>
      {analytics.groups.map(group => <div className="criterion" key={`${group.proof}:${group.environment}:${group.runner}`}><strong>{group.proof} · {group.environment} · runner {group.runner} · {group.attempts} attempt{group.attempts === 1 ? '' : 's'}</strong>
        <p>Outcomes: {group.outcomes.passed} passed · {group.outcomes.failed} failed · {group.outcomes.expired} expired · {group.outcomes.cancelled} cancelled · {group.outcomes.superseded} superseded · {group.outcomes.inFlight} in flight</p>
        <p>Observed: queue {seconds(group.observed.queueMs)} · acknowledge {seconds(group.observed.acknowledgeMs)} · execution {seconds(group.observed.executionMs)} · collection {seconds(group.observed.collectionMs)} · total {seconds(group.observed.totalMs)}</p>
        <p>Runner-reported: duration {seconds(group.reported.durationMs)} · cost observed {money(group.cost.observed.amounts)} over {group.cost.observed.attempts} · estimated {money(group.cost.estimated.amounts)} over {group.cost.estimated.attempts} · unavailable for {group.cost.unavailable}</p></div>)}
      <p className="muted">Reuse: {analytics.reuse.decisions} decisions · {analytics.reuse.granted} granted · {analytics.reuse.refused} refused · {analytics.reuse.avoidedExecutions} executions avoided · {analytics.reuse.supersededByLiveRun} superseded by a live run · {analytics.reuse.contradictedByLaterFailure} contradicted by a later failure. Replays: {analytics.replays.total} · {analytics.replays.outcomes.consistent ?? 0} consistent · {analytics.replays.outcomes.inconsistent ?? 0} inconsistent · {analytics.replays.outcomes.unmeasured ?? 0} unmeasured · {seconds(analytics.replays.durationMs)}.</p>
      <p className="muted">{analytics.caveat}</p></section>}
    <div className="scenario-list">{recent.map(r => {
      const c = candidates.find(c => c.id === r.candidateId), attempt = r.attempts.at(-1), item = work.find(w => w.id === r.workId);
      const diagnosis = capacity?.requests.find(d => d.requestId === r.id && d.condition in conditionLabel);
      const waitingSettlement = attempt && !attempt.settled && !['queued', 'dispatched', 'running', 'collecting'].includes(r.state);
      return <article className="scenario-card" key={r.id}><div className="card-top"><span>{item?.key ?? r.workId} · {r.proof}</span><strong>{r.state}</strong></div><h2>{item?.title ?? 'Validation request'}</h2>
        <p>{c ? `${c.environment.id} · source ${c.sourceSha.slice(0,10)} · policy ${c.policyRevision}` : `Candidate ${r.candidateId}`}</p>
        <p>Runner: {r.runner.id} · collector: {r.collector.id}</p><p>{attempt ? `Attempt ${attempt.epoch} of ${r.maxAttempts}` : 'Not dispatched'} · deadline {new Date(r.deadline).toLocaleString()}</p>
        {waitingSettlement && <p className="amber">Resources remain reserved. Verify execution has stopped before recovery.</p>}
        {diagnosis && <p className={['running', 'collecting', 'settled'].includes(diagnosis.condition) ? 'muted' : 'amber'}><strong>{conditionLabel[diagnosis.condition]}</strong>{r.state === 'queued' ? ` · waiting ${diagnosis.dwellSeconds}s` : ''} — {diagnosis.nextStep}</p>}
        {r.result && <p>{r.result.passed ? 'Required dimensions passed.' : r.result.reasons.join('; ')}</p>}
        <details><summary>Attempt history ({r.attempts.length})</summary>{r.attempts.map(a => <p key={a.id}>Attempt {a.epoch} · {a.state} · {a.settled ? 'settled' : 'settlement not verified'} · {new Date(a.dispatchedAt).toLocaleString()}</p>)}<code>{r.id}</code></details>
      </article>;
    })}</div>
    {nextCursor && <button disabled={loadingOlder} onClick={() => void older()}>{loadingOlder ? 'Loading older requests…' : 'Load older requests'}</button>}
  </>;
}
