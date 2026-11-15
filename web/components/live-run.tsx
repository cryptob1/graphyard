import { useEffect, useRef, useState } from 'react';

type RunLogChunk = { run: { account: string | null; kind: string }; lines: { at: string; stream: string; text: string }[]; cursor: number; ended: boolean };

/**
 * One headless run's output, live (GY-3314): read from the item's run-log endpoint — the same
 * chunked read the item page's worker runs use — polled from its cursor until the log says the run
 * ended, so what the agent prints arrives without a reload. The cursor lives as long as the view of
 * one run: a session going stale or seen again changes nothing here, and only a new run or token
 * reads the log afresh, replacing what was shown. One read runs at a time. The view follows the tail and lets the reader
 * scroll the earlier output back; scrolling away from the bottom stops the following until the
 * reader returns to it. It is read-only: nothing here writes to the run, and no control can type.
 */
export default function LiveRun({ workId, run, token }: { workId: string; run: string; token: string }) {
  const [lines, setLines] = useState<RunLogChunk['lines'] | null>(null);
  const [error, setError] = useState('');
  const [ended, setEnded] = useState(false);
  const [account, setAccount] = useState<string | null>(null);
  const cursor = useRef(0), following = useRef(true), endedRef = useRef(false);
  const view = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let active = true, reading = false;
    cursor.current = 0; following.current = true; endedRef.current = false;
    setLines(null);
    const read = async () => {
      if (reading) return;
      reading = true;
      try { await readChunks(); } finally { reading = false; }
    };
    const readChunks = async () => {
      const fresh: RunLogChunk['lines'] = [];
      // Chunk by chunk to the end, bounded: a view never pulls an unbounded log.
      for (let chunks = 0; chunks < 32; chunks++) {
        const response = await fetch(`/api/work/${encodeURIComponent(workId)}/runs/${run}/log?cursor=${cursor.current}`, { headers: { Authorization: `Bearer ${token}` } });
        const body = await response.json().catch(() => ({}));
        if (!active) return;
        if (!response.ok) { setError(body.error ?? `The log could not be read (${response.status})`); return; }
        const chunk = body as RunLogChunk;
        setAccount(chunk.run.account); fresh.push(...chunk.lines);
        setEnded(chunk.ended); endedRef.current = chunk.ended;
        if (chunk.cursor === cursor.current || !chunk.lines.length) break;
        cursor.current = chunk.cursor;
      }
      setError('');
      if (fresh.length) setLines(previous => [...previous ?? [], ...fresh]);
      else setLines(previous => previous ?? []);
    };
    void read();
    // Polled until the log says the run ended; after that it is whole.
    const timer = setInterval(() => { if (!endedRef.current) void read(); }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [workId, run, token]);
  // Follow the tail unless the reader scrolled the earlier output up.
  useEffect(() => { if (following.current && view.current) view.current.scrollTop = view.current.scrollHeight; }, [lines]);
  const scrolled = () => { const element = view.current!; following.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 24; };
  return <div className="live-run" data-run={run}>
    <p className="live-run-state">{error ? <span className="amber">{error}</span>
      : <span className="muted">{account ? `${account} · ` : ''}{ended ? 'the run has ended' : 'following the output'}</span>}</p>
    {!lines ? <p className="muted">Reading the log…</p> : lines.length
      ? <pre className="run-log" ref={view} onScroll={scrolled} aria-label="Session output">{lines.map(line => `${line.at.slice(11, 19)} ${line.stream} ${line.text}`).join('\n')}</pre>
      : <p className="muted">The run has printed nothing yet.</p>}
  </div>;
}
