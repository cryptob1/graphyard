import { useEffect, useRef, useState } from 'react';
import { replayColumns, type WorkReplay } from '../../src/server/work-replay';
import { Agent, useFun } from '../fun';

function ReplayPanel({ api, onOpen }: { api(path: string): Promise<any>; onOpen(id: string): void }) {
  const request = useRef(api); request.current = api;
  const [hours, setHours] = useState(24), [data, setData] = useState<WorkReplay | null>(null);
  const [error, setError] = useState(''), [position, setPosition] = useState(1000), [playing, setPlaying] = useState(false);
  const fun = useFun();
  const [reduced, setReduced] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const motion = fun && !reduced;
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => setReduced(media.matches);
    media.addEventListener('change', changed); return () => media.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    let active = true;
    setPlaying(false); setData(null); setError(''); setPosition(1000);
    request.current(`work-replay?hours=${hours}`).then(value => { if (!Array.isArray(value?.items)) throw new Error('Replay is unavailable on this server.'); if (active) setData(value); }).catch(reason => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [hours]);
  useEffect(() => { if (!motion) { setPlaying(false); setPosition(1000); } }, [motion]);
  useEffect(() => {
    if (!playing || !motion) return;
    const started = performance.now(), from = position;
    const timer = window.setInterval(() => setPosition(Math.min(1000, from + (performance.now() - started) / 20)), 40);
    return () => clearInterval(timer);
  }, [playing, motion]);
  useEffect(() => { if (position >= 1000) setPlaying(false); }, [position]);
  const time = data ? data.start + (data.end - data.start) * (motion ? position : 1000) / 1000 : 0;
  const items = (data?.items ?? []).map(item => ({ ...item, point: item.points.findLast(point => point.at <= time) })).filter(item => item.point && item.point.column >= 0);
  return <section className="work-replay" aria-label="Replay">
    <div className="replay-tools"><h2>Replay</h2><div role="group" aria-label="Replay window">{[24, 72].map(value => <button type="button" key={value} aria-pressed={hours === value} onClick={() => setHours(value)}>{value === 24 ? '24 h' : '3 days'}</button>)}</div>
      <button type="button" disabled={!motion || !data?.items.length} onClick={() => { if (!playing && position >= 1000) setPosition(0); setPlaying(!playing); }}>{playing ? 'Pause' : 'Play'}</button>
      {data && <time dateTime={new Date(time).toISOString()}>{new Date(time).toLocaleString()}</time>}
    </div>
    <p className="muted">Items that moved during this window. {motion ? 'Play the journey in 20 seconds, or scrub to a moment.' : 'Motion is off. Showing the end of the window.'}</p>
    {error ? <p role="alert">Replay could not load: {error}</p> : !data ? <p>Loading replay…</p> : <>
      <input aria-label="Replay time" type="range" min="0" max="1000" value={motion ? position : 1000} disabled={!motion} onChange={event => { setPlaying(false); setPosition(Number(event.target.value)); }}/>
      {data.items.length === 0 ? <p className="muted">No items moved during this window.</p> : <div className="replay-scroll"><div className="replay-yard" style={{ height: 60 + items.length * 30 }}>
        <div className="replay-columns">{replayColumns.map((label, index) => <div key={label} data-replay-column={label}><strong>{label}</strong> <span className="count">{items.filter(item => item.point!.column === index).length}</span></div>)}</div>
        {items.map((item, index) => <button type="button" key={item.id} data-replay-item={item.key} data-column={replayColumns[item.point!.column]} className="replay-dot" style={{ top: 48 + index * 30, left: `${item.point!.column * 100 / 6}%` }} onClick={() => onOpen(item.id)}><span aria-hidden="true">●</span> {item.key} {item.point!.runner && <Agent id={item.point!.runner}/>}</button>)}
      </div></div>}
    </>}
  </section>;
}

export default function Replay(props: { api(path: string): Promise<any>; onOpen(id: string): void }) {
  const [open, setOpen] = useState(false);
  // The closed fold is an icon named by its label and tooltip, like the sidebar's Delivery control
  // (GY-1901): the Work page's word budget has no room for another visible word, and the opened
  // panel names itself with its heading.
  return <details className="replay-panel" onToggle={event => setOpen(event.currentTarget.open)}><summary aria-label="Replay" title="Replay how items moved over the last 24 hours or 3 days"><svg className="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg></summary>{open && <ReplayPanel {...props}/>}</details>;
}
