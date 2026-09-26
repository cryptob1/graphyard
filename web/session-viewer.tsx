import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Watching a running agent session from the dashboard (GY-713). The loop that launched a session
 * publishes its live tail — a Herdr pane read through Herdr's pane-read API, a headless run's
 * per-run log — redacted and bounded, and this is where it is read: every session of an item, or
 * of every item, with its role, runtime, account, state and age, one click from a live view.
 *
 * The view is read-only by construction. It renders text and a Close button; there is no input,
 * no text area, nothing editable and no key handler, and the control plane has no route that would
 * send anything to a session. To act on a session, attach to it locally with the command shown.
 */

export interface TailSummary {
  work: string; session: string; role: string; runtime: string; account: string | null; principal: string | null;
  startedAt: string | null; surface: 'herdr' | 'headless'; attach: string | null; transcript: string | null;
  host: string; publishedAt: string; readAt: string; stale: boolean; error: string | null; lineCount?: number;
}
export interface Tail extends TailSummary { lines: string[] }
type Api = (path: string) => Promise<any>;

/** How often the open viewer reads its tail; each read keeps the session watched, which the loop refreshes every 3 s. */
export const viewerPollMs = 2_000;
const listPollMs = 5_000;

const roleWords: Record<string, string> = { worker: 'Builds code', reviewer: 'Reviews code', producer: 'Proves requirements', approver: 'Approves decisions', doctor: 'Doctor', research: 'Researches', coordination: 'Coordinates' };
/** Time since an instant, coarse: `12s`, `4m`, `2h 05m`. */
export function sessionAge(iso: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
/** How long a session has run, or that its launcher recorded no start. */
const startedText = (startedAt: string | null, now: number) => startedAt ? `started ${sessionAge(startedAt, now)} ago` : 'start not recorded';
const stateOf = (tail: TailSummary) => tail.stale ? 'not seen recently' : 'running';
/** A session's role, runtime, account, state and age, as one line. */
export const sessionLine = (tail: TailSummary, now: number) =>
  `${roleWords[tail.role] ?? tail.role} · ${tail.runtime} · ${tail.account ?? tail.principal ?? 'account not recorded'} · ${stateOf(tail)} · ${startedText(tail.startedAt, now)}`;

/**
 * The live terminal view of one session: its last lines, following the end as they arrive unless
 * the reader has scrolled up, with the transcript path and the Herdr attach command for local use.
 */
export default function SessionViewer({ api, work, session, onClose, pollMs = viewerPollMs }: { api: Api; work: string; session: string; onClose(): void; pollMs?: number }) {
  const [tail, setTail] = useState<Tail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const log = useRef<HTMLPreElement>(null), following = useRef(true);
  // The dashboard's `api` is a new function every render; the reads follow the latest one without restarting.
  const reader = useRef(api); reader.current = api;
  useEffect(() => {
    let active = true;
    const read = async () => {
      try { const next = await reader.current(`work/${encodeURIComponent(work)}/session-tails/${encodeURIComponent(session)}`); if (active) { setTail(next); setError(null); } }
      catch (failure) { if (active) setError((failure as Error).message); }
    };
    void read();
    const timer = setInterval(read, pollMs);
    return () => { active = false; clearInterval(timer); };
  }, [work, session, pollMs]);
  // Auto-scroll: a reader at the end stays at the end; one who scrolled up is left where they are.
  useLayoutEffect(() => { const element = log.current; if (element && following.current) element.scrollTop = element.scrollHeight; }, [tail]);
  const onScroll = () => { const element = log.current; if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24; };
  const now = Date.now();
  return <section className="session-viewer" role="region" aria-label={`Live view of ${session}`} data-session={session}>
    <div className="session-viewer-head">
      <div><h2>{session}</h2>
        {tail && <p className="muted">{sessionLine(tail, now)} · updated {sessionAge(tail.readAt, now)} ago on {tail.host}</p>}</div>
      <button type="button" className="text-button" onClick={onClose}>Close</button>
    </div>
    <p className="muted session-viewer-note">Read-only live view. Nothing typed here reaches the session; attach locally to act on it.</p>
    {error && !tail && <p className="muted" role="status">{/404|No tail/.test(error) ? 'Waiting for the loop that launched this session to publish its first tail (within 30 seconds).' : `The live view could not be read: ${error}`}</p>}
    {tail?.error && <p className="amber">The last read of this session failed: {tail.error}</p>}
    <pre ref={log} className="session-log" role="log" aria-live="polite" aria-label="Session output" tabIndex={0} onScroll={onScroll}>{(tail?.lines ?? []).join('\n')}</pre>
    <dl className="facts session-viewer-facts">
      <div><dt>Attach locally</dt><dd><code>{tail?.attach ?? 'no attach command recorded'}</code></dd></div>
      <div><dt>Transcript</dt><dd><code>{tail?.transcript ?? 'no transcript recorded'}</code></dd></div>
    </dl>
  </section>;
}

/**
 * Every session the loops have published a live view of — one item's when `work` is given — with
 * its role, runtime, account, state and age, each a click from its live view.
 */
export function LiveSessions({ api, work, title = 'Live sessions' }: { api: Api; work?: string; title?: string }) {
  const [tails, setTails] = useState<TailSummary[] | null>(null);
  const [open, setOpen] = useState<{ work: string; session: string } | null>(null);
  const reader = useRef(api); reader.current = api;
  useEffect(() => {
    let active = true;
    const read = async () => { try { const answer = await reader.current(`session-tails${work ? `?work=${encodeURIComponent(work)}` : ''}`); if (active) setTails(answer.tails ?? []); } catch { if (active) setTails(current => current ?? []); } };
    void read();
    const timer = setInterval(read, listPollMs);
    return () => { active = false; clearInterval(timer); };
  }, [work]);
  const now = Date.now();
  return <section className="panel live-sessions" aria-label={title}><h2>{title} <small>{tails ? `${tails.length} ${tails.length === 1 ? 'session' : 'sessions'}` : 'loading'}</small></h2>
    {tails && !tails.length && <p className="muted">No running session has a live view yet. The loop that launches a session publishes its tail within 30 seconds.</p>}
    {!!tails?.length && <ul className="live-session-list">{tails.map(tail => <li key={`${tail.work}/${tail.session}`} data-live-session={tail.session}>
      <span className="live-session-name mono">{tail.session}</span>
      <span>{sessionLine(tail, now)}</span>
      <button type="button" className="text-button watch" onClick={() => setOpen({ work: tail.work, session: tail.session })}>Watch live</button>
    </li>)}</ul>}
    {open && <SessionViewer api={api} work={open.work} session={open.session} onClose={() => setOpen(null)}/>}
  </section>;
}
