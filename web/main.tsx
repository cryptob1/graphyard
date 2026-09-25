import { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { type Work } from '../src/model';
import type { OpenGroup } from './groups';
import './style.css';
import Docs from './docs';
import type { IntegrationJob } from '../src/coordination';
import { predictQueue } from '../src/merge-queue';
import Sidebar from './components/sidebar';
import type { Dashboard } from './pages/dashboard';
import { primaryEntry, viewFor, views } from './pages';
import TopBar from './components/top-bar';
import { useFeatures } from './features';
import LoginPage, { REJECTED_NOTICE } from './pages/login';
import WorkDetails from './pages/work-details';
import CreateWork from './pages/create-work';
import { readsFlowAnalytics, useStepMoves } from './step-moves';

/**
 * The dashboard shell: session state, polling, the sidebar generated from the view
 * registry, and the page it selects — or the open work item's page. Pages live under web/pages/.
 */
function App() {
  const [token, setToken] = useState(sessionStorage.getItem('graphyard-token') ?? '');
  const sessionEpoch = useRef(0);
  const [draftToken, setDraftToken] = useState('');
  const [work, setWork] = useState<Work[]>([]);
  const [status, setStatus] = useState<any>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [view, setView] = useState('work');
  const [filter, setFilter] = useState<OpenGroup | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [observedAt, setObservedAt] = useState(Number.NaN);
  const [jobs, setJobs] = useState<IntegrationJob[]>([]);
  const [editingRequirements, setEditingRequirements] = useState(false);
  const [query, setQuery] = useState('');
  async function api(path: string, data?: unknown) {
    const response = await fetch(`/api/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: data === undefined ? undefined : JSON.stringify(data) });
    const body = await response.json(); if (!response.ok) throw new Error(body.error + (body.issues ? `: ${body.issues.map((i: any) => i.message).join(', ')}` : '')); return body;
  }
  function signOut() { sessionEpoch.current++; setBusy(false); sessionStorage.removeItem('graphyard-token'); setToken(''); setDraftToken(''); setStatus(null); setWork([]); setJobs([]); setView('work'); setEditingRequirements(false); setObservedAt(Number.NaN); setSelected(null); setEvents([]); setCreating(false); setConnected(false); setLastUpdated(null); setError(''); }
  /** The sign-in page's first read: once the status reply accepts the token, the work snapshot, then the dashboard. */
  async function firstLoad(system: any, signal: AbortSignal) {
    const epoch = sessionEpoch.current;
    const response = await fetch('/api/work-snapshot', { headers: { Authorization: `Bearer ${token}` }, signal });
    if (response.status === 401 || response.status === 403) throw Object.assign(new Error(REJECTED_NOTICE), { unauthorized: true });
    if (!response.ok) throw new Error(`Unable to load dashboard (${response.status}).`);
    const items = await response.json();
    if (signal.aborted || epoch !== sessionEpoch.current) throw new Error('Superseded');
    setWork(items.work); setJobs(items.jobs ?? []); setObservedAt(Date.parse(items.now)); setStatus(system); setConnected(true); setLastUpdated(new Date().toLocaleTimeString()); setError('');
  }
  async function refresh(epoch: number) { const [items, system] = await Promise.all([api('work-snapshot'), api('status')]); if (epoch !== sessionEpoch.current) return; setWork(items.work); setJobs(items.jobs ?? []); setObservedAt(Date.parse(items.now)); setStatus(system); setConnected(true); setLastUpdated(new Date().toLocaleTimeString()); setError(''); }
  // The sign-in page verifies the token first (web/pages/login.tsx); polling starts once it is accepted.
  const live = !!status;
  useEffect(() => {
    if (!token || !live) return;
    const controller = new AbortController(); const epoch = sessionEpoch.current; let active = true; let pending = false;
    const load = async () => {
      if (pending) return; pending = true;
      try {
        const read = async (path: string) => {
          const response = await fetch(`/api/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
          if (response.status === 401) throw Object.assign(new Error(REJECTED_NOTICE), { unauthorized: true });
          if (!response.ok) throw new Error(`Unable to load dashboard (${response.status}). Retrying automatically.`);
          return response.json();
        };
        const [items, system] = await Promise.all([read('work-snapshot'), read('status')]);
        if (active && epoch === sessionEpoch.current) { setWork(items.work); setJobs(items.jobs ?? []); setObservedAt(Date.parse(items.now)); setStatus(system); setConnected(true); setLastUpdated(new Date().toLocaleTimeString()); setError(''); }
      } catch (e: any) {
        if (!active || epoch !== sessionEpoch.current) return;
        if (e.unauthorized) { signOut(); setError(e.message); }
        else { setConnected(false); setError('Connection unavailable. Displayed data may be stale; retrying automatically.'); }
      } finally { pending = false; }
    };
    void load(); const timer = setInterval(load, 5000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [token, live]);
  const stepMoves = useStepMoves(!!token && !!status && readsFlowAnalytics(status.actor?.role), token, api, sessionEpoch);
  useEffect(() => { setEvents([]); setEditingRequirements(false); window.scrollTo?.(0, 0); }, [selected, token]);
  useEffect(() => { let active = true; const epoch = sessionEpoch.current; if (selected) void api(`events?work=${selected}`).then(rows => { if (active && epoch === sessionEpoch.current) setEvents(rows); }).catch(e => { if (active && epoch === sessionEpoch.current) setError(e.message); }); return () => { active = false; }; }, [selected, work]);
  const codexAvailable = status?.reviewProviders?.includes('codex') === true;
  const item = work.find(w => w.id === selected);
  const queue = predictQueue(work, observedAt);
  async function action(id: string, command: string, data: unknown = {}) { const epoch = sessionEpoch.current; setBusy(true); try { await api(`work/${id}/${command}`, data); if (epoch !== sessionEpoch.current) return; await refresh(epoch); } catch (e) { if (epoch === sessionEpoch.current) setError((e as Error).message); } finally { if (epoch === sessionEpoch.current) setBusy(false); } }
  const { features, operatorAgents, operatorAgentsError } = useFeatures(token, !!status, api, status?.actor?.role === 'admin', work.some(w => w.scenarioRequirements?.length > 0));
  const dashboard: Dashboard = { token, work, status, error, connected, lastUpdated, view, setView, filter, setFilter, selected, setSelected, creating, setCreating, busy, setBusy, observedAt, jobs, query, setQuery, operatorAgents, operatorAgentsError, features, events, editingRequirements, setEditingRequirements, codexAvailable, stepMoves, queue, sessionEpoch, api, refresh, action, setError, signOut };
  if (!token || !status) return <LoginPage token={token} error={error} signOut={signOut} setError={setError} sessionEpoch={sessionEpoch} setToken={setToken} draftToken={draftToken} setDraftToken={setDraftToken} host={location.host} onVerified={firstLoad}/>;
  // One page at a time: an open item replaces the page it was opened from, and "← Back" returns to it.
  return <div className="shell"><Sidebar entries={views.map(entry => primaryEntry(dashboard, entry))} dashboard={dashboard}/>
    <main className="main">{error && <div role="alert" className="notice danger">{error}</div>}
      {item ? <WorkDetails {...dashboard} item={item}/> : <><TopBar {...dashboard}/>{viewFor(view).render(dashboard)}</>}</main>
    {creating && <CreateWork {...dashboard}/>}
  </div>;
}
createRoot(document.getElementById('root')!).render(location.pathname.startsWith('/docs') ? <Docs/> : <App/>);
