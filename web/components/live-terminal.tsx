import { useEffect, useRef, useState } from 'react';

const columns = 120, rows = 36;

/**
 * A Herdr pane's live terminal (GY-3211), over the control plane's /api/terminal WebSocket: the
 * master's pane when PANE is absent, else that agent session's. The server decides who may type —
 * a signed-in human admin on the master's pane — and says so in its first message; everyone else
 * watches. Unmounting closes the socket, which detaches without stopping the pane.
 */
export default function LiveTerminal({ token, pane, label }: { token: string; pane?: string; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'connecting' | 'control' | 'observe' | 'closed' | 'refused'>('connecting');
  useEffect(() => {
    if (!token) { setState('refused'); return; }
    // xterm.js loads with the page that shows a terminal, never with the rest of the dashboard.
    let live = true, stop = () => {};
    void import('@xterm/xterm').then(({ Terminal }) => {
      if (!live) return;
      const terminal = new Terminal({ cols: columns, rows, convertEol: false, cursorBlink: true, fontSize: 13 });
      terminal.open(host.current!);
      const query = new URLSearchParams({ ...(pane ? { pane } : {}), cols: String(columns), rows: String(rows) });
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminal?${query}`, ['graphyard', token]);
      socket.binaryType = 'arraybuffer';
      let opened = false;
      socket.onopen = () => { opened = true; };
      socket.onmessage = event => {
        if (typeof event.data === 'string') { const hello = JSON.parse(event.data); setState(hello.mode); if (hello.mode === 'control') terminal.focus(); return; }
        terminal.write(new Uint8Array(event.data));
      };
      socket.onclose = () => setState(opened ? 'closed' : 'refused');
      const typing = terminal.onData(data => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data })); });
      stop = () => { typing.dispose(); socket.close(); terminal.dispose(); };
    });
    return () => { live = false; stop(); };
  }, [token, pane]);
  const notes = {
    connecting: 'Connecting…',
    control: 'Live. You can type here; each line you enter is recorded in history under your name.',
    observe: 'Live, read-only: only a signed-in operator can type into the master.',
    closed: 'Detached. The session keeps running; reopen the page to watch again.',
    refused: 'Not available: sign in, and check the session still has a pane.',
  };
  return <section className="live-terminal" aria-label={label} data-terminal={state}>
    <p className={state === 'refused' ? 'notice danger' : 'muted'} role="status">{notes[state]}</p>
    <div ref={host} className="terminal-host"/>
  </section>;
}
