import { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { type Work, type Stage } from '../src/model';
import './style.css';
import Docs from './docs';
import type { IntegrationJob } from '../src/coordination';
import { predictQueue } from '../src/merge-queue';
import SessionBadge from './components/session-badge';
import type { Dashboard } from './pages/dashboard';
import { viewFor, views } from './pages';
import LoginPage from './pages/login';
import WorkDetails from './pages/work-details';
import CreateWork from './pages/create-work';

/**
 * The dashboard shell: session state, polling, the sidebar generated from the view
 * registry, and the page it selects. Pages live under web/pages/.
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
  const [view, setView] = useState('graph');
  const [filter, setFilter] = useState<Stage | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [observedAt, setObservedAt] = useState(Number.NaN);
  const [jobs, setJobs] = useState<IntegrationJob[]>([]);
  const [editingRequirements, setEditingRequirements] = useState(false);
  const [query, setQuery] = useState('');
  const [operatorAgents, setOperatorAgents] = useState<any[]>([]);
  async function api(path: string, data?: unknown) {
    const response = await fetch(`/api/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: data === undefined ? undefined : JSON.stringify(data) });
    const body = await response.json(); if (!response.ok) throw new Error(body.error + (body.issues ? `: ${body.issues.map((i: any) => i.message).join(', ')}` : '')); return body;
  }
  function signOut() { sessionEpoch.current++; setBusy(false); sessionStorage.removeItem('graphyard-token'); setToken(''); setDraftToken(''); setStatus(null); setWork([]); setJobs([]); setOperatorAgents([]); setView('graph'); setEditingRequirements(false); setObservedAt(Number.NaN); setSelected(null); setEvents([]); setCreating(false); setConnected(false); setLastUpdated(null); setError(''); }
  async function refresh(epoch: number) { const [items, system] = await Promise.all([api('work-snapshot'), api('status')]); if (epoch !== sessionEpoch.current) return; setWork(items.work); setJobs(items.jobs ?? []); setObservedAt(Date.parse(items.now)); setStatus(system); setConnected(true); setLastUpdated(new Date().toLocaleTimeString()); setError(''); }
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController(); const epoch = sessionEpoch.current; let active = true; let pending = false;
    const load = async () => {
      if (pending) return; pending = true;
      try {
        const read = async (path: string) => {
          const response = await fetch(`/api/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
          if (response.status === 401) throw Object.assign(new Error('Access token was rejected. Check the token and try again.'), { unauthorized: true });
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
  }, [token]);
  useEffect(() => { setEvents([]); setEditingRequirements(false); }, [selected, token]);
  useEffect(() => { let active = true; const epoch = sessionEpoch.current; if (selected) void api(`events?work=${selected}`).then(rows => { if (active && epoch === sessionEpoch.current) setEvents(rows); }).catch(e => { if (active && epoch === sessionEpoch.current) setError(e.message); }); return () => { active = false; }; }, [selected, work]);
  const codexAvailable = status?.reviewProviders?.includes('codex') === true;
  const item = work.find(w => w.id === selected);
  const queue = predictQueue(work, observedAt);
  async function action(id: string, command: string, data: unknown = {}) { const epoch = sessionEpoch.current; setBusy(true); try { await api(`work/${id}/${command}`, data); if (epoch !== sessionEpoch.current) return; await refresh(epoch); } catch (e) { if (epoch === sessionEpoch.current) setError((e as Error).message); } finally { if (epoch === sessionEpoch.current) setBusy(false); } }
  async function showAutomation() { const epoch = sessionEpoch.current; setView('automation'); try { const agents = await api('operator-agents'); if (epoch === sessionEpoch.current) setOperatorAgents(agents); } catch (e) { if (epoch === sessionEpoch.current) setError((e as Error).message); } }
  const dashboard: Dashboard = { token, work, status, error, connected, lastUpdated, view, setView, filter, setFilter, selected, setSelected, creating, setCreating, busy, setBusy, observedAt, jobs, query, setQuery, operatorAgents, events, editingRequirements, setEditingRequirements, codexAvailable, queue, sessionEpoch, api, refresh, action, showAutomation, setError, signOut };
  if (!token || !status) return <LoginPage token={token} error={error} signOut={signOut} setError={setError} sessionEpoch={sessionEpoch} setToken={setToken} draftToken={draftToken} setDraftToken={setDraftToken}/>;
  return <div className="shell"><aside className="sidebar"><div className="brand"><img className="mark" src="/graphyard-symbol.svg" alt="" width="32" height="32"/> graphyard</div><div className="workspace-label">CONTROL PLANE</div>{views.map(entry => (!entry.adminOnly || status?.actor?.role === 'admin') && (!entry.visible || entry.visible(dashboard)) && <button key={entry.id} className={view === entry.id ? 'nav active' : 'nav'} onClick={() => entry.open ? entry.open(dashboard) : setView(entry.id)}>{entry.icon} <span>{entry.label}</span>{entry.count && <small>{entry.count(dashboard)}</small>}</button>)}<a className="nav" href="/docs">↗ <span>Documentation</span></a><div className="sidebar-bottom"><span className={`dot ${connected ? 'green' : ''}`}/>{connected ? 'Control plane connected' : 'Disconnected · data may be stale'}<p>{status?.actor?.id} · {status?.actor?.role} <SessionBadge kind={status?.actor?.sessionKind}/></p><button className="text-button" onClick={signOut}>Sign out</button></div></aside>
    <main className="main">{error && <div role="alert" className="notice danger">{error}</div>}{viewFor(view).render(dashboard)}</main>
    {item && <WorkDetails {...dashboard} item={item}/>}
    {creating && <CreateWork {...dashboard}/>}
  </div>;
}
createRoot(document.getElementById('root')!).render(location.pathname.startsWith('/docs') ? <Docs/> : <App/>);
