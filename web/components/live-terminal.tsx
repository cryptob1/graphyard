import { useEffect, useRef, useState } from 'react';

const columns = 120, rows = 36;

// xterm.js loads from the CDN at a pinned exact version, checked by its hash, only on a page that
// shows a terminal: never an npm dependency of the dashboard bundle.
const xterm = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0';
/** The part of xterm.js's Terminal this page uses. */
type TerminalClass = new (options: Record<string, unknown>) => {
  open(host: HTMLElement): void; focus(): void; write(data: Uint8Array): void; dispose(): void;
  onData(listener: (data: string) => void): { dispose(): void };
};
let loading: Promise<TerminalClass> | undefined;
const loadTerminal = () => loading ??= new Promise((done, fail) => {
  const style = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `${xterm}/css/xterm.css`,
    integrity: 'sha384-n2n7twoohnW+d3myBKaUgl7DSiwidw6MkQy9oesGzkPpMjejKRR3XlnD+5yCdtBD', crossOrigin: 'anonymous' });
  const script = Object.assign(document.createElement('script'), { src: `${xterm}/lib/xterm.js`,
    integrity: 'sha384-f/1U6Z9wM4D71a5eRXEZnyOTMOvjqxr2XLwh+Go1OvIl3L3tOcvUrzudnhbECwl4', crossOrigin: 'anonymous',
    onload: () => done((globalThis as unknown as { Terminal: TerminalClass }).Terminal),
    onerror: () => { loading = undefined; fail(new Error('xterm.js did not load')); } });
  document.head.append(style, script);
});

/**
 * A Herdr pane's live terminal (GY-3211), over the control plane's /api/terminal WebSocket: the
 * master's pane when PANE is absent, else that agent session's. The server decides who may type —
 * the operator or an invited maintainer, on the master's pane — and says so in its first message; everyone else
 * watches. Unmounting closes the socket, which detaches without stopping the pane.
 */
export default function LiveTerminal({ token, pane, label }: { token: string; pane?: string; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'connecting' | 'control' | 'observe' | 'closed' | 'refused'>('connecting');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (!token) { setState('refused'); return; }
    let live = true, stop = () => {};
    loadTerminal().then(Terminal => {
      if (!live) return;
      const terminal = new Terminal({ cols: columns, rows, convertEol: false, cursorBlink: true, fontSize: 13 });
      terminal.open(host.current!);
      const query = new URLSearchParams({ ...(pane ? { pane } : {}), cols: String(columns), rows: String(rows) });
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminal?${query}`, ['graphyard', token]);
      socket.binaryType = 'arraybuffer';
      let opened = false;
      socket.onopen = () => { opened = true; };
      socket.onmessage = event => {
        if (typeof event.data === 'string') { const hello = JSON.parse(event.data); if (hello.refused) { setReason(hello.refused); setState('refused'); return; } setState(hello.mode); if (hello.mode === 'control') terminal.focus(); return; }
        terminal.write(new Uint8Array(event.data));
      };
      socket.onclose = () => setState(current => current === 'refused' ? current : opened ? 'closed' : 'refused');
      const typing = terminal.onData(data => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data })); });
      stop = () => { typing.dispose(); socket.close(); terminal.dispose(); };
    }, () => { if (live) setState('refused'); });
    return () => { live = false; stop(); };
  }, [token, pane]);
  const notes = {
    connecting: 'Connecting…',
    control: 'Live. You can type here; each line you enter is recorded in history under your name.',
    observe: 'Live, read-only: only the operator and maintainers can type into the master.',
    closed: 'Detached. The session keeps running; reopen the page to watch again.',
    refused: 'Not available: sign in, and check the session still has a pane.',
  };
  return <section className="live-terminal" aria-label={label} data-terminal={state}>
    <p className={state === 'refused' ? 'notice danger' : 'muted'} role="status">{state === 'refused' && reason ? `refused: ${reason}` : notes[state]}</p>
    <div ref={host} className="terminal-host"/>
  </section>;
}
