import { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { type Work } from '../src/model';
import { isBoard, type Board, type OpenGroup } from './groups';
import './style.css';
import type { IntegrationJob } from '../src/coordination';
import Sidebar from './components/sidebar';
import type { Dashboard } from './pages/dashboard';
import { primaryEntry, viewFor, views } from './pages';
import TopBar from './components/top-bar';
import { useFeatures } from './features';
import LoginPage, { HUMAN_SESSION_KEY, REJECTED_NOTICE, SIGN_IN_NEEDED, storedToken, wantsSignIn } from './pages/login';
import WorkDetails, { useOpenedWork } from './pages/work-details';
import CreateWork from './pages/create-work';
import { initialView } from './pages/setup';
import { idempotencyKey } from './idempotency-key';
import { ShippedToast, confetti, bootFun } from './fun';
import { applyTheme } from './theme';
import { boot } from './boot';
import KeyboardNav from './keyboard';

applyTheme();
bootFun();
boot();

/**
 * The dashboard shell: session state, polling, the sidebar generated from the view
 * registry, and the page it selects — or the open work item's page. Pages live under web/pages/.
 */
function App() {
  const [token, setToken] = useState(storedToken);
  const sessionEpoch = useRef(0);
  // Viewing on this machine needs no sign-in; the form shows once an action asks for it or the local read is refused.
  const [signingIn, setSigningIn] = useState(wantsSignIn);
  const [draftToken, setDraftToken] = useState('');
  const [work, setWork] = useState<Work[]>([]);
  // The last snapshot's cursor (GY-3231): a poll asks for what changed since it, and a delta answer
  // keeps the settled summaries it already holds, so a poll carries the open items, not the ledger.
  const snapshotCursor = useRef('');
  const keepSnapshot = (items: { work: Work[]; cursor?: string; delta?: boolean }) => {
    snapshotCursor.current = items.cursor ?? '';
    setWork(previous => {
      if (!items.delta) return items.work;
      const fresh = new Set(items.work.map(w => w.id)), number = (w: Work) => Number(w.key.split('-').pop());
      return [...items.work, ...previous.filter(w => (w.summary as unknown) === true && !fresh.has(w.id))].sort((a, b) => number(a) - number(b));
    });
  };
  const [status, setStatus] = useState<any>(null);
  const [board, setBoard] = useState<Board | null>(null), keepBoard = (value: unknown) => { if (isBoard(value)) setBoard(value); }; // GET /api/board (GY-200): the Work page's groups; the last one read stands through a failed read
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [view, setView] = useState(initialView);
  const [filter, setFilter] = useState<OpenGroup | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [observedAt, setObservedAt] = useState(Number.NaN);
  const [jobs, setJobs] = useState<IntegrationJob[]>([]);
  const [editingRequirements, setEditingRequirements] = useState(false);
  const [query, setQuery] = useState('');
  const [palette, setPalette] = useState(false);
  async function api(path: string, data?: unknown) {
    const response = await fetch(`/api/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey() }, body: data === undefined ? undefined : JSON.stringify(data) });
    const body = await response.json(); if (!response.ok) throw new Error(!token && response.status === 401 ? SIGN_IN_NEEDED : body.error + (body.issues ? `: ${body.issues.map((i: any) => i.message).join(', ')}` : '')); return body;
  }
  async function signOut() {
    if (token.startsWith('gyh_')) {
      try {
        const response = await fetch('/api/sign-out', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok && response.status !== 401) throw new Error('Unable to sign out. Please retry.');
      } catch { setError('Unable to sign out. Check your connection and retry.'); return; }
    }
    sessionEpoch.current++; snapshotCursor.current = ''; setSigningIn(true); setBusy(false); sessionStorage.removeItem(HUMAN_SESSION_KEY); localStorage.removeItem(HUMAN_SESSION_KEY); setToken(''); setDraftToken(''); setStatus(null); setBoard(null); setWork([]); setJobs([]); setView('work'); setEditingRequirements(false); setObservedAt(Number.NaN); setSelected(null); setEvents([]); setCreating(false); setConnected(false); setLastUpdated(null); setError(''); }
  /** The sign-in page's first read: once the status reply accepts the token, the work snapshot, then the dashboard. */
  async function firstLoad(system: any, signal: AbortSignal) {
    const epoch = sessionEpoch.current, headers = { Authorization: `Bearer ${token}` }, response = await fetch('/api/work-snapshot', { headers, signal });
    if (response.status === 401 || response.status === 403) throw Object.assign(new Error(REJECTED_NOTICE), { unauthorized: true });
    if (!response.ok) throw new Error(`Unable to load dashboard (${response.status}).`);
    const items = await response.json(), served = await fetch('/api/board', { headers, signal }).then(r => r.ok ? r.json() : null, () => null); if (signal.aborted || epoch !== sessionEpoch.current) throw new Error('Superseded');
    keepSnapshot(items); keepBoard(served); setJobs(items.jobs ?? []); setObservedAt(Date.parse(items.now)); setStatus(system); setConnected(true); setLastUpdated(new Date().toLocaleTimeString()); setError('');
  }
  async function refresh(epoch: number) { const [items, system, served] = await Promise.all([api('work-snapshot'), api('status'), api('board').catch(() => null)]); if (epoch !== sessionEpoch.current) return; keepSnapshot(items); keepBoard(served); setJobs(items.jobs ?? []); setObservedAt(Date.parse(items.now)); setStatus(system); setConnected(true); setLastUpdated(new Date().toLocaleTimeString()); setError(''); }
  // The sign-in page verifies the token first (web/pages/login.tsx); polling starts once it is accepted.
  const live = !!status;
  useEffect(() => {
    if (!live) return;
    const controller = new AbortController(); const epoch = sessionEpoch.current; let active = true; let pending = false;
    const load = async () => {
      if (pending) return; pending = true;
      try {
        const read = async (path: string) => {
          const response = await fetch(`/api/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
          if (response.status === 401 || response.status === 403) throw Object.assign(new Error(REJECTED_NOTICE), { unauthorized: true });
          if (!response.ok) throw new Error(`Unable to load dashboard (${response.status}). Retrying automatically.`);
          return response.json();
        };
        const [items, system, served] = await Promise.all([read(snapshotCursor.current ? `work-snapshot?since=${encodeURIComponent(snapshotCursor.current)}` : 'work-snapshot'), read('status'), read('board').catch(() => null)]);
        if (active && epoch === sessionEpoch.current) { keepSnapshot(items); keepBoard(served); setJobs(items.jobs ?? []); setObservedAt(Date.parse(items.now)); setStatus(system); setConnected(true); setLastUpdated(new Date().toLocaleTimeString()); setError(''); }
      } catch (e: any) {
        if (!active || epoch !== sessionEpoch.current) return;
        if (e.unauthorized) { signOut(); if (token) setError(e.message); }
        else { setConnected(false); setError('Connection unavailable. Displayed data may be stale; retrying automatically.'); }
      } finally { pending = false; }
    };
    // A hidden tab's timers are throttled to once a minute, so returning to the tab reads at once.
    const visible = () => { if (document.visibilityState === 'visible') void load(); };
    void load(); const timer = setInterval(load, 5000); document.addEventListener('visibilitychange', visible);
    return () => { active = false; controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [token, live]);
  useEffect(() => { setEvents([]); setEditingRequirements(false); window.scrollTo?.(0, 0); }, [selected, token]);
  // A read answered while the same item is still open is kept even when a work poll re-ran the effect meanwhile, so a later failed read never leaves history empty.
  const selectedRef = useRef(selected); selectedRef.current = selected;
  useEffect(() => { const epoch = sessionEpoch.current, current = () => selectedRef.current === selected && epoch === sessionEpoch.current; if (selected) void api(`events?work=${selected}`).then(rows => { if (current()) setEvents(rows); }).catch(e => { if (current()) setError(e.message); }); }, [selected, work]);
  // GY-3268: an item that merges while the page is open gets a toast naming its builder, and confetti.
  const merged = useRef<Map<string, boolean> | null>(null);
  const [shipped, setShipped] = useState<Work | null>(null);
  useEffect(() => {
    if (!work.length) return;
    const isMerged = (w: Work) => w.stage === 'done' && !!(w.delivery?.mergedAt ?? w.observation?.mergedAt);
    const fresh = merged.current ? work.filter(w => isMerged(w) && merged.current!.get(w.id) === false) : [];
    merged.current = new Map(work.map(w => [w.id, isMerged(w)]));
    if (!fresh.length) return;
    setShipped(fresh.at(-1)!); confetti();
  }, [work]);
  useEffect(() => { if (!shipped) return; const timer = setTimeout(() => setShipped(null), 8000); return () => clearTimeout(timer); }, [shipped]);
  const item = useOpenedWork(work, selected, token, api, sessionEpoch, setError);
  async function action(id: string, command: string, data: unknown = {}) { const epoch = sessionEpoch.current; setBusy(true); try { await api(`work/${id}/${command}`, data); if (epoch !== sessionEpoch.current) return; await refresh(epoch); } catch (e) { if (epoch === sessionEpoch.current) setError((e as Error).message); } finally { if (epoch === sessionEpoch.current) setBusy(false); } }
  const { features, operatorAgents, operatorAgentsError } = useFeatures(token, !!status, api, status?.actor?.role === 'admin', work.some(w => w.scenarioRequirements?.length > 0));
  const dashboard: Dashboard = { token, work, board, status, error, connected, lastUpdated, view, setView, filter, setFilter, selected, setSelected, creating, setCreating, busy, setBusy, observedAt, jobs, query, setQuery, operatorAgents, operatorAgentsError, features, events, editingRequirements, setEditingRequirements, sessionEpoch, api, refresh, action, setError, signOut };
  if (!status) return <LoginPage signingIn={signingIn} setSigningIn={setSigningIn} token={token} error={error} signOut={signOut} setError={setError} sessionEpoch={sessionEpoch} setToken={setToken} draftToken={draftToken} setDraftToken={setDraftToken} host={location.host} onVerified={firstLoad}/>;
  // One page at a time: an open item replaces the page it was opened from, and "← Back" returns to it.
  return <div className="shell"><Sidebar entries={views.map(entry => primaryEntry(dashboard, entry))} dashboard={dashboard}/>
    <main className="main">{error && <div role="alert" className="notice danger">{error}{error === SIGN_IN_NEEDED && <> <button type="button" onClick={signOut}>Sign in</button></>}</div>}
      <TopBar {...dashboard} onPalette={() => setPalette(true)}/>{item ? <WorkDetails {...dashboard} item={item}/> : viewFor(view).render(dashboard)}</main>
    {creating && <CreateWork {...dashboard}/>}
    {shipped && <ShippedToast item={shipped} onClose={() => setShipped(null)}/>}
    <KeyboardNav dashboard={dashboard} palette={palette} setPalette={setPalette}/>
    <VersionLabel status={status}/>
  </div>;
}
/** GY-3310: the Graphyard build this dashboard's server runs, in the bottom-left corner, read from each status poll. */
function VersionLabel({ status }: { status: any }) {
  const commit: string | undefined = status.build?.commit ?? (status.release?.revision !== 'unknown' ? status.release?.revision : undefined);
  const version: string | undefined = status.release?.version;
  return <span className="version-label" title={[version, commit].filter(Boolean).join(' · ')}>Graphyard {commit ? commit.slice(0, 7) : version}</span>;
}
createRoot(document.getElementById('root')!).render(<App/>);
